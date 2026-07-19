import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installRoomHooks,
  normalizePresenceHookPayload,
  roomHookCommand,
  roomHooksPreview,
} from "../src/core/room-hooks.ts";

test("presence hook payloads normalize Codex, Claude and Grok field names", () => {
  assert.deepEqual(
    normalizePresenceHookPayload({
      hook_event_name: "UserPromptSubmit",
      cwd: "/tmp/project",
      session_id: "codex-session",
      turn_id: "turn-1",
      prompt: "修復席位",
      model: "gpt-test",
    }, {}),
    {
      event: "UserPromptSubmit",
      cwd: "/tmp/project",
      sessionId: "codex-session",
      turnId: "turn-1",
      text: "修復席位",
      model: "gpt-test",
    },
  );
  assert.deepEqual(
    normalizePresenceHookPayload({
      hookEventName: "stop",
      workspaceRoot: "/tmp/grok",
      sessionId: "grok-session",
      turnId: "turn-2",
      lastAssistantMessage: "完成",
    }, {}),
    {
      event: "Stop",
      cwd: "/tmp/grok",
      sessionId: "grok-session",
      turnId: "turn-2",
      text: "完成",
    },
  );
  assert.deepEqual(
    normalizePresenceHookPayload({}, {
      GROK_HOOK_EVENT: "session_start",
      GROK_WORKSPACE_ROOT: "/tmp/env",
      GROK_SESSION_ID: "environment-session",
    }),
    { event: "SessionStart", cwd: "/tmp/env", sessionId: "environment-session" },
  );
  assert.equal(normalizePresenceHookPayload({ hook_event_name: "PreToolUse" }, {}), undefined);
});

test("room hook previews contain the three passive lifecycle events", () => {
  const preview = JSON.stringify(roomHooksPreview("grok"));
  assert.match(preview, /SessionStart/u);
  assert.match(preview, /UserPromptSubmit/u);
  assert.match(preview, /Stop/u);
  assert.match(preview, new RegExp(roomHookCommand("grok"), "u"));
});

test("hook installers preserve settings, remove legacy hooks, back up and stay idempotent", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "orchestratory-hooks-"));
  t.after(async () => await rm(home, { recursive: true, force: true }));
  await writeFile(join(home, "placeholder"), "safe", "utf8");
  await installRoomHooks("codex", home);
  await installRoomHooks("grok", home);

  const claudeDirectory = join(home, ".claude");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(claudeDirectory, { recursive: true }));
  const claudePath = join(claudeDirectory, "settings.json");
  await writeFile(claudePath, JSON.stringify({ keep: true, hooks: { Stop: [{ hooks: [{ command: "orchestrator room log-hook" }] }] } }), "utf8");
  const installed = await installRoomHooks("claude", home);
  assert.equal(installed.changed, true);
  assert.equal(installed.backupPath, `${claudePath}.orchestrator-backup`);
  const settings = JSON.parse(await readFile(claudePath, "utf8")) as Record<string, unknown>;
  assert.equal(settings.keep, true);
  assert.equal(JSON.stringify(settings).includes("room log-hook"), false);
  assert.equal((await stat(claudePath)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(`${claudePath}.orchestrator-backup`, "utf8")).keep, true);
  assert.equal((await installRoomHooks("claude", home)).changed, false);

  assert.match(await readFile(join(home, ".codex", "hooks.json"), "utf8"), /presence-hook --provider codex/u);
  assert.match(await readFile(join(home, ".grok", "hooks", "orchestratory-room.json"), "utf8"), /presence-hook --provider grok/u);
});

test("installer refuses malformed existing hook documents", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "orchestratory-hooks-invalid-"));
  t.after(async () => await rm(home, { recursive: true, force: true }));
  const directory = join(home, ".codex");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(directory, { recursive: true }));
  await writeFile(join(directory, "hooks.json"), "{broken", "utf8");
  await assert.rejects(installRoomHooks("codex", home), SyntaxError);
});
