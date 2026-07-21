import test from "node:test";
import assert from "node:assert/strict";
import { chmod, link, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CollaborationAuditLog } from "../src/core/collaboration-audit.ts";

test("technical audit preserves dual identity in one HMAC chain across processes", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "orchestratory-audit-"));
  const first = new CollaborationAuditLog(data, { now: () => 10 });
  const second = new CollaborationAuditLog(data, { now: () => 11 });
  t.after(() => first.close());
  t.after(() => second.close());
  t.after(async () => await rm(data, { recursive: true, force: true }));
  const granted = first.append({
    roomId: "demo", taskId: "task-1", type: "writer.granted", actor: "you",
    onBehalfOf: "codex（aaa）", executedBy: "writer-companion-17", leaseEpoch: 4,
    action: "grant", outcome: "succeeded", detail: { provider: "codex" },
  });
  const write = second.append({
    roomId: "demo", taskId: "task-1", type: "workspace.write", actor: "codex（aaa）",
    onBehalfOf: "codex（aaa）", executedBy: "writer-companion-17", leaseEpoch: 4,
    action: "write_file", path: "src/app.ts", outcome: "succeeded",
  });
  assert.equal(granted.seq, 1);
  assert.equal(write.seq, 2);
  assert.equal(write.previousMac, granted.mac);
  assert.equal(first.verify(), true);
  assert.deepEqual(first.list({ roomId: "demo" }).map((event) => event.executedBy), [
    "writer-companion-17", "writer-companion-17",
  ]);
  assert.equal((await stat(first.path)).mode & 0o777, 0o600);
  assert.equal((await stat(first.keyPath)).mode & 0o777, 0o600);
});

test("technical audit detects a database editor who cannot access the HMAC key", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "orchestratory-audit-tamper-"));
  const audit = new CollaborationAuditLog(data);
  audit.append({ type: "writer.granted", actor: "you", outcome: "succeeded" });
  const path = audit.path;
  audit.close();
  t.after(async () => await rm(data, { recursive: true, force: true }));
  const db = new DatabaseSync(path);
  db.prepare("UPDATE collaboration_audit SET executed_by='forged', mac=? WHERE seq=1")
    .run("0".repeat(64));
  db.close();
  assert.throws(() => new CollaborationAuditLog(data), /COLLABORATION_AUDIT_CHAIN_INVALID/u);
});

test("technical audit validates bounded fields, ranges, outcomes and lifecycle", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "orchestratory-audit-validation-"));
  const audit = new CollaborationAuditLog(data);
  t.after(() => audit.close());
  t.after(async () => await rm(data, { recursive: true, force: true }));
  const base = { type: "workspace.read", actor: "codex", outcome: "allowed" as const };
  assert.throws(() => audit.append({ ...base, type: "" }), /AUDIT_TYPE_INVALID/u);
  assert.throws(() => audit.append({ ...base, actor: "bad\nactor" }), /AUDIT_ACTOR_INVALID/u);
  assert.throws(() => audit.append({ ...base, roomId: "bad\nroom" }), /AUDIT_ROOM_INVALID/u);
  assert.throws(() => audit.append({ ...base, taskId: "bad\ntask" }), /AUDIT_TASK_INVALID/u);
  assert.throws(() => audit.append({ ...base, onBehalfOf: "bad\nidentity" }), /AUDIT_ON_BEHALF_INVALID/u);
  assert.throws(() => audit.append({ ...base, executedBy: "bad\nexecutor" }), /AUDIT_EXECUTOR_INVALID/u);
  assert.throws(() => audit.append({ ...base, action: "bad\naction" }), /AUDIT_ACTION_INVALID/u);
  assert.throws(() => audit.append({ ...base, path: "bad\npath" }), /AUDIT_PATH_INVALID/u);
  assert.throws(() => audit.append({ ...base, outcome: "unknown" as never }), /AUDIT_OUTCOME_INVALID/u);
  assert.throws(() => audit.append({ ...base, leaseEpoch: 0 }), /AUDIT_EPOCH_INVALID/u);
  assert.throws(() => audit.append({ ...base, detail: { oversized: "x".repeat(16_384) } }), /AUDIT_DETAIL_TOO_LARGE/u);
  audit.append({ ...base, roomId: "demo", taskId: "task", leaseEpoch: 1, detail: { ok: true } });
  audit.append({ ...base, roomId: "other" });
  assert.equal(audit.list({ after: 1, limit: 1 })[0]?.roomId, "other");
  assert.equal(audit.list({ roomId: "demo", limit: 10 }).length, 1);
  assert.throws(() => audit.list({ after: -1 }), /AUDIT_RANGE_INVALID/u);
  assert.throws(() => audit.list({ limit: 0 }), /AUDIT_RANGE_INVALID/u);
  audit.close();
  audit.close();
  assert.throws(() => audit.verify(), /COLLABORATION_AUDIT_CLOSED/u);
});

test("technical audit key rejects symlinks, hardlinks, non-files and permissive modes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orchestratory-audit-key-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));

  const symlinkData = join(root, "symlink");
  await mkdir(symlinkData, { mode: 0o700 });
  const symlinkTarget = join(root, "symlink-target");
  await writeFile(symlinkTarget, Buffer.alloc(32, 1), { mode: 0o600 });
  await symlink(symlinkTarget, join(symlinkData, "collaboration-audit.key"));
  assert.throws(() => new CollaborationAuditLog(symlinkData), /COLLABORATION_AUDIT_KEY_UNSAFE/u);

  const hardlinkData = join(root, "hardlink");
  await mkdir(hardlinkData, { mode: 0o700 });
  const hardlinkTarget = join(root, "hardlink-target");
  await writeFile(hardlinkTarget, Buffer.alloc(32, 2), { mode: 0o600 });
  await link(hardlinkTarget, join(hardlinkData, "collaboration-audit.key"));
  assert.throws(() => new CollaborationAuditLog(hardlinkData), /COLLABORATION_AUDIT_KEY_UNSAFE/u);

  const directoryData = join(root, "directory");
  await mkdir(directoryData, { mode: 0o700 });
  await mkdir(join(directoryData, "collaboration-audit.key"), { mode: 0o700 });
  assert.throws(() => new CollaborationAuditLog(directoryData), /COLLABORATION_AUDIT_KEY_UNSAFE/u);

  const modeData = join(root, "mode");
  await mkdir(modeData, { mode: 0o700 });
  const modeKey = join(modeData, "collaboration-audit.key");
  await writeFile(modeKey, Buffer.alloc(32, 3), { mode: 0o600 });
  await chmod(modeKey, 0o644);
  assert.throws(() => new CollaborationAuditLog(modeData), /COLLABORATION_AUDIT_KEY_UNSAFE/u);
});

test("technical audit reports inventory and rejects a future schema", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "orchestratory-audit-schema-"));
  t.after(async () => await rm(data, { recursive: true, force: true }));
  const audit = new CollaborationAuditLog(data);
  audit.append({ type: "writer.granted", actor: "you", outcome: "succeeded" });
  assert.equal(audit.inventory().events, 1);
  assert.deepEqual(audit.integrity(), { schemaVersion: 1, quickCheck: "ok", chainValid: true });
  const path = audit.path;
  audit.close();
  const database = new DatabaseSync(path);
  database.exec("PRAGMA user_version = 999");
  database.close();
  assert.throws(() => new CollaborationAuditLog(data), /COLLABORATION_AUDIT_SCHEMA_UNSUPPORTED/u);
});
