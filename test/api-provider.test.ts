import test from "node:test";
import assert from "node:assert/strict";
import { ApiProvider, estimateMaximumApiCostUsd } from "../src/providers/api.ts";
import type { ProviderRequest } from "../src/types.ts";

test("API cost estimate reserves a conservative byte-token ceiling", () => {
  const amount = estimateMaximumApiCostUsd(
    {
      provider: "codex",
      model: "synthetic-model",
      inputUsdPerMillionTokens: 10,
      outputUsdPerMillionTokens: 20,
      maxOutputTokens: 1000,
    },
    "abc",
  );
  assert.equal(amount, 0.02003);
});

function request(provider: "codex" | "claude" | "grok"): ProviderRequest {
  return {
    runId: "00000000-0000-4000-8000-000000000003",
    role: "reviewer",
    access: "read-only",
    workspace: process.cwd(),
    prompt: "synthetic prompt",
    model: `${provider}-synthetic-model`,
    authMode: "api",
    timeoutMs: 5_000,
    outputLimitBytes: 65_536,
    apiMaxOutputTokens: 100,
  };
}

test("API adapters use fixed endpoints and normalize official response shapes", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalEnvironment = {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    XAI_API_KEY: process.env.XAI_API_KEY,
  };
  const canary = ["synthetic", "credential", "not", "real"].join("-");
  process.env.OPENAI_API_KEY = canary;
  process.env.ANTHROPIC_API_KEY = canary;
  process.env.XAI_API_KEY = canary;
  t.after(() => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const calls: string[] = [];
  globalThis.fetch = async (input, init) => {
    calls.push(String(input));
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "error");
    const url = String(input);
    const value = url.includes("anthropic")
      ? { content: [{ type: "text", text: "claude result" }], usage: { input_tokens: 2, output_tokens: 3 } }
      : { output_text: url.includes("x.ai") ? "grok result" : "codex result", usage: { input_tokens: 2, output_tokens: 3 } };
    return new Response(JSON.stringify(value), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  for (const provider of ["codex", "claude", "grok"] as const) {
    const adapter = new ApiProvider(provider, [
      {
        provider,
        model: `${provider}-synthetic-model`,
        inputUsdPerMillionTokens: 1,
        outputUsdPerMillionTokens: 2,
        maxOutputTokens: 100,
      },
    ]);
    const result = await adapter.invoke(request(provider));
    assert.match(result.text, /result/u);
    assert.equal(result.inputTokens, 2);
    assert.equal(result.outputTokens, 3);
  }
  assert.deepEqual(calls, [
    "https://api.openai.com/v1/responses",
    "https://api.anthropic.com/v1/messages",
    "https://api.x.ai/v1/responses",
  ]);
});

test("API adapter rejects write access and output policy mismatch before network", async () => {
  const adapter = new ApiProvider("codex", [
    {
      provider: "codex",
      model: "codex-synthetic-model",
      inputUsdPerMillionTokens: 1,
      outputUsdPerMillionTokens: 2,
      maxOutputTokens: 100,
    },
  ]);
  await assert.rejects(adapter.invoke({ ...request("codex"), access: "workspace-write" }), /API_WRITER_NOT_SUPPORTED/u);
  await assert.rejects(adapter.invoke({ ...request("codex"), apiMaxOutputTokens: 99 }), /API_OUTPUT_POLICY_MISMATCH/u);
  await assert.rejects(
    adapter.invoke({ ...request("codex"), authMode: "subscription" }),
    /API_PROVIDER_REQUIRES_API_MODE/u,
  );
  assert.throws(() => adapter.policy("missing"), /API_MODEL_POLICY_NOT_CONFIGURED/u);
  assert.deepEqual(await adapter.listModels(), ["codex-synthetic-model"]);
  assert.deepEqual(await adapter.doctor(), { ok: true });
  assert.deepEqual(await new ApiProvider("codex", []).doctor(), {
    ok: false,
    reason: "API_NOT_CONFIGURED",
  });
});

test("API adapter fails closed on HTTP, body, JSON and output bounds", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalSecret = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "synthetic-not-real-secret";
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalSecret === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalSecret;
  });
  const adapter = new ApiProvider("codex", [
    {
      provider: "codex",
      model: "codex-synthetic-model",
      inputUsdPerMillionTokens: 1,
      outputUsdPerMillionTokens: 2,
      maxOutputTokens: 100,
    },
  ]);

  globalThis.fetch = async () => new Response("failure", { status: 503 });
  await assert.rejects(adapter.invoke(request("codex")), /API_HTTP_STATUS:503/u);

  globalThis.fetch = async () => new Response(null, { status: 200 });
  await assert.rejects(adapter.invoke(request("codex")), /API_RESPONSE_BODY_MISSING/u);

  globalThis.fetch = async () => new Response("not-json", { status: 200 });
  await assert.rejects(adapter.invoke(request("codex")), /API_RESPONSE_JSON_INVALID/u);

  globalThis.fetch = async () => new Response("null", { status: 200 });
  await assert.rejects(adapter.invoke(request("codex")), /API_RESPONSE_SCHEMA_INVALID/u);

  globalThis.fetch = async () => new Response("{}", { status: 200 });
  await assert.rejects(adapter.invoke(request("codex")), /API_RESPONSE_TEXT_MISSING/u);

  globalThis.fetch = async () =>
    new Response(JSON.stringify({ output_text: "x".repeat(100) }), { status: 200 });
  await assert.rejects(
    adapter.invoke({ ...request("codex"), outputLimitBytes: 10 }),
    /API_OUTPUT_LIMIT_REACHED/u,
  );

  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        output: [{ content: [{ type: "output_text", text: "nested result" }] }],
      }),
      { status: 200 },
    );
  const result = await adapter.invoke(request("codex"));
  assert.equal(result.text, "nested result");
  assert.equal(result.inputTokens, undefined);
  assert.ok((result.estimatedCostUsd ?? 0) > 0);

  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        output: [
          { content: "ignored" },
          { content: [{ type: "other", text: "ignored" }, { type: "text", text: "fallback text" }] },
        ],
      }),
      { status: 200 },
    );
  assert.equal((await adapter.invoke(request("codex"))).text, "fallback text");
});
