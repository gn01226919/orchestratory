import { chmod, mkdir, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { canonicalWorkspace } from "../security/workspace.ts";
import { minimalGitEnvironment, resolveExecutable, runProcess } from "./process-runner.ts";

export interface WorktreeSession {
  workspace: string;
  branch: string;
  baseSha: string;
}

export interface WorktreeCleanupPreview {
  runId: string;
  workspace: string;
  sourceWorkspace: string;
  branch: string;
  headSha: string;
}

export interface RetainedWorktree {
  runId: string;
  workspace: string;
  sourceWorkspace: string;
  branch: string;
  headSha: string;
}

export class WorktreeBroker {
  readonly #dataDirectory: string;

  constructor(dataDirectory: string) {
    this.#dataDirectory = dataDirectory;
  }

  async #git(
    workspace: string,
    args: string[],
    acceptedExitCodes: ReadonlySet<number> = new Set([0]),
  ): Promise<string> {
    const result = await runProcess({
      executable: await resolveExecutable("git"),
      args,
      cwd: workspace,
      timeoutMs: 30_000,
      outputLimitBytes: 262_144,
      env: minimalGitEnvironment(),
    });
    if (result.terminationReason || !acceptedExitCodes.has(result.exitCode)) {
      throw new Error("WORKTREE_GIT_COMMAND_FAILED");
    }
    return result.stdout;
  }

  async create(sourceInput: string, runId: string): Promise<WorktreeSession> {
    if (!/^[0-9a-f-]{36}$/u.test(runId)) throw new Error("INVALID_WORKTREE_RUN_ID");
    const source = await canonicalWorkspace(sourceInput);
    const unsafeConfig = await this.#git(
      source,
      [
        "config",
        "--local",
        "--name-only",
        "--get-regexp",
        "^(filter\\..*\\.(clean|smudge|process)|core\\.fsmonitor)$",
      ],
      new Set([0, 1]),
    );
    if (unsafeConfig.trim()) throw new Error("UNSAFE_LOCAL_GIT_FILTER_OR_FSMONITOR_CONFIG");

    let baseSha: string;
    try {
      baseSha = (await this.#git(source, ["rev-parse", "--verify", "HEAD^{commit}"])).trim();
    } catch (error) {
      if (error instanceof Error && error.message === "WORKTREE_GIT_COMMAND_FAILED") {
        throw new Error("WORKTREE_BASE_COMMIT_REQUIRED");
      }
      throw error;
    }
    if (!/^[0-9a-f]{40,64}$/u.test(baseSha)) throw new Error("INVALID_BASE_COMMIT");
    const branch = `orchestratory/run-${runId}`;
    const root = join(this.#dataDirectory, "worktrees");
    await mkdir(root, { recursive: true, mode: 0o700 });
    await chmod(root, 0o700);
    const target = join(root, runId);
    await this.#git(source, ["worktree", "add", "--no-track", "-b", branch, target, baseSha]);
    return { workspace: await canonicalWorkspace(target), branch, baseSha };
  }

  async listRunIds(): Promise<string[]> {
    const root = join(this.#dataDirectory, "worktrees");
    try {
      const entries = await readdir(root, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory() && /^[0-9a-f-]{36}$/u.test(entry.name))
        .map((entry) => entry.name)
        .sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async retainedWorkspace(runId: string): Promise<string | undefined> {
    if (!/^[0-9a-f-]{36}$/u.test(runId)) return undefined;
    try {
      return await canonicalWorkspace(join(this.#dataDirectory, "worktrees", runId));
    } catch {
      return undefined;
    }
  }

  async isRetainedWorkspace(runId: string, candidateInput: string): Promise<boolean> {
    if (!/^[0-9a-f-]{36}$/u.test(runId)) return false;
    try {
      const candidate = await canonicalWorkspace(candidateInput);
      const retained = await canonicalWorkspace(join(this.#dataDirectory, "worktrees", runId));
      return candidate === retained;
    } catch {
      return false;
    }
  }

  async inspectRetained(runId: string): Promise<RetainedWorktree> {
    if (!/^[0-9a-f-]{36}$/u.test(runId)) throw new Error("INVALID_WORKTREE_RUN_ID");
    const workspace = await canonicalWorkspace(join(this.#dataDirectory, "worktrees", runId));
    const branch = (await this.#git(workspace, ["branch", "--show-current"])).trim();
    if (branch !== `orchestratory/run-${runId}`) throw new Error("WORKTREE_BRANCH_MISMATCH");
    const headSha = (await this.#git(workspace, ["rev-parse", "--verify", "HEAD^{commit}"])).trim();
    if (!/^[0-9a-f]{40,64}$/u.test(headSha)) throw new Error("INVALID_WORKTREE_HEAD");
    const commonDirectory = (
      await this.#git(workspace, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
    ).trim();
    const sourceWorkspace = await canonicalWorkspace(dirname(commonDirectory));
    if (sourceWorkspace === workspace) throw new Error("WORKTREE_SOURCE_MISMATCH");
    return { runId, workspace, sourceWorkspace, branch, headSha };
  }

  async previewCleanup(runId: string): Promise<WorktreeCleanupPreview> {
    const retained = await this.inspectRetained(runId);
    const { workspace, sourceWorkspace, branch, headSha } = retained;
    const status = await this.#git(workspace, ["status", "--porcelain=v1", "--untracked-files=all"]);
    if (status.trim()) throw new Error("WORKTREE_MUST_BE_CLEAN_FOR_CLEANUP");
    return { runId, workspace, sourceWorkspace, branch, headSha };
  }

  async cleanup(preview: WorktreeCleanupPreview): Promise<void> {
    const current = await this.previewCleanup(preview.runId);
    if (JSON.stringify(current) !== JSON.stringify(preview)) {
      throw new Error("WORKTREE_CLEANUP_SNAPSHOT_CHANGED");
    }
    await this.#git(current.sourceWorkspace, ["worktree", "remove", "--", current.workspace]);
    try {
      await stat(current.workspace);
      throw new Error("WORKTREE_CLEANUP_INCOMPLETE");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
