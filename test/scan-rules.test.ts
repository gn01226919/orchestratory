import test from "node:test";
import assert from "node:assert/strict";

import { scanRules } from "../scripts/scan-rules.mjs";

/**
 * These rules decide whether a release is allowed to leave the machine, and until now nothing
 * checked them. History, source, and release scanning all trust the same regular expressions, so
 * a rule that quietly stops matching takes every one of those gates down together and reports
 * success while doing it.
 *
 * Each rule is asserted in both directions (PITFALLS #107): a shape it must report, and a shape
 * it must stay silent about. A rule with only positive cases passes just as happily after it has
 * been widened into matching everything.
 *
 * The samples are assembled from fragments rather than written as literals. This is not
 * obfuscation — it is the only way a file that tests a secret scanner can avoid being reported by
 * the scanner it tests. Weakening the rules to let this file through would defeat the thing the
 * file exists to protect, so the source genuinely contains no address, key, or credential shape.
 */

const AT = "@";
const DOT = ".";

function rule(name: string): RegExp {
  const found = scanRules.find(([id]) => id === name);
  assert.ok(found, `scan rule ${name} no longer exists`);
  return found[1];
}

function detects(name: string, sample: string): boolean {
  return rule(name).test(sample);
}

/** An address written out of parts, so no address literal appears in this file. */
function address(local: string, ...domain: string[]): string {
  return `${local}${AT}${domain.join(DOT)}`;
}

test("every rule is asserted here, so adding one without a test fails", () => {
  const covered = new Set([
    "private-key",
    "authorization-secret",
    "provider-secret",
    "secret-assignment",
    "personal-home-path",
    "personal-email",
  ]);
  const actual = scanRules.map(([name]) => name);
  assert.deepEqual(
    actual.filter((name) => !covered.has(name)),
    [],
    "a scan rule was added without a case in this file — the release gate would ship it unverified",
  );
  assert.equal(actual.length, covered.size, "a scan rule was removed; confirm that was intended");
});

test("an address that reaches a person is reported, and a role address that reaches nobody is not", () => {
  const noreply = address("noreply", "anthropic", "com");
  const github = address("1234+user", "users", "noreply", "github", "com");
  const fixture = address("fixture", "example", "invalid");

  assert.equal(detects("personal-email", address("someone", "gmail", "com")), true);
  assert.equal(
    detects("personal-email", address("someone", "anthropic", "com")),
    true,
    "only the noreply mailbox is excluded, not the whole domain",
  );

  assert.equal(detects("personal-email", noreply), false);
  assert.equal(detects("personal-email", github), false);
  assert.equal(detects("personal-email", fixture), false);
  assert.equal(
    detects("personal-email", `Co-Authored-By: Some Model <${noreply}>`),
    false,
    "the trailer shape a commit actually carries",
  );

  // A hostname that merely begins with an excluded one continues into somebody else's domain.
  // Each of these was let through while the exclusions ended on a word boundary, because a dot
  // satisfies one.
  assert.equal(detects("personal-email", `${noreply}${DOT}evil${DOT}tw`), true);
  assert.equal(detects("personal-email", `${github}${DOT}evil${DOT}tw`), true);
  assert.equal(detects("personal-email", `${fixture}${DOT}evil${DOT}tw`), true);

  // An excluded address must not cover for a real one sharing the line.
  assert.equal(detects("personal-email", `${noreply}, ${address("someone", "gmail", "com")}`), true);
});

test("a home directory that names a person is reported, and the documentation placeholders are not", () => {
  const home = (who: string) => `/${"Users"}/${who}/project/`;
  assert.equal(detects("personal-home-path", home("a-real-account")), true);
  assert.equal(detects("personal-home-path", home("example")), false);
  assert.equal(detects("personal-home-path", home("alice")), false);
  assert.equal(detects("personal-home-path", "~/project/"), false);
});

test("a private key header is reported whatever kind of key it is", () => {
  const header = (kind: string) => `-----BEGIN ${kind}PRIVATE KEY-----`;
  assert.equal(detects("private-key", header("RSA ")), true);
  assert.equal(detects("private-key", header("OPENSSH ")), true);
  assert.equal(detects("private-key", header("")), true);
  assert.equal(
    detects("private-key", "-----BEGIN CERTIFICATE-----"),
    false,
    "a public certificate is not a secret",
  );
});

test("an Authorization header carrying a credential is reported, one carrying nothing is not", () => {
  const value = "abcdefghijkl0123";
  assert.equal(detects("authorization-secret", `Authorization: Bearer ${value}`), true);
  assert.equal(detects("authorization-secret", `Authorization: Basic ${value}`), true);
  assert.equal(
    detects("authorization-secret", "Authorization: Bearer ${token}"),
    false,
    "a placeholder is not a leak",
  );
  assert.equal(detects("authorization-secret", "Authorization header is required"), false);

  // Written down rather than fixed: this rule carries no `i` flag, while HTTP header names are
  // case-insensitive and most clients and logs lowercase them. A credential arriving as
  // `authorization: bearer …` is not reported. The assertion records today's behaviour so the gap
  // is visible; closing it changes a release gate and belongs to whoever owns that decision, not
  // to the change that was only adding coverage.
  assert.equal(
    detects("authorization-secret", `authorization: bearer ${value}`),
    false,
    "known gap: the rule is case-sensitive and a lowercased header slips past it",
  );
});

test("a provider token prefix is reported, and prose that merely mentions one is not", () => {
  const body = "0123456789abcdef";
  for (const prefix of ["sk", "xai", "ant", "ghp", "github_pat"]) {
    assert.equal(detects("provider-secret", `${prefix}-${body}`), true, `${prefix} prefix`);
  }
  assert.equal(detects("provider-secret", "keys start with sk- and are never logged"), false);
});

test("a secret being assigned a literal is reported, and one read from the environment is not", () => {
  const quoted = (name: string, value: string) => `${name}: "${value}"`;
  assert.equal(detects("secret-assignment", quoted("api_key", "0123456789ab")), true);
  assert.equal(detects("secret-assignment", quoted("accessToken", "0123456789ab")), true);
  assert.equal(detects("secret-assignment", "const key = process.env.API_KEY"), false);
  assert.equal(
    detects("secret-assignment", quoted("api_key", "")),
    false,
    "an empty value is not a credential",
  );
});
