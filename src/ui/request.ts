import { PROFILES } from "../config.ts";
import type { AgentAssignment, ProviderId, SoftLimits, WorkflowRequest } from "../types.ts";
import type { ProviderRegistry } from "../providers/registry.ts";
import { isSelectableProvider } from "../providers/selection.ts";

function text(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || value.trim().length < 1 || value.length > max) {
    throw new Error(`INVALID_${name.toUpperCase()}`);
  }
  if (value.includes("\0")) throw new Error(`INVALID_${name.toUpperCase()}_NULL`);
  return value.trim();
}

function approvalToken(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(value)) {
    throw new Error(`INVALID_${name.toUpperCase()}_APPROVAL`);
  }
  return value;
}

function assignment(
  input: unknown,
  role: AgentAssignment["role"],
  providers: ProviderRegistry,
): AgentAssignment {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error(`INVALID_${role.toUpperCase()}_ASSIGNMENT`);
  }
  const value = input as Record<string, unknown>;
  const candidate = text(value.provider, "provider", 32);
  if (!isSelectableProvider("workflowAgent", candidate)) throw new Error("UNKNOWN_PROVIDER");
  const provider: ProviderId = candidate;
  const authMode = value.authMode === "api" ? "api" : "subscription";
  const capabilities = providers.get(provider).capabilities;
  if (authMode === "api" && !capabilities.api) throw new Error("API_MODE_NOT_AVAILABLE");
  // Two independent writer gates on purpose. The selection table states which
  // providers may ever be offered the writer role; `canWrite` then re-checks the
  // registered adapter. Both must agree, and both report the same stable code.
  if (role === "writer" && !isSelectableProvider("workflowWriter", provider)) {
    throw new Error("WRITER_PROVIDER_IS_READ_ONLY");
  }
  if (role === "writer" && !providers.canWrite(provider, authMode)) {
    throw new Error("WRITER_PROVIDER_IS_READ_ONLY");
  }
  const model = text(value.model, "model", 128);
  if (model !== "default" && !/^[A-Za-z0-9._:/-]{1,128}$/u.test(model)) {
    throw new Error("INVALID_MODEL_ID");
  }
  return { role, provider, model, authMode };
}

function customSoftLimits(input: unknown): SoftLimits {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("INVALID_SOFT_LIMITS");
  }
  const value = input as Record<string, unknown>;
  const keys: Array<keyof SoftLimits> = [
    "maxRounds",
    "maxProviderCalls",
    "workflowTimeoutMs",
    "providerTimeoutMs",
  ];
  if (Object.keys(value).some((key) => !keys.includes(key as keyof SoftLimits))) {
    throw new Error("UNKNOWN_SOFT_LIMIT_KEY");
  }
  const output = {} as SoftLimits;
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate < 1) {
      throw new Error(`INVALID_SOFT_LIMIT:${key}`);
    }
    output[key] = candidate;
  }
  return output;
}

