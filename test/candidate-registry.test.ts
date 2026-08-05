import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  CandidateRegistry, MAX_MERGE_CONFLICTS, MAX_ORPHAN_RECOVERY_REFS, MAX_PREVIEW_SUBMODULES,
  parseRawDiffRecord, type CandidateCheckpoint, type CandidateTask,
} from "../src/core/candidate-registry.ts";
import { GitBroker, type GitInspection } from "../src/core/git-broker.ts";

const execFileAsync = promisify(execFile);

/** One fresh durable idempotency key per logical call; retries deliberately reuse a captured value. */
const key = (): string => randomUUID();

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

/**
 * Models a seat that reserves an idempotency key and then dies before creating any durable artifact:
 * the first inspection reports that it has been entered, stalls until released, and then fails.
 */
class StallingGitBroker extends GitBroker {
  stall: Promise<void> | undefined;
  entered?: () => void;

  override async inspect(workspace: string): Promise<GitInspection> {
    const stall = this.stall;
    if (stall === undefined) return await super.inspect(workspace);
    this.stall = undefined;
    this.entered?.();
    await stall;
    throw new Error("SYNTHETIC_MAIN_INSPECTION_FAILED");
  }
}

/**
 * Reports a main HEAD that is not a commit id, standing in for any way the observed head could stop
 * being one. Nothing but a commit id may ever be handed to git as an argument.
 */
class UnverifiedHeadGitBroker extends GitBroker {
  head?: string;

  override async headSha(workspace: string): Promise<string> {
    return this.head ?? await super.headSha(workspace);
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

function requestRowHash(row: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify([
    row.client_request_id, row.owner_token, row.owner_pid, row.actor, row.operation, row.room_id, row.input_digest,
    row.reserved_json, row.state, row.receipt_json, row.created_at_ms, row.updated_at_ms,
  ]), "utf8").digest("hex");
}

/**
 * Simulates a process that died after the mutation committed but before the receipt was settled.
 * The timestamps are backdated past REQUEST_IN_FLIGHT_MS because a retry that arrives while the key
 * still looks live is correctly refused as in-flight; the crash-recovery path is what is under test.
 */
function stripSettledReceipt(path: string, clientRequestId: string): void {
  const db = new DatabaseSync(path);
  let row = db.prepare("SELECT * FROM candidate_requests WHERE client_request_id=?")
    .get(clientRequestId) as Record<string, unknown>;
  const created = Number(row.created_at_ms) - 60_000;
  row = { ...row, state: "pending", receipt_json: null, created_at_ms: created, updated_at_ms: created };
  db.prepare(
    "UPDATE candidate_requests SET state=?,receipt_json=?,created_at_ms=?,updated_at_ms=?,row_hash=? WHERE client_request_id=?",
  ).run("pending", null, created, created, requestRowHash(row), clientRequestId);
  db.close();
}

/**
 * The mirror of stripSettledReceipt: the owner's settle finally lands. The key stops holding its
 * reservation, so a `creating` row it was guarding becomes reconcilable again.
 */
function restoreSettledReceipt(path: string, clientRequestId: string): void {
  const db = new DatabaseSync(path);
  let row = db.prepare("SELECT * FROM candidate_requests WHERE client_request_id=?")
    .get(clientRequestId) as Record<string, unknown>;
  const receipt = "{\"settled\":true}";
  row = { ...row, state: "succeeded", receipt_json: receipt };
  const changes = db.prepare("UPDATE candidate_requests SET state=?,receipt_json=?,row_hash=? WHERE client_request_id=?")
    .run("succeeded", receipt, requestRowHash(row), clientRequestId).changes;
  db.close();
  assert.equal(Number(changes), 1);
}

/**
 * A `pending` reservation whose reserved identifiers no longer parse. The ledger is advisory, so
 * such a row must guard nothing and must not stop recovery of the authoritative candidates table.
 */
function corruptReservedIdentifiers(path: string, clientRequestId: string): void {
  const db = new DatabaseSync(path);
  let row = db.prepare("SELECT * FROM candidate_requests WHERE client_request_id=?")
    .get(clientRequestId) as Record<string, unknown>;
  row = { ...row, reserved_json: "null" };
  const changes = db.prepare("UPDATE candidate_requests SET reserved_json=?,row_hash=? WHERE client_request_id=?")
    .run("null", requestRowHash(row), clientRequestId).changes;
  db.close();
  assert.equal(Number(changes), 1);
}

/**
 * Simulates a creator killed with SIGKILL mid-create: the reservation is left `pending` and re-stamped
 * with the pid of the process that held it. Backdated for the same reason as stripSettledReceipt, and
 * re-hashed so the row is indistinguishable from one the owner itself wrote — the recovery guard must turn
 * on the owner's liveness, never on a row that merely looks doctored.
 */
function strandReservation(path: string, clientRequestId: string, ownerPid: number): void {
  const db = new DatabaseSync(path);
  let row = db.prepare("SELECT * FROM candidate_requests WHERE client_request_id=?")
    .get(clientRequestId) as Record<string, unknown>;
  const created = Number(row.created_at_ms) - 60_000;
  row = {
    ...row, owner_pid: ownerPid, state: "pending", receipt_json: null,
    created_at_ms: created, updated_at_ms: created,
  };
  const changes = db.prepare(`UPDATE candidate_requests
    SET owner_pid=?,state=?,receipt_json=?,created_at_ms=?,updated_at_ms=?,row_hash=? WHERE client_request_id=?`)
    .run(ownerPid, "pending", null, created, created, requestRowHash(row), clientRequestId).changes;
  db.close();
  assert.equal(Number(changes), 1);
}

function requestOwnerPid(path: string, clientRequestId: string): number {
  const db = new DatabaseSync(path);
  const row = db.prepare("SELECT owner_pid FROM candidate_requests WHERE client_request_id=?")
    .get(clientRequestId) as { owner_pid: number };
  db.close();
  return Number(row.owner_pid);
}

/**
 * A pid that provably belongs to nothing: a child is started, killed outright, reaped, and then
 * confirmed absent. Picking a number out of the air would prove nothing, because the whole question
 * the recovery guard asks is whether that pid is running.
 */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  const pid = child.pid;
  assert.equal(typeof pid, "number");
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.kill("SIGKILL");
  });
  assert.throws(
    () => process.kill(pid as number, 0),
    (error: NodeJS.ErrnoException) => error.code === "ESRCH",
  );
  return pid as number;
}

function forceCandidateStatus(path: string, taskId: string, status: string): void {
  const db = new DatabaseSync(path);
  let row = db.prepare("SELECT * FROM candidates WHERE task_id=?").get(taskId) as Record<string, unknown>;
  row = { ...row, status };
  db.prepare("UPDATE candidates SET status=?,row_hash=? WHERE task_id=?")
    .run(status, candidateRowHash(row), taskId);
  db.close();
}

/**
 * Simulates a process that wrote the recovery ref and then died before the checkpoint row landed.
 * Only the child row is removed, so the parent candidate row keeps its own valid hash.
 */
function deleteCheckpointRow(path: string, checkpointId: string): void {
  const db = new DatabaseSync(path);
  const changes = db.prepare("DELETE FROM candidate_checkpoints WHERE id=?").run(checkpointId).changes;
  db.close();
  assert.equal(Number(changes), 1);
}

function countRequests(path: string): number {
  const db = new DatabaseSync(path);
  const row = db.prepare("SELECT COUNT(*) AS total FROM candidate_requests").get() as { total: number };
  db.close();
  return Number(row.total);
}

function storedRequest(path: string, clientRequestId: string): { state: string; receipt: string | null } {
  const db = new DatabaseSync(path);
  const row = db.prepare("SELECT state, receipt_json FROM candidate_requests WHERE client_request_id=?")
    .get(clientRequestId) as { state: string; receipt_json: string | null };
  db.close();
  return { state: row.state, receipt: row.receipt_json };
}

function requestClock(path: string, clientRequestId: string): { created: number; updated: number } {
  const db = new DatabaseSync(path);
  const row = db.prepare("SELECT created_at_ms, updated_at_ms FROM candidate_requests WHERE client_request_id=?")
    .get(clientRequestId) as { created_at_ms: number; updated_at_ms: number };
  db.close();
  return { created: Number(row.created_at_ms), updated: Number(row.updated_at_ms) };
}

/**
 * Hands the reservation to a different owner exactly as an adopting seat does inside #beginRequest,
 * so the token an already-running call still holds is no longer the one the row carries.
 */
function rotateRequestOwner(path: string, clientRequestId: string): string {
  const db = new DatabaseSync(path);
  let row = db.prepare("SELECT * FROM candidate_requests WHERE client_request_id=?")
    .get(clientRequestId) as Record<string, unknown>;
  const ownerToken = randomUUID();
  row = { ...row, owner_token: ownerToken };
  const changes = db.prepare("UPDATE candidate_requests SET owner_token=?,row_hash=? WHERE client_request_id=?")
    .run(ownerToken, requestRowHash(row), clientRequestId).changes;
  db.close();
  assert.equal(Number(changes), 1);
  return ownerToken;
}

function tableRows(path: string, table: "candidates" | "candidate_checkpoints"): Record<string, unknown>[] {
  const db = new DatabaseSync(path);
  const rows = db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as unknown as Record<string, unknown>[];
  db.close();
  return rows;
}

/**
 * The v2 request ledger, byte for byte as the older build wrote it: eleven columns and no
 * `owner_token`. Ownership was added to this definition without bumping the schema version, so a
 * database written by that build opened cleanly and then failed its first mutation with a raw SQLite
 * string ("table candidate_requests has 11 columns but 12 values were supplied").
 */
const V2_REQUESTS_TABLE_SQL = `CREATE TABLE candidate_requests (
        client_request_id TEXT PRIMARY KEY CHECK(length(client_request_id)=36),
        actor TEXT NOT NULL CHECK(length(actor) BETWEEN 1 AND 64),
        operation TEXT NOT NULL CHECK(operation IN ('start','checkpoint','complete')),
        room_id TEXT NOT NULL CHECK(length(room_id) BETWEEN 1 AND 48),
        input_digest TEXT NOT NULL CHECK(length(input_digest)=64),
        reserved_json TEXT NOT NULL CHECK(length(reserved_json) BETWEEN 2 AND 400),
        state TEXT NOT NULL CHECK(state IN ('pending','succeeded','failed')),
        receipt_json TEXT CHECK(receipt_json IS NULL OR length(receipt_json) BETWEEN 2 AND 1000),
        created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
        updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= created_at_ms),
        row_hash TEXT NOT NULL CHECK(length(row_hash)=64)
      ) STRICT;
      CREATE INDEX candidate_requests_created ON candidate_requests(created_at_ms);`;

function storedCompletionBytes(path: string, taskId: string): number {
  const db = new DatabaseSync(path);
  const row = db.prepare("SELECT completion_json FROM candidates WHERE task_id=?")
    .get(taskId) as { completion_json: string };
  db.close();
  return Buffer.byteLength(row.completion_json, "utf8");
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

/** Commits whatever the index already holds; the mode and submodule fixtures change no file content. */
async function commitIndex(workspace: string, message: string): Promise<string> {
  await execFileAsync("git", [
    "-c", "user.name=Candidate Test", "-c", "user.email=test@example.invalid",
    "commit", "-m", message,
  ], { cwd: workspace });
  return (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: workspace })).stdout.trim();
}

/** A real nested repository, so the gitlink the preview reports names two commits that exist. */
async function nestedRepository(path: string): Promise<{ first: string; second: string }> {
  await mkdir(path);
  await execFileAsync("git", ["init", "-b", "main", "."], { cwd: path });
  await writeFile(join(path, "lib.txt"), "vendor one\n", "utf8");
  await execFileAsync("git", ["add", "lib.txt"], { cwd: path });
  const first = await commitIndex(path, "vendor one");
  await writeFile(join(path, "lib.txt"), "vendor two\n", "utf8");
  await execFileAsync("git", ["add", "lib.txt"], { cwd: path });
  const second = await commitIndex(path, "vendor two");
  return { first, second };
}

/**
 * Rewrites a stored preview and re-stamps BOTH the preview digest and the row hash, so the corrupted
 * completion is internally consistent. Anything the read path still refuses is refused on its own
 * merits rather than because a checksum stopped matching.
 */
function storeCompletionPreview(path: string, taskId: string, preview: Record<string, unknown>): void {
  const db = new DatabaseSync(path);
  let row = db.prepare("SELECT * FROM candidates WHERE task_id=?").get(taskId) as Record<string, unknown>;
  const completion = JSON.parse(String(row.completion_json)) as Record<string, unknown>;
  completion.preview = preview;
  completion.previewDigest = createHash("sha256").update(JSON.stringify(preview), "utf8").digest("hex");
  const completionJson = JSON.stringify(completion);
  row = { ...row, completion_json: completionJson };
  const changes = db.prepare("UPDATE candidates SET completion_json=?,row_hash=? WHERE task_id=?")
    .run(completionJson, candidateRowHash(row), taskId).changes;
  db.close();
  assert.equal(Number(changes), 1);
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

/** Long enough that an edit at each end is two hunks git merges without being asked to choose. */
function longFile(first: string, last: string): string {
  return [first, ...Array.from({ length: 38 }, (_, index) => `line ${String(index + 2).padStart(2, "0")}`), last]
    .join("\n") + "\n";
}

/**
 * Copies main — objects, refs and worktree — into a throwaway directory beside it, then carries the
 * merge all the way out with real git. A preview asserted against a hand-built fixture only ever
 * proves what its author believed the fixture would do; this is the merge itself, so the preview is
 * being measured against the outcome the owner would actually get.
 */
async function actualMerge(root: string, name: string, source: string, candidateHead: string):
  Promise<{ merged: boolean; conflicts: string[] }> {
  const copy = join(root, name);
  await cp(source, copy, { recursive: true });
  // The copy inherits main's worktree registry, whose entries still name the live candidate
  // directory. Dropping it leaves a self-contained repository that cannot reach back into anything
  // this exercise is about to make assertions on.
  await rm(join(copy, ".git", "worktrees"), { recursive: true, force: true });
  let merged = true;
  try {
    await execFileAsync("git", [
      "-c", "user.name=Candidate Test", "-c", "user.email=test@example.invalid",
      "merge", "--no-ff", "--no-commit", candidateHead,
    ], { cwd: copy });
  } catch {
    // Conflicts and refusals share an exit status here exactly as they do for merge-tree; the
    // conflicted index read below is what distinguishes them.
    merged = false;
  }
  const unmerged = (await execFileAsync("git", ["ls-files", "-u", "-z"], { cwd: copy })).stdout;
  // One conflicted path yields up to three stage rows, so the paths are a set, and order is git's
  // business rather than a fact the preview should have to reproduce.
  const conflicts = [...new Set(unmerged.split("\0").filter((entry) => entry !== "")
    .map((entry) => entry.slice(entry.indexOf("\t") + 1)))].sort();
  return { merged, conflicts };
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
    actor: "codex", clientRequestId: key(), roomId: "demo", mainPath: source, task: "Implement candidate lifecycle",
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
    registry.checkpoint({ actor: "codex", clientRequestId: key(), taskId: task.taskId, roomId: "demo", mainPath: source, summary: "too early" }),
    /CANDIDATE_CHECKPOINT_REQUIRES_CLEAN_WORKTREE/u,
  );
  await execFileAsync("git", ["add", "candidate.txt"], { cwd: task.candidatePath });
  await execFileAsync("git", [
    "-c", "user.name=Candidate Test", "-c", "user.email=test@example.invalid",
    "commit", "-m", "candidate implementation",
  ], { cwd: task.candidatePath });
  const candidateHead = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: task.candidatePath })).stdout.trim();
  const checkpoint = await registry.checkpoint({
    actor: "codex", clientRequestId: key(), taskId: task.taskId, roomId: "demo", mainPath: source, summary: "implementation committed",
  });
  assert.equal(checkpoint.candidateHead, candidateHead);

  const completed = await registry.complete({
    actor: "codex", clientRequestId: key(), taskId: task.taskId,
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
  // Scope is now checked before the idempotency key is reserved, so a wrong-room call is named
  // precisely instead of being reported as merely not-active — and it never reaches the ledger.
  const beforeWrongScope = countRequests(join(data, "candidate-registry.sqlite"));
  await assert.rejects(
    registry.checkpoint({ actor: "codex", clientRequestId: key(), taskId: task.taskId, roomId: "other", mainPath: source, summary: "wrong scope" }),
    /CANDIDATE_SCOPE_MISMATCH/u,
  );
  assert.equal(countRequests(join(data, "candidate-registry.sqlite")), beforeWrongScope);
});

