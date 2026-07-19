import test from "node:test";
import assert from "node:assert/strict";
import { chmod, link, mkdtemp, mkdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_HARD_LIMITS,
  defaultDataDirectory,
  PROFILES,
  validateApiModelPolicies,
  validateHardLimits,
  validateSoftLimits,
  validateTesterProfiles,
  validateWorkspaceRootPolicies,
  loadOrCreateWorkspaceRootPolicies,
  saveWorkspaceRootPolicies,
  workspaceRootsPath,
  DEFAULT_RETENTION_POLICY,
  loadOrCreateRetentionPolicy,
  retentionPolicyPath,
  saveRetentionPolicy,
  validateRetentionPolicy,
  loadCodexWriterEnabled,
  loadNativeRoomPtyEnabled,
} from "../src/config.ts";

test("default data directory is scoped to Orchestratory application support", () => {
  assert.match(defaultDataDirectory(), /Library\/Application Support\/Orchestratory$/u);
});

test("owner capability gates fail closed on unsafe files and exact-schema violations", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "orchestratory-gates-"));
  t.after(async () => await rm(data, { recursive: true, force: true }));
  const codexGate = join(data, "codex-writer.json");
  const ptyGate = join(data, "native-room-pty.json");

  assert.equal(await loadCodexWriterEnabled(data), false);
  await writeFile(codexGate, '{"enabled":true}\n', { mode: 0o600 });
  assert.equal(await loadCodexWriterEnabled(data), true);
  await chmod(codexGate, 0o644);
  assert.equal(await loadCodexWriterEnabled(data), false);
  await chmod(codexGate, 0o600);
  await writeFile(codexGate, '{"enabled":true,"extra":true}\n', { mode: 0o600 });
  assert.equal(await loadCodexWriterEnabled(data), false);

  await writeFile(ptyGate, '{"enabled":true}\n', { mode: 0o600 });
  assert.equal(await loadNativeRoomPtyEnabled(data), true);
  await chmod(data, 0o755);
  assert.equal(await loadNativeRoomPtyEnabled(data), false);
  await chmod(data, 0o700);

  const target = join(data, "gate-target.json");
  await writeFile(target, '{"enabled":true}\n', { mode: 0o600 });
  await rm(codexGate);
  await link(target, codexGate);
  assert.equal(await loadCodexWriterEnabled(data), false);
  await rm(ptyGate);
  await symlink(target, ptyGate);
  assert.equal(await loadNativeRoomPtyEnabled(data), false);
});

test("hard limits reject unknown keys", () => {
  assert.throws(
    () => validateHardLimits({ ...DEFAULT_HARD_LIMITS, unexpected: 1 }),
    /UNKNOWN_HARD_LIMIT_KEYS/u,
  );
  assert.throws(() => validateHardLimits(null), /INVALID_HARD_LIMITS_OBJECT/u);
  assert.throws(
    () => validateHardLimits({ ...DEFAULT_HARD_LIMITS, maxRounds: 0 }),
    /INVALID_HARD_LIMIT:maxRounds/u,
  );
});

test("soft limits cannot exceed hard limits", () => {
  assert.throws(
    () =>
      validateSoftLimits(
        { ...PROFILES.normal, maxRounds: DEFAULT_HARD_LIMITS.maxRounds + 1 },
        DEFAULT_HARD_LIMITS,
      ),
    /SOFT_LIMIT_EXCEEDS_HARD:maxRounds/u,
  );
  assert.throws(
    () => validateSoftLimits({ ...PROFILES.normal, maxProviderCalls: 0 }, DEFAULT_HARD_LIMITS),
    /INVALID_SOFT_LIMIT:maxProviderCalls/u,
  );
  assert.throws(
    () => validateSoftLimits(
      { ...PROFILES.normal, workflowTimeoutMs: DEFAULT_HARD_LIMITS.workflowTimeoutMs + 1 },
      DEFAULT_HARD_LIMITS,
    ),
    /SOFT_LIMIT_EXCEEDS_HARD:workflowTimeoutMs/u,
  );
  assert.throws(
    () => validateSoftLimits(
      { ...PROFILES.normal, providerTimeoutMs: DEFAULT_HARD_LIMITS.providerTimeoutMs + 1 },
      DEFAULT_HARD_LIMITS,
    ),
    /SOFT_LIMIT_EXCEEDS_HARD:providerTimeoutMs/u,
  );
});

test("normal and long profiles fit within hard limits", () => {
  assert.deepEqual(validateSoftLimits({ ...PROFILES.normal }, DEFAULT_HARD_LIMITS), PROFILES.normal);
  assert.deepEqual(validateSoftLimits({ ...PROFILES.long }, DEFAULT_HARD_LIMITS), PROFILES.long);
});

test("API model policy rejects unknown fields and duplicate models", () => {
  const policy = {
    provider: "codex",
    model: "synthetic-model",
    inputUsdPerMillionTokens: 1,
    outputUsdPerMillionTokens: 2,
    maxOutputTokens: 1024,
  };
  assert.throws(() => validateApiModelPolicies([{ ...policy, endpoint: "https://attacker.invalid" }]), /UNKNOWN_API_MODEL_POLICY_KEY/u);
  assert.throws(() => validateApiModelPolicies([policy, policy]), /DUPLICATE_API_MODEL_POLICY/u);
  assert.throws(() => validateApiModelPolicies({}), /INVALID_API_MODELS_ARRAY/u);
  assert.throws(() => validateApiModelPolicies([null]), /INVALID_API_MODEL_POLICY/u);
  assert.throws(
    () => validateApiModelPolicies([{ ...policy, provider: "fake" }]),
    /INVALID_API_MODEL_PROVIDER/u,
  );
  assert.throws(
    () => validateApiModelPolicies([{ ...policy, model: "bad model" }]),
    /INVALID_API_MODEL_ID/u,
  );
  assert.throws(
    () => validateApiModelPolicies([{ ...policy, inputUsdPerMillionTokens: 0 }]),
    /INVALID_API_MODEL_PRICE/u,
  );
  assert.throws(
    () => validateApiModelPolicies([{ ...policy, maxOutputTokens: 0 }]),
    /INVALID_API_MAX_OUTPUT_TOKENS/u,
  );
});

