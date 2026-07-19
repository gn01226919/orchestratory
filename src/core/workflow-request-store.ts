import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ProviderId } from "../types.ts";

const SCHEMA_VERSION = 1;
const MAX_PENDING = 100;
const MODEL_PATTERN = /^[A-Za-z0-9._:/-]{1,128}$/u;
const ACTOR_PATTERN = /^[a-z][a-z0-9-]{0,31}$/u;

export interface WorkflowAgentTarget {
  provider: ProviderId;
  model: string;
}

export interface WorkflowRequestProposal {
  workspace: string;
  task: string;
  acceptanceCriteria?: string;
  profile: "normal" | "long";
  planner: WorkflowAgentTarget;
  writer: WorkflowAgentTarget;
  reviewers: WorkflowAgentTarget[];
}

export interface PendingWorkflowRequest extends WorkflowRequestProposal {
  id: string;
  actor: string;
  createdAt: string;
  status: "pending" | "accepted" | "declined";
  resolvedAt?: string;
}

interface StoredPayload extends WorkflowRequestProposal {
  actor: string;
}

function hash(payload: string, status: string, resolvedAt: number | null): string {
  return createHash("sha256")
    .update(JSON.stringify({ payload, status, resolvedAt }), "utf8")
    .digest("hex");
}

function boundedText(value: unknown, code: string, max: number): string {
  if (typeof value !== "string" || value.trim().length < 1 || value.length > max || value.includes("\0")) {
    throw new Error(code);
  }
  return value.trim();
}

function target(value: unknown): WorkflowAgentTarget {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("WORKFLOW_REQUEST_TARGET_INVALID");
  }
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !["provider", "model"].includes(key))) {
    throw new Error("WORKFLOW_REQUEST_TARGET_INVALID");
  }
  const provider = input.provider;
  if (!(["fake", "codex", "claude", "grok"] as unknown[]).includes(provider)) {
    throw new Error("WORKFLOW_REQUEST_TARGET_INVALID");
  }
  const model = boundedText(input.model, "WORKFLOW_REQUEST_MODEL_INVALID", 128);
  if (!MODEL_PATTERN.test(model)) throw new Error("WORKFLOW_REQUEST_MODEL_INVALID");
  return { provider: provider as ProviderId, model };
}

function payload(value: unknown): StoredPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("WORKFLOW_REQUEST_PAYLOAD_INVALID");
  }
  const input = value as Record<string, unknown>;
  const allowed = [
    "actor", "workspace", "task", "acceptanceCriteria", "profile", "planner", "writer", "reviewers",
  ];
  if (Object.keys(input).some((key) => !allowed.includes(key))) {
    throw new Error("WORKFLOW_REQUEST_PAYLOAD_INVALID");
  }
  const actor = boundedText(input.actor, "WORKFLOW_REQUEST_ACTOR_INVALID", 32);
  if (!ACTOR_PATTERN.test(actor)) throw new Error("WORKFLOW_REQUEST_ACTOR_INVALID");
  if (!Array.isArray(input.reviewers) || input.reviewers.length < 1 || input.reviewers.length > 3) {
    throw new Error("WORKFLOW_REQUEST_REVIEWERS_INVALID");
  }
  const profile = input.profile;
  if (profile !== "normal" && profile !== "long") throw new Error("WORKFLOW_REQUEST_PROFILE_INVALID");
  return {
    actor,
    workspace: boundedText(input.workspace, "WORKFLOW_REQUEST_WORKSPACE_INVALID", 4_096),
    task: boundedText(input.task, "WORKFLOW_REQUEST_TASK_INVALID", 20_000),
    ...(input.acceptanceCriteria === undefined
      ? {}
      : { acceptanceCriteria: boundedText(input.acceptanceCriteria, "WORKFLOW_REQUEST_ACCEPTANCE_INVALID", 20_000) }),
    profile,
    planner: target(input.planner),
    writer: target(input.writer),
    reviewers: input.reviewers.map(target),
  };
}

/**
 * Cross-process queue for untrusted workflow proposals.
 *
 * A queued proposal is not an approval and cannot start a workflow. The owner
 * must review it in a trusted local UI, which then uses the existing scoped,
 * short-lived approval service immediately before starting a run.
 */
