import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";

/** Narrows a listing entry, asserting it is readable — an unreadable row is a distinct state. */
function readable(entry: MergeApprovalSummary | UnreadableMergeApproval | undefined): MergeApprovalSummary {
  assert.ok(entry, "expected a merge approval summary");
  assert.notEqual(entry.state, "unreadable");
  return entry as MergeApprovalSummary;
}
import {
  CandidateRegistry, MAX_MERGE_CONFLICTS, MAX_PREVIEW_SUBMODULES, MERGE_APPROVAL_CONFIRMATION,
  MERGE_APPROVAL_GRANT, MERGE_APPROVAL_GRANT_TTL_MS, MERGE_APPROVAL_REQUEST_TTL_MS,
  MergeApprovalBindingError, type CandidateCompletion, type CandidateTask, type MergeApproval,
  type MergeApprovalSummary,
  type UnreadableMergeApproval,
} from "../src/core/candidate-registry.ts";

const execFileAsync = promisify(execFile);
const key = (): string => randomUUID();
const author = ["-c", "user.name=Merge Approval Test", "-c", "user.email=test@example.invalid"];

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

async function commit(workspace: string, filename: string, contents: string, message: string): Promise<string> {
  await writeFile(join(workspace, filename), contents, "utf8");
  await execFileAsync("git", ["add", "--", filename], { cwd: workspace });
  await execFileAsync("git", [...author, "commit", "-m", message], { cwd: workspace });
  return (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: workspace })).stdout.trim();
}

function candidateRowHash(row: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify([
    row.task_id, row.candidate_id, row.room_id, row.main_path, row.main_branch,
    row.base_main_head, row.candidate_path, row.candidate_branch, row.task_text,
    row.acceptance_criteria, row.status, row.baseline_json, row.completion_json,
    row.created_at_ms, row.updated_at_ms, row.completed_at_ms,
  ]), "utf8").digest("hex");
}

function mergeApprovalRowHash(row: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify([
    row.id, row.client_request_id, row.input_digest, row.task_id, row.completion_id, row.room_id,
    row.main_path, row.main_branch, row.candidate_path, row.base_main_head, row.candidate_head,
    row.main_head, row.main_fingerprint, row.main_ignored_fingerprint, row.recovery_ref,
    row.preview_digest, row.preview_json, row.grant_action, row.state, row.token_hash, row.actor,
    row.decided_by, row.refusal_json, row.created_at_ms, row.updated_at_ms, row.expires_at_ms,
  ]), "utf8").digest("hex");
}

function tableRows(path: string, table: string): Record<string, unknown>[] {
  const db = new DatabaseSync(path);
  const rows = db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as unknown as Record<string, unknown>[];
  db.close();
  return rows;
}

function approvalState(path: string, approvalId: string): string {
  const db = new DatabaseSync(path);
  const row = db.prepare("SELECT state FROM candidate_merge_approvals WHERE id=?").get(approvalId) as { state: string };
  db.close();
  return row.state;
}

/**
 * Rewrites the stored completion's known risks and re-stamps both the preview digest and the row
 * hash, so the completion stays internally consistent. It is the one way to move the recomputed
 * preview digest without moving any of the scalars the binding also tracks, which is exactly the
 * case the digest exists to catch.
 */
function rewriteCompletionRisks(path: string, taskId: string, risks: string[]): void {
  const db = new DatabaseSync(path);
  let row = db.prepare("SELECT * FROM candidates WHERE task_id=?").get(taskId) as Record<string, unknown>;
  const completion = JSON.parse(String(row.completion_json)) as { preview: { knownRisks: string[] }; previewDigest: string };
  completion.preview.knownRisks = risks;
  completion.previewDigest = createHash("sha256")
    .update(JSON.stringify(completion.preview), "utf8").digest("hex");
  const completionJson = JSON.stringify(completion);
  row = { ...row, completion_json: completionJson };
  const changes = db.prepare("UPDATE candidates SET completion_json=?,row_hash=? WHERE task_id=?")
    .run(completionJson, candidateRowHash(row), taskId).changes;
  db.close();
  assert.equal(Number(changes), 1);
}

/** Flips one stored preview flag and re-stamps digest and row hash, so nothing else is inconsistent. */
function rewriteApprovalPreview(path: string, approvalId: string, patch: Record<string, unknown>): void {
  const db = new DatabaseSync(path);
  let row = db.prepare("SELECT * FROM candidate_merge_approvals WHERE id=?")
    .get(approvalId) as Record<string, unknown>;
  const preview = { ...JSON.parse(String(row.preview_json)) as Record<string, unknown>, ...patch };
  const previewJson = JSON.stringify(preview);
  const previewDigest = createHash("sha256").update(previewJson, "utf8").digest("hex");
  row = { ...row, preview_json: previewJson, preview_digest: previewDigest };
  const changes = db.prepare(
    "UPDATE candidate_merge_approvals SET preview_json=?,preview_digest=?,row_hash=? WHERE id=?",
  ).run(previewJson, previewDigest, mergeApprovalRowHash(row), approvalId).changes;
  db.close();
  assert.equal(Number(changes), 1);
}

interface Ready {
  source: string;
  data: string;
  path: string;
  registry: CandidateRegistry;
  task: CandidateTask;
  completion: CandidateCompletion;
  clock: { now: number };
}

/** A completed, clean, recoverable candidate: the only shape a merge approval may be raised against. */
async function ready(t: TestContext, options: { maxFiles?: number; files?: number } = {}): Promise<Ready> {
  const root = await mkdtemp(join(tmpdir(), "orchestratory-merge-approval-"));
  const source = join(root, "source");
  const data = join(root, "data");
  await mkdir(source);
  await mkdir(data, { mode: 0o700 });
  await execFileAsync("git", ["init", "-b", "main"], { cwd: source });
  await writeFile(join(source, "README.md"), "committed main\n", "utf8");
  await writeFile(join(source, ".gitignore"), "*.cache\n", "utf8");
  await execFileAsync("git", ["add", "README.md", ".gitignore"], { cwd: source });
  await execFileAsync("git", [...author, "commit", "-m", "initial"], { cwd: source });
  t.after(async () => await rm(root, { recursive: true, force: true }));

  const clock = { now: Date.UTC(2026, 7, 6, 9, 0, 0) };
  const registry = new CandidateRegistry(data, {
    now: () => clock.now,
    ...(options.maxFiles === undefined ? {} : { maxFiles: options.maxFiles }),
  });
  t.after(() => registry.close());
  const task = await registry.start({
    actor: "codex1", clientRequestId: key(), roomId: "demo", mainPath: source,
    task: "snapshot-bound merge approval",
  });
  for (let index = 0; index < (options.files ?? 1); index += 1) {
    await commit(task.candidatePath, `candidate-${index}.txt`, `candidate ${index}\n`, `candidate work ${index}`);
  }
  const completed = await registry.complete({
    actor: "codex1", clientRequestId: key(), taskId: task.taskId, roomId: "demo", mainPath: source,
    summary: "ready for owner review",
    tests: [{ command: "npm test", status: "passed" }],
    knownRisks: ["synthetic"],
  });
  return { source, data, path: registry.path, registry, task, completion: completed.completion, clock };
}

