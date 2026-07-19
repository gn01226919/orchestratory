import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { defaultRoomId, RoomLedger } from "../src/core/room-ledger.ts";

async function ledgerFixture(t: TestContext): Promise<RoomLedger> {
  const data = await mkdtemp(join(tmpdir(), "orchestratory-room-"));
  const ledger = new RoomLedger(data);
  t.after(() => ledger.close());
  t.after(async () => await rm(data, { recursive: true, force: true }));
  return ledger;
}

test("room ledger numbers messages sequentially and keeps an append-only chain", async (t) => {
  const ledger = await ledgerFixture(t);
  const room = ledger.createRoom("passkey", "/tmp/project");
  assert.equal(room.recording, "on");
  assert.equal(room.messages, 1); // room init system message

  const first = ledger.append("passkey", "you", "改用 passkey 好嗎？");
  const second = ledger.append("passkey", "claude", "建議用 WebAuthn，理由如下…");
  const named = ledger.append("passkey", "codex（前端 2）", "自訂席位名稱可安全入帳");
  assert.equal(first.seq, 2);
  assert.equal(second.seq, 3);
  assert.equal(named.author, "codex（前端 2）");
  assert.equal(ledger.verifyChain("passkey"), true);
  assert.deepEqual(ledger.integrity(), {
    schemaVersion: 2,
    quickCheck: "ok",
    foreignKeyViolations: 0,
    rooms: 1,
    auditChainValid: true,
  });
  const inventory = ledger.inventory();
  assert.equal(inventory.rooms, 1);
  assert.equal(inventory.messages, 4);
  assert.equal(inventory.recording.on, 1);
  assert.ok(inventory.databaseBytes > 0);

  assert.deepEqual(
    ledger.getRange("passkey", 2, 3).map((item) => `${item.seq}:${item.author}`),
    ["2:you", "3:claude"],
  );
  assert.equal(ledger.listAfter("passkey", 2).length, 2);
  assert.deepEqual(
    ledger.getRange("passkey", 1, 2).map((item) => item.seq),
    [1, 2],
  );
  assert.equal(ledger.search("passkey", "WebAuthn")[0]?.seq, 3);

  assert.throws(() => ledger.createRoom("passkey", "/tmp/project"), /ROOM_ALREADY_EXISTS/u);
  assert.throws(() => ledger.createRoom("Bad Room", "/tmp/x"), /INVALID_ROOM_ID/u);
  assert.throws(() => ledger.append("passkey", "sh!ell", "x"), /INVALID_ROOM_AUTHOR/u);
  assert.throws(() => ledger.append("passkey", "codex（<script>）", "x"), /INVALID_ROOM_AUTHOR/u);
  assert.throws(() => ledger.append("missing", "you", "x"), /ROOM_NOT_FOUND/u);
});

test("idempotent room appends survive retries without duplicating the ledger", async (t) => {
  const ledger = await ledgerFixture(t);
  ledger.createRoom("retry", "/tmp/project");
  const first = ledger.appendIdempotent("retry", "codex1", "完成修正", "room-delivery:one:reply");
  const replay = ledger.appendIdempotent("retry", "codex1", "完成修正", "room-delivery:one:reply");
  assert.equal(replay.seq, first.seq);
  assert.equal(ledger.getRoom("retry")?.messages, 2);
  assert.throws(
    () => ledger.appendIdempotent("retry", "codex1", "不同內容", "room-delivery:one:reply"),
    /ROOM_IDEMPOTENCY_CONFLICT/u,
  );
  assert.throws(
    () => ledger.appendIdempotent("retry", "codex1", "內容", "bad key"),
    /INVALID_ROOM_IDEMPOTENCY_KEY/u,
  );
});

test("default room ids remain distinct for equal workspace basenames", () => {
  const first = defaultRoomId("/tmp/team-a/project");
  const second = defaultRoomId("/tmp/team-b/project");
  assert.notEqual(first, second);
  assert.match(first, /^project-[a-f0-9]{8}$/u);
  assert.match(defaultRoomId("/tmp/專案"), /^room-default-[a-f0-9]{8}$/u);
});

