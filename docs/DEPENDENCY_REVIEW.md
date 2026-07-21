# Dependency and supply-chain review

## Current inventory

The runtime has no third-party npm dependencies. Development uses three locked packages:

- `typescript` 5.8.3 — Apache-2.0.
- `@types/node` 22.15.30 — MIT.
- `undici-types` 6.21.0 — MIT, transitive through `@types/node`.

Every version is exact in `package.json`/`package-lock.json`; every registry artifact is HTTPS from
`registry.npmjs.org` and has a lockfile SHA-512 integrity value. Install lifecycle scripts are disabled
by repository `.npmrc`, local reproduction, and CI.

## Enforced gates

- `npm audit` is a release gate and covers both runtime and development dependencies. Runtime dependencies
  are currently empty, but the TypeScript toolchain is still part of the release supply chain and must not
  be omitted from the vulnerability check.
- `scripts/sbom.mjs` rejects non-exact versions, non-HTTPS/non-npmjs registry sources, missing SHA-512
  integrity, unapproved licenses, and more than 200 packages.
- `sbom.cdx.json` is deterministic CycloneDX 1.5 output and `npm run sbom:check` rejects drift.
- `npm run repro:smoke` first makes a local `--no-hardlinks` clone of committed `HEAD`, proves its
  identity and clean status, installs offline with lifecycle scripts disabled, and runs the full check suite.
  It separately builds the explicit package `files` allowlist and rejects development/Agent/CI entries except
  the runtime security-audit modules and their declarations. An isolated verification harness supplies the
  non-published lockfile and `tsconfig`, then performs an offline install, syntax-checks published JS/MJS,
  typechecks all published TS, and starts the packaged CLI help and audit paths. Missing, accidentally untracked
  or unexpectedly published inputs fail closed. Full fuzz/SBOM/history checks run in the clean clone because
  their test sources and development scripts are intentionally excluded from the release artifact.
- GitHub Actions use immutable full commit SHAs, read-only repository permission, no persisted checkout
  credential, no dependency cache, no secrets, and a hard timeout.

## Human review still required

Automated tooling cannot prove that a dependency is non-malicious or that a similarly named package is
not a typosquat. Any new dependency, registry, license, GitHub Action, install script, or package count
increase requires a human diff review before the allowlist/SBOM is regenerated. A release must remain
NO-GO until the project license and public repository policy are chosen by the owner.
