import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { WriterLease, WriterProvider } from "./writer-lease.ts";

export type DelegatedAccess = "read-only" | "write";
export type DelegationState = "active" | "revoked" | "completed";

export interface WriterDelegation {
  id: string;
  taskId: string;
  roomId: string;
  parentLeaseId: string;
  parentEpoch: number;
  parentProvider: WriterProvider;
  parentActorId: string;
  onBehalfOf: string;
  childProvider: WriterProvider;
  childActorId: string;
  displayName: string;
  executedBy: string;
  access: DelegatedAccess;
  workspace: string;
  state: DelegationState;
  createdAtMs: number;
  revokedAtMs?: number;
  reason?: string;
}

export interface GrantedWriterDelegation {
  delegation: WriterDelegation;
  capabilityToken?: string;
}

interface DelegationRow {
  id: string;
  task_id: string;
  room_id: string;
  parent_lease_id: string;
  parent_epoch: number;
  parent_provider: WriterProvider;
  parent_actor_id: string;
  on_behalf_of: string;
  child_provider: WriterProvider;
  child_actor_id: string;
  display_name: string;
  executed_by: string;
  access: DelegatedAccess;
  workspace: string;
  capability_hash: string | null;
  state: DelegationState;
  created_at_ms: number;
  revoked_at_ms: number | null;
  reason: string | null;
  row_hash: string;
}

const PROVIDERS = new Set<WriterProvider>(["codex", "claude", "grok"]);
const LABEL_PATTERN = /^[\p{L}\p{N}._ -]{1,24}$/u;
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const SCHEMA_VERSION = 1;
const MAX_ACTIVE_DELEGATIONS_PER_LEASE = 8;

