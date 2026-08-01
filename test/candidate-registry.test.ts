import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { CandidateRegistry } from "../src/core/candidate-registry.ts";
import { GitBroker, type GitInspection } from "../src/core/git-broker.ts";

const execFileAsync = promisify(execFile);

async function gitWithInput(cwd: string, args: string[], input: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(Buffer.concat(stdout).toString("utf8"));
      else reject(new Error(`SYNTHETIC_GIT_FAILED:${Buffer.concat(stderr).toString("utf8")}`));
    });
    child.stdin.end(input);
  });
}

class HookedGitBroker extends GitBroker {
  afterInspect?: (workspace: string, result: GitInspection) => Promise<void>;

  override async inspect(workspace: string): Promise<GitInspection> {
    const result = await super.inspect(workspace);
    await this.afterInspect?.(workspace, result);
    return result;
  }
}

function candidateRowHash(row: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify([
    row.task_id, row.candidate_id, row.room_id, row.main_path, row.main_branch,
    row.base_main_head, row.candidate_path, row.candidate_branch, row.task_text,
    row.acceptance_criteria, row.status, row.baseline_json, row.completion_json,
    row.created_at_ms, row.updated_at_ms, row.completed_at_ms,
  ]), "utf8").digest("hex");
}

async function fixture(t: TestContext): Promise<{ root: string; source: string; data: string }> {
  const root = await mkdtemp(join(tmpdir(), "orchestratory-candidate-"));
  const source = join(root, "source");
  const data = join(root, "data");
  await mkdir(source);
  await mkdir(data, { mode: 0o700 });
  await execFileAsync("git", ["init", "-b", "main"], { cwd: source });
  await writeFile(join(source, "README.md"), "committed main\n", "utf8");
  await writeFile(join(source, "delete-me.txt"), "delete me\n", "utf8");
  await writeFile(join(source, ".gitignore"), "*.cache\n", "utf8");
  await execFileAsync("git", ["add", "README.md", "delete-me.txt", ".gitignore"], { cwd: source });
  await execFileAsync("git", [
    "-c", "user.name=Candidate Test", "-c", "user.email=test@example.invalid",
    "commit", "-m", "initial",
  ], { cwd: source });
  t.after(async () => await rm(root, { recursive: true, force: true }));
  return { root, source, data };
}

async function commit(workspace: string, filename: string, contents: string, message: string): Promise<string> {
  await writeFile(join(workspace, filename), contents, "utf8");
  await execFileAsync("git", ["add", "--", filename], { cwd: workspace });
  await execFileAsync("git", [
    "-c", "user.name=Candidate Test", "-c", "user.email=test@example.invalid",
    "commit", "-m", message,
  ], { cwd: workspace });
  return (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: workspace })).stdout.trim();
}

