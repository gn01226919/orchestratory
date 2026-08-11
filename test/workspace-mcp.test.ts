import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { link, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { WorkspaceToolBroker } from "../src/mcp/workspace-server.ts";
import { CollaborationService } from "../src/core/collaboration-service.ts";

const execFileAsync = promisify(execFile);

/**
 * A throwaway workspace that is a real git working tree.
 *
 * Amendment (X-3): a WRITE broker now asks git where hooks come from and refuses to exist when git
 * cannot be asked, because a broker that cannot say where the auto-executed directory is cannot say
 * a write is outside it. Every write-mode fixture here is therefore a real repository — which is
 * also what a Writer always gets in this product: a task-bound worktree.
 */
async function gitWorkspace(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  await execFileAsync("git", ["init", "-b", "main"], { cwd: root });
  return root;
}

test("workspace MCP broker exposes only bounded canonical text operations", async (t) => {
  const root = await gitWorkspace("orchestratory-mcp-workspace-");
  t.after(async () => await rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "source.ts"), "export const value = 1;\n", "utf8");
  await writeFile(join(root, ".env.local"), "SYNTHETIC=value\n", "utf8");
  await writeFile(join(root, ".git-shadow"), "not sensitive\n", "utf8");
  await mkdir(join(root, ".orchestratory"));
  await writeFile(join(root, ".orchestratory", "state.json"), "{}\n", "utf8");
  const broker = await WorkspaceToolBroker.create(root, "write", { authorizeWrite: () => {} });
  assert.equal(await broker.call("list_files", {}), ".git-shadow\nsource.ts");
  const read = JSON.parse(await broker.call("read_file", { path: "source.ts" })) as {
    sha256: string;
    content: string;
  };
  assert.equal(read.content, "export const value = 1;\n");
  await assert.rejects(broker.call("read_file", { path: "../outside" }), /PATH_ESCAPE_DENIED/u);
  await assert.rejects(broker.call("read_file", { path: ".env.local" }), /SENSITIVE_WORKSPACE_PATH_DENIED/u);
  await assert.rejects(
    broker.call("read_file", { path: ".git/config" }),
    /SENSITIVE_WORKSPACE_PATH_DENIED/u,
  );
  await assert.rejects(
    broker.call("read_file", { path: ".orchestratory/state.json" }),
    /SENSITIVE_WORKSPACE_PATH_DENIED/u,
  );
  await assert.rejects(
    broker.call("write_file", { path: "source.ts", content: "stale\n", expectedSha256: "0".repeat(64) }),
    /WORKSPACE_WRITE_STALE/u,
  );
  await broker.call("write_file", {
    path: "source.ts",
    content: "export const value = 2;\n",
    expectedSha256: read.sha256,
  });
  await broker.call("create_directory", { path: "new-directory" });
  assert.equal((await stat(join(root, "new-directory"))).mode & 0o777, 0o700);
  await assert.rejects(
    broker.call("create_directory", { path: "missing-parent/nested" }),
    /ENOENT/u,
  );
  await broker.call("write_file", { path: "new.ts", content: "export {};\n", expectedSha256: null });
  assert.equal(await readFile(join(root, "source.ts"), "utf8"), "export const value = 2;\n");
  assert.equal((await stat(join(root, "new.ts"))).mode & 0o777, 0o600);
  assert.equal((await stat(join(root, "new.ts"))).nlink, 1);
  assert.equal((await readdir(root)).some((name) => name.startsWith(".orchestratory-")), false);
  await assert.rejects(broker.call("delete_file", { path: "source.ts" }), /UNKNOWN_WORKSPACE_TOOL/u);
});