test("candidate completion reports main HEAD drift and never promotes it", async (t) => {
  const { source, data } = await fixture(t);
  const registry = new CandidateRegistry(data, { maxFiles: 1 });
  t.after(() => registry.close());
  const task = await registry.start({ actor: "codex", clientRequestId: key(), roomId: "demo", mainPath: source, task: "drift test" });
  await commit(task.candidatePath, "candidate.txt", "candidate\n", "candidate");
  await commit(task.candidatePath, "candidate-two.txt", "candidate two\n", "candidate two");
  const changedMainHead = await commit(source, "main-only.txt", "main\n", "main drift");
  const completed = await registry.complete({
    actor: "codex", clientRequestId: key(), taskId: task.taskId, roomId: "demo", mainPath: source, summary: "preview with drift",
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
  const task = await registry.start({ actor: "codex", clientRequestId: key(), roomId: "demo", mainPath: source, task: "TOCTOU guard" });
  await commit(task.candidatePath, "candidate.txt", "committed\n", "candidate");
  let injected = false;
  gitBroker.afterInspect = async (workspace) => {
    if (injected || workspace !== task.candidatePath) return;
    injected = true;
    await writeFile(join(workspace, "late-change.txt"), "arrived after first inspection\n", "utf8");
  };
  await assert.rejects(
    registry.complete({ actor: "codex", clientRequestId: key(), taskId: task.taskId, roomId: "demo", mainPath: source, summary: "must reject race" }),
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
  const task = await registry.start({ actor: "codex", clientRequestId: key(), roomId: "demo", mainPath: source, task: "large streamed inventories" });
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
    actor: "codex", clientRequestId: key(), taskId: task.taskId, roomId: "demo", mainPath: source, summary: "streamed without blocking",
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
  await registry.start({ actor: "codex", clientRequestId: key(), roomId: "demo", mainPath: source, task: "tamper test" });
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
    registry.start({ actor: "codex", clientRequestId: key(), roomId: "demo", mainPath: source, task: "unsafe filter" }),
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
  const task = await registry.start({ actor: "codex", clientRequestId: key(), roomId: "demo", mainPath: source, task: "diff operation preview" });
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
    actor: "codex", clientRequestId: key(), taskId: task.taskId, roomId: "demo", mainPath: source, summary: "mixed preview",
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
  db.exec("PRAGMA user_version=6");
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
  await assert.rejects(registry.start({ actor: "codex", clientRequestId: key(), roomId: "Bad", mainPath: source, task: "x" }), /CANDIDATE_ROOM_INVALID/u);
  await assert.rejects(registry.start({ actor: "codex", clientRequestId: key(), roomId: "demo", mainPath: source, task: "" }), /CANDIDATE_TASK_TEXT_INVALID/u);
  await assert.rejects(
    registry.start({ actor: "codex", clientRequestId: key(), roomId: "demo", mainPath: source, task: "x", acceptanceCriteria: "\0" }),
    /CANDIDATE_ACCEPTANCE_INVALID/u,
  );
  const task = await registry.start({ actor: "codex", clientRequestId: key(), roomId: "demo", mainPath: source, task: "boundary test" });
  assert.equal(registry.get(task.taskId)?.taskId, task.taskId);
  assert.equal(registry.get("00000000-0000-4000-8000-000000000999"), undefined);
  assert.throws(() => registry.get("bad"), /CANDIDATE_TASK_ID_INVALID/u);
  await assert.rejects(
    registry.checkpoint({ actor: "codex", clientRequestId: key(), taskId: task.taskId, roomId: "other", mainPath: source, summary: "wrong" }),
    /CANDIDATE_SCOPE_MISMATCH/u,
  );
  await assert.rejects(
    registry.checkpoint({ actor: "codex", clientRequestId: key(), taskId: task.taskId, roomId: "demo", mainPath: source, summary: "" }),
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
        actor: "codex", clientRequestId: key(), taskId: task.taskId, roomId: "demo", mainPath: source, summary: "invalid tests", ...invalid,
      }),
      /CANDIDATE_TESTS_INVALID/u,
    );
  }
  for (const knownRisks of ["bad", Array(33).fill("risk"), [""]]) {
    await assert.rejects(
      registry.complete({
        actor: "codex", clientRequestId: key(), taskId: task.taskId, roomId: "demo", mainPath: source, summary: "invalid risks", knownRisks,
      }),
      /CANDIDATE_RISKS_INVALID/u,
    );
  }
  await assert.rejects(
    registry.complete({ actor: "codex", clientRequestId: key(), taskId: task.taskId, roomId: "demo", mainPath: source, summary: "" }),
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
  assert.deepEqual(registry.integrity(), { schemaVersion: 5, quickCheck: "ok", rowsValid: true });
  await registry.complete({
    actor: "codex", clientRequestId: key(), taskId: task.taskId, roomId: "demo", mainPath: source, summary: "complete boundary test",
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
    registry.checkpoint({ actor: "codex", clientRequestId: key(), taskId: task.taskId, roomId: "demo", mainPath: source, summary: "late" }),
    /CANDIDATE_NOT_ACTIVE/u,
  );
  registry.close();
  registry.close();
  assert.throws(() => registry.inventory(), /CANDIDATE_REGISTRY_CLOSED/u);
});

test("stale creating metadata reactivates a matching worktree and retains a missing one as failed", async (t) => {
  const { source, data } = await fixture(t);
  let registry = new CandidateRegistry(data);
  const task = await registry.start({ actor: "codex", clientRequestId: key(), roomId: "demo", mainPath: source, task: "recover create" });
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
    registry.start({ actor: "codex", clientRequestId: key(), roomId: "demo", mainPath: source, task: "missing candidate" }),
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
    const task = await registry.start({ actor: "codex", clientRequestId: key(), roomId: "demo", mainPath: source, task: "baseline corruption" });
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
    const task = await registry.start({ actor: "codex", clientRequestId: key(), roomId: "demo", mainPath: source, task: "completion state corruption" });
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
    const task = await registry.start({ actor: "codex", clientRequestId: key(), roomId: "demo", mainPath: source, task: "completion payload corruption" });
    await registry.complete({ actor: "codex", clientRequestId: key(), taskId: task.taskId, roomId: "demo", mainPath: source, summary: "complete" });
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
    const task = await registry.start({ actor: "codex", clientRequestId: key(), roomId: "demo", mainPath: source, task: "checkpoint corruption" });
    await registry.checkpoint({ actor: "codex", clientRequestId: key(), taskId: task.taskId, roomId: "demo", mainPath: source, summary: "checkpoint" });
    const path = registry.path;
    registry.close();
    const db = new DatabaseSync(path);
    db.prepare("UPDATE candidate_checkpoints SET row_hash=?").run("0".repeat(64));
    db.close();
    assert.throws(() => new CandidateRegistry(data), /CANDIDATE_CHECKPOINT_ROW_TAMPERED/u);
  });
});

test("an identical candidate request replays the stored receipt without duplicating any artifact", async (t) => {
  const { source, data } = await fixture(t);
  const registry = new CandidateRegistry(data);
  t.after(() => registry.close());

  const startInput = {
    actor: "codex", clientRequestId: key(), roomId: "demo", mainPath: source,
    task: "replayed start", acceptanceCriteria: "exactly one candidate",
  };
  const started = await registry.start(startInput);
  const replayedStart = await registry.start(startInput);
  assert.equal(replayedStart.taskId, started.taskId);
  assert.equal(replayedStart.candidateId, started.candidateId);
  assert.deepEqual(replayedStart, started);
  assert.equal(registry.inventory().tasks, 1);

  await commit(started.candidatePath, "candidate.txt", "candidate\n", "candidate work");
  const checkpointInput = {
    actor: "codex", clientRequestId: key(), taskId: started.taskId,
    roomId: "demo", mainPath: source, summary: "replayed checkpoint",
  };
  const checkpoint = await registry.checkpoint(checkpointInput);
  const replayedCheckpoint = await registry.checkpoint(checkpointInput);
  assert.equal(replayedCheckpoint.id, checkpoint.id);
  assert.deepEqual(replayedCheckpoint, checkpoint);
  assert.equal(registry.inventory().checkpoints, 1);
  assert.deepEqual(
    (await execFileAsync("git", [
      "for-each-ref", "--format=%(refname)", "refs/orchestratory/checkpoints",
    ], { cwd: source })).stdout.split("\n").filter(Boolean),
    [checkpoint.recoveryRef],
  );

  const completeInput = {
    actor: "codex", clientRequestId: key(), taskId: started.taskId,
    roomId: "demo", mainPath: source, summary: "replayed completion",
    tests: [{ command: "node --test", status: "passed" }], knownRisks: ["none"],
  };
  const completed = await registry.complete(completeInput);
  const replayedCompletion = await registry.complete(completeInput);
  assert.equal(replayedCompletion.completion.id, completed.completion.id);
  assert.equal(replayedCompletion.checkpoint.id, completed.checkpoint.id);
  assert.deepEqual(replayedCompletion, completed);
  assert.equal(registry.inventory().tasks, 1);
  assert.equal(registry.inventory().checkpoints, 2);
  const status = await registry.status({ roomId: "demo", mainPath: source, taskId: started.taskId });
  assert.equal(status[0]?.checkpoints.filter((entry) => entry.summary.startsWith("Completion:")).length, 1);
});

test("a candidate request key reused with different input fails closed and mutates nothing", async (t) => {
  const { source, data } = await fixture(t);
  const registry = new CandidateRegistry(data);
  t.after(() => registry.close());

  const startKey = key();
  const task = await registry.start({
    actor: "codex", clientRequestId: startKey, roomId: "demo", mainPath: source, task: "original task",
  });
  await assert.rejects(
    registry.start({
      actor: "codex", clientRequestId: startKey, roomId: "demo", mainPath: source, task: "swapped task",
    }),
    /CANDIDATE_REQUEST_IDEMPOTENCY_CONFLICT/u,
  );
  assert.equal(registry.inventory().tasks, 1);
  assert.equal(registry.get(task.taskId)?.task, "original task");

  await commit(task.candidatePath, "candidate.txt", "candidate\n", "candidate work");
  const checkpointKey = key();
  const checkpoint = await registry.checkpoint({
    actor: "codex", clientRequestId: checkpointKey, taskId: task.taskId,
    roomId: "demo", mainPath: source, summary: "original checkpoint",
  });
  await assert.rejects(
    registry.checkpoint({
      actor: "codex", clientRequestId: checkpointKey, taskId: task.taskId,
      roomId: "demo", mainPath: source, summary: "swapped checkpoint",
    }),
    /CANDIDATE_REQUEST_IDEMPOTENCY_CONFLICT/u,
  );
  assert.equal(registry.inventory().checkpoints, 1);
  assert.equal(checkpoint.summary, "original checkpoint");

  const completeKey = key();
  await registry.complete({
    actor: "codex", clientRequestId: completeKey, taskId: task.taskId,
    roomId: "demo", mainPath: source, summary: "original completion",
  });
  await assert.rejects(
    registry.complete({
      actor: "codex", clientRequestId: completeKey, taskId: task.taskId,
      roomId: "demo", mainPath: source, summary: "swapped completion",
    }),
    /CANDIDATE_REQUEST_IDEMPOTENCY_CONFLICT/u,
  );
  assert.equal(registry.inventory().checkpoints, 2);
  assert.equal(registry.inventory().tasks, 1);
  assert.equal(registry.get(task.taskId)?.completion?.summary, "original completion");
});

test("a seat that reconnects under a new display name still replays its own request id", async (t) => {
  const { source, data } = await fixture(t);
  const registry = new CandidateRegistry(data);
  t.after(() => registry.close());
  // A presence lease expiring re-mints the display name (codex1 -> codex2). That is exactly the
  // outage this ledger exists to survive, so the seat identity must not be part of the key.
  const shared = key();
  const before = await registry.start({
    actor: "codex1", clientRequestId: shared, roomId: "demo", mainPath: source, task: "shared key",
  });
  const afterReconnect = await registry.start({
    actor: "codex2", clientRequestId: shared, roomId: "demo", mainPath: source, task: "shared key",
  });
  assert.equal(before.status, "active");
  assert.equal(afterReconnect.taskId, before.taskId);
  assert.equal(afterReconnect.candidateId, before.candidateId);
  assert.equal(afterReconnect.candidatePath, before.candidatePath);
  assert.equal(registry.inventory().tasks, 1);
  assert.equal(registry.inventory().active, 1);
});

test("a reused request id with different input still fails closed across actors", async (t) => {
  const { source, data } = await fixture(t);
  const registry = new CandidateRegistry(data);
  t.after(() => registry.close());
  const shared = key();
  await registry.start({
    actor: "codex1", clientRequestId: shared, roomId: "demo", mainPath: source, task: "first task",
  });
  await assert.rejects(
    registry.start({
      actor: "claude1", clientRequestId: shared, roomId: "demo", mainPath: source, task: "different task",
    }),
    /CANDIDATE_REQUEST_IDEMPOTENCY_CONFLICT/u,
  );
  assert.equal(registry.inventory().tasks, 1);
});

test("candidate mutations reject a missing, malformed, or unowned request identity", async (t) => {
  const { source, data } = await fixture(t);
  const registry = new CandidateRegistry(data);
  t.after(() => registry.close());
  const task = await registry.start({
    actor: "codex", clientRequestId: key(), roomId: "demo", mainPath: source, task: "identity validation",
  });
  for (const clientRequestId of [undefined, "", 7, { id: key() }, "not-a-uuid", `g${key().slice(1)}`]) {
    await assert.rejects(
      registry.start({
        actor: "codex", clientRequestId, roomId: "demo", mainPath: source, task: "must not create",
      }),
      /CANDIDATE_CLIENT_REQUEST_ID_INVALID/u,
    );
    await assert.rejects(
      registry.checkpoint({
        actor: "codex", clientRequestId, taskId: task.taskId,
        roomId: "demo", mainPath: source, summary: "must not checkpoint",
      }),
      /CANDIDATE_CLIENT_REQUEST_ID_INVALID/u,
    );
    await assert.rejects(
      registry.complete({
        actor: "codex", clientRequestId, taskId: task.taskId,
        roomId: "demo", mainPath: source, summary: "must not complete",
      }),
      /CANDIDATE_CLIENT_REQUEST_ID_INVALID/u,
    );
  }
  for (const actor of ["", "   ", "a".repeat(65), "seat\0"]) {
    await assert.rejects(
      registry.start({ actor, clientRequestId: key(), roomId: "demo", mainPath: source, task: "bad actor" }),
      /CANDIDATE_ACTOR_INVALID/u,
    );
    await assert.rejects(
      registry.checkpoint({
        actor, clientRequestId: key(), taskId: task.taskId,
        roomId: "demo", mainPath: source, summary: "bad actor",
      }),
      /CANDIDATE_ACTOR_INVALID/u,
    );
    await assert.rejects(
      registry.complete({
        actor, clientRequestId: key(), taskId: task.taskId,
        roomId: "demo", mainPath: source, summary: "bad actor",
      }),
      /CANDIDATE_ACTOR_INVALID/u,
    );
  }
  assert.equal(registry.inventory().tasks, 1);
  assert.equal(registry.inventory().checkpoints, 0);
  assert.equal(registry.get(task.taskId)?.status, "active");
});

test("a v1 candidate database upgrades to the request ledger without disturbing existing rows", async (t) => {
  const { source, data } = await fixture(t);
  const registry = new CandidateRegistry(data);
  const task = await registry.start({
    actor: "codex", clientRequestId: key(), roomId: "demo", mainPath: source, task: "v1 upgrade",
  });
  const path = registry.path;
  registry.close();
  let db = new DatabaseSync(path);
  db.exec("DROP TABLE candidate_merge_promotions; DROP TABLE candidate_merge_approvals; DROP TABLE candidate_requests; PRAGMA user_version=1;");
  assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 1);
  db.close();

  const upgraded = new CandidateRegistry(data);
  assert.deepEqual(upgraded.get(task.taskId), task);
  assert.equal(upgraded.inventory().tasks, 1);
  assert.deepEqual(upgraded.integrity(), { schemaVersion: 5, quickCheck: "ok", rowsValid: true });
  upgraded.close();

  db = new DatabaseSync(path);
  assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 5);
  assert.equal((db.prepare("SELECT COUNT(*) AS total FROM candidate_requests").get() as { total: number }).total, 0);
  for (const table of ["candidate_merge_approvals", "candidate_merge_promotions"]) {
    assert.equal(
      (db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get() as { total: number }).total, 0,
    );
  }
  db.close();
});

// A v3 database already carries the request ledger; only the merge approval table is new, and the
// upgrade must not disturb a single existing candidate, checkpoint or request row.
test("a v3 candidate database gains the merge approval table without disturbing existing rows", async (t) => {
  const { source, data } = await fixture(t);
  const registry = new CandidateRegistry(data);
  const task = await registry.start({
    actor: "codex", clientRequestId: key(), roomId: "demo", mainPath: source, task: "v3 upgrade",
  });
  const path = registry.path;
  const candidatesBefore = tableRows(path, "candidates");
  registry.close();
  let db = new DatabaseSync(path);
  db.exec("DROP TABLE candidate_merge_promotions; DROP TABLE candidate_merge_approvals; PRAGMA user_version=3;");
  db.close();

  const upgraded = new CandidateRegistry(data);
  assert.deepEqual(upgraded.get(task.taskId), task);
  assert.deepEqual(upgraded.integrity(), { schemaVersion: 5, quickCheck: "ok", rowsValid: true });
  assert.equal(upgraded.inventory().mergeApprovals, 0);
  upgraded.close();
  assert.deepEqual(tableRows(path, "candidates"), candidatesBefore);

  db = new DatabaseSync(path);
  assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 5);
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS total FROM candidate_merge_promotions").get() as { total: number }).total,
    0,
  );
  db.close();
});

// The request ledger is advisory; candidates and checkpoints are authoritative. A corrupt retry row
// must poison only its own idempotency key, never make the durable candidate data unopenable.
test("candidate request tampering poisons only its own key and never bricks the registry", async (t) => {
  await t.test("input digest", async (child) => {
    const { source, data } = await fixture(child);
    const registry = new CandidateRegistry(data);
    const clientRequestId = key();
    const created = await registry.start({
      actor: "codex", clientRequestId, roomId: "demo", mainPath: source, task: "request tamper",
    });
    const path = registry.path;
    registry.close();
    const db = new DatabaseSync(path);
    const changed = db.prepare("UPDATE candidate_requests SET input_digest=?").run("a".repeat(64)).changes;
    db.close();
    assert.equal(Number(changed), 1);

    const reopened = new CandidateRegistry(data);
    child.after(() => reopened.close());
    assert.equal(reopened.inventory().tasks, 1);
    const [task] = await reopened.status({ roomId: "demo", mainPath: source, taskId: created.taskId });
    assert.equal(task?.taskId, created.taskId);
    await assert.rejects(
      reopened.start({ actor: "codex", clientRequestId, roomId: "demo", mainPath: source, task: "request tamper" }),
      /CANDIDATE_REQUEST_ROW_TAMPERED/u,
    );
    // A different key is unaffected.
    const other = await reopened.start({
      actor: "codex", clientRequestId: key(), roomId: "demo", mainPath: source, task: "unaffected",
    });
    assert.equal(other.status, "active");
  });

  await t.test("reserved identifiers", async (child) => {
    const { source, data } = await fixture(child);
    const registry = new CandidateRegistry(data);
    const clientRequestId = key();
    const created = await registry.start({
      actor: "codex", clientRequestId, roomId: "demo", mainPath: source, task: "reserved tamper",
    });
    const path = registry.path;
    registry.close();
    for (const reserved of ["null", "[]", '{"taskId":"not-a-uuid"}', '{"unexpected":"x"}', "{}"]) {
      const db = new DatabaseSync(path);
      let row = db.prepare("SELECT * FROM candidate_requests WHERE client_request_id=?")
        .get(clientRequestId) as Record<string, unknown>;
      row = { ...row, reserved_json: reserved };
      db.prepare("UPDATE candidate_requests SET reserved_json=?,row_hash=? WHERE client_request_id=?")
        .run(reserved, requestRowHash(row), clientRequestId);
      db.close();
      const reopened = new CandidateRegistry(data);
      assert.equal(reopened.inventory().tasks, 1);
      const [task] = await reopened.status({ roomId: "demo", mainPath: source, taskId: created.taskId });
      assert.equal(task?.taskId, created.taskId);
      await assert.rejects(
        reopened.start({ actor: "codex", clientRequestId, roomId: "demo", mainPath: source, task: "reserved tamper" }),
        /CANDIDATE_REQUEST_ROW_TAMPERED/u,
      );
      reopened.close();
    }
  });
});