test("candidate lifecycle preserves dirty main and completes only a committed recoverable snapshot", async (t) => {
  const { source, data } = await fixture(t);
  await writeFile(join(source, "README.md"), "dirty main must remain\n", "utf8");
  await unlink(join(source, "delete-me.txt"));
  await writeFile(join(source, "untracked.txt"), "owner draft\n", "utf8");
  await writeFile(join(source, "owner.cache"), "ignored owner state\n", "utf8");
  const mainHeadBefore = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: source })).stdout.trim();
  const mainStatusBefore = (await execFileAsync("git", ["status", "--porcelain=v1"], { cwd: source })).stdout;
  const registry = new CandidateRegistry(data);
  t.after(() => registry.close());

  const task = await registry.start({
    roomId: "demo", mainPath: source, task: "Implement candidate lifecycle",
    acceptanceCriteria: "main remains byte-for-byte untouched",
  });
  assert.equal(task.status, "active");
  assert.equal(task.baseMainHead, mainHeadBefore);
  assert.equal(task.baseline.clean, false);
  assert.equal(task.baseline.untrackedFiles, 1);
  assert.equal(task.baseline.ignoredFiles, 1);
  assert.match(task.baseline.ignoredFingerprint, /^[0-9a-f]{64}$/u);
  assert.equal(await readFile(join(source, "README.md"), "utf8"), "dirty main must remain\n");
  assert.equal(await readFile(join(task.candidatePath, "README.md"), "utf8"), "committed main\n");
  assert.equal(await readFile(join(task.candidatePath, "delete-me.txt"), "utf8"), "delete me\n");
  await assert.rejects(readFile(join(source, "delete-me.txt"), "utf8"), /ENOENT/u);
  assert.equal((await execFileAsync("git", ["branch", "--show-current"], { cwd: source })).stdout.trim(), "main");
  assert.equal((await execFileAsync("git", ["status", "--porcelain=v1"], { cwd: source })).stdout, mainStatusBefore);

  await writeFile(join(task.candidatePath, "candidate.txt"), "uncommitted\n", "utf8");
  await assert.rejects(
    registry.checkpoint({ taskId: task.taskId, roomId: "demo", mainPath: source, summary: "too early" }),
    /CANDIDATE_CHECKPOINT_REQUIRES_CLEAN_WORKTREE/u,
  );
  await execFileAsync("git", ["add", "candidate.txt"], { cwd: task.candidatePath });
  await execFileAsync("git", [
    "-c", "user.name=Candidate Test", "-c", "user.email=test@example.invalid",
    "commit", "-m", "candidate implementation",
  ], { cwd: task.candidatePath });
  const candidateHead = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: task.candidatePath })).stdout.trim();
  const checkpoint = await registry.checkpoint({
    taskId: task.taskId, roomId: "demo", mainPath: source, summary: "implementation committed",
  });
  assert.equal(checkpoint.candidateHead, candidateHead);

  const completed = await registry.complete({
    taskId: task.taskId,
    roomId: "demo",
    mainPath: source,
    summary: "candidate is ready for owner review",
    tests: [{ command: "npm test", status: "passed", summary: "synthetic pass" }],
    knownRisks: ["merge is deliberately not implemented in this phase"],
  });
  assert.equal(completed.task.status, "completed");
  assert.equal(completed.completion.mergeDecision, "owner-required");
  assert.equal(completed.completion.preview.candidateHead, candidateHead);
  assert.equal(completed.completion.preview.mainHead, mainHeadBefore);
  assert.equal(completed.completion.preview.mainDrift, false);
  assert.equal(completed.completion.preview.fileCount, 1);
  assert.equal(completed.completion.preview.files[0]?.path, "candidate.txt");
  assert.match(completed.completion.prompt, /尚未修改 main/u);
  assert.ok(completed.completion.preview.conflicts.includes("DIRTY_MAIN_BASELINE_WAS_RECORDED_BUT_NOT_COPIED_TO_CANDIDATE"));
  assert.ok(completed.completion.preview.conflicts.includes("CURRENT_DIRTY_MAIN_CHANGES_ARE_EXCLUDED_FROM_CANDIDATE"));
  assert.equal(completed.checkpoint.recoveryRef, completed.completion.preview.recovery.ref);
  assert.equal(
    (await execFileAsync("git", ["rev-parse", "--verify", `${completed.checkpoint.recoveryRef}^{commit}`], { cwd: source })).stdout.trim(),
    candidateHead,
  );
  assert.equal((await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: source })).stdout.trim(), mainHeadBefore);
  assert.equal((await execFileAsync("git", ["status", "--porcelain=v1"], { cwd: source })).stdout, mainStatusBefore);

  const secondProcess = new CandidateRegistry(data);
  const shared = await secondProcess.status({ roomId: "demo", mainPath: source, taskId: task.taskId });
  secondProcess.close();
  assert.equal(shared[0]?.live.completionStale, false);
  assert.equal(shared[0]?.live.recoveryReady, true);
  assert.equal(shared[0]?.checkpoints.length, 2);
  await commit(task.candidatePath, "after-completion.txt", "new snapshot\n", "post-completion drift");
  const drifted = (await registry.status({ roomId: "demo", mainPath: source, taskId: task.taskId }))[0];
  assert.equal(drifted?.live.completionStale, true);
  assert.equal(drifted?.live.recoveryReady, true);
  await execFileAsync("git", ["update-ref", "-d", completed.checkpoint.recoveryRef], { cwd: source });
  assert.equal((await registry.status({
    roomId: "demo", mainPath: source, taskId: task.taskId,
  }))[0]?.live.recoveryReady, false);
  await assert.rejects(
    registry.checkpoint({ taskId: task.taskId, roomId: "other", mainPath: source, summary: "wrong scope" }),
    /CANDIDATE_NOT_ACTIVE/u,
  );
});

