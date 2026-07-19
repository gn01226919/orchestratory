import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorktreeBroker } from "../src/core/worktree-broker.ts";

const execFileAsync = promisify(execFile);

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "orchestratory-worktree-source-"));
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

test("creates a branch-isolated worktree without switching the source branch", async (t) => {
  const source = await repository();
  const data = await mkdtemp(join(tmpdir(), "orchestratory-worktree-data-"));
  t.after(async () => await rm(source, { recursive: true, force: true }));
  t.after(async () => await rm(data, { recursive: true, force: true }));
  const runId = "00000000-0000-4000-8000-000000000001";
  const session = await new WorktreeBroker(data).create(source, runId);
  const sourceBranch = await execFileAsync("git", ["branch", "--show-current"], { cwd: source });
  const worktreeBranch = await execFileAsync("git", ["branch", "--show-current"], { cwd: session.workspace });
  assert.equal(sourceBranch.stdout.trim(), "main");
  assert.equal(worktreeBranch.stdout.trim(), `orchestratory/run-${runId}`);
  assert.match(session.baseSha, /^[0-9a-f]{40,64}$/u);
  assert.deepEqual(await new WorktreeBroker(data).listRunIds(), [runId]);
  assert.equal(await new WorktreeBroker(data).isRetainedWorkspace(runId, session.workspace), true);
  assert.equal(await new WorktreeBroker(data).isRetainedWorkspace(runId, source), false);
  assert.equal(await new WorktreeBroker(data).isRetainedWorkspace("invalid", session.workspace), false);
});

test("lists no retained worktrees before the runtime directory exists", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "orchestratory-worktree-empty-"));
  t.after(async () => await rm(data, { recursive: true, force: true }));
  assert.deepEqual(await new WorktreeBroker(join(data, "missing")).listRunIds(), []);
});

test("rejects repository-local external Git filters", async (t) => {
  const source = await repository();
  const data = await mkdtemp(join(tmpdir(), "orchestratory-worktree-data-"));
  t.after(async () => await rm(source, { recursive: true, force: true }));
  t.after(async () => await rm(data, { recursive: true, force: true }));
  await execFileAsync("git", ["config", "filter.evil.clean", "malicious-command"], { cwd: source });
  await assert.rejects(
    new WorktreeBroker(data).create(source, "00000000-0000-4000-8000-000000000002"),
    /UNSAFE_LOCAL_GIT_FILTER_OR_FSMONITOR_CONFIG/u,
  );
});

test("cleanup removes only a clean snapshot-matched worktree and retains its branch", async (t) => {
  const source = await repository();
  const data = await mkdtemp(join(tmpdir(), "orchestratory-worktree-cleanup-"));
  t.after(async () => await rm(source, { recursive: true, force: true }));
  t.after(async () => await rm(data, { recursive: true, force: true }));
  const runId = "00000000-0000-4000-8000-000000000123";
  const broker = new WorktreeBroker(data);
  const session = await broker.create(source, runId);
  const preview = await broker.previewCleanup(runId);
  assert.equal(preview.workspace, session.workspace);
  assert.equal(preview.branch, `orchestratory/run-${runId}`);
  await broker.cleanup(preview);
  assert.deepEqual(await broker.listRunIds(), []);
  const branches = await execFileAsync("git", ["branch", "--list", preview.branch], { cwd: source });
  assert.match(branches.stdout, /orchestratory\/run-/u);
});

test("cleanup fails closed for a dirty retained worktree", async (t) => {
  const source = await repository();
  const data = await mkdtemp(join(tmpdir(), "orchestratory-worktree-dirty-"));
  t.after(async () => await rm(source, { recursive: true, force: true }));
  t.after(async () => await rm(data, { recursive: true, force: true }));
  const runId = "00000000-0000-4000-8000-000000000124";
  const broker = new WorktreeBroker(data);
  const session = await broker.create(source, runId);
  await writeFile(join(session.workspace, "dirty.txt"), "synthetic\n", "utf8");
  await assert.rejects(broker.previewCleanup(runId), /WORKTREE_MUST_BE_CLEAN_FOR_CLEANUP/u);
});

test("cleanup rejects invalid IDs and a clean worktree changed after preview", async (t) => {
  const source = await repository();
  const data = await mkdtemp(join(tmpdir(), "orchestratory-worktree-race-"));
  t.after(async () => await rm(source, { recursive: true, force: true }));
  t.after(async () => await rm(data, { recursive: true, force: true }));
  const runId = "00000000-0000-4000-8000-000000000125";
  const broker = new WorktreeBroker(data);
  await assert.rejects(broker.previewCleanup("invalid"), /INVALID_WORKTREE_RUN_ID/u);
  const session = await broker.create(source, runId);
  const preview = await broker.previewCleanup(runId);
  await execFileAsync(
    "git",
    [
      "-c",
      "user.name=Synthetic Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "synthetic change",
    ],
    { cwd: session.workspace },
  );
  await assert.rejects(broker.cleanup(preview), /WORKTREE_CLEANUP_SNAPSHOT_CHANGED/u);
});
