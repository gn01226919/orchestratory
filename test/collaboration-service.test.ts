import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CollaborationService } from "../src/core/collaboration-service.ts";

const execFileAsync = promisify(execFile);
const ROOM_FIRST_JOIN = { collaborationMode: "room-first" as const, syncTurns: true };

async function repository(prefix = "orchestratory-collaboration-source-"): Promise<string> {
  const source = await mkdtemp(join(tmpdir(), prefix));
  await execFileAsync("git", ["init", "-b", "main"], { cwd: source });
  await writeFile(join(source, "README.md"), "synthetic\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd: source });
  await execFileAsync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "initial"], { cwd: source });
  return source;
}

test("GUI, TUI and MCP service instances share one exact-seat ledger sequence", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "orchestratory-collaboration-"));
  const gui = new CollaborationService(data);
  const mcp = new CollaborationService(data);
  t.after(() => gui.close());
  t.after(() => mcp.close());
  t.after(async () => await rm(data, { recursive: true, force: true }));

  gui.ledger.createRoom("demo", "/tmp/project");
  const external = mcp.registerExternal({
    provider: "codex",
    workspace: "/tmp/project",
    hostPid: 7001,
    model: "gpt-test",
  });
  mcp.requestExternalJoin(external.id, "demo", "/tmp/project");
  const joined = gui.approveExternalJoin({
    ...ROOM_FIRST_JOIN,
    presenceId: external.id,
    roomId: "demo",
    workspace: "/tmp/project",
    label: "frontend",
  });
  assert.equal(joined.displayName, "codex（frontend）");
  const offDutyView = gui.roomView("demo", "/tmp/project").sessions[0];
  assert.equal(offDutyView?.kind, "external-pull");
  assert.equal(offDutyView?.wakeMode, "active-tool-pull");
  assert.equal(offDutyView?.wakeable, false);

  const posted = gui.postToExternal({
    roomId: "demo",
    workspace: "/tmp/project",
    presenceId: external.id,
    text: "請修正登入",
  });
  assert.deepEqual(posted.dispatch, {
    wakeMode: "active-tool-pull",
    wakeable: false,
    immediate: false,
  });
  const claimed = await mcp.waitExternal({ presenceId: external.id, roomId: "demo", timeoutMs: 100 });
  assert.ok(claimed);
  assert.equal(claimed.message.seq, posted.message.seq);
  mcp.ackExternal({ presenceId: external.id, deliveryId: claimed.id, leaseToken: claimed.leaseToken, phase: "read" });
  mcp.ackExternal({ presenceId: external.id, deliveryId: claimed.id, leaseToken: claimed.leaseToken, phase: "working" });
  const reply = await mcp.replyExternal({
    presenceId: external.id,
    deliveryId: claimed.id,
    leaseToken: claimed.leaseToken,
    text: "登入已修正",
  });

  assert.equal(reply.reply.author, "codex（frontend）");
  assert.equal(mcp.externalActor(external.id, "demo"), "codex（frontend）");
  assert.equal(mcp.heartbeatExternal(external.id).id, external.id);
  assert.equal(gui.ledger.getRange("demo", reply.reply.seq, reply.reply.seq)[0]?.text, "登入已修正");
  assert.equal(gui.roomView("demo", "/tmp/project").deliveries[0]?.state, "replied");
  assert.equal(gui.ledger.verifyChain("demo"), true);
  const failing = gui.postToExternal({
    roomId: "demo", workspace: "/tmp/project", presenceId: external.id, text: "請執行失敗案例",
  });
  const failingClaim = await mcp.waitExternal({ presenceId: external.id, roomId: "demo", timeoutMs: 100 });
  assert.ok(failingClaim);
  assert.equal(mcp.failExternal({
    presenceId: external.id, deliveryId: failing.delivery.id,
    leaseToken: failingClaim.leaseToken, reason: "synthetic failure",
  }).state, "failed");
  mcp.unregisterExternal(external.id, "test finished");
  assert.equal(gui.reconcileExternalPresence("demo", "/tmp/project").length, 0);
});

