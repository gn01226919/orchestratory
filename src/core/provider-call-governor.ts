import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ProviderRequest, ProviderResult } from "../types.ts";
import { openOwnerDatabase, verifyOwnerDatabaseFiles } from "./sqlite-security.ts";

const GOVERNOR_SCHEMA_VERSION = 1;
const WINDOW_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_POLL_MS = 250;

export interface ProviderCallUsage {
  calls: number;
  maxCalls: number;
  windowStartedAt: string;
  windowEndsAt: string;
  activeLocal: number;
  killEpoch: number;
}

export interface ProviderGovernorIntegrity {
  schemaVersion: number;
  quickCheck: "ok";
  stateRows: number;
  stateValid: boolean;
}

/**
 * Cross-process subscription/API call governor.
 *
 * Reservations and the kill epoch live in a dedicated owner-only SQLite file,
 * so opening a new TUI or MCP process cannot reset the 24-hour call ceiling.
 * Active subprocesses remain owned by their launching process; each governor
 * watches the shared kill epoch and translates changes into an AbortSignal.
 */
export class ProviderCallGovernor {
  readonly path: string;
  readonly #db: DatabaseSync;
  readonly #maxCalls: number;
  readonly #pollMs: number;
  readonly #active = new Set<AbortController>();
  #closed = false;

