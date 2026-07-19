import type { ApiModelPolicy, AuthMode, ProviderId } from "../types.ts";
import { FakeProvider } from "./fake.ts";
import { SubscriptionCliProvider } from "./cli.ts";
import { ApiProvider, estimateMaximumApiCostUsd } from "./api.ts";
import type { ProviderAdapter, ProviderCapabilities } from "./provider.ts";
import type { ProviderCallGovernor } from "../core/provider-call-governor.ts";

class GovernedProvider implements ProviderAdapter {
  readonly capabilities: ProviderCapabilities;
  readonly #inner: ProviderAdapter;
  readonly #governor: ProviderCallGovernor;

  constructor(inner: ProviderAdapter, governor: ProviderCallGovernor) {
    this.#inner = inner;
    this.#governor = governor;
    this.capabilities = inner.capabilities;
  }

  invoke(request: Parameters<ProviderAdapter["invoke"]>[0]): ReturnType<ProviderAdapter["invoke"]> {
    return this.#governor.invoke(request, async (governed) => await this.#inner.invoke(governed));
  }

  doctor(): ReturnType<ProviderAdapter["doctor"]> {
    return this.#inner.doctor();
  }

  listModels(): ReturnType<ProviderAdapter["listModels"]> {
    return this.#inner.listModels();
  }
}

class HybridProvider implements ProviderAdapter {
  readonly capabilities: ProviderCapabilities;
  readonly #subscription: SubscriptionCliProvider;
  readonly #api: ApiProvider;

  constructor(subscription: SubscriptionCliProvider, api: ApiProvider) {
    this.#subscription = subscription;
    this.#api = api;
    this.capabilities = {
      id: subscription.capabilities.id,
      displayName: subscription.capabilities.displayName,
      subscription: true,
      api: true,
      canWrite: subscription.capabilities.canWrite,
      canWriteSubscription: subscription.capabilities.canWrite,
      canWriteApi: false,
      apiConfigured: api.configured(),
      modelDiscovery: subscription.capabilities.modelDiscovery,
      suggestedModels: [
        ...new Set([
          ...subscription.capabilities.suggestedModels,
          ...api.capabilities.suggestedModels,
        ]),
      ],
      subscriptionModels: [...subscription.capabilities.subscriptionModels],
      apiModels: [...api.capabilities.apiModels],
    };
  }

  invoke(request: Parameters<ProviderAdapter["invoke"]>[0]): ReturnType<ProviderAdapter["invoke"]> {
    return request.authMode === "api" ? this.#api.invoke(request) : this.#subscription.invoke(request);
  }

  doctor(): ReturnType<ProviderAdapter["doctor"]> {
    return this.#subscription.doctor();
  }

  async listModels(): Promise<string[]> {
    return [...new Set([...(await this.#subscription.listModels()), ...(await this.#api.listModels())])];
  }
}

export class ProviderRegistry {
  readonly #providers = new Map<ProviderId, ProviderAdapter>();
  readonly #apiProviders = new Map<Exclude<ProviderId, "fake">, ApiProvider>();
  readonly #subscriptionProviders = new Map<Exclude<ProviderId, "fake">, SubscriptionCliProvider>();
  readonly #modelCache = new Map<string, { expiresAt: number; models: string[] }>();
  readonly #governor: ProviderCallGovernor | undefined;

  constructor(
    policies: ReadonlyArray<Readonly<ApiModelPolicy>> = [],
    options: { codexWriterEnabled?: boolean; governor?: ProviderCallGovernor } = {},
  ) {
    this.#governor = options.governor;
    this.register(new FakeProvider());
    for (const id of ["codex", "claude", "grok"] as const) {
      const api = new ApiProvider(id, policies);
      const subscription = new SubscriptionCliProvider(
        id,
        id === "codex" ? { codexWriterEnabled: options.codexWriterEnabled === true } : {},
      );
      this.#apiProviders.set(id, api);
      this.#subscriptionProviders.set(id, subscription);
      this.register(new HybridProvider(subscription, api));
    }
  }

  register(provider: ProviderAdapter): void {
    if (this.#providers.has(provider.capabilities.id)) throw new Error("DUPLICATE_PROVIDER");
    this.#providers.set(
      provider.capabilities.id,
      this.#governor && provider.capabilities.id !== "fake"
        ? new GovernedProvider(provider, this.#governor)
        : provider,
    );
  }

  get(id: ProviderId): ProviderAdapter {
    const provider = this.#providers.get(id);
    if (!provider) throw new Error(`PROVIDER_NOT_REGISTERED:${id}`);
    return provider;
  }

  canWrite(id: ProviderId, authMode: AuthMode): boolean {
    const capabilities = this.get(id).capabilities;
    return authMode === "api" ? capabilities.canWriteApi : capabilities.canWriteSubscription;
  }

  async listModels(id: ProviderId, authMode: AuthMode): Promise<string[]> {
    const key = `${id}:${authMode}`;
    const cached = this.#modelCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return [...cached.models];
    if (id === "fake" && authMode === "api") throw new Error("FAKE_PROVIDER_HAS_NO_API_MODE");
    const provider = id === "fake"
      ? this.get(id)
      : authMode === "api"
        ? this.#apiProviders.get(id)
        : this.#subscriptionProviders.get(id);
    if (!provider) throw new Error("PROVIDER_MODE_NOT_REGISTERED");
    const discovered = (await provider.listModels())
      .filter((model) => /^[A-Za-z0-9._:/-]{1,128}$/u.test(model))
      .slice(0, 100);
    const fallback = authMode === "api"
      ? this.get(id).capabilities.apiModels
      : this.get(id).capabilities.subscriptionModels;
    const models = [...new Set(discovered.length > 0 ? discovered : fallback)];
    this.#modelCache.set(key, { expiresAt: Date.now() + 5 * 60_000, models });
    return [...models];
  }

  async prepareApiCall(id: ProviderId, model: string, prompt: string): Promise<{
    maximumCostUsd: number;
    maxOutputTokens: number;
  }> {
    if (id === "fake") throw new Error("FAKE_PROVIDER_HAS_NO_API_MODE");
    const provider = this.#apiProviders.get(id);
    if (!provider) throw new Error("API_PROVIDER_NOT_REGISTERED");
    if (!provider.configured()) throw new Error("API_CREDENTIAL_OR_MODEL_POLICY_NOT_CONFIGURED");
    const policy = provider.policy(model);
    await provider.verifyCredential();
    return {
      maximumCostUsd: estimateMaximumApiCostUsd(policy, prompt),
      maxOutputTokens: policy.maxOutputTokens,
    };
  }

  capabilities(): ProviderCapabilities[] {
    return [...this.#providers.values()].map((provider) => ({
      ...provider.capabilities,
      suggestedModels: [...provider.capabilities.suggestedModels],
      subscriptionModels: [...provider.capabilities.subscriptionModels],
      apiModels: [...provider.capabilities.apiModels],
    }));
  }
}
