import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync, closeSync, constants, fstatSync, fsyncSync, linkSync, mkdirSync, openSync,
  readFileSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type AuditOutcome = "allowed" | "denied" | "succeeded" | "failed";

export interface CollaborationAuditInput {
  roomId?: string;
  taskId?: string;
  type: string;
  actor: string;
  onBehalfOf?: string;
  executedBy?: string;
  leaseEpoch?: number;
  action?: string;
  path?: string;
  outcome: AuditOutcome;
  detail?: Record<string, unknown>;
}

export interface CollaborationAuditEvent extends CollaborationAuditInput {
  seq: number;
  atMs: number;
  previousMac: string;
  mac: string;
}

interface AuditRow {
  seq: number;
  at_ms: number;
  room_id: string | null;
  task_id: string | null;
  type: string;
  actor: string;
  on_behalf_of: string | null;
  executed_by: string | null;
  lease_epoch: number | null;
  action: string | null;
  path: string | null;
  outcome: AuditOutcome;
  detail_json: string;
  previous_mac: string;
  mac: string;
}

const MAC_PATTERN = /^[0-9a-f]{64}$/u;
const FIELD_PATTERN = /^[^\0\r\n\t]+$/u;
const SCHEMA_VERSION = 1;

function field(value: unknown, error: string, max = 256): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max || !FIELD_PATTERN.test(value)) throw new Error(error);
  return value;
}

function optionalField(value: unknown, error: string, max = 256): string | undefined {
  return value === undefined ? undefined : field(value, error, max);
}

function canonical(row: Omit<AuditRow, "mac">): string {
  return JSON.stringify([
    row.seq, row.at_ms, row.room_id, row.task_id, row.type, row.actor,
    row.on_behalf_of, row.executed_by, row.lease_epoch, row.action, row.path,
    row.outcome, row.detail_json, row.previous_mac,
  ]);
}

