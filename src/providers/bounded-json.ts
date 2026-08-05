/**
 * Shared bounded JSON reader for HTTP provider surfaces.
 *
 * Every provider that speaks HTTP must read its response through this helper so
 * the byte ceiling, the abort on overflow and the JSON failure mode stay
 * identical across adapters. `codePrefix` keeps each adapter's stable error
 * codes ("API_...", "LOCAL_...") without forking the logic.
 */
export async function readBoundedJson(
  response: Response,
  limitBytes: number,
  controller: AbortController,
  codePrefix: string,
): Promise<unknown> {
  if (!response.body) throw new Error(`${codePrefix}_RESPONSE_BODY_MISSING`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    bytes += part.value.byteLength;
    if (bytes > limitBytes) {
      controller.abort();
      throw new Error(`${codePrefix}_OUTPUT_LIMIT_REACHED`);
    }
    chunks.push(part.value);
  }
  const output = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
  try {
    return JSON.parse(output) as unknown;
  } catch {
    throw new Error(`${codePrefix}_RESPONSE_JSON_INVALID`);
  }
}
