import test from "node:test";
import assert from "node:assert/strict";
import { ProviderRegistry } from "../src/providers/registry.ts";
import { parseWorkflowRequest } from "../src/ui/request.ts";

function payload(): Record<string, unknown> {
  return {
    workspace: "/tmp/synthetic-workspace",
    task: "synthetic task",
    profile: "normal",
    planner: { provider: "fake", model: "fake", authMode: "subscription" },
    writer: { provider: "fake", model: "fake", authMode: "subscription" },
    reviewers: [{ provider: "fake", model: "fake", authMode: "subscription" }],
    apiModeConfirmed: false,
  };
}

test("request parser defaults to fail-closed worktree isolation", () => {
  const value = parseWorkflowRequest(payload(), new ProviderRegistry());
  assert.equal(value.workspaceMode, "worktree");
  assert.equal(value.worktreeConfirmed, false);
});

test("request parser accepts explicit in-place subscription mode", () => {
  const input = payload();
  input.workspaceMode = "in-place";
  const value = parseWorkflowRequest(input, new ProviderRegistry());
  assert.equal(value.workspaceMode, "in-place");
  assert.equal(value.apiBudgetUsdPerRun, 0);
});

test("request parser requires API budgets and rejects API writers", () => {
  const registry = new ProviderRegistry([
    {
      provider: "codex",
      model: "synthetic-model",
      inputUsdPerMillionTokens: 1,
      outputUsdPerMillionTokens: 2,
      maxOutputTokens: 100,
    },
  ]);
  const missingBudget = payload();
  missingBudget.workspaceMode = "in-place";
  missingBudget.planner = { provider: "codex", model: "synthetic-model", authMode: "api" };
  assert.throws(() => parseWorkflowRequest(missingBudget, registry), /INVALID_API_BUDGET/u);

  const apiWriter = payload();
  apiWriter.workspaceMode = "in-place";
  apiWriter.writer = { provider: "codex", model: "synthetic-model", authMode: "api" };
  apiWriter.apiMaxCostUsdPerCall = 1;
  apiWriter.apiBudgetUsdPerRun = 2;
  assert.throws(() => parseWorkflowRequest(apiWriter, registry), /WRITER_PROVIDER_IS_READ_ONLY/u);
});

test("request parser preserves explicit API confirmation and limits", () => {
  const registry = new ProviderRegistry([
    {
      provider: "codex",
      model: "synthetic-model",
      inputUsdPerMillionTokens: 1,
      outputUsdPerMillionTokens: 2,
      maxOutputTokens: 100,
    },
  ]);
  const input = payload();
  input.workspaceMode = "in-place";
  input.planner = { provider: "codex", model: "synthetic-model", authMode: "api" };
  input.apiModeConfirmed = true;
  input.apiMaxCostUsdPerCall = 1;
  input.apiBudgetUsdPerRun = 2;
  const value = parseWorkflowRequest(input, registry);
  assert.equal(value.apiModeConfirmed, true);
  assert.equal(value.apiMaxCostUsdPerCall, 1);
  assert.equal(value.apiBudgetUsdPerRun, 2);
});

test("request parser accepts bounded custom soft limits", () => {
  const input = payload();
  input.workspaceMode = "in-place";
  input.profile = "custom";
  input.softLimits = {
    maxRounds: 2,
    maxProviderCalls: 6,
    workflowTimeoutMs: 60_000,
    providerTimeoutMs: 30_000,
  };
  const value = parseWorkflowRequest(input, new ProviderRegistry());
  assert.equal(value.profile, "custom");
  assert.equal(value.softLimits.maxRounds, 2);

  (input.softLimits as Record<string, unknown>).unknown = 1;
  assert.throws(() => parseWorkflowRequest(input, new ProviderRegistry()), /UNKNOWN_SOFT_LIMIT_KEY/u);
});

