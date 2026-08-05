import type { ProviderId } from "../types.ts";
import type { ManagedAgentProvider } from "../core/managed-room-agent.ts";
import type { WriterProvider } from "../core/writer-lease.ts";

/**
 * Single source of truth for provider *selection*: which provider ids a human may
 * pick, on which surface, and — when one is deliberately withheld — why.
 *
 * The billing layer (providers/billing.ts) already proved the shape works: an
 * `as const satisfies Record<ProviderId, …>` table cannot compile while a
 * provider is unclassified, so a new provider can never inherit a default by
 * omission. Selection had drifted the other way. Every menu kept its own
 * hand-written array — `src/ui/tui.ts`, `src/ui/request.ts`, three lists in
 * `src/ui/web.ts`, one in `public/room.js` — and each of them predated the local
 * adapter. The result was a fully implemented, fully billed-as-free provider that
 * no workflow could reach, and nothing in the type system noticed.
 *
 * This table removes the ability to make that mistake quietly. A provider must
 * state, per surface, either `true` or a written reason for staying out; there is
 * no third option and no way to omit an entry.
 *
 * Security posture: nothing here widens a capability. Being selectable only means
 * a human is allowed to choose the id. The adapter's own checks, the provider-call
 * governor, the approval scopes, the workspace policy and every hard limit apply
 * exactly as before.
 */
export type ProviderSelectionSurface =
  /** Planner / reviewer assignment in the TUI wizard and the GUI team drawer. */
  | "workflowAgent"
  /** The writer role of a coding workflow — the only role permitted to change files. */
  | "workflowWriter"
  /** Conversation main and second agent: `/api/chat`, the TUI session, room summaries. */
  | "conversation"
  /** `@provider` room mentions, which wake a bounded read-only room worker. */
  | "roomMention"
  /** Resident room seats: managed agents, Writer Lease candidates, delegated children. */
  | "roomResident";

/** `true` to offer the provider on a surface, or the reason it is withheld. */
export type ProviderSurfaceEligibility = true | { readonly excluded: string };

const LOCAL_NOT_A_WRITER =
  "地端 adapter 只做一次 bounded loopback HTTP 呼叫，沒有 Workspace MCP broker、task worktree " +
  "或 Writer Lease 通道；LocalModelProvider.invoke 對 access !== \"read-only\" 直接 fail closed，" +
  "所以它只能是唯讀角色。";

const LOCAL_NOT_A_RESIDENT =
  "地端 endpoint 是 owner 自行啟動的 HTTP 服務，沒有 room 席位身分、standby 核准，也沒有可交接的 " +
  "CLI session，因此不能成為常駐席位或 Writer Lease 候選人。";

const LOCAL_NOT_IN_CONVERSATION =
  "對話 session 的 provider 白名單仍寫死在 src/core/session.ts（SUBSCRIPTION_PROVIDER_IDS 與 " +
  "MENTION_TOKEN），該檔案不在本次變更授權的範圍內。在那裡一併放行之前開放這個 surface，只會產生" +
  "必定得到 INVALID_PROVIDER_ID 的死選項。";

const LOCAL_NOT_IN_ROOM_MENTION =
  "room_mention 的 target 契約寫死在 src/mcp/collab-server.ts 的 TARGET_PATTERN，該檔案不在本次變更" +
  "授權的範圍內。提前開放只會讓使用者得到 INVALID_ROOM_MENTION_TARGET。";

const FAKE_NOT_A_RESIDENT =
  "in-process 測試 provider 不啟動任何程序，沒有可交接的 session，也不該佔用 room 席位或持有 " +
  "Writer Lease；它只在單機測試路徑上有意義。";

/**
 * Order matters: the derived arrays keep this order, and the GUI/TUI menus render
 * in it. Subscription CLIs first, then the test double, then the local endpoint.
 */
