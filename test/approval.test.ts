import test from "node:test";
import assert from "node:assert/strict";
import {
  ApprovalService,
  dataPurgeApprovalScope,
  dirtySnapshotApprovalScope,
  workflowApprovalScope,
} from "../src/security/approval.ts";
import { PROFILES } from "../src/config.ts";
import type { WorkflowRequest } from "../src/types.ts";

test("approval is scoped, run-bound and single-use", () => {
  let now = 1_000;
  const runA = "00000000-0000-4000-8000-00000000000a";
  const runB = "00000000-0000-4000-8000-00000000000b";
  const approvals = new ApprovalService({ now: () => now, ttlMs: 60_000 });
  const issued = approvals.issue("create-worktree", "scope-a", "local-tui");

  assert.throws(
    () => approvals.consume("use-api", "scope-a", issued.token, runA),
    /APPROVAL_SCOPE_MISMATCH/u,
  );
  assert.throws(
    () => approvals.consume("create-worktree", "scope-b", issued.token, runA),
    /APPROVAL_SCOPE_MISMATCH/u,
  );
  assert.equal(
    approvals.consume("create-worktree", "scope-a", issued.token, runA).runId,
    runA,
  );
  assert.throws(
    () => approvals.consume("create-worktree", "scope-a", issued.token, runB),
    /APPROVAL_INVALID_OR_REPLAYED/u,
  );
});

test("approval expires and malformed tokens fail closed", () => {
  let now = 1_000;
  const runId = "00000000-0000-4000-8000-00000000000a";
  const approvals = new ApprovalService({ now: () => now, ttlMs: 100 });
  const issued = approvals.issue("use-api", "scope-a", "local-web");
  assert.throws(
    () => approvals.consume("use-api", "scope-a", "not-a-token", runId),
    /APPROVAL_TOKEN_INVALID/u,
  );
  now = 1_101;
  assert.throws(
    () => approvals.consume("use-api", "scope-a", issued.token, runId),
    /APPROVAL_EXPIRED/u,
  );
});

test("approval rejects unbounded fields and unknown actions", () => {
  const approvals = new ApprovalService();
  assert.throws(
    () => approvals.issue("unknown" as "use-api", "scope", "local-tui"),
    /APPROVAL_ACTION_INVALID/u,
  );
  assert.throws(
    () => approvals.issue("use-api", "x".repeat(257), "local-tui"),
    /APPROVAL_SCOPE_INVALID/u,
  );
  assert.throws(
    () => approvals.issue("use-api", "scope", "unknown" as "local-tui"),
    /APPROVAL_ACTOR_INVALID/u,
  );
  assert.throws(() => new ApprovalService({ ttlMs: 9 }), /APPROVAL_TTL_INVALID/u);
  assert.throws(() => new ApprovalService({ ttlMs: 600_001 }), /APPROVAL_TTL_INVALID/u);
  const issued = approvals.issue("use-api", "scope", "local-tui");
  assert.throws(
    () => approvals.consume("use-api", "scope", issued.token, "invalid run id"),
    /APPROVAL_RUN_ID_INVALID/u,
  );
});

test("workflow approvals bind API agents and test profiles into distinct scopes", () => {
  const request: WorkflowRequest = {
    workspace: "/tmp/synthetic",
    workspaceMode: "in-place",
    worktreeConfirmed: false,
    task: "synthetic",
    profile: "normal",
    planner: { role: "planner", provider: "codex", model: "m", authMode: "api" },
    writer: { role: "writer", provider: "fake", model: "fake", authMode: "subscription" },
    reviewers: [{ role: "reviewer", provider: "fake", model: "fake", authMode: "subscription" }],
    testProfileId: "node-tests",
    testConfirmed: true,
    softLimits: { ...PROFILES.normal },
    apiModeConfirmed: true,
    apiMaxCostUsdPerCall: 1,
    apiBudgetUsdPerRun: 2,
  };
  const api = workflowApprovalScope(request, "use-api");
  const testScope = workflowApprovalScope(request, "run-test");
  const worktree = workflowApprovalScope({ ...request, workspaceMode: "worktree" }, "create-worktree");
  assert.match(api, /^[a-f0-9]{64}$/u);
  assert.notEqual(api, testScope);
  assert.notEqual(api, worktree);
  assert.notEqual(
    worktree,
    workflowApprovalScope(
      {
        ...request,
        workspaceMode: "worktree",
        dirtySnapshotConfirmed: true,
        dirtySnapshotId: "00000000-0000-4000-8000-000000000123",
      },
      "create-worktree",
    ),
  );
});

test("dirty snapshot approval binds exact task, agents, source state, and snapshot", () => {
  const request: WorkflowRequest = {
    workspace: "/tmp/synthetic",
    workspaceMode: "worktree",
    worktreeConfirmed: true,
    dirtySnapshotConfirmed: true,
    dirtySnapshotId: "00000000-0000-4000-8000-000000000123",
    task: "synthetic",
    profile: "normal",
    planner: { role: "planner", provider: "fake", model: "fake", authMode: "subscription" },
    writer: { role: "writer", provider: "fake", model: "fake", authMode: "subscription" },
    reviewers: [{ role: "reviewer", provider: "fake", model: "fake", authMode: "subscription" }],
    testConfirmed: false,
    softLimits: { ...PROFILES.normal },
    apiModeConfirmed: false,
    apiMaxCostUsdPerCall: 0,
    apiBudgetUsdPerRun: 0,
  };
  const snapshot = {
    id: request.dirtySnapshotId!,
    createdAt: "2026-07-17T00:00:00.000Z",
    sourceWorkspace: request.workspace,
    baseSha: "a".repeat(40),
    sourceFingerprint: "b".repeat(64),
    files: [{
      path: "README.md",
      operation: "write" as const,
      baseExists: true,
      bytes: 8,
      sha256: "c".repeat(64),
      content: "changed\n",
    }],
    totalBytes: 8,
    snapshotHash: "d".repeat(64),
  };
  const scope = dirtySnapshotApprovalScope(request, snapshot);
  assert.match(scope, /^[a-f0-9]{64}$/u);
  assert.notEqual(scope, dirtySnapshotApprovalScope(request, { ...snapshot, snapshotHash: "e".repeat(64) }));
  assert.notEqual(scope, dirtySnapshotApprovalScope({ ...request, task: "changed" }, snapshot));
});

test("data purge approval binds the exact immutable preview", () => {
  const base = {
    id: "00000000-0000-4000-8000-000000000001",
    createdAt: "2026-07-16T00:00:00.000Z",
    policy: {
      terminalRunDays: 30,
      maxTerminalRuns: 500,
      debugCaptureEnabled: false,
      debugRetentionHours: 24,
    },
    protectedRunIds: [],
    candidates: [{ runId: "old-run", updatedAt: "2026-01-01T00:00:00.000Z" }],
    counts: { runs: 1, events: 2, checkpoints: 0, apiBudgetReservations: 0 },
  };
  const scope = dataPurgeApprovalScope(base);
  assert.match(scope, /^[a-f0-9]{64}$/u);
  assert.notEqual(
    scope,
    dataPurgeApprovalScope({ ...base, candidates: [{ ...base.candidates[0]!, updatedAt: "changed" }] }),
  );
});
