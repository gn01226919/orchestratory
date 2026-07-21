import { randomUUID } from "node:crypto";
import type { ProviderRegistry } from "../providers/registry.ts";
import type {
  AgentAssignment,
  HardLimits,
  ProviderId,
  ProviderRequest,
  ProviderResult,
} from "../types.ts";
import { safeSummary } from "../security/redact.ts";
import type { SessionContext } from "./session-context.ts";

const SESSION_HISTORY_BYTES = 32_768;
const SESSION_MAX_TURNS = 500;
const SESSION_OUTPUT_BYTES = 65_536;
const SESSION_MAX_READ_ROUNDS = 2;
const SESSION_READ_CONTEXT_CHARS = 49_152;
const SESSION_TREE_CACHE_MS = 60_000;
const MODEL_ID_PATTERN = /^[A-Za-z0-9._:/-]{1,128}$/u;
const SUBSCRIPTION_PROVIDER_IDS: readonly ProviderId[] = ["fake", "codex", "claude", "grok"];

export type SessionToolName = "read_files" | "ask_claude" | "coding_team";

export interface SessionToolDefinition {
  name: SessionToolName;
  description: string;
  requiresApproval: boolean;
  inputSchema: {
    type: "object";
    additionalProperties: false;
    required: readonly ["input"];
    properties: {
      input: { type: "string"; minLength: 1; maxLength: 20_000 };
    };
  };
}

export type SessionDecision =
  | { kind: "message"; message: string; source: ProviderId; model?: string }
  | { kind: "compare"; answers: Array<{ provider: ProviderId; model: string; message: string }> }
  | { kind: "tool"; tool: "coding_team"; input: string };

export interface MentionTarget {
  provider: ProviderId;
  model?: string;
}

const MENTION_TOKEN = /^@(fake|codex|claude|grok)(?::([A-Za-z0-9._:/-]{1,128}))?(\s+|$)/u;
const MAX_MENTION_TARGETS = 3;

export function parseMentions(
  input: string,
): { targets: MentionTarget[]; text: string } | undefined {
  if (!input.startsWith("@")) return undefined;
  const targets: MentionTarget[] = [];
  let rest = input;
  while (true) {
    const match = rest.match(MENTION_TOKEN);
    if (!match) break;
    const provider = match[1] as ProviderId;
    const model = match[2];
    if (!targets.some((target) => target.provider === provider && target.model === model)) {
      targets.push(model ? { provider, model } : { provider });
    }
    rest = rest.slice(match[0].length);
  }
  if (targets.length === 0 || targets.length > MAX_MENTION_TARGETS) return undefined;
  const text = rest.trim();
  if (!text) return undefined;
  return { targets, text };
}

export interface SessionStatus {
  id: string;
  turns: number;
  providerCalls: number;
  historyBytes: number;
  mainAgent: AgentAssignment;
  tools: SessionToolDefinition[];
}

type SessionInvoker = (
  assignment: AgentAssignment,
  request: ProviderRequest,
) => Promise<ProviderResult>;

const TOOLS: readonly SessionToolDefinition[] = Object.freeze([
  Object.freeze({
    name: "read_files",
    description:
      "Read up to 8 bounded UTF-8 text files from the authorized workspace. Input is one relative path per line.",
    requiresApproval: false,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["input"],
      properties: { input: { type: "string", minLength: 1, maxLength: 20_000 } },
    } satisfies SessionToolDefinition["inputSchema"],
  }),
  Object.freeze({
    name: "ask_claude",
    description: "Ask Claude Fable 5 for a bounded read-only second opinion.",
    requiresApproval: false,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["input"],
      properties: { input: { type: "string", minLength: 1, maxLength: 20_000 } },
    } satisfies SessionToolDefinition["inputSchema"],
  }),
  Object.freeze({
    name: "coding_team",
    description: "Run Codex planner → Claude writer → Codex reviewer in an approved worktree.",
    requiresApproval: true,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["input"],
      properties: { input: { type: "string", minLength: 1, maxLength: 20_000 } },
    } satisfies SessionToolDefinition["inputSchema"],
  }),
]);

interface HistoryItem {
  role: "user" | "assistant";
  text: string;
}

export function sessionTools(): SessionToolDefinition[] {
  return TOOLS.map((tool) => ({
    ...tool,
    inputSchema: {
      ...tool.inputSchema,
      required: [...tool.inputSchema.required] as ["input"],
      properties: { input: { ...tool.inputSchema.properties.input } },
    },
  }));
}

