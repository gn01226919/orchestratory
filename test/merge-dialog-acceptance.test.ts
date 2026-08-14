import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/*
 * The merge approval dialog is the owner's last look before candidate work is merged
 * into main, and its gate is client-side: scroll to the end of the diff, then type the
 * phrase. Asserting that a line of source exists proves nothing about whether it runs,
 * so the gate was accepted by driving the real page in a real browser (recorded in
 * docs/VERIFICATION.md). That acceptance is manual and does not re-run in CI.
 *
 * This test is what keeps it honest: it hashes the functions the acceptance exercised
 * and requires the same hash to appear in VERIFICATION.md. Change the dialog and this
 * fails until someone re-runs the browser pass and records the result. It buys a
 * reminder, not coverage — a DOM test runner would be the real fix, and that is a new
 * dependency, so it is the owner's call (pending decision D-006).
 */
const ACCEPTED_APPLY_BACK_FUNCTIONS = [
  "applyBackRisk",
  "applyBackScrolledToBottom",
  "applyBackBlockers",
  "applyBackGate",
  "formatApplyBackCountdown",
] as const;

const ACCEPTED_FUNCTIONS = [
  "formatCountdown",
  "tickMergeApprovalTtl",
  "mergeDiffScrolledToBottom",
  "mergeApprovalGate",
  "mergeApprovalInputScope",
  "mergeApprovalIntentTarget",
  "mergeApprovalFailureStatus",
  "updateMergeApprovalGate",
  "handleMergeApprovalPrimaryIntent",
  "handleMergeApprovalConfirmationKeydown",
  "mergeApprovalBlockers",
  "mergeRiskLevel",
  "renderMergeApproval",
  // What the promotion would EXECUTE and OVERWRITE is rendered inside the scroll-gated region, so
  // these two are part of the gate rather than decoration beside it: the owner cannot reach the
  // bottom without passing them. Accepted in a browser together with the gate itself.
  "renderMergePromotionDisclosure",
  "renderMergeDiff",
  // Carries the live overwrite scan onto the screen, and decides whether a poll re-renders when an
  // ignored file appears mid-review. Both were exercised in the same browser pass.
  "loadMergeApproval",
  "mergeApprovalSignature",
  "repollMergeApproval",
  "openMergeApprovalDialog",
  "closeMergeApprovalDialog",
  // The final button is now a write path: the browser acceptance must cover its in-progress state,
  // truthful applied/rolled-back/uncertain result split, and transition into durable history.
  "approveMergeIntoMain",
  "rejectMergeIntoMain",
] as const;

const ACCEPTED_ROOM_FRAGMENTS = [
  {
    file: "room.html",
    patterns: [
      /<section id="merge-approval-blocking"[\s\S]*?<\/section>/u,
      /<div id="merge-approval-diff"[^>]*><\/div>/u,
      /<button id="merge-approval-confirm"[^>]*>.*?<\/button>/u,
      /<p id="merge-approval-status"[^>]*><\/p>/u,
    ],
  },
  {
    file: "styles.css",
    patterns: [
      /^\.merge-approval-diff:focus-visible \{.*\}$/mu,
      /^\.merge-approval-actions #merge-approval-confirm\[aria-disabled="true"\]:not\(:disabled\) \{.*\}$/mu,
      /^#merge-approval-diff\.is-attention,.*\}$/mu,
    ],
  },
] as const;

function acceptedSource(file: string, names: readonly string[]): string {
  const source = readFileSync(join(root, "public", file), "utf8");
  return names.map((name) => {
    // Top-level declarations in this file start at column 0 and end with a closing
    // brace at column 0, so the first such brace terminates the body.
    // Both forms: an async dialog handler was silently uncovered because the pattern
    // only matched `function`, which is how a changed reject path slipped past this guard.
    const pattern = new RegExp(String.raw`^(?:async )?function ${name}\([\s\S]*?^\}$`, "mu");
    const found = pattern.exec(source);
    assert.ok(
      found,
      `${name}() is gone from public/${file}. If the dialog was restructured, re-run the ` +
        `browser acceptance and update both this list and docs/VERIFICATION.md.`,
    );
    return found[0];
  }).join("\n");
}

function acceptedFragments(groups: readonly { file: string; patterns: readonly RegExp[] }[]): string {
  return groups.map(({ file, patterns }) => {
    const source = readFileSync(join(root, "public", file), "utf8");
    return patterns.map((pattern) => {
      const found = pattern.exec(source);
      assert.ok(found, `accepted browser fragment is gone from public/${file}`);
      return found[0];
    }).join("\n");
  }).join("\n");
}

/*
 * Both write-back paths are covered. They are different endpoints with different
 * previews, and each was accepted in a browser separately, so each carries its own
 * digest — a change to one must not be able to hide behind the other still matching.
 */
const ACCEPTED_GATES = [
  {
    file: "room.js", names: ACCEPTED_FUNCTIONS, fragments: ACCEPTED_ROOM_FRAGMENTS,
    label: "candidate → main merge approval",
  },
  { file: "app.js", names: ACCEPTED_APPLY_BACK_FUNCTIONS, label: "workspace apply-back" },
] as const;

for (const gate of ACCEPTED_GATES) {
  test(`the accepted ${gate.label} gate still matches its recorded browser acceptance`, () => {
  const accepted = acceptedSource(gate.file, gate.names)
    + ("fragments" in gate ? `\n${acceptedFragments(gate.fragments)}` : "");
  const digest = createHash("sha256").update(accepted, "utf8").digest("hex");
  const verification = readFileSync(join(root, "docs", "VERIFICATION.md"), "utf8");

  assert.ok(
    verification.includes(digest),
    `The ${gate.label} dialog changed since it was last accepted in a real browser.\n` +
      `Current gate digest: ${digest}\n` +
      "docs/VERIFICATION.md records a different one, so the recorded acceptance no longer\n" +
      "describes this code. Re-run the browser pass (scroll gate, blockers, TTL countdown,\n" +
      "exact phrase), add a dated row with the new digest, and this will pass again.\n" +
      "Editing the digest without re-running the browser pass defeats the point of it.",
  );
  });
}

test("the recorded acceptance names the behaviours a source check cannot see", () => {
  const verification = readFileSync(join(root, "docs", "VERIFICATION.md"), "utf8");
  // Guards against the row being reduced to a digest with no statement of what was
  // observed — the failure this whole file exists to prevent.
  for (const behaviour of ["scroll", "TTL", "MERGE INTO MAIN"]) {
    assert.ok(
      verification.includes(behaviour),
      `the acceptance record no longer mentions ${behaviour}`,
    );
  }
});
