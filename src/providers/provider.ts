import type { ProviderId, ProviderRequest, ProviderResult } from "../types.ts";

export interface ProviderCapabilities {
  id: ProviderId;
  displayName: string;
  subscription: boolean;
  api: boolean;
  canWrite: boolean;
  canWriteSubscription: boolean;
  canWriteApi: boolean;
  apiConfigured: boolean;
  modelDiscovery: "cli" | "manual" | "static" | "endpoint";
  suggestedModels: string[];
  subscriptionModels: string[];
  apiModels: string[];
}

export interface ProviderAdapter {
  readonly capabilities: ProviderCapabilities;
  invoke(request: ProviderRequest): Promise<ProviderResult>;
  doctor(): Promise<{ ok: boolean; version?: string; reason?: string }>;
  listModels(): Promise<string[]>;
}