async function raise(fixture: Ready): Promise<MergeApproval> {
  const preview = await fixture.registry.previewMainMerge({
    taskId: fixture.task.taskId, roomId: "demo", mainPath: fixture.source,
  });
  assert.equal(preview.approvable, true);
  return await fixture.registry.requestMainMerge({
    actor: "codex1", clientRequestId: key(), taskId: fixture.task.taskId, roomId: "demo",
    mainPath: fixture.source, completionId: preview.completionId, previewDigest: preview.previewDigest,
  });
}

async function grant(fixture: Ready, approval: MergeApproval): Promise<{ approvalToken: string }> {
  return await fixture.registry.grantMainMerge({
    approvalId: approval.id, roomId: "demo", mainPath: fixture.source,
    previewDigest: approval.binding.previewDigest,
    confirmation: MERGE_APPROVAL_CONFIRMATION, decidedBy: "local-web",
  });
}

/** Everything a refusal, an expiry or a rejection is forbidden to disturb. */
async function untouched(fixture: Ready): Promise<Record<string, unknown>> {
  const refs = await execFileAsync(
    "git", ["for-each-ref", "--format=%(refname) %(objectname)", "refs/"], { cwd: fixture.source },
  );
  return {
    candidates: tableRows(fixture.path, "candidates"),
    checkpoints: tableRows(fixture.path, "candidate_checkpoints"),
    refs: refs.stdout,
    mainHead: (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: fixture.source })).stdout,
    mainStatus: (await execFileAsync("git", ["status", "--porcelain=v1"], { cwd: fixture.source })).stdout,
    candidateHead: (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: fixture.task.candidatePath })).stdout,
  };
}

// Negative first, and one bound value at a time. A refusal that says only "something changed" leaves
// the owner nothing to act on, so each case asserts the NAME of the value that moved.
test("a granted merge approval is refused when any single bound value has changed, and names it", async (t) => {
  await t.test("main HEAD moved", async (child) => {
    const fixture = await ready(child);
    const approval = await raise(fixture);
    await commit(fixture.source, "main-side.txt", "main moved on\n", "main moves");
    await assert.rejects(
      grant(fixture, approval),
      (error: MergeApprovalBindingError) => error.changed.includes("mainHead")
        && /^MAIN_MERGE_APPROVAL_BINDING_CHANGED:/u.test(error.message),
    );
    assert.equal(approvalState(fixture.path, approval.id), "invalidated");
  });

  await t.test("main is checked out on a different branch", async (child) => {
    const fixture = await ready(child);
    const approval = await raise(fixture);
    // The commit is untouched, so only the branch this approval targets has changed.
    await execFileAsync("git", ["switch", "-c", "release"], { cwd: fixture.source });
    await assert.rejects(
      grant(fixture, approval),
      (error: MergeApprovalBindingError) => error.changed.includes("mainBranch")
        && !error.changed.includes("mainHead"),
    );
  });

  await t.test("main working tree became dirty", async (child) => {
    const fixture = await ready(child);
    const approval = await raise(fixture);
    await writeFile(join(fixture.source, "README.md"), "owner edited main\n", "utf8");
    await assert.rejects(
      grant(fixture, approval),
      (error: MergeApprovalBindingError) => error.changed.includes("mainDirtyFingerprint"),
    );
  });

  await t.test("main gained an ignored file", async (child) => {
    const fixture = await ready(child);
    const approval = await raise(fixture);
    await writeFile(join(fixture.source, "owner.cache"), "ignored owner state\n", "utf8");
    await assert.rejects(
      grant(fixture, approval),
      (error: MergeApprovalBindingError) => error.changed.includes("mainIgnoredFingerprint"),
    );
  });

  await t.test("candidate HEAD moved", async (child) => {
    const fixture = await ready(child);
    const approval = await raise(fixture);
    await commit(fixture.task.candidatePath, "late.txt", "committed after the request\n", "late work");
    await assert.rejects(
      grant(fixture, approval),
      (error: MergeApprovalBindingError) => error.changed.includes("candidateHead"),
    );
  });

  await t.test("candidate working tree became dirty", async (child) => {
    const fixture = await ready(child);
    const approval = await raise(fixture);
    await writeFile(join(fixture.task.candidatePath, "uncommitted.txt"), "not committed\n", "utf8");
    await assert.rejects(
      grant(fixture, approval),
      (error: MergeApprovalBindingError) => error.changed.includes("candidateWorktreeClean")
        && !error.changed.includes("candidateHead"),
    );
  });

  await t.test("the recovery ref is gone", async (child) => {
    const fixture = await ready(child);
    const approval = await raise(fixture);
    await execFileAsync("git", ["update-ref", "-d", approval.binding.recoveryRef], { cwd: fixture.source });
    await assert.rejects(
      grant(fixture, approval),
      (error: MergeApprovalBindingError) => error.changed.includes("recoveryRef"),
    );
  });

  await t.test("the preview digest no longer reproduces", async (child) => {
    const fixture = await ready(child);
    const approval = await raise(fixture);
    // Every scalar stays put; only the content the digest covers moves, which is the one thing a
    // scalar-by-scalar comparison could never notice on its own.
    rewriteCompletionRisks(fixture.path, fixture.task.taskId, ["a risk the owner never saw"]);
    await assert.rejects(
      grant(fixture, approval),
      (error: MergeApprovalBindingError) => error.changed.length === 1 && error.changed[0] === "previewDigest",
    );
  });

  await t.test("the candidate left the completed state", async (child) => {
    const fixture = await ready(child);
    const approval = await raise(fixture);
    const db = new DatabaseSync(fixture.path);
    let row = db.prepare("SELECT * FROM candidates WHERE task_id=?")
      .get(fixture.task.taskId) as Record<string, unknown>;
    row = { ...row, status: "merged" };
    db.prepare("UPDATE candidates SET status=?,row_hash=? WHERE task_id=?")
      .run("merged", candidateRowHash(row), fixture.task.taskId);
    db.close();
    await assert.rejects(
      grant(fixture, approval),
      (error: MergeApprovalBindingError) => error.changed.includes("candidateStatus"),
    );
  });
});