test("managed and external seats cannot claim the same room display identity", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "orchestratory-collaboration-name-"));
  const service = new CollaborationService(data);
  t.after(() => service.close());
  t.after(async () => await rm(data, { recursive: true, force: true }));
  service.ledger.createRoom("demo", "/tmp/project");

  const external = service.registerExternal({ provider: "codex", workspace: "/tmp/project", hostPid: 7101 });
  service.requestExternalJoin(external.id, "demo", "/tmp/project");
  service.approveExternalJoin({
    ...ROOM_FIRST_JOIN,
    presenceId: external.id,
    roomId: "demo",
    workspace: "/tmp/project",
    label: "same",
  });
  assert.throws(() => service.createManaged({
    roomId: "demo",
    workspace: "/tmp/project",
    provider: "codex",
    model: "gpt-test",
    label: "same",
  }), /MANAGED_AGENT_DISPLAY_NAME_IN_USE/u);

  service.createManaged({
    roomId: "demo",
    workspace: "/tmp/project",
    provider: "claude",
    model: "claude-test",
    label: "reserved",
  });
  const another = service.registerExternal({ provider: "claude", workspace: "/tmp/project", hostPid: 7102 });
  service.requestExternalJoin(another.id, "demo", "/tmp/project");
  assert.throws(() => service.approveExternalJoin({
    ...ROOM_FIRST_JOIN,
    presenceId: another.id,
    roomId: "demo",
    workspace: "/tmp/project",
    label: "reserved",
  }), /PRESENCE_DISPLAY_NAME_IN_USE/u);
  assert.equal(service.presence.get(another.id)?.joined, false);
});

test("a second GUI preserves a live cross-process Writer run and revokes it only after the heartbeat stops", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "orchestratory-collaboration-restart-"));
  const first = new CollaborationService(data);
  const second = new CollaborationService(data);
  t.after(() => first.close());
  t.after(() => second.close());
  t.after(async () => await rm(data, { recursive: true, force: true }));
  first.ledger.createRoom("demo", "/tmp/project");
  const granted = first.writerLeases.grant({
    taskId: "live-across-gui",
    roomId: "demo",
    workspace: "/tmp/project",
    worktree: "/tmp/project-live-across-gui",
    writer: { origin: "resident", provider: "codex", actorId: "codex", displayName: "codex" },
  });
  const runId = "00000000-0000-4000-8000-000000000077";
  first.writerLeases.beginRun("live-across-gui", runId, "first-gui");
  assert.equal(second.revokeUnrecoverableWriters(), 0);
  assert.equal(second.writerLeases.current("live-across-gui")?.id, granted.lease.id);
  first.writerLeases.finishRun("live-across-gui", runId, "first-gui");
  assert.equal(second.revokeUnrecoverableWriters(), 1);
  assert.equal(first.writerLeases.current("live-across-gui"), undefined);
  assert.equal(second.audit.verify(), true);
});

test("service rejects cross-room removal and delivery impersonation", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "orchestratory-collaboration-guard-"));
  const service = new CollaborationService(data);
  t.after(() => service.close());
  t.after(async () => await rm(data, { recursive: true, force: true }));
  service.ledger.createRoom("first", "/tmp/project");
  service.ledger.createRoom("second", "/tmp/project");
  const first = service.registerExternal({ provider: "claude", workspace: "/tmp/project", hostPid: 7002 });
  const second = service.registerExternal({ provider: "codex", workspace: "/tmp/project", hostPid: 7003 });
  const foreign = service.registerExternal({ provider: "grok", workspace: "/tmp/other", hostPid: 7004 });
  assert.throws(
    () => service.requestExternalJoin(foreign.id, "first", "/tmp/project"),
    /PRESENCE_WORKSPACE_MISMATCH/u,
  );
  service.requestExternalJoin(first.id, "first", "/tmp/project");
  service.requestExternalJoin(second.id, "first", "/tmp/project");
  service.approveExternalJoin({ ...ROOM_FIRST_JOIN, presenceId: first.id, roomId: "first", workspace: "/tmp/project" });
  service.approveExternalJoin({ ...ROOM_FIRST_JOIN, presenceId: second.id, roomId: "first", workspace: "/tmp/project" });
  const posted = service.postToExternal({ roomId: "first", workspace: "/tmp/project", presenceId: first.id, text: "task" });

  assert.throws(
    () => service.removeExternal({ presenceId: first.id, roomId: "second", workspace: "/tmp/project" }),
    /PRESENCE_NOT_JOINED/u,
  );
  assert.throws(
    () => service.ackExternal({
      presenceId: second.id,
      deliveryId: posted.delivery.id,
      leaseToken: "33333333-3333-4333-8333-333333333333",
      phase: "read",
    }),
    /DELIVERY_NOT_FOUND/u,
  );
});

