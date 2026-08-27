export const scanRules = [
  ["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/u],
  ["authorization-secret", /Authorization:\s*(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/-]{12,}/u],
  ["provider-secret", /\b(?:sk|xai|ant|ghp|github_pat)-[A-Za-z0-9_-]{12,}\b/u],
  ["secret-assignment", /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret)\s*[:=]\s*["'][^"']{8,}["']/iu],
  ["personal-home-path", /\/Users\/(?!example\b|alice\b|bob\b)[^/\s]+\//u],
  [
    // The exclusions are role addresses that route to nobody, which is what this rule is for:
    // it looks for an address that reaches a person. `noreply@anthropic.com` is the trailer a
    // commit carries to say a model helped write it — the same category as the GitHub noreply
    // the rule already allows, and it is excluded by its exact literal rather than by domain so
    // that a real anthropic.com mailbox would still be reported.
    "personal-email",
    // Each exclusion ends on "nothing a hostname could continue with" rather than on \b, because
    // a dot satisfies \b: a domain that merely begins with an excluded one and then continues
    // into somebody else's would have been let through. Measured before changing it — the two
    // older exclusions had the same gap, so this tightens them rather than trading one for
    // another. Writing the example address here would trip this very rule, which is the point.
    //
    // The first exclusion is the whole `.invalid` TLD rather than one literal domain under it.
    // RFC 2606 reserves `.invalid` precisely so that it can never resolve, so an address there is
    // guaranteed not to be anybody's mailbox — the same reasoning D-020 used for the two role
    // addresses, applied to a name space instead of a name.
    //
    // It is not a hypothetical: this product signs every promotion merge commit with its own fixed
    // identity under `.invalid` (`PROMOTION_IDENTITY_EMAIL` in `src/core/process-runner.ts`), and
    // `history-scan` reads `%ae`. So each successful promotion added one more commit that this rule
    // reported, and `audit:history` had been failing since the first one — the product's ordinary
    // operation was breaking its own release gate, unnoticed because `repro:smoke` was skipped.
    // Excluding the reserved TLD is the missing entry, not a relaxation.
    /\b(?![A-Z0-9._%+-]+@[A-Z0-9.-]+\.invalid(?![A-Za-z0-9.-]))(?![A-Z0-9._%+-]+@users\.noreply\.github\.com(?![A-Za-z0-9.-]))(?!noreply@anthropic\.com(?![A-Za-z0-9.-]))[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu,
  ],
];
