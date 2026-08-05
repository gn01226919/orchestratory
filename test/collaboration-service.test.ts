import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { CollaborationService } from "../src/core/collaboration-service.ts";

const execFileAsync = promisify(execFile);
const ROOM_FIRST_JOIN = { collaborationMode: "room-first" as const, syncTurns: true };
/** One fresh durable idempotency key per logical candidate call. */
const key = (): string => randomUUID();

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
  assert.equal(offDutyView?.standbyRequested, false);
  assert.equal(offDutyView?.standbyApproved, false);

  assert.throws(() => gui.postToExternal({
    roomId: "demo", workspace: "/tmp/project", presenceId: external.id, text: "尚未核准待命",
  }), /TARGET_AGENT_STANDBY_NOT_APPROVED/u);

  const standby = mcp.requestExternalStandby(external.id, "demo", "/tmp/project");
  assert.equal(standby.standbyRequested, true);
  assert.equal(gui.roomView("demo", "/tmp/project").sessions[0]?.wakeable, false);
  gui.approveExternalStandby(external.id, "demo", "/tmp/project");
  assert.equal(gui.roomView("demo", "/tmp/project").sessions[0]?.standbyApproved, true);

  const pendingWait = mcp.waitExternal({ presenceId: external.id, roomId: "demo", timeoutMs: 1_000 });
  for (let attempt = 0; attempt < 20 && !gui.roomView("demo", "/tmp/project").sessions[0]?.wakeable; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const posted = gui.postToExternal({
    roomId: "demo", workspace: "/tmp/project", presenceId: external.id, text: "請修正登入",
  });
  assert.deepEqual(posted.dispatch, {
    wakeMode: "active-tool-pull",
    wakeable: true,
    immediate: true,
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
  const claimed = await pendingWait;
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
  const nextWait = mcp.waitExternal({ presenceId: external.id, roomId: "demo", timeoutMs: 1_000 });
  for (let attempt = 0; attempt < 20 && !gui.roomView("demo", "/tmp/project").sessions[0]?.wakeable; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const failing = gui.postToExternal({
    roomId: "demo", workspace: "/tmp/project", presenceId: external.id, text: "請執行失敗案例",
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
  const failingClaim = await nextWait;
  assert.ok(failingClaim);
  assert.equal(mcp.failExternal({
    presenceId: external.id, deliveryId: failing.delivery.id,
    leaseToken: failingClaim.leaseToken, reason: "synthetic failure",
  }).state, "failed");
  gui.revokeExternalStandby(external.id, "demo", "/tmp/project");
  assert.equal(gui.roomView("demo", "/tmp/project").sessions[0]?.standbyApproved, false);
  mcp.unregisterExternal(external.id, "test finished");
  assert.equal(gui.reconcileExternalPresence("demo", "/tmp/project").length, 0);
});

test("exact terminal seats exchange authenticated multi-turn threads without provider fallback", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "orchestratory-peer-thread-"));
  const codexProcess = new CollaborationService(data);
  const claudeProcess = new CollaborationService(data);
  t.after(() => codexProcess.close());
  t.after(() => claudeProcess.close());
  t.after(async () => await rm(data, { recursive: true, force: true }));

  codexProcess.ledger.createRoom("demo", "/tmp/project");
  const codex = codexProcess.registerExternal({
    provider: "codex", workspace: "/tmp/project", hostPid: 7201,
  });
  const claude = claudeProcess.registerExternal({
    provider: "claude", workspace: "/tmp/project", hostPid: 7202,
  });
  for (const seat of [codex, claude]) {
    codexProcess.requestExternalJoin(seat.id, "demo", "/tmp/project");
    codexProcess.approveExternalJoin({
      ...ROOM_FIRST_JOIN,
      presenceId: seat.id,
      roomId: "demo",
      workspace: "/tmp/project",
      label: seat.provider,
    });
    codexProcess.requestExternalStandby(seat.id, "demo", "/tmp/project");
    codexProcess.approveExternalStandby(seat.id, "demo", "/tmp/project");
  }

  const firstRequestId = randomUUID();
  const firstInput = {
    roomId: "demo",
    workspace: "/tmp/project",
    sourcePresenceId: codex.id,
    targetPresenceId: claude.id,
    clientRequestId: firstRequestId,
    text: "請檢查登入修正",
    taskId: "login-task",
  };
  const first = codexProcess.postBetweenExternals(firstInput);
  const firstRetry = codexProcess.postBetweenExternals(firstInput);
  assert.equal(firstRetry.delivery.id, first.delivery.id);
  assert.equal(firstRetry.message.seq, first.message.seq);
  const claudeWait = claudeProcess.waitExternal({
    presenceId: claude.id, roomId: "demo", timeoutMs: 1_000,
  });
  assert.equal(first.message.author, "codex（codex）");
  assert.equal(first.delivery.sourcePresenceId, codex.id);
  assert.equal(first.delivery.sourceDisplayName, "codex（codex）");
  assert.equal(first.delivery.targetPresenceId, claude.id);

  const claimedByClaude = await claudeWait;
  assert.ok(claimedByClaude);
  assert.equal(claimedByClaude.sourcePresenceId, codex.id);
  assert.equal(claimedByClaude.threadId, first.delivery.threadId);
  claudeProcess.ackExternal({
    presenceId: claude.id, deliveryId: claimedByClaude.id,
    leaseToken: claimedByClaude.leaseToken, phase: "read",
  });
  claudeProcess.ackExternal({
    presenceId: claude.id, deliveryId: claimedByClaude.id,
    leaseToken: claimedByClaude.leaseToken, phase: "working",
  });
  await claudeProcess.replyExternal({
    presenceId: claude.id,
    deliveryId: claimedByClaude.id,
    leaseToken: claimedByClaude.leaseToken,
    text: "已檢查，請補一個回歸測試",
  });
  const firstOutcome = await codexProcess.waitForExternalReply({
    presenceId: codex.id, deliveryId: first.delivery.id, timeoutMs: 1_000,
  });
  assert.equal(firstOutcome?.delivery.state, "replied");
  assert.equal(firstOutcome?.reply?.author, "claude（claude）");

  const followUp = claudeProcess.postBetweenExternals({
    roomId: "demo",
    workspace: "/tmp/project",
    sourcePresenceId: claude.id,
    targetPresenceId: codex.id,
    clientRequestId: randomUUID(),
    text: "回歸測試補好了嗎？",
    threadId: first.delivery.threadId,
    replyToDeliveryId: first.delivery.id,
    taskId: "login-task",
  });
  const codexWait = codexProcess.waitExternal({
    presenceId: codex.id, roomId: "demo", timeoutMs: 1_000,
  });
  assert.equal(followUp.delivery.threadId, first.delivery.threadId);
  assert.equal(followUp.delivery.replyToDeliveryId, first.delivery.id);
  const claimedByCodex = await codexWait;
  assert.ok(claimedByCodex);
  assert.equal(claimedByCodex.sourcePresenceId, claude.id);
  assert.equal(claimedByCodex.threadId, first.delivery.threadId);
  await assert.rejects(
    claudeProcess.waitForExternalReply({
      presenceId: codex.id, deliveryId: followUp.delivery.id, timeoutMs: 1,
    }),
    /DELIVERY_NOT_FOUND/u,
  );
  codexProcess.ackExternal({
    presenceId: codex.id, deliveryId: claimedByCodex.id,
    leaseToken: claimedByCodex.leaseToken, phase: "read",
  });
  codexProcess.ackExternal({
    presenceId: codex.id, deliveryId: claimedByCodex.id,
    leaseToken: claimedByCodex.leaseToken, phase: "working",
  });
  await codexProcess.replyExternal({
    presenceId: codex.id,
    deliveryId: claimedByCodex.id,
    leaseToken: claimedByCodex.leaseToken,
    text: "已補回歸測試",
  });
  assert.equal((await claudeProcess.waitForExternalReply({
    presenceId: claude.id, deliveryId: followUp.delivery.id, timeoutMs: 1_000,
  }))?.delivery.state, "replied");

  let previous = followUp.delivery;
  for (let turn = 3; turn <= 20; turn += 1) {
    const codexIsSource = turn % 2 === 1;
    const sourceService = codexIsSource ? codexProcess : claudeProcess;
    const targetService = codexIsSource ? claudeProcess : codexProcess;
    const sourceSeat = codexIsSource ? codex : claude;
    const targetSeat = codexIsSource ? claude : codex;
    const sent = sourceService.postBetweenExternals({
      roomId: "demo",
      workspace: "/tmp/project",
      sourcePresenceId: sourceSeat.id,
      targetPresenceId: targetSeat.id,
      clientRequestId: randomUUID(),
      text: `無固定上限驗收第 ${turn} 輪`,
      threadId: first.delivery.threadId,
      replyToDeliveryId: previous.id,
      taskId: "login-task",
    });
    const claimed = await targetService.waitExternal({
      presenceId: targetSeat.id, roomId: "demo", timeoutMs: 1_000,
    });
    assert.ok(claimed);
    targetService.ackExternal({
      presenceId: targetSeat.id, deliveryId: claimed.id,
      leaseToken: claimed.leaseToken, phase: "read",
    });
    targetService.ackExternal({
      presenceId: targetSeat.id, deliveryId: claimed.id,
      leaseToken: claimed.leaseToken, phase: "working",
    });
    await targetService.replyExternal({
      presenceId: targetSeat.id,
      deliveryId: claimed.id,
      leaseToken: claimed.leaseToken,
      text: `第 ${turn} 輪已回覆`,
    });
    const outcome = await sourceService.waitForExternalReply({
      presenceId: sourceSeat.id, deliveryId: sent.delivery.id, timeoutMs: 1_000,
    });
    assert.equal(outcome?.delivery.state, "replied");
    assert.equal(sent.delivery.threadId, first.delivery.threadId);
    previous = sent.delivery;
  }
  const grok = codexProcess.registerExternal({
    provider: "grok", workspace: "/tmp/project", hostPid: 7203,
  });
  codexProcess.requestExternalJoin(grok.id, "demo", "/tmp/project");
  codexProcess.approveExternalJoin({
    ...ROOM_FIRST_JOIN,
    presenceId: grok.id,
    roomId: "demo",
    workspace: "/tmp/project",
    label: grok.provider,
  });
  codexProcess.requestExternalStandby(grok.id, "demo", "/tmp/project");
  codexProcess.approveExternalStandby(grok.id, "demo", "/tmp/project");
  const messagesBeforeRejectedRoutes = codexProcess.ledger.getRoom("demo")?.messages;
  assert.throws(
    () => codexProcess.postBetweenExternals({
      roomId: "demo",
      workspace: "/tmp/project",
      sourcePresenceId: grok.id,
      targetPresenceId: codex.id,
      clientRequestId: randomUUID(),
      text: "第三席不可插入既有 thread",
      threadId: first.delivery.threadId,
      replyToDeliveryId: previous.id,
      taskId: "login-task",
    }),
    /THREAD_PARTICIPANT_MISMATCH/u,
  );
  assert.throws(
    () => codexProcess.postBetweenExternals({
      roomId: "demo",
      workspace: "/tmp/project",
      sourcePresenceId: codex.id,
      targetPresenceId: claude.id,
      clientRequestId: randomUUID(),
      text: "不可偷換 task",
      threadId: first.delivery.threadId,
      replyToDeliveryId: previous.id,
      taskId: "different-task",
    }),
    /THREAD_TASK_MISMATCH/u,
  );
  assert.throws(
    () => codexProcess.postBetweenExternals({
      roomId: "demo",
      workspace: "/tmp/project",
      sourcePresenceId: codex.id,
      targetPresenceId: claude.id,
      clientRequestId: randomUUID(),
      text: "reply-to 不能省略 thread ID",
      replyToDeliveryId: previous.id,
      taskId: "login-task",
    }),
    /THREAD_CONTINUATION_FIELDS_MISMATCH/u,
  );
  assert.equal(codexProcess.ledger.getRoom("demo")?.messages, messagesBeforeRejectedRoutes);
});

test("exact native seat owns a durable candidate lifecycle while main remains untouched", async (t) => {
  const source = await repository("orchestratory-candidate-service-source-");
  const data = await mkdtemp(join(tmpdir(), "orchestratory-candidate-service-data-"));
  const service = new CollaborationService(data);
  t.after(() => service.close());
  t.after(async () => await rm(data, { recursive: true, force: true }));
  t.after(async () => await rm(source, { recursive: true, force: true }));
  service.ledger.createRoom("demo", source);
  const seat = service.registerExternal({ provider: "codex", workspace: source, hostPid: 7_777 });
  service.requestExternalJoin(seat.id, "demo", source);
  service.approveExternalJoin({
    ...ROOM_FIRST_JOIN, presenceId: seat.id, roomId: "demo", workspace: source, label: "candidate",
  });
  await writeFile(join(source, "owner-draft.txt"), "preserve me\n", "utf8");
  const mainHead = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: source })).stdout.trim();

  const candidate = await service.startCandidate({
    presenceId: seat.id, clientRequestId: key(), roomId: "demo", workspace: source,
    task: "Implement without touching main", acceptanceCriteria: "owner draft survives",
  });
  assert.equal(candidate.baseline.clean, false);
  await writeFile(join(candidate.candidatePath, "implemented.txt"), "candidate only\n", "utf8");
  await execFileAsync("git", ["add", "implemented.txt"], { cwd: candidate.candidatePath });
  await execFileAsync("git", [
    "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "commit", "-m", "candidate implementation",
  ], { cwd: candidate.candidatePath });
  const checkpoint = await service.checkpointCandidate({
    presenceId: seat.id, clientRequestId: key(), roomId: "demo", workspace: source,
    taskId: candidate.taskId, summary: "committed checkpoint",
  });
  const completed = await service.completeCandidate({
    presenceId: seat.id, clientRequestId: key(), roomId: "demo", workspace: source,
    taskId: candidate.taskId, summary: "ready for owner",
    tests: [{ command: "node --test", status: "passed" }], knownRisks: [],
  });
  assert.equal(checkpoint.candidateHead, completed.completion.preview.candidateHead);
  assert.equal(completed.completion.mergeDecision, "owner-required");
  assert.equal((await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: source })).stdout.trim(), mainHead);
  assert.equal(await readFile(join(source, "owner-draft.txt"), "utf8"), "preserve me\n");
  assert.equal((await service.candidateStatus({
    presenceId: seat.id, roomId: "demo", workspace: source, taskId: candidate.taskId,
  }))[0]?.status, "completed");
  assert.deepEqual(
    service.audit.list({ roomId: "demo", limit: 20 }).filter((event) => event.taskId === candidate.taskId)
      .map((event) => event.type),
    ["candidate.started", "candidate.checkpointed", "candidate.completed"],
  );
  const roomMessages = service.ledger.getRoom("demo")?.messages ?? 0;
  assert.match(service.ledger.getRange("demo", 1, roomMessages).map((entry) => entry.text).join("\n"), /Owner 明確核准/u);
  await assert.rejects(
    service.candidateStatus({ presenceId: randomUUID(), roomId: "demo", workspace: source }),
    /PRESENCE_NOT_FOUND/u,
  );
});

