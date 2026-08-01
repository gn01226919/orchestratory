import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
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
const thirdSeat = "33333333-3333-4333-8333-333333333333";
const execFileAsync = promisify(execFile);

test("schema v3 deliveries migrate transactionally into v4 threads", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "orchestratory-inbox-v3-"));
  t.after(async () => await rm(data, { recursive: true, force: true }));
  const ledger = new RoomLedger(data);
  ledger.createRoom("demo", "/tmp/project");
  const store = new RoomInboxStore(data);
  const message = ledger.append("demo", "you", "@codex1 legacy task");
  const delivery = store.enqueue({
    message,
    targetPresenceId: firstSeat,
    targetDisplayName: "codex1",
    taskId: "legacy-task",
  });
  const path = store.path;
  store.close();
  ledger.close();

  const raw = new DatabaseSync(path);
  const current = raw.prepare("SELECT * FROM room_deliveries WHERE id = ?").get(delivery.id) as Record<string, unknown>;
  const v3Hash = createHash("sha256").update(JSON.stringify([
    current.id, current.room_id, current.ledger_seq, current.ledger_hash,
    current.target_presence_id, current.target_display_name, current.state,
    current.attempt, current.max_attempts, current.lease_token,
    current.lease_expires_at_ms, current.cancel_requested, current.reply_key,
    current.reply_author, current.reply_input_hash, current.completion_token_hash,
    current.reply_ledger_seq, current.fail_reason, current.task_id,
    current.created_at_ms, current.updated_at_ms,
  ]), "utf8").digest("hex");
  raw.exec(`
    BEGIN IMMEDIATE;
    ALTER TABLE room_deliveries RENAME TO room_deliveries_v4;
    CREATE TABLE room_deliveries (
      id TEXT PRIMARY KEY, room_id TEXT NOT NULL, ledger_seq INTEGER NOT NULL,
      ledger_hash TEXT NOT NULL, target_presence_id TEXT NOT NULL,
      target_display_name TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('queued','delivered','read','working','replied','failed','cancelled')),
      attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt BETWEEN 0 AND 100),
      max_attempts INTEGER NOT NULL CHECK (max_attempts BETWEEN 1 AND 10),
      lease_token TEXT, lease_expires_at_ms INTEGER,
      cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0,1)),
      reply_key TEXT, reply_author TEXT, reply_input_hash TEXT,
      completion_token_hash TEXT, reply_ledger_seq INTEGER, fail_reason TEXT,
      task_id TEXT, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
      row_hash TEXT NOT NULL, UNIQUE(room_id, ledger_seq, target_presence_id),
      CHECK ((lease_token IS NULL) = (lease_expires_at_ms IS NULL))
    );
  `);
  raw.prepare(`INSERT INTO room_deliveries
    (id,room_id,ledger_seq,ledger_hash,target_presence_id,target_display_name,state,
     attempt,max_attempts,lease_token,lease_expires_at_ms,cancel_requested,reply_key,
     reply_author,reply_input_hash,completion_token_hash,reply_ledger_seq,fail_reason,
     task_id,created_at_ms,updated_at_ms,row_hash)
    SELECT id,room_id,ledger_seq,ledger_hash,target_presence_id,target_display_name,state,
     attempt,max_attempts,lease_token,lease_expires_at_ms,cancel_requested,reply_key,
     reply_author,reply_input_hash,completion_token_hash,reply_ledger_seq,fail_reason,
     task_id,created_at_ms,updated_at_ms,?
    FROM room_deliveries_v4 WHERE id=?`).run(v3Hash, delivery.id);
  raw.exec(`
    DROP TABLE room_deliveries_v4;
    CREATE INDEX room_deliveries_target_queue
      ON room_deliveries(target_presence_id, room_id, state, created_at_ms);
    PRAGMA user_version = 3;
    COMMIT;
  `);
  raw.close();
  await chmod(path, 0o600);

  const tampered = new DatabaseSync(path);
  tampered.prepare("UPDATE room_deliveries SET target_display_name = ? WHERE id = ?")
    .run("attacker", delivery.id);
  tampered.close();
  assert.throws(() => new RoomInboxStore(data), /ROOM_INBOX_ROW_TAMPERED/u);
  const restored = new DatabaseSync(path);
  restored.prepare("UPDATE room_deliveries SET target_display_name = ? WHERE id = ?")
    .run("codex1", delivery.id);
  restored.close();

  const migrated = new RoomInboxStore(data);
  t.after(() => migrated.close());
  assert.deepEqual(migrated.integrity(), { schemaVersion: 4, quickCheck: "ok", stateValid: true });
  assert.equal(migrated.get(delivery.id)?.threadId, delivery.id);
  assert.equal(migrated.get(delivery.id)?.sourcePresenceId, undefined);
  const migratedSchema = new DatabaseSync(path, { readOnly: true });
  const thread = migratedSchema.prepare("PRAGMA table_info(room_deliveries)").all()
    .find((column) => column.name === "thread_id") as { notnull: number };
  const ddl = migratedSchema.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='room_deliveries'")
    .get() as { sql: string };
  migratedSchema.close();
  assert.equal(thread.notnull, 1);
  assert.match(ddl.sql, /source_presence_id IS NULL[\s\S]*source_display_name IS NULL/u);
});

