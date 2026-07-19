// NOTE: this interactive terminal UI (readline prompts, keypress dashboard,
// multi-step workflow wizard) is excluded from the coverage gate — mocking the
// full terminal interaction yields brittle, low-value tests. Its pure dispatch
// logic is extracted as runConversationCommand() and unit-tested; the security-
// critical paths it calls (workflow.start, approvals) are covered via
// workflow/web tests. Core logic keeps the 90/85 gate.
import { createInterface } from "node:readline/promises";
import { emitKeypressEvents } from "node:readline";
import { stdin, stdout } from "node:process";
import type { AppContext } from "../app.ts";
import type {
  AgentAssignment,
  ProviderId,
  RunEvent,
  RunRecord,
  SoftLimits,
  WorkflowRequest,
} from "../types.ts";
import { PROFILES } from "../config.ts";
import { sanitizeTerminal } from "../security/redact.ts";
import { checkpointApprovalScope, workflowApprovalScope } from "../security/approval.ts";
import { NaturalLanguageSession, sessionTools } from "../core/session.ts";
import { SessionContextBroker } from "../core/session-context.ts";
import { RoomLedger, type RoomInfo } from "../core/room-ledger.ts";
import { recordTuiDecision, selectTuiRoom } from "../core/tui-room-bridge.ts";
import {
  cancelKeyTransition,
  type DashboardView,
  renderTerminalDashboard,
  type TerminalDashboardInput,
  usageDetailLines,
} from "./terminal-dashboard.ts";

const providerIds = new Set<ProviderId>(["fake", "codex", "claude", "grok"]);
const CLEAR_SCREEN = "\u001b[2J\u001b[H";
const HIDE_CURSOR = "\u001b[?25l";
const SHOW_CURSOR = "\u001b[?25h";

function setupHeader(subtitle: string): void {
  stdout.write(
    `${CLEAR_SCREEN}\u001b[1;35m✦ ORCHESTRATORY\u001b[0m  \u001b[2msecurity-first local agent workflow\u001b[0m\n` +
      `\u001b[2m${"─".repeat(Math.max(62, Math.min(stdout.columns ?? 90, 120)))}\u001b[0m\n` +
      `\u001b[1m${subtitle}\u001b[0m\n\n`,
  );
}

function setupStep(number: number, title: string, detail: string): void {
  stdout.write(`\n\u001b[35m${number}\u001b[0m  \u001b[1m${title}\u001b[0m\n   \u001b[2m${detail}\u001b[0m\n`);
}

function eventDetailLines(events: RunEvent[]): string[] {
  return events.map((event) => {
    const time = Number.isNaN(Date.parse(event.at))
      ? "--:--:--"
      : new Date(event.at).toLocaleTimeString("en-GB", { hour12: false });
    return `${time}  ${event.status.toUpperCase().padEnd(7, " ")}  ${event.summary}`;
  });
}

