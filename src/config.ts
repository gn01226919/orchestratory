import { chmod, lstat, mkdir, open, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type {
  ApiModelPolicy,
  HardLimits,
  ProviderId,
  SoftLimits,
  TesterProfile,
  WorkspaceRootPolicy,
  RetentionPolicy,
} from "./types.ts";

export const DEFAULT_HARD_LIMITS: Readonly<HardLimits> = Object.freeze({
  maxConcurrentWorkflows: 1,
  providerTimeoutMs: 600_000,
  workflowTimeoutMs: 14_400_000,
  maxProviderCalls: 500,
  maxSubprocesses: 80,
  maxOutputBytes: 2_097_152,
  maxFilesChanged: 40,
  maxDiffLines: 10_000,
  maxConsecutiveErrors: 3,
  maxRetries: 2,
  maxRounds: 20,
  maxApiBudgetUsdPerRun: 25,
  maxApiBudgetUsdPerDay: 50,
  maxApiBudgetUsdPerMonth: 250,
});

/** Compiled ceilings: owner configuration may lower or raise defaults, never these bounds. */
export const ABSOLUTE_HARD_LIMITS: Readonly<HardLimits> = Object.freeze({
  maxConcurrentWorkflows: 4,
  providerTimeoutMs: 1_800_000,
  workflowTimeoutMs: 86_400_000,
  maxProviderCalls: 1_000,
  maxSubprocesses: 500,
  maxOutputBytes: 8_388_608,
  maxFilesChanged: 200,
  maxDiffLines: 100_000,
  maxConsecutiveErrors: 20,
  maxRetries: 10,
  maxRounds: 100,
  maxApiBudgetUsdPerRun: 250,
  maxApiBudgetUsdPerDay: 500,
  maxApiBudgetUsdPerMonth: 2_500,
});

const INTEGER_HARD_LIMITS = new Set<keyof HardLimits>([
  "maxConcurrentWorkflows",
  "providerTimeoutMs",
  "workflowTimeoutMs",
  "maxProviderCalls",
  "maxSubprocesses",
  "maxOutputBytes",
  "maxFilesChanged",
  "maxDiffLines",
  "maxConsecutiveErrors",
  "maxRetries",
  "maxRounds",
]);

export const PROFILES: Readonly<Record<"normal" | "long", Readonly<SoftLimits>>> =
  Object.freeze({
    normal: Object.freeze({
      maxRounds: 5,
      maxProviderCalls: 15,
      workflowTimeoutMs: 2_700_000,
      providerTimeoutMs: 600_000,
    }),
    long: Object.freeze({
      maxRounds: 15,
      maxProviderCalls: 45,
      workflowTimeoutMs: 10_800_000,
      providerTimeoutMs: 600_000,
    }),
  });

async function loadOwnerBooleanGate(dataDirectory: string, filename: string): Promise<boolean> {
  try {
    const directory = await lstat(dataDirectory);
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (
      !directory.isDirectory() ||
      directory.isSymbolicLink() ||
      (directory.mode & 0o077) !== 0 ||
      (uid !== undefined && directory.uid !== uid)
    ) return false;
    const handle = await open(
      join(dataDirectory, filename),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const info = await handle.stat();
      if (
        !info.isFile() ||
        info.nlink !== 1 ||
        info.size < 1 ||
        info.size > 1_024 ||
        (info.mode & 0o077) !== 0 ||
        (uid !== undefined && info.uid !== uid)
      ) return false;
      const parsed = JSON.parse(await handle.readFile({ encoding: "utf8" })) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
      const input = parsed as Record<string, unknown>;
      return Object.keys(input).length === 1 && input.enabled === true;
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
}

export async function loadCodexWriterEnabled(dataDirectory = defaultDataDirectory()): Promise<boolean> {
  // Owner opt-in for experimental Codex Writer. Default OFF (file absent/unsafe → false).
  return await loadOwnerBooleanGate(dataDirectory, "codex-writer.json");
}

export async function loadNativeRoomPtyEnabled(dataDirectory = defaultDataDirectory()): Promise<boolean> {
  // Native CLIs may load owner configuration outside Orchestratory's mediation.
  // Keep the bridge off unless an exact owner-only capability gate is present.
  return await loadOwnerBooleanGate(dataDirectory, "native-room-pty.json");
}

export function defaultDataDirectory(): string {
  return join(homedir(), "Library", "Application Support", "Orchestratory");
}

export function hardLimitsPath(dataDirectory = defaultDataDirectory()): string {
  return join(dataDirectory, "hard-limits.json");
}

export function apiModelsPath(dataDirectory = defaultDataDirectory()): string {
  return join(dataDirectory, "api-models.json");
}

export function testerProfilesPath(dataDirectory = defaultDataDirectory()): string {
  return join(dataDirectory, "tester-profiles.json");
}

export function workspaceRootsPath(dataDirectory = defaultDataDirectory()): string {
  return join(dataDirectory, "workspace-roots.json");
}

export const DEFAULT_RETENTION_POLICY: Readonly<RetentionPolicy> = Object.freeze({
  terminalRunDays: 30,
  maxTerminalRuns: 500,
  debugCaptureEnabled: false,
  debugRetentionHours: 24,
});

export function retentionPolicyPath(dataDirectory = defaultDataDirectory()): string {
  return join(dataDirectory, "retention.json");
}

const MAX_OWNER_CONFIG_BYTES = 1_048_576;

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function ensureOwnerDataDirectory(dataDirectory: string): Promise<void> {
  try {
    await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
    const directory = await lstat(dataDirectory);
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (
      !directory.isDirectory() ||
      directory.isSymbolicLink() ||
      (directory.mode & 0o777) !== 0o700 ||
      (uid !== undefined && directory.uid !== uid)
    ) throw new Error("UNSAFE_DATA_DIRECTORY");
  } catch (error) {
    if (error instanceof Error && error.message === "UNSAFE_DATA_DIRECTORY") throw error;
    throw new Error("UNSAFE_DATA_DIRECTORY");
  }
}

/**
 * Exported so that owner-only state added later (telemetry consent, for one) reuses these
 * exact checks instead of growing a second, weaker reader. ENOENT is re-thrown unchanged so
 * callers can tell "not there yet" from "there but not safe to read".
 */
export async function readOwnerOnlyText(path: string): Promise<string> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isMissing(error)) throw error;
    throw new Error("UNSAFE_OWNER_FILE");
  }
  try {
    const info = await handle.stat();
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.size < 1 ||
      info.size > MAX_OWNER_CONFIG_BYTES ||
      (info.mode & 0o777) !== 0o600 ||
      (uid !== undefined && info.uid !== uid)
    ) throw new Error("UNSAFE_OWNER_FILE");
    return await handle.readFile({ encoding: "utf8" });
  } finally {
    await handle.close();
  }
}

