import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RoomLedger } from "../src/core/room-ledger.ts";
import { RoomPresenceStore } from "../src/core/room-presence.ts";

const ROOM_FIRST = { collaborationMode: "room-first" as const, syncTurns: true };
const SEAT_ONLY = { collaborationMode: "seat-only" as const, syncTurns: false };

async function fixture(t: TestContext) {
  const data = await mkdtemp(join(tmpdir(), "orchestratory-presence-"));
  let now = 1_000_000;
  const presence = new RoomPresenceStore(data, { now: () => now, leaseMs: 15_000 });
  const ledger = new RoomLedger(data);
  t.after(() => presence.close());
  t.after(() => ledger.close());
  t.after(async () => await rm(data, { recursive: true, force: true }));
  return {
    data,
    presence,
    ledger,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
  };
}

test("MCP sessions stay separate and aliases are never reused", async (t) => {
  const { presence } = await fixture(t);
  const first = presence.register({
    provider: "codex",
    workspace: "/tmp/project",
    hostPid: 101,
    client: "Codex CLI",
  });
  const second = presence.register({
    provider: "codex",
    workspace: "/tmp/project",
    hostPid: 102,
    client: "Codex CLI",
  });

  assert.notEqual(first.id, second.id);
  presence.requestJoin(first.id, "demo", "/tmp/project");
  presence.requestJoin(second.id, "demo", "/tmp/project");
  assert.equal(presence.join(first.id, "demo", "/tmp/project", ROOM_FIRST).displayName, "codex1");
  assert.equal(presence.join(second.id, "demo", "/tmp/project", ROOM_FIRST).displayName, "codex2");
  assert.deepEqual(
    presence.list("/tmp/project", "demo").map((entry) => entry.displayName),
    ["codex1", "codex2"],
  );

  presence.unregister(first.id);
  const third = presence.register({ provider: "codex", workspace: "/tmp/project", hostPid: 103 });
  presence.requestJoin(third.id, "demo", "/tmp/project");
  assert.equal(presence.join(third.id, "demo", "/tmp/project", ROOM_FIRST).displayName, "codex3");
});

test("owner approval binds an explicit collaboration mode and independent turn sync", async (t) => {
  const { presence, ledger } = await fixture(t);
  ledger.createRoom("demo", "/tmp/project");
  const roomFirst = presence.register({ provider: "codex", workspace: "/tmp/project", hostPid: 150 });
  const seatOnly = presence.register({ provider: "claude", workspace: "/tmp/project", hostPid: 151 });
  const noTurnSync = presence.register({ provider: "codex", workspace: "/tmp/project", hostPid: 152 });
  presence.requestJoin(roomFirst.id, "demo", "/tmp/project");
  presence.requestJoin(seatOnly.id, "demo", "/tmp/project");
  presence.requestJoin(noTurnSync.id, "demo", "/tmp/project");

  assert.throws(
    () => presence.join(roomFirst.id, "demo", "/tmp/project", undefined as never),
    /INVALID_PRESENCE_JOIN_APPROVAL/u,
  );
  assert.throws(
    () => presence.join(roomFirst.id, "demo", "/tmp/project", { collaborationMode: "unknown", syncTurns: true } as never),
    /INVALID_PRESENCE_COLLABORATION_MODE/u,
  );
  const first = presence.join(roomFirst.id, "demo", "/tmp/project", ROOM_FIRST);
  const second = presence.join(seatOnly.id, "demo", "/tmp/project", { collaborationMode: "seat-only", syncTurns: true });
  const third = presence.join(noTurnSync.id, "demo", "/tmp/project", { collaborationMode: "room-first", syncTurns: false });
  assert.equal(first.collaborationMode, "room-first");
  assert.equal(first.syncTurns, true);
  assert.equal(second.collaborationMode, "seat-only");
  assert.equal(second.syncTurns, true);
  assert.equal(third.collaborationMode, "room-first");
  assert.equal(third.syncTurns, false);

  assert.equal(presence.recordHook(ledger, {
    provider: "codex", workspace: "/tmp/project", hostPid: 150,
    sessionId: "room-first-session", event: "UserPromptSubmit", text: "應同步",
  }), "recorded");
  assert.equal(presence.recordHook(ledger, {
    provider: "claude", workspace: "/tmp/project", hostPid: 151,
    sessionId: "seat-only-session", event: "UserPromptSubmit", text: "席位模式也能同步",
  }), "recorded");
  assert.equal(presence.recordHook(ledger, {
    provider: "codex", workspace: "/tmp/project", hostPid: 152,
    sessionId: "room-first-no-sync", event: "UserPromptSubmit", text: "不應同步",
  }), "ignored");
  assert.equal(ledger.listAfter("demo", 0).some((message) => message.text === "應同步"), true);
  assert.equal(ledger.listAfter("demo", 0).some((message) => message.text === "席位模式也能同步"), true);
  assert.equal(ledger.listAfter("demo", 0).some((message) => message.text === "不應同步"), false);
});

