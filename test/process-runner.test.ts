import test from "node:test";
import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("streams trusted stdout without retaining it or tripping the capture ceiling", async () => {
  const node = await resolveExecutable("node");
  let bytes = 0;
  const result = await runProcess({
    executable: node,
    args: ["-e", "process.stdout.write('x'.repeat(3000000))"],
    cwd: process.cwd(),
    timeoutMs: 2_000,
    outputLimitBytes: 256,
    stdoutConsumer: (chunk) => { bytes += chunk.length; },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.terminationReason, undefined);
  assert.equal(result.stdout, "");
  assert.equal(result.outputBytes, 3_000_000);
  assert.equal(bytes, 3_000_000);
});

test("a trusted stdout parser failure terminates and rejects the process", async () => {
  const node = await resolveExecutable("node");
  await assert.rejects(runProcess({
    executable: node,
    args: ["-e", "process.stdout.write('bad')"],
    cwd: process.cwd(),
    timeoutMs: 2_000,
    outputLimitBytes: 256,
    stdoutConsumer: () => { throw new Error("SYNTHETIC_STREAM_PARSE_FAILURE"); },
  }), /SYNTHETIC_STREAM_PARSE_FAILURE/u);
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

test("an already-aborted process never starts", async (t) => {
  const node = await resolveExecutable("node");
  const directory = await mkdtemp(join(tmpdir(), "orchestratory-pre-abort-"));
  const marker = join(directory, "started");
  t.after(async () => await rm(directory, { recursive: true, force: true }));
  const controller = new AbortController();
  controller.abort();
  const result = await runProcess({
    executable: node,
    args: ["-e", "require('node:fs').writeFileSync(process.argv[1], 'ran')", marker],
    cwd: process.cwd(),
    timeoutMs: 2_000,
    outputLimitBytes: 1_024,
    signal: controller.signal,
  });
  assert.equal(result.terminationReason, "cancelled");
  await assert.rejects(access(marker), (error: unknown) => {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  });
});

test("an abort during executable resolution never starts the process", async (t) => {
  const node = await resolveExecutable("node");
  const directory = await mkdtemp(join(tmpdir(), "orchestratory-resolution-abort-"));
  const marker = join(directory, "started");
  t.after(async () => await rm(directory, { recursive: true, force: true }));
  const controller = new AbortController();
  const running = runProcess({
    executable: node,
    args: ["-e", "require('node:fs').writeFileSync(process.argv[1], 'ran')", marker],
    cwd: process.cwd(),
    timeoutMs: 2_000,
    outputLimitBytes: 1_024,
    signal: controller.signal,
  });
  controller.abort();
  const result = await running;
  assert.equal(result.terminationReason, "cancelled");
  await assert.rejects(access(marker), (error: unknown) => {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  });
});

test("does not report cancellation complete while a stubborn grandchild survives", async (t) => {
  if (process.platform === "win32") return;
  const node = await resolveExecutable("node");
  const controller = new AbortController();
  let grandchildPid = 0;
  t.after(() => {
    if (grandchildPid < 2) return;
    try {
      process.kill(grandchildPid, "SIGKILL");
    } catch {
      // Already gone, which is the expected outcome.
    }
  });
  const running = runProcess({
    executable: node,
    args: [
      "-e",
      [
        "const {spawn}=require('node:child_process')",
        "const stubborn=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore'})",
        "process.stdout.write(String(stubborn.pid)+'\\n')",
        "process.on('SIGTERM',()=>process.exit(0))",
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
  grandchildPid = Number(result.stdout.trim());
  assert.equal(result.terminationReason, "cancelled");
  assert.ok(Number.isSafeInteger(grandchildPid) && grandchildPid > 1);
  assert.throws(() => process.kill(grandchildPid, 0), (error: unknown) => {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  });
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

test("executable trust rejects unsafe files, directories, locations, and PATH entries", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orchestratory-executable-trust-"));
  const outside = await mkdtemp(join(tmpdir(), "orchestratory-executable-outside-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  t.after(async () => await rm(outside, { recursive: true, force: true }));

  const safeBin = join(root, "safe-bin");
  await mkdir(safeBin, { mode: 0o700 });
  const safe = join(safeBin, "safe-tool");
  await writeFile(safe, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  assert.equal(await resolveExecutable("safe-tool", safeBin, [root]), await realpath(safe));

  const writable = join(safeBin, "writable-tool");
  await writeFile(writable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await chmod(writable, 0o722);
  await assert.rejects(
    resolveExecutable("writable-tool", safeBin, [root]),
    /UNSAFE_EXECUTABLE_FILE/u,
  );

  const writableBin = join(root, "writable-bin");
  await mkdir(writableBin, { mode: 0o700 });
  const directoryTool = join(writableBin, "directory-tool");
  await writeFile(directoryTool, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await chmod(writableBin, 0o777);
  await assert.rejects(
    resolveExecutable("directory-tool", writableBin, [root]),
    /UNSAFE_EXECUTABLE_DIRECTORY/u,
  );

  const outsideTarget = join(outside, "outside-tool");
  await writeFile(outsideTarget, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await symlink(outsideTarget, join(safeBin, "linked-tool"));
  await assert.rejects(
    resolveExecutable("linked-tool", safeBin, [root]),
    /UNTRUSTED_EXECUTABLE_LOCATION/u,
  );

  const directoryExecutable = join(safeBin, "directory-executable");
  await mkdir(directoryExecutable, { mode: 0o700 });
  await assert.rejects(
    resolveExecutable("directory-executable", safeBin, [root]),
    /UNSAFE_EXECUTABLE_FILE/u,
  );
  await assert.rejects(
    resolveExecutable("safe-tool", "relative/bin", [root]),
    /UNSAFE_EXECUTABLE_PATH_ENTRY/u,
  );
  await assert.rejects(
    resolveExecutable("safe-tool", safeBin, [outside]),
    /UNTRUSTED_EXECUTABLE_LOCATION/u,
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