test("candidate completion reports main HEAD drift and never promotes it", async (t) => {
  const { source, data } = await fixture(t);
  const registry = new CandidateRegistry(data, { maxFiles: 1 });
  t.after(() => registry.close());
  const task = await registry.start({ roomId: "demo", mainPath: source, task: "drift test" });
  await commit(task.candidatePath, "candidate.txt", "candidate\n", "candidate");
  await commit(task.candidatePath, "candidate-two.txt", "candidate two\n", "candidate two");
  const changedMainHead = await commit(source, "main-only.txt", "main\n", "main drift");
  const completed = await registry.complete({
    taskId: task.taskId, roomId: "demo", mainPath: source, summary: "preview with drift",
  });
  assert.equal(completed.completion.preview.mainHead, changedMainHead);
  assert.equal(completed.completion.preview.mainDrift, true);
  assert.equal(completed.completion.preview.fileCount, 2);
  assert.equal(completed.completion.preview.files.length, 1);
  assert.equal(completed.completion.preview.filesTruncated, true);
  assert.equal(completed.completion.preview.largeFileScanTruncated, true);
  assert.deepEqual(completed.completion.preview.conflicts, ["MAIN_DRIFT_REQUIRES_FRESH_MERGE_PREVIEW"]);
  assert.equal((await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: source })).stdout.trim(), changedMainHead);
  assert.equal(await readFile(join(source, "main-only.txt"), "utf8"), "main\n");
});

test("candidate completion rejects a deterministic dirty-state TOCTOU change", async (t) => {
  const { source, data } = await fixture(t);
  const gitBroker = new HookedGitBroker();
  const registry = new CandidateRegistry(data, { gitBroker });
  t.after(() => registry.close());
  const task = await registry.start({ roomId: "demo", mainPath: source, task: "TOCTOU guard" });
  await commit(task.candidatePath, "candidate.txt", "committed\n", "candidate");
  let injected = false;
  gitBroker.afterInspect = async (workspace) => {
    if (injected || workspace !== task.candidatePath) return;
    injected = true;
    await writeFile(join(workspace, "late-change.txt"), "arrived after first inspection\n", "utf8");
  };
  await assert.rejects(
    registry.complete({ taskId: task.taskId, roomId: "demo", mainPath: source, summary: "must reject race" }),
    /CANDIDATE_COMPLETION_SNAPSHOT_CHANGED/u,
  );
  assert.equal(injected, true);
  assert.equal(registry.get(task.taskId)?.status, "active");
});

