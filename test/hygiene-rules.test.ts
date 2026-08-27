import test from "node:test";
import assert from "node:assert/strict";
import { unexplainedTestUnrefLines, MIN_UNREF_REASON_LENGTH } from "../scripts/hygiene-rules.mjs";

/*
 * The call text is assembled rather than written out, because this file lives under `test/` and a
 * literal would be caught by the very rule it is testing — `scan-rules.test.ts` avoids writing a
 * real address for the same reason. Everything below builds its fixtures from this.
 */
const CALL = `.un${"ref"}()`;
const marker = (reason: string): string => `// hygiene-allow ${"unref"}: ${reason}`;
const GOOD = "the once(child, exit) below holds a ref-ed child-process handle";

test("an unexplained unref under test/ is reported with its line number", () => {
  const content = ["const a = 1;", `setTimeout(f, 5)${CALL};`, "const b = 2;"].join("\n");
  assert.deepEqual(unexplainedTestUnrefLines(content), [2]);
});

test("a substantive reason on the line above allows it", () => {
  const content = ["const a = 1;", marker(GOOD), `setTimeout(f, 5)${CALL};`].join("\n");
  assert.deepEqual(unexplainedTestUnrefLines(content), []);
});

test("a substantive reason on the same line allows it", () => {
  const content = [`setTimeout(f, 5)${CALL}; ${marker(GOOD)}`].join("\n");
  assert.deepEqual(unexplainedTestUnrefLines(content), []);
});

test("a marker with no reason, or a token one, does not silence the check", () => {
  for (const reason of ["", "ok", "fine", "it is safe", "safe"]) {
    const content = [marker(reason), `setTimeout(f, 5)${CALL};`].join("\n");
    assert.deepEqual(
      unexplainedTestUnrefLines(content),
      [2],
      `"${reason}" is ${reason.length} chars and must not pass a ${MIN_UNREF_REASON_LENGTH}-char bar`,
    );
  }
});

test("the reason must sit next to the call, not merely somewhere in the file", () => {
  // Two lines above is far enough to be about something else. This is the bug the first draft of
  // the rule had in reverse: a two-line comment put the reason out of reach and the exemption
  // silently failed to apply, which is the safe direction for a mistake to fall.
  const content = [marker(GOOD), "// continuation of an unrelated thought", `setTimeout(f, 5)${CALL};`].join("\n");
  assert.deepEqual(unexplainedTestUnrefLines(content), [3]);
});

test("every unexplained call is reported, not just the first", () => {
  const content = [`a${CALL};`, marker(GOOD), `b${CALL};`, `c${CALL};`].join("\n");
  assert.deepEqual(unexplainedTestUnrefLines(content), [1, 4]);
});

test("spacing inside the call does not evade the rule", () => {
  const content = [`setTimeout(f, 5).un${"ref"} (  ) ;`].join("\n");
  assert.deepEqual(unexplainedTestUnrefLines(content), [1]);
});
