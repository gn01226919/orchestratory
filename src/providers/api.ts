import { performance } from "node:perf_hooks";
import type {
  ApiModelPolicy,
  ProviderId,
  ProviderRequest,
  ProviderResult,
} from "../types.ts";
import { redact } from "../security/redact.ts";
import { loadApiSecret } from "../security/secret-provider.ts";
import { readBoundedJson } from "./bounded-json.ts";
import type { ProviderAdapter, ProviderCapabilities } from "./provider.ts";

type ApiProviderId = Exclude<ProviderId, "fake" | "local">;

const DEFINITIONS: Record<
  ApiProviderId,
  { displayName: string; endpoint: string; secretEnvironmentKey: string }
> = {
  codex: {
    displayName: "OpenAI API",
    endpoint: "https://api.openai.com/v1/responses",
    secretEnvironmentKey: "OPENAI_API_KEY",
  },
  claude: {
    displayName: "Anthropic API",
    endpoint: "https://api.anthropic.com/v1/messages",
    secretEnvironmentKey: "ANTHROPIC_API_KEY",
  },
  grok: {
    displayName: "xAI API",
    endpoint: "https://api.x.ai/v1/responses",
    secretEnvironmentKey: "XAI_API_KEY",
  },
};

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("API_RESPONSE_SCHEMA_INVALID");
  }
  return value as Record<string, unknown>;
}

function numeric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function responseText(provider: ApiProviderId, value: Record<string, unknown>): string {
  if (provider === "claude") {
    if (!Array.isArray(value.content)) throw new Error("API_RESPONSE_TEXT_MISSING");
    const text = value.content
      .map((item) => asRecord(item))
      .filter((item) => item.type === "text" && typeof item.text === "string")
      .map((item) => item.text as string)
      .join("");
    if (!text) throw new Error("API_RESPONSE_TEXT_MISSING");
    return text;
  }
  if (typeof value.output_text === "string" && value.output_text.length > 0) {
    return value.output_text;
  }
  if (!Array.isArray(value.output)) throw new Error("API_RESPONSE_TEXT_MISSING");
  const parts: string[] = [];
  for (const itemValue of value.output) {
    const item = asRecord(itemValue);
    if (!Array.isArray(item.content)) continue;
    for (const contentValue of item.content) {
      const content = asRecord(contentValue);
      if ((content.type === "output_text" || content.type === "text") && typeof content.text === "string") {
        parts.push(content.text);
      }
    }
  }
  if (parts.length === 0) throw new Error("API_RESPONSE_TEXT_MISSING");
  return parts.join("");
}

function usage(provider: ApiProviderId, value: Record<string, unknown>): {
  inputTokens?: number;
  outputTokens?: number;
} {
  if (typeof value.usage !== "object" || value.usage === null || Array.isArray(value.usage)) return {};
  const data = value.usage as Record<string, unknown>;
  const inputTokens = numeric(data.input_tokens ?? data.prompt_tokens);
  const outputTokens = numeric(data.output_tokens ?? data.completion_tokens);
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
  };
}

export function estimateMaximumApiCostUsd(policy: ApiModelPolicy, prompt: string): number {
  const conservativeInputTokenCeiling = Buffer.byteLength(prompt, "utf8");
  const amount =
    (conservativeInputTokenCeiling * policy.inputUsdPerMillionTokens +
      policy.maxOutputTokens * policy.outputUsdPerMillionTokens) /
    1_000_000;
  return Math.ceil(amount * 1_000_000) / 1_000_000;
}

export class ApiProvider implements ProviderAdapter {
  readonly capabilities: ProviderCapabilities;
  readonly #id: ApiProviderId;
  readonly #policies: ReadonlyMap<string, Readonly<ApiModelPolicy>>;