test("target unregister races cannot leave a new exact-seat delivery active", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "orchestratory-peer-offline-race-"));
  const senderProcess = new CollaborationService(data);
  const targetProcess = new CollaborationService(data);
  t.after(() => senderProcess.close());
  t.after(() => targetProcess.close());
  t.after(async () => await rm(data, { recursive: true, force: true }));
  senderProcess.ledger.createRoom("demo", "/tmp/project");
  const sender = senderProcess.registerExternal({
    provider: "codex", workspace: "/tmp/project", hostPid: 7401,
  });
  const admit = (seat: ReturnType<CollaborationService["registerExternal"]>) => {
    senderProcess.requestExternalJoin(seat.id, "demo", "/tmp/project");
    senderProcess.approveExternalJoin({
      ...ROOM_FIRST_JOIN,
      presenceId: seat.id,
      roomId: "demo",
      workspace: "/tmp/project",
      label: seat.provider,
    });
    senderProcess.requestExternalStandby(seat.id, "demo", "/tmp/project");
    senderProcess.approveExternalStandby(seat.id, "demo", "/tmp/project");
  };
  admit(sender);

  const firstTarget = targetProcess.registerExternal({
    provider: "claude", workspace: "/tmp/project", hostPid: 7402,
  });
  admit(firstTarget);
  const append = senderProcess.ledger.appendIdempotent.bind(senderProcess.ledger);
  senderProcess.ledger.appendIdempotent = (...args) => {
    const message = append(...args);
    targetProcess.unregisterExternal(firstTarget.id);
    return message;
  };
  assert.throws(
    () => senderProcess.postBetweenExternals({
      roomId: "demo",
      workspace: "/tmp/project",
      sourcePresenceId: sender.id,
      targetPresenceId: firstTarget.id,
      clientRequestId: randomUUID(),
      text: "append 後 target 離線",
    }),
    /TARGET_AGENT_OFFLINE/u,
  );
  senderProcess.ledger.appendIdempotent = append;
  assert.equal(senderProcess.presence.get(firstTarget.id), undefined);
  assert.equal(senderProcess.inbox.list("demo").some((item) => item.targetPresenceId === firstTarget.id), false);

  const secondTarget = targetProcess.registerExternal({
    provider: "claude", workspace: "/tmp/project", hostPid: 7403,
  });
  admit(secondTarget);
  const enqueue = senderProcess.inbox.enqueue.bind(senderProcess.inbox);
  senderProcess.inbox.enqueue = (...args) => {
    const delivery = enqueue(...args);
    targetProcess.unregisterExternal(secondTarget.id);
    return delivery;
  };
  assert.throws(
    () => senderProcess.postBetweenExternals({
      roomId: "demo",
      workspace: "/tmp/project",
      sourcePresenceId: sender.id,
      targetPresenceId: secondTarget.id,
      clientRequestId: randomUUID(),
      text: "enqueue 後 target 離線",
    }),
    /TARGET_AGENT_OFFLINE/u,
  );
  senderProcess.inbox.enqueue = enqueue;
  const raced = senderProcess.inbox.list("demo").find((item) => item.targetPresenceId === secondTarget.id);
  assert.equal(raced?.state, "failed");
  assert.equal(senderProcess.inbox.list("demo").some(
    (item) => item.targetPresenceId === secondTarget.id && ["queued", "delivered", "read", "working"].includes(item.state),
  ), false);

  const thirdTarget = targetProcess.registerExternal({
    provider: "claude", workspace: "/tmp/project", hostPid: 7404,
  });
  admit(thirdTarget);
  senderProcess.ledger.appendIdempotent = (...args) => {
    const message = append(...args);
    targetProcess.unregisterExternal(sender.id);
    return message;
  };
  assert.throws(
    () => senderProcess.postBetweenExternals({
      roomId: "demo",
      workspace: "/tmp/project",
      sourcePresenceId: sender.id,
      targetPresenceId: thirdTarget.id,
      clientRequestId: randomUUID(),
      text: "append 後 source 離線",
    }),
    /SOURCE_AGENT_OFFLINE/u,
  );
  senderProcess.ledger.appendIdempotent = append;
  assert.equal(senderProcess.inbox.list("demo").some((item) => item.targetPresenceId === thirdTarget.id), false);

  const secondSender = senderProcess.registerExternal({
    provider: "codex", workspace: "/tmp/project", hostPid: 7405,
  });
  admit(secondSender);
  senderProcess.inbox.enqueue = (...args) => {
    const delivery = enqueue(...args);
    targetProcess.unregisterExternal(secondSender.id);
    return delivery;
  };
  assert.throws(
    () => senderProcess.postBetweenExternals({
      roomId: "demo",
      workspace: "/tmp/project",
      sourcePresenceId: secondSender.id,
      targetPresenceId: thirdTarget.id,
      clientRequestId: randomUUID(),
      text: "enqueue 後 source 離線",
    }),
    /SOURCE_AGENT_OFFLINE/u,
  );
  senderProcess.inbox.enqueue = enqueue;
  const sourceRaced = senderProcess.inbox.list("demo").find(
    (item) => item.sourcePresenceId === secondSender.id && item.targetPresenceId === thirdTarget.id,
  );
  assert.equal(sourceRaced?.state, "cancelled");
});