test("two OS processes can open and migrate the same v3 inbox concurrently", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "orchestratory-inbox-migration-race-"));
  t.after(async () => await rm(data, { recursive: true, force: true }));
  const path = join(data, "room-inbox.sqlite");
  const raw = new DatabaseSync(path);
  raw.exec(`
    CREATE TABLE room_deliveries (
      id TEXT PRIMARY KEY, room_id TEXT NOT NULL, ledger_seq INTEGER NOT NULL,
      ledger_hash TEXT NOT NULL, target_presence_id TEXT NOT NULL,
      target_display_name TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('queued','delivered','read','working','replied','failed','cancelled')),
      attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt BETWEEN 0 AND 100),
      max_attempts INTEGER NOT NULL CHECK (max_attempts BETWEEN 1 AND 10),
      lease_token TEXT, lease_expires_at_ms INTEGER,
      cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0,1)),
      reply_key TEXT, reply_author TEXT, reply_input_hash TEXT,
      completion_token_hash TEXT, reply_ledger_seq INTEGER, fail_reason TEXT,
      task_id TEXT, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
      row_hash TEXT NOT NULL, UNIQUE(room_id, ledger_seq, target_presence_id),
      CHECK ((lease_token IS NULL) = (lease_expires_at_ms IS NULL))
    );
    CREATE INDEX room_deliveries_target_queue
      ON room_deliveries(target_presence_id, room_id, state, created_at_ms);
    CREATE TABLE room_delivery_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, delivery_id TEXT NOT NULL,
      from_state TEXT, to_state TEXT NOT NULL, at_ms INTEGER NOT NULL,
      detail TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE room_wait_leases (
      presence_id TEXT PRIMARY KEY, room_id TEXT NOT NULL,
      waiter_token TEXT NOT NULL, expires_at_ms INTEGER NOT NULL
    );
    PRAGMA user_version = 3;
  `);
  raw.close();
  await chmod(path, 0o600);
  const moduleUrl = new URL("../src/core/room-inbox.ts", import.meta.url).href;
  const script = `import { RoomInboxStore } from ${JSON.stringify(moduleUrl)};
    const store = new RoomInboxStore(process.argv[1]);
    process.stdout.write(String(store.inventory().schemaVersion));
    store.close();`;
  const results = await Promise.all([
    execFileAsync(process.execPath, ["--input-type=module", "-e", script, data]),
    execFileAsync(process.execPath, ["--input-type=module", "-e", script, data]),
  ]);
  assert.deepEqual(results.map(({ stdout }) => stdout), ["4", "4"]);
  const migrated = new RoomInboxStore(data);
  t.after(() => migrated.close());
  assert.deepEqual(migrated.integrity(), { schemaVersion: 4, quickCheck: "ok", stateValid: true });
});

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