test("recording state gates chat entries while system events stay honest", async (t) => {
  const ledger = await ledgerFixture(t);
  ledger.createRoom("demo", "/tmp/project");
  ledger.append("demo", "you", "第一句");

  const paused = ledger.setRecording("demo", "paused");
  assert.equal(paused.recording, "paused");
  assert.throws(() => ledger.append("demo", "you", "不該入帳"), /ROOM_RECORDING_PAUSED/u);

  ledger.setRecording("demo", "on");
  ledger.append("demo", "you", "恢復後這句要在");
  ledger.setRecording("demo", "off");
  assert.throws(() => ledger.append("demo", "you", "關閉後拒收"), /ROOM_RECORDING_OFF/u);

  const texts = ledger.getRange("demo", 1, 7).map((item) => `${item.kind}:${item.text}`);
  assert.ok(texts.some((item) => item.includes("收錄暫停")));
  assert.ok(texts.some((item) => item.includes("收錄恢復")));
  assert.ok(texts.some((item) => item.includes("收錄關閉")));
  assert.equal(ledger.verifyChain("demo"), true);
});

test("room ledger redacts secrets, bounds size, and rejects binary", async (t) => {
  const ledger = await ledgerFixture(t);
  ledger.createRoom("sec", "/tmp/project");
  const syntheticSecret = ["sk-ant", "api03", "abcdefghijklmnop"].join("-");
  const message = ledger.append("sec", "you", `我的 key 是 ${syntheticSecret} 請小心`);
  assert.equal(message.text.includes(syntheticSecret), false);

  const oversized = ledger.append("sec", "claude", "長".repeat(30_000));
  assert.ok(oversized.text.endsWith("…[TRUNCATED]"));
  assert.ok(oversized.text.length <= 16_384 + "…[TRUNCATED]".length);

  assert.throws(() => ledger.append("sec", "you", "bad\0binary"), /ROOM_BINARY_MESSAGE_DENIED/u);
  assert.throws(() => ledger.append("sec", "you", "   "), /INVALID_ROOM_MESSAGE/u);
  assert.throws(() => ledger.getRange("sec", 1, 500), /INVALID_ROOM_RANGE/u);
  assert.throws(() => ledger.search("sec", "%".repeat(300)), /INVALID_ROOM_QUERY/u);
  assert.equal(ledger.search("sec", "%")[0] === undefined, true);
});

test("tampered ledger rows fail closed when the ledger is reopened", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "orchestratory-room-tamper-"));
  t.after(async () => await rm(data, { recursive: true, force: true }));
  const ledger = new RoomLedger(data);
  ledger.createRoom("audit", "/tmp/project");
  ledger.append("audit", "you", "原始內容");
  assert.equal(ledger.verifyChain("audit"), true);
  ledger.close();

  const raw = new DatabaseSync(join(data, "rooms.sqlite"));
  raw.prepare("UPDATE room_messages SET text = ? WHERE room_id = ? AND seq = 2").run(
    "被竄改的內容",
    "audit",
  );
  raw.close();

  assert.throws(() => new RoomLedger(data), /ROOM_LEDGER_AUDIT_CHAIN_INVALID/u);
});

test("room ledger rejects foreign-key corruption and unsupported schemas at startup", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "orchestratory-room-schema-"));
  t.after(async () => await rm(data, { recursive: true, force: true }));
  const ledger = new RoomLedger(data);
  ledger.createRoom("schema", "/tmp/project");
  ledger.close();

  const path = join(data, "rooms.sqlite");
  const orphaned = new DatabaseSync(path);
  orphaned.exec("PRAGMA foreign_keys=OFF");
  orphaned.prepare(
    "INSERT INTO room_messages (room_id, seq, at, author, kind, text, hash) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run("missing", 1, new Date().toISOString(), "system", "system", "orphan", "0".repeat(64));
  orphaned.close();
  assert.throws(() => new RoomLedger(data), /ROOM_LEDGER_FOREIGN_KEY_VIOLATION/u);

  const futureData = await mkdtemp(join(tmpdir(), "orchestratory-room-future-"));
  t.after(async () => await rm(futureData, { recursive: true, force: true }));
  const future = new RoomLedger(futureData);
  future.close();
  const raw = new DatabaseSync(join(futureData, "rooms.sqlite"));
  raw.exec("PRAGMA user_version = 999");
  raw.close();
  assert.throws(() => new RoomLedger(futureData), /ROOM_LEDGER_SCHEMA_UNSUPPORTED/u);
});
