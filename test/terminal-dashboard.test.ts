import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_HARD_LIMITS, PROFILES } from "../src/config.ts";
import {
  cancelKeyTransition,
  renderTerminalDashboard,
  usageDetailLines,
  type TerminalDashboardInput,
} from "../src/ui/terminal-dashboard.ts";

function dashboard(
  status: TerminalDashboardInput["record"]["status"] = "running",
): TerminalDashboardInput {
  const createdAt = "2026-07-16T03:30:00.000Z";
  return {
    runId: "00000000-0000-4000-8000-000000000001",
    task: "Review the project without leaking secrets",
    workspace: "/tmp/synthetic-project",
    workspaceMode: "worktree",
    profile: "normal",
    assignments: [
      { role: "planner", provider: "fake", model: "fake", authMode: "subscription" },
      { role: "writer", provider: "fake", model: "fake", authMode: "subscription" },
      { role: "reviewer", provider: "fake", model: "fake", authMode: "subscription" },
    ],
    record: {
      id: "00000000-0000-4000-8000-000000000001",
      createdAt,
      updatedAt: createdAt,
      status,
      workspaceLabel: "synthetic-project",
      profile: "normal",
      counters: {
        rounds: 1,
        providerCalls: 2,
        subprocesses: 0,
        consecutiveErrors: 0,
        outputBytes: 2048,
        apiBudgetUsd: 0,
      },
    },
    events: [
      {
        runId: "00000000-0000-4000-8000-000000000001",
        at: "2026-07-16T03:30:01.000Z",
        type: "provider.started",
        actor: "fake",
        status: "info",
        summary: "planner started.",
        metadata: { role: "planner", provider: "fake", model: "fake" },
      },
      {
        runId: "00000000-0000-4000-8000-000000000001",
        at: "2026-07-16T03:30:02.000Z",
        type: "provider.completed",
        actor: "fake",
        status: "success",
        summary: "planner completed.",
        metadata: { role: "planner", provider: "fake", model: "fake" },
      },
    ],
    softLimits: { ...PROFILES.normal },
    hardLimits: { ...DEFAULT_HARD_LIMITS },
    view: "activity",
    nowMs: Date.parse("2026-07-16T03:31:05.000Z"),
  };
}

test("renders a readable live terminal dashboard with role and progress state", () => {
  const output = renderTerminalDashboard(dashboard(), { columns: 100, rows: 30, color: false });
  assert.match(output, /ORCHESTRATORY  \/  Live workflow/u);
  assert.match(output, /● RUNNING/u);
  assert.match(output, /planner\s+fake\/fake\s+done/u);
  assert.match(output, /writer\s+fake\/fake\s+waiting/u);
  assert.match(output, /Rounds\s+1 \/ 5/u);
  assert.match(output, /p pause\/resume/u);
  assert.doesNotMatch(output, /\u001b/u);
});

test("renders a distinct final result dashboard", () => {
  const input = dashboard("completed");
  input.notice = "All reviewers passed.";
  const output = renderTerminalDashboard(input, { columns: 90, rows: 26, color: false });
  assert.match(output, /Workflow result/u);
  assert.match(output, /● COMPLETED/u);
  assert.match(output, /All reviewers passed\./u);
  assert.match(output, /Run finished/u);
});

test("sanitizes terminal controls and bounds dashboard detail lines", () => {
  const input = dashboard();
  input.task = "safe\u001b]52;c;payload\u0007 task";
  input.view = "messages";
  input.detailLines = ["line\u001b[31m red", "x".repeat(500)];
  const output = renderTerminalDashboard(input, { columns: 64, rows: 22, color: false });
  assert.doesNotMatch(output, /\u001b/u);
  assert.doesNotMatch(output, /payload/u);
  assert.ok(output.split("\n").every((line) => line.length <= 80));
});

test("formats usage against immutable hard ceilings", () => {
  const lines = usageDetailLines(dashboard());
  assert.ok(lines.some((line) => line.includes("1 / 5 soft / 20 hard")));
  assert.ok(lines.some((line) => line.includes("$0.00 / $25.00 hard")));
});

test("renders bounded failure, pause, cancellation and preparation states", () => {
  const expected = new Map([
    ["created", "○ PREPARING"],
    ["paused", "● PAUSED"],
    ["failed", "● FAILED"],
    ["cancelled", "● CANCELLED"],
  ] as const);
  for (const [status, label] of expected) {
    const output = renderTerminalDashboard(dashboard(status), {
      columns: 84,
      rows: 24,
      color: false,
    });
    assert.ok(output.includes(label));
  }
});

test("renders event severity, working agents, hour durations and byte ranges", () => {
  const input = dashboard();
  input.record.createdAt = "2026-07-16T01:00:00.000Z";
  input.nowMs = Date.parse("2026-07-16T03:31:05.000Z");
  input.record.counters.outputBytes = 2_097_152;
  input.assignments[1] = {
    role: "writer",
    provider: "claude",
    model: "sonnet",
    authMode: "subscription",
  };
  input.events = [
    {
      runId: input.runId,
      at: "invalid-date",
      type: "provider.started",
      actor: "claude",
      status: "warning",
      summary: "writer waiting for approval",
      metadata: { role: "writer", provider: "claude", model: "sonnet" },
    },
    {
      runId: input.runId,
      at: "2026-07-16T03:30:02.000Z",
      type: "workflow.failed",
      actor: "system",
      status: "error",
      summary: "synthetic failure",
    },
  ];
  const output = renderTerminalDashboard(input, { columns: 100, rows: 30, color: false });
  assert.match(output, /2h 31m/u);
  assert.match(output, /writer\s+claude\/sonnet\s+working\s+subscription/u);
  assert.match(output, /--:--:--\s+! writer waiting/u);
  assert.match(output, /× synthetic failure/u);
  assert.match(output, /2\.0 MiB/u);

  input.record.counters.outputBytes = 512;
  assert.match(renderTerminalDashboard(input, { color: false }), /512 B/u);
});

test("renders every detail view and safe empty states with color enabled", () => {
  const input = dashboard();
  input.events = [];
  const emptyActivity = renderTerminalDashboard(input, { color: true });
  assert.match(emptyActivity, /Waiting for the first event/u);
  assert.match(emptyActivity, /\u001b\[/u);

  for (const [view, label] of [
    ["messages", "Volatile model messages"],
    ["diff", "Workspace diff"],
    ["tests", "Test activity"],
    ["usage", "Usage and limits"],
  ] as const) {
    input.view = view;
    delete input.detailLines;
    const output = renderTerminalDashboard(input, { columns: 160, rows: 10, color: false });
    assert.match(output, new RegExp(label, "u"));
    assert.match(output, /No information is available yet/u);
  }
});

test("requires a second cancel key within the bounded confirmation window", () => {
  const first = cancelKeyTransition(1_000, 0);
  assert.equal(first.requestCancel, false);
  assert.equal(first.armedUntil, 6_000);
  assert.match(first.notice, /Press c again/u);

  const expired = cancelKeyTransition(6_001, first.armedUntil);
  assert.equal(expired.requestCancel, false);
  assert.equal(expired.armedUntil, 11_001);

  const confirmed = cancelKeyTransition(6_002, expired.armedUntil);
  assert.equal(confirmed.requestCancel, true);
  assert.equal(confirmed.armedUntil, 0);
  assert.match(confirmed.notice, /Cancellation requested/u);
});
