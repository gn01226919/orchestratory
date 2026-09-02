import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
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

async function convertDeliveryToInterimV4(
  path: string,
  deliveryId: string,
): Promise<void> {
  const raw = new DatabaseSync(path);
  const current = raw.prepare("SELECT * FROM room_deliveries WHERE id = ?")
    .get(deliveryId) as Record<string, string | number | null>;
  const interimHash = createHash("sha256").update(JSON.stringify([
    current.id, current.room_id, current.ledger_seq, current.ledger_hash,
    current.source_presence_id, current.source_display_name, current.target_presence_id,
    current.target_display_name, current.thread_id, current.reply_to_delivery_id,
    current.state, current.attempt, current.max_attempts, current.lease_token,
    current.lease_expires_at_ms, current.cancel_requested, current.reply_key,
    current.reply_author, current.reply_input_hash, current.completion_token_hash,
    current.reply_ledger_seq, current.fail_reason, current.task_id,
    current.created_at_ms, current.updated_at_ms,
  ]), "utf8").digest("hex");
  raw.exec(`
    BEGIN IMMEDIATE;
    ALTER TABLE room_deliveries RENAME TO room_deliveries_v5;
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
      row_hash TEXT NOT NULL, source_presence_id TEXT, source_display_name TEXT,
      thread_id TEXT, reply_to_delivery_id TEXT,
      UNIQUE(room_id, ledger_seq, target_presence_id),
      CHECK ((lease_token IS NULL) = (lease_expires_at_ms IS NULL))
    );
  `);
  const interimValues = [
    current.id, current.room_id, current.ledger_seq, current.ledger_hash,
    current.target_presence_id, current.target_display_name, current.state,
    current.attempt, current.max_attempts, current.lease_token, current.lease_expires_at_ms,
    current.cancel_requested, current.reply_key, current.reply_author,
    current.reply_input_hash, current.completion_token_hash, current.reply_ledger_seq,
    current.fail_reason, current.task_id, current.created_at_ms, current.updated_at_ms,
    interimHash, current.source_presence_id, current.source_display_name,
    current.thread_id, current.reply_to_delivery_id,
  ];
  if (interimValues.some((value) => value === undefined)) throw new Error("INVALID_INTERIM_FIXTURE");
  raw.prepare(`INSERT INTO room_deliveries
    (id,room_id,ledger_seq,ledger_hash,target_presence_id,target_display_name,state,
     attempt,max_attempts,lease_token,lease_expires_at_ms,cancel_requested,reply_key,
     reply_author,reply_input_hash,completion_token_hash,reply_ledger_seq,fail_reason,
     task_id,created_at_ms,updated_at_ms,row_hash,source_presence_id,source_display_name,
     thread_id,reply_to_delivery_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(...interimValues as Array<string | number | null>);
  raw.exec(`
    DROP TABLE room_deliveries_v5;
    CREATE INDEX room_deliveries_target_queue
      ON room_deliveries(target_presence_id, room_id, state, created_at_ms);
    PRAGMA user_version = 4;
    COMMIT;
  `);
  raw.close();
  await chmod(path, 0o600);
}

test("schema v3 deliveries migrate transactionally into v5 threads", async (t) => {
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
  assert.deepEqual(migrated.integrity(), { schemaVersion: 5, quickCheck: "ok", stateValid: true });
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

test("interim v4 inbox migrates transactionally without discarding exact-seat rows", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "orchestratory-inbox-interim-v4-"));
  t.after(async () => await rm(data, { recursive: true, force: true }));
  const ledger = new RoomLedger(data);
  ledger.createRoom("demo", "/tmp/project");
  const store = new RoomInboxStore(data);
  const delivery = store.enqueue({
    message: ledger.append("demo", "codex1", "@claude1 preserve this delivery"),
    sourcePresenceId: firstSeat,
    sourceDisplayName: "codex1",
    targetPresenceId: secondSeat,
    targetDisplayName: "claude1",
    taskId: "interim-v4-task",
  });
  const path = store.path;
  store.close();
  ledger.close();

  const raw = new DatabaseSync(path);
  const current = raw.prepare("SELECT * FROM room_deliveries WHERE id = ?").get(delivery.id) as Record<string, unknown>;
  const interimHash = createHash("sha256").update(JSON.stringify([
    current.id, current.room_id, current.ledger_seq, current.ledger_hash,
    current.source_presence_id, current.source_display_name, current.target_presence_id,
    current.target_display_name, current.thread_id, current.reply_to_delivery_id,
    current.state, current.attempt, current.max_attempts, current.lease_token,
    current.lease_expires_at_ms, current.cancel_requested, current.reply_key,
    current.reply_author, current.reply_input_hash, current.completion_token_hash,
    current.reply_ledger_seq, current.fail_reason, current.task_id,
    current.created_at_ms, current.updated_at_ms,
  ]), "utf8").digest("hex");
  raw.exec(`
    BEGIN IMMEDIATE;
    ALTER TABLE room_deliveries RENAME TO room_deliveries_v5;
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
      row_hash TEXT NOT NULL, source_presence_id TEXT, source_display_name TEXT,
      thread_id TEXT, reply_to_delivery_id TEXT,
      UNIQUE(room_id, ledger_seq, target_presence_id),
      CHECK ((lease_token IS NULL) = (lease_expires_at_ms IS NULL))
    );
  `);
  raw.prepare(`INSERT INTO room_deliveries
    (id,room_id,ledger_seq,ledger_hash,target_presence_id,target_display_name,state,
     attempt,max_attempts,lease_token,lease_expires_at_ms,cancel_requested,reply_key,
     reply_author,reply_input_hash,completion_token_hash,reply_ledger_seq,fail_reason,
     task_id,created_at_ms,updated_at_ms,row_hash,source_presence_id,source_display_name,
     thread_id,reply_to_delivery_id)
    SELECT id,room_id,ledger_seq,ledger_hash,target_presence_id,target_display_name,state,
     attempt,max_attempts,lease_token,lease_expires_at_ms,cancel_requested,reply_key,
     reply_author,reply_input_hash,completion_token_hash,reply_ledger_seq,fail_reason,
     task_id,created_at_ms,updated_at_ms,?,source_presence_id,source_display_name,
     thread_id,reply_to_delivery_id
    FROM room_deliveries_v5 WHERE id=?`).run(interimHash, delivery.id);
  raw.exec(`
    DROP TABLE room_deliveries_v5;
    CREATE INDEX room_deliveries_target_queue
      ON room_deliveries(target_presence_id, room_id, state, created_at_ms);
    PRAGMA user_version = 4;
    COMMIT;
  `);
  const eventCountBefore = Number((raw.prepare(
    "SELECT COUNT(*) AS count FROM room_delivery_events",
  ).get() as { count: number }).count);
  raw.prepare(`INSERT INTO room_wait_leases (presence_id, room_id, waiter_token, expires_at_ms)
    VALUES (?, ?, ?, ?)`).run(thirdSeat, "demo", "interim-waiter", Date.now() + 60_000);
  raw.prepare("UPDATE room_deliveries SET target_display_name = ? WHERE id = ?")
    .run("tampered", delivery.id);
  raw.close();
  await chmod(path, 0o600);

  assert.throws(() => new RoomInboxStore(data), /ROOM_INBOX_ROW_TAMPERED/u);
  const restored = new DatabaseSync(path);
  restored.prepare("UPDATE room_deliveries SET target_display_name = ? WHERE id = ?")
    .run("claude1", delivery.id);
  restored.close();

  const migrated = new RoomInboxStore(data);
  t.after(() => migrated.close());
  assert.deepEqual(migrated.integrity(), { schemaVersion: 5, quickCheck: "ok", stateValid: true });
  assert.equal(migrated.get(delivery.id)?.sourcePresenceId, firstSeat);
  assert.equal(migrated.get(delivery.id)?.sourceDisplayName, "codex1");
  assert.equal(migrated.get(delivery.id)?.targetPresenceId, secondSeat);
  assert.equal(migrated.get(delivery.id)?.threadId, delivery.threadId);
  assert.equal(migrated.get(delivery.id)?.clientRequestId, undefined);
  const migratedSchema = new DatabaseSync(path, { readOnly: true });
  const columns = migratedSchema.prepare("PRAGMA table_info(room_deliveries)").all() as Array<{ name: string }>;
  const version = migratedSchema.prepare("PRAGMA user_version").get() as { user_version: number };
  const eventCountAfter = Number((migratedSchema.prepare(
    "SELECT COUNT(*) AS count FROM room_delivery_events",
  ).get() as { count: number }).count);
  const waitCountAfter = Number((migratedSchema.prepare(
    "SELECT COUNT(*) AS count FROM room_wait_leases WHERE waiter_token = 'interim-waiter'",
  ).get() as { count: number }).count);
  migratedSchema.close();
  assert.equal(version.user_version, 5);
  assert.equal(columns.some((column) => column.name === "client_request_id"), true);
  assert.equal(eventCountAfter, eventCountBefore);
  assert.equal(waitCountAfter, 1);
});

test("canonical v4 rebuilds into v5 while unknown v4 variants roll back fail-closed", async (t) => {
  const canonicalData = await mkdtemp(join(tmpdir(), "orchestratory-inbox-canonical-v4-"));
  const unknownData = await mkdtemp(join(tmpdir(), "orchestratory-inbox-unknown-v4-"));
  t.after(async () => await Promise.all([
    rm(canonicalData, { recursive: true, force: true }),
    rm(unknownData, { recursive: true, force: true }),
  ]));

  const canonical = new RoomInboxStore(canonicalData);
  canonical.close();
  const canonicalRaw = new DatabaseSync(join(canonicalData, "room-inbox.sqlite"));
  canonicalRaw.exec("PRAGMA user_version = 4;");
  canonicalRaw.close();
  const upgraded = new RoomInboxStore(canonicalData);
  assert.deepEqual(upgraded.integrity(), { schemaVersion: 5, quickCheck: "ok", stateValid: true });
  upgraded.close();

  const unknown = new RoomInboxStore(unknownData);
  unknown.close();
  const unknownPath = join(unknownData, "room-inbox.sqlite");
  const unknownRaw = new DatabaseSync(unknownPath);
  unknownRaw.exec("ALTER TABLE room_deliveries ADD COLUMN unexpected TEXT; PRAGMA user_version = 4;");
  unknownRaw.close();
  assert.throws(() => new RoomInboxStore(unknownData), /ROOM_INBOX_SCHEMA_V4_UNRECOGNIZED/u);
  const rolledBack = new DatabaseSync(unknownPath, { readOnly: true });
  const version = rolledBack.prepare("PRAGMA user_version").get() as { user_version: number };
  const temporary = rolledBack.prepare(
    "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='room_deliveries_v5'",
  ).get() as { count: number };
  rolledBack.close();
  assert.equal(version.user_version, 4);
  assert.equal(temporary.count, 0);
});

test("an interim v4 insert failure rolls back the complete migration", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "orchestratory-inbox-v4-rollback-"));
  t.after(async () => await rm(data, { recursive: true, force: true }));
  const ledger = new RoomLedger(data);
  ledger.createRoom("demo", "/tmp/project");
  const store = new RoomInboxStore(data);
  const delivery = store.enqueue({
    message: ledger.append("demo", "you", "@codex1 rollback"),
    targetPresenceId: firstSeat,
    targetDisplayName: "codex1",
  });
  const path = store.path;
  store.close();
  ledger.close();
  await convertDeliveryToInterimV4(path, delivery.id);

  const before = new DatabaseSync(path, { readOnly: true });
  const beforeRow = before.prepare("SELECT row_hash FROM room_deliveries WHERE id = ?")
    .get(delivery.id) as { row_hash: string };
  const beforeEvents = Number((before.prepare(
    "SELECT COUNT(*) AS count FROM room_delivery_events",
  ).get() as { count: number }).count);
  before.close();

  assert.throws(
    () => new RoomInboxStore(data, { testOnlyMigrationFailureAfterRows: 1 }),
    /ROOM_INBOX_MIGRATION_TEST_FAILURE/u,
  );
  const after = new DatabaseSync(path, { readOnly: true });
  const version = after.prepare("PRAGMA user_version").get() as { user_version: number };
  const afterRow = after.prepare("SELECT row_hash FROM room_deliveries WHERE id = ?")
    .get(delivery.id) as { row_hash: string };
  const afterEvents = Number((after.prepare(
    "SELECT COUNT(*) AS count FROM room_delivery_events",
  ).get() as { count: number }).count);
  const temporary = Number((after.prepare(
    "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='room_deliveries_v5'",
  ).get() as { count: number }).count);
  after.close();
  assert.equal(version.user_version, 4);
  assert.equal(afterRow.row_hash, beforeRow.row_hash);
  assert.equal(afterEvents, beforeEvents);
  assert.equal(temporary, 0);
});

test("two OS processes can migrate the exact interim v4 inbox concurrently", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "orchestratory-inbox-interim-race-"));
  t.after(async () => await rm(data, { recursive: true, force: true }));
  const ledger = new RoomLedger(data);
  ledger.createRoom("demo", "/tmp/project");
  const store = new RoomInboxStore(data);
  const delivery = store.enqueue({
    message: ledger.append("demo", "you", "@codex1 concurrent interim migration"),
    targetPresenceId: firstSeat,
    targetDisplayName: "codex1",
  });
  const path = store.path;
  store.close();
  ledger.close();
  await convertDeliveryToInterimV4(path, delivery.id);
  const before = new DatabaseSync(path, { readOnly: true });
  const expected = before.prepare("SELECT thread_id FROM room_deliveries WHERE id = ?")
    .get(delivery.id) as { thread_id: string };
  before.close();

  const moduleUrl = new URL("../src/core/room-inbox.ts", import.meta.url).href;
  const script = `import { RoomInboxStore } from ${JSON.stringify(moduleUrl)};
    const store = new RoomInboxStore(process.argv[1]);
    process.stdout.write(String(store.inventory().schemaVersion));
    store.close();`;
  const results = await Promise.all([
    execFileAsync(process.execPath, ["--input-type=module", "-e", script, data]),
    execFileAsync(process.execPath, ["--input-type=module", "-e", script, data]),
  ]);
  assert.deepEqual(results.map(({ stdout }) => stdout), ["5", "5"]);
  const migrated = new RoomInboxStore(data);
  assert.equal(migrated.get(delivery.id)?.threadId, expected.thread_id);
  assert.deepEqual(migrated.integrity(), { schemaVersion: 5, quickCheck: "ok", stateValid: true });
  migrated.close();
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
  assert.deepEqual(results.map(({ stdout }) => stdout), ["5", "5"]);
  const migrated = new RoomInboxStore(data);
  t.after(() => migrated.close());
  assert.deepEqual(migrated.integrity(), { schemaVersion: 5, quickCheck: "ok", stateValid: true });
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

test("a crashed waiter stops looking wakeable once its rolling lease lapses", async (t) => {
  const { inbox, ledger, advance } = await fixture(t);
  const controller = new AbortController();
  // No timeoutMs: standby is unbounded, so what makes a seat stop looking wakeable can no longer be
  // a deadline. It is the lease going unrenewed — which is what a crashed process looks like, and
  // the only thing that distinguishes it from one that is simply waiting quietly.
  const pending = inbox.wait({ presenceId: firstSeat, roomId: "demo", ledger, signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(inbox.isListening(firstSeat, "demo"), true);
  // Jumping the clock past the lease without letting the loop run IS the crash: a live waiter would
  // have re-extended it several times over this span.
  advance(15_001);
  assert.equal(inbox.isListening(firstSeat, "demo"), false,
    "a waiter that stopped renewing must stop advertising itself as reachable");
  controller.abort();
  await assert.rejects(pending, /ROOM_WAIT_CANCELLED/u);
});

test("the standby liveness lease stays on the presence heartbeat scale", async () => {
  // Asserted against the SOURCE, not against behaviour, and the distinction is the point. A live
  // waiter re-extends its lease every poll, so a behavioural test that lets the loop run before
  // advancing the clock passes for a lease of fifteen seconds and equally for one of a day.
  //
  // Honest scope, corrected again in review round 3: the crashed-waiter test above hard-codes
  // advance(15_001), so it already catches ANY lease longer than that, not just an absurd one. The
  // earlier version of this comment claimed a whole uncovered band that does not exist. What this
  // guard actually adds is the LOWER bound and the coupling to room-presence — neither of which any
  // behavioural test asserts — plus the check below that the constant is the one the code uses.
  //
  // Standby no longer ends on a timer, so this lease is now the ONLY signal that a terminal died.
  // Its length is therefore a real bound, and a bound that nothing checks is one that drifts. It
  // belongs at the scale room-presence already uses to mean "still alive"; longer, and a crashed
  // seat advertises itself as reachable for exactly that much longer.
  const source = await readFile(new URL("../src/core/room-inbox.ts", import.meta.url), "utf8");
  const match = /const WAIT_LEASE_MS = ([0-9_]+);/u.exec(source);
  assert.ok(match, "room-inbox must define the standby liveness lease as a named constant");
  const leaseMs = Number((match[1] ?? "").replaceAll("_", ""));

  const presenceSource = await readFile(new URL("../src/core/room-presence.ts", import.meta.url), "utf8");
  const presenceMatch = /const DEFAULT_LEASE_MS = ([0-9_]+);/u.exec(presenceSource);
  assert.ok(presenceMatch, "room-presence must define its heartbeat lease as a named constant");
  const presenceLeaseMs = Number((presenceMatch[1] ?? "").replaceAll("_", ""));

  // Renewal is at half-life, not per poll, so a short lease does not drop a live waiter — the earlier
  // reason given here was wrong. The real cost of a short lease is write amplification: every seat
  // renews twice per lease, forever, against an owner-only SQLite file shared with delivery traffic.
  assert.ok(leaseMs >= 5_000,
    `a lease of ${leaseMs}ms makes every standby seat rewrite its row more than twice a ${leaseMs}ms window`);

  // And the constant has to be the one the code actually uses. Without this, changing only the
  // renewal interval to a literal — leaving the declaration untouched — passes every test here:
  // the crashed-waiter test never lets the loop reach a renewal, and the regex above only reads the
  // declaration. That was the one lease regression nothing guarded.
  assert.match(source, /#beginWait\([^)]*\)[\s\S]{0,400}?WAIT_LEASE_MS|this\.#beginWait\([^;]*WAIT_LEASE_MS/u,
    "the initial standby lease must come from WAIT_LEASE_MS, not a literal");
  assert.match(source, /#refreshWait\([^;]*WAIT_LEASE_MS/u,
    "the standby lease RENEWAL must come from WAIT_LEASE_MS, not a literal");
  assert.ok(leaseMs <= presenceLeaseMs,
    `standby lease ${leaseMs}ms outlives the presence heartbeat ${presenceLeaseMs}ms, so a dead `
    + "seat would keep looking reachable after presence itself has given up on it");
});

test("a waiter whose lease lapsed while it stalled keeps its standby", async (t) => {
  const { inbox, ledger, advance } = await fixture(t);
  const controller = new AbortController();
  const pending = inbox.wait({ presenceId: firstSeat, roomId: "demo", ledger, signal: controller.signal })
    .then(() => "returned", (error: Error) => error.message);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(inbox.isListening(firstSeat, "demo"), true);

  // A laptop sleeping is a loop that stops polling while the clock keeps moving, so a concurrent
  // reader runs the sweep while this waiter is still very much alive.
  //
  // Renamed after review: this test used to say "swept", and that word stopped being true when rows
  // began to survive expiry by WAIT_LEASE_GC_MS. Twenty seconds no longer sweeps anything, so the
  // old name described a mechanism the test no longer exercises — a green test standing guard over
  // behaviour that had moved. What it asserts now is the thing that matters to a sleeping laptop:
  // a LAPSED lease is not a lost seat. The collected-row case has its own test below.
  advance(20_000);
  inbox.list("demo");
  await new Promise((resolve) => setTimeout(resolve, 400));

  const race = await Promise.race([
    pending,
    new Promise((resolve) => { setTimeout(() => resolve("still-waiting"), 50); }),
  ]);
  assert.equal(race, "still-waiting", "a stall must not end standby; the loop running is the fact");
  assert.equal(inbox.isListening(firstSeat, "demo"), true, "and the seat re-advertises itself");

  controller.abort();
  assert.match(String(await pending), /ROOM_WAIT_CANCELLED/u);
});

/*
 * The round-3 hole, and the reason expired lease rows are kept instead of collected.
 *
 * Collecting a row on expiry erases the only record of WHICH waiter the client opened last. Two
 * stalled waiters then both find nothing on wake, and whichever polls first re-inserts itself -- so
 * the displaced loop can take the seat back from the loop the client is actually reading, and the
 * seat goes back to looking present while being unreachable. That is the exact defect this item
 * exists to remove, reintroduced by an earlier version of its own fix.
 */
/*
 * The other half of "expired rows are kept". Every guard added this round pushes the same way -- do
 * not delete, do not let a stale loop lose its seat -- so the direction that needs its own proof is
 * that rows are still collected eventually. Without this, setting WAIT_LEASE_GC_MS to Infinity, or
 * deleting the sweep's DELETE outright, passes the entire file.
 */
test("a lease row is collected once it is far past the GC window, and its loop loses the seat", { timeout: 30_000 }, async (t) => {
  const { inbox, ledger, advance } = await fixture(t);
  const controller = new AbortController();
  const abandoned = inbox.wait({ presenceId: firstSeat, roomId: "demo", ledger, signal: controller.signal })
    .then(() => "returned", (error: Error) => error.message);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(inbox.isListening(firstSeat, "demo"), true);

  // Twenty-five hours: past the lease by a day, and past the GC window. A stall this long is no
  // longer a laptop asleep; whatever was holding this seat is not coming back to read anything.
  advance(25 * 60 * 60 * 1_000);
  inbox.list("demo");
  await new Promise((resolve) => setTimeout(resolve, 400));

  assert.match(String(await abandoned), /ROOM_WAIT_LEASE_LOST/u,
    "a loop whose row was collected must end, not carry on holding a seat nobody can reach");
  assert.equal(inbox.isListening(firstSeat, "demo"), false, "and the seat must stop advertising itself");
  controller.abort();
});

test("a displaced waiter cannot take the seat back after a sweep", { timeout: 30_000 }, async (t) => {
  const { inbox, ledger, advance } = await fixture(t);
  const displaced = new AbortController();
  const current = new AbortController();

  const old = inbox.wait({ presenceId: firstSeat, roomId: "demo", ledger, signal: displaced.signal })
    .then(() => "returned", (error: Error) => error.message);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const held = inbox.wait({ presenceId: firstSeat, roomId: "demo", ledger, signal: current.signal })
    .then((value) => ({ ok: true as const, value }), (error: Error) => ({ ok: false as const, value: error.message }));
  await new Promise((resolve) => setTimeout(resolve, 20));

  // Both loops stall past their lease, then any concurrent reader runs the sweep. The displaced loop
  // wakes FIRST -- it was created first, so its poll timer fires first -- which is precisely the
  // ordering that let it win when a missing row meant "free seat".
  advance(20_000);
  inbox.list("demo");
  await new Promise((resolve) => setTimeout(resolve, 400));

  assert.match(String(await old), /ROOM_WAIT_LEASE_LOST/u, "the displaced loop must learn it lost the seat");
  assert.equal(inbox.isListening(firstSeat, "demo"), true, "and the seat the client is reading stays listening");

  inbox.enqueue({
    message: ledger.append("demo", "you", "@codex1 \u4efb\u52d9"),
    targetPresenceId: firstSeat,
    targetDisplayName: "codex1",
  });
  const claimed = await held;
  assert.equal(claimed.ok, true, `the current waiter must receive the work, got ${String(claimed.value)}`);

  displaced.abort();
  current.abort();
});

/* Bounded on purpose. If the takeover guard regresses, the abandoned loop eats the delivery and the
   fresh wait -- which no longer has a default cap -- never settles. Without this timeout that shows up
   as a CI job that hangs until the runner kills it, which reads as "infrastructure was slow" rather
   than "the guard is gone". The timeout turns a hang into a named failure. */
test("a fresh room_wait takes the seat from an abandoned one, and the old loop cannot eat a message", { timeout: 30_000 }, async (t) => {
  const { inbox, ledger, advance } = await fixture(t);
  const first = new AbortController();
  // An MCP client that stops reading a long-poll without sending notifications/cancelled leaves
  // this loop running server-side. While standby was capped it cleared itself within four hours;
  // unbounded, it would hold the seat forever — reporting wakeable, refusing the client's own
  // retry, and claiming deliveries into a response nobody reads.
  const abandoned = inbox.wait({ presenceId: firstSeat, roomId: "demo", ledger, signal: first.signal })
    .then(() => "returned", (error: Error) => error.message);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(inbox.isListening(firstSeat, "demo"), true);

  // The client comes back and waits again. That request IS the statement that the old one is gone.
  const second = new AbortController();
  // Both outcomes attached at creation. A bare promise that rejects before anything awaits it is an
  // unhandled rejection, and node:test reports that by cancelling the rest of the FILE — so the
  // symptom appears three tests away from the cause.
  const fresh = inbox.wait({ presenceId: firstSeat, roomId: "demo", ledger, signal: second.signal })
    .then((value) => ({ ok: true as const, value }), (error: Error) => ({ ok: false as const, value: error.message }));
  await new Promise((resolve) => setTimeout(resolve, 20));

  // The delivery must reach the waiter the client is actually reading.
  inbox.enqueue({
    message: ledger.append("demo", "you", "@codex1 任務"),
    targetPresenceId: firstSeat,
    targetDisplayName: "codex1",
  });
  const claimed = await fresh;
  assert.equal(claimed.ok, true, `the newest waiter must receive the work, got ${String(claimed.value)}`);
  assert.match(String((claimed.value as { message: { text: string } })?.message?.text), /任務/u);

  // And the displaced loop ended rather than lingering as a second claimant. It finds out at its
  // next CLAIM attempt, not at its next renewal — the guard is inside `#claim`, one poll away — so
  // no clock movement is needed here. An earlier draft advanced the fake clock first and hung the
  // whole file: the sweep it triggered expired the delivery before either loop could take it.
  assert.match(String(await abandoned), /ROOM_WAIT_LEASE_LOST/u);
  // Both controllers, even though the first loop already ended: an un-aborted signal keeps its
  // listener attached, and with nothing ref-ed alive Node cancels the rest of the file rather than
  // failing here — the same shape as the unref-ed timer in [[PITFALLS]] #173.
  first.abort();
  second.abort();
});

