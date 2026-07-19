import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApplyBackService } from "../src/core/apply-back-broker.ts";
import { RunEvents } from "../src/core/events.ts";
import { GitBroker } from "../src/core/git-broker.ts";
import { LocalStore } from "../src/core/store.ts";
import { WorktreeBroker } from "../src/core/worktree-broker.ts";
import { ApprovalService } from "../src/security/approval.ts";
import { WorkspacePolicy } from "../src/security/workspace-policy.ts";

const execFileAsync = promisify(execFile);

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "orchestratory-apply-source-"));
  await execFileAsync("git", ["init", "-b", "main"], { cwd: root });
  await writeFile(join(root, "README.md"), "original\n", "utf8");
  await writeFile(join(root, "delete.txt"), "recoverable\n", "utf8");
  await execFileAsync("git", ["add", "README.md", "delete.txt"], { cwd: root });
  await execFileAsync(
    "git",
    ["-c", "user.name=Synthetic Test", "-c", "user.email=test@example.invalid", "commit", "-m", "initial"],
    { cwd: root },
  );
  return root;
}

async function completedWorktree(input: {
  source: string;
  store: LocalStore;
  events: RunEvents;
  runId: string;
}): Promise<string> {
  const git = new GitBroker();
  const baseline = await git.inspect(input.source);
  const headSha = await git.headSha(input.source);
  input.store.saveRun({
    id: input.runId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "completed",
    workspaceLabel: "synthetic",
    profile: "normal",
    counters: {
      rounds: 1,
      providerCalls: 3,
      subprocesses: 0,
      consecutiveErrors: 0,
      outputBytes: 0,
      apiBudgetUsd: 0,
    },
  });
  input.events.emit({
    runId: input.runId,
    type: "workspace.source-baseline",
    actor: "git",
    status: "info",
    summary: "Synthetic baseline.",
    metadata: { fingerprint: baseline.fingerprint, headSha, dirtySnapshot: false },
  });
  return (await new WorktreeBroker(input.store.dataDirectory).create(input.source, input.runId)).workspace;
}

test("apply-back is preview-bound, single-use, and moves deletions to trash-pending", async (t) => {
  const source = await repository();
  const data = await mkdtemp(join(tmpdir(), "orchestratory-apply-data-"));
  const trash = await mkdtemp(join(tmpdir(), "orchestratory-trash-pending-"));
  t.after(async () => await rm(source, { recursive: true, force: true }));
  t.after(async () => await rm(data, { recursive: true, force: true }));
  t.after(async () => await rm(trash, { recursive: true, force: true }));
  const store = new LocalStore(data);
  t.after(() => store.close());
  const events = new RunEvents(store);
  const approvals = new ApprovalService();
  const runId = "00000000-0000-4000-8000-000000000901";
  const worktree = await completedWorktree({ source, store, events, runId });
  await writeFile(join(worktree, "README.md"), "agent result\n", "utf8");
  await mkdir(join(worktree, "nested"));
  await writeFile(join(worktree, "nested", "new.txt"), "new result\n", "utf8");
  await rm(join(worktree, "delete.txt"));
  const service = new ApplyBackService({
    store,
    approvals,
    events,
    workspaces: WorkspacePolicy.fromPaths([source]),
    maxFiles: 10,
    trashRoot: trash,
  });
  const preview = await service.prepare(runId);
  assert.deepEqual(
    preview.changes.map((change) => `${change.operation}:${change.path}`),
    ["write:README.md", "delete:delete.txt", "write:nested/new.txt"],
  );
  assert.equal(JSON.stringify(preview).includes("agent result"), false);
  assert.deepEqual(preview.risk, {
    level: "high",
    reasons: [
      "1 個既有檔案將移至 trash-pending（可復原）",
      "1 個既有檔案內容將被覆寫",
      "1 個新檔案將加入專案",
    ],
  });
  assert.deepEqual(service.status(), { pending: 1, maxPending: 4, ttlMs: 120_000 });
  await assert.rejects(service.apply(preview.id, "a".repeat(43)), /APPROVAL_INVALID_OR_REPLAYED/u);

  const issued = service.issueApproval(preview.id, "local-web");
  const result = await service.apply(preview.id, issued.token);
  assert.equal(result.writes, 2);
  assert.equal(result.deletesMovedToTrash, 1);
  assert.ok(result.trashSession);
  assert.equal(await readFile(join(source, "README.md"), "utf8"), "agent result\n");
  assert.equal(await readFile(join(source, "nested", "new.txt"), "utf8"), "new result\n");
  await assert.rejects(readFile(join(source, "delete.txt")), /ENOENT/u);
  assert.equal(await readFile(join(result.trashSession!, "delete.txt"), "utf8"), "recoverable\n");
  assert.throws(() => service.get(preview.id), /NOT_FOUND_OR_EXPIRED/u);
  assert.ok(store.listEvents(runId).some((event) => event.type === "worktree.apply-back-completed"));
});

