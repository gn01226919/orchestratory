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

/**
 * Release checklist item 43 asks that the GUI, the README and the help output all decline to claim
 * an OS sandbox. Nothing held that up, and the gap it left was not theoretical: the sentence went
 * into `public/app.js` — the legacy apply-back entry — and the item was ticked, while the path the
 * README actually teaches (candidate_start → main_merge_preview → approve in the room view) runs
 * through `public/room.js`, which says "isolated worktree" ten times and carried no caveat at all.
 *
 * Each surface is asserted separately rather than as a total count, because that is how the gap
 * happened: two of three is a passing sum and a failing promise. The match is on the property being
 * disclaimed, not on a sentence, so rewording stays free and deleting does not.
 */
test("every surface that shows a merge decision declines to claim an OS sandbox", async () => {
  const surfaces: Array<[string, URL]> = [
    ["help output", new URL("../src/help.ts", import.meta.url)],
    ["README", new URL("../README.md", import.meta.url)],
    /* The room view's markup, not its script. The stronger placement -- inside the scroll-gated
       disclosure, where the owner cannot reach the confirmation without passing it -- lives in
       `renderMergePromotionDisclosure`, which `merge-dialog-acceptance` digests against a real
       browser pass. Putting it there invalidated that recorded acceptance, and re-running the
       pass is a manual owner action by design. So it sits in the dialog head instead: on the
       same page as the confirmation phrase, visible whenever the dialog opens, but not inside
       the measured region. That is a weaker property, and it is written down rather than
       rounded up. */
    ["room view (the path the README teaches)", new URL("../public/room.html", import.meta.url)],
    ["workflow apply-back (legacy path)", new URL("../public/app.js", import.meta.url)],
  ];

  /* The claim being refused, in either language, however it is phrased around. */
  const disclaims = /not an OS sandbox|OS-level isolation|不是 OS 沙箱|作業系統層級的隔離|不是強制隔離/u;
  /* And the reason, so that a bare "not a sandbox" cannot stand in for telling the reader why. */
  const names = /full-trust|application-level|應用層邊界/u;

  for (const [label, url] of surfaces) {
    const text = await readFile(url, "utf8");
    assert.match(text, disclaims, `${label} no longer says a worktree is not an OS sandbox`);
    assert.match(text, names, `${label} disclaims the sandbox without saying what can cross the boundary`);
  }
});