test("candidate inventories stream beyond the former capture ceilings", { timeout: 60_000 }, async (t) => {
  const { source, data } = await fixture(t);
  const ignoredDirectory = join(source, "i".repeat(240), "j".repeat(240));
  await mkdir(ignoredDirectory, { recursive: true });
  const ignoredNames = Array.from({ length: 3_100 }, (_, index) =>
    `${String(index).padStart(4, "0")}-${"q".repeat(195)}.cache`);
  for (let offset = 0; offset < ignoredNames.length; offset += 100) {
    await Promise.all(ignoredNames.slice(offset, offset + 100)
      .map(async (name) => await writeFile(join(ignoredDirectory, name), "")));
  }
  const ignoredOutput = (await execFileAsync(
    "git", ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"],
    { cwd: source, maxBuffer: 8 * 1_048_576 },
  )).stdout;
  assert.ok(Buffer.byteLength(ignoredOutput) > 2 * 1_048_576);
  const untrackedNames = Array.from({ length: 1_600 }, (_, index) =>
    `${String(index).padStart(4, "0")}-${"u".repeat(200)}.draft`);
  for (let offset = 0; offset < untrackedNames.length; offset += 100) {
    await Promise.all(untrackedNames.slice(offset, offset + 100)
      .map(async (name) => await writeFile(join(ignoredDirectory, name), "")));
  }
  const statusOutput = (await execFileAsync(
    "git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    { cwd: source, maxBuffer: 8 * 1_048_576 },
  )).stdout;
  assert.ok(Buffer.byteLength(statusOutput) > 1_048_576);

  const registry = new CandidateRegistry(data, { maxFiles: 1 });
  t.after(() => registry.close());
  const task = await registry.start({ roomId: "demo", mainPath: source, task: "large streamed inventories" });
  const emptyBlob = (await gitWithInput(task.candidatePath, ["hash-object", "-w", "--stdin"], "")).trim();
  const baseTree = (await execFileAsync("git", ["ls-tree", "-z", "HEAD"], {
    cwd: task.candidatePath, maxBuffer: 8 * 1_048_576,
  })).stdout;
  const bulkNames = Array.from({ length: 9_200 }, (_, index) =>
    `bulk-${String(index).padStart(5, "0")}-${"x".repeat(215)}`);
  const treeInput = baseTree + bulkNames
    .map((name) => `100644 blob ${emptyBlob}\t${name}\0`)
    .join("");
  const tree = (await gitWithInput(task.candidatePath, ["mktree", "-z"], treeInput)).trim();
  const head = (await gitWithInput(task.candidatePath, [
    "-c", "user.name=Candidate Test", "-c", "user.email=test@example.invalid",
    "commit-tree", tree, "-p", task.baseMainHead,
  ], "large streamed diff\n")).trim();
  await execFileAsync("git", ["merge", "--ff-only", head], {
    cwd: task.candidatePath, maxBuffer: 8 * 1_048_576,
  });
  const nameStatusOutput = (await execFileAsync(
    "git", ["diff", "--name-status", "-z", task.baseMainHead, head, "--"],
    { cwd: task.candidatePath, maxBuffer: 8 * 1_048_576 },
  )).stdout;
  const numstatOutput = (await execFileAsync(
    "git", ["diff", "--numstat", "-z", "--no-renames", task.baseMainHead, head, "--"],
    { cwd: task.candidatePath, maxBuffer: 8 * 1_048_576 },
  )).stdout;
  assert.ok(Buffer.byteLength(nameStatusOutput) > 2 * 1_048_576);
  assert.ok(Buffer.byteLength(numstatOutput) > 2 * 1_048_576);
  const completed = await registry.complete({
    taskId: task.taskId, roomId: "demo", mainPath: source, summary: "streamed without blocking",
  });
  assert.equal(completed.completion.preview.fileCount, bulkNames.length);
  assert.equal(completed.completion.preview.files.length, 1);
  assert.equal(completed.completion.preview.filesTruncated, true);
  assert.equal(completed.completion.preview.additions, 0);
  assert.equal(completed.completion.preview.deletions, 0);
  assert.equal(completed.completion.preview.mainDirty.ignoredFiles, ignoredNames.length);
  assert.equal(completed.completion.preview.mainDirty.untrackedFiles, untrackedNames.length);
});

test("candidate metadata tampering is detected on reopen", async (t) => {
  const { source, data } = await fixture(t);
  const registry = new CandidateRegistry(data);
  await registry.start({ roomId: "demo", mainPath: source, task: "tamper test" });
  const path = registry.path;
  registry.close();
  const db = new DatabaseSync(path);
  db.prepare("UPDATE candidates SET task_text='tampered'").run();
  db.close();
  assert.throws(() => new CandidateRegistry(data), /CANDIDATE_ROW_TAMPERED/u);
});

test("candidate creation rejects unsafe repository-local filters without changing main", async (t) => {
  const { source, data } = await fixture(t);
  await execFileAsync("git", ["config", "filter.evil.clean", "malicious-command"], { cwd: source });
  const head = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: source })).stdout.trim();
  const registry = new CandidateRegistry(data);
  t.after(() => registry.close());
  await assert.rejects(
    registry.start({ roomId: "demo", mainPath: source, task: "unsafe filter" }),
    /UNSAFE_LOCAL_GIT_FILTER_OR_FSMONITOR_CONFIG/u,
  );
  assert.equal((await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: source })).stdout.trim(), head);
  assert.equal(registry.inventory().tasks, 1);
  assert.equal(registry.inventory().active, 0);
});

