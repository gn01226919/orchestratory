import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createAppContext } from "../src/app.ts";
import { startWebServer } from "../src/ui/web.ts";
import { CollaborationService } from "../src/core/collaboration-service.ts";
import { MERGE_APPROVAL_CONFIRMATION } from "../src/core/candidate-registry.ts";

const execFileAsync = promisify(execFile);
const author = ["-c", "user.name=Merge Web Test", "-c", "user.email=test@example.invalid"];

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "orchestratory-merge-web-workspace-"));
  await execFileAsync("git", ["init", "-b", "main"], { cwd: root });
  await writeFile(join(root, "README.md"), "synthetic\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd: root });
  await execFileAsync("git", [...author, "commit", "-m", "initial"], { cwd: root });
  return await realpath(root);
}

/**
 * The dialog's whole HTTP contract, exercised end to end against the real server: list, inspect,
 * approve-and-promote with the exact phrase, durable history, and reject. Negative cases first,
 * because the only thing worse than a dialog that cannot approve is one that approves something
 * the owner did not see or says "approved" without actually merging it.
 */
test("the merge approval dialog contract lists, inspects, approves once, and refuses everything else", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "orchestratory-merge-web-data-"));
  const workspace = await repository();
  t.after(async () => await rm(data, { recursive: true, force: true }));
  t.after(async () => await rm(workspace, { recursive: true, force: true }));
  await writeFile(
    join(data, "workspace-roots.json"),
    `${JSON.stringify([{ id: "merge-root", label: "Merge root", path: workspace }])}\n`,
    { encoding: "utf8", mode: 0o600 },
  );

  const setup = new CollaborationService(data);
  setup.ledger.createRoom("demo", workspace);
  const task = await setup.candidates.start({
    actor: "codex1", clientRequestId: randomUUID(), roomId: "demo", mainPath: workspace,
    task: "web merge approval contract",
  });
  await writeFile(join(task.candidatePath, "candidate.txt"), "candidate\n", "utf8");
  await execFileAsync("git", ["add", "candidate.txt"], { cwd: task.candidatePath });
  await execFileAsync("git", [...author, "commit", "-m", "candidate work"], { cwd: task.candidatePath });
  await setup.candidates.complete({
    actor: "codex1", clientRequestId: randomUUID(), taskId: task.taskId, roomId: "demo",
    mainPath: workspace, summary: "ready for the owner",
  });
  const preview = await setup.candidates.previewMainMerge({
    taskId: task.taskId, roomId: "demo", mainPath: workspace,
  });
  const approval = await setup.candidates.requestMainMerge({
    actor: "codex1", clientRequestId: randomUUID(), taskId: task.taskId, roomId: "demo",
    mainPath: workspace, completionId: preview.completionId, previewDigest: preview.previewDigest,
  });
  setup.close();

  const app = await createAppContext(data);
  t.after(() => app.close());
  const server = await startWebServer(app, 0);
  t.after(async () => await server.close());
  const index = await fetch(server.url);
  const cookie = (index.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const bootstrap = await (await fetch(`${server.url}/api/bootstrap`, { headers: { Cookie: cookie } })).json() as
    { csrf: string };
  const get = async (path: string): Promise<{ status: number; body: Record<string, unknown> }> => {
    const response = await fetch(`${server.url}${path}`, { headers: { Cookie: cookie } });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  const post = async (path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
    const response = await fetch(`${server.url}${path}`, {
      method: "POST",
      headers: {
        Cookie: cookie, Origin: server.url,
        "Content-Type": "application/json", "x-csrf-token": bootstrap.csrf,
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };

  const candidates = await get(`/api/rooms/candidates?room=demo&taskId=${task.taskId}`);
  assert.equal(candidates.status, 200);
  const listedTasks = candidates.body.candidates as Array<{
    taskId: string; status: string; mergeApprovals: Array<{ id: string; state: string }>;
  }>;
  assert.equal(listedTasks[0]?.taskId, task.taskId);
  assert.equal(listedTasks[0]?.status, "completed");
  assert.deepEqual(listedTasks[0]?.mergeApprovals.map((entry) => entry.state), ["requested"]);
  assert.equal((await get("/api/rooms/candidates?room=demo&taskId=nope")).status, 400);
  assert.equal((await get("/api/rooms/candidates?room=missing")).status, 400);

  const approvals = await get("/api/rooms/merge-approvals?room=demo");
  assert.equal(approvals.status, 200);
  assert.equal(approvals.body.confirmationPhrase, MERGE_APPROVAL_CONFIRMATION);
  assert.equal(approvals.body.grants, "merge-candidate-into-main");
  assert.ok((approvals.body.notAuthorized as string[]).includes("push"));
  const listed = approvals.body.approvals as Array<{
    id: string; state: string; binding: { previewDigest: string }; preview: { mergeable: boolean };
  }>;
  assert.equal(listed[0]?.id, approval.id);
  assert.equal(listed[0]?.state, "requested");
  // The dialog needs the whole preview to render its scroll gate over the diff and the conflicts.
  assert.equal(listed[0]?.preview.mergeable, true);
  assert.equal(JSON.stringify(listed).includes("approvalToken"), false);
  assert.equal(
    (await get(`/api/rooms/merge-approvals?room=demo&taskId=${task.taskId}`)).status, 200,
  );
  assert.equal((await get("/api/rooms/merge-approvals?room=demo&taskId=nope")).status, 400);
  assert.equal((await get("/api/rooms/merge-approvals?room=missing")).status, 400);

  const inspected = await get(`/api/rooms/merge-approvals/inspect?room=demo&approvalId=${approval.id}`);
  assert.equal(inspected.status, 200);
  assert.deepEqual(inspected.body.binding, { checked: true, valid: true, changed: [] });
  assert.equal(inspected.body.confirmationPhrase, MERGE_APPROVAL_CONFIRMATION);
  assert.equal((await get("/api/rooms/merge-approvals/inspect?room=demo&approvalId=nope")).status, 400);
  assert.equal((await get("/api/rooms/merge-approvals/inspect?room=missing&approvalId=x")).status, 400);

  for (const body of [
    "not-an-object",
    { room: "demo", approvalId: approval.id, previewDigest: approval.binding.previewDigest },
    {
      room: "demo", approvalId: approval.id, previewDigest: approval.binding.previewDigest,
      confirmation: MERGE_APPROVAL_CONFIRMATION, extra: true,
    },
    {
      room: "demo", approvalId: approval.id, previewDigest: approval.binding.previewDigest,
      confirmation: MERGE_APPROVAL_CONFIRMATION, approvalToken: "captured-legacy-token",
    },
  ]) {
    const refused = await post("/api/rooms/merge-approvals/approve", body);
    assert.equal(refused.status, 400);
    assert.equal(refused.body.error, "INVALID_MERGE_APPROVAL_REQUEST");
  }
  const wrongPhrase = await post("/api/rooms/merge-approvals/approve", {
    room: "demo", approvalId: approval.id, previewDigest: approval.binding.previewDigest,
    confirmation: "yes please",
  });
  assert.equal(wrongPhrase.status, 400);
  assert.equal(wrongPhrase.body.error, "MAIN_MERGE_CONFIRMATION_MISMATCH");
  const wrongDigest = await post("/api/rooms/merge-approvals/approve", {
    room: "demo", approvalId: approval.id, previewDigest: "0".repeat(64),
    confirmation: MERGE_APPROVAL_CONFIRMATION,
  });
  assert.equal(wrongDigest.body.error, "MAIN_MERGE_PREVIEW_DIGEST_MISMATCH");

  const promoted = await post("/api/rooms/merge-approvals/approve", {
    room: "demo", approvalId: approval.id, previewDigest: approval.binding.previewDigest,
    confirmation: MERGE_APPROVAL_CONFIRMATION,
  });
  assert.equal(promoted.status, 200);
  assert.equal(JSON.stringify(promoted.body).includes("approvalToken"), false);
  assert.equal((promoted.body.approval as { state: string }).state, "consumed");
  assert.equal((promoted.body.promotion as { state: string }).state, "applied");
  assert.equal(promoted.body.mainMutated, true);
  const mainAfter = String((promoted.body.promotion as { mainHeadAfter: string }).mainHeadAfter);
  assert.equal((await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: workspace })).stdout.trim(), mainAfter);
  assert.equal(
    (await execFileAsync("git", ["show", `${mainAfter}:candidate.txt`], { cwd: workspace })).stdout,
    "candidate\n",
  );

  const history = await get("/api/rooms/merge-history?room=demo");
  assert.equal(history.status, 200);
  assert.equal(history.body.chainValid, true);
  assert.deepEqual(history.body.unpromotedApprovals, []);
  const entries = history.body.promotions as Array<{
    id: string; approvalId: string; taskId: string; state: string; mainHeadBefore: string;
    mainHeadAfter: string; recoveryRef: string; observation: { code: string; hooksExecuted?: unknown[] };
  }>;
  assert.equal(entries[0]?.approvalId, approval.id);
  assert.equal(entries[0]?.taskId, task.taskId);
  assert.equal(entries[0]?.state, "applied");
  assert.equal(entries[0]?.mainHeadAfter, mainAfter);
  assert.match(entries[0]?.recoveryRef ?? "", /^refs\/orchestratory\/checkpoints\//u);
  assert.equal(JSON.stringify(history.body).includes("approvalToken"), false);
  assert.equal((await get(`/api/rooms/merge-history?room=demo&taskId=${task.taskId}`)).status, 200);
  assert.equal((await get("/api/rooms/merge-history?room=demo&taskId=nope")).status, 400);
  assert.equal((await get("/api/rooms/merge-history?room=missing")).status, 400);

  // A lost HTTP response is safe to retry: the durable promotion is returned, never applied twice.
  const replayed = await post("/api/rooms/merge-approvals/approve", {
    room: "demo", approvalId: approval.id, previewDigest: approval.binding.previewDigest,
    confirmation: MERGE_APPROVAL_CONFIRMATION,
  });
  assert.equal(replayed.status, 200);
  assert.equal((replayed.body.promotion as { id: string }).id, entries[0]?.id);
  assert.equal((replayed.body.promotion as { state: string }).state, "applied");
  assert.equal((await get("/api/rooms/merge-history?room=demo")).body.promotions instanceof Array, true);
  const mergedTasks = (await get(`/api/rooms/candidates?room=demo&taskId=${task.taskId}`))
    .body.candidates as Array<{ status: string }>;
  assert.equal(mergedTasks[0]?.status, "merged");

  // The list is not browser-memory history: another registry instance rebuilds it from SQLite and
  // re-observes main, which is the path used after a daemon restart.
  const restarted = new CollaborationService(data);
  const restartedHistory = await restarted.candidates.promotions({ roomId: "demo", mainPath: workspace });
  assert.equal(restartedHistory[0]?.id, entries[0]?.id);
  assert.equal(restartedHistory[0]?.state, "applied");
  restarted.close();

  for (const body of [
    "not-an-object",
    { room: "demo" },
    { room: "demo", approvalId: approval.id, reason: 5 },
    { room: "demo", approvalId: approval.id, extra: true },
  ]) {
    assert.equal((await post("/api/rooms/merge-approvals/reject", body)).body.error, "INVALID_MERGE_APPROVAL_REQUEST");
  }
  const rejected = await post("/api/rooms/merge-approvals/reject", {
    room: "demo", approvalId: approval.id, reason: "owner changed their mind",
  });
  assert.equal(rejected.body.error, "MAIN_MERGE_APPROVAL_NOT_PENDING");
  // The response describes this action, not the state of the repository: rejection runs no Git
  // command, so it is in no position to assert that anything is still there (PITFALLS #86).
  // A consumed approval cannot be withdrawn and retrying either action cannot rewrite main.
  assert.equal((await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: workspace })).stdout.trim(), mainAfter);
  assert.equal((await execFileAsync("git", ["status", "--porcelain=v1"], { cwd: workspace })).stdout, "");
  assert.equal(
    (await execFileAsync(
      "git", ["rev-parse", "--verify", `${approval.binding.recoveryRef}^{commit}`], { cwd: workspace },
    )).stdout.trim(),
    approval.binding.candidateHead,
  );
  const afterReject = await get(`/api/rooms/merge-approvals/inspect?room=demo&approvalId=${approval.id}`);
  // Terminal: nothing is compared, so the check reports that it did not run rather than
  // reporting a clean binding it never looked at.
  assert.deepEqual(afterReject.body.binding, { checked: false, valid: false, changed: [] });
  assert.equal((await post("/api/rooms/merge-approvals/reject", {
    room: "demo", approvalId: approval.id,
  })).body.error, "MAIN_MERGE_APPROVAL_NOT_PENDING");
});

