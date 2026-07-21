import assert from "node:assert/strict";
import { chmod, link, lstat, mkdtemp, readFile, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ensureOwnerOnlyDirectory,
  MAX_RELEASE_ARTIFACT_BYTES,
  writeIdempotentArtifact,
} from "../scripts/release-artifact.mjs";

test("release artifact persistence uses owner-only no-follow descriptors", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orchestratory-release-artifact-"));
  await chmod(root, 0o700);
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });
  const output = join(root, "release");
  await ensureOwnerOnlyDirectory(output);
  const source = join(root, "source.tgz");
  await writeFile(source, "verified artifact", { mode: 0o600 });

  const created = join(output, "created.tgz");
  await writeIdempotentArtifact(source, created);
  assert.equal(await readFile(created, "utf8"), "verified artifact");
  assert.equal((await lstat(created)).mode & 0o777, 0o600);
  await writeIdempotentArtifact(source, created);

  const sentinel = join(root, "sentinel");
  await writeFile(sentinel, "must remain unchanged", { mode: 0o600 });
  const linked = join(output, "linked.tgz");
  await symlink(sentinel, linked);
  await assert.rejects(writeIdempotentArtifact(source, linked));
  assert.equal(await readFile(sentinel, "utf8"), "must remain unchanged");

  const hardlinked = join(output, "hardlinked.tgz");
  await link(sentinel, hardlinked);
  await assert.rejects(writeIdempotentArtifact(source, hardlinked), /UNSAFE_RELEASE_ARTIFACT/u);
  assert.equal(await readFile(sentinel, "utf8"), "must remain unchanged");

  const permissive = join(output, "permissive.tgz");
  await writeFile(permissive, "verified artifact", { mode: 0o644 });
  await assert.rejects(writeIdempotentArtifact(source, permissive), /UNSAFE_RELEASE_ARTIFACT/u);

  const oversized = join(output, "oversized.tgz");
  await writeFile(oversized, "x", { mode: 0o600 });
  await truncate(oversized, MAX_RELEASE_ARTIFACT_BYTES + 1);
  await assert.rejects(writeIdempotentArtifact(source, oversized), /UNSAFE_RELEASE_ARTIFACT/u);
});
