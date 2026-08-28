import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { allowedRuntimeScripts } from "../scripts/release-manifest.mjs";

/*
 * Two lists describe which `scripts/` files the published package carries: the `files` field in
 * `package.json` (what npm packs) and `allowedRuntimeScripts` (what the release reproduction
 * permits past its denied-prefix check). Both are deliberate — the second exists so that editing
 * `package.json` alone cannot smuggle a script into the artifact — but nothing kept them equal,
 * and lists that must agree drift apart exactly when nothing checks them.
 *
 * Measured before this test existed: supervisor scripts entered `package.json` on 2026-08-13 and
 * 2026-08-20, the allowlist stayed at its 2026-07-21 contents, and every reproduction from then on
 * died at DENIED_PACKAGE_ENTRY — undiscovered for sixteen days because the timed-out gate ahead of
 * it never let a run reach the check. One entry (`scan-rules.d.mts`) had been missing since the
 * list was first written. This test moves the discovery from forty-five minutes into a release to
 * the ordinary test run.
 */
test("the release allowlist and package.json agree on every shipped script", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
    files: string[];
  };
  const shipped = pkg.files.filter((entry) => entry.startsWith("scripts/"));

  // No globs: the reproduction compares exact paths, so a glob here would compare unlike things.
  for (const entry of shipped) {
    assert.doesNotMatch(entry, /[*?[]/u, `${entry} must be an exact path, not a pattern`);
  }

  const missing = shipped.filter((entry) => !allowedRuntimeScripts.has(entry));
  assert.deepEqual(
    missing,
    [],
    "package.json ships scripts the release check would refuse (DENIED_PACKAGE_ENTRY)",
  );

  const dead = [...allowedRuntimeScripts].filter((entry) => !shipped.includes(entry));
  assert.deepEqual(
    dead,
    [],
    "the allowlist permits scripts the package no longer ships — a standing exception nobody uses",
  );
});

test("every shipped runtime script travels with its declaration file", () => {
  // `scan-rules.d.mts` was the entry missing from the first version of the allowlist: the .mjs was
  // present and its declaration was not, so the shipped tree could not type-check the way the
  // repository does. Pairing is the invariant, so pairing is what gets asserted.
  for (const entry of allowedRuntimeScripts) {
    if (!entry.endsWith(".mjs")) continue;
    const declaration = entry.replace(/\.mjs$/u, ".d.mts");
    assert.equal(
      allowedRuntimeScripts.has(declaration),
      true,
      `${entry} ships without ${declaration}`,
    );
  }
});