test("an interrupted candidate request converges on retry instead of creating a second artifact", async (t) => {
  const { source, data } = await fixture(t);
  let registry = new CandidateRegistry(data);
  t.after(() => registry.close());
  const path = registry.path;

  const startInput = {
    actor: "codex", clientRequestId: key(), roomId: "demo", mainPath: source, task: "converge start",
  };
  const started = await registry.start(startInput);
  registry.close();
  stripSettledReceipt(path, startInput.clientRequestId);
  registry = new CandidateRegistry(data);
  const recoveredStart = await registry.start(startInput);
  assert.equal(recoveredStart.taskId, started.taskId);
  assert.equal(recoveredStart.candidateId, started.candidateId);
  assert.equal(registry.inventory().tasks, 1);

  await commit(started.candidatePath, "candidate.txt", "candidate\n", "candidate work");
  const checkpointInput = {
    actor: "codex", clientRequestId: key(), taskId: started.taskId,
    roomId: "demo", mainPath: source, summary: "converge checkpoint",
  };
  const checkpoint = await registry.checkpoint(checkpointInput);
  registry.close();
  stripSettledReceipt(path, checkpointInput.clientRequestId);
  registry = new CandidateRegistry(data);
  assert.deepEqual(await registry.checkpoint(checkpointInput), checkpoint);
  assert.equal(registry.inventory().checkpoints, 1);

  const completeInput = {
    actor: "codex", clientRequestId: key(), taskId: started.taskId,
    roomId: "demo", mainPath: source, summary: "converge completion",
  };
  const completed = await registry.complete(completeInput);
  registry.close();
  stripSettledReceipt(path, completeInput.clientRequestId);
  registry = new CandidateRegistry(data);
  const recoveredCompletion = await registry.complete(completeInput);
  assert.equal(recoveredCompletion.completion.id, completed.completion.id);
  assert.equal(recoveredCompletion.checkpoint.id, completed.checkpoint.id);
  assert.deepEqual(recoveredCompletion, completed);
  assert.equal(registry.inventory().checkpoints, 2);
  assert.equal(registry.inventory().tasks, 1);
});

test("an interrupted candidate create is never silently replaced by a retry of the same key", async (t) => {
  const { source, data } = await fixture(t);
  let registry = new CandidateRegistry(data);
  t.after(() => registry.close());
  const path = registry.path;
  const inFlight = {
    actor: "codex", clientRequestId: key(), roomId: "demo", mainPath: source, task: "still creating",
  };
  const creating = await registry.start(inFlight);
  registry.close();
  forceCandidateStatus(path, creating.taskId, "creating");
  stripSettledReceipt(path, inFlight.clientRequestId);
  registry = new CandidateRegistry(data);
  // A half-created candidate is a recovery wait, not a live call — distinct codes, distinct waits.
  await assert.rejects(registry.start(inFlight), /CANDIDATE_REQUEST_RECOVERING/u);
  assert.equal(registry.inventory().tasks, 1);
  assert.equal(registry.get(creating.taskId)?.status, "creating");

  // The two waits are governed by different things and must stay distinguishable. This one is bounded
  // by CREATING_RECOVERY_GRACE_MS on the wall clock and is cleared by reconcileCreating; it is not a
  // key held by a live call, so it must never be reported as CANDIDATE_REQUEST_IN_FLIGHT.
  const recovering = await registry.start(inFlight).catch((reason: unknown) => String(reason));
  assert.match(String(recovering), /CANDIDATE_REQUEST_RECOVERING/u);
  assert.doesNotMatch(String(recovering), /CANDIDATE_REQUEST_IN_FLIGHT/u);

  registry.close();
  forceCandidateStatus(path, creating.taskId, "failed");
  registry = new CandidateRegistry(data);
  await assert.rejects(registry.start(inFlight), /CANDIDATE_REQUEST_FAILED_RETRY_WITH_NEW_KEY/u);
  assert.equal(registry.inventory().tasks, 1);
  assert.equal(registry.get(creating.taskId)?.status, "failed");
  await assert.rejects(registry.start(inFlight), /CANDIDATE_REQUEST_FAILED_RETRY_WITH_NEW_KEY/u);
  assert.equal(registry.inventory().tasks, 1);

  // The other wait, for contrast: two genuinely concurrent calls on one fresh key. Exactly one
  // proceeds and the refused one is named IN_FLIGHT — the key is executing in this process right
  // now, and nothing half-created is involved, so it must never be reported as RECOVERING.
  const concurrentStart = {
    actor: "codex", clientRequestId: key(), roomId: "demo", mainPath: source, task: "two live starts",
  };
  const outcomes = await Promise.allSettled([registry.start(concurrentStart), registry.start(concurrentStart)]);
  const refused = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
  assert.equal(refused.length, 1);
  assert.match(String(refused[0]?.reason), /CANDIDATE_REQUEST_IN_FLIGHT/u);
  assert.doesNotMatch(String(refused[0]?.reason), /CANDIDATE_REQUEST_RECOVERING/u);
  const accepted = outcomes.filter(
    (outcome): outcome is PromiseFulfilledResult<CandidateTask> => outcome.status === "fulfilled",
  );
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0]?.value.status, "active");
  assert.equal(registry.inventory().tasks, 2);
});

test("a checkpoint retry adopts the recovery ref its interrupted attempt already wrote", async (t) => {
  const { source, data } = await fixture(t);
  let registry = new CandidateRegistry(data);
  t.after(() => registry.close());
  const path = registry.path;
  const task = await registry.start({
    actor: "codex", clientRequestId: key(), roomId: "demo", mainPath: source, task: "adopt orphan ref",
  });
  await commit(task.candidatePath, "candidate.txt", "candidate\n", "candidate work");
  const checkpointInput = {
    actor: "codex", clientRequestId: key(), taskId: task.taskId,
    roomId: "demo", mainPath: source, summary: "ref is written before the row",
  };
  const checkpoint = await registry.checkpoint(checkpointInput);

  // The ref is written before the row that records it, so an interrupted or rolled-back attempt
  // leaves the ref alone on disk. `update-ref <ref> <head> ""` means "must not exist", so that
  // orphan used to make every retry of this exact reserved checkpoint fail forever with
  // CANDIDATE_GIT_COMMAND_FAILED. A ref that already names the identical head must be adopted.
  registry.close();
  deleteCheckpointRow(path, checkpoint.id);
  stripSettledReceipt(path, checkpointInput.clientRequestId);
  registry = new CandidateRegistry(data);
  const retried = await registry.checkpoint(checkpointInput);
  assert.equal(retried.id, checkpoint.id);
  assert.equal(retried.recoveryRef, checkpoint.recoveryRef);
  assert.equal(retried.candidateHead, checkpoint.candidateHead);
  assert.deepEqual(
    (await execFileAsync("git", [
      "for-each-ref", "--format=%(refname)", "refs/orchestratory/checkpoints",
    ], { cwd: source })).stdout.split("\n").filter(Boolean),
    [checkpoint.recoveryRef],
  );
  assert.equal(registry.inventory().checkpoints, 1);
});

test("a checkpoint refuses a reserved recovery ref that already names a different commit", async (t) => {
  const { source, data } = await fixture(t);
  let registry = new CandidateRegistry(data);
  t.after(() => registry.close());
  const path = registry.path;
  const task = await registry.start({
    actor: "codex", clientRequestId: key(), roomId: "demo", mainPath: source, task: "reject foreign ref",
  });
  await commit(task.candidatePath, "candidate.txt", "candidate\n", "first snapshot");
  const checkpointInput = {
    actor: "codex", clientRequestId: key(), taskId: task.taskId,
    roomId: "demo", mainPath: source, summary: "first snapshot",
  };
  const checkpoint = await registry.checkpoint(checkpointInput);
  registry.close();
  deleteCheckpointRow(path, checkpoint.id);
  stripSettledReceipt(path, checkpointInput.clientRequestId);
  registry = new CandidateRegistry(data);

  // Adoption is only ever safe for an identical head. Once the candidate has moved on, the surviving
  // ref names a snapshot this retry is not about, so it must fail closed rather than be rewritten.
  const moved = await commit(task.candidatePath, "later.txt", "later\n", "second snapshot");
  assert.notEqual(moved, checkpoint.candidateHead);
  await assert.rejects(registry.checkpoint(checkpointInput), /CANDIDATE_CHECKPOINT_REF_CONFLICT/u);
  assert.equal(
    (await execFileAsync("git", [
      "rev-parse", "--verify", `${checkpoint.recoveryRef}^{commit}`,
    ], { cwd: source })).stdout.trim(),
    checkpoint.candidateHead,
  );
  assert.equal(registry.inventory().checkpoints, 0);
});

test("a maximal completion payload still settles because the receipt is a fixed-size marker", {
  timeout: 120_000,
}, async (t) => {
  const { source, data } = await fixture(t);
  const nested = join(source, "a".repeat(200), "b".repeat(200));
  await mkdir(nested, { recursive: true });
  const bulkNames = Array.from({ length: 1_000 }, (_, index) =>
    `${String(index).padStart(4, "0")}-${"c".repeat(180)}`);
  for (let offset = 0; offset < bulkNames.length; offset += 100) {
    await Promise.all(bulkNames.slice(offset, offset + 100)
      .map(async (name) => await writeFile(join(nested, name), "")));
  }
  await execFileAsync("git", ["add", "-A"], { cwd: source });
  await execFileAsync("git", [
    "-c", "user.name=Candidate Test", "-c", "user.email=test@example.invalid",
    "commit", "-m", "bulk baseline",
  ], { cwd: source });

  const registry = new CandidateRegistry(data, { maxFiles: 1_200 });
  t.after(() => registry.close());
  const path = registry.path;
  const task = await registry.start({
    actor: "codex", clientRequestId: key(), roomId: "demo", mainPath: source, task: "maximal completion",
  });
  // Deleting the baseline files keeps the preview enormous without a per-file blob size probe.
  await execFileAsync("git", ["rm", "-r", "-q", "--", "a".repeat(200)], { cwd: task.candidatePath });
  await execFileAsync("git", [
    "-c", "user.name=Candidate Test", "-c", "user.email=test@example.invalid",
    "commit", "-m", "remove bulk baseline",
  ], { cwd: task.candidatePath });

  const completeInput = {
    actor: "codex", clientRequestId: key(), taskId: task.taskId, roomId: "demo", mainPath: source,
    summary: "maximal completion payload",
    tests: Array.from({ length: 32 }, (_, index) => ({
      command: `${String(index).padStart(2, "0")}-${"t".repeat(497)}`,
      status: "passed",
      summary: "s".repeat(1_000),
    })),
    knownRisks: Array.from({ length: 32 }, (_, index) => `${String(index).padStart(2, "0")}-${"r".repeat(997)}`),
  };
  const completed = await registry.complete(completeInput);
  assert.equal(completed.task.status, "completed");
  assert.equal(completed.completion.preview.fileCount, bulkNames.length);
  assert.equal(completed.completion.preview.filesTruncated, false);
  assert.equal(completed.completion.preview.tests.length, 32);
  assert.equal(completed.completion.preview.knownRisks.length, 32);

  // The durable answer is far larger than the receipt column can ever hold. Embedding the completion
  // in the receipt made settling throw AFTER the mutation had already committed, which left the work
  // done, every retry failing, and a fresh key answering CANDIDATE_NOT_ACTIVE — a permanent dead end.
  assert.ok(storedCompletionBytes(path, task.taskId) > 600_000);
  const settled = storedRequest(path, completeInput.clientRequestId);
  assert.equal(settled.state, "succeeded");
  assert.ok(settled.receipt !== null && Buffer.byteLength(settled.receipt, "utf8") < 1_000);

  const replayed = await registry.complete(completeInput);
  assert.equal(replayed.completion.id, completed.completion.id);
  assert.equal(replayed.checkpoint.id, completed.checkpoint.id);
  assert.deepEqual(replayed, completed);
  assert.equal(registry.inventory().checkpoints, 1);
  assert.equal(registry.inventory().completed, 1);
});

test("a settle failure leaves a committed checkpoint replayable instead of reporting a failure", async (t) => {
  const { source, data } = await fixture(t);
  let registry = new CandidateRegistry(data);
  t.after(() => registry.close());
  const path = registry.path;
  const task = await registry.start({
    actor: "codex", clientRequestId: key(), roomId: "demo", mainPath: source, task: "settle failure",
  });
  await commit(task.candidatePath, "candidate.txt", "candidate\n", "candidate work");
  const checkpointInput = {
    actor: "codex", clientRequestId: key(), taskId: task.taskId,
    roomId: "demo", mainPath: source, summary: "committed before settling",
  };
  const checkpoint = await registry.checkpoint(checkpointInput);

  // Settling runs after the mutation has already committed, so the only on-disk trace a settle
  // failure leaves is a request row still marked pending. The caller must never be told the
  // checkpoint failed, and the retry must converge on the row that already exists.
  registry.close();
  stripSettledReceipt(path, checkpointInput.clientRequestId);
  registry = new CandidateRegistry(data);
  const retried = await registry.checkpoint(checkpointInput);
  assert.deepEqual(retried, checkpoint);
  const observed = await registry.status({ roomId: "demo", mainPath: source, taskId: task.taskId });
  assert.deepEqual(observed[0]?.checkpoints.map((entry) => entry.id), [checkpoint.id]);
  assert.equal(registry.inventory().checkpoints, 1);
});

test("a settled request whose durable artifact vanished fails closed instead of re-minting it", async (t) => {
  const { source, data } = await fixture(t);
  let registry = new CandidateRegistry(data);
  t.after(() => registry.close());
  const path = registry.path;
  const task = await registry.start({
    actor: "codex", clientRequestId: key(), roomId: "demo", mainPath: source, task: "missing receipt",
  });
  await commit(task.candidatePath, "candidate.txt", "candidate\n", "candidate work");
  const checkpointInput = {
    actor: "codex", clientRequestId: key(), taskId: task.taskId,
    roomId: "demo", mainPath: source, summary: "receipt outlives its artifact",
  };
  const checkpoint = await registry.checkpoint(checkpointInput);

  // The receipt still claims success while the artifact it points at is gone, so durable state can
  // no longer rebuild the answer. Fabricating a second checkpoint under the same key is not an
  // option, so the replay refuses instead.
  registry.close();
  deleteCheckpointRow(path, checkpoint.id);
  registry = new CandidateRegistry(data);
  await assert.rejects(registry.checkpoint(checkpointInput), /CANDIDATE_REQUEST_RECEIPT_MISSING/u);
  assert.equal(registry.inventory().checkpoints, 0);
});

test("checkpoint and complete reject an invalid room id before touching the request ledger", async (t) => {
  const { source, data } = await fixture(t);
  let registry = new CandidateRegistry(data);
  t.after(() => registry.close());
  const path = registry.path;
  const task = await registry.start({
    actor: "codex", clientRequestId: key(), roomId: "demo", mainPath: source, task: "room validation",
  });
  const before = countRequests(path);

  // A room id that only passed a length check was written into candidate_requests, while the read
  // path required ROOM_PATTERN. Reopening the registry then threw CANDIDATE_REQUEST_ROW_TAMPERED
  // forever, bricking it, so the pattern has to be enforced before anything is persisted.
  await assert.rejects(
    registry.checkpoint({
      actor: "codex", clientRequestId: key(), taskId: task.taskId,
      roomId: "DEMO_UPPER", mainPath: source, summary: "must not reach the ledger",
    }),
    /CANDIDATE_ROOM_INVALID/u,
  );
  await assert.rejects(
    registry.complete({
      actor: "codex", clientRequestId: key(), taskId: task.taskId,
      roomId: "DEMO_UPPER", mainPath: source, summary: "must not reach the ledger",
    }),
    /CANDIDATE_ROOM_INVALID/u,
  );
  assert.equal(countRequests(path), before);

  registry.close();
  registry = new CandidateRegistry(data);
  assert.deepEqual(registry.integrity(), { schemaVersion: 5, quickCheck: "ok", rowsValid: true });
  assert.equal(registry.get(task.taskId)?.status, "active");
  assert.equal(registry.inventory().tasks, 1);
});

test("a candidate retry that spells mainPath with a trailing separator replays instead of conflicting", async (t) => {
  const { source, data } = await fixture(t);
  const registry = new CandidateRegistry(data);
  t.after(() => registry.close());
  const task = await registry.start({
    actor: "codex", clientRequestId: key(), roomId: "demo", mainPath: source, task: "canonical digest",
  });
  await commit(task.candidatePath, "candidate.txt", "candidate\n", "candidate work");

  // start digests the canonicalised path, so checkpoint and complete must too. Digesting the raw
  // input made a legitimate retry that merely spells the same directory differently look like a
  // payload swap and fail with CANDIDATE_REQUEST_IDEMPOTENCY_CONFLICT.
  const checkpointKey = key();
  const checkpoint = await registry.checkpoint({
    actor: "codex", clientRequestId: checkpointKey, taskId: task.taskId,
    roomId: "demo", mainPath: source, summary: "same logical request",
  });
  const replayedCheckpoint = await registry.checkpoint({
    actor: "codex", clientRequestId: checkpointKey, taskId: task.taskId,
    roomId: "demo", mainPath: `${source}${sep}`, summary: "same logical request",
  });
  assert.deepEqual(replayedCheckpoint, checkpoint);
  assert.equal(registry.inventory().checkpoints, 1);

  const completeKey = key();
  const completed = await registry.complete({
    actor: "codex", clientRequestId: completeKey, taskId: task.taskId,
    roomId: "demo", mainPath: source, summary: "same logical completion",
  });
  const replayedCompletion = await registry.complete({
    actor: "codex", clientRequestId: completeKey, taskId: task.taskId,
    roomId: "demo", mainPath: `${source}${sep}`, summary: "same logical completion",
  });
  assert.equal(replayedCompletion.completion.id, completed.completion.id);
  assert.deepEqual(replayedCompletion, completed);
  assert.equal(registry.inventory().checkpoints, 2);
  assert.equal(registry.inventory().tasks, 1);
});

