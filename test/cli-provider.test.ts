import test from "node:test";
import assert from "node:assert/strict";
import { access, chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { SubscriptionCliProvider, subscriptionCliArguments } from "../src/providers/cli.ts";
import type { ProviderRequest } from "../src/types.ts";

function request(access: ProviderRequest["access"]): ProviderRequest {
  return {
    runId: "00000000-0000-4000-8000-000000000004",
    role: access === "workspace-write" ? "writer" : "reviewer",
    access,
    workspace: process.cwd(),
    prompt: "synthetic prompt",
    model: "default",
    authMode: "subscription",
    // Coverage runs execute many subprocess tests concurrently; keep this well
    // below the product ceiling while avoiding host-load flakes.
    timeoutMs: 3000,
    outputLimitBytes: 1024,
  };
}

test("Codex read-only adapter keeps the hardened flags and no MCP write path", () => {
  const args = subscriptionCliArguments("codex", request("read-only"));
  assert.ok(args.includes("--ephemeral"));
  assert.ok(args.includes("--strict-config"));
  assert.ok(args.includes("--skip-git-repo-check"));
  assert.ok(args.some((value, index) => value === "--disable" && args[index + 1] === "shell_tool"));
  assert.equal(args[args.indexOf("--sandbox") + 1], "read-only");
  assert.ok(!args.some((a) => a.startsWith("mcp_servers.orchestratory_workspace")));
});

test("cross-provider child receives only a revocable read-only Workspace MCP", () => {
  const delegated: ProviderRequest = {
    ...request("read-only"),
    writerAuthorization: {
      dataDirectory: "/tmp/orchestratory-test-data",
      roomId: "room-test",
      sourceWorkspace: process.cwd(),
      taskId: "task-test",
      epoch: 4,
      executedBy: "subagent-claude-00000000-0000-4000-8000-000000000004",
      delegationId: "00000000-0000-4000-8000-000000000005",
    },
  };
  const codex = subscriptionCliArguments("codex", delegated);
  const codexMcpArgs = codex.find((value) => value.startsWith("mcp_servers.orchestratory_workspace.args="));
  assert.match(codexMcpArgs ?? "", /read-only/u);
  assert.doesNotMatch(codexMcpArgs ?? "", /capability/u);
  const claude = subscriptionCliArguments("claude", delegated, "/tmp/synthetic-read-mcp.json");
  const tools = claude[claude.indexOf("--tools") + 1] ?? "";
  assert.match(tools, /list_files/u);
  assert.match(tools, /read_file/u);
  assert.doesNotMatch(tools, /write_file|create_directory/u);
  assert.equal(claude[claude.indexOf("--permission-mode") + 1], "plan");
  const grok = subscriptionCliArguments("grok", delegated);
  assert.equal(grok[grok.indexOf("--tools") + 1], "");
  assert.match(grok[grok.indexOf("--disallowed-tools") + 1] ?? "", /Bash.*Read.*Edit.*Write.*Glob.*Grep/u);
});

test("delegated Grok remains in an empty scratch directory without filesystem tools", async (t) => {
  const bin = await mkdtemp(join(tmpdir(), "orchestratory-grok-bin-"));
  t.after(async () => await rm(bin, { recursive: true, force: true }));
  const executable = join(bin, "grok");
  await writeFile(
    executable,
    [
      "#!/usr/bin/env node",
      "const index = process.argv.indexOf('--cwd');",
      "process.stdout.write(JSON.stringify({result: process.argv[index + 1]}));",
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(executable, 0o700);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${previousPath ?? ""}`;
  t.after(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  });
  const workspace = await mkdtemp(join(tmpdir(), "orchestratory-grok-workspace-"));
  t.after(async () => await rm(workspace, { recursive: true, force: true }));
  const result = await new SubscriptionCliProvider("grok").invoke({
    ...request("read-only"),
    workspace,
    writerAuthorization: {
      dataDirectory: "/tmp/orchestratory-test-data",
      roomId: "room-test",
      sourceWorkspace: workspace,
      taskId: "task-test",
      epoch: 4,
      executedBy: "subagent-grok-00000000-0000-4000-8000-000000000004",
      delegationId: "00000000-0000-4000-8000-000000000005",
    },
  });
  assert.notEqual(result.text, workspace);
  await assert.rejects(access(result.text));
});

test("Codex conversation adapter can run in its empty read-only scratch directory", async (t) => {
  const bin = await mkdtemp(join(tmpdir(), "orchestratory-codex-bin-"));
  t.after(async () => await rm(bin, { recursive: true, force: true }));
  const executable = join(bin, "codex");
  await writeFile(
    executable,
    [
      "#!/usr/bin/env node",
      "if (!process.argv.includes('--skip-git-repo-check')) process.exit(9);",
      "process.stdout.write(JSON.stringify({result: 'conversation-ready'}));",
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(executable, 0o700);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${previousPath ?? ""}`;
  t.after(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  });
  const result = await new SubscriptionCliProvider("codex").invoke(request("read-only"));
  assert.equal(result.text, "conversation-ready");
});

test("Claude and Grok adapters deny shell, network and subagents", () => {
  assert.equal(new SubscriptionCliProvider("grok").capabilities.canWrite, false);
  const claude = subscriptionCliArguments("claude", request("workspace-write"), "/tmp/synthetic-mcp.json");
  assert.equal(claude[claude.indexOf("--permission-mode") + 1], "dontAsk");
  assert.match(claude[claude.indexOf("--tools") + 1] ?? "", /mcp__orchestratory_workspace__write_file/u);
  assert.match(claude[claude.indexOf("--tools") + 1] ?? "", /mcp__orchestratory_workspace__create_directory/u);
  assert.match(claude[claude.indexOf("--disallowed-tools") + 1] ?? "", /Bash.*WebFetch.*Agent.*Read.*Write/u);
  assert.equal(claude[claude.indexOf("--mcp-config") + 1], "/tmp/synthetic-mcp.json");
  assert.throws(
    () => subscriptionCliArguments("claude", request("workspace-write")),
    /CLAUDE_WRITER_MCP_CONFIG_REQUIRED/u,
  );
  const grok = subscriptionCliArguments("grok", request("read-only"));
  assert.ok(grok.includes("--no-memory"));
  assert.ok(grok.includes("--no-subagents"));
  assert.ok(grok.includes("--disable-web-search"));
  assert.equal(grok[grok.indexOf("--permission-mode") + 1], "plan");
  assert.equal(grok[grok.indexOf("--tools") + 1], "");
  assert.throws(
    () => subscriptionCliArguments("grok", request("workspace-write")),
    /GROK_WRITER_DISABLED/u,
  );
});

test("read-only subscription execution uses and removes an empty scratch cwd", async (t) => {
  const bin = await mkdtemp(join(tmpdir(), "orchestratory-cli-bin-"));
  t.after(async () => await rm(bin, { recursive: true, force: true }));
  const executable = join(bin, "claude");
  await writeFile(
    executable,
    "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({result: process.cwd()}));\n",
    "utf8",
  );
  await chmod(executable, 0o700);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${previousPath ?? ""}`;
  t.after(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  });
  const original = await mkdtemp(join(tmpdir(), "orchestratory-cli-original-"));
  t.after(async () => await rm(original, { recursive: true, force: true }));
  const result = await new SubscriptionCliProvider("claude").invoke({
    ...request("read-only"),
    workspace: original,
  });
  assert.notEqual(result.text, original);
  await assert.rejects(access(result.text));
});

test("Claude writer keeps its owner-only MCP configuration out of process arguments", async (t) => {
  const bin = await mkdtemp(join(tmpdir(), "orchestratory-writer-bin-"));
  t.after(async () => await rm(bin, { recursive: true, force: true }));
  const executable = join(bin, "claude");
  await writeFile(
    executable,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "const index = process.argv.indexOf('--mcp-config');",
      "const path = process.argv[index + 1];",
      "if (!path || path.startsWith('{')) process.exit(2);",
      "const config = JSON.parse(fs.readFileSync(path, 'utf8'));",
      "const args = config.mcpServers.orchestratory_workspace.args;",
      "const workspace = args[args.indexOf('--workspace') + 1];",
      "if (!workspace || process.argv.includes(workspace)) process.exit(3);",
      "if ((fs.statSync(path).mode & 0o777) !== 0o600) process.exit(4);",
      "process.stdout.write(JSON.stringify({result: 'secure'}));",
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(executable, 0o700);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${previousPath ?? ""}`;
  t.after(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  });
  const workspace = await mkdtemp(join(tmpdir(), "orchestratory-writer-workspace-"));
  t.after(async () => await rm(workspace, { recursive: true, force: true }));
  const result = await new SubscriptionCliProvider("claude").invoke({
    ...request("workspace-write"),
    workspace,
  });
  assert.equal(result.text, "secure");
});

test("model and prompt validation rejects injection carriers", () => {
  assert.throws(
    () => subscriptionCliArguments("claude", { ...request("read-only"), model: "bad model" }),
    /INVALID_MODEL_ID/u,
  );
  assert.throws(
    () => subscriptionCliArguments("grok", { ...request("read-only"), prompt: "bad\0prompt" }),
    /PROMPT_CONTAINS_NULL/u,
  );
});

test("codex writer runs read-only sandbox with shell disabled and Workspace MCP as the only write path", () => {
  const args = subscriptionCliArguments("codex", request("workspace-write"));
  // Kernel-level guarantee: Codex itself can never write to disk.
  const sandbox = args.indexOf("--sandbox");
  assert.equal(args[sandbox + 1], "read-only");
  // Shell writing disabled; the only write path is the external MCP broker.
  assert.ok(args.includes("shell_tool"));
  assert.ok(args.some((a) => a.startsWith("mcp_servers.orchestratory_workspace.command=")));
  const mcpArgs = args.find((a) => a.startsWith("mcp_servers.orchestratory_workspace.args="));
  assert.ok(mcpArgs);
  assert.match(mcpArgs, /--mode/u);
  assert.match(mcpArgs, /write/u);
  assert.match(mcpArgs, /workspace-mcp\.mjs/u);
});

test("codex writer is off by default and requires an explicit owner opt-in", () => {
  assert.equal(new SubscriptionCliProvider("codex").capabilities.canWrite, false);
  assert.equal(new SubscriptionCliProvider("codex").capabilities.canWriteSubscription, false);
  assert.equal(
    new SubscriptionCliProvider("codex", { codexWriterEnabled: true }).capabilities.canWrite,
    true,
  );
  // Claude writer is unaffected by the Codex gate.
  assert.equal(new SubscriptionCliProvider("claude").capabilities.canWrite, true);
  // Grok stays read-only regardless.
  assert.equal(
    new SubscriptionCliProvider("grok", { codexWriterEnabled: true } as never).capabilities.canWrite,
    false,
  );
});
