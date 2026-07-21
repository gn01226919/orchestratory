import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  CheckpointRecord,
  RetentionPolicy,
  RunCounters,
  RunEvent,
  RunRecord,
} from "../types.ts";
import { safeSummary } from "../security/redact.ts";
import { defaultDataDirectory } from "../config.ts";
import { openOwnerDatabase, verifyOwnerDatabaseFiles } from "./sqlite-security.ts";

export interface PurgePreview {
  id: string;
  createdAt: string;
  policy: RetentionPolicy;
  protectedRunIds: string[];
  candidates: Array<{ runId: string; updatedAt: string }>;
  counts: {
    runs: number;
    events: number;
    checkpoints: number;
    apiBudgetReservations: number;
  };
}

const DATABASE_SCHEMA_VERSION = 2;

function eventHash(input: {
  runId: string;
  at: string;
  type: string;
  actor: string;
  status: string;
  summary: string;
  metadataJson: string | null;
  previousHash: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.runId,
        input.at,
        input.type,
        input.actor,
        input.status,
        input.summary,
        input.metadataJson,
        input.previousHash,
      ]),
      "utf8",
    )
    .digest("hex");
}

export class LocalStore {
  readonly path: string;
  readonly dataDirectory: string;
  readonly #db: DatabaseSync;

  constructor(dataDirectory = defaultDataDirectory()) {
    this.dataDirectory = dataDirectory;
    this.path = join(dataDirectory, "orchestratory.sqlite");
    this.#db = openOwnerDatabase(this.path);
    try {
      this.#db.exec(
        "PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON;",
      );
      verifyOwnerDatabaseFiles(this.path);
      this.#assertQuickCheck();
      this.#migrate();
      this.#assertIntegrity();
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }

