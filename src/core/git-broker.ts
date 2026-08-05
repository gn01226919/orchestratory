import { createHash } from "node:crypto";
import { open, readdir, readFile, stat, type FileHandle } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { canonicalWorkspace, resolveExistingInside } from "../security/workspace.ts";
import {
  minimalGitEnvironment,
  promotionGitEnvironment,
  resolveExecutable,
  runProcess,
} from "./process-runner.ts";

/**
 * Every executable that a merge in this repository can cause to run, with content hashes.
 *
 * A promotion is the first operation in this product that executes code out of `.git`, and it does
 * so as the owner, unsandboxed. That is a trust boundary, so it is measured rather than assumed:
 * the hook directory can be moved by `core.hooksPath`, and a linked candidate worktree shares the
 * common `.git`, which means an agent with a terminal could write both the config and the hook after
 * the owner looked at the preview. Binding this fingerprint into the approval is what makes that
 * substitution a drift refusal instead of an execution.
 */
export interface HookEnvironment {
  /** Where git says hooks come from, as configured. */
  hooksPath: string;
  /** Executable hooks present there, name and content hash, sorted. */
  hooks: Array<{ name: string; sha256: string; bytes: number }>;
  /** Configured merge drivers: `merge.<name>.driver` runs a command during a real merge. */
  drivers: string[];
  /** Configured clean/smudge filters, including LFS. Their presence is a refusal, not a warning. */
  filters: string[];
  /** True when the hook directory could not be listed; never reported as "no hooks". */
  unreadable: boolean;
  fingerprint: string;
}

/**
 * Everything a promotion records before it touches main, so that "put it back" can be VERIFIED
 * rather than assumed. Every field is observed; none is inferred from the fact that a command
 * returned zero.
 *
 * `ignoredFingerprint` covers CONTENT, not only paths. A path-only fingerprint was accepted as a
 * residual risk until a real-git measurement showed what it hides: main's `git status --porcelain`
 * is completely empty, `git merge` silently replaces the contents of an ignored file, exits zero,
 * and still reports a clean working tree afterwards — and the obvious rollback then deletes that
 * file rather than restoring it. Two steps that each look correct, one destroyed local secret.
 */
export interface GitRestorePoint {
  head: string;
  /** The same inspection the rest of the product uses, computed once and shared. */
  inspection: GitInspection;
  /** Ignored paths, so the owner can be shown WHICH files a merge would destroy, not a warning. */
  ignoredPaths: string[];
  /** Empty only when this working tree may receive a merge; see `PROMOTION_BLOCKERS`. */
  blockers: string[];
  clean: boolean;
  untrackedFiles: number;
  ignoredFiles: number;
  worktreeFingerprint: string;
  indexFingerprint: string;
  /** Paths AND content of untracked, non-ignored files. */
  untrackedFingerprint: string;
  /** Paths AND content of ignored files — the ones a merge destroys without saying anything. */
  ignoredFingerprint: string;
  stashDigest: string;
  stashEntries: number;
  reflogEntries: number;
  reflogDigest: string;
  hooks: HookEnvironment;
}

export interface GitInspection {
  root: string;
  clean: boolean;
  changedFiles: number;
  changedLines: number;
  changedBytes: number;
  untrackedFiles: number;
  statusSummary: string;
  fingerprint: string;
}

export const MAX_CHANGED_BYTES = 50 * 1024 * 1024;
const MAX_UNTRACKED_REVIEW_FILE_BYTES = 65_536;
const CONTENT_FINGERPRINT_TIMEOUT_MS = 30_000;
/** A promotion may run owner hooks, which can be slow; it may not run forever. */
export const MERGE_TIMEOUT_MS = 300_000;
/** Bounded pathspec for the overwrite scan; the caller's file list is already bounded below this. */
const MAX_OVERWRITE_PATHSPEC = 2_000;
/** Bounded hook inventory; an oversized one is reported as unreadable, never as "no hooks". */
const MAX_HOOK_FILES = 64;
/** Bounded ignored-path report. The fingerprint always covers every file; this list is the display. */
const MAX_REPORTED_IGNORED_PATHS = 500;
/**
 * Hard ceiling on one streamed inventory. Reaching it fails closed with its own code rather than
 * fingerprinting a prefix: a fingerprint over some of the files is not a fingerprint over the files.
 */
