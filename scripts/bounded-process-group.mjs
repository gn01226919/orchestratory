import { spawn } from "node:child_process";

const DEFAULT_KILL_GRACE_MS = 250;

function signalProcessGroup(child, signal) {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

export function runBoundedProcessGroup(file, args, options = {}) {
  const timeoutMs = options.timeoutMs;
  const maxOutputBytes = options.maxOutputBytes;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) {
    throw new Error("BOUNDED_PROCESS_TIMEOUT_INVALID");
  }
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1024 || maxOutputBytes > 1024 * 1024) {
    throw new Error("BOUNDED_PROCESS_OUTPUT_LIMIT_INVALID");
  }

  return new Promise((resolveResult, rejectResult) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let timedOut = false;
    let outputExceeded = false;
    let settled = false;
    let terminating = false;
    let forceTimer;

    const finish = (value, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(forceTimer);
      if (error) rejectResult(error);
      else resolveResult(value);
    };
    const terminate = (reason) => {
      if (terminating || settled) return;
      terminating = true;
      clearTimeout(timeoutTimer);
      if (reason === "timeout") timedOut = true;
      if (reason === "output") outputExceeded = true;
      try {
        signalProcessGroup(child, "SIGTERM");
      } catch (error) {
        finish(undefined, error);
        return;
      }
      forceTimer = setTimeout(() => {
        try {
          signalProcessGroup(child, "SIGKILL");
        } catch {
          // The bounded result below is still authoritative even if the process already disappeared.
        }
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref();
        finish({
          ok: false,
          code: null,
          signal: "SIGKILL",
          timedOut,
          outputExceeded,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        });
      }, options.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
      forceTimer.unref();
    };
    const collect = (target) => (chunk) => {
      if (settled || outputExceeded) return;
      const bytes = Buffer.from(chunk);
      outputBytes += bytes.length;
      if (outputBytes > maxOutputBytes) {
        terminate("output");
        return;
      }
      target.push(bytes);
    };

    child.stdout?.on("data", collect(stdout));
    child.stderr?.on("data", collect(stderr));
    child.once("error", (error) => finish(undefined, error));
    child.once("close", (code, signal) => finish({
      ok: !timedOut && !outputExceeded && code === 0,
      code,
      signal,
      timedOut,
      outputExceeded,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }));

    const timeoutTimer = setTimeout(() => terminate("timeout"), timeoutMs);
    timeoutTimer.unref();
  });
}