test("consumption re-verifies the binding rather than trusting the grant", async (t) => {
  const fixture = await ready(t);
  const approval = await raise(fixture);
  const { approvalToken } = await grant(fixture, approval);
  // Nothing was wrong when the owner approved. Everything below happens afterwards, so a check that
  // ran only at creation time would let all of it through.
  await commit(fixture.source, "main-side.txt", "main moved after approval\n", "main moves");
  await assert.rejects(
    fixture.registry.promoteMainMerge({
      approvalId: approval.id, token: approvalToken, action: MERGE_APPROVAL_GRANT,
      taskId: fixture.task.taskId, roomId: "demo", mainPath: fixture.source,
    }),
    (error: MergeApprovalBindingError) => error.changed.includes("mainHead"),
  );
  assert.equal(approvalState(fixture.path, approval.id), "invalidated");
});

test("a merge approval refuses a consumer pointed at anything but what the owner agreed to", async (t) => {
  const fixture = await ready(t);
  const approval = await raise(fixture);
  const { approvalToken } = await grant(fixture, approval);
  const base = {
    approvalId: approval.id, token: approvalToken, action: MERGE_APPROVAL_GRANT,
    taskId: fixture.task.taskId, roomId: "demo", mainPath: fixture.source,
  };
  for (const [patch, named] of [
    [{ taskId: randomUUID() }, "taskId"],
    [{ roomId: "other" }, "roomId"],
    [{ mainPath: fixture.task.candidatePath }, "mainPath"],
  ] as const) {
    await assert.rejects(
      fixture.registry.promoteMainMerge({ ...base, ...patch }),
      (error: MergeApprovalBindingError) => error.changed.includes(named),
    );
  }
  // A caller who merely pointed at the wrong thing has not spent the owner's decision.
  assert.equal(approvalState(fixture.path, approval.id), "approved");
});

test("a consumed merge approval cannot be replayed and cannot be revived", async (t) => {
  const fixture = await ready(t);
  const approval = await raise(fixture);
  const { approvalToken } = await grant(fixture, approval);
  const call = {
    approvalId: approval.id, token: approvalToken, action: MERGE_APPROVAL_GRANT,
    taskId: fixture.task.taskId, roomId: "demo", mainPath: fixture.source,
  };
  const { authorization } = await fixture.registry.promoteMainMerge(call);
  assert.equal(authorization.grants, MERGE_APPROVAL_GRANT);
  assert.equal(authorization.singleUse, true);
  await assert.rejects(fixture.registry.promoteMainMerge(call), /MAIN_MERGE_APPROVAL_ALREADY_CONSUMED/u);
  // Terminal is terminal: neither the owner surface nor a second grant can put it back in play.
  await assert.rejects(grant(fixture, approval), /MAIN_MERGE_APPROVAL_NOT_PENDING/u);
  await assert.rejects(
    fixture.registry.rejectMainMerge({
      approvalId: approval.id, roomId: "demo", mainPath: fixture.source, decidedBy: "local-web",
    }),
    /MAIN_MERGE_APPROVAL_NOT_PENDING/u,
  );
  const stored = tableRows(fixture.path, "candidate_merge_approvals")[0];
  assert.equal(stored?.state, "consumed");
  // The single-use secret does not outlive the single use.
  assert.equal(stored?.token_hash, null);
});

