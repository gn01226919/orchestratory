import { chmod, lstat, mkdir, open, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { constants, realpathSync, statSync } from "node:fs";
import type { Stats } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
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

/**
 * Where every store lives. Overridable, and the override is validated rather than trusted.
 *
 * Why an override exists at all: a working tree and an installed runtime resolved to the SAME
 * directory, so the moment a development build opened it and applied a newer migration, every
 * installed runtime was locked out of it -- correctly, because refusing an unknown schema is the
 * safe answer, but the lockout took down the whole product for every session on the machine. The
 * fix for that class is not a looser schema check; it is giving development its own state.
 *
 * Why the override is checked: an absolute-path environment variable is an input, and this one
 * decides where credentials-adjacent state, the append-only ledger and the approval records are
 * read from and written to. The threat is not a remote attacker -- anyone who can set your
 * environment already runs as you. It is the ordinary mistake: a typo, a stale export in a shell
 * profile, a path that resolves somewhere with existing contents.
 *
 * An invalid value THROWS. It deliberately does not fall back to the default, because the failure
 * that would cause is the exact one being fixed: a developer who believes they are isolated, is
 * not, and finds out by migrating the production database.
 */
export const DATA_DIRECTORY_ENVIRONMENT_KEY = "ORCHESTRATORY_DATA_DIR";

export function defaultDataDirectory(environment: NodeJS.ProcessEnv = process.env): string {
  const override = environment[DATA_DIRECTORY_ENVIRONMENT_KEY];
  if (override === undefined || override === "") {
    return join(homedir(), "Library", "Application Support", "Orchestratory");
  }
  return assertDataDirectoryOverride(override);
}

/**
 * The checks, in the order a wrong value is most likely to be wrong.
 *
 * `resolve` collapses `..` before anything is compared, so a path is judged by where it lands
 * rather than by how it was spelled. Everything after that is about landing somewhere that is
 * plausibly a data directory and not somewhere whose contents belong to someone else.
 */
export function assertDataDirectoryOverride(value: string): string {
  if (value.includes("\0")) throw new Error(
      `INVALID_DATA_DIRECTORY:NUL_BYTE — ${DATA_DIRECTORY_ENVIRONMENT_KEY} 路徑不能含 NUL 位元組。`
      + "未設定這個變數時會使用預設位置；設錯不會靜默退回預設。",
    );
  if (!isAbsolute(value)) throw new Error(
      `INVALID_DATA_DIRECTORY:NOT_ABSOLUTE — ${DATA_DIRECTORY_ENVIRONMENT_KEY} 路徑必須是絕對路徑，例如 /Users/example/orchestratory-dev。`
      + "未設定這個變數時會使用預設位置；設錯不會靜默退回預設。",
    );

  /*
   * Resolve links before judging, and judge the resolved form.
   *
   * The first version compared the string after `resolve`, which collapses `..` but knows nothing
   * about the filesystem. Two bypasses were measured on macOS, not argued: `/private/var/db` passed
   * while `/var/db` was refused, because `/var` is a symlink to it and only one spelling was in the
   * list; and `/SYSTEM`, `/Etc` and `/USR/local` all passed on a case-insensitive volume that treats
   * them as the very directories being refused.
   *
   * The target may not exist yet -- that is the ordinary case for a fresh data directory -- so the
   * deepest ancestor that DOES exist is resolved and the remainder appended. That also closes the
   * case of a symlinked parent with a not-yet-created leaf.
   */
  const requested = resolve(value);
  let existing = requested;
  const trailing: string[] = [];
  for (;;) {
    try {
      existing = realpathSync(existing);
      break;
    } catch (error) {
      /*
       * ENOENT is the only failure that means "keep looking further up". Everything else means the
       * resolution did not happen, and walking up on those turns the whole check into the string
       * comparison it replaced: the loop climbs to `/`, `realpathSync("/")` always succeeds, and
       * `canonical` comes out as plain `resolve(value)` with no symlink resolved anywhere in it.
       *
       * That is not a theoretical path. A data directory on a network volume answers EIO or ESTALE
       * during an ordinary reconnect; ELOOP, ENOTDIR and ENAMETOOLONG are answers about the path
       * itself. In every one of those the earlier symlink bypass comes back whole, and nothing had
       * to go wrong on purpose for it to happen -- one transient read is enough.
       */
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code !== "ENOENT") {
        /*
         * The errno and how deep the walk got, never the path itself. The first version of this
         * message interpolated `existing`, which is an absolute path -- written, of all rounds, in
         * the one that was removing paths from error messages elsewhere. The repository scanner
         * could not see it because nothing in the source is a path; it only becomes one at runtime.
         *
         * The depth is what the reader actually needs: they set the value, so they know the string,
         * and "the third segment answered EACCES" tells them which parent to look at without this
         * process repeating anything back.
         */
        const depth = trailing.length + 1;
        throw new Error(
          `INVALID_DATA_DIRECTORY:UNRESOLVABLE — ${DATA_DIRECTORY_ENVIRONMENT_KEY} 的路徑無法解析：`
          + `從尾端數來第 ${depth} 段回報 ${code ?? "未知錯誤"}。這不是「還沒建立」，而是「查不下去」，`
          + "所以不能假設它安全。請確認該層的拼寫與權限，以及外接或網路磁碟是否已掛載。"
          + "（訊息刻意不回吐路徑；`orchestratory data inventory` 會在本機顯示解析結果。）"
          + "未設定這個變數時會使用預設位置；設錯不會靜默退回預設。",
        );
      }
      const parent = dirname(existing);
      /* `dirname("/") === "/"`: nothing above the root exists to resolve, so stop rather than loop. */
      if (parent === existing) break;
      /* `basename`, not a slice by the parent's length: at the filesystem root the parent is "/",
         whose length already counts the separator, so `parent.length + 1` ate the first character
         of the child and turned /etcetera into /tcetera. Only reachable one level below the root,
         which is exactly where a test found it. */
      trailing.unshift(basename(existing));
      existing = parent;
    }
  }
  const canonical = trailing.length > 0 ? join(existing, ...trailing) : existing;

  if (canonical === "/") throw new Error(
      `INVALID_DATA_DIRECTORY:FILESYSTEM_ROOT — ${DATA_DIRECTORY_ENVIRONMENT_KEY} 不能是檔案系統根目錄。`
      + "未設定這個變數時會使用預設位置；設錯不會靜默退回預設。",
    );

  /* Home is compared resolved too: a home directory reached through a symlinked volume is still
     the home directory, and every later `join` would write into somebody's own files. */
  let home = homedir();
  try {
    home = realpathSync(home);
  } catch (error) {
    /* A home that will not resolve is not a reason to compare against the unresolved spelling and
       call the difference a pass: that is exactly how a symlinked home would slip through. */
    if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
      throw new Error(
        `INVALID_DATA_DIRECTORY:HOME_UNRESOLVABLE — 無法解析家目錄，因此無法確認 `
        + `${DATA_DIRECTORY_ENVIRONMENT_KEY} 不是家目錄本身。這是環境問題，不是設定值的問題。`,
      );
    }
  }
  if (canonical === home) throw new Error(
      `INVALID_DATA_DIRECTORY:HOME_ROOT — ${DATA_DIRECTORY_ENVIRONMENT_KEY} 不能是家目錄本身；家目錄底下的子目錄可以。`
      + "未設定這個變數時會使用預設位置；設錯不會靜默退回預設。",
    );

  /*
   * Directories the operating system owns. Compared case-insensitively because the volume this runs
   * on usually is: on a case-insensitive filesystem `/SYSTEM` and `/System` name one directory, and
   * a check that distinguishes them refuses one spelling of a path it has already decided is
   * forbidden. Case-folding is the conservative direction -- it can only refuse more.
   */
  const RESERVED = [
    "/System", "/Library", "/usr", "/bin", "/sbin", "/etc", "/var", "/opt", "/cores",
    "/private/etc", "/private/var", "/Applications", "/Volumes/Preboot",
  ];
  const folded = canonical.toLowerCase();
  for (const reserved of RESERVED) {
    const target = reserved.toLowerCase();
    if (folded === target || folded.startsWith(`${target}/`)) {
      throw new Error(
      `INVALID_DATA_DIRECTORY:SYSTEM_PATH — ${DATA_DIRECTORY_ENVIRONMENT_KEY} 不能落在作業系統擁有的目錄（/System、/usr、/etc、/var…）。`
      + "未設定這個變數時會使用預設位置；設錯不會靜默退回預設。",
    );
    }
  }

  /*
   * What this does NOT establish, said plainly because the previous version's comment claimed more
   * than it held: resolving a path is a read, and the filesystem can change between this check and
   * the moment a store opens a file there. Closing that needs `O_NOFOLLOW` and directory-relative
   * opens in every store, which is a change to how files are opened rather than to how a path is
   * judged. Recorded as residual in docs/DECISIONS.md rather than implied to be handled.
   */
  /*
   * Ownership, checked here so the refusal happens where the value was set.
   *
   * This adds no security. `assertOwnerDirectory` in sqlite-security.ts already refuses a directory
   * that is not yours or not 0700, and it does so at the moment a store opens the file, which is the
   * only moment that can be authoritative -- this check and that one are separated by exactly the
   * TOCTOU window ADR-045 records as unclosed. What it adds is the difference between being told
   * `UNSAFE_SQLITE_DIRECTORY` several layers into startup and being told, at the variable, that the
   * directory belongs to somebody else.
   *
   * A path that does not exist yet is the ordinary case and passes: the store creates it with 0700.
   */
  let existingTarget: Stats | undefined;
  try {
    existingTarget = statSync(canonical);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
      throw new Error(
        `INVALID_DATA_DIRECTORY:UNREADABLE — 無法讀取 ${DATA_DIRECTORY_ENVIRONMENT_KEY} 指向的位置。`
        + "請確認父目錄權限與磁碟是否已掛載。未設定這個變數時會使用預設位置；設錯不會靜默退回預設。",
      );
    }
  }
  if (existingTarget !== undefined) {
    if (!existingTarget.isDirectory()) {
      throw new Error(
        `INVALID_DATA_DIRECTORY:NOT_A_DIRECTORY — ${DATA_DIRECTORY_ENVIRONMENT_KEY} 指向的是一個已存在`
        + "的非目錄項目。請改指向一個目錄，或換一個尚未使用的路徑。",
      );
    }
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (uid !== undefined && existingTarget.uid !== uid) {
      throw new Error(
        `INVALID_DATA_DIRECTORY:NOT_OWNED — ${DATA_DIRECTORY_ENVIRONMENT_KEY} 指向的目錄屬於其他使用者。`
        + "資料目錄必須由執行這個程式的帳號擁有；若這個目錄曾經以 sudo 建立，它會屬於 root。",
      );
    }
    if ((existingTarget.mode & 0o077) !== 0) {
      throw new Error(
        `INVALID_DATA_DIRECTORY:TOO_PERMISSIVE — ${DATA_DIRECTORY_ENVIRONMENT_KEY} 指向的目錄開放了`
        + "群組或其他使用者的權限。資料目錄必須是 0700；請執行 chmod 700 後重試。",
      );
    }
  }

  return canonical;
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
