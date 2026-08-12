import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, rename } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { homedir } from "node:os";
import { applyBackApprovalScope, type ApprovalService } from "../security/approval.ts";
import { safeSummary } from "../security/redact.ts";
import type { WorkspacePolicy } from "../security/workspace-policy.ts";
import { WorkspaceToolBroker } from "../mcp/workspace-server.ts";
import type { RunEvents } from "./events.ts";
import { DirtySnapshotBroker, type DirtySnapshot } from "./dirty-snapshot-broker.ts";
import { GitBroker } from "./git-broker.ts";
import type { LocalStore } from "./store.ts";
import { recordTelemetryCounter } from "./telemetry.ts";
import { WorktreeBroker } from "./worktree-broker.ts";

const MAX_PENDING_APPLY_BACKS = 4;

interface ApplyBackChangeInternal {
  path: string;
  operation: "write" | "delete";
  bytes: number;
  sha256: string;
  expectedSourceSha256: string | null;
  expectedSourceContent?: string;
}

interface PendingApplyBack {
  preview: ApplyBackPreview;
  snapshot: DirtySnapshot;
  changes: ApplyBackChangeInternal[];
  expiresAt: number;
}

export interface ApplyBackPreview {
  id: string;
  runId: string;
  createdAt: string;
  expiresAt: string;
  sourceWorkspace: string;
  baseSha: string;
  sourceFingerprint: string;
  worktreeFingerprint: string;
  previewHash: string;
  files: number;
  writes: number;
  deletes: number;
  totalBytes: number;
  changes: Array<{ path: string; operation: "write" | "delete"; bytes: number }>;
  risk: {
    level: "low" | "medium" | "high";
    reasons: string[];
  };
}

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function digestPreview(input: Omit<ApplyBackPreview, "previewHash" | "expiresAt" | "changes" | "risk"> & {
  changes: ApplyBackChangeInternal[];
}): string {
  return createHash("sha256").update(JSON.stringify(input), "utf8").digest("hex");
}

/**
 * Short-lived, RAM-only apply-back transaction.
 *
 * It never merges, commits, pushes, or deletes permanently. Deletions are moved
 * into an owner-only trash-pending session. Every source and worktree state is
 * revalidated after preview and immediately before the scoped approval is consumed.
 */
export class ApplyBackService {
  readonly #store: LocalStore;
  readonly #approvals: ApprovalService;
  readonly #events: RunEvents;
  readonly #workspaces: WorkspacePolicy;
  readonly #worktrees: WorktreeBroker;
  readonly #snapshotBroker: DirtySnapshotBroker;
  readonly #git = new GitBroker();
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #trashRoot: string;
  readonly #pending = new Map<string, PendingApplyBack>();
  #preparing = 0;