test("workspace MCP broker denies writes in read-only mode and link traversal", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orchestratory-mcp-links-"));
  const outside = await mkdtemp(join(tmpdir(), "orchestratory-mcp-outside-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  t.after(async () => await rm(outside, { recursive: true, force: true }));
  await writeFile(join(root, "source.ts"), "safe\n", "utf8");
  await writeFile(join(outside, "secret.txt"), "synthetic\n", "utf8");
  await symlink(join(outside, "secret.txt"), join(root, "escape.txt"));
  const readOnly = await WorkspaceToolBroker.create(root, "read-only");
  await assert.rejects(
    readOnly.call("write_file", { path: "source.ts", content: "changed\n", expectedSha256: null }),
    /WORKSPACE_WRITE_TOOL_DENIED/u,
  );
  await assert.rejects(
    readOnly.call("create_directory", { path: "denied" }),
    /WORKSPACE_WRITE_TOOL_DENIED/u,
  );
  await assert.rejects(readOnly.call("read_file", { path: "escape.txt" }), /WORKSPACE_PATH_ESCAPE_DENIED/u);
  await assert.rejects(readOnly.call("list_files", {}), /WORKSPACE_SYMLINK_DENIED/u);
  await rm(join(root, "escape.txt"));
  await link(join(root, "source.ts"), join(root, "linked.ts"));
  await assert.rejects(readOnly.call("read_file", { path: "source.ts" }), /WORKSPACE_HARDLINK_DENIED/u);
});

test("workspace MCP broker fails closed on malformed, binary and oversized operations", async (t) => {
  const root = await gitWorkspace("orchestratory-mcp-invalid-");
  t.after(async () => await rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "binary.bin"), Buffer.from([1, 0, 2]));
  await writeFile(join(root, "invalid-utf8.txt"), Buffer.from([0xff, 0xfe]));
  await writeFile(join(root, "large.txt"), "x".repeat(524_289), "utf8");
  await writeFile(join(root, "safe.txt"), "safe\n", "utf8");
  const broker = await WorkspaceToolBroker.create(root, "write", { authorizeWrite: () => {} });
  assert.deepEqual(
    broker.tools().map((tool) => tool.name),
    ["list_files", "read_file", "create_directory", "write_file"],
  );
  await assert.rejects(broker.call("list_files", { unexpected: true }), /UNKNOWN_LIST_FILES_ARGUMENT/u);
  await assert.rejects(
    broker.call("read_file", { path: "safe.txt", unexpected: true }),
    /UNKNOWN_READ_FILE_ARGUMENT/u,
  );
  await assert.rejects(broker.call("read_file", { path: "binary.bin" }), /WORKSPACE_BINARY_FILE_DENIED/u);
  await assert.rejects(broker.call("read_file", { path: "invalid-utf8.txt" }), /WORKSPACE_INVALID_UTF8_DENIED/u);
  await assert.rejects(broker.call("read_file", { path: "large.txt" }), /WORKSPACE_FILE_TOO_LARGE/u);
  await assert.rejects(broker.call("read_file", { path: "." }), /WORKSPACE_FILE_NOT_REGULAR/u);
  await assert.rejects(broker.call("read_file", { path: "/tmp/outside" }), /PATH_ESCAPE_DENIED/u);
  await assert.rejects(
    broker.call("write_file", { path: "safe.txt", content: "bad\0data", expectedSha256: null }),
    /WORKSPACE_BINARY_WRITE_DENIED/u,
  );
  await assert.rejects(
    broker.call("write_file", { path: "too-large.txt", content: "x".repeat(524_289), expectedSha256: null }),
    /WORKSPACE_WRITE_CONTENT_TOO_LARGE/u,
  );
  await assert.rejects(
    broker.call("write_file", { path: "new.txt", content: "new", expectedSha256: "0".repeat(64) }),
    /WORKSPACE_CREATE_EXPECTED_HASH_MUST_BE_NULL/u,
  );
  await assert.rejects(
    broker.call("write_file", { path: "new.txt", content: "new", expectedSha256: null, extra: true }),
    /UNKNOWN_WRITE_FILE_ARGUMENT/u,
  );
  await assert.rejects(
    broker.call("create_directory", { path: "directory", extra: true }),
    /UNKNOWN_CREATE_DIRECTORY_ARGUMENT/u,
  );
  await broker.call("create_directory", { path: "directory" });
  await assert.rejects(broker.call("create_directory", { path: "directory" }), /EEXIST/u);
  await assert.rejects(WorkspaceToolBroker.create(root, "invalid" as "write"), /INVALID_WORKSPACE_BROKER_MODE/u);
});

