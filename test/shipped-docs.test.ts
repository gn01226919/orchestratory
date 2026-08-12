import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { APPLY_BACK_CONFIRMATION } from "../src/ui/web.ts";

/**
 * The interactive guide ships: `package.json` lists it under `files`, so whatever it says is
 * what a user reads before typing. When the apply-back confirmation was unified into one symbol
 * the guide kept teaching the phrase that had just been deleted — eight places, four of them in
 * the embedded demo's own logic, all of them instructing the reader to type something the
 * backend now rejects.
 *
 * Fixing those eight was fixing an instance. This is the class: the guide is bound to the
 * constant, so the next change to the phrase turns this red instead of turning the guide into a
 * set of instructions that cannot work.
 */

const GUIDE = new URL("../docs/orchestrator-interactive-guide.html", import.meta.url);

/**
 * Phrases the product used to accept and no longer does. A guide that still teaches one is worse
 * than a guide that omits it: the reader follows it, is refused, and has no way to tell whether
 * the product or the instruction is wrong.
 */
const RETIRED_PHRASES = ["APPLY WRITER", "APPLY BACK TO SOURCE"];

test("the shipped guide teaches the phrase the backend actually compares against", async () => {
  const guide = await readFile(GUIDE, "utf8");
  assert.ok(
    guide.includes(APPLY_BACK_CONFIRMATION),
    `the guide never mentions ${APPLY_BACK_CONFIRMATION}, which is the only phrase apply-back accepts`,
  );
});

test("no phrase the product has retired survives in the shipped guide", async () => {
  const guide = await readFile(GUIDE, "utf8");
  for (const retired of RETIRED_PHRASES) {
    assert.equal(
      guide.includes(retired),
      false,
      `the guide still instructs the reader to type "${retired}", which apply-back refuses`,
    );
  }
});

test("the guide's embedded demo compares against the same phrase the product does", async () => {
  const guide = await readFile(GUIDE, "utf8");
  // The demo builds its expected value and its placeholder from the phrase. Both were template
  // literals interpolating a task id, because the retired phrase was per-task; the current one is
  // not. If either drifts back to interpolation the demo starts refusing input that the real
  // product would accept, which is the failure the guide exists to prevent.
  assert.equal(
    guide.includes("const expected = `MERGE INTO MAIN`") ||
      guide.includes('const expected = "MERGE INTO MAIN"') ||
      guide.includes("const expected = &quot;MERGE INTO MAIN&quot;") ||
      guide.includes("const expected = `" + APPLY_BACK_CONFIRMATION + "`"),
    true,
    "the demo's expected value is no longer the phrase the product compares against",
  );
});
