/**
 * The rules themselves live in `.mjs` because the release scanners run under plain node with no
 * build step. This declaration exists so the tests that assert them can be type-checked with the
 * rest of the suite instead of being the one file the gate cannot see.
 */
export declare const scanRules: ReadonlyArray<readonly [name: string, pattern: RegExp]>;