test("concurrent connections cannot replace an immutable prepared reply payload", async (t) => {
  const { data, inbox, ledger } = await fixture(t);
  const queued = inbox.enqueue({
    message: ledger.append("demo", "you", "@codex1 race reply"),
    targetPresenceId: firstSeat,
    targetDisplayName: "codex1",
  });
  const claimed = await inbox.wait({ presenceId: firstSeat, roomId: "demo", timeoutMs: 100, ledger });
  assert.ok(claimed);
  inbox.ack({ presenceId: firstSeat, deliveryId: queued.id, leaseToken: claimed.leaseToken, phase: "read" });
  inbox.ack({ presenceId: firstSeat, deliveryId: queued.id, leaseToken: claimed.leaseToken, phase: "working" });
  const competingInbox = new RoomInboxStore(data, { deliveryLeaseMs: 5_000 });
  const competingLedger = new RoomLedger(data);
  t.after(() => competingInbox.close());
  t.after(() => competingLedger.close());
  const append = ledger.appendIdempotent.bind(ledger);
  let competing: Promise<unknown> | undefined;
  ledger.appendIdempotent = (...args) => {
    competing = competingInbox.reply({
      presenceId: firstSeat,
      deliveryId: queued.id,
      leaseToken: claimed.leaseToken,
      text: "payload B",
      ledger: competingLedger,
      author: "codex1",
    });
    void competing.catch(() => { /* asserted after the winning reply commits */ });
    return append(...args);
  };
  const winner = await inbox.reply({
    presenceId: firstSeat,
    deliveryId: queued.id,
    leaseToken: claimed.leaseToken,
    text: "payload A",
    ledger,
    author: "codex1",
  });
  ledger.appendIdempotent = append;
  assert.ok(competing);
  await assert.rejects(competing, /ROOM_IDEMPOTENCY_CONFLICT/u);
  assert.equal(winner.reply.text, "payload A");
  assert.equal(inbox.get(queued.id)?.state, "replied");
  assert.equal(ledger.getRoom("demo")?.messages, 3);
});

