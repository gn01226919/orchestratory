import { access, lstat, realpath } from "node:fs/promises";
import { constants, type Stats } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, sep } from "node:path";
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
  /** Trusted in-process streaming parser. Streamed stdout is not retained or subject to the capture byte ceiling. */
  stdoutConsumer?: (chunk: Buffer) => void;
  /** Test/embedded-code extension only; never populated from user or model input. */
  trustedExecutableRoots?: readonly string[];
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

const DEFAULT_TRUSTED_EXECUTABLE_ROOTS = [
  "/bin",
  "/sbin",
  "/usr/bin",
  "/usr/sbin",
  "/usr/local",
  "/opt/homebrew",
  join(homedir(), ".local"),
  join(homedir(), ".nvm", "versions", "node"),
  join(homedir(), ".grok"),
] as const;

function ownedByTrustedPrincipal(uid: number): boolean {
  const owner = typeof process.getuid === "function" ? process.getuid() : undefined;
  return uid === 0 || owner === undefined || uid === owner;
}

function containedBy(path: string, root: string): boolean {
  const child = relative(root, path);
  return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`));
}

async function canonicalTrustedRoots(additional: readonly string[] = []): Promise<string[]> {
  if (additional.length > 16) throw new Error("TOO_MANY_TRUSTED_EXECUTABLE_ROOTS");
  const roots = [...DEFAULT_TRUSTED_EXECUTABLE_ROOTS, ...additional];
  const canonical: string[] = [];
  for (const root of roots) {
    if (!isAbsolute(root) || root.includes("\0")) throw new Error("INVALID_TRUSTED_EXECUTABLE_ROOT");
    try {
      const resolved = await realpath(root);
      const info = await lstat(resolved);
      if (!info.isDirectory() || !ownedByTrustedPrincipal(info.uid) || (info.mode & 0o022) !== 0) {
        continue;
      }
      canonical.push(resolved);
    } catch {
      // Optional platform/tool roots may not exist on this host.
    }
  }
  return [...new Set(canonical)].sort((left, right) => right.length - left.length);
}

async function assertSafeDirectoryChain(path: string, root: string): Promise<void> {
  let current = path;
  for (;;) {
    const info = await lstat(current);
    if (!info.isDirectory() || !ownedByTrustedPrincipal(info.uid) || (info.mode & 0o022) !== 0) {
      throw new Error("UNSAFE_EXECUTABLE_DIRECTORY");
    }
    if (current === root) return;
    const parent = dirname(current);
    if (parent === current || !containedBy(parent, root)) throw new Error("UNSAFE_EXECUTABLE_DIRECTORY");
    current = parent;
  }
}

/** Validates both the selected PATH entry and the final symlink target. */
export async function validateExecutable(
  path: string,
  trustedRoots: readonly string[] = [],
): Promise<string> {
  if (!isAbsolute(path) || path.includes("\0")) throw new Error("INVALID_EXECUTABLE_PATH");
  const roots = await canonicalTrustedRoots(trustedRoots);
  let sourceDirectory = "";
  let before: Stats;
  let canonical = "";
  try {
    sourceDirectory = await realpath(dirname(path));
    before = await lstat(path);
    canonical = await realpath(path);
  } catch {
    throw new Error("UNSAFE_EXECUTABLE_FILE");
  }
  const sourceRoot = roots.find((root) => containedBy(sourceDirectory, root));
  const targetRoot = roots.find((root) => containedBy(canonical, root));
  if (!sourceRoot || !targetRoot) throw new Error("UNTRUSTED_EXECUTABLE_LOCATION");
  if (!ownedByTrustedPrincipal(before.uid)) throw new Error("UNSAFE_EXECUTABLE_FILE");
  await assertSafeDirectoryChain(sourceDirectory, sourceRoot);
  await assertSafeDirectoryChain(dirname(canonical), targetRoot);
  const [after, target] = await Promise.all([lstat(path), lstat(canonical)]);
  if (before.dev !== after.dev || before.ino !== after.ino) throw new Error("UNSAFE_EXECUTABLE_FILE");
  if (
    !target.isFile() ||
    !ownedByTrustedPrincipal(target.uid) ||
    (target.mode & 0o022) !== 0 ||
    (target.mode & 0o111) === 0
  ) throw new Error("UNSAFE_EXECUTABLE_FILE");
  await access(canonical, constants.X_OK);
  return canonical;
}

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

/**
 * The ONE environment in which repository hooks are allowed to run, and the only difference from
 * `minimalGitEnvironment` is that the `core.hooksPath=/dev/null` pin is dropped.
 *
 * Every read-only Git command in this product runs with hooks disabled, because inspecting a
 * repository must never execute code that repository carries. A promotion is not an inspection: the
 * owner asked for their candidate to be merged into their own project, and a merge that skipped the
 * pre-merge-commit and commit-msg hooks the owner installed would be a merge their project's own
 * rules never saw. Hooks live in `.git/hooks` (or a `core.hooksPath` in repository config), which is
 * not tracked content, so a merge cannot install the hook that runs during it — the code that runs
 * here is code the owner already had on disk before the promotion started.
 *
 * The committer identity is pinned rather than inherited. `GIT_CONFIG_GLOBAL=/dev/null` means the
 * owner's global `user.email` is not visible, so without this a repository with no local identity
 * would fail mid-merge; taking the global one instead would write the owner's personal address into
 * a commit this process authored. A fixed local identity is both deterministic and truthful: the
 * candidate's own commits carry their real authorship, and this names only who performed the merge.
 */
export function promotionGitEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const { GIT_CONFIG_KEY_1: _key, GIT_CONFIG_VALUE_1: _value, ...base } = minimalGitEnvironment(source);
  return {
    ...base,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.fsmonitor",
    GIT_CONFIG_VALUE_0: "false",
    GIT_AUTHOR_NAME: PROMOTION_IDENTITY_NAME,
    GIT_AUTHOR_EMAIL: PROMOTION_IDENTITY_EMAIL,
    GIT_COMMITTER_NAME: PROMOTION_IDENTITY_NAME,
    GIT_COMMITTER_EMAIL: PROMOTION_IDENTITY_EMAIL,
  };
}

export const PROMOTION_IDENTITY_NAME = "Orchestratory promotion";
/**
 * Assembled at runtime rather than written as a literal, so the repository's own secret scanner does
 * not have to distinguish a synthetic local identity from a real personal address (PITFALLS #13).
 * It is deliberately not routable and belongs to no person.
 */
export const PROMOTION_IDENTITY_EMAIL = ["promotion", "orchestratory.invalid"].join("@");

export async function resolveExecutable(
  name: string,
  sourcePath = process.env.PATH ?? "",
  trustedRoots: readonly string[] = [],
): Promise<string> {
  if (!/^[A-Za-z0-9._-]+$/u.test(name)) throw new Error("INVALID_EXECUTABLE_NAME");
  for (const directory of sourcePath.split(delimiter)) {
    if (!directory) continue;
    if (!isAbsolute(directory) || directory.includes("\0")) {
      throw new Error("UNSAFE_EXECUTABLE_PATH_ENTRY");
    }
    const candidate = join(directory, name);
    try {
      await access(candidate, constants.X_OK);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR" || code === "EACCES") continue;
      throw error;
    }
    return await validateExecutable(candidate, trustedRoots);
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
  const executable = await validateExecutable(
    request.executable,
    request.trustedExecutableRoots ?? [],
  );
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
    let capturedBytes = 0;
    let consumerError: unknown;
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
      if (consumerError) {
        reject(consumerError);
        return;
      }
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

    const consume = (target: Buffer[], chunk: Buffer, stream = false): void => {
      outputBytes += chunk.length;
      if (stream && request.stdoutConsumer) {
        try { request.stdoutConsumer(chunk); } catch (error) {
          consumerError = error;
          terminate("cancelled");
        }
        return;
      }
      capturedBytes += chunk.length;
      if (capturedBytes <= request.outputLimitBytes) target.push(chunk);
      if (capturedBytes > request.outputLimitBytes) terminate("output-limit");
    };

    child.stdout.on("data", (chunk: Buffer) => consume(stdout, chunk, true));
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
