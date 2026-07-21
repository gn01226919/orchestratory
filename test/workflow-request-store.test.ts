import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  WorkflowRequestStore,
  type WorkflowRequestProposal,
} from "../src/core/workflow-request-store.ts";

function proposal(workspace: string): WorkflowRequestProposal {
  return {
    workspace,
    task: "修正登入流程並補反向測試",
    acceptanceCriteria: "所有測試通過且不得新增網路權限",
    profile: "normal",
    planner: { provider: "codex", model: "gpt-5.6-sol" },
    writer: { provider: "claude", model: "claude-fable-5" },
    reviewers: [{ provider: "codex", model: "gpt-5.6-sol" }],
  };
}

test("workflow request store persists owner-only proposals and resolves once", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orchestratory-workflow-requests-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const first = new WorkflowRequestStore(root);
  const queued = first.enqueue(proposal("/tmp/project"), "claude", 1_000);
  assert.equal(queued.status, "pending");
  assert.equal(queued.actor, "claude");
  assert.equal(first.enqueue(proposal("/tmp/project"), "claude", 2_000).id, queued.id);
  assert.deepEqual(first.inventory(), { total: 1, pending: 1, accepted: 0, declined: 0 });
  assert.equal((await stat(first.path)).mode & 0o777, 0o600);
  first.close();

  const reopened = new WorkflowRequestStore(root);
  assert.equal(reopened.listPending()[0]?.id, queued.id);
  const resolved = reopened.resolve(queued.id, "accepted", 3_000);
  assert.equal(resolved.status, "accepted");
  assert.equal(resolved.resolvedAt, new Date(3_000).toISOString());
  assert.deepEqual(reopened.listPending(), []);
  await assert.rejects(
    async () => reopened.resolve(queued.id, "declined", 4_000),
    /WORKFLOW_REQUEST_ALREADY_RESOLVED/u,
  );
  assert.equal(reopened.integrity().hashesValid, true);
  reopened.close();
});

test("workflow request store validates actors, bounds, and targets", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orchestratory-workflow-request-invalid-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const store = new WorkflowRequestStore(root);
  t.after(() => store.close());
  assert.throws(() => store.enqueue(proposal("/tmp/project"), "Claude Code"), /ACTOR_INVALID/u);
  assert.throws(
    () => store.enqueue({ ...proposal("/tmp/project"), task: "x".repeat(20_001) }, "claude"),
    /TASK_INVALID/u,
  );
  assert.throws(
    () => store.enqueue({ ...proposal("/tmp/project"), reviewers: [] }, "claude"),
    /REVIEWERS_INVALID/u,
  );
  assert.throws(
    () => store.enqueue({
      ...proposal("/tmp/project"),
      writer: { provider: "claude", model: "bad model" },
    }, "claude"),
    /MODEL_INVALID/u,
  );
  assert.throws(
    () => store.enqueue({ ...proposal("/tmp/project"), profile: "custom" as "normal" }, "claude"),
    /PROFILE_INVALID/u,
  );
  assert.throws(
    () => store.enqueue({
      ...proposal("/tmp/project"),
      planner: { provider: "unknown" as "codex", model: "model" },
    }, "claude"),
    /TARGET_INVALID/u,
  );
  assert.throws(() => store.enqueue(proposal("/tmp/project"), "claude", -1), /TIME_INVALID/u);
  assert.throws(() => store.listPending(0), /LIMIT_INVALID/u);
  assert.throws(() => store.resolve("bad", "accepted"), /ID_INVALID/u);
  assert.throws(
    () => store.resolve("00000000-0000-4000-8000-000000000001", "pending" as "accepted"),
    /DECISION_INVALID/u,
  );
  assert.throws(
    () => store.resolve("00000000-0000-4000-8000-000000000001", "accepted"),
    /NOT_FOUND/u,
  );
});

test("workflow request store rejects row tampering on reopen", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orchestratory-workflow-request-tamper-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const store = new WorkflowRequestStore(root);
  store.enqueue(proposal("/tmp/project"), "codex");
  const path = store.path;
  store.close();
  await chmod(path, 0o600);
  const db = new DatabaseSync(path);
  db.prepare("UPDATE workflow_requests SET payload = ?").run(JSON.stringify({ actor: "attacker" }));
  db.close();
  assert.throws(() => new WorkflowRequestStore(root), /WORKFLOW_REQUEST_HASH_MISMATCH/u);
});

test("two store processes serialize duplicate proposal enqueue", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orchestratory-workflow-request-race-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const first = new WorkflowRequestStore(root);
  const second = new WorkflowRequestStore(root);
  t.after(() => first.close());
  t.after(() => second.close());
  const left = first.enqueue(proposal("/tmp/project"), "claude", 1_000);
  const right = second.enqueue(proposal("/tmp/project"), "claude", 2_000);
  assert.equal(left.id, right.id);
  assert.equal(first.inventory().total, 1);
  assert.equal(second.inventory().pending, 1);
});

test("workflow request store bounds pending denial-of-service and closed access", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orchestratory-workflow-request-cap-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const store = new WorkflowRequestStore(root);
  for (let index = 0; index < 100; index += 1) {
    store.enqueue({ ...proposal("/tmp/project"), task: `bounded task ${index}` }, "claude", index);
  }
  assert.equal(store.inventory().pending, 100);
  assert.throws(
    () => store.enqueue({ ...proposal("/tmp/project"), task: "one too many" }, "claude", 101),
    /QUEUE_FULL/u,
  );
  store.close();
  store.close();
  assert.throws(() => store.inventory(), /STORE_CLOSED/u);
});

test("workflow request store rejects future schemas and reports live hash corruption", async (t) => {
  const futureRoot = await mkdtemp(join(tmpdir(), "orchestratory-workflow-request-future-"));
  const tamperRoot = await mkdtemp(join(tmpdir(), "orchestratory-workflow-request-live-tamper-"));
  t.after(async () => await rm(futureRoot, { recursive: true, force: true }));
  t.after(async () => await rm(tamperRoot, { recursive: true, force: true }));
  const future = new DatabaseSync(join(futureRoot, "workflow-requests.sqlite"));
  future.exec("PRAGMA user_version = 2");
  future.close();
  await chmod(join(futureRoot, "workflow-requests.sqlite"), 0o600);
  assert.throws(() => new WorkflowRequestStore(futureRoot), /SCHEMA_UNSUPPORTED/u);

  const store = new WorkflowRequestStore(tamperRoot);
  t.after(() => store.close());
  store.enqueue(proposal("/tmp/project"), "codex");
  const attacker = new DatabaseSync(store.path);
  attacker.prepare("UPDATE workflow_requests SET payload = ?").run(JSON.stringify({ actor: "bad" }));
  attacker.close();
  assert.equal(store.integrity().hashesValid, false);
  assert.throws(() => store.listPending(), /HASH_MISMATCH/u);
});
