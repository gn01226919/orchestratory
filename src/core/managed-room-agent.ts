import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type ManagedAgentProvider = "codex" | "claude" | "grok";

export interface ManagedRoomAgent {
  id: string;
  kind: "managed-subagent";
  roomId: string;
  workspace: string;
  provider: ManagedAgentProvider;
  model: string;
  displayName: string;
  createdAt: string;
}

interface AgentRow {
  id: string;
  room_id: string;
  workspace: string;
  provider: ManagedAgentProvider;
  model: string;
  display_name: string;
  created_at_ms: number;
  archived_at_ms: number | null;
  row_hash: string;
}

const SCHEMA_VERSION = 2;
const MAX_ACTIVE_PER_ROOM = 12;
const ROOM_PATTERN = /^[a-z][a-z0-9-]{0,47}$/u;
const LABEL_PATTERN = /^[\p{L}\p{N}._ -]{1,24}$/u;
const MODEL_PATTERN = /^[A-Za-z0-9._:/-]{1,128}$/u;
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function rowHash(row: Omit<AgentRow, "row_hash">): string {
  return hashJson(row);
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function validateProvider(value: unknown): ManagedAgentProvider {
  if (value !== "codex" && value !== "claude" && value !== "grok") {
    throw new Error("MANAGED_AGENT_PROVIDER_INVALID");
  }
  return value;
}

function validateRoom(value: unknown): string {
  if (typeof value !== "string" || !ROOM_PATTERN.test(value)) throw new Error("MANAGED_AGENT_ROOM_INVALID");
  return value;
}

function validateWorkspace(value: unknown): string {
  if (typeof value !== "string" || !isAbsolute(value) || value.length > 4_096 || value.includes("\0")) {
    throw new Error("MANAGED_AGENT_WORKSPACE_INVALID");
  }
  return value;
}

function validateModel(value: unknown): string {
  if (typeof value !== "string" || !MODEL_PATTERN.test(value)) throw new Error("MANAGED_AGENT_MODEL_INVALID");
  return value;
}

export function managedAgentDisplayName(providerValue: unknown, value: unknown): string {
  const provider = validateProvider(providerValue);
  if (typeof value !== "string") throw new Error("MANAGED_AGENT_LABEL_INVALID");
  const label = value.trim();
  if (!LABEL_PATTERN.test(label)) throw new Error("MANAGED_AGENT_LABEL_INVALID");
  return `${provider}（${label}）`;
}

export class ManagedRoomAgentStore {
  readonly path: string;
  readonly #db: DatabaseSync;
  #closed = false;

  constructor(dataDirectory: string) {
    mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    chmodSync(dataDirectory, 0o700);
    this.path = join(dataDirectory, "managed-room-agents.sqlite");
    this.#db = new DatabaseSync(this.path);
    try {
      chmodSync(this.path, 0o600);
      this.#db.exec("PRAGMA journal_mode=WAL; PRAGMA secure_delete=ON; PRAGMA busy_timeout=3000;");
      const quick = this.#db.prepare("PRAGMA quick_check").get() as { quick_check?: string };
      if (quick.quick_check !== "ok") throw new Error("MANAGED_AGENT_STORE_CORRUPT");
      const version = Number(
        (this.#db.prepare("PRAGMA user_version").get() as { user_version?: number }).user_version ?? 0,
      );
      if (!Number.isSafeInteger(version) || version < 0 || version > SCHEMA_VERSION) {
        throw new Error("MANAGED_AGENT_SCHEMA_UNSUPPORTED");
      }
      if (version === 0) {
        this.#db.exec(`
          CREATE TABLE managed_room_agents (
            id TEXT PRIMARY KEY CHECK (length(id) = 36),
            room_id TEXT NOT NULL,
            workspace TEXT NOT NULL,
            provider TEXT NOT NULL CHECK (provider IN ('codex', 'claude', 'grok')),
            model TEXT NOT NULL,
            display_name TEXT NOT NULL,
            created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
            archived_at_ms INTEGER CHECK (archived_at_ms IS NULL OR archived_at_ms >= created_at_ms),
            row_hash TEXT NOT NULL CHECK (length(row_hash) = 64)
          ) STRICT;
          CREATE UNIQUE INDEX managed_room_agents_active_name
            ON managed_room_agents(room_id, display_name) WHERE archived_at_ms IS NULL;
          CREATE INDEX managed_room_agents_room_created
            ON managed_room_agents(room_id, created_at_ms) WHERE archived_at_ms IS NULL;
          PRAGMA user_version = 2;
        `);
      }
      if (version === 1) this.#migrateLegacyArchiveHashes();
      this.#verifyRows();
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }

  create(input: {
    roomId: string;
    workspace: string;
    provider: ManagedAgentProvider;
    model: string;
    label: string;
  }, now = Date.now()): ManagedRoomAgent {
    this.#assertOpen();
    const roomId = validateRoom(input.roomId);
    const workspace = validateWorkspace(input.workspace);
    const provider = validateProvider(input.provider);
    const model = validateModel(input.model);
    const name = managedAgentDisplayName(provider, input.label);
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("MANAGED_AGENT_TIME_INVALID");
    const count = this.#db.prepare(
      "SELECT COUNT(*) AS count FROM managed_room_agents WHERE room_id = ? AND archived_at_ms IS NULL",
    ).get(roomId) as { count: number };
    if (Number(count.count) >= MAX_ACTIVE_PER_ROOM) throw new Error("MANAGED_AGENT_ROOM_LIMIT_REACHED");
    const row: Omit<AgentRow, "row_hash"> = {
      id: randomUUID(), room_id: roomId, workspace, provider, model,
      display_name: name, created_at_ms: now, archived_at_ms: null,
    };
    try {
      this.#db.prepare(
        `INSERT INTO managed_room_agents
          (id, room_id, workspace, provider, model, display_name, created_at_ms, archived_at_ms, row_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      ).run(row.id, roomId, workspace, provider, model, name, now, rowHash(row));
    } catch (error) {
      if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
        throw new Error("MANAGED_AGENT_DISPLAY_NAME_IN_USE");
      }
      throw error;
    }
    return this.get(row.id)!;
  }

  list(roomId: string): ManagedRoomAgent[] {
    this.#assertOpen();
    validateRoom(roomId);
    return (this.#db.prepare(
      "SELECT * FROM managed_room_agents WHERE room_id = ? AND archived_at_ms IS NULL ORDER BY created_at_ms, id",
    ).all(roomId) as unknown as AgentRow[]).map((row) => this.#public(row));
  }

  get(id: string): ManagedRoomAgent | undefined {
    this.#assertOpen();
    if (!ID_PATTERN.test(id)) throw new Error("MANAGED_AGENT_ID_INVALID");
    const row = this.#db.prepare(
      "SELECT * FROM managed_room_agents WHERE id = ? AND archived_at_ms IS NULL",
    ).get(id) as unknown as AgentRow | undefined;
    return row ? this.#public(row) : undefined;
  }

  archive(id: string, roomId: string, now = Date.now()): ManagedRoomAgent {
    const current = this.get(id);
    if (!current || current.roomId !== validateRoom(roomId)) throw new Error("MANAGED_AGENT_NOT_FOUND");
    if (!Number.isSafeInteger(now) || now < Date.parse(current.createdAt)) throw new Error("MANAGED_AGENT_TIME_INVALID");
    const stored = this.#db.prepare("SELECT * FROM managed_room_agents WHERE id = ?").get(id) as unknown as AgentRow;
    const { row_hash: _oldHash, ...fields } = stored;
    const next: Omit<AgentRow, "row_hash"> = { ...fields, archived_at_ms: now };
    this.#db.prepare(
      "UPDATE managed_room_agents SET archived_at_ms = ?, row_hash = ? WHERE id = ? AND archived_at_ms IS NULL",
    ).run(now, rowHash(next), id);
    return current;
  }

  inventory(): {
    database: string;
    schemaVersion: number;
    databaseBytes: number;
    agents: number;
    active: number;
    activeLimitPerRoom: number;
  } {
    this.#assertOpen();
    const row = this.#db.prepare(`SELECT COUNT(*) agents,
      SUM(CASE WHEN archived_at_ms IS NULL THEN 1 ELSE 0 END) active
      FROM managed_room_agents`).get() as { agents: number; active: number | null };
    return {
      database: this.path,
      schemaVersion: SCHEMA_VERSION,
      databaseBytes: statSync(this.path).size,
      agents: Number(row.agents),
      active: Number(row.active ?? 0),
      activeLimitPerRoom: MAX_ACTIVE_PER_ROOM,
    };
  }

  integrity(): { schemaVersion: number; quickCheck: string; stateValid: boolean } {
    this.#assertOpen();
    const quickCheck = String(
      (this.#db.prepare("PRAGMA quick_check").get() as { quick_check?: string }).quick_check ?? "unknown",
    );
    let stateValid = true;
    try { this.#verifyRows(); } catch { stateValid = false; }
    return { schemaVersion: SCHEMA_VERSION, quickCheck, stateValid };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }

  #public(row: AgentRow): ManagedRoomAgent {
    const { row_hash: _hash, ...fields } = row;
    if (rowHash(fields) !== row.row_hash) throw new Error("MANAGED_AGENT_ROW_TAMPERED");
    const { archived_at_ms: _archived, ...publicFields } = fields;
    validateRoom(row.room_id);
    validateWorkspace(row.workspace);
    validateProvider(row.provider);
    validateModel(row.model);
    if (!ID_PATTERN.test(row.id)
      || !Number.isSafeInteger(row.created_at_ms)
      || row.created_at_ms < 0
      || (row.archived_at_ms !== null
        && (!Number.isSafeInteger(row.archived_at_ms) || row.archived_at_ms < row.created_at_ms))) {
      throw new Error("MANAGED_AGENT_ROW_INVALID");
    }
    const label = row.display_name.slice(`${row.provider}（`.length, -1);
    if (managedAgentDisplayName(row.provider, label) !== row.display_name) throw new Error("MANAGED_AGENT_ROW_INVALID");
    return {
      id: publicFields.id,
      kind: "managed-subagent",
      roomId: row.room_id,
      workspace: row.workspace,
      provider: row.provider,
      model: row.model,
      displayName: row.display_name,
      createdAt: new Date(row.created_at_ms).toISOString(),
    };
  }

  #verifyRows(): void {
    for (const row of this.#db.prepare("SELECT * FROM managed_room_agents").all() as unknown as AgentRow[]) {
      this.#public(row);
    }
  }

  #migrateLegacyArchiveHashes(): void {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of this.#db.prepare("SELECT * FROM managed_room_agents").all() as unknown as AgentRow[]) {
        const { row_hash: _hash, ...fields } = row;
        if (rowHash(fields) === row.row_hash) continue;
        if (row.archived_at_ms === null) throw new Error("MANAGED_AGENT_ROW_TAMPERED");
        const activeHash = rowHash({ ...fields, archived_at_ms: null });
        const legacyHash = hashJson({ ...fields, row_hash: activeHash });
        if (legacyHash !== row.row_hash) throw new Error("MANAGED_AGENT_ROW_TAMPERED");
        this.#db.prepare("UPDATE managed_room_agents SET row_hash = ? WHERE id = ?").run(rowHash(fields), row.id);
      }
      this.#db.exec("PRAGMA user_version = 2; COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("MANAGED_AGENT_STORE_CLOSED");
  }
}
