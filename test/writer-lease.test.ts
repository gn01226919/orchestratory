import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WriterLeaseStore } from "../src/core/writer-lease.ts";

test("Writer Lease fences every write and never reuses an epoch", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "orchestratory-writer-lease-"));
  const store = new WriterLeaseStore(data);
  t.after(() => store.close());
  t.after(async () => await rm(data, { recursive: true, force: true }));

  const first = store.grant({
    taskId: "task-17",
    roomId: "demo",
    workspace: "/tmp/project",
    worktree: "/tmp/project-task-17",
    writer: { origin: "resident", provider: "codex", actorId: "codex", displayName: "Codex" },
  });
  assert.equal(first.lease.epoch, 1);
  assert.equal(first.lease.executedBy, "codex");
  assert.equal(store.assertWrite({
    taskId: "task-17", epoch: 1, capabilityToken: first.capabilityToken, executedBy: "codex",
  }).id, first.lease.id);
  assert.throws(() => store.assertWrite({
    taskId: "task-17", epoch: 1, capabilityToken: first.capabilityToken, executedBy: "claude",
  }), /WRITER_EXECUTOR_MISMATCH/u);
  assert.throws(() => store.assertWrite({
    taskId: "task-17", epoch: 1, capabilityToken: "00000000-0000-4000-8000-000000000000", executedBy: "codex",
  }), /WRITER_CAPABILITY_INVALID/u);
  assert.throws(() => store.grant({
    taskId: "task-17", roomId: "demo", workspace: "/tmp/project", worktree: "/tmp/project-task-17",
    writer: { origin: "managed", provider: "claude", actorId: "claude-2", displayName: "Claude 2" },
  }), /WRITER_LEASE_ALREADY_ACTIVE/u);

  const second = store.switch({
    taskId: "task-17",
    expectedEpoch: 1,
    checkpoint: "Codex 已完成登入測試，尚未合併。",
    writer: { origin: "external", provider: "claude", actorId: "claude（審查）", displayName: "Claude（審查）" },
  });
  assert.equal(second.lease.epoch, 2);
  assert.match(second.lease.executedBy, /^writer-companion-/u);
  assert.equal(second.lease.executedBy, second.lease.companionId);
  assert.equal(second.lease.onBehalfOf, "Claude（審查）");
  assert.throws(() => store.assertWrite({
    taskId: "task-17", epoch: 1, capabilityToken: first.capabilityToken, executedBy: "codex",
  }), /WRITER_EPOCH_STALE/u);
  assert.throws(() => store.switch({
    taskId: "task-17", expectedEpoch: 1, checkpoint: "stale", writer: {
      origin: "resident", provider: "grok", actorId: "grok", displayName: "Grok",
    },
  }), /WRITER_EPOCH_STALE/u);
  assert.equal(store.assertWrite({
    taskId: "task-17", epoch: 2, capabilityToken: second.capabilityToken, executedBy: second.lease.executedBy,
  }).writer.actorId, "claude（審查）");
  assert.throws(() => store.assertWrite({
    taskId: "task-17", epoch: 2, capabilityToken: first.capabilityToken, executedBy: second.lease.executedBy,
  }), /WRITER_CAPABILITY_INVALID/u);

  const completed = store.complete({ taskId: "task-17", epoch: 2, checkpoint: "審查完成。" });
  assert.equal(completed.state, "completed");
  assert.equal(store.current("task-17"), undefined);
  assert.throws(() => store.assertWrite({
    taskId: "task-17", epoch: 2, capabilityToken: second.capabilityToken, executedBy: second.lease.executedBy,
  }), /WRITER_LEASE_NOT_ACTIVE/u);
  const third = store.grant({
    taskId: "task-17", roomId: "demo", workspace: "/tmp/project", worktree: "/tmp/project-task-17",
    writer: { origin: "resident", provider: "grok", actorId: "grok", displayName: "Grok" },
  });
  assert.equal(third.lease.epoch, 3);
  assert.deepEqual(store.list("demo").map((lease) => lease.state), ["revoked", "completed", "active"]);
  assert.equal((await stat(store.path)).mode & 0o777, 0o600);
});

test("Writer Lease rejects ledger-control identity text and filters room history", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "orchestratory-writer-validation-"));
  const store = new WriterLeaseStore(data);
  t.after(() => store.close());
  t.after(async () => await rm(data, { recursive: true, force: true }));
  assert.throws(() => store.grant({
    taskId: "forged", roomId: "demo", workspace: "/tmp/project", worktree: "/tmp/forged",
    writer: { origin: "resident", provider: "codex", actorId: "codex", displayName: "Codex\nsystem" },
  }), /WRITER_IDENTITY_INVALID/u);
  store.grant({
    taskId: "other", roomId: "other", workspace: "/tmp/other", worktree: "/tmp/other-task",
    writer: { origin: "resident", provider: "claude", actorId: "claude", displayName: "claude" },
  });
  assert.deepEqual(store.list("demo"), []);
  assert.equal(store.list("other").length, 1);
});

