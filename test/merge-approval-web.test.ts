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
 * approve with the exact phrase, and reject. Negative cases first, because the only thing worse than
 * a dialog that cannot approve is one that approves something the owner did not see.
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

  const granted = await post("/api/rooms/merge-approvals/approve", {
    room: "demo", approvalId: approval.id, previewDigest: approval.binding.previewDigest,
    confirmation: MERGE_APPROVAL_CONFIRMATION,
  });
  assert.equal(granted.status, 200);
  const grantedApproval = granted.body.approval as { state: string; decidedBy: string };
  assert.equal(grantedApproval.state, "approved");
  assert.equal(grantedApproval.decidedBy, "local-web");
  assert.match(String(granted.body.approvalToken), /^[A-Za-z0-9_-]{43}$/u);
  assert.ok(Date.parse(String(granted.body.expiresAt)) > Date.now());
  // Single-use is the whole point: the same grant cannot be issued twice.
  const replayed = await post("/api/rooms/merge-approvals/approve", {
    room: "demo", approvalId: approval.id, previewDigest: approval.binding.previewDigest,
    confirmation: MERGE_APPROVAL_CONFIRMATION,
  });
  assert.equal(replayed.body.error, "MAIN_MERGE_APPROVAL_NOT_PENDING");

  const mainHead = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: workspace })).stdout;
  const mainStatus = (await execFileAsync("git", ["status", "--porcelain=v1"], { cwd: workspace })).stdout;
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
  assert.equal(rejected.status, 200);
  assert.equal((rejected.body.approval as { state: string }).state, "rejected");
  assert.equal(rejected.body.candidateRetained, true);
  assert.equal(rejected.body.recoveryRefRetained, true);
  // Withdrawing an approval is not a cleanup authorization.
  assert.equal((await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: workspace })).stdout, mainHead);
  assert.equal(
    (await execFileAsync("git", ["status", "--porcelain=v1"], { cwd: workspace })).stdout, mainStatus,
  );
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
