import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { link, mkdtemp, readFile, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DirtySnapshotBroker,
  DirtySnapshotService,
  MAX_DIRTY_SNAPSHOT_FILE_BYTES,
} from "../src/core/dirty-snapshot-broker.ts";
import { WorktreeBroker } from "../src/core/worktree-broker.ts";

const execFileAsync = promisify(execFile);

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "orchestratory-dirty-source-"));
  await execFileAsync("git", ["init", "-b", "main"], { cwd: root });
  await writeFile(join(root, "README.md"), "original\n", "utf8");
  await writeFile(join(root, "delete-me.txt"), "delete\n", "utf8");
  await writeFile(join(root, ".gitignore"), "ignored.txt\n", "utf8");
  await execFileAsync("git", ["add", "README.md", "delete-me.txt", ".gitignore"], { cwd: root });
  await execFileAsync(
    "git",
    ["-c", "user.name=Synthetic Test", "-c", "user.email=test@example.invalid", "commit", "-m", "initial"],
    { cwd: root },
  );
  return root;
}

test("dirty snapshot recreates tracked, staged, untracked, and deleted text only in a worktree", async (t) => {
  const source = await repository();
  const data = await mkdtemp(join(tmpdir(), "orchestratory-dirty-data-"));
  t.after(async () => await rm(source, { recursive: true, force: true }));
  t.after(async () => await rm(data, { recursive: true, force: true }));
  await writeFile(join(source, "README.md"), "changed\n", "utf8");
  await writeFile(join(source, "staged.txt"), "staged\n", "utf8");
  await execFileAsync("git", ["add", "staged.txt"], { cwd: source });
  await writeFile(join(source, "new.txt"), "new\n", "utf8");
  await rm(join(source, "delete-me.txt"));

  const broker = new DirtySnapshotBroker({ maxFiles: 10 });
  const snapshot = await broker.capture(source);
  assert.deepEqual(
    snapshot.files.map((file) => `${file.operation}:${file.path}`),
    ["write:README.md", "delete:delete-me.txt", "write:new.txt", "write:staged.txt"],
  );
  const runId = "00000000-0000-4000-8000-000000000777";
  const worktree = await new WorktreeBroker(data).create(source, runId);
  await broker.applyToWorktree(snapshot, worktree.workspace);
  assert.equal(await readFile(join(worktree.workspace, "README.md"), "utf8"), "changed\n");
  assert.equal(await readFile(join(worktree.workspace, "staged.txt"), "utf8"), "staged\n");
  assert.equal(await readFile(join(worktree.workspace, "new.txt"), "utf8"), "new\n");
  await assert.rejects(stat(join(worktree.workspace, "delete-me.txt")), /ENOENT/u);
  assert.equal(await readFile(join(source, "README.md"), "utf8"), "changed\n");
});

