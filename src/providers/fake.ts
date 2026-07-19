import { setTimeout as delay } from "node:timers/promises";
import type { ProviderRequest, ProviderResult } from "../types.ts";
import type { ProviderAdapter, ProviderCapabilities } from "./provider.ts";

export class FakeProvider implements ProviderAdapter {
  readonly capabilities: ProviderCapabilities = {
    id: "fake",
    displayName: "Fake Provider (no quota used)",
    subscription: true,
    api: false,
    canWrite: true,
    canWriteSubscription: true,
    canWriteApi: false,
    apiConfigured: false,
    modelDiscovery: "static",
    suggestedModels: ["fake"],
    subscriptionModels: ["fake"],
    apiModels: [],
  };

  async invoke(request: ProviderRequest): Promise<ProviderResult> {
    const started = Date.now();
    await delay(5, undefined, { signal: request.signal });
    const text =
      request.role === "reviewer"
        ? "Synthetic review completed.\nORCHESTRATOR_VERDICT: PASS"
        : request.role === "writer"
          ? "Synthetic writer completed without modifying files.\nORCHESTRATOR_STATUS: DONE"
          : "Synthetic plan completed.\nORCHESTRATOR_STATUS: DONE";
    return {
      provider: "fake",
      model: "fake",
      text,
      exitCode: 0,
      durationMs: Date.now() - started,
      outputBytes: Buffer.byteLength(text),
    };
  }

  async doctor(): Promise<{ ok: boolean; version: string }> {
    return { ok: true, version: "built-in" };
  }

  async listModels(): Promise<string[]> {
    return ["fake"];
  }
}
