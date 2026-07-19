import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderCallGovernor } from "../src/core/provider-call-governor.ts";
import { ProviderRegistry } from "../src/providers/registry.ts";
import type { ProviderAdapter } from "../src/providers/provider.ts";
import type { ProviderId, ProviderRequest } from "../src/types.ts";

test("provider registry caches bounded model discovery and keeps API fail closed", async () => {
  const registry = new ProviderRegistry();
  assert.deepEqual(await registry.listModels("fake", "subscription"), ["fake"]);
  assert.deepEqual(await registry.listModels("fake", "subscription"), ["fake"]);
  assert.deepEqual(await registry.listModels("codex", "subscription"), ["gpt-5.6-sol", "default"]);
  assert.deepEqual(await registry.listModels("codex", "api"), []);
  assert.equal(registry.canWrite("claude", "subscription"), true);
  assert.equal(registry.canWrite("claude", "api"), false);
  assert.throws(() => registry.register(registry.get("fake")), /DUPLICATE_PROVIDER/u);
  await assert.rejects(registry.listModels("fake", "api"), /FAKE_PROVIDER_HAS_NO_API_MODE/u);
  await assert.rejects(
    registry.prepareApiCall("fake", "fake", "synthetic"),
    /FAKE_PROVIDER_HAS_NO_API_MODE/u,
  );
  assert.equal(registry.capabilities().length, 4);
});

test("provider registry preserves adapter behavior behind the shared call governor", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "orchestratory-registry-governed-"));
  const governor = new ProviderCallGovernor(data, 2, { pollMs: 10 });
  t.after(() => governor.close());
  t.after(async () => await rm(data, { recursive: true, force: true }));
  const registry = new ProviderRegistry([], { governor });
  const syntheticId = "synthetic" as ProviderId;
  const adapter: ProviderAdapter = {
    capabilities: {
      id: syntheticId,
      displayName: "Synthetic governed provider",
      subscription: true,
      api: false,
      canWrite: false,
      canWriteSubscription: false,
      canWriteApi: false,
      apiConfigured: false,
      modelDiscovery: "static",
      suggestedModels: ["synthetic"],
      subscriptionModels: ["synthetic"],
      apiModels: [],
    },
    async invoke(request) {
      return {
        provider: syntheticId,
        model: request.model,
        text: "governed",
        exitCode: 0,
        durationMs: 1,
        outputBytes: 8,
      };
    },
    async doctor() {
      return { ok: true, version: "synthetic" };
    },
    async listModels() {
      return ["synthetic"];
    },
  };
  registry.register(adapter);
  const request: ProviderRequest = {
    runId: "00000000-0000-4000-8000-000000000099",
    role: "planner",
    access: "read-only",
    workspace: data,
    prompt: "synthetic",
    model: "synthetic",
    authMode: "subscription",
    timeoutMs: 1_000,
    outputLimitBytes: 1_024,
  };
  assert.equal((await registry.get(syntheticId).invoke(request)).text, "governed");
  assert.deepEqual(await registry.get(syntheticId).doctor(), { ok: true, version: "synthetic" });
  assert.deepEqual(await registry.get(syntheticId).listModels(), ["synthetic"]);
  assert.throws(() => registry.get("missing" as ProviderId), /PROVIDER_NOT_REGISTERED/u);
});