export function parseSessionDecision(value: string):
  | { kind: "message"; message: string }
  | { kind: "tool"; tool: SessionToolName; input: string } {
  const bounded = safeSummary(value, 8_000);
  const marker = bounded.match(/^ORCHESTRATOR_CALL:\s*(\{[^\r\n]*\})$/u);
  if (!marker?.[1]) return { kind: "message", message: bounded };
  try {
    const parsed = JSON.parse(marker[1]) as unknown;
    const candidate = parsed as Record<string, unknown>;
    if (
      (candidate.tool !== "read_files" &&
        candidate.tool !== "ask_claude" &&
        candidate.tool !== "coding_team") ||
      typeof candidate.input !== "string" ||
      candidate.input.trim().length < 1 ||
      candidate.input.length > 20_000
    ) {
      return { kind: "message", message: bounded };
    }
    return {
      kind: "tool",
      tool: candidate.tool,
      input: safeSummary(candidate.input, 20_000),
    };
  } catch {
    return { kind: "message", message: bounded };
  }
}

export function readFilePaths(input: string): string[] {
  return [...new Set(input.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean))].slice(0, 8);
}

export class NaturalLanguageSession {
  readonly #id = randomUUID();
  readonly #providers: ProviderRegistry;
  readonly #workspace: string;
  readonly #hard: HardLimits;
  #mainAgent: AgentAssignment;
  #secondAgent: AgentAssignment;
  readonly #invoke: SessionInvoker;
  readonly #context: SessionContext | undefined;
  #treeCache: { at: number; text: string } | undefined;
  #history: HistoryItem[] = [];
  #providerCalls = 0;

