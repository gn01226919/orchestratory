import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { redact } from "../security/redact.ts";
import {
  httpsTelemetryTransport,
  TELEMETRY_ANON_KEY,
  TELEMETRY_HOST,
  type TelemetryTransport,
} from "./telemetry-egress.ts";

/**
 * Telemetry client.
 *
 * Five decisions from D-019 are load-bearing here and are not re-litigated in code:
 * no accounts (a random install id only), Supabase as the backend, a first-run question
 * with no default, RLS handled server side, and "report yesterday on today's first start".
 *
 * The client never blocks the product. Every path in this file either sends one bounded
 * request or silently does nothing.
 */

// ---------------------------------------------------------------------------
// Consent: three states, never two
// ---------------------------------------------------------------------------

/**
 * `unanswered` is a state, not a missing boolean. A boolean would fold "we have not asked
 * yet" into "the owner said no", and the denominator the owner actually wants is exactly the
 * difference between those two.
 */
export type TelemetryConsent = "unanswered" | "yes" | "no";

export const TELEMETRY_CONSENT_STATES: readonly TelemetryConsent[] =
  Object.freeze(["unanswered", "yes", "no"]);

/** The one sentence both the GUI and the TUI render, so the two surfaces cannot drift. */
export function describeTelemetryConsent(consent: TelemetryConsent): string {
  if (consent === "yes") return "Telemetry is ON: one anonymous daily summary is sent.";
  if (consent === "no") return "Telemetry is OFF: nothing is sent.";
  return "Telemetry has not been answered yet: nothing is sent until you answer.";
}

/** The question asked once, on the first interactive start. There is no default answer. */
export const TELEMETRY_QUESTION =
  "Send one anonymous daily summary (no paths, no code, no prompts)? Answer yes or no: ";
export const TELEMETRY_ANSWER_YES = "yes";
export const TELEMETRY_ANSWER_NO = "no";

/** Accepts only an explicit yes or no. Anything else, including empty input, is undefined. */
export function parseTelemetryAnswer(value: string): TelemetryConsent | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === TELEMETRY_ANSWER_YES) return "yes";
  if (normalized === TELEMETRY_ANSWER_NO) return "no";
  return undefined;
}

// ---------------------------------------------------------------------------
// The field whitelist, fixed at compile time
// ---------------------------------------------------------------------------

/**
 * Everything the product is allowed to send. A field that is not here cannot reach the wire,
 * because nothing downstream copies an object generically: the body is assembled property by
 * property from exactly these names.
 */
export interface TelemetryPayload {
  readonly install_id: string;
  readonly version: string;
  readonly os: string;
  readonly arch: string;
  readonly ran_today: boolean;
  readonly promotions: number;
  readonly apply_backs: number;
  readonly error_codes: readonly string[];
}

export const TELEMETRY_FIELDS = Object.freeze([
  "install_id",
  "version",
  "os",
  "arch",
  "ran_today",
  "promotions",
  "apply_backs",
  "error_codes",
] as const);

type PayloadField = keyof TelemetryPayload;
type ListedField = (typeof TELEMETRY_FIELDS)[number];
type MutuallyExact<A extends string, B extends string> =
  [A] extends [B] ? ([B] extends [A] ? true : never) : never;

/**
 * Compile-time guard. Adding a property to `TelemetryPayload` without adding its name here
 * (or the reverse) makes this assignment `never` and `tsc --noEmit` fails. The whitelist is
 * therefore checked by the type system, not by a reviewer remembering to look.
 */
export const TELEMETRY_WHITELIST_IS_EXACT: MutuallyExact<PayloadField, ListedField> = true;

/** Mirrors the `events_os_allowlist` CHECK on the server; values are `process.platform`. */
export const TELEMETRY_OS_ALLOWLIST: ReadonlySet<string> = Object.freeze(
  new Set([
    "aix", "android", "cygwin", "darwin", "freebsd", "haiku",
    "linux", "netbsd", "openbsd", "sunos", "win32",
  ]),
);

