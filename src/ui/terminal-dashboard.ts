import type {
  AgentAssignment,
  HardLimits,
  RunEvent,
  RunRecord,
  SoftLimits,
  WorkspaceMode,
} from "../types.ts";
import { sanitizeTerminal } from "../security/redact.ts";

export type DashboardView = "activity" | "messages" | "diff" | "tests" | "usage";

export interface TerminalDashboardInput {
  runId: string;
  task: string;
  workspace: string;
  workspaceMode: WorkspaceMode;
  profile: string;
  assignments: AgentAssignment[];
  record: RunRecord;
  events: RunEvent[];
  softLimits: SoftLimits;
  hardLimits: HardLimits;
  view: DashboardView;
  detailLines?: string[];
  notice?: string;
  nowMs?: number;
}

export interface TerminalRenderOptions {
  columns?: number;
  rows?: number;
  color?: boolean;
}

export interface CancelKeyTransition {
  armedUntil: number;
  requestCancel: boolean;
  notice: string;
}

export function cancelKeyTransition(nowMs: number, armedUntil: number): CancelKeyTransition {
  if (armedUntil > nowMs) {
    return {
      armedUntil: 0,
      requestCancel: true,
      notice: "Cancellation requested. Waiting for the active provider to stop safely.",
    };
  }
  return {
    armedUntil: nowMs + 5_000,
    requestCancel: false,
    notice: "Press c again within 5 seconds to cancel this workflow.",
  };
}

const ANSI = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  cyan: "\u001b[36m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  red: "\u001b[31m",
  magenta: "\u001b[35m",
};

function paint(value: string, code: string, enabled: boolean): string {
  return enabled ? `${code}${value}${ANSI.reset}` : value;
}

function terminalText(value: string): string {
  return sanitizeTerminal(value).replace(/[\r\n\t]+/gu, " ").trim();
}

function clip(value: string, width: number): string {
  const safe = terminalText(value);
  if (safe.length <= width) return safe;
  return `${safe.slice(0, width - 1)}…`;
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  return hours > 0
    ? `${hours}h ${String(minutes).padStart(2, "0")}m`
    : `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KiB`;
  return `${(bytes / 1_048_576).toFixed(1)} MiB`;
}

function statusPresentation(status: RunRecord["status"], color: boolean): string {
  if (status === "completed") return paint("● COMPLETED", ANSI.green, color);
  if (status === "failed") return paint("● FAILED", ANSI.red, color);
  if (status === "cancelled") return paint("● CANCELLED", ANSI.yellow, color);
  if (status === "paused") return paint("● PAUSED", ANSI.yellow, color);
  if (status === "running") return paint("● RUNNING", ANSI.cyan, color);
  return paint("○ PREPARING", ANSI.dim, color);
}

function eventPresentation(event: RunEvent, color: boolean): string {
  const time = Number.isNaN(Date.parse(event.at))
    ? "--:--:--"
    : new Date(event.at).toLocaleTimeString("en-GB", { hour12: false });
  const marker = event.status === "success"
    ? paint("✓", ANSI.green, color)
    : event.status === "warning"
      ? paint("!", ANSI.yellow, color)
      : event.status === "error"
        ? paint("×", ANSI.red, color)
        : paint("•", ANSI.cyan, color);
  return `${paint(time, ANSI.dim, color)}  ${marker} ${terminalText(event.summary)}`;
}

function assignmentState(
  assignment: AgentAssignment,
  events: RunEvent[],
  color: boolean,
): string {
  const related = events.filter((event) =>
    event.metadata?.role === assignment.role &&
    event.metadata?.provider === assignment.provider &&
    event.metadata?.model === assignment.model
  );
  const latest = related.at(-1);
  if (latest?.type === "provider.started") return paint("working", ANSI.cyan, color);
  if (latest?.type === "provider.completed") return paint("done", ANSI.green, color);
  return paint("waiting", ANSI.dim, color);
}

function progressBar(value: number, maximum: number, width: number): string {
  const safeMaximum = Math.max(1, maximum);
  const ratio = Math.max(0, Math.min(1, value / safeMaximum));
  const filled = Math.round(ratio * width);
  return `${"━".repeat(filled)}${"─".repeat(Math.max(0, width - filled))}`;
}

function viewLabel(view: DashboardView): string {
  if (view === "messages") return "Volatile model messages";
  if (view === "diff") return "Workspace diff";
  if (view === "tests") return "Test activity";
  if (view === "usage") return "Usage and limits";
  return "Recent activity";
}

