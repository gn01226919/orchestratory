import test from "node:test";
import assert from "node:assert/strict";
import { chmod, link, mkdtemp, mkdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  ABSOLUTE_HARD_LIMITS,
  DEFAULT_HARD_LIMITS,
  defaultDataDirectory,
  DATA_DIRECTORY_ENVIRONMENT_KEY,
  assertDataDirectoryOverride,
  PROFILES,
  apiModelsPath,
  hardLimitsPath,
  loadOrCreateApiModelPolicies,
  loadOrCreateHardLimits,
  loadOrCreateTesterProfiles,
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
  testerProfilesPath,
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

test("all owner configuration loaders reject unsafe existing paths", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orchestratory-config-preflight-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const cases = [
    {
      name: "hard-limits",
      path: hardLimitsPath,
      content: `${JSON.stringify(DEFAULT_HARD_LIMITS)}\n`,
      load: loadOrCreateHardLimits,
    },
    { name: "api-models", path: apiModelsPath, content: "[]\n", load: loadOrCreateApiModelPolicies },
    { name: "tester-profiles", path: testerProfilesPath, content: "[]\n", load: loadOrCreateTesterProfiles },
    { name: "workspace-roots", path: workspaceRootsPath, content: "[]\n", load: loadOrCreateWorkspaceRootPolicies },
    {
      name: "retention",
      path: retentionPolicyPath,
      content: `${JSON.stringify(DEFAULT_RETENTION_POLICY)}\n`,
      load: loadOrCreateRetentionPolicy,
    },
  ] as const;

  for (const fixture of cases) {
    const symlinkData = join(root, `${fixture.name}-symlink`);
    await mkdir(symlinkData, { mode: 0o700 });
    const symlinkTarget = join(symlinkData, "target.json");
    await writeFile(symlinkTarget, fixture.content, { mode: 0o600 });
    await symlink(symlinkTarget, fixture.path(symlinkData));
    await assert.rejects(fixture.load(symlinkData), /UNSAFE_OWNER_FILE/u);

    const hardlinkData = join(root, `${fixture.name}-hardlink`);
    await mkdir(hardlinkData, { mode: 0o700 });
    const hardlinkTarget = join(hardlinkData, "target.json");
    await writeFile(hardlinkTarget, fixture.content, { mode: 0o600 });
    await link(hardlinkTarget, fixture.path(hardlinkData));
    await assert.rejects(fixture.load(hardlinkData), /UNSAFE_OWNER_FILE/u);

    const permissiveData = join(root, `${fixture.name}-mode`);
    await mkdir(permissiveData, { mode: 0o700 });
    await writeFile(fixture.path(permissiveData), fixture.content, { mode: 0o644 });
    await assert.rejects(fixture.load(permissiveData), /UNSAFE_OWNER_FILE/u);

    const unsafeDirectory = join(root, `${fixture.name}-directory`);
    await mkdir(unsafeDirectory, { mode: 0o755 });
    await assert.rejects(fixture.load(unsafeDirectory), /UNSAFE_DATA_DIRECTORY/u);
  }
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
  for (const [key, maximum] of Object.entries(ABSOLUTE_HARD_LIMITS)) {
    assert.throws(
      () => validateHardLimits({ ...DEFAULT_HARD_LIMITS, [key]: maximum + 1 }),
      new RegExp(`INVALID_HARD_LIMIT:${key}`, "u"),
    );
  }
  assert.throws(
    () => validateHardLimits({ ...DEFAULT_HARD_LIMITS, maxProviderCalls: 10.5 }),
    /INVALID_HARD_LIMIT:maxProviderCalls/u,
  );
  assert.deepEqual(
    validateHardLimits({ ...DEFAULT_HARD_LIMITS, maxApiBudgetUsdPerRun: 25.5 }),
    { ...DEFAULT_HARD_LIMITS, maxApiBudgetUsdPerRun: 25.5 },
  );
  assert.throws(
    () => validateHardLimits({ ...DEFAULT_HARD_LIMITS, providerTimeoutMs: 1_000, workflowTimeoutMs: 999 }),
    /INVALID_HARD_LIMIT_RELATION:providerTimeoutMs/u,
  );
  assert.throws(
    () => validateHardLimits({ ...DEFAULT_HARD_LIMITS, maxRounds: 21, maxProviderCalls: 20 }),
    /INVALID_HARD_LIMIT_RELATION:maxRounds/u,
  );
  assert.throws(
    () => validateHardLimits({ ...DEFAULT_HARD_LIMITS, maxApiBudgetUsdPerRun: 51 }),
    /INVALID_HARD_LIMIT_RELATION:maxApiBudgetUsdPerRun/u,
  );
  assert.throws(
    () => validateHardLimits({ ...DEFAULT_HARD_LIMITS, maxApiBudgetUsdPerDay: 251 }),
    /INVALID_HARD_LIMIT_RELATION:maxApiBudgetUsdPerDay/u,
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
    () => validateSoftLimits({ ...PROFILES.normal, maxProviderCalls: 1.5 }, DEFAULT_HARD_LIMITS),
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

/*
 * The data directory override.
 *
 * It exists because a working tree and an installed runtime resolved to the same directory, so the
 * moment a development build applied a newer migration every installed runtime was locked out of the
 * database -- correctly, since refusing an unknown schema is the safe answer, but the lockout took
 * the whole product down for every session on the machine. Development needs its own state.
 *
 * The tests below are in both directions, because the value is an input that decides where the
 * ledger, the approvals and credential-adjacent state are read from and written to.
 */
test("the data directory is overridable, and an override is judged by where it lands", () => {
  const base = defaultDataDirectory({});
  assert.match(base, /Library\/Application Support\/Orchestratory$/u);

  /* Absent and empty both mean "not set". An empty string reaching the validator would fail
     `isAbsolute` and throw, which would turn `export ORCHESTRATORY_DATA_DIR=` -- a perfectly ordinary
     way to unset a variable in a shell -- into a crash. */
  assert.equal(defaultDataDirectory({ [DATA_DIRECTORY_ENVIRONMENT_KEY]: "" }), base);
  assert.equal(defaultDataDirectory({}), base);

  const chosen = defaultDataDirectory({ [DATA_DIRECTORY_ENVIRONMENT_KEY]: "/tmp/orchestratory-dev" });
  assert.equal(chosen, "/tmp/orchestratory-dev");

  /* Spelling does not decide the answer: `..` is collapsed before anything is compared, and a
     trailing separator resolves to the same directory, so every store agrees on one string. */
  assert.equal(assertDataDirectoryOverride("/tmp/a/../orchestratory-dev"), "/tmp/orchestratory-dev");
  assert.equal(assertDataDirectoryOverride("/tmp/orchestratory-dev/"), "/tmp/orchestratory-dev");
  assert.equal(assertDataDirectoryOverride("/tmp//orchestratory-dev"), "/tmp/orchestratory-dev");
});

test("an override that lands somewhere it should not is refused, not quietly ignored", () => {
  const refuse = (value: string, code: RegExp) =>
    assert.throws(() => assertDataDirectoryOverride(value), code, `${value} should be refused`);

  refuse("relative/path", /NOT_ABSOLUTE/u);
  refuse("", /NOT_ABSOLUTE/u);
  refuse("/tmp/with\0nul", /NUL_BYTE/u);

  /* Landing on the filesystem root or on a home directory itself means every later `join` writes
     into a directory whose contents are not this product's. The home case had no test until a
     mutant removed the check and nothing turned red -- the rule was written and unguarded. */
  refuse("/", /FILESYSTEM_ROOT/u);
  refuse("/tmp/..", /FILESYSTEM_ROOT/u);
  refuse(homedir(), /HOME_ROOT/u);
  refuse(`${homedir()}/`, /HOME_ROOT/u);
  /* A directory INSIDE home is the ordinary case and must stay allowed -- that is where the real
     default lives. */
  assert.equal(assertDataDirectoryOverride(`${homedir()}/orchestratory-dev`), `${homedir()}/orchestratory-dev`);

  /* Directories the operating system owns. Writing here needs privileges this product never asks
     for, so a value pointing at one is a mistake rather than an intention. */
  for (const reserved of ["/System", "/usr/local", "/etc", "/var/db", "/private/etc/hosts.d"]) {
    refuse(reserved, /SYSTEM_PATH/u);
  }
  /* A directory whose name merely begins with a reserved one is somebody's ordinary folder. */
  assert.equal(assertDataDirectoryOverride("/etcetera/data"), "/etcetera/data");
  assert.equal(assertDataDirectoryOverride("/usr-local-backup"), "/usr-local-backup");
});

test("an invalid override throws instead of falling back to the default", () => {
  /*
   * The failure this prevents is the exact one the override exists to fix: a developer sets it,
   * mistypes it, is told nothing, and unknowingly migrates the production database. Silence would
   * make the mistake indistinguishable from success.
   */
  assert.throws(
    () => defaultDataDirectory({ [DATA_DIRECTORY_ENVIRONMENT_KEY]: "not/absolute" }),
    /INVALID_DATA_DIRECTORY/u,
  );
  assert.throws(
    () => defaultDataDirectory({ [DATA_DIRECTORY_ENVIRONMENT_KEY]: "/" }),
    /INVALID_DATA_DIRECTORY/u,
  );
});
