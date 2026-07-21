import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RoomInboxStore } from "../src/core/room-inbox.ts";
import { RoomLedger } from "../src/core/room-ledger.ts";

async function fixture(t: TestContext, fakeClock = true) {
  const data = await mkdtemp(join(tmpdir(), "orchestratory-inbox-"));
  let now = Date.now();
  const inbox = new RoomInboxStore(data, {
    ...(fakeClock ? { now: () => now } : {}),
    deliveryLeaseMs: 5_000,
  });
  const ledger = new RoomLedger(data);
  ledger.createRoom("demo", "/tmp/project");
  t.after(() => inbox.close());
  t.after(() => ledger.close());
  t.after(async () => await rm(data, { recursive: true, force: true }));
  return { data, inbox, ledger, advance: (ms: number) => { now += ms; } };
}

const firstSeat = "11111111-1111-4111-8111-111111111111";
const secondSeat = "22222222-2222-4222-8222-222222222222";

test("exact-seat delivery moves through every receipt state and reply is idempotent", async (t) => {
  const { inbox, ledger } = await fixture(t);
  const mention = ledger.append("demo", "you", "@codex（前端） 請修正登入");
  const queued = inbox.enqueue({ message: mention, targetPresenceId: firstSeat, targetDisplayName: "codex（前端）" });
  assert.equal(queued.state, "queued");
  assert.equal(inbox.enqueue({ message: mention, targetPresenceId: firstSeat, targetDisplayName: "codex（前端）" }).id, queued.id);

  const claimed = await inbox.wait({ presenceId: firstSeat, roomId: "demo", timeoutMs: 100, ledger });
  assert.ok(claimed);
  assert.equal(claimed.state, "delivered");
  assert.equal(claimed.message.seq, mention.seq);
  const rawInbox = new DatabaseSync(inbox.path);
  const persistedLease = rawInbox.prepare("SELECT lease_token FROM room_deliveries WHERE id=?")
    .get(claimed.id) as { lease_token: string };
  rawInbox.close();
  assert.match(persistedLease.lease_token, /^[0-9a-f]{64}$/u);
  assert.notEqual(persistedLease.lease_token, claimed.leaseToken);
  assert.throws(
    () => inbox.ack({ presenceId: secondSeat, deliveryId: claimed.id, leaseToken: claimed.leaseToken, phase: "read" }),
    /DELIVERY_ACTOR_MISMATCH/u,
  );
  assert.equal(inbox.ack({ presenceId: firstSeat, deliveryId: claimed.id, leaseToken: claimed.leaseToken, phase: "read" }).state, "read");
  assert.equal(inbox.ack({ presenceId: firstSeat, deliveryId: claimed.id, leaseToken: claimed.leaseToken, phase: "working" }).state, "working");

  const firstReply = await inbox.reply({
    presenceId: firstSeat,
    deliveryId: claimed.id,
    leaseToken: claimed.leaseToken,
    text: "登入流程已修正",
    ledger,
    author: "codex（前端）",
  });
  assert.equal(firstReply.delivery.state, "replied");
  const replay = await inbox.reply({
    presenceId: firstSeat,
    deliveryId: claimed.id,
    leaseToken: claimed.leaseToken,
    text: "登入流程已修正",
    ledger,
    author: "codex（前端）",
  });
  assert.equal(replay.reply.seq, firstReply.reply.seq);
  await assert.rejects(
    inbox.reply({
      presenceId: firstSeat,
      deliveryId: claimed.id,
      leaseToken: "33333333-3333-4333-8333-333333333333",
      text: "登入流程已修正",
      ledger,
      author: "codex（前端）",
    }),
    /DELIVERY_LEASE_MISMATCH/u,
  );
  await assert.rejects(
    inbox.reply({
      presenceId: firstSeat,
      deliveryId: claimed.id,
      leaseToken: claimed.leaseToken,
      text: "不同回覆",
      ledger,
      author: "codex（前端）",
    }),
    /ROOM_IDEMPOTENCY_CONFLICT/u,
  );
  assert.equal(ledger.getRoom("demo")?.messages, 3);
});

