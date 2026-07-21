import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_HARD_LIMITS } from "../src/config.ts";
import {
  NaturalLanguageSession,
  parseMentions,
  parseSessionDecision,
  readFilePaths,
  sessionTools,
} from "../src/core/session.ts";
import { ProviderRegistry } from "../src/providers/registry.ts";
import type { AgentAssignment, ProviderRequest, ProviderResult } from "../src/types.ts";

function providerResult(
  assignment: AgentAssignment,
  request: ProviderRequest,
  text: string,
): ProviderResult {
  return {
    provider: assignment.provider,
    model: request.model,
    text,
    exitCode: 0,
    durationMs: 1,
    outputBytes: Buffer.byteLength(text),
  };
}

test("session exposes only the fixed bounded tool registry", () => {
  assert.deepEqual(sessionTools(), [
    {
      name: "read_files",
      description:
        "Read up to 8 bounded UTF-8 text files from the authorized workspace. Input is one relative path per line.",
      requiresApproval: false,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["input"],
        properties: { input: { type: "string", minLength: 1, maxLength: 20_000 } },
      },
    },
    {
      name: "ask_claude",
      description: "Ask Claude Fable 5 for a bounded read-only second opinion.",
      requiresApproval: false,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["input"],
        properties: { input: { type: "string", minLength: 1, maxLength: 20_000 } },
      },
    },
    {
      name: "coding_team",
      description: "Run Codex planner → Claude writer → Codex reviewer in an approved worktree.",
      requiresApproval: true,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["input"],
        properties: { input: { type: "string", minLength: 1, maxLength: 20_000 } },
      },
    },
  ]);
});

test("session tool parser fails closed for malformed or unknown calls", () => {
  assert.deepEqual(parseSessionDecision("一般回答"), {
    kind: "message",
    message: "一般回答",
  });
  assert.deepEqual(
    parseSessionDecision('ORCHESTRATOR_CALL: {"tool":"coding_team","input":"fix tests"}'),
    { kind: "tool", tool: "coding_team", input: "fix tests" },
  );
  assert.deepEqual(
    parseSessionDecision('ORCHESTRATOR_CALL: {"tool":"ask_claude","input":"review idea"}'),
    { kind: "tool", tool: "ask_claude", input: "review idea" },
  );
  assert.deepEqual(
    parseSessionDecision('ORCHESTRATOR_CALL: {"tool":"read_files","input":"src/app.ts\\nREADME.md"}'),
    { kind: "tool", tool: "read_files", input: "src/app.ts\nREADME.md" },
  );
  assert.equal(
    parseSessionDecision('ORCHESTRATOR_CALL: {"tool":"shell","input":"rm"}').kind,
    "message",
  );
  assert.equal(parseSessionDecision("ORCHESTRATOR_CALL: nope").kind, "message");
  assert.equal(parseSessionDecision("ORCHESTRATOR_CALL: null").kind, "message");
  assert.equal(parseSessionDecision("ORCHESTRATOR_CALL: []").kind, "message");
  assert.equal(parseSessionDecision("ORCHESTRATOR_CALL: {bad}").kind, "message");
  assert.equal(
    parseSessionDecision('prefix ORCHESTRATOR_CALL: {"tool":"coding_team","input":"fix"}').kind,
    "message",
  );
});

