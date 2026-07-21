import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WriterDelegationStore } from "../src/core/writer-delegation.ts";
import type { WriterLease } from "../src/core/writer-lease.ts";

const parent: WriterLease = {
  id: "11111111-1111-4111-8111-111111111111",
  taskId: "task-1",
  roomId: "demo",
  workspace: "/tmp/project",
  worktree: "/tmp/project-task-1",
  epoch: 4,
  state: "active",
  writer: { origin: "external", provider: "codex", actorId: "codex-seat", displayName: "codex（aaa）" },
  onBehalfOf: "codex（aaa）",
  executedBy: "writer-companion-17",
  companionId: "writer-companion-17",
  grantedAtMs: 1,
};

test("same-provider child receives fenced write capability; cross-provider child is read-only", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "orchestratory-delegation-"));
  const store = new WriterDelegationStore(data);
  t.after(() => store.close());
  t.after(async () => await rm(data, { recursive: true, force: true }));

  const same = store.create({ parent, childProvider: "codex", label: "修測試", workspace: "/tmp/child-codex" });
  assert.equal(same.delegation.access, "write");
  assert.ok(same.capabilityToken);
  assert.equal(store.assertWrite({
    delegationId: same.delegation.id,
    parentLease: parent,
    capabilityToken: same.capabilityToken!,
    executedBy: same.delegation.executedBy,
  }).id, same.delegation.id);

  const cross = store.create({ parent, childProvider: "claude", label: "第二意見", workspace: "/tmp/project" });
  assert.equal(cross.delegation.access, "read-only");
  assert.equal(cross.capabilityToken, undefined);
  assert.throws(() => store.assertWrite({
    delegationId: cross.delegation.id,
    parentLease: parent,
    capabilityToken: "00000000-0000-4000-8000-000000000000",
    executedBy: cross.delegation.executedBy,
  }), /DELEGATION_WRITE_DENIED/u);
});

test("parent lease transition invalidates and revokes every child capability", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "orchestratory-delegation-revoke-"));
  const store = new WriterDelegationStore(data);
  t.after(() => store.close());
  t.after(async () => await rm(data, { recursive: true, force: true }));
  const child = store.create({ parent, childProvider: "codex", label: "worker", workspace: "/tmp/child" });
  assert.throws(() => store.assertWrite({
    delegationId: child.delegation.id,
    parentLease: { ...parent, epoch: 5 },
    capabilityToken: child.capabilityToken!,
    executedBy: child.delegation.executedBy,
  }), /DELEGATION_PARENT_LEASE_STALE/u);
  assert.equal(store.revokeByLease(parent.id, "Writer 已交接").length, 1);
  assert.equal(store.get(child.delegation.id)?.state, "revoked");
  assert.equal(store.revokeByLease(parent.id, "再次撤銷").length, 0);
  assert.throws(() => store.assertWrite({
    delegationId: child.delegation.id,
    parentLease: parent,
    capabilityToken: child.capabilityToken!,
    executedBy: child.delegation.executedBy,
  }), /DELEGATION_NOT_ACTIVE/u);
});