test("workspace MCP stdio transport performs initialization and tool discovery", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orchestratory-mcp-transport-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "source.ts"), "safe\n", "utf8");
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL("../bin/workspace-mcp.mjs", import.meta.url)),
      "--workspace",
      root,
      "--mode",
      "read-only",
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const send = (value: unknown): void => {
    child.stdin.write(`${JSON.stringify(value)}\n`);
  };
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  child.stdin.end();
  const [code] = await once(child, "close") as [number];
  assert.equal(code, 0, Buffer.concat(stderr).toString("utf8"));
  const output = Buffer.concat(stdout).toString("utf8");
  assert.match(output, /"id":1/u);
  assert.match(output, /"name":"read_file"/u);
  assert.doesNotMatch(output, /"name":"write_file"/u);
});

test("workspace MCP stdio returns bounded tool errors and rejects truncated requests", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orchestratory-mcp-errors-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "source.ts"), "safe\n", "utf8");
  const executable = fileURLToPath(new URL("../bin/workspace-mcp.mjs", import.meta.url));
  const child = spawn(process.execPath, [executable, "--workspace", root, "--mode", "read-only"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "read_file", arguments: { path: "source.ts" } } })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "write_file", arguments: {} } })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 4, method: "unknown" })}\n`);
  child.stdin.end();
  const [code] = await once(child, "close") as [number];
  assert.equal(code, 0);
  const output = Buffer.concat(stdout).toString("utf8");
  assert.match(output, /"id":1,"result":\{\}/u);
  assert.match(output, /source\.ts/u);
  assert.match(output, /WORKSPACE_WRITE_TOOL_DENIED/u);
  assert.match(output, /UNKNOWN_MCP_METHOD/u);

  const truncated = spawn(
    process.execPath,
    [executable, "--workspace", root, "--mode", "read-only"],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const stderr: Buffer[] = [];
  truncated.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  truncated.stdin.end('{"jsonrpc":"2.0"}');
  const [truncatedCode] = await once(truncated, "close") as [number];
  assert.equal(truncatedCode, 1);
  assert.match(Buffer.concat(stderr).toString("utf8"), /MCP_TRUNCATED_REQUEST/u);
});

test("workspace broker blocks write-then-auto-execute config paths for every writer", async () => {
  const { WORKSPACE_SENSITIVE_PATH } = await import("../src/mcp/workspace-server.ts");
  for (const blocked of [
    ".github/workflows/ci.yml",
    "sub/.github/workflows/deploy.yaml",
    ".husky/pre-commit",
    ".claude/hooks/x.sh",
    ".circleci/config.yml",
    ".gitlab-ci.yml",
    ".git/hooks/pre-push",
    ".env.local",
    "server.key",
  ]) {
    assert.equal(WORKSPACE_SENSITIVE_PATH.test(blocked), true, `should block ${blocked}`);
  }
  for (const allowed of ["src/app.ts", "README.md", ".github/ISSUE_TEMPLATE.md", "package.json"]) {
    assert.equal(WORKSPACE_SENSITIVE_PATH.test(allowed), false, `should allow ${allowed}`);
  }
});

test("workspace broker rechecks Writer authorization immediately before mutation and records operations", async (t) => {
  const root = await gitWorkspace("orchestratory-mcp-fence-");
  t.after(async () => await rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "source.ts"), "old\n", "utf8");
  await assert.rejects(WorkspaceToolBroker.create(root, "write"), /WORKSPACE_WRITE_AUTHORIZER_REQUIRED/u);
  let checks = 0;
  const operations: Array<{ action: string; outcome: string; error?: string }> = [];
  const broker = await WorkspaceToolBroker.create(root, "write", {
    authorizeWrite: () => {
      checks += 1;
      if (checks > 1) throw new Error("WRITER_EPOCH_STALE");
    },
    recordOperation: (operation) => { operations.push(operation); },
  });
  const read = JSON.parse(await broker.call("read_file", { path: "source.ts" })) as { sha256: string };
  await assert.rejects(broker.call("write_file", {
    path: "source.ts", content: "new\n", expectedSha256: read.sha256,
  }), /WRITER_EPOCH_STALE/u);
  assert.equal(await readFile(join(root, "source.ts"), "utf8"), "old\n");
  assert.deepEqual(operations.map(({ action, outcome }) => ({ action, outcome })), [
    { action: "read_file", outcome: "succeeded" },
    { action: "write_file", outcome: "failed" },
  ]);
  assert.equal(operations[1]?.error, "WRITER_EPOCH_STALE");
});

test("workspace MCP stdio accepts an exact Writer Lease and writes dual-identity audit records", async (t) => {
  const source = await mkdtemp(join(tmpdir(), "orchestratory-mcp-lease-source-"));
  const data = await mkdtemp(join(tmpdir(), "orchestratory-mcp-lease-data-"));
  await execFileAsync("git", ["init", "-b", "main"], { cwd: source });
  await writeFile(join(source, "README.md"), "synthetic\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd: source });
  await execFileAsync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "initial"], { cwd: source });
  const service = new CollaborationService(data);
  t.after(() => service.close());
  t.after(async () => await rm(data, { recursive: true, force: true }));
  t.after(async () => await rm(source, { recursive: true, force: true }));
  service.ledger.createRoom("demo", source);
  const writer = await service.grantWriter({
    taskId: "task-mcp", roomId: "demo", workspace: source,
    candidate: { origin: "resident", provider: "codex" },
  });
  const executable = fileURLToPath(new URL("../bin/workspace-mcp.mjs", import.meta.url));
  const args = [
    executable, "--workspace", writer.lease.worktree, "--mode", "write",
    "--data-directory", data, "--room", "demo", "--source-workspace", source,
    "--task", "task-mcp", "--epoch", String(writer.lease.epoch),
    "--executed-by", writer.lease.executedBy,
  ];
  const child = spawn(process.execPath, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ORCHESTRATORY_WORKSPACE_CAPABILITY: writer.capabilityToken },
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  child.stdin.end(`${JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "write_file", arguments: { path: "new.ts", content: "export {};\n", expectedSha256: null } },
  })}\n`);
  const [code] = await once(child, "close") as [number];
  assert.equal(code, 0, Buffer.concat(stderr).toString("utf8"));
  assert.match(Buffer.concat(stdout).toString("utf8"), /WROTE new\.ts/u);
  assert.equal(await readFile(join(writer.lease.worktree, "new.ts"), "utf8"), "export {};\n");
  const operation = service.audit.list({ roomId: "demo" }).find((event) => event.type === "workspace.write_file");
  assert.equal(operation?.onBehalfOf, "codex");
  assert.equal(operation?.executedBy, "codex");
  assert.equal(operation?.leaseEpoch, 1);
  assert.ok(service.ledger.listAfter("demo", 0, 20).some((message) => message.text.includes("寫入 new.ts")));

  service.switchWriter({
    taskId: "task-mcp", roomId: "demo", workspace: source, expectedEpoch: 1,
    checkpoint: "切換 Writer", candidate: { origin: "resident", provider: "claude" },
  });
  const stale = spawn(process.execPath, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ORCHESTRATORY_WORKSPACE_CAPABILITY: writer.capabilityToken },
  });
  const staleError: Buffer[] = [];
  stale.stderr.on("data", (chunk: Buffer) => staleError.push(chunk));
  stale.stdin.end();
  const [staleCode] = await once(stale, "close") as [number];
  assert.equal(staleCode, 1);
  assert.match(Buffer.concat(staleError).toString("utf8"), /WRITER_EPOCH_STALE/u);
});

test("delegated child MCP enforces same-provider write and cross-provider read-only access", async (t) => {
  const source = await mkdtemp(join(tmpdir(), "orchestratory-mcp-child-source-"));
  const data = await mkdtemp(join(tmpdir(), "orchestratory-mcp-child-data-"));
  await execFileAsync("git", ["init", "-b", "main"], { cwd: source });
  await writeFile(join(source, "README.md"), "delegated synthetic\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd: source });
  await execFileAsync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "initial"], { cwd: source });
  const service = new CollaborationService(data);
  t.after(() => service.close());
  t.after(async () => await rm(data, { recursive: true, force: true }));
  t.after(async () => await rm(source, { recursive: true, force: true }));
  service.ledger.createRoom("demo", source);
  const writer = await service.grantWriter({
    taskId: "task-child-mcp", roomId: "demo", workspace: source,
    candidate: { origin: "resident", provider: "codex" },
  });
  const same = await service.delegateWriterChild({
    taskId: "task-child-mcp", roomId: "demo", workspace: source,
    epoch: writer.lease.epoch, capabilityToken: writer.capabilityToken,
    executedBy: writer.lease.executedBy, childProvider: "codex", label: "實作",
  });
  const cross = await service.delegateWriterChild({
    taskId: "task-child-mcp", roomId: "demo", workspace: source,
    epoch: writer.lease.epoch, capabilityToken: writer.capabilityToken,
    executedBy: writer.lease.executedBy, childProvider: "claude", label: "審查",
  });
  const executable = fileURLToPath(new URL("../bin/workspace-mcp.mjs", import.meta.url));
  const context = (workspace: string, mode: "write" | "read-only", delegationId: string, executedBy: string) => [
    executable, "--workspace", workspace, "--mode", mode,
    "--data-directory", data, "--room", "demo", "--source-workspace", source,
    "--task", "task-child-mcp", "--epoch", String(writer.lease.epoch),
    "--executed-by", executedBy, "--delegation", delegationId,
  ];

  const writable = spawn(process.execPath, context(
    same.delegation.workspace, "write", same.delegation.id, same.delegation.executedBy,
  ), {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ORCHESTRATORY_WORKSPACE_CAPABILITY: same.capabilityToken },
  });
  const writableOut: Buffer[] = [];
  const writableErr: Buffer[] = [];
  writable.stdout.on("data", (chunk: Buffer) => writableOut.push(chunk));
  writable.stderr.on("data", (chunk: Buffer) => writableErr.push(chunk));
  writable.stdin.end(`${JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "write_file", arguments: { path: "child.ts", content: "export const child = true;\n", expectedSha256: null } },
  })}\n`);
  const [writableCode] = await once(writable, "close") as [number];
  assert.equal(writableCode, 0, Buffer.concat(writableErr).toString("utf8"));
  assert.match(Buffer.concat(writableOut).toString("utf8"), /WROTE child\.ts/u);
  assert.equal(await readFile(join(same.delegation.workspace, "child.ts"), "utf8"), "export const child = true;\n");

  const reader = spawn(process.execPath, context(
    cross.delegation.workspace, "read-only", cross.delegation.id, cross.delegation.executedBy,
  ), { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env } });
  const readerOut: Buffer[] = [];
  const readerErr: Buffer[] = [];
  reader.stdout.on("data", (chunk: Buffer) => readerOut.push(chunk));
  reader.stderr.on("data", (chunk: Buffer) => readerErr.push(chunk));
  reader.stdin.end(
    `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n` +
    `${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "read_file", arguments: { path: "README.md" } } })}\n`,
  );
  const [readerCode] = await once(reader, "close") as [number];
  const readerText = Buffer.concat(readerOut).toString("utf8");
  assert.equal(readerCode, 0, Buffer.concat(readerErr).toString("utf8"));
  assert.match(readerText, /delegated synthetic/u);
  assert.doesNotMatch(readerText, /create_directory|write_file/u);
  const readAudit = service.audit.list({ roomId: "demo" }).find((event) =>
    event.type === "workspace.read_file" && event.executedBy === cross.delegation.executedBy);
  assert.equal(readAudit?.onBehalfOf, "codex");
  assert.equal(readAudit?.leaseEpoch, 1);

  service.switchWriter({
    taskId: "task-child-mcp", roomId: "demo", workspace: source, expectedEpoch: 1,
    checkpoint: "撤銷 children", candidate: { origin: "resident", provider: "claude" },
  });
  const stale = spawn(process.execPath, context(
    cross.delegation.workspace, "read-only", cross.delegation.id, cross.delegation.executedBy,
  ), { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env } });
  const staleError: Buffer[] = [];
  stale.stderr.on("data", (chunk: Buffer) => staleError.push(chunk));
  stale.stdin.end();
  const [staleCode] = await once(stale, "close") as [number];
  assert.equal(staleCode, 1);
  assert.match(Buffer.concat(staleError).toString("utf8"), /DELEGATION_NOT_ACTIVE/u);
});

/**
 * AMENDMENT (X-3). The hook directory is whatever `core.hooksPath` says it is, so the guard asks git.
 *
 * `WORKSPACE_SENSITIVE_PATH`'s own comment says it blocks "write-then-auto-execute … git/husky/claude
 * hooks", and the measurement behind this test is that it blocked exactly one spelling: `.husky/…`
 * matched, while `.githooks/pre-merge-commit`, `githooks/…`, `hooks/…` and `tools/hooks/…` did not —
 * a Writer could install a hook through the ordinary MCP write tool. The family cannot be closed by
 * adding names, so each case below CONFIGURES the directory and then asserts that the regular
 * expression alone still does not match it while the broker refuses anyway.
 */
test("a Writer cannot write into whatever directory git says it runs hooks from", async (t) => {
  const { WORKSPACE_SENSITIVE_PATH } = await import("../src/mcp/workspace-server.ts");
  for (const hooksPath of [".githooks", "githooks", "hooks", "tools/hooks"]) {
    const root = await gitWorkspace("orchestratory-mcp-hookdir-");
    t.after(async () => await rm(root, { recursive: true, force: true }));
    await execFileAsync("git", ["config", "core.hooksPath", hooksPath], { cwd: root });
    const target = `${hooksPath}/pre-merge-commit`;
    // Precondition ([[PITFALLS]] #106/#129): the name list would let this through, so a refusal below
    // can only come from the git-derived half.
    assert.equal(WORKSPACE_SENSITIVE_PATH.test(target), false,
      `${target} is already on the name list, so this case measures the list and not the fix`);

    const broker = await WorkspaceToolBroker.create(root, "write", { authorizeWrite: () => {} });
    await assert.rejects(
      broker.call("write_file", { path: target, content: "#!/bin/sh\nexit 0\n", expectedSha256: null }),
      /SENSITIVE_WORKSPACE_PATH_DENIED/u,
      `a Writer installed a hook at ${target}`,
    );
    await assert.rejects(
      broker.call("create_directory", { path: hooksPath }),
      /SENSITIVE_WORKSPACE_PATH_DENIED/u,
    );
    await assert.rejects(broker.call("read_file", { path: target }), /SENSITIVE_WORKSPACE_PATH_DENIED/u);
  }
});

/**
 * AMENDMENT (X-3), the other direction ([[PITFALLS]] #107), twice.
 *
 * The guard is a question about THIS repository, not a new set of forbidden names: a directory
 * called `.githooks` in a repository that has not configured it is not auto-executed by anything,
 * and a sibling whose name merely starts with the same characters is not inside it either. Reading
 * either as denied would be a name list again, just a longer one.
 */
test("a directory git does not run hooks from stays writable, and so does a same-prefix sibling", async (t) => {
  const plain = await gitWorkspace("orchestratory-mcp-nohook-");
  t.after(async () => await rm(plain, { recursive: true, force: true }));
  const plainBroker = await WorkspaceToolBroker.create(plain, "write", { authorizeWrite: () => {} });
  await plainBroker.call("create_directory", { path: ".githooks" });
  await plainBroker.call("write_file", {
    path: ".githooks/pre-merge-commit", content: "#!/bin/sh\nexit 0\n", expectedSha256: null,
  });
  assert.equal(await readFile(join(plain, ".githooks", "pre-merge-commit"), "utf8"), "#!/bin/sh\nexit 0\n");

  const configured = await gitWorkspace("orchestratory-mcp-sibling-");
  t.after(async () => await rm(configured, { recursive: true, force: true }));
  await execFileAsync("git", ["config", "core.hooksPath", ".githooks"], { cwd: configured });
  const broker = await WorkspaceToolBroker.create(configured, "write", { authorizeWrite: () => {} });
  await broker.call("create_directory", { path: ".githooks-notes" });
  await broker.call("write_file", { path: ".githooks-notes/x.md", content: "notes\n", expectedSha256: null });
  assert.equal(await readFile(join(configured, ".githooks-notes", "x.md"), "utf8"), "notes\n");
});

/**
 * AMENDMENT (Y-1)/P2-1: the answer is asked again, because the question is about RIGHT NOW.
 *
 * `core.hooksPath` lives in a config file that outlives any one broker, and a broker created before
 * the repository was reconfigured used to go on answering with the directory that was auto-executed
 * then. Measured (`w2-stale`): the same write a freshly-built broker refused was admitted by the
 * older one, which is a stale answer to a mutable question ([[PITFALLS]] #103).
 */
test("a broker built before the repository was reconfigured does not use its old answer", async (t) => {
  const root = await gitWorkspace("orchestratory-mcp-stale-");
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const broker = await WorkspaceToolBroker.create(root, "write", { authorizeWrite: () => {} });
  // Precondition ([[PITFALLS]] #106/#129): before the reconfiguration this path is genuinely
  // writable, so the refusal afterwards is the reconfiguration being noticed and nothing else.
  await broker.call("create_directory", { path: "tools" });
  await broker.call("write_file", {
    path: "tools/hooks-probe", content: "probe\n", expectedSha256: null,
  });

  await execFileAsync("git", ["config", "core.hooksPath", "tools"], { cwd: root });
  await assert.rejects(
    broker.call("write_file", {
      path: "tools/pre-merge-commit", content: "#!/bin/sh\nexit 0\n", expectedSha256: null,
    }),
    /SENSITIVE_WORKSPACE_PATH_DENIED/u,
    "the broker admitted a write into the directory git now runs hooks from",
  );
  await assert.rejects(broker.call("create_directory", { path: "tools/nested" }),
    /SENSITIVE_WORKSPACE_PATH_DENIED/u);

  // And back again, in the direction that would be a permanent refusal if this were a one-way latch.
  await execFileAsync("git", ["config", "--unset", "core.hooksPath"], { cwd: root });
  await broker.call("write_file", {
    path: "tools/ordinary.txt", content: "ordinary\n", expectedSha256: null,
  });
  assert.equal(await readFile(join(root, "tools", "ordinary.txt"), "utf8"), "ordinary\n");
});

/**
 * AMENDMENT (X-3), the fail-closed direction: a write broker that cannot ask git does not exist.
 *
 * A Writer's workspace is always a task-bound git worktree here, so "git could not answer" is an
 * anomaly, and the anomaly costs a refusal rather than an unguarded write surface. Read-only brokers
 * are unaffected — nothing they do can install a program anywhere.
 */
test("a write broker refuses to exist over a workspace git cannot answer for", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orchestratory-mcp-notrepo-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "source.ts"), "safe\n", "utf8");
  await assert.rejects(
    WorkspaceToolBroker.create(root, "write", { authorizeWrite: () => {} }),
    /WORKSPACE_HOOK_DIRECTORY_UNRESOLVED/u,
  );
  const readOnly = await WorkspaceToolBroker.create(root, "read-only");
  assert.equal(await readOnly.call("list_files", {}), "source.ts");
});
