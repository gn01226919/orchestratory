import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspacePolicy } from "../src/security/workspace-policy.ts";

test("workspace policy allows only an explicit root and its descendants", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "orchestratory-policy-"));
  const root = join(fixture, "project");
  const child = join(root, "nested");
  const sibling = join(fixture, "project-copy");
  await mkdir(child, { recursive: true });
  await mkdir(sibling);
  t.after(async () => await rm(fixture, { recursive: true, force: true }));

  const policy = WorkspacePolicy.fromPaths([root]);
  assert.equal(await policy.assertAllowed(root), policy.roots()[0]?.path);
  assert.equal(await policy.assertAllowed(child), await import("node:fs/promises").then(({ realpath }) => realpath(child)));
  await assert.rejects(policy.assertAllowed(sibling), /WORKSPACE_NOT_ALLOWLISTED/u);
  await assert.rejects(new WorkspacePolicy([]).assertAllowed(root), /WORKSPACE_ALLOWLIST_EMPTY/u);
});

test("workspace policy hot-reload adds and removes roots in place", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "orchestratory-policy-reload-"));
  const a = join(fixture, "a");
  const b = join(fixture, "b");
  await mkdir(a);
  await mkdir(b);
  t.after(async () => await rm(fixture, { recursive: true, force: true }));
  const { realpath } = await import("node:fs/promises");
  const policy = new WorkspacePolicy([{ id: "a", label: "a", path: await realpath(a) }]);
  assert.equal(policy.roots().length, 1);
  await assert.rejects(policy.assertAllowed(b), /WORKSPACE_NOT_ALLOWLISTED/u);
  policy.replace([
    { id: "a", label: "a", path: await realpath(a) },
    { id: "b", label: "b", path: await realpath(b) },
  ]);
  assert.equal(policy.roots().length, 2);
  assert.equal(await policy.assertAllowed(b), await realpath(b));
  policy.replace([]);
  await assert.rejects(policy.assertAllowed(a), /WORKSPACE_ALLOWLIST_EMPTY/u);
});
