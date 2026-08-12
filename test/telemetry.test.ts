import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  describeTelemetryConsent,
  emptyTelemetryState,
  ensureTelemetryConsent,
  loadTelemetryState,
  newInstallId,
  parseTelemetryAnswer,
  previousUtcDay,
  recordTelemetryCounter,
  recordTelemetryErrorCode,
  reportTelemetryOnStartup,
  sanitizeErrorCodes,
  saveTelemetryState,
  setTelemetryConsent,
  telemetryRequestBody,
  telemetryStatePath,
  telemetryStatus,
  TELEMETRY_ERROR_CODE_SHAPE,
  TELEMETRY_FIELDS,
  TELEMETRY_INSTALL_ID_SHAPE,
  TELEMETRY_PRODUCT_VERSION,
  TELEMETRY_WHITELIST_IS_EXACT,
  utcDay,
  type TelemetryPayload,
  type TelemetryState,
} from "../src/core/telemetry.ts";
import {
  assertTelemetryUrl,
  assertTelemetryUrlAgainst,
  buildTelemetryRequest,
  httpsTelemetryTransport,
  TELEMETRY_ANON_KEY,
  TELEMETRY_HOST,
  TELEMETRY_PATH,
  type TelemetrySendOutcome,
  type TelemetryTransport,
} from "../src/core/telemetry-egress.ts";

async function directory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "orchestratory-telemetry-"));
  await chmod(root, 0o700);
  return root;
}

/**
 * A transport that counts. Every assertion about "nothing was sent" in this file is an
 * assertion about `calls.length`, never about a flag somewhere being false: a flag can be
 * true while the socket is opened anyway, which is the failure the owner actually cares about.
 */
function countingTransport(outcome: TelemetrySendOutcome = "sent"): {
  transport: TelemetryTransport;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    transport: {
      async send(body: string): Promise<TelemetrySendOutcome> {
        calls.push(body);
        return outcome;
      },
    },
  };
}

const YESTERDAY = "2026-08-11";
const TODAY = new Date("2026-08-12T09:00:00.000Z");

async function stateWithYesterday(
  root: string,
  overrides: Partial<TelemetryState> = {},
): Promise<TelemetryState> {
  const state: TelemetryState = {
    ...emptyTelemetryState(),
    consent: "yes",
    installId: newInstallId(),
    days: [{
      day: YESTERDAY,
      ranToday: true,
      promotions: 2,
      applyBacks: 1,
      errorCodes: ["MAIN_MERGE_PROMOTION_MAIN_PATH_BUSY"],
    }],
    ...overrides,
  };
  return await saveTelemetryState(state, root);
}

// ---------------------------------------------------------------------------
// The three states
// ---------------------------------------------------------------------------

test("consent is three states, so 'never asked' and 'said no' are different rows", async () => {
  const root = await directory();
  const fresh = await telemetryStatus(root);
  assert.equal(fresh.consent, "unanswered");

  await setTelemetryConsent("no", root);
  const refused = await telemetryStatus(root);
  assert.equal(refused.consent, "no");

  // The distinguishing assertion: the two states are not the same value, and neither is a
  // boolean. A boolean would have collapsed both of these onto `false`.
  assert.notEqual(fresh.consent, refused.consent);
  assert.notEqual(describeTelemetryConsent("unanswered"), describeTelemetryConsent("no"));
  assert.equal(typeof fresh.consent, "string");
});

test("consent persists to an owner-only file in the data directory", async () => {
  const root = await directory();
  await setTelemetryConsent("yes", root);
  const path = telemetryStatePath(root);
  assert.ok(path.endsWith("telemetry.json"));
  const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  assert.equal(raw.consent, "yes");
  assert.equal(raw.stateVersion, 1);
  assert.ok(TELEMETRY_INSTALL_ID_SHAPE.test(String(raw.installId)));
});

test("only an explicit yes or no is an answer", () => {
  assert.equal(parseTelemetryAnswer("yes"), "yes");
  assert.equal(parseTelemetryAnswer(" YES "), "yes");
  assert.equal(parseTelemetryAnswer("no"), "no");
  for (const junk of ["", " ", "y", "n", "maybe", "true", "1", "0", "好"]) {
    assert.equal(parseTelemetryAnswer(junk), undefined, `"${junk}" must not count as an answer`);
  }
});