test("join is owner-controlled, workspace-bound, live-only, and idempotent", async (t) => {
  const { presence, advance } = await fixture(t);
  const session = presence.register({ provider: "claude", workspace: "/tmp/a", hostPid: 201 });

  assert.equal(presence.get("missing"), undefined);
  assert.throws(() => presence.requestJoin(session.id, "demo", "/tmp/b"), /PRESENCE_WORKSPACE_MISMATCH/u);
  assert.throws(() => presence.requestJoin(session.id, "BAD ROOM", "/tmp/a"), /INVALID_ROOM_ID/u);
  assert.throws(() => presence.join(session.id, "demo", "/tmp/a", ROOM_FIRST), /PRESENCE_JOIN_NOT_REQUESTED/u);
  assert.throws(() => presence.join(session.id, "demo", "/tmp/b", ROOM_FIRST), /PRESENCE_WORKSPACE_MISMATCH/u);
  presence.requestJoin(session.id, "demo", "/tmp/a");
  const joined = presence.join(session.id, "demo", "/tmp/a", ROOM_FIRST);
  assert.equal(joined.displayName, "claude1");
  assert.equal(presence.actorFor(session.id, "demo"), "claude1");
  assert.equal(presence.requestJoin(session.id, "demo", "/tmp/a").requested, false);
  assert.throws(() => presence.requestJoin(session.id, "other", "/tmp/a"), /PRESENCE_ALREADY_JOINED/u);
  assert.throws(() => presence.actorFor(session.id, "other"), /PRESENCE_NOT_JOINED/u);
  const idempotent = presence.join(session.id, "demo", "/tmp/a", SEAT_ONLY);
  assert.equal(idempotent.displayName, "claude1");
  assert.equal(idempotent.collaborationMode, "room-first");
  assert.equal(idempotent.syncTurns, true);
  assert.throws(() => presence.join(session.id, "other", "/tmp/a", ROOM_FIRST), /PRESENCE_ALREADY_JOINED/u);

  presence.leave(session.id, "demo");
  assert.equal(presence.list("/tmp/a", "demo")[0]?.joined, false);
  advance(15_001);
  assert.throws(() => presence.join(session.id, "demo", "/tmp/a", ROOM_FIRST), /PRESENCE_NOT_FOUND/u);
  assert.deepEqual(presence.list("/tmp/a", "demo"), []);
});

test("owner can name a joined desk while invalid or duplicate labels fail closed", async (t) => {
  const { presence } = await fixture(t);
  const first = presence.register({ provider: "codex", workspace: "/tmp/project", hostPid: 221 });
  const second = presence.register({ provider: "codex", workspace: "/tmp/project", hostPid: 222 });
  presence.requestJoin(first.id, "demo", "/tmp/project");
  presence.requestJoin(second.id, "demo", "/tmp/project");

  assert.equal(presence.join(first.id, "demo", "/tmp/project", { ...ROOM_FIRST, label: "前端 2" }).displayName, "codex（前端 2）");
  assert.throws(
    () => presence.join(second.id, "demo", "/tmp/project", { ...ROOM_FIRST, label: "前端 2" }),
    /PRESENCE_DISPLAY_NAME_IN_USE/u,
  );
  assert.throws(
    () => presence.join(second.id, "demo", "/tmp/project", { ...ROOM_FIRST, label: "<script>" }),
    /INVALID_PRESENCE_OWNER_LABEL/u,
  );
  assert.equal(presence.join(second.id, "demo", "/tmp/project", ROOM_FIRST).displayName, "codex1");
});