test("delegation validation fails closed for identity, scope, executor, provider and capability mismatches", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "orchestratory-delegation-validation-"));
  const store = new WriterDelegationStore(data);
  t.after(() => store.close());
  t.after(async () => await rm(data, { recursive: true, force: true }));

  assert.throws(() => store.create({
    parent: { ...parent, state: "completed" }, childProvider: "codex", label: "worker", workspace: "/tmp/child",
  }), /DELEGATION_PARENT_NOT_ACTIVE/u);
  assert.throws(() => store.create({
    parent, childProvider: "fake" as never, label: "worker", workspace: "/tmp/child",
  }), /DELEGATION_PROVIDER_INVALID/u);
  assert.throws(() => store.create({ parent, childProvider: "codex", label: "\n", workspace: "/tmp/child" }), /DELEGATION_LABEL_INVALID/u);
  assert.throws(() => store.create({ parent, childProvider: "codex", label: "worker", workspace: "relative" }), /DELEGATION_WORKSPACE_INVALID/u);
  assert.throws(() => store.create({
    id: "bad", parent, childProvider: "codex", label: "worker", workspace: "/tmp/child",
  }), /DELEGATION_ID_INVALID/u);

  const same = store.create({ parent, childProvider: "codex", label: "same", workspace: "/tmp/same" });
  const cross = store.create({ parent, childProvider: "claude", label: "cross", workspace: "/tmp/project" });
  assert.equal(store.assertRead({
    delegationId: cross.delegation.id, parentLease: parent, executedBy: cross.delegation.executedBy,
  }).access, "read-only");
  assert.throws(() => store.assertRead({
    delegationId: cross.delegation.id, parentLease: { ...parent, id: "22222222-2222-4222-8222-222222222222" },
    executedBy: cross.delegation.executedBy,
  }), /DELEGATION_PARENT_LEASE_STALE/u);
  assert.throws(() => store.assertRead({
    delegationId: cross.delegation.id, parentLease: parent, executedBy: "wrong-executor",
  }), /DELEGATION_EXECUTOR_MISMATCH/u);
  assert.throws(() => store.assertWrite({
    delegationId: same.delegation.id, parentLease: { ...parent, writer: { ...parent.writer, provider: "claude" } },
    capabilityToken: same.capabilityToken!, executedBy: same.delegation.executedBy,
  }), /DELEGATION_PROVIDER_MISMATCH/u);
  assert.throws(() => store.assertWrite({
    delegationId: same.delegation.id, parentLease: parent,
    capabilityToken: same.capabilityToken!, executedBy: "wrong-executor",
  }), /DELEGATION_EXECUTOR_MISMATCH/u);
  assert.throws(() => store.assertWrite({
    delegationId: same.delegation.id, parentLease: parent,
    capabilityToken: "00000000-0000-4000-8000-000000000000", executedBy: same.delegation.executedBy,
  }), /DELEGATION_CAPABILITY_INVALID/u);
  assert.equal(store.get("33333333-3333-4333-8333-333333333333"), undefined);
  assert.deepEqual(store.list("other-room"), []);
  assert.throws(() => store.revokeByLease("bad", "reason"), /DELEGATION_PARENT_ID_INVALID/u);
  assert.throws(() => store.revokeByLease(parent.id, ""), /DELEGATION_REASON_INVALID/u);
  assert.throws(() => store.get("bad"), /DELEGATION_ID_INVALID/u);
  store.close();
  store.close();
  assert.throws(() => store.list("demo"), /WRITER_DELEGATION_STORE_CLOSED/u);
});

test("delegation enforces a per-lease active ceiling and rejects a future schema", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "orchestratory-delegation-limit-"));
  const store = new WriterDelegationStore(data);
  t.after(() => store.close());
  t.after(async () => await rm(data, { recursive: true, force: true }));
  for (let index = 0; index < 8; index += 1) {
    store.create({
      parent,
      childProvider: "codex",
      label: `child ${index}`,
      workspace: `/tmp/child-${index}`,
    });
  }
  assert.throws(() => store.create({
    parent,
    childProvider: "codex",
    label: "one too many",
    workspace: "/tmp/child-overflow",
  }), /DELEGATION_ACTIVE_LIMIT_REACHED/u);
  assert.equal(store.inventory().active, 8);
  assert.equal(store.inventory().activeLimitPerLease, 8);
  assert.deepEqual(store.integrity(), { schemaVersion: 1, quickCheck: "ok", rowsValid: true });
  const path = store.path;
  store.close();
  const database = new DatabaseSync(path);
  database.exec("PRAGMA user_version = 999");
  database.close();
  assert.throws(() => new WriterDelegationStore(data), /WRITER_DELEGATION_SCHEMA_UNSUPPORTED/u);
});
