import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MaintenanceService } from "../src/core/maintenance.ts";
import { LocalStore } from "../src/core/store.ts";
import { WorktreeBroker } from "../src/core/worktree-broker.ts";
import {
  ApprovalService,
  dataPurgeApprovalScope,
  worktreeCleanupApprovalScope,
} from "../src/security/approval.ts";

const execFileAsync = promisify(execFile);
const retention = {
  terminalRunDays: 1,
  maxTerminalRuns: 1,
  debugCaptureEnabled: false,
  debugRetentionHours: 24,
};

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "orchestratory-maintenance-repo-"));
  await execFileAsync("git", ["init", "-b", "main"], { cwd: root });
  await writeFile(join(root, "README.md"), "synthetic\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd: root });
  await execFileAsync(
    "git",
    ["-c", "user.name=Synthetic Test", "-c", "user.email=test@example.invalid", "commit", "-m", "initial"],
    { cwd: root },
  );
  return root;
}

test("maintenance service requires exact approval for purge", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "orchestratory-maintenance-data-"));
  t.after(async () => await rm(data, { recursive: true, force: true }));
  const store = new LocalStore(data);
  t.after(() => store.close());
  const approvals = new ApprovalService();
  const maintenance = new MaintenanceService({ store, approvals, activeRuns: () => [] });
  const at = "2026-01-01T00:00:00.000Z";
  store.saveRun({
    id: "old-run",
    createdAt: at,
    updatedAt: at,
    status: "completed",
    workspaceLabel: "synthetic",
    profile: "normal",
    counters: { rounds: 0, providerCalls: 0, subprocesses: 0, consecutiveErrors: 0, outputBytes: 0, apiBudgetUsd: 0 },
  });
  const preview = await maintenance.previewPurge(retention, new Date("2026-07-16T00:00:00.000Z"));
  assert.throws(() => maintenance.purge(preview, undefined), /APPROVAL_TOKEN_INVALID/u);
  const issued = approvals.issue("purge-data", dataPurgeApprovalScope(preview), "local-tui");
  assert.equal(maintenance.purge(preview, issued.token).runs, 1);
});

test("maintenance service denies purge while any workflow is active", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "orchestratory-maintenance-active-"));
  t.after(async () => await rm(data, { recursive: true, force: true }));
  const store = new LocalStore(data);
  t.after(() => store.close());
  const approvals = new ApprovalService();
  const maintenance = new MaintenanceService({
    store,
    approvals,
    activeRuns: () => [
      {
        id: "00000000-0000-4000-8000-000000000202",
        createdAt: "2026-07-16T00:00:00.000Z",
        updatedAt: "2026-07-16T00:00:00.000Z",
        status: "running",
        workspaceLabel: "synthetic",
        profile: "normal",
        counters: { rounds: 0, providerCalls: 0, subprocesses: 0, consecutiveErrors: 0, outputBytes: 0, apiBudgetUsd: 0 },
      },
    ],
  });
  const preview = await maintenance.previewPurge(retention);
  assert.throws(() => maintenance.purge(preview, "unused"), /PURGE_DENIED_WHILE_WORKFLOW_ACTIVE/u);
});

test("maintenance service requires exact approval for worktree cleanup", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "orchestratory-maintenance-worktree-"));
  const source = await repository();
  t.after(async () => await rm(data, { recursive: true, force: true }));
  t.after(async () => await rm(source, { recursive: true, force: true }));
  const store = new LocalStore(data);
  t.after(() => store.close());
  const approvals = new ApprovalService();
  const runId = "00000000-0000-4000-8000-000000000201";
  await new WorktreeBroker(data).create(source, runId);
  const maintenance = new MaintenanceService({ store, approvals, activeRuns: () => [] });
  const preview = await maintenance.previewWorktreeCleanup(runId);
  await assert.rejects(maintenance.cleanupWorktree(preview, undefined), /APPROVAL_TOKEN_INVALID/u);
  const issued = approvals.issue(
    "cleanup-worktree",
    worktreeCleanupApprovalScope(preview),
    "local-tui",
  );
  await maintenance.cleanupWorktree(preview, issued.token);
  assert.deepEqual(await new WorktreeBroker(data).listRunIds(), []);
});

test("maintenance service denies cleanup of an active run worktree", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "orchestratory-maintenance-active-worktree-"));
  const source = await repository();
  t.after(async () => await rm(data, { recursive: true, force: true }));
  t.after(async () => await rm(source, { recursive: true, force: true }));
  const store = new LocalStore(data);
  t.after(() => store.close());
  const approvals = new ApprovalService();
  const runId = "00000000-0000-4000-8000-000000000203";
  await new WorktreeBroker(data).create(source, runId);
  const maintenance = new MaintenanceService({
    store,
    approvals,
    activeRuns: () => [
      {
        id: runId,
        createdAt: "2026-07-16T00:00:00.000Z",
        updatedAt: "2026-07-16T00:00:00.000Z",
        status: "running",
        workspaceLabel: "synthetic",
        profile: "normal",
        counters: { rounds: 0, providerCalls: 0, subprocesses: 0, consecutiveErrors: 0, outputBytes: 0, apiBudgetUsd: 0 },
      },
    ],
  });
  const preview = await maintenance.previewWorktreeCleanup(runId);
  await assert.rejects(
    maintenance.cleanupWorktree(preview, "unused"),
    /ACTIVE_WORKTREE_CLEANUP_DENIED/u,
  );
});
