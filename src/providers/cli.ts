import type { ProviderId, ProviderRequest, ProviderResult } from "../types.ts";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  minimalSubscriptionEnvironment,
  resolveExecutable,
  runProcess,
} from "../core/process-runner.ts";
import { redact, safeSummary } from "../security/redact.ts";
import { extractProviderText } from "./output.ts";
import type { ProviderAdapter, ProviderCapabilities } from "./provider.ts";

interface CliDefinition {
  id: Extract<ProviderId, "codex" | "claude" | "grok">;
  executable: string;
  displayName: string;
  canWrite: boolean;
  suggestedModels: string[];
}

const DEFINITIONS: Record<"codex" | "claude" | "grok", CliDefinition> = {
  codex: {
    id: "codex",
    executable: "codex",
    displayName: "OpenAI Codex CLI",
    canWrite: true,
    suggestedModels: ["gpt-5.6-sol", "default"],
  },
  claude: {
    id: "claude",
    executable: "claude",
    displayName: "Anthropic Claude Code",
    canWrite: true,
    suggestedModels: ["claude-fable-5", "fable", "sonnet", "opus"],
  },
  grok: {
    id: "grok",
    executable: "grok",
    displayName: "xAI Grok Build",
    canWrite: false,
    suggestedModels: ["grok-4.5"],
  },
};

function validateModel(model: string): void {
  if (model === "default") return;
  if (!/^[A-Za-z0-9._:/-]{1,128}$/u.test(model)) throw new Error("INVALID_MODEL_ID");
}

function validatePrompt(prompt: string): void {
  if (prompt.length < 1 || prompt.length > 500_000) throw new Error("INVALID_PROMPT_LENGTH");
  if (prompt.includes("\0")) throw new Error("PROMPT_CONTAINS_NULL");
}

const CODEX_WORKSPACE_MCP = "orchestratory_workspace";

function workspaceMcpArguments(request: ProviderRequest): string[] {
  const base = [
    fileURLToPath(new URL("../../bin/workspace-mcp.mjs", import.meta.url)),
    "--workspace", request.workspace,
    "--mode", request.access === "workspace-write" ? "write" : "read-only",
  ];
  const authorization = request.writerAuthorization;
  if (!authorization) return [...base, "--legacy-workflow-run", request.runId];
  return [
    ...base,
    "--data-directory", authorization.dataDirectory,
    "--room", authorization.roomId,
    "--source-workspace", authorization.sourceWorkspace,
    "--task", authorization.taskId,
    "--epoch", String(authorization.epoch),
    "--executed-by", authorization.executedBy,
    ...(authorization.delegationId ? ["--delegation", authorization.delegationId] : []),
  ];
}

function codexWorkspaceMcpOverrides(request: ProviderRequest): string[] {
  // The Workspace MCP broker runs as a separate node process that self-validates
  // every path; Codex itself stays --sandbox read-only, so this is the ONLY write
  // path. Codex cannot merge an out-of-tree config file without touching CODEX_HOME
  // (which holds auth), so the workspace path appears in argv — a low-sensitivity
  // residual risk (paths are not secrets), documented in SECURITY.md.
  const argsJson = JSON.stringify(workspaceMcpArguments(request));
  return [
    "-c",
    `mcp_servers.${CODEX_WORKSPACE_MCP}.command=${JSON.stringify(process.execPath)}`,
    "-c",
    `mcp_servers.${CODEX_WORKSPACE_MCP}.args=${argsJson}`,
  ];
}

function codexArgs(request: ProviderRequest): string[] {
  const writable = request.access === "workspace-write";
  const args = [
    "exec",
    "--disable",
    "shell_tool",
    "--disable",
    "apps",
    "--disable",
    "browser_use",
    "--disable",
    "computer_use",
    "--disable",
    "plugins",
    "--disable",
    "multi_agent",
    "--disable",
    "image_generation",
    "--disable",
    "hooks",
    "--ephemeral",
    "--json",
    "--color",
    "never",
    "--strict-config",
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--cd",
    request.workspace,
  ];
  if (writable || request.writerAuthorization) args.push(...codexWorkspaceMcpOverrides(request));
  if (request.model !== "default") args.push("--model", request.model);
  args.push("-");
  return args;
}