async function monitorRun(input: {
  app: AppContext;
  runId: string;
  completion: Promise<RunRecord>;
  workflow: WorkflowRequest;
  assignments: AgentAssignment[];
}): Promise<RunRecord> {
  const { app, runId, completion, workflow, assignments } = input;
  let record = app.workflows.usageView(runId);
  let events = app.workflows.eventsView(runId);
  let view: DashboardView = "activity";
  let detailLines: string[] | undefined;
  let notice: string | undefined;
  let cancelArmedUntil = 0;

  const dashboardInput = (): TerminalDashboardInput => ({
    runId,
    task: workflow.task,
    workspace: workflow.workspace,
    workspaceMode: workflow.workspaceMode,
    profile: workflow.profile,
    assignments,
    record,
    events,
    softLimits: workflow.softLimits,
    hardLimits: app.hardLimits,
    view,
    ...(detailLines ? { detailLines } : {}),
    ...(notice ? { notice } : {}),
  });

  const refreshData = (): void => {
    try {
      record = app.workflows.usageView(runId);
    } catch {
      // Completion may move the run from memory to the store between refreshes.
    }
    events = app.workflows.eventsView(runId);
    if (view === "messages") {
      detailLines = app.workflows.messagesView(runId).flatMap((message) => [
        `${message.role} · ${message.provider}/${message.model} · ${message.at}`,
        ...message.text.split(/\r?\n/u),
        "",
      ]);
    } else if (view === "tests") {
      detailLines = eventDetailLines(app.workflows.testsView(runId));
    } else if (view === "usage") {
      detailLines = usageDetailLines(dashboardInput());
    } else if (view === "activity") {
      detailLines = undefined;
    }
  };

  const render = (): void => {
    if (cancelArmedUntil > 0 && Date.now() > cancelArmedUntil) {
      cancelArmedUntil = 0;
      notice = undefined;
    }
    refreshData();
    stdout.write(
      `${CLEAR_SCREEN}${renderTerminalDashboard(dashboardInput(), {
        columns: stdout.columns,
        rows: stdout.rows,
        color: process.env.NO_COLOR === undefined,
      })}`,
    );
  };

  const selectView = (selected: DashboardView): void => {
    view = selected;
    notice = undefined;
    render();
  };

  const onKeypress = (
    _sequence: string,
    key: { name?: string; ctrl?: boolean },
  ): void => {
    const name = key.name?.toLowerCase();
    if (name === "p") {
      const active = app.workflows.listActive().find((item) => item.id === runId);
      const changed = active?.status === "paused"
        ? app.workflows.resume(runId)
        : app.workflows.pause(runId);
      notice = changed ? (active?.status === "paused" ? "Workflow resumed." : "Workflow paused.") : "Pause/resume was rejected.";
      render();
    } else if (name === "e") selectView("activity");
    else if (name === "m") selectView("messages");
    else if (name === "t") selectView("tests");
    else if (name === "u") selectView("usage");
    else if (name === "d") {
      view = "diff";
      detailLines = ["Loading bounded workspace diff…"];
      notice = undefined;
      render();
      void app.workflows.diffView(runId).then((diff) => {
        detailLines = diff.split(/\r?\n/u);
        render();
      }).catch(() => {
        detailLines = ["Diff view could not be loaded."];
        render();
      });
    } else if (name === "c") {
      const transition = cancelKeyTransition(Date.now(), cancelArmedUntil);
      cancelArmedUntil = transition.armedUntil;
      notice = transition.requestCancel && !app.workflows.cancel(runId)
        ? "Cancellation was rejected."
        : transition.notice;
      render();
    }
  };

  emitKeypressEvents(stdin);
  const wasRaw = stdin.isRaw;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.on("keypress", onKeypress);
  stdout.on("resize", render);
  stdout.write(HIDE_CURSOR);
  const timer = setInterval(render, 1_000);
  timer.unref();
  const unsubscribe = app.events.subscribe(runId, render);
  render();

  try {
    const result = await completion;
    record = result;
    events = app.workflows.eventsView(runId);
    view = "activity";
    detailLines = undefined;
    notice = result.status === "completed"
      ? "All reviewers passed. Changes remain isolated for your review."
      : result.errorCode
        ? `Reason: ${result.errorCode}`
        : undefined;
    render();
    return result;
  } finally {
    clearInterval(timer);
    unsubscribe();
    stdin.off("keypress", onKeypress);
    stdout.off("resize", render);
    stdin.setRawMode(wasRaw);
    stdin.pause();
    stdout.write(`${SHOW_CURSOR}\n`);
  }
}

function provider(value: string, fallback: ProviderId): ProviderId {
  const normalized = value.trim().toLowerCase() as ProviderId;
  return providerIds.has(normalized) ? normalized : fallback;
}

async function askAssignment(
  rl: ReturnType<typeof createInterface>,
  app: AppContext,
  role: AgentAssignment["role"],
  fallback: ProviderId,
): Promise<AgentAssignment> {
  const selected = provider(await rl.question(`${role} provider [${fallback}]: `), fallback);
  const capabilities = app.providers.get(selected).capabilities;
  let authMode: AgentAssignment["authMode"] = "subscription";
  if (role !== "writer" && capabilities.apiConfigured) {
    const answer = (await rl.question(`${role} auth subscription/api [subscription]: `))
      .trim()
      .toLowerCase();
    if (answer === "api") authMode = "api";
  }
  if (!app.providers.canWrite(selected, authMode) && role === "writer") {
    throw new Error("WRITER_PROVIDER_IS_READ_ONLY");
  }
  const configuredModels = await app.providers.listModels(selected, authMode);
  const defaultModel =
    configuredModels[0] ??
    (selected === "fake"
      ? "fake"
      : selected === "claude"
        ? "sonnet"
        : selected === "grok"
          ? "grok-4.5"
      : "default");
  if (configuredModels.length > 0) {
    stdout.write(`${role} available models: ${configuredModels.map(sanitizeTerminal).join(", ")}\n`);
  }
  const model = (await rl.question(`${role} model [${defaultModel}]: `)).trim() || defaultModel;
  return { role, provider: selected, model, authMode };
}

