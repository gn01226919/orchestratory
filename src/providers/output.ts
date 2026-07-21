function collectText(value: unknown, output: string[], depth = 0): void {
  if (depth > 8 || value === null || value === undefined) return;
  if (typeof value === "string") {
    if (value.trim()) output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectText(item, output, depth + 1);
    return;
  }
  if (typeof value !== "object") return;
  const object = value as Record<string, unknown>;
  if (object.type === "item.completed") {
    const item = object.item;
    if (
      typeof item === "object" &&
      item !== null &&
      !Array.isArray(item) &&
      (item as Record<string, unknown>).type === "agent_message" &&
      typeof (item as Record<string, unknown>).text === "string"
    ) {
      collectText((item as Record<string, unknown>).text, output, depth + 1);
      return;
    }
  }
  const preferred = [
    "result",
    "output_text",
    "final_output",
    "finalOutput",
    "text",
    "content",
    "message",
  ];
  for (const key of preferred) {
    if (key in object) collectText(object[key], output, depth + 1);
  }
}

export function extractProviderText(stdout: string): string {
  const candidates: string[] = [];
  const trimmed = stdout.trim();
  if (!trimmed) return "";
  let structuredSeen = false;

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    structuredSeen = true;
    collectText(parsed, candidates);
  } catch {
    for (const line of trimmed.split("\n")) {
      try {
        const parsed = JSON.parse(line) as unknown;
        structuredSeen = true;
        collectText(parsed, candidates);
      } catch {
        // Non-JSON lines are intentionally ignored when structured events exist.
      }
    }
  }
  if (candidates.length === 0) {
    if (structuredSeen) throw new Error("PROVIDER_STRUCTURED_OUTPUT_MISSING_TEXT");
    return trimmed;
  }
  return candidates.at(-1) ?? "";
}
