import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalStore } from "../src/core/store.ts";
import { DatabaseSync } from "node:sqlite";

test("stores only redacted event summaries in an owner-only database", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "orchestratory-store-"));
  t.after(async () => await rm(fixture, { recursive: true, force: true }));
  const store = new LocalStore(fixture);
  t.after(() => store.close());
  const now = new Date().toISOString();
  store.saveRun({
    id: "run-test",
    createdAt: now,
    updatedAt: now,
    status: "running",
    workspaceLabel: "synthetic-workspace",
    profile: "normal",
    counters: {
      rounds: 0,
      providerCalls: 0,
      subprocesses: 0,
      consecutiveErrors: 0,
      outputBytes: 0,
      apiBudgetUsd: 0,
    },
  });
  store.appendEvent({
    runId: "run-test",
    at: now,
    type: "test",
    actor: "test",
    status: "info",
    summary: "api_key=synthetic-secret-value",
  });
  const [event] = store.listEvents("run-test");
  assert.ok(event);
  assert.doesNotMatch(event.summary, /synthetic-secret-value/u);
  const info = await stat(store.path);
  assert.equal(info.mode & 0o077, 0);
});

test("atomically enforces per-run, daily and monthly API reservations", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "orchestratory-budget-"));
  t.after(async () => await rm(fixture, { recursive: true, force: true }));
  const store = new LocalStore(fixture);
  t.after(() => store.close());
  const now = new Date("2026-07-15T12:00:00.000Z");
  store.saveRun({
    id: "budget-run",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    status: "running",
    workspaceLabel: "synthetic",
    profile: "normal",
    counters: {
      rounds: 0,
      providerCalls: 0,
      subprocesses: 0,
      consecutiveErrors: 0,
      outputBytes: 0,
      apiBudgetUsd: 0,
    },
  });
  const first = store.reserveApiBudget({
    runId: "budget-run",
    provider: "codex",
    model: "synthetic-model",
    amountUsd: 1.25,
    maxPerRunUsd: 2,
    maxPerDayUsd: 3,
    maxPerMonthUsd: 4,
    now,
  });
  assert.equal(first.runUsd, 1.25);
  assert.throws(
    () =>
      store.reserveApiBudget({
        runId: "budget-run",
        provider: "codex",
        model: "synthetic-model",
        amountUsd: 1,
        maxPerRunUsd: 2,
        maxPerDayUsd: 3,
        maxPerMonthUsd: 4,
        now,
      }),
    /API_RUN_BUDGET_REACHED/u,
  );
});

test("restart recovery fails interrupted runs closed without replaying agents", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "orchestratory-recovery-"));
  t.after(async () => await rm(fixture, { recursive: true, force: true }));
  const store = new LocalStore(fixture);
  t.after(() => store.close());
  const at = new Date("2026-07-15T12:00:00.000Z");
  store.saveRun({
    id: "interrupted-run",
    createdAt: at.toISOString(),
    updatedAt: at.toISOString(),
    status: "running",
    workspaceLabel: "synthetic",
    profile: "normal",
    counters: {
      rounds: 1,
      providerCalls: 1,
      subprocesses: 1,
      consecutiveErrors: 0,
      outputBytes: 1,
      apiBudgetUsd: 0,
    },
  });
  store.saveCheckpoint({
    id: "00000000-0000-4000-8000-000000000002",
    runId: "interrupted-run",
    createdAt: at.toISOString(),
    round: 1,
    phase: "writer-complete",
    workspaceFingerprint: "a".repeat(64),
    counters: {
      rounds: 1,
      providerCalls: 1,
      subprocesses: 1,
      consecutiveErrors: 0,
      outputBytes: 1,
      apiBudgetUsd: 0,
    },
  });
  assert.equal(store.recoverInterruptedRuns(new Date("2026-07-15T12:01:00.000Z")), 1);
  assert.equal(store.recoverInterruptedRuns(new Date("2026-07-15T12:02:00.000Z")), 0);
  const events = store.listEvents("interrupted-run");
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "workflow.interrupted");
  assert.equal(store.getRun("interrupted-run")?.errorCode, "INTERRUPTED_RESTART");
  assert.equal(store.latestCheckpoint("interrupted-run")?.round, 1);
  assert.equal(store.listRecoverableCheckpoints()[0]?.runId, "interrupted-run");
  assert.deepEqual(store.inventory(), {
    database: store.path,
    runs: 1,
    events: 1,
    checkpoints: 1,
    apiBudgetReservations: 0,
  });
});

