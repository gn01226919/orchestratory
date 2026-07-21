import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalWorkspace,
  inspectWorkspaceSymlinks,
  resolveExistingInside,
} from "../src/security/workspace.ts";

test("canonical workspace resolves safe paths and denies absolute child paths", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "orchestratory-workspace-"));
  t.after(async () => await rm(fixture, { recursive: true, force: true }));
  await mkdir(join(fixture, "src"));
  await writeFile(join(fixture, "src", "safe.txt"), "safe", "utf8");
  const root = await canonicalWorkspace(fixture);
  assert.equal(await resolveExistingInside(root, "src/safe.txt"), join(root, "src", "safe.txt"));
  assert.equal(await resolveExistingInside(root, "src"), join(root, "src"));
  await assert.rejects(resolveExistingInside(root, "/etc/passwd"), /ABSOLUTE_PATH_DENIED/u);
  await assert.rejects(resolveExistingInside(root, "bad\0path"), /PATH_CONTAINS_NULL/u);
  await assert.rejects(canonicalWorkspace("bad\0path"), /WORKSPACE_CONTAINS_NULL/u);
  await assert.rejects(canonicalWorkspace(join(fixture, "src", "safe.txt")), /WORKSPACE_NOT_DIRECTORY/u);
});

test("detects symlinks that leave the workspace", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "orchestratory-symlink-"));
  t.after(async () => await rm(fixture, { recursive: true, force: true }));
  await symlink(tmpdir(), join(fixture, "outside"));
  const inspection = await inspectWorkspaceSymlinks(fixture);
  assert.deepEqual(inspection.externalSymlinks, ["outside"]);
  await assert.rejects(inspectWorkspaceSymlinks(fixture, 0), /WORKSPACE_SCAN_LIMIT_REACHED/u);
});

test("allows internal symlinks while rejecting broken links", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "orchestratory-symlink-"));
  t.after(async () => await rm(fixture, { recursive: true, force: true }));
  await mkdir(join(fixture, "inside"));
  await symlink(join(fixture, "inside"), join(fixture, "internal"));
  await symlink(join(fixture, "missing"), join(fixture, "broken"));
  const inspection = await inspectWorkspaceSymlinks(fixture);
  assert.deepEqual(inspection.externalSymlinks, ["broken"]);
});