test("Room Writer registers its source baseline at grant time and completes into review-only apply-back", async (t) => {
  const source = await repository();
  const data = await mkdtemp(join(tmpdir(), "orchestratory-room-writer-data-"));
  const trash = await mkdtemp(join(tmpdir(), "orchestratory-room-writer-trash-"));
  t.after(async () => await rm(source, { recursive: true, force: true }));
  t.after(async () => await rm(data, { recursive: true, force: true }));
  t.after(async () => await rm(trash, { recursive: true, force: true }));
  const store = new LocalStore(data);
  t.after(() => store.close());
  const events = new RunEvents(store);
  const service = new ApplyBackService({
    store,
    approvals: new ApprovalService(),
    events,
    workspaces: WorkspacePolicy.fromPaths([source]),
    maxFiles: 10,
    trashRoot: trash,
  });
  const runId = "00000000-0000-4000-8000-000000000905";
  const retained = await new WorktreeBroker(data).create(source, runId);
  await service.beginRetained({
    runId,
    roomId: "demo",
    taskId: "room-task",
    workspace: source,
    worktree: retained.workspace,
  });
  assert.equal(store.getRun(runId)?.status, "created");
  assert.ok(store.listEvents(runId).some((event) => event.type === "workspace.source-baseline"));
  await writeFile(join(retained.workspace, "README.md"), "room writer result\n", "utf8");
  const preview = await service.completeRetained(runId);
  assert.equal(store.getRun(runId)?.status, "completed");
  assert.equal(preview.risk.level, "medium");
  assert.equal(await readFile(join(source, "README.md"), "utf8"), "original\n");
  const approval = service.issueApproval(preview.id, "local-web");
  await service.apply(preview.id, approval.token);
  assert.equal(await readFile(join(source, "README.md"), "utf8"), "room writer result\n");
});