const DEFAULT_NATURAL_LANGUAGE_TEAM = Object.freeze({
  planner: {
    role: "planner",
    provider: "codex",
    model: "gpt-5.6-sol",
    authMode: "subscription",
  } satisfies AgentAssignment,
  writer: {
    role: "writer",
    provider: "claude",
    model: "claude-fable-5",
    authMode: "subscription",
  } satisfies AgentAssignment,
  reviewer: {
    role: "reviewer",
    provider: "codex",
    model: "gpt-5.6-sol",
    authMode: "subscription",
  } satisfies AgentAssignment,
});

export function defaultNaturalLanguageTeam(): {
  planner: AgentAssignment;
  writer: AgentAssignment;
  reviewer: AgentAssignment;
} {
  return {
    planner: { ...DEFAULT_NATURAL_LANGUAGE_TEAM.planner },
    writer: { ...DEFAULT_NATURAL_LANGUAGE_TEAM.writer },
    reviewer: { ...DEFAULT_NATURAL_LANGUAGE_TEAM.reviewer },
  };
}

async function runAdvancedWorkflow(app: AppContext, options: { guiUrl?: string } = {}): Promise<void> {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error("TUI_REQUIRES_TTY");
  const rl = createInterface({ input: stdin, output: stdout, terminal: true });
  try {
    setupHeader("AI 協作工作區");
    const workspaceRoots = app.workspaces.roots();
    if (workspaceRoots.length === 0) {
      stdout.write(
        "尚未授權任何專案資料夾。為了安全，Orchestratory 不會讀取整個電腦。\n\n" +
          "請回到一般終端機執行：\n\n" +
          "  orchestrator workspaces allow \"/path/to/your/project\"\n\n",
      );
      return;
    }

    let workspace = workspaceRoots[0]!.path;
    if (workspaceRoots.length > 1) {
      setupStep(1, "選擇專案", "AI 只能讀取你已授權的專案。");
      for (const [index, root] of workspaceRoots.entries()) {
        stdout.write(`   ${index + 1}. ${sanitizeTerminal(root.label)}  \u001b[2m${sanitizeTerminal(root.path)}\u001b[0m\n`);
      }
      const workspaceAnswer = (await rl.question("\n   專案編號 [1]: ")).trim();
      const selectedIndex = /^\d+$/u.test(workspaceAnswer) ? Number(workspaceAnswer) - 1 : 0;
      workspace = workspaceRoots[selectedIndex]?.path ?? workspace;
    } else {
      stdout.write(
        `\u001b[2m專案\u001b[0m  ${sanitizeTerminal(workspaceRoots[0]!.label)}\n` +
          `\u001b[2m位置\u001b[0m  ${sanitizeTerminal(workspace)}\n`,
      );
    }
    stdout.write(
      `\u001b[2m主 AI\u001b[0m  Codex · GPT-5.6 Sol\n` +
        `\u001b[2m寫程式\u001b[0m  Claude · Fable 5\n` +
        `\u001b[2m審查\u001b[0m  Codex · GPT-5.6 Sol\n` +
        (options.guiUrl ? `\u001b[2mGUI\u001b[0m    ${options.guiUrl}\n` : "") +
        "\n",
    );

    setupStep(2, "直接告訴 AI 要做什麼", "不用指定角色或模型；需要寫檔時會使用安全分支。");
    const task = (await rl.question("   你想讓 AI 做什麼？ ")).trim();
    if (!task) {
      stdout.write("\n沒有輸入任務，因此沒有呼叫任何模型。\n");
      return;
    }

    const setupMode = (await rl.question("\n   直接使用安全預設；輸入 A 才開啟進階設定 [Enter]: ")).trim().toLowerCase();
    const advanced = setupMode === "a" || setupMode === "advanced";
    let profile: "normal" | "long" | "custom" = "normal";
    let softLimits: SoftLimits = { ...PROFILES.normal };
    const recoverable = app.store.listRecoverableCheckpoints();
    let restore: (typeof recoverable)[number] | undefined;
    let workspaceMode: WorkflowRequest["workspaceMode"] = "worktree";
    let worktreeConfirmed = true;
    const defaultTeam = defaultNaturalLanguageTeam();
    let planner: AgentAssignment = defaultTeam.planner;
    let writer: AgentAssignment = defaultTeam.writer;
    let reviewers: AgentAssignment[] = [defaultTeam.reviewer];
    let testProfileId: string | undefined;
    let testConfirmed = false;

    if (advanced) {
      setupStep(3, "執行時間", "1 標準、2 長時間、3 自訂；硬性安全上限永遠有效。");
      const profileAnswer = (await rl.question("   選擇 [1]: ")).trim().toLowerCase();
      profile = profileAnswer === "2" || profileAnswer === "long"
        ? "long"
        : profileAnswer === "3" || profileAnswer === "custom"
          ? "custom"
          : "normal";
      softLimits = profile === "custom"
        ? {
            maxRounds: Number(await rl.question("   最多回合：")),
            maxProviderCalls: Number(await rl.question("   最多模型呼叫：")),
            workflowTimeoutMs: Number(await rl.question("   整體分鐘數：")) * 60_000,
            providerTimeoutMs: Number(await rl.question("   單次模型分鐘數：")) * 60_000,
          }
        : { ...PROFILES[profile] };
    }

    if (advanced && recoverable.length > 0) {
      stdout.write("\nInterrupted runs with verified checkpoints:\n");
      for (const item of recoverable) {
        stdout.write(
          `  ${item.runId} — ${sanitizeTerminal(item.workspaceLabel)} — round ${item.round} — ${item.profile}\n`,
        );
      }
      const selectedRun = (await rl.question("Restore run ID [new workflow]: ")).trim();
      if (selectedRun) {
        restore = recoverable.find((item) => item.runId === selectedRun);
        if (!restore) throw new Error("CHECKPOINT_NOT_FOUND");
        if (restore.profile !== profile) throw new Error("CHECKPOINT_PROFILE_MISMATCH");
        stdout.write("Restore uses the exact workspace above in in-place mode and will verify its Git fingerprint.\n");
        if ((await rl.question("Type RESTORE to approve manual checkpoint restoration: ")) !== "RESTORE") {
          stdout.write("Cancelled before checkpoint restoration or provider calls.\n");
          return;
        }
      }
    }
    if (advanced) {
      setupStep(4, "檔案隔離", "1 安全分支（推薦）、2 直接操作（進階）。");
      const isolationAnswer = restore ? "2" : (await rl.question("   選擇 [1]: ")).trim().toLowerCase();
      workspaceMode = isolationAnswer === "2" || isolationAnswer === "in-place" ? "in-place" : "worktree";
      worktreeConfirmed = workspaceMode === "worktree";

      setupStep(5, "AI 團隊", "直接按 Enter 保留 Codex＋Claude＋Codex；輸入 C 才逐一自訂。");
      const teamAnswer = (await rl.question("   團隊 [預設]: ")).trim().toLowerCase();
      if (teamAnswer === "c" || teamAnswer === "custom") {
        planner = await askAssignment(rl, app, "planner", "codex");
        writer = await askAssignment(rl, app, "writer", "claude");
        const reviewer = await askAssignment(rl, app, "reviewer", "codex");
        reviewers = [reviewer];
        if (reviewer.authMode === "api") {
          stdout.write("API reviewer 只能補充；還需要一個訂閱模式 reviewer。\n");
          reviewers.push(await askAssignment(rl, app, "reviewer", "codex"));
          if (reviewers[1]?.authMode !== "subscription") throw new Error("SUBSCRIPTION_REVIEWER_REQUIRED");
        }
      }

      const testerProfiles = app.testers.profiles();
      if (testerProfiles.length > 0) {
      stdout.write("\nConfigured isolated test profiles:\n");
      for (const item of testerProfiles) {
        stdout.write(`  ${sanitizeTerminal(item.id)} — ${sanitizeTerminal(item.displayName)} (${item.runtime})\n`);
      }
      const selected = (await rl.question("Test profile ID [none]: ")).trim();
      if (selected) {
        if (!app.testers.hasProfile(selected)) throw new Error("TESTER_PROFILE_NOT_CONFIGURED");
        stdout.write("Tests run in a digest-pinned, offline, read-only container and may use local CPU/memory.\n");
        testConfirmed = (await rl.question("Type TEST to approve this test profile: ")) === "TEST";
        if (!testConfirmed) {
          stdout.write("Cancelled before test execution or provider calls.\n");
          return;
        }
        testProfileId = selected;
      }
      }
    }
    const assignments = [planner, writer, ...reviewers];
    const usesLive = assignments.some((item) => item.provider !== "fake");
    const usesApi = assignments.some((item) => item.authMode === "api");
    if (usesLive) {
      stdout.write(
        "\n\u001b[1m準備開始\u001b[0m\n" +
          `  專案：${sanitizeTerminal(workspace)}\n` +
          "  團隊：Codex GPT-5.6 Sol → Claude Fable 5 → Codex GPT-5.6 Sol\n" +
          `  限制：最多 ${softLimits.maxRounds} 回合／${softLimits.maxProviderCalls} 次模型呼叫\n` +
          (workspaceMode === "worktree" ? "  檔案：建立本機安全分支，不自動合併或上傳\n" : "  檔案：直接操作目前專案（進階）\n") +
          "  額度：會使用已登入的 Codex／Claude 訂閱額度\n\n",
      );
      const confirmation = await rl.question("輸入 RUN 開始；其他輸入都會取消：");
      if (confirmation !== "RUN") {
        stdout.write("已取消，沒有呼叫任何模型。\n");
        return;
      }
    }

    let apiMaxCostUsdPerCall = 0;
    let apiBudgetUsdPerRun = 0;
    let apiModeConfirmed = false;
    if (usesApi) {
      apiMaxCostUsdPerCall = Number(await rl.question("API maximum USD per call: "));
      apiBudgetUsdPerRun = Number(await rl.question("API maximum USD for this workflow: "));
      stdout.write("API mode transmits the task, bounded tracked diff, and bounded non-sensitive untracked text context to configured providers.\n");
      apiModeConfirmed = (await rl.question("Type API to confirm billed API calls: ")) === "API";
      if (!apiModeConfirmed) {
        stdout.write("Cancelled before any API call.\n");
        return;
      }
    }

    const workflow: WorkflowRequest = {
      workspace: await app.workflows.authorizeWorkspace(workspace, restore?.runId),
      workspaceMode,
      worktreeConfirmed,
      task,
      profile,
      planner,
      writer,
      reviewers,
      ...(testProfileId ? { testProfileId } : {}),
      testConfirmed,
      ...(restore
        ? { restoreRunId: restore.runId, restoreCheckpointId: restore.checkpointId }
        : {}),
      softLimits,
      apiModeConfirmed,
      apiMaxCostUsdPerCall,
      apiBudgetUsdPerRun,
    };
    if (workspaceMode === "worktree") {
      workflow.worktreeApproval = app.approvals.issue(
        "create-worktree",
        workflowApprovalScope(workflow, "create-worktree"),
        "local-tui",
      ).token;
    }
    if (usesApi) {
      workflow.apiApproval = app.approvals.issue(
        "use-api",
        workflowApprovalScope(workflow, "use-api"),
        "local-tui",
      ).token;
    }
    if (testProfileId) {
      workflow.testApproval = app.approvals.issue(
        "run-test",
        workflowApprovalScope(workflow, "run-test"),
        "local-tui",
      ).token;
    }
    if (restore) {
      workflow.restoreApproval = app.approvals.issue(
        "restore-checkpoint",
        checkpointApprovalScope(workflow, restore.runId, restore.checkpointId),
        "local-tui",
      ).token;
    }

    const { runId, completion } = await app.workflows.start(workflow);
    rl.close();
    await monitorRun({ app, runId, completion, workflow, assignments });
  } finally {
    rl.close();
    stdout.write(SHOW_CURSOR);
  }
}

