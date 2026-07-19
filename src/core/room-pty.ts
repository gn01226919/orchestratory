import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { stderr, stdout } from "node:process";
import type { Writable } from "node:stream";
import { minimalSubscriptionEnvironment, resolveExecutable } from "./process-runner.ts";
import { safeSummary, sanitizeTerminal } from "../security/redact.ts";

export type RoomPtyProvider = "codex" | "grok";

export interface RoomPtyResult {
  provider: RoomPtyProvider;
  author: `${RoomPtyProvider}-terminal`;
  exitCode: number;
  signal?: NodeJS.Signals;
  durationMs: number;
  transcript: string;
}

const SCRIPT_PATH = "/usr/bin/script";
const MAX_CAPTURE_BYTES = 128 * 1_024;
const MAX_LEDGER_CHARS = 12_000;
const MAX_SESSION_MS = 4 * 60 * 60 * 1_000;
const TERMINAL_ESCAPE_REMAINDER = /\u001B(?:[@-_]|[^\r\n]{0,32})/gu;
const SCRIPT_METADATA = /^Script (?:started|done) on .*$/gimu;

function applyTerminalBackspaces(value: string): string {
  const output: string[] = [];
  for (const character of value) {
    if (character === "\b") {
      if (output.at(-1) !== "\n" && output.at(-1) !== "\r") output.pop();
    } else {
      output.push(character);
    }
  }
  return output.join("");
}

export function parseRoomPtyProvider(value: unknown): RoomPtyProvider {
  if (value !== "codex" && value !== "grok") throw new Error("ROOM_PTY_PROVIDER_DENIED");
  return value;
}

export function parseRoomPtyCliArgs(args: readonly string[]): RoomPtyProvider {
  if (args[0] !== "room" || args[1] !== "pty") throw new Error("ROOM_PTY_ARGUMENT_DENIED");
  const roomFlagIndexes = args.flatMap((value, index) => (value === "--room" ? [index] : []));
  if (roomFlagIndexes.length > 1) throw new Error("ROOM_PTY_ARGUMENT_DENIED");
  const permitted = new Set([0, 1, 2]);
  const roomFlagIndex = roomFlagIndexes[0];
  if (roomFlagIndex !== undefined) {
    if (!args[roomFlagIndex + 1]) throw new Error("ROOM_PTY_ARGUMENT_DENIED");
    permitted.add(roomFlagIndex);
    permitted.add(roomFlagIndex + 1);
  }
  if (args.some((_value, index) => !permitted.has(index))) {
    throw new Error("ROOM_PTY_ARGUMENT_DENIED");
  }
  return parseRoomPtyProvider(args[2]);
}

export function roomPtyProviderArguments(provider: RoomPtyProvider, cwd: string): string[] {
  if (provider === "codex") {
    return [
      "--disable", "shell_tool",
      "--disable", "apps",
      "--disable", "browser_use",
      "--disable", "computer_use",
      "--disable", "plugins",
      "--disable", "multi_agent",
      "--disable", "image_generation",
      "--disable", "hooks",
      "--strict-config",
      "--sandbox", "read-only",
      "--ask-for-approval", "never",
      "--cd", cwd,
    ];
  }
  return [
    "--cwd", cwd,
    "--no-memory",
    "--no-subagents",
    "--disable-web-search",
    "--max-turns", "30",
    "--permission-mode", "plan",
    "--tools", "",
    "--disallowed-tools", "Bash,WebSearch,WebFetch,Task,Agent,Edit,Write,NotebookEdit",
  ];
}

/**
 * A PTY recording is inherently a mixed screen stream: it can contain echoed
 * owner input, provider output and redraws. Keep that provenance in the text
 * instead of presenting it as a clean provider-authored reply.
 */
export function normalizeRoomPtyTranscript(value: string): string {
  const normalized = sanitizeTerminal(applyTerminalBackspaces(value))
    .replace(TERMINAL_ESCAPE_REMAINDER, "[CONTROL_REMOVED]")
    .replace(SCRIPT_METADATA, "")
    .replace(/\r\n?/gu, "\n")
    .replace(/[\t ]+\n/gu, "\n")
    .replace(/\n{4,}/gu, "\n\n\n")
    .trim();
  if (!normalized) return "";
  return safeSummary(
    "[bounded mixed PTY transcript: may include your input, provider output and screen redraws]\n" +
      normalized,
    MAX_LEDGER_CHARS,
  );
}