async function createOwnerOnlyText(path: string, content: string): Promise<void> {
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(content, { encoding: "utf8" });
    await handle.chmod(0o600);
  } finally {
    await handle.close();
  }
}

async function readOrCreateOwnerConfig(
  path: string,
  defaultContent: string,
): Promise<{ raw: string; created: boolean }> {
  await ensureOwnerDataDirectory(dirname(path));
  try {
    return { raw: await readOwnerOnlyText(path), created: false };
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  try {
    await createOwnerOnlyText(path, defaultContent);
    return { raw: await readOwnerOnlyText(path), created: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return { raw: await readOwnerOnlyText(path), created: false };
  }
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function validateHardLimits(value: unknown): HardLimits {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("INVALID_HARD_LIMITS_OBJECT");
  }
  const input = value as Record<string, unknown>;
  const expected = Object.keys(DEFAULT_HARD_LIMITS) as Array<keyof HardLimits>;
  const unknownKeys = Object.keys(input).filter(
    (key) => !expected.includes(key as keyof HardLimits),
  );
  if (unknownKeys.length > 0) throw new Error("UNKNOWN_HARD_LIMIT_KEYS");

  const output = {} as HardLimits;
  for (const key of expected) {
    const candidate = input[key];
    if (
      !isPositiveFinite(candidate) ||
      candidate > ABSOLUTE_HARD_LIMITS[key] ||
      (INTEGER_HARD_LIMITS.has(key) && !Number.isSafeInteger(candidate))
    ) throw new Error(`INVALID_HARD_LIMIT:${key}`);
    output[key] = candidate;
  }
  if (output.providerTimeoutMs > output.workflowTimeoutMs) {
    throw new Error("INVALID_HARD_LIMIT_RELATION:providerTimeoutMs");
  }
  if (output.maxRounds > output.maxProviderCalls) {
    throw new Error("INVALID_HARD_LIMIT_RELATION:maxRounds");
  }
  if (output.maxApiBudgetUsdPerRun > output.maxApiBudgetUsdPerDay) {
    throw new Error("INVALID_HARD_LIMIT_RELATION:maxApiBudgetUsdPerRun");
  }
  if (output.maxApiBudgetUsdPerDay > output.maxApiBudgetUsdPerMonth) {
    throw new Error("INVALID_HARD_LIMIT_RELATION:maxApiBudgetUsdPerDay");
  }
  return Object.freeze(output);
}

export function validateSoftLimits(
  value: SoftLimits,
  hard: HardLimits,
): Readonly<SoftLimits> {
  const fields: Array<keyof SoftLimits> = [
    "maxRounds",
    "maxProviderCalls",
    "workflowTimeoutMs",
    "providerTimeoutMs",
  ];
  for (const field of fields) {
    if (!Number.isSafeInteger(value[field]) || value[field] <= 0) {
      throw new Error(`INVALID_SOFT_LIMIT:${field}`);
    }
  }
  if (value.maxRounds > hard.maxRounds) throw new Error("SOFT_LIMIT_EXCEEDS_HARD:maxRounds");
  if (value.maxProviderCalls > hard.maxProviderCalls) {
    throw new Error("SOFT_LIMIT_EXCEEDS_HARD:maxProviderCalls");
  }
  if (value.workflowTimeoutMs > hard.workflowTimeoutMs) {
    throw new Error("SOFT_LIMIT_EXCEEDS_HARD:workflowTimeoutMs");
  }
  if (value.providerTimeoutMs > hard.providerTimeoutMs) {
    throw new Error("SOFT_LIMIT_EXCEEDS_HARD:providerTimeoutMs");
  }
  return Object.freeze({ ...value });
}

export async function loadOrCreateHardLimits(
  dataDirectory = defaultDataDirectory(),
): Promise<Readonly<HardLimits>> {
  const path = hardLimitsPath(dataDirectory);
  const loaded = await readOrCreateOwnerConfig(
    path,
    `${JSON.stringify(DEFAULT_HARD_LIMITS, null, 2)}\n`,
  );
  return loaded.created ? DEFAULT_HARD_LIMITS : validateHardLimits(JSON.parse(loaded.raw) as unknown);
}

const API_PROVIDERS = new Set<ProviderId>(["codex", "claude", "grok"]);

function validateModelId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:/-]{1,128}$/u.test(value)) {
    throw new Error("INVALID_API_MODEL_ID");
  }
  return value;
}