const PROVIDER_SELECTION = {
  codex: {
    workflowAgent: true,
    workflowWriter: true,
    conversation: true,
    roomMention: true,
    roomResident: true,
  },
  claude: {
    workflowAgent: true,
    workflowWriter: true,
    conversation: true,
    roomMention: true,
    roomResident: true,
  },
  grok: {
    workflowAgent: true,
    workflowWriter: true,
    conversation: true,
    roomMention: true,
    roomResident: true,
  },
  fake: {
    workflowAgent: true,
    workflowWriter: true,
    conversation: true,
    roomMention: true,
    roomResident: { excluded: FAKE_NOT_A_RESIDENT },
  },
  local: {
    workflowAgent: true,
    workflowWriter: { excluded: LOCAL_NOT_A_WRITER },
    conversation: { excluded: LOCAL_NOT_IN_CONVERSATION },
    roomMention: { excluded: LOCAL_NOT_IN_ROOM_MENTION },
    roomResident: { excluded: LOCAL_NOT_A_RESIDENT },
  },
} as const satisfies Record<
  ProviderId,
  Readonly<Record<ProviderSelectionSurface, ProviderSurfaceEligibility>>
>;

type SelectionTable = typeof PROVIDER_SELECTION;

/** The provider ids a given surface offers, as a type. */
export type SelectableProviderId<S extends ProviderSelectionSurface> = {
  [K in ProviderId]: SelectionTable[K][S] extends true ? K : never;
}[ProviderId];

export type WorkflowAgentProviderId = SelectableProviderId<"workflowAgent">;
export type WorkflowWriterProviderId = SelectableProviderId<"workflowWriter">;
export type ConversationProviderId = SelectableProviderId<"conversation">;
export type RoomMentionProviderId = SelectableProviderId<"roomMention">;
export type RoomResidentProviderId = SelectableProviderId<"roomResident">;

type Assert<T extends true> = T;
type Equals<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/*
 * Compile-time statements of the deliberate exclusions. These are the reason the
 * `local` gaps below are engineering decisions rather than forgotten array
 * entries: flipping the table without revisiting them fails `tsc --noEmit`.
 */

/** Writers must remain a strict subset of the non-local providers — see LOCAL_NOT_A_WRITER. */
type _WriterIdsExcludeLocal = Assert<
  WorkflowWriterProviderId extends Exclude<ProviderId, "local"> ? true : false
>;
/** Resident room seats exclude both the loopback endpoint and the in-process fake. */
type _ResidentIdsExcludeLocalAndFake = Assert<
  Equals<RoomResidentProviderId, Exclude<ProviderId, "fake" | "local">>
>;
/** …and must stay exactly the union the core lease/managed-agent modules accept. */
type _ResidentMatchesWriterLease = Assert<Equals<RoomResidentProviderId, WriterProvider>>;
type _ResidentMatchesManagedAgent = Assert<Equals<RoomResidentProviderId, ManagedAgentProvider>>;

export const PROVIDER_SELECTION_SURFACES = [
  "workflowAgent",
  "workflowWriter",
  "conversation",
  "roomMention",
  "roomResident",
] as const satisfies readonly ProviderSelectionSurface[];

/** The surface list itself is total: a new surface must be added here too. */
type _SurfaceListIsTotal = Assert<
  Equals<(typeof PROVIDER_SELECTION_SURFACES)[number], ProviderSelectionSurface>
>;

type SelectionEntry = Readonly<Record<ProviderSelectionSurface, ProviderSurfaceEligibility>>;

const ENTRIES: ReadonlyArray<readonly [ProviderId, SelectionEntry]> = Object.freeze(
  Object.entries(PROVIDER_SELECTION).map(
    ([id, entry]) => Object.freeze([id, entry] as const) as readonly [ProviderId, SelectionEntry],
  ),
);

/** Map lookups, never object indexing: `__proto__` and friends can never resolve. */
const BY_ID = new Map<ProviderId, SelectionEntry>(ENTRIES);

export const ALL_PROVIDER_IDS: readonly ProviderId[] = Object.freeze(ENTRIES.map(([id]) => id));

const SELECTABLE_LISTS = new Map<ProviderSelectionSurface, readonly ProviderId[]>(
  PROVIDER_SELECTION_SURFACES.map((surface) => [
    surface,
    Object.freeze(ENTRIES.filter(([, entry]) => entry[surface] === true).map(([id]) => id)),
  ]),
);