test("a live MCP terminal stays invisible to a room until it explicitly requests entry", async (t) => {
  const { presence } = await fixture(t);
  const session = presence.register({ provider: "codex", workspace: "/tmp/project", hostPid: 211 });

  assert.equal(presence.list("/tmp/project", "demo")[0]?.requested, false);
  assert.equal(presence.list("/tmp/project", "other")[0]?.requested, false);
  const requested = presence.requestJoin(session.id, "demo", "/tmp/project");
  assert.equal(requested.requested, true);
  assert.equal(requested.joined, false);
  assert.equal(presence.list("/tmp/project", "demo")[0]?.requested, true);
  assert.equal(presence.list("/tmp/project", "other")[0]?.requested, false);
});

test("a cancelled join request disappears without removing the live terminal", async (t) => {
  const { presence } = await fixture(t);
  const session = presence.register({ provider: "codex", workspace: "/tmp/project", hostPid: 212 });
  presence.requestJoin(session.id, "demo", "/tmp/project");
  assert.equal(presence.list("/tmp/project", "demo")[0]?.requested, true);
  const cancelled = presence.cancelJoinRequest(session.id, "demo");
  assert.equal(cancelled.requested, false);
  assert.equal(cancelled.joined, false);
  assert.equal(presence.get(session.id)?.id, session.id);
});

test("heartbeat extends the lease while unregister removes the desk immediately", async (t) => {
  const { presence, advance } = await fixture(t);
  const session = presence.register({ provider: "grok", workspace: "/tmp/project", hostPid: 301 });
  presence.requestJoin(session.id, "demo", "/tmp/project");
  presence.join(session.id, "demo", "/tmp/project", ROOM_FIRST);
  advance(10_000);
  presence.heartbeat(session.id);
  advance(10_000);
  assert.equal(presence.list("/tmp/project", "demo").length, 1);
  presence.unregister(session.id);
  assert.equal(presence.list("/tmp/project", "demo").length, 0);
});

test("hook content is recorded only after joining and retries are deduplicated", async (t) => {
  const { presence, ledger } = await fixture(t);
  ledger.createRoom("demo", "/tmp/project");
  const session = presence.register({ provider: "codex", workspace: "/tmp/project", hostPid: 401 });

  assert.equal(
    presence.recordHook(ledger, {
      provider: "codex",
      workspace: "/tmp/project",
      hostPid: 401,
      sessionId: "private-session-id",
      event: "UserPromptSubmit",
      turnId: "turn-1",
      text: "未加入，不應保存",
    }),
    "ignored",
  );
  assert.equal(ledger.getRoom("demo")?.messages, 1);

  presence.requestJoin(session.id, "demo", "/tmp/project");
  presence.join(session.id, "demo", "/tmp/project", ROOM_FIRST);
  const input = {
    provider: "codex" as const,
    workspace: "/tmp/project",
    hostPid: 401,
    sessionId: "private-session-id",
    event: "UserPromptSubmit" as const,
    turnId: "turn-2",
    text: "請檢查登入流程",
  };
  assert.equal(presence.recordHook(ledger, input), "recorded");
  assert.equal(presence.recordHook(ledger, input), "duplicate");
  assert.equal(
    presence.recordHook(ledger, {
      ...input,
      event: "Stop",
      text: "登入流程已檢查完成",
    }),
    "recorded",
  );
  assert.deepEqual(
    ledger.getRange("demo", 2, 3).map((message) => [message.author, message.text]),
    [
      ["you", "請檢查登入流程"],
      ["codex1", "登入流程已檢查完成"],
    ],
  );

  const raw = new DatabaseSync(presence.path, { readOnly: true });
  const persisted = JSON.stringify(raw.prepare("SELECT * FROM agent_presence").all());
  assert.equal(persisted.includes("private-session-id"), false);
  raw.close();
});