test("service grants and switches Writer only to eligible room identities", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "orchestratory-collaboration-writer-"));
  const source = await repository();
  const service = new CollaborationService(data);
  t.after(() => service.close());
  t.after(async () => await rm(data, { recursive: true, force: true }));
  t.after(async () => await rm(source, { recursive: true, force: true }));
  service.ledger.createRoom("demo", source);
  const external = service.registerExternal({ provider: "codex", workspace: source, hostPid: 7010 });
  await assert.rejects(service.grantWriter({
    taskId: "task-1", roomId: "demo", workspace: source,
    candidate: { origin: "external", actorId: external.id },
  }), /WRITER_CANDIDATE_NOT_ELIGIBLE/u);
  service.requestExternalJoin(external.id, "demo", source);
  const joined = service.approveExternalJoin({ ...ROOM_FIRST_JOIN, presenceId: external.id, roomId: "demo", workspace: source, label: "修復" });
  const granted = await service.grantWriter({
    taskId: "task-1", roomId: "demo", workspace: source,
    candidate: { origin: "external", actorId: external.id },
  });
  assert.equal(granted.lease.writer.displayName, joined.displayName);
  assert.match(granted.lease.executedBy, /^writer-companion-/u);
  assert.ok(service.ledger.listAfter("demo", 0, 20).some((message) =>
    message.text.includes("受管 Writer Companion") && message.text.includes("epoch 1")));

  const managed = service.createManaged({ roomId: "demo", workspace: source, provider: "claude", model: "claude-test", label: "審查" });
  const switched = service.switchWriter({
    taskId: "task-1", roomId: "demo", workspace: source, expectedEpoch: 1,
    checkpoint: "外接 Codex 已完成初稿。\n尚未合併。", candidate: { origin: "managed", actorId: managed.id },
  });
  assert.equal(switched.lease.epoch, 2);
  assert.equal(switched.lease.writer.displayName, managed.displayName);
  assert.equal(switched.lease.executedBy, managed.id);
  assert.ok(service.ledger.listAfter("demo", 0, 30)
    .filter((message) => message.kind === "system")
    .every((message) => !message.text.includes("\n")));
  assert.equal(service.roomView("demo", source).writerLeases.at(-1)?.id, switched.lease.id);
  assert.equal(service.assertWriterWrite({
    taskId: "task-1", roomId: "demo", workspace: source, epoch: 2,
    capabilityToken: switched.capabilityToken, executedBy: managed.id,
  }).id, switched.lease.id);

  service.ledger.createRoom("other", source);
  assert.throws(() => service.assertWriterWrite({
    taskId: "task-1", roomId: "other", workspace: source, epoch: 2,
    capabilityToken: switched.capabilityToken, executedBy: managed.id,
  }), /WRITER_TASK_SCOPE_MISMATCH/u);
  assert.throws(() => service.completeWriter({
    taskId: "task-1", roomId: "other", workspace: source, epoch: 2, checkpoint: "wrong room",
  }), /WRITER_TASK_SCOPE_MISMATCH/u);

  service.archiveManaged(managed.id, "demo", source);
  assert.equal(service.writerLeases.current("task-1"), undefined);
  assert.throws(() => service.assertWriterWrite({
    taskId: "task-1", roomId: "demo", workspace: source, epoch: 2,
    capabilityToken: switched.capabilityToken, executedBy: managed.id,
  }), /WRITER_LEASE_NOT_ACTIVE/u);

  const resumed = await service.grantWriter({
    taskId: "task-1", roomId: "demo", workspace: source,
    candidate: { origin: "resident", provider: "claude" },
  });
  assert.equal(resumed.lease.epoch, 3);
  assert.equal(resumed.lease.worktree, granted.lease.worktree);
  await assert.rejects(service.grantWriter({
    taskId: "task-1", roomId: "demo", workspace: source,
    candidate: { origin: "resident", provider: "claude" },
  }), /WRITER_LEASE_ALREADY_ACTIVE/u);
  assert.throws(() => service.switchWriter({
    taskId: "missing-task", roomId: "demo", workspace: source, expectedEpoch: 1,
    checkpoint: "missing", candidate: { origin: "resident", provider: "claude" },
  }), /WRITER_TASK_SCOPE_MISMATCH/u);
  await assert.rejects(service.grantWriter({
    taskId: "managed-missing", roomId: "demo", workspace: source,
    candidate: { origin: "managed", actorId: "00000000-0000-4000-8000-000000000099" },
  }), /WRITER_CANDIDATE_NOT_ELIGIBLE/u);

  const externalWriter = await service.grantWriter({
    taskId: "task-2", roomId: "demo", workspace: source,
    candidate: { origin: "external", actorId: external.id },
  });
  service.removeExternal({ presenceId: external.id, roomId: "demo", workspace: source });
  assert.equal(service.writerLeases.current("task-2"), undefined);
  assert.throws(() => service.assertWriterWrite({
    taskId: "task-2", roomId: "demo", workspace: source, epoch: externalWriter.lease.epoch,
    capabilityToken: externalWriter.capabilityToken, executedBy: externalWriter.lease.executedBy,
  }), /WRITER_LEASE_NOT_ACTIVE/u);
  service.completeWriter({
    taskId: "task-1", roomId: "demo", workspace: source,
    epoch: resumed.lease.epoch, checkpoint: "完成後保留 worktree",
  });
  await rm(resumed.lease.worktree, { recursive: true, force: true });
  await assert.rejects(service.grantWriter({
    taskId: "task-1", roomId: "demo", workspace: source,
    candidate: { origin: "resident", provider: "claude" },
  }), /WRITER_RETAINED_WORKTREE_MISSING/u);
});

