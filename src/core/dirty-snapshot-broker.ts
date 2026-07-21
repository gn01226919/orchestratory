import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";
import { canonicalWorkspace } from "../security/workspace.ts";
import { WORKSPACE_SENSITIVE_PATH, WorkspaceToolBroker } from "../mcp/workspace-server.ts";
import { GitBroker } from "./git-broker.ts";
import { minimalGitEnvironment, resolveExecutable, runProcess } from "./process-runner.ts";

export const MAX_DIRTY_SNAPSHOT_FILE_BYTES = 524_288;
export const MAX_DIRTY_SNAPSHOT_TOTAL_BYTES = 20 * 1_048_576;
const SAFE_PATH_CONTROL = /[\u0000-\u001f\u007f]/u;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export interface DirtySnapshotFile {
  path: string;
  operation: "write" | "delete";
  baseExists: boolean;
  bytes: number;
  sha256: string;
  content?: string;
}

export interface DirtySnapshot {
  id: string;
  createdAt: string;
  sourceWorkspace: string;
  baseSha: string;
  sourceFingerprint: string;
  files: DirtySnapshotFile[];
  totalBytes: number;
  snapshotHash: string;
}

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function safePath(value: string): string {
  if (
    value.length < 1 || value.length > 4_096 || isAbsolute(value) || value.includes("\\") ||
    SAFE_PATH_CONTROL.test(value) || value.split("/").includes("..") || WORKSPACE_SENSITIVE_PATH.test(value)
  ) throw new Error("DIRTY_SNAPSHOT_PATH_DENIED");
  const stripped = value.replace(/^\.\//u, "");
  if (stripped === "." || normalize(stripped) !== stripped) {
    throw new Error("DIRTY_SNAPSHOT_PATH_DENIED");
  }
  return stripped;
}

function snapshotDigest(snapshot: Omit<DirtySnapshot, "snapshotHash">): string {
  return createHash("sha256").update(JSON.stringify(snapshot), "utf8").digest("hex");
}

/**
 * Captures the final working-tree contents relative to HEAD and can reproduce
 * them only inside a clean, matching isolated worktree.
 *
 * Snapshot data stays in memory. It is deliberately not persisted because it
 * may contain private source text. This broker has no source-workspace write or
 * apply-back operation.
 */
export class DirtySnapshotBroker {
  readonly #maxFiles: number;
  readonly #maxTotalBytes: number;

  constructor(input: { maxFiles: number; maxTotalBytes?: number }) {
    if (!Number.isSafeInteger(input.maxFiles) || input.maxFiles < 1 || input.maxFiles > 1_000) {
      throw new Error("DIRTY_SNAPSHOT_FILE_LIMIT_INVALID");
    }
    const maxTotalBytes = input.maxTotalBytes ?? MAX_DIRTY_SNAPSHOT_TOTAL_BYTES;
    if (!Number.isSafeInteger(maxTotalBytes) || maxTotalBytes < 1 || maxTotalBytes > MAX_DIRTY_SNAPSHOT_TOTAL_BYTES) {
      throw new Error("DIRTY_SNAPSHOT_BYTE_LIMIT_INVALID");
    }
    this.#maxFiles = input.maxFiles;
    this.#maxTotalBytes = maxTotalBytes;
  }

  async capture(sourceInput: string, options: { allowClean?: boolean } = {}): Promise<DirtySnapshot> {
    const sourceWorkspace = await canonicalWorkspace(sourceInput);
    const git = new GitBroker();
    const before = await git.inspect(sourceWorkspace);
    const baseSha = (await this.#git(sourceWorkspace, ["rev-parse", "--verify", "HEAD^{commit}"])).trim();
    if (!/^[0-9a-f]{40,64}$/u.test(baseSha)) throw new Error("DIRTY_SNAPSHOT_BASE_INVALID");
    if (before.clean) {
      if (!options.allowClean) throw new Error("DIRTY_SNAPSHOT_SOURCE_IS_CLEAN");
      const unsigned: Omit<DirtySnapshot, "snapshotHash"> = {
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        sourceWorkspace,
        baseSha,
        sourceFingerprint: before.fingerprint,
        files: [],
        totalBytes: 0,
      };
      return { ...unsigned, snapshotHash: snapshotDigest(unsigned) };
    }

    const changed = await this.#changedPaths(sourceWorkspace);
    if (changed.length < 1 || changed.length > this.#maxFiles) {
      throw new Error("DIRTY_SNAPSHOT_FILE_LIMIT_EXCEEDED");
    }
    const files: DirtySnapshotFile[] = [];
    let totalBytes = 0;
    for (const item of changed) {
      const path = safePath(item.path);
      const headMode = await this.#headFileMode(sourceWorkspace, path);
      if (item.baseExists !== Boolean(headMode)) throw new Error("DIRTY_SNAPSHOT_BASE_ENTRY_MISMATCH");
      if (item.operation === "delete") {
        files.push({
          path,
          operation: "delete",
          baseExists: true,
          bytes: 0,
          sha256: createHash("sha256").update("", "utf8").digest("hex"),
        });
        continue;
      }
      const candidate = join(sourceWorkspace, path);
      const info = await lstat(candidate);
      if (info.isSymbolicLink()) throw new Error("DIRTY_SNAPSHOT_SYMLINK_DENIED");
      if (!info.isFile()) throw new Error("DIRTY_SNAPSHOT_FILE_NOT_REGULAR");
      if (info.nlink > 1) throw new Error("DIRTY_SNAPSHOT_HARDLINK_DENIED");
      if (info.size > MAX_DIRTY_SNAPSHOT_FILE_BYTES) {
        throw new Error("DIRTY_SNAPSHOT_FILE_TOO_LARGE");
      }
      const executable = (info.mode & 0o111) !== 0;
      if (executable !== (headMode === "100755")) {
        throw new Error("DIRTY_SNAPSHOT_EXECUTABLE_MODE_DENIED");
      }
      const canonical = await realpath(candidate);
      if (!inside(sourceWorkspace, canonical)) throw new Error("DIRTY_SNAPSHOT_PATH_ESCAPE_DENIED");
      const bytes = await readFile(canonical);
      if (bytes.includes(0)) throw new Error("DIRTY_SNAPSHOT_BINARY_DENIED");
      let content: string;
      try {
        content = UTF8_DECODER.decode(bytes);
      } catch {
        throw new Error("DIRTY_SNAPSHOT_INVALID_UTF8_DENIED");
      }
      totalBytes += bytes.length;
      if (totalBytes > this.#maxTotalBytes) throw new Error("DIRTY_SNAPSHOT_TOTAL_BYTES_EXCEEDED");
      files.push({
        path,
        operation: "write",
        baseExists: item.baseExists,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        content,
      });
    }
    const after = await git.inspect(sourceWorkspace);
    const afterBase = (await this.#git(sourceWorkspace, ["rev-parse", "--verify", "HEAD^{commit}"])).trim();
    if (after.fingerprint !== before.fingerprint || afterBase !== baseSha) {
      throw new Error("DIRTY_SNAPSHOT_SOURCE_CHANGED_DURING_CAPTURE");
    }
    const unsigned: Omit<DirtySnapshot, "snapshotHash"> = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      sourceWorkspace,
      baseSha,
      sourceFingerprint: before.fingerprint,
      files,
      totalBytes,
    };
    return { ...unsigned, snapshotHash: snapshotDigest(unsigned) };
  }

  async applyToWorktree(snapshot: DirtySnapshot, targetInput: string): Promise<void> {
    const { snapshotHash, ...unsigned } = snapshot;
    if (snapshotDigest(unsigned) !== snapshotHash) throw new Error("DIRTY_SNAPSHOT_HASH_MISMATCH");
    this.#validateSnapshot(snapshot);
    const sourceWorkspace = await canonicalWorkspace(snapshot.sourceWorkspace);
    if (sourceWorkspace !== snapshot.sourceWorkspace) throw new Error("DIRTY_SNAPSHOT_SOURCE_NOT_CANONICAL");
    const source = await new GitBroker().inspect(sourceWorkspace);
    if (source.fingerprint !== snapshot.sourceFingerprint) {
      throw new Error("DIRTY_SNAPSHOT_SOURCE_CHANGED");
    }
    const target = await canonicalWorkspace(targetInput);
    if (target === sourceWorkspace) throw new Error("DIRTY_SNAPSHOT_TARGET_MUST_BE_ISOLATED");
    const targetInspection = await new GitBroker().inspect(target);
    if (!targetInspection.clean) throw new Error("DIRTY_SNAPSHOT_TARGET_NOT_CLEAN");
    const targetBase = (await this.#git(target, ["rev-parse", "--verify", "HEAD^{commit}"])).trim();
    if (targetBase !== snapshot.baseSha) throw new Error("DIRTY_SNAPSHOT_BASE_MISMATCH");

    const workspace = await WorkspaceToolBroker.create(target, "write", { authorizeWrite: () => {} });
    const expectedTargetHashes = new Map<string, string | null>();
    for (const file of snapshot.files) {
      const path = safePath(file.path);
      let currentSha256: string | null = null;
      try {
        const current = JSON.parse(await workspace.call("read_file", { path })) as { sha256?: unknown };
        if (typeof current.sha256 !== "string") throw new Error("DIRTY_SNAPSHOT_TARGET_HASH_INVALID");
        currentSha256 = current.sha256;
      } catch (error) {
        if (!this.#isMissing(error)) throw error;
      }
      if (file.baseExists && currentSha256 === null) {
        throw new Error("DIRTY_SNAPSHOT_TARGET_BASE_MISSING");
      }
      if (!file.baseExists && currentSha256 !== null) {
        throw new Error("DIRTY_SNAPSHOT_TARGET_NEW_PATH_EXISTS");
      }
      expectedTargetHashes.set(path, currentSha256);
    }
    for (const file of snapshot.files) {
      const path = safePath(file.path);
      if (file.operation === "delete") {
        await this.#deleteTargetFile(target, path, expectedTargetHashes.get(path) ?? null);
        continue;
      }
      if (
        typeof file.content !== "string" || Buffer.byteLength(file.content) !== file.bytes ||
        createHash("sha256").update(file.content, "utf8").digest("hex") !== file.sha256
      ) throw new Error("DIRTY_SNAPSHOT_FILE_HASH_MISMATCH");
      await this.#ensureParent(target, path);
      await workspace.call("write_file", {
        path,
        content: file.content,
        expectedSha256: expectedTargetHashes.get(path) ?? null,
      });
    }
    await this.#verifyApplied(snapshot, target);
  }

  async #changedPaths(workspace: string): Promise<Array<{
    path: string;
    operation: "write" | "delete";
    baseExists: boolean;
  }>> {
    const diff = await this.#git(workspace, [
      "diff", "HEAD", "--no-ext-diff", "--no-renames", "--name-status", "-z",
    ]);
    const tokens = diff.split("\0").filter(Boolean);
    if (tokens.some((token) => token.includes("\uFFFD")) || tokens.length % 2 !== 0) {
      throw new Error("DIRTY_SNAPSHOT_GIT_STATUS_INVALID");
    }
    const changes = new Map<string, { operation: "write" | "delete"; baseExists: boolean }>();
    for (let index = 0; index < tokens.length; index += 2) {
      const status = tokens[index]!;
      const path = tokens[index + 1]!;
      if (status === "A") changes.set(path, { operation: "write", baseExists: false });
      else if (status === "M") changes.set(path, { operation: "write", baseExists: true });
      else if (status === "D") changes.set(path, { operation: "delete", baseExists: true });
      else throw new Error("DIRTY_SNAPSHOT_UNSUPPORTED_GIT_STATUS");
    }
    const untracked = (await this.#git(workspace, [
      "ls-files", "--others", "--exclude-standard", "-z",
    ])).split("\0").filter(Boolean);
    if (untracked.some((path) => path.includes("\uFFFD"))) {
      throw new Error("DIRTY_SNAPSHOT_GIT_STATUS_INVALID");
    }
    for (const path of untracked) changes.set(path, { operation: "write", baseExists: false });
    return [...changes.entries()]
      .map(([path, value]) => ({ path, ...value }))
      .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  }

  async #headFileMode(workspace: string, path: string): Promise<"100644" | "100755" | undefined> {
    const output = await this.#git(workspace, ["ls-tree", "-z", "HEAD", "--", path]);
    if (!output) return undefined;
    const rows = output.split("\0").filter(Boolean);
    if (rows.length !== 1) throw new Error("DIRTY_SNAPSHOT_BASE_ENTRY_INVALID");
    const tab = rows[0]!.indexOf("\t");
    if (tab < 0 || rows[0]!.slice(tab + 1) !== path) throw new Error("DIRTY_SNAPSHOT_BASE_ENTRY_INVALID");
    const [mode, type] = rows[0]!.slice(0, tab).split(" ");
    if (type !== "blob" || (mode !== "100644" && mode !== "100755")) {
      throw new Error("DIRTY_SNAPSHOT_BASE_ENTRY_UNSUPPORTED");
    }
    return mode;
  }

  #validateSnapshot(snapshot: DirtySnapshot): void {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(snapshot.id)) {
      throw new Error("DIRTY_SNAPSHOT_ID_INVALID");
    }
    if (!Number.isFinite(Date.parse(snapshot.createdAt))) throw new Error("DIRTY_SNAPSHOT_TIME_INVALID");
    if (!/^[0-9a-f]{40,64}$/u.test(snapshot.baseSha)) throw new Error("DIRTY_SNAPSHOT_BASE_INVALID");
    if (!/^[0-9a-f]{64}$/u.test(snapshot.sourceFingerprint)) {
      throw new Error("DIRTY_SNAPSHOT_FINGERPRINT_INVALID");
    }
    if (snapshot.files.length < 1 || snapshot.files.length > this.#maxFiles) {
      throw new Error("DIRTY_SNAPSHOT_FILE_LIMIT_EXCEEDED");
    }
    const seen = new Set<string>();
    let totalBytes = 0;
    const emptyHash = createHash("sha256").update("", "utf8").digest("hex");
    for (const file of snapshot.files) {
      const path = safePath(file.path);
      if (seen.has(path)) throw new Error("DIRTY_SNAPSHOT_DUPLICATE_PATH");
      seen.add(path);
      if (!Number.isSafeInteger(file.bytes) || file.bytes < 0 || !/^[0-9a-f]{64}$/u.test(file.sha256)) {
        throw new Error("DIRTY_SNAPSHOT_FILE_METADATA_INVALID");
      }
      if (file.operation === "delete") {
        if (!file.baseExists || file.bytes !== 0 || file.sha256 !== emptyHash || file.content !== undefined) {
          throw new Error("DIRTY_SNAPSHOT_DELETE_METADATA_INVALID");
        }
        continue;
      }
      if (file.operation !== "write" || typeof file.baseExists !== "boolean" || typeof file.content !== "string") {
        throw new Error("DIRTY_SNAPSHOT_FILE_METADATA_INVALID");
      }
      const bytes = Buffer.from(file.content, "utf8");
      if (
        bytes.length !== file.bytes || bytes.length > MAX_DIRTY_SNAPSHOT_FILE_BYTES || bytes.includes(0) ||
        createHash("sha256").update(bytes).digest("hex") !== file.sha256
      ) throw new Error("DIRTY_SNAPSHOT_FILE_HASH_MISMATCH");
      totalBytes += bytes.length;
    }
    if (totalBytes !== snapshot.totalBytes || totalBytes > this.#maxTotalBytes) {
      throw new Error("DIRTY_SNAPSHOT_TOTAL_BYTES_INVALID");
    }
  }

  async #deleteTargetFile(root: string, path: string, expectedSha256: string | null): Promise<void> {
    if (expectedSha256 === null) throw new Error("DIRTY_SNAPSHOT_DELETE_TARGET_MISSING");
    await this.#ensureParent(root, path);
    const candidate = join(root, path);
    let info;
    try {
      info = await lstat(candidate);
    } catch (error) {
      if (this.#isMissing(error)) throw new Error("DIRTY_SNAPSHOT_DELETE_TARGET_MISSING");
      throw error;
    }
    if (info.isSymbolicLink()) throw new Error("DIRTY_SNAPSHOT_SYMLINK_DENIED");
    if (!info.isFile()) throw new Error("DIRTY_SNAPSHOT_FILE_NOT_REGULAR");
    if (info.nlink > 1) throw new Error("DIRTY_SNAPSHOT_HARDLINK_DENIED");
    const current = await readFile(candidate);
    if (createHash("sha256").update(current).digest("hex") !== expectedSha256) {
      throw new Error("DIRTY_SNAPSHOT_DELETE_TARGET_CHANGED");
    }
    await unlink(candidate);
  }

  async #ensureParent(root: string, path: string): Promise<void> {
    const parts = dirname(path).split("/").filter((part) => part && part !== ".");
    let current = root;
    for (const part of parts) {
      const candidate = join(current, part);
      try {
        const info = await lstat(candidate);
        if (info.isSymbolicLink()) throw new Error("DIRTY_SNAPSHOT_SYMLINK_DENIED");
        if (!info.isDirectory()) throw new Error("DIRTY_SNAPSHOT_PARENT_NOT_DIRECTORY");
      } catch (error) {
        if (!this.#isMissing(error)) throw error;
        await mkdir(candidate, { mode: 0o700, recursive: false });
      }
      const canonical = await realpath(candidate);
      if (!inside(root, canonical)) throw new Error("DIRTY_SNAPSHOT_PATH_ESCAPE_DENIED");
      current = canonical;
    }
  }

  async #verifyApplied(snapshot: DirtySnapshot, target: string): Promise<void> {
    for (const file of snapshot.files) {
      const candidate = join(target, file.path);
      if (file.operation === "delete") {
        try {
          await lstat(candidate);
          throw new Error("DIRTY_SNAPSHOT_DELETE_VERIFY_FAILED");
        } catch (error) {
          if (!this.#isMissing(error)) throw error;
        }
        continue;
      }
      const content = await readFile(candidate);
      if (createHash("sha256").update(content).digest("hex") !== file.sha256) {
        throw new Error("DIRTY_SNAPSHOT_WRITE_VERIFY_FAILED");
      }
    }
  }

  async #git(workspace: string, args: string[]): Promise<string> {
    const result = await runProcess({
      executable: await resolveExecutable("git"),
      args,
      cwd: workspace,
      timeoutMs: 30_000,
      outputLimitBytes: 2_097_152,
      env: minimalGitEnvironment(),
    });
    if (result.exitCode !== 0 || result.terminationReason) {
      throw new Error("DIRTY_SNAPSHOT_GIT_COMMAND_FAILED");
    }
    return result.stdout;
  }

  #isMissing(error: unknown): boolean {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ||
      (error instanceof Error && /ENOENT/u.test(error.message));
  }
}

