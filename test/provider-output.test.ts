import test from "node:test";
import assert from "node:assert/strict";
import { extractProviderText } from "../src/providers/output.ts";

test("extracts final text from a single JSON result", () => {
  assert.equal(extractProviderText('{"type":"result","result":"final answer"}'), "final answer");
});

test("extracts final text from JSONL events", () => {
  const value = [
    JSON.stringify({ type: "start", message: "starting" }),
    JSON.stringify({ type: "result", result: "finished" }),
  ].join("\n");
  assert.equal(extractProviderText(value), "finished");
});

test("extracts only the Codex agent message from Codex exec JSONL", () => {
  const value = [
    JSON.stringify({ type: "thread.started", thread_id: "private-thread-id" }),
    JSON.stringify({ type: "turn.started" }),
    JSON.stringify({
      type: "item.completed",
      item: { id: "item_0", type: "agent_message", text: "真正回答" },
    }),
    JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: 10_000, output_tokens: 20 },
    }),
  ].join("\n");
  assert.equal(extractProviderText(value), "真正回答");
  assert.doesNotMatch(extractProviderText(value), /thread_id|input_tokens/u);
});

test("provider output parser handles empty, nested and unstructured output", () => {
  assert.equal(extractProviderText("  "), "");
  assert.equal(extractProviderText("plain output"), "plain output");
  assert.equal(
    extractProviderText(JSON.stringify({ content: [{ text: "nested" }, { ignored: 1 }] })),
    "nested",
  );
  assert.throws(
    () => extractProviderText(JSON.stringify({ result: 42 })),
    /PROVIDER_STRUCTURED_OUTPUT_MISSING_TEXT/u,
  );
});