export function validateApiModelPolicies(value: unknown): ApiModelPolicy[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error("INVALID_API_MODELS_ARRAY");
  const seen = new Set<string>();
  return value.map((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error("INVALID_API_MODEL_POLICY");
    }
    const input = item as Record<string, unknown>;
    const expected = [
      "provider",
      "model",
      "inputUsdPerMillionTokens",
      "outputUsdPerMillionTokens",
      "maxOutputTokens",
    ];
    if (Object.keys(input).some((key) => !expected.includes(key))) {
      throw new Error("UNKNOWN_API_MODEL_POLICY_KEY");
    }
    const provider = input.provider as ProviderId;
    if (!API_PROVIDERS.has(provider)) throw new Error("INVALID_API_MODEL_PROVIDER");
    const model = validateModelId(input.model);
    const inputPrice = input.inputUsdPerMillionTokens;
    const outputPrice = input.outputUsdPerMillionTokens;
    const maxOutputTokens = input.maxOutputTokens;
    if (!isPositiveFinite(inputPrice) || !isPositiveFinite(outputPrice)) {
      throw new Error("INVALID_API_MODEL_PRICE");
    }
    if (
      typeof maxOutputTokens !== "number" ||
      !Number.isSafeInteger(maxOutputTokens) ||
      maxOutputTokens < 1 ||
      maxOutputTokens > 1_000_000
    ) {
      throw new Error("INVALID_API_MAX_OUTPUT_TOKENS");
    }
    const key = `${provider}:${model}`;
    if (seen.has(key)) throw new Error("DUPLICATE_API_MODEL_POLICY");
    seen.add(key);
    return {
      provider: provider as ApiModelPolicy["provider"],
      model,
      inputUsdPerMillionTokens: inputPrice,
      outputUsdPerMillionTokens: outputPrice,
      maxOutputTokens,
    };
  });
}

export async function loadOrCreateApiModelPolicies(
  dataDirectory = defaultDataDirectory(),
): Promise<ReadonlyArray<Readonly<ApiModelPolicy>>> {
  const path = apiModelsPath(dataDirectory);
  const loaded = await readOrCreateOwnerConfig(path, "[]\n");
  return Object.freeze(
    validateApiModelPolicies(JSON.parse(loaded.raw) as unknown).map((policy) => Object.freeze(policy)),
  );
}