test("a corrupt request row leaves checkpoints readable and other keys usable", async (t) => {
  const { source, data } = await fixture(t);
  const registry = new CandidateRegistry(data);
  const poisoned = key();
  const task = await registry.start({
    actor: "codex", clientRequestId: poisoned, roomId: "demo", mainPath: source, task: "advisory ledger",
  });
  await commit(task.candidatePath, "candidate.txt", "candidate\n", "candidate work");
  const checkpoint = await registry.checkpoint({
    actor: "codex", clientRequestId: key(), taskId: task.taskId,
    roomId: "demo", mainPath: source, summary: "recorded before the corruption",
  });
  const path = registry.path;
  registry.close();
  const db = new DatabaseSync(path);
  const changed = db.prepare("UPDATE candidate_requests SET input_digest=? WHERE client_request_id=?")
    .run("b".repeat(64), poisoned).changes;
  db.close();
  assert.equal(Number(changed), 1);

  // candidate_requests is advisory; candidates and candidate_checkpoints are authoritative. Verifying
  // the ledger in the constructor made one unreadable retry row hide every durable checkpoint behind
  // CANDIDATE_REQUEST_ROW_TAMPERED, so the corruption must stay confined to the key that carries it.
  const reopened = new CandidateRegistry(data);
  t.after(() => reopened.close());
  const [observed] = await reopened.status({ roomId: "demo", mainPath: source, taskId: task.taskId });
  assert.deepEqual(observed?.checkpoints.map((entry) => entry.id), [checkpoint.id]);
  assert.equal(observed?.checkpoints[0]?.recoveryRef, checkpoint.recoveryRef);
  assert.equal(observed?.live.recoveryReady, true);
  await assert.rejects(
    reopened.start({ actor: "codex", clientRequestId: poisoned, roomId: "demo", mainPath: source, task: "advisory ledger" }),
    /CANDIDATE_REQUEST_ROW_TAMPERED/u,
  );
  const second = await reopened.checkpoint({
    actor: "codex", clientRequestId: key(), taskId: task.taskId,
    roomId: "demo", mainPath: source, summary: "a different key still works",
  });
  assert.notEqual(second.id, checkpoint.id);
  assert.equal(reopened.inventory().checkpoints, 2);
});

test("one candidate key runs one mutation at a time and never blocks a sequential retry", async (t) => {
  const { source, data } = await fixture(t);
  const registry = new CandidateRegistry(data);
  t.after(() => registry.close());
  const path = registry.path;
  const task = await registry.start({
    actor: "codex", clientRequestId: key(), roomId: "demo", mainPath: source, task: "one key one mutation",
  });
  await commit(task.candidatePath, "candidate.txt", "candidate\n", "candidate work");

  // Two genuinely concurrent calls on one key must not both proceed. The timestamp window this
  // replaced could not express that: once it expired the second caller received the same reserved
  // identifiers, and the loser's rollback then overwrote the winner's `succeeded` verdict.
  const concurrent = {
    actor: "codex", clientRequestId: key(), taskId: task.taskId,
    roomId: "demo", mainPath: source, summary: "concurrent on one key",
  };
  const outcomes = await Promise.allSettled([registry.checkpoint(concurrent), registry.checkpoint(concurrent)]);
  const rejected = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
  const fulfilled = outcomes.filter(
    (outcome): outcome is PromiseFulfilledResult<CandidateCheckpoint> => outcome.status === "fulfilled",
  );
  assert.equal(rejected.length, 1);
  assert.match(String(rejected[0]?.reason), /CANDIDATE_REQUEST_IN_FLIGHT/u);
  assert.equal(fulfilled.length, 1);
  const winner = fulfilled[0]?.value;
  assert.ok(winner);
  assert.equal(registry.inventory().checkpoints, 1);
  assert.deepEqual(
    (await execFileAsync("git", [
      "for-each-ref", "--format=%(refname)", "refs/orchestratory/checkpoints",
    ], { cwd: source })).stdout.split("\n").filter(Boolean),
    [winner.recoveryRef],
  );
  // The refused caller must not have touched the winner's verdict on its way out.
  assert.equal(storedRequest(path, concurrent.clientRequestId).state, "succeeded");

  // Nothing sequential is ever refused by the clock. A call that aborts before creating any durable
  // artifact discards its reservation, so the immediate retry of that same key starts from a clean
  // ledger instead of being told the key is still in flight for another 30 seconds.
  const ledgerBeforeCheckpointAbort = countRequests(path);
  await writeFile(join(task.candidatePath, "checkpoint-work.txt"), "uncommitted\n", "utf8");
  const checkpointRetry = {
    actor: "codex", clientRequestId: key(), taskId: task.taskId,
    roomId: "demo", mainPath: source, summary: "retried with no delay",
  };
  await assert.rejects(registry.checkpoint(checkpointRetry), /CANDIDATE_CHECKPOINT_REQUIRES_CLEAN_WORKTREE/u);
  assert.equal(countRequests(path), ledgerBeforeCheckpointAbort);
  await commit(task.candidatePath, "checkpoint-work.txt", "uncommitted\n", "commit the pending work");
  const retried = await registry.checkpoint(checkpointRetry);
  assert.equal(retried.taskId, task.taskId);
  assert.equal(registry.inventory().checkpoints, 2);
  assert.equal(storedRequest(path, checkpointRetry.clientRequestId).state, "succeeded");

  const ledgerBeforeCompletionAbort = countRequests(path);
  await writeFile(join(task.candidatePath, "completion-work.txt"), "uncommitted\n", "utf8");
  const completeRetry = {
    actor: "codex", clientRequestId: key(), taskId: task.taskId,
    roomId: "demo", mainPath: source, summary: "completion retried with no delay",
  };
  await assert.rejects(registry.complete(completeRetry), /CANDIDATE_COMPLETION_REQUIRES_CLEAN_WORKTREE/u);
  assert.equal(countRequests(path), ledgerBeforeCompletionAbort);
  assert.equal(registry.get(task.taskId)?.status, "active");
  await commit(task.candidatePath, "completion-work.txt", "uncommitted\n", "commit the pending completion work");
  const completed = await registry.complete(completeRetry);
  assert.equal(completed.task.status, "completed");
  assert.equal(registry.inventory().checkpoints, 3);
  assert.equal(storedRequest(path, completeRetry.clientRequestId).state, "succeeded");
});

test("a candidate key that recorded a failure demands a new key and still has a forward path", async (t) => {
  const { source, data } = await fixture(t);
  let registry = new CandidateRegistry(data);
  t.after(() => registry.close());
  const path = registry.path;
  const task = await registry.start({
    actor: "codex", clientRequestId: key(), roomId: "demo", mainPath: source, task: "recorded failure",
  });
  await commit(task.candidatePath, "first.txt", "first\n", "first snapshot");
  const checkpointInput = {
    actor: "codex", clientRequestId: key(), taskId: task.taskId,
    roomId: "demo", mainPath: source, summary: "ref conflict on retry",
  };
  const checkpoint = await registry.checkpoint(checkpointInput);

  // A failure recorded at or after the durable boundary is a verdict, not an unknown outcome:
  // retrying that key would repeat the identical deterministic failure forever. The caller must be
  // told to mint a new key, and the new key must actually work, or the verdict is a dead end.
  registry.close();
  deleteCheckpointRow(path, checkpoint.id);
  stripSettledReceipt(path, checkpointInput.clientRequestId);
  registry = new CandidateRegistry(data);
  const moved = await commit(task.candidatePath, "second.txt", "second\n", "second snapshot");
  assert.notEqual(moved, checkpoint.candidateHead);
  await assert.rejects(registry.checkpoint(checkpointInput), /CANDIDATE_CHECKPOINT_REF_CONFLICT/u);
  assert.equal(storedRequest(path, checkpointInput.clientRequestId).state, "failed");
  await assert.rejects(registry.checkpoint(checkpointInput), /CANDIDATE_REQUEST_FAILED_RETRY_WITH_NEW_KEY/u);
  // Refusing the retry must not erase the verdict it just reported: only a still-pending reservation
  // is ever discarded, so the row survives its own refusal.
  assert.equal(storedRequest(path, checkpointInput.clientRequestId).state, "failed");
  assert.equal(registry.inventory().checkpoints, 0);
  const fresh = await registry.checkpoint({
    actor: "codex", clientRequestId: key(), taskId: task.taskId,
    roomId: "demo", mainPath: source, summary: "a fresh key gets through",
  });
  assert.equal(fresh.candidateHead, moved);
  assert.equal(registry.inventory().checkpoints, 1);

  // complete cannot be driven onto the ref-conflict path the way checkpoint can: once a completion
  // exists, its retry is refused by #activeScoped long before any ref is written. A ref occupying the
  // task's whole namespace fails the identical call at the identical durable boundary instead — but
  // git answers that one with the same undifferentiated CANDIDATE_GIT_COMMAND_FAILED it uses for a
  // read-only ref store or a spawn that never happened, so it is NOT a verdict this module may
  // record. The key stays retryable, and removing the obstruction lets that same key converge.
  const second = await registry.start({
    actor: "codex", clientRequestId: key(), roomId: "demo", mainPath: source, task: "recorded completion failure",
  });
  await commit(second.candidatePath, "candidate.txt", "candidate\n", "candidate work");
  const blocking = `refs/orchestratory/checkpoints/${second.taskId}`;
  await execFileAsync("git", ["update-ref", blocking, second.baseMainHead], { cwd: source });
  const completeInput = {
    actor: "codex", clientRequestId: key(), taskId: second.taskId,
    roomId: "demo", mainPath: source, summary: "blocked recovery ref namespace",
  };
  await assert.rejects(registry.complete(completeInput), /CANDIDATE_GIT_COMMAND_FAILED/u);
  assert.equal(storedRequest(path, completeInput.clientRequestId).state, "pending");
  // Refused, not silently accepted: the obstruction is still there, so the answer is the same real
  // failure rather than a fabricated success.
  await assert.rejects(registry.complete(completeInput), /CANDIDATE_GIT_COMMAND_FAILED/u);
  assert.equal(storedRequest(path, completeInput.clientRequestId).state, "pending");
  assert.equal(registry.get(second.taskId)?.status, "active");
  await execFileAsync("git", ["update-ref", "-d", blocking], { cwd: source });
  const completed = await registry.complete(completeInput);
  assert.equal(completed.task.status, "completed");
  assert.equal(storedRequest(path, completeInput.clientRequestId).state, "succeeded");
  assert.equal(registry.inventory().checkpoints, 2);
});

test("a momentarily read-only ref store does not burn a candidate checkpoint key", async (t) => {
  const { source, data } = await fixture(t);
  const registry = new CandidateRegistry(data);
  t.after(() => registry.close());
  const path = registry.path;
  const task = await registry.start({
    actor: "codex", clientRequestId: key(), roomId: "demo", mainPath: source, task: "transient ref store",
  });
  const head = await commit(task.candidatePath, "work.txt", "work\n", "candidate work");

  // A REAL transient failure, induced with chmod alone: main's loose ref store cannot be written, so
  // `git update-ref` fails while every read the call makes before it still succeeds. No database row
  // is touched to arrange this — a doctored row is a permanent corruption and would never reach the
  // branch under test, which is exactly how a previous revision shipped this defect with a passing
  // test vouching for it.
  const refs = join(source, ".git", "refs");
  await chmod(refs, 0o500);
  t.after(async () => await chmod(refs, 0o700).catch(() => undefined));
  const input = {
    actor: "codex", clientRequestId: key(), taskId: task.taskId,
    roomId: "demo", mainPath: source, summary: "written while the ref store was read-only",
  };
  await assert.rejects(registry.checkpoint(input), /CANDIDATE_GIT_COMMAND_FAILED/u);
  // Fail closed on the action: nothing was recorded, and the caller was told so.
  assert.equal(registry.inventory().checkpoints, 0);
  assert.equal(registry.get(task.taskId)?.status, "active");
  // Open on the key: `pending` is the honest record of an outcome nobody established.
  assert.deepEqual(storedRequest(path, input.clientRequestId), { state: "pending", receipt: null });
  // Still failing while the store is still read-only. The key surviving must not mean the next
  // attempt is waved through on the strength of the earlier one.
  await assert.rejects(registry.checkpoint(input), /CANDIDATE_GIT_COMMAND_FAILED/u);
  assert.equal(registry.inventory().checkpoints, 0);

  await chmod(refs, 0o700);
  const recovered = await registry.checkpoint(input);
  assert.equal(recovered.taskId, task.taskId);
  assert.equal(recovered.candidateHead, head);
  assert.equal(storedRequest(path, input.clientRequestId).state, "succeeded");
  assert.equal(registry.inventory().checkpoints, 1);
  assert.equal(countRequests(path), 2);
  // One logical request, one durable artifact: the surviving key converged rather than duplicating.
  assert.deepEqual(tableRows(path, "candidate_checkpoints").map((row) => row.id), [recovered.id]);
});

test("a momentarily read-only ref store does not burn a candidate completion key", async (t) => {
  const { source, data } = await fixture(t);
  const registry = new CandidateRegistry(data);
  t.after(() => registry.close());
  const path = registry.path;
  const task = await registry.start({
    actor: "codex", clientRequestId: key(), roomId: "demo", mainPath: source, task: "transient completion",
  });
  await commit(task.candidatePath, "work.txt", "work\n", "candidate work");

  // The most expensive key in the system to burn: by this point the candidate is finished work whose
  // only remaining step is the owner's merge decision. Under the old rule one chmod made it reachable
  // solely through a new key — and a new key knows nothing about what the burnt one already wrote.
  const refs = join(source, ".git", "refs");
  await chmod(refs, 0o500);
  t.after(async () => await chmod(refs, 0o700).catch(() => undefined));
  const input = {
    actor: "codex", clientRequestId: key(), taskId: task.taskId,
    roomId: "demo", mainPath: source, summary: "completed while the ref store was read-only",
  };
  await assert.rejects(registry.complete(input), /CANDIDATE_GIT_COMMAND_FAILED/u);
  assert.equal(registry.get(task.taskId)?.status, "active");
  assert.equal(registry.get(task.taskId)?.completion, undefined);
  assert.deepEqual(storedRequest(path, input.clientRequestId), { state: "pending", receipt: null });

  await chmod(refs, 0o700);
  const completed = await registry.complete(input);
  assert.equal(completed.task.status, "completed");
  assert.equal(completed.task.taskId, task.taskId);
  assert.equal(storedRequest(path, input.clientRequestId).state, "succeeded");
  assert.equal(registry.inventory().checkpoints, 1);
  // And the converged completion is genuinely usable: it is the snapshot an owner can be asked about.
  const preview = await registry.previewMainMerge({ taskId: task.taskId, roomId: "demo", mainPath: source });
  assert.equal(preview.completionId, completed.completion.id);
  assert.equal(preview.approvable, true);
});

test("a git that cannot be spawned at all leaves the candidate key retryable", async (t) => {
  const { source, data } = await fixture(t);
  const registry = new CandidateRegistry(data);
  t.after(() => registry.close());
  const path = registry.path;
  const task = await registry.start({
    actor: "codex", clientRequestId: key(), roomId: "demo", mainPath: source, task: "git off the path",
  });
  await commit(task.candidatePath, "work.txt", "work\n", "candidate work");

  // The other half of "the machine, not the request": git is not merely failing, it cannot be found.
  // resolveExecutable reads PATH on every call, so emptying it is a real spawn-resolution failure and
  // not a stub — and it is the failure an external volume or a broken shell profile actually produces.
  const realPath = process.env.PATH;
  process.env.PATH = "";
  t.after(() => { process.env.PATH = realPath; });
  const input = {
    actor: "codex", clientRequestId: key(), taskId: task.taskId,
    roomId: "demo", mainPath: source, summary: "attempted with no git on PATH",
  };
  await assert.rejects(registry.checkpoint(input), /EXECUTABLE_NOT_FOUND:git/u);
  assert.equal(registry.inventory().checkpoints, 0);
  // This one aborts before the durable boundary, so the reservation is dropped outright rather than
  // left `pending` — only the successful start's key remains. Either way the key is reusable; what
  // must never happen is a recorded `failed` that no repair to the machine can undo.
  assert.equal(countRequests(path), 1);

  process.env.PATH = realPath;
  const recovered = await registry.checkpoint(input);
  assert.equal(recovered.taskId, task.taskId);
  assert.equal(storedRequest(path, input.clientRequestId).state, "succeeded");
  assert.equal(registry.inventory().checkpoints, 1);
});