test("abnormal target death is reconciled by reply wait and room visibility without presence polling", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "orchestratory-peer-crash-reconcile-"));
  const service = new CollaborationService(data);
  t.after(() => service.close());
  t.after(async () => await rm(data, { recursive: true, force: true }));
  service.ledger.createRoom("demo", "/tmp/project");
  const admit = (provider: "codex" | "claude", hostPid: number) => {
    const seat = service.registerExternal({ provider, workspace: "/tmp/project", hostPid });
    service.requestExternalJoin(seat.id, "demo", "/tmp/project");
    service.approveExternalJoin({
      ...ROOM_FIRST_JOIN,
      presenceId: seat.id,
      roomId: "demo",
      workspace: "/tmp/project",
      label: provider,
    });
    service.requestExternalStandby(seat.id, "demo", "/tmp/project");
    service.approveExternalStandby(seat.id, "demo", "/tmp/project");
    return seat;
  };
  const source = admit("codex", 7501);
  const waitTarget = admit("claude", 7502);
  const waiting = service.postBetweenExternals({
    roomId: "demo",
    workspace: "/tmp/project",
    sourcePresenceId: source.id,
    targetPresenceId: waitTarget.id,
    clientRequestId: randomUUID(),
    text: "target crash should fail during reply wait",
  });

  service.presence.unregister(waitTarget.id);
  const outcome = await service.waitForExternalReply({
    presenceId: source.id,
    deliveryId: waiting.delivery.id,
    timeoutMs: 1_000,
  });
  assert.equal(outcome?.delivery.state, "failed");
  assert.equal(outcome?.delivery.failReason, "TARGET_SEAT_OFFLINE_DURING_REPLY_WAIT");

  const visibleTarget = admit("claude", 7503);
  const visible = service.postBetweenExternals({
    roomId: "demo",
    workspace: "/tmp/project",
    sourcePresenceId: source.id,
    targetPresenceId: visibleTarget.id,
    clientRequestId: randomUUID(),
    text: "target crash should fail when room becomes visible",
  });
  service.presence.unregister(visibleTarget.id);
  const reconciled = service.roomView("demo", "/tmp/project").deliveries.find(
    (delivery) => delivery.id === visible.delivery.id,
  );
  assert.equal(reconciled?.state, "failed");
  assert.equal(reconciled?.failReason, "SEAT_OFFLINE");

  const raceTarget = admit("claude", 7504);
  const oldDelivery = service.postBetweenExternals({
    roomId: "demo",
    workspace: "/tmp/project",
    sourcePresenceId: source.id,
    targetPresenceId: raceTarget.id,
    clientRequestId: randomUUID(),
    text: "only the delivery observed before rejoin may fail",
  });
  service.presence.leave(raceTarget.id, "demo");
  const preciseFail = service.inbox.failDeliveryIfTargetUnavailable.bind(service.inbox);
  let newDelivery: ReturnType<CollaborationService["postBetweenExternals"]> | undefined;
  service.inbox.failDeliveryIfTargetUnavailable = (input) => {
    if (!newDelivery) {
      service.requestExternalJoin(raceTarget.id, "demo", "/tmp/project");
      service.approveExternalJoin({
        ...ROOM_FIRST_JOIN,
        presenceId: raceTarget.id,
        roomId: "demo",
        workspace: "/tmp/project",
        label: "claude",
      });
      service.requestExternalStandby(raceTarget.id, "demo", "/tmp/project");
      service.approveExternalStandby(raceTarget.id, "demo", "/tmp/project");
      newDelivery = service.postBetweenExternals({
        roomId: "demo",
        workspace: "/tmp/project",
        sourcePresenceId: source.id,
        targetPresenceId: raceTarget.id,
        clientRequestId: randomUUID(),
        text: "new work after exact-seat rejoin must survive stale reconciliation",
      });
    }
    return preciseFail(input);
  };
  const raceView = service.roomView("demo", "/tmp/project");
  service.inbox.failDeliveryIfTargetUnavailable = preciseFail;
  assert.equal(raceView.deliveries.find((item) => item.id === oldDelivery.delivery.id)?.state, "failed");
  assert.equal(raceView.deliveries.find((item) => item.id === newDelivery?.delivery.id)?.state, "queued");
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

