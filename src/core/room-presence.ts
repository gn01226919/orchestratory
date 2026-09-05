import { createHash, randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { RoomLedger } from "./room-ledger.ts";
import { openOwnerDatabase, verifyOwnerDatabaseFiles } from "./sqlite-security.ts";

export type PresenceProvider = "codex" | "claude" | "grok";
export type PresenceHookEvent = "SessionStart" | "UserPromptSubmit" | "Stop";
export type PresenceCollaborationMode = "room-first" | "seat-only";

export interface PresenceJoinApproval {
  collaborationMode: PresenceCollaborationMode;
  syncTurns: boolean;
  label?: string;
}

export interface PresenceInfo {
  id: string;
  provider: PresenceProvider;
  workspace: string;
  client?: string;
  model?: string;
  connectedAtMs: number;
  lastSeenAtMs: number;
  joined: boolean;
  requested: boolean;
  requestedAtMs?: number;
  roomId?: string;
  displayName?: string;
  collaborationMode?: PresenceCollaborationMode;
  syncTurns?: boolean;
  standbyRequested: boolean;
  standbyRequestedAtMs?: number;
  standbyApproved: boolean;
}

export interface PresenceRegistration {
  provider: PresenceProvider;
  workspace: string;
  hostPid: number;
  client?: string;
  model?: string;
}

export interface PresenceHookInput {
  provider: PresenceProvider;
  workspace: string;
  hostPid: number;
  sessionId: string;
  event: PresenceHookEvent;
  turnId?: string;
  text?: string;
  model?: string;
}

interface PresenceRow {
  id: string;
  provider: PresenceProvider;
  workspace: string;
  host_pid: number;
  client: string | null;
  model: string | null;
  connected_at_ms: number;
  last_seen_at_ms: number;
  lease_expires_at_ms: number;
  room_id: string | null;
  display_name: string | null;
  session_hash: string | null;
  requested_room_id: string | null;
  requested_at_ms: number | null;
  open_turn_key: string | null;
  collaboration_mode: PresenceCollaborationMode | null;
  sync_turns: number;
  standby_requested_at_ms: number | null;
  standby_approved: number;
}

const PRESENCE_SCHEMA_VERSION = 5;
const DEFAULT_LEASE_MS = 15_000;
const MAX_ACTIVE_SESSIONS = 32;
const MAX_WORKSPACE_SESSIONS = 12;
const MAX_HOOK_TEXT_CHARS = 16_384;
const ROOM_ID_PATTERN = /^[a-z][a-z0-9-]{0,47}$/u;
const TEXT_FIELD_PATTERN = /^[^\0-\x1f\x7f]{1,120}$/u;
const OWNER_LABEL_PATTERN = /^[\p{L}\p{N}._ -]{1,24}$/u;

function validProvider(provider: unknown): PresenceProvider {
  if (provider !== "codex" && provider !== "claude" && provider !== "grok") {
    throw new Error("INVALID_PRESENCE_PROVIDER");
  }
  return provider;
}

function validWorkspace(workspace: unknown): string {
  if (
    typeof workspace !== "string" ||
    !isAbsolute(workspace) ||
    workspace.length < 1 ||
    workspace.length > 4_096 ||
    workspace.includes("\0")
  ) {
    throw new Error("INVALID_PRESENCE_WORKSPACE");
  }
  return workspace;
}

function validPid(pid: unknown): number {
  if (!Number.isSafeInteger(pid) || Number(pid) <= 0) throw new Error("INVALID_PRESENCE_HOST_PID");
  return Number(pid);
}

function optionalText(value: unknown, error: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !TEXT_FIELD_PATTERN.test(value)) throw new Error(error);
  return value;
}

function validRoom(roomId: unknown): string {
  if (typeof roomId !== "string" || !ROOM_ID_PATTERN.test(roomId)) {
    throw new Error("INVALID_ROOM_ID");
  }
  return roomId;
}

function validOwnerLabel(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error("INVALID_PRESENCE_OWNER_LABEL");
  const label = value.trim();
  if (label.length === 0) return undefined;
  if (!OWNER_LABEL_PATTERN.test(label)) throw new Error("INVALID_PRESENCE_OWNER_LABEL");
  return label;
}

/**
 * The display name an external seat carries after the owner renames it. The provider stays in front
 * of the label on purpose: the name is what the owner reads on the floor to tell terminals apart, and
 * "which model is this" is half of that. It is also the same shape join() gives a labelled seat, so
 * every mention pattern and colour lookup that already understands `codex（前端 2）` keeps working.
 */