test("two concurrent consumptions of one approval leave exactly one winner", async (t) => {
  const fixture = await ready(t);
  const approval = await raise(fixture);
  const { approvalToken } = await grant(fixture, approval);
  const call = {
    approvalId: approval.id, token: approvalToken, action: MERGE_APPROVAL_GRANT,
    taskId: fixture.task.taskId, roomId: "demo", mainPath: fixture.source,
  };
  const outcomes = await Promise.allSettled([
    fixture.registry.promoteMainMerge(call),
    fixture.registry.promoteMainMerge(call),
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  const loser = outcomes.find((outcome) => outcome.status === "rejected");
  // Either serialization point may win the race, and both are refusals that name what happened:
  // the loser is stopped by the promotion ledger's exclusive marker before it can run any Git
  // command, or by the approval's own single-use compare-and-set.
  assert.match(
    String(loser?.status === "rejected" ? (loser.reason as Error).message : ""),
    /MAIN_MERGE_(?:APPROVAL_ALREADY_CONSUMED|PROMOTION_ALREADY_STARTED)/u,
  );
  assert.equal(tableRows(fixture.path, "candidate_merge_approvals").length, 1);
  // And exactly one promotion exists, so main was written at most once.
  assert.equal(tableRows(fixture.path, "candidate_merge_promotions").length, 1);
});

test("a merge approval expires, and an expired one is refused at every surface", async (t) => {
  await t.test("an unanswered request lapses before the owner can grant it", async (child) => {
    const fixture = await ready(child);
    const approval = await raise(fixture);
    const before = await untouched(fixture);
    fixture.clock.now += MERGE_APPROVAL_REQUEST_TTL_MS + 1;
    await assert.rejects(grant(fixture, approval), /MAIN_MERGE_APPROVAL_EXPIRED/u);
    assert.equal(approvalState(fixture.path, approval.id), "expired");
    // Bar item 3: an expiry is not a cleanup authorization.
    assert.deepEqual(await untouched(fixture), before);
    // And the owner can be asked again, against a freshly computed snapshot.
    const again = await raise(fixture);
    assert.equal(again.state, "requested");
    assert.notEqual(again.id, approval.id);
  });

  await t.test("a granted approval lapses before it is consumed", async (child) => {
    const fixture = await ready(child);
    const approval = await raise(fixture);
    const { approvalToken } = await grant(fixture, approval);
    const before = await untouched(fixture);
    fixture.clock.now += MERGE_APPROVAL_GRANT_TTL_MS + 1;
    await assert.rejects(
      fixture.registry.promoteMainMerge({
        approvalId: approval.id, token: approvalToken, action: MERGE_APPROVAL_GRANT,
        taskId: fixture.task.taskId, roomId: "demo", mainPath: fixture.source,
      }),
      /MAIN_MERGE_APPROVAL_EXPIRED/u,
    );
    assert.equal(approvalState(fixture.path, approval.id), "expired");
    assert.deepEqual(await untouched(fixture), before);
  });

  await t.test("the grant window is shorter than the window the owner had to decide", async (child) => {
    const fixture = await ready(child);
    const approval = await raise(fixture);
    const granted = await fixture.registry.grantMainMerge({
      approvalId: approval.id, roomId: "demo", mainPath: fixture.source,
      previewDigest: approval.binding.previewDigest,
      confirmation: MERGE_APPROVAL_CONFIRMATION, decidedBy: "local-web",
    });
    assert.equal(
      Date.parse(granted.expiresAt),
      fixture.clock.now + MERGE_APPROVAL_GRANT_TTL_MS,
    );
    assert.ok(MERGE_APPROVAL_GRANT_TTL_MS < MERGE_APPROVAL_REQUEST_TTL_MS);
  });
});

test("a truncated preview is not approvable, whichever list was truncated", async (t) => {
  await t.test("the file list", async (child) => {
    // Two changed files against a registry that reports one.
    const fixture = await ready(child, { maxFiles: 1, files: 2 });
    const preview = await fixture.registry.previewMainMerge({
      taskId: fixture.task.taskId, roomId: "demo", mainPath: fixture.source,
    });
    assert.equal(preview.preview.filesTruncated, true);
    assert.equal(preview.approvable, false);
    // A truncated file list also makes the overwrite scan unrunnable, and that is reported as its
    // own blocker rather than as an empty overwrite result: the scan looks for exactly the paths the
    // truncated list is missing, so "nothing would be overwritten" is not an answer it can give.
    assert.deepEqual(
      preview.blockers, ["PREVIEW_FILES_TRUNCATED", "OVERWRITE_SCAN_FILE_LIST_TRUNCATED"],
    );
    assert.equal(preview.overwrites.checked, false);
    await assert.rejects(
      fixture.registry.requestMainMerge({
        actor: "codex1", clientRequestId: key(), taskId: fixture.task.taskId, roomId: "demo",
        mainPath: fixture.source, completionId: preview.completionId, previewDigest: preview.previewDigest,
      }),
      /MAIN_MERGE_PREVIEW_TRUNCATED/u,
    );
    assert.equal(tableRows(fixture.path, "candidate_merge_approvals").length, 0);
  });

  await t.test("the submodule list", { timeout: 120_000 }, async (child) => {
    const fixture = await ready(child);
    const baseTree = (await execFileAsync("git", ["ls-tree", "-z", "HEAD"], { cwd: fixture.source })).stdout;
    const pointers = Array.from({ length: MAX_PREVIEW_SUBMODULES + 5 }, (_, index) =>
      `vendor-${String(index).padStart(4, "0")}`);
    const tree = (await gitWithInput(fixture.task.candidatePath, ["mktree", "-z"],
      baseTree + pointers.map((name) => `160000 commit ${fixture.task.baseMainHead}\t${name}\0`).join(""))).trim();
    const created = (await gitWithInput(fixture.task.candidatePath, [
      ...author, "commit-tree", tree, "-p", fixture.task.baseMainHead,
    ], "candidate adds more pointers than the preview lists\n")).trim();
    await execFileAsync("git", ["reset", "--hard", created], { cwd: fixture.task.candidatePath });
    // Completing again is impossible, so the candidate is completed fresh against this tree.
    const second = await freshCompletion(child, fixture);
    assert.equal(second.preview.preview.submodulesTruncated, true);
    assert.equal(second.preview.approvable, false);
    assert.deepEqual(second.preview.blockers, ["PREVIEW_SUBMODULES_TRUNCATED"]);
    await assert.rejects(second.request(), /MAIN_MERGE_PREVIEW_TRUNCATED/u);
  });

  await t.test("the merge-conflict list", { timeout: 120_000 }, async (child) => {
    const fixture = await ready(child);
    const mainBlob = (await gitWithInput(fixture.source, ["hash-object", "-w", "--stdin"], "main side\n")).trim();
    const candidateBlob = (await gitWithInput(fixture.source, ["hash-object", "-w", "--stdin"], "candidate side\n")).trim();
    const baseTree = (await execFileAsync("git", ["ls-tree", "-z", "HEAD"], { cwd: fixture.source })).stdout;
    const contested = Array.from({ length: MAX_MERGE_CONFLICTS + 5 }, (_, index) =>
      `conflict-${String(index).padStart(4, "0")}.txt`);
    const mainTree = (await gitWithInput(fixture.source, ["mktree", "-z"],
      baseTree + contested.map((name) => `100644 blob ${mainBlob}\t${name}\0`).join(""))).trim();
    const mainCommit = (await gitWithInput(fixture.source, [
      ...author, "commit-tree", mainTree, "-p", fixture.task.baseMainHead,
    ], "main claims every contested path\n")).trim();
    await execFileAsync("git", ["merge", "--ff-only", mainCommit], { cwd: fixture.source });
    const candidateTree = (await gitWithInput(fixture.task.candidatePath, ["mktree", "-z"],
      baseTree + contested.map((name) => `100644 blob ${candidateBlob}\t${name}\0`).join(""))).trim();
    const candidateCommit = (await gitWithInput(fixture.task.candidatePath, [
      ...author, "commit-tree", candidateTree, "-p", fixture.task.baseMainHead,
    ], "candidate claims every contested path\n")).trim();
    await execFileAsync("git", ["reset", "--hard", candidateCommit], { cwd: fixture.task.candidatePath });
    const second = await freshCompletion(child, fixture);
    assert.equal(second.preview.preview.mergeConflictsTruncated, true);
    assert.equal(second.preview.approvable, false);
    // Conflicts cannot be truncated without existing, so this is the one flag that cannot be
    // isolated. Both reasons are reported, and either one alone would already block approval.
    assert.ok(second.preview.blockers.includes("PREVIEW_MERGE_CONFLICTS_TRUNCATED"));
    await assert.rejects(second.request(), /MAIN_MERGE_PREVIEW_CONFLICTED/u);
  });

  await t.test("a stored approval carrying a truncated preview is refused on the read path", async (child) => {
    const fixture = await ready(child);
    const approval = await raise(fixture);
    // A conflict list cannot be truncated while the merge is also clean, so that flag is caught one
    // layer earlier, by the contradiction check every stored preview goes through. Both refuse.
    for (const [flag, refusal] of [
      ["filesTruncated", /MAIN_MERGE_APPROVAL_ROW_TAMPERED/u],
      ["submodulesTruncated", /MAIN_MERGE_APPROVAL_ROW_TAMPERED/u],
      ["mergeConflictsTruncated", /CANDIDATE_COMPLETION_PREVIEW_INVALID/u],
    ] as const) {
      rewriteApprovalPreview(fixture.path, approval.id, {
        filesTruncated: false, submodulesTruncated: false, mergeConflictsTruncated: false, [flag]: true,
      });
      await assert.rejects(
        fixture.registry.inspectMergeApproval({
          approvalId: approval.id, roomId: "demo", mainPath: fixture.source,
        }),
        refusal,
      );
      await assert.rejects(grant(fixture, approval), refusal);
      await assert.rejects(
        fixture.registry.promoteMainMerge({
          approvalId: approval.id, token: "A".repeat(43), action: MERGE_APPROVAL_GRANT,
          taskId: fixture.task.taskId, roomId: "demo", mainPath: fixture.source,
        }),
        refusal,
      );
    }
  });
});

/**
 * A candidate can only be completed once, so a fixture that rewrites the candidate tree afterwards
 * needs its own task. This builds one against the tree that is already on disk.
 */
async function freshCompletion(t: TestContext, fixture: Ready): Promise<{
  preview: Awaited<ReturnType<CandidateRegistry["previewMainMerge"]>>;
  request: () => Promise<MergeApproval>;
}> {
  const registry = fixture.registry;
  const candidateHead = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: fixture.task.candidatePath }))
    .stdout.trim();
  const second = await registry.start({
    actor: "codex1", clientRequestId: key(), roomId: "demo", mainPath: fixture.source,
    task: "second candidate over the rewritten tree",
  });
  await execFileAsync("git", ["fetch", fixture.task.candidatePath, candidateHead], { cwd: second.candidatePath });
  await execFileAsync("git", ["reset", "--hard", candidateHead], { cwd: second.candidatePath });
  await registry.complete({
    actor: "codex1", clientRequestId: key(), taskId: second.taskId, roomId: "demo",
    mainPath: fixture.source, summary: "rewritten tree",
  });
  t.after(() => undefined);
  const preview = await registry.previewMainMerge({
    taskId: second.taskId, roomId: "demo", mainPath: fixture.source,
  });
  return {
    preview,
    request: async () => await registry.requestMainMerge({
      actor: "codex1", clientRequestId: key(), taskId: second.taskId, roomId: "demo",
      mainPath: fixture.source, completionId: preview.completionId, previewDigest: preview.previewDigest,
    }),
  };
}

