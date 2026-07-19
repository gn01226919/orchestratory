import test from "node:test";
import assert from "node:assert/strict";
import { runCli } from "../src/cli-entry.ts";
import { helpText } from "../src/help.ts";
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