async function chooseConversationWorkspace(
  app: AppContext,
  rl: ReturnType<typeof createInterface>,
): Promise<string | undefined> {
  const roots = app.workspaces.roots();
  if (roots.length === 0) {
    stdout.write(
      "尚未授權任何專案資料夾。為了安全，Orchestratory 不會讀取整台電腦。\n\n" +
        "請回到一般終端機執行：\n\n" +
        '  orchestrator workspaces allow "/path/to/your/project"\n',
    );
    return undefined;
  }
  if (roots.length === 1) return roots[0]!.path;
  stdout.write("請選擇這個對話可以操作的專案：\n");
  for (const [index, root] of roots.entries()) {
    stdout.write(`  ${index + 1}. ${sanitizeTerminal(root.label)}  ${sanitizeTerminal(root.path)}\n`);
  }
  const answer = (await rl.question("專案編號 [1]：")).trim();
  const selected = /^\d+$/u.test(answer) ? Number(answer) - 1 : 0;
  return roots[selected]?.path ?? roots[0]!.path;
}

async function chooseConversationRoom(
  ledger: RoomLedger,
  workspace: string,
  rl: ReturnType<typeof createInterface>,
): Promise<RoomInfo> {
  const rooms = ledger.listRooms().filter((room) => room.workspace === workspace);
  if (rooms.length <= 1) return selectTuiRoom(ledger, workspace);
  stdout.write("這個專案有多個 Room，請選擇本次 TUI 要寫入的帳本：\n");
  for (const [index, room] of rooms.entries()) {
    stdout.write(`  ${index + 1}. ${sanitizeTerminal(room.id)} · ${room.messages} 則 · ${room.recording}\n`);
  }
  const answer = (await rl.question("Room 編號 [1]：")).trim();
  const selected = /^\d+$/u.test(answer) ? Number(answer) - 1 : 0;
  return selectTuiRoom(ledger, workspace, rooms[selected]?.id ?? rooms[0]!.id);
}