export interface DirtySnapshotSummary {
  id: string;
  createdAt: string;
  expiresAt: string;
  sourceWorkspace: string;
  baseSha: string;
  sourceFingerprint: string;
  snapshotHash: string;
  files: number;
  writes: number;
  deletes: number;
  totalBytes: number;
}

/** RAM-only, short-lived handoff between the trusted approval UI and workflow. */
export class DirtySnapshotService {
  readonly #broker: DirtySnapshotBroker;
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #pending = new Map<string, { snapshot: DirtySnapshot; expiresAt: number }>();
  #preparing = 0;

  constructor(input: {
    maxFiles: number;
    maxTotalBytes?: number;
    now?: () => number;
    ttlMs?: number;
  }) {
    this.#broker = new DirtySnapshotBroker({
      maxFiles: input.maxFiles,
      ...(input.maxTotalBytes === undefined ? {} : { maxTotalBytes: input.maxTotalBytes }),
    });
    this.#now = input.now ?? Date.now;
    this.#ttlMs = input.ttlMs ?? 120_000;
    if (!Number.isSafeInteger(this.#ttlMs) || this.#ttlMs < 10_000 || this.#ttlMs > 600_000) {
      throw new Error("DIRTY_SNAPSHOT_TTL_INVALID");
    }
  }

  async prepare(workspace: string): Promise<DirtySnapshotSummary> {
    this.#discardExpired();
    if (this.#pending.size + this.#preparing >= 8) {
      throw new Error("DIRTY_SNAPSHOT_PENDING_LIMIT_REACHED");
    }
    this.#preparing += 1;
    try {
      const snapshot = await this.#broker.capture(workspace);
      const expiresAt = this.#now() + this.#ttlMs;
      this.#pending.set(snapshot.id, { snapshot, expiresAt });
      return this.#summary(snapshot, expiresAt);
    } finally {
      this.#preparing -= 1;
    }
  }

  get(id: string): DirtySnapshot {
    this.#discardExpired();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(id)) {
      throw new Error("DIRTY_SNAPSHOT_ID_INVALID");
    }
    const pending = this.#pending.get(id);
    if (!pending) throw new Error("DIRTY_SNAPSHOT_NOT_FOUND_OR_EXPIRED");
    return structuredClone(pending.snapshot);
  }

  take(id: string): DirtySnapshot {
    const snapshot = this.get(id);
    this.#pending.delete(id);
    return snapshot;
  }

  async apply(snapshot: DirtySnapshot, target: string): Promise<void> {
    await this.#broker.applyToWorktree(snapshot, target);
  }

  status(): { pending: number; maxPending: number; ttlMs: number } {
    this.#discardExpired();
    return { pending: this.#pending.size + this.#preparing, maxPending: 8, ttlMs: this.#ttlMs };
  }

  clear(): void {
    this.#pending.clear();
  }

  #summary(snapshot: DirtySnapshot, expiresAt: number): DirtySnapshotSummary {
    return {
      id: snapshot.id,
      createdAt: snapshot.createdAt,
      expiresAt: new Date(expiresAt).toISOString(),
      sourceWorkspace: snapshot.sourceWorkspace,
      baseSha: snapshot.baseSha,
      sourceFingerprint: snapshot.sourceFingerprint,
      snapshotHash: snapshot.snapshotHash,
      files: snapshot.files.length,
      writes: snapshot.files.filter((file) => file.operation === "write").length,
      deletes: snapshot.files.filter((file) => file.operation === "delete").length,
      totalBytes: snapshot.totalBytes,
    };
  }

  #discardExpired(): void {
    const now = this.#now();
    for (const [id, pending] of this.#pending) {
      if (now > pending.expiresAt) this.#pending.delete(id);
    }
  }
}
