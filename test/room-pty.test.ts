import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeRoomPtyTranscript,
  parseRoomPtyCliArgs,
  parseRoomPtyProvider,
  roomPtyProviderArguments,
  runRoomPty,
} from "../src/core/room-pty.ts";

test("room PTY accepts only fixed subscription CLI providers", () => {
  assert.equal(parseRoomPtyProvider("codex"), "codex");
  assert.equal(parseRoomPtyProvider("grok"), "grok");
  assert.throws(() => parseRoomPtyProvider("claude"), /ROOM_PTY_PROVIDER_DENIED/u);
  assert.throws(() => parseRoomPtyProvider("sh"), /ROOM_PTY_PROVIDER_DENIED/u);
  assert.throws(() => parseRoomPtyProvider("codex --dangerously-bypass-approvals"), /ROOM_PTY_PROVIDER_DENIED/u);
});

test("room PTY forces provider-native read-only controls", () => {
  const codex = roomPtyProviderArguments("codex", "/tmp/project");
  assert.equal(codex[codex.indexOf("--sandbox") + 1], "read-only");
  assert.equal(codex[codex.indexOf("--ask-for-approval") + 1], "never");
  assert.ok(codex.includes("shell_tool"));
  assert.ok(codex.includes("hooks"));
  assert.equal(codex[codex.indexOf("--cd") + 1], "/tmp/project");

  const grok = roomPtyProviderArguments("grok", "/tmp/project");
  assert.equal(grok[grok.indexOf("--permission-mode") + 1], "plan");
  assert.equal(grok[grok.indexOf("--tools") + 1], "");
  assert.ok(grok.includes("--no-subagents"));
  assert.ok(grok.includes("--disable-web-search"));
  assert.equal(grok[grok.indexOf("--max-turns") + 1], "30");
});

test("room PTY CLI parser rejects every unrecognized or ambiguous argument", () => {
  assert.equal(parseRoomPtyCliArgs(["room", "pty", "codex"]), "codex");
  assert.equal(parseRoomPtyCliArgs(["room", "pty", "grok", "--room", "demo"]), "grok");
  assert.throws(() => parseRoomPtyCliArgs(["room", "pty", "codex", "--dangerous"]), /ROOM_PTY_ARGUMENT_DENIED/u);
  assert.throws(() => parseRoomPtyCliArgs(["room", "pty", "codex", "--room"]), /ROOM_PTY_ARGUMENT_DENIED/u);
  assert.throws(
    () => parseRoomPtyCliArgs(["room", "pty", "codex", "--room", "one", "--room", "two"]),
    /ROOM_PTY_ARGUMENT_DENIED/u,
  );
  assert.throws(() => parseRoomPtyCliArgs(["room", "join", "codex"]), /ROOM_PTY_ARGUMENT_DENIED/u);
  assert.throws(() => parseRoomPtyCliArgs(["room", "tail", "codex"]), /ROOM_PTY_ARGUMENT_DENIED/u);
});

test("room PTY transcript is visibly mixed, sanitized, redacted and bounded", () => {
  const syntheticSecret = ["sk", "example", "abcdefghijk"].join("-");
  const input =
    `Script started on 2026-07-17 00:00:00+08:00\r\n` +
    `\u001b[31m你 > hello\u001b[0m\ragent > token ${syntheticSecret}\u0000\n` +
    `To continue this session, run codex resume 019f6de5-8fe4-70b3-98ee-71c731b496ab\n` +
    `Script done on 2026-07-17 00:00:01+08:00\n`;
  const transcript = normalizeRoomPtyTranscript(input);
  assert.match(transcript, /^\[bounded mixed PTY transcript:/u);
  assert.match(transcript, /你 > hello/u);
  assert.equal(transcript.includes("\u001b"), false);
  assert.equal(transcript.includes("\u0000"), false);
  assert.equal(transcript.includes(syntheticSecret), false);
  assert.equal(transcript.includes("019f6de5-8fe4-70b3-98ee-71c731b496ab"), false);
  assert.match(transcript, /codex resume \[SESSION_ID_REDACTED\]/u);
  assert.ok(transcript.length <= 12_020);
  assert.equal(normalizeRoomPtyTranscript("\u001b[2J\r\n"), "");
  assert.equal(normalizeRoomPtyTranscript("^D\b\b"), "");
});

test("room PTY fails closed off macOS before starting a provider", async () => {
  await assert.rejects(
    runRoomPty("codex", "/tmp", { platform: "linux" }),
    /ROOM_PTY_UNSUPPORTED_PLATFORM/u,
  );
  await assert.rejects(
    runRoomPty("not-a-provider", "/tmp", { platform: "darwin" }),
    /ROOM_PTY_PROVIDER_DENIED/u,
  );
  await assert.rejects(
    runRoomPty("codex", "/tmp", { platform: "darwin", timeoutMs: 0 }),
    /INVALID_ROOM_PTY_TIMEOUT/u,
  );
});