function appendTail(chunks: Buffer[], capturedBytes: number, chunk: Buffer): number {
  chunks.push(chunk);
  let bytes = capturedBytes + chunk.length;
  while (bytes > MAX_CAPTURE_BYTES && chunks.length > 0) {
    const first = chunks[0]!;
    const excess = bytes - MAX_CAPTURE_BYTES;
    if (first.length <= excess) {
      chunks.shift();
      bytes -= first.length;
    } else {
      chunks[0] = first.subarray(excess);
      bytes -= excess;
    }
  }
  return bytes;
}

function terminateProcessGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // The process may have exited between the timer and signal delivery.
    }
  }
}

export async function runRoomPty(
  providerValue: unknown,
  cwd: string,
  options: {
    output?: Writable;
    errorOutput?: Writable;
    timeoutMs?: number;
    platform?: NodeJS.Platform;
  } = {},
): Promise<RoomPtyResult> {
  const provider = parseRoomPtyProvider(providerValue);
  if ((options.platform ?? process.platform) !== "darwin") {
    throw new Error("ROOM_PTY_UNSUPPORTED_PLATFORM");
  }
  const timeoutMs = options.timeoutMs ?? MAX_SESSION_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_SESSION_MS) {
    throw new Error("INVALID_ROOM_PTY_TIMEOUT");
  }
  const [script, executable, canonicalCwd] = await Promise.all([
    realpath(SCRIPT_PATH),
    resolveExecutable(provider),
    realpath(cwd),
  ]);
  if (script !== SCRIPT_PATH) throw new Error("ROOM_PTY_SCRIPT_PATH_MISMATCH");

  const output = options.output ?? stdout;
  const errorOutput = options.errorOutput ?? stderr;
  const captured: Buffer[] = [];
  let capturedBytes = 0;
  const started = performance.now();

  return await new Promise<RoomPtyResult>((resolvePromise, reject) => {
    const child = spawn(
      script,
      ["-q", "/dev/null", executable, ...roomPtyProviderArguments(provider, canonicalCwd)],
      {
      cwd: canonicalCwd,
      env: minimalSubscriptionEnvironment(),
      shell: false,
      detached: true,
      stdio: ["inherit", "pipe", "pipe"],
      windowsHide: true,
      },
    );
    let settled = false;
    let timedOut = false;
    let forceTimer: NodeJS.Timeout | undefined;
    const forwardInterrupt = (): void => terminateProcessGroup(child.pid, "SIGINT");
    const forwardTermination = (): void => terminateProcessGroup(child.pid, "SIGTERM");
    const forwardResize = (): void => terminateProcessGroup(child.pid, "SIGWINCH");
    const cleanup = (): void => {
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      process.removeListener("SIGINT", forwardInterrupt);
      process.removeListener("SIGTERM", forwardTermination);
      process.removeListener("SIGWINCH", forwardResize);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminateProcessGroup(child.pid, "SIGTERM");
      forceTimer = setTimeout(() => terminateProcessGroup(child.pid, "SIGKILL"), 1_000);
      forceTimer.unref();
    }, timeoutMs);
    timer.unref();
    process.on("SIGINT", forwardInterrupt);
    process.on("SIGTERM", forwardTermination);
    process.on("SIGWINCH", forwardResize);

    child.stdout.on("data", (chunk: Buffer) => {
      capturedBytes = appendTail(captured, capturedBytes, chunk);
      output.write(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => errorOutput.write(chunk));
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (timedOut) {
        reject(new Error("ROOM_PTY_SESSION_TIMEOUT"));
        return;
      }
      const result: RoomPtyResult = {
        provider,
        author: `${provider}-terminal`,
        exitCode: code ?? 1,
        durationMs: Math.round(performance.now() - started),
        transcript: normalizeRoomPtyTranscript(Buffer.concat(captured).toString("utf8")),
      };
      if (signal) result.signal = signal;
      resolvePromise(result);
    });
  });
}
