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
  validateArgs(request.args);
  if (request.timeoutMs <= 0 || request.outputLimitBytes <= 0) {
    throw new Error("INVALID_PROCESS_LIMITS");
  }
  const executable = await realpath(request.executable);
  const started = performance.now();

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

    const terminate = (reason: NonNullable<ProcessResult["terminationReason"]>): void => {
      if (terminationReason) return;
      terminationReason = reason;
      if (child.pid && process.platform !== "win32") {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          child.kill("SIGTERM");
        }
      } else {
        child.kill("SIGTERM");
      }
      const forceTimer = setTimeout(() => {
        if (child.pid && process.platform !== "win32") {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        } else {
          child.kill("SIGKILL");
        }
      }, 1_000);
      forceTimer.unref();
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

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", onAbort);
      reject(error);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", onAbort);
      resolvePromise({
        exitCode: typeof code === "number" ? code : 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        durationMs: Math.round(performance.now() - started),
        outputBytes,
        ...(terminationReason ? { terminationReason } : {}),
      });
    });

    if (request.stdin !== undefined) child.stdin.end(request.stdin, "utf8");
    else child.stdin.end();
  });
}
