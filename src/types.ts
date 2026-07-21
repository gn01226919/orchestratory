export type ProviderId = "fake" | "codex" | "claude" | "grok";
export type AuthMode = "subscription" | "api";
export type AgentRole = "planner" | "writer" | "reviewer" | "tester";
export type AccessMode = "read-only" | "workspace-write";
export type RunStatus =
  | "created"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";
export type WorkspaceMode = "in-place" | "worktree";

export interface HardLimits {
  maxConcurrentWorkflows: number;
  providerTimeoutMs: number;
  workflowTimeoutMs: number;
  maxProviderCalls: number;
  maxSubprocesses: number;
  maxOutputBytes: number;
  maxFilesChanged: number;
  maxDiffLines: number;
  maxConsecutiveErrors: number;
  maxRetries: number;
  maxRounds: number;
  maxApiBudgetUsdPerRun: number;
  maxApiBudgetUsdPerDay: number;
  maxApiBudgetUsdPerMonth: number;
}

export interface SoftLimits {
  maxRounds: number;
  maxProviderCalls: number;
  workflowTimeoutMs: number;
  providerTimeoutMs: number;
}

export interface AgentAssignment {
  role: AgentRole;
  provider: ProviderId;
  model: string;
  authMode: AuthMode;
}

export interface WorkflowRequest {
  workspace: string;
  workspaceMode: WorkspaceMode;
  worktreeConfirmed: boolean;
  worktreeApproval?: string;
  dirtySnapshotConfirmed?: boolean;
  dirtySnapshotId?: string;
  dirtySnapshotApproval?: string;
  task: string;
  acceptanceCriteria?: string;
  profile: "normal" | "long" | "custom";
  planner: AgentAssignment;
  writer: AgentAssignment;
  fallbackWriter?: AgentAssignment;
  reviewers: AgentAssignment[];
  tester?: AgentAssignment;
  testProfileId?: string;
  testConfirmed: boolean;
  testApproval?: string;
  restoreRunId?: string;
  restoreCheckpointId?: string;
  restoreApproval?: string;
  softLimits: SoftLimits;
  apiModeConfirmed: boolean;
  apiApproval?: string;
  apiMaxCostUsdPerCall: number;
  apiBudgetUsdPerRun: number;
}

export interface CheckpointRecord {
  id: string;
  runId: string;
  createdAt: string;
  round: number;
  phase: "writer-complete";
  workspaceFingerprint: string;
  counters: RunCounters;
}

export interface ApiModelPolicy {
  provider: Exclude<ProviderId, "fake">;
  model: string;
  inputUsdPerMillionTokens: number;
  outputUsdPerMillionTokens: number;
  maxOutputTokens: number;
}

export interface TesterProfile {
  id: string;
  displayName: string;
  runtime: "docker" | "podman";
  image: string;
  executable: string;
  args: readonly string[];
}

export interface WorkspaceRootPolicy {
  id: string;
  label: string;
  path: string;
}

export interface RetentionPolicy {
  terminalRunDays: number;
  maxTerminalRuns: number;
  debugCaptureEnabled: boolean;
  debugRetentionHours: number;
}

export interface TestResult {
  profileId: string;
  exitCode: number;
  durationMs: number;
  outputBytes: number;
  stdout: string;
  stderr: string;
}

export interface RunCounters {
  rounds: number;
  providerCalls: number;
  subprocesses: number;
  consecutiveErrors: number;
  outputBytes: number;
  apiBudgetUsd: number;
}

export interface ProviderRequest {
  runId: string;
  role: AgentRole;
  access: AccessMode;
  workspace: string;
  prompt: string;
  model: string;
  authMode: AuthMode;
  timeoutMs: number;
  outputLimitBytes: number;
  apiMaxOutputTokens?: number;
  writerAuthorization?: {
    dataDirectory: string;
    roomId: string;
    sourceWorkspace: string;
    taskId: string;
    epoch: number;
    executedBy: string;
    capabilityToken?: string;
    delegationId?: string;
  };
  signal?: AbortSignal;
}

export interface ProviderResult {
  provider: ProviderId;
  model: string;
  text: string;
  exitCode: number;
  durationMs: number;
  outputBytes: number;
  estimatedCostUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
}

export interface RunEvent {
  id?: number;
  runId: string;
  at: string;
  type: string;
  actor: string;
  status: "info" | "success" | "warning" | "error";
  summary: string;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface RunMessage {
  at: string;
  role: AgentRole;
  provider: ProviderId;
  model: string;
  text: string;
}

export interface RunRecord {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: RunStatus;
  workspaceLabel: string;
  profile: string;
  counters: RunCounters;
  errorCode?: string;
}

export interface PolicyDecision {
  decision: "allow" | "deny" | "require-approval";
  reason: string;
}