test("reply prepare is the linearization point and a later owner cancel cannot orphan its ledger reply", async (t) => {
  const { data, inbox, ledger } = await fixture(t);
  const queued = inbox.enqueue({
    message: ledger.append("demo", "you", "@codex1 cancel race"),
    targetPresenceId: firstSeat,
    targetDisplayName: "codex1",
  });
  const claimed = await inbox.wait({ presenceId: firstSeat, roomId: "demo", timeoutMs: 100, ledger });
  assert.ok(claimed);
  inbox.ack({ presenceId: firstSeat, deliveryId: queued.id, leaseToken: claimed.leaseToken, phase: "read" });
  inbox.ack({ presenceId: firstSeat, deliveryId: queued.id, leaseToken: claimed.leaseToken, phase: "working" });
  const ownerView = new RoomInboxStore(data, { deliveryLeaseMs: 5_000 });
  t.after(() => ownerView.close());
  const append = ledger.appendIdempotent.bind(ledger);
  let cancelResult: ReturnType<RoomInboxStore["cancel"]> | undefined;
  ledger.appendIdempotent = (...args) => {
    cancelResult = ownerView.cancel(queued.id);
    return append(...args);
  };
  const completed = await inbox.reply({
    presenceId: firstSeat,
    deliveryId: queued.id,
    leaseToken: claimed.leaseToken,
    text: "prepare 已先勝出",
    ledger,
    author: "codex1",
  });
  ledger.appendIdempotent = append;
  assert.equal(cancelResult?.state, "working");
  assert.equal(cancelResult?.cancelRequested, false);
  assert.equal(completed.delivery.state, "replied");
  assert.equal(inbox.get(queued.id)?.replyLedgerSeq, completed.reply.seq);
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
    message: ledger.append("demo", "claude1", "@codex1 請回覆"),
    sourcePresenceId: secondSeat,
    sourceDisplayName: "claude1",
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
  now += 5_001;
  inbox = new RoomInboxStore(data, { now: () => now, deliveryLeaseMs: 5_000 });
  ledger = new RoomLedger(data);
  assert.equal(inbox.get(queued.id)?.failReason, "REPLY_COMMIT_UNCERTAIN");

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

  const reconciled = await inbox.waitForReply({
    sourcePresenceId: secondSeat,
    deliveryId: queued.id,
    timeoutMs: 100,
    ledger,
  });
  assert.equal(reconciled?.delivery.state, "replied");
  assert.equal(reconciled?.reply?.text, "原子回覆");
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

test("a prepared reply that never reaches the ledger expires fail-closed for explicit recovery", async (t) => {
  const { inbox, ledger, advance } = await fixture(t);
  const queued = inbox.enqueue({
    message: ledger.append("demo", "you", "@codex1 uncertain reply"),
    targetPresenceId: firstSeat,
    targetDisplayName: "codex1",
  });
  const claimed = await inbox.wait({ presenceId: firstSeat, roomId: "demo", timeoutMs: 100, ledger });
  assert.ok(claimed);
  inbox.ack({ presenceId: firstSeat, deliveryId: queued.id, leaseToken: claimed.leaseToken, phase: "read" });
  inbox.ack({ presenceId: firstSeat, deliveryId: queued.id, leaseToken: claimed.leaseToken, phase: "working" });
  const append = ledger.appendIdempotent.bind(ledger);
  ledger.appendIdempotent = () => { throw new Error("SIMULATED_PRE_LEDGER_FAILURE"); };
  await assert.rejects(
    inbox.reply({
      presenceId: firstSeat,
      deliveryId: queued.id,
      leaseToken: claimed.leaseToken,
      text: "沒有寫進 ledger",
      ledger,
      author: "codex1",
    }),
    /SIMULATED_PRE_LEDGER_FAILURE/u,
  );
  ledger.appendIdempotent = append;
  advance(5_001);
  const expired = inbox.get(queued.id);
  assert.equal(expired?.state, "failed");
  assert.equal(expired?.failReason, "REPLY_COMMIT_UNCERTAIN");
  assert.throws(() => inbox.retry(queued.id), /DELIVERY_REPLY_RECOVERY_REQUIRED/u);
  assert.equal(ledger.getRoom("demo")?.messages, 2);
});

test("owner cancellation is terminal and a working agent must confirm instead of replying", async (t) => {
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
  await assert.rejects(
    inbox.reply({
      presenceId: firstSeat,
      deliveryId: first.id,
      leaseToken: claimed.leaseToken,
      text: "取消後不可提交",
      ledger,
      author: "codex1",
    }),
    /DELIVERY_CANCELLED/u,
  );
  assert.equal(inbox.get(first.id)?.state, "cancelled");
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
  assert.throws(
    () => inbox.enqueue({
      message: mention,
      sourcePresenceId: secondSeat,
      targetPresenceId: firstSeat,
      targetDisplayName: "codex1",
    }),
    /INVALID_SOURCE_IDENTITY/u,
  );
  assert.throws(
    () => inbox.enqueue({
      message: mention,
      sourcePresenceId: secondSeat,
      sourceDisplayName: "claude1",
      targetPresenceId: firstSeat,
      targetDisplayName: "codex1",
      clientRequestId: "retry-me",
    }),
    /INVALID_CLIENT_REQUEST_ID/u,
  );
  assert.throws(
    () => inbox.enqueue({
      message: mention,
      targetPresenceId: firstSeat,
      targetDisplayName: "codex1",
      clientRequestId: thirdSeat,
    }),
    /CLIENT_REQUEST_REQUIRES_SOURCE/u,
  );
  assert.throws(
    () => inbox.enqueue({
      message: mention,
      sourcePresenceId: firstSeat,
      sourceDisplayName: "codex1",
      targetPresenceId: firstSeat,
      targetDisplayName: "codex1",
    }),
    /ROOM_DELIVERY_SELF_TARGET/u,
  );
  assert.throws(
    () => inbox.enqueue({
      message: mention,
      sourcePresenceId: secondSeat,
      sourceDisplayName: "claude1",
      targetPresenceId: firstSeat,
      targetDisplayName: "codex1",
      threadId: "bad",
    }),
    /INVALID_THREAD_ID/u,
  );
  assert.throws(
    () => inbox.enqueue({
      message: mention,
      sourcePresenceId: secondSeat,
      sourceDisplayName: "claude1",
      targetPresenceId: firstSeat,
      targetDisplayName: "codex1",
      threadId: thirdSeat,
      replyToDeliveryId: thirdSeat,
    }),
    /REPLY_TO_DELIVERY_NOT_FOUND/u,
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
  const peerMessage = ledger.append("demo", "claude1", "@codex1 peer task");
  const peer = inbox.enqueue({
    message: peerMessage,
    sourcePresenceId: secondSeat,
    sourceDisplayName: "claude1",
    targetPresenceId: firstSeat,
    targetDisplayName: "codex1",
  });
  const replyOnlyMessage = ledger.append("demo", "codex1", "@claude1 reply only");
  assert.throws(
    () => inbox.enqueue({
      message: replyOnlyMessage,
      sourcePresenceId: firstSeat,
      sourceDisplayName: "codex1",
      targetPresenceId: secondSeat,
      targetDisplayName: "claude1",
      replyToDeliveryId: peer.id,
    }),
    /THREAD_CONTINUATION_FIELDS_MISMATCH/u,
  );
  const wrongParticipantMessage = ledger.append("demo", "grok1", "@codex1 wrong participant");
  assert.throws(
    () => inbox.enqueue({
      message: wrongParticipantMessage,
      sourcePresenceId: thirdSeat,
      sourceDisplayName: "grok1",
      targetPresenceId: firstSeat,
      targetDisplayName: "codex1",
      threadId: peer.threadId,
      replyToDeliveryId: peer.id,
    }),
    /THREAD_PARTICIPANT_MISMATCH/u,
  );
  const wrongThreadMessage = ledger.append("demo", "codex1", "@claude1 wrong thread");
  assert.throws(
    () => inbox.enqueue({
      message: wrongThreadMessage,
      sourcePresenceId: firstSeat,
      sourceDisplayName: "codex1",
      targetPresenceId: secondSeat,
      targetDisplayName: "claude1",
      threadId: thirdSeat,
      replyToDeliveryId: peer.id,
    }),
    /THREAD_ID_MISMATCH/u,
  );
  const changedTaskMessage = ledger.append("demo", "codex1", "@claude1 changed task");
  assert.throws(
    () => inbox.enqueue({
      message: changedTaskMessage,
      sourcePresenceId: firstSeat,
      sourceDisplayName: "codex1",
      targetPresenceId: secondSeat,
      targetDisplayName: "claude1",
      threadId: peer.threadId,
      replyToDeliveryId: peer.id,
      taskId: "different-task",
    }),
    /THREAD_TASK_MISMATCH/u,
  );
  ledger.createRoom("other", "/tmp/other");
  const crossRoomMessage = ledger.append("other", "codex1", "@claude1 cross room");
  assert.throws(
    () => inbox.enqueue({
      message: crossRoomMessage,
      sourcePresenceId: firstSeat,
      sourceDisplayName: "codex1",
      targetPresenceId: secondSeat,
      targetDisplayName: "claude1",
      threadId: peer.threadId,
      replyToDeliveryId: peer.id,
    }),
    /THREAD_ROOM_MISMATCH/u,
  );
  const hijackMessage = ledger.append("demo", "grok1", "@codex1 thread hijack");
  assert.throws(
    () => inbox.enqueue({
      message: hijackMessage,
      sourcePresenceId: thirdSeat,
      sourceDisplayName: "grok1",
      targetPresenceId: firstSeat,
      targetDisplayName: "codex1",
      threadId: peer.threadId,
    }),
    /THREAD_CONTINUATION_FIELDS_MISMATCH/u,
  );
  assert.equal(inbox.inventory().deliveries, 2);
  assert.deepEqual(inbox.integrity(), { schemaVersion: 4, quickCheck: "ok", stateValid: true });

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
  assert.throws(
    () => inbox.failDeliveryIfTargetUnavailable({
      deliveryId: queued.id,
      targetPresenceId: secondSeat,
      reason: "SEAT_OFFLINE",
    }),
    /DELIVERY_TARGET_MISMATCH/u,
  );
  assert.throws(
    () => inbox.failDeliveryIfTargetUnavailable({
      deliveryId: queued.id,
      targetPresenceId: firstSeat,
      reason: "",
    }),
    /INVALID_DELIVERY_FAILURE_REASON/u,
  );
  assert.equal(inbox.failDeliveryIfTargetUnavailable({
    deliveryId: queued.id,
    targetPresenceId: firstSeat,
    reason: "SEAT_OFFLINE",
  })?.state, "failed");
  assert.equal(inbox.failDeliveryIfTargetUnavailable({
    deliveryId: queued.id,
    targetPresenceId: firstSeat,
    reason: "SEAT_OFFLINE",
  }), undefined);
});
