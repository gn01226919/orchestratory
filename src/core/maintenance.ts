import type { RetentionPolicy, RunRecord } from "../types.ts";
import {
  dataPurgeApprovalScope,
  worktreeCleanupApprovalScope,
  type ApprovalService,
} from "../security/approval.ts";
import type { LocalStore, PurgePreview } from "./store.ts";
import { WorktreeBroker, type WorktreeCleanupPreview } from "./worktree-broker.ts";

export class MaintenanceService {
  readonly #store: LocalStore;
  readonly #approvals: ApprovalService;
  readonly #worktrees: WorktreeBroker;
  readonly #activeRuns: () => RunRecord[];

  constructor(input: {
    store: LocalStore;
    approvals: ApprovalService;
    activeRuns: () => RunRecord[];
  }) {
    this.#store = input.store;
    this.#approvals = input.approvals;
    this.#worktrees = new WorktreeBroker(input.store.dataDirectory);
    this.#activeRuns = input.activeRuns;
  }

  async previewPurge(policy: RetentionPolicy, now = new Date()): Promise<PurgePreview> {
    return this.#store.previewPurge(policy, await this.#worktrees.listRunIds(), now);
  }

  purge(preview: PurgePreview, approvalToken: string | undefined): PurgePreview["counts"] {
    if (this.#activeRuns().length > 0) throw new Error("PURGE_DENIED_WHILE_WORKFLOW_ACTIVE");
    const scope = dataPurgeApprovalScope(preview);
    this.#approvals.consume("purge-data", scope, approvalToken, preview.id);
    return this.#store.purge(preview);
  }

  previewWorktreeCleanup(runId: string): Promise<WorktreeCleanupPreview> {
    return this.#worktrees.previewCleanup(runId);
  }

  async cleanupWorktree(
    preview: WorktreeCleanupPreview,
    approvalToken: string | undefined,
  ): Promise<void> {
    if (this.#activeRuns().some((run) => run.id === preview.runId)) {
      throw new Error("ACTIVE_WORKTREE_CLEANUP_DENIED");
    }
    const scope = worktreeCleanupApprovalScope(preview);
    this.#approvals.consume("cleanup-worktree", scope, approvalToken, preview.runId);
    await this.#worktrees.cleanup(preview);
  }
}