export function validateTesterProfiles(value: unknown): TesterProfile[] {
  if (!Array.isArray(value) || value.length > 32) throw new Error("INVALID_TESTER_PROFILES_ARRAY");
  const seen = new Set<string>();
  return value.map((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error("INVALID_TESTER_PROFILE");
    }
    const input = item as Record<string, unknown>;
    const expected = ["id", "displayName", "runtime", "image", "executable", "args"];
    if (Object.keys(input).some((key) => !expected.includes(key))) {
      throw new Error("UNKNOWN_TESTER_PROFILE_KEY");
    }
    if (typeof input.id !== "string" || !/^[a-z][a-z0-9-]{0,63}$/u.test(input.id)) {
      throw new Error("INVALID_TESTER_PROFILE_ID");
    }
    if (seen.has(input.id)) throw new Error("DUPLICATE_TESTER_PROFILE");
    seen.add(input.id);
    if (
      typeof input.displayName !== "string" ||
      input.displayName.trim().length < 1 ||
      input.displayName.length > 100 ||
      /[\u0000-\u001F\u007F]/u.test(input.displayName)
    ) {
      throw new Error("INVALID_TESTER_DISPLAY_NAME");
    }
    if (input.runtime !== "docker" && input.runtime !== "podman") {
      throw new Error("INVALID_TESTER_RUNTIME");
    }
    if (
      typeof input.image !== "string" ||
      !/^[a-z0-9][a-z0-9._/-]{0,200}@sha256:[a-f0-9]{64}$/u.test(input.image)
    ) {
      throw new Error("TESTER_IMAGE_NOT_DIGEST_PINNED");
    }
    if (
      typeof input.executable !== "string" ||
      !/^[A-Za-z0-9_./-]{1,256}$/u.test(input.executable) ||
      input.executable.startsWith("-") ||
      input.executable.split("/").includes("..")
    ) {
      throw new Error("INVALID_TESTER_EXECUTABLE");
    }
    if (
      !Array.isArray(input.args) ||
      input.args.length > 32 ||
      input.args.some(
        (arg) => typeof arg !== "string" || arg.length > 2_048 || arg.includes("\0"),
      )
    ) {
      throw new Error("INVALID_TESTER_ARGS");
    }
    return {
      id: input.id,
      displayName: input.displayName.trim(),
      runtime: input.runtime,
      image: input.image,
      executable: input.executable,
      args: [...input.args] as string[],
    };
  });
}

export async function loadOrCreateTesterProfiles(
  dataDirectory = defaultDataDirectory(),
): Promise<ReadonlyArray<Readonly<TesterProfile>>> {
  const path = testerProfilesPath(dataDirectory);
  const loaded = await readOrCreateOwnerConfig(path, "[]\n");
  return Object.freeze(
    validateTesterProfiles(JSON.parse(loaded.raw) as unknown).map((profile) =>
      Object.freeze({ ...profile, args: Object.freeze([...profile.args]) }),
    ),
  );
}

export function validateWorkspaceRootPolicies(value: unknown): WorkspaceRootPolicy[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error("INVALID_WORKSPACE_ROOTS_ARRAY");
  const ids = new Set<string>();
  const paths = new Set<string>();
  return value.map((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error("INVALID_WORKSPACE_ROOT_POLICY");
    }
    const input = item as Record<string, unknown>;
    const expected = ["id", "label", "path"];
    if (Object.keys(input).some((key) => !expected.includes(key))) {
      throw new Error("UNKNOWN_WORKSPACE_ROOT_KEY");
    }
    if (typeof input.id !== "string" || !/^[a-z][a-z0-9-]{0,63}$/u.test(input.id)) {
      throw new Error("INVALID_WORKSPACE_ROOT_ID");
    }
    if (ids.has(input.id)) throw new Error("DUPLICATE_WORKSPACE_ROOT_ID");
    ids.add(input.id);
    if (
      typeof input.label !== "string" ||
      input.label.trim().length < 1 ||
      input.label.length > 100 ||
      /[\u0000-\u001F\u007F]/u.test(input.label)
    ) {
      throw new Error("INVALID_WORKSPACE_ROOT_LABEL");
    }
    if (
      typeof input.path !== "string" ||
      input.path.length > 4_096 ||
      input.path.includes("\0") ||
      !isAbsolute(input.path)
    ) {
      throw new Error("INVALID_WORKSPACE_ROOT_PATH");
    }
    const normalizedPath = resolve(input.path);
    if (paths.has(normalizedPath)) throw new Error("DUPLICATE_WORKSPACE_ROOT_PATH");
    paths.add(normalizedPath);
    return { id: input.id, label: input.label.trim(), path: normalizedPath };
  });
}