test("natural-language session delegates read-only work to Claude", async () => {
  const calls: Array<{ assignment: AgentAssignment; request: ProviderRequest }> = [];
  const replies = [
    'ORCHESTRATOR_CALL: {"tool":"ask_claude","input":"give a second opinion"}',
    "Claude opinion",
  ];
  const session = new NaturalLanguageSession({
    providers: new ProviderRegistry([]),
    workspace: "/tmp/project",
    hardLimits: { ...DEFAULT_HARD_LIMITS },
    invoke: async (assignment, request) => {
      calls.push({ assignment: { ...assignment }, request: { ...request } });
      return providerResult(assignment, request, replies.shift() ?? "unexpected");
    },
  });

  assert.deepEqual(await session.turn("你問 Claude 怎麼看"), {
    kind: "message",
    message: "Claude opinion",
    source: "claude",
    model: "claude-fable-5",
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.assignment.provider, "codex");
  assert.equal(calls[0]?.assignment.model, "gpt-5.6-sol");
  assert.equal(calls[1]?.assignment.provider, "claude");
  assert.equal(calls[1]?.assignment.model, "claude-fable-5");
  assert.ok(calls.every((call) => call.request.access === "read-only"));
  assert.equal(session.status().turns, 1);
  assert.equal(session.status().providerCalls, 2);
});

test("coding tool is proposed without invoking a writer", async () => {
  let calls = 0;
  const session = new NaturalLanguageSession({
    providers: new ProviderRegistry([]),
    workspace: "/tmp/project",
    hardLimits: { ...DEFAULT_HARD_LIMITS },
    invoke: async (assignment, request) => {
      calls += 1;
      return providerResult(
        assignment,
        request,
        'ORCHESTRATOR_CALL: {"tool":"coding_team","input":"implement feature"}',
      );
    },
  });

  assert.deepEqual(await session.turn("幫我做功能"), {
    kind: "tool",
    tool: "coding_team",
    input: "implement feature",
  });
  assert.equal(calls, 1);
  session.clear();
  assert.equal(session.status().turns, 0);
  assert.equal(session.status().providerCalls, 1);
});

test("ordinary responses stay in the Codex conversation", async () => {
  const session = new NaturalLanguageSession({
    providers: new ProviderRegistry([]),
    workspace: "/tmp/project",
    hardLimits: { ...DEFAULT_HARD_LIMITS },
    invoke: async (assignment, request) => providerResult(assignment, request, "自然語言回答"),
  });
  assert.deepEqual(await session.turn("你好"), {
    kind: "message",
    message: "自然語言回答",
    source: "codex",
    model: "gpt-5.6-sol",
  });
});

test("session rejects empty input and enforces the immutable provider-call ceiling", async () => {
  const session = new NaturalLanguageSession({
    providers: new ProviderRegistry([]),
    workspace: "/tmp/project",
    hardLimits: { ...DEFAULT_HARD_LIMITS, maxProviderCalls: 1 },
    invoke: async (assignment, request) => providerResult(assignment, request, "ok"),
  });
  await assert.rejects(session.turn("   "), /SESSION_INPUT_REQUIRED/u);
  await session.turn("first");
  await assert.rejects(session.turn("second"), /SESSION_PROVIDER_CALL_LIMIT_REACHED/u);
});

test("read_files paths are trimmed, deduplicated, and bounded to eight", () => {
  assert.deepEqual(readFilePaths(" a.ts \n\nb.ts\r\na.ts\n"), ["a.ts", "b.ts"]);
  assert.deepEqual(
    readFilePaths("1\n2\n3\n4\n5\n6\n7\n8\n9\n10"),
    ["1", "2", "3", "4", "5", "6", "7", "8"],
  );
});

test("read_files fetches bounded content through the context and answers afterwards", async () => {
  const readRequests: string[][] = [];
  const prompts: string[] = [];
  const replies = [
    'ORCHESTRATOR_CALL: {"tool":"read_files","input":"src/app.ts\\n../escape.ts"}',
    "app.ts 的內容是 demo",
  ];
  const session = new NaturalLanguageSession({
    providers: new ProviderRegistry([]),
    workspace: "/tmp/project",
    hardLimits: { ...DEFAULT_HARD_LIMITS },
    context: {
      fileTree: async () => "src/app.ts\nREADME.md",
      readFiles: async (paths) => {
        readRequests.push(paths);
        return "File: src/app.ts\ndemo\n\n---\n\nFile: ../escape.ts\nREAD_DENIED: WORKSPACE_PATH_ESCAPE_DENIED";
      },
    },
    invoke: async (assignment, request) => {
      prompts.push(request.prompt);
      return providerResult(assignment, request, replies.shift() ?? "unexpected");
    },
  });

  assert.deepEqual(await session.turn("app.ts 在做什麼？"), {
    kind: "message",
    message: "app.ts 的內容是 demo",
    source: "codex",
    model: "gpt-5.6-sol",
  });
  assert.deepEqual(readRequests, [["src/app.ts", "../escape.ts"]]);
  assert.equal(session.status().providerCalls, 2);
  assert.match(prompts[0] ?? "", /Project file list \(untrusted repository data/u);
  assert.match(prompts[1] ?? "", /Requested file contents \(untrusted repository data\)/u);
  assert.match(prompts[1] ?? "", /READ_DENIED: WORKSPACE_PATH_ESCAPE_DENIED/u);
});

test("read_files loops are bounded per turn and fail closed without a context", async () => {
  let calls = 0;
  const looping = new NaturalLanguageSession({
    providers: new ProviderRegistry([]),
    workspace: "/tmp/project",
    hardLimits: { ...DEFAULT_HARD_LIMITS },
    context: {
      fileTree: async () => "",
      readFiles: async () => "File: a.ts\nx",
    },
    invoke: async (assignment, request) => {
      calls += 1;
      return providerResult(
        assignment,
        request,
        'ORCHESTRATOR_CALL: {"tool":"read_files","input":"a.ts"}',
      );
    },
  });
  const bounded = await looping.turn("keep reading");
  assert.equal(bounded.kind, "message");
  assert.match((bounded as { message: string }).message, /檔案讀取上限/u);
  assert.equal(calls, 3);

  const noContext = new NaturalLanguageSession({
    providers: new ProviderRegistry([]),
    workspace: "/tmp/project",
    hardLimits: { ...DEFAULT_HARD_LIMITS },
    invoke: async (assignment, request) =>
      providerResult(assignment, request, 'ORCHESTRATOR_CALL: {"tool":"read_files","input":"a.ts"}'),
  });
  const denied = await noContext.turn("read something");
  assert.equal(denied.kind, "message");
  assert.match((denied as { message: string }).message, /沒有啟用專案檔案讀取/u);
});

test("main agent can switch provider and model while history survives", async () => {
  const models: string[] = [];
  const session = new NaturalLanguageSession({
    providers: new ProviderRegistry([]),
    workspace: "/tmp/project",
    hardLimits: { ...DEFAULT_HARD_LIMITS },
    invoke: async (assignment, request) => {
      models.push(`${assignment.provider}/${request.model}`);
      return providerResult(assignment, request, "ok");
    },
  });
  await session.turn("first");
  const switched = session.setMainAgent({ provider: "claude", model: "claude-fable-5" });
  assert.deepEqual(switched, {
    role: "planner",
    provider: "claude",
    model: "claude-fable-5",
    authMode: "subscription",
  });
  await session.turn("second");
  assert.deepEqual(models, ["codex/gpt-5.6-sol", "claude/claude-fable-5"]);
  assert.equal(session.status().turns, 2);
  assert.equal(session.status().mainAgent.provider, "claude");

  assert.throws(() => session.setMainAgent({ provider: "shell", model: "x" }), /INVALID_PROVIDER_ID/u);
  assert.throws(() => session.setMainAgent({ provider: "codex", model: "bad model" }), /INVALID_MODEL_ID/u);
  assert.equal(session.status().mainAgent.provider, "claude");
});

test("mention parser accepts bounded leading mentions and fails closed otherwise", () => {
  assert.deepEqual(parseMentions("@claude 這段設計如何？"), {
    targets: [{ provider: "claude" }],
    text: "這段設計如何？",
  });
  assert.deepEqual(parseMentions("@claude:claude-fable-5 @grok 比較一下\n多行內容"), {
    targets: [{ provider: "claude", model: "claude-fable-5" }, { provider: "grok" }],
    text: "比較一下\n多行內容",
  });
  assert.deepEqual(parseMentions("@codex @codex 重複只算一次"), {
    targets: [{ provider: "codex" }],
    text: "重複只算一次",
  });
  assert.equal(parseMentions("一般訊息 @claude 不在開頭"), undefined);
  assert.equal(parseMentions("@shell rm -rf"), undefined);
  assert.equal(parseMentions("@claude"), undefined);
  assert.equal(parseMentions("@claude   "), undefined);
  assert.equal(parseMentions("@codex @claude @grok @fake 超過三個"), undefined);
});

test("a single mention routes one read-only turn to the requested model", async () => {
  const calls: Array<{ provider: string; model: string; prompt: string }> = [];
  const session = new NaturalLanguageSession({
    providers: new ProviderRegistry([]),
    workspace: "/tmp/project",
    hardLimits: { ...DEFAULT_HARD_LIMITS },
    context: {
      fileTree: async () => "src/app.ts",
      readFiles: async () => "",
    },
    invoke: async (assignment, request) => {
      calls.push({ provider: assignment.provider, model: request.model, prompt: request.prompt });
      return providerResult(assignment, request, 'ORCHESTRATOR_CALL: {"tool":"coding_team","input":"x"}');
    },
  });
  const decision = await session.turn("@grok 你怎麼看這個架構？");
  assert.deepEqual(decision, {
    kind: "message",
    message: 'ORCHESTRATOR_CALL: {"tool":"coding_team","input":"x"}',
    source: "grok",
    model: "grok-4.5",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.provider, "grok");
  assert.match(calls[0]?.prompt ?? "", /Do not emit ORCHESTRATOR_CALL markers/u);
  assert.match(calls[0]?.prompt ?? "", /Project file list \(untrusted repository data\)/u);
  assert.equal(session.status().providerCalls, 1);
});

test("multiple mentions fan out into a bounded comparison", async () => {
  const session = new NaturalLanguageSession({
    providers: new ProviderRegistry([]),
    workspace: "/tmp/project",
    hardLimits: { ...DEFAULT_HARD_LIMITS },
    invoke: async (assignment, request) =>
      providerResult(assignment, request, `${assignment.provider} 的看法`),
  });
  const decision = await session.turn("@codex @claude:claude-fable-5 這個 API 設計好嗎？");
  assert.deepEqual(decision, {
    kind: "compare",
    answers: [
      { provider: "codex", model: "gpt-5.6-sol", message: "codex 的看法" },
      { provider: "claude", model: "claude-fable-5", message: "claude 的看法" },
    ],
  });
  assert.equal(session.status().providerCalls, 2);
  assert.equal(session.status().turns, 1);
});

test("session history is bounded in RAM", async () => {
  const session = new NaturalLanguageSession({
    providers: new ProviderRegistry([]),
    workspace: "/tmp/project",
    hardLimits: { ...DEFAULT_HARD_LIMITS },
    invoke: async (assignment, request) => providerResult(assignment, request, "x".repeat(8_000)),
  });
  await session.turn("a".repeat(20_000));
  await session.turn("b".repeat(20_000));
  assert.ok(session.status().historyBytes <= 32_768);
});