test("acknowledged lease expiry retries with a rotated token, then fails after bounded attempts", async (t) => {
  const { inbox, ledger, advance } = await fixture(t);
  const mention = ledger.append("demo", "you", "@codex1 任務");
  const queued = inbox.enqueue({ message: mention, targetPresenceId: firstSeat, targetDisplayName: "codex1" });
  const tokens = new Set<string>();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const claimed = await inbox.wait({ presenceId: firstSeat, roomId: "demo", timeoutMs: 100, ledger });
    assert.ok(claimed);
    tokens.add(claimed.leaseToken);
    inbox.ack({ presenceId: firstSeat, deliveryId: claimed.id, leaseToken: claimed.leaseToken, phase: "read" });
    advance(5_001);
    const state = inbox.list("demo").find((item) => item.id === queued.id)?.state;
    assert.equal(state, attempt === 2 ? "failed" : "queued");
  }
  assert.equal(tokens.size, 3);
  assert.equal(inbox.retry(queued.id).state, "queued");
});

test("disconnect before MCP acknowledgement does not consume the retry budget", async (t) => {
  const { inbox, ledger, advance } = await fixture(t);
  const queued = inbox.enqueue({
    message: ledger.append("demo", "you", "@codex1 請收件"),
    targetPresenceId: firstSeat,
    targetDisplayName: "codex1",
  });
  for (let disconnect = 0; disconnect < 4; disconnect += 1) {
    const claimed = await inbox.wait({ presenceId: firstSeat, roomId: "demo", timeoutMs: 100, ledger });
    assert.ok(claimed);
    advance(5_001);
    const delivery = inbox.get(queued.id);
    assert.equal(delivery?.state, "queued");
    assert.equal(delivery?.attempt, 0);
  }
});

test("reply recovers idempotently when the process fails after ledger commit", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "orchestratory-inbox-crash-"));
  let now = Date.now();
  let inbox = new RoomInboxStore(data, { now: () => now, deliveryLeaseMs: 5_000 });
  let ledger = new RoomLedger(data);
  ledger.createRoom("demo", "/tmp/project");
  t.after(async () => {
    try { inbox.close(); } catch { /* process instance was already closed */ }
    try { ledger.close(); } catch { /* process instance was already closed */ }
    await rm(data, { recursive: true, force: true });
  });
  const queued = inbox.enqueue({
    message: ledger.append("demo", "you", "@codex1 請回覆"),
    targetPresenceId: firstSeat,
    targetDisplayName: "codex1",
  });
  const claimed = await inbox.wait({ presenceId: firstSeat, roomId: "demo", timeoutMs: 100, ledger });
  assert.ok(claimed);
  inbox.ack({ presenceId: firstSeat, deliveryId: queued.id, leaseToken: claimed.leaseToken, phase: "read" });
  inbox.ack({ presenceId: firstSeat, deliveryId: queued.id, leaseToken: claimed.leaseToken, phase: "working" });

  const append = ledger.appendIdempotent.bind(ledger);
  ledger.appendIdempotent = (...args) => {
    append(...args);
    throw new Error("SIMULATED_PROCESS_FAILURE");
  };
  await assert.rejects(
    inbox.reply({
      presenceId: firstSeat,
      deliveryId: queued.id,
      leaseToken: claimed.leaseToken,
      text: "原子回覆",
      ledger,
      author: "codex1",
    }),
    /SIMULATED_PROCESS_FAILURE/u,
  );
  ledger.appendIdempotent = append;

  inbox.close();
  ledger.close();
  now += 1;
  inbox = new RoomInboxStore(data, { now: () => now, deliveryLeaseMs: 5_000 });
  ledger = new RoomLedger(data);

  await assert.rejects(
    inbox.reply({
      presenceId: firstSeat,
      deliveryId: queued.id,
      leaseToken: claimed.leaseToken,
      text: "重啟後的不同回覆",
      ledger,
      author: "codex1",
    }),
    /ROOM_IDEMPOTENCY_CONFLICT/u,
  );

  const recovered = await inbox.reply({
    presenceId: firstSeat,
    deliveryId: queued.id,
    leaseToken: claimed.leaseToken,
    text: "原子回覆",
    ledger,
    author: "codex1",
  });
  assert.equal(recovered.delivery.state, "replied");
  assert.equal(recovered.reply.text, "原子回覆");
  assert.equal(ledger.getRoom("demo")?.messages, 3);
});