/** Mirrors the `events_arch_allowlist` CHECK on the server; values are `process.arch`. */
export const TELEMETRY_ARCH_ALLOWLIST: ReadonlySet<string> = Object.freeze(
  new Set([
    "arm", "arm64", "ia32", "loong64", "mips", "mipsel",
    "ppc", "ppc64", "riscv64", "s390", "s390x", "x64",
  ]),
);

/** Mirrors the `telemetry_error_code` domain CHECK on the server. */
export const TELEMETRY_ERROR_CODE_SHAPE = /^[A-Z][A-Z0-9_]{2,79}$/u;
export const TELEMETRY_VERSION_SHAPE = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,31}$/u;
export const TELEMETRY_INSTALL_ID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
export const TELEMETRY_MAX_ERROR_CODES = 20;
export const TELEMETRY_MAX_COUNT = 10_000;

/**
 * Product version. Kept as a source constant rather than read from `package.json` at runtime
 * so that a release cannot report a version it did not ship with; `telemetry.test.ts` asserts
 * the two agree, so bumping one without the other turns a test red.
 */
export const TELEMETRY_PRODUCT_VERSION = "0.1.0";

export class TelemetryPayloadError extends Error {}

function refuse(code: string): never {
  throw new TelemetryPayloadError(code);
}

/**
 * The redactor gate. These fields have shapes so tight that redaction must be a no-op; if the
 * existing redactor changes the value at all, something that looks like a path, a token, an
 * address or a control sequence is in there, and the value is refused rather than trimmed.
 */
function requireClean(value: string, field: string): string {
  if (redact(value) !== value) refuse(`TELEMETRY_FIELD_WOULD_BE_REDACTED:${field}`);
  return value;
}

function requireInstallId(value: unknown): string {
  if (typeof value !== "string" || !TELEMETRY_INSTALL_ID_SHAPE.test(value)) {
    refuse("TELEMETRY_INSTALL_ID_INVALID");
  }
  return requireClean(value, "install_id");
}

function requireVersion(value: unknown): string {
  if (typeof value !== "string" || !TELEMETRY_VERSION_SHAPE.test(value)) {
    refuse("TELEMETRY_VERSION_INVALID");
  }
  return requireClean(value, "version");
}

function requireOs(value: unknown): string {
  if (typeof value !== "string" || !TELEMETRY_OS_ALLOWLIST.has(value)) refuse("TELEMETRY_OS_INVALID");
  return requireClean(value, "os");
}

function requireArch(value: unknown): string {
  if (typeof value !== "string" || !TELEMETRY_ARCH_ALLOWLIST.has(value)) {
    refuse("TELEMETRY_ARCH_INVALID");
  }
  return requireClean(value, "arch");
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") refuse(`TELEMETRY_FIELD_NOT_BOOLEAN:${field}`);
  return value;
}

function requireCount(value: unknown, field: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > TELEMETRY_MAX_COUNT
  ) refuse(`TELEMETRY_COUNT_INVALID:${field}`);
  return value;
}

/**
 * Keeps only codes that already are codes. A malformed entry is dropped rather than failing
 * the whole report: the shape is the mechanical barrier against a full error message or a
 * path arriving in this array, so dropping is the correct outcome for one bad element.
 */
export function sanitizeErrorCodes(values: readonly unknown[]): string[] {
  const kept = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string") continue;
    if (!TELEMETRY_ERROR_CODE_SHAPE.test(value)) continue;
    if (redact(value) !== value) continue;
    kept.add(value);
    if (kept.size >= TELEMETRY_MAX_ERROR_CODES) break;
  }
  return [...kept].sort();
}

function requireErrorCodes(value: unknown): string[] {
  if (!Array.isArray(value)) refuse("TELEMETRY_ERROR_CODES_NOT_ARRAY");
  const codes = sanitizeErrorCodes(value as readonly unknown[]);
  if (codes.length > TELEMETRY_MAX_ERROR_CODES) refuse("TELEMETRY_ERROR_CODES_TOO_MANY");
  return codes;
}

/**
 * Serialises the one body shape the server accepts. Note what this function does not do:
 * it never spreads, never iterates the input's own keys and never calls `JSON.stringify` on
 * the caller's object. A payload carrying an extra property contributes nothing from it.
 */
