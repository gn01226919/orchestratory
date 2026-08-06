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

/*
 * FINDING F6 (fifth round). The itemised configuration disclosure carries KEYS only, and the comment
 * beside it explained that values are withheld because `credential.helper` can carry a secret. But a
 * git key is `section.subsection.name`, and git's own documented spelling for a per-URL helper puts a
 * URL in the subsection — so a token in that URL's userinfo was rendered verbatim on the approval
 * screen and written into the stored preview. Measured in a real browser: SECRET_IN_PROGRAM_KEY_RENDERED.
 *
 * The assertion below is not "the key is shortened"; it is that the secret appears NOWHERE in the
 * value this function returns, which is what makes it a leak test rather than a formatting test.
 */
test("a secret carried in a configuration KEY is never disclosed, and keys that name nothing secret are", async (t) => {
  const root = await repository();
  t.after(async () => await rm(root, { recursive: true, force: true }));
  // Assembled at runtime so the repository never stores anything shaped like a credential.
  const secret = ["ghp", "0123456789abcdef0123456789abcdef0123"].join("_");
  const url = `https://x-access-token:${secret}@github.com`;
  await execFileAsync("git", ["config", "--local", `credential.${url}.helper`, "store"], { cwd: root });
  await execFileAsync("git", ["config", "--local", "credential.helper", "cache"], { cwd: root });
  // A subsection that is a NAME the owner chose stays legible: hiding it would remove the disclosure
  // this list exists to provide, and there is nothing secret in it.
  await execFileAsync("git", ["config", "--local", "difftool.mine.cmd", "true"], { cwd: root });
  await execFileAsync("git", ["config", "--local", "gpg.ssh.defaultKeyCommand", "true"], { cwd: root });

  const restore = await new GitBroker().restorePoint(root);
  const serialised = JSON.stringify(restore.hooks);
  assert.ok(!serialised.includes(secret), `the configuration key leaked a secret: ${serialised}`);
  assert.ok(!serialised.includes("x-access-token"), serialised);
  assert.ok(restore.hooks.programs.includes("credential.<redacted>.helper"), serialised);
  // The bare key has no subsection at all, so there is nothing to redact and it is reported as-is.
  assert.ok(restore.hooks.programs.includes("credential.helper"), serialised);
  assert.ok(restore.hooks.programs.includes("difftool.mine.cmd"), serialised);
  assert.ok(restore.hooks.programs.includes("gpg.ssh.defaultkeycommand"), serialised);
  // Completeness of the gate is unaffected: the digest is taken over git's raw listing, so the
  // redacted key is still bound and setting it after an approval is still a binding change.
  const before = restore.hooks.configDigest;
  await execFileAsync("git", ["config", "--local", `credential.${url}.helper`, "cache"], { cwd: root });
  assert.notEqual((await new GitBroker().restorePoint(root)).hooks.configDigest, before);
});