test("dirty snapshot rejects source races, mutation, dirty targets, and base mismatch", async (t) => {
  const source = await repository();
  const data = await mkdtemp(join(tmpdir(), "orchestratory-dirty-race-"));
  t.after(async () => await rm(source, { recursive: true, force: true }));
  t.after(async () => await rm(data, { recursive: true, force: true }));
  await writeFile(join(source, "README.md"), "first\n", "utf8");
  const broker = new DirtySnapshotBroker({ maxFiles: 10 });
  const snapshot = await broker.capture(source);
  const first = await new WorktreeBroker(data).create(source, "00000000-0000-4000-8000-000000000778");
  await writeFile(join(source, "README.md"), "second\n", "utf8");
  await assert.rejects(broker.applyToWorktree(snapshot, first.workspace), /SOURCE_CHANGED/u);

  const fresh = await broker.capture(source);
  const mutated = structuredClone(fresh);
  mutated.files[0]!.content = "attacker";
  await assert.rejects(broker.applyToWorktree(mutated, first.workspace), /HASH_MISMATCH/u);
  await writeFile(join(first.workspace, "dirty.txt"), "dirty\n", "utf8");
  await assert.rejects(broker.applyToWorktree(fresh, first.workspace), /TARGET_NOT_CLEAN/u);

  const unrelated = await repository();
  t.after(async () => await rm(unrelated, { recursive: true, force: true }));
  await execFileAsync(
    "git",
    ["-c", "user.name=Synthetic Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "other"],
    { cwd: unrelated },
  );
  await assert.rejects(broker.applyToWorktree(fresh, unrelated), /BASE_MISMATCH/u);
});

test("dirty snapshot denies sensitive, binary, oversized, hardlinked, and excessive changes", async (t) => {
  const roots = await Promise.all(Array.from({ length: 5 }, () => repository()));
  t.after(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  });

  await writeFile(join(roots[0]!, ".env"), "SECRET=synthetic\n", "utf8");
  await assert.rejects(new DirtySnapshotBroker({ maxFiles: 10 }).capture(roots[0]!), /PATH_DENIED/u);

  await writeFile(join(roots[1]!, "binary.dat"), Buffer.from([0, 1, 2]));
  await assert.rejects(new DirtySnapshotBroker({ maxFiles: 10 }).capture(roots[1]!), /BINARY_DENIED/u);

  await writeFile(join(roots[2]!, "large.txt"), "x", "utf8");
  await truncate(join(roots[2]!, "large.txt"), MAX_DIRTY_SNAPSHOT_FILE_BYTES + 1);
  await assert.rejects(new DirtySnapshotBroker({ maxFiles: 10 }).capture(roots[2]!), /FILE_TOO_LARGE/u);

  await link(join(roots[3]!, "README.md"), join(roots[3]!, "linked.txt"));
  await assert.rejects(new DirtySnapshotBroker({ maxFiles: 10 }).capture(roots[3]!), /HARDLINK/u);

  await writeFile(join(roots[4]!, "a.txt"), "a", "utf8");
  await writeFile(join(roots[4]!, "b.txt"), "b", "utf8");
  await assert.rejects(new DirtySnapshotBroker({ maxFiles: 1 }).capture(roots[4]!), /FILE_LIMIT_EXCEEDED/u);
});

test("dirty snapshot validates limits and refuses a clean source", async (t) => {
  const source = await repository();
  t.after(async () => await rm(source, { recursive: true, force: true }));
  assert.throws(() => new DirtySnapshotBroker({ maxFiles: 0 }), /FILE_LIMIT_INVALID/u);
  assert.throws(
    () => new DirtySnapshotBroker({ maxFiles: 10, maxTotalBytes: 0 }),
    /BYTE_LIMIT_INVALID/u,
  );
  await assert.rejects(new DirtySnapshotBroker({ maxFiles: 10 }).capture(source), /SOURCE_IS_CLEAN/u);
});

test("dirty snapshot rejects executable mode changes and forged semantic metadata", async (t) => {
  const source = await repository();
  const data = await mkdtemp(join(tmpdir(), "orchestratory-dirty-mode-"));
  t.after(async () => await rm(source, { recursive: true, force: true }));
  t.after(async () => await rm(data, { recursive: true, force: true }));
  await writeFile(join(source, "script.sh"), "echo safe\n", { encoding: "utf8", mode: 0o700 });
  await assert.rejects(
    new DirtySnapshotBroker({ maxFiles: 10 }).capture(source),
    /EXECUTABLE_MODE_DENIED/u,
  );

  await rm(join(source, "script.sh"));
  await writeFile(join(source, "README.md"), "changed\n", "utf8");
  const broker = new DirtySnapshotBroker({ maxFiles: 10 });
  const snapshot = await broker.capture(source);
  const target = await new WorktreeBroker(data).create(
    source,
    "00000000-0000-4000-8000-000000000779",
  );
  const forged = structuredClone(snapshot);
  forged.files.push({ ...forged.files[0]!, path: `./${forged.files[0]!.path}` });
  const { createHash } = await import("node:crypto");
  const { snapshotHash: _ignored, ...unsigned } = forged;
  forged.snapshotHash = createHash("sha256").update(JSON.stringify(unsigned), "utf8").digest("hex");
  await assert.rejects(broker.applyToWorktree(forged, target.workspace), /DUPLICATE_PATH/u);
});