export function telemetryRequestBody(payload: TelemetryPayload): string {
  const body = {
    p_install_id: requireInstallId(payload.install_id),
    p_version: requireVersion(payload.version),
    p_os: requireOs(payload.os),
    p_arch: requireArch(payload.arch),
    p_ran_today: requireBoolean(payload.ran_today, "ran_today"),
    p_promotions: requireCount(payload.promotions, "promotions"),
    p_apply_backs: requireCount(payload.apply_backs, "apply_backs"),
    p_error_codes: requireErrorCodes(payload.error_codes),
  };
  return JSON.stringify(body);
}

// ---------------------------------------------------------------------------
// Local state: consent, install id, day rollup, and the record of what was sent
// ---------------------------------------------------------------------------

export const TELEMETRY_STATE_VERSION = 1;
export const TELEMETRY_MAX_KEPT_DAYS = 7;
export const TELEMETRY_MAX_KEPT_SENDS = 60;

export interface TelemetryDay {
  readonly day: string;
  readonly ranToday: boolean;
  readonly promotions: number;
  readonly applyBacks: number;
  readonly errorCodes: readonly string[];
}

export type TelemetrySendOutcomeRecord = "sent" | "failed" | "refused" | "nothing-to-report";

/** One line of the human-readable record of what left this machine. */
export interface TelemetrySendRecord {
  readonly day: string;
  readonly attemptedAt: string;
  readonly outcome: TelemetrySendOutcomeRecord;
  readonly reason: string | null;
  readonly payload: TelemetryPayload | null;
}

export interface TelemetryState {
  readonly stateVersion: number;
  readonly consent: TelemetryConsent;
  readonly installId: string | null;
  readonly lastAttemptedDay: string | null;
  readonly days: readonly TelemetryDay[];
  readonly sent: readonly TelemetrySendRecord[];
}

export type TelemetryLoad =
  | { readonly status: "ok"; readonly state: TelemetryState }
  | { readonly status: "missing" }
  | { readonly status: "unreadable"; readonly reason: string };

export function telemetryStatePath(dataDirectory: string): string {
  return join(dataDirectory, "telemetry.json");
}

export function emptyTelemetryState(): TelemetryState {
  return {
    stateVersion: TELEMETRY_STATE_VERSION,
    consent: "unanswered",
    installId: null,
    lastAttemptedDay: null,
    days: [],
    sent: [],
  };
}

const DAY_SHAPE = /^\d{4}-\d{2}-\d{2}$/u;

export function utcDay(at: Date): string {
  const iso = at.toISOString();
  return iso.slice(0, 10);
}

export function previousUtcDay(at: Date): string {
  return utcDay(new Date(at.getTime() - 86_400_000));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateDay(value: unknown): TelemetryDay | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.day !== "string" || !DAY_SHAPE.test(value.day)) return undefined;
  if (typeof value.ranToday !== "boolean") return undefined;
  const promotions = value.promotions;
  const applyBacks = value.applyBacks;
  if (!Number.isSafeInteger(promotions) || (promotions as number) < 0) return undefined;
  if (!Number.isSafeInteger(applyBacks) || (applyBacks as number) < 0) return undefined;
  if (!Array.isArray(value.errorCodes)) return undefined;
  return {
    day: value.day,
    ranToday: value.ranToday,
    promotions: Math.min(promotions as number, TELEMETRY_MAX_COUNT),
    applyBacks: Math.min(applyBacks as number, TELEMETRY_MAX_COUNT),
    errorCodes: sanitizeErrorCodes(value.errorCodes as readonly unknown[]),
  };
}