const MAX_INVENTORY_PATHS = 200_000;
const MAX_HOOK_BYTES = 1_048_576;
/**
 * Files whose presence in the git directory means a working tree is in the middle of an operation.
 * `AUTO_MERGE` and `MERGE_MSG` are included because they outlive some interruptions that leave no
 * `MERGE_HEAD` at all, and `index.lock` because a promotion must refuse rather than wait for it.
 */
const PROMOTION_STATE_FILES: ReadonlyArray<readonly [string, string]> = [
  ["MERGE_HEAD", "MAIN_MERGE_HEAD_PRESENT"],
  ["AUTO_MERGE", "MAIN_AUTO_MERGE_PRESENT"],
  ["MERGE_MSG", "MAIN_MERGE_MSG_PRESENT"],
  ["REBASE_HEAD", "MAIN_REBASE_IN_PROGRESS"],
  ["CHERRY_PICK_HEAD", "MAIN_CHERRY_PICK_IN_PROGRESS"],
  ["REVERT_HEAD", "MAIN_REVERT_IN_PROGRESS"],
  ["index.lock", "MAIN_INDEX_LOCKED"],
];
const SENSITIVE_UNTRACKED_PATH = /(?:^|\/)(?:\.env(?:\.[^/]*)?|[^/]+\.(?:pem|key|p12|pfx))$/iu;