export function parseWorkflowRequest(input: unknown, providers: ProviderRegistry): WorkflowRequest {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("INVALID_WORKFLOW_REQUEST");
  }
  const value = input as Record<string, unknown>;
  const profile = value.profile === "long" ? "long" : value.profile === "custom" ? "custom" : "normal";
  const workspaceMode = value.workspaceMode === "in-place" ? "in-place" : "worktree";
  if (!Array.isArray(value.reviewers) || value.reviewers.length < 1 || value.reviewers.length > 4) {
    throw new Error("INVALID_REVIEWERS");
  }
  const planner = assignment(value.planner, "planner", providers);
  const writer = assignment(value.writer, "writer", providers);
  const reviewers = value.reviewers.map((item) => assignment(item, "reviewer", providers));
  const fallbackWriter = value.fallbackWriter === undefined
    ? undefined
    : assignment(value.fallbackWriter, "writer", providers);
  const hasApi = [planner, writer, ...reviewers].some((item) => item.authMode === "api");
  const worktreeApproval = approvalToken(value.worktreeApproval, "worktree");
  const dirtySnapshotApproval = approvalToken(value.dirtySnapshotApproval, "dirty_snapshot");
  const dirtySnapshotConfirmed = value.dirtySnapshotConfirmed === true;
  const dirtySnapshotId = value.dirtySnapshotId === undefined
    ? undefined
    : text(value.dirtySnapshotId, "dirty_snapshot_id", 36);
  if (
    dirtySnapshotId &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(dirtySnapshotId)
  ) {
    throw new Error("INVALID_DIRTY_SNAPSHOT_ID");
  }
  const dirtySnapshotFields = [dirtySnapshotId, dirtySnapshotApproval].filter(Boolean).length;
  if (dirtySnapshotFields !== 0 && dirtySnapshotFields !== 2) {
    throw new Error("INCOMPLETE_DIRTY_SNAPSHOT_APPROVAL");
  }
  if (dirtySnapshotConfirmed && workspaceMode !== "worktree") {
    throw new Error("DIRTY_SNAPSHOT_REQUIRES_WORKTREE");
  }
  if (!dirtySnapshotConfirmed && dirtySnapshotFields !== 0) {
    throw new Error("UNEXPECTED_DIRTY_SNAPSHOT_CONFIGURATION");
  }
  const apiApproval = approvalToken(value.apiApproval, "api");
  const testProfileId =
    value.testProfileId === undefined
      ? undefined
      : text(value.testProfileId, "test_profile_id", 64);
  if (testProfileId && !/^[a-z][a-z0-9-]{0,63}$/u.test(testProfileId)) {
    throw new Error("INVALID_TEST_PROFILE_ID");
  }
  const testApproval = approvalToken(value.testApproval, "test");
  const restoreRunId =
    value.restoreRunId === undefined ? undefined : text(value.restoreRunId, "restore_run_id", 36);
  const restoreCheckpointId =
    value.restoreCheckpointId === undefined
      ? undefined
      : text(value.restoreCheckpointId, "restore_checkpoint_id", 36);
  const restoreApproval = approvalToken(value.restoreApproval, "restore");
  const restoreIds = [restoreRunId, restoreCheckpointId].filter(Boolean).length;
  if (restoreIds !== 0 && restoreIds !== 2) throw new Error("INCOMPLETE_CHECKPOINT_RESTORE");
  if (restoreApproval && restoreIds !== 2) throw new Error("INCOMPLETE_CHECKPOINT_RESTORE");
  if (
    (restoreRunId && !/^[0-9a-f-]{36}$/u.test(restoreRunId)) ||
    (restoreCheckpointId && !/^[0-9a-f-]{36}$/u.test(restoreCheckpointId))
  ) {
    throw new Error("INVALID_CHECKPOINT_RESTORE_ID");
  }
  if (restoreRunId && workspaceMode !== "in-place") {
    throw new Error("CHECKPOINT_RESTORE_REQUIRES_IN_PLACE_WORKSPACE");
  }
  if (workspaceMode !== "worktree" && worktreeApproval) throw new Error("UNEXPECTED_WORKTREE_APPROVAL");
  if (!hasApi && apiApproval) throw new Error("UNEXPECTED_API_APPROVAL");
  if (!testProfileId && testApproval) throw new Error("UNEXPECTED_TEST_APPROVAL");
  if (!testProfileId && value.testConfirmed === true) {
    throw new Error("UNEXPECTED_TEST_CONFIRMATION");
  }
  const apiMaxCostUsdPerCall = hasApi ? Number(value.apiMaxCostUsdPerCall) : 0;
  const apiBudgetUsdPerRun = hasApi ? Number(value.apiBudgetUsdPerRun) : 0;
  if (
    hasApi &&
    (!Number.isFinite(apiMaxCostUsdPerCall) ||
      apiMaxCostUsdPerCall <= 0 ||
      !Number.isFinite(apiBudgetUsdPerRun) ||
      apiBudgetUsdPerRun <= 0 ||
      apiMaxCostUsdPerCall > apiBudgetUsdPerRun)
  ) {
    throw new Error("INVALID_API_BUDGET");
  }
  return {
    workspace: text(value.workspace, "workspace", 4_096),
    workspaceMode,
    worktreeConfirmed: workspaceMode === "worktree" && value.worktreeConfirmed === true,
    ...(worktreeApproval ? { worktreeApproval } : {}),
    dirtySnapshotConfirmed,
    ...(dirtySnapshotId ? { dirtySnapshotId } : {}),
    ...(dirtySnapshotApproval ? { dirtySnapshotApproval } : {}),
    task: text(value.task, "task", 100_000),
    ...(value.acceptanceCriteria !== undefined
      ? { acceptanceCriteria: text(value.acceptanceCriteria, "acceptance_criteria", 20_000) }
      : {}),
    profile,
    planner,
    writer,
    ...(fallbackWriter ? { fallbackWriter } : {}),
    reviewers,
    ...(testProfileId ? { testProfileId } : {}),
    testConfirmed: Boolean(testProfileId) && value.testConfirmed === true,
    ...(testApproval ? { testApproval } : {}),
    ...(restoreRunId ? { restoreRunId } : {}),
    ...(restoreCheckpointId ? { restoreCheckpointId } : {}),
    ...(restoreApproval ? { restoreApproval } : {}),
    softLimits:
      profile === "custom" ? customSoftLimits(value.softLimits) : { ...PROFILES[profile] },
    apiModeConfirmed: hasApi && value.apiModeConfirmed === true,
    ...(apiApproval ? { apiApproval } : {}),
    apiMaxCostUsdPerCall,
    apiBudgetUsdPerRun,
  };
}