test("turning consent off drops the install id and the accumulated days", async () => {
  const root = await directory();
  await stateWithYesterday(root);
  await setTelemetryConsent("no", root);
  const load = await loadTelemetryState(root);
  assert.equal(load.status, "ok");
  if (load.status !== "ok") return;
  assert.equal(load.state.installId, null);
  assert.deepEqual(load.state.days, []);
});

// ---------------------------------------------------------------------------
// The headless path — the one this product runs every day
// ---------------------------------------------------------------------------

test("with no TTY the question is not asked, nothing is written and nothing is sent", async () => {
  const root = await directory();
  const { transport, calls } = countingTransport();
  let asked = 0;

  const result = await ensureTelemetryConsent({
    dataDirectory: root,
    interactive: false,
    ask: async () => {
      asked += 1;
      return "yes";
    },
  });

  assert.equal(result.outcome, "skipped-not-interactive");
  assert.equal(result.consent, "unanswered");
  assert.equal(asked, 0, "a process with nobody attached must not ask");

  // Not written: the next interactive start must still get to ask.
  await assert.rejects(readFile(telemetryStatePath(root), "utf8"));
  const status = await telemetryStatus(root);
  assert.equal(status.consent, "unanswered", "a headless start must not be recorded as a refusal");

  // Not sent: zero calls, not a false flag.
  const report = await reportTelemetryOnStartup({ dataDirectory: root, now: TODAY, transport });
  assert.equal(report.outcome, "state-unreadable");
  assert.equal(calls.length, 0);
});

test("a headless start does not block: the whole startup path resolves and stays unanswered", async () => {
  const root = await directory();
  const started = Date.now();
  const { telemetryStartup } = await import("../src/main.ts");
  // `main.ts` decides interactivity from the real streams; under `node --test` they are not
  // a TTY, which is the same shape as the MCP server started by another process.
  await telemetryStartup(root);
  assert.ok(Date.now() - started < 5_000, "startup must not wait for an answer nobody can give");
  const status = await telemetryStatus(root);
  assert.equal(status.consent, "unanswered");
  await assert.rejects(readFile(telemetryStatePath(root), "utf8"));
});

test("an interactive start asks, and re-asks until the answer is yes or no", async () => {
  const root = await directory();
  const asked: string[] = [];
  const answers = ["", "y", "no"];
  const result = await ensureTelemetryConsent({
    dataDirectory: root,
    interactive: true,
    ask: async (question) => {
      asked.push(question);
      return answers[asked.length - 1] ?? "";
    },
  });
  assert.equal(result.outcome, "answered");
  assert.equal(result.consent, "no");
  assert.equal(asked.length, 3, "there is no default answer; junk is re-asked");
});

test("an interactive start that never gets an answer leaves the state unanswered", async () => {
  const root = await directory();
  const result = await ensureTelemetryConsent({
    dataDirectory: root,
    interactive: true,
    ask: async () => "maybe",
    attempts: 2,
  });
  assert.equal(result.outcome, "declined-no-answer");
  assert.equal(result.consent, "unanswered");
  await assert.rejects(readFile(telemetryStatePath(root), "utf8"));
});

test("the question is only asked once", async () => {
  const root = await directory();
  let asked = 0;
  const ask = async (): Promise<string> => {
    asked += 1;
    return "yes";
  };
  await ensureTelemetryConsent({ dataDirectory: root, interactive: true, ask });
  const second = await ensureTelemetryConsent({ dataDirectory: root, interactive: true, ask });
  assert.equal(asked, 1);
  assert.equal(second.outcome, "already-answered");
  assert.equal(second.consent, "yes");
});

// ---------------------------------------------------------------------------
// Off means zero calls
// ---------------------------------------------------------------------------

test("with consent off the transport is never called", async () => {
  const root = await directory();
  await stateWithYesterday(root);
  await setTelemetryConsent("no", root);
  const { transport, calls } = countingTransport();
  const result = await reportTelemetryOnStartup({ dataDirectory: root, now: TODAY, transport });
  assert.equal(result.outcome, "consent-not-yes");
  assert.equal(calls.length, 0);
});

test("with consent unanswered the transport is never called", async () => {
  const root = await directory();
  await saveTelemetryState({ ...emptyTelemetryState(), consent: "unanswered" }, root);
  const { transport, calls } = countingTransport();
  const result = await reportTelemetryOnStartup({ dataDirectory: root, now: TODAY, transport });
  assert.equal(result.outcome, "consent-not-yes");
  assert.equal(calls.length, 0);
});