test("standby with no timeout never ends on its own", { timeout: 30_000 }, async (t) => {
  const { inbox, ledger, advance } = await fixture(t);
  const controller = new AbortController();
  // The property under test is the ABSENCE of a deadline, so the assertion is about how the promise
  // ends — not about the lease, which the crashed-waiter test above already owns. Under the old
  // default this resolved to `undefined` once four hours elapsed, and the caller's standby was over
  // without anything having happened.
  const pending = inbox.wait({ presenceId: firstSeat, roomId: "demo", ledger, signal: controller.signal })
    .then((value) => ({ settled: true, value }), (error: Error) => ({ settled: true, value: error.message }));
  await new Promise((resolve) => setTimeout(resolve, 20));

  advance(5 * 60 * 60 * 1_000);
  await new Promise((resolve) => setTimeout(resolve, 400));
  const race = await Promise.race([
    pending,
    new Promise((resolve) => { setTimeout(() => resolve({ settled: false }), 50); }),
  ]) as { settled: boolean; value?: unknown };
  assert.equal(race.settled, false,
    "five hours passed and standby is still waiting; a timer must not be what ends it");

  // And it is still reachable: the loop kept renewing across that span, so a sender is told the
  // truth rather than being handed a seat that quietly stopped listening an hour ago.
  assert.equal(inbox.isListening(firstSeat, "demo"), true);

  controller.abort();
  assert.match(String((await pending).value), /ROOM_WAIT_CANCELLED/u);
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
  assert.deepEqual(inbox.integrity(), { schemaVersion: 5, quickCheck: "ok", stateValid: true });

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