test("a grant that fails before durable promotion intent is retired and never shown as merge success", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "orchestratory-merge-web-preintent-"));
  const workspace = await repository();
  t.after(async () => await rm(data, { recursive: true, force: true }));
  t.after(async () => await rm(workspace, { recursive: true, force: true }));
  const service = new CollaborationService(data);
  t.after(() => service.close());
  service.ledger.createRoom("demo", workspace);
  const task = await service.candidates.start({
    actor: "codex1", clientRequestId: randomUUID(), roomId: "demo", mainPath: workspace,
    task: "pre-intent failure",
  });
  await writeFile(join(task.candidatePath, "candidate.txt"), "candidate\n", "utf8");
  await execFileAsync("git", ["add", "candidate.txt"], { cwd: task.candidatePath });
  await execFileAsync("git", [...author, "commit", "-m", "candidate work"], { cwd: task.candidatePath });
  await service.candidates.complete({
    actor: "codex1", clientRequestId: randomUUID(), taskId: task.taskId, roomId: "demo",
    mainPath: workspace, summary: "ready",
  });
  const preview = await service.candidates.previewMainMerge({
    taskId: task.taskId, roomId: "demo", mainPath: workspace,
  });
  const approval = await service.candidates.requestMainMerge({
    actor: "codex1", clientRequestId: randomUUID(), taskId: task.taskId, roomId: "demo",
    mainPath: workspace, completionId: preview.completionId, previewDigest: preview.previewDigest,
  });
  const before = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: workspace })).stdout.trim();
  Object.defineProperty(service.candidates, "promoteMainMerge", {
    configurable: true,
    value: async () => { throw new Error("SYNTHETIC_PRE_INTENT_FAILURE"); },
  });
  await assert.rejects(service.approveAndPromoteMainMerge({
    roomId: "demo", workspace, approvalId: approval.id,
    previewDigest: approval.previewDigest, confirmation: MERGE_APPROVAL_CONFIRMATION,
    decidedBy: "local-web",
  }), /SYNTHETIC_PRE_INTENT_FAILURE/u);
  const inspected = await service.candidates.inspectMergeApproval({
    approvalId: approval.id, roomId: "demo", mainPath: workspace,
  });
  assert.equal(inspected.approval.state, "rejected");
  assert.equal(inspected.approval.refusal?.reason, "PROMOTION_NOT_STARTED_AFTER_GRANT");
  assert.deepEqual(await service.candidates.promotions({ roomId: "demo", mainPath: workspace }), []);
  assert.equal((await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: workspace })).stdout.trim(), before);
  assert.equal((await execFileAsync("git", ["status", "--porcelain=v1"], { cwd: workspace })).stdout, "");
});