test("nothing is accumulated locally until consent is yes", async () => {
  const root = await directory();
  await saveTelemetryState({ ...emptyTelemetryState(), consent: "unanswered" }, root);
  await recordTelemetryCounter("promotion", root, TODAY);
  await recordTelemetryErrorCode("MAIN_MERGE_PROMOTION_MAIN_PATH_BUSY", root, TODAY);
  const load = await loadTelemetryState(root);
  assert.equal(load.status, "ok");
  if (load.status !== "ok") return;
  assert.deepEqual(load.state.days, [], "before the question is answered there is no material");
});

// ---------------------------------------------------------------------------
// Correction (O): unreadable settings fall to "do not send"
// ---------------------------------------------------------------------------

test("an unreadable settings file falls to not sending, and does not ask either", async () => {
  const root = await directory();
  await stateWithYesterday(root);
  await writeFile(telemetryStatePath(root), "{ not json", { encoding: "utf8", mode: 0o600 });

  const load = await loadTelemetryState(root);
  assert.equal(load.status, "unreadable");

  const status = await telemetryStatus(root);
  assert.equal(status.readable, false);
  assert.equal(status.consent, "unanswered", "unreadable must not read as consent");

  const { transport, calls } = countingTransport();
  const report = await reportTelemetryOnStartup({ dataDirectory: root, now: TODAY, transport });
  assert.equal(report.outcome, "state-unreadable");
  assert.equal(calls.length, 0);

  let asked = 0;
  const consent = await ensureTelemetryConsent({
    dataDirectory: root,
    interactive: true,
    ask: async () => {
      asked += 1;
      return "yes";
    },
  });
  assert.equal(consent.outcome, "skipped-unreadable");
  assert.equal(asked, 0, "a broken store cannot hold an answer, so do not collect one");
});

test("a settings file with loose permissions is unreadable, not trusted", async () => {
  const root = await directory();
  await setTelemetryConsent("yes", root);
  await chmod(telemetryStatePath(root), 0o644);
  const load = await loadTelemetryState(root);
  assert.equal(load.status, "unreadable");
  const { transport, calls } = countingTransport();
  await reportTelemetryOnStartup({ dataDirectory: root, now: TODAY, transport });
  assert.equal(calls.length, 0);
});

test("a state file claiming an unknown version is unreadable", async () => {
  const root = await directory();
  await setTelemetryConsent("yes", root);
  const raw = JSON.parse(await readFile(telemetryStatePath(root), "utf8")) as Record<string, unknown>;
  raw.stateVersion = 99;
  await writeFile(telemetryStatePath(root), JSON.stringify(raw), { encoding: "utf8", mode: 0o600 });
  const load = await loadTelemetryState(root);
  assert.equal(load.status, "unreadable");
});

// ---------------------------------------------------------------------------
// The field whitelist
// ---------------------------------------------------------------------------

test("the whitelist is exactly the eight agreed fields", () => {
  assert.equal(TELEMETRY_WHITELIST_IS_EXACT, true);
  assert.deepEqual([...TELEMETRY_FIELDS], [
    "install_id", "version", "os", "arch", "ran_today", "promotions", "apply_backs", "error_codes",
  ]);
});

test("a field that is not on the whitelist cannot reach the wire", () => {
  const payload = {
    install_id: newInstallId(),
    version: "0.1.0",
    os: "darwin",
    arch: "arm64",
    ran_today: true,
    promotions: 1,
    apply_backs: 0,
    error_codes: [],
    // Everything below is what the whitelist exists to stop.
    workspace: "/Users/example/secret-project",
    prompt: "the owner's actual prompt",
    repo: "orchestratory",
    ledger: "room ledger contents",
    stack: "Error: at /Users/example/src/main.ts:1:1",
  } as unknown as TelemetryPayload;

  const body = telemetryRequestBody(payload);
  const parsed = JSON.parse(body) as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed).sort(), [
    "p_apply_backs", "p_arch", "p_error_codes", "p_install_id",
    "p_os", "p_promotions", "p_ran_today", "p_version",
  ]);
  for (const forbidden of ["workspace", "prompt", "repo", "ledger", "stack"]) {
    assert.equal(body.includes(forbidden), false, `${forbidden} must not appear in the body`);
  }
  assert.equal(body.includes("secret-project"), false);
  assert.equal(body.includes("Users"), false);
});