test("apply-back rejects source/worktree changes, expiry, unsafe state, and uncompleted runs", async (t) => {
  const source = await repository();
  const data = await mkdtemp(join(tmpdir(), "orchestratory-apply-race-"));
  const trash = await mkdtemp(join(tmpdir(), "orchestratory-trash-race-"));
  t.after(async () => await rm(source, { recursive: true, force: true }));
  t.after(async () => await rm(data, { recursive: true, force: true }));
  t.after(async () => await rm(trash, { recursive: true, force: true }));
  const store = new LocalStore(data);
  t.after(() => store.close());
  const events = new RunEvents(store);
  const approvals = new ApprovalService();
  let now = 1_000;
  const runId = "00000000-0000-4000-8000-000000000902";
  const worktree = await completedWorktree({ source, store, events, runId });
  await writeFile(join(worktree, "README.md"), "first result\n", "utf8");
  const service = new ApplyBackService({
    store,
    approvals,
    events,
    workspaces: WorkspacePolicy.fromPaths([source]),
    maxFiles: 10,
    now: () => now,
    ttlMs: 10_000,
    trashRoot: trash,
  });
  const sourceRace = await service.prepare(runId);
  const sourceToken = service.issueApproval(sourceRace.id, "local-tui").token;
  await writeFile(join(source, "README.md"), "owner changed\n", "utf8");
  await assert.rejects(service.apply(sourceRace.id, sourceToken), /STATE_CHANGED/u);
  await writeFile(join(source, "README.md"), "original\n", "utf8");

  const worktreeRace = await service.prepare(runId);
  const worktreeToken = service.issueApproval(worktreeRace.id, "local-tui").token;
  await writeFile(join(worktree, "README.md"), "second result\n", "utf8");
  await assert.rejects(service.apply(worktreeRace.id, worktreeToken), /STATE_CHANGED/u);

  const expiring = await service.prepare(runId);
  now += 10_001;
  assert.throws(() => service.get(expiring.id), /NOT_FOUND_OR_EXPIRED/u);
  assert.throws(() => service.get("bad"), /ID_INVALID/u);
  assert.throws(
    () => new ApplyBackService({
      store,
      approvals,
      events,
      workspaces: WorkspacePolicy.fromPaths([source]),
      maxFiles: 10,
      ttlMs: 9_999,
    }),
    /TTL_INVALID/u,
  );
  assert.throws(
    () => new ApplyBackService({
      store,
      approvals,
      events,
      workspaces: WorkspacePolicy.fromPaths([source]),
      maxFiles: 10,
      ttlMs: 600_001,
    }),
    /TTL_INVALID/u,
  );
  assert.throws(
    () => new ApplyBackService({
      store,
      approvals,
      events,
      workspaces: WorkspacePolicy.fromPaths([source]),
      maxFiles: 10,
      trashRoot: "relative/trash",
    }),
    /TRASH_ROOT_INVALID/u,
  );

  const notCompleted = "00000000-0000-4000-8000-000000000903";
  store.saveRun({
    ...(store.getRun(runId)!),
    id: notCompleted,
    status: "failed",
  });
  await assert.rejects(service.prepare(notCompleted), /RUN_NOT_COMPLETED/u);
});

test("apply-back fails closed on missing baseline and unsafe trash without hiding the audit failure", async (t) => {
  const source = await repository();
  const data = await mkdtemp(join(tmpdir(), "orchestratory-apply-negative-"));
  const unsafeTrash = join(data, "trash-is-a-file");
  t.after(async () => await rm(source, { recursive: true, force: true }));
  t.after(async () => await rm(data, { recursive: true, force: true }));
  const store = new LocalStore(data);
  t.after(() => store.close());
  const events = new RunEvents(store);
  const approvals = new ApprovalService();
  const runId = "00000000-0000-4000-8000-000000000904";
  const worktree = await new WorktreeBroker(data).create(source, runId);
  store.saveRun({
    id: runId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "completed",
    workspaceLabel: "synthetic",
    profile: "normal",
    counters: {
      rounds: 1,
      providerCalls: 0,
      subprocesses: 0,
      consecutiveErrors: 0,
      outputBytes: 0,
      apiBudgetUsd: 0,
    },
  });
  await rm(join(worktree.workspace, "delete.txt"));
  const service = new ApplyBackService({
    store,
    approvals,
    events,
    workspaces: WorkspacePolicy.fromPaths([source]),
    maxFiles: 10,
    trashRoot: unsafeTrash,
  });
  await assert.rejects(service.prepare(runId), /BASELINE_MISSING/u);

  const git = new GitBroker();
  events.emit({
    runId,
    type: "workspace.source-baseline",
    actor: "git",
    status: "info",
    summary: "Synthetic baseline.",
    metadata: {
      fingerprint: (await git.inspect(source)).fingerprint,
      headSha: await git.headSha(source),
      dirtySnapshot: false,
    },
  });
  const preview = await service.prepare(runId);
  const token = service.issueApproval(preview.id, "local-tui").token;
  await writeFile(unsafeTrash, "not a directory", "utf8");
  await assert.rejects(service.apply(preview.id, token), /EEXIST|TRASH_ROOT_UNSAFE/u);
  assert.ok(store.listEvents(runId).some((event) => event.type === "worktree.apply-back-failed"));
});