export function externalSeatDisplayName(provider: PresenceProvider, value: unknown): string {
  if (typeof value !== "string") throw new Error("PRESENCE_NAME_INVALID");
  const label = value.trim();
  if (label.length === 0 || !OWNER_LABEL_PATTERN.test(label)) throw new Error("PRESENCE_NAME_INVALID");
  return `${provider}（${label}）`;
}

function validJoinApproval(value: unknown): PresenceJoinApproval {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("INVALID_PRESENCE_JOIN_APPROVAL");
  }
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !["collaborationMode", "syncTurns", "label"].includes(key))) {
    throw new Error("INVALID_PRESENCE_JOIN_APPROVAL");
  }
  if (input.collaborationMode !== "room-first" && input.collaborationMode !== "seat-only") {
    throw new Error("INVALID_PRESENCE_COLLABORATION_MODE");
  }
  if (typeof input.syncTurns !== "boolean") throw new Error("INVALID_PRESENCE_TURN_SYNC");
  const label = validOwnerLabel(input.label);
  return {
    collaborationMode: input.collaborationMode,
    syncTurns: input.syncTurns,
    ...(label ? { label } : {}),
  };
}

function sessionHash(provider: PresenceProvider, sessionId: string): string {
  if (sessionId.length < 1 || sessionId.length > 512 || sessionId.includes("\0")) {
    throw new Error("INVALID_PRESENCE_SESSION_ID");
  }
  return createHash("sha256").update(`${provider}\0${sessionId}`, "utf8").digest("hex");
}

function publicInfo(row: PresenceRow, roomId?: string): PresenceInfo {
  const joined = row.room_id !== null && (roomId === undefined || row.room_id === roomId);
  const exposeMembership = roomId === undefined || row.room_id === roomId;
  const requested = roomId !== undefined && row.requested_room_id === roomId;
  return {
    id: row.id,
    provider: row.provider,
    workspace: row.workspace,
    ...(row.client ? { client: row.client } : {}),
    ...(row.model ? { model: row.model } : {}),
    connectedAtMs: Number(row.connected_at_ms),
    lastSeenAtMs: Number(row.last_seen_at_ms),
    joined,
    requested,
    ...(requested && row.requested_at_ms !== null ? { requestedAtMs: Number(row.requested_at_ms) } : {}),
    ...(exposeMembership && row.room_id ? { roomId: row.room_id } : {}),
    ...(exposeMembership && row.display_name ? { displayName: row.display_name } : {}),
    ...(joined && row.collaboration_mode
      ? { collaborationMode: row.collaboration_mode, syncTurns: row.sync_turns === 1 }
      : {}),
    standbyRequested: joined && row.standby_requested_at_ms !== null,
    ...(joined && row.standby_requested_at_ms !== null
      ? { standbyRequestedAtMs: Number(row.standby_requested_at_ms) }
      : {}),
    standbyApproved: joined && row.standby_approved === 1,
  };
}

/**
 * Ephemeral, owner-only control plane for MCP terminal presence and explicit Room membership.
 * Raw session ids, prompts, responses and host pids are never returned through its public API.
 */
export class RoomPresenceStore {
  readonly path: string;
  readonly #db: DatabaseSync;
  readonly #now: () => number;
  readonly #leaseMs: number;
  #closed = false;