test("hook replies require a paired prompt and session binding prevents PID confusion", async (t) => {
  const { presence, ledger } = await fixture(t);
  ledger.createRoom("demo", "/tmp/project");
  const session = presence.register({ provider: "claude", workspace: "/tmp/project", hostPid: 450 });
  presence.requestJoin(session.id, "demo", "/tmp/project");
  presence.join(session.id, "demo", "/tmp/project", { ...ROOM_FIRST, label: "審查" });
  assert.equal(presence.recordHook(ledger, {
    provider: "claude", workspace: "/tmp/project", hostPid: 450,
    sessionId: "session-a", event: "SessionStart",
  }), "ignored");
  assert.equal(presence.recordHook(ledger, {
    provider: "claude", workspace: "/tmp/project", hostPid: 450,
    sessionId: "session-a", event: "Stop", turnId: "orphan", text: "不應入帳",
  }), "ignored");
  assert.equal(presence.recordHook(ledger, {
    provider: "claude", workspace: "/tmp/project", hostPid: 450,
    sessionId: "session-b", event: "UserPromptSubmit", turnId: "turn-x", text: "錯誤 session",
  }), "ignored");
  assert.equal(ledger.getRoom("demo")?.messages, 1);
  presence.recordHook(ledger, {
    provider: "claude", workspace: "/tmp/project", hostPid: 450,
    sessionId: "session-a", event: "UserPromptSubmit", turnId: "turn-a", text: "請審查",
  });
  assert.equal(presence.recordHook(ledger, {
    provider: "claude", workspace: "/tmp/project", hostPid: 450,
    sessionId: "session-a", event: "Stop", turnId: "turn-b", text: "錯誤回合",
  }), "ignored");
  assert.equal(presence.recordHook(ledger, {
    provider: "claude", workspace: "/tmp/project", hostPid: 450,
    sessionId: "session-a", event: "Stop", turnId: "turn-a", text: "審查完成",
  }), "recorded");
  assert.deepEqual(ledger.getRange("demo", 2, 3).map((message) => message.author), ["you", "claude（審查）"]);
});

test("hooks without upstream turn ids preserve repeated natural-language turns", async (t) => {
  const { presence, ledger } = await fixture(t);
  ledger.createRoom("demo", "/tmp/project");
  const session = presence.register({ provider: "codex", workspace: "/tmp/project", hostPid: 455 });
  presence.requestJoin(session.id, "demo", "/tmp/project");
  presence.join(session.id, "demo", "/tmp/project", { ...ROOM_FIRST, label: "重複回合" });
  presence.recordHook(ledger, {
    provider: "codex", workspace: "/tmp/project", hostPid: 455,
    sessionId: "same-text-session", event: "SessionStart",
  });
  const prompt = {
    provider: "codex" as const, workspace: "/tmp/project", hostPid: 455,
    sessionId: "same-text-session", event: "UserPromptSubmit" as const, text: "繼續",
  };
  const stop = {
    provider: "codex" as const, workspace: "/tmp/project", hostPid: 455,
    sessionId: "same-text-session", event: "Stop" as const, text: "已繼續處理",
  };
  assert.equal(presence.recordHook(ledger, prompt), "recorded");
  assert.equal(presence.recordHook(ledger, prompt), "duplicate");
  assert.equal(presence.recordHook(ledger, stop), "recorded");
  assert.equal(presence.recordHook(ledger, prompt), "recorded");
  assert.equal(presence.recordHook(ledger, stop), "recorded");
  assert.deepEqual(
    ledger.getRange("demo", 2, 5).map((message) => [message.author, message.text]),
    [
      ["you", "繼續"],
      ["codex（重複回合）", "已繼續處理"],
      ["you", "繼續"],
      ["codex（重複回合）", "已繼續處理"],
    ],
  );
});

test("an older prompt collision abandons a different open turn instead of disappearing", async (t) => {
  const { presence, ledger } = await fixture(t);
  ledger.createRoom("demo", "/tmp/project");
  const session = presence.register({ provider: "codex", workspace: "/tmp/project", hostPid: 457 });
  presence.requestJoin(session.id, "demo", "/tmp/project");
  presence.join(session.id, "demo", "/tmp/project", { ...ROOM_FIRST, label: "衝突回合" });
  presence.recordHook(ledger, {
    provider: "codex", workspace: "/tmp/project", hostPid: 457,
    sessionId: "collision-session", event: "SessionStart",
  });
  const hook = (event: "UserPromptSubmit" | "Stop", text: string) => presence.recordHook(ledger, {
    provider: "codex", workspace: "/tmp/project", hostPid: 457,
    sessionId: "collision-session", event, text,
  });
  assert.equal(hook("UserPromptSubmit", "再跑測試"), "recorded");
  assert.equal(hook("Stop", "第一回合完成"), "recorded");
  assert.equal(hook("UserPromptSubmit", "不同任務"), "recorded");
  assert.equal(hook("UserPromptSubmit", "再跑測試"), "recorded");
  assert.equal(ledger.search("demo", "再跑測試").length, 2);
  assert.equal(ledger.search("demo", "上一個終端回合未收到完成事件").length, 1);
});