export interface ConversationCommandOutcome {
  exit: boolean;
  openAdvanced: boolean;
  lines: string[];
}

/**
 * Pure-ish dispatch for the conversation slash commands. Side effects are
 * limited to the injected session (setMainAgent/clear); all user-facing text is
 * returned as lines so the loop — and tests — can drive it without a terminal.
 */
export function runConversationCommand(
  input: string,
  session: NaturalLanguageSession,
  options: { guiUrl?: string; maxProviderCalls: number },
): ConversationCommandOutcome {
  const command = input.toLowerCase().split(/\s+/u)[0];
  const lines: string[] = [];
  if (command === "/exit" || command === "/quit") return { exit: true, openAdvanced: false, lines };
  if (command === "/help") lines.push(...conversationHelpLines());
  else if (command === "/agents") lines.push(...agentsLines(session));
  else if (command === "/model") {
    const parts = input.split(/\s+/u).slice(1);
    if (parts.length === 0) {
      const current = session.status().mainAgent;
      lines.push(
        `主代理：${current.provider} · ${sanitizeTerminal(current.model)}`,
        "切換：/model <provider> <model>（provider 為 codex、claude、grok 或 fake）",
        "例如：/model claude claude-fable-5 · 切換後對話歷史保留。",
      );
    } else if (parts.length !== 2 || !parts[0] || !parts[1]) {
      lines.push("用法：/model <provider> <model>，例如 /model claude claude-fable-5");
    } else {
      try {
        const switched = session.setMainAgent({ provider: parts[0], model: parts[1] });
        lines.push(`主代理已切換為 ${switched.provider} · ${sanitizeTerminal(switched.model)}；對話歷史與呼叫計數保留。`);
      } catch (error) {
        lines.push(`無法切換主代理：${sanitizeTerminal(error instanceof Error ? error.message : "UNKNOWN_ERROR")}`);
      }
    }
  } else if (command === "/status") {
    const status = session.status();
    lines.push(
      `session ${status.id.slice(0, 8)} · ${status.turns} 回合 · ` +
        `${status.providerCalls}/${options.maxProviderCalls} 次模型呼叫 · ${status.historyBytes} bytes 暫存內容`,
    );
  } else if (command === "/new" || command === "/clear") {
    session.clear();
    lines.push("已清除 RAM 中的對話內容；模型呼叫計數不會重設。");
  } else if (command === "/gui") {
    lines.push(options.guiUrl ? `GUI：${options.guiUrl}` : "此模式沒有啟動 GUI。");
  } else if (command === "/advanced") {
    return { exit: false, openAdvanced: true, lines };
  } else {
    lines.push("未知指令；輸入 /help 查看可用指令。");
  }
  return { exit: false, openAdvanced: false, lines };
}