test("dirty snapshot refuses to overwrite an unexpected ignored target file", async (t) => {
  const source = await repository();
  const data = await mkdtemp(join(tmpdir(), "orchestratory-dirty-ignored-target-"));
  t.after(async () => await rm(source, { recursive: true, force: true }));
  t.after(async () => await rm(data, { recursive: true, force: true }));
  await writeFile(join(source, "new.txt"), "owner content\n", "utf8");
  const broker = new DirtySnapshotBroker({ maxFiles: 10 });
  const snapshot = await broker.capture(source);
  const forged = structuredClone(snapshot);
  forged.files[0]!.path = "ignored.txt";
  const { createHash } = await import("node:crypto");
  const { snapshotHash: _ignored, ...unsigned } = forged;
  forged.snapshotHash = createHash("sha256").update(JSON.stringify(unsigned), "utf8").digest("hex");
  const target = await new WorktreeBroker(data).create(
    source,
    "00000000-0000-4000-8000-000000000780",
  );
  await writeFile(join(target.workspace, "ignored.txt"), "must survive\n", "utf8");
  await assert.rejects(broker.applyToWorktree(forged, target.workspace), /TARGET_NEW_PATH_EXISTS/u);
  assert.equal(await readFile(join(target.workspace, "ignored.txt"), "utf8"), "must survive\n");
});

test("dirty snapshot service is RAM-only, bounded, expiring, and single-use", async (t) => {
  const source = await repository();
  t.after(async () => await rm(source, { recursive: true, force: true }));
  await writeFile(join(source, "README.md"), "pending\n", "utf8");
  let now = 10_000;
  const service = new DirtySnapshotService({
    maxFiles: 10,
    ttlMs: 10_000,
    now: () => now,
  });
  const summary = await service.prepare(source);
  assert.equal(summary.files, 1);
  assert.equal(summary.writes, 1);
  assert.equal(summary.deletes, 0);
  assert.equal(service.status().pending, 1);
  assert.equal(service.get(summary.id).snapshotHash, summary.snapshotHash);
  const taken = service.take(summary.id);
  assert.equal(taken.id, summary.id);
  assert.throws(() => service.get(summary.id), /NOT_FOUND_OR_EXPIRED/u);

  const expiring = await service.prepare(source);
  now += 10_001;
  assert.throws(() => service.get(expiring.id), /NOT_FOUND_OR_EXPIRED/u);
  assert.equal(service.status().pending, 0);
  assert.throws(() => service.get("not-a-uuid"), /ID_INVALID/u);
  assert.throws(() => new DirtySnapshotService({ maxFiles: 1, ttlMs: 9_999 }), /TTL_INVALID/u);
  service.clear();
});

test("dirty snapshot service caps concurrent pending handoffs", async (t) => {
  const source = await repository();
  t.after(async () => await rm(source, { recursive: true, force: true }));
  await writeFile(join(source, "README.md"), "pending\n", "utf8");
  const service = new DirtySnapshotService({ maxFiles: 10 });
  const attempts = await Promise.allSettled(Array.from({ length: 9 }, () => service.prepare(source)));
  assert.equal(attempts.filter((result) => result.status === "fulfilled").length, 8);
  assert.equal(attempts.filter((result) => result.status === "rejected").length, 1);
  assert.match(
    String((attempts.find((result) => result.status === "rejected") as PromiseRejectedResult).reason),
    /PENDING_LIMIT_REACHED/u,
  );
  assert.deepEqual(service.status(), { pending: 8, maxPending: 8, ttlMs: 120_000 });
  await assert.rejects(service.prepare(source), /PENDING_LIMIT_REACHED/u);
});