test("SessionStart cannot rebind an already bound exact seat by PID", async (t) => {
  const { presence, ledger } = await fixture(t);
  ledger.createRoom("demo", "/tmp/project");
  const session = presence.register({ provider: "claude", workspace: "/tmp/project", hostPid: 456 });
  presence.requestJoin(session.id, "demo", "/tmp/project");
  presence.join(session.id, "demo", "/tmp/project", { ...ROOM_FIRST, label: "固定席位" });
  assert.equal(presence.recordHook(ledger, {
    provider: "claude", workspace: "/tmp/project", hostPid: 456,
    sessionId: "owner-session", event: "SessionStart",
  }), "ignored");
  assert.equal(presence.recordHook(ledger, {
    provider: "claude", workspace: "/tmp/project", hostPid: 456,
    sessionId: "attacker-session", event: "SessionStart",
  }), "ignored");
  assert.equal(presence.recordHook(ledger, {
    provider: "claude", workspace: "/tmp/project", hostPid: 456,
    sessionId: "attacker-session", event: "UserPromptSubmit", text: "不應入帳",
  }), "ignored");
  assert.equal(presence.recordHook(ledger, {
    provider: "claude", workspace: "/tmp/project", hostPid: 456,
    sessionId: "owner-session", event: "UserPromptSubmit", text: "正常訊息",
  }), "recorded");
  assert.equal(ledger.search("demo", "不應入帳").length, 0);
  assert.equal(ledger.search("demo", "正常訊息").length, 1);
});

test("hook deduplication survives exact seat reconnects for the same provider session", async (t) => {
  const { presence, ledger } = await fixture(t);
  ledger.createRoom("demo", "/tmp/project");
  const first = presence.register({ provider: "codex", workspace: "/tmp/project", hostPid: 460 });
  presence.requestJoin(first.id, "demo", "/tmp/project");
  presence.join(first.id, "demo", "/tmp/project", { ...ROOM_FIRST, label: "原席位" });
  const event = {
    provider: "codex" as const, workspace: "/tmp/project", hostPid: 460,
    sessionId: "stable-session", event: "UserPromptSubmit" as const,
    turnId: "stable-turn", text: "只應入帳一次",
  };
  assert.equal(presence.recordHook(ledger, event), "recorded");
  presence.unregister(first.id);
  const second = presence.register({ provider: "codex", workspace: "/tmp/project", hostPid: 461 });
  presence.requestJoin(second.id, "demo", "/tmp/project");
  presence.join(second.id, "demo", "/tmp/project", { ...ROOM_FIRST, label: "新席位" });
  presence.recordHook(ledger, {
    provider: "codex", workspace: "/tmp/project", hostPid: 461,
    sessionId: "stable-session", event: "SessionStart",
  });
  assert.equal(presence.recordHook(ledger, { ...event, hostPid: 461 }), "duplicate");
  assert.equal(ledger.search("demo", "只應入帳一次").length, 1);
});

test("presence storage is owner-only and rejects malformed or future schemas", async (t) => {
  const { data, presence } = await fixture(t);
  assert.equal((await stat(presence.path)).mode & 0o777, 0o600);
  assert.throws(
    () => presence.register({ provider: "shell" as "codex", workspace: "/tmp/a", hostPid: 1 }),
    /INVALID_PRESENCE_PROVIDER/u,
  );
  assert.throws(
    () => presence.register({ provider: "codex", workspace: "relative", hostPid: 1 }),
    /INVALID_PRESENCE_WORKSPACE/u,
  );
  const duplicate = presence.register({ provider: "codex", workspace: "/tmp/a", hostPid: 701 });
  assert.ok(duplicate.id);
  assert.throws(
    () => presence.register({ provider: "codex", workspace: "/tmp/a", hostPid: 701 }),
    /PRESENCE_ALREADY_REGISTERED/u,
  );
  assert.throws(() => presence.heartbeat("missing"), /PRESENCE_NOT_FOUND/u);
  presence.close();

  const raw = new DatabaseSync(join(data, "room-presence.sqlite"));
  raw.exec("PRAGMA user_version = 999");
  raw.close();
  assert.throws(() => new RoomPresenceStore(data), /PRESENCE_SCHEMA_UNSUPPORTED/u);
});

