/**
 * The rules live in `.mjs` because `source-hygiene.mjs` runs under plain node with no build step.
 * This declaration exists so the test that asserts them is type-checked with the rest of the suite,
 * the same arrangement `scan-rules.d.mts` makes for the release scanners.
 */

/** 1-based line numbers of `unref()` calls under `test/` that do not say what keeps the loop alive. */
export declare function unexplainedTestUnrefLines(content: string): number[];

/** Long enough to refuse "ok", "fine", "it is safe"; short enough not to demand an essay. */
export declare const MIN_UNREF_REASON_LENGTH: number;