test("a conflicted preview is never approvable", async (t) => {
  const fixture = await ready(t);
  // Both sides claim the same path with different content.
  await commit(fixture.source, "contested.txt", "main content\n", "main claims the path");
  await commit(fixture.task.candidatePath, "contested.txt", "candidate content\n", "candidate claims the path");
  const second = await freshCompletion(t, fixture);
  assert.equal(second.preview.preview.mergeable, false);
  assert.deepEqual(second.preview.blockers, ["MERGE_CONFLICTS_PRESENT"]);
  assert.match(second.preview.prompt, /目前不可核准/u);
  await assert.rejects(second.request(), /MAIN_MERGE_PREVIEW_CONFLICTED/u);
});

test("rejecting a merge approval retains everything and leaves the owner able to be asked again", async (t) => {
  const fixture = await ready(t);
  const approval = await raise(fixture);
  const before = await untouched(fixture);
  const rejected = await fixture.registry.rejectMainMerge({
    approvalId: approval.id, roomId: "demo", mainPath: fixture.source, decidedBy: "local-web",
    reason: "wants the tests re-run first",
  });
  assert.equal(rejected.state, "rejected");
  assert.equal(rejected.refusal?.code, "OWNER_REJECTED");
  assert.equal(rejected.refusal?.reason, "wants the tests re-run first");
  // Bar item 3, byte for byte.
  assert.deepEqual(await untouched(fixture), before);
  const again = await raise(fixture);
  assert.equal(again.state, "requested");
  assert.notEqual(again.id, approval.id);
});

test("an owner can withdraw an approval they already granted", async (t) => {
  const fixture = await ready(t);
  const approval = await raise(fixture);
  const { approvalToken } = await grant(fixture, approval);
  await fixture.registry.rejectMainMerge({
    approvalId: approval.id, roomId: "demo", mainPath: fixture.source, decidedBy: "local-tui",
  });
  await assert.rejects(
    fixture.registry.promoteMainMerge({
      approvalId: approval.id, token: approvalToken, action: MERGE_APPROVAL_GRANT,
      taskId: fixture.task.taskId, roomId: "demo", mainPath: fixture.source,
    }),
    /MAIN_MERGE_APPROVAL_NOT_APPROVED/u,
  );
});