async function canonicalizeWorkspaceRootPolicies(
  policies: WorkspaceRootPolicy[],
): Promise<WorkspaceRootPolicy[]> {
  const seen = new Set<string>();
  const output: WorkspaceRootPolicy[] = [];
  for (const policy of policies) {
    const path = await realpath(policy.path);
    const info = await stat(path);
    if (!info.isDirectory()) throw new Error("WORKSPACE_ROOT_NOT_DIRECTORY");
    if (seen.has(path)) throw new Error("DUPLICATE_CANONICAL_WORKSPACE_ROOT");
    seen.add(path);
    output.push({ ...policy, path });
  }
  return output;
}

export async function atomicOwnerOnlyJson(path: string, value: unknown): Promise<void> {
  await ensureOwnerDataDirectory(dirname(path));
  try {
    await readOwnerOnlyText(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
    await chmod(path, 0o600);
    await readOwnerOnlyText(path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function loadOrCreateWorkspaceRootPolicies(
  dataDirectory = defaultDataDirectory(),
): Promise<ReadonlyArray<Readonly<WorkspaceRootPolicy>>> {
  const path = workspaceRootsPath(dataDirectory);
  const loaded = await readOrCreateOwnerConfig(path, "[]\n");
  const validated = validateWorkspaceRootPolicies(JSON.parse(loaded.raw) as unknown);
  return Object.freeze(
    (await canonicalizeWorkspaceRootPolicies(validated)).map((policy) => Object.freeze(policy)),
  );
}

export async function saveWorkspaceRootPolicies(
  policies: unknown,
  dataDirectory = defaultDataDirectory(),
): Promise<ReadonlyArray<Readonly<WorkspaceRootPolicy>>> {
  const validated = validateWorkspaceRootPolicies(policies);
  const canonical = await canonicalizeWorkspaceRootPolicies(validated);
  await atomicOwnerOnlyJson(workspaceRootsPath(dataDirectory), canonical);
  return Object.freeze(canonical.map((policy) => Object.freeze(policy)));
}

export function validateRetentionPolicy(value: unknown): RetentionPolicy {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("INVALID_RETENTION_POLICY");
  }
  const input = value as Record<string, unknown>;
  const expected = [
    "terminalRunDays",
    "maxTerminalRuns",
    "debugCaptureEnabled",
    "debugRetentionHours",
  ];
  if (Object.keys(input).some((key) => !expected.includes(key))) {
    throw new Error("UNKNOWN_RETENTION_POLICY_KEY");
  }
  const boundedInteger = (name: string, minimum: number, maximum: number): number => {
    const candidate = input[name];
    if (
      typeof candidate !== "number" ||
      !Number.isSafeInteger(candidate) ||
      candidate < minimum ||
      candidate > maximum
    ) {
      throw new Error(`INVALID_RETENTION_POLICY:${name}`);
    }
    return candidate;
  };
  if (typeof input.debugCaptureEnabled !== "boolean") {
    throw new Error("INVALID_RETENTION_POLICY:debugCaptureEnabled");
  }
  if (input.debugCaptureEnabled) {
    throw new Error("DEBUG_CAPTURE_NOT_IMPLEMENTED");
  }
  return {
    terminalRunDays: boundedInteger("terminalRunDays", 1, 3_650),
    maxTerminalRuns: boundedInteger("maxTerminalRuns", 1, 10_000),
    debugCaptureEnabled: input.debugCaptureEnabled,
    debugRetentionHours: boundedInteger("debugRetentionHours", 1, 168),
  };
}

export async function loadOrCreateRetentionPolicy(
  dataDirectory = defaultDataDirectory(),
): Promise<Readonly<RetentionPolicy>> {
  const path = retentionPolicyPath(dataDirectory);
  const loaded = await readOrCreateOwnerConfig(
    path,
    `${JSON.stringify(DEFAULT_RETENTION_POLICY, null, 2)}\n`,
  );
  return loaded.created
    ? DEFAULT_RETENTION_POLICY
    : Object.freeze(validateRetentionPolicy(JSON.parse(loaded.raw) as unknown));
}

export async function saveRetentionPolicy(
  policy: unknown,
  dataDirectory = defaultDataDirectory(),
): Promise<Readonly<RetentionPolicy>> {
  const validated = validateRetentionPolicy(policy);
  await atomicOwnerOnlyJson(retentionPolicyPath(dataDirectory), validated);
  return Object.freeze(validated);
}