test("completion preview reports rename, delete, binary, and large-file operations", async (t) => {
  const { source, data } = await fixture(t);
  const registry = new CandidateRegistry(data);
  t.after(() => registry.close());
  const task = await registry.start({ roomId: "demo", mainPath: source, task: "diff operation preview" });
  await execFileAsync("git", ["mv", "README.md", "RENAMED.md"], { cwd: task.candidatePath });
  await execFileAsync("git", ["rm", "delete-me.txt"], { cwd: task.candidatePath });
  const binary = Buffer.alloc(5 * 1_048_576 + 1, 0);
  binary[0] = 1;
  await writeFile(join(task.candidatePath, "large.bin"), binary);
  await execFileAsync("git", ["add", "large.bin"], { cwd: task.candidatePath });
  await execFileAsync("git", [
    "-c", "user.name=Candidate Test", "-c", "user.email=test@example.invalid",
    "commit", "-m", "mixed diff operations",
  ], { cwd: task.candidatePath });
  const completed = await registry.complete({
    taskId: task.taskId, roomId: "demo", mainPath: source, summary: "mixed preview",
  });
  const preview = completed.completion.preview;
  assert.equal(preview.filesTruncated, false);
  assert.equal(preview.largeFileScanTruncated, false);
  assert.equal(preview.binaryEntries, 1);
  assert.deepEqual(preview.largeFiles, ["large.bin"]);
  assert.ok(preview.files.some((file) => file.operation === "rename" && file.previousPath === "README.md" && file.path === "RENAMED.md"));
  assert.ok(preview.files.some((file) => file.operation === "delete" && file.path === "delete-me.txt"));
  assert.ok(preview.files.some((file) => file.operation === "add" && file.path === "large.bin"));
});

test("candidate registry rejects a future schema version", async (t) => {
  const { data } = await fixture(t);
  const registry = new CandidateRegistry(data);
  const path = registry.path;
  registry.close();
  const db = new DatabaseSync(path);
  db.exec("PRAGMA user_version=2");
  db.close();
  assert.throws(() => new CandidateRegistry(data), /CANDIDATE_REGISTRY_SCHEMA_UNSUPPORTED/u);
});

