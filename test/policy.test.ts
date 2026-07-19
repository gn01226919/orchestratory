import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_HARD_LIMITS, PROFILES } from "../src/config.ts";
import { decideProviderCall, decideRound } from "../src/security/policy.ts";
import type { RunCounters, WorkflowRequest } from "../src/types.ts";

const counters = (): RunCounters => ({
  rounds: 0,
  providerCalls: 0,
  subprocesses: 0,
  consecutiveErrors: 0,
  outputBytes: 0,
  apiBudgetUsd: 0,
});

const assignment = {
  role: "planner" as const,
  provider: "fake" as const,
  model: "fake",
  authMode: "subscription" as const,
};

const request = (): WorkflowRequest => ({
  workspace: ".",
  workspaceMode: "in-place",
  worktreeConfirmed: false,
  task: "synthetic task",
  profile: "normal",
  planner: assignment,
  writer: { ...assignment, role: "writer" },
  reviewers: [{ ...assignment, role: "reviewer" }],
  testConfirmed: false,
  softLimits: { ...PROFILES.normal },
  apiModeConfirmed: false,
  apiMaxCostUsdPerCall: 0,
  apiBudgetUsdPerRun: 0,
});

test("only writer role may request workspace write", () => {
  const decision = decideProviderCall({
    request: request(),
    counters: counters(),
    hard: { ...DEFAULT_HARD_LIMITS },
    soft: { ...PROFILES.normal },
    access: "workspace-write",
    role: "reviewer",
  });
  assert.equal(decision.decision, "deny");
  assert.equal(decision.reason, "ONLY_WRITER_MAY_WRITE");
});

test("API mode requires explicit confirmation", () => {
  const value = request();
  value.writer = { ...value.writer, authMode: "api" };
  const decision = decideProviderCall({
    request: value,
    counters: counters(),
    hard: { ...DEFAULT_HARD_LIMITS },
    soft: { ...PROFILES.normal },
    access: "workspace-write",
    role: "writer",
  });
  assert.equal(decision.decision, "require-approval");
});

test("round policy stops at the soft limit", () => {
  const value = counters();
  value.rounds = PROFILES.normal.maxRounds;
  const decision = decideRound({
    counters: value,
    hard: { ...DEFAULT_HARD_LIMITS },
    soft: { ...PROFILES.normal },
    startedAtMs: 0,
    nowMs: 1,
  });
  assert.equal(decision.reason, "MAX_ROUNDS_REACHED");
});

test("provider policy denies every hard resource boundary", () => {
  const cases: Array<[keyof RunCounters, number, string]> = [
    ["providerCalls", PROFILES.normal.maxProviderCalls, "MAX_PROVIDER_CALLS_REACHED"],
    ["subprocesses", DEFAULT_HARD_LIMITS.maxSubprocesses, "MAX_SUBPROCESSES_REACHED"],
    ["consecutiveErrors", DEFAULT_HARD_LIMITS.maxConsecutiveErrors, "CIRCUIT_BREAKER_OPEN"],
    [
      "outputBytes",
      DEFAULT_HARD_LIMITS.maxOutputBytes * DEFAULT_HARD_LIMITS.maxProviderCalls,
      "MAX_TOTAL_OUTPUT_REACHED",
    ],
  ];
  for (const [key, value, reason] of cases) {
    const usage = counters();
    usage[key] = value;
    const decision = decideProviderCall({
      request: request(),
      counters: usage,
      hard: { ...DEFAULT_HARD_LIMITS },
      soft: { ...PROFILES.normal },
      access: "read-only",
      role: "planner",
    });
    assert.equal(decision.reason, reason);
  }
});

test("round policy enforces the absolute elapsed deadline", () => {
  const decision = decideRound({
    counters: counters(),
    hard: { ...DEFAULT_HARD_LIMITS },
    soft: { ...PROFILES.normal },
    startedAtMs: 1,
    nowMs: 1 + PROFILES.normal.workflowTimeoutMs,
  });
  assert.equal(decision.reason, "WORKFLOW_TIMEOUT");
});