test("request parser rejects malformed and irrelevant approval tokens", () => {
  const registry = new ProviderRegistry();
  const malformed = payload();
  malformed.worktreeApproval = "short";
  assert.throws(() => parseWorkflowRequest(malformed, registry), /INVALID_WORKTREE_APPROVAL/u);

  const irrelevant = payload();
  irrelevant.workspaceMode = "in-place";
  irrelevant.worktreeApproval = "a".repeat(43);
  assert.throws(() => parseWorkflowRequest(irrelevant, registry), /UNEXPECTED_WORKTREE_APPROVAL/u);

  const unexpectedTest = payload();
  unexpectedTest.workspaceMode = "in-place";
  unexpectedTest.testConfirmed = true;
  assert.throws(
    () => parseWorkflowRequest(unexpectedTest, registry),
    /UNEXPECTED_TEST_CONFIRMATION/u,
  );

  const malformedTest = payload();
  malformedTest.workspaceMode = "in-place";
  malformedTest.testProfileId = "../escape";
  assert.throws(() => parseWorkflowRequest(malformedTest, registry), /INVALID_TEST_PROFILE_ID/u);

  const incompleteRestore = payload();
  incompleteRestore.workspaceMode = "in-place";
  incompleteRestore.restoreRunId = "00000000-0000-4000-8000-000000000001";
  assert.throws(
    () => parseWorkflowRequest(incompleteRestore, registry),
    /INCOMPLETE_CHECKPOINT_RESTORE/u,
  );
});

test("request parser rejects malformed core fields and assignments", () => {
  const registry = new ProviderRegistry();
  assert.throws(() => parseWorkflowRequest(null, registry), /INVALID_WORKFLOW_REQUEST/u);
  const noReviewers = payload();
  noReviewers.reviewers = [];
  assert.throws(() => parseWorkflowRequest(noReviewers, registry), /INVALID_REVIEWERS/u);
  const badPlanner = payload();
  badPlanner.planner = null;
  assert.throws(() => parseWorkflowRequest(badPlanner, registry), /INVALID_PLANNER_ASSIGNMENT/u);
  const unknownProvider = payload();
  unknownProvider.planner = { provider: "unknown", model: "m" };
  assert.throws(() => parseWorkflowRequest(unknownProvider, registry), /UNKNOWN_PROVIDER/u);
  const badModel = payload();
  badModel.planner = { provider: "fake", model: "bad model" };
  assert.throws(() => parseWorkflowRequest(badModel, registry), /INVALID_MODEL_ID/u);
  const badTask = payload();
  badTask.task = "\0";
  assert.throws(() => parseWorkflowRequest(badTask, registry), /INVALID_TASK_NULL/u);
  const custom = payload();
  custom.profile = "custom";
  assert.throws(() => parseWorkflowRequest(custom, registry), /INVALID_SOFT_LIMITS/u);
});

test("request parser accepts only complete, worktree-bound dirty snapshot handoffs", () => {
  const registry = new ProviderRegistry();
  const preparing = payload();
  preparing.dirtySnapshotConfirmed = true;
  const prepared = parseWorkflowRequest(preparing, registry);
  assert.equal(prepared.dirtySnapshotConfirmed, true);
  assert.equal(prepared.dirtySnapshotId, undefined);

  const complete = payload();
  complete.dirtySnapshotConfirmed = true;
  complete.dirtySnapshotId = "00000000-0000-4000-8000-000000000123";
  complete.dirtySnapshotApproval = "a".repeat(43);
  const parsed = parseWorkflowRequest(complete, registry);
  assert.equal(parsed.dirtySnapshotId, complete.dirtySnapshotId);
  assert.equal(parsed.dirtySnapshotApproval, complete.dirtySnapshotApproval);

  const inPlace = payload();
  inPlace.workspaceMode = "in-place";
  inPlace.dirtySnapshotConfirmed = true;
  assert.throws(() => parseWorkflowRequest(inPlace, registry), /DIRTY_SNAPSHOT_REQUIRES_WORKTREE/u);

  const partial = payload();
  partial.dirtySnapshotConfirmed = true;
  partial.dirtySnapshotId = complete.dirtySnapshotId;
  assert.throws(() => parseWorkflowRequest(partial, registry), /INCOMPLETE_DIRTY_SNAPSHOT_APPROVAL/u);

  const unexpected = payload();
  unexpected.dirtySnapshotId = complete.dirtySnapshotId;
  unexpected.dirtySnapshotApproval = complete.dirtySnapshotApproval;
  assert.throws(
    () => parseWorkflowRequest(unexpected, registry),
    /UNEXPECTED_DIRTY_SNAPSHOT_CONFIGURATION/u,
  );

  const malformed = payload();
  malformed.dirtySnapshotConfirmed = true;
  malformed.dirtySnapshotId = "not-a-uuid";
  malformed.dirtySnapshotApproval = complete.dirtySnapshotApproval;
  assert.throws(() => parseWorkflowRequest(malformed, registry), /INVALID_DIRTY_SNAPSHOT_ID/u);
});
