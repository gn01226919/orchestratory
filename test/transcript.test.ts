import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLatestAssistantTranscript } from "../src/security/transcript.ts";

test("transcript reader returns only the latest assistant text from a bounded root", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orchestratory-transcript-root-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const transcript = join(root, "session.jsonl");
  await writeFile(transcript, [
    "malformed",
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "較舊" }] } }),
    JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "忽略" }] } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool", text: "忽略" }, { type: "text", text: "最新回答" }] } }),
  ].join("\n"), { encoding: "utf8", mode: 0o600 });
  assert.equal(await readLatestAssistantTranscript(transcript, root), "最新回答");
});

test("transcript reader denies escapes, symlinks, unsafe modes and non-JSONL files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orchestratory-transcript-policy-"));
  const outside = await mkdtemp(join(tmpdir(), "orchestratory-transcript-outside-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  t.after(async () => await rm(outside, { recursive: true, force: true }));
  const outsideFile = join(outside, "outside.jsonl");
  await writeFile(outsideFile, "{}\n", { mode: 0o600 });
  await assert.rejects(readLatestAssistantTranscript(outsideFile, root), /TRANSCRIPT_PATH_DENIED/u);
  const linked = join(root, "linked.jsonl");
  await symlink(outsideFile, linked);
  await assert.rejects(readLatestAssistantTranscript(linked, root), /TRANSCRIPT_PATH_DENIED/u);
  const unsafe = join(root, "unsafe.jsonl");
  await writeFile(unsafe, "{}\n", { mode: 0o600 });
  await chmod(unsafe, 0o622);
  await assert.rejects(readLatestAssistantTranscript(unsafe, root), /TRANSCRIPT_FILE_DENIED/u);
  const wrongExtension = join(root, "session.txt");
  await writeFile(wrongExtension, "{}\n", { mode: 0o600 });
  await assert.rejects(readLatestAssistantTranscript(wrongExtension, root), /TRANSCRIPT_PATH_DENIED/u);
  await assert.rejects(readLatestAssistantTranscript("bad\0path", root), /INVALID_TRANSCRIPT_PATH/u);
});