function validateSendRecord(value: unknown): TelemetrySendRecord | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.day !== "string" || !DAY_SHAPE.test(value.day)) return undefined;
  if (typeof value.attemptedAt !== "string" || value.attemptedAt.length > 40) return undefined;
  const outcome = value.outcome;
  if (
    outcome !== "sent" && outcome !== "failed" &&
    outcome !== "refused" && outcome !== "nothing-to-report"
  ) return undefined;
  const reason = typeof value.reason === "string" ? value.reason.slice(0, 120) : null;
  let payload: TelemetryPayload | null = null;
  if (isRecord(value.payload)) {
    const candidate = value.payload;
    payload = {
      install_id: String(candidate.install_id ?? ""),
      version: String(candidate.version ?? ""),
      os: String(candidate.os ?? ""),
      arch: String(candidate.arch ?? ""),
      ran_today: candidate.ran_today === true,
      promotions: Number(candidate.promotions ?? 0),
      apply_backs: Number(candidate.apply_backs ?? 0),
      error_codes: sanitizeErrorCodes(
        Array.isArray(candidate.error_codes) ? (candidate.error_codes as readonly unknown[]) : [],
      ),
    };
  }
  return { day: value.day, attemptedAt: value.attemptedAt, outcome, reason, payload };
}

export function validateTelemetryState(value: unknown): TelemetryState {
  if (!isRecord(value)) throw new Error("INVALID_TELEMETRY_STATE");
  if (value.stateVersion !== TELEMETRY_STATE_VERSION) throw new Error("TELEMETRY_STATE_VERSION_UNSUPPORTED");
  const consent = value.consent;
  if (consent !== "unanswered" && consent !== "yes" && consent !== "no") {
    throw new Error("INVALID_TELEMETRY_CONSENT");
  }
  const installId = value.installId;
  if (installId !== null && (typeof installId !== "string" || !TELEMETRY_INSTALL_ID_SHAPE.test(installId))) {
    throw new Error("INVALID_TELEMETRY_INSTALL_ID");
  }
  const lastAttemptedDay = value.lastAttemptedDay;
  if (lastAttemptedDay !== null && (typeof lastAttemptedDay !== "string" || !DAY_SHAPE.test(lastAttemptedDay))) {
    throw new Error("INVALID_TELEMETRY_LAST_ATTEMPTED_DAY");
  }
  if (!Array.isArray(value.days) || !Array.isArray(value.sent)) throw new Error("INVALID_TELEMETRY_STATE");
  const days: TelemetryDay[] = [];
  for (const entry of value.days.slice(-TELEMETRY_MAX_KEPT_DAYS)) {
    const day = validateDay(entry);
    if (day !== undefined) days.push(day);
  }
  const sent: TelemetrySendRecord[] = [];
  for (const entry of value.sent.slice(-TELEMETRY_MAX_KEPT_SENDS)) {
    const record = validateSendRecord(entry);
    if (record !== undefined) sent.push(record);
  }
  return { stateVersion: TELEMETRY_STATE_VERSION, consent, installId, lastAttemptedDay, days, sent };
}

/**
 * Reads the state file. Correction (O): anything other than "the file is simply not there"
 * is `unreadable`, and every caller treats `unreadable` as "do not send". A missing file is
 * the genuine first run, which is the only case that may lead to asking the question.
 */
export async function loadTelemetryState(dataDirectory: string): Promise<TelemetryLoad> {
  const { readOwnerOnlyText } = await import("../config.ts");
  let raw: string;
  try {
    raw = await readOwnerOnlyText(telemetryStatePath(dataDirectory));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
    const reason = error instanceof Error ? error.message : "TELEMETRY_STATE_UNREADABLE";
    return { status: "unreadable", reason };
  }
  try {
    return { status: "ok", state: validateTelemetryState(JSON.parse(raw) as unknown) };
  } catch (error) {
    return {
      status: "unreadable",
      reason: error instanceof Error ? error.message : "TELEMETRY_STATE_INVALID",
    };
  }
}

export async function saveTelemetryState(state: TelemetryState, dataDirectory: string): Promise<TelemetryState> {
  const { atomicOwnerOnlyJson } = await import("../config.ts");
  const bounded: TelemetryState = {
    ...state,
    stateVersion: TELEMETRY_STATE_VERSION,
    days: state.days.slice(-TELEMETRY_MAX_KEPT_DAYS),
    sent: state.sent.slice(-TELEMETRY_MAX_KEPT_SENDS),
  };
  await atomicOwnerOnlyJson(telemetryStatePath(dataDirectory), bounded);
  return bounded;
}

