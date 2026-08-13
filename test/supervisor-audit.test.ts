import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { audit, parseArgs, type SupervisorOptions } from "../scripts/supervisor-audit.mjs";

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

  const statusFile = join(handoff, "status.md");
  const pendingFile = join(handoff, "PENDING_DECISIONS.md");
  await writeFile(statusFile, "## 2026-08-13 handoff\n");
  await writeFile(pendingFile, "D-010 pending\n");
  return {
    workspace,
    branch,
    room: "orchestratory",
    dataDirectory,
    statusFile,
    pendingFile,
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
    "--report-dir", "reports",
    "--json",
  ]);
  assert.equal(parsed.workspace, "/tmp/orchestratory-supervisor-workspace");
  assert.equal(parsed.branch, "main");
  assert.equal(parsed.room, "demo");
  assert.equal(parsed.dataDirectory, "/tmp/orchestratory-supervisor-data");
  assert.equal(parsed.json, true);
});

test("launchd example is portable and contains no personal absolute path", async () => {
  const template = await readFile(
    join(import.meta.dirname, "..", "ops", "com.orchestratory.supervisor.example.plist"),
    "utf8",
  );
  assert.match(template, /<integer>3600<\/integer>/u);
  assert.match(template, /__NODE_EXECUTABLE__/u);
  assert.match(template, /__WORKSPACE__/u);
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
      "--report-dir", options.reportDir,
    ]),
    (error: unknown) => Number((error as NodeJS.ErrnoException & { code?: number }).code) === 1,
  );
  const current = (await runFile("git", ["branch", "--show-current"], { cwd: options.workspace, encoding: "utf8" })).stdout.trim();
  assert.equal(current, "actual");
});

test("report serialization fails closed above the 64 KiB bound", async () => {
  const options = await fixture();
  await assert.rejects(
    audit({ ...options, branch: "x".repeat(70_000) }),
    /SUPERVISOR_REPORT_TOO_LARGE/u,
  );
});
