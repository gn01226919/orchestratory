import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { RoomLedger, RoomMessage } from "./room-ledger.ts";
import { openOwnerDatabase, verifyOwnerDatabaseFiles } from "./sqlite-security.ts";

export type RoomDeliveryState =
  | "queued"
  | "delivered"
  | "read"
  | "working"
  | "replied"
  | "failed"
  | "cancelled";

export interface RoomDelivery {
  id: string;
  roomId: string;
  ledgerSeq: number;
  ledgerHash: string;
  targetPresenceId: string;
  targetDisplayName: string;
  state: RoomDeliveryState;
  attempt: number;
  maxAttempts: number;
  leaseExpiresAtMs?: number;
  cancelRequested: boolean;
  replyLedgerSeq?: number;
  failReason?: string;
  taskId?: string;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface ClaimedRoomDelivery extends RoomDelivery {
  leaseToken: string;
  message: RoomMessage;
}

interface DeliveryRow {
  id: string;
  room_id: string;
  ledger_seq: number;
  ledger_hash: string;
  target_presence_id: string;
  target_display_name: string;
  state: RoomDeliveryState;
  attempt: number;
  max_attempts: number;
  lease_token: string | null;
  lease_expires_at_ms: number | null;
  cancel_requested: number;
  reply_key: string | null;
  reply_author: string | null;
  reply_input_hash: string | null;
  completion_token_hash: string | null;
  reply_ledger_seq: number | null;
  fail_reason: string | null;
  task_id: string | null;
  created_at_ms: number;
  updated_at_ms: number;
  row_hash: string;
}

const SCHEMA_VERSION = 3;
const ROOM_PATTERN = /^[a-z][a-z0-9-]{0,47}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const AUTHOR_PATTERN = /^(?:[a-z][a-z0-9-]{0,31}|(?:codex|claude|grok)（[\p{L}\p{N}._ -]{1,24}）)$/u;
const MAX_PENDING_PER_SEAT = 32;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_DELIVERY_LEASE_MS = 60_000;
const MAX_WAIT_MS = 4 * 60 * 60 * 1_000;
const WAIT_POLL_MS = 150;

function rowHash(row: Omit<DeliveryRow, "row_hash">): string {
  return createHash("sha256").update(JSON.stringify([
    row.id, row.room_id, row.ledger_seq, row.ledger_hash, row.target_presence_id,
    row.target_display_name, row.state, row.attempt, row.max_attempts, row.lease_token,
    row.lease_expires_at_ms, row.cancel_requested, row.reply_key, row.reply_author,
    row.reply_input_hash, row.completion_token_hash, row.reply_ledger_seq,
    row.fail_reason, row.task_id, row.created_at_ms, row.updated_at_ms,
  ]), "utf8").digest("hex");
}

function validRoom(value: unknown): string {
  if (typeof value !== "string" || !ROOM_PATTERN.test(value)) throw new Error("INVALID_ROOM_ID");
  return value;
}

function validId(value: unknown, error: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) throw new Error(error);
  return value;
}

function validToken(value: unknown): string {
  return validId(value, "INVALID_DELIVERY_LEASE_TOKEN");
}

function tokenHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function replyInputHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function equalHash(left: string, right: string): boolean {
  if (!HASH_PATTERN.test(left) || !HASH_PATTERN.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function validAuthor(value: unknown): string {
  if (typeof value !== "string" || value === "system" || !AUTHOR_PATTERN.test(value)) {
    throw new Error("INVALID_ROOM_AUTHOR");
  }
  return value;
}

function publicDelivery(row: DeliveryRow): RoomDelivery {
  return {
    id: row.id,
    roomId: row.room_id,
    ledgerSeq: Number(row.ledger_seq),
    ledgerHash: row.ledger_hash,
    targetPresenceId: row.target_presence_id,
    targetDisplayName: row.target_display_name,
    state: row.state,
    attempt: Number(row.attempt),
    maxAttempts: Number(row.max_attempts),
    ...(row.lease_expires_at_ms === null ? {} : { leaseExpiresAtMs: Number(row.lease_expires_at_ms) }),
    cancelRequested: row.cancel_requested === 1,
    ...(row.reply_ledger_seq === null ? {} : { replyLedgerSeq: Number(row.reply_ledger_seq) }),
    ...(row.fail_reason ? { failReason: row.fail_reason } : {}),
    ...(row.task_id ? { taskId: row.task_id } : {}),
    createdAtMs: Number(row.created_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
  };
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("ROOM_WAIT_CANCELLED"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("ROOM_WAIT_CANCELLED"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Owner-only exact-seat inbox. Message bodies stay in the append-only RoomLedger. */
export class RoomInboxStore {
  readonly path: string;
  readonly #db: DatabaseSync;
  readonly #now: () => number;
  readonly #deliveryLeaseMs: number;
  #closed = false;

  constructor(dataDirectory: string, options: { now?: () => number; deliveryLeaseMs?: number } = {}) {
    this.path = join(dataDirectory, "room-inbox.sqlite");
    this.#now = options.now ?? Date.now;
    this.#deliveryLeaseMs = options.deliveryLeaseMs ?? DEFAULT_DELIVERY_LEASE_MS;
    if (!Number.isSafeInteger(this.#deliveryLeaseMs) || this.#deliveryLeaseMs < 5_000 || this.#deliveryLeaseMs > 300_000) {
      throw new Error("INVALID_DELIVERY_LEASE");
    }
    this.#db = openOwnerDatabase(this.path);
    try {
      this.#db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON; PRAGMA busy_timeout=3000;");
      verifyOwnerDatabaseFiles(this.path);
      const quick = this.#db.prepare("PRAGMA quick_check").get() as { quick_check?: string };
      if (quick.quick_check !== "ok") throw new Error("ROOM_INBOX_CORRUPT");
      let version = Number((this.#db.prepare("PRAGMA user_version").get() as { user_version?: number }).user_version ?? 0);
      if (!Number.isSafeInteger(version) || version < 0 || version > SCHEMA_VERSION) throw new Error("ROOM_INBOX_SCHEMA_UNSUPPORTED");
      if (version === 0) this.#migrate();
      else {
        if (version === 1) {
          this.#migrateV2();
          version = 2;
        }
        if (version === 2) this.#migrateV3();
      }
      if (this.#db.prepare("PRAGMA foreign_key_check").all().length > 0) throw new Error("ROOM_INBOX_FOREIGN_KEY_VIOLATION");
      this.#verifyRows();
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }

  #migrate(): void {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.exec(`
        CREATE TABLE room_deliveries (
          id TEXT PRIMARY KEY,
          room_id TEXT NOT NULL,
          ledger_seq INTEGER NOT NULL,
          ledger_hash TEXT NOT NULL,
          target_presence_id TEXT NOT NULL,
          target_display_name TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('queued','delivered','read','working','replied','failed','cancelled')),
          attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt BETWEEN 0 AND 100),
          max_attempts INTEGER NOT NULL CHECK (max_attempts BETWEEN 1 AND 10),
          lease_token TEXT,
          lease_expires_at_ms INTEGER,
          cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0,1)),
          reply_key TEXT,
          reply_author TEXT,
          reply_input_hash TEXT,
          completion_token_hash TEXT,
          reply_ledger_seq INTEGER,
          fail_reason TEXT,
          task_id TEXT,
          created_at_ms INTEGER NOT NULL,
          updated_at_ms INTEGER NOT NULL,
          row_hash TEXT NOT NULL,
          UNIQUE(room_id, ledger_seq, target_presence_id),
          CHECK ((lease_token IS NULL) = (lease_expires_at_ms IS NULL))
        );
        CREATE INDEX room_deliveries_target_queue ON room_deliveries(target_presence_id, room_id, state, created_at_ms);
        CREATE TABLE room_delivery_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          delivery_id TEXT NOT NULL,
          from_state TEXT,
          to_state TEXT NOT NULL,
          at_ms INTEGER NOT NULL,
          detail TEXT NOT NULL DEFAULT ''
        );
        CREATE TABLE room_wait_leases (
          presence_id TEXT PRIMARY KEY,
          room_id TEXT NOT NULL,
          waiter_token TEXT NOT NULL,
          expires_at_ms INTEGER NOT NULL
        );
        PRAGMA user_version = 3;
      `);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  #migrateV2(): void {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.exec(`
        ALTER TABLE room_deliveries ADD COLUMN reply_author TEXT;
        ALTER TABLE room_deliveries ADD COLUMN reply_input_hash TEXT;
        ALTER TABLE room_deliveries ADD COLUMN completion_token_hash TEXT;
      `);
      const rows = this.#db.prepare("SELECT * FROM room_deliveries").all() as unknown as DeliveryRow[];
      for (const row of rows) {
        const { row_hash: _old, ...hashable } = row;
        this.#db.prepare("UPDATE room_deliveries SET row_hash = ? WHERE id = ?")
          .run(rowHash(hashable), row.id);
      }
      this.#db.exec("PRAGMA user_version = 2; COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  #migrateV3(): void {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.#db.prepare("SELECT * FROM room_deliveries").all() as unknown as DeliveryRow[];
      for (const row of rows) {
        if (row.lease_token !== null && UUID_PATTERN.test(row.lease_token)) {
          row.lease_token = tokenHash(row.lease_token);
        } else if (row.lease_token !== null && !HASH_PATTERN.test(row.lease_token)) {
          throw new Error("ROOM_INBOX_LEASE_TOKEN_INVALID");
        }
        const { row_hash: _old, ...hashable } = row;
        this.#db.prepare("UPDATE room_deliveries SET lease_token=?, row_hash=? WHERE id=?")
          .run(row.lease_token, rowHash(hashable), row.id);
      }
      this.#db.exec("PRAGMA user_version = 3; COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }

  inventory(): { database: string; schemaVersion: number; databaseBytes: number; deliveries: number; listening: number } {
    this.#sweep();
    const row = this.#db.prepare("SELECT COUNT(*) deliveries FROM room_deliveries").get() as { deliveries: number };
    const listening = this.#db.prepare("SELECT COUNT(*) listening FROM room_wait_leases WHERE expires_at_ms > ?").get(this.#now()) as { listening: number };
    return { database: this.path, schemaVersion: SCHEMA_VERSION, databaseBytes: statSync(this.path).size, deliveries: Number(row.deliveries), listening: Number(listening.listening) };
  }

  integrity(): { schemaVersion: number; quickCheck: string; stateValid: boolean } {
    const quick = String((this.#db.prepare("PRAGMA quick_check").get() as { quick_check?: string }).quick_check ?? "unknown");
    let stateValid = true;
    try { this.#verifyRows(); } catch { stateValid = false; }
    return { schemaVersion: SCHEMA_VERSION, quickCheck: quick, stateValid };
  }

  enqueue(input: { message: RoomMessage; targetPresenceId: string; targetDisplayName: string; taskId?: string }): RoomDelivery {
    const roomId = validRoom(input.message.roomId);
    const target = validId(input.targetPresenceId, "INVALID_TARGET_PRESENCE_ID");
    if (typeof input.targetDisplayName !== "string" || input.targetDisplayName.length < 1 || input.targetDisplayName.length > 64 || input.targetDisplayName.includes("\0")) {
      throw new Error("INVALID_TARGET_DISPLAY_NAME");
    }
    if (!HASH_PATTERN.test(input.message.hash) || !Number.isSafeInteger(input.message.seq) || input.message.seq < 1) throw new Error("INVALID_DELIVERY_LEDGER_MESSAGE");
    if (input.taskId !== undefined && (typeof input.taskId !== "string" || input.taskId.length < 1 || input.taskId.length > 128 || input.taskId.includes("\0"))) throw new Error("INVALID_DELIVERY_TASK_ID");
    const now = this.#now();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#sweep(now, true);
      const existing = this.#db.prepare("SELECT * FROM room_deliveries WHERE room_id = ? AND ledger_seq = ? AND target_presence_id = ?")
        .get(roomId, input.message.seq, target) as unknown as DeliveryRow | undefined;
      if (existing) {
        this.#assertRow(existing);
        if (existing.target_display_name !== input.targetDisplayName || existing.task_id !== (input.taskId ?? null)) {
          throw new Error("ROOM_DELIVERY_IDEMPOTENCY_CONFLICT");
        }
        this.#db.exec("COMMIT");
        return publicDelivery(existing);
      }
      const pending = this.#db.prepare("SELECT COUNT(*) count FROM room_deliveries WHERE target_presence_id = ? AND state IN ('queued','delivered','read','working')")
        .get(target) as { count: number };
      if (Number(pending.count) >= MAX_PENDING_PER_SEAT) throw new Error("ROOM_INBOX_SEAT_LIMIT_REACHED");
      const bare: Omit<DeliveryRow, "row_hash"> = {
        id: randomUUID(), room_id: roomId, ledger_seq: input.message.seq, ledger_hash: input.message.hash,
        target_presence_id: target, target_display_name: input.targetDisplayName, state: "queued", attempt: 0,
        max_attempts: DEFAULT_MAX_ATTEMPTS, lease_token: null, lease_expires_at_ms: null,
        cancel_requested: 0, reply_key: null, reply_author: null, reply_input_hash: null,
        completion_token_hash: null, reply_ledger_seq: null, fail_reason: null,
        task_id: input.taskId ?? null, created_at_ms: now, updated_at_ms: now,
      };
      this.#insert({ ...bare, row_hash: rowHash(bare) });
      this.#event(bare.id, null, "queued", now, "enqueue");
      this.#db.exec("COMMIT");
      return publicDelivery(this.#row(bare.id)!);
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  list(roomId: string): RoomDelivery[] {
    this.#sweep();
    const rows = this.#db.prepare("SELECT * FROM room_deliveries WHERE room_id = ? ORDER BY created_at_ms, rowid").all(validRoom(roomId)) as unknown as DeliveryRow[];
    for (const row of rows) this.#assertRow(row);
    return rows.map(publicDelivery);
  }

  get(deliveryId: string): RoomDelivery | undefined {
    this.#sweep();
    const row = this.#row(validId(deliveryId, "INVALID_DELIVERY_ID"));
    if (!row) return undefined;
    this.#assertRow(row);
    return publicDelivery(row);
  }

  isListening(presenceId: string, roomId: string): boolean {
    const row = this.#db.prepare("SELECT 1 found FROM room_wait_leases WHERE presence_id = ? AND room_id = ? AND expires_at_ms > ?")
      .get(validId(presenceId, "INVALID_PRESENCE_ID"), validRoom(roomId), this.#now()) as { found: number } | undefined;
    return Boolean(row);
  }

  async wait(input: {
    presenceId: string;
    roomId: string;
    timeoutMs?: number;
    ledger: RoomLedger;
    signal?: AbortSignal;
    canContinue?: () => boolean;
  }): Promise<ClaimedRoomDelivery | undefined> {
    const presenceId = validId(input.presenceId, "INVALID_PRESENCE_ID");
    const roomId = validRoom(input.roomId);
    const timeoutMs = input.timeoutMs ?? MAX_WAIT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_WAIT_MS) throw new Error("INVALID_ROOM_WAIT_TIMEOUT");
    const waiterToken = randomUUID();
    const deadline = this.#now() + timeoutMs;
    this.#beginWait(presenceId, roomId, waiterToken, deadline + 2_000);
    try {
      while (true) {
        if (input.canContinue && !input.canContinue()) throw new Error("ROOM_STANDBY_REVOKED");
        const claimed = this.#claim(presenceId, roomId);
        if (claimed) {
          const message = input.ledger.getRange(roomId, claimed.ledgerSeq, claimed.ledgerSeq)[0];
          if (!message || message.hash !== claimed.ledgerHash) {
            this.fail({ presenceId, deliveryId: claimed.id, leaseToken: claimed.leaseToken, reason: "LEDGER_MESSAGE_MISMATCH" });
            throw new Error("DELIVERY_LEDGER_MISMATCH");
          }
          return { ...claimed, message };
        }
        const remaining = deadline - this.#now();
        if (remaining <= 0) return undefined;
        await wait(Math.min(WAIT_POLL_MS, remaining), input.signal);
        if (input.canContinue && !input.canContinue()) throw new Error("ROOM_STANDBY_REVOKED");
        this.#refreshWait(presenceId, waiterToken, deadline + 2_000);
      }
    } finally {
      this.#endWait(presenceId, waiterToken);
    }
  }

  ack(input: { presenceId: string; deliveryId: string; leaseToken: string; phase: "read" | "working" }): RoomDelivery {
    const expected = input.phase === "read" ? "delivered" : "read";
    return this.#transitionWithLease(input, expected, input.phase, "ack");
  }

  async reply(input: { presenceId: string; deliveryId: string; leaseToken: string; text: string; ledger: RoomLedger; author: string }): Promise<{ delivery: RoomDelivery; reply: RoomMessage }> {
    if (typeof input.text !== "string" || input.text.trim().length < 1) throw new Error("INVALID_ROOM_MESSAGE");
    const author = validAuthor(input.author);
    const leaseToken = validToken(input.leaseToken);
    const existing = this.#row(validId(input.deliveryId, "INVALID_DELIVERY_ID"));
    const presenceId = validId(input.presenceId, "INVALID_PRESENCE_ID");
    if (!existing) throw new Error("DELIVERY_NOT_FOUND");
    this.#assertRow(existing);
    if (existing.target_presence_id !== presenceId) throw new Error("DELIVERY_ACTOR_MISMATCH");
    if (existing.state === "replied" && existing.reply_ledger_seq !== null) {
      if (existing.completion_token_hash === null || !equalHash(tokenHash(leaseToken), existing.completion_token_hash)) throw new Error("DELIVERY_LEASE_MISMATCH");
      if (existing.reply_input_hash === null || !equalHash(replyInputHash(input.text), existing.reply_input_hash)) throw new Error("ROOM_IDEMPOTENCY_CONFLICT");
      const reply = existing.reply_key ? input.ledger.getByIdempotencyKey(existing.reply_key) : undefined;
      if (!reply || reply.seq !== existing.reply_ledger_seq) throw new Error("DELIVERY_REPLY_RECEIPT_MISSING");
      return { delivery: publicDelivery(existing), reply };
    }
    if (existing.reply_key !== null) {
      const committed = input.ledger.getByIdempotencyKey(existing.reply_key);
      if (committed) {
        this.#authorizedLease(input);
        if (existing.reply_input_hash === null || !equalHash(replyInputHash(input.text), existing.reply_input_hash)) {
          throw new Error("ROOM_IDEMPOTENCY_CONFLICT");
        }
        const delivery = this.#finishReply(input, committed);
        return { delivery, reply: committed };
      }
    }
    const prepared = this.#prepareReply({ ...input, author, leaseToken });
    const key = prepared.replyKey;
    const reply = input.ledger.appendIdempotent(prepared.roomId, prepared.replyAuthor, input.text, key);
    const delivery = this.#finishReply(input, reply);
    return { delivery, reply };
  }

  fail(input: { presenceId: string; deliveryId: string; leaseToken: string; reason: string }): RoomDelivery {
    if (typeof input.reason !== "string" || input.reason.trim().length < 1 || input.reason.length > 240 || input.reason.includes("\0")) throw new Error("INVALID_DELIVERY_FAILURE_REASON");
    const row = this.#authorizedLease(input);
    if (["replied", "failed", "cancelled"].includes(row.state)) return publicDelivery(row);
    return this.#update(row, "failed", { lease_token: null, lease_expires_at_ms: null, fail_reason: input.reason.trim() }, "agent-fail");
  }

  cancel(deliveryId: string): RoomDelivery {
    const row = this.#row(validId(deliveryId, "INVALID_DELIVERY_ID"));
    if (!row) throw new Error("DELIVERY_NOT_FOUND");
    this.#assertRow(row);
    if (["replied", "failed", "cancelled"].includes(row.state)) return publicDelivery(row);
    if (row.state === "working") return this.#update(row, row.state, { cancel_requested: 1 }, "cancel-requested");
    return this.#update(row, "cancelled", { cancel_requested: 1, lease_token: null, lease_expires_at_ms: null }, "owner-cancel");
  }

  retry(deliveryId: string): RoomDelivery {
    const row = this.#row(validId(deliveryId, "INVALID_DELIVERY_ID"));
    if (!row) throw new Error("DELIVERY_NOT_FOUND");
    this.#assertRow(row);
    if (row.state !== "failed" && row.state !== "cancelled") throw new Error("DELIVERY_NOT_RETRYABLE");
    return this.#update(row, "queued", { attempt: 0, cancel_requested: 0, lease_token: null, lease_expires_at_ms: null, fail_reason: null, reply_key: null, reply_author: null, reply_input_hash: null, completion_token_hash: null, reply_ledger_seq: null }, "owner-retry");
  }

  failTarget(presenceId: string, reason = "SEAT_OFFLINE"): RoomDelivery[] {
    const target = validId(presenceId, "INVALID_PRESENCE_ID");
    if (typeof reason !== "string" || reason.length < 1 || reason.length > 240) throw new Error("INVALID_DELIVERY_FAILURE_REASON");
    const rows = this.#db.prepare("SELECT * FROM room_deliveries WHERE target_presence_id = ? AND state IN ('queued','delivered','read','working')")
      .all(target) as unknown as DeliveryRow[];
    return rows.map((row) => this.#update(row, "failed", {
      lease_token: null,
      lease_expires_at_ms: null,
      fail_reason: reason,
    }, "seat-offline"));
  }

  failUnavailable(roomId: string, activePresenceIds: readonly string[]): RoomDelivery[] {
    const room = validRoom(roomId);
    const active = new Set(activePresenceIds.map((id) => validId(id, "INVALID_PRESENCE_ID")));
    const rows = this.#db.prepare("SELECT * FROM room_deliveries WHERE room_id = ? AND state IN ('queued','delivered','read','working')")
      .all(room) as unknown as DeliveryRow[];
    const failed: RoomDelivery[] = [];
    for (const row of rows) {
      this.#assertRow(row);
      if (!active.has(row.target_presence_id)) {
        failed.push(this.#update(row, "failed", {
          lease_token: null,
          lease_expires_at_ms: null,
          fail_reason: "SEAT_OFFLINE",
        }, "seat-offline"));
      }
    }
    return failed;
  }

  #claim(presenceId: string, roomId: string): (RoomDelivery & { leaseToken: string }) | undefined {
    const now = this.#now();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#sweep(now, true);
      const row = this.#db.prepare("SELECT * FROM room_deliveries WHERE target_presence_id = ? AND room_id = ? AND state = 'queued' ORDER BY created_at_ms, rowid LIMIT 1")
        .get(presenceId, roomId) as unknown as DeliveryRow | undefined;
      if (!row) { this.#db.exec("COMMIT"); return undefined; }
      this.#assertRow(row);
      const token = randomUUID();
      const next = this.#mutated(row, "delivered", { attempt: row.attempt + 1, lease_token: tokenHash(token), lease_expires_at_ms: now + this.#deliveryLeaseMs }, now);
      const changed = this.#replace(row, next, "claim");
      this.#db.exec("COMMIT");
      return { ...publicDelivery(changed), leaseToken: token };
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }

  #transitionWithLease(input: { presenceId: string; deliveryId: string; leaseToken: string }, expected: RoomDeliveryState, nextState: RoomDeliveryState, detail: string): RoomDelivery {
    const row = this.#authorizedLease(input);
    if (row.state === nextState || (nextState === "read" && row.state === "working")) {
      return this.#update(row, row.state, { lease_expires_at_ms: this.#now() + this.#deliveryLeaseMs }, `${detail}-replay`);
    }
    if (row.state !== expected) throw new Error("INVALID_DELIVERY_TRANSITION");
    return this.#update(row, nextState, { lease_expires_at_ms: this.#now() + this.#deliveryLeaseMs }, detail);
  }

  #prepareReply(input: { presenceId: string; deliveryId: string; leaseToken: string; author: string; text: string }): { roomId: string; replyKey: string; replyAuthor: string } {
    const row = this.#authorizedLease(input);
    if (row.state !== "working") throw new Error("DELIVERY_NOT_WORKING");
    const replyKey = row.reply_key ?? `room-delivery:${row.id}:reply`;
    const author = validAuthor(input.author);
    this.#update(row, row.state, {
      reply_key: replyKey,
      reply_author: author,
      reply_input_hash: replyInputHash(input.text),
      completion_token_hash: tokenHash(input.leaseToken),
      lease_expires_at_ms: this.#now() + this.#deliveryLeaseMs,
    }, "reply-prepared");
    return { roomId: row.room_id, replyKey, replyAuthor: author };
  }

  #finishReply(input: { presenceId: string; deliveryId: string; leaseToken: string }, reply: RoomMessage): RoomDelivery {
    const row = this.#authorizedLease(input);
    if (row.state !== "working" || row.reply_key !== `room-delivery:${row.id}:reply`) throw new Error("INVALID_DELIVERY_TRANSITION");
    return this.#update(row, "replied", {
      reply_ledger_seq: reply.seq,
      completion_token_hash: tokenHash(input.leaseToken),
      lease_token: null,
      lease_expires_at_ms: null,
    }, "reply-committed");
  }

  #authorizedLease(input: { presenceId: string; deliveryId: string; leaseToken: string }): DeliveryRow {
    const presenceId = validId(input.presenceId, "INVALID_PRESENCE_ID");
    const row = this.#row(validId(input.deliveryId, "INVALID_DELIVERY_ID"));
    const leaseToken = validToken(input.leaseToken);
    if (!row) throw new Error("DELIVERY_NOT_FOUND");
    this.#assertRow(row);
    if (row.target_presence_id !== presenceId) throw new Error("DELIVERY_ACTOR_MISMATCH");
    if (row.lease_token === null || !equalHash(row.lease_token, tokenHash(leaseToken))) throw new Error("DELIVERY_LEASE_MISMATCH");
    if (row.lease_expires_at_ms !== null && row.lease_expires_at_ms <= this.#now()) throw new Error("DELIVERY_LEASE_EXPIRED");
    return row;
  }

  #sweep(now = this.#now(), insideTransaction = false): void {
    if (insideTransaction) {
      this.#sweepRows(now);
      return;
    }
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#sweepRows(now);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  #sweepRows(now: number): void {
    this.#db.prepare("DELETE FROM room_wait_leases WHERE expires_at_ms <= ?").run(now);
    const expired = this.#db.prepare("SELECT * FROM room_deliveries WHERE state IN ('delivered','read','working') AND lease_expires_at_ms <= ?").all(now) as unknown as DeliveryRow[];
    for (const row of expired) {
      this.#assertRow(row);
      const cancelled = row.cancel_requested === 1;
      const exhausted = row.attempt >= row.max_attempts;
      const acknowledged = row.state === "read" || row.state === "working";
      const state: RoomDeliveryState = cancelled ? "cancelled" : exhausted && acknowledged ? "failed" : "queued";
      this.#replace(row, this.#mutated(row, state, {
        attempt: acknowledged ? row.attempt : Math.max(0, row.attempt - 1),
        lease_token: null, lease_expires_at_ms: null,
        ...(exhausted && acknowledged && !cancelled ? { fail_reason: "DELIVERY_ATTEMPTS_EXHAUSTED" } : {}),
      }, now), "lease-expired");
    }
  }

  #beginWait(presenceId: string, roomId: string, token: string, expires: number): void {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.prepare("DELETE FROM room_wait_leases WHERE expires_at_ms <= ?").run(this.#now());
      const existing = this.#db.prepare("SELECT 1 found FROM room_wait_leases WHERE presence_id = ?").get(presenceId);
      if (existing) throw new Error("ROOM_WAIT_ALREADY_ACTIVE");
      this.#db.prepare("INSERT INTO room_wait_leases (presence_id, room_id, waiter_token, expires_at_ms) VALUES (?, ?, ?, ?)").run(presenceId, roomId, token, expires);
      this.#db.exec("COMMIT");
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }

  #refreshWait(presenceId: string, token: string, expires: number): void {
    const result = this.#db.prepare("UPDATE room_wait_leases SET expires_at_ms = ? WHERE presence_id = ? AND waiter_token = ?").run(expires, presenceId, token);
    if (Number(result.changes) !== 1) throw new Error("ROOM_WAIT_LEASE_LOST");
  }

  #endWait(presenceId: string, token: string): void {
    this.#db.prepare("DELETE FROM room_wait_leases WHERE presence_id = ? AND waiter_token = ?").run(presenceId, token);
  }

  #update(row: DeliveryRow, state: RoomDeliveryState, fields: Partial<Omit<DeliveryRow, "id" | "room_id" | "ledger_seq" | "ledger_hash" | "target_presence_id" | "target_display_name" | "state" | "created_at_ms" | "updated_at_ms" | "row_hash">>, detail: string): RoomDelivery {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.#row(row.id);
      if (!current) throw new Error("DELIVERY_NOT_FOUND");
      this.#assertRow(current);
      if (current.row_hash !== row.row_hash) throw new Error("DELIVERY_CONCURRENT_UPDATE");
      const changed = this.#replace(current, this.#mutated(current, state, fields, this.#now()), detail);
      this.#db.exec("COMMIT");
      return publicDelivery(changed);
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }

  #mutated(row: DeliveryRow, state: RoomDeliveryState, fields: Record<string, unknown>, now: number): DeliveryRow {
    const bare = { ...row, ...fields, state, updated_at_ms: now } as DeliveryRow;
    const { row_hash: _old, ...hashable } = bare;
    return { ...hashable, row_hash: rowHash(hashable) };
  }

  #replace(previous: DeliveryRow, next: DeliveryRow, detail: string): DeliveryRow {
    const result = this.#db.prepare(`UPDATE room_deliveries SET state=?, attempt=?, max_attempts=?, lease_token=?, lease_expires_at_ms=?, cancel_requested=?, reply_key=?, reply_author=?, reply_input_hash=?, completion_token_hash=?, reply_ledger_seq=?, fail_reason=?, task_id=?, updated_at_ms=?, row_hash=? WHERE id=? AND row_hash=?`)
      .run(next.state, next.attempt, next.max_attempts, next.lease_token, next.lease_expires_at_ms, next.cancel_requested, next.reply_key, next.reply_author, next.reply_input_hash, next.completion_token_hash, next.reply_ledger_seq, next.fail_reason, next.task_id, next.updated_at_ms, next.row_hash, next.id, previous.row_hash);
    if (Number(result.changes) !== 1) throw new Error("DELIVERY_CONCURRENT_UPDATE");
    if (previous.state !== next.state || detail.includes("requested") || detail.includes("prepared")) this.#event(next.id, previous.state, next.state, next.updated_at_ms, detail);
    return next;
  }

  #insert(row: DeliveryRow): void {
    this.#db.prepare(`INSERT INTO room_deliveries (id,room_id,ledger_seq,ledger_hash,target_presence_id,target_display_name,state,attempt,max_attempts,lease_token,lease_expires_at_ms,cancel_requested,reply_key,reply_author,reply_input_hash,completion_token_hash,reply_ledger_seq,fail_reason,task_id,created_at_ms,updated_at_ms,row_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(row.id,row.room_id,row.ledger_seq,row.ledger_hash,row.target_presence_id,row.target_display_name,row.state,row.attempt,row.max_attempts,row.lease_token,row.lease_expires_at_ms,row.cancel_requested,row.reply_key,row.reply_author,row.reply_input_hash,row.completion_token_hash,row.reply_ledger_seq,row.fail_reason,row.task_id,row.created_at_ms,row.updated_at_ms,row.row_hash);
  }

  #event(id: string, from: RoomDeliveryState | null, to: RoomDeliveryState, at: number, detail: string): void {
    this.#db.prepare("INSERT INTO room_delivery_events (delivery_id, from_state, to_state, at_ms, detail) VALUES (?, ?, ?, ?, ?)").run(id, from, to, at, detail);
  }

  #row(id: string): DeliveryRow | undefined {
    return this.#db.prepare("SELECT * FROM room_deliveries WHERE id = ?").get(id) as unknown as DeliveryRow | undefined;
  }

  #assertRow(row: DeliveryRow): void {
    const { row_hash: actual, ...hashable } = row;
    if (!HASH_PATTERN.test(actual) || rowHash(hashable) !== actual) throw new Error("ROOM_INBOX_ROW_TAMPERED");
  }

  #verifyRows(): void {
    const rows = this.#db.prepare("SELECT * FROM room_deliveries").all() as unknown as DeliveryRow[];
    for (const row of rows) this.#assertRow(row);
  }
}