test("presence rejects unsafe lease and hook correlation fields", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "orchestratory-presence-invalid-"));
  t.after(async () => await rm(data, { recursive: true, force: true }));
  assert.throws(() => new RoomPresenceStore(data, { leaseMs: 4_999 }), /INVALID_PRESENCE_LEASE/u);

  const presence = new RoomPresenceStore(data);
  const ledger = new RoomLedger(data);
  t.after(() => presence.close());
  t.after(() => ledger.close());
  presence.register({ provider: "grok", workspace: "/tmp/project", hostPid: 702 });
  const base = {
    provider: "grok" as const,
    workspace: "/tmp/project",
    hostPid: 702,
    event: "Stop" as const,
    text: "done",
  };
  assert.throws(
    () => presence.recordHook(ledger, { ...base, sessionId: "" }),
    /INVALID_PRESENCE_SESSION_ID/u,
  );
  assert.throws(
    () => presence.recordHook(ledger, { ...base, sessionId: "session", turnId: "" }),
    /INVALID_PRESENCE_TURN_ID/u,
  );
});

test("presence schema v1 migrates transactionally to explicit requests and safe legacy collaboration modes", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "orchestratory-presence-v1-"));
  t.after(async () => await rm(data, { recursive: true, force: true }));
  const path = join(data, "room-presence.sqlite");
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE agent_presence (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL CHECK (provider IN ('codex', 'claude', 'grok')),
      workspace TEXT NOT NULL,
      host_pid INTEGER NOT NULL,
      client TEXT,
      model TEXT,
      connected_at_ms INTEGER NOT NULL,
      last_seen_at_ms INTEGER NOT NULL,
      lease_expires_at_ms INTEGER NOT NULL,
      room_id TEXT,
      display_name TEXT,
      session_hash TEXT,
      UNIQUE(provider, workspace, host_pid),
      CHECK ((room_id IS NULL AND display_name IS NULL) OR
             (room_id IS NOT NULL AND display_name IS NOT NULL))
    );
    CREATE INDEX agent_presence_workspace_live
      ON agent_presence(workspace, lease_expires_at_ms);
    CREATE TABLE room_agent_counters (
      room_id TEXT NOT NULL,
      provider TEXT NOT NULL CHECK (provider IN ('codex', 'claude', 'grok')),
      next_number INTEGER NOT NULL CHECK (next_number BETWEEN 1 AND 1000000),
      PRIMARY KEY (room_id, provider)
    );
    CREATE TABLE presence_hook_dedup (
      presence_id TEXT NOT NULL REFERENCES agent_presence(id) ON DELETE CASCADE,
      event_key TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      PRIMARY KEY (presence_id, event_key)
    );
    INSERT INTO agent_presence (
      id, provider, workspace, host_pid, client, model,
      connected_at_ms, last_seen_at_ms, lease_expires_at_ms,
      room_id, display_name, session_hash
    ) VALUES (
      'legacy-seat', 'codex', '/tmp/legacy-project', 500, 'Codex CLI', NULL,
      1000, 1000, 4000000000000,
      'legacy-room', 'codex1', NULL
    );
    PRAGMA user_version = 1;
  `);
  legacy.close();
  await chmod(path, 0o600);

  const migrated = new RoomPresenceStore(data);
  t.after(() => migrated.close());
  assert.equal(migrated.inventory().schemaVersion, 4);
  const legacySeat = migrated.list("/tmp/legacy-project", "legacy-room")[0];
  assert.equal(legacySeat?.collaborationMode, "seat-only");
  assert.equal(legacySeat?.syncTurns, true);
  const session = migrated.register({ provider: "claude", workspace: "/tmp/project", hostPid: 501 });
  assert.equal(migrated.requestJoin(session.id, "demo", "/tmp/project").requested, true);
  assert.equal(migrated.integrity().stateValid, true);
});