/**
 * What both surfaces read. It always goes to disk rather than to a value captured at process
 * start, so a change made in the GUI is visible to the TUI on its next read and the reverse;
 * a cached snapshot is exactly how the same sentence ends up disagreeing in two places.
 */
export interface TelemetryStatus {
  readonly consent: TelemetryConsent;
  readonly description: string;
  readonly readable: boolean;
  readonly reason: string | null;
  readonly endpointProvisioned: boolean;
  readonly installId: string | null;
  readonly sent: readonly TelemetrySendRecord[];
}

export async function telemetryStatus(dataDirectory: string): Promise<TelemetryStatus> {
  const load = await loadTelemetryState(dataDirectory);
  const endpointProvisioned = TELEMETRY_HOST !== null && TELEMETRY_ANON_KEY !== null;
  if (load.status === "ok") {
    return {
      consent: load.state.consent,
      description: describeTelemetryConsent(load.state.consent),
      readable: true,
      reason: null,
      endpointProvisioned,
      installId: load.state.installId,
      sent: load.state.sent,
    };
  }
  if (load.status === "missing") {
    return {
      consent: "unanswered",
      description: describeTelemetryConsent("unanswered"),
      readable: true,
      reason: null,
      endpointProvisioned,
      installId: null,
      sent: [],
    };
  }
  return {
    consent: "unanswered",
    description: describeTelemetryConsent("unanswered"),
    readable: false,
    reason: load.reason,
    endpointProvisioned,
    installId: null,
    sent: [],
  };
}

/**
 * The one writer of consent, shared by the CLI, the TUI and the GUI. Turning telemetry on
 * mints the install id if there is not one yet; turning it off drops the install id and the
 * accumulated day rollup, so "off" also means "stop keeping the material".
 */
export async function setTelemetryConsent(
  next: "yes" | "no",
  dataDirectory: string,
): Promise<TelemetryStatus> {
  const load = await loadTelemetryState(dataDirectory);
  if (load.status === "unreadable") throw new Error(`TELEMETRY_STATE_UNREADABLE:${load.reason}`);
  const current = load.status === "ok" ? load.state : emptyTelemetryState();
  const state: TelemetryState = next === "yes"
    ? { ...current, consent: "yes", installId: current.installId ?? newInstallId() }
    : { ...current, consent: "no", installId: null, days: [] };
  await saveTelemetryState(state, dataDirectory);
  return await telemetryStatus(dataDirectory);
}

/**
 * A random identifier, and nothing else. `randomUUID` is the platform CSPRNG; no hostname,
 * MAC address, serial number, username or any other machine characteristic is read anywhere
 * in this module, which `telemetry.test.ts` asserts against the source text.
 */
export function newInstallId(): string {
  return randomUUID();
}

// ---------------------------------------------------------------------------
// Asking the question
// ---------------------------------------------------------------------------

export type TelemetryConsentPromptOutcome =
  | "already-answered"
  | "answered"
  | "skipped-not-interactive"
  | "skipped-unreadable"
  | "declined-no-answer";

export interface TelemetryConsentResult {
  readonly outcome: TelemetryConsentPromptOutcome;
  readonly consent: TelemetryConsent;
}

export interface TelemetryConsentOptions {
  readonly dataDirectory: string;
  /** True only when a real person can answer. An MCP server started by another process is not. */
  readonly interactive: boolean;
  /** Asks the question and returns the raw answer; called at most `attempts` times. */
  readonly ask?: (question: string) => Promise<string>;
  readonly attempts?: number;
}

/**
 * First-run consent.
 *
 * With no terminal there is nobody to answer, so this returns immediately: nothing is written,
 * nothing is sent, and the state stays `unanswered` so the next interactive start still asks.
 * A headless start must never be recorded as a refusal and must never block, because a headless
 * start is the path this product runs on every day.
 */