function conversationHelpLines(): string[] {
  return [
    "直接輸入自然語言即可與 Orchestrator 對話。只有本機指令使用斜線：",
    "  /help      顯示這份說明",
    "  /agents    顯示主代理與可用 sub-agent tools",
    "  /model     查看或切換主代理（/model <provider> <model>，歷史保留）",
    "  /status    顯示 session 用量與硬性上限",
    "  /new       清除目前的暫存對話內容",
    "  /gui       顯示本機 GUI 位址",
    "  /advanced  開啟完整 workflow 設定精靈",
    "  /exit      結束 Orchestrator",
    "訊息開頭用 @codex、@claude、@grok 可單輪指定模型直答（唯讀）；多個 @ 會並排比稿。",
  ];
}

function agentsLines(session: NaturalLanguageSession): string[] {
  const status = session.status();
  const lines = [`主代理  ${status.mainAgent.provider} · ${status.mainAgent.model}（唯讀對話/router）`];
  for (const tool of status.tools) {
    lines.push(`工具    ${tool.name}${tool.requiresApproval ? " · 寫檔前需 RUN" : " · 自動唯讀"}`);
    lines.push(`        ${sanitizeTerminal(tool.description)}`);
  }
  return lines;
}

function printConversationHelp(): void {
  stdout.write(
    "\n直接輸入自然語言即可與 Orchestrator 對話。只有本機指令使用斜線：\n" +
      "  /help      顯示這份說明\n" +
      "  /agents    顯示主代理與可用 sub-agent tools\n" +
      "  /model     查看或切換主代理（/model <provider> <model>，歷史保留）\n" +
      "  /status    顯示 session 用量與硬性上限\n" +
      "  /new       清除目前的暫存對話內容\n" +
      "  /gui       顯示本機 GUI 位址\n" +
      "  /advanced  開啟完整 workflow 設定精靈\n" +
      "  /exit      結束 Orchestrator\n" +
      "\n訊息開頭用 @codex、@claude、@grok 可單輪指定模型直答（唯讀）；\n" +
      "多個 @ 會並排比稿（最多 3 個），@claude:model-id 可指定模型。\n",
  );
}