test("a candidate whose activation failed keeps its worktree reachable by the same key", async (t) => {
  const { root, source, data } = await fixture(t);
  const registryModule = fileURLToPath(new URL("../src/core/candidate-registry.ts", import.meta.url));
  const child = join(root, "half-created-start.mjs");
  // A separate process, because that is what ships: each MCP seat is its own process, and the retry
  // after a seat is restarted is the retry this recovery exists for. It also means the reservation
  // this attempt leaves behind has a genuinely dead owner rather than a doctored pid.
  await writeFile(child, [
    "const [data, source, clientRequestId, base] = process.argv.slice(2);",
    `const { CandidateRegistry } = await import(${JSON.stringify(registryModule)});`,
    "const at = Number(base);",
    "let reads = 0;",
    // A clock that steps backwards between the candidate row and its activation: an NTP correction or
    // a sleep/wake, the same hazard #beginRequest and #settleRequest already clamp for. The row is
    // durably `creating`, the worktree and branch are fully built, and the UPDATE that would mark it
    // `active` violates CHECK(updated_at_ms >= created_at_ms).
    "const registry = new CandidateRegistry(data, { now: () => { reads += 1; return reads >= 4 ? at - 60000 : at; } });",
    "try {",
    "  const task = await registry.start({ actor: 'codex', clientRequestId, roomId: 'demo', mainPath: source,",
    "    task: 'activation blocked by a backwards clock' });",
    "  console.log(JSON.stringify({ threw: false, status: task.status }));",
    "} catch (error) { console.log(JSON.stringify({ threw: String(error && error.message) })); }",
    "registry.close();",
    "",
  ].join("\n"), { encoding: "utf8", mode: 0o600 });

  const shared = key();
  const base = Date.UTC(2026, 7, 6, 9, 0, 0);
  const attempt = await execFileAsync(process.execPath, [child, data, source, shared, String(base)]);
  assert.deepEqual(JSON.parse(attempt.stdout.trim()), {
    threw: "CHECK constraint failed: updated_at_ms >= created_at_ms",
  });

  const path = join(data, "candidate-registry.sqlite");
  // The precondition that makes this the expensive case: a complete, usable worktree exists, and the
  // only handle entitled to it is the key that just failed.
  assert.deepEqual(tableRows(path, "candidates").map((row) => row.status), ["creating"]);
  assert.deepEqual(storedRequest(path, shared), { state: "pending", receipt: null });
  assert.equal(
    (await execFileAsync("git", ["worktree", "list", "--porcelain"], { cwd: source })).stdout
      .split("\n").filter((line) => line.startsWith("worktree ")).length,
    2,
  );

  // A new seat, past the recovery grace, retrying the SAME key. Before this fix the ledger answered
  // CANDIDATE_REQUEST_FAILED_RETRY_WITH_NEW_KEY here and that worktree and branch were orphaned for good.
  const registry = new CandidateRegistry(data, { now: () => base + 10 * 60_000 });
  t.after(() => registry.close());
  const converged = await registry.start({
    actor: "codex", clientRequestId: shared, roomId: "demo", mainPath: source,
    task: "activation blocked by a backwards clock",
  });
  assert.equal(converged.status, "active");
  assert.equal(registry.inventory().tasks, 1);
  assert.equal(countRequests(path), 1);
  assert.deepEqual(
    (await execFileAsync("git", [
      "branch", "--list", "orchestratory/candidate-*", "--format=%(refname:short)",
    ], { cwd: source })).stdout.split("\n").filter(Boolean),
    [converged.candidateBranch],
  );
  // Reachable is not enough; the recovered candidate has to be usable.
  await commit(converged.candidatePath, "after.txt", "after\n", "post-recovery work");
  const checkpoint = await registry.checkpoint({
    actor: "codex", clientRequestId: key(), taskId: converged.taskId,
    roomId: "demo", mainPath: source, summary: "usable after a failed activation",
  });
  assert.equal(checkpoint.taskId, converged.taskId);
});

test("a candidate start blocked by a read-only worktree store is not judged failed", async (t) => {
  const { source, data } = await fixture(t);
  const registry = new CandidateRegistry(data);
  t.after(() => registry.close());
  const path = registry.path;
  // A first candidate so `.git/worktrees` exists and only the next child directory is blocked.
  await registry.start({
    actor: "codex", clientRequestId: key(), roomId: "demo", mainPath: source, task: "first candidate",
  });
  const worktrees = join(source, ".git", "worktrees");
  await chmod(worktrees, 0o500);
  t.after(async () => await chmod(worktrees, 0o700).catch(() => undefined));

  const input = {
    actor: "codex", clientRequestId: key(), roomId: "demo", mainPath: source, task: "blocked worktree store",
  };
  await assert.rejects(registry.start(input), /WORKTREE_GIT_COMMAND_FAILED/u);
  // Nothing here establishes that this request failed — only that this attempt could not finish. The
  // half-created row says exactly that, and the key is still the one entitled to whatever it owns.
  assert.deepEqual(storedRequest(path, input.clientRequestId), { state: "pending", receipt: null });
  assert.deepEqual(
    (await registry.status({ roomId: "demo", mainPath: source })).map((task) => task.status).sort(),
    ["active", "creating"],
  );
  await chmod(worktrees, 0o700);
  // Retried inside the same live seat the answer is "wait for the recovery", never the terminal
  // verdict that would force a second candidate for one logical create.
  await assert.rejects(registry.start(input), /CANDIDATE_REQUEST_RECOVERING/u);
  assert.deepEqual(storedRequest(path, input.clientRequestId), { state: "pending", receipt: null });
  assert.equal(registry.inventory().tasks, 2);
});

test("a succeeded candidate request is never demoted by a later failure verdict", async (t) => {
  const { source, data } = await fixture(t);
  let registry = new CandidateRegistry(data);
  t.after(() => registry.close());
  const path = registry.path;
  const startInput = {
    actor: "codex", clientRequestId: key(), roomId: "demo", mainPath: source, task: "terminal success",
  };
  const task = await registry.start(startInput);
  assert.equal(storedRequest(path, startInput.clientRequestId).state, "succeeded");

  // `succeeded` is terminal. A retry that finds the candidate row failed tries to record `failed` on
  // a key that already succeeded; letting that land would mark a demonstrably completed mutation as
  // failed, which is exactly how a race loser could overwrite the winner's verdict.
  registry.close();
  forceCandidateStatus(path, task.taskId, "failed");
  registry = new CandidateRegistry(data);
  await assert.rejects(registry.start(startInput), /CANDIDATE_REQUEST_FAILED_RETRY_WITH_NEW_KEY/u);
  const settled = storedRequest(path, startInput.clientRequestId);
  assert.equal(settled.state, "succeeded");
  assert.notEqual(settled.receipt, null);
  assert.deepEqual(registry.integrity(), { schemaVersion: 5, quickCheck: "ok", rowsValid: true });
  assert.equal(registry.inventory().tasks, 1);
});

test("a candidate start that aborts before its first durable write leaves no ledger row", async (t) => {
  const { source, data } = await fixture(t);
  const registry = new CandidateRegistry(data);
  t.after(() => registry.close());
  const path = registry.path;
  await execFileAsync("git", ["checkout", "--detach", "HEAD"], { cwd: source });

  // Every abort before the candidates insert used to leave a permanent `pending` row that nothing
  // prunes, so a repeatable pre-mutation failure grew the ledger for free.
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await assert.rejects(
      registry.start({
        actor: "codex", clientRequestId: key(), roomId: "demo", mainPath: source, task: "detached main",
      }),
      /CANDIDATE_MAIN_BRANCH_REQUIRED/u,
    );
    assert.equal(countRequests(path), 0);
  }
  assert.equal(countRequests(path), 0);
  assert.equal(registry.inventory().tasks, 0);
});

test("checkpoint and complete reject an unknown task before reserving a ledger row", async (t) => {
  const { source, data } = await fixture(t);
  const registry = new CandidateRegistry(data);
  t.after(() => registry.close());
  const path = registry.path;

  // The scope check runs before #beginRequest, so a bogus taskId never commits a request row.
  // Reserving first made every failed call leave a permanent ledger row that nothing prunes, which
  // let an unauthenticated typo grow the durable ledger for free.
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const taskId = randomUUID();
    await assert.rejects(
      registry.checkpoint({
        actor: "codex", clientRequestId: key(), taskId,
        roomId: "demo", mainPath: source, summary: "no such task",
      }),
      /CANDIDATE_NOT_ACTIVE/u,
    );
    await assert.rejects(
      registry.complete({
        actor: "codex", clientRequestId: key(), taskId,
        roomId: "demo", mainPath: source, summary: "no such task",
      }),
      /CANDIDATE_NOT_ACTIVE/u,
    );
  }
  assert.equal(countRequests(path), 0);
  assert.equal(registry.inventory().tasks, 0);
  assert.equal(registry.inventory().checkpoints, 0);
});

test("orphan recovery refs are reported for owner review and never deleted", async (t) => {
  const { source, data } = await fixture(t);
  let registry = new CandidateRegistry(data);
  t.after(() => registry.close());
  const path = registry.path;
  const task = await registry.start({
    actor: "codex", clientRequestId: key(), roomId: "demo", mainPath: source, task: "orphan refs",
  });
  await commit(task.candidatePath, "first.txt", "first\n", "first snapshot");
  const orphaned = await registry.checkpoint({
    actor: "codex", clientRequestId: key(), taskId: task.taskId,
    roomId: "demo", mainPath: source, summary: "its row will vanish",
  });
  await commit(task.candidatePath, "second.txt", "second\n", "second snapshot");
  const healthy = await registry.checkpoint({
    actor: "codex", clientRequestId: key(), taskId: task.taskId,
    roomId: "demo", mainPath: source, summary: "keeps its row",
  });
  assert.deepEqual(await registry.orphanRecoveryRefs(source), []);

  // The ref is written before the row that records it, so a rollback, a snapshot-changed abort or an
  // abandoned key can leave a ref in the owner's canonical repository that nothing reports.
  registry.close();
  deleteCheckpointRow(path, orphaned.id);
  registry = new CandidateRegistry(data);
  assert.deepEqual(await registry.orphanRecoveryRefs(source), [{
    ref: orphaned.recoveryRef, head: orphaned.candidateHead,
  }]);
  assert.equal(
    (await execFileAsync("git", ["rev-parse", "--verify", `${healthy.recoveryRef}^{commit}`], { cwd: source })).stdout.trim(),
    healthy.candidateHead,
  );
  // Reporting must never delete: removing a ref from the owner's repository is a destructive Git
  // action that belongs to the approval-gated maintenance path, not to a read-only scan.
  assert.equal(
    (await execFileAsync("git", ["rev-parse", "--verify", `${orphaned.recoveryRef}^{commit}`], { cwd: source })).stdout.trim(),
    orphaned.candidateHead,
  );

  // A foreign ref sharing the namespace is neither reported nor acted on.
  await execFileAsync("git", [
    "update-ref", "refs/orchestratory/checkpoints/not-a-checkpoint-ref", orphaned.candidateHead,
  ], { cwd: source });
  assert.deepEqual(await registry.orphanRecoveryRefs(source), [{
    ref: orphaned.recoveryRef, head: orphaned.candidateHead,
  }]);

  const bulk = Array.from({ length: MAX_ORPHAN_RECOVERY_REFS + 5 }, () =>
    `create refs/orchestratory/checkpoints/${randomUUID()}/${randomUUID()} ${orphaned.candidateHead}\n`).join("");
  await gitWithInput(source, ["update-ref", "--stdin"], bulk);
  const capped = await registry.orphanRecoveryRefs(source);
  assert.equal(capped.length, MAX_ORPHAN_RECOVERY_REFS);
  assert.ok(capped.every((entry) => entry.head === orphaned.candidateHead));
  assert.ok(!capped.some((entry) => entry.ref === healthy.recoveryRef));
});

test("an aborting seat cannot delete the reservation another registry adopted", async (t) => {
  const { source, data } = await fixture(t);
  // Each MCP seat is its own OS process over the same data directory, so the in-memory lock covers
  // neither of these two registries against the other. The reservation therefore has to carry proof
  // of ownership: the abandoning registry must not be able to delete a row the adopter is using.
  let release!: () => void;
  const stalled = new Promise<void>((resolve) => { release = resolve; });
  const stalling = new StallingGitBroker();
  stalling.stall = stalled;
  const reserved = new Promise<void>((resolve) => { stalling.entered = resolve; });
  // BOTH registries run on the SAME frozen clock. This is the decisive condition: ownership must not
  // be derivable from time. An earlier implementation re-stamped the adopted row with a new
  // `updated_at_ms` and treated the resulting row hash as the ownership token — which silently
  // degrades to no protection at all whenever two attempts land in the same millisecond, and made
  // the duplicate-candidate failure 100% reproducible under a frozen clock. Release count 3 is the
  // candidate row's own timestamp: the abort lands after that row is committed and before the
  // receipt settles, which is the widest window a stale discard could steal.
  const frozen = 1_700_000_000_000;
  const abandoning = new CandidateRegistry(data, { gitBroker: stalling, now: () => frozen });
  t.after(() => abandoning.close());
  let clockReads = 0;
  const adopting = new CandidateRegistry(data, {
    now: () => {
      clockReads += 1;
      if (clockReads === 3) queueMicrotask(release);
      return frozen;
    },
  });
  t.after(() => adopting.close());
  const path = adopting.path;

  const shared = key();
  const input = {
    actor: "codex", clientRequestId: shared, roomId: "demo", mainPath: source, task: "adopted reservation",
  };
  const abandoned = abandoning.start(input);
  await reserved;
  const [abandonedOutcome, adoptedOutcome] = await Promise.allSettled([abandoned, adopting.start(input)]);
  assert.ok(abandonedOutcome.status === "rejected");
  assert.match(String(abandonedOutcome.reason), /SYNTHETIC_MAIN_INSPECTION_FAILED/u);
  assert.ok(adoptedOutcome.status === "fulfilled");
  const adopted = adoptedOutcome.value;
  assert.equal(adopted.status, "active");
  assert.equal(countRequests(path), 1);
  assert.equal(storedRequest(path, shared).state, "succeeded");

  // The decisive question: a later retry of that same key must converge on the one candidate that
  // exists. With the reservation deleted from under the adopter this retry found no ledger row and
  // minted a second task, candidate, branch and worktree from a single clientRequestId.
  const retrying = new CandidateRegistry(data, { now: () => frozen });
  t.after(() => retrying.close());
  const retried = await retrying.start(input);
  assert.equal(retried.taskId, adopted.taskId);
  assert.equal(retried.candidateId, adopted.candidateId);
  assert.equal(retried.candidatePath, adopted.candidatePath);
  assert.equal(retrying.inventory().tasks, 1);
  assert.equal(retrying.inventory().active, 1);
  assert.equal(countRequests(path), 1);
  assert.deepEqual(
    (await execFileAsync("git", [
      "branch", "--list", "orchestratory/candidate-*", "--format=%(refname:short)",
    ], { cwd: source })).stdout.split("\n").filter(Boolean),
    [adopted.candidateBranch],
  );
  assert.equal(
    (await execFileAsync("git", ["worktree", "list", "--porcelain"], { cwd: source })).stdout
      .split("\n").filter((line) => line.startsWith("worktree ")).length,
    2,
  );
});

test("a closed candidate registry names itself instead of leaking a storage failure", async (t) => {
  const { source, data } = await fixture(t);
  const registry = new CandidateRegistry(data);
  t.after(() => registry.close());
  const task = await registry.start({
    actor: "codex", clientRequestId: key(), roomId: "demo", mainPath: source, task: "closed registry",
  });
  registry.close();

  // Every mutation goes through the same abort path, and that path touches the database on its way
  // out. A raw storage string such as "database is not open" reaching the caller would replace the
  // caller's own verdict with an implementation detail nothing downstream can act on.
  for (const call of [
    async () => await registry.start({
      actor: "codex", clientRequestId: key(), roomId: "demo", mainPath: source, task: "after close",
    }),
    async () => await registry.checkpoint({
      actor: "codex", clientRequestId: key(), taskId: task.taskId,
      roomId: "demo", mainPath: source, summary: "after close",
    }),
    async () => await registry.complete({
      actor: "codex", clientRequestId: key(), taskId: task.taskId,
      roomId: "demo", mainPath: source, summary: "after close",
    }),
  ]) {
    const reason = await call().then(() => "UNEXPECTED_SUCCESS", (error: unknown) => String(error));
    assert.match(reason, /CANDIDATE_REGISTRY_CLOSED/u);
    assert.doesNotMatch(reason, /database is not open/u);
  }
});

test("a registry closed mid-flight still reports the caller's own failure", async (t) => {
  const { source, data } = await fixture(t);
  const gitBroker = new HookedGitBroker();
  const registry = new CandidateRegistry(data, { gitBroker });
  t.after(() => registry.close());
  await execFileAsync("git", ["checkout", "--detach", "HEAD"], { cwd: source });

  // The key is reserved, the database then goes away mid-call, and the attempt fails before creating
  // any durable artifact — so the abort path tries to discard its own reservation against a closed
  // database. That cleanup is best effort and must never overwrite the failure being reported.
  gitBroker.afterInspect = async () => { registry.close(); };
  const reason = await registry.start({
    actor: "codex", clientRequestId: key(), roomId: "demo", mainPath: source, task: "closed mid-flight",
  }).then(() => "UNEXPECTED_SUCCESS", (error: unknown) => String(error));
  assert.match(reason, /CANDIDATE_MAIN_BRANCH_REQUIRED/u);
  assert.doesNotMatch(reason, /database is not open/u);
});

test("a late start replay refuses a task that has left active instead of handing back its completion", async (t) => {
  const { source, data } = await fixture(t);
  const registry = new CandidateRegistry(data);
  t.after(() => registry.close());
  const path = registry.path;
  const startInput = {
    actor: "codex", clientRequestId: key(), roomId: "demo", mainPath: source, task: "late start replay",
  };
  const started = await registry.start(startInput);
  await commit(started.candidatePath, "candidate.txt", "candidate\n", "candidate work");
  const completed = await registry.complete({
    actor: "codex", clientRequestId: key(), taskId: started.taskId,
    roomId: "demo", mainPath: source, summary: "awaiting the owner's merge decision",
  });
  assert.equal(completed.task.status, "completed");
  assert.ok(registry.get(started.taskId)?.completion);

  // A start replay that arrives after its task has moved on must fail closed. Returning the current
  // row presented a completed — later possibly merged — candidate as a fresh start, complete with
  // the whole completion payload and an instruction to keep working in a worktree that may be gone.
  let handedBack: CandidateTask | undefined;
  await assert.rejects(
    registry.start(startInput).then((task) => { handedBack = task; return task; }),
    /CANDIDATE_REQUEST_TASK_NO_LONGER_ACTIVE/u,
  );
  assert.equal(handedBack?.completion, undefined);
  assert.equal(handedBack, undefined);
  // The refusal is not a verdict on the request itself: the start really did succeed, so the ledger
  // row stays terminal and the durable candidate is untouched.
  assert.equal(storedRequest(path, startInput.clientRequestId).state, "succeeded");
  assert.equal(registry.get(started.taskId)?.status, "completed");

  for (const status of ["retained", "rejected", "merged"]) {
    registry.close();
    forceCandidateStatus(path, started.taskId, status);
    const reopened = new CandidateRegistry(data);
    await assert.rejects(
      reopened.start(startInput).then((task) => { handedBack = task; return task; }),
      /CANDIDATE_REQUEST_TASK_NO_LONGER_ACTIVE/u,
    );
    assert.equal(handedBack, undefined);
    assert.equal(reopened.inventory().tasks, 1);
    assert.equal(storedRequest(path, startInput.clientRequestId).state, "succeeded");
    reopened.close();
  }
});