export class WorkflowRequestStore {
  readonly path: string;
  readonly #db: DatabaseSync;
  #closed = false;

  constructor(dataDirectory: string) {
    mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    chmodSync(dataDirectory, 0o700);
    this.path = join(dataDirectory, "workflow-requests.sqlite");
    this.#db = new DatabaseSync(this.path);
    try {
      chmodSync(this.path, 0o600);
      this.#db.exec("PRAGMA journal_mode=WAL; PRAGMA secure_delete=ON; PRAGMA busy_timeout=5000;");
      const quick = this.#db.prepare("PRAGMA quick_check").get() as { quick_check?: string };
      if (quick.quick_check !== "ok") throw new Error("WORKFLOW_REQUEST_STORE_CORRUPT");
      const version = Number(
        (this.#db.prepare("PRAGMA user_version").get() as { user_version?: number }).user_version ?? 0,
      );
      if (!Number.isSafeInteger(version) || version < 0 || version > SCHEMA_VERSION) {
        throw new Error("WORKFLOW_REQUEST_STORE_SCHEMA_UNSUPPORTED");
      }
      if (version === 0) {
        this.#db.exec("BEGIN IMMEDIATE");
        try {
          this.#db.exec(`
            CREATE TABLE workflow_requests (
              id TEXT PRIMARY KEY CHECK (length(id) = 36),
              created_at INTEGER NOT NULL CHECK (created_at >= 0),
              payload TEXT NOT NULL CHECK (length(payload) BETWEEN 2 AND 100000),
              status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'declined')),
              resolved_at INTEGER CHECK (resolved_at IS NULL OR resolved_at >= created_at),
              row_hash TEXT NOT NULL CHECK (length(row_hash) = 64)
            ) STRICT;
            CREATE INDEX workflow_requests_status_created ON workflow_requests(status, created_at);
            PRAGMA user_version = 1;
          `);
          this.#db.exec("COMMIT");
        } catch (error) {
          this.#db.exec("ROLLBACK");
          throw error;
        }
      }
      this.#verifyRows();
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }

  enqueue(input: WorkflowRequestProposal, actor: string, now = Date.now()): PendingWorkflowRequest {
    this.#assertOpen();
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("WORKFLOW_REQUEST_TIME_INVALID");
    const checked = payload({ ...input, actor });
    const serialized = JSON.stringify(checked);
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const count = this.#db.prepare(
        "SELECT COUNT(*) AS count FROM workflow_requests WHERE status = 'pending'",
      ).get() as { count?: number };
      if (Number(count.count) >= MAX_PENDING) throw new Error("WORKFLOW_REQUEST_QUEUE_FULL");
      const existing = this.#db.prepare(
        "SELECT * FROM workflow_requests WHERE status = 'pending' AND payload = ? ORDER BY created_at LIMIT 1",
      ).get(serialized) as Record<string, unknown> | undefined;
      if (existing) {
        const parsed = this.#row(existing);
        this.#db.exec("COMMIT");
        return parsed;
      }
      const id = randomUUID();
      this.#db.prepare(
        "INSERT INTO workflow_requests (id, created_at, payload, status, resolved_at, row_hash) VALUES (?, ?, ?, 'pending', NULL, ?)",
      ).run(id, now, serialized, hash(serialized, "pending", null));
      const created = this.#db.prepare("SELECT * FROM workflow_requests WHERE id = ?").get(id) as Record<string, unknown>;
      this.#db.exec("COMMIT");
      return this.#row(created);
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  listPending(limit = MAX_PENDING): PendingWorkflowRequest[] {
    this.#assertOpen();
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PENDING) {
      throw new Error("WORKFLOW_REQUEST_LIMIT_INVALID");
    }
    const rows = this.#db.prepare(
      "SELECT * FROM workflow_requests WHERE status = 'pending' ORDER BY created_at, id LIMIT ?",
    ).all(limit) as Record<string, unknown>[];
    return rows.map((row) => this.#row(row));
  }

  resolve(id: string, decision: "accepted" | "declined", now = Date.now()): PendingWorkflowRequest {
    this.#assertOpen();
    if (!/^[0-9a-f-]{36}$/u.test(id)) throw new Error("WORKFLOW_REQUEST_ID_INVALID");
    if (decision !== "accepted" && decision !== "declined") {
      throw new Error("WORKFLOW_REQUEST_DECISION_INVALID");
    }
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("WORKFLOW_REQUEST_TIME_INVALID");
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.#db.prepare("SELECT * FROM workflow_requests WHERE id = ?").get(id) as
        | Record<string, unknown>
        | undefined;
      if (!current) throw new Error("WORKFLOW_REQUEST_NOT_FOUND");
      const parsed = this.#row(current);
      if (parsed.status !== "pending") throw new Error("WORKFLOW_REQUEST_ALREADY_RESOLVED");
      const serialized = String(current.payload);
      this.#db.prepare(
        "UPDATE workflow_requests SET status = ?, resolved_at = ?, row_hash = ? WHERE id = ? AND status = 'pending'",
      ).run(decision, now, hash(serialized, decision, now), id);
      const updated = this.#db.prepare("SELECT * FROM workflow_requests WHERE id = ?").get(id) as Record<string, unknown>;
      this.#db.exec("COMMIT");
      return this.#row(updated);
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  inventory(): { total: number; pending: number; accepted: number; declined: number } {
    this.#assertOpen();
    const counts = { total: 0, pending: 0, accepted: 0, declined: 0 };
    for (const row of this.#db.prepare(
      "SELECT status, COUNT(*) AS count FROM workflow_requests GROUP BY status",
    ).all() as Array<{ status: keyof Omit<typeof counts, "total">; count: number }>) {
      counts[row.status] = Number(row.count);
      counts.total += Number(row.count);
    }
    return counts;
  }

  integrity(): { schemaVersion: number; quickCheck: "ok"; rows: number; hashesValid: boolean } {
    this.#assertOpen();
    const quick = this.#db.prepare("PRAGMA quick_check").get() as { quick_check?: string };
    if (quick.quick_check !== "ok") throw new Error("WORKFLOW_REQUEST_STORE_CORRUPT");
    const version = Number(
      (this.#db.prepare("PRAGMA user_version").get() as { user_version?: number }).user_version,
    );
    let hashesValid = true;
    try {
      this.#verifyRows();
    } catch {
      hashesValid = false;
    }
    const count = this.#db.prepare("SELECT COUNT(*) AS count FROM workflow_requests").get() as { count?: number };
    return { schemaVersion: version, quickCheck: "ok", rows: Number(count.count), hashesValid };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }

  #row(row: Record<string, unknown>): PendingWorkflowRequest {
    const id = String(row.id);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(id)) {
      throw new Error("WORKFLOW_REQUEST_ROW_INVALID");
    }
    const serialized = String(row.payload);
    const status = String(row.status);
    const resolvedAt = row.resolved_at === null ? null : Number(row.resolved_at);
    if (!['pending', 'accepted', 'declined'].includes(status)) throw new Error("WORKFLOW_REQUEST_ROW_INVALID");
    if (hash(serialized, status, resolvedAt) !== row.row_hash) {
      throw new Error("WORKFLOW_REQUEST_HASH_MISMATCH");
    }
    const checked = payload(JSON.parse(serialized) as unknown);
    const createdAt = Number(row.created_at);
    if (!Number.isSafeInteger(createdAt) || createdAt < 0) throw new Error("WORKFLOW_REQUEST_ROW_INVALID");
    if (resolvedAt !== null && (!Number.isSafeInteger(resolvedAt) || resolvedAt < createdAt)) {
      throw new Error("WORKFLOW_REQUEST_ROW_INVALID");
    }
    if ((status === "pending") !== (resolvedAt === null)) {
      throw new Error("WORKFLOW_REQUEST_ROW_INVALID");
    }
    return {
      id,
      ...checked,
      status: status as PendingWorkflowRequest["status"],
      createdAt: new Date(createdAt).toISOString(),
      ...(resolvedAt === null ? {} : { resolvedAt: new Date(resolvedAt).toISOString() }),
    };
  }

  #verifyRows(): void {
    for (const row of this.#db.prepare("SELECT * FROM workflow_requests ORDER BY created_at, id").all() as Record<string, unknown>[]) {
      this.#row(row);
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("WORKFLOW_REQUEST_STORE_CLOSED");
  }
}