test("candidate registry validates bounded public inputs and lifecycle state", async (t) => {
  const { source, data } = await fixture(t);
  assert.throws(() => new CandidateRegistry(data, { maxFiles: 0 }), /CANDIDATE_MAX_FILES_INVALID/u);
  assert.throws(() => new CandidateRegistry(data, { maxFiles: 10_001 }), /CANDIDATE_MAX_FILES_INVALID/u);
  assert.throws(() => new CandidateRegistry(data, { maxFiles: 1.5 }), /CANDIDATE_MAX_FILES_INVALID/u);
  const registry = new CandidateRegistry(data);
  assert.deepEqual(await registry.status({ roomId: "demo", mainPath: source }), []);
  await assert.rejects(registry.start({ roomId: "Bad", mainPath: source, task: "x" }), /CANDIDATE_ROOM_INVALID/u);
  await assert.rejects(registry.start({ roomId: "demo", mainPath: source, task: "" }), /CANDIDATE_TASK_TEXT_INVALID/u);
  await assert.rejects(
    registry.start({ roomId: "demo", mainPath: source, task: "x", acceptanceCriteria: "\0" }),
    /CANDIDATE_ACCEPTANCE_INVALID/u,
  );
  const task = await registry.start({ roomId: "demo", mainPath: source, task: "boundary test" });
  assert.equal(registry.get(task.taskId)?.taskId, task.taskId);
  assert.equal(registry.get("00000000-0000-4000-8000-000000000999"), undefined);
  assert.throws(() => registry.get("bad"), /CANDIDATE_TASK_ID_INVALID/u);
  await assert.rejects(
    registry.checkpoint({ taskId: task.taskId, roomId: "other", mainPath: source, summary: "wrong" }),
    /CANDIDATE_SCOPE_MISMATCH/u,
  );
  await assert.rejects(
    registry.checkpoint({ taskId: task.taskId, roomId: "demo", mainPath: source, summary: "" }),
    /CANDIDATE_CHECKPOINT_SUMMARY_INVALID/u,
  );
  for (const invalid of [
    { tests: "bad" },
    { tests: Array(33).fill({ command: "x", status: "passed" }) },
    { tests: [null] },
    { tests: [{ command: "x", status: "passed", extra: true }] },
    { tests: [{ command: "x", status: "unknown" }] },
    { tests: [{ command: "", status: "passed" }] },
    { tests: [{ command: "x", status: "passed", summary: "" }] },
  ]) {
    await assert.rejects(
      registry.complete({
        taskId: task.taskId, roomId: "demo", mainPath: source, summary: "invalid tests", ...invalid,
      }),
      /CANDIDATE_TESTS_INVALID/u,
    );
  }
  for (const knownRisks of ["bad", Array(33).fill("risk"), [""]]) {
    await assert.rejects(
      registry.complete({
        taskId: task.taskId, roomId: "demo", mainPath: source, summary: "invalid risks", knownRisks,
      }),
      /CANDIDATE_RISKS_INVALID/u,
    );
  }
  await assert.rejects(
    registry.complete({ taskId: task.taskId, roomId: "demo", mainPath: source, summary: "" }),
    /CANDIDATE_COMPLETION_SUMMARY_INVALID/u,
  );
  await assert.rejects(registry.status({ roomId: "Bad", mainPath: source }), /CANDIDATE_ROOM_INVALID/u);
  await assert.rejects(
    registry.status({ roomId: "demo", mainPath: source, taskId: "bad" }),
    /CANDIDATE_TASK_ID_INVALID/u,
  );
  await assert.rejects(
    registry.status({ roomId: "other", mainPath: source, taskId: task.taskId }),
    /CANDIDATE_SCOPE_MISMATCH/u,
  );
  assert.deepEqual(await registry.reconcileCreating(0), { activated: 0, failed: 0 });
  await assert.rejects(registry.reconcileCreating(-1), /CANDIDATE_RECOVERY_GRACE_INVALID/u);
  await assert.rejects(registry.reconcileCreating(86_400_001), /CANDIDATE_RECOVERY_GRACE_INVALID/u);
  await assert.rejects(registry.reconcileCreating(1.5), /CANDIDATE_RECOVERY_GRACE_INVALID/u);
  assert.equal(registry.inventory().tasks, 1);
  assert.deepEqual(registry.integrity(), { schemaVersion: 1, quickCheck: "ok", rowsValid: true });
  await registry.complete({
    taskId: task.taskId, roomId: "demo", mainPath: source, summary: "complete boundary test",
    tests: [{ command: "node --test", status: "not-run" }], knownRisks: ["none"],
  });
  await writeFile(join(source, "README.md"), "post-completion dirty main\n", "utf8");
  assert.equal((await registry.status({
    roomId: "demo", mainPath: source, taskId: task.taskId,
  }))[0]?.live.completionStale, true);
  await writeFile(join(source, "README.md"), "committed main\n", "utf8");
  assert.equal((await registry.status({
    roomId: "demo", mainPath: source, taskId: task.taskId,
  }))[0]?.live.completionStale, false);
  await writeFile(join(source, "post-completion.cache"), "ignored drift\n", "utf8");
  assert.equal((await registry.status({
    roomId: "demo", mainPath: source, taskId: task.taskId,
  }))[0]?.live.completionStale, true);
  await assert.rejects(
    registry.checkpoint({ taskId: task.taskId, roomId: "demo", mainPath: source, summary: "late" }),
    /CANDIDATE_NOT_ACTIVE/u,
  );
  registry.close();
  registry.close();
  assert.throws(() => registry.inventory(), /CANDIDATE_REGISTRY_CLOSED/u);
});