test("a stale seat cannot record a verdict on the reservation another seat adopted", async (t) => {
  const { source, data } = await fixture(t);
  // Ownership was wired into only one of the ledger's two state-changing verbs: #discardRequest took
  // the owner token, #settleRequest did not. A stale seat could therefore stamp `failed` on a
  // reservation a live seat was still using, and the documented recovery for that verdict ("mint a
  // new key") then produced TWO checkpoints and TWO recovery refs from one logical request.
  //
  // Both registries run on the SAME frozen clock, for the same reason as the discard test above:
  // ownership must not be derivable from time, and a shared millisecond is where a time-derived
  // token silently degrades to no protection at all.
  const frozen = 1_700_000_000_000;
  const handOver = new HookedGitBroker();
  const staleSeat = new CandidateRegistry(data, { gitBroker: handOver, now: () => frozen });
  t.after(() => staleSeat.close());
  const liveSeat = new CandidateRegistry(data, { now: () => frozen });
  t.after(() => liveSeat.close());
  const path = liveSeat.path;

  const task = await liveSeat.start({
    actor: "codex", clientRequestId: key(), roomId: "demo", mainPath: source, task: "stale verdict",
  });
  const firstHead = await commit(task.candidatePath, "first.txt", "first\n", "first snapshot");
  const shared = {
    actor: "codex", clientRequestId: key(), taskId: task.taskId,
    roomId: "demo", mainPath: source, summary: "one logical checkpoint",
  };

  // The stale seat reserves the key and then loses its turn. The live seat adopts that reservation,
  // moves the candidate on, writes the recovery ref and commits the checkpoint row; stripping the
  // receipt models it dying after that commit and before its settle landed. The row is therefore
  // still `pending`, so the owner token is the only thing left protecting it.
  let adopted: CandidateCheckpoint | undefined;
  let movedHead: string | undefined;
  let handedOver = false;
  handOver.afterInspect = async () => {
    if (handedOver) return;
    handedOver = true;
    movedHead = await commit(task.candidatePath, "second.txt", "second\n", "second snapshot");
    assert.notEqual(movedHead, firstHead);
    adopted = await liveSeat.checkpoint(shared);
    stripSettledReceipt(path, shared.clientRequestId);
  };
  const reason = await staleSeat.checkpoint(shared)
    .then(() => "UNEXPECTED_SUCCESS", (error: unknown) => String(error));
  assert.match(reason, /CANDIDATE_CHECKPOINT_REF_CONFLICT/u);
  // The refused settle is best effort on the way out and must never replace the caller's own failure.
  assert.doesNotMatch(reason, /CANDIDATE_REQUEST_NOT_OWNED/u);
  assert.ok(adopted);
  assert.equal(adopted.candidateHead, movedHead);

  // The decisive assertion: the live seat's reservation still says `pending`, not `failed`.
  assert.equal(storedRequest(path, shared.clientRequestId).state, "pending");
  assert.equal(countRequests(path), 2);
  // So the key is still the live seat's own, and retrying it converges on the checkpoint that exists
  // instead of being told to mint a new key that would duplicate it.
  const retried = await liveSeat.checkpoint(shared);
  assert.deepEqual(retried, adopted);
  assert.equal(storedRequest(path, shared.clientRequestId).state, "succeeded");
  assert.equal(liveSeat.inventory().checkpoints, 1);
  assert.deepEqual(
    (await execFileAsync("git", [
      "for-each-ref", "--format=%(refname)", "refs/orchestratory/checkpoints",
    ], { cwd: source })).stdout.split("\n").filter(Boolean),
    [adopted.recoveryRef],
  );
  assert.deepEqual(liveSeat.integrity(), { schemaVersion: 5, quickCheck: "ok", rowsValid: true });
});

test("a settle whose token the reservation no longer holds is refused without leaking its code", async (t) => {
  const { source, data } = await fixture(t);
  const gitBroker = new HookedGitBroker();
  const registry = new CandidateRegistry(data, { gitBroker });
  t.after(() => registry.close());
  const path = registry.path;
  const task = await registry.start({
    actor: "codex", clientRequestId: key(), roomId: "demo", mainPath: source, task: "unowned settle",
  });
  await commit(task.candidatePath, "candidate.txt", "candidate\n", "candidate work");

  // Occupying the whole recovery-ref namespace makes the completion fail at its durable boundary,
  // which is the point where complete records a `failed` verdict for the key.
  const blocking = `refs/orchestratory/checkpoints/${task.taskId}`;
  await execFileAsync("git", ["update-ref", blocking, task.baseMainHead], { cwd: source });
  const completeInput = {
    actor: "codex", clientRequestId: key(), taskId: task.taskId,
    roomId: "demo", mainPath: source, summary: "settles with a stale token",
  };
  let rotated = false;
  gitBroker.afterInspect = async () => {
    if (rotated) return;
    rotated = true;
    rotateRequestOwner(path, completeInput.clientRequestId);
  };

  // CANDIDATE_REQUEST_NOT_OWNED is reachable but never caller-visible: every #settleRequest call site
  // wraps it so the caller keeps its own verdict, and #settleSucceeded swallows it too. What the test
  // can observe is its effect — the write is refused, so the row keeps the state its real owner left.
  const reason = await registry.complete(completeInput)
    .then(() => "UNEXPECTED_SUCCESS", (error: unknown) => String(error));
  assert.match(reason, /CANDIDATE_GIT_COMMAND_FAILED/u);
  assert.doesNotMatch(reason, /CANDIDATE_REQUEST_NOT_OWNED/u);
  assert.doesNotMatch(reason, /CANDIDATE_REQUEST_CONCURRENT_UPDATE/u);
  assert.equal(storedRequest(path, completeInput.clientRequestId).state, "pending");
  assert.equal(storedRequest(path, completeInput.clientRequestId).receipt, null);
  assert.equal(registry.get(task.taskId)?.status, "active");
  assert.equal(registry.inventory().checkpoints, 0);

  // A verdict nobody was entitled to record must not dead-end the key either: with the namespace
  // freed, the same key still completes exactly once.
  await execFileAsync("git", ["update-ref", "-d", blocking], { cwd: source });
  const completed = await registry.complete(completeInput);
  assert.equal(completed.task.status, "completed");
  assert.equal(storedRequest(path, completeInput.clientRequestId).state, "succeeded");
  assert.equal(registry.inventory().checkpoints, 1);
  assert.equal(countRequests(path), 2);
  assert.deepEqual(registry.integrity(), { schemaVersion: 5, quickCheck: "ok", rowsValid: true });
});

test("a v2 candidate database is refused instead of silently rebuilding its ledger", async (t) => {
  const { source, data } = await fixture(t);
  const registry = new CandidateRegistry(data);
  const path = registry.path;
  const task = await registry.start({
    actor: "codex", clientRequestId: key(), roomId: "demo", mainPath: source, task: "v2 refusal",
  });
  await commit(task.candidatePath, "candidate.txt", "candidate\n", "candidate work");
  await registry.checkpoint({
    actor: "codex", clientRequestId: key(), taskId: task.taskId,
    roomId: "demo", mainPath: source, summary: "recorded before the downgrade",
  });
  const candidatesBefore = tableRows(path, "candidates");
  const checkpointsBefore = tableRows(path, "candidate_checkpoints");
  registry.close();

  // Rebuild the ledger in its v2 shape (no owner_token) and hand the database back as v2.
  const stranded = randomUUID();
  let db = new DatabaseSync(path);
  db.exec(`DROP TABLE candidate_requests; ${V2_REQUESTS_TABLE_SQL} PRAGMA user_version=2;`);
  db.prepare("INSERT INTO candidate_requests VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(
    stranded, "codex", "start", "demo", "a".repeat(64), JSON.stringify({ taskId: randomUUID() }),
    "succeeded", "{\"settled\":true}", 1_700_000_000_000, 1_700_000_000_000, "b".repeat(64),
  );
  db.close();

  // Rebuilding the ledger would be fail-OPEN: a key already recorded `succeeded` would lose its
  // answer, and the replay that follows creates a second durable candidate rather than merely
  // losing a replay. v2 was never committed or released, so refusing it costs nothing and is the
  // only option that fails closed.
  assert.throws(() => new CandidateRegistry(data), /CANDIDATE_REGISTRY_SCHEMA_UNSUPPORTED/u);

  // Refusal must not have touched anything: authoritative rows, the ledger and the version stamp
  // are all exactly as the v2 database left them, so an operator can still downgrade or repair.
  db = new DatabaseSync(path);
  assert.deepEqual(tableRows(path, "candidates"), candidatesBefore);
  assert.deepEqual(tableRows(path, "candidate_checkpoints"), checkpointsBefore);
  assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 2);
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS total FROM candidate_requests WHERE client_request_id=?")
      .get(stranded) as { total: number }).total,
    1,
  );
  db.close();
  t.after(() => { /* no registry to close: the constructor refused to open one */ });
});
test("a candidate settle survives a clock that steps backwards after the mutation committed", async (t) => {
  const { source, data } = await fixture(t);
  const owner = new CandidateRegistry(data);
  t.after(() => owner.close());
  const path = owner.path;
  const task = await owner.start({
    actor: "codex", clientRequestId: key(), roomId: "demo", mainPath: source, task: "backwards clock",
  });
  await commit(task.candidatePath, "candidate.txt", "candidate\n", "candidate work");

  // checkpoint reads the clock exactly three times: reserving the key, stamping the checkpoint row,
  // and settling the receipt. Only the third read steps backwards, so the mutation itself is entirely
  // normal and the settle is the step that has to survive an NTP correction or a sleep/wake. Only the
  // adopt path was clamped, so every settle under a backwards clock violated
  // CHECK(updated_at_ms >= created_at_ms), was swallowed as best effort, and left the row `pending`
  // forever — the mutation reported success while its receipt never landed.
  const base = Date.now() + 60_000;
  const backwards = base - 3_600_000;
  let reads = 0;
  const seat = new CandidateRegistry(data, {
    now: () => { reads += 1; return reads < 3 ? base : backwards; },
  });
  t.after(() => seat.close());
  const checkpointInput = {
    actor: "codex", clientRequestId: key(), taskId: task.taskId,
    roomId: "demo", mainPath: source, summary: "settled under a backwards clock",
  };
  const checkpoint = await seat.checkpoint(checkpointInput);
  assert.equal(reads, 3);
  assert.equal(checkpoint.taskId, task.taskId);
  assert.equal(checkpoint.createdAt, new Date(base).toISOString());

  assert.equal(storedRequest(path, checkpointInput.clientRequestId).state, "succeeded");
  assert.notEqual(storedRequest(path, checkpointInput.clientRequestId).receipt, null);
  assert.deepEqual(requestClock(path, checkpointInput.clientRequestId), { created: base, updated: base });
  assert.equal(seat.inventory().requestsPending, 0);
  assert.equal(seat.inventory().checkpoints, 1);
  assert.deepEqual(seat.integrity(), { schemaVersion: 5, quickCheck: "ok", rowsValid: true });
});

test("a live candidate creator is never reaped by a concurrent seat, at any grace", async (t) => {
  const { source, data } = await fixture(t);
  // Two registries over one data directory model two MCP seat processes. The in-memory #executing
  // lock covers neither against the other, so the only thing standing between a concurrent
  // candidate_status/candidate_start and the live creator is the request ledger.
  let opened!: () => void;
  const creatingCommitted = new Promise<void>((resolve) => { opened = resolve; });
  let clockReads = 0;
  const creator = new CandidateRegistry(data, {
    now: () => {
      clockReads += 1;
      // Read three is the candidate row's own timestamp. Everything from there to the COMMIT of the
      // `creating` row is synchronous, so this microtask runs with the row durably `creating` and
      // the creator suspended inside createCandidate — the exact window that a large-repository
      // checkout, or a machine that sleeps mid-create, stretches past CREATING_RECOVERY_GRACE_MS.
      if (clockReads === 3) queueMicrotask(opened);
      return Date.now();
    },
  });
  t.after(() => creator.close());
  const reaper = new CandidateRegistry(data);
  t.after(() => reaper.close());
  const path = creator.path;

  const input = {
    actor: "codex", clientRequestId: key(), roomId: "demo", mainPath: source, task: "live creator",
  };
  const started = creator.start(input);
  await creatingCommitted;
  assert.deepEqual(tableRows(path, "candidates").map((row) => row.status), ["creating"]);
  // Grace zero: by the wall clock alone this row is unambiguously stale, and reconcileCreating
  // mutates the AUTHORITATIVE table. Reaping it flipped the row hash, CAS-failed the creator's own
  // transition to `active`, settled the key `failed`, and the documented "mint a new key" recovery
  // then produced a SECOND candidate while the first worktree and branch were orphaned forever.
  assert.deepEqual(await reaper.reconcileCreating(0), { activated: 0, failed: 0 });

  const task = await started;
  assert.equal(task.status, "active");
  assert.equal(storedRequest(path, input.clientRequestId).state, "succeeded");
  assert.deepEqual(tableRows(path, "candidates").map((row) => row.status), ["active"]);
  assert.equal(countRequests(path), 1);
  assert.deepEqual(
    (await execFileAsync("git", [
      "branch", "--list", "orchestratory/candidate-*", "--format=%(refname:short)",
    ], { cwd: source })).stdout.split("\n").filter(Boolean),
    [task.candidateBranch],
  );
  assert.equal(
    (await execFileAsync("git", ["worktree", "list", "--porcelain"], { cwd: source })).stdout
      .split("\n").filter((line) => line.startsWith("worktree ")).length,
    2,
  );

  // One logical request, one durable artifact: the retry the caller sends after any interruption
  // converges on the candidate that exists instead of minting a second one.
  const retried = await reaper.start(input);
  assert.equal(retried.taskId, task.taskId);
  assert.equal(retried.candidateId, task.candidateId);
  assert.equal(retried.candidatePath, task.candidatePath);
  assert.equal(reaper.inventory().tasks, 1);
  assert.equal(countRequests(path), 1);
});

test("an abandoned candidate create is skipped while its key is live and recovers afterwards", async (t) => {
  const { source, data } = await fixture(t);
  let registry = new CandidateRegistry(data);
  const path = registry.path;
  const input = {
    actor: "codex", clientRequestId: key(), roomId: "demo", mainPath: source, task: "abandoned create",
  };
  const task = await registry.start(input);
  registry.close();
  // A creator that has not come back: the candidate row is `creating` and its key is still `pending`.
  forceCandidateStatus(path, task.taskId, "creating");
  stripSettledReceipt(path, input.clientRequestId);

  // Ten minutes on, well past CREATING_RECOVERY_GRACE_MS, so the row is stale by every age test
  // there is. Age is exactly what must not decide this: the reservation is old precisely because the
  // create was slow, so an age-qualified guard would fail in the one case it exists for.
  const later = Date.now() + 10 * 60_000;
  registry = new CandidateRegistry(data, { now: () => later });
  t.after(() => registry.close());
  assert.deepEqual(await registry.reconcileCreating(0), { activated: 0, failed: 0 });
  assert.equal(registry.get(task.taskId)?.status, "creating");

  // The retry of the SAME key is told to wait for the recovery rather than that its key burned, and
  // it mints nothing: one task, one ledger row, one branch, one worktree. reconcileCreating runs at
  // the head of start() too, so this also covers the skip on the internal five-minute grace.
  await assert.rejects(registry.start(input), /CANDIDATE_REQUEST_RECOVERING/u);
  assert.equal(registry.get(task.taskId)?.status, "creating");
  assert.equal(registry.inventory().tasks, 1);
  assert.equal(countRequests(path), 1);
  assert.deepEqual(
    (await execFileAsync("git", [
      "branch", "--list", "orchestratory/candidate-*", "--format=%(refname:short)",
    ], { cwd: source })).stdout.split("\n").filter(Boolean),
    [task.candidateBranch],
  );

  // Skipped is not stranded. Once the owner's settle lands the row is no longer guarded, reconciles
  // on the worktree evidence, and the same key still answers with that one task.
  restoreSettledReceipt(path, input.clientRequestId);
  assert.deepEqual(await registry.reconcileCreating(0), { activated: 1, failed: 0 });
  assert.equal(registry.get(task.taskId)?.status, "active");
  const replayed = await registry.start(input);
  assert.equal(replayed.taskId, task.taskId);
  assert.equal(replayed.candidateId, task.candidateId);
  assert.equal(registry.inventory().tasks, 1);
  assert.equal(countRequests(path), 1);
});

test("a creating candidate no live reservation holds is still reconciled from worktree evidence", async (t) => {
  const { source, data } = await fixture(t);
  const registry = new CandidateRegistry(data);
  t.after(() => registry.close());
  const path = registry.path;

  // A settled key holds nothing, so the guard must not turn every interrupted create into a
  // permanent `creating` row: reactivation on matching worktree evidence stays exactly as it was.
  const settled = {
    actor: "codex", clientRequestId: key(), roomId: "demo", mainPath: source, task: "settled reservation",
  };
  const reactivated = await registry.start(settled);
  assert.equal(storedRequest(path, settled.clientRequestId).state, "succeeded");
  forceCandidateStatus(path, reactivated.taskId, "creating");
  assert.deepEqual(await registry.reconcileCreating(0), { activated: 1, failed: 0 });
  assert.equal(registry.get(reactivated.taskId)?.status, "active");

  // A `pending` reservation whose reserved identifiers cannot be parsed guards nothing. The ledger
  // is advisory; one unreadable row must never hold the authoritative table hostage.
  const corrupted = {
    actor: "codex", clientRequestId: key(), roomId: "demo", mainPath: source, task: "corrupt reservation",
  };
  const unguarded = await registry.start(corrupted);
  forceCandidateStatus(path, unguarded.taskId, "creating");
  stripSettledReceipt(path, corrupted.clientRequestId);
  corruptReservedIdentifiers(path, corrupted.clientRequestId);
  assert.deepEqual(await registry.reconcileCreating(0), { activated: 1, failed: 0 });
  assert.equal(registry.get(unguarded.taskId)?.status, "active");

  // Reservation removed outright and the worktree gone: the row is still marked `failed`, and the
  // branch is retained rather than deleted.
  forceCandidateStatus(path, reactivated.taskId, "creating");
  const db = new DatabaseSync(path);
  const removed = db.prepare("DELETE FROM candidate_requests WHERE client_request_id=?")
    .run(settled.clientRequestId).changes;
  db.close();
  assert.equal(Number(removed), 1);
  await rm(reactivated.candidatePath, { recursive: true, force: true });
  assert.deepEqual(await registry.reconcileCreating(0), { activated: 0, failed: 1 });
  assert.equal(registry.get(reactivated.taskId)?.status, "failed");
  assert.deepEqual(
    (await execFileAsync("git", [
      "branch", "--list", "orchestratory/candidate-*", "--format=%(refname:short)",
    ], { cwd: source })).stdout.split("\n").filter(Boolean).sort(),
    [reactivated.candidateBranch, unguarded.candidateBranch].sort(),
  );
});

