import test from "node:test";
import assert from "node:assert/strict";
import {
  minimalSubscriptionEnvironment,
  runProcess,
  resolveExecutable,
} from "../src/core/process-runner.ts";

test("runs an executable without a shell", async () => {
  const node = await resolveExecutable("node");
  const result = await runProcess({
    executable: node,
    args: ["-e", "process.stdout.write('ok')"],
    cwd: process.cwd(),
    timeoutMs: 2_000,
    outputLimitBytes: 1_024,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "ok");
});

test("terminates output flooding", async () => {
  const node = await resolveExecutable("node");
  const result = await runProcess({
    executable: node,
    args: ["-e", "process.stdout.write('x'.repeat(100000))"],
    cwd: process.cwd(),
    timeoutMs: 2_000,
    outputLimitBytes: 256,
  });
  assert.equal(result.terminationReason, "output-limit");
  assert.ok(result.outputBytes > 256);
});

test("terminates a process on timeout", async () => {
  const node = await resolveExecutable("node");
  const result = await runProcess({
    executable: node,
    args: ["-e", "setInterval(() => {}, 1000)"],
    cwd: process.cwd(),
    timeoutMs: 100,
    outputLimitBytes: 1_024,
  });
  assert.equal(result.terminationReason, "timeout");
});

test("cancellation terminates the detached process group", async () => {
  if (process.platform === "win32") return;
  const node = await resolveExecutable("node");
  const controller = new AbortController();
  const running = runProcess({
    executable: node,
    args: [
      "-e",
      [
        "const {spawn}=require('node:child_process')",
        "const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'})",
        "process.stdout.write(String(child.pid)+'\\n')",
        "setInterval(()=>{},1000)",
      ].join(";"),
    ],
    cwd: process.cwd(),
    timeoutMs: 5_000,
    outputLimitBytes: 1_024,
    signal: controller.signal,
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  controller.abort();
  const result = await running;
  assert.equal(result.terminationReason, "cancelled");
  const childPid = Number(result.stdout.trim());
  assert.ok(Number.isSafeInteger(childPid) && childPid > 1);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.throws(() => process.kill(childPid, 0), (error: unknown) => {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  });
});

test("process broker rejects invalid executables, arguments and limits", async () => {
  await assert.rejects(resolveExecutable("../sh"), /INVALID_EXECUTABLE_NAME/u);
  await assert.rejects(
    resolveExecutable("definitely-missing-orchestratory-tool", "/usr/bin"),
    /EXECUTABLE_NOT_FOUND/u,
  );
  const executable = await resolveExecutable("true");
  await assert.rejects(
    runProcess({ executable, args: [], cwd: process.cwd(), timeoutMs: 0, outputLimitBytes: 1 }),
    /INVALID_PROCESS_LIMITS/u,
  );
  await assert.rejects(
    runProcess({
      executable,
      args: Array.from({ length: 129 }, () => "x"),
      cwd: process.cwd(),
      timeoutMs: 100,
      outputLimitBytes: 1,
    }),
    /TOO_MANY_ARGUMENTS/u,
  );
});

test("subscription environment drops arbitrary secrets", () => {
  const untrustedKey = ["API", "KEY"].join("_");
  const env = minimalSubscriptionEnvironment({
    PATH: "/usr/bin",
    HOME: "/tmp/home",
    [untrustedKey]: "must-not-pass",
  });
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env[untrustedKey], undefined);
  assert.equal(env.NO_COLOR, "1");
});
