import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { link, mkdtemp, open, rm, truncate, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitBroker, MAX_CHANGED_BYTES } from "../src/core/git-broker.ts";

const execFileAsync = promisify(execFile);

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "orchestratory-git-broker-"));
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

test("Git inspection fingerprints and exposes bounded untracked text", async (t) => {
  const root = await repository();
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const broker = new GitBroker();
  await writeFile(join(root, "new.ts"), "alpha", "utf8");
  const first = await broker.inspect(root);
  assert.equal(first.changedFiles, 1);
  assert.equal(first.untrackedFiles, 1);
  assert.equal(first.changedBytes, 5);
  assert.match(await broker.reviewContext(root), /Untracked text file: new\.ts\s+alpha/u);
  await writeFile(join(root, "new.ts"), "bravo", "utf8");
  const second = await broker.inspect(root);
  assert.notEqual(second.fingerprint, first.fingerprint);
});

test("tracked same-size content changes alter the review fingerprint", async (t) => {
  const root = await repository();
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const broker = new GitBroker();
  await writeFile(join(root, "README.md"), "aaaaaaaaaa\n", "utf8");
  const first = await broker.inspect(root);
  await writeFile(join(root, "README.md"), "bbbbbbbbbb\n", "utf8");
  const second = await broker.inspect(root);
  assert.notEqual(second.fingerprint, first.fingerprint);
});

test("Git inspection includes a tracked deletion without trying to read the missing file", async (t) => {
  const root = await repository();
  t.after(async () => await rm(root, { recursive: true, force: true }));
  await unlink(join(root, "README.md"));
  const inspection = await new GitBroker().inspect(root);
  assert.equal(inspection.clean, false);
  assert.equal(inspection.changedFiles, 1);
  assert.equal(inspection.changedBytes, 0);
  assert.match(inspection.statusSummary, /README\.md/u);
});

test("Git inspection parses a NUL-delimited tracked rename as one current path", async (t) => {
  const root = await repository();
  t.after(async () => await rm(root, { recursive: true, force: true }));
  await execFileAsync("git", ["mv", "README.md", "RENAMED.md"], { cwd: root });
  const inspection = await new GitBroker().inspect(root);
  assert.equal(inspection.changedFiles, 1);
  assert.equal(inspection.untrackedFiles, 0);
  assert.equal(inspection.changedBytes, Buffer.byteLength("synthetic\n"));
  assert.match(inspection.statusSummary, /RENAMED\.md/u);
});

test("untracked review rejects sensitive paths and oversized files", async (t) => {
  const sensitive = await repository();
  const oversized = await repository();
  const hardlinked = await repository();
  t.after(async () => await rm(sensitive, { recursive: true, force: true }));
  t.after(async () => await rm(oversized, { recursive: true, force: true }));
  t.after(async () => await rm(hardlinked, { recursive: true, force: true }));
  const broker = new GitBroker();
  await writeFile(join(sensitive, ".env.local"), "SYNTHETIC=value\n", "utf8");
  await assert.rejects(broker.reviewContext(sensitive), /SENSITIVE_UNTRACKED_PATH_DENIED/u);
  await writeFile(join(oversized, "large.bin"), "x", "utf8");
  await truncate(join(oversized, "large.bin"), 65_537);
  await assert.rejects(broker.reviewContext(oversized), /UNTRACKED_REVIEW_FILE_TOO_LARGE/u);
  await link(join(hardlinked, "README.md"), join(hardlinked, "linked.txt"));
  await assert.rejects(broker.inspect(hardlinked), /HARDLINK_CHANGED_FILE_DENIED/u);
});

test("Git inspection fully fingerprints content beyond the changed-byte safety ceiling", async (t) => {
  const root = await repository();
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const path = join(root, "oversized.bin");
  await writeFile(path, "x", "utf8");
  await truncate(path, MAX_CHANGED_BYTES + 1);
  const broker = new GitBroker();
  const first = await broker.inspect(root);
  assert.equal(first.changedBytes, MAX_CHANGED_BYTES + 1);
  const handle = await open(path, "r+");
  try {
    await handle.write(Buffer.from("y"), 0, 1, MAX_CHANGED_BYTES);
  } finally {
    await handle.close();
  }
  const second = await broker.inspect(root);
  assert.equal(second.changedBytes, first.changedBytes);
  assert.notEqual(second.fingerprint, first.fingerprint);
});
