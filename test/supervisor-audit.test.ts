import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { audit, parseArgs, type SupervisorOptions } from "../scripts/supervisor-audit.mjs";
import { refreshMirrors } from "../scripts/supervisor-mirror.mjs";

const runFile = promisify(execFile);

async function fixture(branch = "main"): Promise<SupervisorOptions> {
  const root = await mkdtemp(join(tmpdir(), "orchestratory-supervisor-"));
  const workspace = join(root, "workspace");
  const dataDirectory = join(root, "data");
  const handoff = join(root, "handoff");
  const reportDir = join(root, "reports");
  await mkdir(workspace, { mode: 0o700 });
  await mkdir(dataDirectory, { mode: 0o700 });
  await mkdir(handoff, { mode: 0o700 });
  const git = (args: string[]) => runFile("git", args, { cwd: workspace, encoding: "utf8" });
  await git(["init", "-q", "-b", branch]);
  await git(["config", "user.email", "supervisor@example.invalid"]);
  await git(["config", "user.name", "Supervisor Test"]);
  await writeFile(join(workspace, "README.md"), "fixture\n");
  await git(["add", "README.md"]);
  await git(["commit", "-q", "-m", "fixture"]);
  await git(["update-ref", "refs/heads/main", "HEAD"]);
  await git(["update-ref", "refs/remotes/origin/main", "HEAD"]);

  const roomPath = join(dataDirectory, "rooms.sqlite");
  const roomDatabase = new DatabaseSync(roomPath);
  roomDatabase.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE rooms (id TEXT PRIMARY KEY, recording TEXT NOT NULL);
    CREATE TABLE room_messages (
      room_id TEXT NOT NULL REFERENCES rooms(id),
      seq INTEGER NOT NULL,
      at TEXT NOT NULL,
      author TEXT NOT NULL,
      kind TEXT NOT NULL,
      text TEXT NOT NULL,
      hash TEXT NOT NULL,
      PRIMARY KEY (room_id, seq)
    );
    INSERT INTO rooms (id, recording) VALUES ('orchestratory', 'on');
    PRAGMA user_version=2;
  `);
  roomDatabase.close();
  await chmod(roomPath, 0o600);

  const sourceDirectory = join(root, "sources");
  await mkdir(sourceDirectory, { mode: 0o700 });
  const statusSource = join(sourceDirectory, "status.md");
  const pendingSource = join(sourceDirectory, "PENDING_DECISIONS.md");
  const statusFile = join(handoff, "status-marker.md");
  const pendingFile = join(handoff, "pending-marker.md");
  const mirrorManifest = join(handoff, "mirror-manifest.json");
  await writeFile(statusSource, "## 2026-08-13 handoff\n");
  await writeFile(pendingSource, "D-010 pending\n");
  await refreshMirrors({
    statusSource,
    pendingSource,
    statusMirror: statusFile,
    pendingMirror: pendingFile,
    manifest: mirrorManifest,
    readDeadlineMs: 5000,
    staleAfterSeconds: 7200,
  });
  return {
    workspace,
    branch,
    room: "orchestratory",
    dataDirectory,
    statusFile,
    pendingFile,
    mirrorManifest,
    readDeadlineMs: 5000,
    reportDir,
  };
}

test("supervisor parser resolves bounded operational inputs", () => {
  const parsed = parseArgs([
    "--workspace", "/tmp/orchestratory-supervisor-workspace",
    "--branch", "main",
    "--room", "demo",
    "--data-directory", "/tmp/orchestratory-supervisor-data",
    "--status-file", "handoff/status.md",
    "--pending-file", "handoff/pending.md",
    "--mirror-manifest", "handoff/mirror.json",
    "--read-deadline-ms", "1234",
    "--report-dir", "reports",
    "--json",
  ]);
  assert.equal(parsed.workspace, "/tmp/orchestratory-supervisor-workspace");
  assert.equal(parsed.branch, "main");
  assert.equal(parsed.room, "demo");
  assert.equal(parsed.dataDirectory, "/tmp/orchestratory-supervisor-data");
  assert.equal(parsed.readDeadlineMs, 1234);
  assert.equal(parsed.json, true);
});

test("supervisor parser defaults to owner-local mirrors instead of iCloud sources", () => {
  const parsed = parseArgs([]);
  assert.equal(parsed.statusFile, join(parsed.reportDir, "status-marker.md"));
  assert.equal(parsed.pendingFile, join(parsed.reportDir, "pending-marker.md"));
  assert.equal(parsed.mirrorManifest, join(parsed.reportDir, "mirror-manifest.json"));
  assert.doesNotMatch(parsed.statusFile, /Mobile Documents/u);
  assert.doesNotMatch(parsed.pendingFile, /Mobile Documents/u);
});

test("launchd example is portable and contains no personal absolute path", async () => {
  const template = await readFile(
    join(import.meta.dirname, "..", "ops", "com.orchestratory.supervisor.example.plist"),
    "utf8",
  );
  assert.match(template, /<integer>3600<\/integer>/u);
  assert.match(template, /__NODE_EXECUTABLE__/u);
  assert.match(template, /__WORKSPACE__/u);
  assert.match(template, /__MIRROR_MANIFEST__/u);
  assert.match(template, /--read-deadline-ms/u);
  assert.doesNotMatch(template, /\/Users\//u);
});

test("clean supervisor audit deterministically passes and only writes its bounded report", async () => {
  const options = await fixture();
  const beforeHead = (await runFile("git", ["rev-parse", "HEAD"], { cwd: options.workspace, encoding: "utf8" })).stdout;
  const report = await audit(options);
  assert.equal(report.ok, true);
  assert.equal(report.alerts.length, 0);
  assert.ok(report.checks.every((item) => item.status === "pass"));
  const afterHead = (await runFile("git", ["rev-parse", "HEAD"], { cwd: options.workspace, encoding: "utf8" })).stdout;
  const status = (await runFile("git", ["status", "--porcelain=v1"], { cwd: options.workspace, encoding: "utf8" })).stdout;
  assert.equal(afterHead, beforeHead);
  assert.equal(status, "");
  const reportPath = join(options.reportDir, "last-report.json");
  const encoded = await readFile(reportPath, "utf8");
  assert.ok(Buffer.byteLength(encoded) < 64 * 1024);
  assert.equal((await stat(options.reportDir)).mode & 0o777, 0o700);
  assert.equal((await stat(reportPath)).mode & 0o777, 0o600);
});

test("branch drift produces an alert while preserving the clean worktree", async () => {
  const options = await fixture("actual");
  const report = await audit({ ...options, branch: "expected" });
  assert.equal(report.ok, false);
  assert.ok(report.alerts.some((item) => item.code === "BRANCH_DRIFT"));
  assert.equal(report.checks.find((item) => item.name === "worktree-clean")?.status, "pass");
  const current = (await runFile("git", ["branch", "--show-current"], { cwd: options.workspace, encoding: "utf8" })).stdout.trim();
  assert.equal(current, "actual");
});

test("CLI exits nonzero on drift and does not auto-correct it", async () => {
  const options = await fixture("actual");
  const script = join(import.meta.dirname, "..", "scripts", "supervisor-audit.mjs");
  await assert.rejects(
    runFile(process.execPath, [
      script,
      "--workspace", options.workspace,
      "--branch", "expected",
      "--room", options.room,
      "--data-directory", options.dataDirectory,
      "--status-file", options.statusFile,
      "--pending-file", options.pendingFile,
      "--mirror-manifest", options.mirrorManifest,
      "--read-deadline-ms", String(options.readDeadlineMs),
      "--report-dir", options.reportDir,
    ]),
    (error: unknown) => Number((error as NodeJS.ErrnoException & { code?: number }).code) === 1,
  );
  const current = (await runFile("git", ["branch", "--show-current"], { cwd: options.workspace, encoding: "utf8" })).stdout.trim();
  assert.equal(current, "actual");
});

test("oversized operational input fails closed before unbounded report serialization", async () => {
  const options = await fixture();
  await assert.rejects(
    audit({ ...options, branch: "x".repeat(70_000) }),
    /SUPERVISOR_INTERNAL_PAYLOAD_TOO_LARGE/u,
  );
});

test("mirror manifest records source, digest, mirroredAt and bounded staleness", async () => {
  const options = await fixture();
  const manifest = JSON.parse(await readFile(options.mirrorManifest, "utf8")) as {
    schemaVersion: number;
    mirroredAt: string;
    staleness: { staleAfterSeconds: number; expiresAt: string };
    files: { status: { source: string; digest: string; bytes: number } };
  };
  assert.equal(manifest.schemaVersion, 1);
  assert.ok(Number.isFinite(Date.parse(manifest.mirroredAt)));
  assert.equal(manifest.staleness.staleAfterSeconds, 7200);
  assert.equal(
    Date.parse(manifest.staleness.expiresAt),
    Date.parse(manifest.mirroredAt) + 7200 * 1000,
  );
  assert.match(manifest.files.status.source, /status\.md$/u);
  assert.match(manifest.files.status.digest, /^[a-f0-9]{64}$/u);
  assert.ok(manifest.files.status.bytes > 0);
  assert.equal((await stat(options.mirrorManifest)).mode & 0o777, 0o600);
});

test("stale or digest-mismatched mirrors produce named alerts and never fall back to iCloud", async () => {
  const stale = await fixture();
  const manifest = JSON.parse(await readFile(stale.mirrorManifest, "utf8")) as {
    mirroredAt: string;
    staleness: { staleAfterSeconds: number; expiresAt: string };
  };
  manifest.mirroredAt = "2020-01-01T00:00:00.000Z";
  manifest.staleness.expiresAt = new Date(Date.parse(manifest.mirroredAt) + manifest.staleness.staleAfterSeconds * 1000).toISOString();
  await writeFile(stale.mirrorManifest, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
  const staleReport = await audit(stale);
  assert.equal(staleReport.ok, false);
  assert.ok(staleReport.alerts.some((item) => item.code === "OBSIDIAN_MIRROR_STALE"));

  const mismatch = await fixture();
  await writeFile(mismatch.statusFile, "## 2026-08-20 changed without manifest\n", { mode: 0o600 });
  const mismatchReport = await audit(mismatch);
  assert.equal(mismatchReport.ok, false);
  assert.ok(mismatchReport.alerts.some((item) => item.code === "OBSIDIAN_MIRROR_SIZE_MISMATCH" || item.code === "OBSIDIAN_MIRROR_DIGEST_MISMATCH"));
});

test("audit remains independent of unavailable mirror sources", async () => {
  const options = await fixture();
  const manifest = JSON.parse(await readFile(options.mirrorManifest, "utf8")) as {
    files: { status: { source: string }; pending: { source: string } };
  };
  await unlink(manifest.files.status.source);
  await unlink(manifest.files.pending.source);
  const report = await audit(options);
  assert.equal(report.ok, true);
  assert.equal(report.policy.iCloudReadByLaunchd, false);
});

test("malformed mirror metadata fails closed with a named alert", async () => {
  const options = await fixture();
  await writeFile(options.mirrorManifest, "{not-json\n", { mode: 0o600 });
  const report = await audit(options);
  assert.equal(report.ok, false);
  assert.ok(report.alerts.some((item) => item.code === "OBSIDIAN_MIRROR_MANIFEST_INVALID"));
});

test("unavailable mirror source produces a stable named CLI alert and exits", async () => {
  const options = await fixture();
  const manifest = JSON.parse(await readFile(options.mirrorManifest, "utf8")) as {
    staleness: { staleAfterSeconds: number };
    files: { status: { source: string }; pending: { source: string } };
  };
  await unlink(manifest.files.status.source);
  const script = join(import.meta.dirname, "..", "scripts", "supervisor-mirror.mjs");
  await assert.rejects(
    runFile(process.execPath, [
      script,
      "--status-source", manifest.files.status.source,
      "--pending-source", manifest.files.pending.source,
      "--status-mirror", options.statusFile,
      "--pending-mirror", options.pendingFile,
      "--manifest", options.mirrorManifest,
      "--read-deadline-ms", "1000",
      "--stale-after-seconds", String(manifest.staleness.staleAfterSeconds),
    ]),
    (error: unknown) => {
      const value = error as NodeJS.ErrnoException & { code?: number; stderr?: string };
      assert.equal(Number(value.code), 2);
      assert.match(value.stderr ?? "", /^SUPERVISOR ALERT SUPERVISOR_MIRROR_SOURCE_READ_FAILED$/mu);
      return true;
    },
  );
});

test("mirror parent preserves a specific named worker failure", async () => {
  const options = await fixture();
  const manifest = JSON.parse(await readFile(options.mirrorManifest, "utf8")) as {
    staleness: { staleAfterSeconds: number };
    files: { status: { source: string }; pending: { source: string } };
  };
  await chmod(join(options.statusFile, ".."), 0o755);
  const script = join(import.meta.dirname, "..", "scripts", "supervisor-mirror.mjs");
  await assert.rejects(
    runFile(process.execPath, [
      script,
      "--status-source", manifest.files.status.source,
      "--pending-source", manifest.files.pending.source,
      "--status-mirror", options.statusFile,
      "--pending-mirror", options.pendingFile,
      "--manifest", options.mirrorManifest,
      "--read-deadline-ms", "1000",
      "--stale-after-seconds", String(manifest.staleness.staleAfterSeconds),
    ]),
    (error: unknown) => {
      const value = error as NodeJS.ErrnoException & { code?: number; stderr?: string };
      assert.equal(Number(value.code), 2);
      assert.match(value.stderr ?? "", /^SUPERVISOR ALERT SUPERVISOR_MIRROR_DIRECTORY_UNSAFE$/mu);
      return true;
    },
  );
});

test("a hung audit child is process-group terminated, emits a named alert and exits on time", async () => {
  const options = await fixture();
  const root = join(options.reportDir, "..", "deadline-fixture");
  const bin = join(root, "bin");
  const pidFile = join(root, "git.pid");
  await mkdir(bin, { recursive: true, mode: 0o700 });
  const fakeGit = join(bin, "git");
  await writeFile(fakeGit, "#!/bin/sh\necho $$ > \"$SUPERVISOR_TEST_PID\"\nsleep 30\n", { mode: 0o700 });
  await chmod(fakeGit, 0o700);
  const script = join(import.meta.dirname, "..", "scripts", "supervisor-audit.mjs");
  const started = Date.now();
  await assert.rejects(
    runFile(process.execPath, [
      script,
      "--workspace", options.workspace,
      "--branch", options.branch,
      "--room", options.room,
      "--data-directory", options.dataDirectory,
      "--status-file", options.statusFile,
      "--pending-file", options.pendingFile,
      "--mirror-manifest", options.mirrorManifest,
      "--read-deadline-ms", "1000",
      "--report-dir", options.reportDir,
    ], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, SUPERVISOR_TEST_PID: pidFile },
    }),
    (error: unknown) => {
      const value = error as NodeJS.ErrnoException & { code?: number; stdout?: string };
      assert.equal(Number(value.code), 1);
      assert.match(value.stdout ?? "", /SUPERVISOR ALERT FILESYSTEM_READ_DEADLINE_EXCEEDED/u);
      return true;
    },
  );
  assert.ok(Date.now() - started < 4000);
  const pid = Number((await readFile(pidFile, "utf8")).trim());
  assert.throws(() => process.kill(pid, 0), /ESRCH/u);
  const report = JSON.parse(await readFile(join(options.reportDir, "last-report.json"), "utf8")) as { alerts: Array<{ code: string }> };
  assert.ok(report.alerts.some((item) => item.code === "FILESYSTEM_READ_DEADLINE_EXCEEDED"));
});
