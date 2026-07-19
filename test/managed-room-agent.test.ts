import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ManagedRoomAgentStore, managedAgentDisplayName } from "../src/core/managed-room-agent.ts";

test("managed room agents have persistent distinct identities and archive cleanly", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "orchestratory-managed-agent-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  const store = new ManagedRoomAgentStore(data);
  t.after(() => store.close());
  const created = store.create({
    roomId: "demo", workspace: "/tmp/project", provider: "claude", model: "sonnet", label: "前端小組",
  }, 1_000);
  assert.equal(created.displayName, "claude（前端小組）");
  assert.equal(created.kind, "managed-subagent");
  assert.equal((await stat(store.path)).mode & 0o777, 0o600);
  assert.throws(() => store.create({
    roomId: "demo", workspace: "/tmp/project", provider: "claude", model: "sonnet", label: "前端小組",
  }), /MANAGED_AGENT_DISPLAY_NAME_IN_USE/u);
  assert.equal(store.list("demo").length, 1);
  assert.equal(store.inventory().agents, 1);
  assert.equal(store.inventory().active, 1);
  assert.equal(store.inventory().activeLimitPerRoom, 12);
  assert.deepEqual(store.integrity(), { schemaVersion: 2, quickCheck: "ok", stateValid: true });
  store.archive(created.id, "demo", 2_000);
  assert.equal(store.list("demo").length, 0);
});

test("managed room agent storage rejects malformed input and row tampering", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "orchestratory-managed-agent-bad-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  const store = new ManagedRoomAgentStore(data);
  assert.throws(() => store.create({
    roomId: "BAD ROOM", workspace: "/tmp/project", provider: "codex", model: "default", label: "x",
  }), /MANAGED_AGENT_ROOM_INVALID/u);
  assert.throws(() => store.create({
    roomId: "demo", workspace: "/tmp/project", provider: "codex", model: "default", label: "<script>",
  }), /MANAGED_AGENT_LABEL_INVALID/u);
  const agent = store.create({
    roomId: "demo", workspace: "/tmp/project", provider: "codex", model: "default", label: "reviewer",
  });
  const path = store.path;
  store.close();
  await chmod(path, 0o600);
  const raw = new DatabaseSync(path);
  raw.prepare("UPDATE managed_room_agents SET display_name = 'claude（偽裝）' WHERE id = ?").run(agent.id);
  raw.close();
  assert.throws(() => new ManagedRoomAgentStore(data), /MANAGED_AGENT_ROW_TAMPERED/u);
});

test("managed room agent validation covers identity, lifecycle, and capacity boundaries", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "orchestratory-managed-agent-boundaries-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  const store = new ManagedRoomAgentStore(data);
  assert.throws(() => managedAgentDisplayName("fake", "x"), /MANAGED_AGENT_PROVIDER_INVALID/u);
  assert.throws(() => managedAgentDisplayName("codex", 42), /MANAGED_AGENT_LABEL_INVALID/u);
  assert.throws(() => store.create({
    roomId: "demo", workspace: "relative", provider: "codex", model: "default", label: "x",
  }), /MANAGED_AGENT_WORKSPACE_INVALID/u);
  assert.throws(() => store.create({
    roomId: "demo", workspace: "/tmp/project", provider: "fake" as "codex", model: "default", label: "x",
  }), /MANAGED_AGENT_PROVIDER_INVALID/u);
  assert.throws(() => store.create({
    roomId: "demo", workspace: "/tmp/project", provider: "codex", model: "model with spaces", label: "x",
  }), /MANAGED_AGENT_MODEL_INVALID/u);
  assert.throws(() => store.create({
    roomId: "demo", workspace: "/tmp/project", provider: "codex", model: "default", label: "x",
  }, -1), /MANAGED_AGENT_TIME_INVALID/u);
  assert.throws(() => store.get("not-an-id"), /MANAGED_AGENT_ID_INVALID/u);
  assert.equal(store.get("00000000-0000-4000-8000-000000000000"), undefined);

  const first = store.create({
    roomId: "demo", workspace: "/tmp/project", provider: "codex", model: "default", label: "agent-1",
  }, 1_000);
  assert.throws(() => store.archive(first.id, "elsewhere", 2_000), /MANAGED_AGENT_NOT_FOUND/u);
  assert.throws(() => store.archive(first.id, "demo", 999), /MANAGED_AGENT_TIME_INVALID/u);
  for (let index = 2; index <= 12; index += 1) {
    store.create({
      roomId: "demo", workspace: "/tmp/project", provider: "codex", model: "default", label: `agent-${index}`,
    }, 1_000 + index);
  }
  assert.throws(() => store.create({
    roomId: "demo", workspace: "/tmp/project", provider: "codex", model: "default", label: "agent-13",
  }), /MANAGED_AGENT_ROOM_LIMIT_REACHED/u);
  store.close();
  store.close();
  assert.throws(() => store.list("demo"), /MANAGED_AGENT_STORE_CLOSED/u);
});

test("managed room agent store rejects a future schema and closes the failed database", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "orchestratory-managed-agent-schema-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  const path = join(data, "managed-room-agents.sqlite");
  const raw = new DatabaseSync(path);
  raw.exec("PRAGMA user_version = 3");
  raw.close();
  assert.throws(() => new ManagedRoomAgentStore(data), /MANAGED_AGENT_SCHEMA_UNSUPPORTED/u);
});

test("managed room agent store repairs only the exact legacy archive hash", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "orchestratory-managed-agent-v1-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  const store = new ManagedRoomAgentStore(data);
  const agent = store.create({
    roomId: "demo", workspace: "/tmp/project", provider: "claude", model: "sonnet", label: "legacy",
  }, 1_000);
  const path = store.path;
  store.close();

  const raw = new DatabaseSync(path);
  const row = raw.prepare("SELECT * FROM managed_room_agents WHERE id = ?").get(agent.id) as Record<string, unknown>;
  const { row_hash: _hash, ...activeFields } = row;
  const archivedFields = { ...activeFields, archived_at_ms: 2_000 };
  const activeHash = createHash("sha256").update(JSON.stringify(activeFields), "utf8").digest("hex");
  const legacyHash = createHash("sha256")
    .update(JSON.stringify({ ...archivedFields, row_hash: activeHash }), "utf8")
    .digest("hex");
  raw.prepare("UPDATE managed_room_agents SET archived_at_ms = 2000, row_hash = ? WHERE id = ?")
    .run(legacyHash, agent.id);
  raw.exec("PRAGMA user_version = 1");
  raw.close();

  const migrated = new ManagedRoomAgentStore(data);
  assert.deepEqual(migrated.list("demo"), []);
  migrated.close();
  const verified = new DatabaseSync(path);
  assert.equal((verified.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 2);
  verified.close();
});
