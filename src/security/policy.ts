import type {
  AccessMode,
  HardLimits,
  PolicyDecision,
  RunCounters,
  SoftLimits,
  WorkflowRequest,
} from "../types.ts";

export function decideProviderCall(input: {
  request: WorkflowRequest;
  counters: RunCounters;
  hard: HardLimits;
  soft: SoftLimits;
  access: AccessMode;
  role: string;
}): PolicyDecision {
  const { request, counters, hard, soft, access, role } = input;
  if (counters.providerCalls >= Math.min(hard.maxProviderCalls, soft.maxProviderCalls)) {
    return { decision: "deny", reason: "MAX_PROVIDER_CALLS_REACHED" };
  }
  if (counters.subprocesses >= hard.maxSubprocesses) {
    return { decision: "deny", reason: "MAX_SUBPROCESSES_REACHED" };
  }
  if (counters.consecutiveErrors >= hard.maxConsecutiveErrors) {
    return { decision: "deny", reason: "CIRCUIT_BREAKER_OPEN" };
  }
  if (counters.outputBytes >= hard.maxOutputBytes * hard.maxProviderCalls) {
    return { decision: "deny", reason: "MAX_TOTAL_OUTPUT_REACHED" };
  }
  if (access === "workspace-write" && role !== "writer") {
    return { decision: "deny", reason: "ONLY_WRITER_MAY_WRITE" };
  }
  const usesApi = [request.planner, request.writer, ...request.reviewers, request.tester]
    .filter(Boolean)
    .some((assignment) => assignment?.authMode === "api");
  if (usesApi && !request.apiModeConfirmed) {
    return { decision: "require-approval", reason: "API_MODE_NOT_CONFIRMED" };
  }
  return { decision: "allow", reason: "POLICY_ALLOW" };
}

export function decideRound(input: {
  counters: RunCounters;
  hard: HardLimits;
  soft: SoftLimits;
  startedAtMs: number;
  nowMs: number;
}): PolicyDecision {
  const { counters, hard, soft, startedAtMs, nowMs } = input;
  if (counters.rounds >= Math.min(hard.maxRounds, soft.maxRounds)) {
    return { decision: "deny", reason: "MAX_ROUNDS_REACHED" };
  }
  if (nowMs - startedAtMs >= Math.min(hard.workflowTimeoutMs, soft.workflowTimeoutMs)) {
    return { decision: "deny", reason: "WORKFLOW_TIMEOUT" };
  }
  return { decision: "allow", reason: "ROUND_ALLOWED" };
}