test("Writer grant explains that a repository without a base commit cannot create a worktree", async (t) => {
  const source = await mkdtemp(join(tmpdir(), "orchestratory-writer-empty-source-"));
  const data = await mkdtemp(join(tmpdir(), "orchestratory-writer-empty-data-"));
  await execFileAsync("git", ["init", "-b", "main"], { cwd: source });
  const service = new CollaborationService(data);
  t.after(() => service.close());
  t.after(async () => await rm(data, { recursive: true, force: true }));
  t.after(async () => await rm(source, { recursive: true, force: true }));
  service.ledger.createRoom("empty", source);
  await assert.rejects(service.grantWriter({
    taskId: "no-base", roomId: "empty", workspace: source,
    candidate: { origin: "resident", provider: "claude" },
  }), /WRITER_BASE_COMMIT_REQUIRED/u);
});

test("Writer serializes same-provider writable children in the task worktree and keeps cross-provider children read-only", async (t) => {
  const source = await repository("orchestratory-delegation-source-");
  const data = await mkdtemp(join(tmpdir(), "orchestratory-delegation-service-"));
  const service = new CollaborationService(data);
  t.after(() => service.close());
  t.after(async () => await rm(data, { recursive: true, force: true }));
  t.after(async () => await rm(source, { recursive: true, force: true }));
  service.ledger.createRoom("demo", source);
  const writer = await service.grantWriter({
    taskId: "task-delegate", roomId: "demo", workspace: source,
    candidate: { origin: "resident", provider: "codex" },
  });

  const writable = await service.delegateWriterChild({
    taskId: "task-delegate", roomId: "demo", workspace: source, epoch: writer.lease.epoch,
    capabilityToken: writer.capabilityToken, executedBy: writer.lease.executedBy,
    childProvider: "codex", label: "實作",
  });
  assert.equal(writable.delegation.access, "write");
  assert.equal(writable.delegation.workspace, writer.lease.worktree);
  assert.equal(service.assertDelegatedWrite({
    delegationId: writable.delegation.id, taskId: "task-delegate", roomId: "demo", workspace: source,
    capabilityToken: writable.capabilityToken!, executedBy: writable.delegation.executedBy,
  }).workspace, writable.delegation.workspace);

  const readonly = await service.delegateWriterChild({
    taskId: "task-delegate", roomId: "demo", workspace: source, epoch: writer.lease.epoch,
    capabilityToken: writer.capabilityToken, executedBy: writer.lease.executedBy,
    childProvider: "claude", label: "審查",
  });
  assert.equal(readonly.delegation.access, "read-only");
  assert.equal(readonly.delegation.workspace, writer.lease.worktree);
  assert.equal(service.assertDelegatedRead({
    delegationId: readonly.delegation.id, taskId: "task-delegate", roomId: "demo", workspace: source,
    executedBy: readonly.delegation.executedBy,
  }).id, readonly.delegation.id);
  assert.throws(() => service.assertDelegatedRead({
    delegationId: readonly.delegation.id, taskId: "missing-task", roomId: "demo", workspace: source,
    executedBy: readonly.delegation.executedBy,
  }), /DELEGATION_PARENT_LEASE_STALE/u);
  assert.throws(() => service.assertDelegatedWrite({
    delegationId: readonly.delegation.id, taskId: "task-delegate", roomId: "demo", workspace: source,
    capabilityToken: "00000000-0000-4000-8000-000000000000", executedBy: readonly.delegation.executedBy,
  }), /DELEGATION_WRITE_DENIED/u);

  const switched = service.switchWriter({
    taskId: "task-delegate", roomId: "demo", workspace: source, expectedEpoch: 1,
    checkpoint: "Codex 子工作已停止。", candidate: { origin: "resident", provider: "claude" },
  });
  assert.deepEqual(service.writerDelegations.list("demo").map((child) => child.state), ["revoked", "revoked"]);
  assert.throws(() => service.assertDelegatedWrite({
    delegationId: writable.delegation.id, taskId: "task-delegate", roomId: "demo", workspace: source,
    capabilityToken: writable.capabilityToken!, executedBy: writable.delegation.executedBy,
  }), /DELEGATION_NOT_ACTIVE/u);
  for (const action of ["list_files", "read_file", "create_directory", "write_file"] as const) {
    service.recordWorkspaceOperation({
      taskId: "task-delegate", roomId: "demo", workspace: source,
      actor: switched.lease.writer.displayName, onBehalfOf: switched.lease.onBehalfOf,
      executedBy: switched.lease.executedBy, leaseEpoch: switched.lease.epoch,
      action, ...(action === "list_files" ? {} : { path: `src/${action}.ts` }), outcome: "succeeded",
    });
  }
  const originalGetRoom = service.ledger.getRoom.bind(service.ledger);
  service.ledger.getRoom = ((roomId: string) => {
    const room = originalGetRoom(roomId);
    return room ? { ...room, messages: 4_500 } : undefined;
  }) as typeof service.ledger.getRoom;
  service.recordWorkspaceOperation({
    taskId: "task-delegate", roomId: "demo", workspace: source,
    actor: switched.lease.writer.displayName, onBehalfOf: switched.lease.onBehalfOf,
    executedBy: switched.lease.executedBy, leaseEpoch: switched.lease.epoch,
    action: "write_file", path: "src/ledger-reserve.ts", outcome: "succeeded",
  });
  service.ledger.getRoom = originalGetRoom;
  assert.equal(service.completeWriter({
    taskId: "task-delegate", roomId: "demo", workspace: source,
    epoch: switched.lease.epoch, checkpoint: "Claude Writer 完成",
  }).state, "completed");
  assert.equal(service.revokeUnrecoverableWriters(), 0);
});
