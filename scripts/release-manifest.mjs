/*
 * The `scripts/` entries the published package is allowed to carry, kept apart from
 * `repro-smoke.mjs` so a test can import them — importing the smoke script itself would start a
 * forty-five-minute reproduction. The same split `scan-rules.mjs` and `hygiene-rules.mjs` use.
 *
 * `scripts/` is a denied prefix in the package check, and this is the exception list: every script
 * the INSTALLED product actually loads. `orchestrator audit` imports security-scan and history-scan
 * (which import scan-rules); the supervisor launchd job in `ops/` runs supervisor-audit and
 * supervisor-mirror, and supervisor-audit imports bounded-process-group. The `.d.mts` files ride
 * along so the shipped tree type-checks the same way the repository does.
 *
 * This list went stale once already: supervisor scripts entered `package.json` on 2026-08-13 and
 * 2026-08-20 and nobody updated it, so every reproduction failed at DENIED_PACKAGE_ENTRY —
 * discovered only on 2026-08-29, because the gate ahead of the check had been timing out for just
 * as long. `test/release-package.test.ts` now asserts this list and `package.json` agree, so the
 * next divergence fails in `npm run check` instead of forty-five minutes into a release.
 */
export const allowedRuntimeScripts = new Set([
  "scripts/bounded-process-group.d.mts", "scripts/bounded-process-group.mjs",
  "scripts/history-scan.d.mts", "scripts/history-scan.mjs",
  "scripts/scan-rules.d.mts", "scripts/scan-rules.mjs",
  "scripts/security-scan.d.mts", "scripts/security-scan.mjs",
  "scripts/supervisor-audit.d.mts", "scripts/supervisor-audit.mjs",
  "scripts/supervisor-mirror.d.mts", "scripts/supervisor-mirror.mjs",
]);
