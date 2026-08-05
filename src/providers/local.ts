import { performance } from "node:perf_hooks";
import type { ProviderRequest, ProviderResult } from "../types.ts";
import { redact } from "../security/redact.ts";
import { readBoundedJson } from "./bounded-json.ts";
import type { ProviderAdapter, ProviderCapabilities } from "./provider.ts";

/**
 * Local model adapter for servers that speak the OpenAI-compatible HTTP surface
 * (Ollama, LM Studio, llama.cpp server). It consumes no subscription quota and
 * no API credential, so no secret is loaded, stored or sent here.
 *
 * Hard security boundary: the endpoint is loopback-only. A "local model" adapter
 * that can be pointed at an arbitrary host is an exfiltration channel, so every
 * non-loopback origin, credentialed URL, non-http scheme and redirect fails
 * closed with a stable code instead of being normalized into something usable.
 */

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "[::1]", "localhost"]);
const MODEL_PATTERN = /^[A-Za-z0-9._:/-]{1,128}$/u;
const MAX_ENDPOINT_LENGTH = 200;
const MAX_MODELS = 100;
const DEFAULT_DISCOVERY_TIMEOUT_MS = 10_000;
const DEFAULT_DISCOVERY_LIMIT_BYTES = 262_144;

export interface LocalProviderOptions {
  endpoint: string;
  displayName?: string;
  discoveryTimeoutMs?: number;
  discoveryLimitBytes?: number;
}

interface FetchOptions {
  path: string;
  body?: string;
  timeoutMs: number;
  limitBytes: number;
  allowNotFound: boolean;
  signal?: AbortSignal;
}

/**
 * Validates an owner-supplied base URL and returns the canonical origin.
 * `localhost` is pinned to 127.0.0.1 so a poisoned hosts file or resolver cannot
 * move the connection off the loopback interface.
 */
export function normalizeLocalEndpoint(value: unknown): string {
  if (typeof value !== "string") throw new Error("LOCAL_ENDPOINT_MALFORMED");
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error("LOCAL_ENDPOINT_MALFORMED");
  if (trimmed.length > MAX_ENDPOINT_LENGTH) throw new Error("LOCAL_ENDPOINT_MALFORMED");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("LOCAL_ENDPOINT_MALFORMED");
  }
  if (url.protocol !== "http:") throw new Error("LOCAL_ENDPOINT_SCHEME_DENIED");
  if (url.username !== "") throw new Error("LOCAL_ENDPOINT_CREDENTIALS_DENIED");
  if (url.password !== "") throw new Error("LOCAL_ENDPOINT_CREDENTIALS_DENIED");
  if (!LOOPBACK_HOSTNAMES.has(url.hostname)) throw new Error("LOCAL_ENDPOINT_NOT_LOOPBACK");
  if (url.port === "") throw new Error("LOCAL_ENDPOINT_PORT_REQUIRED");
  if (Number(url.port) < 1) throw new Error("LOCAL_ENDPOINT_PORT_REQUIRED");
  if (url.pathname !== "/") throw new Error("LOCAL_ENDPOINT_PATH_DENIED");
  if (url.search !== "") throw new Error("LOCAL_ENDPOINT_PATH_DENIED");
  if (url.hash !== "") throw new Error("LOCAL_ENDPOINT_PATH_DENIED");
  const host = url.hostname === "localhost" ? "127.0.0.1" : url.hostname;
  return `http://${host}:${url.port}`;
}

/** Normalizes any failure into a stable code; raw socket text never escapes. */
export function localErrorCode(error: unknown): string {
  if (!(error instanceof Error)) return "LOCAL_ENDPOINT_UNREACHABLE";
  return error.message.startsWith("LOCAL_") ? error.message : "LOCAL_ENDPOINT_UNREACHABLE";
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("LOCAL_RESPONSE_SCHEMA_INVALID");
  }
  return value as Record<string, unknown>;
}

function validateModel(model: string): void {
  if (!MODEL_PATTERN.test(model)) throw new Error("LOCAL_MODEL_ID_INVALID");
}

function validatePrompt(prompt: string): void {
  if (prompt.length < 1 || prompt.length > 500_000) throw new Error("LOCAL_PROMPT_INVALID");
  if (prompt.includes("\0")) throw new Error("LOCAL_PROMPT_INVALID");
}

function modelIds(values: unknown[]): string[] {
  if (values.length > MAX_MODELS) throw new Error("LOCAL_MODEL_LIST_TOO_LARGE");
  const ids: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") throw new Error("LOCAL_MODEL_ID_INVALID");
    if (!MODEL_PATTERN.test(value)) throw new Error("LOCAL_MODEL_ID_INVALID");
    ids.push(value);
  }
  return [...new Set(ids)];
}

function openAiModelIds(value: Record<string, unknown>): string[] {
  if (!Array.isArray(value.data)) throw new Error("LOCAL_RESPONSE_SCHEMA_INVALID");
  return modelIds(value.data.map((entry) => asRecord(entry).id));
}

function ollamaModelNames(value: Record<string, unknown>): string[] {
  if (!Array.isArray(value.models)) throw new Error("LOCAL_RESPONSE_SCHEMA_INVALID");
  return modelIds(value.models.map((entry) => asRecord(entry).name));
}

function completionText(value: Record<string, unknown>): string {
  if (!Array.isArray(value.choices)) throw new Error("LOCAL_RESPONSE_SCHEMA_INVALID");
  const parts: string[] = [];
  for (const entry of value.choices) {
    const message = asRecord(entry).message;
    if (typeof message !== "object" || message === null) continue;
    const content = (message as Record<string, unknown>).content;
    if (typeof content === "string" && content.length > 0) parts.push(content);
  }
  if (parts.length === 0) throw new Error("LOCAL_RESPONSE_TEXT_MISSING");
  return parts.join("");
}

