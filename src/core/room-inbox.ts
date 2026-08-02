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
  sourcePresenceId?: string;
  sourceDisplayName?: string;
  targetPresenceId: string;
  targetDisplayName: string;
  threadId: string;
  replyToDeliveryId?: string;
  clientRequestId?: string;
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

export interface RoomDeliveryOutcome {
  delivery: RoomDelivery;
  reply?: RoomMessage;
}

interface DeliveryRow {
  id: string;
  room_id: string;
  ledger_seq: number;
  ledger_hash: string;
  source_presence_id: string | null;
  source_display_name: string | null;
  target_presence_id: string;
  target_display_name: string;
  thread_id: string;
  reply_to_delivery_id: string | null;
  client_request_id: string | null;
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

type LegacyV3DeliveryRow = Omit<DeliveryRow,
  "source_presence_id" | "source_display_name" | "thread_id" | "reply_to_delivery_id" | "client_request_id"
>;
type LegacyV1DeliveryRow = Omit<LegacyV3DeliveryRow,
  "reply_author" | "reply_input_hash" | "completion_token_hash"
>;
type InterimV4DeliveryRow = Omit<DeliveryRow, "client_request_id">;

const SCHEMA_VERSION = 5;
const ROOM_PATTERN = /^[a-z][a-z0-9-]{0,47}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const AUTHOR_PATTERN = /^(?:[a-z][a-z0-9-]{0,31}|(?:codex|claude|grok)（[\p{L}\p{N}._ -]{1,24}）)$/u;
const MAX_PENDING_PER_SEAT = 32;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_DELIVERY_LEASE_MS = 60_000;
const MAX_WAIT_MS = 4 * 60 * 60 * 1_000;
const WAIT_POLL_MS = 150;
const SQLITE_STARTUP_RETRY_MS = 3_000;
const SQLITE_STARTUP_POLL_MS = 25;
const DELIVERY_COLUMNS = [
  "id", "room_id", "ledger_seq", "ledger_hash", "source_presence_id",
  "source_display_name", "target_presence_id", "target_display_name", "thread_id",
  "reply_to_delivery_id", "client_request_id", "state", "attempt", "max_attempts",
  "lease_token", "lease_expires_at_ms", "cancel_requested", "reply_key", "reply_author",
  "reply_input_hash", "completion_token_hash", "reply_ledger_seq", "fail_reason", "task_id",
  "created_at_ms", "updated_at_ms", "row_hash",
].join(",");

function rowHash(row: Omit<DeliveryRow, "row_hash">): string {
  return createHash("sha256").update(JSON.stringify([
    row.id, row.room_id, row.ledger_seq, row.ledger_hash, row.source_presence_id,
    row.source_display_name, row.target_presence_id, row.target_display_name,
    row.thread_id, row.reply_to_delivery_id, row.client_request_id, row.state, row.attempt, row.max_attempts, row.lease_token,
    row.lease_expires_at_ms, row.cancel_requested, row.reply_key, row.reply_author,
    row.reply_input_hash, row.completion_token_hash, row.reply_ledger_seq,
    row.fail_reason, row.task_id, row.created_at_ms, row.updated_at_ms,
  ]), "utf8").digest("hex");
}

function legacyV3RowHash(row: Omit<LegacyV3DeliveryRow, "row_hash">): string {
  return createHash("sha256").update(JSON.stringify([
    row.id, row.room_id, row.ledger_seq, row.ledger_hash, row.target_presence_id,
    row.target_display_name, row.state, row.attempt, row.max_attempts, row.lease_token,
    row.lease_expires_at_ms, row.cancel_requested, row.reply_key, row.reply_author,
    row.reply_input_hash, row.completion_token_hash, row.reply_ledger_seq,
    row.fail_reason, row.task_id, row.created_at_ms, row.updated_at_ms,
  ]), "utf8").digest("hex");
}

function interimV4RowHash(row: Omit<InterimV4DeliveryRow, "row_hash">): string {
  return createHash("sha256").update(JSON.stringify([
    row.id, row.room_id, row.ledger_seq, row.ledger_hash, row.source_presence_id,
    row.source_display_name, row.target_presence_id, row.target_display_name,
    row.thread_id, row.reply_to_delivery_id, row.state, row.attempt, row.max_attempts,
    row.lease_token, row.lease_expires_at_ms, row.cancel_requested, row.reply_key,
    row.reply_author, row.reply_input_hash, row.completion_token_hash,
    row.reply_ledger_seq, row.fail_reason, row.task_id, row.created_at_ms,
    row.updated_at_ms,
  ]), "utf8").digest("hex");
}

function legacyV1RowHash(row: Omit<LegacyV1DeliveryRow, "row_hash">): string {
  return createHash("sha256").update(JSON.stringify([
    row.id, row.room_id, row.ledger_seq, row.ledger_hash, row.target_presence_id,
    row.target_display_name, row.state, row.attempt, row.max_attempts, row.lease_token,
    row.lease_expires_at_ms, row.cancel_requested, row.reply_key, row.reply_ledger_seq,
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

function validDisplayName(value: unknown, error: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 64 || value.includes("\0")) {
    throw new Error(error);
  }
  return value;
}

function publicDelivery(row: DeliveryRow): RoomDelivery {
  return {
    id: row.id,
    roomId: row.room_id,
    ledgerSeq: Number(row.ledger_seq),
    ledgerHash: row.ledger_hash,
    ...(row.source_presence_id === null ? {} : { sourcePresenceId: row.source_presence_id }),
    ...(row.source_display_name === null ? {} : { sourceDisplayName: row.source_display_name }),
    targetPresenceId: row.target_presence_id,
    targetDisplayName: row.target_display_name,
    threadId: row.thread_id,
    ...(row.reply_to_delivery_id === null ? {} : { replyToDeliveryId: row.reply_to_delivery_id }),
    ...(row.client_request_id === null ? {} : { clientRequestId: row.client_request_id }),
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

function sqliteBusy(error: unknown): boolean {
  return (error as { errcode?: unknown }).errcode === 5;
}

/** Owner-only exact-seat inbox. Message bodies stay in the append-only RoomLedger. */
export class RoomInboxStore {
  readonly path: string;
  readonly #db: DatabaseSync;
  readonly #now: () => number;
  readonly #deliveryLeaseMs: number;
  readonly #testOnlyMigrationFailureAfterRows: number | undefined;
  #closed = false;

  constructor(dataDirectory: string, options: {
    now?: () => number;
    deliveryLeaseMs?: number;
    testOnlyMigrationFailureAfterRows?: number;
  } = {}) {
    this.path = join(dataDirectory, "room-inbox.sqlite");
    this.#now = options.now ?? Date.now;
    this.#deliveryLeaseMs = options.deliveryLeaseMs ?? DEFAULT_DELIVERY_LEASE_MS;
    this.#testOnlyMigrationFailureAfterRows = options.testOnlyMigrationFailureAfterRows;
    if (!Number.isSafeInteger(this.#deliveryLeaseMs) || this.#deliveryLeaseMs < 5_000 || this.#deliveryLeaseMs > 300_000) {
      throw new Error("INVALID_DELIVERY_LEASE");
    }
    if (this.#testOnlyMigrationFailureAfterRows !== undefined &&
      (!Number.isSafeInteger(this.#testOnlyMigrationFailureAfterRows) || this.#testOnlyMigrationFailureAfterRows < 1)) {
      throw new Error("INVALID_TEST_MIGRATION_FAILURE_POINT");
    }
    this.#db = openOwnerDatabase(this.path);
    try {
      this.#db.exec("PRAGMA busy_timeout=3000; PRAGMA foreign_keys=ON;");
      this.#enableWal();
      this.#db.exec("PRAGMA secure_delete=ON;");
      verifyOwnerDatabaseFiles(this.path);
      const quick = this.#db.prepare("PRAGMA quick_check").get() as { quick_check?: string };
      if (quick.quick_check !== "ok") throw new Error("ROOM_INBOX_CORRUPT");
      while (true) {
        const version = this.#schemaVersion();
        if (version === SCHEMA_VERSION) break;
        if (version === 0) this.#migrate();
        else if (version === 1) this.#migrateV2();
        else if (version === 2) this.#migrateV3();
        else if (version === 3) this.#migrateV4();
        else if (version === 4) this.#migrateV5();
      }
      if (this.#db.prepare("PRAGMA foreign_key_check").all().length > 0) throw new Error("ROOM_INBOX_FOREIGN_KEY_VIOLATION");
      this.#verifyRows();
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }

  #enableWal(): void {
    const deadline = Date.now() + SQLITE_STARTUP_RETRY_MS;
    const sleeper = new Int32Array(new SharedArrayBuffer(4));
    while (true) {
      try {
        const row = this.#db.prepare("PRAGMA journal_mode=WAL").get() as { journal_mode?: string };
        if (String(row.journal_mode).toLowerCase() !== "wal") throw new Error("ROOM_INBOX_WAL_UNAVAILABLE");
        return;
      } catch (error) {
        if (!sqliteBusy(error) || Date.now() >= deadline) throw error;
        Atomics.wait(sleeper, 0, 0, SQLITE_STARTUP_POLL_MS);
      }
    }
  }

  #schemaVersion(): number {
    const version = Number((this.#db.prepare("PRAGMA user_version").get() as { user_version?: number }).user_version ?? 0);
    if (!Number.isSafeInteger(version) || version < 0 || version > SCHEMA_VERSION) {
      throw new Error("ROOM_INBOX_SCHEMA_UNSUPPORTED");
    }
    return version;
  }

  #migrate(): void {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      if (this.#schemaVersion() !== 0) {
        this.#db.exec("COMMIT");
        return;
      }
      this.#db.exec(`
        CREATE TABLE room_deliveries (
          id TEXT PRIMARY KEY,
          room_id TEXT NOT NULL,
          ledger_seq INTEGER NOT NULL,
          ledger_hash TEXT NOT NULL,
          source_presence_id TEXT,
          source_display_name TEXT,
          target_presence_id TEXT NOT NULL,
          target_display_name TEXT NOT NULL,
          thread_id TEXT NOT NULL,
          reply_to_delivery_id TEXT,
          client_request_id TEXT,
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
          UNIQUE(source_presence_id, client_request_id),
          CHECK ((lease_token IS NULL) = (lease_expires_at_ms IS NULL)),
          CHECK ((source_presence_id IS NULL) = (source_display_name IS NULL))
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
        PRAGMA user_version = 5;
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
      if (this.#schemaVersion() !== 1) {
        this.#db.exec("COMMIT");
        return;
      }
      const legacyRows = this.#db.prepare("SELECT * FROM room_deliveries").all() as unknown as LegacyV1DeliveryRow[];
      for (const row of legacyRows) {
        const { row_hash: actual, ...hashable } = row;
        if (!HASH_PATTERN.test(actual) || legacyV1RowHash(hashable) !== actual) {
          throw new Error("ROOM_INBOX_ROW_TAMPERED");
        }
      }
      this.#db.exec(`
        ALTER TABLE room_deliveries ADD COLUMN reply_author TEXT;
        ALTER TABLE room_deliveries ADD COLUMN reply_input_hash TEXT;
        ALTER TABLE room_deliveries ADD COLUMN completion_token_hash TEXT;
      `);
      const rows = this.#db.prepare("SELECT * FROM room_deliveries").all() as unknown as LegacyV3DeliveryRow[];
      for (const row of rows) {
        const { row_hash: _old, ...hashable } = row;
        this.#db.prepare("UPDATE room_deliveries SET row_hash = ? WHERE id = ?")
          .run(legacyV3RowHash(hashable), row.id);
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
      if (this.#schemaVersion() !== 2) {
        this.#db.exec("COMMIT");
        return;
      }
      const rows = this.#db.prepare("SELECT * FROM room_deliveries").all() as unknown as LegacyV3DeliveryRow[];
      for (const row of rows) {
        const { row_hash: actual, ...legacyHashable } = row;
        if (!HASH_PATTERN.test(actual) || legacyV3RowHash(legacyHashable) !== actual) {
          throw new Error("ROOM_INBOX_ROW_TAMPERED");
        }
        if (row.lease_token !== null && UUID_PATTERN.test(row.lease_token)) {
          row.lease_token = tokenHash(row.lease_token);
        } else if (row.lease_token !== null && !HASH_PATTERN.test(row.lease_token)) {
          throw new Error("ROOM_INBOX_LEASE_TOKEN_INVALID");
        }
        const { row_hash: _old, ...hashable } = row;
        this.#db.prepare("UPDATE room_deliveries SET lease_token=?, row_hash=? WHERE id=?")
          .run(row.lease_token, legacyV3RowHash(hashable), row.id);
      }
      this.#db.exec("PRAGMA user_version = 3; COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  #migrateV4(): void {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      if (this.#schemaVersion() !== 3) {
        this.#db.exec("COMMIT");
        return;
      }
      const legacyRows = this.#db.prepare("SELECT * FROM room_deliveries").all() as unknown as LegacyV3DeliveryRow[];
      for (const row of legacyRows) {
        const { row_hash: actual, ...hashable } = row;
        if (!HASH_PATTERN.test(actual) || legacyV3RowHash(hashable) !== actual) {
          throw new Error("ROOM_INBOX_ROW_TAMPERED");
        }
      }
      this.#db.exec(`
        CREATE TABLE room_deliveries_v4 (
          id TEXT PRIMARY KEY,
          room_id TEXT NOT NULL,
          ledger_seq INTEGER NOT NULL,
          ledger_hash TEXT NOT NULL,
          source_presence_id TEXT,
          source_display_name TEXT,
          target_presence_id TEXT NOT NULL,
          target_display_name TEXT NOT NULL,
          thread_id TEXT NOT NULL,
          reply_to_delivery_id TEXT,
          client_request_id TEXT,
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
          UNIQUE(source_presence_id, client_request_id),
          CHECK ((lease_token IS NULL) = (lease_expires_at_ms IS NULL)),
          CHECK ((source_presence_id IS NULL) = (source_display_name IS NULL))
        );
      `);
      for (const legacy of legacyRows) {
        const { row_hash: _old, ...base } = legacy;
        const migrated: Omit<DeliveryRow, "row_hash"> = {
          ...base,
          source_presence_id: null,
          source_display_name: null,
          thread_id: legacy.id,
          reply_to_delivery_id: null,
          client_request_id: null,
        };
        this.#db.prepare(`INSERT INTO room_deliveries_v4
          (id,room_id,ledger_seq,ledger_hash,source_presence_id,source_display_name,target_presence_id,target_display_name,thread_id,reply_to_delivery_id,client_request_id,state,attempt,max_attempts,lease_token,lease_expires_at_ms,cancel_requested,reply_key,reply_author,reply_input_hash,completion_token_hash,reply_ledger_seq,fail_reason,task_id,created_at_ms,updated_at_ms,row_hash)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(
            migrated.id, migrated.room_id, migrated.ledger_seq, migrated.ledger_hash,
            migrated.source_presence_id, migrated.source_display_name, migrated.target_presence_id,
            migrated.target_display_name, migrated.thread_id, migrated.reply_to_delivery_id,
            migrated.client_request_id, migrated.state, migrated.attempt, migrated.max_attempts,
            migrated.lease_token, migrated.lease_expires_at_ms, migrated.cancel_requested,
            migrated.reply_key, migrated.reply_author, migrated.reply_input_hash,
            migrated.completion_token_hash, migrated.reply_ledger_seq, migrated.fail_reason,
            migrated.task_id, migrated.created_at_ms, migrated.updated_at_ms, rowHash(migrated),
          );
      }
      this.#db.exec(`
        DROP TABLE room_deliveries;
        ALTER TABLE room_deliveries_v4 RENAME TO room_deliveries;
        CREATE INDEX room_deliveries_target_queue ON room_deliveries(target_presence_id, room_id, state, created_at_ms);
        PRAGMA user_version = 4;
        COMMIT;
      `);
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  #migrateV5(): void {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      if (this.#schemaVersion() !== 4) {
        this.#db.exec("COMMIT");
        return;
      }
      const canonicalColumns = [
        "id", "room_id", "ledger_seq", "ledger_hash", "source_presence_id",
        "source_display_name", "target_presence_id", "target_display_name", "thread_id",
        "reply_to_delivery_id", "client_request_id", "state", "attempt", "max_attempts",
        "lease_token", "lease_expires_at_ms", "cancel_requested", "reply_key", "reply_author",
        "reply_input_hash", "completion_token_hash", "reply_ledger_seq", "fail_reason", "task_id",
        "created_at_ms", "updated_at_ms", "row_hash",
      ];
      const interimColumns = [
        "id", "room_id", "ledger_seq", "ledger_hash", "target_presence_id",
        "target_display_name", "state", "attempt", "max_attempts", "lease_token",
        "lease_expires_at_ms", "cancel_requested", "reply_key", "reply_author",
        "reply_input_hash", "completion_token_hash", "reply_ledger_seq", "fail_reason",
        "task_id", "created_at_ms", "updated_at_ms", "row_hash", "source_presence_id",
        "source_display_name", "thread_id", "reply_to_delivery_id",
      ];
      type ColumnInfo = {
        cid: number;
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
        pk: number;
      };
      const actual = this.#db.prepare("PRAGMA table_info(room_deliveries)").all() as unknown as ColumnInfo[];
      const integerColumns = new Set([
        "ledger_seq", "attempt", "max_attempts", "lease_expires_at_ms", "cancel_requested",
        "reply_ledger_seq", "created_at_ms", "updated_at_ms",
      ]);
      const required = new Set([
        "room_id", "ledger_seq", "ledger_hash", "target_presence_id", "target_display_name",
        "state", "attempt", "max_attempts", "cancel_requested", "created_at_ms",
        "updated_at_ms", "row_hash",
      ]);
      const exactLayout = (columns: string[], requireThread: boolean): boolean => {
        if (actual.length !== columns.length) return false;
        return actual.every((column, index) => {
          const name = columns[index];
          if (column.cid !== index || column.name !== name) return false;
          const expectedType = integerColumns.has(column.name) ? "INTEGER" : "TEXT";
          const expectedRequired = required.has(column.name) || (requireThread && column.name === "thread_id");
          const expectedDefault = ["attempt", "cancel_requested"].includes(column.name) ? "0" : null;
          return column.type.toUpperCase() === expectedType &&
            column.notnull === (expectedRequired ? 1 : 0) &&
            column.dflt_value === expectedDefault && column.pk === (column.name === "id" ? 1 : 0);
        });
      };
      const tableSql = String((this.#db.prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='room_deliveries'",
      ).get() as { sql?: string } | undefined)?.sql ?? "").replace(/\s+/gu, " ").toLowerCase();
      const targetIndexSql = String((this.#db.prepare(
        "SELECT sql FROM sqlite_master WHERE type='index' AND name='room_deliveries_target_queue'",
      ).get() as { sql?: string } | undefined)?.sql ?? "").replace(/\s+/gu, " ").toLowerCase();
      const indexes = this.#db.prepare("PRAGMA index_list(room_deliveries)").all() as unknown as Array<{
        unique: number;
        origin: string;
        partial: number;
      }>;
      const triggerCount = Number((this.#db.prepare(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='trigger' AND tbl_name='room_deliveries'",
      ).get() as { count: number }).count);
      const targetIndexValid = /^create index room_deliveries_target_queue on room_deliveries\s*\(\s*target_presence_id\s*,\s*room_id\s*,\s*state\s*,\s*created_at_ms\s*\)$/u.test(targetIndexSql);
      const indexShape = (uniqueConstraints: number): boolean =>
        indexes.length === uniqueConstraints + 2 &&
        indexes.filter((index) => index.origin === "c" && index.unique === 0 && index.partial === 0).length === 1 &&
        indexes.filter((index) => index.origin === "u" && index.unique === 1 && index.partial === 0).length === uniqueConstraints &&
        indexes.filter((index) => index.origin === "pk" && index.unique === 1 && index.partial === 0).length === 1;
      const ledgerUnique = /unique\s*\(\s*room_id\s*,\s*ledger_seq\s*,\s*target_presence_id\s*\)/u.test(tableSql);
      const sourceUnique = /unique\s*\(\s*source_presence_id\s*,\s*client_request_id\s*\)/u.test(tableSql);
      const leaseCheck = /check\s*\(\s*\(\s*lease_token is null\s*\)\s*=\s*\(\s*lease_expires_at_ms is null\s*\)\s*\)/u.test(tableSql);
      const sourceCheck = /check\s*\(\s*\(\s*source_presence_id is null\s*\)\s*=\s*\(\s*source_display_name is null\s*\)\s*\)/u.test(tableSql);
      const stateCheck = /check\s*\(\s*state in\s*\(\s*'queued'\s*,\s*'delivered'\s*,\s*'read'\s*,\s*'working'\s*,\s*'replied'\s*,\s*'failed'\s*,\s*'cancelled'\s*\)\s*\)/u.test(tableSql);
      const attemptCheck = /check\s*\(\s*attempt between 0 and 100\s*\)/u.test(tableSql);
      const maxAttemptsCheck = /check\s*\(\s*max_attempts between 1 and 10\s*\)/u.test(tableSql);
      const cancelCheck = /check\s*\(\s*cancel_requested in\s*\(\s*0\s*,\s*1\s*\)\s*\)/u.test(tableSql);
      const commonChecks = stateCheck && attemptCheck && maxAttemptsCheck && cancelCheck && leaseCheck;
      const canonical = exactLayout(canonicalColumns, true) && targetIndexValid && indexShape(2) &&
        ledgerUnique && sourceUnique && commonChecks && sourceCheck && triggerCount === 0;
      const interim = exactLayout(interimColumns, false) && targetIndexValid && indexShape(1) &&
        ledgerUnique && !sourceUnique && commonChecks && !sourceCheck && triggerCount === 0;
      if (!canonical && !interim) throw new Error("ROOM_INBOX_SCHEMA_V4_UNRECOGNIZED");

      const migratedRows: DeliveryRow[] = [];
      if (canonical) {
        const rows = this.#db.prepare("SELECT * FROM room_deliveries ORDER BY rowid").all() as unknown as DeliveryRow[];
        for (const row of rows) {
          this.#assertRow(row);
          migratedRows.push(row);
        }
      } else {
        const rows = this.#db.prepare("SELECT * FROM room_deliveries ORDER BY rowid").all() as unknown as InterimV4DeliveryRow[];
        for (const row of rows) {
          const { row_hash: actualHash, ...hashable } = row;
          if (!HASH_PATTERN.test(actualHash) || interimV4RowHash(hashable) !== actualHash) {
            throw new Error("ROOM_INBOX_ROW_TAMPERED");
          }
          const hashableV5: Omit<DeliveryRow, "row_hash"> = {
            ...hashable,
            client_request_id: null,
          };
          const migrated = { ...hashableV5, row_hash: rowHash(hashableV5) };
          this.#assertRow(migrated);
          migratedRows.push(migrated);
        }
      }

      this.#db.exec(`
        CREATE TABLE room_deliveries_v5 (
          id TEXT PRIMARY KEY,
          room_id TEXT NOT NULL,
          ledger_seq INTEGER NOT NULL,
          ledger_hash TEXT NOT NULL,
          source_presence_id TEXT,
          source_display_name TEXT,
          target_presence_id TEXT NOT NULL,
          target_display_name TEXT NOT NULL,
          thread_id TEXT NOT NULL,
          reply_to_delivery_id TEXT,
          client_request_id TEXT,
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
          UNIQUE(source_presence_id, client_request_id),
          CHECK ((lease_token IS NULL) = (lease_expires_at_ms IS NULL)),
          CHECK ((source_presence_id IS NULL) = (source_display_name IS NULL))
        );
      `);
      const insert = this.#db.prepare(`INSERT INTO room_deliveries_v5
        (id,room_id,ledger_seq,ledger_hash,source_presence_id,source_display_name,target_presence_id,target_display_name,thread_id,reply_to_delivery_id,client_request_id,state,attempt,max_attempts,lease_token,lease_expires_at_ms,cancel_requested,reply_key,reply_author,reply_input_hash,completion_token_hash,reply_ledger_seq,fail_reason,task_id,created_at_ms,updated_at_ms,row_hash)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      let insertedRows = 0;
      for (const row of migratedRows) {
        insert.run(
          row.id, row.room_id, row.ledger_seq, row.ledger_hash, row.source_presence_id,
          row.source_display_name, row.target_presence_id, row.target_display_name, row.thread_id,
          row.reply_to_delivery_id, row.client_request_id, row.state, row.attempt, row.max_attempts,
          row.lease_token, row.lease_expires_at_ms, row.cancel_requested, row.reply_key,
          row.reply_author, row.reply_input_hash, row.completion_token_hash, row.reply_ledger_seq,
          row.fail_reason, row.task_id, row.created_at_ms, row.updated_at_ms, row.row_hash,
        );
        insertedRows += 1;
        if (insertedRows === this.#testOnlyMigrationFailureAfterRows) {
          throw new Error("ROOM_INBOX_MIGRATION_TEST_FAILURE");
        }
      }
      this.#db.exec(`
        DROP TABLE room_deliveries;
        ALTER TABLE room_deliveries_v5 RENAME TO room_deliveries;
        CREATE INDEX room_deliveries_target_queue ON room_deliveries(target_presence_id, room_id, state, created_at_ms);
        PRAGMA user_version = 5;
        COMMIT;
      `);
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

  enqueue(input: {
    message: RoomMessage;
    sourcePresenceId?: string;
    sourceDisplayName?: string;
    targetPresenceId: string;
    targetDisplayName: string;
    threadId?: string;
    replyToDeliveryId?: string;
    clientRequestId?: string;
    taskId?: string;
  }): RoomDelivery {
    const roomId = validRoom(input.message.roomId);
    const target = validId(input.targetPresenceId, "INVALID_TARGET_PRESENCE_ID");
    const targetDisplayName = validDisplayName(input.targetDisplayName, "INVALID_TARGET_DISPLAY_NAME");
    if ((input.sourcePresenceId === undefined) !== (input.sourceDisplayName === undefined)) {
      throw new Error("INVALID_SOURCE_IDENTITY");
    }
    const source = input.sourcePresenceId === undefined
      ? undefined
      : validId(input.sourcePresenceId, "INVALID_SOURCE_PRESENCE_ID");
    const sourceDisplayName = input.sourceDisplayName === undefined
      ? undefined
      : validDisplayName(input.sourceDisplayName, "INVALID_SOURCE_DISPLAY_NAME");
    if (source === target) throw new Error("ROOM_DELIVERY_SELF_TARGET");
    const requestedThreadId = input.threadId === undefined
      ? undefined
      : validId(input.threadId, "INVALID_THREAD_ID");
    const replyToDeliveryId = input.replyToDeliveryId === undefined
      ? undefined
      : validId(input.replyToDeliveryId, "INVALID_REPLY_TO_DELIVERY_ID");
    const clientRequestId = input.clientRequestId === undefined
      ? undefined
      : validId(input.clientRequestId, "INVALID_CLIENT_REQUEST_ID");
    if (clientRequestId !== undefined && source === undefined) throw new Error("CLIENT_REQUEST_REQUIRES_SOURCE");
    if ((requestedThreadId === undefined) !== (replyToDeliveryId === undefined)) {
      throw new Error("THREAD_CONTINUATION_FIELDS_MISMATCH");
    }
    if (!HASH_PATTERN.test(input.message.hash) || !Number.isSafeInteger(input.message.seq) || input.message.seq < 1) throw new Error("INVALID_DELIVERY_LEDGER_MESSAGE");
    if (input.taskId !== undefined && (typeof input.taskId !== "string" || input.taskId.length < 1 || input.taskId.length > 128 || input.taskId.includes("\0"))) throw new Error("INVALID_DELIVERY_TASK_ID");
    const now = this.#now();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#sweep(now, true);
      const existingByLedger = this.#db.prepare("SELECT * FROM room_deliveries WHERE room_id = ? AND ledger_seq = ? AND target_presence_id = ?")
        .get(roomId, input.message.seq, target) as unknown as DeliveryRow | undefined;
      const existingByRequest = clientRequestId === undefined ? undefined : this.#db.prepare(
        "SELECT * FROM room_deliveries WHERE source_presence_id = ? AND client_request_id = ?",
      ).get(source!, clientRequestId) as unknown as DeliveryRow | undefined;
      if (existingByLedger && existingByRequest && existingByLedger.id !== existingByRequest.id) {
        throw new Error("ROOM_DELIVERY_IDEMPOTENCY_CONFLICT");
      }
      const existing = existingByRequest ?? existingByLedger;
      if (existing) this.#assertRow(existing);
      const previous = replyToDeliveryId === undefined ? undefined : this.#row(replyToDeliveryId);
      if (replyToDeliveryId !== undefined) {
        if (!previous) throw new Error("REPLY_TO_DELIVERY_NOT_FOUND");
        this.#assertRow(previous);
        if (previous.room_id !== roomId) throw new Error("THREAD_ROOM_MISMATCH");
        if (previous.source_presence_id === null || source === undefined) {
          throw new Error("THREAD_PARTICIPANT_MISMATCH");
        }
        const previousParticipants = new Set([previous.source_presence_id, previous.target_presence_id]);
        if (!previousParticipants.has(source) || !previousParticipants.has(target)) {
          throw new Error("THREAD_PARTICIPANT_MISMATCH");
        }
        if (requestedThreadId !== undefined && requestedThreadId !== previous.thread_id) {
          throw new Error("THREAD_ID_MISMATCH");
        }
        if (previous.task_id !== (input.taskId ?? null)) throw new Error("THREAD_TASK_MISMATCH");
      }
      const threadId = existing?.thread_id ?? previous?.thread_id ?? requestedThreadId ?? randomUUID();
      if (existing) {
        if (
          existing.source_presence_id !== (source ?? null) ||
          existing.source_display_name !== (sourceDisplayName ?? null) ||
          existing.target_display_name !== targetDisplayName ||
          existing.target_presence_id !== target ||
          existing.ledger_seq !== input.message.seq ||
          existing.ledger_hash !== input.message.hash ||
          existing.thread_id !== threadId ||
          existing.reply_to_delivery_id !== (replyToDeliveryId ?? null) ||
          existing.client_request_id !== (clientRequestId ?? null) ||
          existing.task_id !== (input.taskId ?? null)
        ) {
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
        source_presence_id: source ?? null, source_display_name: sourceDisplayName ?? null,
        target_presence_id: target, target_display_name: targetDisplayName,
        thread_id: threadId, reply_to_delivery_id: replyToDeliveryId ?? null,
        client_request_id: clientRequestId ?? null,
        state: "queued", attempt: 0,
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

  async waitForReply(input: {
    sourcePresenceId: string;
    deliveryId: string;
    timeoutMs?: number;
    ledger: RoomLedger;
    signal?: AbortSignal;
    canContinue?: () => boolean;
  }): Promise<RoomDeliveryOutcome | undefined> {
    const sourcePresenceId = validId(input.sourcePresenceId, "INVALID_SOURCE_PRESENCE_ID");
    const deliveryId = validId(input.deliveryId, "INVALID_DELIVERY_ID");
    const timeoutMs = input.timeoutMs ?? MAX_WAIT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_WAIT_MS) {
      throw new Error("INVALID_ROOM_REPLY_WAIT_TIMEOUT");
    }
    const deadline = this.#now() + timeoutMs;
    while (true) {
      if (input.canContinue && !input.canContinue()) throw new Error("SOURCE_SEAT_OFFLINE");
      this.#sweep();
      const row = this.#row(deliveryId);
      if (!row) throw new Error("DELIVERY_NOT_FOUND");
      this.#assertRow(row);
      if (row.source_presence_id !== sourcePresenceId) throw new Error("DELIVERY_SOURCE_MISMATCH");
      if (row.reply_key !== null && row.state !== "replied") {
        const committed = input.ledger.getByIdempotencyKey(row.reply_key);
        if (committed && (
          row.state === "working" ||
          (row.state === "failed" && row.fail_reason === "REPLY_COMMIT_UNCERTAIN")
        )) {
          const delivery = this.#reconcileCommittedReply(row, committed);
          return { delivery, reply: committed };
        }
      }
      if (row.state === "replied") {
        if (row.reply_ledger_seq === null) throw new Error("DELIVERY_REPLY_RECEIPT_MISSING");
        const reply = input.ledger.getRange(row.room_id, row.reply_ledger_seq, row.reply_ledger_seq)[0];
        if (!reply) throw new Error("DELIVERY_REPLY_RECEIPT_MISSING");
        return { delivery: publicDelivery(row), reply };
      }
      if (row.state === "failed" || row.state === "cancelled") {
        return { delivery: publicDelivery(row) };
      }
      const remaining = deadline - this.#now();
      if (remaining <= 0) return undefined;
      await wait(Math.min(WAIT_POLL_MS, remaining), input.signal);
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
    if (existing.cancel_requested === 1) {
      const authorized = this.#authorizedLease(input);
      this.#update(authorized, "cancelled", {
        lease_token: null,
        lease_expires_at_ms: null,
      }, "cancel-confirmed");
      throw new Error("DELIVERY_CANCELLED");
    }
    if (existing.reply_key !== null) {
      const committed = input.ledger.getByIdempotencyKey(existing.reply_key);
      if (committed) {
        if (existing.reply_input_hash === null || !equalHash(replyInputHash(input.text), existing.reply_input_hash)) {
          throw new Error("ROOM_IDEMPOTENCY_CONFLICT");
        }
        const delivery = this.#finishReply({ ...input, author }, committed);
        return { delivery, reply: committed };
      }
    }
    const prepared = this.#prepareReply({ ...input, author, leaseToken });
    const key = prepared.replyKey;
    const reply = input.ledger.appendIdempotent(prepared.roomId, prepared.replyAuthor, input.text, key);
    const delivery = this.#finishReply({ ...input, author }, reply);
    return { delivery, reply };
  }

  fail(input: { presenceId: string; deliveryId: string; leaseToken: string; reason: string }): RoomDelivery {
    if (typeof input.reason !== "string" || input.reason.trim().length < 1 || input.reason.length > 240 || input.reason.includes("\0")) throw new Error("INVALID_DELIVERY_FAILURE_REASON");
    const row = this.#authorizedLease(input);
    if (["replied", "failed", "cancelled"].includes(row.state)) return publicDelivery(row);
    if (row.reply_key !== null) return publicDelivery(row);
    if (row.cancel_requested === 1) {
      return this.#update(row, "cancelled", {
        lease_token: null,
        lease_expires_at_ms: null,
        fail_reason: input.reason.trim(),
      }, "cancel-confirmed");
    }
    return this.#update(row, "failed", { lease_token: null, lease_expires_at_ms: null, fail_reason: input.reason.trim() }, "agent-fail");
  }

  cancel(deliveryId: string): RoomDelivery {
    const row = this.#row(validId(deliveryId, "INVALID_DELIVERY_ID"));
    if (!row) throw new Error("DELIVERY_NOT_FOUND");
    this.#assertRow(row);
    if (["replied", "failed", "cancelled"].includes(row.state)) return publicDelivery(row);
    if (row.reply_key !== null) return publicDelivery(row);
    if (row.state === "working") return this.#update(row, row.state, { cancel_requested: 1 }, "cancel-requested");
    return this.#update(row, "cancelled", { cancel_requested: 1, lease_token: null, lease_expires_at_ms: null }, "owner-cancel");
  }

  retry(deliveryId: string): RoomDelivery {
    const row = this.#row(validId(deliveryId, "INVALID_DELIVERY_ID"));
    if (!row) throw new Error("DELIVERY_NOT_FOUND");
    this.#assertRow(row);
    if (row.state !== "failed" && row.state !== "cancelled") throw new Error("DELIVERY_NOT_RETRYABLE");
    if (row.fail_reason === "REPLY_COMMIT_UNCERTAIN") throw new Error("DELIVERY_REPLY_RECOVERY_REQUIRED");
    return this.#update(row, "queued", { attempt: 0, cancel_requested: 0, lease_token: null, lease_expires_at_ms: null, fail_reason: null, reply_key: null, reply_author: null, reply_input_hash: null, completion_token_hash: null, reply_ledger_seq: null }, "owner-retry");
  }

  failTarget(presenceId: string, reason = "SEAT_OFFLINE"): RoomDelivery[] {
    const target = validId(presenceId, "INVALID_PRESENCE_ID");
    if (typeof reason !== "string" || reason.length < 1 || reason.length > 240) throw new Error("INVALID_DELIVERY_FAILURE_REASON");
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.#db.prepare("SELECT * FROM room_deliveries WHERE target_presence_id = ? AND state IN ('queued','delivered','read','working') AND reply_key IS NULL")
        .all(target) as unknown as DeliveryRow[];
      const failed = rows.map((row) => {
        this.#assertRow(row);
        return publicDelivery(this.#replace(row, this.#mutated(row, "failed", {
          lease_token: null,
          lease_expires_at_ms: null,
          fail_reason: reason,
        }, this.#now()), "seat-offline"));
      });
      this.#db.exec("COMMIT");
      return failed;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  failDeliveryIfTargetUnavailable(input: {
    deliveryId: string;
    targetPresenceId: string;
    reason?: string;
  }): RoomDelivery | undefined {
    const deliveryId = validId(input.deliveryId, "INVALID_DELIVERY_ID");
    const targetPresenceId = validId(input.targetPresenceId, "INVALID_PRESENCE_ID");
    const reason = input.reason ?? "SEAT_OFFLINE";
    if (typeof reason !== "string" || reason.length < 1 || reason.length > 240) {
      throw new Error("INVALID_DELIVERY_FAILURE_REASON");
    }
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#row(deliveryId);
      if (!row) throw new Error("DELIVERY_NOT_FOUND");
      this.#assertRow(row);
      if (row.target_presence_id !== targetPresenceId) throw new Error("DELIVERY_TARGET_MISMATCH");
      if (!["queued", "delivered", "read", "working"].includes(row.state) || row.reply_key !== null) {
        this.#db.exec("COMMIT");
        return undefined;
      }
      const failed = publicDelivery(this.#replace(row, this.#mutated(row, "failed", {
        lease_token: null,
        lease_expires_at_ms: null,
        fail_reason: reason,
      }, this.#now()), "seat-offline"));
      this.#db.exec("COMMIT");
      return failed;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  failUnavailable(roomId: string, activePresenceIds: readonly string[]): RoomDelivery[] {
    const room = validRoom(roomId);
    const active = new Set(activePresenceIds.map((id) => validId(id, "INVALID_PRESENCE_ID")));
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.#db.prepare("SELECT * FROM room_deliveries WHERE room_id = ? AND state IN ('queued','delivered','read','working') AND reply_key IS NULL")
        .all(room) as unknown as DeliveryRow[];
      const failed: RoomDelivery[] = [];
      for (const row of rows) {
        this.#assertRow(row);
        if (!active.has(row.target_presence_id)) {
          failed.push(publicDelivery(this.#replace(row, this.#mutated(row, "failed", {
            lease_token: null,
            lease_expires_at_ms: null,
            fail_reason: "SEAT_OFFLINE",
          }, this.#now()), "seat-offline")));
        }
      }
      this.#db.exec("COMMIT");
      return failed;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
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
    if (row.cancel_requested === 1) {
      this.#update(row, "cancelled", { lease_token: null, lease_expires_at_ms: null }, "cancel-confirmed");
      throw new Error("DELIVERY_CANCELLED");
    }
    const replyKey = `room-delivery:${row.id}:reply`;
    const author = validAuthor(input.author);
    const inputHash = replyInputHash(input.text);
    const completionHash = tokenHash(input.leaseToken);
    if (row.reply_key !== null) {
      if (
        row.reply_key !== replyKey || row.reply_author !== author ||
        row.reply_input_hash === null || !equalHash(row.reply_input_hash, inputHash) ||
        row.completion_token_hash === null || !equalHash(row.completion_token_hash, completionHash)
      ) throw new Error("ROOM_IDEMPOTENCY_CONFLICT");
      return { roomId: row.room_id, replyKey, replyAuthor: author };
    }
    this.#update(row, row.state, {
      reply_key: replyKey,
      reply_author: author,
      reply_input_hash: inputHash,
      completion_token_hash: completionHash,
      lease_expires_at_ms: this.#now() + this.#deliveryLeaseMs,
    }, "reply-prepared");
    return { roomId: row.room_id, replyKey, replyAuthor: author };
  }

  #finishReply(input: { presenceId: string; deliveryId: string; leaseToken: string; author: string; text: string }, reply: RoomMessage): RoomDelivery {
    const validateBinding = (row: DeliveryRow): void => {
      const key = `room-delivery:${row.id}:reply`;
      if (
        row.reply_key !== key || row.reply_author !== input.author ||
        row.reply_input_hash === null || !equalHash(row.reply_input_hash, replyInputHash(input.text)) ||
        row.completion_token_hash === null || !equalHash(row.completion_token_hash, tokenHash(input.leaseToken)) ||
        reply.roomId !== row.room_id || reply.author !== row.reply_author
      ) throw new Error("ROOM_IDEMPOTENCY_CONFLICT");
    };
    const row = this.#row(validId(input.deliveryId, "INVALID_DELIVERY_ID"));
    if (!row) throw new Error("DELIVERY_NOT_FOUND");
    this.#assertRow(row);
    if (row.target_presence_id !== validId(input.presenceId, "INVALID_PRESENCE_ID")) throw new Error("DELIVERY_ACTOR_MISMATCH");
    validateBinding(row);
    if (row.state === "replied") {
      if (row.reply_ledger_seq !== reply.seq) throw new Error("DELIVERY_REPLY_RECEIPT_MISSING");
      return publicDelivery(row);
    }
    if (row.state === "failed" && row.fail_reason === "REPLY_COMMIT_UNCERTAIN") {
      return this.#reconcileCommittedReply(row, reply);
    }
    const authorized = this.#authorizedLease(input);
    if (authorized.state !== "working") throw new Error("INVALID_DELIVERY_TRANSITION");
    try {
      return this.#update(authorized, "replied", {
        reply_ledger_seq: reply.seq,
        completion_token_hash: tokenHash(input.leaseToken),
        cancel_requested: 0,
        lease_token: null,
        lease_expires_at_ms: null,
      }, "reply-committed");
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "DELIVERY_CONCURRENT_UPDATE") throw error;
      const completed = this.#row(authorized.id);
      if (!completed) throw new Error("DELIVERY_NOT_FOUND");
      this.#assertRow(completed);
      validateBinding(completed);
      if (completed.state !== "replied" || completed.reply_ledger_seq !== reply.seq) throw error;
      return publicDelivery(completed);
    }
  }

  #reconcileCommittedReply(row: DeliveryRow, reply: RoomMessage): RoomDelivery {
    if (
      row.reply_key === null || row.reply_author === null ||
      reply.roomId !== row.room_id || reply.author !== row.reply_author || reply.kind !== "chat"
    ) throw new Error("DELIVERY_REPLY_RECEIPT_MISMATCH");
    if (row.state === "replied") {
      if (row.reply_ledger_seq !== reply.seq) throw new Error("DELIVERY_REPLY_RECEIPT_MISSING");
      return publicDelivery(row);
    }
    if (
      row.state !== "working" &&
      !(row.state === "failed" && row.fail_reason === "REPLY_COMMIT_UNCERTAIN")
    ) throw new Error("INVALID_DELIVERY_TRANSITION");
    try {
      return this.#update(row, "replied", {
        reply_ledger_seq: reply.seq,
        cancel_requested: 0,
        lease_token: null,
        lease_expires_at_ms: null,
        fail_reason: null,
      }, "reply-reconciled");
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "DELIVERY_CONCURRENT_UPDATE") throw error;
      const completed = this.#row(row.id);
      if (!completed) throw new Error("DELIVERY_NOT_FOUND");
      this.#assertRow(completed);
      if (completed.state !== "replied" || completed.reply_ledger_seq !== reply.seq) throw error;
      return publicDelivery(completed);
    }
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
      if (row.reply_key !== null) {
        this.#replace(row, this.#mutated(row, "failed", {
          lease_token: null,
          lease_expires_at_ms: null,
          fail_reason: "REPLY_COMMIT_UNCERTAIN",
        }, now), "reply-commit-uncertain");
        continue;
      }
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

  #update(row: DeliveryRow, state: RoomDeliveryState, fields: Partial<Omit<DeliveryRow, "id" | "room_id" | "ledger_seq" | "ledger_hash" | "source_presence_id" | "source_display_name" | "target_presence_id" | "target_display_name" | "thread_id" | "reply_to_delivery_id" | "client_request_id" | "state" | "created_at_ms" | "updated_at_ms" | "row_hash">>, detail: string): RoomDelivery {
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
    this.#db.prepare(`INSERT INTO room_deliveries (id,room_id,ledger_seq,ledger_hash,source_presence_id,source_display_name,target_presence_id,target_display_name,thread_id,reply_to_delivery_id,client_request_id,state,attempt,max_attempts,lease_token,lease_expires_at_ms,cancel_requested,reply_key,reply_author,reply_input_hash,completion_token_hash,reply_ledger_seq,fail_reason,task_id,created_at_ms,updated_at_ms,row_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(row.id,row.room_id,row.ledger_seq,row.ledger_hash,row.source_presence_id,row.source_display_name,row.target_presence_id,row.target_display_name,row.thread_id,row.reply_to_delivery_id,row.client_request_id,row.state,row.attempt,row.max_attempts,row.lease_token,row.lease_expires_at_ms,row.cancel_requested,row.reply_key,row.reply_author,row.reply_input_hash,row.completion_token_hash,row.reply_ledger_seq,row.fail_reason,row.task_id,row.created_at_ms,row.updated_at_ms,row.row_hash);
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
    validId(row.id, "ROOM_INBOX_ROW_INVALID");
    validRoom(row.room_id);
    validId(row.target_presence_id, "ROOM_INBOX_ROW_INVALID");
    validDisplayName(row.target_display_name, "ROOM_INBOX_ROW_INVALID");
    validId(row.thread_id, "ROOM_INBOX_ROW_INVALID");
    if ((row.source_presence_id === null) !== (row.source_display_name === null)) {
      throw new Error("ROOM_INBOX_ROW_INVALID");
    }
    if (row.source_presence_id !== null) {
      validId(row.source_presence_id, "ROOM_INBOX_ROW_INVALID");
      validDisplayName(row.source_display_name, "ROOM_INBOX_ROW_INVALID");
      if (row.source_presence_id === row.target_presence_id) throw new Error("ROOM_INBOX_ROW_INVALID");
    }
    if (row.reply_to_delivery_id !== null) validId(row.reply_to_delivery_id, "ROOM_INBOX_ROW_INVALID");
    if (row.client_request_id !== null) {
      validId(row.client_request_id, "ROOM_INBOX_ROW_INVALID");
      if (row.source_presence_id === null) throw new Error("ROOM_INBOX_ROW_INVALID");
    }
  }

  #verifyRows(): void {
    const rows = this.#db.prepare(`SELECT ${DELIVERY_COLUMNS} FROM room_deliveries`).all() as unknown as DeliveryRow[];
    for (const row of rows) this.#assertRow(row);
  }
}