  constructor(input: {
    store: LocalStore;
    approvals: ApprovalService;
    events: RunEvents;
    workspaces: WorkspacePolicy;
    maxFiles: number;
    now?: () => number;
    ttlMs?: number;
    trashRoot?: string;
  }) {
    this.#store = input.store;
    this.#approvals = input.approvals;
    this.#events = input.events;
    this.#workspaces = input.workspaces;
    this.#worktrees = new WorktreeBroker(input.store.dataDirectory);
    this.#snapshotBroker = new DirtySnapshotBroker({ maxFiles: input.maxFiles });
    this.#now = input.now ?? Date.now;
    this.#ttlMs = input.ttlMs ?? 120_000;
    if (!Number.isSafeInteger(this.#ttlMs) || this.#ttlMs < 10_000 || this.#ttlMs > 600_000) {
      throw new Error("APPLY_BACK_TTL_INVALID");
    }
    this.#trashRoot = input.trashRoot ?? join(homedir(), "trash-pending", "orchestratory");
    if (!isAbsolute(this.#trashRoot)) throw new Error("APPLY_BACK_TRASH_ROOT_INVALID");
  }

  /**
   * Register the immutable source baseline as soon as a Room Writer worktree is
   * created. This closes the gap where a late baseline could silently accept
   * source edits made while the Agent was working.
   */
  async beginRetained(input: {
    runId: string;
    roomId: string;
    taskId: string;
    workspace: string;
    worktree: string;
  }): Promise<void> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(input.runId)) {
      throw new Error("APPLY_BACK_RUN_ID_INVALID");
    }
    const retained = await this.#worktrees.inspectRetained(input.runId);
    if (retained.workspace !== await realpath(input.worktree)
      || retained.sourceWorkspace !== await realpath(input.workspace)) {
      throw new Error("APPLY_BACK_RETAINED_SCOPE_MISMATCH");
    }
    await this.#workspaces.assertAllowed(retained.sourceWorkspace);
    const existing = this.#store.getRun(input.runId);
    if (existing) {
      const baseline = this.#store.listEvents(input.runId, 0, 500)
        .some((event) => event.type === "workspace.source-baseline");
      if (!baseline || (existing.status !== "created" && existing.status !== "completed")) {
        throw new Error("APPLY_BACK_RETAINED_RUN_CONFLICT");
      }
      return;
    }
    const source = await this.#git.inspect(retained.sourceWorkspace);
    const headSha = await this.#git.headSha(retained.sourceWorkspace);
    if (retained.headSha !== headSha) throw new Error("APPLY_BACK_SOURCE_HEAD_CHANGED");
    const now = new Date(this.#now()).toISOString();
    this.#store.saveRun({
      id: input.runId,
      createdAt: now,
      updatedAt: now,
      status: "created",
      workspaceLabel: basename(retained.sourceWorkspace),
      profile: "room-writer",
      counters: {
        rounds: 0,
        providerCalls: 0,
        subprocesses: 0,
        consecutiveErrors: 0,
        outputBytes: 0,
        apiBudgetUsd: 0,
      },
    });
    this.#events.emit({
      runId: input.runId,
      type: "workspace.source-baseline",
      actor: "git",
      status: "info",
      summary: "Room Writer source baseline recorded without file contents.",
      metadata: {
        fingerprint: source.fingerprint,
        headSha,
        dirtySnapshot: !source.clean,
        roomId: input.roomId,
        taskId: input.taskId,
      },
    });
    this.#events.emit({
      runId: input.runId,
      type: "room-writer.worktree-created",
      actor: "system",
      status: "info",
      summary: "Room Writer isolated worktree registered for owner-reviewed apply-back.",
      metadata: { roomId: input.roomId, taskId: input.taskId },
    });
  }

  async completeRetained(runId: string): Promise<ApplyBackPreview> {
    const run = this.#store.getRun(runId);
    if (!run) throw new Error("APPLY_BACK_RUN_NOT_FOUND");
    if (run.profile !== "room-writer") throw new Error("APPLY_BACK_RUN_KIND_MISMATCH");
    if (run.status !== "created" && run.status !== "completed") {
      throw new Error("APPLY_BACK_RUN_NOT_COMPLETABLE");
    }
    if (run.status !== "completed") {
      this.#store.saveRun({ ...run, status: "completed", updatedAt: new Date(this.#now()).toISOString() });
      this.#events.emit({
        runId,
        type: "room-writer.worktree-completed",
        actor: "system",
        status: "success",
        summary: "Room Writer worktree is ready for owner risk review; no source files were changed.",
      });
    }
    return await this.prepare(runId);
  }

  async failRetained(runId: string, reason: string): Promise<void> {
    const run = this.#store.getRun(runId);
    if (!run || run.profile !== "room-writer" || run.status !== "created") return;
    this.#store.saveRun({
      ...run,
      status: "failed",
      updatedAt: new Date(this.#now()).toISOString(),
      errorCode: safeSummary(reason, 120),
    });
    this.#events.emit({
      runId,
      type: "room-writer.worktree-registration-failed",
      actor: "system",
      status: "error",
      summary: safeSummary(reason, 240),
    });
  }

  async prepare(runId: string): Promise<ApplyBackPreview> {
    this.#discardExpired();
    if (this.#pending.size + this.#preparing >= MAX_PENDING_APPLY_BACKS) {
      throw new Error("APPLY_BACK_PENDING_LIMIT_REACHED");
    }
    this.#preparing += 1;
    try {
      const run = this.#store.getRun(runId);
      if (!run || run.status !== "completed") throw new Error("APPLY_BACK_RUN_NOT_COMPLETED");
      const retained = await this.#worktrees.inspectRetained(runId);
      await this.#workspaces.assertAllowed(retained.sourceWorkspace);
      const baselineEvent = this.#store.listEvents(runId, 0, 500)
        .filter((event) => event.type === "workspace.source-baseline")
        .at(-1);
      const sourceFingerprint = baselineEvent?.metadata?.fingerprint;
      const baseSha = baselineEvent?.metadata?.headSha;
      if (
        typeof sourceFingerprint !== "string" || !/^[0-9a-f]{64}$/u.test(sourceFingerprint) ||
        typeof baseSha !== "string" || !/^[0-9a-f]{40,64}$/u.test(baseSha)
      ) throw new Error("APPLY_BACK_BASELINE_MISSING");
      if (retained.headSha !== baseSha) throw new Error("APPLY_BACK_WORKTREE_HEAD_CHANGED");
      if (await this.#git.headSha(retained.sourceWorkspace) !== baseSha) {
        throw new Error("APPLY_BACK_SOURCE_HEAD_CHANGED");
      }
      const source = await this.#git.inspect(retained.sourceWorkspace);
      if (source.fingerprint !== sourceFingerprint) throw new Error("APPLY_BACK_SOURCE_CHANGED");
      const snapshot = await this.#snapshotBroker.capture(retained.workspace, { allowClean: true });
      if (snapshot.baseSha !== baseSha) throw new Error("APPLY_BACK_WORKTREE_BASE_MISMATCH");
      const reader = await WorkspaceToolBroker.create(retained.sourceWorkspace, "read-only");
      const changes: ApplyBackChangeInternal[] = [];
      for (const file of snapshot.files) {
        const sourceState = await this.#readState(reader, file.path);
        changes.push({
          path: file.path,
          operation: file.operation,
          bytes: file.bytes,
          sha256: file.sha256,
          expectedSourceSha256: sourceState?.sha256 ?? null,
          ...(sourceState ? { expectedSourceContent: sourceState.content } : {}),
        });
      }
      const id = randomUUID();
      const createdAt = new Date(this.#now()).toISOString();
      const expiresAtMs = this.#now() + this.#ttlMs;
      const unsigned = {
        id,
        runId,
        createdAt,
        sourceWorkspace: retained.sourceWorkspace,
        baseSha,
        sourceFingerprint,
        worktreeFingerprint: snapshot.sourceFingerprint,
        files: changes.length,
        writes: changes.filter((change) => change.operation === "write").length,
        deletes: changes.filter((change) => change.operation === "delete").length,
        totalBytes: snapshot.totalBytes,
        changes,
      };
      const previewHash = digestPreview(unsigned);
      const preview: ApplyBackPreview = {
        ...unsigned,
        expiresAt: new Date(expiresAtMs).toISOString(),
        previewHash,
        changes: changes.map(({ path, operation, bytes }) => ({ path, operation, bytes })),
        risk: this.#risk(changes),
      };
      this.#pending.set(id, { preview, snapshot, changes, expiresAt: expiresAtMs });
      return structuredClone(preview);
    } finally {
      this.#preparing -= 1;
    }
  }

  get(id: string): ApplyBackPreview {
    this.#discardExpired();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(id)) {
      throw new Error("APPLY_BACK_ID_INVALID");
    }
    const pending = this.#pending.get(id);
    if (!pending) throw new Error("APPLY_BACK_NOT_FOUND_OR_EXPIRED");
    return structuredClone(pending.preview);
  }

  issueApproval(id: string, actor: "local-tui" | "local-web"): { token: string; expiresAt: string } {
    const preview = this.get(id);
    return this.#approvals.issue("apply-back", applyBackApprovalScope(preview), actor);
  }

  async apply(id: string, approvalToken: string | undefined): Promise<{
    writes: number;
    deletesMovedToTrash: number;
    trashSession?: string;
  }> {
    const preview = this.get(id);
    const pending = this.#pending.get(id);
    if (!pending) throw new Error("APPLY_BACK_NOT_FOUND_OR_EXPIRED");
    const retained = await this.#worktrees.inspectRetained(preview.runId);
    await this.#workspaces.assertAllowed(retained.sourceWorkspace);
    if (
      retained.sourceWorkspace !== preview.sourceWorkspace || retained.headSha !== preview.baseSha ||
      await this.#git.headSha(preview.sourceWorkspace) !== preview.baseSha
    ) throw new Error("APPLY_BACK_STATE_CHANGED");
    const source = await this.#git.inspect(preview.sourceWorkspace);
    const worktree = await this.#git.inspect(retained.workspace);
    if (
      source.fingerprint !== preview.sourceFingerprint ||
      worktree.fingerprint !== preview.worktreeFingerprint
    ) throw new Error("APPLY_BACK_STATE_CHANGED");
    const expectedHash = digestPreview({
      id: preview.id,
      runId: preview.runId,
      createdAt: preview.createdAt,
      sourceWorkspace: preview.sourceWorkspace,
      baseSha: preview.baseSha,
      sourceFingerprint: preview.sourceFingerprint,
      worktreeFingerprint: preview.worktreeFingerprint,
      files: preview.files,
      writes: preview.writes,
      deletes: preview.deletes,
      totalBytes: preview.totalBytes,
      changes: pending.changes,
    });
    if (expectedHash !== preview.previewHash) throw new Error("APPLY_BACK_PREVIEW_TAMPERED");
    const reader = await WorkspaceToolBroker.create(preview.sourceWorkspace, "read-only");
    for (const change of pending.changes) {
      if ((await this.#readState(reader, change.path))?.sha256 !== (change.expectedSourceSha256 ?? undefined)) {
        throw new Error("APPLY_BACK_SOURCE_FILE_CHANGED");
      }
    }
    const finalSourceCheck = await this.#git.inspect(preview.sourceWorkspace);
    if (
      finalSourceCheck.fingerprint !== preview.sourceFingerprint ||
      await this.#git.headSha(preview.sourceWorkspace) !== preview.baseSha
    ) throw new Error("APPLY_BACK_STATE_CHANGED");
    this.#approvals.consume(
      "apply-back",
      applyBackApprovalScope(preview),
      approvalToken,
      preview.runId,
    );
    this.#pending.delete(id);

    let trashSession: string | undefined;
    let writes = 0;
    let deletesMovedToTrash = 0;
    const appliedWrites: ApplyBackChangeInternal[] = [];
    const movedDeletes: ApplyBackChangeInternal[] = [];
    try {
      if (pending.changes.some((change) => change.operation === "delete" && change.expectedSourceSha256)) {
        trashSession = await this.#createTrashSession(preview);
      }
      const writer = await WorkspaceToolBroker.create(preview.sourceWorkspace, "write", { authorizeWrite: () => {} });
      for (const change of pending.changes.filter((item) => item.operation === "write")) {
        const file = pending.snapshot.files.find((item) => item.path === change.path);
        if (!file || file.path !== change.path || file.operation !== change.operation) {
          throw new Error("APPLY_BACK_CHANGE_ORDER_MISMATCH");
        }
        if (change.expectedSourceSha256 === change.sha256) continue;
        if (typeof file.content !== "string") throw new Error("APPLY_BACK_CONTENT_MISSING");
        await this.#ensureParent(preview.sourceWorkspace, change.path, writer);
        await writer.call("write_file", {
          path: change.path,
          content: file.content,
          expectedSha256: change.expectedSourceSha256,
        });
        writes += 1;
        appliedWrites.push(change);
      }
      for (const change of pending.changes.filter((item) => item.operation === "delete")) {
        if (change.expectedSourceSha256 && trashSession) {
          await this.#moveToTrash(
            preview.sourceWorkspace,
            trashSession,
            change,
            change.expectedSourceSha256,
          );
          deletesMovedToTrash += 1;
          movedDeletes.push(change);
        }
      }
      this.#events.emit({
        runId: preview.runId,
        type: "worktree.apply-back-completed",
        actor: "human",
        status: "success",
        summary: "Approved worktree changes were applied back; deletions were moved to trash-pending.",
        metadata: { writes, deletesMovedToTrash, previewHash: preview.previewHash },
      });
      // Coarse count only, and only into today's local rollup. It is deliberately not
      // awaited into the result and cannot throw: an apply-back that reached this line has
      // succeeded, and telemetry bookkeeping must not be able to change that.
      void recordTelemetryCounter("apply-back", this.#store.dataDirectory);
      return { writes, deletesMovedToTrash, ...(trashSession ? { trashSession } : {}) };
    } catch (error) {
      const rollbackFailed = !await this.#rollback(
        preview,
        pending,
        appliedWrites,
        movedDeletes,
        trashSession,
      );
      this.#events.emit({
        runId: preview.runId,
        type: "worktree.apply-back-failed",
        actor: "system",
        status: "error",
        summary: rollbackFailed
          ? "APPLY_BACK_PARTIAL_ROLLBACK_FAILED"
          : (error instanceof Error ? error.message : "APPLY_BACK_FAILED"),
        metadata: { writes, deletesMovedToTrash, rollbackFailed, previewHash: preview.previewHash },
      });
      if (rollbackFailed) throw new Error("APPLY_BACK_PARTIAL_ROLLBACK_FAILED");
      throw error;
    }
  }

  status(): { pending: number; maxPending: number; ttlMs: number } {
    this.#discardExpired();
    return {
      pending: this.#pending.size + this.#preparing,
      maxPending: MAX_PENDING_APPLY_BACKS,
      ttlMs: this.#ttlMs,
    };
  }

  clear(): void {
    this.#pending.clear();
  }

  #risk(changes: ApplyBackChangeInternal[]): ApplyBackPreview["risk"] {
    const deletes = changes.filter((change) => change.operation === "delete").length;
    const overwrites = changes.filter((change) =>
      change.operation === "write" && change.expectedSourceSha256 !== null).length;
    const additions = changes.filter((change) =>
      change.operation === "write" && change.expectedSourceSha256 === null).length;
    const reasons: string[] = [];
    if (deletes > 0) reasons.push(`${deletes} 個既有檔案將移至 trash-pending（可復原）`);
    if (overwrites > 0) reasons.push(`${overwrites} 個既有檔案內容將被覆寫`);
    if (additions > 0) reasons.push(`${additions} 個新檔案將加入專案`);
    if (reasons.length === 0) reasons.push("沒有實際檔案變更");
    return {
      level: deletes > 0 ? "high" : overwrites > 0 ? "medium" : "low",
      reasons,
    };
  }

  async #readState(
    broker: WorkspaceToolBroker,
    path: string,
  ): Promise<{ sha256: string; content: string } | undefined> {
    try {
      const value = JSON.parse(await broker.call("read_file", { path })) as {
        sha256?: unknown;
        content?: unknown;
      };
      if (typeof value.sha256 !== "string" || typeof value.content !== "string") {
        throw new Error("APPLY_BACK_SOURCE_HASH_INVALID");
      }
      return { sha256: value.sha256, content: value.content };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || /ENOENT/u.test(String(error))) return undefined;
      throw error;
    }
  }

  async #ensureParent(root: string, path: string, writer: WorkspaceToolBroker): Promise<void> {
    const parts = dirname(path).split("/").filter((part) => part && part !== ".");
    let current = root;
    const relativeParts: string[] = [];
    for (const part of parts) {
      relativeParts.push(part);
      const candidate = join(current, part);
      try {
        const info = await lstat(candidate);
        if (info.isSymbolicLink()) throw new Error("APPLY_BACK_SYMLINK_DENIED");
        if (!info.isDirectory()) throw new Error("APPLY_BACK_PARENT_NOT_DIRECTORY");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await writer.call("create_directory", { path: relativeParts.join("/") });
      }
      const canonical = await realpath(candidate);
      if (!inside(root, canonical)) throw new Error("APPLY_BACK_PATH_ESCAPE_DENIED");
      current = canonical;
    }
  }

  async #createTrashSession(preview: ApplyBackPreview): Promise<string> {
    await mkdir(this.#trashRoot, { recursive: true, mode: 0o700 });
    const info = await lstat(this.#trashRoot);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("APPLY_BACK_TRASH_ROOT_UNSAFE");
    await chmod(this.#trashRoot, 0o700);
    const canonicalRoot = await realpath(this.#trashRoot);
    const session = join(canonicalRoot, `${preview.runId}-${preview.id}`);
    await mkdir(session, { recursive: false, mode: 0o700 });
    await chmod(session, 0o700);
    return session;
  }

  async #moveToTrash(
    root: string,
    trashSession: string,
    change: ApplyBackChangeInternal,
    expectedSha256: string,
  ): Promise<void> {
    const source = join(root, change.path);
    const info = await lstat(source);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error("APPLY_BACK_DELETE_TARGET_UNSAFE");
    if (info.nlink > 1) throw new Error("APPLY_BACK_HARDLINK_DENIED");
    const current = await readFile(source);
    if (createHash("sha256").update(current).digest("hex") !== expectedSha256) {
      throw new Error("APPLY_BACK_SOURCE_FILE_CHANGED");
    }
    const destination = join(trashSession, change.path);
    if (!inside(trashSession, destination)) throw new Error("APPLY_BACK_TRASH_ESCAPE_DENIED");
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await rename(source, destination);
  }

  async #rollback(
    preview: ApplyBackPreview,
    pending: PendingApplyBack,
    appliedWrites: ApplyBackChangeInternal[],
    movedDeletes: ApplyBackChangeInternal[],
    initialTrashSession: string | undefined,
  ): Promise<boolean> {
    let trashSession = initialTrashSession;
    try {
      for (const change of [...movedDeletes].reverse()) {
        if (!trashSession) return false;
        const trashed = join(trashSession, change.path);
        const source = join(preview.sourceWorkspace, change.path);
        try {
          await lstat(source);
          return false;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        await mkdir(dirname(source), { recursive: true, mode: 0o700 });
        await rename(trashed, source);
      }
      const writer = await WorkspaceToolBroker.create(preview.sourceWorkspace, "write", { authorizeWrite: () => {} });
      for (const change of [...appliedWrites].reverse()) {
        if (change.expectedSourceContent !== undefined) {
          await writer.call("write_file", {
            path: change.path,
            content: change.expectedSourceContent,
            expectedSha256: change.sha256,
          });
          continue;
        }
        if (!trashSession) trashSession = await this.#createTrashSession(preview);
        await this.#moveToTrash(preview.sourceWorkspace, trashSession, change, change.sha256);
      }
      const restored = await this.#git.inspect(preview.sourceWorkspace);
      return restored.fingerprint === preview.sourceFingerprint &&
        await this.#git.headSha(preview.sourceWorkspace) === preview.baseSha;
    } catch {
      return false;
    } finally {
      // Keep content reachable only for the duration of this bounded rollback.
      for (const change of pending.changes) delete change.expectedSourceContent;
    }
  }

  #discardExpired(): void {
    const now = this.#now();
    for (const [id, pending] of this.#pending) {
      if (now > pending.expiresAt) this.#pending.delete(id);
    }
  }
}