export function renderTerminalDashboard(
  input: TerminalDashboardInput,
  options: TerminalRenderOptions = {},
): string {
  const columns = Math.max(64, Math.min(options.columns ?? 100, 140));
  const rows = Math.max(22, options.rows ?? 32);
  const color = options.color ?? true;
  const lineWidth = columns - 2;
  const nowMs = input.nowMs ?? Date.now();
  const elapsed = formatDuration(nowMs - Date.parse(input.record.createdAt));
  const terminal = ["completed", "failed", "cancelled"].includes(input.record.status);
  const title = terminal ? "Workflow result" : "Live workflow";
  const divider = paint("─".repeat(lineWidth), ANSI.dim, color);
  const taskWidth = Math.max(20, columns - 15);
  const assignmentWidth = Math.max(12, Math.min(34, columns - 50));

  const lines = [
    paint(`✦ ORCHESTRATORY  /  ${title}`, ANSI.bold + ANSI.magenta, color),
    divider,
    `${statusPresentation(input.record.status, color)}   ${paint(`elapsed ${elapsed}`, ANSI.dim, color)}   ${paint(`run ${input.runId.slice(0, 8)}`, ANSI.dim, color)}`,
    "",
    `${paint("Workspace", ANSI.bold, color)}  ${clip(input.workspace, taskWidth)}`,
    `${paint("Task", ANSI.bold, color)}       ${clip(input.task, taskWidth)}`,
    `${paint("Mode", ANSI.bold, color)}       ${input.workspaceMode}  ·  ${input.profile}`,
    "",
    paint("Agents", ANSI.bold, color),
  ];

  for (const assignment of input.assignments) {
    const role = assignment.role.padEnd(8, " ");
    const auth = assignment.provider === "fake" ? "no quota" : assignment.authMode;
    lines.push(
      `  ${paint("◆", ANSI.magenta, color)} ${role}  ${clip(`${assignment.provider}/${assignment.model}`, assignmentWidth).padEnd(assignmentWidth, " ")}  ${assignmentState(assignment, input.events, color)}  ${paint(auth, ANSI.dim, color)}`,
    );
  }

  const counters = input.record.counters;
  const progressWidth = Math.max(12, Math.min(34, columns - 46));
  lines.push(
    "",
    paint("Progress", ANSI.bold, color),
    `  Rounds  ${String(counters.rounds).padStart(2, " ")} / ${String(input.softLimits.maxRounds).padEnd(2, " ")}   ${progressBar(counters.rounds, input.softLimits.maxRounds, progressWidth)}`,
    `  Calls   ${String(counters.providerCalls).padStart(2, " ")} / ${String(input.softLimits.maxProviderCalls).padEnd(2, " ")}   ${progressBar(counters.providerCalls, input.softLimits.maxProviderCalls, progressWidth)}`,
    `  Output  ${formatBytes(counters.outputBytes)}   ·   API reserved $${counters.apiBudgetUsd.toFixed(2)}`,
    "",
    paint(viewLabel(input.view), ANSI.bold, color),
  );

  const fixedRows = lines.length + 4;
  const availableRows = Math.max(3, rows - fixedRows);
  if (input.view === "activity") {
    const recent = input.events.slice(-availableRows);
    if (recent.length === 0) lines.push(paint("  Waiting for the first event…", ANSI.dim, color));
    for (const event of recent) lines.push(`  ${clip(eventPresentation(event, color), lineWidth - 2)}`);
  } else {
    const details = input.detailLines?.slice(-availableRows) ?? [];
    if (details.length === 0) lines.push(paint("  No information is available yet.", ANSI.dim, color));
    for (const detail of details) lines.push(`  ${clip(detail, lineWidth - 2)}`);
  }

  while (lines.length < rows - 2) lines.push("");
  if (input.notice) lines.push(paint(clip(input.notice, lineWidth), ANSI.yellow, color));
  const controls = terminal
    ? "Run finished · full details remain available in the Web dashboard"
    : "p pause/resume   e activity   m messages   d diff   t tests   u usage   c c cancel";
  lines.push(divider, paint(clip(controls, lineWidth), ANSI.dim, color));
  return `${lines.join("\n")}\n`;
}

export function usageDetailLines(input: TerminalDashboardInput): string[] {
  const counters = input.record.counters;
  return [
    `Rounds                 ${counters.rounds} / ${input.softLimits.maxRounds} soft / ${input.hardLimits.maxRounds} hard`,
    `Provider calls         ${counters.providerCalls} / ${input.softLimits.maxProviderCalls} soft / ${input.hardLimits.maxProviderCalls} hard`,
    `Subprocesses           ${counters.subprocesses} / ${input.hardLimits.maxSubprocesses} hard`,
    `Consecutive errors     ${counters.consecutiveErrors} / ${input.hardLimits.maxConsecutiveErrors} hard`,
    `Output                 ${formatBytes(counters.outputBytes)} / ${formatBytes(input.hardLimits.maxOutputBytes)} per call`,
    `Reserved API budget    $${counters.apiBudgetUsd.toFixed(2)} / $${input.hardLimits.maxApiBudgetUsdPerRun.toFixed(2)} hard`,
  ];
}