test("the client never sends a date; the server decides the day", () => {
  const body = telemetryRequestBody({
    install_id: newInstallId(),
    version: "0.1.0",
    os: "linux",
    arch: "x64",
    ran_today: false,
    promotions: 0,
    apply_backs: 0,
    error_codes: [],
  });
  const parsed = JSON.parse(body) as Record<string, unknown>;
  // `ran_today` is a boolean about yesterday, not a date; the fields that would carry a clock
  // or a timezone are the ones that must be absent. The server derives `day` from its own
  // `now()`, which is also what makes one-row-per-day unforgeable.
  const clockFields = new Set(["at", "day", "date", "time", "timestamp", "timezone", "tz", "zone"]);
  for (const key of Object.keys(parsed)) {
    assert.equal(clockFields.has(key.replace(/^p_/u, "")), false, key);
  }
  for (const value of Object.values(parsed)) {
    if (typeof value !== "string") continue;
    assert.equal(/\d{4}-\d{2}-\d{2}/u.test(value), false, `${value} looks like a date`);
  }
});

test("the product version constant matches what the package actually ships", async () => {
  const packagePath = fileURLToPath(new URL("../package.json", import.meta.url));
  const pkg = JSON.parse(await readFile(packagePath, "utf8")) as Record<string, unknown>;
  assert.equal(TELEMETRY_PRODUCT_VERSION, pkg.version);
});

// ---------------------------------------------------------------------------
// The redactor gate
// ---------------------------------------------------------------------------

test("a real path or token in a whitelisted field is refused, not trimmed", () => {
  const base: TelemetryPayload = {
    install_id: newInstallId(),
    version: "0.1.0",
    os: "darwin",
    arch: "arm64",
    ran_today: true,
    promotions: 0,
    apply_backs: 0,
    error_codes: [],
  };
  const home = process.env.HOME ?? "/Users/example";
  // Deliberately just under the repository secret-scanner's own threshold: these are long
  // enough for the redactor to treat as provider keys, short enough that this test file does
  // not itself become a finding.
  for (const poison of [
    `${home}/orchestratory`,
    "sk-abcdefghij",
    "ghp-abcdefghij",
    "owner@example.invalid",
  ]) {
    assert.throws(
      () => telemetryRequestBody({ ...base, version: poison }),
      /TELEMETRY_VERSION_INVALID|TELEMETRY_FIELD_WOULD_BE_REDACTED/u,
      `"${poison}" must not be sendable as a version`,
    );
  }
});

test("the redactor gate catches what the shape check alone would let through", () => {
  const base: TelemetryPayload = {
    install_id: newInstallId(),
    version: "0.1.0",
    os: "darwin",
    arch: "arm64",
    ran_today: true,
    promotions: 0,
    apply_backs: 0,
    error_codes: [],
  };
  // This value satisfies TELEMETRY_VERSION_SHAPE exactly — same character class, under the
  // length cap — so the only thing standing between it and the wire is the redactor.
  const tokenShapedVersion = "sk-abcdefghij";
  assert.match(tokenShapedVersion, /^[0-9A-Za-z][0-9A-Za-z._+-]{0,31}$/u);
  assert.throws(
    () => telemetryRequestBody({ ...base, version: tokenShapedVersion }),
    /TELEMETRY_FIELD_WOULD_BE_REDACTED:version/u,
  );
});

test("error codes that are not codes are dropped before the wire", () => {
  const home = process.env.HOME ?? "/Users/example";
  const codes = sanitizeErrorCodes([
    "MAIN_MERGE_PROMOTION_MAIN_PATH_BUSY",
    `failed to open ${home}/orchestratory/src/main.ts`,
    "Error: ENOENT, open '/Users/example/.ssh/id_rsa'",
    "sk-abcdefghij",
    "lowercase_code",
    "AB",
    42,
    null,
    { code: "OBJECT" },
    "MAIN_MERGE_PROMOTION_MAIN_PATH_BUSY",
  ]);
  assert.deepEqual(codes, ["MAIN_MERGE_PROMOTION_MAIN_PATH_BUSY"]);
  for (const code of codes) assert.match(code, TELEMETRY_ERROR_CODE_SHAPE);
});

test("a full error message never survives into the payload", () => {
  const home = process.env.HOME ?? "/Users/example";
  const body = telemetryRequestBody({
    install_id: newInstallId(),
    version: "0.1.0",
    os: "darwin",
    arch: "arm64",
    ran_today: true,
    promotions: 0,
    apply_backs: 0,
    error_codes: [
      "MAIN_MERGE_PROMOTION_MAIN_PATH_BUSY",
      `EACCES: permission denied, open '${home}/Library/Application Support/Orchestratory/x.sqlite'`,
    ],
  });
  assert.equal(body.includes(home), false);
  assert.equal(body.includes("EACCES"), false);
  assert.equal(body.includes("permission denied"), false);
  assert.ok(body.includes("MAIN_MERGE_PROMOTION_MAIN_PATH_BUSY"));
});

