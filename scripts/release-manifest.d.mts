/**
 * The list lives in `.mjs` because `repro-smoke.mjs` runs under plain node with no build step.
 * This declaration exists so the test that asserts it is type-checked with the rest of the suite,
 * the same arrangement `scan-rules.d.mts` makes.
 */
export declare const allowedRuntimeScripts: ReadonlySet<string>;