function printAgents(session: NaturalLanguageSession): void {
  const status = session.status();
  stdout.write(
    `\n主代理  ${status.mainAgent.provider} · ${status.mainAgent.model}（唯讀對話/router）\n`,
  );
  for (const tool of status.tools) {
    stdout.write(
      `工具    ${tool.name}${tool.requiresApproval ? " · 寫檔前需 RUN" : " · 自動唯讀"}\n` +
        `        ${sanitizeTerminal(tool.description)}\n`,
    );
  }
}

async function runDefaultCodingTeam(
  app: AppContext,
  workspace: string,
  task: string,
  rl: ReturnType<typeof createInterface>,
  room?: { ledger: RoomLedger; id: string },
): Promise<void> {
  const team = defaultNaturalLanguageTeam();
  const assignments = [team.planner, team.writer, team.reviewer];
  const limits = { ...PROFILES.normal };
  stdout.write(
    "\nOrchestrator 建議啟動 coding team：\n" +
      `  任務：${sanitizeTerminal(task)}\n` +
      "  團隊：Codex GPT-5.6 Sol → Claude Fable 5 → Codex GPT-5.6 Sol\n" +
      `  上限：${limits.maxRounds} 回合／${limits.maxProviderCalls} 次模型呼叫\n` +
      "  檔案：建立本機隔離 worktree；不自動合併、不 commit、不上傳\n" +
      "  額度：使用目前登入的 Codex／Claude 訂閱額度\n\n",
  );
  if ((await rl.question("輸入 RUN 才執行；按 Enter 取消：")) !== "RUN") {
    stdout.write("已取消 coding team；對話 session 保持開啟。\n");
    room?.ledger.appendSystem(room.id, "TUI coding team 提案已由 Leader 取消");
    return;
  }
  const workflow: WorkflowRequest = {
    workspace: await app.workflows.authorizeWorkspace(workspace),
    workspaceMode: "worktree",
    worktreeConfirmed: true,
    task,
    profile: "normal",
    planner: team.planner,
    writer: team.writer,
    reviewers: [team.reviewer],
    testConfirmed: false,
    softLimits: limits,
    apiModeConfirmed: false,
    apiMaxCostUsdPerCall: 0,
    apiBudgetUsdPerRun: 0,
  };
  workflow.worktreeApproval = app.approvals.issue(
    "create-worktree",
    workflowApprovalScope(workflow, "create-worktree"),
    "local-tui",
  ).token;
  const { runId, completion } = await app.workflows.start(workflow);
  room?.ledger.appendSystem(room.id, `TUI coding team 已由 Leader 核准啟動（run ${runId}）`);
  rl.pause();
  let result: RunRecord;
  try {
    result = await monitorRun({ app, runId, completion, workflow, assignments });
  } finally {
    rl.resume();
  }
  room?.ledger.appendSystem(
    room.id,
    `TUI coding team run ${runId} ${result.status === "completed" ? "已完成，成果仍在隔離 worktree 等待審核" : `結束：${result.errorCode ?? result.status}`}`,
  );
  stdout.write("\nCoding team 已結束；你可以繼續原本的對話。\n");
}

