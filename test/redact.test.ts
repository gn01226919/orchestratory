import test from "node:test";
import assert from "node:assert/strict";
import { redact, safeSummary, sanitizeTerminal } from "../src/security/redact.ts";

test("redacts common secret carriers and email addresses", () => {
  const input = [
    ["Author", "ization: Bearer synthetic-secret-value"].join(""),
    "api_key=synthetic-secret-value",
    "user@example.invalid",
  ].join("\n");
  const output = redact(input);
  assert.doesNotMatch(output, /synthetic-secret-value/u);
  assert.doesNotMatch(output, /user@example\.invalid/u);
  assert.match(output, /REDACTED/u);
});

test("removes terminal control sequences", () => {
  const malicious = "safe\u001b]52;c;payload\u0007\u001b[31mred\u001b[0m";
  const output = sanitizeTerminal(malicious);
  assert.doesNotMatch(output, /\u001b/u);
  assert.doesNotMatch(output, /payload/u);
  assert.equal(output, "safe[CONTROL_REMOVED]red");
});

test("safe summaries are trimmed and deterministically bounded", () => {
  assert.equal(safeSummary("  short  ", 10), "short");
  assert.equal(safeSummary("abcdefgh", 4), "abcd…[TRUNCATED]");
});