test("a candidate creator killed mid-create is resolved without destroying its reservation", async (t) => {
  const { source, data } = await fixture(t);
  const registry = new CandidateRegistry(data);
  const path = registry.path;
  const shared = key();
  const task = await registry.start({
    actor: "codex", clientRequestId: shared, roomId: "demo", mainPath: source, task: "killed mid-create",
  });
  registry.close();
  // Exactly what a SIGKILL between the `creating` insert and the transition to `active` leaves behind.
  forceCandidateStatus(path, task.taskId, "creating");
  strandReservation(path, shared, await deadPid());

  const reopened = new CandidateRegistry(data);
  t.after(() => reopened.close());
  // The dead owner is simply not guarded, so the row resolves from the evidence already on disk.
  assert.deepEqual(await reopened.reconcileCreating(0), { activated: 1, failed: 0 });
  assert.equal(reopened.get(task.taskId)?.status, "active");
  // Nothing was written to the ledger. Settling it would put the artifacts this reservation owns out
  // of reach of the only key entitled to them, which is how the previous attempt at recovery
  // reintroduced the duplicate candidate it was meant to prevent.
  assert.equal(storedRequest(path, shared).state, "pending");
  assert.equal(countRequests(path), 1);
});

test("a resolved crash leaves the original key able to converge, so no duplicate is ever minted", async (t) => {
  const { source, data } = await fixture(t);
  const registry = new CandidateRegistry(data);
  const path = registry.path;
  const shared = key();
  const input = {
    actor: "codex", clientRequestId: shared, roomId: "demo", mainPath: source, task: "converge after crash",
  };
  const task = await registry.start(input);
  registry.close();
  forceCandidateStatus(path, task.taskId, "creating");
  strandReservation(path, shared, await deadPid());

  // Ten minutes later, i.e. past the recovery grace. start() reconciles BEFORE it reserves, so the
  // dead owner's row is resolved first and the original key then converges on it — the wait is
  // bounded, unlike the permanent stall a previous revision produced.
  const reopened = new CandidateRegistry(data, { now: () => Date.now() + 10 * 60_000 });
  t.after(() => reopened.close());
  const recovered = await reopened.start(input);
  assert.equal(recovered.taskId, task.taskId);
  assert.equal(recovered.candidateId, task.candidateId);
  assert.equal(recovered.status, "active");
  // One logical request, one durable artifact — the invariant the whole ledger exists for.
  assert.equal(reopened.inventory().tasks, 1);
  assert.deepEqual(
    (await execFileAsync("git", [
      "branch", "--list", "orchestratory/candidate-*", "--format=%(refname:short)",
    ], { cwd: source })).stdout.split("\n").filter(Boolean),
    [task.candidateBranch],
  );
  // The recovered task is genuinely usable, not merely present.
  await commit(task.candidatePath, "after-recovery.txt", "work\n", "post-recovery work");
  const checkpoint = await reopened.checkpoint({
    actor: "codex", clientRequestId: key(), taskId: task.taskId,
    roomId: "demo", mainPath: source, summary: "usable after recovery",
  });
  assert.equal(checkpoint.taskId, task.taskId);
});
test("a live candidate creator's reservation is never taken over, at any grace", async (t) => {
  const { source, data } = await fixture(t);
  // The round-7 guard must survive the round-8 fix: liveness is now evidence-based, so the live case
  // has to be re-proved rather than assumed to still hold.
  let opened!: () => void;
  const creatingCommitted = new Promise<void>((resolve) => { opened = resolve; });
  let clockReads = 0;
  const creator = new CandidateRegistry(data, {
    now: () => {
      clockReads += 1;
      // Read three is the candidate row's own timestamp; everything to the COMMIT of the `creating`
      // row is synchronous, so this microtask runs with the row durably `creating` and the creator
      // suspended inside createCandidate.
      if (clockReads === 3) queueMicrotask(opened);
      return Date.now();
    },
  });
  t.after(() => creator.close());
  const reaper = new CandidateRegistry(data);
  t.after(() => reaper.close());
  const path = creator.path;

  const input = {
    actor: "codex", clientRequestId: key(), roomId: "demo", mainPath: source, task: "live owner",
  };
  const started = creator.start(input);
  await creatingCommitted;
  assert.deepEqual(tableRows(path, "candidates").map((row) => row.status), ["creating"]);
  assert.equal(requestOwnerPid(path, input.clientRequestId), process.pid);

  // Grace zero, and the owner is running: no reap, and no takeover either. A takeover here would
  // settle the live creator's reservation `failed` behind its back, which is the round-7 defect
  // wearing new evidence — its own settle would then fail and its key would be burned.
  assert.deepEqual(await reaper.reconcileCreating(0), { activated: 0, failed: 0 });
  assert.deepEqual(storedRequest(path, input.clientRequestId), { state: "pending", receipt: null });
  assert.deepEqual(tableRows(path, "candidates").map((row) => row.status), ["creating"]);

  const task = await started;
  assert.equal(task.status, "active");
  assert.equal(storedRequest(path, input.clientRequestId).state, "succeeded");
  assert.equal(reaper.inventory().tasks, 1);
  assert.equal(countRequests(path), 1);
  const retried = await reaper.start(input);
  assert.equal(retried.taskId, task.taskId);
  assert.equal(retried.candidateId, task.candidateId);
  assert.equal(reaper.inventory().tasks, 1);
  assert.equal(countRequests(path), 1);
});

test("a reservation whose owner this process cannot rule out is guarded however stale it looks", async (t) => {
  const { source, data } = await fixture(t);
  let registry = new CandidateRegistry(data);
  const path = registry.path;
  const mine = {
    actor: "codex", clientRequestId: key(), roomId: "demo", mainPath: source, task: "owned by this process",
  };
  const task = await registry.start(mine);
  registry.close();
  // Owned by the process doing the reconciling. No signal is needed to answer this one: the owner is
  // by definition running, so a stale-looking row of our own must never be taken over.
  forceCandidateStatus(path, task.taskId, "creating");
  strandReservation(path, mine.clientRequestId, process.pid);

  const later = Date.now() + 10 * 60_000;
  registry = new CandidateRegistry(data, { now: () => later });
  t.after(() => registry.close());
  assert.deepEqual(await registry.reconcileCreating(0), { activated: 0, failed: 0 });
  assert.equal(registry.get(task.taskId)?.status, "creating");
  assert.deepEqual(storedRequest(path, mine.clientRequestId), { state: "pending", receipt: null });
  await assert.rejects(registry.start(mine), /CANDIDATE_REQUEST_RECOVERING/u);

  // A pid this user may not signal is alive too: the kernel refusing to answer is not evidence of
  // death, and treating EPERM as death would take over another user's live reservation. pid 1 is the
  // one pid guaranteed to exist; whether it answers EPERM or succeeds, the verdict is "alive".
  const foreign = {
    actor: "codex", clientRequestId: key(), roomId: "demo", mainPath: source, task: "owned by another user",
  };
  const second = await registry.start(foreign);
  forceCandidateStatus(path, second.taskId, "creating");
  strandReservation(path, foreign.clientRequestId, 1);
  assert.deepEqual(await registry.reconcileCreating(0), { activated: 0, failed: 0 });
  assert.equal(registry.get(second.taskId)?.status, "creating");
  assert.deepEqual(storedRequest(path, foreign.clientRequestId), { state: "pending", receipt: null });
  assert.equal(registry.inventory().requestsPending, 2);
});

test("a candidate retry inside the recovery grace never claims liveness it is not using", async (t) => {
  const { source, data } = await fixture(t);
  // ONE registry for the whole test, because that is what ships: each MCP seat holds a single
  // long-lived CandidateRegistry for the life of its stdio session. A retry that stamps its own pid
  // onto the reservation and then bails out therefore guards the half-created row for as long as the
  // seat runs, not for a moment. The injectable offset moves past the recovery grace without sleeping.
  let offset = 0;
  const registry = new CandidateRegistry(data, { now: () => Date.now() + offset });
  t.after(() => registry.close());
  const path = registry.path;
  const input = {
    actor: "codex", clientRequestId: key(), roomId: "demo", mainPath: source, task: "guarded by its own retry",
  };
  const task = await registry.start(input);
  // Exactly what a SIGKILL between the `creating` insert and the transition to `active` leaves behind.
  forceCandidateStatus(path, task.taskId, "creating");
  const owner = await deadPid();
  assert.notEqual(owner, process.pid);
  strandReservation(path, input.clientRequestId, owner);

  // Inside the grace. start() reconciles BEFORE it reserves, so the row is correctly left alone and
  // the retry has nothing to converge on yet — it is told to wait, which on its own is right.
  await assert.rejects(registry.start(input), /CANDIDATE_REQUEST_RECOVERING/u);
  // The assertion the fix exists for. Reserving ADOPTED the reservation and stamped this process onto
  // it on the way in; a retry that then bails out without handing the pid back advertises itself as
  // the live owner of work it is not doing. #ownerAlive would see a running owner from that moment on
  // and reconcileCreating would skip the row for the life of the seat: the same key answering
  // RECOVERING at t+0, t+10m and t+24h, with a new key the only way forward — a second candidate,
  // branch and worktree for one logical create.
  assert.equal(requestOwnerPid(path, input.clientRequestId), owner);
  assert.deepEqual(storedRequest(path, input.clientRequestId), { state: "pending", receipt: null });

  // Handing the pid back is what keeps the row recoverable: nobody alive holds it, so the dead
  // owner's half-created candidate resolves from the worktree evidence already on disk.
  assert.deepEqual(await registry.reconcileCreating(0), { activated: 1, failed: 0 });
  assert.equal(registry.get(task.taskId)?.status, "active");

  // Past the grace the same key converges on the SAME candidate instead of minting a second one.
  offset = 10 * 60_000;
  const converged = await registry.start(input);
  assert.equal(converged.taskId, task.taskId);
  assert.equal(converged.candidateId, task.candidateId);
  assert.equal(converged.status, "active");
  assert.equal(registry.inventory().tasks, 1);
  assert.equal(countRequests(path), 1);
  assert.deepEqual(tableRows(path, "candidates").map((row) => row.task_id), [task.taskId]);
  assert.deepEqual(
    (await execFileAsync("git", [
      "branch", "--list", "orchestratory/candidate-*", "--format=%(refname:short)",
    ], { cwd: source })).stdout.split("\n").filter(Boolean),
    [task.candidateBranch],
  );
});

test("a recovering retry whose prior owner is this process keeps that reservation guarded", async (t) => {
  const { source, data } = await fixture(t);
  const registry = new CandidateRegistry(data);
  t.after(() => registry.close());
  const path = registry.path;
  const input = {
    actor: "codex", clientRequestId: key(), roomId: "demo", mainPath: source, task: "prior owner is this process",
  };
  const task = await registry.start(input);
  // The half-created row belongs to a creator that IS this process — a concurrent call in the same
  // seat, or a reservation this registry itself still holds. Nothing has died here.
  forceCandidateStatus(path, task.taskId, "creating");
  strandReservation(path, input.clientRequestId, process.pid);

  await assert.rejects(registry.start(input), /CANDIDATE_REQUEST_RECOVERING/u);
  // There is nothing to hand back when the prior owner is us, so restoring the pid must be a no-op
  // rather than a write. The reservation still names this process, and — the half of the behaviour
  // the fix must not break — the row stays guarded: a live owner's create is never reaped.
  assert.equal(requestOwnerPid(path, input.clientRequestId), process.pid);
  assert.deepEqual(await registry.reconcileCreating(0), { activated: 0, failed: 0 });
  assert.equal(registry.get(task.taskId)?.status, "creating");
  assert.deepEqual(storedRequest(path, input.clientRequestId), { state: "pending", receipt: null });
  assert.equal(registry.inventory().tasks, 1);
  assert.equal(countRequests(path), 1);
});

test("completion preview names a pure mode change and a submodule pointer instead of an ordinary edit", async (t) => {
  const { source, data } = await fixture(t);
  const pointers = await nestedRepository(join(source, "vendor"));
  // Recorded at the nested repository's current HEAD, so main is clean and the candidate is the only
  // thing that moves the pointer.
  await execFileAsync("git", ["update-index", "--add", "--cacheinfo", `160000,${pointers.second},vendor`], { cwd: source });
  await commitIndex(source, "track the vendor pointer");
  const registry = new CandidateRegistry(data);
  t.after(() => registry.close());
  const task = await registry.start({
    actor: "codex", clientRequestId: key(), roomId: "demo", mainPath: source, task: "mode and pointer preview",
  });
  await chmod(join(task.candidatePath, "README.md"), 0o755);
  await execFileAsync("git", ["update-index", "--chmod=+x", "--", "README.md"], { cwd: task.candidatePath });
  await execFileAsync("git", ["update-index", "--cacheinfo", `160000,${pointers.first},vendor`], { cwd: task.candidatePath });
  await commitIndex(task.candidatePath, "permission bit and submodule pointer only");

  const completed = await registry.complete({
    actor: "codex", clientRequestId: key(), taskId: task.taskId, roomId: "demo", mainPath: source,
    summary: "nothing but modes and a pointer",
  });
  const preview = completed.completion.preview;
  // The only lines in this diff are the submodule's own pointer line. The permission change on
  // README.md contributes nothing at all, which is exactly why a line-oriented preview cannot see it.
  assert.equal(preview.additions, 1);
  assert.equal(preview.deletions, 1);
  assert.equal(preview.modeChanges, 1);
  assert.deepEqual(preview.files.find((file) => file.path === "README.md"), {
    path: "README.md", operation: "modify", mode: { from: "100644", to: "100755" }, bytes: 15,
  });
  const vendor = preview.files.find((file) => file.path === "vendor");
  assert.equal(vendor?.operation, "modify");
  assert.equal(vendor?.submodule, true);
  // Both sides of a pointer move are 160000, so there is no mode change to report — and a gitlink has
  // no blob whose size could be asked for.
  assert.equal(vendor?.mode, undefined);
  assert.equal(vendor?.bytes, undefined);
  assert.deepEqual(preview.submodules, ["vendor"]);
  assert.equal(preview.submodulesTruncated, false);
  assert.equal(preview.mergeable, true);
  assert.deepEqual(preview.mergeConflicts, []);
  assert.equal(preview.mergeConflictsTruncated, false);

  // The digest and the read-path validation must both accept every new field, or the stored
  // completion becomes unreadable the moment the owner reopens it.
  const reopened = new CandidateRegistry(data);
  t.after(() => reopened.close());
  assert.deepEqual(reopened.get(task.taskId)?.completion?.preview, preview);
  assert.equal(reopened.get(task.taskId)?.completion?.previewDigest, completed.completion.previewDigest);
});

test("a simulated merge names the conflicting paths and never touches main", async (t) => {
  const { source, data } = await fixture(t);
  const registry = new CandidateRegistry(data);
  t.after(() => registry.close());
  const task = await registry.start({
    actor: "codex", clientRequestId: key(), roomId: "demo", mainPath: source, task: "real conflict preview",
  });
  await commit(task.candidatePath, "README.md", "candidate rewrite\n", "candidate edit");
  const mainHead = await commit(source, "README.md", "main rewrite\n", "main edit");
  const candidateHead = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: task.candidatePath })).stdout.trim();
  const refsBefore = (await execFileAsync("git", ["for-each-ref", "--format=%(refname) %(objectname)"], { cwd: source })).stdout;

  const completed = await registry.complete({
    actor: "codex", clientRequestId: key(), taskId: task.taskId, roomId: "demo", mainPath: source,
    summary: "this candidate does not merge cleanly",
  });
  const preview = completed.completion.preview;
  assert.equal(preview.mergeable, false);
  assert.deepEqual(preview.mergeConflicts, ["README.md"]);
  assert.equal(preview.mergeConflictsTruncated, false);
  // Drift and a conflict are different facts and stay in different fields: the advisory list still
  // says only that main moved, and the simulated result is the one that names a path.
  assert.deepEqual(preview.conflicts, ["MAIN_DRIFT_REQUIRES_FRESH_MERGE_PREVIEW"]);
  assert.match(completed.completion.prompt, /1 個檔案衝突/u);

  // The simulation writes no ref, no index and no file, in either workspace.
  assert.equal((await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: source })).stdout.trim(), mainHead);
  assert.equal((await execFileAsync("git", ["status", "--porcelain=v1"], { cwd: source })).stdout, "");
  assert.equal(await readFile(join(source, "README.md"), "utf8"), "main rewrite\n");
  assert.equal(
    (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: task.candidatePath })).stdout.trim(),
    candidateHead,
  );
  assert.equal((await execFileAsync("git", ["status", "--porcelain=v1"], { cwd: task.candidatePath })).stdout, "");
  for (const workspace of [source, task.candidatePath]) {
    await assert.rejects(execFileAsync("git", ["rev-parse", "--verify", "MERGE_HEAD"], { cwd: workspace }));
  }
  // The only ref this completion is allowed to add is its own recovery checkpoint. A merge that had
  // been carried out, rather than simulated, would show up here.
  const refsAfter = (await execFileAsync("git", ["for-each-ref", "--format=%(refname) %(objectname)"], { cwd: source })).stdout;
  assert.deepEqual(
    refsAfter.split("\n").filter(Boolean).filter((line) => !refsBefore.includes(line)),
    [`${completed.completion.preview.recovery.ref} ${candidateHead}`],
  );
});

test("main drift that still merges cleanly is reported mergeable with an empty conflict list", async (t) => {
  const { source, data } = await fixture(t);
  const registry = new CandidateRegistry(data);
  t.after(() => registry.close());
  const task = await registry.start({
    actor: "codex", clientRequestId: key(), roomId: "demo", mainPath: source, task: "clean merge preview",
  });
  await commit(task.candidatePath, "candidate.txt", "candidate work\n", "candidate work");
  await commit(source, "main-only.txt", "main work\n", "main work");
  const completed = await registry.complete({
    actor: "codex", clientRequestId: key(), taskId: task.taskId, roomId: "demo", mainPath: source,
    summary: "drifted but mergeable",
  });
  const preview = completed.completion.preview;
  assert.equal(preview.mainDrift, true);
  assert.deepEqual(preview.conflicts, ["MAIN_DRIFT_REQUIRES_FRESH_MERGE_PREVIEW"]);
  // Drift alone never meant a conflict; now the difference is measured instead of assumed.
  assert.equal(preview.mergeable, true);
  assert.deepEqual(preview.mergeConflicts, []);
  assert.equal(preview.mergeConflictsTruncated, false);
  assert.match(completed.completion.prompt, /沒有衝突/u);
});