  constructor(id: ApiProviderId, policies: ReadonlyArray<Readonly<ApiModelPolicy>>) {
    this.#id = id;
    this.#policies = new Map(
      policies.filter((policy) => policy.provider === id).map((policy) => [policy.model, policy]),
    );
    this.capabilities = {
      id,
      displayName: DEFINITIONS[id].displayName,
      subscription: false,
      api: true,
      canWrite: false,
      canWriteSubscription: false,
      canWriteApi: false,
      apiConfigured: this.#policies.size > 0,
      modelDiscovery: "static",
      suggestedModels: [...this.#policies.keys()],
      subscriptionModels: [],
      apiModels: [...this.#policies.keys()],
    };
  }

  configured(): boolean {
    return this.#policies.size > 0;
  }

  policy(model: string): Readonly<ApiModelPolicy> {
    const policy = this.#policies.get(model);
    if (!policy) throw new Error("API_MODEL_POLICY_NOT_CONFIGURED");
    return policy;
  }

  async verifyCredential(): Promise<void> {
    await loadApiSecret(DEFINITIONS[this.#id].secretEnvironmentKey);
  }

  async invoke(request: ProviderRequest): Promise<ProviderResult> {
    if (request.authMode !== "api") throw new Error("API_PROVIDER_REQUIRES_API_MODE");
    if (request.access !== "read-only") throw new Error("API_WRITER_NOT_SUPPORTED");
    const policy = this.policy(request.model);
    if (request.apiMaxOutputTokens !== policy.maxOutputTokens) {
      throw new Error("API_OUTPUT_POLICY_MISMATCH");
    }
    const secret = await loadApiSecret(DEFINITIONS[this.#id].secretEnvironmentKey);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), request.timeoutMs);
    timeout.unref();
    const onAbort = (): void => controller.abort();
    request.signal?.addEventListener("abort", onAbort, { once: true });
    const started = performance.now();
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      let body: Record<string, unknown>;
      if (this.#id === "claude") {
        headers["x-api-key"] = secret;
        headers["anthropic-version"] = "2023-06-01";
        body = {
          model: request.model,
          max_tokens: policy.maxOutputTokens,
          messages: [{ role: "user", content: request.prompt }],
        };
      } else {
        headers.Authorization = `Bearer ${secret}`;
        body = {
          model: request.model,
          input: request.prompt,
          max_output_tokens: policy.maxOutputTokens,
          store: false,
        };
      }
      const response = await fetch(DEFINITIONS[this.#id].endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
        redirect: "error",
      });
      if (!response.ok) {
        controller.abort();
        throw new Error(`API_HTTP_STATUS:${response.status}`);
      }
      const value = asRecord(await readBoundedJson(response, request.outputLimitBytes, controller, "API"));
      const text = redact(responseText(this.#id, value));
      const measuredUsage = usage(this.#id, value);
      const estimatedCostUsd =
        measuredUsage.inputTokens !== undefined && measuredUsage.outputTokens !== undefined
          ? (measuredUsage.inputTokens * policy.inputUsdPerMillionTokens +
              measuredUsage.outputTokens * policy.outputUsdPerMillionTokens) /
            1_000_000
          : estimateMaximumApiCostUsd(policy, request.prompt);
      return {
        provider: this.#id,
        model: request.model,
        text,
        exitCode: 0,
        durationMs: Math.round(performance.now() - started),
        outputBytes: Buffer.byteLength(text),
        estimatedCostUsd,
        ...measuredUsage,
      };
    } catch (error) {
      if (request.signal?.aborted) throw new Error("API_CANCELLED");
      if (controller.signal.aborted && error instanceof Error && error.name === "AbortError") {
        throw new Error("API_TIMEOUT");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", onAbort);
    }
  }

  async doctor(): Promise<{ ok: boolean; reason?: string }> {
    return this.configured() ? { ok: true } : { ok: false, reason: "API_NOT_CONFIGURED" };
  }

  async listModels(): Promise<string[]> {
    return [...this.#policies.keys()];
  }
}