test("owner cancellation is terminal while working cancellation is cooperative", async (t) => {
  const { inbox, ledger } = await fixture(t);
  const first = inbox.enqueue({
    message: ledger.append("demo", "you", "@codex1 取消我"),
    targetPresenceId: firstSeat,
    targetDisplayName: "codex1",
  });
  assert.equal(inbox.cancel(first.id).state, "cancelled");
  assert.equal(inbox.retry(first.id).state, "queued");
  const claimed = await inbox.wait({ presenceId: firstSeat, roomId: "demo", timeoutMs: 100, ledger });
  assert.ok(claimed);
  inbox.ack({ presenceId: firstSeat, deliveryId: claimed.id, leaseToken: claimed.leaseToken, phase: "read" });
  inbox.ack({ presenceId: firstSeat, deliveryId: claimed.id, leaseToken: claimed.leaseToken, phase: "working" });
  const requested = inbox.cancel(first.id);
  assert.equal(requested.state, "working");
  assert.equal(requested.cancelRequested, true);
  assert.equal(inbox.fail({ presenceId: firstSeat, deliveryId: first.id, leaseToken: claimed.leaseToken, reason: "OWNER_CANCELLED" }).state, "failed");
});

test("offline exact seats fail closed instead of falling back or staying queued forever", async (t) => {
  const { inbox, ledger } = await fixture(t);
  const first = inbox.enqueue({
    message: ledger.append("demo", "you", "@codex1 任務一"),
    targetPresenceId: firstSeat,
    targetDisplayName: "codex1",
  });
  const second = inbox.enqueue({
    message: ledger.append("demo", "you", "@codex2 任務二"),
    targetPresenceId: secondSeat,
    targetDisplayName: "codex2",
  });
  const failed = inbox.failUnavailable("demo", [secondSeat]);
  assert.deepEqual(failed.map((item) => item.id), [first.id]);
  assert.equal(inbox.get(first.id)?.failReason, "SEAT_OFFLINE");
  assert.equal(inbox.get(second.id)?.state, "queued");
  assert.equal(inbox.failTarget(secondSeat, "SEAT_REMOVED_BY_OWNER")[0]?.state, "failed");
});

