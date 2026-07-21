export const scanRules = [
  ["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/u],
  ["authorization-secret", /Authorization:\s*(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/-]{12,}/u],
  ["provider-secret", /\b(?:sk|xai|ant|ghp|github_pat)-[A-Za-z0-9_-]{12,}\b/u],
  ["secret-assignment", /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret)\s*[:=]\s*["'][^"']{8,}["']/iu],
  ["personal-home-path", /\/Users\/(?!example\b|alice\b|bob\b)[^/\s]+\//u],
  [
    "personal-email",
    /\b(?![A-Z0-9._%+-]+@example\.invalid\b)(?![A-Z0-9._%+-]+@users\.noreply\.github\.com\b)[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu,
  ],
];