test("tester profiles require digest-pinned images and exact schema", () => {
  const profile = {
    id: "node-tests",
    displayName: "Node tests",
    runtime: "docker",
    image: `node@sha256:${"a".repeat(64)}`,
    executable: "node",
    args: ["--test"],
  };
  assert.deepEqual(validateTesterProfiles([profile]), [profile]);
  assert.throws(
    () => validateTesterProfiles([{ ...profile, image: "node:latest" }]),
    /TESTER_IMAGE_NOT_DIGEST_PINNED/u,
  );
  assert.throws(
    () => validateTesterProfiles([{ ...profile, endpoint: "attacker.invalid" }]),
    /UNKNOWN_TESTER_PROFILE_KEY/u,
  );
  assert.throws(() => validateTesterProfiles([profile, profile]), /DUPLICATE_TESTER_PROFILE/u);
  assert.throws(() => validateTesterProfiles({}), /INVALID_TESTER_PROFILES_ARRAY/u);
  assert.throws(() => validateTesterProfiles([null]), /INVALID_TESTER_PROFILE/u);
  assert.throws(
    () => validateTesterProfiles([{ ...profile, displayName: "\n" }]),
    /INVALID_TESTER_DISPLAY_NAME/u,
  );
  assert.throws(
    () => validateTesterProfiles([{ ...profile, runtime: "host" }]),
    /INVALID_TESTER_RUNTIME/u,
  );
  assert.throws(
    () => validateTesterProfiles([{ ...profile, executable: "../node" }]),
    /INVALID_TESTER_EXECUTABLE/u,
  );
  assert.throws(
    () => validateTesterProfiles([{ ...profile, args: ["x\0y"] }]),
    /INVALID_TESTER_ARGS/u,
  );
});

test("workspace roots use an exact owner-only schema and canonical paths", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "orchestratory-config-data-"));
  const root = join(data, "projects");
  await mkdir(root);
  t.after(async () => await rm(data, { recursive: true, force: true }));

  assert.throws(
    () => validateWorkspaceRootPolicies([{ id: "root", label: "Root", path: "relative" }]),
    /INVALID_WORKSPACE_ROOT_PATH/u,
  );
  assert.throws(
    () => validateWorkspaceRootPolicies([{ id: "root", label: "Root", path: root, extra: true }]),
    /UNKNOWN_WORKSPACE_ROOT_KEY/u,
  );
  assert.throws(
    () =>
      validateWorkspaceRootPolicies([
        { id: "root", label: "Root", path: root },
        { id: "root", label: "Duplicate", path: data },
      ]),
    /DUPLICATE_WORKSPACE_ROOT_ID/u,
  );

  assert.deepEqual(await loadOrCreateWorkspaceRootPolicies(data), []);
  const saved = await saveWorkspaceRootPolicies(
    [{ id: "projects", label: "Projects", path: root }],
    data,
  );
  assert.equal(saved[0]?.path, await import("node:fs/promises").then(({ realpath }) => realpath(root)));
  assert.equal((await stat(workspaceRootsPath(data))).mode & 0o777, 0o600);
  assert.equal((await stat(data)).mode & 0o777, 0o700);
  assert.deepEqual(await loadOrCreateWorkspaceRootPolicies(data), saved);
});

test("retention policy is finite, owner-only and debug capture defaults off", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "orchestratory-retention-data-"));
  t.after(async () => await rm(data, { recursive: true, force: true }));
  assert.equal(DEFAULT_RETENTION_POLICY.debugCaptureEnabled, false);
  assert.throws(
    () => validateRetentionPolicy({ ...DEFAULT_RETENTION_POLICY, terminalRunDays: 0 }),
    /INVALID_RETENTION_POLICY:terminalRunDays/u,
  );
  assert.throws(
    () => validateRetentionPolicy({ ...DEFAULT_RETENTION_POLICY, unknown: true }),
    /UNKNOWN_RETENTION_POLICY_KEY/u,
  );
  assert.throws(() => validateRetentionPolicy(null), /INVALID_RETENTION_POLICY/u);
  assert.throws(
    () => validateRetentionPolicy({ ...DEFAULT_RETENTION_POLICY, debugCaptureEnabled: "yes" }),
    /INVALID_RETENTION_POLICY:debugCaptureEnabled/u,
  );
  assert.throws(
    () => validateRetentionPolicy({ ...DEFAULT_RETENTION_POLICY, debugCaptureEnabled: true }),
    /DEBUG_CAPTURE_NOT_IMPLEMENTED/u,
  );
  assert.throws(
    () => validateRetentionPolicy({ ...DEFAULT_RETENTION_POLICY, debugRetentionHours: 169 }),
    /INVALID_RETENTION_POLICY:debugRetentionHours/u,
  );
  assert.deepEqual(await loadOrCreateRetentionPolicy(data), DEFAULT_RETENTION_POLICY);
  const saved = await saveRetentionPolicy(
    { ...DEFAULT_RETENTION_POLICY, terminalRunDays: 14, maxTerminalRuns: 100 },
    data,
  );
  assert.equal(saved.terminalRunDays, 14);
  assert.equal((await stat(retentionPolicyPath(data))).mode & 0o777, 0o600);
});