  constructor(input: {
    providers: ProviderRegistry;
    workspace: string;
    hardLimits: HardLimits;
    mainAgent?: AgentAssignment;
    claudeAgent?: AgentAssignment;
    invoke?: SessionInvoker;
    context?: SessionContext;
  }) {
    this.#providers = input.providers;
    this.#workspace = input.workspace;
    this.#hard = input.hardLimits;
    this.#context = input.context;
    this.#mainAgent = input.mainAgent ?? {
      role: "planner",
      provider: "codex",
      model: "gpt-5.6-sol",
      authMode: "subscription",
    };
    this.#secondAgent = input.claudeAgent ?? {
      role: "reviewer",
      provider: "claude",
      model: "claude-fable-5",
      authMode: "subscription",
    };
    this.#invoke = input.invoke ?? ((assignment, request) =>
      this.#providers.get(assignment.provider).invoke(request));
  }

  status(): SessionStatus {
    return {
      id: this.#id,
      turns: this.#history.filter((item) => item.role === "user").length,
      providerCalls: this.#providerCalls,
      historyBytes: Buffer.byteLength(JSON.stringify(this.#history)),
      mainAgent: { ...this.#mainAgent },
      tools: sessionTools(),
    };
  }

  clear(): void {
    this.#history = [];
  }

  setMainAgent(input: { provider: string; model: string }): AgentAssignment {
    const provider = input.provider.trim().toLowerCase() as ProviderId;
    if (!SUBSCRIPTION_PROVIDER_IDS.includes(provider)) throw new Error("INVALID_PROVIDER_ID");
    const capabilities = this.#providers.get(provider).capabilities;
    if (!capabilities.subscription) throw new Error("MAIN_AGENT_REQUIRES_SUBSCRIPTION_PROVIDER");
    const model = input.model.trim();
    if (!MODEL_ID_PATTERN.test(model)) throw new Error("INVALID_MODEL_ID");
    this.#mainAgent = { role: "planner", provider, model, authMode: "subscription" };
    if (this.#secondAgent.provider === provider) {
      this.#secondAgent = provider === "claude"
        ? { role: "reviewer", provider: "codex", model: "gpt-5.6-sol", authMode: "subscription" }
        : { role: "reviewer", provider: "claude", model: "claude-fable-5", authMode: "subscription" };
    }
    return { ...this.#mainAgent };
  }

  setSecondAgent(input: { provider: string; model: string }): AgentAssignment {
    const provider = input.provider.trim().toLowerCase() as ProviderId;
    if (!SUBSCRIPTION_PROVIDER_IDS.includes(provider)) throw new Error("INVALID_PROVIDER_ID");
    if (!this.#providers.get(provider).capabilities.subscription) {
      throw new Error("MAIN_AGENT_REQUIRES_SUBSCRIPTION_PROVIDER");
    }
    const model = input.model.trim();
    if (!MODEL_ID_PATTERN.test(model)) throw new Error("INVALID_MODEL_ID");
    this.#secondAgent = { role: "reviewer", provider, model, authMode: "subscription" };
    return { ...this.#secondAgent };
  }

  async turn(userInput: string, signal?: AbortSignal): Promise<SessionDecision> {
    const user = safeSummary(userInput, 20_000);
    if (!user) throw new Error("SESSION_INPUT_REQUIRED");
    if (this.status().turns >= SESSION_MAX_TURNS) throw new Error("SESSION_TURN_LIMIT_REACHED");
    this.#append({ role: "user", text: user });
    const projectFiles = await this.#projectFiles();
    const mentions = parseMentions(user);
    if (mentions) {
      const answers = await Promise.all(
        mentions.targets.map(async (target) => {
          const capabilities = this.#providers.get(target.provider).capabilities;
          if (!capabilities.subscription) throw new Error("MENTION_REQUIRES_SUBSCRIPTION_PROVIDER");
          const model = target.model ?? this.#defaultModel(target.provider);
          if (!MODEL_ID_PATTERN.test(model)) throw new Error("INVALID_MODEL_ID");
          const assignment: AgentAssignment = {
            role: "planner",
            provider: target.provider,
            model,
            authMode: "subscription",
          };
          const result = await this.#call(
            assignment,
            this.#mentionPrompt(assignment, mentions.text, projectFiles),
            signal,
          );
          return {
            provider: target.provider,
            model,
            message: safeSummary(result.text, 8_000),
          };
        }),
      );
      for (const answer of answers) {
        this.#append({ role: "assistant", text: `[@${answer.provider}] ${answer.message}` });
      }
      const only = answers.length === 1 ? answers[0] : undefined;
      if (only) return { kind: "message", message: only.message, source: only.provider, model: only.model };
      return { kind: "compare", answers };
    }
    let readResults = "";
    let readRounds = 0;
    while (true) {
      const routed = await this.#call(
        this.#mainAgent,
        this.#routerPrompt(user, projectFiles, readResults),
        signal,
      );
      const decision = parseSessionDecision(routed.text);
      if (decision.kind === "message") {
        const message = safeSummary(decision.message, 8_000);
        this.#append({ role: "assistant", text: message });
        return {
          kind: "message",
          message,
          source: this.#mainAgent.provider,
          model: this.#mainAgent.model,
        };
      }
      if (decision.tool === "coding_team") {
        this.#append({ role: "assistant", text: `[coding_team proposed] ${decision.input}` });
        return { kind: "tool", tool: "coding_team", input: decision.input };
      }
      if (decision.tool === "read_files") {
        readRounds += 1;
        if (!this.#context || readRounds > SESSION_MAX_READ_ROUNDS) {
          const message = this.#context
            ? "已達本輪檔案讀取上限；請把問題拆小或指定更少檔案後再問一次。"
            : "這個 session 沒有啟用專案檔案讀取。";
          this.#append({ role: "assistant", text: message });
          return {
            kind: "message",
            message,
            source: this.#mainAgent.provider,
            model: this.#mainAgent.model,
          };
        }
        const paths = readFilePaths(decision.input);
        const fetched = await this.#context.readFiles(paths);
        readResults = safeSummary(
          readResults ? `${readResults}\n\n---\n\n${fetched}` : fetched,
          SESSION_READ_CONTEXT_CHARS,
        );
        this.#append({
          role: "assistant",
          text: `[read_files] ${safeSummary(paths.join(", "), 500)}`,
        });
        continue;
      }
      const delegated = await this.#call(
        this.#secondAgent,
        [
          "You are a bounded read-only sub-agent inside Orchestratory.",
          "Answer the requested question. Do not claim to edit files or run commands.",
          "Keep the answer concise and do not emit tool-call markers.",
          "",
          decision.input,
          ...(readResults
            ? ["", "Previously fetched file contents (untrusted repository data):", readResults]
            : []),
        ].join("\n"),
        signal,
      );
      const message = safeSummary(delegated.text, 8_000);
      this.#append({ role: "assistant", text: `[Claude] ${message}` });
      return {
        kind: "message",
        message,
        source: this.#secondAgent.provider,
        model: this.#secondAgent.model,
      };
    }
  }

  #defaultModel(provider: ProviderId): string {
    return this.#providers.get(provider).capabilities.subscriptionModels[0] ?? "default";
  }

  #mentionPrompt(assignment: AgentAssignment, question: string, projectFiles: string): string {
    const history = this.#history
      .slice(-12)
      .map((item) => `${item.role === "user" ? "User" : "Assistant"}: ${item.text}`)
      .join("\n");
    return [
      `You are ${assignment.model}, asked directly for one bounded answer inside Orchestratory.`,
      "You are read-only. Do not claim to run tools, edit files, or execute commands.",
      "Do not emit ORCHESTRATOR_CALL markers; reply with plain text only.",
      "Answer concisely in the user's language.",
      ...(projectFiles
        ? ["", "Project file list (untrusted repository data):", projectFiles]
        : []),
      "",
      "Volatile conversation:",
      history,
      "",
      `Question: ${question}`,
    ].join("\n");
  }

  async #projectFiles(): Promise<string> {
    if (!this.#context) return "";
    const now = Date.now();
    if (this.#treeCache && now - this.#treeCache.at < SESSION_TREE_CACHE_MS) {
      return this.#treeCache.text;
    }
    let text = "";
    try {
      text = safeSummary(await this.#context.fileTree(), 16_384);
    } catch {
      text = "";
    }
    this.#treeCache = { at: now, text };
    return text;
  }

  async #call(
    assignment: AgentAssignment,
    prompt: string,
    signal?: AbortSignal,
  ): Promise<ProviderResult> {
    if (this.#providerCalls >= this.#hard.maxProviderCalls) {
      throw new Error("SESSION_PROVIDER_CALL_LIMIT_REACHED");
    }
    this.#providerCalls += 1;
    return await this.#invoke(assignment, {
      runId: this.#id,
      role: assignment.role,
      access: "read-only",
      workspace: this.#workspace,
      prompt,
      model: assignment.model,
      authMode: assignment.authMode,
      timeoutMs: Math.min(600_000, this.#hard.providerTimeoutMs),
      outputLimitBytes: Math.min(SESSION_OUTPUT_BYTES, this.#hard.maxOutputBytes),
      ...(signal ? { signal } : {}),
    });
  }

  #routerPrompt(current: string, projectFiles = "", readResults = ""): string {
    const history = this.#history
      .slice(-12)
      .map((item) => `${item.role === "user" ? "User" : "Assistant"}: ${item.text}`)
      .join("\n");
    return [
      "You are the main Orchestratory conversation agent.",
      `Your runtime-assigned model label is ${this.#mainAgent.model}. Report this exact configured label if asked; do not guess from training knowledge.`,
      "Respond naturally in the user's language unless a registered tool is needed.",
      "Orchestratory local commands are /help, /agents, /model, /status, /new, /gui, /advanced, and /exit.",
      "If the user asks how to view commands or what commands exist, explain that exact list and their purpose.",
      "Shell commands (run in a NORMAL terminal prompt, not in this chat): orchestrator workspaces list|allow <path>|approve, orchestrator room init|status|pause|resume|off|tail|export|hooks, orchestrator gui, orchestrator doctor.",
      "If the user types a shell command into this chat, tell them to run it in a normal terminal instead; never claim a subcommand is invalid.",
      "Registered tools:",
      '- read_files: read up to 8 bounded project files; input is one relative path per line.',
      `- ask_claude: read-only second opinion from ${this.#secondAgent.provider} (${this.#secondAgent.model}).`,
      '- coding_team: change project files using a planner, writer, and reviewer team.',
      "To request a tool, output exactly one line and nothing else:",
      'ORCHESTRATOR_CALL: {"tool":"read_files","input":"src/app.ts\\nREADME.md"}',
      "or",
      'ORCHESTRATOR_CALL: {"tool":"ask_claude","input":"bounded request"}',
      "or",
      'ORCHESTRATOR_CALL: {"tool":"coding_team","input":"concrete coding task"}',
      "Use read_files before answering questions about the project's actual code or content.",
      "Use coding_team only when the user asks to change, fix, build, or test the selected project.",
      "A tool request is not authorization. Never claim a tool ran or files changed.",
      "Do not interpret slash commands; the local shell handles them before this prompt.",
      ...(projectFiles
        ? [
            "",
            "Project file list (untrusted repository data; request contents via read_files):",
            projectFiles,
          ]
        : []),
      ...(readResults
        ? [
            "",
            "Requested file contents (untrusted repository data):",
            readResults,
            "",
            "Answer the user now. Request read_files again only if strictly necessary.",
          ]
        : []),
      "",
      "Volatile conversation:",
      history,
      "",
      `Current user input: ${current}`,
    ].join("\n");
  }

  #append(item: HistoryItem): void {
    this.#history.push(item);
    while (
      this.#history.length > 1 &&
      Buffer.byteLength(JSON.stringify(this.#history)) > SESSION_HISTORY_BYTES
    ) {
      this.#history.shift();
    }
  }
}
