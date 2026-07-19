import { createHash, randomBytes } from "node:crypto";
import type { WorkflowRequest } from "../types.ts";
import type { PurgePreview } from "../core/store.ts";
import type { DirtySnapshot } from "../core/dirty-snapshot-broker.ts";

export type ApprovalAction =
  | "create-worktree"
  | "import-dirty-snapshot"
  | "apply-back"
  | "use-api"
  | "run-test"
  | "purge-data"
  | "restore-checkpoint"
  | "cleanup-worktree"
export type ApprovalActor = "local-tui" | "local-web";

interface PendingApproval {
  action: ApprovalAction;
  scope: string;
  actor: ApprovalActor;
  issuedAt: number;
  expiresAt: number;
}

export interface ConsumedApproval extends PendingApproval {
  runId: string;
  consumedAt: number;
}

const ACTIONS = new Set<ApprovalAction>([
  "create-worktree",
  "import-dirty-snapshot",
  "apply-back",
  "use-api",
  "run-test",
  "purge-data",
  "restore-checkpoint",
  "cleanup-worktree",
]);
const ACTORS = new Set<ApprovalActor>(["local-tui", "local-web"]);

function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export class ApprovalService {
  readonly #pending = new Map<string, PendingApproval>();
  readonly #now: () => number;
  readonly #ttlMs: number;

  constructor(input: { now?: () => number; ttlMs?: number } = {}) {
    this.#now = input.now ?? Date.now;
    this.#ttlMs = input.ttlMs ?? 120_000;
    if (!Number.isSafeInteger(this.#ttlMs) || this.#ttlMs < 10 || this.#ttlMs > 600_000) {
      throw new Error("APPROVAL_TTL_INVALID");
    }
  }

  issue(action: ApprovalAction, scope: string, actor: ApprovalActor): {
    token: string;
    expiresAt: string;
  } {
    if (!ACTIONS.has(action)) throw new Error("APPROVAL_ACTION_INVALID");
    if (!ACTORS.has(actor)) throw new Error("APPROVAL_ACTOR_INVALID");
    if (scope.length < 1 || scope.length > 256 || scope.includes("\0")) {
      throw new Error("APPROVAL_SCOPE_INVALID");
    }
    this.#discardExpired();
    const issuedAt = this.#now();
    const token = randomBytes(32).toString("base64url");
    this.#pending.set(tokenHash(token), {
      action,
      scope,
      actor,
      issuedAt,
      expiresAt: issuedAt + this.#ttlMs,
    });
    return { token, expiresAt: new Date(issuedAt + this.#ttlMs).toISOString() };
  }

  consume(
    action: ApprovalAction,
    scope: string,
    token: string | undefined,
    runId: string,
  ): ConsumedApproval {
    if (!ACTIONS.has(action)) throw new Error("APPROVAL_ACTION_INVALID");
    if (!token || !/^[A-Za-z0-9_-]{43}$/u.test(token)) throw new Error("APPROVAL_TOKEN_INVALID");
    if (!/^[0-9a-f-]{3,64}$/u.test(runId)) throw new Error("APPROVAL_RUN_ID_INVALID");
    const key = tokenHash(token);
    const approval = this.#pending.get(key);
    if (!approval) throw new Error("APPROVAL_INVALID_OR_REPLAYED");
    const consumedAt = this.#now();
    if (consumedAt > approval.expiresAt) {
      this.#pending.delete(key);
      throw new Error("APPROVAL_EXPIRED");
    }
    if (approval.action !== action || approval.scope !== scope) {
      throw new Error("APPROVAL_SCOPE_MISMATCH");
    }
    this.#pending.delete(key);
    return { ...approval, runId, consumedAt };
  }

  #discardExpired(): void {
    const now = this.#now();
    for (const [key, approval] of this.#pending) {
      if (now > approval.expiresAt) this.#pending.delete(key);
    }
  }
}

export function workflowApprovalScope(
  request: WorkflowRequest,
  action: Extract<ApprovalAction, "create-worktree" | "use-api" | "run-test">,
): string {
  const value =
    action === "create-worktree"
      ? {
          action,
          workspace: request.workspace,
          workspaceMode: request.workspaceMode,
          dirtySnapshotConfirmed: Boolean(request.dirtySnapshotConfirmed),
          dirtySnapshotId: request.dirtySnapshotId,
        }
      : action === "use-api"
        ? {
          action,
          workspace: request.workspace,
          task: request.task,
          profile: request.profile,
          softLimits: request.softLimits,
          apiMaxCostUsdPerCall: request.apiMaxCostUsdPerCall,
          apiBudgetUsdPerRun: request.apiBudgetUsdPerRun,
          agents: [request.planner, request.writer, ...request.reviewers, request.tester]
            .filter((agent) => agent?.authMode === "api")
            .map((agent) => ({
              role: agent?.role,
              provider: agent?.provider,
              model: agent?.model,
            })),
          }
        : {
            action,
            workspace: request.workspace,
            task: request.task,
            profile: request.profile,
            softLimits: request.softLimits,
            testProfileId: request.testProfileId,
          };
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

export function checkpointApprovalScope(
  request: WorkflowRequest,
  runId: string,
  checkpointId: string,
): string {
  const value = {
    action: "restore-checkpoint",
    runId,
    checkpointId,
    workspace: request.workspace,
    task: request.task,
    profile: request.profile,
    softLimits: request.softLimits,
    agents: [request.planner, request.writer, ...request.reviewers],
    testProfileId: request.testProfileId,
  };
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

export function dirtySnapshotApprovalScope(
  request: WorkflowRequest,
  snapshot: DirtySnapshot,
): string {
  const value = {
    action: "import-dirty-snapshot",
    workspace: request.workspace,
    workspaceMode: request.workspaceMode,
    task: request.task,
    acceptanceCriteria: request.acceptanceCriteria,
    profile: request.profile,
    softLimits: request.softLimits,
    agents: [
      request.planner,
      request.writer,
      request.fallbackWriter,
      ...request.reviewers,
      request.tester,
    ].filter(Boolean),
    testProfileId: request.testProfileId,
    snapshot: {
      id: snapshot.id,
      sourceWorkspace: snapshot.sourceWorkspace,
      baseSha: snapshot.baseSha,
      sourceFingerprint: snapshot.sourceFingerprint,
      snapshotHash: snapshot.snapshotHash,
      files: snapshot.files.length,
      totalBytes: snapshot.totalBytes,
    },
  };
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

export function applyBackApprovalScope(preview: {
  id: string;
  runId: string;
  sourceWorkspace: string;
  baseSha: string;
  sourceFingerprint: string;
  worktreeFingerprint: string;
  previewHash: string;
  files: number;
  writes: number;
  deletes: number;
  totalBytes: number;
}): string {
  return createHash("sha256")
    .update(JSON.stringify({ action: "apply-back", ...preview }), "utf8")
    .digest("hex");
}

export function dataPurgeApprovalScope(preview: PurgePreview): string {
  const value = {
    action: "purge-data",
    previewId: preview.id,
    createdAt: preview.createdAt,
    candidates: preview.candidates,
    protectedRunIds: preview.protectedRunIds,
    policy: preview.policy,
  };
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

export function worktreeCleanupApprovalScope(preview: {
  runId: string;
  workspace: string;
  sourceWorkspace: string;
  branch: string;
  headSha: string;
}): string {
  return createHash("sha256")
    .update(JSON.stringify({ action: "cleanup-worktree", ...preview }), "utf8")
    .digest("hex");
}
