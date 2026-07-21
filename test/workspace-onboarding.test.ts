import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceOnboardingService } from "../src/core/workspace-onboarding.ts";
import { WorkspacePolicy } from "../src/security/workspace-policy.ts";

async function gitRoot(parent: string, name = "project"): Promise<string> {
  const root = join(parent, name);
  await mkdir(join(root, ".git"), { recursive: true });
  await writeFile(join(root, "README.md"), "safe\n", "utf8");
  return root;
}

test("workspace onboarding previews and confirms one exact Git root", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "orchestratory-onboarding-"));
  const data = join(sandbox, "data");
  const project = await gitRoot(sandbox, "safe-project");
  const policy = new WorkspacePolicy([]);
  t.after(async () => await rm(sandbox, { recursive: true, force: true }));

  const service = new WorkspaceOnboardingService({
    dataDirectory: data,
    workspaces: policy,
    homeDirectory: join(sandbox, "home"),
  });
  const preview = await service.preview(project);
  assert.equal(preview.blocked, false);
  assert.equal(preview.label, "safe-project");
  assert.equal(preview.confirmation, "ALLOW safe-project");
  assert.equal(preview.checks.every((check) => check.status === "pass"), true);

  const added = await service.confirm(preview.id, preview.confirmation);
  const canonicalProject = await realpath(project);
  assert.equal(added.path, canonicalProject);
  assert.equal(policy.allowsCanonical(canonicalProject), true);
  const saved = JSON.parse(await readFile(join(data, "workspace-roots.json"), "utf8")) as Array<{ path: string }>;
  assert.deepEqual(saved.map((root) => root.path), [canonicalProject]);
  await assert.rejects(service.confirm(preview.id, preview.confirmation), /WORKSPACE_PREVIEW_NOT_FOUND/u);
});

test("workspace onboarding is fail-closed for confirmation, expiry and path races", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "orchestratory-onboarding-race-"));
  const data = join(sandbox, "data");
  const project = await gitRoot(sandbox, "race-project");
  const policy = new WorkspacePolicy([]);
  let now = 1_000;
  t.after(async () => await rm(sandbox, { recursive: true, force: true }));
  const service = new WorkspaceOnboardingService({
    dataDirectory: data,
    workspaces: policy,
    homeDirectory: join(sandbox, "home"),
    now: () => now,
    ttlMs: 1_000,
  });

  const wrong = await service.preview(project);
  await assert.rejects(service.confirm(wrong.id, "ALLOW something-else"), /WORKSPACE_CONFIRMATION_MISMATCH/u);
  await assert.rejects(service.confirm(wrong.id, wrong.confirmation), /WORKSPACE_PREVIEW_NOT_FOUND/u);

  const expired = await service.preview(project);
  now += 1_001;
  await assert.rejects(service.confirm(expired.id, expired.confirmation), /WORKSPACE_PREVIEW_EXPIRED/u);

  now += 1;
  const permissionRace = await service.preview(project);
  await chmod(project, 0o775);
  await assert.rejects(
    service.confirm(permissionRace.id, permissionRace.confirmation),
    /WORKSPACE_PREVIEW_PATH_CHANGED/u,
  );
  await chmod(project, 0o755);

  now += 1;
  const raced = await service.preview(project);
  await rm(project, { recursive: true, force: true });
  await gitRoot(sandbox, "race-project");
  await assert.rejects(service.confirm(raced.id, raced.confirmation), /WORKSPACE_PREVIEW_PATH_CHANGED/u);
  assert.deepEqual(policy.roots(), []);
});

test("workspace onboarding blocks broad, sensitive, unsafe and non-Git selections", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "orchestratory-onboarding-block-"));
  const home = join(sandbox, "home");
  const data = join(home, "Library", "Application Support", "Orchestratory");
  const ssh = join(home, ".ssh");
  const plain = join(sandbox, "plain");
  const unsafe = await gitRoot(sandbox, "unsafe");
  const allowed = await gitRoot(sandbox, "allowed");
  await mkdir(data, { recursive: true });
  await mkdir(ssh, { recursive: true });
  await mkdir(plain);
  await chmod(unsafe, 0o777);
  const policy = new WorkspacePolicy([{ id: "allowed", label: "Allowed", path: await realpath(allowed) }]);
  t.after(async () => await rm(sandbox, { recursive: true, force: true }));
  const service = new WorkspaceOnboardingService({ dataDirectory: data, workspaces: policy, homeDirectory: home });

  for (const path of [home, ssh, data, plain, unsafe, allowed]) {
    const preview = await service.preview(path);
    assert.equal(preview.blocked, true, path);
    await assert.rejects(service.confirm(preview.id, preview.confirmation), /WORKSPACE_PREVIEW_BLOCKED/u);
  }
});

test("workspace onboarding resolves a selected symlink but binds the canonical target", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "orchestratory-onboarding-link-"));
  const target = await gitRoot(sandbox, "target-project");
  const link = join(sandbox, "project-link");
  await symlink(target, link);
  const policy = new WorkspacePolicy([]);
  t.after(async () => await rm(sandbox, { recursive: true, force: true }));
  const service = new WorkspaceOnboardingService({
    dataDirectory: join(sandbox, "data"),
    workspaces: policy,
    homeDirectory: join(sandbox, "home"),
  });

  const preview = await service.preview(link);
  assert.equal(preview.blocked, false);
  const canonicalTarget = await realpath(target);
  assert.equal(preview.canonicalPath, canonicalTarget);
  assert.equal(preview.resolvedSymlink, true);
  const added = await service.confirm(preview.id, preview.confirmation);
  assert.equal(added.path, canonicalTarget);
});