test("purge is preview-bound, preserves active and protected runs, and deletes cascades", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "orchestratory-purge-"));
  t.after(async () => await rm(fixture, { recursive: true, force: true }));
  const store = new LocalStore(fixture);
  t.after(() => store.close());
  const old = "2026-01-01T00:00:00.000Z";
  const recent = "2026-07-15T00:00:00.000Z";
  const counters = {
    rounds: 0,
    providerCalls: 0,
    subprocesses: 0,
    consecutiveErrors: 0,
    outputBytes: 0,
    apiBudgetUsd: 0,
  };
  for (const [id, status, updatedAt] of [
    ["old-terminal", "completed", old],
    ["protected-terminal", "failed", old],
    ["active-run", "running", old],
    ["recent-terminal", "cancelled", recent],
  ] as const) {
    store.saveRun({
      id,
      createdAt: updatedAt,
      updatedAt,
      status,
      workspaceLabel: "synthetic",
      profile: "normal",
      counters,
    });
  }
  store.appendEvent({
    runId: "old-terminal",
    at: old,
    type: "synthetic",
    actor: "test",
    status: "info",
    summary: "synthetic",
  });
  store.saveCheckpoint({
    id: "00000000-0000-4000-8000-000000000099",
    runId: "old-terminal",
    createdAt: old,
    round: 1,
    phase: "writer-complete",
    workspaceFingerprint: "a".repeat(64),
    counters,
  });
  store.reserveApiBudget({
    runId: "old-terminal",
    provider: "fake",
    model: "fake",
    amountUsd: 0.01,
    maxPerRunUsd: 1,
    maxPerDayUsd: 1,
    maxPerMonthUsd: 1,
    now: new Date(old),
  });
  const policy = {
    terminalRunDays: 30,
    maxTerminalRuns: 500,
    debugCaptureEnabled: false,
    debugRetentionHours: 24,
  };
  const preview = store.previewPurge(
    policy,
    ["protected-terminal"],
    new Date("2026-07-16T00:00:00.000Z"),
  );
  assert.deepEqual(preview.candidates.map((item) => item.runId), ["old-terminal"]);
  assert.deepEqual(preview.counts, {
    runs: 1,
    events: 1,
    checkpoints: 1,
    apiBudgetReservations: 1,
  });
  assert.deepEqual(store.purge(preview), preview.counts);
  assert.equal(store.getRun("old-terminal"), undefined);
  assert.ok(store.getRun("protected-terminal"));
  assert.ok(store.getRun("active-run"));
  assert.ok(store.getRun("recent-terminal"));
});

test("purge rolls back if a previewed run changes", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "orchestratory-purge-race-"));
  t.after(async () => await rm(fixture, { recursive: true, force: true }));
  const store = new LocalStore(fixture);
  t.after(() => store.close());
  const counters = {
    rounds: 0,
    providerCalls: 0,
    subprocesses: 0,
    consecutiveErrors: 0,
    outputBytes: 0,
    apiBudgetUsd: 0,
  };
  store.saveRun({
    id: "changed-run",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    status: "completed",
    workspaceLabel: "synthetic",
    profile: "normal",
    counters,
  });
  const preview = store.previewPurge(
    { terminalRunDays: 1, maxTerminalRuns: 1, debugCaptureEnabled: false, debugRetentionHours: 24 },
    [],
    new Date("2026-07-16T00:00:00.000Z"),
  );
  store.saveRun({
    id: "changed-run",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-07-16T00:00:00.000Z",
    status: "completed",
    workspaceLabel: "synthetic",
    profile: "normal",
    counters,
  });
  assert.throws(() => store.purge(preview), /PURGE_SNAPSHOT_CHANGED/u);
  assert.ok(store.getRun("changed-run"));
});

test("database integrity reports schema, foreign keys and audit-chain state", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "orchestratory-integrity-"));
  t.after(async () => await rm(fixture, { recursive: true, force: true }));
  const store = new LocalStore(fixture);
  const now = new Date().toISOString();
  store.saveRun({
    id: "integrity-run",
    createdAt: now,
    updatedAt: now,
    status: "completed",
    workspaceLabel: "synthetic",
    profile: "normal",
    counters: {
      rounds: 0,
      providerCalls: 0,
      subprocesses: 0,
      consecutiveErrors: 0,
      outputBytes: 0,
      apiBudgetUsd: 0,
    },
  });
  store.appendEvent({
    runId: "integrity-run",
    at: now,
    type: "first",
    actor: "test",
    status: "info",
    summary: "first",
  });
  store.appendEvent({
    runId: "integrity-run",
    at: now,
    type: "second",
    actor: "test",
    status: "success",
    summary: "second",
  });
  assert.deepEqual(store.integrity(), {
    schemaVersion: 2,
    quickCheck: "ok",
    foreignKeyViolations: 0,
    auditEvents: 2,
    auditChainValid: true,
  });
  store.close();

  const raw = new DatabaseSync(join(fixture, "orchestratory.sqlite"));
  raw.prepare("UPDATE events SET summary = 'tampered' WHERE type = 'first'").run();
  raw.close();
  assert.throws(() => new LocalStore(fixture), /AUDIT_EVENT_CHAIN_INVALID/u);
});

test("migration backfills legacy audit hashes transactionally and rejects newer schemas", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "orchestratory-migration-"));
  t.after(async () => await rm(fixture, { recursive: true, force: true }));
  const path = join(fixture, "orchestratory.sqlite");
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE runs (
      id TEXT PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      status TEXT NOT NULL, workspace_label TEXT NOT NULL, profile TEXT NOT NULL,
      counters_json TEXT NOT NULL, error_code TEXT
    ) STRICT;
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, at TEXT NOT NULL,
      type TEXT NOT NULL, actor TEXT NOT NULL, status TEXT NOT NULL, summary TEXT NOT NULL,
      metadata_json TEXT, FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE CASCADE
    ) STRICT;
    INSERT INTO runs VALUES (
      'legacy-run', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
      'completed', 'synthetic', 'normal',
      '{"rounds":0,"providerCalls":0,"subprocesses":0,"consecutiveErrors":0,"outputBytes":0,"apiBudgetUsd":0}',
      NULL
    );
    INSERT INTO events (run_id, at, type, actor, status, summary, metadata_json)
    VALUES ('legacy-run', '2026-01-01T00:00:00.000Z', 'legacy', 'test', 'info', 'legacy', NULL);
    PRAGMA user_version=1;
  `);
  legacy.close();
  await chmod(path, 0o600);
  const migrated = new LocalStore(fixture);
  assert.equal(migrated.integrity().auditChainValid, true);
  assert.equal(migrated.integrity().schemaVersion, 2);
  migrated.close();

  const newer = new DatabaseSync(path);
  newer.exec("PRAGMA user_version=99");
  newer.close();
  assert.throws(() => new LocalStore(fixture), /DATABASE_SCHEMA_TOO_NEW/u);
});