test("stale creating metadata reactivates a matching worktree and retains a missing one as failed", async (t) => {
  const { source, data } = await fixture(t);
  let registry = new CandidateRegistry(data);
  const task = await registry.start({ roomId: "demo", mainPath: source, task: "recover create" });
  const databasePath = registry.path;
  registry.close();
  let db = new DatabaseSync(databasePath);
  let row = db.prepare("SELECT * FROM candidates WHERE task_id=?").get(task.taskId) as Record<string, unknown>;
  row = { ...row, status: "creating" };
  db.prepare("UPDATE candidates SET status=?,row_hash=? WHERE task_id=?")
    .run("creating", candidateRowHash(row), task.taskId);
  db.close();
  registry = new CandidateRegistry(data);
  assert.deepEqual(await registry.reconcileCreating(0), { activated: 1, failed: 0 });
  assert.equal(registry.get(task.taskId)?.status, "active");
  registry.close();

  await execFileAsync("git", ["config", "filter.evil.clean", "malicious-command"], { cwd: source });
  registry = new CandidateRegistry(data);
  await assert.rejects(
    registry.start({ roomId: "demo", mainPath: source, task: "missing candidate" }),
    /UNSAFE_LOCAL_GIT_FILTER_OR_FSMONITOR_CONFIG/u,
  );
  registry.close();
  db = new DatabaseSync(databasePath);
  row = db.prepare("SELECT * FROM candidates WHERE status='failed' ORDER BY created_at_ms DESC LIMIT 1").get() as Record<string, unknown>;
  row = { ...row, status: "creating" };
  db.prepare("UPDATE candidates SET status=?,row_hash=? WHERE task_id=?")
    .run("creating", candidateRowHash(row), String(row.task_id));
  db.close();
  registry = new CandidateRegistry(data);
  assert.deepEqual(await registry.reconcileCreating(0), { activated: 0, failed: 1 });
  assert.equal(registry.get(String(row.task_id))?.status, "failed");
  registry.close();
});

test("candidate integrity rejects semantic row, completion, and checkpoint corruption", async (t) => {
  await t.test("baseline", async (child) => {
    const { source, data } = await fixture(child);
    const registry = new CandidateRegistry(data);
    const task = await registry.start({ roomId: "demo", mainPath: source, task: "baseline corruption" });
    const path = registry.path;
    registry.close();
    const db = new DatabaseSync(path);
    let row = db.prepare("SELECT * FROM candidates WHERE task_id=?").get(task.taskId) as Record<string, unknown>;
    row = { ...row, baseline_json: "null" };
    db.prepare("UPDATE candidates SET baseline_json=?,row_hash=? WHERE task_id=?")
      .run("null", candidateRowHash(row), task.taskId);
    db.close();
    assert.throws(() => new CandidateRegistry(data), /CANDIDATE_BASELINE_INVALID/u);
  });

  await t.test("completion state", async (child) => {
    const { source, data } = await fixture(child);
    const registry = new CandidateRegistry(data);
    const task = await registry.start({ roomId: "demo", mainPath: source, task: "completion state corruption" });
    const path = registry.path;
    registry.close();
    const db = new DatabaseSync(path);
    let row = db.prepare("SELECT * FROM candidates WHERE task_id=?").get(task.taskId) as Record<string, unknown>;
    row = { ...row, status: "completed" };
    db.prepare("UPDATE candidates SET status=?,row_hash=? WHERE task_id=?")
      .run("completed", candidateRowHash(row), task.taskId);
    db.close();
    assert.throws(() => new CandidateRegistry(data), /CANDIDATE_COMPLETION_STATE_INVALID/u);
  });

  await t.test("completion payload", async (child) => {
    const { source, data } = await fixture(child);
    const registry = new CandidateRegistry(data);
    const task = await registry.start({ roomId: "demo", mainPath: source, task: "completion payload corruption" });
    await registry.complete({ taskId: task.taskId, roomId: "demo", mainPath: source, summary: "complete" });
    const path = registry.path;
    registry.close();
    const db = new DatabaseSync(path);
    let row = db.prepare("SELECT * FROM candidates WHERE task_id=?").get(task.taskId) as Record<string, unknown>;
    row = { ...row, completion_json: "null" };
    db.prepare("UPDATE candidates SET completion_json=?,row_hash=? WHERE task_id=?")
      .run("null", candidateRowHash(row), task.taskId);
    db.close();
    assert.throws(() => new CandidateRegistry(data), /CANDIDATE_COMPLETION_INVALID/u);
  });

  await t.test("checkpoint", async (child) => {
    const { source, data } = await fixture(child);
    const registry = new CandidateRegistry(data);
    const task = await registry.start({ roomId: "demo", mainPath: source, task: "checkpoint corruption" });
    await registry.checkpoint({ taskId: task.taskId, roomId: "demo", mainPath: source, summary: "checkpoint" });
    const path = registry.path;
    registry.close();
    const db = new DatabaseSync(path);
    db.prepare("UPDATE candidate_checkpoints SET row_hash=?").run("0".repeat(64));
    db.close();
    assert.throws(() => new CandidateRegistry(data), /CANDIDATE_CHECKPOINT_ROW_TAMPERED/u);
  });
});