test("vNext revokes persisted external Writer capabilities and runs while preserving managed leases", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "orchestratory-collaboration-legacy-external-"));
  const service = new CollaborationService(data);
  t.after(() => service.close());
  t.after(async () => await rm(data, { recursive: true, force: true }));
  service.ledger.createRoom("demo", "/tmp/project");

  const legacy = service.writerLeases.grant({
    taskId: "legacy-external",
    roomId: "demo",
    workspace: "/tmp/project",
    worktree: "/tmp/project-legacy-external",
    writer: {
      origin: "external",
      provider: "codex",
      actorId: "codex-legacy-seat",
      displayName: "codex（legacy）",
    },
  });
  const writableChild = service.writerDelegations.create({
    parent: legacy.lease,
    childProvider: "codex",
    label: "legacy-write",
    workspace: legacy.lease.worktree,
  });
  const readonlyChild = service.writerDelegations.create({
    parent: legacy.lease,
    childProvider: "claude",
    label: "legacy-review",
    workspace: legacy.lease.worktree,
  });
  const legacyRunId = "00000000-0000-4000-8000-000000000078";
  service.writerLeases.beginRun(legacy.lease.taskId, legacyRunId, "legacy-gui");

  assert.throws(() => service.assertWriterWrite({
    taskId: legacy.lease.taskId,
    roomId: "demo",
    workspace: "/tmp/project",
    epoch: legacy.lease.epoch,
    capabilityToken: legacy.capabilityToken,
    executedBy: legacy.lease.executedBy,
  }), /NATIVE_EXTERNAL_WRITER_LEASE_UNSUPPORTED/u);
  assert.throws(() => service.assertDelegatedWrite({
    delegationId: writableChild.delegation.id,
    taskId: legacy.lease.taskId,
    roomId: "demo",
    workspace: "/tmp/project",
    capabilityToken: writableChild.capabilityToken!,
    executedBy: writableChild.delegation.executedBy,
  }), /NATIVE_EXTERNAL_WRITER_LEASE_UNSUPPORTED/u);
  assert.throws(() => service.assertDelegatedRead({
    delegationId: readonlyChild.delegation.id,
    taskId: legacy.lease.taskId,
    roomId: "demo",
    workspace: "/tmp/project",
    executedBy: readonlyChild.delegation.executedBy,
  }), /NATIVE_EXTERNAL_WRITER_LEASE_UNSUPPORTED/u);

  const managed = service.writerLeases.grant({
    taskId: "managed-live",
    roomId: "demo",
    workspace: "/tmp/project",
    worktree: "/tmp/project-managed-live",
    writer: {
      origin: "managed",
      provider: "claude",
      actorId: "managed-claude",
      displayName: "claude（managed）",
    },
  });
  const managedRunId = "00000000-0000-4000-8000-000000000079";
  service.writerLeases.beginRun(managed.lease.taskId, managedRunId, "current-gui");

  assert.equal(service.revokeUnrecoverableWriters(), 1);
  assert.equal(service.writerLeases.current(legacy.lease.taskId), undefined);
  assert.equal(service.writerLeases.hasActiveRun(legacy.lease.taskId), false);
  assert.throws(
    () => service.writerLeases.heartbeatRun(legacy.lease.taskId, legacyRunId, "legacy-gui"),
    /WRITER_RUN_LOCK_LOST/u,
  );
  assert.equal(service.writerLeases.current(managed.lease.taskId)?.id, managed.lease.id);
  assert.equal(service.writerLeases.hasActiveRun(managed.lease.taskId), true);
  assert.deepEqual(
    service.writerDelegations.list("demo")
      .filter((delegation) => delegation.parentLeaseId === legacy.lease.id)
      .map((delegation) => delegation.state),
    ["revoked", "revoked"],
  );
  assert.equal(service.writerLeases.taskScope(legacy.lease.taskId)?.worktree, legacy.lease.worktree);
  const revocation = service.audit.list({ roomId: "demo" })
    .find((event) => event.action === "revoke-legacy-external");
  assert.equal(revocation?.outcome, "succeeded");
  assert.equal((revocation?.detail as { terminatedRun?: boolean }).terminatedRun, true);

  service.writerLeases.finishRun(managed.lease.taskId, managedRunId, "current-gui");
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
  service.requestExternalStandby(first.id, "first", "/tmp/project");
  service.approveExternalStandby(first.id, "first", "/tmp/project");
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
    candidate: { origin: "external", actorId: external.id } as never,
  }), /WRITER_CANDIDATE_NOT_ELIGIBLE/u);
  service.requestExternalJoin(external.id, "demo", source);
  const joined = service.approveExternalJoin({ ...ROOM_FIRST_JOIN, presenceId: external.id, roomId: "demo", workspace: source, label: "修復" });
  const nativeView = service.roomView("demo", source).sessions.find((session) => session.id === joined.id);
  assert.equal(nativeView?.executionClass, "native-full-trust");
  assert.equal(nativeView?.capabilityAuthority, "host");
  assert.equal(nativeView?.hostCapabilities, "unchanged");
  await assert.rejects(service.grantWriter({
    taskId: "task-1", roomId: "demo", workspace: source,
    candidate: { origin: "external", actorId: external.id } as never,
  }), /WRITER_CANDIDATE_NOT_ELIGIBLE/u);
  const granted = await service.grantWriter({
    taskId: "task-1", roomId: "demo", workspace: source,
    candidate: { origin: "resident", provider: "codex" },
  });
  assert.equal(granted.lease.writer.displayName, "codex");
  assert.equal(granted.lease.executedBy, "codex");

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

  service.removeExternal({ presenceId: external.id, roomId: "demo", workspace: source });
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