test("every preview verdict is confirmed against a merge that really happens", async (t) => {
  const scenarios: Array<{
    name: string;
    mergeable: boolean;
    conflicts: string[];
    base?: (source: string) => Promise<void>;
    diverge: (source: string, candidatePath: string) => Promise<void>;
  }> = [
    {
      name: "both sides rewrite the same line",
      mergeable: false,
      conflicts: ["README.md"],
      diverge: async (source, candidatePath) => {
        await commit(candidatePath, "README.md", "candidate rewrite\n", "candidate edit");
        await commit(source, "README.md", "main rewrite\n", "main edit");
      },
    },
    {
      name: "each side adds a file of its own",
      mergeable: true,
      conflicts: [],
      diverge: async (source, candidatePath) => {
        await commit(candidatePath, "candidate.txt", "candidate work\n", "candidate work");
        await commit(source, "main-only.txt", "main work\n", "main work");
      },
    },
    {
      // The case a "same file touched ⇒ conflict" heuristic gets wrong. Git merges these two hunks,
      // so a preview that reasoned about paths rather than content would report a conflict the owner
      // would never have hit.
      name: "both sides touch one file in hunks git merges on its own",
      mergeable: true,
      conflicts: [],
      base: async (source) => {
        await commit(source, "shared.txt", longFile("line 01", "line 40"), "shared base");
      },
      diverge: async (source, candidatePath) => {
        await commit(candidatePath, "shared.txt", longFile("candidate rewrote the top", "line 40"),
          "candidate edits the top");
        await commit(source, "shared.txt", longFile("line 01", "main rewrote the bottom"),
          "main edits the bottom");
      },
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async (child) => {
      const { root, source, data } = await fixture(child);
      await scenario.base?.(source);
      const registry = new CandidateRegistry(data);
      child.after(() => registry.close());
      const task = await registry.start({
        actor: "codex", clientRequestId: key(), roomId: "demo", mainPath: source, task: scenario.name,
      });
      await scenario.diverge(source, task.candidatePath);
      const mainHead = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: source })).stdout.trim();
      const mainTree = (await execFileAsync("git", ["rev-parse", "HEAD^{tree}"], { cwd: source })).stdout.trim();
      const refsBefore = (await execFileAsync("git", [
        "for-each-ref", "--format=%(refname) %(objectname)",
      ], { cwd: source })).stdout;

      const completed = await registry.complete({
        actor: "codex", clientRequestId: key(), taskId: task.taskId, roomId: "demo", mainPath: source,
        summary: "a preview that is about to be merged for real",
      });
      const preview = completed.completion.preview;
      assert.equal(preview.mergeConflictsTruncated, false);

      const actual = await actualMerge(root, "merge-check", source, preview.candidateHead);
      // The fixture's own expectation is asserted first: a fixture that quietly stopped conflicting
      // would otherwise keep passing by agreeing with a preview that had stopped conflicting too.
      assert.equal(actual.merged, scenario.mergeable);
      assert.deepEqual(actual.conflicts, scenario.conflicts);
      // The bar itself — the verdict and the path set the owner will be asked to approve are the
      // ones a real merge produces.
      assert.equal(preview.mergeable, actual.merged);
      assert.deepEqual([...preview.mergeConflicts].sort(), actual.conflicts);

      // Neither the simulation nor the merge carried out on the copy may leave a mark on main. Its
      // head, its tree, its worktree and its index all have to be where they were, and the only ref
      // the completion may add is its own recovery checkpoint.
      assert.equal((await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: source })).stdout.trim(), mainHead);
      assert.equal((await execFileAsync("git", ["rev-parse", "HEAD^{tree}"], { cwd: source })).stdout.trim(), mainTree);
      assert.equal((await execFileAsync("git", ["status", "--porcelain=v1"], { cwd: source })).stdout, "");
      await assert.rejects(execFileAsync("git", ["rev-parse", "--verify", "MERGE_HEAD"], { cwd: source }));
      const refsAfter = (await execFileAsync("git", [
        "for-each-ref", "--format=%(refname) %(objectname)",
      ], { cwd: source })).stdout;
      assert.deepEqual(
        refsAfter.split("\n").filter(Boolean).filter((line) => !refsBefore.includes(line)),
        [`${preview.recovery.ref} ${preview.candidateHead}`],
      );
    });
  }
});

test("submodule and merge-conflict lists are bounded and report their own truncation", {
  timeout: 120_000,
}, async (t) => {
  const { source, data } = await fixture(t);
  const registry = new CandidateRegistry(data);
  t.after(() => registry.close());
  const task = await registry.start({
    actor: "codex", clientRequestId: key(), roomId: "demo", mainPath: source, task: "bounded preview lists",
  });
  const mainBlob = (await gitWithInput(source, ["hash-object", "-w", "--stdin"], "main side\n")).trim();
  const candidateBlob = (await gitWithInput(source, ["hash-object", "-w", "--stdin"], "candidate side\n")).trim();
  const baseTree = (await execFileAsync("git", ["ls-tree", "-z", "HEAD"], { cwd: source })).stdout;
  const conflicting = Array.from({ length: MAX_MERGE_CONFLICTS + 50 }, (_, index) =>
    `conflict-${String(index).padStart(4, "0")}.txt`);
  const pointers = Array.from({ length: MAX_PREVIEW_SUBMODULES + 20 }, (_, index) =>
    `vendor-${String(index).padStart(4, "0")}`);

  const mainTree = (await gitWithInput(source, ["mktree", "-z"],
    baseTree + conflicting.map((name) => `100644 blob ${mainBlob}\t${name}\0`).join(""))).trim();
  const mainCommit = (await gitWithInput(source, [
    "-c", "user.name=Candidate Test", "-c", "user.email=test@example.invalid",
    "commit-tree", mainTree, "-p", task.baseMainHead,
  ], "main adds every contested path\n")).trim();
  await execFileAsync("git", ["merge", "--ff-only", mainCommit], { cwd: source });

  // The candidate adds the same paths with different content, plus more submodule pointers than the
  // preview will ever list.
  const candidateTree = (await gitWithInput(task.candidatePath, ["mktree", "-z"],
    baseTree
      + conflicting.map((name) => `100644 blob ${candidateBlob}\t${name}\0`).join("")
      + pointers.map((name) => `160000 commit ${task.baseMainHead}\t${name}\0`).join(""))).trim();
  const candidateCommit = (await gitWithInput(task.candidatePath, [
    "-c", "user.name=Candidate Test", "-c", "user.email=test@example.invalid",
    "commit-tree", candidateTree, "-p", task.baseMainHead,
  ], "candidate adds contested paths and pointers\n")).trim();
  await execFileAsync("git", ["merge", "--ff-only", candidateCommit], { cwd: task.candidatePath });

  const completed = await registry.complete({
    actor: "codex", clientRequestId: key(), taskId: task.taskId, roomId: "demo", mainPath: source,
    summary: "more conflicts and pointers than either list reports",
  });
  const preview = completed.completion.preview;
  assert.equal(preview.fileCount, conflicting.length + pointers.length);
  assert.equal(preview.filesTruncated, false);
  // Reaching the bound is reported as truncation, exactly as filesTruncated does; it never means the
  // list is the whole answer.
  assert.equal(preview.submodules.length, MAX_PREVIEW_SUBMODULES);
  assert.equal(preview.submodulesTruncated, true);
  assert.equal(preview.submodules[0], "vendor-0000");
  assert.equal(preview.files.filter((file) => file.submodule === true).length, pointers.length);
  assert.equal(preview.files.filter((file) => file.bytes !== undefined).length, conflicting.length);
  assert.equal(preview.modeChanges, 0);
  assert.equal(preview.mergeable, false);
  assert.equal(preview.mergeConflicts.length, MAX_MERGE_CONFLICTS);
  assert.equal(preview.mergeConflictsTruncated, true);
  assert.equal(preview.mergeConflicts[0], "conflict-0000.txt");
  assert.match(completed.completion.prompt, /（已截斷）/u);
  assert.deepEqual(new CandidateRegistry(data).get(task.taskId)?.completion?.preview, preview);
});

test("a merge that cannot be simulated fails closed instead of claiming the candidate is mergeable", async (t) => {
  await t.test("git refuses the merge outright", async (child) => {
    const { source, data } = await fixture(child);
    const registry = new CandidateRegistry(data);
    child.after(() => registry.close());
    const task = await registry.start({
      actor: "codex", clientRequestId: key(), roomId: "demo", mainPath: source, task: "unmergeable main",
    });
    await commit(task.candidatePath, "candidate.txt", "candidate work\n", "candidate work");
    // Main is rewritten onto a root commit that shares no history with the candidate. merge-tree
    // reports that on stderr and exits 1 — the same status a real conflict uses.
    await execFileAsync("git", ["checkout", "--orphan", "rewritten"], { cwd: source });
    const rewritten = await commitIndex(source, "unrelated root");
    const requests = countRequests(registry.path);
    await assert.rejects(
      registry.complete({
        actor: "codex", clientRequestId: key(), taskId: task.taskId, roomId: "demo", mainPath: source,
        summary: "must not be answered with mergeable",
      }),
      /CANDIDATE_MERGE_PREVIEW_UNAVAILABLE/u,
    );
    assert.equal(registry.get(task.taskId)?.status, "active");
    assert.equal(registry.get(task.taskId)?.completion, undefined);
    assert.equal(countRequests(registry.path), requests);
    assert.equal((await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: source })).stdout.trim(), rewritten);
  });

  await t.test("the main head cannot be vouched for", async (child) => {
    const { source, data } = await fixture(child);
    const gitBroker = new UnverifiedHeadGitBroker();
    const registry = new CandidateRegistry(data, { gitBroker });
    child.after(() => registry.close());
    const task = await registry.start({
      actor: "codex", clientRequestId: key(), roomId: "demo", mainPath: source, task: "unverifiable main head",
    });
    await commit(task.candidatePath, "candidate.txt", "candidate work\n", "candidate work");
    // Nothing that is not a commit id may reach git's argument list, whatever produced it.
    gitBroker.head = "--upload-pack=touch-main";
    await assert.rejects(
      registry.complete({
        actor: "codex", clientRequestId: key(), taskId: task.taskId, roomId: "demo", mainPath: source,
        summary: "must not reach git",
      }),
      /CANDIDATE_MERGE_PREVIEW_UNAVAILABLE/u,
    );
    assert.equal(registry.get(task.taskId)?.status, "active");
  });
});

test("a merge simulation that outgrows its output budget fails closed rather than truncating", {
  timeout: 180_000,
}, async (t) => {
  const { source, data } = await fixture(t);
  const registry = new CandidateRegistry(data, { maxFiles: 1 });
  t.after(() => registry.close());
  const task = await registry.start({
    actor: "codex", clientRequestId: key(), roomId: "demo", mainPath: source, task: "oversized merge output",
  });
  const mainBlob = (await gitWithInput(source, ["hash-object", "-w", "--stdin"], "main side\n")).trim();
  const candidateBlob = (await gitWithInput(source, ["hash-object", "-w", "--stdin"], "candidate side\n")).trim();
  const baseTree = (await execFileAsync("git", ["ls-tree", "-z", "HEAD"], { cwd: source })).stdout;
  // Enough contested paths that the conflict list alone exceeds the streamed byte budget. A half-read
  // list would understate the conflicts the owner is being asked to approve.
  const contested = Array.from({ length: 5_200 }, (_, index) =>
    `contested-${String(index).padStart(5, "0")}-${"z".repeat(200)}`);
  const mainTree = (await gitWithInput(source, ["mktree", "-z"],
    baseTree + contested.map((name) => `100644 blob ${mainBlob}\t${name}\0`).join(""))).trim();
  const mainCommit = (await gitWithInput(source, [
    "-c", "user.name=Candidate Test", "-c", "user.email=test@example.invalid",
    "commit-tree", mainTree, "-p", task.baseMainHead,
  ], "main bulk\n")).trim();
  await execFileAsync("git", ["merge", "--ff-only", mainCommit], { cwd: source, maxBuffer: 8 * 1_048_576 });
  const candidateTree = (await gitWithInput(task.candidatePath, ["mktree", "-z"],
    baseTree + contested.map((name) => `100644 blob ${candidateBlob}\t${name}\0`).join(""))).trim();
  const candidateCommit = (await gitWithInput(task.candidatePath, [
    "-c", "user.name=Candidate Test", "-c", "user.email=test@example.invalid",
    "commit-tree", candidateTree, "-p", task.baseMainHead,
  ], "candidate bulk\n")).trim();
  await execFileAsync("git", ["merge", "--ff-only", candidateCommit], {
    cwd: task.candidatePath, maxBuffer: 8 * 1_048_576,
  });

  await assert.rejects(
    registry.complete({
      actor: "codex", clientRequestId: key(), taskId: task.taskId, roomId: "demo", mainPath: source,
      summary: "output budget exceeded",
    }),
    /CANDIDATE_MERGE_PREVIEW_UNAVAILABLE/u,
  );
  assert.equal(registry.get(task.taskId)?.status, "active");
});

test("a raw diff record this parser does not fully understand is refused, never guessed at", () => {
  assert.deepEqual(parseRawDiffRecord(":100644 100755 7898192 7898192 M"), {
    from: "100644", to: "100755", code: "M",
  });
  assert.deepEqual(parseRawDiffRecord(":100644 100644 6178079 6178079 R100"), {
    from: "100644", to: "100644", code: "R",
  });
  assert.deepEqual(parseRawDiffRecord(":000000 160000 0000000 ab02cc4 A"), {
    from: "000000", to: "160000", code: "A",
  });
  for (const malformed of [
    "",
    "M",
    "100644 100755 7898192 7898192 M",
    ":100644 100755 7898192 M",
    // A mode this parser cannot read must never be treated as "no mode change".
    ":10064 100755 7898192 7898192 M",
    ":100644 10075x 7898192 7898192 M",
    ":100644 100755 789819g 7898192 M",
    ":100644 100755 7898192 7898192 m",
    ":100644 100755 7898192 7898192 M100000",
    ":100644 100755 7898192 7898192 M extra",
    ":100644 100755 7898192 7898192 M\n:100644 100755 7898192 7898192 M",
    "::100644 100644 100755 7898192 7898192 7898192 MM",
  ]) {
    assert.throws(() => parseRawDiffRecord(malformed), /CANDIDATE_DIFF_INVALID/u, malformed);
  }
});

test("a stored preview whose merge facts do not hold up is refused on reopen", async (t) => {
  const { source, data } = await fixture(t);
  const registry = new CandidateRegistry(data);
  const task = await registry.start({
    actor: "codex", clientRequestId: key(), roomId: "demo", mainPath: source, task: "stored preview validation",
  });
  await commit(task.candidatePath, "README.md", "candidate rewrite\n", "candidate edit");
  await commit(source, "README.md", "main rewrite\n", "main edit");
  const completed = await registry.complete({
    actor: "codex", clientRequestId: key(), taskId: task.taskId, roomId: "demo", mainPath: source,
    summary: "stored for re-validation",
  });
  const pristine = completed.completion.preview as unknown as Record<string, unknown>;
  const path = registry.path;
  registry.close();
  assert.deepEqual(new CandidateRegistry(data).get(task.taskId)?.completion?.preview.mergeConflicts, ["README.md"]);

  // Every corruption below is re-digested and re-hashed, so it is refused on what it claims rather
  // than on a checksum. A stored preview is the thing the owner approves a merge from.
  const corruptions: Array<[string, (preview: Record<string, unknown>) => void]> = [
    ["mergeable while naming conflicts", (preview) => { preview.mergeable = true; }],
    ["mergeable while claiming truncation", (preview) => {
      preview.mergeable = true;
      preview.mergeConflicts = [];
      preview.mergeConflictsTruncated = true;
    }],
    ["a non-boolean mergeable", (preview) => { preview.mergeable = "no"; }],
    ["a non-boolean truncation flag", (preview) => { preview.submodulesTruncated = 0; }],
    ["conflicts that are not a list", (preview) => { preview.mergeConflicts = "README.md"; }],
    ["more conflicts than the bound allows", (preview) => {
      preview.mergeConflicts = Array.from({ length: MAX_MERGE_CONFLICTS + 1 }, (_, index) => `c-${index}`);
    }],
    ["a conflict path that is not a path", (preview) => { preview.mergeConflicts = [{ path: "README.md" }]; }],
    ["more submodules than the bound allows", (preview) => {
      preview.submodules = Array.from({ length: MAX_PREVIEW_SUBMODULES + 1 }, (_, index) => `s-${index}`);
    }],
    ["a negative mode-change count", (preview) => { preview.modeChanges = -1; }],
    ["more mode changes than files", (preview) => { preview.modeChanges = Number(preview.fileCount) + 1; }],
    ["files that are not a list", (preview) => { preview.files = "README.md"; }],
    ["a file entry that is not an object", (preview) => { preview.files = [1]; }],
    ["a submodule flag that is not true", (preview) => { preview.files = [{ path: "a", operation: "modify", submodule: "yes" }]; }],
    ["a mode that is not a pair", (preview) => { preview.files = [{ path: "a", operation: "modify", mode: "100755" }]; }],
    ["a mode whose source is not a mode", (preview) => {
      preview.files = [{ path: "a", operation: "modify", mode: { from: "100", to: "100755" } }];
    }],
    ["a mode whose target is not a mode", (preview) => {
      preview.files = [{ path: "a", operation: "modify", mode: { from: "100644", to: "rwxrwx" } }];
    }],
    ["a mode that did not change", (preview) => {
      preview.files = [{ path: "a", operation: "modify", mode: { from: "100644", to: "100644" } }];
    }],
  ];
  for (const [name, mutate] of corruptions) {
    // Each case starts from the pristine preview, so what is refused is the one fact it corrupts.
    const preview = structuredClone(pristine);
    mutate(preview);
    storeCompletionPreview(path, task.taskId, preview);
    assert.throws(() => new CandidateRegistry(data), /CANDIDATE_COMPLETION_PREVIEW_INVALID/u, name);
  }
});