export class GitBroker {
  async #git(
    workspace: string, args: string[], outputLimitBytes = 1_048_576,
    env: NodeJS.ProcessEnv = minimalGitEnvironment(),
  ): Promise<string> {
    const executable = await resolveExecutable("git");
    const result = await runProcess({
      executable,
      args,
      cwd: workspace,
      timeoutMs: 30_000,
      outputLimitBytes,
      env,
    });
    if (result.exitCode !== 0 || result.terminationReason) throw new Error("GIT_COMMAND_FAILED");
    return result.stdout;
  }

  async #paths(workspace: string, args: string[]): Promise<string[]> {
    const output = await this.#git(workspace, args);
    const paths = output.split("\0").filter(Boolean);
    if (paths.some((path) => path.includes("\uFFFD") || path.includes("\0"))) {
      throw new Error("UNSUPPORTED_GIT_PATH_ENCODING");
    }
    return paths;
  }

  async #streamStdout(workspace: string, args: string[], consume: (chunk: Buffer) => void): Promise<void> {
    const executable = await resolveExecutable("git");
    const result = await runProcess({
      executable,
      args,
      cwd: workspace,
      timeoutMs: 30_000,
      outputLimitBytes: 262_144,
      env: minimalGitEnvironment(),
      stdoutConsumer: consume,
    });
    if (result.exitCode !== 0 || result.terminationReason) throw new Error("GIT_COMMAND_FAILED");
  }

  async #statusInventory(workspace: string, fingerprint: ReturnType<typeof createHash>): Promise<{
    changedPaths: string[];
    untrackedPaths: string[];
    summary: string;
  }> {
    const decoder = new StringDecoder("utf8");
    const changedPaths: string[] = [];
    const untrackedPaths: string[] = [];
    const summary: string[] = [];
    let pending = "";
    let expectingRenameSource = false;
    const token = (value: string): void => {
      if (value.includes("\uFFFD")) throw new Error("UNSUPPORTED_GIT_PATH_ENCODING");
      if (expectingRenameSource) {
        if (!value) throw new Error("INVALID_GIT_STATUS_STREAM");
        expectingRenameSource = false;
        return;
      }
      if (value.length < 4 || value[2] !== " ") throw new Error("INVALID_GIT_STATUS_STREAM");
      const code = value.slice(0, 2);
      const path = value.slice(3);
      if (!path) throw new Error("INVALID_GIT_STATUS_STREAM");
      if (code === "!!") return;
      changedPaths.push(path);
      if (code === "??") untrackedPaths.push(path);
      if (summary.length < 100) summary.push(`${code} ${JSON.stringify(path)}`);
      expectingRenameSource = code.includes("R") || code.includes("C");
    };
    const consume = (chunk: Buffer): void => {
      fingerprint.update(chunk);
      pending += decoder.write(chunk);
      for (;;) {
        const boundary = pending.indexOf("\0");
        if (boundary < 0) return;
        token(pending.slice(0, boundary));
        pending = pending.slice(boundary + 1);
      }
    };
    await this.#streamStdout(workspace, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], consume);
    pending += decoder.end();
    if (pending.length > 0 || expectingRenameSource) throw new Error("INVALID_GIT_STATUS_STREAM");
    return { changedPaths, untrackedPaths, summary: summary.join("\n") };
  }

  async #numstatLines(
    workspace: string,
    args: string[],
    fingerprint: ReturnType<typeof createHash>,
  ): Promise<number> {
    const decoder = new StringDecoder("utf8");
    let pending = "";
    let lines = 0;
    const token = (value: string): void => {
      if (value.includes("\uFFFD")) throw new Error("UNSUPPORTED_GIT_PATH_ENCODING");
      const firstTab = value.indexOf("\t");
      const secondTab = firstTab < 0 ? -1 : value.indexOf("\t", firstTab + 1);
      if (firstTab < 0 || secondTab < 0) return;
      const added = value.slice(0, firstTab);
      const removed = value.slice(firstTab + 1, secondTab);
      if (/^\d+$/u.test(added)) lines += Number(added);
      if (/^\d+$/u.test(removed)) lines += Number(removed);
    };
    const consume = (chunk: Buffer): void => {
      fingerprint.update(chunk);
      pending += decoder.write(chunk);
      for (;;) {
        const boundary = pending.indexOf("\0");
        if (boundary < 0) return;
        token(pending.slice(0, boundary));
        pending = pending.slice(boundary + 1);
      }
    };
    await this.#streamStdout(workspace, [...args, "-z"], consume);
    pending += decoder.end();
    if (pending.length > 0) throw new Error("INVALID_GIT_NUMSTAT_STREAM");
    return lines;
  }

  async #existingFile(workspace: string, path: string): Promise<{ absolute: string; size: number } | undefined> {
    try {
      const absolute = await resolveExistingInside(workspace, path);
      const info = await stat(absolute);
      if (info.isFile() && info.nlink > 1) throw new Error("HARDLINK_CHANGED_FILE_DENIED");
      return info.isFile() ? { absolute, size: info.size } : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async #contentFingerprint(
    workspace: string,
    path: string,
    deadlineMs: number,
  ): Promise<{ size: number; digest: string } | undefined> {
    let handle: FileHandle | undefined;
    try {
      const absolute = await resolveExistingInside(workspace, path);
      handle = await open(absolute, "r");
      const before = await handle.stat({ bigint: true });
      if (!before.isFile()) return undefined;
      if (before.nlink > 1) throw new Error("HARDLINK_CHANGED_FILE_DENIED");
      const content = createHash("sha256");
      const remainingMs = deadlineMs - Date.now();
      if (remainingMs <= 0) throw new Error("GIT_CONTENT_FINGERPRINT_TIMEOUT");
      const stream = handle.createReadStream({ autoClose: false });
      const timeout = setTimeout(() => {
        stream.destroy(new Error("GIT_CONTENT_FINGERPRINT_TIMEOUT"));
      }, remainingMs);
      timeout.unref();
      try {
        for await (const chunk of stream) content.update(chunk);
      } finally {
        clearTimeout(timeout);
      }
      const after = await handle.stat({ bigint: true });
      if (
        before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
      ) throw new Error("GIT_FILE_CHANGED_DURING_INSPECTION");
      const size = Number(before.size);
      if (!Number.isSafeInteger(size)) throw new Error("GIT_FILE_SIZE_UNSUPPORTED");
      return { size, digest: content.digest("hex") };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    } finally {
      await handle?.close();
    }
  }

  async inspect(workspaceInput: string): Promise<GitInspection> {
    const workspace = await canonicalWorkspace(workspaceInput);
    const root = (await this.#git(workspace, ["rev-parse", "--show-toplevel"], 16_384)).trim();
    if ((await canonicalWorkspace(root)) !== workspace) throw new Error("WORKSPACE_MUST_BE_GIT_ROOT");
    const fingerprintHash = createHash("sha256").update("orchestratory.git-inspection.v2\0status\0");
    const status = await this.#statusInventory(workspace, fingerprintHash);
    fingerprintHash.update("\0numstat\0");
    let changedLines = await this.#numstatLines(
      workspace, ["diff", "--no-ext-diff", "--numstat"], fingerprintHash,
    );
    fingerprintHash.update("\0cached-numstat\0");
    changedLines += await this.#numstatLines(
      workspace, ["diff", "--cached", "--no-ext-diff", "--numstat"], fingerprintHash,
    );
    const untrackedPaths = status.untrackedPaths;
    const changedPaths = [...new Set(status.changedPaths)].sort();
    const contentFingerprintDeadline = Date.now() + CONTENT_FINGERPRINT_TIMEOUT_MS;
    let changedBytes = 0;
    fingerprintHash.update("\0content\0");
    for (const path of changedPaths) {
      fingerprintHash.update(path).update("\0");
      const file = await this.#contentFingerprint(workspace, path, contentFingerprintDeadline);
      if (!file) continue;
      changedBytes += file.size;
      fingerprintHash.update(String(file.size)).update("\0").update(file.digest).update("\0");
    }
    return {
      root,
      clean: changedPaths.length === 0,
      changedFiles: changedPaths.length,
      changedLines,
      changedBytes,
      untrackedFiles: untrackedPaths.length,
      statusSummary: status.summary,
      fingerprint: fingerprintHash.digest("hex"),
    };
  }

  async headSha(workspaceInput: string): Promise<string> {
    const workspace = await canonicalWorkspace(workspaceInput);
    const value = (await this.#git(workspace, ["rev-parse", "--verify", "HEAD^{commit}"], 16_384)).trim();
    if (!/^[0-9a-f]{40,64}$/u.test(value)) throw new Error("INVALID_GIT_HEAD");
    return value;
  }

  /** Resolves a path inside this working tree's git directory, honouring linked worktrees. */
  async #gitPath(workspace: string, name: string, env?: NodeJS.ProcessEnv): Promise<string> {
    if (!/^[A-Za-z0-9_.-]+$/u.test(name)) throw new Error("INVALID_GIT_PATH_NAME");
    // `--git-path hooks` honours `core.hooksPath`, so which environment asks matters: asked under
    // the read-only environment it answers `/dev/null`, which is this product's own guard rather
    // than the repository's configuration, and would report every repository as having no hooks.
    const value = (await this.#git(workspace, ["rev-parse", "--git-path", name], 16_384, env)).trim();
    if (!value) throw new Error("GIT_COMMAND_FAILED");
    return isAbsolute(value) ? value : join(workspace, value);
  }

  async #present(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  /**
   * Paths and CONTENT of a set of files, as one fingerprint. Used for the untracked and ignored
   * inventories, where the path alone says nothing about what a merge is about to destroy.
   *
   * It shares the same wall-clock deadline as every other content hash in this class, and a deadline
   * that runs out throws rather than returning a shorter answer: a fingerprint over some of the
   * files is not a fingerprint over the files.
   */
  async #pathContentFingerprint(
    workspace: string, args: string[], deadlineMs: number, label: string,
  ): Promise<{ files: number; fingerprint: string; paths: string[] }> {
    // Streamed, not captured. The captured form has a 1 MiB ceiling, and a repository with tens of
    // thousands of ignored files exceeds it — which would turn a safety gate into a hard failure on
    // exactly the large repositories it matters most for (the shape PITFALLS #43 already recorded).
    const paths: string[] = [];
    const decoder = new StringDecoder("utf8");
    let pending = "";
    await this.#streamStdout(workspace, args, (chunk) => {
      pending += decoder.write(chunk);
      for (;;) {
        const boundary = pending.indexOf("\0");
        if (boundary < 0) return;
        const path = pending.slice(0, boundary);
        pending = pending.slice(boundary + 1);
        if (!path) continue;
        if (path.includes("�")) throw new Error("UNSUPPORTED_GIT_PATH_ENCODING");
        if (paths.length >= MAX_INVENTORY_PATHS) throw new Error("GIT_INVENTORY_TOO_LARGE");
        paths.push(path);
      }
    });
    pending += decoder.end();
    if (pending.length > 0) throw new Error("INVALID_GIT_PATH_STREAM");
    paths.sort();
    const hash = createHash("sha256").update(label).update("\0");
    for (const path of paths) {
      hash.update(path, "utf8").update("\0");
      const file = await this.#contentFingerprint(workspace, path, deadlineMs);
      // An entry git listed but that is not a readable regular file right now is recorded as such,
      // never skipped: skipping would make an appearing or disappearing file invisible.
      if (!file) {
        hash.update("absent").update("\0");
        continue;
      }
      hash.update(String(file.size)).update("\0").update(file.digest).update("\0");
    }
    return { files: paths.length, fingerprint: hash.digest("hex"), paths };
  }

  /**
   * Every hook, merge driver and filter this repository would run, with content hashes.
   *
   * Failure to list the directory sets `unreadable` rather than producing an empty list, because
   * "there are no hooks" and "I could not look" lead to opposite decisions.
   */
  async hookEnvironment(workspaceInput: string): Promise<HookEnvironment> {
    const workspace = await canonicalWorkspace(workspaceInput);
    // Measured under the environment the PROMOTION will use, not the read-only one. Every other Git
    // command in this product pins `core.hooksPath=/dev/null` so that inspecting a repository never
    // runs its code — read that way, this function would faithfully report the product's own guard
    // instead of the owner's configuration, and conclude there are no hooks. What has to be reported
    // here is what will actually execute.
    const promotionEnv = promotionGitEnvironment();
    const config = await this.#git(workspace, ["config", "--list", "-z"], 1_048_576, promotionEnv);
    const entries = config.split("\0").filter(Boolean).map((entry) => {
      const boundary = entry.indexOf("\n");
      return boundary < 0 ? { key: entry, value: "" } : { key: entry.slice(0, boundary), value: entry.slice(boundary + 1) };
    });
    const configured = (test: RegExp): string[] =>
      entries.filter((entry) => test.test(entry.key)).map((entry) => `${entry.key}=${entry.value}`).sort();
    const hooksPathEntry = entries.find((entry) => entry.key === "core.hookspath");
    const hooksPath = hooksPathEntry?.value ?? "";
    const directory = hooksPath === ""
      ? await this.#gitPath(workspace, "hooks", promotionEnv)
      : (isAbsolute(hooksPath) ? hooksPath : join(workspace, hooksPath));
    // git treats a hooks path it cannot read as "no hooks" and proceeds. So does this, but it says
    // so: `/dev/null` and a deleted directory are both "nothing will run", and both are reported as
    // an explicit empty inventory rather than as an unreadable one.
    const absent = await stat(directory).then((info) => !info.isDirectory()).catch(() => true);
    const hooks: HookEnvironment["hooks"] = [];
    let unreadable = false;
    if (!absent) try {
      const names = (await readdir(directory)).filter((name) => !name.endsWith(".sample")).sort();
      if (names.length > MAX_HOOK_FILES) throw new Error("TOO_MANY_HOOKS");
      for (const name of names) {
        const info = await stat(join(directory, name)).catch(() => undefined);
        // Only files git could actually execute are reported; a non-executable file in the hook
        // directory cannot run, and reporting it would bury the ones that can.
        if (!info?.isFile() || (info.mode & 0o111) === 0) continue;
        if (info.size > MAX_HOOK_BYTES) throw new Error("HOOK_TOO_LARGE");
        hooks.push({
          name,
          bytes: info.size,
          sha256: createHash("sha256").update(await readFile(join(directory, name))).digest("hex"),
        });
      }
    } catch {
      unreadable = true;
    }
    const drivers = configured(/^merge\..+\.driver$/u);
    const filters = [...configured(/^filter\..+\.(?:clean|smudge|process)$/u)];
    return {
      hooksPath,
      hooks,
      drivers,
      filters,
      unreadable,
      fingerprint: createHash("sha256")
        .update(JSON.stringify([hooksPath, hooks, drivers, filters, unreadable]), "utf8")
        .digest("hex"),
    };
  }

  /**
   * Everything about a working tree that a promotion must be able to put back exactly as it found it,
   * plus every reason it may not receive a merge at all.
   *
   * "Clean" is defined here and nowhere else, because the obvious definition is measurably wrong:
   * `git update-index --skip-worktree` leaves `git status --porcelain` completely empty while a real
   * merge aborts with exit 2, and does so identically on every retry — a state in which "recover the
   * environment and it succeeds" can never become true. So the gate is a list of named conditions,
   * each of which is a refusal before anything is spent.
   */
  async restorePoint(workspaceInput: string): Promise<GitRestorePoint> {
    const workspace = await canonicalWorkspace(workspaceInput);
    const inspection = await this.inspect(workspace);
    const deadline = Date.now() + CONTENT_FINGERPRINT_TIMEOUT_MS;
    const [head, stash, reflog, indexFlags] = await Promise.all([
      this.headSha(workspace),
      this.#git(workspace, ["stash", "list", "--format=%H"], 262_144),
      this.#git(workspace, ["reflog", "show", "--format=%H %gs", "HEAD"], 1_048_576),
      this.#git(workspace, ["ls-files", "-v"], 8_388_608),
    ]);
    const untracked = await this.#pathContentFingerprint(
      workspace, ["ls-files", "--others", "--exclude-standard", "-z"], deadline, "untracked",
    );
    const ignored = await this.#pathContentFingerprint(
      workspace, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"], deadline, "ignored",
    );
    const hooks = await this.hookEnvironment(workspace);
    const blockers: string[] = [];
    // Equivalent to `git status --porcelain` being non-empty, derived from the streamed inspection
    // rather than from a second captured command: on a repository with tens of thousands of
    // untracked files the captured form blows its output ceiling and turns a gate into an outage.
    if (!inspection.clean || inspection.untrackedFiles > 0) blockers.push("MAIN_STATUS_NOT_EMPTY");
    // `ls-files -v` marks skip-worktree with `S` and assume-unchanged with a lowercase tag. Both make
    // `status` lie about the working tree, and both make a real merge fail the same way every time.
    if (indexFlags.split("\n").some((line) => /^(?:S|[a-z]) /u.test(line))) {
      blockers.push("MAIN_INDEX_HAS_SKIPPED_ENTRIES");
    }
    for (const [name, code] of PROMOTION_STATE_FILES) {
      if (await this.#present(await this.#gitPath(workspace, name))) blockers.push(code);
    }
    const sparse = (await this.#git(workspace, ["config", "--get", "core.sparseCheckout"], 4_096).catch(() => "")).trim();
    if (sparse === "true") blockers.push("MAIN_SPARSE_CHECKOUT_ENABLED");
    if (await this.#present(join(workspace, ".gitmodules"))) blockers.push("MAIN_HAS_SUBMODULES");
    if (hooks.filters.length > 0) blockers.push("MAIN_HAS_CONTENT_FILTERS");
    if (hooks.unreadable) blockers.push("MAIN_HOOK_DIRECTORY_UNREADABLE");
    const attributes = await readFile(join(workspace, ".gitattributes"), "utf8").catch(() => "");
    if (/(?:^|\s)filter=/mu.test(attributes)) blockers.push("MAIN_ATTRIBUTES_DECLARE_FILTER");
    const reflogEntries = reflog.split("\n").filter(Boolean);
    return {
      head,
      inspection,
      ignoredPaths: ignored.paths.slice(0, MAX_REPORTED_IGNORED_PATHS),
      blockers,
      clean: blockers.length === 0,
      untrackedFiles: untracked.files,
      ignoredFiles: ignored.files,
      worktreeFingerprint: inspection.fingerprint,
      // The index itself — mode, object id, stage and path for every entry. Deliberately NOT
      // `git write-tree`, which would be a write: it can create objects and take `index.lock`, and
      // this fingerprint has to be readable during a strictly read-only crash reconciliation.
      indexFingerprint: createHash("sha256")
        .update(await this.#git(workspace, ["ls-files", "--stage", "-z"], 4_194_304), "utf8")
        .digest("hex"),
      untrackedFingerprint: untracked.fingerprint,
      ignoredFingerprint: ignored.fingerprint,
      stashDigest: createHash("sha256").update(stash, "utf8").digest("hex"),
      stashEntries: stash.split("\n").filter(Boolean).length,
      reflogEntries: reflogEntries.length,
      // The whole log, not a count: an append-only log that grew by one is intact, while one whose
      // older entries were rewritten has lost the recovery path even if the count happens to match.
      reflogDigest: createHash("sha256").update(reflogEntries.join("\n"), "utf8").digest("hex"),
      hooks,
    };
  }

  /**
   * Names every aspect in which main now differs from a recorded restore point.
   *
   * This is what a crashed promotion reports instead of acting. It runs no writing Git command at
   * all: after a `kill -9` during a hook the index and working tree can be fully rewritten while
   * HEAD has not moved and no `MERGE_HEAD` exists, which is bit-for-bit indistinguishable from work
   * the owner staged themselves — so the only safe response is to say exactly what moved and let the
   * owner decide.
   */
  async differencesFrom(workspaceInput: string, point: GitRestorePoint): Promise<string[]> {
    const now = await this.restorePoint(workspaceInput);
    const differences: string[] = [];
    const compare = (label: string, before: unknown, after: unknown): void => {
      if (before !== after) differences.push(label);
    };
    compare("HEAD", point.head, now.head);
    compare("index", point.indexFingerprint, now.indexFingerprint);
    compare("trackedWorkingTree", point.worktreeFingerprint, now.worktreeFingerprint);
    compare("untrackedFiles", point.untrackedFingerprint, now.untrackedFingerprint);
    compare("ignoredFiles", point.ignoredFingerprint, now.ignoredFingerprint);
    compare("stash", point.stashDigest, now.stashDigest);
    compare("hookEnvironment", point.hooks.fingerprint, now.hooks.fingerprint);
    if (!await this.reflogPreserves(workspaceInput, point.reflogEntries, point.reflogDigest)) {
      differences.push("reflog");
    }
    for (const [name, code] of PROMOTION_STATE_FILES) {
      if (await this.#present(await this.#gitPath(await canonicalWorkspace(workspaceInput), name))) {
        differences.push(`leftover:${code}`);
      }
    }
    return differences;
  }

  /**
   * Whether every reflog entry recorded before an attempt is still present, unmodified, in order.
   *
   * A reflog is append-only, so an attempt that was undone still leaves its own entries behind and
   * exact equality is unachievable — measured, not assumed: an aborted merge adds exactly one HEAD
   * entry. What CAN be required is that nothing was removed or rewritten, which is what makes the
   * pre-promotion commit still reachable and therefore what the owner's recovery path depends on.
   * `git reflog show` prints newest first, so the recorded entries are the tail. The format is the
   * commit and the reflog SUBJECT, deliberately not the selector: `HEAD@{0}` renumbers every time an
   * entry is appended, so a selector-based digest reports an intact log as rewritten.
   */
  async reflogPreserves(workspaceInput: string, entries: number, digest: string): Promise<boolean> {
    if (!Number.isSafeInteger(entries) || entries < 0) throw new Error("INVALID_REFLOG_BASELINE");
    const workspace = await canonicalWorkspace(workspaceInput);
    const current = (await this.#git(workspace, ["reflog", "show", "--format=%H %gs", "HEAD"], 1_048_576))
      .split("\n").filter(Boolean);
    if (current.length < entries) return false;
    const tail = current.slice(current.length - entries);
    return createHash("sha256").update(tail.join("\n"), "utf8").digest("hex") === digest;
  }

  /** Whether this working tree is sitting in the middle of a merge git could not finish. */
  async mergeInProgress(workspaceInput: string): Promise<boolean> {
    const workspace = await canonicalWorkspace(workspaceInput);
    const result = await runProcess({
      executable: await resolveExecutable("git"),
      args: ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"],
      cwd: workspace,
      timeoutMs: 30_000,
      outputLimitBytes: 16_384,
      env: minimalGitEnvironment(),
    });
    if (result.terminationReason) throw new Error("GIT_COMMAND_FAILED");
    if (result.exitCode === 0) return true;
    if (result.exitCode === 1) return false;
    throw new Error("GIT_COMMAND_FAILED");
  }

  /** The parent commits of one commit, used to prove a merge commit is the one that was authorized. */
  async commitParents(workspaceInput: string, commit: string): Promise<string[]> {
    if (!/^[0-9a-f]{40,64}$/u.test(commit)) throw new Error("INVALID_GIT_HEAD");
    const workspace = await canonicalWorkspace(workspaceInput);
    const value = await this.#git(workspace, ["rev-list", "--parents", "-n", "1", commit], 16_384);
    const parts = value.trim().split(" ");
    if (parts.length < 1 || parts.some((part) => !/^[0-9a-f]{40,64}$/u.test(part))) {
      throw new Error("GIT_COMMAND_FAILED");
    }
    return parts.slice(1);
  }

  /**
   * Paths that already exist in this working tree without being tracked, restricted to a bounded
   * pathspec. Ignored and merely-untracked are reported separately because git treats them
   * differently and only one of them is silent: a merge REFUSES to clobber an untracked file, and
   * SILENTLY overwrites an ignored one.
   */
  async untrackedAtPaths(workspaceInput: string, paths: readonly string[]): Promise<{
    ignored: string[];
    untracked: string[];
  }> {
    if (paths.length === 0) return { ignored: [], untracked: [] };
    if (paths.length > MAX_OVERWRITE_PATHSPEC) throw new Error("OVERWRITE_PATHSPEC_TOO_LARGE");
    if (paths.some((path) => path.length === 0 || path.includes("\0") || path.startsWith("-"))) {
      throw new Error("INVALID_GIT_PATHSPEC");
    }
    const workspace = await canonicalWorkspace(workspaceInput);
    const scan = async (extra: string[]): Promise<string[]> => {
      const output = await this.#paths(workspace, [
        "ls-files", "--others", "--exclude-standard", "-z", ...extra, "--", ...paths,
      ]);
      return [...new Set(output)].sort();
    };
    return { ignored: await scan(["--ignored"]), untracked: await scan([]) };
  }

  /**
   * The one command in this product that writes to canonical main.
   *
   * `--no-ff` always, so the promotion is a single revertable commit with the pre-promotion head as
   * its first parent even when a fast-forward was possible; `--no-edit` so no editor is ever spawned;
   * and repository hooks deliberately enabled (see `promotionGitEnvironment`). Output is discarded
   * rather than returned: it is untrusted repository text, and the caller decides what happened by
   * observing the repository afterwards, never by reading git's prose.
   */
  async mergeIntoHead(workspaceInput: string, commit: string, timeoutMs = MERGE_TIMEOUT_MS): Promise<{
    exitCode: number;
    timedOut: boolean;
  }> {
    if (!/^[0-9a-f]{40,64}$/u.test(commit)) throw new Error("INVALID_GIT_HEAD");
    const workspace = await canonicalWorkspace(workspaceInput);
    const result = await runProcess({
      executable: await resolveExecutable("git"),
      args: ["merge", "--no-ff", "--no-edit", commit],
      cwd: workspace,
      timeoutMs,
      outputLimitBytes: 262_144,
      env: promotionGitEnvironment(),
    });
    return { exitCode: result.exitCode, timedOut: result.terminationReason === "timeout" };
  }

  /** Undoes a merge git left in progress. Hooks stay disabled: aborting is not the owner's merge. */
  async abortMerge(workspaceInput: string): Promise<boolean> {
    const workspace = await canonicalWorkspace(workspaceInput);
    const result = await runProcess({
      executable: await resolveExecutable("git"),
      args: ["merge", "--abort"],
      cwd: workspace,
      timeoutMs: 120_000,
      outputLimitBytes: 65_536,
      env: minimalGitEnvironment(),
    });
    return result.exitCode === 0 && !result.terminationReason;
  }

  async #untrackedContext(workspace: string, outputLimitBytes: number): Promise<string> {
    const paths = await this.#paths(workspace, ["ls-files", "--others", "--exclude-standard", "-z"]);
    const sections: string[] = [];
    let bytes = 0;
    for (const path of paths) {
      if (SENSITIVE_UNTRACKED_PATH.test(path)) throw new Error("SENSITIVE_UNTRACKED_PATH_DENIED");
      const file = await this.#existingFile(workspace, path);
      if (!file) continue;
      if (file.size > MAX_UNTRACKED_REVIEW_FILE_BYTES) {
        throw new Error("UNTRACKED_REVIEW_FILE_TOO_LARGE");
      }
      const content = await readFile(file.absolute);
      const section = content.includes(0)
        ? `Untracked binary file: ${path} (${file.size} bytes; content omitted)`
        : `Untracked text file: ${path}\n${content.toString("utf8")}`;
      bytes += Buffer.byteLength(section);
      if (bytes > outputLimitBytes) throw new Error("UNTRACKED_REVIEW_CONTEXT_TOO_LARGE");
      sections.push(section);
    }
    return sections.length > 0 ? sections.join("\n\n---\n\n") : "no untracked files";
  }

  async reviewContext(workspaceInput: string, outputLimitBytes = 524_288): Promise<string> {
    const workspace = await canonicalWorkspace(workspaceInput);
    const inspection = await this.inspect(workspace);
    const diff = await this.#git(
      workspace,
      ["diff", "HEAD", "--no-ext-diff", "--no-color", "--src-prefix=a/", "--dst-prefix=b/"],
      Math.max(65_536, Math.floor(outputLimitBytes * 0.7)),
    );
    const untracked = await this.#untrackedContext(
      workspace,
      Math.max(32_768, Math.floor(outputLimitBytes * 0.3)),
    );
    return [
      "Git status (untrusted repository data):",
      inspection.statusSummary || "clean",
      "Tracked diff (untrusted repository data):",
      diff || "no tracked diff",
      "Bounded untracked file context (untrusted repository data):",
      untracked,
    ].join("\n\n");
  }
}