  #migrate(): void {
    const row = this.#db.prepare("PRAGMA user_version").get() as Record<string, unknown>;
    const version = Number(row.user_version);
    if (!Number.isSafeInteger(version) || version < 0) throw new Error("INVALID_DATABASE_SCHEMA_VERSION");
    if (version > DATABASE_SCHEMA_VERSION) throw new Error("DATABASE_SCHEMA_TOO_NEW");
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        status TEXT NOT NULL,
        workspace_label TEXT NOT NULL,
        profile TEXT NOT NULL,
        counters_json TEXT NOT NULL,
        error_code TEXT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        at TEXT NOT NULL,
        type TEXT NOT NULL,
        actor TEXT NOT NULL,
        status TEXT NOT NULL,
        summary TEXT NOT NULL,
        metadata_json TEXT,
        prev_hash TEXT NOT NULL,
        event_hash TEXT NOT NULL,
        FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE CASCADE
      ) STRICT;
      CREATE INDEX IF NOT EXISTS events_run_id_id ON events(run_id, id);
      CREATE TABLE IF NOT EXISTS api_budget_reservations (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        reserved_at TEXT NOT NULL,
        amount_usd REAL NOT NULL CHECK(amount_usd > 0),
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE CASCADE
      ) STRICT;
      CREATE INDEX IF NOT EXISTS api_budget_reserved_at
        ON api_budget_reservations(reserved_at);
      CREATE INDEX IF NOT EXISTS api_budget_run_id
        ON api_budget_reservations(run_id);
      CREATE TABLE IF NOT EXISTS checkpoints (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        round INTEGER NOT NULL CHECK(round > 0),
        phase TEXT NOT NULL CHECK(phase = 'writer-complete'),
        workspace_fingerprint TEXT NOT NULL,
        counters_json TEXT NOT NULL,
        FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE CASCADE
      ) STRICT;
      CREATE INDEX IF NOT EXISTS checkpoints_run_round
        ON checkpoints(run_id, round DESC);
    `);
      if (version < 2) {
        const columns = this.#db.prepare("PRAGMA table_info(events)").all() as Array<Record<string, unknown>>;
        const names = new Set(columns.map((column) => String(column.name)));
        if (!names.has("prev_hash")) this.#db.exec("ALTER TABLE events ADD COLUMN prev_hash TEXT");
        if (!names.has("event_hash")) this.#db.exec("ALTER TABLE events ADD COLUMN event_hash TEXT");
        this.#backfillEventHashes();
      }
      this.#db.exec(`PRAGMA user_version=${DATABASE_SCHEMA_VERSION}; COMMIT`);
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  #assertQuickCheck(): void {
    const rows = this.#db.prepare("PRAGMA quick_check").all() as Array<Record<string, unknown>>;
    if (rows.length !== 1 || String(rows[0]?.quick_check) !== "ok") {
      throw new Error("DATABASE_QUICK_CHECK_FAILED");
    }
  }

  #backfillEventHashes(): void {
    const rows = this.#db
      .prepare(`
        SELECT id, run_id, at, type, actor, status, summary, metadata_json
        FROM events ORDER BY run_id ASC, id ASC
      `)
      .all() as Array<Record<string, unknown>>;
    const previous = new Map<string, string>();
    const update = this.#db.prepare("UPDATE events SET prev_hash = ?, event_hash = ? WHERE id = ?");
    for (const row of rows) {
      const runId = String(row.run_id);
      const previousHash = previous.get(runId) ?? "";
      const hash = eventHash({
        runId,
        at: String(row.at),
        type: String(row.type),
        actor: String(row.actor),
        status: String(row.status),
        summary: String(row.summary),
        metadataJson: row.metadata_json === null ? null : String(row.metadata_json),
        previousHash,
      });
      update.run(previousHash, hash, Number(row.id));
      previous.set(runId, hash);
    }
  }

  #verifyEventHashes(): { events: number; valid: boolean } {
    const rows = this.#db
      .prepare(`
        SELECT id, run_id, at, type, actor, status, summary, metadata_json, prev_hash, event_hash
        FROM events ORDER BY run_id ASC, id ASC
      `)
      .all() as Array<Record<string, unknown>>;
    const previous = new Map<string, string>();
    for (const row of rows) {
      const runId = String(row.run_id);
      const expectedPrevious = previous.get(runId) ?? "";
      const storedPrevious = String(row.prev_hash ?? "");
      const storedHash = String(row.event_hash ?? "");
      const expectedHash = eventHash({
        runId,
        at: String(row.at),
        type: String(row.type),
        actor: String(row.actor),
        status: String(row.status),
        summary: String(row.summary),
        metadataJson: row.metadata_json === null ? null : String(row.metadata_json),
        previousHash: expectedPrevious,
      });
      if (
        storedPrevious !== expectedPrevious ||
        !/^[a-f0-9]{64}$/u.test(storedHash) ||
        storedHash !== expectedHash
      ) {
        return { events: rows.length, valid: false };
      }
      previous.set(runId, storedHash);
    }
    return { events: rows.length, valid: true };
  }

  #assertIntegrity(): void {
    this.#assertQuickCheck();
    const foreignKeys = this.#db.prepare("PRAGMA foreign_key_check").all();
    if (foreignKeys.length > 0) throw new Error("DATABASE_FOREIGN_KEY_CHECK_FAILED");
    if (!this.#verifyEventHashes().valid) throw new Error("AUDIT_EVENT_CHAIN_INVALID");
  }

  integrity(): {
    schemaVersion: number;
    quickCheck: "ok";
    foreignKeyViolations: number;
    auditEvents: number;
    auditChainValid: boolean;
  } {
    this.#assertQuickCheck();
    const schema = this.#db.prepare("PRAGMA user_version").get() as Record<string, unknown>;
    const foreignKeyViolations = this.#db.prepare("PRAGMA foreign_key_check").all().length;
    const audit = this.#verifyEventHashes();
    return {
      schemaVersion: Number(schema.user_version),
      quickCheck: "ok",
      foreignKeyViolations,
      auditEvents: audit.events,
      auditChainValid: audit.valid,
    };
  }

  reserveApiBudget(input: {
    runId: string;
    provider: string;
    model: string;
    amountUsd: number;
    maxPerRunUsd: number;
    maxPerDayUsd: number;
    maxPerMonthUsd: number;
    now?: Date;
  }): { runUsd: number; dayUsd: number; monthUsd: number } {
    if (
      !Number.isFinite(input.amountUsd) ||
      input.amountUsd <= 0 ||
      !Number.isFinite(input.maxPerRunUsd) ||
      !Number.isFinite(input.maxPerDayUsd) ||
      !Number.isFinite(input.maxPerMonthUsd)
    ) {
      throw new Error("INVALID_API_BUDGET_RESERVATION");
    }
    const now = input.now ?? new Date();
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const sum = (where: string, ...values: Array<string | number>): number => {
      const row = this.#db
        .prepare(`SELECT COALESCE(SUM(amount_usd), 0) AS total FROM api_budget_reservations WHERE ${where}`)
        .get(...values) as Record<string, unknown>;
      return Number(row.total);
    };
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const runUsd = sum("run_id = ?", input.runId);
      const dayUsd = sum("reserved_at >= ?", dayStart.toISOString());
      const monthUsd = sum("reserved_at >= ?", monthStart.toISOString());
      if (runUsd + input.amountUsd > input.maxPerRunUsd) throw new Error("API_RUN_BUDGET_REACHED");
      if (dayUsd + input.amountUsd > input.maxPerDayUsd) throw new Error("API_DAILY_BUDGET_REACHED");
      if (monthUsd + input.amountUsd > input.maxPerMonthUsd) throw new Error("API_MONTHLY_BUDGET_REACHED");
      this.#db
        .prepare(`
          INSERT INTO api_budget_reservations
            (id, run_id, reserved_at, amount_usd, provider, model)
          VALUES (?, ?, ?, ?, ?, ?)
        `)
        .run(
          randomUUID(),
          input.runId,
          now.toISOString(),
          input.amountUsd,
          safeSummary(input.provider, 32),
          safeSummary(input.model, 128),
        );
      this.#db.exec("COMMIT");
      return {
        runUsd: runUsd + input.amountUsd,
        dayUsd: dayUsd + input.amountUsd,
        monthUsd: monthUsd + input.amountUsd,
      };
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  recoverInterruptedRuns(now = new Date()): number {
    const rows = this.#db
      .prepare("SELECT id FROM runs WHERE status IN ('created', 'running', 'paused')")
      .all() as Array<Record<string, unknown>>;
    if (rows.length === 0) return 0;
    const at = now.toISOString();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const update = this.#db.prepare(`
        UPDATE runs SET status = 'failed', updated_at = ?, error_code = 'INTERRUPTED_RESTART'
        WHERE id = ? AND status IN ('created', 'running', 'paused')
      `);
      for (const row of rows) {
        const id = String(row.id);
        update.run(at, id);
        this.#appendEventRow({
          runId: id,
          at,
          type: "workflow.interrupted",
          actor: "system",
          status: "error",
          summary: "Run stopped after process restart; automatic replay is disabled.",
        });
      }
      this.#db.exec("COMMIT");
      return rows.length;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  saveRun(run: RunRecord): void {
    this.#db
      .prepare(`
        INSERT INTO runs (
          id, created_at, updated_at, status, workspace_label, profile, counters_json, error_code
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          updated_at=excluded.updated_at,
          status=excluded.status,
          counters_json=excluded.counters_json,
          error_code=excluded.error_code
      `)
      .run(
        run.id,
        run.createdAt,
        run.updatedAt,
        run.status,
        safeSummary(run.workspaceLabel, 200),
        run.profile,
        JSON.stringify(run.counters),
        run.errorCode ?? null,
      );
  }

  getRun(runId: string): RunRecord | undefined {
    const row = this.#db
      .prepare(`
        SELECT id, created_at, updated_at, status, workspace_label, profile, counters_json, error_code
        FROM runs WHERE id = ?
      `)
      .get(runId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      id: String(row.id),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      status: row.status as RunRecord["status"],
      workspaceLabel: String(row.workspace_label),
      profile: String(row.profile),
      counters: JSON.parse(String(row.counters_json)) as RunCounters,
      ...(row.error_code ? { errorCode: String(row.error_code) } : {}),
    };
  }

  saveCheckpoint(checkpoint: CheckpointRecord): void {
    this.#db
      .prepare(`
        INSERT INTO checkpoints
          (id, run_id, created_at, round, phase, workspace_fingerprint, counters_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        checkpoint.id,
        checkpoint.runId,
        checkpoint.createdAt,
        checkpoint.round,
        checkpoint.phase,
        checkpoint.workspaceFingerprint,
        JSON.stringify(checkpoint.counters),
      );
  }

  getCheckpoint(runId: string, checkpointId: string): CheckpointRecord | undefined {
    const row = this.#db
      .prepare(`
        SELECT id, run_id, created_at, round, phase, workspace_fingerprint, counters_json
        FROM checkpoints WHERE run_id = ? AND id = ?
      `)
      .get(runId, checkpointId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      id: String(row.id),
      runId: String(row.run_id),
      createdAt: String(row.created_at),
      round: Number(row.round),
      phase: "writer-complete",
      workspaceFingerprint: String(row.workspace_fingerprint),
      counters: JSON.parse(String(row.counters_json)) as RunCounters,
    };
  }

  latestCheckpoint(runId: string): CheckpointRecord | undefined {
    const row = this.#db
      .prepare(`SELECT id FROM checkpoints WHERE run_id = ? ORDER BY round DESC, created_at DESC LIMIT 1`)
      .get(runId) as Record<string, unknown> | undefined;
    return row ? this.getCheckpoint(runId, String(row.id)) : undefined;
  }

  listRecoverableCheckpoints(): Array<{
    runId: string;
    checkpointId: string;
    workspaceLabel: string;
    profile: string;
    round: number;
    createdAt: string;
  }> {
    const rows = this.#db
      .prepare(`
        SELECT r.id AS run_id, r.workspace_label, r.profile,
               c.id AS checkpoint_id, c.round, c.created_at
        FROM runs r
        JOIN checkpoints c ON c.id = (
          SELECT c2.id FROM checkpoints c2
          WHERE c2.run_id = r.id
          ORDER BY c2.round DESC, c2.created_at DESC LIMIT 1
        )
        WHERE r.status = 'failed' AND r.error_code = 'INTERRUPTED_RESTART'
        ORDER BY r.updated_at DESC
        LIMIT 100
      `)
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      runId: String(row.run_id),
      checkpointId: String(row.checkpoint_id),
      workspaceLabel: String(row.workspace_label),
      profile: String(row.profile),
      round: Number(row.round),
      createdAt: String(row.created_at),
    }));
  }

  inventory(): {
    database: string;
    runs: number;
    events: number;
    checkpoints: number;
    apiBudgetReservations: number;
  } {
    const count = (table: "runs" | "events" | "checkpoints" | "api_budget_reservations"): number => {
      const row = this.#db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as Record<string, unknown>;
      return Number(row.count);
    };
    return {
      database: this.path,
      runs: count("runs"),
      events: count("events"),
      checkpoints: count("checkpoints"),
      apiBudgetReservations: count("api_budget_reservations"),
    };
  }

  previewPurge(
    policy: RetentionPolicy,
    protectedRunIds: readonly string[] = [],
    now = new Date(),
  ): PurgePreview {
    if (!Number.isFinite(now.getTime())) throw new Error("INVALID_PURGE_TIME");
    const protectedSet = new Set(protectedRunIds);
    const terminal = this.#db
      .prepare(`
        SELECT id, updated_at FROM runs
        WHERE status IN ('completed', 'failed', 'cancelled')
        ORDER BY updated_at DESC, id ASC
      `)
      .all() as Array<Record<string, unknown>>;
    const cutoff = now.getTime() - policy.terminalRunDays * 86_400_000;
    const candidates = terminal
      .filter((row, index) => {
        const runId = String(row.id);
        if (protectedSet.has(runId)) return false;
        const updatedAt = Date.parse(String(row.updated_at));
        if (!Number.isFinite(updatedAt)) throw new Error("CORRUPT_RUN_TIMESTAMP");
        return index >= policy.maxTerminalRuns || updatedAt < cutoff;
      })
      .map((row) => ({ runId: String(row.id), updatedAt: String(row.updated_at) }));
    if (candidates.length > 10_000) throw new Error("PURGE_PREVIEW_TOO_LARGE");
    const counts = {
      runs: candidates.length,
      events: 0,
      checkpoints: 0,
      apiBudgetReservations: 0,
    };
    const count = this.#db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM events WHERE run_id = ?) AS events,
        (SELECT COUNT(*) FROM checkpoints WHERE run_id = ?) AS checkpoints,
        (SELECT COUNT(*) FROM api_budget_reservations WHERE run_id = ?) AS reservations
    `);
    for (const candidate of candidates) {
      const row = count.get(
        candidate.runId,
        candidate.runId,
        candidate.runId,
      ) as Record<string, unknown>;
      counts.events += Number(row.events);
      counts.checkpoints += Number(row.checkpoints);
      counts.apiBudgetReservations += Number(row.reservations);
    }
    return {
      id: randomUUID(),
      createdAt: now.toISOString(),
      policy: { ...policy },
      protectedRunIds: [...protectedSet].sort(),
      candidates,
      counts,
    };
  }

  purge(preview: PurgePreview): PurgePreview["counts"] {
    if (!/^[0-9a-f-]{36}$/u.test(preview.id) || preview.candidates.length > 10_000) {
      throw new Error("INVALID_PURGE_PREVIEW");
    }
    const deleted = { runs: 0, events: 0, checkpoints: 0, apiBudgetReservations: 0 };
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const snapshot = this.#db.prepare("SELECT status, updated_at FROM runs WHERE id = ?");
      const count = this.#db.prepare(`
        SELECT
          (SELECT COUNT(*) FROM events WHERE run_id = ?) AS events,
          (SELECT COUNT(*) FROM checkpoints WHERE run_id = ?) AS checkpoints,
          (SELECT COUNT(*) FROM api_budget_reservations WHERE run_id = ?) AS reservations
      `);
      const remove = this.#db.prepare(`
        DELETE FROM runs
        WHERE id = ? AND updated_at = ? AND status IN ('completed', 'failed', 'cancelled')
      `);
      for (const candidate of preview.candidates) {
        const row = snapshot.get(candidate.runId) as Record<string, unknown> | undefined;
        if (
          !row ||
          !["completed", "failed", "cancelled"].includes(String(row.status)) ||
          String(row.updated_at) !== candidate.updatedAt ||
          preview.protectedRunIds.includes(candidate.runId)
        ) {
          throw new Error("PURGE_SNAPSHOT_CHANGED");
        }
        const related = count.get(
          candidate.runId,
          candidate.runId,
          candidate.runId,
        ) as Record<string, unknown>;
        const result = remove.run(candidate.runId, candidate.updatedAt);
        if (Number(result.changes) !== 1) throw new Error("PURGE_SNAPSHOT_CHANGED");
        deleted.runs += 1;
        deleted.events += Number(related.events);
        deleted.checkpoints += Number(related.checkpoints);
        deleted.apiBudgetReservations += Number(related.reservations);
      }
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
    this.#db.exec("PRAGMA wal_checkpoint(TRUNCATE); VACUUM;");
    return deleted;
  }

  appendEvent(event: RunEvent): number {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const id = this.#appendEventRow(event);
      this.#db.exec("COMMIT");
      return id;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  #appendEventRow(event: RunEvent): number {
    const summary = safeSummary(event.summary);
    const metadataJson = event.metadata ? JSON.stringify(event.metadata) : null;
    const previous = this.#db
      .prepare("SELECT event_hash FROM events WHERE run_id = ? ORDER BY id DESC LIMIT 1")
      .get(event.runId) as Record<string, unknown> | undefined;
    const previousHash = previous ? String(previous.event_hash) : "";
    if (previous && !/^[a-f0-9]{64}$/u.test(previousHash)) {
      throw new Error("AUDIT_EVENT_CHAIN_INVALID");
    }
    const hash = eventHash({
      runId: event.runId,
      at: event.at,
      type: event.type,
      actor: event.actor,
      status: event.status,
      summary,
      metadataJson,
      previousHash,
    });
    const result = this.#db
      .prepare(`
        INSERT INTO events
          (run_id, at, type, actor, status, summary, metadata_json, prev_hash, event_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        event.runId,
        event.at,
        event.type,
        event.actor,
        event.status,
        summary,
        metadataJson,
        previousHash,
        hash,
      );
    return Number(result.lastInsertRowid);
  }

  listEvents(runId: string, afterId = 0, limit = 500): RunEvent[] {
    const boundedLimit = Math.max(1, Math.min(limit, 500));
    const rows = this.#db
      .prepare(`
        SELECT id, run_id, at, type, actor, status, summary, metadata_json
        FROM events WHERE run_id = ? AND id > ? ORDER BY id ASC LIMIT ?
      `)
      .all(runId, afterId, boundedLimit) as Array<Record<string, unknown>>;
    return rows.map((row) => {
      const event: RunEvent = {
        id: Number(row.id),
        runId: String(row.run_id),
        at: String(row.at),
        type: String(row.type),
        actor: String(row.actor),
        status: row.status as RunEvent["status"],
        summary: String(row.summary),
      };
      if (row.metadata_json) {
        const metadata = JSON.parse(String(row.metadata_json)) as Record<
          string,
          string | number | boolean | null
        >;
        event.metadata = metadata;
      }
      return event;
    });
  }

  close(): void {
    this.#db.close();
  }
}