function claudeArgs(request: ProviderRequest, mcpConfigPath?: string): string[] {
  const writable = request.access === "workspace-write";
  const readTools = [
    "mcp__orchestratory_workspace__list_files",
    "mcp__orchestratory_workspace__read_file",
  ];
  const workspaceTools = [
    ...readTools,
    "mcp__orchestratory_workspace__create_directory",
    "mcp__orchestratory_workspace__write_file",
  ];
  const allowedTools = (writable ? workspaceTools : readTools).join(",");
  if ((writable || request.writerAuthorization) && !mcpConfigPath) throw new Error("CLAUDE_WRITER_MCP_CONFIG_REQUIRED");
  const args = [
    "--print",
    "--output-format",
    "json",
    "--safe-mode",
    "--no-session-persistence",
    "--disable-slash-commands",
    "--strict-mcp-config",
    "--mcp-config",
    mcpConfigPath ?? '{"mcpServers":{}}',
    "--permission-mode",
    writable ? "dontAsk" : "plan",
    "--tools",
    writable || request.writerAuthorization ? allowedTools : "",
    ...(writable || request.writerAuthorization ? ["--allowedTools", allowedTools] : []),
    "--disallowed-tools",
    "Bash,WebFetch,WebSearch,NotebookEdit,Task,Agent,Read,Edit,Write,Glob,Grep",
  ];
  if (request.model !== "default") args.push("--model", request.model);
  return args;
}

function grokArgs(request: ProviderRequest): string[] {
  if (request.access === "workspace-write") {
    throw new Error("GROK_WRITER_DISABLED_PENDING_SANDBOX_REVIEW");
  }
  const args = [
    "--prompt-file",
    "/dev/stdin",
    "--output-format",
    "json",
    "--cwd",
    request.workspace,
    "--no-memory",
    "--no-subagents",
    "--disable-web-search",
    "--max-turns",
    "4",
    "--permission-mode",
    "plan",
    "--tools",
    "",
    "--disallowed-tools",
    "Bash,WebSearch,WebFetch,Task,Agent,Read,Edit,Write,Glob,Grep",
  ];
  if (request.model !== "default") args.push("--model", request.model);
  return args;
}

function versionArgs(id: CliDefinition["id"]): string[] {
  return id === "grok" ? ["version"] : ["--version"];
}

export function subscriptionCliArguments(
  id: CliDefinition["id"],
  request: ProviderRequest,
  mcpConfigPath?: string,
): string[] {
  validateModel(request.model);
  validatePrompt(request.prompt);
  return id === "codex"
    ? codexArgs(request)
    : id === "claude"
      ? claudeArgs(request, mcpConfigPath)
      : grokArgs(request);
}

function claudeWorkspaceMcpConfiguration(request: ProviderRequest): Record<string, unknown> {
  return {
    mcpServers: {
      orchestratory_workspace: {
        type: "stdio",
        command: process.execPath,
        args: workspaceMcpArguments(request),
      },
    },
  };
}

export class SubscriptionCliProvider implements ProviderAdapter {
  readonly capabilities: ProviderCapabilities;
  readonly #definition: CliDefinition;