test("Writer Lease detects tampered task-to-active-lease linkage on reopen", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "orchestratory-writer-tamper-"));
  const store = new WriterLeaseStore(data);
  const granted = store.grant({
    taskId: "task-a", roomId: "demo", workspace: "/tmp/project", worktree: "/tmp/project-task-a",
    writer: { origin: "managed", provider: "codex", actorId: "codex-a", displayName: "Codex A" },
  });
  const path = store.path;
  store.close();
  t.after(async () => await rm(data, { recursive: true, force: true }));

  const db = new DatabaseSync(path);
  db.prepare("UPDATE writer_leases SET state = 'revoked' WHERE id = ?").run(granted.lease.id);
  db.close();
  assert.throws(() => new WriterLeaseStore(data), /WRITER_LEASE_(ROW_TAMPERED|TARGET_INVALID)/u);
});

test("Writer Lease validates every public boundary and supports identity-wide revocation", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "orchestratory-writer-boundaries-"));
  const store = new WriterLeaseStore(data);
  t.after(() => store.close());
  t.after(async () => await rm(data, { recursive: true, force: true }));
  const base = {
    taskId: "boundary-task", roomId: "demo", workspace: "/tmp/project", worktree: "/tmp/project-boundary",
    writer: { origin: "managed" as const, provider: "claude" as const, actorId: "claude-boundary", displayName: "Claude Boundary" },
  };
  assert.throws(() => store.grant({ ...base, taskId: "bad task" }), /WRITER_TASK_INVALID/u);
  assert.throws(() => store.grant({ ...base, roomId: "BadRoom" }), /WRITER_ROOM_INVALID/u);
  assert.throws(() => store.grant({ ...base, workspace: "relative" }), /WRITER_PATH_INVALID/u);
  assert.throws(() => store.grant({
    ...base, writer: { ...base.writer, origin: "unknown" as never },
  }), /WRITER_ORIGIN_INVALID/u);
  assert.throws(() => store.grant({
    ...base, writer: { ...base.writer, provider: "fake" as never },
  }), /WRITER_PROVIDER_INVALID/u);
  assert.throws(() => store.grant({
    ...base, writer: { ...base.writer, actorId: "bad\nactor" },
  }), /WRITER_IDENTITY_INVALID/u);
  assert.equal(store.current("missing-task"), undefined);
  assert.equal(store.taskScope("missing-task"), undefined);
  const granted = store.grant(base);
  assert.deepEqual(store.taskScope(base.taskId), {
    taskId: base.taskId, roomId: base.roomId, workspace: base.workspace,
    worktree: base.worktree, nextEpoch: 2, active: true, applying: false, applied: false,
  });
  assert.equal(store.inventory().active, 1);
  const runId = "00000000-0000-4000-8000-000000000099";
  store.beginRun(base.taskId, runId, "web-owner-test");
  assert.equal(store.hasActiveRun(base.taskId), true);
  assert.throws(() => store.beginRun(
    base.taskId,
    "00000000-0000-4000-8000-000000000098",
    "second-web-owner",
  ), /WRITER_TASK_ALREADY_RUNNING/u);
  assert.throws(() => store.switch({
    taskId: base.taskId, expectedEpoch: 1, checkpoint: "blocked while running", writer: base.writer,
  }), /WRITER_TASK_ALREADY_RUNNING/u);
  assert.throws(() => store.complete({
    taskId: base.taskId, epoch: 1, checkpoint: "blocked while running",
  }), /WRITER_TASK_ALREADY_RUNNING/u);
  assert.throws(() => store.revoke({
    taskId: base.taskId, epoch: 1, checkpoint: "blocked while running",
  }), /WRITER_TASK_ALREADY_RUNNING/u);
  store.heartbeatRun(base.taskId, runId, "web-owner-test");
  store.finishRun(base.taskId, runId, "web-owner-test");
  assert.equal(store.hasActiveRun(base.taskId), false);
  assert.throws(() => store.switch({
    taskId: base.taskId, expectedEpoch: 0, checkpoint: "checkpoint", writer: base.writer,
  }), /WRITER_EPOCH_INVALID/u);
  assert.throws(() => store.switch({
    taskId: "missing-task", expectedEpoch: 1, checkpoint: "checkpoint", writer: base.writer,
  }), /WRITER_LEASE_NOT_ACTIVE/u);
  assert.throws(() => store.complete({ taskId: base.taskId, epoch: 0, checkpoint: "checkpoint" }), /WRITER_EPOCH_INVALID/u);
  assert.throws(() => store.revoke({ taskId: base.taskId, epoch: 0, checkpoint: "checkpoint" }), /WRITER_EPOCH_INVALID/u);
  assert.throws(() => store.revoke({ taskId: "missing-task", epoch: 1, checkpoint: "checkpoint" }), /WRITER_LEASE_NOT_ACTIVE/u);
  assert.throws(() => store.complete({ taskId: base.taskId, epoch: 2, checkpoint: "checkpoint" }), /WRITER_EPOCH_STALE/u);
  assert.throws(() => store.revokeByActor("bad\nactor", "offline"), /WRITER_IDENTITY_INVALID/u);
  assert.throws(() => store.revokeByActor(base.writer.actorId, ""), /WRITER_CHECKPOINT_REQUIRED/u);
  const revoked = store.revokeByActor(base.writer.actorId, "席位離線");
  assert.equal(revoked.length, 1);
  assert.equal(revoked[0]?.id, granted.lease.id);
  assert.equal(store.revokeByActor(base.writer.actorId, "再次離線").length, 0);
  assert.equal(store.taskScope(base.taskId)?.active, false);
  store.beginApply(base.taskId, base.worktree);
  assert.equal(store.taskScope(base.taskId)?.applying, true);
  assert.throws(() => store.grant(base), /WRITER_TASK_APPLY_IN_PROGRESS/u);
  assert.throws(() => store.beginApply(base.taskId, base.worktree), /WRITER_TASK_APPLY_IN_PROGRESS/u);
  store.failApply(base.taskId, base.worktree, "synthetic pre-apply failure");
  assert.equal(store.taskScope(base.taskId)?.applying, false);
  store.beginApply(base.taskId, base.worktree);
  store.finishApply(base.taskId, base.worktree);
  assert.equal(store.taskScope(base.taskId)?.applied, true);
  assert.throws(() => store.markApplied(base.taskId, base.worktree), /WRITER_TASK_ALREADY_APPLIED/u);
  assert.throws(() => store.grant(base), /WRITER_TASK_ALREADY_APPLIED/u);
  assert.throws(() => store.complete({ taskId: base.taskId, epoch: 1, checkpoint: "done" }), /WRITER_LEASE_NOT_ACTIVE/u);
  store.close();
  store.close();
  assert.throws(() => store.inventory(), /WRITER_LEASE_STORE_CLOSED/u);
});