  constructor(
    dataDirectory: string,
    maxCalls: number,
    options: { pollMs?: number } = {},
  ) {
    if (!Number.isSafeInteger(maxCalls) || maxCalls < 1) throw new Error("INVALID_PROVIDER_CALL_LIMIT");
    const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    if (!Number.isSafeInteger(pollMs) || pollMs < 10 || pollMs > 5_000) {
      throw new Error("INVALID_PROVIDER_GOVERNOR_POLL");
    }
    this.#maxCalls = maxCalls;
    this.#pollMs = pollMs;
    this.path = join(dataDirectory, "provider-governor.sqlite");
    this.#db = openOwnerDatabase(this.path);
    try {
      this.#db.exec("PRAGMA journal_mode=WAL; PRAGMA secure_delete=ON; PRAGMA busy_timeout=5000;");
      verifyOwnerDatabaseFiles(this.path);
      const quick = this.#db.prepare("PRAGMA quick_check").get() as { quick_check?: string };
      if (quick.quick_check !== "ok") throw new Error("PROVIDER_GOVERNOR_CORRUPT");
      const version = Number(
        (this.#db.prepare("PRAGMA user_version").get() as { user_version?: number }).user_version ?? 0,
      );
      if (!Number.isSafeInteger(version) || version < 0 || version > GOVERNOR_SCHEMA_VERSION) {
        throw new Error("PROVIDER_GOVERNOR_SCHEMA_UNSUPPORTED");
      }
      if (version === 0) {
        const now = Date.now();
        this.#db.exec("BEGIN IMMEDIATE");
        try {
          this.#db.exec(`
            CREATE TABLE provider_governor_state (
              id INTEGER PRIMARY KEY CHECK (id = 1),
              window_started_at INTEGER NOT NULL CHECK (window_started_at >= 0),
              calls INTEGER NOT NULL CHECK (calls >= 0),
              kill_epoch INTEGER NOT NULL CHECK (kill_epoch >= 0)
            ) STRICT;
            PRAGMA user_version = 1;
          `);
          this.#db.prepare(
            "INSERT INTO provider_governor_state (id, window_started_at, calls, kill_epoch) VALUES (1, ?, 0, 0)",
          ).run(now);
          this.#db.exec("COMMIT");
        } catch (error) {
          this.#db.exec("ROLLBACK");
          throw error;
        }
      }
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }

  status(now = Date.now()): ProviderCallUsage {
    this.#assertOpen();
    const row = this.#state();
    const expired = now - row.windowStartedAt >= WINDOW_MS;
    const windowStartedAt = expired ? now : row.windowStartedAt;
    return {
      calls: expired ? 0 : row.calls,
      maxCalls: this.#maxCalls,
      windowStartedAt: new Date(windowStartedAt).toISOString(),
      windowEndsAt: new Date(windowStartedAt + WINDOW_MS).toISOString(),
      activeLocal: this.#active.size,
      killEpoch: row.killEpoch,
    };
  }

  integrity(): ProviderGovernorIntegrity {
    this.#assertOpen();
    const quick = this.#db.prepare("PRAGMA quick_check").get() as { quick_check?: string };
    if (quick.quick_check !== "ok") throw new Error("PROVIDER_GOVERNOR_CORRUPT");
    const schema = this.#db.prepare("PRAGMA user_version").get() as { user_version?: number };
    const count = this.#db.prepare("SELECT COUNT(*) AS count FROM provider_governor_state").get() as {
      count?: number;
    };
    let stateValid = false;
    try {
      this.#state();
      stateValid = Number(count.count) === 1;
    } catch {
      stateValid = false;
    }
    return {
      schemaVersion: Number(schema.user_version),
      quickCheck: "ok",
      stateRows: Number(count.count),
      stateValid,
    };
  }

  async invoke(
    request: ProviderRequest,
    operation: (governed: ProviderRequest) => Promise<ProviderResult>,
  ): Promise<ProviderResult> {
    this.#assertOpen();
    if (request.signal?.aborted) throw new Error("PROVIDER_ABORTED");
    const epoch = this.#reserve();
    const controller = new AbortController();
    const abortFromCaller = (): void => controller.abort(request.signal?.reason);
    request.signal?.addEventListener("abort", abortFromCaller, { once: true });
    this.#active.add(controller);
    const timer = setInterval(() => {
      try {
        if (this.#killEpoch() !== epoch) controller.abort(new Error("PROVIDER_GLOBAL_STOP"));
      } catch {
        controller.abort(new Error("PROVIDER_GOVERNOR_UNAVAILABLE"));
      }
    }, this.#pollMs);
    try {
      return await operation({ ...request, signal: controller.signal });
    } finally {
      clearInterval(timer);
      request.signal?.removeEventListener("abort", abortFromCaller);
      this.#active.delete(controller);
    }
  }

  stopAll(): { activeLocal: number; killEpoch: number } {
    this.#assertOpen();
    const activeLocal = this.#active.size;
    for (const controller of this.#active) controller.abort(new Error("PROVIDER_GLOBAL_STOP"));
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.prepare("UPDATE provider_governor_state SET kill_epoch = kill_epoch + 1 WHERE id = 1").run();
      const killEpoch = this.#killEpoch();
      this.#db.exec("COMMIT");
      return { activeLocal, killEpoch };
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    if (this.#closed) return;
    for (const controller of this.#active) controller.abort(new Error("PROVIDER_GOVERNOR_CLOSED"));
    this.#closed = true;
    this.#db.close();
  }

  #reserve(now = Date.now()): number {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      let row = this.#state();
      if (now - row.windowStartedAt >= WINDOW_MS) {
        this.#db.prepare(
          "UPDATE provider_governor_state SET window_started_at = ?, calls = 0 WHERE id = 1",
        ).run(now);
        row = { ...row, windowStartedAt: now, calls: 0 };
      }
      if (row.calls >= this.#maxCalls) throw new Error("GLOBAL_PROVIDER_CALL_LIMIT_REACHED");
      this.#db.prepare("UPDATE provider_governor_state SET calls = calls + 1 WHERE id = 1").run();
      this.#db.exec("COMMIT");
      return row.killEpoch;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  #state(): { windowStartedAt: number; calls: number; killEpoch: number } {
    const row = this.#db.prepare(
      "SELECT window_started_at, calls, kill_epoch FROM provider_governor_state WHERE id = 1",
    ).get() as { window_started_at?: number; calls?: number; kill_epoch?: number } | undefined;
    if (!row) throw new Error("PROVIDER_GOVERNOR_STATE_MISSING");
    const state = {
      windowStartedAt: Number(row.window_started_at),
      calls: Number(row.calls),
      killEpoch: Number(row.kill_epoch),
    };
    if (
      !Number.isSafeInteger(state.windowStartedAt) || state.windowStartedAt < 0 ||
      !Number.isSafeInteger(state.calls) || state.calls < 0 ||
      !Number.isSafeInteger(state.killEpoch) || state.killEpoch < 0
    ) throw new Error("PROVIDER_GOVERNOR_STATE_INVALID");
    return state;
  }

  #killEpoch(): number {
    return this.#state().killEpoch;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("PROVIDER_GOVERNOR_CLOSED");
  }
}
