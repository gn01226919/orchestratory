import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { open, realpath, stat } from "node:fs/promises";

const MAX_TRANSCRIPT_BYTES = 64 * 1_048_576;
const MAX_TAIL_BYTES = 1_048_576;

export async function readLatestAssistantTranscript(
  inputPath: string,
  transcriptRoot = join(homedir(), ".claude", "projects"),
): Promise<string> {
  if (typeof inputPath !== "string" || inputPath.length < 1 || inputPath.length > 4_096 || inputPath.includes("\0")) {
    throw new Error("INVALID_TRANSCRIPT_PATH");
  }
  const [root, candidate] = await Promise.all([realpath(transcriptRoot), realpath(inputPath)]);
  const child = relative(root, candidate);
  if (!child || child.startsWith("..") || isAbsolute(child) || !candidate.endsWith(".jsonl")) {
    throw new Error("TRANSCRIPT_PATH_DENIED");
  }
  const metadata = await stat(candidate);
  if (!metadata.isFile() || metadata.size > MAX_TRANSCRIPT_BYTES || (metadata.mode & 0o022) !== 0) {
    throw new Error("TRANSCRIPT_FILE_DENIED");
  }
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new Error("TRANSCRIPT_OWNER_MISMATCH");
  }
  const length = Math.min(metadata.size, MAX_TAIL_BYTES);
  const offset = metadata.size - length;
  const handle = await open(candidate, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    let raw = buffer.subarray(0, bytesRead).toString("utf8");
    if (offset > 0) {
      const firstNewline = raw.indexOf("\n");
      raw = firstNewline < 0 ? "" : raw.slice(firstNewline + 1);
    }
    for (const line of raw.trim().split("\n").reverse()) {
      try {
        const entry = JSON.parse(line) as {
          type?: string;
          message?: { content?: Array<{ type?: string; text?: string }> };
        };
        if (entry.type !== "assistant" || !Array.isArray(entry.message?.content)) continue;
        const text = entry.message.content
          .filter((content) => content.type === "text" && typeof content.text === "string")
          .map((content) => content.text!)
          .join("\n")
          .trim();
        if (text) return text;
      } catch { /* malformed transcript rows are untrusted and skipped */ }
    }
    return "";
  } finally {
    await handle.close();
  }
}
