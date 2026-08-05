import test from "node:test";
import assert from "node:assert/strict";
import { runCli } from "../src/cli-entry.ts";
import { helpText } from "../src/help.ts";
import { describeOrphanRecoveryRefs } from "../src/main.ts";
import { defaultNaturalLanguageTeam } from "../src/ui/tui.ts";

test("global CLI help and safe entrypoint remain bounded", async () => {
  assert.match(helpText(), /natural-language TUI \+ local GUI/u);
  assert.match(helpText(), /loopback-only visual GUI/u);
  assert.match(helpText(), /approval-gated/u);
  let errorOutput = "";
  assert.equal(
    await runCli(async () => {
      throw new Error("UNKNOWN_COMMAND");
    }, (value) => {
      errorOutput += value;
    }),
    1,
  );
  assert.equal(errorOutput, "Error: UNKNOWN_COMMAND\n");
  assert.doesNotMatch(errorOutput, /\bat main\b|file:\/\//u);
  assert.equal(await runCli(async () => undefined), 0);
});

test("orphan recovery refs are reportable, explained, and never offered for deletion", () => {
  // The command has to exist in help at all: an accumulating recovery point nobody can see is the
  // defect this exit closes, and an undiscoverable command is the same defect one step removed.
  assert.match(helpText(), /candidates orphan-refs/u);
  assert.match(helpText(), /read-only; lists, never deletes/u);

  const known = "11111111-1111-4111-8111-111111111111";
  const unknown = "22222222-2222-4222-8222-222222222222";
  const empty = describeOrphanRecoveryRefs({
    mainPath: "/workspace/project", orphans: [], limit: 100, taskStatus: () => undefined,
  });
  assert.match(empty, /^No orphan recovery refs under refs\/orchestratory\/checkpoints in \/workspace\/project\.\n$/u);

  const report = describeOrphanRecoveryRefs({
    mainPath: "/workspace/project",
    orphans: [
      { ref: `refs/orchestratory/checkpoints/${known}/33333333-3333-4333-8333-333333333333`, head: "a".repeat(40) },
      { ref: `refs/orchestratory/checkpoints/${unknown}/44444444-4444-4444-8444-444444444444`, head: "b".repeat(40) },
    ],
    limit: 100,
    taskStatus: (taskId) => (taskId === known ? "completed" : undefined),
  });
  // Which ref, what it points at, which task, and why it counts as an orphan.
  assert.match(report, /Orphan recovery refs under refs\/orchestratory\/checkpoints in \/workspace\/project: 2\n/u);
  assert.match(report, new RegExp(`refs/orchestratory/checkpoints/${known}/33333333-3333-4333-8333-333333333333`, "u"));
  assert.match(report, /commit {6}a{40}/u);
  assert.match(report, new RegExp(`task {8}${known} \\(candidate status: completed\\)`, "u"));
  assert.match(report, new RegExp(`task {8}${unknown} \\(no candidate row on record\\)`, "u"));
  assert.match(report, /checkpoint {2}33333333-3333-4333-8333-333333333333 \(no checkpoint row on record\)/u);
  assert.match(report, /no owning checkpoint row in the candidate ledger/u);
  // Read-only by construction: the report must not advertise a removal path that does not exist.
  assert.match(report, /Listed only\. Removing a recovery ref is a destructive Git action and is not offered here\./u);
  assert.doesNotMatch(report, /--execute|--delete|update-ref -d/u);
  assert.doesNotMatch(report, /\(scan limit/u);

  // A truncated scan says so rather than reading as a complete inventory.
  const capped = describeOrphanRecoveryRefs({
    mainPath: "/workspace/project",
    orphans: [{ ref: `refs/orchestratory/checkpoints/${known}/55555555-5555-4555-8555-555555555555`, head: "c".repeat(40) }],
    limit: 1,
    taskStatus: () => "active",
  });
  assert.match(capped, /\(scan limit 1 reached — more may exist\)/u);
});

test("natural-language mode defaults to Codex 5.6 Sol with a Claude Fable 5 writer", () => {
  const team = defaultNaturalLanguageTeam();
  assert.deepEqual(team.planner, {
    role: "planner",
    provider: "codex",
    model: "gpt-5.6-sol",
    authMode: "subscription",
  });
  assert.deepEqual(team.writer, {
    role: "writer",
    provider: "claude",
    model: "claude-fable-5",
    authMode: "subscription",
  });
  assert.deepEqual(team.reviewer, {
    role: "reviewer",
    provider: "codex",
    model: "gpt-5.6-sol",
    authMode: "subscription",
  });
});

test("conversation slash commands dispatch without a terminal", async () => {
  const { runConversationCommand } = await import("../src/ui/tui.ts");
  const { NaturalLanguageSession } = await import("../src/core/session.ts");
  const { ProviderRegistry } = await import("../src/providers/registry.ts");
  const { DEFAULT_HARD_LIMITS } = await import("../src/config.ts");
  // Slash commands never call invoke, so the default provider path is unused here.
  const makeSession = () => new NaturalLanguageSession({
    providers: new ProviderRegistry([]),
    workspace: "/tmp/project",
    hardLimits: { ...DEFAULT_HARD_LIMITS },
  });
  const opts = { guiUrl: "http://127.0.0.1:4317", maxProviderCalls: 500 };

  assert.deepEqual(runConversationCommand("/exit", makeSession(), opts), { exit: true, openAdvanced: false, lines: [] });
  assert.deepEqual(runConversationCommand("/quit", makeSession(), opts).exit, true);
  assert.match(runConversationCommand("/help", makeSession(), opts).lines.join("\n"), /\/advanced/u);
  assert.match(runConversationCommand("/agents", makeSession(), opts).lines.join("\n"), /主代理/u);
  assert.match(runConversationCommand("/status", makeSession(), opts).lines.join("\n"), /session .* 回合/u);
  assert.match(runConversationCommand("/gui", makeSession(), opts).lines.join("\n"), /4317/u);
  assert.match(runConversationCommand("/gui", makeSession(), { maxProviderCalls: 500 }).lines.join("\n"), /沒有啟動 GUI/u);
  assert.match(runConversationCommand("/nope", makeSession(), opts).lines.join("\n"), /未知指令/u);
  assert.equal(runConversationCommand("/advanced", makeSession(), opts).openAdvanced, true);

  const cleared = makeSession();
  assert.match(runConversationCommand("/new", cleared, opts).lines.join("\n"), /已清除/u);

  // /model view, switch, and validation.
  assert.match(runConversationCommand("/model", makeSession(), opts).lines.join("\n"), /主代理：codex/u);
  assert.match(runConversationCommand("/model claude", makeSession(), opts).lines.join("\n"), /用法/u);
  const switched = makeSession();
  assert.match(runConversationCommand("/model claude claude-fable-5", switched, opts).lines.join("\n"), /已切換為 claude/u);
  assert.equal(switched.status().mainAgent.provider, "claude");
  assert.match(runConversationCommand("/model shell x", makeSession(), opts).lines.join("\n"), /無法切換主代理/u);
});

test("/local applies for the loopback endpoint and never registers it itself", async () => {
  const { runConversationCommand } = await import("../src/ui/tui.ts");
  const { NaturalLanguageSession } = await import("../src/core/session.ts");
  const { ProviderRegistry } = await import("../src/providers/registry.ts");
  const { DEFAULT_HARD_LIMITS } = await import("../src/config.ts");
  const registry = new ProviderRegistry([]);
  const session = new NaturalLanguageSession({
    providers: registry,
    workspace: "/tmp/project",
    hardLimits: { ...DEFAULT_HARD_LIMITS },
  });
  const opts = { maxProviderCalls: 500 };

  // Bare /local explains the gate instead of opening it.
  const help = runConversationCommand("/local", session, opts);
  assert.equal(help.localEndpointRequest, undefined);
  assert.match(help.lines.join("\n"), /loopback/u);
  assert.match(help.lines.join("\n"), /唯讀角色/u);

  // A candidate is only ever handed back for confirmation, never registered here.
  const applied = runConversationCommand("/local http://127.0.0.1:11434", session, opts);
  assert.equal(applied.localEndpointRequest, "http://127.0.0.1:11434");
  assert.equal(applied.lines.length, 0);
  assert.equal(registry.has("local"), false);

  // Extra words are rejected rather than silently truncated to the first token.
  assert.equal(
    runConversationCommand("/local http://127.0.0.1:11434 extra", session, opts).localEndpointRequest,
    undefined,
  );

  // Once registered the command reports state and refuses to re-point the id.
  assert.equal(
    runConversationCommand("/local http://127.0.0.1:11434", session, {
      ...opts,
      localEndpointRegistered: true,
    }).localEndpointRequest,
    undefined,
  );
  assert.match(
    runConversationCommand("/local", session, { ...opts, localEndpointRegistered: true })
      .lines.join("\n"),
    /已在這次啟動中加入/u,
  );
  assert.match(runConversationCommand("/help", session, opts).lines.join("\n"), /\/local/u);
});
