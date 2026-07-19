import test from "node:test";
import assert from "node:assert/strict";
import { RunEvents } from "../src/core/events.ts";
import type { LocalStore } from "../src/core/store.ts";

test("event subscriptions receive sanitized events and can unsubscribe", () => {
  const store = { appendEvent: () => 7 } as unknown as LocalStore;
  const events = new RunEvents(store);
  const received: string[] = [];
  const unsubscribe = events.subscribe("run-1", (event) => received.push(event.summary));
  events.emit({ runId: "run-1", type: "test", actor: "test", status: "info", summary: "hello" });
  unsubscribe();
  events.emit({ runId: "run-1", type: "test", actor: "test", status: "info", summary: "ignored" });
  assert.deepEqual(received, ["hello"]);
});