test("restart retires an approved approval with no promotion and revokes its captured legacy token", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "orchestratory-merge-web-orphan-restart-"));
  const workspace = await repository();
  t.after(async () => await rm(data, { recursive: true, force: true }));
  t.after(async () => await rm(workspace, { recursive: true, force: true }));
  const first = new CollaborationService(data);
  first.ledger.createRoom("demo", workspace);
  const task = await first.candidates.start({
    actor: "codex1", clientRequestId: randomUUID(), roomId: "demo", mainPath: workspace,
    task: "crash after grant before promotion intent",
  });
  await writeFile(join(task.candidatePath, "candidate.txt"), "candidate\n", "utf8");
  await execFileAsync("git", ["add", "candidate.txt"], { cwd: task.candidatePath });
  await execFileAsync("git", [...author, "commit", "-m", "candidate work"], { cwd: task.candidatePath });
  await first.candidates.complete({
    actor: "codex1", clientRequestId: randomUUID(), taskId: task.taskId, roomId: "demo",
    mainPath: workspace, summary: "ready",
  });
  const preview = await first.candidates.previewMainMerge({
    taskId: task.taskId, roomId: "demo", mainPath: workspace,
  });
  const approval = await first.candidates.requestMainMerge({
    actor: "codex1", clientRequestId: randomUUID(), taskId: task.taskId, roomId: "demo",
    mainPath: workspace, completionId: preview.completionId, previewDigest: preview.previewDigest,
  });
  const granted = await first.candidates.grantMainMerge({
    approvalId: approval.id, roomId: "demo", mainPath: workspace,
    previewDigest: approval.previewDigest, confirmation: MERGE_APPROVAL_CONFIRMATION,
    decidedBy: "local-web",
  });
  const capturedLegacyToken = granted.approvalToken;
  const before = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: workspace })).stdout.trim();
  first.close(); // crash/restart boundary: durable approved row exists, no promotion intent does.

  const restarted = new CollaborationService(data);
  t.after(() => restarted.close());
  await assert.rejects(restarted.approveAndPromoteMainMerge({
    roomId: "demo", workspace, approvalId: approval.id,
    previewDigest: approval.previewDigest, confirmation: MERGE_APPROVAL_CONFIRMATION,
    decidedBy: "local-web",
  }), /MAIN_MERGE_APPROVAL_ORPHANED_NO_PROMOTION/u);
  const history = await restarted.listMergeHistory({ roomId: "demo", workspace });
  assert.deepEqual(history.promotions, []);
  assert.equal(history.unpromotedApprovals.length, 1);
  assert.equal(history.unpromotedApprovals[0]?.id, approval.id);
  assert.equal(history.unpromotedApprovals[0]?.state, "rejected");
  assert.equal(
    history.unpromotedApprovals[0]?.refusal?.reason,
    "PROMOTION_NOT_STARTED_AFTER_GRANT",
  );
  await assert.rejects(restarted.candidates.promoteMainMerge({
    approvalId: approval.id,
    token: capturedLegacyToken,
    action: approval.grants,
    taskId: task.taskId,
    roomId: "demo",
    mainPath: workspace,
  }), /MAIN_MERGE_APPROVAL_NOT_APPROVED/u);
  assert.equal((await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: workspace })).stdout.trim(), before);
  assert.equal((await execFileAsync("git", ["status", "--porcelain=v1"], { cwd: workspace })).stdout, "");
  assert.equal(restarted.audit.verify(), true);
});
