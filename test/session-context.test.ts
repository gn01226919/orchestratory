import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionContextBroker } from "../src/core/session-context.ts";
import {
  minimalGitEnvironment,
  resolveExecutable,
  runProcess,
} from "../src/core/process-runner.ts";

async function git(cwd: string, args: string[]): Promise<void> {
  const executable = await resolveExecutable("git");
  const result = await runProcess({
    executable,
    args,
    cwd,
    timeoutMs: 15_000,
    outputLimitBytes: 1_048_576,
    env: minimalGitEnvironment(),
  });
  assert.equal(result.exitCode, 0);
}

async function syntheticProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "orchestratory-session-context-"));
  await git(root, ["init", "--quiet"]);
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "app.ts"), "export const demo = 1;\n", "utf8");
  await writeFile(join(root, "README.md"), "# demo\n", "utf8");
  await writeFile(join(root, ".env"), "SECRET=do-not-read\n", "utf8");
  await writeFile(join(root, "server.key"), "fake-key-material\n", "utf8");
  await writeFile(join(root, ".gitignore"), "ignored-dir/\n", "utf8");
  await mkdir(join(root, "ignored-dir"));
  await writeFile(join(root, "ignored-dir", "noise.txt"), "ignored\n", "utf8");
  return root;
}

test("session context lists Git-visible files and omits sensitive or ignored paths", async (t) => {
  const root = await syntheticProject();
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const broker = new SessionContextBroker(root);
  const tree = await broker.fileTree();
  assert.match(tree, /src\/app\.ts/u);
  assert.match(tree, /README\.md/u);
  assert.doesNotMatch(tree, /\.env/u);
  assert.doesNotMatch(tree, /server\.key/u);
  assert.doesNotMatch(tree, /ignored-dir/u);
});

test("session context file tree is empty outside a Git repository", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orchestratory-session-nogit-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "plain.txt"), "text\n", "utf8");
  const broker = new SessionContextBroker(root);
  assert.equal(await broker.fileTree(), "");
});

test("session context reads bounded files and denies escapes without failing the batch", async (t) => {
  const root = await syntheticProject();
  t.after(async () => await rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "binary.bin"), Buffer.from([0, 1, 2, 3]));
  await symlink("/etc/hosts", join(root, "hosts-link"));
  const broker = new SessionContextBroker(root);
  const result = await broker.readFiles([
    "src/app.ts",
    "../outside.txt",
    "/etc/hosts",
    ".env",
    "binary.bin",
    "hosts-link",
    "missing.txt",
  ]);
  assert.match(result, /File: src\/app\.ts\nexport const demo = 1;/u);
  assert.match(result, /File: \.\.\/outside\.txt\nREAD_DENIED: WORKSPACE_PATH_ESCAPE_DENIED/u);
  assert.match(result, /File: \/etc\/hosts\nREAD_DENIED: WORKSPACE_PATH_ESCAPE_DENIED/u);
  assert.match(result, /File: \.env\nREAD_DENIED: SENSITIVE_WORKSPACE_PATH_DENIED/u);
  assert.match(result, /File: binary\.bin\nREAD_DENIED: WORKSPACE_BINARY_FILE_DENIED/u);
  assert.match(result, /File: hosts-link\nREAD_DENIED: WORKSPACE_PATH_ESCAPE_DENIED/u);
  assert.match(result, /File: missing\.txt\nREAD_DENIED:/u);
  assert.doesNotMatch(result, /do-not-read/u);
});

test("session context enforces the bounded total read budget", async (t) => {
  const root = await syntheticProject();
  t.after(async () => await rm(root, { recursive: true, force: true }));
  for (let index = 0; index < 5; index += 1) {
    await writeFile(join(root, `big-${index}.txt`), "x".repeat(16_000), "utf8");
  }
  const broker = new SessionContextBroker(root);
  const result = await broker.readFiles([
    "big-0.txt",
    "big-1.txt",
    "big-2.txt",
    "big-3.txt",
    "big-4.txt",
  ]);
  assert.match(result, /bounded read budget reached/u);
  assert.ok(Buffer.byteLength(result) <= 80_000);
  assert.equal(await broker.readFiles(["   ", ""]), "No valid file paths were requested.");
});
