import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomLedger } from "../src/core/room-ledger.ts";
import { recordTuiDecision, selectTuiRoom } from "../src/core/tui-room-bridge.ts";

test("TUI selects an exact workspace Room and never silently chooses among duplicates", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "orchestratory-tui-room-"));
  t.after(async () => await rm(data, { recursive: true, force: true }));
  const ledger = new RoomLedger(data);
  t.after(() => ledger.close());
  const created = selectTuiRoom(ledger, "/tmp/project");
  assert.equal(created.workspace, "/tmp/project");
  assert.equal(selectTuiRoom(ledger, "/tmp/project").id, created.id);
  ledger.createRoom("second", "/tmp/project");
  assert.throws(() => selectTuiRoom(ledger, "/tmp/project"), /TUI_ROOM_SELECTION_REQUIRED/u);
  assert.equal(selectTuiRoom(ledger, "/tmp/project", "second").id, "second");
  ledger.createRoom("other", "/tmp/other");
  assert.throws(() => selectTuiRoom(ledger, "/tmp/project", "other"), /TUI_ROOM_WORKSPACE_MISMATCH/u);
});

test("TUI records Leader input and each validated provider reply in the shared ledger", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "orchestratory-tui-ledger-"));
  t.after(async () => await rm(data, { recursive: true, force: true }));
  const ledger = new RoomLedger(data);
  t.after(() => ledger.close());
  const room = selectTuiRoom(ledger, "/tmp/project");
  ledger.append(room.id, "you", "請分析架構");
  recordTuiDecision(ledger, room.id, {
    kind: "message", source: "codex", model: "gpt-5.6-sol", message: "Codex 建議",
  });
  recordTuiDecision(ledger, room.id, {
    kind: "compare",
    answers: [
      { provider: "claude", model: "claude-fable-5", message: "Claude 意見" },
      { provider: "grok", model: "grok-4.5", message: "Grok 意見" },
    ],
  });
  recordTuiDecision(ledger, room.id, { kind: "tool", tool: "coding_team", input: "修正 bug" });
  const messages = ledger.listAfter(room.id, 0);
  assert.deepEqual(messages.slice(1).map((message) => message.author), ["you", "codex", "claude", "grok", "system"]);
  assert.equal(ledger.verifyChain(room.id), true);
});