function sha(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function safeEqual(left: string, right: string): boolean {
  if (!HASH_PATTERN.test(left) || !HASH_PATTERN.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function hashRow(row: Omit<DelegationRow, "row_hash">): string {
  return sha(JSON.stringify(Object.values(row)));
}

function provider(value: unknown): WriterProvider {
  if (!PROVIDERS.has(value as WriterProvider)) throw new Error("DELEGATION_PROVIDER_INVALID");
  return value as WriterProvider;
}

function text(value: unknown, error: string, max = 4_096): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max || value.includes("\0")) throw new Error(error);
  return value;
}

export class WriterDelegationStore {
  readonly path: string;
  readonly #db: DatabaseSync;
  readonly #now: () => number;
  #closed = false;

  constructor(dataDirectory: string, options: { now?: () => number } = {}) {
    mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    chmodSync(dataDirectory, 0o700);
    this.path = join(dataDirectory, "writer-delegations.sqlite");
    this.#now = options.now ?? Date.now;
    this.#db = new DatabaseSync(this.path);
    try {
      chmodSync(this.path, 0o600);
      this.#db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON; PRAGMA busy_timeout=3000;");
      const quick = this.#db.prepare("PRAGMA quick_check").get() as { quick_check?: string };
      if (quick.quick_check !== "ok") throw new Error("WRITER_DELEGATION_STORE_CORRUPT");
      const version = Number((this.#db.prepare("PRAGMA user_version").get() as { user_version?: number }).user_version ?? 0);
      if (!Number.isSafeInteger(version) || version < 0 || version > SCHEMA_VERSION) {
        throw new Error("WRITER_DELEGATION_SCHEMA_UNSUPPORTED");
      }
      if (version === 0) this.#migrate();
      if (this.#db.prepare("PRAGMA foreign_key_check").all().length > 0) {
        throw new Error("WRITER_DELEGATION_FOREIGN_KEY_VIOLATION");
      }
      this.#verify();
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }

  create(input: { id?: string; parent: WriterLease; childProvider: WriterProvider; label: string; workspace: string }): GrantedWriterDelegation {
    this.#assertOpen();
    if (input.parent.state !== "active") throw new Error("DELEGATION_PARENT_NOT_ACTIVE");
    const childProvider = provider(input.childProvider);
    if (typeof input.label !== "string" || !LABEL_PATTERN.test(input.label.trim())) throw new Error("DELEGATION_LABEL_INVALID");
    const workspace = text(input.workspace, "DELEGATION_WORKSPACE_INVALID");
    if (!isAbsolute(workspace)) throw new Error("DELEGATION_WORKSPACE_INVALID");
    const access: DelegatedAccess = input.parent.writer.provider === childProvider ? "write" : "read-only";
    const id = input.id ?? randomUUID();
    if (!ID_PATTERN.test(id)) throw new Error("DELEGATION_ID_INVALID");
    const childActorId = `subagent-${childProvider}-${id}`;
    const capabilityToken = access === "write" ? randomUUID() : undefined;
    const now = this.#now();
    const bare: Omit<DelegationRow, "row_hash"> = {
      id, task_id: input.parent.taskId, room_id: input.parent.roomId,
      parent_lease_id: input.parent.id, parent_epoch: input.parent.epoch,
      parent_provider: input.parent.writer.provider, parent_actor_id: input.parent.writer.actorId,
      on_behalf_of: input.parent.onBehalfOf, child_provider: childProvider,
      child_actor_id: childActorId, display_name: `${childProvider}（${input.label.trim()}）`,
      executed_by: childActorId, access, workspace,
      capability_hash: capabilityToken ? sha(capabilityToken) : null,
      state: "active", created_at_ms: now, revoked_at_ms: null, reason: null,
    };
    const row: DelegationRow = { ...bare, row_hash: hashRow(bare) };
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const active = this.#db.prepare(
        "SELECT COUNT(*) count FROM writer_delegations WHERE parent_lease_id=? AND state='active'",
      ).get(input.parent.id) as { count: number };
      if (Number(active.count) >= MAX_ACTIVE_DELEGATIONS_PER_LEASE) {
        throw new Error("DELEGATION_ACTIVE_LIMIT_REACHED");
      }
      this.#db.prepare("INSERT INTO writer_delegations VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(...Object.values(row));
      this.#db.exec("COMMIT");
      return { delegation: this.#public(row), ...(capabilityToken ? { capabilityToken } : {}) };
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  assertWrite(input: { delegationId: string; parentLease: WriterLease; capabilityToken: string; executedBy: string }): WriterDelegation {
    this.#assertOpen();
    const row = this.#getRow(input.delegationId);
    if (!row || row.state !== "active") throw new Error("DELEGATION_NOT_ACTIVE");
    this.#assertRow(row);
    if (row.access !== "write" || !row.capability_hash) throw new Error("DELEGATION_WRITE_DENIED");
    if (input.parentLease.state !== "active" || input.parentLease.id !== row.parent_lease_id
      || input.parentLease.epoch !== row.parent_epoch || input.parentLease.taskId !== row.task_id) {
      throw new Error("DELEGATION_PARENT_LEASE_STALE");
    }
    if (input.parentLease.writer.provider !== row.child_provider) throw new Error("DELEGATION_PROVIDER_MISMATCH");
    if (input.executedBy !== row.executed_by) throw new Error("DELEGATION_EXECUTOR_MISMATCH");
    const token = text(input.capabilityToken, "DELEGATION_CAPABILITY_INVALID", 64);
    if (!safeEqual(sha(token), row.capability_hash)) throw new Error("DELEGATION_CAPABILITY_INVALID");
    return this.#public(row);
  }

  assertRead(input: { delegationId: string; parentLease: WriterLease; executedBy: string }): WriterDelegation {
    this.#assertOpen();
    const row = this.#getRow(input.delegationId);
    if (!row || row.state !== "active") throw new Error("DELEGATION_NOT_ACTIVE");
    this.#assertRow(row);
    if (input.parentLease.state !== "active" || input.parentLease.id !== row.parent_lease_id
      || input.parentLease.epoch !== row.parent_epoch || input.parentLease.taskId !== row.task_id) {
      throw new Error("DELEGATION_PARENT_LEASE_STALE");
    }
    if (input.executedBy !== row.executed_by) throw new Error("DELEGATION_EXECUTOR_MISMATCH");
    return this.#public(row);
  }

  revokeByLease(parentLeaseId: string, reasonValue: string): WriterDelegation[] {
    this.#assertOpen();
    if (!ID_PATTERN.test(parentLeaseId)) throw new Error("DELEGATION_PARENT_ID_INVALID");
    const reason = text(reasonValue, "DELEGATION_REASON_INVALID", 1_024);
    const now = this.#now();
    const output: WriterDelegation[] = [];
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.#db.prepare(
        "SELECT * FROM writer_delegations WHERE parent_lease_id = ? AND state = 'active' ORDER BY created_at_ms, id",
      ).all(parentLeaseId) as unknown as DelegationRow[];
      for (const row of rows) {
        this.#assertRow(row);
        const bare: Omit<DelegationRow, "row_hash"> = { ...row, state: "revoked", revoked_at_ms: now, reason };
        delete (bare as Partial<DelegationRow>).row_hash;
        const next: DelegationRow = { ...bare, row_hash: hashRow(bare) };
        const result = this.#db.prepare(
          "UPDATE writer_delegations SET state='revoked',revoked_at_ms=?,reason=?,row_hash=? WHERE id=? AND row_hash=? AND state='active'",
        ).run(now, reason, next.row_hash, row.id, row.row_hash);
        if (Number(result.changes) !== 1) throw new Error("DELEGATION_CONCURRENT_UPDATE");
        output.push(this.#public(next));
      }
      this.#db.exec("COMMIT");
      return output;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  get(id: string): WriterDelegation | undefined {
    this.#assertOpen();
    const row = this.#getRow(id);
    return row ? this.#public(row) : undefined;
  }

  list(roomId: string): WriterDelegation[] {
    this.#assertOpen();
    return (this.#db.prepare("SELECT * FROM writer_delegations WHERE room_id=? ORDER BY created_at_ms,id")
      .all(text(roomId, "DELEGATION_ROOM_INVALID", 48)) as unknown as DelegationRow[]).map((row) => this.#public(row));
  }

  inventory(): { database: string; schemaVersion: number; databaseBytes: number; delegations: number; active: number; activeLimitPerLease: number } {
    this.#assertOpen();
    const row = this.#db.prepare(`SELECT COUNT(*) delegations,
      SUM(CASE WHEN state='active' THEN 1 ELSE 0 END) active FROM writer_delegations`).get() as { delegations: number; active: number | null };
    return {
      database: this.path,
      schemaVersion: SCHEMA_VERSION,
      databaseBytes: statSync(this.path).size,
      delegations: Number(row.delegations),
      active: Number(row.active ?? 0),
      activeLimitPerLease: MAX_ACTIVE_DELEGATIONS_PER_LEASE,
    };
  }

  integrity(): { schemaVersion: number; quickCheck: string; rowsValid: boolean } {
    this.#assertOpen();
    const quickCheck = String((this.#db.prepare("PRAGMA quick_check").get() as { quick_check?: string }).quick_check ?? "unknown");
    let rowsValid = true;
    try { this.#verify(); } catch { rowsValid = false; }
    return { schemaVersion: SCHEMA_VERSION, quickCheck, rowsValid };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }

  #getRow(id: string): DelegationRow | undefined {
    if (!ID_PATTERN.test(id)) throw new Error("DELEGATION_ID_INVALID");
    return this.#db.prepare("SELECT * FROM writer_delegations WHERE id=?").get(id) as unknown as DelegationRow | undefined;
  }

  #migrate(): void {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.exec(`CREATE TABLE IF NOT EXISTS writer_delegations (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL, room_id TEXT NOT NULL,
        parent_lease_id TEXT NOT NULL, parent_epoch INTEGER NOT NULL CHECK(parent_epoch >= 1),
        parent_provider TEXT NOT NULL CHECK(parent_provider IN ('codex','claude','grok')),
        parent_actor_id TEXT NOT NULL, on_behalf_of TEXT NOT NULL,
        child_provider TEXT NOT NULL CHECK(child_provider IN ('codex','claude','grok')),
        child_actor_id TEXT NOT NULL, display_name TEXT NOT NULL, executed_by TEXT NOT NULL,
        access TEXT NOT NULL CHECK(access IN ('read-only','write')), workspace TEXT NOT NULL,
        capability_hash TEXT, state TEXT NOT NULL CHECK(state IN ('active','revoked','completed')),
        created_at_ms INTEGER NOT NULL, revoked_at_ms INTEGER, reason TEXT, row_hash TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS writer_delegations_parent_active
        ON writer_delegations(parent_lease_id) WHERE state = 'active';
      PRAGMA user_version = 1;
      COMMIT;`);
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  #public(row: DelegationRow): WriterDelegation {
    this.#assertRow(row);
    return {
      id: row.id, taskId: row.task_id, roomId: row.room_id, parentLeaseId: row.parent_lease_id,
      parentEpoch: row.parent_epoch, parentProvider: row.parent_provider, parentActorId: row.parent_actor_id,
      onBehalfOf: row.on_behalf_of, childProvider: row.child_provider, childActorId: row.child_actor_id,
      displayName: row.display_name, executedBy: row.executed_by, access: row.access,
      workspace: row.workspace, state: row.state, createdAtMs: row.created_at_ms,
      ...(row.revoked_at_ms === null ? {} : { revokedAtMs: row.revoked_at_ms }),
      ...(row.reason ? { reason: row.reason } : {}),
    };
  }

  #assertRow(row: DelegationRow): void {
    const { row_hash: actual, ...bare } = row;
    if (!ID_PATTERN.test(row.id) || hashRow(bare) !== actual) throw new Error("DELEGATION_ROW_TAMPERED");
    if (row.access === "write" && row.parent_provider !== row.child_provider) throw new Error("DELEGATION_PROVIDER_POLICY_TAMPERED");
    if ((row.access === "write") !== Boolean(row.capability_hash)) throw new Error("DELEGATION_CAPABILITY_POLICY_TAMPERED");
  }

  #verify(): void {
    for (const row of this.#db.prepare("SELECT * FROM writer_delegations").all() as unknown as DelegationRow[]) this.#assertRow(row);
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("WRITER_DELEGATION_STORE_CLOSED");
  }
}