export async function ensureTelemetryConsent(
  options: TelemetryConsentOptions,
): Promise<TelemetryConsentResult> {
  const load = await loadTelemetryState(options.dataDirectory);
  if (load.status === "unreadable") return { outcome: "skipped-unreadable", consent: "unanswered" };
  if (load.status === "ok" && load.state.consent !== "unanswered") {
    return { outcome: "already-answered", consent: load.state.consent };
  }
  if (!options.interactive || options.ask === undefined) {
    return { outcome: "skipped-not-interactive", consent: "unanswered" };
  }
  const attempts = options.attempts ?? 3;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let answer: string;
    try {
      answer = await options.ask(TELEMETRY_QUESTION);
    } catch {
      return { outcome: "skipped-not-interactive", consent: "unanswered" };
    }
    const parsed = parseTelemetryAnswer(answer);
    if (parsed === "yes" || parsed === "no") {
      await setTelemetryConsent(parsed, options.dataDirectory);
      return { outcome: "answered", consent: parsed };
    }
  }
  return { outcome: "declined-no-answer", consent: "unanswered" };
}

// ---------------------------------------------------------------------------
// Accumulating today, so that tomorrow can report a whole day
// ---------------------------------------------------------------------------

export type TelemetryCounter = "run" | "promotion" | "apply-back";

async function mutateToday(
  dataDirectory: string,
  at: Date,
  change: (day: TelemetryDay) => TelemetryDay,
): Promise<void> {
  const load = await loadTelemetryState(dataDirectory);
  if (load.status !== "ok" || load.state.consent !== "yes") return;
  const today = utcDay(at);
  const existing = load.state.days.find((entry) => entry.day === today);
  const base: TelemetryDay = existing ?? {
    day: today,
    ranToday: false,
    promotions: 0,
    applyBacks: 0,
    errorCodes: [],
  };
  const updated = change(base);
  const days = load.state.days.filter((entry) => entry.day !== today);
  days.push(updated);
  await saveTelemetryState({ ...load.state, days }, dataDirectory);
}

/**
 * Records one coarse counter for today. Nothing is accumulated at all unless consent is `yes`:
 * before the question is answered, and after a refusal, the material for a report is not even
 * kept locally.
 *
 * This never throws. Telemetry bookkeeping must not be able to fail a promotion.
 */
export async function recordTelemetryCounter(
  counter: TelemetryCounter,
  dataDirectory: string,
  at: Date = new Date(),
): Promise<void> {
  try {
    await mutateToday(dataDirectory, at, (day) => {
      if (counter === "run") return { ...day, ranToday: true };
      if (counter === "promotion") {
        return { ...day, ranToday: true, promotions: Math.min(day.promotions + 1, TELEMETRY_MAX_COUNT) };
      }
      return { ...day, ranToday: true, applyBacks: Math.min(day.applyBacks + 1, TELEMETRY_MAX_COUNT) };
    });
  } catch {
    // Silent by design: a telemetry write must never surface as a product error.
  }
}

/**
 * Records that a named error code occurred today. Only the code is kept — never the message,
 * never the path it mentioned. A value that is not already code-shaped is dropped here, one
 * layer before the payload builder drops it again.
 */
export async function recordTelemetryErrorCode(
  code: string,
  dataDirectory: string,
  at: Date = new Date(),
): Promise<void> {
  try {
    if (!TELEMETRY_ERROR_CODE_SHAPE.test(code)) return;
    await mutateToday(dataDirectory, at, (day) => ({
      ...day,
      errorCodes: sanitizeErrorCodes([...day.errorCodes, code]),
    }));
  } catch {
    // Silent by design.
  }
}

// ---------------------------------------------------------------------------
// Reporting yesterday, once, on today's first start
// ---------------------------------------------------------------------------

export type TelemetryStartupOutcome =
  | "state-unreadable"
  | "consent-not-yes"
  | "already-attempted-today"
  | "nothing-to-report"
  | "refused"
  | "failed"
  | "sent";

export interface TelemetryStartupResult {
  readonly outcome: TelemetryStartupOutcome;
  readonly reason: string | null;
  readonly payload: TelemetryPayload | null;
}

export interface TelemetryStartupOptions {
  readonly dataDirectory: string;
  readonly now?: Date;
  readonly platform?: string;
  readonly arch?: string;
  readonly version?: string;
  readonly transport?: TelemetryTransport;
}

