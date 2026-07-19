import { randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { PresenceHookEvent, PresenceProvider } from "./room-presence.ts";

const EVENTS: PresenceHookEvent[] = ["SessionStart", "UserPromptSubmit", "Stop"];

export interface NormalizedPresenceHook {
  event: PresenceHookEvent;
  cwd: string;
  sessionId: string;
  turnId?: string;
  text?: string;
  model?: string;
}

export interface InstalledRoomHooks {
  path: string;
  backupPath?: string;
  changed: boolean;
  trustReviewRequired: boolean;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function normalizeEvent(value: unknown): PresenceHookEvent | undefined {
  if (value === "SessionStart" || value === "session_start") return "SessionStart";
  if (value === "UserPromptSubmit" || value === "user_prompt_submit") return "UserPromptSubmit";
  if (value === "Stop" || value === "stop") return "Stop";
  return undefined;
}

export function normalizePresenceHookPayload(
  payload: Record<string, unknown>,
  environment: NodeJS.ProcessEnv = process.env,
): NormalizedPresenceHook | undefined {
  const event = normalizeEvent(payload.hook_event_name ?? payload.hookEventName ?? environment.GROK_HOOK_EVENT);
  const cwd = nonEmptyString(payload.cwd) ?? nonEmptyString(payload.workspaceRoot) ?? environment.GROK_WORKSPACE_ROOT;
  const sessionId = nonEmptyString(payload.session_id) ?? nonEmptyString(payload.sessionId) ?? environment.GROK_SESSION_ID;
  if (!event || !cwd || !sessionId) return undefined;

  const turnId = nonEmptyString(payload.turn_id) ?? nonEmptyString(payload.turnId);
  const model = nonEmptyString(payload.model);
  const text = event === "UserPromptSubmit"
    ? nonEmptyString(payload.prompt) ?? nonEmptyString(payload.userPrompt)
    : event === "Stop"
      ? nonEmptyString(payload.last_assistant_message) ?? nonEmptyString(payload.lastAssistantMessage)
      : undefined;
  return {
    event,
    cwd,
    sessionId,
    ...(turnId ? { turnId } : {}),
    ...(text ? { text } : {}),
    ...(model ? { model } : {}),
  };
}

export function roomHookCommand(provider: PresenceProvider): string {
  return `exec orchestrator room presence-hook --provider ${provider}`;
}

function mergeRoomHooks(document: Record<string, unknown>, provider: PresenceProvider): boolean {
  const command = roomHookCommand(provider);
  const hookEntry = { hooks: [{ type: "command", command, timeout: 10 }] };
  if (document.hooks !== undefined && (typeof document.hooks !== "object" || document.hooks === null || Array.isArray(document.hooks))) {
    throw new Error("INVALID_HOOKS_CONFIG");
  }
  const hooks = (document.hooks ?? {}) as Record<string, unknown>;
  let changed = document.hooks === undefined;
  for (const event of EVENTS) {
    if (hooks[event] !== undefined && !Array.isArray(hooks[event])) throw new Error("INVALID_HOOKS_CONFIG");
    const existing = (hooks[event] as unknown[] | undefined) ?? [];
    const filtered = existing.filter((entry) => !JSON.stringify(entry).includes("room log-hook"));
    if (filtered.length !== existing.length) changed = true;
    if (!filtered.some((entry) => JSON.stringify(entry).includes(command))) {
      filtered.push(hookEntry);
      changed = true;
    }
    hooks[event] = filtered;
  }
  document.hooks = hooks;
  return changed;
}

export function roomHooksPreview(provider: PresenceProvider): Record<string, unknown> {
  const document: Record<string, unknown> = {};
  mergeRoomHooks(document, provider);
  return document;
}

function hookConfigPath(provider: PresenceProvider, home: string): string {
  if (provider === "codex") return join(home, ".codex", "hooks.json");
  if (provider === "claude") return join(home, ".claude", "settings.json");
  return join(home, ".grok", "hooks", "orchestratory-room.json");
}

export async function installRoomHooks(
  provider: PresenceProvider,
  home = homedir(),
): Promise<InstalledRoomHooks> {
  const path = hookConfigPath(provider, home);
  let document: Record<string, unknown> = {};
  let existed = false;
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("INVALID_HOOKS_CONFIG");
    document = parsed as Record<string, unknown>;
    existed = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const changed = mergeRoomHooks(document, provider);
  if (!changed) return { path, changed: false, trustReviewRequired: provider === "codex" };

  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const backupPath = `${path}.orchestrator-backup`;
  if (existed) await copyFile(path, backupPath);
  const temporaryPath = join(dirname(path), `.${randomUUID()}.orchestrator.tmp`);
  await writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, path);
  await chmod(path, 0o600);
  return {
    path,
    ...(existed ? { backupPath } : {}),
    changed: true,
    trustReviewRequired: provider === "codex",
  };
}
