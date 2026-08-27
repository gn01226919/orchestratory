/*
 * Pure hygiene rules, kept separate from the script that walks the repository so they can be tested
 * directly — the same split `scan-rules.mjs` already uses.
 */

/**
 * An unref-ed timer under `test/` must say what else keeps the event loop alive.
 *
 * This guards the defect that cost a full investigation round: an unref-ed timer holds nothing open,
 * so when the thing being awaited is a bare promise, Node decides the loop is drained and reports
 * every pending test as "Promise resolution is still pending but the event loop has already
 * resolved". Those tests are reported as CANCELLED rather than failed, which reads like a runner or
 * Node problem and sends the next person looking anywhere except the line responsible.
 *
 * `test/` is deliberately outside `semanticCodePrefixes`, so the `forbiddenCode` rules never see it.
 *
 * This does not forbid `unref()` — some are correct. It forbids an unexplained one. Write, on the
 * same line or the line immediately above:
 *   // hygiene-allow unref: <what holds the loop open instead>
 *
 * The reason must be substantive, because the marker exists to make someone name the handle out
 * loud. A short reason is refused; a long meaningless one cannot be, and this rule does not pretend
 * otherwise. It forces a sentence, not a thought.
 *
 * @param {string} content file text
 * @returns {number[]} 1-based line numbers of unexplained `unref()` calls
 */
export function unexplainedTestUnrefLines(content) {
  const lines = content.split("\n");
  const allowance = /\/\/\s*hygiene-allow unref:\s*(\S.*)$/u;
  const found = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!/\.unref\s*\(\s*\)/u.test(lines[index])) continue;
    const here = allowance.exec(lines[index]);
    const above = index > 0 ? allowance.exec(lines[index - 1]) : null;
    const reason = (here?.[1] ?? above?.[1] ?? "").trim();
    if (reason.length < MIN_UNREF_REASON_LENGTH) found.push(index + 1);
  }
  return found;
}

/** Long enough to refuse "ok", "fine", "it is safe"; short enough not to demand an essay. */
export const MIN_UNREF_REASON_LENGTH = 12;