test("an os or arch outside the server's allowlist is refused rather than guessed", () => {
  const base: TelemetryPayload = {
    install_id: newInstallId(),
    version: "0.1.0",
    os: "darwin",
    arch: "arm64",
    ran_today: true,
    promotions: 0,
    apply_backs: 0,
    error_codes: [],
  };
  assert.throws(() => telemetryRequestBody({ ...base, os: "plan9" }), /TELEMETRY_OS_INVALID/u);
  assert.throws(() => telemetryRequestBody({ ...base, arch: "z80" }), /TELEMETRY_ARCH_INVALID/u);
  assert.throws(() => telemetryRequestBody({ ...base, promotions: -1 }), /TELEMETRY_COUNT_INVALID/u);
  assert.throws(() => telemetryRequestBody({ ...base, promotions: 10_001 }), /TELEMETRY_COUNT_INVALID/u);
  assert.throws(
    () => telemetryRequestBody({ ...base, install_id: "00000000-0000-0000-0000-000000000000" }),
    /TELEMETRY_INSTALL_ID_INVALID/u,
  );
});

// ---------------------------------------------------------------------------
// The install id
// ---------------------------------------------------------------------------

test("the install id is a random v4 uuid, not derived from the machine", async () => {
  const first = newInstallId();
  const second = newInstallId();
  assert.match(first, TELEMETRY_INSTALL_ID_SHAPE);
  assert.notEqual(first, second);

  // The shape check above cannot tell a random value from a hash shaped to look like one, so
  // this asserts the property at its actual source: the module reads no machine characteristic
  // and does no hashing. Call shapes are matched, not bare words, so that a comment saying
  // "no hostname is read" does not fail a test about whether one is read.
  const source = await readFile(
    fileURLToPath(new URL("../src/core/telemetry.ts", import.meta.url)),
    "utf8",
  );
  for (const forbidden of [
    /\bhostname\s*\(/u,
    /\bnetworkInterfaces\s*\(/u,
    /\buserInfo\s*\(/u,
    /\bmachineIdSync?\s*\(/u,
    /\bcpus\s*\(/u,
    /\bcreateHash\s*\(/u,
    /\bgetuid\s*\(/u,
    /from\s+"node:os"/u,
  ]) {
    assert.equal(
      forbidden.test(source),
      false,
      `${forbidden.source} must not appear: the install id has to stay unlinkable to this machine`,
    );
  }
  // The only randomness source it may use is the platform CSPRNG.
  assert.match(source, /randomUUID/u);
});

test("the install id is stable across restarts once consent is yes", async () => {
  const root = await directory();
  const first = await setTelemetryConsent("yes", root);
  const second = await setTelemetryConsent("yes", root);
  assert.equal(first.installId, second.installId);
  assert.notEqual(first.installId, null);
});

// ---------------------------------------------------------------------------
// Reporting yesterday
// ---------------------------------------------------------------------------

test("utc day arithmetic reports the day before, not the day in progress", () => {
  assert.equal(utcDay(TODAY), "2026-08-12");
  assert.equal(previousUtcDay(TODAY), YESTERDAY);
  assert.equal(previousUtcDay(new Date("2026-01-01T00:30:00.000Z")), "2025-12-31");
});

test("today's first start reports yesterday's complete summary and nothing about today", async () => {
  const root = await directory();
  const state = await stateWithYesterday(root);
  await saveTelemetryState({
    ...state,
    days: [...state.days, {
      day: "2026-08-12",
      ranToday: true,
      promotions: 99,
      applyBacks: 99,
      errorCodes: ["TODAY_ONLY_CODE"],
    }],
  }, root);

  const { transport, calls } = countingTransport();
  const result = await reportTelemetryOnStartup({
    dataDirectory: root,
    now: TODAY,
    platform: "darwin",
    arch: "arm64",
    transport,
  });

  assert.equal(result.outcome, "sent");
  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0]!) as Record<string, unknown>;
  assert.equal(body.p_promotions, 2, "yesterday's numbers, not today's");
  assert.equal(body.p_apply_backs, 1);
  assert.equal(body.p_ran_today, true);
  assert.deepEqual(body.p_error_codes, ["MAIN_MERGE_PROMOTION_MAIN_PATH_BUSY"]);
  assert.equal(calls[0]!.includes("99"), false, "today's in-progress counts must not be sent");
  assert.equal(calls[0]!.includes("TODAY_ONLY_CODE"), false);
});

test("the report is attempted at most once a day, so failures cannot pile up", async () => {
  const root = await directory();
  await stateWithYesterday(root);
  const { transport, calls } = countingTransport("failed");
  const first = await reportTelemetryOnStartup({ dataDirectory: root, now: TODAY, transport });
  const second = await reportTelemetryOnStartup({ dataDirectory: root, now: TODAY, transport });
  const third = await reportTelemetryOnStartup({ dataDirectory: root, now: TODAY, transport });
  assert.equal(first.outcome, "failed");
  assert.equal(second.outcome, "already-attempted-today");
  assert.equal(third.outcome, "already-attempted-today");
  assert.equal(calls.length, 1, "one attempt per day, whatever the first one did");
});

test("a transport that throws is discarded silently and does not fail startup", async () => {
  const root = await directory();
  await stateWithYesterday(root);
  const result = await reportTelemetryOnStartup({
    dataDirectory: root,
    now: TODAY,
    transport: {
      async send(): Promise<TelemetrySendOutcome> {
        throw new Error("NETWORK_IS_ON_FIRE");
      },
    },
  });
  assert.equal(result.outcome, "failed");
  const status = await telemetryStatus(root);
  assert.equal(status.readable, true, "a failed send must leave the product working");
});

test("with no yesterday there is nothing to report and no call is made", async () => {
  const root = await directory();
  await saveTelemetryState(
    { ...emptyTelemetryState(), consent: "yes", installId: newInstallId() },
    root,
  );
  const { transport, calls } = countingTransport();
  const result = await reportTelemetryOnStartup({ dataDirectory: root, now: TODAY, transport });
  assert.equal(result.outcome, "nothing-to-report");
  assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------------------
// The owner-visible record
// ---------------------------------------------------------------------------

test("the owner can read back what was sent", async () => {
  const root = await directory();
  await stateWithYesterday(root);
  const { transport } = countingTransport();
  await reportTelemetryOnStartup({ dataDirectory: root, now: TODAY, transport });
  const status = await telemetryStatus(root);
  assert.equal(status.sent.length, 1);
  const record = status.sent[0]!;
  assert.equal(record.day, YESTERDAY);
  assert.equal(record.outcome, "sent");
  // The record is reconstructed from the bytes that actually left, so it cannot describe a
  // different report than the one that was sent.
  assert.equal(record.payload?.promotions, 2);
  assert.equal(record.payload?.apply_backs, 1);
  assert.deepEqual(record.payload?.error_codes, ["MAIN_MERGE_PROMOTION_MAIN_PATH_BUSY"]);
});

test("counters accumulate into today, and stay coarse", async () => {
  const root = await directory();
  await setTelemetryConsent("yes", root);
  await recordTelemetryCounter("promotion", root, TODAY);
  await recordTelemetryCounter("promotion", root, TODAY);
  await recordTelemetryCounter("apply-back", root, TODAY);
  await recordTelemetryCounter("run", root, TODAY);
  await recordTelemetryErrorCode("MAIN_MERGE_PROMOTION_MAIN_PATH_BUSY", root, TODAY);
  await recordTelemetryErrorCode("not a code at all", root, TODAY);

  const load = await loadTelemetryState(root);
  assert.equal(load.status, "ok");
  if (load.status !== "ok") return;
  const today = load.state.days.find((day) => day.day === utcDay(TODAY));
  assert.ok(today);
  assert.equal(today.promotions, 2);
  assert.equal(today.applyBacks, 1);
  assert.equal(today.ranToday, true);
  assert.deepEqual(today.errorCodes, ["MAIN_MERGE_PROMOTION_MAIN_PATH_BUSY"]);
});

test("recording never throws, even when the data directory is gone", async () => {
  const missing = join(tmpdir(), "orchestratory-telemetry-missing-directory-xyz");
  await recordTelemetryCounter("promotion", missing);
  await recordTelemetryErrorCode("SOME_CODE", missing);
});

// ---------------------------------------------------------------------------
// The egress boundary
// ---------------------------------------------------------------------------

test("the destination is a compile-time constant, not configuration", async () => {
  const source = await readFile(
    fileURLToPath(new URL("../src/core/telemetry-egress.ts", import.meta.url)),
    "utf8",
  );
  // Nothing in the egress module may consult the environment, a file or the store for where
  // to connect. If any of these appear, the destination has become data.
  for (const forbidden of ["process.env", "readFile", "readFileSync", "require(", "import("]) {
    assert.equal(source.includes(forbidden), false, `${forbidden} must not decide the destination`);
  }
  assert.ok(source.includes("export const TELEMETRY_HOST"));
});

test("as shipped, no endpoint is provisioned and a request cannot be built", () => {
  if (TELEMETRY_HOST !== null && TELEMETRY_ANON_KEY !== null) return;
  assert.throws(() => buildTelemetryRequest("{}"), /TELEMETRY_ENDPOINT_NOT_PROVISIONED/u);
  assert.throws(
    () => assertTelemetryUrl(`https://anything.supabase.co${TELEMETRY_PATH}`),
    /TELEMETRY_ENDPOINT_NOT_PROVISIONED/u,
  );
});

test("no destination can be supplied to the transport at all", async () => {
  // The seam takes a body, not a URL, so there is no argument through which a caller or a
  // test could name a different host. The strongest available assertion is the type-level one
  // plus this: the shipped transport, handed a well-formed body, still reaches nobody.
  const transport = httpsTelemetryTransport();
  const outcome = await transport.send(JSON.stringify({ p_install_id: newInstallId() }));
  if (TELEMETRY_HOST === null || TELEMETRY_ANON_KEY === null) {
    assert.equal(outcome, "failed", "with no project provisioned there is nowhere to send");
  }
});

test("every destination that is not the compiled one is refused before a socket exists", () => {
  // Exercised against a hypothetical host, because with no project provisioned the real
  // entry point refuses on its first line and these checks would never be reached.
  const host = "examplereference.supabase.co";
  const good = `https://${host}${TELEMETRY_PATH}`;
  assert.equal(assertTelemetryUrlAgainst(good, host).host, host);

  for (const [url, code] of [
    [`http://${host}${TELEMETRY_PATH}`, /NOT_HTTPS/u],
    [`https://user:pass@${host}${TELEMETRY_PATH}`, /CARRIES_CREDENTIALS/u],
    [`https://${host}:8443${TELEMETRY_PATH}`, /HAS_PORT/u],
    [`https://other.supabase.co${TELEMETRY_PATH}`, /HOST_NOT_COMPILED_IN/u],
    [`https://evil.example.invalid${TELEMETRY_PATH}`, /HOST_NOT_COMPILED_IN/u],
    [`https://${host}.evil.example${TELEMETRY_PATH}`, /HOST_NOT_COMPILED_IN/u],
    [`https://127.0.0.1${TELEMETRY_PATH}`, /HOST_NOT_COMPILED_IN/u],
    [`https://${host}/rest/v1/rpc/some_other_function`, /PATH_NOT_ALLOWED/u],
    [`https://${host}/`, /PATH_NOT_ALLOWED/u],
    [`https://${host}${TELEMETRY_PATH}?x=1`, /HAS_QUERY_OR_FRAGMENT/u],
    [`https://${host}${TELEMETRY_PATH}#x`, /HAS_QUERY_OR_FRAGMENT/u],
    ["file:///etc/passwd", /NOT_HTTPS/u],
    ["not a url at all", /UNPARSEABLE/u],
  ] as const) {
    assert.throws(
      () => assertTelemetryUrlAgainst(url, host),
      code,
      `${url} must not be contacted`,
    );
  }
});

test("the parameterised pinning helper has exactly one caller in the product", async () => {
  const egress = await readFile(
    fileURLToPath(new URL("../src/core/telemetry-egress.ts", import.meta.url)),
    "utf8",
  );
  // One definition plus one call. If a second call site appears, some code other than
  // `assertTelemetryUrl` is choosing a host, which is the thing that must not happen.
  const uses = [...egress.matchAll(/assertTelemetryUrlAgainst\s*\(/gu)];
  assert.equal(uses.length, 2, "definition and the single call inside assertTelemetryUrl");
  assert.ok(egress.includes("return assertTelemetryUrlAgainst(value, host);"));
});

// ---------------------------------------------------------------------------
// The two surfaces
// ---------------------------------------------------------------------------

test("a change made on one surface is what the other surface reads", async () => {
  const root = await directory();

  // What the GUI route does on POST /api/telemetry.
  const fromGui = await setTelemetryConsent("yes", root);
  // What the TUI and the CLI do on their next read. Both go to disk; neither consults a
  // value captured at process start, which is how the same statement ends up disagreeing.
  const fromTui = await telemetryStatus(root);
  assert.equal(fromGui.consent, fromTui.consent);
  assert.equal(fromGui.description, fromTui.description);

  const backOff = await setTelemetryConsent("no", root);
  const afterOff = await telemetryStatus(root);
  assert.equal(backOff.consent, "no");
  assert.equal(afterOff.consent, "no");
  assert.equal(backOff.description, afterOff.description);
});

test("both surfaces render the identical sentence, from one function", async () => {
  const root = await directory();
  await setTelemetryConsent("yes", root);
  const status = await telemetryStatus(root);
  assert.equal(status.description, describeTelemetryConsent("yes"));
  assert.equal(status.description, describeTelemetryConsent(status.consent));
});

test("the TUI command decides nothing itself; it hands the request to the shared writer", async () => {
  const { runConversationCommand } = await import("../src/ui/tui.ts");
  const session = {
    status: () => ({ mainAgent: { provider: "codex", model: "gpt" }, turns: 0, providerCalls: 0 }),
  } as unknown as Parameters<typeof runConversationCommand>[1];
  for (const [input, expected] of [
    ["/telemetry", "status"],
    ["/telemetry status", "status"],
    ["/telemetry on", "on"],
    ["/telemetry off", "off"],
    ["/telemetry log", "log"],
  ] as const) {
    const outcome = runConversationCommand(input, session, { maxProviderCalls: 10 });
    assert.equal(outcome.telemetryRequest, expected, input);
  }
  const bad = runConversationCommand("/telemetry sideways", session, { maxProviderCalls: 10 });
  assert.equal(bad.telemetryRequest, undefined);
  assert.ok(bad.lines.join("\n").includes("/telemetry"));
});

test("the GUI actually renders the switch, rather than only receiving it", async () => {
  // F26's fourth correction is the precedent: the data was in the payload and the UI
  // referenced it zero times, while the document claimed it was displayed. These assertions
  // are the cheap mechanical version of "did anyone actually wire it up".
  const appJs = await readFile(fileURLToPath(new URL("../public/app.js", import.meta.url)), "utf8");
  const indexHtml = await readFile(
    fileURLToPath(new URL("../public/index.html", import.meta.url)),
    "utf8",
  );
  assert.ok(appJs.includes("renderTelemetry(value.telemetry)"), "bootstrap must feed the renderer");
  assert.ok(appJs.includes('api("/api/telemetry"'), "the GUI must call the shared writer");
  assert.ok(appJs.includes("telemetry.description"), "the GUI must print the server's sentence");
  for (const id of ["telemetry-state", "telemetry-on", "telemetry-off", "telemetry-dot"]) {
    assert.ok(indexHtml.includes(`id="${id}"`), `${id} must exist in the page`);
    assert.ok(appJs.includes(`"${id}"`), `${id} must be referenced by the script`);
  }
});

test("the web layer exposes telemetry on bootstrap and accepts only yes or no", async () => {
  const web = await readFile(fileURLToPath(new URL("../src/ui/web.ts", import.meta.url)), "utf8");
  assert.ok(web.includes("telemetry: await telemetryStatus(app.store.dataDirectory)"));
  assert.ok(web.includes('url.pathname === "/api/telemetry"'));
  // The GUI must not be able to express a third state, and must reject unknown fields.
  assert.ok(web.includes('input.consent !== "yes" && input.consent !== "no"'));
  assert.ok(web.includes("UNKNOWN_TELEMETRY_REQUEST_FIELD"));
  // It must go through the same writer the TUI and CLI use, not its own copy.
  assert.ok(web.includes("setTelemetryConsent(input.consent, app.store.dataDirectory)"));
});

test("the request body stays small enough that it cannot be a smuggling channel", () => {
  const body = telemetryRequestBody({
    install_id: newInstallId(),
    version: "0.1.0",
    os: "darwin",
    arch: "arm64",
    ran_today: true,
    promotions: 10_000,
    apply_backs: 10_000,
    error_codes: Array.from({ length: 40 }, (_value, index) => `CODE_NUMBER_${index}`),
  });
  const parsed = JSON.parse(body) as Record<string, unknown>;
  assert.equal((parsed.p_error_codes as string[]).length, 20);
  assert.ok(Buffer.byteLength(body, "utf8") < 4_096);
});