export async function runTui(app: AppContext, options: { guiUrl?: string } = {}): Promise<void> {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error("TUI_REQUIRES_TTY");
  let rl = createInterface({ input: stdin, output: stdout, terminal: true });
  let ledger: RoomLedger | undefined;
  try {
    setupHeader("Orchestrator 對話 session");
    const workspace = await chooseConversationWorkspace(app, rl);
    if (!workspace) return;
    ledger = new RoomLedger(app.store.dataDirectory);
    const room = await chooseConversationRoom(ledger, workspace, rl);
    const session = new NaturalLanguageSession({
      providers: app.providers,
      workspace,
      hardLimits: app.hardLimits,
      context: new SessionContextBroker(workspace),
    });
    stdout.write(
      `\u001b[2m專案\u001b[0m  ${sanitizeTerminal(workspace)}\n` +
        `\u001b[2mRoom\u001b[0m  ${sanitizeTerminal(room.id)} · 共用帳本已啟用\n` +
        `\u001b[2m主代理\u001b[0m  ${session.status().mainAgent.provider} · ${sanitizeTerminal(session.status().mainAgent.model)}（訂閱模式，/model 可切換）\n` +
        `\u001b[2m工具\u001b[0m  ${sessionTools().map((tool) => tool.name).join(", ")}\n` +
        (options.guiUrl ? `\u001b[2mGUI\u001b[0m     ${options.guiUrl}\n` : "") +
        "\n直接輸入任何問題或任務。一般文字會使用主代理的訂閱額度；它可讀取受限的專案檔案，需要時自動詢問 Claude。\n" +
        "輸入 /help 查看本機指令；輸入 /exit 離開。\n",
    );

    while (true) {
      const raw = await rl.question("\n\u001b[36m你 ›\u001b[0m ");
      const input = raw.trim();
      if (!input) continue;
      if (input.startsWith("/")) {
        const outcome = runConversationCommand(input, session, {
          ...(options.guiUrl ? { guiUrl: options.guiUrl } : {}),
          maxProviderCalls: app.hardLimits.maxProviderCalls,
        });
        if (outcome.lines.length > 0) stdout.write(`\n${outcome.lines.join("\n")}\n`);
        if (outcome.exit) break;
        if (outcome.openAdvanced) {
          rl.close();
          try {
            await runAdvancedWorkflow(app, options);
          } catch (error) {
            const reason = error instanceof Error ? error.message : "UNKNOWN_WORKFLOW_ERROR";
            stdout.write(`\n\u5de5\u4f5c\u6d41\u672a\u80fd\u958b\u59cb\uff1a${sanitizeTerminal(reason)}\n`);
          }
          rl = createInterface({ input: stdin, output: stdout, terminal: true });
          stdout.write("\n\u5df2\u56de\u5230\u5c0d\u8a71\uff1b\u6b77\u53f2\u8207\u547c\u53eb\u8a08\u6578\u4fdd\u7559\uff0c\u8f38\u5165 /help \u67e5\u770b\u6307\u4ee4\u3002\n");
        }
        continue;
      }

      try {
        ledger.append(room.id, "you", input);
        stdout.write("\u001b[2mOrchestrator 正在思考…\u001b[0m\r");
        const decision = await session.turn(input);
        recordTuiDecision(ledger, room.id, decision);
        stdout.write("\u001b[2K\r");
        if (decision.kind === "message") {
          const label = decision.model
            ? `${decision.source} · ${decision.model}`
            : decision.source;
          stdout.write(`\n\u001b[35m${sanitizeTerminal(label)} ›\u001b[0m ${sanitizeTerminal(decision.message)}\n`);
        } else if (decision.kind === "compare") {
          for (const answer of decision.answers) {
            stdout.write(
              `\n\u001b[35m@${answer.provider} · ${sanitizeTerminal(answer.model)} ›\u001b[0m ${sanitizeTerminal(answer.message)}\n`,
            );
          }
        } else {
          await runDefaultCodingTeam(app, workspace, decision.input, rl, { ledger, id: room.id });
        }
      } catch (error) {
        stdout.write("\u001b[2K\r");
        const reason = error instanceof Error ? error.message : "UNKNOWN_SESSION_ERROR";
        try { ledger.appendSystem(room.id, `TUI 對話回合失敗：${reason}`); } catch { /* preserve original failure */ }
        stdout.write(`\n無法完成這一輪：${sanitizeTerminal(reason)}\n`);
      }
    }
    stdout.write("\nOrchestrator session 已結束；RAM 上下文已清除，Room 帳本仍完整保留。\n");
  } finally {
    ledger?.close();
    rl.close();
    stdout.write(SHOW_CURSOR);
  }
}