test("a merge approval authorizes the merge and nothing else", async (t) => {
  const fixture = await ready(t);
  const approval = await raise(fixture);
  assert.equal(approval.grants, MERGE_APPROVAL_GRANT);
  assert.ok(approval.notAuthorized.includes("push"));
  assert.ok(approval.notAuthorized.includes("publish"));
  assert.ok(approval.notAuthorized.includes("deploy"));
  assert.ok(approval.notAuthorized.includes("delete-recovery-ref"));
  assert.equal(approval.mainMutation, false);
  const { approvalToken } = await grant(fixture, approval);
  for (const action of ["push", "publish", "deploy", "cleanup-worktree", "delete-candidate", ""]) {
    await assert.rejects(
      fixture.registry.promoteMainMerge({
        approvalId: approval.id, token: approvalToken, action,
        taskId: fixture.task.taskId, roomId: "demo", mainPath: fixture.source,
      }),
      /MAIN_MERGE_APPROVAL_ACTION_NOT_GRANTED/u,
    );
  }
  const before = await untouched(fixture);
  const { authorization, promotion, mainMutated } = await fixture.registry.promoteMainMerge({
    approvalId: approval.id, token: approvalToken, action: MERGE_APPROVAL_GRANT,
    taskId: fixture.task.taskId, roomId: "demo", mainPath: fixture.source,
  });
  assert.equal(authorization.grants, MERGE_APPROVAL_GRANT);
  assert.equal(authorization.binding.candidateHead, approval.binding.candidateHead);
  assert.equal(authorization.binding.mainHead, approval.binding.mainHead);
  assert.equal(authorization.preview.mergeable, true);
  // The one thing it IS authorized to do actually happened, and is reported from observation.
  assert.equal(mainMutated, true);
  assert.equal(promotion.state, "applied");
  assert.equal(promotion.observation.authorizedMergeCommit, true);
  const after = await untouched(fixture);
  // The authorized merge moved main's head and nothing else: the candidate, its checkpoints and
  // every ref under refs/ are byte-identical, and the candidate's own head never moved.
  assert.notEqual(after.mainHead, before.mainHead);
  assert.equal(after.candidateHead, before.candidateHead);
  assert.deepEqual(after.checkpoints, before.checkpoints);
  assert.equal(after.mainStatus, before.mainStatus);
  assert.equal(promotion.mainHeadAfter, String(after.mainHead).trim());
});

test("requesting a merge approval is not approving it", async (t) => {
  const fixture = await ready(t);
  const before = await untouched(fixture);
  const approval = await raise(fixture);
  assert.equal(approval.state, "requested");
  assert.equal(JSON.stringify(approval).includes("token"), false);
  // Nothing in the request path writes a ref, a worktree or a candidate row.
  assert.deepEqual(await untouched(fixture), before);
  await assert.rejects(
    fixture.registry.promoteMainMerge({
      approvalId: approval.id, token: "A".repeat(43), action: MERGE_APPROVAL_GRANT,
      taskId: fixture.task.taskId, roomId: "demo", mainPath: fixture.source,
    }),
    /MAIN_MERGE_APPROVAL_NOT_APPROVED/u,
  );
  const inspected = await fixture.registry.inspectMergeApproval({
    approvalId: approval.id, roomId: "demo", mainPath: fixture.source,
  });
  assert.equal(inspected.binding.valid, true);
  assert.equal(inspected.approval.state, "requested");
});

test("granting refuses a wrong phrase or a preview the surface did not display", async (t) => {
  const fixture = await ready(t);
  const approval = await raise(fixture);
  for (const confirmation of ["merge into main", "MERGE INTO MAIN ", "APPROVE MERGE", ""]) {
    await assert.rejects(
      fixture.registry.grantMainMerge({
        approvalId: approval.id, roomId: "demo", mainPath: fixture.source,
        previewDigest: approval.binding.previewDigest, confirmation, decidedBy: "local-web",
      }),
      /MAIN_MERGE_CONFIRMATION_MISMATCH/u,
    );
  }
  await assert.rejects(
    fixture.registry.grantMainMerge({
      approvalId: approval.id, roomId: "demo", mainPath: fixture.source,
      previewDigest: "0".repeat(64), confirmation: MERGE_APPROVAL_CONFIRMATION, decidedBy: "local-web",
    }),
    /MAIN_MERGE_PREVIEW_DIGEST_MISMATCH/u,
  );
  await assert.rejects(
    fixture.registry.grantMainMerge({
      approvalId: approval.id, roomId: "demo", mainPath: fixture.source,
      previewDigest: approval.binding.previewDigest, confirmation: MERGE_APPROVAL_CONFIRMATION,
      decidedBy: "remote" as "local-web",
    }),
    /MAIN_MERGE_APPROVAL_ACTOR_INVALID/u,
  );
  // None of it moved the approval.
  assert.equal(approvalState(fixture.path, approval.id), "requested");
});

test("a granted approval refuses a token that is not the one it issued", async (t) => {
  const fixture = await ready(t);
  const approval = await raise(fixture);
  const { approvalToken } = await grant(fixture, approval);
  const call = {
    approvalId: approval.id, action: MERGE_APPROVAL_GRANT,
    taskId: fixture.task.taskId, roomId: "demo", mainPath: fixture.source,
  };
  for (const token of ["", "short", `${approvalToken.slice(0, 42)}!`, "B".repeat(43)]) {
    await assert.rejects(
      fixture.registry.promoteMainMerge({ ...call, token }),
      /MAIN_MERGE_APPROVAL_TOKEN_INVALID/u,
    );
  }
  assert.equal(approvalState(fixture.path, approval.id), "approved");
});

test("a merge request is idempotent per client request id and never opens two questions at once", async (t) => {
  const fixture = await ready(t);
  const preview = await fixture.registry.previewMainMerge({
    taskId: fixture.task.taskId, roomId: "demo", mainPath: fixture.source,
  });
  const clientRequestId = key();
  const input = {
    actor: "codex1", clientRequestId, taskId: fixture.task.taskId, roomId: "demo",
    mainPath: fixture.source, completionId: preview.completionId, previewDigest: preview.previewDigest,
  };
  const first = await fixture.registry.requestMainMerge(input);
  assert.deepEqual(await fixture.registry.requestMainMerge(input), first);
  await assert.rejects(
    fixture.registry.requestMainMerge({ ...input, previewDigest: "0".repeat(64) }),
    /MAIN_MERGE_REQUEST_IDEMPOTENCY_CONFLICT/u,
  );
  await assert.rejects(
    fixture.registry.requestMainMerge({ ...input, clientRequestId: key() }),
    /MAIN_MERGE_APPROVAL_ALREADY_PENDING/u,
  );
  await assert.rejects(
    fixture.registry.requestMainMerge({ ...input, clientRequestId: "not-a-uuid" }),
    /MAIN_MERGE_CLIENT_REQUEST_ID_INVALID/u,
  );
  assert.equal(fixture.registry.inventory().mergeApprovals, 1);
  assert.equal(fixture.registry.inventory().mergeApprovalsOpen, 1);
  const concurrent = await Promise.allSettled([
    fixture.registry.requestMainMerge({ ...input, clientRequestId: key() }),
    fixture.registry.requestMainMerge({ ...input, clientRequestId: key() }),
  ]);
  assert.equal(concurrent.filter((outcome) => outcome.status === "fulfilled").length, 0);
  assert.equal(tableRows(fixture.path, "candidate_merge_approvals").length, 1);
});