const SELECTABLE_SETS = new Map<ProviderSelectionSurface, ReadonlySet<string>>(
  PROVIDER_SELECTION_SURFACES.map((surface) => [
    surface,
    new Set<string>(SELECTABLE_LISTS.get(surface) ?? []),
  ]),
);

const ANY_SURFACE: readonly ProviderId[] = Object.freeze(
  ENTRIES.filter(([, entry]) =>
    PROVIDER_SELECTION_SURFACES.some((surface) => entry[surface] === true),
  ).map(([id]) => id),
);
const ANY_SURFACE_SET: ReadonlySet<string> = new Set<string>(ANY_SURFACE);

function list(surface: ProviderSelectionSurface): readonly ProviderId[] {
  const value = SELECTABLE_LISTS.get(surface);
  // Unreachable through the exported type; fails closed if a caller forges a surface.
  if (!value) throw new Error("PROVIDER_SELECTION_SURFACE_UNDECLARED");
  return value;
}

/** The provider ids offered on `surface`, in menu order. */
export function selectableProviderIds(surface: ProviderSelectionSurface): readonly ProviderId[] {
  return list(surface);
}

/** True only for an exact, lower-case provider id that `surface` offers. */
export function isSelectableProvider(
  surface: ProviderSelectionSurface,
  value: unknown,
): value is ProviderId {
  if (typeof value !== "string") return false;
  const set = SELECTABLE_SETS.get(surface);
  if (!set) throw new Error("PROVIDER_SELECTION_SURFACE_UNDECLARED");
  return set.has(value);
}

/** Why `id` is withheld from `surface`, or undefined when it is offered. */
export function providerExclusionReason(
  surface: ProviderSelectionSurface,
  id: ProviderId,
): string | undefined {
  const entry = BY_ID.get(id);
  if (!entry) throw new Error("PROVIDER_SELECTION_UNDECLARED");
  const eligibility = entry[surface];
  return eligibility === true ? undefined : eligibility.excluded;
}

/**
 * Providers whose model list a UI may query. Anything a menu can hold must be
 * listable, so this is the union of every surface — and nothing beyond it.
 */
export function modelListingProviderIds(): readonly ProviderId[] {
  return ANY_SURFACE;
}

export function isModelListingProvider(value: unknown): value is ProviderId {
  return typeof value === "string" && ANY_SURFACE_SET.has(value);
}

export function isWorkflowWriterProvider(value: unknown): value is WorkflowWriterProviderId {
  return isSelectableProvider("workflowWriter", value);
}

export function isRoomResidentProvider(value: unknown): value is RoomResidentProviderId {
  return isSelectableProvider("roomResident", value);
}

export function roomResidentProviderIds(): readonly RoomResidentProviderId[] {
  return list("roomResident") as readonly RoomResidentProviderId[];
}

/**
 * Shape of a room mention target. The provider alternation is no longer baked
 * into the pattern: the pattern only bounds the shape, and membership is decided
 * by the table above.
 */
const MENTION_TARGET_SHAPE = /^([a-z]{2,16})(?::([A-Za-z0-9._:/-]{1,128}))?$/u;
const MENTION_PREFIX_SHAPE = /^@([a-z]{2,16})\s+[\s\S]+$/u;
const MAX_MENTION_TARGET_LENGTH = 160;

export function parseProviderMentionTarget(
  value: unknown,
): { provider: ProviderId; model?: string } | undefined {
  if (typeof value !== "string" || value.length > MAX_MENTION_TARGET_LENGTH) return undefined;
  const match = MENTION_TARGET_SHAPE.exec(value);
  const provider = match?.[1];
  if (!provider || !isSelectableProvider("roomMention", provider)) return undefined;
  const model = match?.[2];
  return model === undefined ? { provider } : { provider, model };
}

/** The provider a `@provider …` ledger message addresses, if any. */
export function mentionedProviderId(text: unknown): ProviderId | undefined {
  if (typeof text !== "string") return undefined;
  const provider = MENTION_PREFIX_SHAPE.exec(text)?.[1];
  return provider && isSelectableProvider("roomMention", provider) ? provider : undefined;
}
