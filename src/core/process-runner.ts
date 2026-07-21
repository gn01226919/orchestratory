import { access, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, join } from "node:path";
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";

export interface ProcessRequest {
  executable: string;
  args: string[];
  cwd: string;
  stdin?: string;
  timeoutMs: number;
  outputLimitBytes: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  outputBytes: number;
  terminationReason?: "timeout" | "output-limit" | "cancelled";
}

const SAFE_ENV_KEYS = [
  "PATH",
  "HOME",
  "TMPDIR",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
  "XDG_CONFIG_HOME",
] as const;

export function minimalSubscriptionEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const output: NodeJS.ProcessEnv = { NO_COLOR: "1" };
  for (const key of SAFE_ENV_KEYS) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0) output[key] = value;
  }
  return output;
}

export function minimalGitEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...minimalSubscriptionEnvironment(source),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: "/dev/null",
    GIT_CONFIG_KEY_1: "core.fsmonitor",
    GIT_CONFIG_VALUE_1: "false",
  };
}

export async function resolveExecutable(
  name: string,
  sourcePath = process.env.PATH ?? "",
): Promise<string> {
  if (!/^[A-Za-z0-9._-]+$/u.test(name)) throw new Error("INVALID_EXECUTABLE_NAME");
  for (const directory of sourcePath.split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    try {
      await access(candidate, constants.X_OK);
      return await realpath(candidate);
    } catch {
      // Continue searching the fixed PATH list.
    }
  }
  throw new Error(`EXECUTABLE_NOT_FOUND:${name}`);
}

function validateArgs(args: string[]): void {
  if (args.length > 128) throw new Error("TOO_MANY_ARGUMENTS");
  for (const arg of args) {
    if (arg.length > 32_768) throw new Error("ARGUMENT_TOO_LONG");
    if (arg.includes("\0")) throw new Error("ARGUMENT_CONTAINS_NULL");
  }
}

export async function runProcess(request: ProcessRequest): Promise<ProcessResult> {
  const started = performance.now();
  validateArgs(request.args);
  if (request.timeoutMs <= 0 || request.outputLimitBytes <= 0) {
    throw new Error("INVALID_PROCESS_LIMITS");
  }
  const cancelledBeforeStart = (): ProcessResult => ({
    exitCode: 1,
    stdout: "",
    stderr: "",
    durationMs: Math.round(performance.now() - started),
    outputBytes: 0,
    terminationReason: "cancelled",
  });
  if (request.signal?.aborted) return cancelledBeforeStart();
  const executable = await realpath(request.executable);
  if (request.signal?.aborted) return cancelledBeforeStart();

  return await new Promise<ProcessResult>((resolvePromise, reject) => {
    const child = spawn(executable, request.args, {
      cwd: request.cwd,
      env: request.env ?? minimalSubscriptionEnvironment(),
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let terminationReason: ProcessResult["terminationReason"];
    let settled = false;
    let leaderClosed = false;
    let closeCode = 1;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    let groupProbeTimer: ReturnType<typeof setTimeout> | undefined;
    let cleanupDeadline = 0;

    const clearTerminationTimers = (): void => {
      if (forceTimer) clearTimeout(forceTimer);
      if (groupProbeTimer) clearTimeout(groupProbeTimer);
      forceTimer = undefined;
      groupProbeTimer = undefined;
    };

    const processGroupExists = (): boolean => {
      if (!child.pid || process.platform === "win32") return false;
      try {
        process.kill(-child.pid, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code !== "ESRCH";
      }
    };

    const cleanup = (): void => {
      clearTimeout(timeout);
      clearTerminationTimers();
      request.signal?.removeEventListener("abort", onAbort);
    };

    const settleClosed = (): void => {
      if (settled || !leaderClosed) return;
      if (terminationReason && processGroupExists()) return;
      settled = true;
      cleanup();
      resolvePromise({
        exitCode: closeCode,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        durationMs: Math.round(performance.now() - started),
        outputBytes,
        ...(terminationReason ? { terminationReason } : {}),
      });
    };

    const probeTerminatedGroup = (): void => {
      groupProbeTimer = undefined;
      if (settled || !leaderClosed || !terminationReason) return;
      if (!processGroupExists()) {
        settleClosed();
        return;
      }
      if (!forceTimer && cleanupDeadline > 0 && performance.now() >= cleanupDeadline) {
        settled = true;
        cleanup();
        reject(new Error("PROCESS_TREE_CLEANUP_FAILED"));
        return;
      }
      groupProbeTimer = setTimeout(probeTerminatedGroup, 25);
    };

    const signalProcessTree = (signal: NodeJS.Signals): void => {
      if (child.pid && process.platform !== "win32") {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // The leader may already be gone; fall through to the child handle.
        }
      }
      child.kill(signal);
    };

    const terminate = (reason: NonNullable<ProcessResult["terminationReason"]>): void => {
      if (terminationReason) return;
      terminationReason = reason;
      signalProcessTree("SIGTERM");
      forceTimer = setTimeout(() => {
        forceTimer = undefined;
        cleanupDeadline = performance.now() + 1_000;
        signalProcessTree("SIGKILL");
        if (leaderClosed && !groupProbeTimer) probeTerminatedGroup();
      }, 1_000);
    };

    const consume = (target: Buffer[], chunk: Buffer): void => {
      outputBytes += chunk.length;
      if (outputBytes <= request.outputLimitBytes) target.push(chunk);
      if (outputBytes > request.outputLimitBytes) terminate("output-limit");
    };

    child.stdout.on("data", (chunk: Buffer) => consume(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => consume(stderr, chunk));

    const timeout = setTimeout(() => terminate("timeout"), request.timeoutMs);
    timeout.unref();

    const onAbort = (): void => terminate("cancelled");
    request.signal?.addEventListener("abort", onAbort, { once: true });
    if (request.signal?.aborted) onAbort();

    child.on("error", (error) => {
      if (settled) return;
      if (terminationReason && child.pid) {
        leaderClosed = true;
        closeCode = 1;
        if (!groupProbeTimer) probeTerminatedGroup();
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    });

    child.on("close", (code) => {
      if (settled) return;
      leaderClosed = true;
      closeCode = typeof code === "number" ? code : 1;
      settleClosed();
      if (!settled && terminationReason && !groupProbeTimer) probeTerminatedGroup();
    });

    if (request.stdin !== undefined) child.stdin.end(request.stdin, "utf8");
    else child.stdin.end();
  });
}