/**
 * Sends yesterday's complete summary on today's first start.
 *
 * Reporting the day in progress cannot work against this server: `UNIQUE(install_id, day)`
 * plus an anon role that may only INSERT means exactly one row per install per day, so a row
 * written mid-day would permanently describe the fragment before the first report. Yesterday
 * is finished, so every row is a whole day. The cost is that the dashboard is one day behind,
 * which does not affect counting active installs.
 *
 * At most one attempt per day, regardless of outcome: a network failure is discarded, never
 * queued and never retried, so failures cannot accumulate.
 */
export async function reportTelemetryOnStartup(
  options: TelemetryStartupOptions,
): Promise<TelemetryStartupResult> {
  const nothing = (
    outcome: TelemetryStartupOutcome,
    reason: string | null = null,
  ): TelemetryStartupResult => ({ outcome, reason, payload: null });
  try {
    const now = options.now ?? new Date();
    const load = await loadTelemetryState(options.dataDirectory);
    if (load.status !== "ok") {
      return nothing("state-unreadable", load.status === "unreadable" ? load.reason : "MISSING");
    }
    const state = load.state;
    if (state.consent !== "yes") return nothing("consent-not-yes");
    const today = utcDay(now);
    if (state.lastAttemptedDay === today) return nothing("already-attempted-today");
    const yesterday = previousUtcDay(now);
    const record = state.days.find((entry) => entry.day === yesterday);
    const installId = state.installId;
    if (record === undefined || installId === null) {
      await saveTelemetryState(
        {
          ...state,
          lastAttemptedDay: today,
          days: state.days.filter((entry) => entry.day === today),
          sent: [...state.sent, {
            day: yesterday,
            attemptedAt: now.toISOString(),
            outcome: "nothing-to-report",
            reason: null,
            payload: null,
          }],
        },
        options.dataDirectory,
      );
      return nothing("nothing-to-report");
    }

    const payload: TelemetryPayload = {
      install_id: installId,
      version: options.version ?? TELEMETRY_PRODUCT_VERSION,
      os: options.platform ?? process.platform,
      arch: options.arch ?? process.arch,
      ran_today: record.ranToday,
      promotions: record.promotions,
      apply_backs: record.applyBacks,
      error_codes: record.errorCodes,
    };

    let body: string;
    try {
      body = telemetryRequestBody(payload);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "TELEMETRY_REFUSED";
      await saveTelemetryState(
        {
          ...state,
          lastAttemptedDay: today,
          days: state.days.filter((entry) => entry.day === today),
          sent: [...state.sent, {
            day: yesterday,
            attemptedAt: now.toISOString(),
            outcome: "refused",
            reason,
            payload: null,
          }],
        },
        options.dataDirectory,
      );
      return nothing("refused", reason);
    }

    const transport = options.transport ?? httpsTelemetryTransport();
    let outcome: "sent" | "failed";
    try {
      outcome = await transport.send(body);
    } catch {
      outcome = "failed";
    }

    // What is written to the record is what was actually serialised, parsed back from the
    // exact bytes that left, so the owner-visible log cannot describe a different report.
    const wire = JSON.parse(body) as Record<string, unknown>;
    const recorded: TelemetryPayload = {
      install_id: String(wire.p_install_id),
      version: String(wire.p_version),
      os: String(wire.p_os),
      arch: String(wire.p_arch),
      ran_today: wire.p_ran_today === true,
      promotions: Number(wire.p_promotions),
      apply_backs: Number(wire.p_apply_backs),
      error_codes: sanitizeErrorCodes(wire.p_error_codes as readonly unknown[]),
    };
    await saveTelemetryState(
      {
        ...state,
        lastAttemptedDay: today,
        days: state.days.filter((entry) => entry.day === today),
        sent: [...state.sent, {
          day: yesterday,
          attemptedAt: now.toISOString(),
          outcome,
          reason: null,
          payload: recorded,
        }],
      },
      options.dataDirectory,
    );
    return { outcome, reason: null, payload: recorded };
  } catch (error) {
    return nothing("failed", error instanceof Error ? error.message : "TELEMETRY_STARTUP_FAILED");
  }
}
