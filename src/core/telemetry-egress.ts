/**
 * The telemetry egress boundary.
 *
 * The product already reaches the network from inside the process in two places
 * (`src/providers/api.ts`, three hardcoded first-party LLM endpoints behind an explicit API
 * opt-in, and `src/providers/local.ts`, pinned to the loopback interface). This is the first
 * one that is not about serving a request the owner just made, so the destination itself is a
 * compile-time constant: it is deliberately not read from a configuration file, an environment
 * variable, the SQLite store or model output. Moving where this product talks to must be a
 * reviewed source change, not data.
 *
 * `TELEMETRY_HOST` and `TELEMETRY_ANON_KEY` are `null` because no Supabase project has been
 * provisioned. While either is `null` the client refuses to build a request at all, so as
 * shipped this module cannot open a connection to anything.
 */
export const TELEMETRY_HOST: string | null = null;

/**
 * Supabase anon keys are public by design (the security boundary is RLS plus column grants,
 * see the SQL side). It still lives in source rather than in configuration, for the same
 * reason as the host: so that the pair cannot be repointed by data.
 */
export const TELEMETRY_ANON_KEY: string | null = null;

/** The single RPC the client is allowed to call. */
export const TELEMETRY_PATH = "/rest/v1/rpc/report_telemetry";

/** Hard ceilings on the one request this module ever makes. */
export const TELEMETRY_TIMEOUT_MS = 10_000;
export const TELEMETRY_MAX_BODY_BYTES = 4_096;

export type TelemetrySendOutcome = "sent" | "failed";

export interface TelemetryRequest {
  readonly url: string;
  readonly method: "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/**
 * The seam tests substitute.
 *
 * It deliberately takes the request *body* and not a URL: the destination is never a
 * parameter anywhere in the product, so no caller — and no test — is able to point this at a
 * different host. Whether a body becomes a connection, and to where, is decided only by the
 * constants above.
 */
export interface TelemetryTransport {
  send(body: string): Promise<TelemetrySendOutcome>;
}

export class TelemetryEgressError extends Error {}

function refuse(code: string): never {
  throw new TelemetryEgressError(code);
}

/**
 * Structural check on the destination. Every field is pinned, not merely inspected: a URL that
 * is not exactly `https://<compiled host>/rest/v1/rpc/report_telemetry` with no credentials,
 * no port, no query and no fragment is refused before any socket exists.
 */
export function assertTelemetryUrl(value: string): URL {
  const host = TELEMETRY_HOST;
  if (host === null) refuse("TELEMETRY_ENDPOINT_NOT_PROVISIONED");
  return assertTelemetryUrlAgainst(value, host);
}

/**
 * The pinning itself, with the expected host as an argument.
 *
 * It is split out for one reason: while no project is provisioned `TELEMETRY_HOST` is `null`,
 * so `assertTelemetryUrl` refuses on its first line and every check below would be unreachable
 * — a guard nothing can exercise is a guard nobody knows works. Tests call this form with a
 * hypothetical host.
 *
 * This does not widen anything. It takes no part in choosing where to connect: the only
 * caller in the product is `assertTelemetryUrl` directly above, which passes the compiled
 * constant and nothing else, and `telemetry.test.ts` asserts that remains the only caller.
 */
export function assertTelemetryUrlAgainst(value: string, host: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return refuse("TELEMETRY_URL_UNPARSEABLE");
  }
  if (url.protocol !== "https:") refuse("TELEMETRY_URL_NOT_HTTPS");
  if (url.username !== "" || url.password !== "") refuse("TELEMETRY_URL_CARRIES_CREDENTIALS");
  if (url.port !== "") refuse("TELEMETRY_URL_HAS_PORT");
  if (url.hostname !== host || url.host !== host) refuse("TELEMETRY_URL_HOST_NOT_COMPILED_IN");
  if (url.pathname !== TELEMETRY_PATH) refuse("TELEMETRY_URL_PATH_NOT_ALLOWED");
  if (url.search !== "" || url.hash !== "") refuse("TELEMETRY_URL_HAS_QUERY_OR_FRAGMENT");
  return url;
}

/**
 * Builds the one request shape this product may send. The body is produced by the caller
 * (`telemetryRequestBody`), which is where the field whitelist is enforced.
 */
export function buildTelemetryRequest(body: string): TelemetryRequest {
  const host = TELEMETRY_HOST;
  const key = TELEMETRY_ANON_KEY;
  if (host === null || key === null) refuse("TELEMETRY_ENDPOINT_NOT_PROVISIONED");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.supabase\.co$/u.test(host)) {
    refuse("TELEMETRY_COMPILED_HOST_INVALID");
  }
  if (Buffer.byteLength(body, "utf8") > TELEMETRY_MAX_BODY_BYTES) refuse("TELEMETRY_BODY_TOO_LARGE");
  const url = `https://${host}${TELEMETRY_PATH}`;
  assertTelemetryUrl(url);
  return Object.freeze({
    url,
    method: "POST" as const,
    headers: Object.freeze({
      apikey: key,
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      accept: "application/json",
    }),
    body,
  });
}

/**
 * The only code in the product that opens a socket for telemetry.
 *
 * It never throws and never reports a reason to the caller beyond sent/failed: a telemetry
 * failure must not become a user-visible error and must not gate anything the product does.
 * There is no retry — one attempt, one process start, then the report is discarded.
 */
export function httpsTelemetryTransport(): TelemetryTransport {
  return {
    async send(body: string): Promise<TelemetrySendOutcome> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TELEMETRY_TIMEOUT_MS);
      try {
        // Built here, from the compiled constants only. If no project has been provisioned
        // this throws and the outcome is a silent failure — never a connection somewhere else.
        const input = buildTelemetryRequest(body);
        // Re-validated rather than trusted: this is the last statement before a socket
        // exists, so it is the one that has to be right.
        const url = assertTelemetryUrl(input.url);
        const response = await fetch(url, {
          method: "POST",
          headers: { ...input.headers },
          body: input.body,
          signal: controller.signal,
          // A redirect is not a destination this module agreed to talk to.
          redirect: "error",
        });
        // The response body is never read or parsed; the server returns void on success.
        await response.body?.cancel().catch(() => undefined);
        return response.ok ? "sent" : "failed";
      } catch {
        return "failed";
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