function tokenCount(value: unknown): number | undefined {
  if (typeof value !== "number") return undefined;
  if (!Number.isSafeInteger(value)) return undefined;
  if (value < 0) return undefined;
  return value;
}

function usageTokens(value: Record<string, unknown>): { inputTokens?: number; outputTokens?: number } {
  const usage = value.usage;
  if (typeof usage !== "object" || usage === null) return {};
  const data = usage as Record<string, unknown>;
  const inputTokens = tokenCount(data.prompt_tokens);
  const outputTokens = tokenCount(data.completion_tokens);
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
  };
}

export class LocalModelProvider implements ProviderAdapter {
  readonly capabilities: ProviderCapabilities;
  readonly #origin: string;
  readonly #discoveryTimeoutMs: number;
  readonly #discoveryLimitBytes: number;

  constructor(options: LocalProviderOptions) {
    this.#origin = normalizeLocalEndpoint(options.endpoint);
    this.#discoveryTimeoutMs = options.discoveryTimeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;
    this.#discoveryLimitBytes = options.discoveryLimitBytes ?? DEFAULT_DISCOVERY_LIMIT_BYTES;
    this.capabilities = {
      id: "local",
      displayName: options.displayName ?? "Local model endpoint (no subscription quota)",
      subscription: true,
      api: false,
      canWrite: false,
      canWriteSubscription: false,
      canWriteApi: false,
      apiConfigured: false,
      modelDiscovery: "endpoint",
      suggestedModels: [],
      subscriptionModels: [],
      apiModels: [],
    };
  }

  get endpoint(): string {
    return this.#origin;
  }

  /**
   * One bounded attempt per call: explicit timeout, byte ceiling, no retry and no
   * redirect following. Returns undefined only when `allowNotFound` is set and the
   * endpoint answered 404, which model discovery uses to try the other surface.
   */
  async #fetchJson(options: FetchOptions): Promise<unknown | undefined> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
    timeout.unref();
    const onAbort = (): void => controller.abort();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const response = await fetch(`${this.#origin}${options.path}`, {
        method: options.body === undefined ? "GET" : "POST",
        headers: options.body === undefined
          ? { Accept: "application/json" }
          : { Accept: "application/json", "Content-Type": "application/json" },
        ...(options.body === undefined ? {} : { body: options.body }),
        signal: controller.signal,
        redirect: "manual",
      });
      if (response.status >= 300 && response.status < 400) {
        controller.abort();
        throw new Error("LOCAL_ENDPOINT_REDIRECT_DENIED");
      }
      if (response.status === 404 && options.allowNotFound) {
        controller.abort();
        return undefined;
      }
      if (!response.ok) {
        controller.abort();
        throw new Error(`LOCAL_HTTP_STATUS:${response.status}`);
      }
      return await readBoundedJson(response, options.limitBytes, controller, "LOCAL");
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("LOCAL_")) throw error;
      if (options.signal?.aborted) throw new Error("LOCAL_CANCELLED");
      if (controller.signal.aborted) throw new Error("LOCAL_TIMEOUT");
      throw new Error("LOCAL_ENDPOINT_UNREACHABLE");
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
    }
  }

  async invoke(request: ProviderRequest): Promise<ProviderResult> {
    // API mode carries credentials and a metered budget; a local endpoint has neither.
    // It is declared `no-cost` in providers/billing.ts, which skips the monetary
    // reservation only — every non-monetary hard limit still applies.
    if (request.authMode !== "subscription") throw new Error("LOCAL_AUTH_MODE_UNSUPPORTED");
    if (request.access !== "read-only") throw new Error("LOCAL_WRITER_NOT_SUPPORTED");
    validateModel(request.model);
    validatePrompt(request.prompt);
    const started = performance.now();
    const payload = await this.#fetchJson({
      path: "/v1/chat/completions",
      body: JSON.stringify({
        model: request.model,
        messages: [{ role: "user", content: request.prompt }],
        stream: false,
      }),
      timeoutMs: request.timeoutMs,
      limitBytes: request.outputLimitBytes,
      allowNotFound: false,
      ...(request.signal ? { signal: request.signal } : {}),
    });
    const value = asRecord(payload);
    const text = redact(completionText(value));
    return {
      provider: "local",
      model: request.model,
      text,
      exitCode: 0,
      durationMs: Math.round(performance.now() - started),
      outputBytes: Buffer.byteLength(text),
      estimatedCostUsd: 0,
      ...usageTokens(value),
    };
  }

  async doctor(): Promise<{ ok: boolean; version?: string; reason?: string }> {
    try {
      const models = await this.listModels();
      return { ok: true, version: `${models.length} local model(s) available` };
    } catch (error) {
      return { ok: false, reason: localErrorCode(error) };
    }
  }

  /**
   * Discovery prefers the OpenAI-compatible listing and falls back to the Ollama
   * native listing only when the first surface is absent. An unreachable endpoint
   * or an unparsable payload throws a stable code; it never degrades to [].
   */
  async listModels(): Promise<string[]> {
    const discovered = await this.#fetchJson({
      path: "/v1/models",
      timeoutMs: this.#discoveryTimeoutMs,
      limitBytes: this.#discoveryLimitBytes,
      allowNotFound: true,
    });
    const models = discovered === undefined
      ? ollamaModelNames(asRecord(await this.#fetchJson({
        path: "/api/tags",
        timeoutMs: this.#discoveryTimeoutMs,
        limitBytes: this.#discoveryLimitBytes,
        allowNotFound: false,
      })))
      : openAiModelIds(asRecord(discovered));
    if (models.length === 0) throw new Error("LOCAL_MODELS_EMPTY");
    return models;
  }
}
