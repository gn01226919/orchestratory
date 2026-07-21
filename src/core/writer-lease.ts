import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openOwnerDatabase, verifyOwnerDatabaseFiles } from "./sqlite-security.ts";

export type WriterOrigin = "resident" | "managed" | "external";
export type WriterProvider = "codex" | "claude" | "grok";
export type WriterLeaseState = "active" | "revoked" | "completed";

export interface WriterIdentity {
  origin: WriterOrigin;
  provider: WriterProvider;
  actorId: string;
  displayName: string;
}

export interface WriterLease {
  id: string;
  taskId: string;
  roomId: string;
  workspace: string;
  worktree: string;
  epoch: number;
  state: WriterLeaseState;
  writer: WriterIdentity;
  onBehalfOf: string;
  executedBy: string;
  companionId?: string;
  grantedAtMs: number;
  revokedAtMs?: number;
  checkpoint?: string;
}

export interface GrantedWriterLease {
  lease: WriterLease;
  capabilityToken: string;
}

interface TaskRow {
  task_id: string;
  room_id: string;
  workspace: string;
  worktree: string;
  next_epoch: number;
  active_lease_id: string | null;
  apply_started_at_ms: number | null;
  applied_at_ms: number | null;
  updated_at_ms: number;
  row_hash: string;
}

interface LeaseRow {
  id: string;
  task_id: string;
  epoch: number;
  state: WriterLeaseState;
  writer_origin: WriterOrigin;
  provider: WriterProvider;
  actor_id: string;
  display_name: string;
  on_behalf_of: string;
  executed_by: string;
  companion_id: string | null;
  capability_hash: string;
  granted_at_ms: number;
  revoked_at_ms: number | null;
  checkpoint: string | null;
  row_hash: string;
}

const SCHEMA_VERSION = 4;
const ROOM_PATTERN = /^[a-z][a-z0-9-]{0,47}$/u;
const TASK_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const ACTOR_PATTERN = /^[A-Za-z0-9._:()\-·\p{L}\p{N} （）]{1,96}$/u;
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;