test("listening is true only during an active room_wait", async (t) => {
  const { inbox, ledger } = await fixture(t, false);
  const controller = new AbortController();
  const pending = inbox.wait({ presenceId: firstSeat, roomId: "demo", timeoutMs: 1_000, ledger, signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(inbox.isListening(firstSeat, "demo"), true);
  controller.abort();
  await assert.rejects(pending, /ROOM_WAIT_CANCELLED/u);
  assert.equal(inbox.isListening(firstSeat, "demo"), false);
});

test("a crashed waiter lease stops looking wakeable after its bounded TTL", async (t) => {
  const { inbox, ledger, advance } = await fixture(t);
  const controller = new AbortController();
  const pending = inbox.wait({ presenceId: firstSeat, roomId: "demo", timeoutMs: 1_000, ledger, signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(inbox.isListening(firstSeat, "demo"), true);
  advance(3_001);
  assert.equal(inbox.isListening(firstSeat, "demo"), false);
  controller.abort();
  await assert.rejects(pending, /ROOM_WAIT_CANCELLED/u);
});

test("inbox storage is owner-only and rejects tampered rows on reopen", async (t) => {
  const { data, inbox, ledger } = await fixture(t);
  assert.equal((await stat(inbox.path)).mode & 0o777, 0o600);
  inbox.enqueue({
    message: ledger.append("demo", "you", "@codex1 任務"),
    targetPresenceId: firstSeat,
    targetDisplayName: "codex1",
  });
  inbox.close();
  const raw = new DatabaseSync(join(data, "room-inbox.sqlite"));
  raw.prepare("UPDATE room_deliveries SET target_presence_id = ?").run(secondSeat);
  raw.close();
  assert.throws(() => new RoomInboxStore(data), /ROOM_INBOX_ROW_TAMPERED/u);
});

test("public inbox boundaries reject malformed or ambiguous delivery operations", async (t) => {
  const invalidLeaseData = await mkdtemp(join(tmpdir(), "orchestratory-inbox-invalid-lease-"));
  t.after(async () => await rm(invalidLeaseData, { recursive: true, force: true }));
  assert.throws(() => new RoomInboxStore(invalidLeaseData, { deliveryLeaseMs: 4_999 }), /INVALID_DELIVERY_LEASE/u);
  assert.throws(() => new RoomInboxStore(invalidLeaseData, { deliveryLeaseMs: 300_001 }), /INVALID_DELIVERY_LEASE/u);

  const { inbox, ledger } = await fixture(t);
  const mention = ledger.append("demo", "you", "@codex1 邊界測試");
  assert.throws(
    () => inbox.enqueue({ message: { ...mention, roomId: "Bad Room" }, targetPresenceId: firstSeat, targetDisplayName: "codex1" }),
    /INVALID_ROOM_ID/u,
  );
  assert.throws(
    () => inbox.enqueue({ message: mention, targetPresenceId: "not-a-presence", targetDisplayName: "codex1" }),
    /INVALID_TARGET_PRESENCE_ID/u,
  );
  assert.throws(
    () => inbox.enqueue({ message: mention, targetPresenceId: firstSeat, targetDisplayName: "" }),
    /INVALID_TARGET_DISPLAY_NAME/u,
  );
  assert.throws(
    () => inbox.enqueue({ message: { ...mention, hash: "bad" }, targetPresenceId: firstSeat, targetDisplayName: "codex1" }),
    /INVALID_DELIVERY_LEDGER_MESSAGE/u,
  );
  assert.throws(
    () => inbox.enqueue({ message: mention, targetPresenceId: firstSeat, targetDisplayName: "codex1", taskId: "" }),
    /INVALID_DELIVERY_TASK_ID/u,
  );

  const queued = inbox.enqueue({ message: mention, targetPresenceId: firstSeat, targetDisplayName: "codex1", taskId: "task-1" });
  assert.throws(
    () => inbox.enqueue({ message: mention, targetPresenceId: firstSeat, targetDisplayName: "codex-other", taskId: "task-1" }),
    /ROOM_DELIVERY_IDEMPOTENCY_CONFLICT/u,
  );
  assert.throws(() => inbox.retry(queued.id), /DELIVERY_NOT_RETRYABLE/u);
  assert.throws(() => inbox.cancel("33333333-3333-4333-8333-333333333333"), /DELIVERY_NOT_FOUND/u);
  assert.throws(() => inbox.get("bad"), /INVALID_DELIVERY_ID/u);
  assert.equal(inbox.get("33333333-3333-4333-8333-333333333333"), undefined);
  assert.throws(() => inbox.list("Bad Room"), /INVALID_ROOM_ID/u);
  assert.throws(() => inbox.isListening("bad", "demo"), /INVALID_PRESENCE_ID/u);
  assert.throws(() => inbox.failTarget(firstSeat, ""), /INVALID_DELIVERY_FAILURE_REASON/u);
  assert.throws(() => inbox.failUnavailable("demo", ["bad"]), /INVALID_PRESENCE_ID/u);
  assert.equal(inbox.inventory().deliveries, 1);
  assert.deepEqual(inbox.integrity(), { schemaVersion: 3, quickCheck: "ok", stateValid: true });

  await assert.rejects(
    inbox.wait({ presenceId: firstSeat, roomId: "demo", timeoutMs: 0, ledger }),
    /INVALID_ROOM_WAIT_TIMEOUT/u,
  );
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    inbox.wait({ presenceId: secondSeat, roomId: "demo", timeoutMs: 100, ledger, signal: aborted.signal }),
    /ROOM_WAIT_CANCELLED/u,
  );
  await assert.rejects(
    inbox.reply({ presenceId: firstSeat, deliveryId: queued.id, leaseToken: firstSeat, text: " ", ledger, author: "codex1" }),
    /INVALID_ROOM_MESSAGE/u,
  );
  await assert.rejects(
    inbox.reply({ presenceId: firstSeat, deliveryId: queued.id, leaseToken: firstSeat, text: "reply", ledger, author: "system" }),
    /INVALID_ROOM_AUTHOR/u,
  );
  assert.throws(
    () => inbox.fail({ presenceId: firstSeat, deliveryId: queued.id, leaseToken: firstSeat, reason: "" }),
    /INVALID_DELIVERY_FAILURE_REASON/u,
  );
});