function secureEqual(left: string, right: string): boolean {
  if (!MAC_PATTERN.test(left) || !MAC_PATTERN.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

/**
 * Owner-only technical audit chain. The HMAC key is stored outside the SQLite
 * database and is inaccessible to sandboxed Workspace MCP workers.
 */
export class CollaborationAuditLog {
  readonly path: string;
  readonly keyPath: string;
  readonly #db: DatabaseSync;
  readonly #key: Buffer;
  readonly #now: () => number;
  #closed = false;

  constructor(dataDirectory: string, options: { now?: () => number } = {}) {
    mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    chmodSync(dataDirectory, 0o700);
    this.path = join(dataDirectory, "collaboration-audit.sqlite");
    this.keyPath = join(dataDirectory, "collaboration-audit.key");
    this.#key = this.#loadKey();
    this.#now = options.now ?? Date.now;
    this.#db = new DatabaseSync(this.path);
    try {
      chmodSync(this.path, 0o600);
      this.#db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON; PRAGMA busy_timeout=3000;");
      const quick = this.#db.prepare("PRAGMA quick_check").get() as { quick_check?: string };
      if (quick.quick_check !== "ok") throw new Error("COLLABORATION_AUDIT_STORE_CORRUPT");
      const version = Number((this.#db.prepare("PRAGMA user_version").get() as { user_version?: number }).user_version ?? 0);
      if (!Number.isSafeInteger(version) || version < 0 || version > SCHEMA_VERSION) {
        throw new Error("COLLABORATION_AUDIT_SCHEMA_UNSUPPORTED");
      }
      if (version === 0) this.#migrate();
      if (this.#db.prepare("PRAGMA foreign_key_check").all().length > 0) {
        throw new Error("COLLABORATION_AUDIT_FOREIGN_KEY_VIOLATION");
      }
      if (!this.verify()) throw new Error("COLLABORATION_AUDIT_CHAIN_INVALID");
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }

  append(input: CollaborationAuditInput): CollaborationAuditEvent {
    this.#assertOpen();
    const type = field(input.type, "AUDIT_TYPE_INVALID", 96);
    const actor = field(input.actor, "AUDIT_ACTOR_INVALID");
    const roomId = optionalField(input.roomId, "AUDIT_ROOM_INVALID", 48) ?? null;
    const taskId = optionalField(input.taskId, "AUDIT_TASK_INVALID", 128) ?? null;
    const onBehalfOf = optionalField(input.onBehalfOf, "AUDIT_ON_BEHALF_INVALID") ?? null;
    const executedBy = optionalField(input.executedBy, "AUDIT_EXECUTOR_INVALID") ?? null;
    const action = optionalField(input.action, "AUDIT_ACTION_INVALID", 96) ?? null;
    const path = optionalField(input.path, "AUDIT_PATH_INVALID", 4_096) ?? null;
    if (!(["allowed", "denied", "succeeded", "failed"] as unknown[]).includes(input.outcome)) throw new Error("AUDIT_OUTCOME_INVALID");
    if (input.leaseEpoch !== undefined && (!Number.isSafeInteger(input.leaseEpoch) || input.leaseEpoch < 1)) throw new Error("AUDIT_EPOCH_INVALID");
    const detailJson = JSON.stringify(input.detail ?? {});
    if (Buffer.byteLength(detailJson) > 16_384) throw new Error("AUDIT_DETAIL_TOO_LARGE");
    const at = this.#now();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const last = this.#db.prepare("SELECT seq,mac FROM collaboration_audit ORDER BY seq DESC LIMIT 1").get() as { seq: number; mac: string } | undefined;
      const seq = (last?.seq ?? 0) + 1;
      const previousMac = last?.mac ?? "0".repeat(64);
      const bare: Omit<AuditRow, "mac"> = {
        seq, at_ms: at, room_id: roomId, task_id: taskId, type, actor,
        on_behalf_of: onBehalfOf, executed_by: executedBy,
        lease_epoch: input.leaseEpoch ?? null, action, path,
        outcome: input.outcome, detail_json: detailJson, previous_mac: previousMac,
      };
      const mac = this.#mac(bare);
      this.#db.prepare(`INSERT INTO collaboration_audit
        (seq,at_ms,room_id,task_id,type,actor,on_behalf_of,executed_by,lease_epoch,action,path,outcome,detail_json,previous_mac,mac)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        seq, at, roomId, taskId, type, actor, onBehalfOf, executedBy,
        input.leaseEpoch ?? null, action, path, input.outcome, detailJson, previousMac, mac,
      );
      this.#db.exec("COMMIT");
      return this.#public({ ...bare, mac });
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  list(input: { roomId?: string; after?: number; limit?: number } = {}): CollaborationAuditEvent[] {
    this.#assertOpen();
    const after = input.after ?? 0;
    const limit = input.limit ?? 100;
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error("AUDIT_RANGE_INVALID");
    }
    const rows = input.roomId
      ? this.#db.prepare("SELECT * FROM collaboration_audit WHERE room_id=? AND seq>? ORDER BY seq LIMIT ?")
        .all(field(input.roomId, "AUDIT_ROOM_INVALID", 48), after, limit)
      : this.#db.prepare("SELECT * FROM collaboration_audit WHERE seq>? ORDER BY seq LIMIT ?").all(after, limit);
    return (rows as unknown as AuditRow[]).map((row) => this.#public(row));
  }

  inventory(): { database: string; key: string; schemaVersion: number; databaseBytes: number; events: number } {
    this.#assertOpen();
    const row = this.#db.prepare("SELECT COUNT(*) events FROM collaboration_audit").get() as { events: number };
    return {
      database: this.path,
      key: this.keyPath,
      schemaVersion: SCHEMA_VERSION,
      databaseBytes: statSync(this.path).size,
      events: Number(row.events),
    };
  }

  integrity(): { schemaVersion: number; quickCheck: string; chainValid: boolean } {
    this.#assertOpen();
    const quickCheck = String((this.#db.prepare("PRAGMA quick_check").get() as { quick_check?: string }).quick_check ?? "unknown");
    return { schemaVersion: SCHEMA_VERSION, quickCheck, chainValid: this.verify() };
  }

  verify(): boolean {
    this.#assertOpen();
    let previous = "0".repeat(64);
    let expectedSeq = 1;
    for (const row of this.#db.prepare("SELECT * FROM collaboration_audit ORDER BY seq").all() as unknown as AuditRow[]) {
      const { mac, ...bare } = row;
      if (row.seq !== expectedSeq || row.previous_mac !== previous || !secureEqual(this.#mac(bare), mac)) return false;
      previous = mac;
      expectedSeq += 1;
    }
    return true;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }

  #public(row: AuditRow): CollaborationAuditEvent {
    let detail: Record<string, unknown>;
    try {
      const parsed = JSON.parse(row.detail_json) as unknown;
      detail = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
      throw new Error("COLLABORATION_AUDIT_DETAIL_INVALID");
    }
    return {
      seq: row.seq, atMs: row.at_ms, type: row.type, actor: row.actor,
      outcome: row.outcome, previousMac: row.previous_mac, mac: row.mac,
      ...(row.room_id ? { roomId: row.room_id } : {}),
      ...(row.task_id ? { taskId: row.task_id } : {}),
      ...(row.on_behalf_of ? { onBehalfOf: row.on_behalf_of } : {}),
      ...(row.executed_by ? { executedBy: row.executed_by } : {}),
      ...(row.lease_epoch === null ? {} : { leaseEpoch: row.lease_epoch }),
      ...(row.action ? { action: row.action } : {}),
      ...(row.path ? { path: row.path } : {}),
      ...(Object.keys(detail).length > 0 ? { detail } : {}),
    };
  }

  #mac(row: Omit<AuditRow, "mac">): string {
    return createHmac("sha256", this.#key).update(canonical(row), "utf8").digest("hex");
  }

  #migrate(): void {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.exec(`CREATE TABLE IF NOT EXISTS collaboration_audit (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, at_ms INTEGER NOT NULL,
        room_id TEXT, task_id TEXT, type TEXT NOT NULL, actor TEXT NOT NULL,
        on_behalf_of TEXT, executed_by TEXT, lease_epoch INTEGER,
        action TEXT, path TEXT, outcome TEXT NOT NULL CHECK(outcome IN ('allowed','denied','succeeded','failed')),
        detail_json TEXT NOT NULL, previous_mac TEXT NOT NULL, mac TEXT NOT NULL
      ) STRICT;
      PRAGMA user_version = 1;
      COMMIT;`);
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  #loadKey(): Buffer {
    const temporary = `${this.keyPath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      const handle = openSync(temporary, "wx", 0o600);
      try {
        writeFileSync(handle, randomBytes(32));
        fsyncSync(handle);
      } finally {
        closeSync(handle);
      }
      try { linkSync(temporary, this.keyPath); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    } finally {
      try { unlinkSync(temporary); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const noFollow = constants.O_NOFOLLOW ?? 0;
    let handle: number;
    try {
      handle = openSync(this.keyPath, constants.O_RDONLY | noFollow);
    } catch {
      throw new Error("COLLABORATION_AUDIT_KEY_UNSAFE");
    }
    try {
      const metadata = fstatSync(handle);
      const owner = typeof process.getuid === "function" ? process.getuid() : metadata.uid;
      if (!metadata.isFile() || metadata.uid !== owner || metadata.nlink !== 1
        || (metadata.mode & 0o077) !== 0 || metadata.size !== 32) {
        throw new Error("COLLABORATION_AUDIT_KEY_UNSAFE");
      }
      const key = readFileSync(handle);
      if (key.length !== 32) throw new Error("COLLABORATION_AUDIT_KEY_INVALID");
      return key;
    } finally {
      closeSync(handle);
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("COLLABORATION_AUDIT_CLOSED");
  }
}