test("a merge request is refused for anything that is not a completed, recoverable candidate", async (t) => {
  await t.test("an unknown or foreign task", async (child) => {
    const fixture = await ready(child);
    for (const scope of [
      { taskId: randomUUID(), roomId: "demo", mainPath: fixture.source },
      { taskId: fixture.task.taskId, roomId: "other", mainPath: fixture.source },
      { taskId: "not-a-uuid", roomId: "demo", mainPath: fixture.source },
    ]) {
      await assert.rejects(fixture.registry.previewMainMerge(scope), /MAIN_MERGE_TASK_NOT_FOUND/u);
    }
  });

  await t.test("a candidate that has not completed", async (child) => {
    const fixture = await ready(child);
    const active = await fixture.registry.start({
      actor: "codex1", clientRequestId: key(), roomId: "demo", mainPath: fixture.source, task: "still working",
    });
    await assert.rejects(
      fixture.registry.previewMainMerge({ taskId: active.taskId, roomId: "demo", mainPath: fixture.source }),
      /MAIN_MERGE_CANDIDATE_NOT_COMPLETED/u,
    );
  });

  await t.test("a candidate that moved past its own completion", async (child) => {
    const fixture = await ready(child);
    await commit(fixture.task.candidatePath, "later.txt", "after completion\n", "later work");
    await assert.rejects(
      fixture.registry.previewMainMerge({ taskId: fixture.task.taskId, roomId: "demo", mainPath: fixture.source }),
      /MAIN_MERGE_CANDIDATE_HEAD_CHANGED/u,
    );
  });

  await t.test("a candidate with uncommitted work", async (child) => {
    const fixture = await ready(child);
    await writeFile(join(fixture.task.candidatePath, "scratch.txt"), "uncommitted\n", "utf8");
    await assert.rejects(
      fixture.registry.previewMainMerge({ taskId: fixture.task.taskId, roomId: "demo", mainPath: fixture.source }),
      /MAIN_MERGE_CANDIDATE_WORKTREE_DIRTY/u,
    );
  });

  await t.test("a completion whose recovery point is gone", async (child) => {
    const fixture = await ready(child);
    await execFileAsync(
      "git", ["update-ref", "-d", fixture.completion.preview.recovery.ref], { cwd: fixture.source },
    );
    await assert.rejects(
      fixture.registry.previewMainMerge({ taskId: fixture.task.taskId, roomId: "demo", mainPath: fixture.source }),
      /MAIN_MERGE_RECOVERY_POINT_MISSING/u,
    );
  });

  await t.test("a completion id that names something else", async (child) => {
    const fixture = await ready(child);
    const preview = await fixture.registry.previewMainMerge({
      taskId: fixture.task.taskId, roomId: "demo", mainPath: fixture.source,
    });
    for (const completionId of [randomUUID(), "not-a-uuid"]) {
      await assert.rejects(
        fixture.registry.requestMainMerge({
          actor: "codex1", clientRequestId: key(), taskId: fixture.task.taskId, roomId: "demo",
          mainPath: fixture.source, completionId, previewDigest: preview.previewDigest,
        }),
        /MAIN_MERGE_COMPLETION_MISMATCH/u,
      );
    }
  });

  await t.test("a preview digest that no longer reproduces", async (child) => {
    const fixture = await ready(child);
    const preview = await fixture.registry.previewMainMerge({
      taskId: fixture.task.taskId, roomId: "demo", mainPath: fixture.source,
    });
    await commit(fixture.source, "main-side.txt", "main moved\n", "main moves");
    await assert.rejects(
      fixture.registry.requestMainMerge({
        actor: "codex1", clientRequestId: key(), taskId: fixture.task.taskId, roomId: "demo",
        mainPath: fixture.source, completionId: preview.completionId, previewDigest: preview.previewDigest,
      }),
      /MAIN_MERGE_PREVIEW_DIGEST_STALE/u,
    );
    for (const previewDigest of ["", "not-a-digest"]) {
      await assert.rejects(
        fixture.registry.requestMainMerge({
          actor: "codex1", clientRequestId: key(), taskId: fixture.task.taskId, roomId: "demo",
          mainPath: fixture.source, completionId: preview.completionId, previewDigest,
        }),
        /MAIN_MERGE_PREVIEW_DIGEST_STALE/u,
      );
    }
    assert.equal(tableRows(fixture.path, "candidate_merge_approvals").length, 0);
  });
});

test("merge approvals are scoped to the exact Room and project that raised them", async (t) => {
  const fixture = await ready(t);
  const approval = await raise(fixture);
  for (const scope of [
    { roomId: "other", mainPath: fixture.source },
    { roomId: "demo", mainPath: fixture.task.candidatePath },
  ]) {
    await assert.rejects(
      fixture.registry.inspectMergeApproval({ approvalId: approval.id, ...scope }),
      /MAIN_MERGE_APPROVAL_NOT_FOUND/u,
    );
  }
  await assert.rejects(
    fixture.registry.inspectMergeApproval({ approvalId: "not-a-uuid", roomId: "demo", mainPath: fixture.source }),
    /MAIN_MERGE_APPROVAL_ID_INVALID/u,
  );
  await assert.rejects(
    fixture.registry.inspectMergeApproval({ approvalId: randomUUID(), roomId: "demo", mainPath: fixture.source }),
    /MAIN_MERGE_APPROVAL_NOT_FOUND/u,
  );
  const listed = await fixture.registry.mergeApprovals({ roomId: "demo", mainPath: fixture.source });
  assert.deepEqual(listed.map((entry) => entry.id), [approval.id]);
  assert.deepEqual(
    (await fixture.registry.mergeApprovals({
      roomId: "demo", mainPath: fixture.source, taskId: fixture.task.taskId,
    })).map((entry) => entry.id),
    [approval.id],
  );
  assert.deepEqual(await fixture.registry.mergeApprovals({ roomId: "other", mainPath: fixture.source }), []);
  await assert.rejects(
    fixture.registry.mergeApprovals({ roomId: "demo", mainPath: fixture.source, taskId: "not-a-uuid" }),
    /CANDIDATE_TASK_ID_INVALID/u,
  );
  await assert.rejects(
    fixture.registry.mergeApprovals({ roomId: "NOT VALID", mainPath: fixture.source }),
    /CANDIDATE_ROOM_INVALID/u,
  );
});