  constructor(id: "codex" | "claude" | "grok", options: { codexWriterEnabled?: boolean } = {}) {
    this.#definition = DEFINITIONS[id];
    // Codex Writer is experimental and OFF by default: it requires an owner opt-in
    // because "Codex uses the Workspace MCP instead of shell to write" is not yet
    // live-verified. --sandbox read-only remains a hard kernel guarantee regardless.
    const canWrite = id === "codex"
      ? this.#definition.canWrite && options.codexWriterEnabled === true
      : this.#definition.canWrite;
    this.capabilities = {
      id,
      displayName: this.#definition.displayName,
      subscription: true,
      api: false,
      canWrite,
      canWriteSubscription: canWrite,
      canWriteApi: false,
      apiConfigured: false,
      modelDiscovery: id === "grok" ? "cli" : "manual",
      suggestedModels: [...this.#definition.suggestedModels],
      subscriptionModels: [...this.#definition.suggestedModels],
      apiModels: [],
    };
  }

  async invoke(request: ProviderRequest): Promise<ProviderResult> {
    if (request.authMode !== "subscription") throw new Error("CLI_PROVIDER_REQUIRES_SUBSCRIPTION_MODE");
    if (request.access === "workspace-write" && !this.capabilities.canWrite) {
      throw new Error("PROVIDER_WRITE_NOT_ALLOWED");
    }
    const executable = await resolveExecutable(this.#definition.executable);
    const scratch = await mkdtemp(join(tmpdir(), "orchestratory-provider-"));
    await chmod(scratch, 0o700);
    const boundedWorkspace =
      (request.access === "workspace-write" || Boolean(request.writerAuthorization)) &&
      (this.#definition.id === "claude" || this.#definition.id === "codex");
    const effectiveRequest = boundedWorkspace ? request : { ...request, workspace: scratch };
    let result;
    try {
      let mcpConfigPath: string | undefined;
      if (this.#definition.id === "claude" && (request.access === "workspace-write" || request.writerAuthorization)) {
        mcpConfigPath = join(scratch, "workspace-mcp.json");
        await writeFile(
          mcpConfigPath,
          `${JSON.stringify(claudeWorkspaceMcpConfiguration(request))}\n`,
          { encoding: "utf8", mode: 0o600, flag: "wx" },
        );
        await chmod(mcpConfigPath, 0o600);
      }
      const args = subscriptionCliArguments(this.#definition.id, effectiveRequest, mcpConfigPath);
      result = await runProcess({
        executable,
        args,
        cwd: scratch,
        stdin: request.prompt,
        timeoutMs: request.timeoutMs,
        outputLimitBytes: request.outputLimitBytes,
        env: {
          ...minimalSubscriptionEnvironment(),
          ...(request.access === "workspace-write" && request.writerAuthorization?.capabilityToken
            ? { ORCHESTRATORY_WORKSPACE_CAPABILITY: request.writerAuthorization.capabilityToken }
            : request.access === "workspace-write"
              ? { ORCHESTRATORY_LEGACY_WORKFLOW_CAPABILITY: randomUUID() }
              : {}),
        },
        ...(request.signal ? { signal: request.signal } : {}),
      });
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
    if (result.terminationReason) throw new Error(`PROVIDER_TERMINATED:${result.terminationReason}`);
    if (result.exitCode !== 0) {
      throw new Error(`PROVIDER_EXITED:${this.#definition.id}:${safeSummary(result.stderr, 500)}`);
    }
    return {
      provider: this.#definition.id,
      model: request.model,
      text: redact(extractProviderText(result.stdout)),
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      outputBytes: result.outputBytes,
    };
  }

  async doctor(): Promise<{ ok: boolean; version?: string; reason?: string }> {
    try {
      const executable = await resolveExecutable(this.#definition.executable);
      const result = await runProcess({
        executable,
        args: versionArgs(this.#definition.id),
        cwd: process.cwd(),
        timeoutMs: 10_000,
        outputLimitBytes: 16_384,
        env: minimalSubscriptionEnvironment(),
      });
      if (result.exitCode !== 0) return { ok: false, reason: "VERSION_COMMAND_FAILED" };
      return { ok: true, version: safeSummary(result.stdout || result.stderr, 200) };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : "UNKNOWN_ERROR" };
    }
  }

  async listModels(): Promise<string[]> {
    if (this.#definition.id !== "grok") return [...this.capabilities.suggestedModels];
    try {
      const executable = await resolveExecutable("grok");
      const scratch = await mkdtemp(join(tmpdir(), "orchestratory-models-"));
      await chmod(scratch, 0o700);
      let result;
      try {
        result = await runProcess({
          executable,
          args: ["models"],
          cwd: scratch,
          timeoutMs: 20_000,
          outputLimitBytes: 65_536,
          env: minimalSubscriptionEnvironment(),
        });
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
      if (result.exitCode !== 0) return [...this.capabilities.suggestedModels];
      const models = result.stdout
        .split("\n")
        .map((line) => line.trim().split(/\s+/u)[0] ?? "")
        .filter((value) => /^[A-Za-z0-9._:/-]{1,128}$/u.test(value));
      return models.length > 0 ? [...new Set(models)] : [...this.capabilities.suggestedModels];
    } catch {
      return [...this.capabilities.suggestedModels];
    }
  }
}