  constructor(
    dataDirectory: string,
    options: { now?: () => number; leaseMs?: number } = {},
  ) {
    this.path = join(dataDirectory, "room-presence.sqlite");
    this.#now = options.now ?? Date.now;
    this.#leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    if (!Number.isSafeInteger(this.#leaseMs) || this.#leaseMs < 5_000 || this.#leaseMs > 120_000) {
      throw new Error("INVALID_PRESENCE_LEASE");
    }
    this.#db = openOwnerDatabase(this.path);
    try {
      this.#db.exec(
        "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON; PRAGMA busy_timeout=3000;",
      );
      verifyOwnerDatabaseFiles(this.path);
      const quick = this.#db.prepare("PRAGMA quick_check").get() as { quick_check?: string };
      if (quick.quick_check !== "ok") throw new Error("PRESENCE_STORE_CORRUPT");
      const versionRow = this.#db.prepare("PRAGMA user_version").get() as { user_version?: number };
      const version = Number(versionRow.user_version ?? 0);
      if (!Number.isSafeInteger(version) || version < 0 || version > PRESENCE_SCHEMA_VERSION) {
        throw new Error("PRESENCE_SCHEMA_UNSUPPORTED");
      }
      if (version === 0) this.#migrate();
      else {
        if (version === 1) this.#migrateV2();
        if (version <= 2) this.#migrateV3();
        if (version <= 3) this.#migrateV4();
        if (version <= 4) this.#migrateV5();
      }
      if (this.#db.prepare("PRAGMA foreign_key_check").all().length > 0) {
        throw new Error("PRESENCE_FOREIGN_KEY_VIOLATION");
      }
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }

  #migrate(): void {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.exec(`
        CREATE TABLE agent_presence (
          id TEXT PRIMARY KEY,
          provider TEXT NOT NULL CHECK (provider IN ('codex', 'claude', 'grok')),
          workspace TEXT NOT NULL,
          host_pid INTEGER NOT NULL,
          client TEXT,
          model TEXT,
          connected_at_ms INTEGER NOT NULL,
          last_seen_at_ms INTEGER NOT NULL,
          lease_expires_at_ms INTEGER NOT NULL,
          room_id TEXT,
          display_name TEXT,
          session_hash TEXT,
          requested_room_id TEXT,
          requested_at_ms INTEGER,
          open_turn_key TEXT,
          collaboration_mode TEXT CHECK (collaboration_mode IN ('room-first', 'seat-only') OR collaboration_mode IS NULL),
          sync_turns INTEGER NOT NULL DEFAULT 0 CHECK (sync_turns IN (0, 1)),
          standby_requested_at_ms INTEGER,
          standby_approved INTEGER NOT NULL DEFAULT 0 CHECK (standby_approved IN (0, 1)),
          UNIQUE(provider, workspace, host_pid),
          CHECK ((room_id IS NULL AND display_name IS NULL AND collaboration_mode IS NULL AND sync_turns = 0 AND standby_requested_at_ms IS NULL AND standby_approved = 0) OR
                 (room_id IS NOT NULL AND display_name IS NOT NULL AND collaboration_mode IS NOT NULL)),
          CHECK (standby_approved = 0 OR standby_requested_at_ms IS NULL),
          CHECK ((requested_room_id IS NULL AND requested_at_ms IS NULL) OR
                 (requested_room_id IS NOT NULL AND requested_at_ms IS NOT NULL))
        );
        CREATE INDEX agent_presence_workspace_live
          ON agent_presence(workspace, lease_expires_at_ms);
        CREATE TABLE room_agent_counters (
          room_id TEXT NOT NULL,
          provider TEXT NOT NULL CHECK (provider IN ('codex', 'claude', 'grok')),
          next_number INTEGER NOT NULL CHECK (next_number BETWEEN 1 AND 1000000),
          PRIMARY KEY (room_id, provider)
        );
        CREATE TABLE presence_hook_dedup (
          session_hash TEXT NOT NULL,
          event_key TEXT NOT NULL,
          created_at_ms INTEGER NOT NULL,
          PRIMARY KEY (session_hash, event_key)
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
      this.#db.exec(`
        ALTER TABLE agent_presence ADD COLUMN requested_room_id TEXT;
        ALTER TABLE agent_presence ADD COLUMN requested_at_ms INTEGER;
        PRAGMA user_version = 2;
      `);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  #migrateV3(): void {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.exec(`
        ALTER TABLE agent_presence ADD COLUMN open_turn_key TEXT;
        CREATE TABLE presence_hook_dedup_v3 (
          session_hash TEXT NOT NULL,
          event_key TEXT NOT NULL,
          created_at_ms INTEGER NOT NULL,
          PRIMARY KEY (session_hash, event_key)
        );
        INSERT OR IGNORE INTO presence_hook_dedup_v3 (session_hash, event_key, created_at_ms)
          SELECT COALESCE(agent_presence.session_hash, presence_hook_dedup.presence_id),
                 presence_hook_dedup.event_key,
                 presence_hook_dedup.created_at_ms
          FROM presence_hook_dedup
          LEFT JOIN agent_presence ON agent_presence.id = presence_hook_dedup.presence_id;
        DROP TABLE presence_hook_dedup;
        ALTER TABLE presence_hook_dedup_v3 RENAME TO presence_hook_dedup;
        PRAGMA user_version = 3;
      `);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  #migrateV4(): void {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.exec(`
        ALTER TABLE agent_presence ADD COLUMN collaboration_mode TEXT;
        ALTER TABLE agent_presence ADD COLUMN sync_turns INTEGER NOT NULL DEFAULT 0;
        UPDATE agent_presence
          SET collaboration_mode = 'seat-only', sync_turns = 1
          WHERE room_id IS NOT NULL;
        PRAGMA user_version = 4;
      `);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  #migrateV5(): void {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.exec(`
        ALTER TABLE agent_presence ADD COLUMN standby_requested_at_ms INTEGER;
        ALTER TABLE agent_presence ADD COLUMN standby_approved INTEGER NOT NULL DEFAULT 0
          CHECK (standby_approved IN (0, 1));
        PRAGMA user_version = 5;
      `);
      this.#db.exec("COMMIT");
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

  inventory(): {
    database: string;
    schemaVersion: number;
    databaseBytes: number;
    activeSessions: number;
    joinedSessions: number;
    aliasCounters: number;
    dedupeKeys: number;
  } {
    this.#prune();
    const schema = this.#db.prepare("PRAGMA user_version").get() as { user_version?: number };
    const counts = this.#db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM agent_presence) AS active_sessions,
        (SELECT COUNT(*) FROM agent_presence WHERE room_id IS NOT NULL) AS joined_sessions,
        (SELECT COUNT(*) FROM room_agent_counters) AS alias_counters,
        (SELECT COUNT(*) FROM presence_hook_dedup) AS dedupe_keys
    `).get() as Record<string, number>;
    return {
      database: this.path,
      schemaVersion: Number(schema.user_version ?? 0),
      databaseBytes: statSync(this.path).size,
      activeSessions: Number(counts.active_sessions),
      joinedSessions: Number(counts.joined_sessions),
      aliasCounters: Number(counts.alias_counters),
      dedupeKeys: Number(counts.dedupe_keys),
    };
  }

  integrity(): {
    schemaVersion: number;
    quickCheck: string;
    foreignKeyViolations: number;
    stateValid: boolean;
  } {
    const schema = this.#db.prepare("PRAGMA user_version").get() as { user_version?: number };
    const quick = this.#db.prepare("PRAGMA quick_check").get() as { quick_check?: string };
    const foreignKeyViolations = this.#db.prepare("PRAGMA foreign_key_check").all().length;
    const invalidRows = this.#db.prepare(`
      SELECT COUNT(*) AS count FROM agent_presence
      WHERE lease_expires_at_ms < last_seen_at_ms
         OR connected_at_ms > last_seen_at_ms
         OR (room_id IS NULL) <> (display_name IS NULL)
         OR (requested_room_id IS NULL) <> (requested_at_ms IS NULL)
         OR sync_turns NOT IN (0, 1)
         OR standby_approved NOT IN (0, 1)
         OR (room_id IS NULL AND (collaboration_mode IS NOT NULL OR sync_turns <> 0))
         OR (room_id IS NULL AND (standby_requested_at_ms IS NOT NULL OR standby_approved <> 0))
         OR (room_id IS NOT NULL AND collaboration_mode NOT IN ('room-first', 'seat-only'))
         OR (standby_approved = 1 AND standby_requested_at_ms IS NOT NULL)
         OR LENGTH(id) < 1 OR LENGTH(id) > 128
    `).get() as { count: number };
    return {
      schemaVersion: Number(schema.user_version ?? 0),
      quickCheck: String(quick.quick_check ?? "unknown"),
      foreignKeyViolations,
      stateValid: Number(invalidRows.count) === 0,
    };
  }

  #prune(now = this.#now()): void {
    this.#db.prepare("DELETE FROM agent_presence WHERE lease_expires_at_ms <= ?").run(now);
    this.#db.prepare("DELETE FROM presence_hook_dedup WHERE created_at_ms <= ?").run(now - 86_400_000);
  }

  /*
   * The clock this store was built with. Exposed so callers reasoning about presence time -- bucketing,
   * expiry -- read the same clock the leases do, rather than calling Date.now() beside a store running
   * on an injected one.
   *
   * It aligns a caller with THIS store, and claims nothing wider: the ledger stamps its own `at` from
   * the system clock and the inbox has a third clock of its own. In production all three are Date.now
   * and agree; under an injected clock they do not, which is fine for a value used only to build an
   * idempotency key, and would not be fine for anything a reader sees.
   */
  now(): number {
    return this.#now();
  }

  register(input: PresenceRegistration): PresenceInfo {
    const provider = validProvider(input.provider);
    const workspace = validWorkspace(input.workspace);
    const hostPid = validPid(input.hostPid);
    const client = optionalText(input.client, "INVALID_PRESENCE_CLIENT");
    const model = optionalText(input.model, "INVALID_PRESENCE_MODEL");
    const now = this.#now();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#prune(now);
      const counts = this.#db
        .prepare(
          "SELECT COUNT(*) AS total, SUM(CASE WHEN workspace = ? THEN 1 ELSE 0 END) AS workspace_count FROM agent_presence",
        )
        .get(workspace) as { total: number; workspace_count: number | null };
      if (Number(counts.total) >= MAX_ACTIVE_SESSIONS) throw new Error("PRESENCE_LIMIT_REACHED");
      if (Number(counts.workspace_count ?? 0) >= MAX_WORKSPACE_SESSIONS) {
        throw new Error("PRESENCE_WORKSPACE_LIMIT_REACHED");
      }
      const id = randomUUID();
      this.#db
        .prepare(
          `INSERT INTO agent_presence
             (id, provider, workspace, host_pid, client, model, connected_at_ms,
              last_seen_at_ms, lease_expires_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, provider, workspace, hostPid, client ?? null, model ?? null, now, now, now + this.#leaseMs);
      const row = this.#row(id)!;
      this.#db.exec("COMMIT");
      return publicInfo(row);
    } catch (error) {
      this.#db.exec("ROLLBACK");
      if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
        throw new Error("PRESENCE_ALREADY_REGISTERED");
      }
      throw error;
    }
  }

  heartbeat(id: string): PresenceInfo {
    const now = this.#now();
    this.#prune(now);
    const result = this.#db
      .prepare("UPDATE agent_presence SET last_seen_at_ms = ?, lease_expires_at_ms = ? WHERE id = ?")
      .run(now, now + this.#leaseMs, id);
    if (Number(result.changes) !== 1) throw new Error("PRESENCE_NOT_FOUND");
    return publicInfo(this.#row(id)!);
  }

  unregister(id: string): void {
    this.#db.prepare("DELETE FROM agent_presence WHERE id = ?").run(id);
  }

  list(workspace: string, roomId?: string): PresenceInfo[] {
    validWorkspace(workspace);
    if (roomId !== undefined) validRoom(roomId);
    this.#prune();
    const rows = this.#db
      .prepare(
        "SELECT * FROM agent_presence WHERE workspace = ? ORDER BY connected_at_ms ASC, rowid ASC",
      )
      .all(workspace) as unknown as PresenceRow[];
    return rows.map((row) => publicInfo(row, roomId));
  }

  get(id: string): PresenceInfo | undefined {
    this.#prune();
    const row = this.#row(id);
    return row ? publicInfo(row) : undefined;
  }

  actorFor(id: string, roomId: string): string {
    validRoom(roomId);
    this.#prune();
    const row = this.#row(id);
    if (!row) throw new Error("PRESENCE_NOT_FOUND");
    if (row.room_id !== roomId || row.display_name === null) throw new Error("PRESENCE_NOT_JOINED");
    return row.display_name;
  }

  requestJoin(id: string, roomId: string, roomWorkspace: string): PresenceInfo {
    validRoom(roomId);
    validWorkspace(roomWorkspace);
    const now = this.#now();
    this.#prune(now);
    const row = this.#row(id);
    if (!row) throw new Error("PRESENCE_NOT_FOUND");
    if (row.workspace !== roomWorkspace) throw new Error("PRESENCE_WORKSPACE_MISMATCH");
    if (row.room_id !== null && row.room_id !== roomId) throw new Error("PRESENCE_ALREADY_JOINED");
    if (row.room_id === roomId) return publicInfo(row, roomId);
    this.#db
      .prepare("UPDATE agent_presence SET requested_room_id = ?, requested_at_ms = ? WHERE id = ?")
      .run(roomId, now, id);
    return publicInfo(this.#row(id)!, roomId);
  }

  cancelJoinRequest(id: string, roomId: string): PresenceInfo {
    validRoom(roomId);
    this.#prune();
    const row = this.#row(id);
    if (!row) throw new Error("PRESENCE_NOT_FOUND");
    if (row.room_id !== null || row.requested_room_id !== roomId) return publicInfo(row, roomId);
    this.#db
      .prepare("UPDATE agent_presence SET requested_room_id = NULL, requested_at_ms = NULL WHERE id = ?")
      .run(id);
    return publicInfo(this.#row(id)!, roomId);
  }

  requestStandby(id: string, roomId: string): PresenceInfo {
    validRoom(roomId);
    const now = this.#now();
    this.#prune(now);
    const row = this.#row(id);
    if (!row) throw new Error("PRESENCE_NOT_FOUND");
    if (row.room_id !== roomId || row.display_name === null) throw new Error("PRESENCE_NOT_JOINED");
    if (row.standby_approved === 1 || row.standby_requested_at_ms !== null) {
      return publicInfo(row, roomId);
    }
    this.#db
      .prepare("UPDATE agent_presence SET standby_requested_at_ms = ? WHERE id = ?")
      .run(now, id);
    return publicInfo(this.#row(id)!, roomId);
  }

  cancelStandbyRequest(id: string, roomId: string): PresenceInfo {
    validRoom(roomId);
    this.#prune();
    const row = this.#row(id);
    if (!row) throw new Error("PRESENCE_NOT_FOUND");
    if (row.room_id !== roomId || row.display_name === null) throw new Error("PRESENCE_NOT_JOINED");
    if (row.standby_approved === 1 || row.standby_requested_at_ms === null) {
      return publicInfo(row, roomId);
    }
    this.#db
      .prepare("UPDATE agent_presence SET standby_requested_at_ms = NULL WHERE id = ?")
      .run(id);
    return publicInfo(this.#row(id)!, roomId);
  }

  approveStandby(id: string, roomId: string): PresenceInfo {
    validRoom(roomId);
    this.#prune();
    const row = this.#row(id);
    if (!row) throw new Error("PRESENCE_NOT_FOUND");
    if (row.room_id !== roomId || row.display_name === null) throw new Error("PRESENCE_NOT_JOINED");
    if (row.standby_approved === 1) return publicInfo(row, roomId);
    if (row.standby_requested_at_ms === null) throw new Error("PRESENCE_STANDBY_NOT_REQUESTED");
    this.#db
      .prepare("UPDATE agent_presence SET standby_requested_at_ms = NULL, standby_approved = 1 WHERE id = ?")
      .run(id);
    return publicInfo(this.#row(id)!, roomId);
  }

  revokeStandby(id: string, roomId: string): PresenceInfo {
    validRoom(roomId);
    this.#prune();
    const row = this.#row(id);
    if (!row) throw new Error("PRESENCE_NOT_FOUND");
    if (row.room_id !== roomId || row.display_name === null) throw new Error("PRESENCE_NOT_JOINED");
    this.#db
      .prepare("UPDATE agent_presence SET standby_requested_at_ms = NULL, standby_approved = 0 WHERE id = ?")
      .run(id);
    return publicInfo(this.#row(id)!, roomId);
  }

  join(id: string, roomId: string, roomWorkspace: string, approvalValue: PresenceJoinApproval): PresenceInfo {
    validRoom(roomId);
    validWorkspace(roomWorkspace);
    const approval = validJoinApproval(approvalValue);
    const label = approval.label;
    const now = this.#now();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#prune(now);
      const row = this.#row(id);
      if (!row) throw new Error("PRESENCE_NOT_FOUND");
      if (row.workspace !== roomWorkspace) throw new Error("PRESENCE_WORKSPACE_MISMATCH");
      if (row.room_id === roomId) {
        this.#db.exec("COMMIT");
        return publicInfo(row, roomId);
      }
      if (row.room_id !== null) throw new Error("PRESENCE_ALREADY_JOINED");
      if (row.requested_room_id !== roomId) throw new Error("PRESENCE_JOIN_NOT_REQUESTED");
      let displayName: string;
      if (label) {
        displayName = `${row.provider}（${label}）`;
      } else {
        const counter = this.#db
          .prepare("SELECT next_number FROM room_agent_counters WHERE room_id = ? AND provider = ?")
          .get(roomId, row.provider) as { next_number: number } | undefined;
        const number = Number(counter?.next_number ?? 1);
        if (!Number.isSafeInteger(number) || number < 1 || number > 999_999) {
          throw new Error("PRESENCE_ALIAS_LIMIT_REACHED");
        }
        if (counter) {
          this.#db
            .prepare("UPDATE room_agent_counters SET next_number = ? WHERE room_id = ? AND provider = ?")
            .run(number + 1, roomId, row.provider);
        } else {
          this.#db
            .prepare(
              "INSERT INTO room_agent_counters (room_id, provider, next_number) VALUES (?, ?, ?)",
            )
            .run(roomId, row.provider, number + 1);
        }
        displayName = `${row.provider}${number}`;
      }
      const duplicate = this.#db
        .prepare("SELECT 1 AS found FROM agent_presence WHERE room_id = ? AND display_name = ? AND id <> ?")
        .get(roomId, displayName, id) as { found: number } | undefined;
      if (duplicate) throw new Error("PRESENCE_DISPLAY_NAME_IN_USE");
      this.#db
        .prepare("UPDATE agent_presence SET room_id = ?, display_name = ?, collaboration_mode = ?, sync_turns = ?, requested_room_id = NULL, requested_at_ms = NULL WHERE id = ?")
        .run(roomId, displayName, approval.collaborationMode, approval.syncTurns ? 1 : 0, id);
      const joined = this.#row(id)!;
      this.#db.exec("COMMIT");
      return publicInfo(joined, roomId);
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  leave(id: string, roomId: string): PresenceInfo {
    validRoom(roomId);
    this.#prune();
    const row = this.#row(id);
    if (!row) throw new Error("PRESENCE_NOT_FOUND");
    if (row.room_id !== roomId) throw new Error("PRESENCE_NOT_JOINED");
    this.#db
      .prepare("UPDATE agent_presence SET room_id = NULL, display_name = NULL, collaboration_mode = NULL, sync_turns = 0, standby_requested_at_ms = NULL, standby_approved = 0, session_hash = NULL, requested_room_id = NULL, requested_at_ms = NULL, open_turn_key = NULL WHERE id = ?")
      .run(id);
    return publicInfo(this.#row(id)!, roomId);
  }

  /**
   * Owner renames a joined seat in place. Only the label changes; the seat keeps its id, room,
   * collaboration mode, standby state and open turn, so nothing that is bound to the seat by id has
   * to be re-approved. The ledger line is written inside the same transaction as the update: a name
   * that changed without a line saying so would leave earlier ledger entries pointing at a name
   * nobody can find on the floor any more.
   */
  rename(
    ledger: RoomLedger,
    id: string,
    roomId: string,
    label: unknown,
  ): { session: PresenceInfo; previousDisplayName: string; displayName: string } {
    validRoom(roomId);
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#prune();
      const row = this.#row(id);
      if (!row) throw new Error("PRESENCE_NOT_FOUND");
      if (row.room_id !== roomId || row.display_name === null) throw new Error("PRESENCE_NOT_JOINED");
      const previousDisplayName = row.display_name;
      const displayName = externalSeatDisplayName(row.provider, label);
      if (displayName === previousDisplayName) {
        this.#db.exec("COMMIT");
        return { session: publicInfo(row, roomId), previousDisplayName, displayName };
      }
      const duplicate = this.#db
        .prepare("SELECT 1 AS found FROM agent_presence WHERE room_id = ? AND display_name = ? AND id <> ?")
        .get(roomId, displayName, id) as { found: number } | undefined;
      if (duplicate) throw new Error("PRESENCE_NAME_TAKEN");
      this.#db.prepare("UPDATE agent_presence SET display_name = ? WHERE id = ?").run(displayName, id);
      ledger.appendSystem(roomId, `席位 ${id.slice(0, 8)} 更名：${previousDisplayName} → ${displayName}`);
      const renamed = this.#row(id)!;
      this.#db.exec("COMMIT");
      return { session: publicInfo(renamed, roomId), previousDisplayName, displayName };
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  recordHook(
    ledger: RoomLedger,
    input: PresenceHookInput,
  ): "recorded" | "ignored" | "duplicate" {
    const provider = validProvider(input.provider);
    const workspace = validWorkspace(input.workspace);
    const hostPid = validPid(input.hostPid);
    const model = optionalText(input.model, "INVALID_PRESENCE_MODEL");
    const hash = sessionHash(provider, input.sessionId);
    if (input.event !== "SessionStart" && input.event !== "UserPromptSubmit" && input.event !== "Stop") {
      throw new Error("INVALID_PRESENCE_HOOK_EVENT");
    }
    if (input.turnId !== undefined && (input.turnId.length < 1 || input.turnId.length > 512 || input.turnId.includes("\0"))) {
      throw new Error("INVALID_PRESENCE_TURN_ID");
    }
    if (typeof input.text === "string" && (input.text.length > MAX_HOOK_TEXT_CHARS || input.text.includes("\0"))) {
      throw new Error("INVALID_PRESENCE_HOOK_TEXT");
    }
    const now = this.#now();
    this.#prune(now);
    let row = this.#db
      .prepare("SELECT * FROM agent_presence WHERE provider = ? AND workspace = ? AND session_hash = ?")
      .get(provider, workspace, hash) as unknown as PresenceRow | undefined;
    if (!row) {
      const byPid = this.#db
        .prepare("SELECT * FROM agent_presence WHERE provider = ? AND workspace = ? AND host_pid = ?")
        .get(provider, workspace, hostPid) as unknown as PresenceRow | undefined;
      if (byPid?.session_hash === null) row = byPid;
    }
    if (!row) return "ignored";
    if (row.session_hash !== null && row.session_hash !== hash) {
      return "ignored";
    }
    this.#db
      .prepare(
        "UPDATE agent_presence SET session_hash = ?, model = COALESCE(?, model), last_seen_at_ms = ?, lease_expires_at_ms = ? WHERE id = ?",
      )
      .run(hash, model ?? null, now, now + this.#leaseMs, row.id);
    if (
      input.event === "SessionStart" || row.room_id === null || row.display_name === null ||
      row.sync_turns !== 1
    ) return "ignored";
    if (typeof input.text !== "string" || input.text.trim().length === 0) return "ignored";
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.#row(row.id)!;
      const contentTurn = createHash("sha256").update(input.text, "utf8").digest("hex");
      let turn = input.turnId ?? (input.event === "Stop" && current.open_turn_key !== null ? current.open_turn_key : contentTurn);
      let eventKey = createHash("sha256")
        .update(`${hash}\0${input.event}\0${turn}`, "utf8")
        .digest("hex");
      let duplicate = this.#db
        .prepare("SELECT 1 FROM presence_hook_dedup WHERE session_hash = ? AND event_key = ?")
        .get(hash, eventKey);
      const currentIsSameFallbackTurn = current.open_turn_key === contentTurn || current.open_turn_key?.startsWith(`${contentTurn}:`) === true;
      if (duplicate && input.event === "UserPromptSubmit" && input.turnId === undefined && !currentIsSameFallbackTurn) {
        turn = `${contentTurn}:${randomUUID()}`;
        eventKey = createHash("sha256")
          .update(`${hash}\0${input.event}\0${turn}`, "utf8")
          .digest("hex");
        duplicate = this.#db
          .prepare("SELECT 1 FROM presence_hook_dedup WHERE session_hash = ? AND event_key = ?")
          .get(hash, eventKey);
      }
      if (duplicate) {
        this.#db.exec("COMMIT");
        return "duplicate";
      }
      if (input.event === "Stop") {
        if (current.open_turn_key === null || (input.turnId !== undefined && current.open_turn_key !== turn)) {
          this.#db.exec("COMMIT");
          return "ignored";
        }
        ledger.appendIdempotent(
          row.room_id,
          row.display_name,
          input.text,
          `presence-hook:${eventKey}`,
        );
        this.#db.prepare("UPDATE agent_presence SET open_turn_key = NULL WHERE id = ?").run(row.id);
      } else {
        if (current.open_turn_key !== null && current.open_turn_key !== turn) {
          ledger.appendSystemIdempotent(
            row.room_id,
            `${row.display_name} 上一個終端回合未收到完成事件，已標記為中止`,
            `presence-hook:${eventKey}:abandon`,
          );
        }
        ledger.appendIdempotent(
          row.room_id,
          "you",
          input.text,
          `presence-hook:${eventKey}`,
        );
        this.#db.prepare("UPDATE agent_presence SET open_turn_key = ? WHERE id = ?").run(turn, row.id);
      }
      this.#db
        .prepare(
          "INSERT INTO presence_hook_dedup (session_hash, event_key, created_at_ms) VALUES (?, ?, ?)",
        )
        .run(hash, eventKey, now);
      this.#db.exec("COMMIT");
      return "recorded";
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  #row(id: string): PresenceRow | undefined {
    if (typeof id !== "string" || id.length < 1 || id.length > 128) throw new Error("INVALID_PRESENCE_ID");
    return this.#db.prepare("SELECT * FROM agent_presence WHERE id = ?").get(id) as
      | PresenceRow
      | undefined;
  }
}