test("candidate_status carries the owner decision without carrying the preview or the secret", async (t) => {
  const fixture = await ready(t);
  const approval = await raise(fixture);
  const requested = await fixture.registry.status({ roomId: "demo", mainPath: fixture.source });
  assert.deepEqual(requested[0]?.mergeApprovals.map((entry) => entry.state), ["requested"]);
  assert.equal(readable(requested[0]?.mergeApprovals[0]).previewDigest, approval.binding.previewDigest);
  assert.equal("preview" in (requested[0]?.mergeApprovals[0] ?? {}), false);
  assert.equal(JSON.stringify(requested).includes("token"), false);
  await grant(fixture, approval);
  const granted = await fixture.registry.status({ roomId: "demo", mainPath: fixture.source });
  assert.deepEqual(granted[0]?.mergeApprovals.map((entry) => entry.state), ["approved"]);
  assert.equal(readable(granted[0]?.mergeApprovals[0]).expired, false);
  fixture.clock.now += MERGE_APPROVAL_GRANT_TTL_MS + 1;
  const lapsed = await fixture.registry.status({ roomId: "demo", mainPath: fixture.source });
  // The row has not been written yet, but the listing must not present a lapsed approval as live.
  assert.equal(readable(lapsed[0]?.mergeApprovals[0]).expired, true);
});

test("a tampered merge approval row is refused instead of being shown as an owner decision", async (t) => {
  const fixture = await ready(t);
  const approval = await raise(fixture);
  const db = new DatabaseSync(fixture.path);
  // A head swapped without re-stamping the row hash: the crudest tamper, and the one a row hash is for.
  db.prepare("UPDATE candidate_merge_approvals SET main_head=? WHERE id=?")
    .run("f".repeat(40), approval.id);
  db.close();
  await assert.rejects(
    fixture.registry.mergeApprovals({ roomId: "demo", mainPath: fixture.source }),
    /MAIN_MERGE_APPROVAL_ROW_TAMPERED/u,
  );
  await assert.rejects(grant(fixture, approval), /MAIN_MERGE_APPROVAL_ROW_TAMPERED/u);
  await assert.rejects(
    fixture.registry.promoteMainMerge({
      approvalId: approval.id, token: "A".repeat(43), action: MERGE_APPROVAL_GRANT,
      taskId: fixture.task.taskId, roomId: "demo", mainPath: fixture.source,
    }),
    /MAIN_MERGE_APPROVAL_ROW_TAMPERED/u,
  );
});

test("a scalar edited to disagree with the stored preview is refused even when re-hashed", async (t) => {
  const fixture = await ready(t);
  const approval = await raise(fixture);
  const db = new DatabaseSync(fixture.path);
  let row = db.prepare("SELECT * FROM candidate_merge_approvals WHERE id=?")
    .get(approval.id) as Record<string, unknown>;
  row = { ...row, main_head: "f".repeat(40) };
  // Consistent row hash, inconsistent with the preview it claims to bind. The redundancy is the check.
  db.prepare("UPDATE candidate_merge_approvals SET main_head=?,row_hash=? WHERE id=?")
    .run("f".repeat(40), mergeApprovalRowHash(row), approval.id);
  db.close();
  await assert.rejects(
    fixture.registry.mergeApprovals({ roomId: "demo", mainPath: fixture.source }),
    /MAIN_MERGE_APPROVAL_ROW_TAMPERED/u,
  );
});

test("a closed registry names itself instead of leaking a storage failure", async (t) => {
  const fixture = await ready(t);
  const approval = await raise(fixture);
  fixture.registry.close();
  await assert.rejects(
    fixture.registry.previewMainMerge({ taskId: fixture.task.taskId, roomId: "demo", mainPath: fixture.source }),
    /CANDIDATE_REGISTRY_CLOSED/u,
  );
  await assert.rejects(grant(fixture, approval), /CANDIDATE_REGISTRY_CLOSED/u);
  await assert.rejects(
    fixture.registry.rejectMainMerge({
      approvalId: approval.id, roomId: "demo", mainPath: fixture.source, decidedBy: "local-web",
    }),
    /CANDIDATE_REGISTRY_CLOSED/u,
  );
  await assert.rejects(
    fixture.registry.promoteMainMerge({
      approvalId: approval.id, token: "A".repeat(43), action: MERGE_APPROVAL_GRANT,
      taskId: fixture.task.taskId, roomId: "demo", mainPath: fixture.source,
    }),
    /CANDIDATE_REGISTRY_CLOSED/u,
  );
  await assert.rejects(
    fixture.registry.mergeApprovals({ roomId: "demo", mainPath: fixture.source }),
    /CANDIDATE_REGISTRY_CLOSED/u,
  );
  await assert.rejects(
    fixture.registry.inspectMergeApproval({ approvalId: approval.id, roomId: "demo", mainPath: fixture.source }),
    /CANDIDATE_REGISTRY_CLOSED/u,
  );
});

test("an approval survives a reopen and stays bound to the same snapshot", async (t) => {
  const fixture = await ready(t);
  const approval = await raise(fixture);
  fixture.registry.close();
  const reopened = new CandidateRegistry(fixture.data, { now: () => fixture.clock.now });
  t.after(() => reopened.close());
  const listed = await reopened.mergeApprovals({ roomId: "demo", mainPath: fixture.source });
  // The listing is an observation path, so it also reports the live binding check the request path
  // had no reason to run. Everything the approval itself binds must be identical across the reopen.
  assert.deepEqual(listed[0]?.bindingCheck, { checked: true, valid: true, changed: [] });
  const { bindingCheck: _observed, ...persisted } = listed[0] ?? {};
  assert.deepEqual(persisted, approval);
  const granted = await reopened.grantMainMerge({
    approvalId: approval.id, roomId: "demo", mainPath: fixture.source,
    previewDigest: approval.binding.previewDigest,
    confirmation: MERGE_APPROVAL_CONFIRMATION, decidedBy: "local-tui",
  });
  assert.equal(granted.approval.decidedBy, "local-tui");
  assert.match(granted.approvalToken, /^[A-Za-z0-9_-]{43}$/u);
  const { authorization } = await reopened.promoteMainMerge({
    approvalId: approval.id, token: granted.approvalToken, action: MERGE_APPROVAL_GRANT,
    taskId: fixture.task.taskId, roomId: "demo", mainPath: fixture.source,
  });
  assert.equal(authorization.binding.previewDigest, approval.binding.previewDigest);
});