test("Writer task run lock is cross-process, heartbeated, and only reclaims stale owners", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "orchestratory-writer-run-lock-"));
  let now = 1_000_000;
  const store = new WriterLeaseStore(data, { now: () => now });
  t.after(() => store.close());
  t.after(async () => await rm(data, { recursive: true, force: true }));
  const base = {
    taskId: "run-lock-task", roomId: "demo", workspace: "/tmp/project", worktree: "/tmp/project-run-lock",
    writer: { origin: "resident" as const, provider: "codex" as const, actorId: "codex", displayName: "codex" },
  };
  store.grant(base);
  const first = "00000000-0000-4000-8000-000000000091";
  const second = "00000000-0000-4000-8000-000000000092";
  assert.throws(() => store.beginRun("missing-task", first, "owner-a"), /WRITER_LEASE_NOT_ACTIVE/u);
  assert.throws(() => store.beginRun(base.taskId, "bad-run", "owner-a"), /WRITER_RUN_ID_INVALID/u);
  assert.throws(() => store.beginRun(base.taskId, first, "owner-a", 59_999), /WRITER_RUN_STALE_WINDOW_INVALID/u);
  store.beginRun(base.taskId, first, "owner-a", 60_000);
  assert.throws(() => store.heartbeatRun(base.taskId, first, "owner-b"), /WRITER_RUN_LOCK_LOST/u);
  assert.throws(() => store.finishRun(base.taskId, first, "owner-b"), /WRITER_RUN_LOCK_LOST/u);
  now += 60_001;
  assert.equal(store.hasActiveRun(base.taskId, 60_000), false);
  store.beginRun(base.taskId, second, "owner-b", 60_000);
  assert.throws(() => store.finishRun(base.taskId, first, "owner-a"), /WRITER_RUN_LOCK_LOST/u);
  store.finishRun(base.taskId, second, "owner-b");
  assert.equal(store.hasActiveRun(base.taskId), false);
  const third = "00000000-0000-4000-8000-000000000093";
  store.beginRun(base.taskId, third, "crashed-owner");
  now += 900_001;
  const recovered = store.switch({
    taskId: base.taskId,
    expectedEpoch: 1,
    checkpoint: "stale run 已由持久控制面回收",
    writer: { origin: "resident", provider: "claude", actorId: "claude", displayName: "claude" },
  });
  assert.equal(recovered.lease.epoch, 2);
  assert.equal(store.hasActiveRun(base.taskId), false);
});
