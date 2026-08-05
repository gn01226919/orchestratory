import type { ProviderId } from "../types.ts";

/**
 * How a provider call is paid for.
 *
 * - `billed`: the call has a metered monetary price. Every API-mode call must reserve
 *   its worst-case USD against the per-call, per-run, per-day and per-month ceilings
 *   before any network traffic happens.
 * - `no-cost`: the call has no monetary price at all — an in-process fake, or a model
 *   served by a process the owner already runs on loopback. Zero here is a *measured*
 *   zero, never "not yet priced".
 *
 * `no-cost` removes exactly one control: the monetary reservation. It never removes a
 * call-count, round, timeout, concurrency, consecutive-failure or kill-switch bound.
 */
export type ProviderBillingModel = "billed" | "no-cost";

/**
 * Whether a provider call occupies a subprocess slot.
 *
 * `in-process` providers spawn nothing: the fake adapter answers inline and the local
 * adapter issues one bounded loopback HTTP request to a server the owner started
 * outside Orchestratory. Counting a subprocess for them would make the subprocess
 * counter untruthful; they stay bounded by the provider-call ceilings instead.
 */
export type ProviderExecutionModel = "subprocess" | "in-process";

/**
 * Explicit per-provider opt-in tables.
 *
 * `satisfies Record<ProviderId, …>` makes them total: adding an id to `ProviderId`
 * without classifying it here is a compile error. A future provider therefore cannot
 * inherit "no monetary budget" by omission, and a missed lookup can never be read as
 * free — `providerBillingModel` throws instead of defaulting.
 */
const PROVIDER_BILLING_MODEL = {
  fake: "no-cost",
  local: "no-cost",
  codex: "billed",
  claude: "billed",
  grok: "billed",
} as const satisfies Record<ProviderId, ProviderBillingModel>;

const PROVIDER_EXECUTION_MODEL = {
  fake: "in-process",
  local: "in-process",
  codex: "subprocess",
  claude: "subprocess",
  grok: "subprocess",
} as const satisfies Record<ProviderId, ProviderExecutionModel>;

function declared<T extends string>(
  table: Readonly<Record<string, string>>,
  id: string,
  allowed: readonly T[],
  code: string,
): T {
  const value = table[id];
  // Runtime backstop for an id that reached here without passing a parser: an
  // undeclared provider fails closed rather than silently taking the cheaper path.
  if (value === undefined || !(allowed as readonly string[]).includes(value)) throw new Error(code);
  return value as T;
}

export function providerBillingModel(id: ProviderId): ProviderBillingModel {
  return declared(
    PROVIDER_BILLING_MODEL,
    id,
    ["billed", "no-cost"] as const,
    "PROVIDER_BILLING_MODEL_UNDECLARED",
  );
}

/** True only for providers that explicitly opted into the no-monetary-cost path. */
export function isNoCostProvider(id: ProviderId): boolean {
  return providerBillingModel(id) === "no-cost";
}

export function providerExecutionModel(id: ProviderId): ProviderExecutionModel {
  return declared(
    PROVIDER_EXECUTION_MODEL,
    id,
    ["subprocess", "in-process"] as const,
    "PROVIDER_EXECUTION_MODEL_UNDECLARED",
  );
}