function sha(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function equalHash(left: string, right: string): boolean {
  if (!HASH_PATTERN.test(left) || !HASH_PATTERN.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function hashTask(row: Omit<TaskRow, "row_hash">): string {
  return sha(JSON.stringify([
    row.task_id, row.room_id, row.workspace, row.worktree, row.next_epoch,
    row.active_lease_id, row.apply_started_at_ms, row.applied_at_ms, row.updated_at_ms,
  ]));
}

function hashLease(row: Omit<LeaseRow, "row_hash">): string {
  return sha(JSON.stringify([
    row.id, row.task_id, row.epoch, row.state, row.writer_origin, row.provider,
    row.actor_id, row.display_name, row.on_behalf_of, row.executed_by,
    row.companion_id, row.capability_hash, row.granted_at_ms, row.revoked_at_ms,
    row.checkpoint,
  ]));
}

function validText(value: unknown, error: string, max = 128): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max || value.includes("\0")) throw new Error(error);
  return value;
}

function validTask(value: unknown): string {
  const taskId = validText(value, "WRITER_TASK_INVALID");
  if (!TASK_PATTERN.test(taskId)) throw new Error("WRITER_TASK_INVALID");
  return taskId;
}

function validIdentity(input: WriterIdentity): WriterIdentity {
  if (input.origin !== "resident" && input.origin !== "managed" && input.origin !== "external") throw new Error("WRITER_ORIGIN_INVALID");
  if (input.provider !== "codex" && input.provider !== "claude" && input.provider !== "grok") throw new Error("WRITER_PROVIDER_INVALID");
  if (!ACTOR_PATTERN.test(input.actorId) || !ACTOR_PATTERN.test(input.displayName)) throw new Error("WRITER_IDENTITY_INVALID");
  return { ...input };
}

/** Owner-only, epoch-fenced Writer lease registry. */
export class WriterLeaseStore {
  readonly path: string;
  readonly #db: DatabaseSync;
  readonly #now: () => number;
  #closed = false;

  constructor(dataDirectory: string, options: { now?: () => number } = {}) {
    this.path = join(dataDirectory, "writer-leases.sqlite");
    this.#now = options.now ?? Date.now;
    this.#db = openOwnerDatabase(this.path);
    try {
      this.#db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON; PRAGMA busy_timeout=3000;");
      verifyOwnerDatabaseFiles(this.path);
      const quick = this.#db.prepare("PRAGMA quick_check").get() as { quick_check?: string };
      if (quick.quick_check !== "ok") throw new Error("WRITER_LEASE_STORE_CORRUPT");
      const version = Number((this.#db.prepare("PRAGMA user_version").get() as { user_version?: number }).user_version ?? 0);
      if (!Number.isSafeInteger(version) || version < 0 || version > SCHEMA_VERSION) throw new Error("WRITER_LEASE_SCHEMA_UNSUPPORTED");
      if (version === 0) this.#migrate();
      if (version < 2) this.#migrateV2();
      if (version < 3) this.#migrateV3();
      if (version < 4) this.#migrateV4();
      if (this.#db.prepare("PRAGMA foreign_key_check").all().length > 0) throw new Error("WRITER_LEASE_FOREIGN_KEY_VIOLATION");
      this.#verify();
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }

  grant(input: { taskId: string; roomId: string; workspace: string; worktree: string; writer: WriterIdentity }): GrantedWriterLease {
    this.#assertOpen();
    const taskId = validTask(input.taskId);
    const roomId = validText(input.roomId, "WRITER_ROOM_INVALID", 48);
    if (!ROOM_PATTERN.test(roomId)) throw new Error("WRITER_ROOM_INVALID");
    const workspace = validText(input.workspace, "WRITER_WORKSPACE_INVALID", 4_096);
    const worktree = validText(input.worktree, "WRITER_WORKTREE_INVALID", 4_096);
    if (!isAbsolute(workspace) || !isAbsolute(worktree)) throw new Error("WRITER_PATH_INVALID");
    const writer = validIdentity(input.writer);
    return this.#grant({ taskId, roomId, workspace, worktree, writer });
  }

  switch(input: {
    taskId: string;
    expectedEpoch: number;
    checkpoint: string;
    writer: WriterIdentity;
  }): GrantedWriterLease {
    this.#assertOpen();
    const taskId = validTask(input.taskId);
    if (!Number.isSafeInteger(input.expectedEpoch) || input.expectedEpoch < 1) throw new Error("WRITER_EPOCH_INVALID");
    const checkpoint = validText(input.checkpoint, "WRITER_CHECKPOINT_REQUIRED", 1_024);
    const writer = validIdentity(input.writer);
    const now = this.#now();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const task = this.#task(taskId);
      if (!task || !task.active_lease_id) throw new Error("WRITER_LEASE_NOT_ACTIVE");
      this.#assertTask(task);
      if (this.#blockingTaskRun(task.task_id, now)) throw new Error("WRITER_TASK_ALREADY_RUNNING");
      const current = this.#lease(task.active_lease_id);
      if (!current || current.state !== "active" || current.epoch !== input.expectedEpoch) throw new Error("WRITER_EPOCH_STALE");
      this.#assertLease(current);
      const revoked = this.#leaseMutation(current, { state: "revoked", revoked_at_ms: now, checkpoint });
      this.#replaceLease(current, revoked);
      const capabilityToken = randomUUID();
      const next = this.#newLease(task, writer, task.next_epoch, capabilityToken, now);
      this.#insertLease(next);
      const nextTask = this.#taskMutation(task, {
        next_epoch: task.next_epoch + 1,
        active_lease_id: next.id,
        updated_at_ms: now,
      });
      this.#replaceTask(task, nextTask);
      this.#event(taskId, current.epoch, "writer-revoked", now, checkpoint);
      this.#event(taskId, next.epoch, "writer-granted", now, next.on_behalf_of);
      this.#db.exec("COMMIT");
      return { lease: this.#public(next, nextTask), capabilityToken };
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  complete(input: { taskId: string; epoch: number; checkpoint: string }): WriterLease {
    this.#assertOpen();
    if (!Number.isSafeInteger(input.epoch) || input.epoch < 1) throw new Error("WRITER_EPOCH_INVALID");
    const checkpoint = validText(input.checkpoint, "WRITER_CHECKPOINT_REQUIRED", 1_024);
    const now = this.#now();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const task = this.#task(validTask(input.taskId));
      if (!task?.active_lease_id) throw new Error("WRITER_LEASE_NOT_ACTIVE");
      this.#assertTask(task);
      if (this.#blockingTaskRun(task.task_id, now)) throw new Error("WRITER_TASK_ALREADY_RUNNING");
      const current = this.#lease(task.active_lease_id);
      if (!current || current.state !== "active" || current.epoch !== input.epoch) throw new Error("WRITER_EPOCH_STALE");
      this.#assertLease(current);
      const completed = this.#leaseMutation(current, { state: "completed", revoked_at_ms: now, checkpoint });
      this.#replaceLease(current, completed);
      const nextTask = this.#taskMutation(task, { active_lease_id: null, updated_at_ms: now });
      this.#replaceTask(task, nextTask);
      this.#event(task.task_id, current.epoch, "writer-completed", now, checkpoint);
      this.#db.exec("COMMIT");
      return this.#public(completed, nextTask);
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  revoke(input: { taskId: string; epoch: number; checkpoint: string }): WriterLease {
    this.#assertOpen();
    if (!Number.isSafeInteger(input.epoch) || input.epoch < 1) throw new Error("WRITER_EPOCH_INVALID");
    const checkpoint = validText(input.checkpoint, "WRITER_CHECKPOINT_REQUIRED", 1_024);
    const now = this.#now();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const task = this.#task(validTask(input.taskId));
      if (!task?.active_lease_id) throw new Error("WRITER_LEASE_NOT_ACTIVE");
      this.#assertTask(task);
      if (this.#blockingTaskRun(task.task_id, now)) throw new Error("WRITER_TASK_ALREADY_RUNNING");
      const current = this.#lease(task.active_lease_id);
      if (!current || current.state !== "active" || current.epoch !== input.epoch) throw new Error("WRITER_EPOCH_STALE");
      this.#assertLease(current);
      const revoked = this.#leaseMutation(current, { state: "revoked", revoked_at_ms: now, checkpoint });
      this.#replaceLease(current, revoked);
      const nextTask = this.#taskMutation(task, { active_lease_id: null, updated_at_ms: now });
      this.#replaceTask(task, nextTask);
      this.#event(task.task_id, current.epoch, "writer-revoked", now, checkpoint);
      this.#db.exec("COMMIT");
      return this.#public(revoked, nextTask);
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  revokeByActor(actorIdValue: string, checkpointValue: string): WriterLease[] {
    this.#assertOpen();
    const actorId = validText(actorIdValue, "WRITER_IDENTITY_INVALID", 96);
    if (!ACTOR_PATTERN.test(actorId)) throw new Error("WRITER_IDENTITY_INVALID");
    const checkpoint = validText(checkpointValue, "WRITER_CHECKPOINT_REQUIRED", 1_024);
    const now = this.#now();
    const revoked: Array<{ lease: LeaseRow; task: TaskRow }> = [];
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const active = this.#db.prepare(
        "SELECT * FROM writer_leases WHERE actor_id = ? AND state = 'active' ORDER BY task_id",
      ).all(actorId) as unknown as LeaseRow[];
      for (const current of active) {
        this.#assertLease(current);
        const task = this.#task(current.task_id);
        if (!task || task.active_lease_id !== current.id) throw new Error("WRITER_LEASE_TARGET_INVALID");
        this.#assertTask(task);
        const nextLease = this.#leaseMutation(current, { state: "revoked", revoked_at_ms: now, checkpoint });
        this.#replaceLease(current, nextLease);
        const nextTask = this.#taskMutation(task, { active_lease_id: null, updated_at_ms: now });
        this.#replaceTask(task, nextTask);
        this.#event(task.task_id, current.epoch, "writer-revoked", now, checkpoint);
        revoked.push({ lease: nextLease, task: nextTask });
      }
      this.#db.exec("COMMIT");
      return revoked.map(({ lease, task }) => this.#public(lease, task));
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  assertWrite(input: { taskId: string; epoch: number; capabilityToken: string; executedBy: string }): WriterLease {
    this.#assertOpen();
    const task = this.#task(validTask(input.taskId));
    if (!task?.active_lease_id) throw new Error("WRITER_LEASE_NOT_ACTIVE");
    const lease = this.#lease(task.active_lease_id);
    if (!lease || lease.state !== "active" || lease.epoch !== input.epoch) throw new Error("WRITER_EPOCH_STALE");
    if (lease.executed_by !== input.executedBy) throw new Error("WRITER_EXECUTOR_MISMATCH");
    const token = validText(input.capabilityToken, "WRITER_CAPABILITY_INVALID", 64);
    if (!equalHash(sha(token), lease.capability_hash)) throw new Error("WRITER_CAPABILITY_INVALID");
    this.#assertLease(lease);
    this.#assertTask(task);
    return this.#public(lease, task);
  }

  current(taskId: string): WriterLease | undefined {
    this.#assertOpen();
    const task = this.#task(validTask(taskId));
    if (!task?.active_lease_id) return undefined;
    this.#assertTask(task);
    const lease = this.#lease(task.active_lease_id);
    if (!lease) throw new Error("WRITER_LEASE_TARGET_MISSING");
    this.#assertLease(lease);
    return this.#public(lease, task);
  }

  taskScope(taskIdValue: string): { taskId: string; roomId: string; workspace: string; worktree: string; nextEpoch: number; active: boolean; applying: boolean; applied: boolean } | undefined {
    this.#assertOpen();
    const task = this.#task(validTask(taskIdValue));
    if (!task) return undefined;
    this.#assertTask(task);
    return {
      taskId: task.task_id,
      roomId: task.room_id,
      workspace: task.workspace,
      worktree: task.worktree,
      nextEpoch: task.next_epoch,
      active: Boolean(task.active_lease_id),
      applying: task.apply_started_at_ms !== null,
      applied: task.applied_at_ms !== null,
    };
  }

  beginApply(taskIdValue: string, expectedWorktree: string): void {
    this.#assertOpen();
    const taskId = validTask(taskIdValue);
    const worktree = validText(expectedWorktree, "WRITER_WORKTREE_INVALID", 4_096);
    const now = this.#now();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const task = this.#task(taskId);
      if (!task || task.worktree !== worktree) throw new Error("WRITER_TASK_SCOPE_MISMATCH");
      this.#assertTask(task);
      if (task.active_lease_id) throw new Error("WRITER_LEASE_ALREADY_ACTIVE");
      if (task.applied_at_ms !== null) throw new Error("WRITER_TASK_ALREADY_APPLIED");
      if (task.apply_started_at_ms !== null) throw new Error("WRITER_TASK_APPLY_IN_PROGRESS");
      this.#replaceTask(task, this.#taskMutation(task, { apply_started_at_ms: now, updated_at_ms: now }));
      this.#event(taskId, task.next_epoch - 1, "writer-apply-started", now, worktree);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  finishApply(taskIdValue: string, expectedWorktree: string): void {
    this.#assertOpen();
    const taskId = validTask(taskIdValue);
    const worktree = validText(expectedWorktree, "WRITER_WORKTREE_INVALID", 4_096);
    const now = this.#now();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const task = this.#task(taskId);
      if (!task || task.worktree !== worktree) throw new Error("WRITER_TASK_SCOPE_MISMATCH");
      this.#assertTask(task);
      if (task.active_lease_id) throw new Error("WRITER_LEASE_ALREADY_ACTIVE");
      if (task.applied_at_ms !== null) throw new Error("WRITER_TASK_ALREADY_APPLIED");
      if (task.apply_started_at_ms === null) throw new Error("WRITER_TASK_APPLY_NOT_STARTED");
      this.#replaceTask(task, this.#taskMutation(task, {
        apply_started_at_ms: null, applied_at_ms: now, updated_at_ms: now,
      }));
      this.#event(taskId, task.next_epoch - 1, "writer-applied", now, worktree);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  failApply(taskIdValue: string, expectedWorktree: string, reason: string): void {
    this.#assertOpen();
    const taskId = validTask(taskIdValue);
    const worktree = validText(expectedWorktree, "WRITER_WORKTREE_INVALID", 4_096);
    const detail = validText(reason, "WRITER_APPLY_FAILURE_REASON_REQUIRED", 1_024);
    const now = this.#now();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const task = this.#task(taskId);
      if (!task || task.worktree !== worktree) throw new Error("WRITER_TASK_SCOPE_MISMATCH");
      this.#assertTask(task);
      if (task.applied_at_ms !== null) throw new Error("WRITER_TASK_ALREADY_APPLIED");
      if (task.apply_started_at_ms === null) throw new Error("WRITER_TASK_APPLY_NOT_STARTED");
      this.#replaceTask(task, this.#taskMutation(task, { apply_started_at_ms: null, updated_at_ms: now }));
      this.#event(taskId, task.next_epoch - 1, "writer-apply-failed", now, detail);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  markApplied(taskIdValue: string, expectedWorktree: string): void {
    this.beginApply(taskIdValue, expectedWorktree);
    this.finishApply(taskIdValue, expectedWorktree);
  }

  beginRun(taskIdValue: string, runIdValue: string, ownerIdValue: string, staleAfterMs = 900_000): void {
    this.#assertOpen();
    const taskId = validTask(taskIdValue);
    const runId = validText(runIdValue, "WRITER_RUN_ID_INVALID");
    const ownerId = validText(ownerIdValue, "WRITER_RUN_OWNER_INVALID");
    if (!ID_PATTERN.test(runId) || !/^[A-Za-z0-9._:-]{1,128}$/u.test(ownerId)) throw new Error("WRITER_RUN_ID_INVALID");
    if (!Number.isSafeInteger(staleAfterMs) || staleAfterMs < 60_000 || staleAfterMs > 3_600_000) {
      throw new Error("WRITER_RUN_STALE_WINDOW_INVALID");
    }
    const now = this.#now();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const task = this.#task(taskId);
      if (!task?.active_lease_id) throw new Error("WRITER_LEASE_NOT_ACTIVE");
      this.#assertTask(task);
      if (task.apply_started_at_ms !== null || task.applied_at_ms !== null) throw new Error("WRITER_TASK_NOT_RUNNABLE");
      const existing = this.#taskRun(taskId);
      if (existing && existing.heartbeat_at_ms > now - staleAfterMs) throw new Error("WRITER_TASK_ALREADY_RUNNING");
      if (existing) this.#db.prepare("DELETE FROM writer_task_runs WHERE task_id=?").run(taskId);
      this.#db.prepare(`INSERT INTO writer_task_runs
        (task_id,run_id,owner_id,started_at_ms,heartbeat_at_ms) VALUES (?,?,?,?,?)`)
        .run(taskId, runId, ownerId, now, now);
      this.#event(taskId, task.next_epoch - 1, "writer-run-started", now, runId);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  heartbeatRun(taskIdValue: string, runIdValue: string, ownerIdValue: string): void {
    this.#assertOpen();
    const taskId = validTask(taskIdValue);
    const runId = validText(runIdValue, "WRITER_RUN_ID_INVALID");
    const ownerId = validText(ownerIdValue, "WRITER_RUN_OWNER_INVALID");
    const result = this.#db.prepare(`UPDATE writer_task_runs SET heartbeat_at_ms=?
      WHERE task_id=? AND run_id=? AND owner_id=?`).run(this.#now(), taskId, runId, ownerId);
    if (Number(result.changes) !== 1) throw new Error("WRITER_RUN_LOCK_LOST");
  }

  finishRun(taskIdValue: string, runIdValue: string, ownerIdValue: string): void {
    this.#assertOpen();
    const taskId = validTask(taskIdValue);
    const runId = validText(runIdValue, "WRITER_RUN_ID_INVALID");
    const ownerId = validText(ownerIdValue, "WRITER_RUN_OWNER_INVALID");
    const result = this.#db.prepare("DELETE FROM writer_task_runs WHERE task_id=? AND run_id=? AND owner_id=?")
      .run(taskId, runId, ownerId);
    if (Number(result.changes) !== 1) throw new Error("WRITER_RUN_LOCK_LOST");
  }

  hasActiveRun(taskIdValue: string, staleAfterMs = 900_000): boolean {
    this.#assertOpen();
    const taskId = validTask(taskIdValue);
    const row = this.#taskRun(taskId);
    return Boolean(row && row.heartbeat_at_ms > this.#now() - staleAfterMs);
  }

  list(roomId: string): WriterLease[] {
    this.#assertOpen();
    const room = validText(roomId, "WRITER_ROOM_INVALID", 48);
    if (!ROOM_PATTERN.test(room)) throw new Error("WRITER_ROOM_INVALID");
    const rows = this.#db.prepare(`SELECT l.*, t.room_id, t.workspace, t.worktree
      FROM writer_leases l JOIN writer_tasks t ON t.task_id = l.task_id
      WHERE t.room_id = ? ORDER BY l.granted_at_ms, l.epoch`).all(room) as unknown as Array<LeaseRow & Pick<TaskRow, "room_id" | "workspace" | "worktree">>;
    return rows.map((row) => {
      const task = this.#task(row.task_id)!;
      this.#assertLease(row);
      this.#assertTask(task);
      return this.#public(row, task);
    });
  }

  inventory(): { database: string; schemaVersion: number; databaseBytes: number; tasks: number; leases: number; active: number } {
    this.#assertOpen();
    const row = this.#db.prepare(`SELECT
      (SELECT COUNT(*) FROM writer_tasks) tasks,
      (SELECT COUNT(*) FROM writer_leases) leases,
      (SELECT COUNT(*) FROM writer_leases WHERE state = 'active') active`).get() as { tasks: number; leases: number; active: number };
    return { database: this.path, schemaVersion: SCHEMA_VERSION, databaseBytes: statSync(this.path).size, ...row };
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

  #grant(input: { taskId: string; roomId: string; workspace: string; worktree: string; writer: WriterIdentity }): GrantedWriterLease {
    const now = this.#now();
    const token = randomUUID();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      let task = this.#task(input.taskId);
      if (task) {
        this.#assertTask(task);
        if (task.room_id !== input.roomId || task.workspace !== input.workspace || task.worktree !== input.worktree) throw new Error("WRITER_TASK_SCOPE_MISMATCH");
        if (task.applied_at_ms !== null) throw new Error("WRITER_TASK_ALREADY_APPLIED");
        if (task.apply_started_at_ms !== null) throw new Error("WRITER_TASK_APPLY_IN_PROGRESS");
        if (task.active_lease_id) throw new Error("WRITER_LEASE_ALREADY_ACTIVE");
      } else {
        const bare: Omit<TaskRow, "row_hash"> = {
          task_id: input.taskId, room_id: input.roomId, workspace: input.workspace,
          worktree: input.worktree, next_epoch: 1, active_lease_id: null,
          apply_started_at_ms: null, applied_at_ms: null, updated_at_ms: now,
        };
        task = { ...bare, row_hash: hashTask(bare) };
        this.#insertTask(task);
      }
      const lease = this.#newLease(task, input.writer, task.next_epoch, token, now);
      this.#insertLease(lease);
      const nextTask = this.#taskMutation(task, { next_epoch: task.next_epoch + 1, active_lease_id: lease.id, updated_at_ms: now });
      this.#replaceTask(task, nextTask);
      this.#event(task.task_id, lease.epoch, "writer-granted", now, lease.on_behalf_of);
      this.#db.exec("COMMIT");
      return { lease: this.#public(lease, nextTask), capabilityToken: token };
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  #newLease(task: TaskRow, writer: WriterIdentity, epoch: number, token: string, now: number): LeaseRow {
    const id = randomUUID();
    const companionId = writer.origin === "external" ? `writer-companion-${randomUUID()}` : null;
    const bare: Omit<LeaseRow, "row_hash"> = {
      id, task_id: task.task_id, epoch, state: "active", writer_origin: writer.origin,
      provider: writer.provider, actor_id: writer.actorId, display_name: writer.displayName,
      on_behalf_of: writer.displayName, executed_by: companionId ?? writer.actorId,
      companion_id: companionId, capability_hash: sha(token), granted_at_ms: now,
      revoked_at_ms: null, checkpoint: null,
    };
    return { ...bare, row_hash: hashLease(bare) };
  }

  #public(row: LeaseRow, task: TaskRow): WriterLease {
    return {
      id: row.id, taskId: row.task_id, roomId: task.room_id, workspace: task.workspace,
      worktree: task.worktree, epoch: row.epoch, state: row.state,
      writer: { origin: row.writer_origin, provider: row.provider, actorId: row.actor_id, displayName: row.display_name },
      onBehalfOf: row.on_behalf_of, executedBy: row.executed_by,
      ...(row.companion_id ? { companionId: row.companion_id } : {}),
      grantedAtMs: row.granted_at_ms,
      ...(row.revoked_at_ms === null ? {} : { revokedAtMs: row.revoked_at_ms }),
      ...(row.checkpoint ? { checkpoint: row.checkpoint } : {}),
    };
  }

  #migrate(): void {
    this.#db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE writer_tasks (
        task_id TEXT PRIMARY KEY, room_id TEXT NOT NULL, workspace TEXT NOT NULL,
        worktree TEXT NOT NULL, next_epoch INTEGER NOT NULL CHECK(next_epoch >= 1),
        active_lease_id TEXT, updated_at_ms INTEGER NOT NULL, row_hash TEXT NOT NULL
      ) STRICT;
      CREATE TABLE writer_leases (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES writer_tasks(task_id),
        epoch INTEGER NOT NULL CHECK(epoch >= 1), state TEXT NOT NULL CHECK(state IN ('active','revoked','completed')),
        writer_origin TEXT NOT NULL CHECK(writer_origin IN ('resident','managed','external')),
        provider TEXT NOT NULL CHECK(provider IN ('codex','claude','grok')),
        actor_id TEXT NOT NULL, display_name TEXT NOT NULL, on_behalf_of TEXT NOT NULL,
        executed_by TEXT NOT NULL, companion_id TEXT, capability_hash TEXT NOT NULL,
        granted_at_ms INTEGER NOT NULL, revoked_at_ms INTEGER, checkpoint TEXT, row_hash TEXT NOT NULL,
        UNIQUE(task_id, epoch)
      ) STRICT;
      CREATE UNIQUE INDEX writer_one_active_per_task ON writer_leases(task_id) WHERE state = 'active';
      CREATE TABLE writer_lease_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, epoch INTEGER NOT NULL,
        type TEXT NOT NULL, at_ms INTEGER NOT NULL, detail TEXT NOT NULL
      ) STRICT;
      PRAGMA user_version = 1; COMMIT;`);
  }

  #migrateV2(): void {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const columns = this.#db.prepare("PRAGMA table_info(writer_tasks)").all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === "applied_at_ms")) {
        this.#db.exec("ALTER TABLE writer_tasks ADD COLUMN applied_at_ms INTEGER");
      }
      const rows = this.#db.prepare("SELECT * FROM writer_tasks").all() as unknown as TaskRow[];
      const update = this.#db.prepare("UPDATE writer_tasks SET row_hash=? WHERE task_id=?");
      for (const row of rows) {
        const normalized = { ...row, applied_at_ms: row.applied_at_ms ?? null } as TaskRow;
        const { row_hash: _old, ...hashable } = normalized;
        update.run(hashTask(hashable), normalized.task_id);
      }
      this.#db.exec(`PRAGMA user_version=${SCHEMA_VERSION}; COMMIT`);
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  #migrateV3(): void {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const columns = this.#db.prepare("PRAGMA table_info(writer_tasks)").all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === "apply_started_at_ms")) {
        this.#db.exec("ALTER TABLE writer_tasks ADD COLUMN apply_started_at_ms INTEGER");
      }
      const rows = this.#db.prepare("SELECT * FROM writer_tasks").all() as unknown as TaskRow[];
      const update = this.#db.prepare("UPDATE writer_tasks SET row_hash=? WHERE task_id=?");
      for (const row of rows) {
        const normalized: TaskRow = { ...row, apply_started_at_ms: row.apply_started_at_ms ?? null };
        const { row_hash: _old, ...hashable } = normalized;
        update.run(hashTask(hashable), normalized.task_id);
      }
      this.#db.exec(`PRAGMA user_version=${SCHEMA_VERSION}; COMMIT`);
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  #migrateV4(): void {
    this.#db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS writer_task_runs (
        task_id TEXT PRIMARY KEY REFERENCES writer_tasks(task_id),
        run_id TEXT NOT NULL UNIQUE,
        owner_id TEXT NOT NULL,
        started_at_ms INTEGER NOT NULL,
        heartbeat_at_ms INTEGER NOT NULL
      ) STRICT;
      PRAGMA user_version=${SCHEMA_VERSION}; COMMIT;`);
  }

  #task(id: string): TaskRow | undefined {
    return this.#db.prepare("SELECT * FROM writer_tasks WHERE task_id = ?").get(id) as unknown as TaskRow | undefined;
  }

  #lease(id: string): LeaseRow | undefined {
    return this.#db.prepare("SELECT * FROM writer_leases WHERE id = ?").get(id) as unknown as LeaseRow | undefined;
  }

  #taskRun(taskId: string): { task_id: string; run_id: string; owner_id: string; started_at_ms: number; heartbeat_at_ms: number } | undefined {
    return this.#db.prepare("SELECT * FROM writer_task_runs WHERE task_id=?").get(taskId) as
      | { task_id: string; run_id: string; owner_id: string; started_at_ms: number; heartbeat_at_ms: number }
      | undefined;
  }

  #blockingTaskRun(taskId: string, now: number, staleAfterMs = 900_000): boolean {
    const run = this.#taskRun(taskId);
    if (!run) return false;
    if (run.heartbeat_at_ms > now - staleAfterMs) return true;
    this.#db.prepare("DELETE FROM writer_task_runs WHERE task_id=? AND run_id=?").run(taskId, run.run_id);
    this.#event(taskId, 0, "writer-run-stale-recovered", now, run.run_id);
    return false;
  }

  #insertTask(row: TaskRow): void {
    this.#db.prepare(`INSERT INTO writer_tasks
      (task_id,room_id,workspace,worktree,next_epoch,active_lease_id,updated_at_ms,row_hash,applied_at_ms,apply_started_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(row.task_id, row.room_id, row.workspace, row.worktree, row.next_epoch, row.active_lease_id,
        row.updated_at_ms, row.row_hash, row.applied_at_ms, row.apply_started_at_ms);
  }

  #insertLease(row: LeaseRow): void {
    this.#db.prepare("INSERT INTO writer_leases VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(row.id, row.task_id, row.epoch, row.state, row.writer_origin, row.provider, row.actor_id,
        row.display_name, row.on_behalf_of, row.executed_by, row.companion_id, row.capability_hash,
        row.granted_at_ms, row.revoked_at_ms, row.checkpoint, row.row_hash);
  }

  #taskMutation(row: TaskRow, fields: Partial<TaskRow>): TaskRow {
    const bare = { ...row, ...fields };
    const { row_hash: _old, ...hashable } = bare;
    return { ...hashable, row_hash: hashTask(hashable) };
  }

  #leaseMutation(row: LeaseRow, fields: Partial<LeaseRow>): LeaseRow {
    const bare = { ...row, ...fields };
    const { row_hash: _old, ...hashable } = bare;
    return { ...hashable, row_hash: hashLease(hashable) };
  }

  #replaceTask(previous: TaskRow, next: TaskRow): void {
    const result = this.#db.prepare(`UPDATE writer_tasks SET room_id=?,workspace=?,worktree=?,next_epoch=?,active_lease_id=?,apply_started_at_ms=?,applied_at_ms=?,updated_at_ms=?,row_hash=? WHERE task_id=? AND row_hash=?`)
      .run(next.room_id, next.workspace, next.worktree, next.next_epoch, next.active_lease_id, next.apply_started_at_ms, next.applied_at_ms,
        next.updated_at_ms, next.row_hash, next.task_id, previous.row_hash);
    if (Number(result.changes) !== 1) throw new Error("WRITER_TASK_CONCURRENT_UPDATE");
  }

  #replaceLease(previous: LeaseRow, next: LeaseRow): void {
    const result = this.#db.prepare(`UPDATE writer_leases SET state=?,revoked_at_ms=?,checkpoint=?,row_hash=? WHERE id=? AND row_hash=?`)
      .run(next.state, next.revoked_at_ms, next.checkpoint, next.row_hash, next.id, previous.row_hash);
    if (Number(result.changes) !== 1) throw new Error("WRITER_LEASE_CONCURRENT_UPDATE");
  }

  #event(taskId: string, epoch: number, type: string, at: number, detail: string): void {
    this.#db.prepare("INSERT INTO writer_lease_events (task_id,epoch,type,at_ms,detail) VALUES (?,?,?,?,?)")
      .run(taskId, epoch, type, at, detail);
  }

  #assertTask(row: TaskRow): void {
    const { row_hash: actual, ...hashable } = row;
    if (!HASH_PATTERN.test(actual) || hashTask(hashable) !== actual) throw new Error("WRITER_TASK_ROW_TAMPERED");
  }

  #assertLease(row: LeaseRow): void {
    const { row_hash: actual, ...hashable } = row;
    if (!HASH_PATTERN.test(actual) || hashLease(hashable) !== actual || !ID_PATTERN.test(row.id)) throw new Error("WRITER_LEASE_ROW_TAMPERED");
  }

  #verify(): void {
    const tasks = this.#db.prepare("SELECT * FROM writer_tasks").all() as unknown as TaskRow[];
    const leases = this.#db.prepare("SELECT * FROM writer_leases").all() as unknown as LeaseRow[];
    const byId = new Map(leases.map((lease) => [lease.id, lease]));
    const maxEpoch = new Map<string, number>();
    for (const lease of leases) {
      this.#assertLease(lease);
      maxEpoch.set(lease.task_id, Math.max(maxEpoch.get(lease.task_id) ?? 0, lease.epoch));
    }
    for (const task of tasks) {
      this.#assertTask(task);
      if (task.next_epoch <= (maxEpoch.get(task.task_id) ?? 0)) throw new Error("WRITER_TASK_EPOCH_TAMPERED");
      if (task.active_lease_id) {
        const active = byId.get(task.active_lease_id);
        if (!active || active.task_id !== task.task_id || active.state !== "active") throw new Error("WRITER_LEASE_TARGET_INVALID");
      }
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("WRITER_LEASE_STORE_CLOSED");
  }
}
