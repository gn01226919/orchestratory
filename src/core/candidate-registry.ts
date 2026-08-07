import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { closeSync, mkdirSync, openSync, readSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { uptime } from "node:os";
import { isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { StringDecoder } from "node:string_decoder";
import { canonicalWorkspace } from "../security/workspace.ts";
import {
  GitBroker, MERGE_TIMEOUT_MS, readExecutedHooks,
  type GitInspection, type GitRestorePoint,
} from "./git-broker.ts";
import { minimalGitEnvironment, resolveExecutable, runProcess } from "./process-runner.ts";
import { openOwnerDatabase, verifyOwnerDatabaseFiles } from "./sqlite-security.ts";
import { WorktreeBroker, type CandidateWorktree } from "./worktree-broker.ts";

export type CandidateStatus = "creating" | "active" | "completed" | "retained" | "rejected" | "merged" | "failed";

export interface CandidateBaseline {
  clean: boolean;
  changedFiles: number;
  changedLines: number;
  changedBytes: number;
  untrackedFiles: number;
  ignoredFiles: number;
  ignoredFingerprint: string;
  statusSummary: string;
  fingerprint: string;
}

export interface CandidateTestResult {
  command: string;
  status: "passed" | "failed" | "not-run";
  summary?: string;
}

export interface CandidateFileChange {
  path: string;
  operation: "add" | "modify" | "delete" | "rename" | "copy" | "type-change" | "unmerged" | "unknown";
  previousPath?: string;
  bytes?: number;
  /**
   * Present only when the entry changed an existing file's mode, e.g. 100644 -> 100755. An add or a
   * delete is deliberately excluded: its counterpart mode is `000000`, so reporting it would flag
   * every new and removed file as a permission change and bury the ones that actually are.
   */
  mode?: { from: string; to: string };
  /** Either side of the entry is a gitlink (mode 160000), so this is a submodule pointer, not a file. */
  submodule?: true;
}

export interface CandidateCompletionPreview {
  baseMainHead: string;
  candidateHead: string;
  mainHead: string;
  mainDrift: boolean;
  candidatePath: string;
  mainPath: string;
  files: CandidateFileChange[];
  fileCount: number;
  filesTruncated: boolean;
  additions: number;
  deletions: number;
  binaryEntries: number;
  /** Entries whose file mode changed. Counted over every entry, not only the reported ones. */
  modeChanges: number;
  /** Paths whose entry is a submodule pointer change; bounded, with its own truncation flag. */
  submodules: string[];
  submodulesTruncated: boolean;
  largeFiles: string[];
  largeFileScanTruncated: boolean;
  tests: CandidateTestResult[];
  knownRisks: string[];
  /**
   * Advisory facts about the SHAPE of this preview — main has moved, main is dirty. They are not
   * merge results and never were; `mergeConflicts` below is the simulated merge.
   */
  conflicts: string[];
  /**
   * Paths that actually conflict when this candidate head is merged into the observed main head,
   * computed with `git merge-tree --write-tree`, which writes no ref and touches no worktree.
   * Bounded, with its own truncation flag.
   */
  mergeConflicts: string[];
  mergeConflictsTruncated: boolean;
  /** True only when the simulated merge produced no conflict at all. Never inferred from a failure. */
  mergeable: boolean;
  mainDirty: CandidateBaseline;
  recovery: {
    ready: true;
    kind: "git-checkpoint-ref";
    ref: string;
    head: string;
  };
  /**
   * The promotion-only facts, carried INSIDE the preview so they are covered by `previewDigest` and
   * therefore bound to the approval, re-verified at grant and again immediately before main is
   * written — with no schema change and no rewritten row hashes.
   *
   * They are optional on the type because a completion recorded before Phase 5-5 has none, and such
   * a completion is refused rather than promoted; an approval is required to carry them.
   */
  promotion?: PromotionFacts;
}

/**
 * Everything about LIVE main that only matters because a promotion writes to it.
 *
 * `mainIgnored` covers CONTENT, upgrading what Phase 5-4 recorded as an accepted residual risk. The
 * measurement that closed it: a `git merge` into a working tree whose `git status --porcelain` is
 * completely empty silently replaced the contents of an ignored file and exited zero, and the
 * obvious rollback then deleted that file instead of restoring it.
 *
 * `hooks` is here because promotion is the first operation in this product that executes code out of
 * `.git`, as the owner, unsandboxed. Binding it means an agent that rewrites a hook — which a linked
 * candidate worktree can do, since it shares the common `.git` — turns the promotion into a drift
 * refusal instead of an execution.
 */
export interface PromotionFacts {
  mainIgnored: { files: number; fingerprint: string };
  hooks: {
    hooksPath: string;
    hooks: Array<{ name: string; sha256: string; bytes: number }>;
    drivers: string[];
    filters: string[];
    /**
     * Configuration keys present in main that can name a program git runs, by key only, so the
     * owner sees them itemised on the approval screen. Absent on a snapshot taken before this gate
     * existed, which `promotionFacts` refuses by name rather than reading as "there were none".
     */
    programs?: string[];
    /** Digest of main's whole effective configuration; see `HookEnvironment.configDigest`. */
    configDigest?: string;
    unreadable: boolean;
    fingerprint: string;
  };
}

export interface CandidateCompletion {
  id: string;
  summary: string;
  createdAt: string;
  previewDigest: string;
  preview: CandidateCompletionPreview;
  mergeDecision: "owner-required";
  next: "Ask the owner whether to merge this candidate into main";
  prompt: string;
}

export interface CandidateCompletionResult {
  task: CandidateTask;
  completion: CandidateCompletion;
  checkpoint: CandidateCheckpoint;
}

export interface CandidateCheckpoint {
  id: string;
  taskId: string;
  candidateHead: string;
  recoveryRef: string;
  summary: string;
  createdAt: string;
}

export interface CandidateTask {
  taskId: string;
  candidateId: string;
  roomId: string;
  mainPath: string;
  mainBranch: string;
  baseMainHead: string;
  candidatePath: string;
  candidateBranch: string;
  task: string;
  acceptanceCriteria?: string;
  status: CandidateStatus;
  baseline: CandidateBaseline;
  completion?: CandidateCompletion;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface CandidateTaskStatus extends CandidateTask {
  checkpoints: CandidateCheckpoint[];
  /** Bounded decision record only; the full preview lives on the approval itself. */
  mergeApprovals: Array<MergeApprovalSummary | UnreadableMergeApproval>;
  live: {
    candidateHead?: string;
    candidateDirty?: boolean;
    mainHead?: string;
    mainDirty?: boolean;
    completionStale: boolean;
    recoveryReady: boolean;
  };
}

/**
 * `requested` is an agent asking; it is NOT an approval. Only `approved` carries owner authority, and
 * only for as long as its short grant window lasts. Every other state is terminal: a consumed
 * approval is spent, and a rejected, invalidated or expired one can never become valid again — the
 * owner has to be asked again against a freshly computed snapshot.
 */
export type MergeApprovalState = "requested" | "approved" | "consumed" | "rejected" | "invalidated" | "expired";

/** The single action a merge approval may ever authorize. */
export const MERGE_APPROVAL_GRANT = "merge-candidate-into-main";

/**
 * The exact owner confirmation phrase. It is semantic and deliberately carries no taskId: a phrase
 * that can be copied out of the page it is shown on is not evidence of intent.
 */
export const MERGE_APPROVAL_CONFIRMATION = "MERGE INTO MAIN";

/**
 * The owner's phrase for releasing a promotion that is blocked on a process group.
 *
 * It exists because a blocked promotion holds the one open question a task is allowed to have, and
 * a state with no product-side exit permanently retires the task. The only condition that can end
 * the wait honestly is that the process really is gone, which nothing here can force: killing it
 * would be this product terminating something in the owner's repository, and concluding without it
 * would be publishing a verdict over a possible live write. So the owner looks (the record hands
 * them the exact `ps` command and pid), decides, and says so — and the record attributes the
 * decision to them rather than dressing it up as an observation (PITFALLS #86).
 */
export const MERGE_GROUP_ABANDON_CONFIRMATION = "STOP WAITING FOR THIS PROCESS GROUP";

/**
 * The second phrase, required when the group's LEADER is answering "alive" — that is, when `ps` can
 * still show a `git merge` writing to the owner's project.
 *
 * The first phrase does not cover this case, and one measurement is the whole reason: a promotion
 * whose merge was demonstrably mid-flight (the hook had been entered, `ps -g` listed the running
 * `git merge`) accepted `STOP WAITING FOR THIS PROCESS GROUP` and handed back a copy-and-paste
 * `git reset --hard <pre-promotion head>` — an instruction to reset a working tree WHILE git is
 * writing its index. PITFALLS #94 is about exactly that command being more destructive than the
 * failure it claims to repair.
 *
 * So this state is refused on the first attempt, by name, and the way through says what is being
 * abandoned rather than which record is being edited. Nothing is killed here either: what changes is
 * only whether this record keeps waiting.
 */
export const MERGE_LIVE_ABANDON_CONFIRMATION =
  "STOP WAITING FOR A MERGE THAT MAY STILL BE WRITING TO MAIN";

/**
 * The owner's phrase for releasing a promotion that is waiting on the process which STARTED it.
 *
 * Within one boot the operating system can hand `owner_pid` to an unrelated process of the same
 * user, and no probe can tell that apart from the original still running. Without this, such a row
 * waits forever, `#assertNoUnresolvedPromotion` refuses every later approval for that task, and the
 * task is permanently retired with no product-side path — the same dead end the process-group
 * release exists to prevent, one level up.
 */
export const MERGE_OWNER_ABANDON_CONFIRMATION = "STOP WAITING FOR THIS PROMOTION'S OWNER PROCESS";

/**
 * The owner's phrase for the one state neither of the phrases above can leave: BOTH numbers this
 * record waits on are answering "alive".
 *
 * The two releases refuse each other by design, and each refusal is right on its own: disowning the
 * merge while the owner process runs would let two readers describe one repository, and disowning
 * the owner while the merge runs would publish a verdict over a live write. Together they were a
 * cycle. Measured on a real promotion whose merge had been killed outright and whose two recorded
 * numbers had been recycled to live processes of the same user within one boot — PITFALLS #105's
 * shape exactly — `abandonMergeProcessGroup` answered `MAIN_MERGE_PROMOTION_STILL_OWNED`,
 * `abandonPromotionOwnerProcess` answered `MERGE_ABANDON_REFUSED_MERGE_STILL_RUNNING`, and the task
 * could never be promoted again. That is the state bar item 11 forbids.
 *
 * So there is a third way out, and its phrase says what the other two cannot: that this abandons TWO
 * processes, and that one of them may still be writing to main. Nothing is killed here either, and
 * main is not touched — what changes is only whether this record keeps waiting, and the record
 * attributes that to the owner rather than dressing it up as an observation.
 */
export const MERGE_PROMOTION_ABANDON_CONFIRMATION =
  "STOP WAITING FOR BOTH PROCESSES OF A PROMOTION THAT MAY STILL BE WRITING TO MAIN";

/**
 * The owner's phrase for a promotion record this release cannot read at all.
 *
 * A row whose integrity check fails is not evidence that main is fine, so it holds the project's
 * exclusive marker — and every OTHER task in the project was then refused for as long as the
 * corruption lasted, while the one release that could have freed them refused to look at the row at
 * all (`#promotionRow` returns nothing for a row that fails its check, so every abandon answered
 * `MAIN_MERGE_PROMOTION_NOT_FOUND`). One unreadable row therefore retired an entire project rather
 * than the one task it belongs to.
 *
 * This phrase does not repair the row and does not decide what happened to main: it moves that row
 * out of `applying` so it stops claiming the project, and leaves it unresolved for its own task,
 * which is exactly what an unreadable record deserves.
 */
export const MERGE_UNREADABLE_ABANDON_CONFIRMATION =
  "STOP LETTING AN UNREADABLE PROMOTION RECORD BLOCK THIS PROJECT";

/**
 * The owner's phrase for a promotion whose merge NOTHING can account for.
 *
 * Amendment (O). Every other phrase here names a number, because until this one existed a record
 * that named no number was not treated as blocked at all: it concluded. The measured shape needed
 * no forgery and no database access — a repository hook, which this phase trusts and runs as the
 * owner with no sandbox, emptied the file whose path the product had just handed it in
 * `GIT_TRACE2_EVENT`. With the group's own write already lost to an ordinary SQLite contention, all
 * four sources fell silent at once, and the record answered "no process this record names is still
 * being waited on" and offered `git reset --hard <pre-promotion head>` while `ps -g` listed the
 * `git merge`, its hook and its `sleep`, with main already half-applied.
 *
 * Silence is now a reason to wait rather than a reason to conclude, and this is the way out of it.
 * It names no pid BECAUSE there is none to name — that is the state — so the phrase carries the
 * whole weight, and the record hands over a read-only SEARCH (`ps` filtered by the candidate head
 * every one of this product's merges carries on its command line) instead of a lookup.
 */
export const MERGE_UNACCOUNTED_ABANDON_CONFIRMATION =
  "STOP WAITING FOR A MERGE THIS RECORD CANNOT ACCOUNT FOR";

/**
 * The second phrase for an unreadable row, required when one of the numbers that row was waiting on
 * is still answering "alive".
 *
 * The phrase above says nothing about main being written, and that was measured rather than
 * theorised: with `ps -g` listing a live `git merge`, its hook and its `sleep`, and main already
 * half-applied (`A  a.txt`), the release above was ACCEPTED, the merge went on writing, and the
 * project's exclusive marker was gone. The next task was refused only because main happened to be
 * dirty by then — stopped by coincidence rather than by design, which is exactly what
 * [[PITFALLS]] #109 says is not a guard.
 *
 * A row whose hash does not verify cannot be trusted to say which pid is which, so the probe here is
 * best-effort and its answer only ever raises the bar: anything that might still be running turns
 * the ordinary phrase into a refusal that names this one, and this one says what the owner is
 * actually doing. Nothing is killed here either, and main is not touched.
 */
export const MERGE_UNREADABLE_LIVE_ABANDON_CONFIRMATION =
  "STOP LETTING AN UNREADABLE RECORD BLOCK THIS PROJECT WHILE ONE OF ITS PROCESSES IS STILL ALIVE"
  + " AND MAY BE WRITING TO MAIN";

/**
 * Written into every consumed authorization so no downstream caller has to infer the limits of what
 * the owner agreed to. A merge approval authorizes one merge of one snapshot into main; it is not a
 * push, publish, deploy, delete or cleanup approval, and it never becomes one.
 */
export const MERGE_APPROVAL_NOT_AUTHORIZED: readonly string[] = [
  "push", "publish", "deploy", "release", "delete-candidate", "delete-recovery-ref",
  "cleanup-worktree", "restore-checkpoint", "run-test",
];

/** How long the owner has to decide on a request before it stops being answerable. */
export const MERGE_APPROVAL_REQUEST_TTL_MS = 15 * 60_000;
/** How long a granted approval stays usable. Short on purpose: it authorizes writing to main. */
export const MERGE_APPROVAL_GRANT_TTL_MS = 5 * 60_000;
/** Ledger growth bound per task; reaching it fails closed rather than accumulating silently. */
export const MAX_MERGE_APPROVALS_PER_TASK = 50;

export interface MergeApprovalBinding {
  taskId: string;
  completionId: string;
  roomId: string;
  mainPath: string;
  mainBranch: string;
  candidatePath: string;
  baseMainHead: string;
  candidateHead: string;
  mainHead: string;
  mainFingerprint: string;
  mainIgnoredFingerprint: string;
  recoveryRef: string;
  previewDigest: string;
}

export interface MergeApprovalRefusal {
  code: string;
  /**
   * Names of the bound values that were compared against live state and no longer match.
   *
   * Only compared values appear here. A value the check could not read is NOT a value that moved,
   * and this array is copied verbatim into the audit chain and the public Room ledger — listing an
   * unread field here would tell the owner and every agent in the room that main's HEAD moved when
   * nothing about main had changed at all.
   */
  changed: string[];
  /**
   * Names of the bound values the check could not read on this attempt, kept separate from `changed`
   * for exactly that reason. Present only when at least one value could not be compared.
   */
  unverified?: string[];
  reason?: string;
}

/**
 * Where a binding check ran. It is recorded in the durable refusal and in the audit entry, because
 * "this approval was invalidated by drift, noticed by the status listing at 09:14" and "this approval
 * was refused when the owner tried to grant it" are different stories about the same row, and an
 * owner asking why their decision did not take effect needs to be able to tell them apart.
 */
export type MergeApprovalObservation =
  | "candidate-status" | "merge-approval-list" | "merge-approval-inspect" | "merge-request"
  | "grant" | "consume";

/**
 * The outcome of comparing one approval's bindings against live state on a read.
 *
 * `checked` is separate from `valid` on purpose. A check that could not run — a transient Git
 * failure, a repository momentarily unreadable — is not evidence that anything moved, and treating
 * it as such would burn an owner decision on a hiccup. It is also not evidence that nothing moved,
 * so it is reported rather than rounded to either answer.
 */
export interface MergeApprovalBindingCheck {
  /** True only when live state was actually compared on this read. */
  checked: boolean;
  /** True only when the comparison ran and every bound value still matched. */
  valid: boolean;
  /**
   * Bound values that were actually compared and moved, named with the same vocabulary grant and
   * consume use. A value that could not be read is never named here — see `unverified`.
   */
  changed: string[];
  /** Bound values this read could not compare at all. Never merged into `changed`. */
  unverified?: string[];
  /** Stable code, present only when the comparison could not be completed. */
  unavailable?: string;
}

/**
 * One approval that an observation path found drifted and invalidated. Emitted only after the
 * durable state transition has committed, so a listener can never record an invalidation that did
 * not happen, and exactly one listener call exists per invalidation however many readers raced.
 */
export interface MergeApprovalDriftEvent {
  approvalId: string;
  taskId: string;
  roomId: string;
  mainPath: string;
  candidateHead: string;
  mainHead: string;
  previewDigest: string;
  /** Only values that were compared and moved. Unread values are reported in `unverified`. */
  changed: string[];
  /** Values that could not be compared on the read that noticed the drift, if any. */
  unverified?: string[];
  /**
   * True when the owner had already granted this approval. A granted decision that lapsed unnoticed
   * is a materially different record from a request nobody ever answered.
   */
  wasGranted: boolean;
  previousState: MergeApprovalState;
  observedOn: MergeApprovalObservation;
  at: string;
}

/** A row whose integrity check failed. Reported so it is visible, never silently dropped. */
export interface UnreadableMergeApproval {
  id: string;
  taskId: string;
  state: "unreadable";
  unreadable: true;
}

export interface MergeApprovalSummary {
  id: string;
  taskId: string;
  state: MergeApprovalState;
  previewDigest: string;
  candidateHead: string;
  mainHead: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  /** True when the deadline has passed but no mutation has yet recorded the terminal state. */
  expired: boolean;
  refusal?: MergeApprovalRefusal;
  /**
   * Present only on an observation path (`status`, the approval list, `inspect`), where the bindings
   * were compared against live state before the row was reported. Absent everywhere else, so it can
   * never be read as "checked and fine" on a surface that did no checking.
   *
   * When it reports drift the row itself is already `invalidated` and its `refusal` names the same
   * values; this field exists so a reader can also distinguish "checked, still valid" from "could
   * not be checked", which the row alone cannot say.
   */
  bindingCheck?: MergeApprovalBindingCheck;
}

export interface MergeApproval extends MergeApprovalSummary {
  clientRequestId: string;
  grants: string;
  notAuthorized: readonly string[];
  requestedBy: string;
  decidedBy?: "local-web" | "local-tui";
  binding: MergeApprovalBinding;
  preview: CandidateCompletionPreview;
  /** Nothing in the approval lifecycle writes to canonical main; promotion is a separate phase. */
  mainMutation: false;
}

export interface MergeApprovalPreview {
  taskId: string;
  completionId: string;
  previewDigest: string;
  preview: CandidateCompletionPreview;
  recoveryRef: string;
  /** False whenever a bar-level gate is closed; `blockers` says which, so the owner sees why. */
  approvable: boolean;
  blockers: string[];
  /**
   * Files that exist in live main without being tracked there, at paths this merge writes.
   *
   * `ignored` is the one the owner cannot discover any other way: git replaces those files and exits
   * zero, reporting a clean working tree afterwards. `checked: false` means the scan did not run and
   * is never the same as an empty list.
   */
  overwrites: { checked: boolean; ignored: string[]; untracked: string[] };
  /**
   * The exact hook files this promotion would execute, by name and content hash. Promotion is the
   * first operation in this product that runs code out of `.git`, as the owner and unsandboxed, so
   * the owner is shown WHAT will run rather than told that hooks exist.
   *
   * `programs` is the same disclosure for configuration: the keys in main's config that this
   * release RECOGNISES as able to name a program git runs, by key. It is not every such key and
   * never claims to be — the previous wording said "every", and `gpg.ssh.defaultKeyCommand` was in
   * main's config, executable by git, and absent from the list at the same time. Completeness is
   * `configDigest`'s job: it binds every key including the ones no expression here matches. Values
   * are not here on purpose — this is rendered to the owner and one of those keys can carry a
   * secret — and are covered by `configDigest` instead.
   */
  hooks: PromotionFacts["hooks"];
  confirmationPhrase: string;
  prompt: string;
  mainMutation: false;
}

/**
 * The four states a promotion can be in, and the only three answers a reader ever gets.
 *
 * `applying` is not a failure and not a success: it means a promotion was recorded as under way and
 * has not been resolved, which after a crash is the honest "this needs a human to look". It is
 * deliberately NOT resolved by retrying the merge — a retry would turn "I do not know" into a second
 * write to main.
 */
export type MergePromotionState = "applying" | "applied" | "rolled-back" | "needs-manual-review";

/**
 * What identifies the merge subprocess's process group, as opposed to merely naming it.
 *
 * A pid on its own is a label the operating system reuses. `bootAtSec` scopes it to one boot, which
 * is what stops a post-reboot pid from impersonating a merge that died with the machine.
 */
export interface MergeProcessGroupIdentity {
  pgid: number;
  /** Whole seconds since the epoch at which this machine booted, or null on a record predating it. */
  bootAtSec: number | null;
  spawnedAt: string | null;
}

/** Everything every reason a promotion is not answerable carries, whatever the reason. */
interface MergePromotionPendingCommon {
  /** A read-only command. Nothing here ever executes it. */
  inspect: string;
  /** Present only when the owner has a way to release this state without waiting. */
  release?: string;
  /**
   * The SECOND process in the way, present only for the combined state.
   *
   * Both numbers have to be named there, because the release that works requires both of them and a
   * state that names one while refusing on the other is the dead end this field exists to end.
   */
  alsoBlockedBy?: { pid: number; inspect: string };
}

/**
 * Why a promotion has no answer yet, observed at read time rather than written once.
 *
 * A union rather than one shape with an optional pid, so that the one reason which carries NO pid
 * cannot be handled by accident: every path that reads `pending.pid` has to narrow first, and the
 * compiler is what enforces it. That is deliberate — the state with no number is exactly the state
 * the previous shape concluded from, and a renderer or a release that silently printed `pid 0` or
 * compared against `undefined` would be that same defect with a different surface.
 */
export type MergePromotionPending =
  | (MergePromotionPendingCommon & {
    code:
      | "OWNER_PROCESS_STILL_RUNNING"
      | "MERGE_SUBPROCESS_STILL_RUNNING"
      | "MERGE_PROCESS_GROUP_UNDECIDABLE"
      | "PROMOTION_OWNER_AND_MERGE_STILL_RUNNING";
    /** The process the owner can look at. "Still running" with no pid is unactionable. */
    pid: number;
  })
  | (MergePromotionPendingCommon & {
    /**
     * Amendment (O). No source named a group, and nothing positive says there is none to name.
     *
     * The previous shape treated "nobody named a number" as "nothing is running" and concluded —
     * a destructive conclusion reached from the ABSENCE of evidence. `inspect` here is a read-only
     * SEARCH rather than a lookup, because a search is the only honest instruction left when the
     * record has nothing to look up.
     */
    code: "MERGE_IDENTITY_UNACCOUNTED";
    pid?: undefined;
  });

/**
 * What a promotion OBSERVED, never what it intended. Every field is nullable, and `null` means
 * exactly one thing: this was not read on the pass that produced this record. Nothing here is a
 * constant, because a record that asserts a fact it never checked is worse than no record
 * (PITFALLS #86).
 */
export interface MergePromotionObservation {
  /** Stable, path-free code naming what the observation found. */
  code: string;
  /** main's HEAD as read after the attempt; null when it could not be read. */
  mainHead: string | null;
  /**
   * True only when the observed HEAD is a two-parent commit whose first parent is the pre-promotion
   * head and whose second is the authorized candidate head. Anything else about main is not the
   * merge the owner approved, whatever else it may be.
   */
  authorizedMergeCommit: boolean | null;
  mergeInProgress: boolean | null;
  worktreeRestored: boolean | null;
  stashRestored: boolean | null;
  /** True only when every reflog entry recorded before the attempt is still present, in order. */
  reflogPreserved: boolean | null;
  /**
   * Every aspect of main that differs from the pre-promotion fingerprints, by name. Absent means the
   * comparison could not be run — never "nothing differs". An unresolved promotion that does not
   * name what moved leaves the owner with nothing to act on.
   */
  differences?: string[];
  /** A copy-and-paste command the owner can run themselves. Nothing here ever executes it. */
  recovery?: string;
  /** Whether the recovery ref still names the candidate head, read back after the attempt. */
  recoveryRefIntact: boolean | null;
  /** Present when the attempt itself reported something; absent when this is a later observation. */
  attempt?: { exitCode: number; timedOut: boolean };
  /**
   * The process group the merge subprocess was spawned into, recorded the instant it was spawned and
   * set to null the first time an observation establishes that the merge is over.
   *
   * It exists because the merge is `detached`: killing the orchestrator does NOT kill the `git merge`
   * it started, and that merge goes on to write main to completion. Without this, a reader arriving
   * during that window sees an owner process that is gone and a repository mid-write, calls it
   * undetermined, and freezes that answer while the merge quietly succeeds behind it.
   *
   * It is NOT carried forward unconditionally. A pid is a reused name, not an identity: macOS wraps
   * around 99999 and a reboot restarts the numbering from the bottom — and a reboot is the single
   * likeliest reason a promotion is unresolved in the first place. Carrying a dead group's number
   * into every later observation is the same defect as PITFALLS #67, one level up.
   */
  mergePgid?: number | null;
  /**
   * What makes the number above identifiable rather than merely numeric. Without it a recycled pid
   * reads as "the merge is still running" forever, which closes the only route out.
   */
  mergeGroup?: MergeProcessGroupIdentity | null;
  /**
   * Present when the merge itself is over but processes it started are still alive — a hook that
   * backgrounded a dev server, a watcher, a log tailer. Reported so it is visible; it does not stop
   * the record from settling, because the write to main is what a conclusion is about and that write
   * is finished.
   */
  mergeGroupSurvivors?: { pgid: number; inspect: string };
  /**
   * Recorded when the owner declared, explicitly and by pid, that a process group this record was
   * waiting on is no longer theirs to wait for. Attributed rather than stated as an observation: it
   * is the owner's assertion, and the record says so.
   */
  mergeGroupDisowned?: {
    pgid: number;
    at: string;
    decidedBy: string;
    /** The boot that pgid belonged to, so a disowned number is still identifiable afterwards. */
    bootAtSec?: number | null;
    /**
     * True when the owner disowned a group whose LEADER was answering "alive" at that moment — the
     * one case where the merge may genuinely still be writing main. Recorded because it changes what
     * the record may offer afterwards: no destructive recovery command while that is possible.
     */
    whileRunning?: boolean;
  };
  /**
   * True when the single write that records the merge's process group is KNOWN to have failed.
   *
   * Amendment (N). It is not "no group was recorded" — it is "a group existed and this record did
   * not get it", which is the opposite conclusion, and until this field existed the two were the
   * same bytes on disk. Set from a marker file rather than from this payload, because the reason the
   * payload lacks the number is that writing to this database failed.
   */
  mergeIdentityUnrecorded?: true;
  /**
   * Recorded when the owner declared, explicitly and by pid, that the process which STARTED this
   * promotion is not one this record should keep waiting for.
   *
   * The way in is the same shape as `mergeGroupDisowned` and exists for the same reason: within one
   * boot the operating system can hand `owner_pid` to an unrelated process of the same user, and
   * `kill(pid, 0)` cannot tell that apart from the original. Without an owner-side release, such a
   * row waits on it forever and the task can never be promoted again — a product with no path.
   */
  ownerProcessDisowned?: { pid: number; at: string; decidedBy: string };
  /**
   * Recorded when the owner declared that a promotion whose merge NOTHING can account for should
   * stop waiting.
   *
   * Amendment (O). The other two declarations quote a number, which is what proves the owner read
   * the record. There is no number here — that is the state being released — so what the owner
   * quotes is the phrase, and what the record hands them beforehand is the read-only search that
   * would find such a merge if one existed. It is the ONLY thing that can end this wait, because
   * every source has fallen silent and silence may not end it.
   */
  mergeAccountAbandoned?: { at: string; decidedBy: string };
  /**
   * Recorded when the owner declared that a promotion row NOBODY CAN READ should stop claiming the
   * project's exclusive marker.
   *
   * It is written into the row this same declaration is about, which is only sound because that row
   * is already unreadable: nothing here recomputes its hash, so the record does not acquire a valid
   * signature it never had. It is stored rather than returned once because a declaration that exists
   * only in one call's return value cannot be read back — and then "released" and "still claiming the
   * project" look identical on the next read, which is the state bar item 13 forbids.
   */
  unreadableRecordReleased?: {
    at: string;
    decidedBy: string;
    /** What the best-effort probe could still see at that moment. Attributed to that instant only. */
    aliveAtRelease?: Array<{ kind: string; pid: number }>;
  };
  /**
   * The boot the process that started this promotion belonged to.
   *
   * `owner_pid` on its own is the same defect as a bare pgid, one level up: after a reboot the
   * number names some unrelated process, `processAlive` answers "yes", and an `applying` row waits
   * on it for the rest of its life — while a reboot is one of the likeliest ways a promotion is left
   * unresolved in the first place. Absent on rows written before this was recorded, which keeps the
   * previous behaviour for them rather than inventing a boot they never had.
   */
  ownerBootAtSec?: number | null;
  /**
   * The hooks git actually executed during this attempt and what each returned, read back from git's
   * own trace stream. Absent means it was not read; an empty array means it was read and no hook ran.
   */
  hooksExecuted?: Array<{ name: string; path: string; exitCode: number | null }>;
  /**
   * What the recovery command in `recovery` would do, named rather than left for the owner to infer
   * from the command text. `inspect` never writes.
   */
  recoveryKind?: "reset-to-pre-promotion" | "inspect-observed-merge" | "inspect-live-merge"
    /**
     * Amendment (O). Nothing accounts for this promotion's merge, so nothing here may offer to
     * rewrite the repository. The command is a read-only SEARCH for the merge the record lost.
     */
    | "search-for-unaccounted-merge";
  /**
   * Why the record was or was not allowed to conclude, named rather than left to be inferred from
   * which command `recovery` happens to hold. Amendment (O): the default is "cannot conclude", and
   * a reader has to be able to see which positive evidence moved it off that default.
   */
  mergeConclusion?: MergeConclusionReason;
  observedAt: string;
}

export interface MergePromotion {
  id: string;
  approvalId: string;
  taskId: string;
  roomId: string;
  mainPath: string;
  mainBranch: string;
  candidateHead: string;
  recoveryRef: string;
  /** The commit main was on before anything was written; the commit a rollback returns to. */
  mainHeadBefore: string;
  /** Observed after the attempt. Absent when nothing could be observed. */
  mainHeadAfter?: string;
  state: MergePromotionState;
  observation: MergePromotionObservation;
  /**
   * True while the process that started this promotion is still alive. A live `applying` row is a
   * promotion in progress; a dead one is a crash, and only the second needs a human.
   */
  ownerAlive: boolean | null;
  /**
   * Present only while this row cannot be settled, and re-derived on every read. It names the exact
   * process that is the reason, so "still writing" is something an owner can look at rather than a
   * status they can only wait on.
   */
  pending?: MergePromotionPending;
  startedAt: string;
  updatedAt: string;
}

/**
 * One durable transition of a promotion, handed to whoever owns the audit chain and the room ledger.
 *
 * The registry writes durable rows and knows nothing about either, exactly as it knows nothing about
 * them for approval drift. Everything in here is a value the registry already OBSERVED and committed
 * — nothing is recomputed for the ledger's benefit, so a ledger entry cannot claim something the
 * durable record does not also say.
 */
export interface MergePromotionEvent {
  phase:
    | "started" | "settled" | "re-observed" | "merge-group-abandoned" | "owner-process-abandoned"
    | "promotion-abandoned" | "unreadable-record-released";
  promotionId: string;
  approvalId: string;
  taskId: string;
  roomId: string;
  mainPath: string;
  /**
   * The three values below and `mainHeadBefore` are null on exactly one phase:
   * `unreadable-record-released`, where the only place they could have come from is a row whose
   * integrity check failed. Null there means "this trail does not assert them", and the row's own
   * copies travel in `detail.unverifiedRowValues` behind `detail.unverifiedSource`.
   */
  mainBranch: string | null;
  candidateHead: string | null;
  recoveryRef: string | null;
  /** main's HEAD as observed BEFORE anything was written. */
  mainHeadBefore: string | null;
  /** main's HEAD as observed after. Null means it was not read on the pass that produced this. */
  mainHeadAfter: string | null;
  /**
   * True only when both observations succeeded and produced the same commit — a promotion that
   * created no new commit. Null when the second observation could not be made. Recording one commit
   * id and calling it "applied" is precisely what this exists to prevent.
   */
  mainHeadUnchanged: boolean | null;
  state: MergePromotionState;
  observation: MergePromotionObservation;
  /** True only when an authorized merge commit was observed at main's HEAD. */
  mainMutated: boolean;
  /** From the approval row this promotion spent, never a free-text constant. */
  decidedBy: string | null;
  previewDigest: string | null;
  approvalState: string | null;
  at: string;
  detail?: Record<string, unknown>;
}

/**
 * Where a recorded merge process group was read from.
 *
 * Named per source rather than folded into one number because the whole reason there is more than
 * one is that they can disagree, and the owner is the one who has to look at the disagreement. Two
 * of them live in the promotion row (`column`, `payload`) and two do not: `trace` is git's own event
 * stream for this promotion, and `spawn-record` is the marker this product writes when the single
 * write that was carrying the group id failed ([[PITFALLS]] #115, #119).
 */
export type MergeIdentitySourceName = "column" | "payload" | "trace" | "spawn-record";

/** A promotion row whose integrity check failed. Reported, never silently dropped. */
export interface UnreadableMergePromotion {
  id: string;
  taskId: string;
  state: "unreadable";
  unreadable: true;
  /**
   * The value of the row's own `state` column, present only where it matters: after the owner has
   * released such a row from the project's exclusive marker.
   *
   * The row stays unreadable — nothing here repairs it — but "unreadable and still claiming the
   * project" and "unreadable and no longer claiming it" are different facts about the repository,
   * and collapsing them would leave the owner unable to tell whether their release did anything.
   */
  storedState?: string;
  /**
   * Whether this row still claims the project's exclusive marker, re-derived from the `state` column
   * on every read. This is the fact a release changes, and it is the one the owner needs in order to
   * tell whether theirs took effect.
   */
  holdsProjectExclusiveMarker?: boolean;
  /**
   * What releasing this row would require right now: the exact phrase, and every number the record
   * was waiting on that a best-effort probe can still see, each with a read-only command that shows
   * it. Present only while the row still holds the marker, and re-derived on every read — these are
   * statements about processes that are alive at the moment of the call.
   */
  release?: {
    confirmation: string;
    alive: Array<{ kind: "merge" | "owner"; pid: number; inspect: string }>;
    /**
     * Whether the merge group could be read at all. When it is false, an empty `alive` means the
     * question could not be answered — not that nothing is running — and the phrase is the longer
     * one for that reason alone. It is also false when two sources named DIFFERENT groups: two
     * answers is not an answer.
     */
    probeReadable: boolean;
    /**
     * Every group the record names, attributed to the source that named it. More than one entry is
     * the disagreement itself, shown rather than resolved: the owner sees both numbers.
     */
    recordedGroups: Array<{
      source: MergeIdentitySourceName; pgid: number; bootAtSec: number | null;
    }>;
  };
  /** The owner's declaration, echoed back. Attributed, never presented as an observation. */
  releasedFromExclusiveMarker?: { at: string; decidedBy: string };
}

export interface MergePromotionResult {
  promotion: MergePromotion;
  /** The merge that was authorized, echoed back so no caller has to infer it. */
  authorization: MergeAuthorization;
  /** True only when an authorized merge commit was observed in main. */
  mainMutated: boolean;
}

/** What Phase 5-5 receives, and the only thing it is entitled to do. */
export interface MergeAuthorization {
  approvalId: string;
  grants: string;
  notAuthorized: readonly string[];
  singleUse: true;
  binding: MergeApprovalBinding;
  preview: CandidateCompletionPreview;
  consumedAt: string;
}

/**
 * A refusal that names the bound values that moved. The message keeps the stable code as its prefix
 * so string matching on the code still works, and appends the field names because a refusal that
 * does not say what changed leaves the owner nothing to act on.
 */
export class MergeApprovalBindingError extends Error {
  readonly changed: string[];
  /** Values that could not be read on the same attempt. Never folded into `changed`. */
  readonly unverified: string[];

  constructor(changed: string[], unverified: string[] = []) {
    super(`MAIN_MERGE_APPROVAL_BINDING_CHANGED:${changed.join(",")}`);
    this.name = "MergeApprovalBindingError";
    this.changed = changed;
    this.unverified = unverified;
  }
}

/**
 * The check could not be completed, so this attempt is refused — and nothing else happens.
 *
 * It is deliberately a different type from `MergeApprovalBindingError`, because the two demand
 * opposite handling. Drift is a fact about the world and makes the approval permanently unusable.
 * An unreadable repository is a fact about this attempt: a `chmod`, an unmounted volume, a spawn
 * that failed under load. Rounding the second to the first burns an owner decision that nothing was
 * ever wrong with, and no later recovery can bring it back, so the approval row is left untouched
 * and the caller is told to try again.
 */
export class MergeApprovalBindingUnverifiableError extends Error {
  readonly unverified: string[];

  constructor(unverified: string[]) {
    super(`MAIN_MERGE_APPROVAL_BINDING_CHECK_FAILED:${unverified.join(",")}`);
    this.name = "MergeApprovalBindingUnverifiableError";
    this.unverified = unverified;
  }
}

interface CandidateRow {
  task_id: string;
  candidate_id: string;
  room_id: string;
  main_path: string;
  main_branch: string;
  base_main_head: string;
  candidate_path: string;
  candidate_branch: string;
  task_text: string;
  acceptance_criteria: string | null;
  status: CandidateStatus;
  baseline_json: string;
  completion_json: string | null;
  created_at_ms: number;
  updated_at_ms: number;
  completed_at_ms: number | null;
  row_hash: string;
}

interface CheckpointRow {
  id: string;
  task_id: string;
  candidate_head: string;
  recovery_ref: string;
  summary: string;
  created_at_ms: number;
  row_hash: string;
}

export type CandidateRequestOperation = "start" | "checkpoint" | "complete";

type CandidateRequestState = "pending" | "succeeded" | "failed";

interface RequestRow {
  client_request_id: string;
  /**
   * Opaque proof of who currently holds this reservation. Re-minted every time the reservation is
   * adopted, so an aborting earlier owner can never satisfy the discard CAS. It must NOT be derived
   * from the clock: a timestamp does not change when two attempts land in the same millisecond.
   */
  owner_token: string;
  /**
   * OS pid of the process that currently holds the reservation. This is real liveness evidence on a
   * single-user machine, not another proxy: a reservation whose owner is gone can be terminated by
   * someone else, which is the primitive every earlier reap policy was missing. Without it the only
   * choices were "reap and burn a live creator's key" or "never reap and strand a dead one forever".
   */
  owner_pid: number;
  actor: string;
  operation: CandidateRequestOperation;
  room_id: string;
  input_digest: string;
  reserved_json: string;
  state: CandidateRequestState;
  receipt_json: string | null;
  created_at_ms: number;
  updated_at_ms: number;
  row_hash: string;
}

/**
 * The result of one binding re-check. Two lists, never one: `changed` is what was compared and
 * differs, `unverified` is what could not be compared at all. Only the first may invalidate an
 * approval, and only the first may be shown to the owner as a value that moved.
 */
interface MergeBindingVerification {
  changed: string[];
  unverified: string[];
  /**
   * The most specific reason a probe could not run, when there is one. It exists so that "the
   * preview recomputation ran out of its deadline on a large repository" reaches the owner as
   * exactly that, instead of as an undifferentiated "the check failed" that looks identical to a
   * corrupt row. A deadline that is indistinguishable from every other failure is a deadline the
   * owner cannot act on.
   */
  unavailable?: string;
}

interface PromotionRow {
  id: string;
  approval_id: string;
  task_id: string;
  room_id: string;
  main_path: string;
  main_branch: string;
  candidate_head: string;
  recovery_ref: string;
  main_head_before: string;
  main_head_after: string | null;
  restore_json: string;
  observation_json: string;
  state: MergePromotionState;
  owner_pid: number;
  started_at_ms: number;
  updated_at_ms: number;
  row_hash: string;
  /**
   * The merge subprocess group, in a column of its own so that it survives whatever happened to
   * `observation_json`. Null means "no group is recorded", which is the truth before the merge is
   * spawned and again once an observation has established that it is over.
   *
   * Written by `#writePromotion`, and there derived from the observation being written, so a row
   * that went through that helper cannot hold two different answers. The one write that does NOT
   * maintain the pair is `#releaseUnreadablePromotion`, which edits an already-unreadable row's
   * payload with a raw UPDATE on purpose; disagreement there is harmless because the row is
   * unreadable either way, and `#assertPromotionRow` treats disagreement as damage in any case.
   */
  merge_pgid: number | null;
  /** The boot that `merge_pgid` belongs to. A pid from another boot names somebody else. */
  merge_boot_at_sec: number | null;
}

interface MergeApprovalRow {
  id: string;
  /**
   * The approval row IS the durable artifact of `main_merge_request`, so it carries its own
   * idempotency instead of borrowing the candidate request ledger. One UNIQUE column answers "did my
   * request land?" without a reservation, an owner token or a second state machine to keep honest.
   */
  client_request_id: string;
  input_digest: string;
  task_id: string;
  completion_id: string;
  room_id: string;
  main_path: string;
  main_branch: string;
  candidate_path: string;
  base_main_head: string;
  candidate_head: string;
  main_head: string;
  main_fingerprint: string;
  main_ignored_fingerprint: string;
  recovery_ref: string;
  preview_digest: string;
  preview_json: string;
  grant_action: string;
  state: MergeApprovalState;
  /**
   * SHA-256 of the single-use secret handed to the owner surface at grant time, never the secret. It
   * is cleared the moment the approval leaves `approved`, so a spent approval holds no usable secret.
   */
  token_hash: string | null;
  actor: string;
  decided_by: "local-web" | "local-tui" | null;
  refusal_json: string | null;
  created_at_ms: number;
  updated_at_ms: number;
  expires_at_ms: number;
  row_hash: string;
}

/** Identifiers minted once per idempotency key so a retried mutation reuses them instead of duplicating work. */
interface ReservedIdentifiers {
  taskId: string;
  candidateId?: string;
  checkpointId?: string;
  completionId?: string;
}

/**
 * The schema this build writes.
 *
 * v6 is v5 plus `merge_pgid` and `merge_boot_at_sec`. Adding columns without moving this number
 * looked free — `ADD COLUMN` is additive and no stored hash moves — but it left the DOWNGRADE
 * direction with no name: an older build opening a database this one has touched still saw
 * "version 5", accepted it, and failed later inside SQLite with `table candidate_merge_promotions
 * has 19 columns but 17 values were supplied`, from its own positional INSERT. That failure lands
 * before the approval is spent, so the direction was already closed — but a raw SQLite message is
 * not an answer an owner can act on. Moving the number makes the older build refuse at OPEN, by
 * name, with `CANDIDATE_REGISTRY_SCHEMA_UNSUPPORTED`, which is the check it already has.
 */
const SCHEMA_VERSION = 6;
const MAX_LIST = 100;
const MAX_TESTS = 32;
const MAX_RISKS = 32;
const MAX_STATUS_SUMMARY = 16_000;
const LARGE_FILE_BYTES = 5 * 1_048_576;
const CREATING_RECOVERY_GRACE_MS = 5 * 60_000;
/**
 * `pending` conflates three situations that need different handling: executing right now, died
 * before persisting anything, and died mid-mutation. Liveness of the KEY is therefore tracked
 * exactly, in memory, by the executing process (`CANDIDATE_REQUEST_IN_FLIGHT`); a reservation that
 * persisted nothing is discarded outright; and correctness across processes rests on the terminal
 * `succeeded` state plus row-hash compare-and-set, not on a timer.
 *
 * `CREATING_RECOVERY_GRACE_MS` above is a separate concern and IS a wall clock: it bounds how long a
 * half-created candidate row is assumed to belong to a still-running creator before reconcileCreating
 * ages it out. A retry that lands in that window gets `CANDIDATE_REQUEST_RECOVERING`, not IN_FLIGHT.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ROOM_PATTERN = /^[a-z][a-z0-9-]{0,47}$/u;
const HEAD_PATTERN = /^[0-9a-f]{40,64}$/u;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const MODE_PATTERN = /^[0-7]{6}$/u;
/**
 * One `git diff --raw -z` record: `:<src mode> <dst mode> <src sha> <dst sha> <status><score?>`.
 * Anchored and exact, because a record this parser does not fully understand is a record whose
 * modes it must not guess at — a wrong mode here is a permission change reported as ordinary.
 */
const RAW_DIFF_RECORD = /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]{4,64}) ([0-9a-f]{4,64}) ([A-Z])([0-9]{0,3})$/u;
const ABSENT_MODE = "000000";
const SUBMODULE_MODE = "160000";
const MAX_PREVIEW_PATH = 4_096;
const CHECKPOINT_REF_PATTERN = /^refs\/orchestratory\/checkpoints\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/u;
const MAX_RECEIPT_BYTES = 1_000;
const MAX_ACTOR = 64;
/**
 * Upper bound on one orphan recovery-ref report. A result of exactly this length means the scan was
 * truncated and more orphans may exist; it never means the repository holds exactly this many.
 */
export const MAX_ORPHAN_RECOVERY_REFS = 100;
/**
 * Upper bound on the reported submodule and merge-conflict path lists. Reaching it sets the matching
 * truncation flag, exactly as `filesTruncated` does; it never means the list is complete.
 */
export const MAX_PREVIEW_SUBMODULES = 100;
export const MAX_MERGE_CONFLICTS = 100;
/**
 * Bounded stdout budget for the merge simulation. Streamed stdout bypasses the process runner's
 * capture ceiling, so this is counted here; exceeding it fails closed rather than truncating, because
 * a half-read conflict list would understate the conflicts the owner is being asked to approve.
 */
const MERGE_TREE_OUTPUT_BYTES = 1_048_576;
/** Bounded stdout budget for the orphan scan; an oversized ref listing fails closed, never truncates. */
const ORPHAN_REF_SCAN_BYTES = 262_144;
/** Fixed-size success marker; the answer itself is always rebuilt from durable state on replay. */
const SETTLED_RECEIPT = "{\"settled\":true}";
/** 32 random bytes, base64url. Same shape as every other single-use approval secret in the product. */
const MERGE_APPROVAL_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const MAX_MERGE_REFUSAL_CHANGED = 20;
/**
 * Upper bound on the pathspec handed to the overwrite scan. Exceeding it makes the scan report
 * itself unchecked, which is a blocker; it never silently scans a prefix. `maxFiles` (500 by
 * default) already bounds the preview's file list well below this.
 */
const MAX_OVERWRITE_SCAN_PATHS = 2_000;
/** Upper bound on the paths reported back. The blocker fires on the count, not on the report. */
const MAX_OVERWRITE_REPORTED_PATHS = 100;
/**
 * How long one recomputed preview digest may be reused across OBSERVATION paths.
 *
 * Every observation of an approval was recomputing the whole snapshot — streaming every changed
 * file and simulating the merge — under a 30-second command deadline. A dialog polling every five
 * seconds therefore re-ran the most expensive operation in the product every five seconds, and on a
 * repository large enough to approach that deadline it did so with no chance of ever finishing. The
 * throttle applies ONLY to observation: grant and promotion recompute unconditionally, because those
 * are the two moments where the answer is acted on rather than displayed.
 */
export const MERGE_PREVIEW_RECOMPUTE_THROTTLE_MS = 5_000;
/** Stable code for a preview recomputation that ran out of its deadline, kept distinct on purpose. */
export const MERGE_PREVIEW_DEADLINE_CODE = "MAIN_MERGE_PREVIEW_DEADLINE_EXCEEDED";
const MAX_MERGE_REJECT_REASON = 240;
/** Terminal states can never become usable again; only these leave the one-open-approval slot free. */
const MERGE_APPROVAL_TERMINAL: ReadonlySet<MergeApprovalState> =
  new Set<MergeApprovalState>(["consumed", "rejected", "invalidated", "expired"]);

/**
 * Failures that are a VERDICT about this logical request, and are therefore the only ones allowed to
 * write the terminal `failed` state onto an idempotency key.
 *
 * `failed` is unrecoverable by design: #beginRequest answers every later use of that key with
 * CANDIDATE_REQUEST_FAILED_RETRY_WITH_NEW_KEY, and a new key is a new logical request that knows
 * nothing about what the burnt one may already have persisted. Spending that on "the external disk
 * blinked", "a permission flickered", "git took longer than the deadline on a large repository" or
 * "git could not be spawned at all" destroys work that nothing was wrong with, and restoring the
 * machine does not bring it back — the same defect the merge-approval binding check was carrying
 * (see #verifyMergeBinding), one layer down.
 *
 * So the list is an allowlist, not a denylist, and the default is "outcome unknown". Every entry
 * here is a fact about the request that no amount of environmental recovery can change:
 *
 * - the reserved recovery ref already exists naming a different commit, so this key's reserved
 *   checkpoint identity can never be written;
 * - the reserved identifiers are not well formed, so every retry composes the same invalid ref;
 * - main moved off the base head this key recorded, so the candidate this key reserved can no
 *   longer be branched from what it was reserved against;
 * - the worktree that was created is not the one that was asked for, which is a scope refusal;
 * - git read the repository's local config successfully and it configures a clean/smudge filter or
 *   fsmonitor, which is a policy refusal about the repository, not a failed read of it. (The failed
 *   read has its own code and is deliberately not on this list.)
 *
 * Anything else — including the deliberately ambiguous CANDIDATE_GIT_COMMAND_FAILED, every SQLite
 * error, and every spawn failure — leaves the key `pending`, which is exactly what `pending` means:
 * outcome unknown, retry the same key, converge on whatever was persisted. Fail closed on the
 * action, open on the key.
 */
const DETERMINATE_REQUEST_FAILURES: ReadonlySet<string> = new Set([
  "CANDIDATE_CHECKPOINT_REF_CONFLICT",
  "CANDIDATE_CHECKPOINT_REF_INVALID",
  "CANDIDATE_MAIN_HEAD_CHANGED",
  "CANDIDATE_WORKTREE_SCOPE_MISMATCH",
  "CANDIDATE_ID_INVALID",
  "CANDIDATE_BASE_HEAD_INVALID",
  "UNSAFE_LOCAL_GIT_FILTER_OR_FSMONITOR_CONFIG",
]);

/**
 * True only for a failure this module can name as a verdict. A non-Error throw, an aggregate, a
 * wrapped cause or an unrecognised code is "unknown", never "failed".
 */
function determinateRequestFailure(error: unknown): boolean {
  return error instanceof Error && DETERMINATE_REQUEST_FAILURES.has(error.message);
}

/**
 * Durable idempotency ledger for candidate mutations, keyed by clientRequestId alone.
 *
 * The seat identity is deliberately NOT part of the key. `actor` is a presence display name that is
 * re-minted when a seat reconnects after its lease expires (codex1 -> codex2), which is exactly the
 * failure this ledger exists to survive; keying on it would make the reconnect retry mint a second
 * candidate. Replay still requires operation, room and input digest to match, so a reused key can
 * only ever return the identical logical request. `actor` is retained for audit.
 */
const REQUESTS_TABLE_SQL = `CREATE TABLE candidate_requests (
        client_request_id TEXT PRIMARY KEY CHECK(length(client_request_id)=36),
        owner_token TEXT NOT NULL CHECK(length(owner_token)=36),
        owner_pid INTEGER NOT NULL CHECK(owner_pid > 0),
        actor TEXT NOT NULL CHECK(length(actor) BETWEEN 1 AND ${MAX_ACTOR}),
        operation TEXT NOT NULL CHECK(operation IN ('start','checkpoint','complete')),
        room_id TEXT NOT NULL CHECK(length(room_id) BETWEEN 1 AND 48),
        input_digest TEXT NOT NULL CHECK(length(input_digest)=64),
        reserved_json TEXT NOT NULL CHECK(length(reserved_json) BETWEEN 2 AND 400),
        state TEXT NOT NULL CHECK(state IN ('pending','succeeded','failed')),
        receipt_json TEXT CHECK(receipt_json IS NULL OR length(receipt_json) BETWEEN 2 AND ${MAX_RECEIPT_BYTES}),
        created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
        updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= created_at_ms),
        row_hash TEXT NOT NULL CHECK(length(row_hash)=64)
      ) STRICT;
      CREATE INDEX candidate_requests_created ON candidate_requests(created_at_ms);`;

/**
 * Snapshot-bound, single-use owner approval for merging one candidate into main.
 *
 * It is a separate table rather than a widening of `candidate_requests` on purpose: that ledger
 * records whether a mutation happened, while this records what an owner authorized, and the two have
 * different lifetimes, different terminal states and different consequences when they are wrong.
 *
 * The partial UNIQUE index is the structural form of "one open question per task". Without it two
 * concurrent requests could both pass an application-level check and leave the owner two dialogs for
 * the same candidate, only one of which they would read.
 */
const MERGE_APPROVALS_TABLE_SQL = `CREATE TABLE candidate_merge_approvals (
        id TEXT PRIMARY KEY CHECK(length(id)=36),
        client_request_id TEXT NOT NULL UNIQUE CHECK(length(client_request_id)=36),
        input_digest TEXT NOT NULL CHECK(length(input_digest)=64),
        task_id TEXT NOT NULL REFERENCES candidates(task_id),
        completion_id TEXT NOT NULL CHECK(length(completion_id)=36),
        room_id TEXT NOT NULL CHECK(length(room_id) BETWEEN 1 AND 48),
        main_path TEXT NOT NULL CHECK(length(main_path) BETWEEN 1 AND 4096),
        main_branch TEXT NOT NULL CHECK(length(main_branch) BETWEEN 1 AND 255),
        candidate_path TEXT NOT NULL CHECK(length(candidate_path) BETWEEN 1 AND 4096),
        base_main_head TEXT NOT NULL CHECK(length(base_main_head) BETWEEN 40 AND 64),
        candidate_head TEXT NOT NULL CHECK(length(candidate_head) BETWEEN 40 AND 64),
        main_head TEXT NOT NULL CHECK(length(main_head) BETWEEN 40 AND 64),
        main_fingerprint TEXT NOT NULL CHECK(length(main_fingerprint)=64),
        main_ignored_fingerprint TEXT NOT NULL CHECK(length(main_ignored_fingerprint)=64),
        recovery_ref TEXT NOT NULL CHECK(length(recovery_ref) BETWEEN 1 AND 512),
        preview_digest TEXT NOT NULL CHECK(length(preview_digest)=64),
        preview_json TEXT NOT NULL CHECK(length(preview_json) BETWEEN 2 AND 1000000),
        grant_action TEXT NOT NULL CHECK(grant_action='${MERGE_APPROVAL_GRANT}'),
        state TEXT NOT NULL CHECK(state IN ('requested','approved','consumed','rejected','invalidated','expired')),
        token_hash TEXT CHECK(token_hash IS NULL OR length(token_hash)=64),
        actor TEXT NOT NULL CHECK(length(actor) BETWEEN 1 AND ${MAX_ACTOR}),
        decided_by TEXT CHECK(decided_by IS NULL OR decided_by IN ('local-web','local-tui')),
        refusal_json TEXT CHECK(refusal_json IS NULL OR length(refusal_json) BETWEEN 2 AND 1000),
        created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
        updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= created_at_ms),
        expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms > created_at_ms),
        row_hash TEXT NOT NULL CHECK(length(row_hash)=64)
      ) STRICT;
      CREATE INDEX candidate_merge_approvals_task ON candidate_merge_approvals(task_id, created_at_ms);
      CREATE UNIQUE INDEX candidate_merge_approvals_open ON candidate_merge_approvals(task_id)
        WHERE state IN ('requested','approved');`;

/**
 * The exclusive marker, and what it is exclusive ON.
 *
 * `approval_id UNIQUE` serialises two callers holding the same token. It says nothing about the
 * repository: two DIFFERENT approvals, for two different tasks over one main, satisfy it completely
 * and could be `applying` at the same instant. When that was measured the second promotion was
 * indeed refused — but by the dirty-working-tree gate, because the first merge had already made main
 * dirty. A gate that holds by coincidence is not a gate, and the coincidence is gone in the window
 * before the first merge has written anything.
 *
 * A partial unique index on `main_path` where `state='applying'` is a marker SQLite itself enforces:
 * held for exactly as long as a promotion is under way, visible to every reader in every process,
 * and impossible for a future call site to forget the way an explicit check can (PITFALLS #74).
 */
const MERGE_PROMOTIONS_EXCLUSIVE_SQL = `CREATE UNIQUE INDEX candidate_merge_promotions_applying
        ON candidate_merge_promotions(main_path) WHERE state='applying';`;

/**
 * The merge process group's own columns, in the order `ALTER TABLE ... ADD COLUMN` appends them.
 *
 * They are listed LAST in the table definition rather than beside `owner_pid`, where they belong by
 * meaning, for one reason: a database created by this build and a database upgraded into it must end
 * up with the same column order, and `ADD COLUMN` can only append. The statements that write them
 * spell the columns out ([[PITFALLS]] #59), so nothing depends on the position — but two
 * different orders for one schema version is the kind of difference that only shows up later.
 */
const MERGE_PROMOTIONS_GROUP_COLUMNS = ["merge_pgid", "merge_boot_at_sec"] as const;

/**
 * The durable INTENT to write canonical main, and the record of what was observed afterwards.
 *
 * It exists because spending the approval and writing main cannot be one atomic act: one is a SQLite
 * transaction, the other is a subprocess mutating a working tree. What CAN be atomic is spending the
 * approval and recording that main is about to be written, and that is exactly what this row is —
 * inserted in the same transaction that consumes the approval, before git is invoked. A process that
 * dies at any point after that leaves this row behind saying "a promotion was under way", which is
 * the honest answer, and the observation that resolves it looks at the repository rather than
 * retrying anything.
 *
 * `owner_pid` distinguishes "still running" from "died". Without it a reader could not tell a
 * promotion in flight in another process from a crashed one, and would have to either report every
 * live promotion as needing manual review or settle a running one as finished.
 *
 * `merge_pgid` and `merge_boot_at_sec` are columns for exactly the same reason, arrived at the same
 * way — by measurement. The merge's process group used to live ONLY inside `observation_json`, and
 * `observation_json` is the first thing that cannot be trusted when a row fails its hash: a
 * corruption that touched the payload left `promotionGroupIdentity()` answering `null`, which the
 * release requirement read as "no merge is alive" and handed out the short phrase while `ps -g`
 * could still list the `git merge`, its hook and its `sleep`. That is [[PITFALLS]] #85 in its
 * sharpest form — "I cannot read this" turned into "I know, and the news is good" — and the answer
 * is the one `owner_pid` already had: give the fact its own column, so losing the payload does not
 * lose the number the owner needs to quote.
 */
const MERGE_PROMOTIONS_TABLE_SQL = `CREATE TABLE candidate_merge_promotions (
        id TEXT PRIMARY KEY CHECK(length(id)=36),
        approval_id TEXT NOT NULL UNIQUE CHECK(length(approval_id)=36),
        task_id TEXT NOT NULL REFERENCES candidates(task_id),
        room_id TEXT NOT NULL CHECK(length(room_id) BETWEEN 1 AND 48),
        main_path TEXT NOT NULL CHECK(length(main_path) BETWEEN 1 AND 4096),
        main_branch TEXT NOT NULL CHECK(length(main_branch) BETWEEN 1 AND 255),
        candidate_head TEXT NOT NULL CHECK(length(candidate_head) BETWEEN 40 AND 64),
        recovery_ref TEXT NOT NULL CHECK(length(recovery_ref) BETWEEN 1 AND 512),
        main_head_before TEXT NOT NULL CHECK(length(main_head_before) BETWEEN 40 AND 64),
        main_head_after TEXT CHECK(main_head_after IS NULL OR length(main_head_after) BETWEEN 40 AND 64),
        restore_json TEXT NOT NULL CHECK(length(restore_json) BETWEEN 2 AND 8000),
        observation_json TEXT NOT NULL CHECK(length(observation_json) BETWEEN 2 AND 8000),
        state TEXT NOT NULL CHECK(state IN ('applying','applied','rolled-back','needs-manual-review')),
        owner_pid INTEGER NOT NULL CHECK(owner_pid > 0),
        started_at_ms INTEGER NOT NULL CHECK(started_at_ms >= 0),
        updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= started_at_ms),
        row_hash TEXT NOT NULL CHECK(length(row_hash)=64),
        ${MERGE_PROMOTIONS_GROUP_COLUMNS.map((column) => `${column} INTEGER`).join(",\n        ")}
      ) STRICT;
      CREATE INDEX candidate_merge_promotions_task
        ON candidate_merge_promotions(task_id, started_at_ms DESC);
      ${MERGE_PROMOTIONS_EXCLUSIVE_SQL}`;

function sha(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function text(value: unknown, code: string, max: number): string {
  if (typeof value !== "string" || value.trim().length < 1 || value.length > max || value.includes("\0")) {
    throw new Error(code);
  }
  return value.trim();
}

function baseline(input: GitInspection, ignored: { files: number; fingerprint: string }): CandidateBaseline {
  return {
    clean: input.clean,
    changedFiles: input.changedFiles,
    changedLines: input.changedLines,
    changedBytes: input.changedBytes,
    untrackedFiles: input.untrackedFiles,
    ignoredFiles: ignored.files,
    ignoredFingerprint: ignored.fingerprint,
    statusSummary: input.statusSummary.slice(0, MAX_STATUS_SUMMARY),
    fingerprint: input.fingerprint,
  };
}

function validateBaseline(value: unknown): CandidateBaseline {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("CANDIDATE_BASELINE_INVALID");
  const input = value as Record<string, unknown>;
  const keys = [
    "clean", "changedFiles", "changedLines", "changedBytes", "untrackedFiles", "ignoredFiles",
    "ignoredFingerprint", "statusSummary", "fingerprint",
  ];
  if (Object.keys(input).some((key) => !keys.includes(key)) || typeof input.clean !== "boolean"
    || typeof input.statusSummary !== "string" || input.statusSummary.length > MAX_STATUS_SUMMARY
    || typeof input.fingerprint !== "string" || !HASH_PATTERN.test(input.fingerprint)
    || typeof input.ignoredFingerprint !== "string" || !HASH_PATTERN.test(input.ignoredFingerprint)) {
    throw new Error("CANDIDATE_BASELINE_INVALID");
  }
  for (const key of ["changedFiles", "changedLines", "changedBytes", "untrackedFiles", "ignoredFiles"] as const) {
    if (!Number.isSafeInteger(input[key]) || Number(input[key]) < 0) throw new Error("CANDIDATE_BASELINE_INVALID");
  }
  return input as unknown as CandidateBaseline;
}

function tests(value: unknown): CandidateTestResult[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_TESTS) throw new Error("CANDIDATE_TESTS_INVALID");
  return value.map((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) throw new Error("CANDIDATE_TESTS_INVALID");
    const input = item as Record<string, unknown>;
    if (Object.keys(input).some((key) => !["command", "status", "summary"].includes(key))
      || (input.status !== "passed" && input.status !== "failed" && input.status !== "not-run")) {
      throw new Error("CANDIDATE_TESTS_INVALID");
    }
    return {
      command: text(input.command, "CANDIDATE_TESTS_INVALID", 500),
      status: input.status,
      ...(input.summary === undefined ? {} : { summary: text(input.summary, "CANDIDATE_TESTS_INVALID", 1_000) }),
    };
  });
}

/**
 * One `git diff --raw -z` record, parsed exactly.
 *
 * Exported only so the negative tests can drive it directly: git cannot be asked to emit a record it
 * does not know how to write, yet the whole point of this parser is what it does with one. It is a
 * pure function with no side effects and no privileged access.
 */
export function parseRawDiffRecord(token: string): { from: string; to: string; code: string } {
  const parsed = RAW_DIFF_RECORD.exec(token);
  const from = parsed?.[1];
  const to = parsed?.[2];
  const code = parsed?.[5];
  if (from === undefined || to === undefined || code === undefined) throw new Error("CANDIDATE_DIFF_INVALID");
  return { from, to, code };
}

/** Read-path check for a stored, bounded list of preview paths. */
function previewPaths(value: unknown, max: number): string[] {
  if (!Array.isArray(value) || value.length > max) throw new Error("CANDIDATE_COMPLETION_PREVIEW_INVALID");
  return value.map((item) => text(item, "CANDIDATE_COMPLETION_PREVIEW_INVALID", MAX_PREVIEW_PATH));
}

/**
 * Read-path check for the per-file mode and submodule facts. A stored preview is re-validated before
 * it is shown, so these must be as strict on the way in as they were on the way out: a `mode` whose
 * two sides are equal, or a `submodule` that is anything but `true`, is not a fact this code ever
 * wrote and is therefore refused rather than displayed.
 */
function previewFileFacts(value: unknown): void {
  if (!Array.isArray(value)) throw new Error("CANDIDATE_COMPLETION_PREVIEW_INVALID");
  for (const item of value) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error("CANDIDATE_COMPLETION_PREVIEW_INVALID");
    }
    const file = item as Record<string, unknown>;
    if (file.submodule !== undefined && file.submodule !== true) {
      throw new Error("CANDIDATE_COMPLETION_PREVIEW_INVALID");
    }
    if (file.mode === undefined) continue;
    if (typeof file.mode !== "object" || file.mode === null || Array.isArray(file.mode)) {
      throw new Error("CANDIDATE_COMPLETION_PREVIEW_INVALID");
    }
    const mode = file.mode as Record<string, unknown>;
    if (typeof mode.from !== "string" || !MODE_PATTERN.test(mode.from)
      || typeof mode.to !== "string" || !MODE_PATTERN.test(mode.to) || mode.from === mode.to) {
      throw new Error("CANDIDATE_COMPLETION_PREVIEW_INVALID");
    }
  }
}

/**
 * Read-path check for a whole stored preview. Shared by the frozen completion and by the snapshot a
 * merge approval is bound to, because both are shown to an owner who is about to act on them, and a
 * preview validated at only one of the two entry points is a preview that can be displayed unchecked.
 */
function assertPreviewShape(value: unknown): CandidateCompletionPreview {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("CANDIDATE_COMPLETION_PREVIEW_INVALID");
  }
  const preview = value as CandidateCompletionPreview;
  tests(preview.tests);
  risks(preview.knownRisks);
  previewFileFacts(preview.files);
  previewPaths(preview.submodules, MAX_PREVIEW_SUBMODULES);
  previewPaths(preview.mergeConflicts, MAX_MERGE_CONFLICTS);
  if (!HEAD_PATTERN.test(preview.baseMainHead) || !HEAD_PATTERN.test(preview.candidateHead)
    || !HEAD_PATTERN.test(preview.mainHead) || !isAbsolute(preview.candidatePath) || !isAbsolute(preview.mainPath)
    || !Array.isArray(preview.largeFiles) || !Array.isArray(preview.conflicts)
    || !Number.isSafeInteger(preview.fileCount) || preview.fileCount < preview.files.length
    || !Number.isSafeInteger(preview.additions) || preview.additions < 0
    || !Number.isSafeInteger(preview.deletions) || preview.deletions < 0
    || !Number.isSafeInteger(preview.binaryEntries) || preview.binaryEntries < 0
    || !Number.isSafeInteger(preview.modeChanges) || preview.modeChanges < 0
    || preview.modeChanges > preview.fileCount
    || typeof preview.filesTruncated !== "boolean"
    || typeof preview.submodulesTruncated !== "boolean" || typeof preview.mergeConflictsTruncated !== "boolean"
    || typeof preview.mergeable !== "boolean"
    // A stored preview that claims both "this merges cleanly" and a list of conflicting paths is
    // not a preview with a defect in one field; it is two contradictory answers to the question the
    // owner is about to act on, so neither is shown.
    || (preview.mergeable && (preview.mergeConflicts.length > 0 || preview.mergeConflictsTruncated))
    || preview.recovery?.ready !== true || preview.recovery.kind !== "git-checkpoint-ref"
    || !CHECKPOINT_REF_PATTERN.test(preview.recovery.ref)
    || preview.recovery.head !== preview.candidateHead) {
    throw new Error("CANDIDATE_COMPLETION_PREVIEW_INVALID");
  }
  validateBaseline(preview.mainDirty);
  return preview;
}

function risks(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_RISKS) throw new Error("CANDIDATE_RISKS_INVALID");
  return value.map((item) => text(item, "CANDIDATE_RISKS_INVALID", 1_000));
}

function rowHash(row: Omit<CandidateRow, "row_hash">): string {
  return sha(JSON.stringify([
    row.task_id, row.candidate_id, row.room_id, row.main_path, row.main_branch,
    row.base_main_head, row.candidate_path, row.candidate_branch, row.task_text,
    row.acceptance_criteria, row.status, row.baseline_json, row.completion_json,
    row.created_at_ms, row.updated_at_ms, row.completed_at_ms,
  ]));
}

function checkpointHash(row: Omit<CheckpointRow, "row_hash">): string {
  return sha(JSON.stringify([
    row.id, row.task_id, row.candidate_head, row.recovery_ref, row.summary, row.created_at_ms,
  ]));
}

function requestHash(row: Omit<RequestRow, "row_hash">): string {
  return sha(JSON.stringify([
    row.client_request_id, row.owner_token, row.owner_pid, row.actor, row.operation, row.room_id, row.input_digest,
    row.reserved_json, row.state, row.receipt_json, row.created_at_ms, row.updated_at_ms,
  ]));
}

/**
 * Canonical digest of the caller-visible mutation input. Key reuse with a different digest is a
 * client bug or an attempted payload swap, so it fails closed instead of silently replaying.
 */
function requestDigest(operation: CandidateRequestOperation, payload: unknown): string {
  return sha(JSON.stringify([operation, payload]));
}

function requestKey(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) throw new Error("CANDIDATE_CLIENT_REQUEST_ID_INVALID");
  return value;
}

function mergeApprovalHash(row: Omit<MergeApprovalRow, "row_hash">): string {
  return sha(JSON.stringify([
    row.id, row.client_request_id, row.input_digest, row.task_id, row.completion_id, row.room_id,
    row.main_path, row.main_branch, row.candidate_path, row.base_main_head, row.candidate_head,
    row.main_head, row.main_fingerprint, row.main_ignored_fingerprint, row.recovery_ref,
    row.preview_digest, row.preview_json, row.grant_action, row.state, row.token_hash, row.actor,
    row.decided_by, row.refusal_json, row.created_at_ms, row.updated_at_ms, row.expires_at_ms,
  ]));
}

/**
 * The row's integrity digest.
 *
 * The two merge-group columns are appended only when at least one of them holds something, so a row
 * written before those columns existed hashes to exactly the value it was stored with. Bar item 11
 * is about precisely this: a database written by the previous commit must stay readable, and an
 * integrity check that suddenly rejects every existing promotion would report tampering where there
 * was an upgrade ([[PITFALLS]] #100).
 */
function mergePromotionHash(row: Omit<PromotionRow, "row_hash">): string {
  const base = [
    row.id, row.approval_id, row.task_id, row.room_id, row.main_path, row.main_branch,
    row.candidate_head, row.recovery_ref, row.main_head_before, row.main_head_after,
    row.restore_json, row.observation_json, row.state, row.owner_pid, row.started_at_ms,
    row.updated_at_ms,
  ];
  return sha(JSON.stringify(
    row.merge_pgid === null && row.merge_boot_at_sec === null
      ? base
      : [...base, row.merge_pgid, row.merge_boot_at_sec],
  ));
}

/**
 * The largest number the process probes will treat as naming a process.
 *
 * `pid_t` is a signed 32-bit integer on macOS and Linux, and `process.kill`
 * throws `ERR_INVALID_ARG_TYPE` above that — not `ESRCH`, not `EPERM`. Nothing is REJECTED for
 * exceeding it: a recorded number too large to be a pid is a number nobody can decide about, and
 * turning "undecidable" into "no such process" is the fail-open direction ([[PITFALLS]] #85). The
 * bound exists so that the undecidable answer comes from a decision written here rather than from
 * Node's argument validation happening to throw in a convenient direction, and so the branch can be
 * reached from the public interface without replacing `process.kill`.
 *
 * Measured on this build: `2147483648`, `4294967296` and `2**53-1` all reach the probes, because
 * `promotionPgid` accepts anything up to 2^53 and `owner_pid`'s CHECK has no upper bound at all.
 */
const MAX_PID = 2 ** 31 - 1;

/**
 * A number recorded as a process group id, or `null` when the record does not carry one.
 *
 * Deliberately NOT bounded by `MAX_PID`: a value out of range still means "something wrote a group
 * here", and the probes answer `unknown` for it, which blocks a conclusion. Filtering it out at this
 * layer would turn a nonsensical record into a clean "no merge is running".
 */
function recordedPgid(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 1 ? value : null;
}

/** The merge subprocess group recorded on a promotion row, or `null` when none is recorded. */
function promotionPgid(row: PromotionRow): number | null {
  try {
    return recordedPgid((JSON.parse(row.observation_json) as MergePromotionObservation).mergePgid);
  } catch { return null; }
}

/** The identity recorded alongside a merge's process group id, read back from a promotion row. */
function promotionGroupIdentity(row: PromotionRow): MergeProcessGroupIdentity | null {
  const pgid = promotionPgid(row);
  if (pgid === null) return null;
  try {
    const value = (JSON.parse(row.observation_json) as MergePromotionObservation).mergeGroup;
    if (!value || typeof value !== "object") return { pgid, bootAtSec: null, spawnedAt: null };
    const bootAtSec = typeof value.bootAtSec === "number" && Number.isSafeInteger(value.bootAtSec)
      ? value.bootAtSec : null;
    const spawnedAt = typeof value.spawnedAt === "string" ? value.spawnedAt : null;
    return { pgid, bootAtSec, spawnedAt };
  } catch { return { pgid, bootAtSec: null, spawnedAt: null }; }
}

/**
 * What a row says about its merge's process group when the row itself cannot be trusted, and whether
 * that answer was READ or merely absent.
 *
 * The distinction is the whole point. "I probed and found no merge" and "I could not find out
 * whether there is a merge" lead to opposite actions — the first releases a project-wide marker with
 * a short phrase, the second must not — and folding them into one `null` is exactly the failure that
 * was measured: corrupt `observation_json`, `promotionGroupIdentity()` answers `null`, and the
 * release read that as good news while `ps -g` still listed a `git merge` writing to main.
 */
interface MergeIdentityReading {
  /**
   * The one group every answering source agreed on, or `null` when there is none — including when
   * there is more than one candidate, because "two answers" is not an answer.
   */
  identity: MergeProcessGroupIdentity | null;
  /**
   * False when no source could answer the question at all, AND when two sources answered it
   * differently. A `false` here NEVER means "no merge"; it means the record's answer is missing or
   * contested, and callers must treat it exactly as they treat a probe that comes back undecidable.
   */
  readable: boolean;
  /**
   * Every distinct group any source named. Probed one by one, because when the sources disagree none
   * of them can be ruled out and the one that is still writing to main must not be the one dropped.
   */
  candidates: readonly MergeProcessGroupIdentity[];
  /** Which source said what, so a disagreement can be shown rather than resolved silently. */
  sources: readonly MergeIdentitySource[];
  /**
   * True when NO source inside the row named a group and one outside it did.
   *
   * Such a number is still probed — that can only add a reason to refuse — but on its own it never
   * makes the record answered: a group only the outside source names, still answering "alive", is a
   * record that has not said what is writing to main. That test needs a probe, so it is made where
   * the probing happens ([[PITFALLS]] #120, VERIFICATION amendment (M)).
   */
  outsideRowOnly: boolean;
  /**
   * True when a source INSIDE the promotion row named a group.
   *
   * Amendment (O) and (Q). Probing a number is the only way this code ever learns that a merge is
   * over, and a probe is worth something only if the number came from somewhere the merge itself
   * cannot write. The two in-row sources are covered by the row hash; git's trace and the
   * spawn-record marker sit in a directory whose path this product hands to every hook it runs, and
   * a hook that writes a `start` event naming a number nothing is using was measured turning
   * "nobody could answer" into "asked, and the answer is no" ([[PITFALLS]] #120). So those two may
   * add a number to probe — which can only add a reason to refuse — and this flag is what stops them
   * ever supplying the positive answer that ends the wait.
   *
   * False when the two in-row sources CONTRADICT each other, for the same reason `readable` is: a
   * record that cannot say which number decides whether main is being written has not named one.
   */
  namedInRow: boolean;
}

/** One source's answer about the merge group, kept attributed. */
interface MergeIdentitySource {
  source: MergeIdentitySourceName;
  identity: MergeProcessGroupIdentity;
}

/**
 * The merge process group as the row's OWN COLUMNS hold it, independent of `observation_json`.
 *
 * A pgid with no boot beside it is refused rather than returned with `bootAtSec: null`. Every write
 * that sets one of these columns sets both, so half of the pair is damage, not an older shape — and
 * a pid without the boot it belongs to is a number that names somebody else after a restart, which
 * is [[PITFALLS]] #105 in the exact place this pair was added to close. Rows written before the
 * columns existed carry NULL in BOTH, so nothing legacy is caught by this.
 */
function columnMergeIdentity(row: PromotionRow): MergeProcessGroupIdentity | null {
  const pgid = recordedPgid(row.merge_pgid);
  if (pgid === null) return null;
  const boot = row.merge_boot_at_sec;
  if (typeof boot !== "number" || !Number.isSafeInteger(boot)) return null;
  return { pgid, bootAtSec: boot, spawnedAt: null };
}

/** The merge process group as `observation_json` holds it, and whether that payload said anything. */
function payloadMergeIdentity(row: PromotionRow): {
  identity: MergeProcessGroupIdentity | null;
  /** True only when the payload parsed to an object AND stated something about the group. */
  answered: boolean;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.observation_json);
  } catch {
    return { identity: null, answered: false };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { identity: null, answered: false };
  }
  const identity = promotionGroupIdentity(row);
  if (identity !== null) return { identity, answered: true };
  const recorded = (parsed as MergePromotionObservation).mergePgid;
  // `undefined` is a promotion that has not spawned git yet; `null` is one whose group an
  // observation established is over, or that the owner disowned. Both are answers. Anything else
  // sitting in that field is a group written by something this code does not understand.
  return { identity: null, answered: recorded === undefined || recorded === null };
}

/**
 * Whether two recorded groups are the same group.
 *
 * The number has to match exactly. The boot is compared with the same tolerance every other boot
 * comparison uses, because `bootAtSec()` is derived from `Date.now()` and `os.uptime()` sampled
 * separately and drifts by a second between calls — two sources recording the same boot routinely
 * write numbers one apart, and treating that as a disagreement would make every ordinary row
 * contested. A boot of `null` is "unknown", which cannot contradict anything.
 */
function sameMergeGroup(a: MergeProcessGroupIdentity, b: MergeProcessGroupIdentity): boolean {
  if (a.pgid !== b.pgid) return false;
  if (a.bootAtSec === null || b.bootAtSec === null) return true;
  return Math.abs(a.bootAtSec - b.bootAtSec) <= BOOT_IDENTITY_TOLERANCE_SEC;
}

/**
 * Two readings of one group, folded into the one that can be ruled out by the least.
 *
 * A source that does not know the boot makes the pair's boot unknown, never the other source's
 * value: a known boot is what lets `mergeGroupState` answer "gone", and inheriting one from a source
 * that did not have it would be manufacturing the evidence that settles the row.
 */
function foldMergeGroup(
  a: MergeProcessGroupIdentity, b: MergeProcessGroupIdentity,
): MergeProcessGroupIdentity {
  return {
    pgid: a.pgid,
    bootAtSec: a.bootAtSec === null || b.bootAtSec === null ? null : a.bootAtSec,
    spawnedAt: a.spawnedAt ?? b.spawnedAt,
  };
}

/**
 * The merge process group of a row whose integrity check failed, read from EVERY source that has
 * one, and honest about not knowing — including when the sources do not say the same thing.
 *
 * The previous shape preferred the columns and returned the moment it found one, so a row whose
 * column said `999999` and whose payload named the `git merge` that `ps -g` was listing reported
 * `alive: []`, `probeReadable: true`, and handed out the short phrase. The detection was already
 * there — `#assertPromotionRow` refuses a row whose column and payload disagree — and this function
 * threw it away. Amendment (F): **when two sources both answer and their answers differ, the answer
 * is "unreadable", and every group any of them named is carried out for probing.** Picking one and
 * labelling it readable is [[PITFALLS]] #85 with two candidates instead of one.
 *
 * Four sources, and only two of them live in the damaged row:
 *  - the two columns, which a damaged payload does not take with it;
 *  - `observation_json`, which is the only source a row written before those columns has;
 *  - git's own trace stream for this promotion, which lives in a FILE, not in SQLite at all — the
 *    check [[PITFALLS]] #115 asks for, since the first two share a row and therefore a failure;
 *  - and this product's own marker for a pgid write that FAILED, which is the only source that can
 *    distinguish "there was no group" from "this record never got the group" (amendment (N)).
 *
 * The contest test is scoped to the two IN-ROW sources, for the reason spelled out at it below; the
 * outside sources still contribute candidates to probe, and one of their numbers blocking a release
 * is what the measured `col-null-key` corruption needed.
 *
 * They cannot do more than that. BOTH outside sources live in a directory whose path this product
 * hands to every hook this promotion runs, in `GIT_TRACE2_EVENT` — the marker is one line of shell
 * away from it, and the claim that it was "not handed to anything" was measured false. A hook
 * forging a `start` event that named a dead pid turned "nobody could answer" into "asked, and the
 * answer is no"; a hook emptying that same file turned four sources silent at once and got
 * `git reset --hard` offered over a live `git merge`. Amendment (M) and (Q): a source the observed
 * thing can reach may tighten, never loosen — and amendment (O) is what makes SILENCE from any
 * source, inside the row or outside it, unable to loosen either.
 *
 * `readable: false` never means "no merge". It means the record's answer is missing or contested,
 * and callers must treat it exactly as they treat a probe that comes back undecidable.
 */
function durableMergeIdentity(
  row: PromotionRow, trace: TraceMergeReading, options: { disowned: MergeProcessGroupIdentity | null },
): MergeIdentityReading {
  const column = columnMergeIdentity(row);
  const payload = payloadMergeIdentity(row);
  // A group the owner has explicitly stopped waiting on is dropped from EVERY source, not just from
  // the payload the release rewrote. Without this the release was undone one read later: the payload
  // no longer named the group, git's trace still did, and the record went straight back to waiting on
  // the number the owner had just disowned — a release with no effect is the dead end bar item 11
  // forbids. The caller decides whether this row may speak for its own owner decisions.
  const disowned = options.disowned;
  const named = (identity: MergeProcessGroupIdentity | null): MergeProcessGroupIdentity | null =>
    identity !== null && disowned !== null && sameMergeGroup(identity, disowned) ? null : identity;
  const columnNamed = named(column);
  const payloadNamed = named(payload.identity);
  const traceNamed = named(trace.identity);
  const spawnRecordNamed = named(trace.unrecorded);
  const sources: MergeIdentitySource[] = [];
  if (columnNamed !== null) sources.push({ source: "column", identity: columnNamed });
  if (payloadNamed !== null) sources.push({ source: "payload", identity: payloadNamed });
  if (traceNamed !== null) sources.push({ source: "trace", identity: traceNamed });
  if (spawnRecordNamed !== null) sources.push({ source: "spawn-record", identity: spawnRecordNamed });
  const candidates: MergeProcessGroupIdentity[] = [];
  for (const entry of sources) {
    const at = candidates.findIndex((seen) => sameMergeGroup(seen, entry.identity));
    if (at === -1) candidates.push(entry.identity);
    else candidates[at] = foldMergeGroup(candidates[at] as MergeProcessGroupIdentity, entry.identity);
  }
  // The contest is between the two IN-ROW sources only, and it has two shapes: both name a group
  // and the groups differ, or one names a group while the other states there is none. Either way the
  // record contradicts itself about the number that decides whether main is being written.
  //
  // The outside sources are deliberately not part of this test. They record a group that EXISTED; a
  // payload that says `mergePgid: null` records a later observation that the group is over. Those
  // are a timeline, not a contradiction — and treating them as one would put the short phrase
  // permanently out of service for every promotion that ever spawned git, which is the shape bar
  // item 11 forbids and the shape mutation M3 caught two rounds ago. What DOES turn the timeline
  // into a contradiction is a probe: a group that is still alive cannot be one an observation
  // established was over, and that test is made in `mergeIdentityStanding` where the probing is.
  const recordDeniesGroup = payloadNamed === null && payload.answered;
  const contested = columnNamed !== null
    && ((payloadNamed !== null && !sameMergeGroup(columnNamed, payloadNamed)) || recordDeniesGroup);
  const inRow = columnNamed ?? payloadNamed;
  const outside = traceNamed ?? spawnRecordNamed;
  const common = {
    candidates, sources,
    outsideRowOnly: inRow === null && outside !== null,
    namedInRow: inRow !== null && !contested,
  };
  if (contested) return { identity: null, readable: false, ...common };
  if (inRow !== null) {
    // An outside source naming a DIFFERENT group is a third opinion nothing can rule out. Neither
    // number is dropped, and neither is the answer.
    if (outside !== null && !sameMergeGroup(inRow, outside)) {
      return { identity: null, readable: false, ...common };
    }
    return {
      identity: outside === null ? inRow : foldMergeGroup(inRow, outside),
      readable: true,
      ...common,
    };
  }
  // No source INSIDE the row names a group.
  //
  // git's trace can still name one, and that number is carried out to be probed — which can only add
  // a reason to refuse. What it must never do is make this record READABLE on its own: the path of
  // that file is handed to every hook this promotion runs, and a hook that writes a `start` event
  // naming a number nothing is using would otherwise turn "nobody could answer" into "asked, and the
  // answer is no". That was measured: a forged session id got the short phrase accepted and the
  // project's exclusive marker handed back while `ps -g` listed the live `git merge`
  // ([[PITFALLS]] #120, amendment (M) — a source the observed thing controls may tighten, never
  // loosen). So whether the question was ANSWERED stays the payload's to say, and the probe in
  // `mergeIdentityStanding` can only take that answer away.
  if (trace.unrecorded !== null) {
    // The one write that was carrying the group id is KNOWN to have failed. Amendment (N): that is a
    // named fact, and a record whose own account of the merge is known to be incomplete has not
    // answered anything, whatever else is in it.
    return { identity: outside, readable: false, ...common };
  }
  if (outside !== null) return { identity: outside, readable: payload.answered, ...common };
  // Nothing names a group at all. A trace proving a merge was started for this promotion without
  // naming it is an unanswered question, never "nothing is running".
  return { identity: null, readable: trace.spawned ? false : payload.answered, ...common };
}

/**
 * The merge group the owner has declared this record is no longer waiting on, or `null`.
 *
 * Read from `observation_json`, so it is a statement the row makes about itself — which is why the
 * caller has to say whether this row's integrity check passed. A row that failed its hash does not
 * get to drop a live merge from its own list of things to probe.
 */
function disownedMergeGroup(row: PromotionRow): MergeProcessGroupIdentity | null {
  try {
    const value = (JSON.parse(row.observation_json) as MergePromotionObservation).mergeGroupDisowned;
    if (!value || typeof value !== "object") return null;
    const pgid = recordedPgid(value.pgid);
    if (pgid === null) return null;
    const bootAtSec = typeof value.bootAtSec === "number" && Number.isSafeInteger(value.bootAtSec)
      ? value.bootAtSec : null;
    return { pgid, bootAtSec, spawnedAt: typeof value.at === "string" ? value.at : null };
  } catch { return null; }
}

/**
 * Everything every path that concludes about a promotion has to ask, asked once.
 *
 * The eighth round's blocker lived precisely in the absence of this function. The three-source
 * comparison existed and was correct, and it was wired into exactly ONE of the two decisions that
 * use it — "may this record's exclusive marker be released" — while "may a conclusion be drawn about
 * this repository" went on reading `observation_json` alone. That second decision is the one that
 * hands the owner a `git reset --hard`. Amendment (I): after fixing a judgement, list every path
 * that makes the same judgement and wire them ALL to it. There is now one place to wire, and the
 * type system requires a trace at every call site ([[PITFALLS]] #74, #119).
 */
interface MergeIdentityStanding {
  /** What the record says, before anything was probed. */
  reading: MergeIdentityReading;
  /** Every group this record names that a probe cannot rule out, deduplicated by number. */
  alive: ReadonlyArray<{ identity: MergeProcessGroupIdentity; state: MergeGroupState }>;
  /** The one to report, a leader answering "alive" ahead of one nobody can decide about. */
  blocking: { identity: MergeProcessGroupIdentity; state: MergeGroupState } | undefined;
  /**
   * False when the record's answer about the merge is missing, contested, or contradicted by a
   * probe. Never means "no merge": it means this record did not answer the question.
   */
  answered: boolean;
}

function mergeIdentityStanding(
  row: PromotionRow, trace: TraceMergeReading, options: { recordTrusted: boolean },
): MergeIdentityStanding {
  const reading = durableMergeIdentity(row, trace, {
    disowned: options.recordTrusted ? disownedMergeGroup(row) : null,
  });
  const alive: Array<{ identity: MergeProcessGroupIdentity; state: MergeGroupState }> = [];
  // Every candidate is probed, not just the one a preference order would have picked. "unknown"
  // counts as alive on purpose: an undecidable probe is not evidence the merge is over, and this is
  // the one decision where being wrong means concluding over a live write.
  for (const candidate of reading.candidates) {
    const state = mergeGroupState(candidate);
    if (state !== "merge-running" && state !== "unknown") continue;
    if (alive.some((entry) => entry.identity.pgid === candidate.pgid)) continue;
    alive.push({ identity: candidate, state });
  }
  return {
    reading,
    alive,
    blocking: alive.find((entry) => entry.state === "merge-running") ?? alive[0],
    // A group that only a source OUTSIDE the row named, still answering "alive", against a record
    // whose own sources did not name it: the record has not answered the question, whatever it says.
    // This is the probe that turns "the payload's `null` is a later observation" into "the payload's
    // `null` is contradicted by something that is running right now".
    answered: reading.readable && !(reading.outsideRowOnly && alive.length > 0),
  };
}

/**
 * The merge group the owner declared this record should stop waiting for WITHOUT naming a number,
 * or `null`. Read from `observation_json`, so the caller has to say whether this row may speak for
 * its own owner decisions, exactly as `disownedMergeGroup` does.
 */
function abandonedMergeAccount(row: PromotionRow): { at: string; decidedBy: string } | null {
  try {
    const value = (JSON.parse(row.observation_json) as MergePromotionObservation).mergeAccountAbandoned;
    if (!value || typeof value !== "object") return null;
    if (typeof value.at !== "string" || typeof value.decidedBy !== "string") return null;
    return { at: value.at, decidedBy: value.decidedBy };
  } catch { return null; }
}

/**
 * Why a promotion may — or may not — be concluded about. Never a bare boolean, because the whole
 * point of amendment (O) is that "concluded" has to name the positive evidence that produced it.
 */
export type MergeConclusionReason =
  /** The approval was never spent, so no Git command that writes main was ever invoked. */
  | "APPROVAL_NEVER_SPENT_NO_GIT_COMMAND_RAN"
  /** This process spawned the merge and watched its leader close. First-hand, not inferred. */
  | "MERGE_LEADER_EXIT_OBSERVED"
  /** At least one source named a group and every group any source named probed as gone. */
  | "MERGE_GROUP_PROBED_GONE"
  /** The owner quoted the number and declared the record should stop waiting for it. */
  | "MERGE_GROUP_DISOWNED_BY_OWNER"
  /** The owner declared the record should stop waiting for a merge nothing could account for. */
  | "MERGE_ACCOUNT_ABANDONED_BY_OWNER"
  /** A group this record names has a leader answering "alive". */
  | "MERGE_GROUP_STILL_RUNNING"
  /** A group this record names cannot be decided about, which is not evidence it is over. */
  | "MERGE_GROUP_UNDECIDABLE"
  /**
   * Nothing named a group, and nothing positive said there was none to name.
   *
   * This is the default. Amendment (O): leaving it requires evidence, and every absence, silence,
   * blank, unreadable file and parse failure moves TOWARDS it, never away.
   */
  | "MERGE_IDENTITY_UNACCOUNTED";

/** The reasons that mean "concluded". Everything not in here leaves the default in place. */
const CONCLUDED_MERGE_REASONS: ReadonlySet<string> = new Set<MergeConclusionReason>([
  "APPROVAL_NEVER_SPENT_NO_GIT_COMMAND_RAN",
  "MERGE_LEADER_EXIT_OBSERVED",
  "MERGE_GROUP_PROBED_GONE",
  "MERGE_GROUP_DISOWNED_BY_OWNER",
  "MERGE_ACCOUNT_ABANDONED_BY_OWNER",
]);

/**
 * A conclusion an earlier observation of this same row positively reached, or `null`.
 *
 * Only ever written by `#observeMain`, and only with the reason that observation actually had, so
 * this cannot be produced by anything falling silent. An unparsable payload, a missing field or a
 * reason that is not one of the five answers `null`, which is the direction that keeps waiting.
 */
function recordedMergeConclusion(row: PromotionRow): MergeConclusionReason | null {
  try {
    const value = (JSON.parse(row.observation_json) as MergePromotionObservation).mergeConclusion;
    return typeof value === "string" && CONCLUDED_MERGE_REASONS.has(value)
      ? value as MergeConclusionReason : null;
  } catch { return null; }
}

/**
 * Whether there is POSITIVE EVIDENCE that no merge subprocess of this promotion can still be
 * writing to the owner's project — the one question every destructive conclusion depends on.
 *
 * ## Why this replaces the three-class corruption matrix
 *
 * Four rounds in a row fixed the dimension that had just been broken: field names, then sources,
 * then the INTERSECTION of sources, then whether a source exists at all. Each fix was correct and
 * each was followed by the same defect through the next dimension, because the standard was written
 * about the SHAPE of the damage ([[PITFALLS]] #117, #121). There is only ever one invariant behind
 * all four, and it is about direction, not shape:
 *
 *   **A destructive conclusion may not be reached from the ABSENCE of evidence.**
 *
 * So this function does not compare sources looking for damage. It starts at "cannot conclude" and
 * asks what, positively, would move it off that default. Deleting a source, blanking it, making it
 * unreadable or making it fail to parse removes an answer; it can never supply one, which means no
 * subset of removals — including all of them — can loosen anything. That is checkable by test for
 * every subset rather than for a list of shapes somebody thought of.
 *
 * ## The four things that count as evidence
 *
 *  1. the approval was never spent — no Git command that writes main was invoked, and the approval
 *     row lives in the hash-chained database, which is not a file a merge hook can reach past;
 *  2. this process spawned the merge and watched its leader close (`ProcessRunner` does not resolve
 *     a terminated child until its whole group is gone), which is first-hand;
 *  3. a source NAMED a group and every named group probes as gone — a probe, not a silence;
 *  4. the owner declared it, quoting either the number or the phrase for a merge nothing can name.
 *
 * Everything else — the record naming nothing, the trace missing, the marker missing, a payload
 * that says `mergePgid: null` with nothing to corroborate it — leaves the default in place.
 *
 * `recordTrusted: false` withholds (4) from a row whose integrity check failed, for the same reason
 * `mergeIdentityStanding` withholds its disown list: a record nobody can read does not get to end a
 * wait by asserting that its owner ended it.
 */
interface MergeWriteConclusion {
  /** True only when one of the four positive facts above holds. Default false. */
  concluded: boolean;
  reason: MergeConclusionReason;
  /**
   * True when what ended the wait was an owner DECLARATION rather than an observation.
   *
   * Kept separate because the two are allowed different things: a declaration ends the waiting (it
   * has to, or the release would have no effect and the task would be retired for good — bar item
   * 11), but it does not by itself license a command that rewrites the repository while the group
   * the owner disowned still answers "alive".
   */
  byOwnerDeclaration: boolean;
  standing: MergeIdentityStanding;
  /** The two outside sources exactly as they were read, carried so no caller re-reads them. */
  trace: TraceMergeReading;
}

function mergeWriteConclusion(
  row: PromotionRow,
  trace: TraceMergeReading,
  options: { approvalSpent: boolean; recordTrusted: boolean; leaderExitObserved?: boolean },
): MergeWriteConclusion {
  const standing = mergeIdentityStanding(row, trace, { recordTrusted: options.recordTrusted });
  const open = (reason: MergeConclusionReason): MergeWriteConclusion =>
    ({ concluded: false, reason, byOwnerDeclaration: false, standing, trace });
  const settled = (reason: MergeConclusionReason, byOwnerDeclaration = false): MergeWriteConclusion =>
    ({ concluded: true, reason, byOwnerDeclaration, standing, trace });
  // A group that is answering, or that cannot be asked about, comes first: no declaration and no
  // first-hand observation may talk over a probe that is still saying something.
  if (standing.blocking !== undefined) {
    return open(standing.blocking.state === "merge-running"
      ? "MERGE_GROUP_STILL_RUNNING" : "MERGE_GROUP_UNDECIDABLE");
  }
  if (!options.approvalSpent) return settled("APPROVAL_NEVER_SPENT_NO_GIT_COMMAND_RAN");
  if (options.recordTrusted) {
    if (abandonedMergeAccount(row) !== null) {
      return settled("MERGE_ACCOUNT_ABANDONED_BY_OWNER", true);
    }
    if (disownedMergeGroup(row) !== null) return settled("MERGE_GROUP_DISOWNED_BY_OWNER", true);
    // An earlier observation of THIS row asked the same question and got a positive answer. It is
    // read back rather than re-derived because the act of recording it erases the evidence that
    // produced it: `#observeMain` writes `mergePgid: null` once a group is established to be over,
    // deliberately, so a dead number stops answering "still writing" for the rest of the row's life
    // — and without this the very next read would find nothing naming a group and re-open a record
    // that had already been concluded, honestly, from a probe. It lives in the hash-covered payload,
    // which is what separates it from the two sources a hook can write.
    const recorded = recordedMergeConclusion(row);
    if (recorded !== null) return settled(recorded);
  }
  // A probe, not a silence: a source INSIDE the row named a number, the number was asked about, and
  // every number any source named came back gone. `namedInRow` is the load-bearing half — the two
  // outside sources contribute numbers to probe but may never be the reason an answer exists, or a
  // hook that writes one `start` event naming a dead pid would supply this product's evidence for it
  // (amendment (Q), [[PITFALLS]] #120).
  //
  // A marker beside the trace takes even that away, in the one direction amendment (Q) permits a
  // source the merge can reach to move anything: it says this record's own account of the merge is
  // KNOWN to be incomplete, and a record that knows that has not answered, whatever else is in it
  // (amendment (N)). A hook can therefore keep a promotion unaccounted for by writing that file —
  // which costs the owner one phrase and cannot cost them their repository.
  if (standing.reading.namedInRow && trace.unrecorded === null) {
    return settled("MERGE_GROUP_PROBED_GONE");
  }
  if (options.leaderExitObserved === true) return settled("MERGE_LEADER_EXIT_OBSERVED");
  return open("MERGE_IDENTITY_UNACCOUNTED");
}

/**
 * A read-only command that looks for a merge this record can no longer name. Never executed here.
 *
 * Every `git merge` this product starts carries the authorized candidate head on its command line,
 * so a record that lost the number can still tell the owner exactly what to look for. It is a
 * SEARCH rather than a lookup and it is named as one: `inspectGroupCommand` answers "what is this
 * pid", and this answers "is there one at all" — which is the only question left when nothing named
 * a pid. Falls back to a bare listing when even the candidate head is unreadable, because a record
 * that cannot say what to grep for must still say where to look.
 */
function searchMergeCommand(candidateHead: unknown): string {
  const command = "ps -eo pid,pgid,stat,lstart,command";
  return typeof candidateHead === "string" && /^[0-9a-f]{40}$/u.test(candidateHead)
    ? `${command} | grep -F ${candidateHead}`
    : command;
}

/** The most bytes of a promotion's trace stream this will read while looking for the merge's pid. */
const MAX_TRACE_IDENTITY_BYTES = 64 * 1024;

/**
 * Trace2 session ids end in the emitting git process's own pid, in hex: `<time>-H<host>-P<pid>`.
 *
 * Parsed rather than asked for, because there is nothing to ask: the process is gone by the time
 * this runs. A format change makes the pattern miss, and a miss is reported as `spawned` with no
 * identity — an unanswered question, which blocks exactly as a live merge does. It cannot turn into
 * "nothing was running".
 */
const TRACE_SESSION_PID_PATTERN = /-P([0-9a-fA-F]{1,12})$/u;

/** What the two sources OUTSIDE the promotion row say about the merge it started. */
interface TraceMergeReading {
  /** True when either outside source records a git process having started for this promotion. */
  spawned: boolean;
  /** The group that process led, or null when there is no trace or its session id did not parse. */
  identity: MergeProcessGroupIdentity | null;
  /**
   * The group the ONE write that records it was carrying when that write failed, from this
   * product's own marker file — or `null` when no such failure was recorded.
   *
   * Amendment (N). `#recordMergePgid` swallowed its failure and `runProcess` swallowed a throwing
   * listener on top of it, so "the group was never recorded" and "there was no group to record"
   * became the same durable record — and the second reads as "nothing is running". A marker beside
   * the trace says which of the two it was, and names the number the failed write was carrying.
   */
  unrecorded: MergeProcessGroupIdentity | null;
}

/** A trace-less reading, for the callers that have no promotion id to look one up by. */
const NO_TRACE_READING: TraceMergeReading = { spawned: false, identity: null, unrecorded: null };

/** A bounded prefix of a file, read synchronously. Never throws; an unreadable file is `null`. */
function readFilePrefix(path: string, bytes: number): string | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch { return null; }
  try {
    const buffer = Buffer.allocUnsafe(bytes);
    const read = readSync(fd, buffer, 0, bytes, 0);
    return buffer.toString("utf8", 0, read);
  } catch {
    return null;
  } finally {
    try { closeSync(fd); } catch { /* the descriptor is this function's alone */ }
  }
}

/**
 * The boot a git process recorded in a trace belongs to, derived from when it started.
 *
 * A pid only names a process within one boot ([[PITFALLS]] #105). The trace does not record a boot,
 * but it does record the instant git started, and a git that started before this machine booted
 * cannot be holding a pid this boot issued. Within the sampling tolerance the two are treated as the
 * same boot, which is the conservative direction: it keeps the number blocking.
 */
function traceBootAtSec(startedAtMs: number | null): number | null {
  if (startedAtMs === null) return null;
  const boot = bootAtSec();
  const started = Math.round(startedAtMs / 1_000);
  return started >= boot ? boot : started;
}

/**
 * The merge's identity as git itself recorded it, read from the promotion's trace file.
 *
 * This is the only source that does not live in the database, which is the whole reason it is here:
 * the columns added last round and the payload they were added to survive share one SQLite row, so
 * "A is broken, fall back to B" was answered by a B that lives inside A ([[PITFALLS]] #115). A
 * corruption that nulls the columns and strips the payload leaves this file untouched — and it was
 * measured doing exactly that: short phrase accepted, `--pgid 999999` accepted, marker handed back
 * while `ps -g` listed the merge.
 *
 * It asserts nothing it did not read. No trace, an unreadable trace, or a trace with no `start`
 * event is `spawned: false` — this source simply did not answer — and the other two decide.
 */
function traceMergeIdentity(tracePath: string | null): TraceMergeReading {
  if (tracePath === null) return NO_TRACE_READING;
  const text = readFilePrefix(tracePath, MAX_TRACE_IDENTITY_BYTES);
  if (text === null) return NO_TRACE_READING;
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch { continue; /* the bounded read can cut the last line in half */ }
    if (event.event !== "start") continue;
    const sid = typeof event.sid === "string" ? event.sid : "";
    const startedAt = typeof event.time === "string" ? Date.parse(event.time) : Number.NaN;
    const match = TRACE_SESSION_PID_PATTERN.exec(sid);
    const pgid = match === null ? null : recordedPgid(Number.parseInt(match[1] as string, 16));
    if (pgid === null) return { spawned: true, identity: null, unrecorded: null };
    return {
      spawned: true,
      identity: {
        pgid,
        bootAtSec: traceBootAtSec(Number.isFinite(startedAt) ? startedAt : null),
        spawnedAt: Number.isFinite(startedAt) ? new Date(startedAt).toISOString() : null,
      },
      unrecorded: null,
    };
  }
  return NO_TRACE_READING;
}

/**
 * The group a failed `#recordMergePgid` was carrying, read back from its marker file.
 *
 * It asserts nothing it did not read — a missing, unreadable or unparsable marker is `null`.
 *
 * ## What this source is NOT
 *
 * The comment here used to say it was "never named to anything the merge runs, which is the
 * difference between it and git's trace", and that was measured false. It lives in
 * `dirname($GIT_TRACE2_EVENT)`, and that variable is handed to every hook this promotion runs: one
 * line of ordinary shell derives this path from it, and a hook writing a number of its own choosing
 * into this file was measured making the product print a sentence about its own internals that was
 * not true. The 0700 mode protects nothing here, because the hook runs as the owner
 * ([[PITFALLS]] #120, amendment (Q)).
 *
 * So this is treated as what it is: a source the observed thing can reach. It may TIGHTEN — it adds
 * a number to probe, and it marks a record whose own account is known incomplete — and amendment
 * (O) is what makes that safe, because nothing here can supply the positive evidence that lets a
 * conclusion be drawn, and its ABSENCE cannot either.
 */
function unrecordedMergeIdentity(path: string): MergeProcessGroupIdentity | null {
  const raw = readFilePrefix(path, MAX_SPAWN_RECORD_BYTES);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const pgid = recordedPgid(parsed.pgid);
    if (pgid === null) return null;
    return {
      pgid,
      bootAtSec: typeof parsed.bootAtSec === "number" && Number.isSafeInteger(parsed.bootAtSec)
        ? parsed.bootAtSec : null,
      spawnedAt: typeof parsed.at === "string" ? parsed.at : null,
    };
  } catch { return null; }
}

/** The most bytes of a spawn-record marker this will read. It holds three fields. */
const MAX_SPAWN_RECORD_BYTES = 4 * 1024;

/**
 * This machine's boot instant in whole seconds, derived from the monotonic uptime.
 *
 * A pid only names a process within one boot. macOS wraps pids around 99999 and a restart begins
 * numbering again from the bottom, so `pid 68408` recorded before a reboot names a completely
 * unrelated process afterwards — and a reboot is precisely what leaves promotions unresolved. This
 * is derived rather than read from a file so it works the same on every platform this runs on; it
 * is compared with a tolerance because `Date.now()` and `os.uptime()` are not sampled atomically.
 */
function bootAtSec(): number {
  return Math.round(Date.now() / 1_000 - uptime());
}

/** Two boot timestamps this far apart cannot be the same boot; anything closer is sampling noise. */
const BOOT_IDENTITY_TOLERANCE_SEC = 60;

/**
 * What a recorded merge process group is doing, right now, asked in the one way that distinguishes
 * "the write to main is still in flight" from "the number is stale".
 *
 * The group leader IS the `git merge`: children are spawned detached, which on POSIX makes the child
 * a session and group leader, so its pid equals the group id. That distinction is the whole point.
 * A hook that backgrounds anything at all — a dev server, a watcher, a log tailer — leaves the GROUP
 * alive indefinitely after the merge itself has finished and main is fully written; gating on the
 * group meant such a promotion could never be settled by anyone, and no product path could release
 * it. Gating on the LEADER asks the question that a conclusion actually depends on.
 *
 * Every answer other than "running" is justified by identity, not by optimism:
 *  - a group recorded before this boot cannot be this boot's pid;
 *  - `EPERM` means the pid exists and belongs to somebody else, and this promotion's merge ran as
 *    the owner, so it is not ours — the opposite of the previous reading, which treated another
 *    user's recycled pid as proof our merge was still writing;
 *  - anything undecidable stays `unknown`, which blocks a conclusion exactly as "running" does but
 *    is reported under its own name so it can be seen and released.
 */
type MergeGroupState = "none" | "merge-running" | "merge-done-group-alive" | "gone" | "unknown";

function probe(pid: number): "alive" | "gone" | "foreign" | "unknown" {
  // Group probes pass `-pgid`, so the range is checked on the magnitude. A number outside it cannot
  // be asked about, and "cannot be asked about" is `unknown` — never "gone".
  if (!Number.isSafeInteger(pid) || pid === 0 || Math.abs(pid) > MAX_PID) return "unknown";
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "gone";
    if (code === "EPERM") return "foreign";
    return "unknown";
  }
}

function mergeGroupState(identity: MergeProcessGroupIdentity | null): MergeGroupState {
  if (identity === null) return "none";
  if (identity.bootAtSec !== null
    && Math.abs(identity.bootAtSec - bootAtSec()) > BOOT_IDENTITY_TOLERANCE_SEC) return "gone";
  const leader = probe(identity.pgid);
  if (leader === "alive") return "merge-running";
  if (leader === "unknown") return "unknown";
  // The leader is either gone or is now somebody else's process. Either way this promotion's merge
  // is over; what remains is whether it left anything behind that the owner should know about.
  if (leader === "foreign") return "gone";
  const group = probe(-identity.pgid);
  if (group === "alive") return "merge-done-group-alive";
  return "gone";
}

/** A read-only command that shows what a process group currently contains. Never executed here. */
function inspectGroupCommand(pgid: number): string {
  return `ps -o pid,ppid,pgid,stat,lstart,command -g ${pgid}`;
}

/** A read-only command that shows one process. Never executed here. */
function inspectPidCommand(pid: number): string {
  return `ps -o pid,ppid,pgid,stat,lstart,command -p ${pid}`;
}

/**
 * Why this promotion cannot be concluded right now, or `undefined` when nothing is in the way.
 *
 * Everything here is re-derived at the moment of the call, never read from a stored verdict, and
 * every branch names the exact pid the owner can look at. A record that says "still writing" without
 * saying WHICH process is writing gives the owner a status instead of a lever — that was the
 * measured failure: a promotion frozen on `applying` with nothing anywhere naming what to inspect.
 */
function promotionPending(
  row: PromotionRow, trace: TraceMergeReading, options: { approvalSpent: boolean },
): MergePromotionPending | undefined {
  if (row.state === "applied" || row.state === "rolled-back") return undefined;
  // Every source, not just `observation_json`. This function is the gate in front of every
  // conclusion — `#resolvePromotion` returns early on it, `#assertNoUnresolvedPromotion` and
  // `#assertMainNotBusy` refuse on it, the three releases dispatch on it, and the listing prints it
  // — and while it read one source, a promotion whose pgid write had failed reported
  // "not blocked on any process" and offered `git reset --hard` over a `git merge` that `ps -g` was
  // listing. The trace is a required parameter so that a new caller cannot repeat that by omission.
  //
  // Amendment (O): reading every source is still not enough, because an attacker who cannot change
  // what a source SAYS can delete it. `approvalSpent` is a required parameter for the same reason
  // the trace is — it is the positive fact that says whether a Git command capable of writing main
  // was ever invoked, and it is the one input here that a repository hook cannot reach.
  const conclusion = mergeWriteConclusion(row, trace, {
    approvalSpent: options.approvalSpent, recordTrusted: true,
  });
  const standing = conclusion.standing;
  const blocking = standing.blocking;
  if (row.state === "applying" && ownerProcessAlive(row) !== false) {
    // Both numbers alive is its own state, not the owner state with a footnote. Reporting it as
    // `OWNER_PROCESS_STILL_RUNNING` handed out a release phrase that the merge check then refused,
    // and the merge release refused on the owner — a cycle with no exit and a permanently retired
    // task. Naming it is what lets `pending.release` be a phrase that actually works.
    return blocking !== undefined
      ? {
        code: "PROMOTION_OWNER_AND_MERGE_STILL_RUNNING",
        pid: row.owner_pid,
        inspect: inspectPidCommand(row.owner_pid),
        release: MERGE_PROMOTION_ABANDON_CONFIRMATION,
        alsoBlockedBy: {
          pid: blocking.identity.pgid, inspect: inspectGroupCommand(blocking.identity.pgid),
        },
      }
      : {
        code: "OWNER_PROCESS_STILL_RUNNING",
        pid: row.owner_pid,
        inspect: inspectPidCommand(row.owner_pid),
        release: MERGE_OWNER_ABANDON_CONFIRMATION,
      };
  }
  if (blocking === undefined) {
    // Amendment (O). No number to name, and no positive evidence that there is none to name. The
    // previous shape returned `undefined` here, which every caller reads as "nothing is in the way":
    // the record settled, the project's exclusive marker was handed back, and the owner was offered
    // `git reset --hard` — all of it reached from four sources being SILENT rather than from any of
    // them saying anything. Measured with nothing forged: a repository hook emptied the trace file
    // whose path this product put in its own environment, while an ordinary SQLite contention had
    // already cost the group's one write ([[PITFALLS]] #65, #120).
    //
    // Waiting is the default, and this is what the owner is told and how they get out of it.
    if (conclusion.concluded) return undefined;
    return {
      code: "MERGE_IDENTITY_UNACCOUNTED",
      inspect: searchMergeCommand(row.candidate_head),
      release: MERGE_UNACCOUNTED_ABANDON_CONFIRMATION,
    };
  }
  const running = blocking.state === "merge-running";
  return {
    code: running ? "MERGE_SUBPROCESS_STILL_RUNNING" : "MERGE_PROCESS_GROUP_UNDECIDABLE",
    pid: blocking.identity.pgid,
    inspect: inspectGroupCommand(blocking.identity.pgid),
    // A leader that is answering "alive" is a merge that may be writing main right now, and the
    // phrase offered says so. The record must not hand out the shorter one here: it is the same
    // sentence an owner would use for a group nobody can decide about, and the two states are not
    // the same risk.
    release: running ? MERGE_LIVE_ABANDON_CONFIRMATION : MERGE_GROUP_ABANDON_CONFIRMATION,
  };
}

/**
 * Whether the process that started this promotion still exists, asked with its boot as part of the
 * question. A pid recorded before this boot cannot be that process, whoever holds the number now.
 */
function ownerProcessAlive(row: PromotionRow): boolean | null {
  let recorded: number | null = null;
  try {
    const observation = JSON.parse(row.observation_json) as MergePromotionObservation;
    // The owner's own declaration ends the wait, exactly as disowning a process group does. It is
    // checked first because it is a decision, and a decision is not overruled by a probe.
    if (observation.ownerProcessDisowned !== undefined) return false;
    const value = observation.ownerBootAtSec;
    if (typeof value === "number" && Number.isSafeInteger(value)) recorded = value;
  } catch { /* an observation that cannot be read decides nothing */ }
  if (recorded !== null && Math.abs(recorded - bootAtSec()) > BOOT_IDENTITY_TOLERANCE_SEC) return false;
  return processAlive(row.owner_pid);
}

/**
 * Whether a pid is the process this product started and is therefore worth waiting for.
 *
 * Signal 0 checks for existence without delivering anything. `EPERM` means the pid exists and
 * belongs to SOMEBODY ELSE — and this promotion's orchestrator ran as the owner, so it is not that
 * process: the number has been recycled. Answering "alive" there is the same mistake the merge
 * process group made until this round, in the same file, one level up; the two must not point in
 * opposite directions, because between them they decide whether a promotion can ever be resolved.
 *
 * A pid that cannot be decided about is reported as unknown rather than assumed dead: assuming dead
 * is what would let a reader settle a promotion that is still running.
 */
function processAlive(pid: number): boolean | null {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > MAX_PID) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return false;
    return null;
  }
}

/**
 * What releasing an UNREADABLE promotion row from the project's exclusive marker requires right now,
 * and which of the numbers it was waiting on can still be seen.
 *
 * Every input here is read without the row hash, because the row hash is the thing that failed:
 * `owner_pid`, `merge_pgid` and `merge_boot_at_sec` are plain integer columns that a damaged payload
 * does not take with it. That makes this a best-effort probe and it is described as one — but
 * best-effort in the safe direction: anything that might still be running, AND anything this cannot
 * find out about, demands the phrase that says so. Only a row where the question was actually asked
 * and actually answered gets the short one.
 *
 * The previous shape got that last distinction wrong in the direction that matters, and it was
 * measured: with `observation_json` destroyed as well as the hash — which is what real corruption
 * looks like, since it does not pick fields — the merge group read back as `null`,
 * `mergeGroupState(null)` answered `"none"`, and "none" was treated as "no merge is alive". The
 * short phrase was accepted, `--pgid 999999` was accepted, and the project's exclusive marker was
 * handed back while `ps -g` still listed the `git merge`, its hook and its `sleep`.
 */
function unreadableReleaseRequirement(
  row: PromotionRow, trace: TraceMergeReading, options: { approvalSpent: boolean },
): {
  confirmation: string;
  alive: Array<{ kind: "merge" | "owner"; pid: number; inspect: string }>;
  /**
   * True only on positive evidence that no merge of this promotion can still be writing main.
   *
   * False when the group could not be read at all, when two sources named different groups, and —
   * amendment (O) — when no source named one and nothing positive said there was none to name.
   * `alive: []` then means "nothing could be seen", not "nothing is there", and the confirmation
   * reflects the stronger of the two.
   */
  probeReadable: boolean;
  /**
   * Every group the record names, attributed to the source that named it. More than one entry means
   * the sources disagree; the owner sees both numbers rather than the one this code preferred.
   */
  recordedGroups: Array<{ source: MergeIdentitySourceName; pgid: number; bootAtSec: number | null }>;
} {
  const alive: Array<{ kind: "merge" | "owner"; pid: number; inspect: string }> = [];
  // `recordTrusted: false` on purpose: this row failed its integrity check, so its own claim to have
  // disowned a process group — or to have been released from waiting for one it could not name — is
  // not something it may use to drop a live merge from what gets probed, nor to supply the positive
  // evidence amendment (O) requires. Both of those are owner DECLARATIONS, and a record nobody can
  // read does not get to assert that its owner made one.
  const conclusion = mergeWriteConclusion(row, trace, {
    approvalSpent: options.approvalSpent, recordTrusted: false,
  });
  const standing = conclusion.standing;
  for (const entry of standing.alive) {
    alive.push({
      kind: "merge", pid: entry.identity.pgid, inspect: inspectGroupCommand(entry.identity.pgid),
    });
  }
  if (ownerProcessAlive(row) !== false && Number.isSafeInteger(row.owner_pid) && row.owner_pid > 1) {
    alive.push({ kind: "owner", pid: row.owner_pid, inspect: inspectPidCommand(row.owner_pid) });
  }
  return {
    // An unreadable group is the same answer as a live one, because it is the same amount of
    // evidence that main is not being written: none. The difference between them is reported in
    // `probeReadable` rather than resolved in favour of the convenient reading.
    // Amendment (O): the short phrase is available only on positive evidence. `standing.answered`
    // was not that — a row whose four sources all fell silent answered `true`, because a payload
    // with no `mergePgid` in it counted as having said "there is no group". Silence is now a reason
    // to ask for the longer phrase, and no combination of deletions can produce the shorter one.
    confirmation: alive.length > 0 || !conclusion.concluded
      ? MERGE_UNREADABLE_LIVE_ABANDON_CONFIRMATION
      : MERGE_UNREADABLE_ABANDON_CONFIRMATION,
    alive,
    probeReadable: conclusion.concluded,
    recordedGroups: standing.reading.sources.map((entry) => ({
      source: entry.source, pgid: entry.identity.pgid, bootAtSec: entry.identity.bootAtSec,
    })),
  };
}

/**
 * What an unreadable promotion row looks like to a reader, derived from the row every single time.
 *
 * `storedState` and `releasedFromExclusiveMarker` used to exist only in the value returned by the ONE
 * call that performed a release: every later read collapsed "released" and "still claiming the whole
 * project" back into the same `{state:"unreadable"}`, so an owner could not tell whether their
 * release had done anything. Bar item 13 is about exactly that. Both come from the durable row here,
 * and `holdsProjectExclusiveMarker` is re-derived from the `state` column on each read rather than
 * cached, because it is the fact the release is about.
 */
function unreadablePromotionView(
  row: PromotionRow, trace: TraceMergeReading, options: { approvalSpent: boolean },
): UnreadableMergePromotion {
  let released: { at: string; decidedBy: string } | undefined;
  try {
    const value = (JSON.parse(String(row.observation_json)) as MergePromotionObservation)
      .unreadableRecordReleased;
    if (value && typeof value.at === "string" && typeof value.decidedBy === "string") {
      released = { at: value.at, decidedBy: value.decidedBy };
    }
  } catch { /* an observation that cannot be read asserts nothing, exactly like the row it is in */ }
  const holds = row.state === "applying";
  return {
    id: typeof row.id === "string" ? row.id : "",
    taskId: typeof row.task_id === "string" ? row.task_id : "",
    state: "unreadable",
    unreadable: true,
    storedState: typeof row.state === "string" ? row.state : "",
    holdsProjectExclusiveMarker: holds,
    ...(holds ? { release: unreadableReleaseRequirement(row, trace, options) } : {}),
    ...(released === undefined ? {} : { releasedFromExclusiveMarker: released }),
  };
}

function mergeRequestKey(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) throw new Error("MAIN_MERGE_CLIENT_REQUEST_ID_INVALID");
  return value;
}

function mergeBinding(row: MergeApprovalRow): MergeApprovalBinding {
  return {
    taskId: row.task_id,
    completionId: row.completion_id,
    roomId: row.room_id,
    mainPath: row.main_path,
    mainBranch: row.main_branch,
    candidatePath: row.candidate_path,
    baseMainHead: row.base_main_head,
    candidateHead: row.candidate_head,
    mainHead: row.main_head,
    mainFingerprint: row.main_fingerprint,
    mainIgnoredFingerprint: row.main_ignored_fingerprint,
    recoveryRef: row.recovery_ref,
    previewDigest: row.preview_digest,
  };
}

/**
 * Every reason a snapshot is not approvable, named individually.
 *
 * The three truncation flags are separate entries rather than one "truncated" verdict because they
 * are three different things the owner was not shown, and a merge that the simulation says conflicts
 * is a fourth: an approval is documented to mean "no content conflicts", so one that carries them
 * would be promising something the preview already disproved.
 */
function mergeBlockers(preview: CandidateCompletionPreview): string[] {
  const blockers: string[] = [];
  if (preview.filesTruncated) blockers.push("PREVIEW_FILES_TRUNCATED");
  if (preview.submodulesTruncated) blockers.push("PREVIEW_SUBMODULES_TRUNCATED");
  if (preview.mergeConflictsTruncated) blockers.push("PREVIEW_MERGE_CONFLICTS_TRUNCATED");
  if (!preview.mergeable) blockers.push("MERGE_CONFLICTS_PRESENT");
  return blockers;
}

/**
 * A release the owner asked for while a `git merge` was still answering "alive".
 *
 * It carries the pid, a read-only command that shows what that process is, and the phrase the second
 * attempt needs — so the refusal is a route rather than a wall. It is a refusal at all because the
 * measured alternative was handing over `git reset --hard` against a working tree git was writing.
 */
export class MergeAbandonStillRunningError extends Error {
  readonly pid: number;
  readonly inspect: string;
  readonly confirmation: string;

  constructor(pid: number, inspect: string, confirmation: string) {
    super("MERGE_ABANDON_REFUSED_MERGE_STILL_RUNNING");
    this.name = "MergeAbandonStillRunningError";
    this.pid = pid;
    this.inspect = inspect;
    this.confirmation = confirmation;
  }
}

/**
 * A narrow release asked for while BOTH of this record's processes are answering "alive".
 *
 * Each narrow release refuses on the other one, which was a cycle: the owner release refused because
 * the merge was running, the merge release refused because the owner was running, and nothing else
 * could ever move that row. The refusal now carries both pids, both read-only inspect commands and
 * the phrase that does work, so the state that used to have no exit hands out the exit.
 */
export class MergePromotionDoublyBlockedError extends Error {
  readonly ownerPid: number;
  readonly mergePgid: number;
  readonly inspect: readonly string[];
  readonly confirmation: string;

  constructor(ownerPid: number, mergePgid: number, inspect: readonly string[]) {
    super("MERGE_ABANDON_REFUSED_BOTH_PROCESSES_RUNNING");
    this.name = "MergePromotionDoublyBlockedError";
    this.ownerPid = ownerPid;
    this.mergePgid = mergePgid;
    this.inspect = [...inspect];
    this.confirmation = MERGE_PROMOTION_ABANDON_CONFIRMATION;
  }
}

/**
 * A release asked for on a promotion row this release cannot read.
 *
 * It is a refusal only because the phrase was missing or wrong; it carries the one that works, so
 * the state that used to answer `MAIN_MERGE_PROMOTION_NOT_FOUND` — and leave the entire project
 * blocked with no action able to touch the row — now answers with the way through.
 */
export class MergeUnreadablePromotionError extends Error {
  readonly promotionId: string;
  readonly confirmation: string;
  /**
   * The numbers this unreadable row was waiting on that a best-effort probe can still see, each with
   * a read-only command that shows it. Non-empty is why `confirmation` is the longer phrase.
   */
  readonly alive: ReadonlyArray<{ kind: "merge" | "owner"; pid: number; inspect: string }>;
  /**
   * False when the merge group could not be read, and when two sources named different groups. An
   * empty `alive` then asserts nothing.
   */
  readonly probeReadable: boolean;
  /** Every group the record names, attributed. More than one entry IS the reason for the refusal. */
  readonly recordedGroups: ReadonlyArray<{
    source: MergeIdentitySourceName; pgid: number; bootAtSec: number | null;
  }>;

  constructor(
    promotionId: string,
    requirement: {
      confirmation: string;
      alive: ReadonlyArray<{ kind: "merge" | "owner"; pid: number; inspect: string }>;
      probeReadable?: boolean;
      recordedGroups?: ReadonlyArray<{
        source: MergeIdentitySourceName; pgid: number; bootAtSec: number | null;
      }>;
    } = { confirmation: MERGE_UNREADABLE_ABANDON_CONFIRMATION, alive: [] },
  ) {
    super("MAIN_MERGE_PROMOTION_ROW_UNREADABLE");
    this.name = "MergeUnreadablePromotionError";
    this.promotionId = promotionId;
    this.confirmation = requirement.confirmation;
    this.alive = [...requirement.alive];
    this.probeReadable = requirement.probeReadable ?? true;
    this.recordedGroups = [...requirement.recordedGroups ?? []];
  }
}

/**
 * What a live main working tree found at the paths this candidate is about to write, and whether the
 * scan ran at all.
 *
 * `checked: false` is its own answer and never collapses into "nothing found". An unread scan and an
 * empty result are the same JSON shape only if you let them be, and the difference here is between
 * "no ignored file will be destroyed" and "I did not look" (PITFALLS #85).
 */
interface OverwriteScan {
  checked: boolean;
  /**
   * Ignored files at paths the merge writes. git overwrites these SILENTLY — measured, not assumed:
   * a merge that adds a tracked file at the path of an ignored one replaces its contents and exits 0
   * with a working tree it still reports as clean.
   */
  ignored: string[];
  /** Untracked, non-ignored files at those paths. git refuses to clobber these, so the merge fails. */
  untracked: string[];
  /** Present only when the scan could not be completed; names why, path-free. */
  unavailable?: string;
}

/**
 * The gates that exist only because a promotion writes to a working tree, kept separate from
 * `mergeBlockers` because they are facts about LIVE main rather than about the stored snapshot.
 *
 * `mergeable: true` means two trees have no conflicting content. It says nothing about whether the
 * working tree main is checked out in can receive that merge, and Phase 5-4 recorded exactly that
 * gap as failing at 5-5.
 */
function promotionBlockers(restore: GitRestorePoint, overwrite: OverwriteScan): string[] {
  return [
    // Every named condition the working tree itself fails, straight from the one place "clean" is
    // defined. Summarising them into a single "not clean" would hide which of them the owner has to
    // fix, and some of them (a skip-worktree entry) can never be fixed by retrying.
    ...restore.blockers,
    ...(overwrite.checked ? [] : [overwrite.unavailable ?? "OVERWRITE_SCAN_UNAVAILABLE"]),
    ...(overwrite.ignored.length > 0 ? ["IGNORED_FILES_WOULD_BE_OVERWRITTEN"] : []),
    ...(overwrite.untracked.length > 0 ? ["UNTRACKED_FILES_WOULD_BE_OVERWRITTEN"] : []),
  ];
}

/**
 * A promotion refused before anything was spent or written, naming every gate that is closed.
 *
 * It carries the offending paths because "an ignored file would be destroyed" is unactionable
 * without saying which one — and those paths are the entire reason this gate exists.
 */
export class MergePromotionRefusedError extends Error {
  readonly blockers: string[];
  readonly ignored: string[];
  readonly untracked: string[];

  constructor(blockers: string[], overwrite: { ignored: string[]; untracked: string[] }) {
    super(`MAIN_MERGE_PROMOTION_REFUSED:${blockers.join(",")}`);
    this.name = "MergePromotionRefusedError";
    this.blockers = blockers;
    this.ignored = [...overwrite.ignored];
    this.untracked = [...overwrite.untracked];
  }
}

/**
 * The promotion facts a preview must carry, or a refusal shaped as a blocker.
 *
 * A preview recorded before Phase 5-5 has none. That is not "no blockers": it is a snapshot that was
 * never checked against any of the conditions promotion depends on, so it is refused by name.
 *
 * The same applies one gate finer. A snapshot taken before main's whole configuration was bound
 * carries `hooks` without a `configDigest`, and comparing only the fields it does have would spend
 * an approval that was never checked against the configuration the merge is about to run under. It
 * is the same answer, for the same reason, at the same name.
 */
function promotionFacts(preview: CandidateCompletionPreview): PromotionFacts | undefined {
  const facts = preview.promotion;
  if (facts === undefined) return undefined;
  return typeof facts.hooks?.configDigest === "string" && Array.isArray(facts.hooks.programs)
    ? facts
    : undefined;
}

/**
 * The one code for "this approval's snapshot was taken before the promotion gates existed".
 *
 * It is deliberately NOT an integrity failure. An approval written by the previous release verifies
 * its own hash perfectly — nothing was tampered with, the snapshot simply predates a check that did
 * not exist when it was taken. Folding the two together was PITFALLS #85 in its textbook form: the
 * row could then never be read, never be rejected and never expire, so it held the task's single
 * open-question slot forever and the task could never be asked about again. "Older than this feature"
 * is its own terminal state, and a terminal state releases the slot.
 */
const PREVIEW_PREDATES_PROMOTION_GATES = "PREVIEW_PREDATES_PROMOTION_GATES";

/**
 * Whether a row that PASSED its integrity check carries a snapshot from before Phase 5-5.
 *
 * Callers must have run `#assertMergeApprovalRow` first: this answers a question about a readable
 * row, and a row that cannot be verified is not readable enough to be asked.
 */
function previewPredatesPromotionGates(row: MergeApprovalRow): boolean {
  return promotionFacts(assertPreviewShape(JSON.parse(row.preview_json) as unknown)) === undefined;
}

function boundedRefusal(refusal: MergeApprovalRefusal): MergeApprovalRefusal {
  const reason = refusal.reason === undefined
    ? undefined
    : refusal.reason.replace(/[\r\n\t\0]+/gu, " ").slice(0, MAX_MERGE_REJECT_REASON).trim();
  const unverified = refusal.unverified === undefined
    ? undefined
    : refusal.unverified.slice(0, MAX_MERGE_REFUSAL_CHANGED).map((name) => name.slice(0, 40));
  return {
    code: refusal.code.slice(0, 64),
    changed: refusal.changed.slice(0, MAX_MERGE_REFUSAL_CHANGED).map((name) => name.slice(0, 40)),
    ...(unverified && unverified.length > 0 ? { unverified } : {}),
    ...(reason ? { reason } : {}),
  };
}

/**
 * The one shape a drift refusal takes, wherever it is detected. Grant, consume and every observation
 * path go through it so the durable record of "this approval stopped applying" reads the same no
 * matter who noticed, and always names both the values that moved and the surface that saw them.
 */
function driftRefusal(
  changed: string[], observedOn: MergeApprovalObservation, unverified: string[] = [],
): MergeApprovalRefusal {
  return {
    code: "MAIN_MERGE_APPROVAL_BINDING_CHANGED",
    changed,
    ...(unverified.length > 0 ? { unverified } : {}),
    reason: `drift-detected-on:${observedOn}`,
  };
}

/**
 * A stable, path-free code for a binding check that could not run. Anything that is not already a
 * bare error code is collapsed to one, because a raw message can carry a filesystem path and this
 * value is reported on read surfaces the room can see.
 */
function bindingCheckFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return /^[A-Z][A-Z0-9_]{2,63}$/u.test(message) ? message : "MAIN_MERGE_APPROVAL_BINDING_CHECK_FAILED";
}

function assertRefusal(value: unknown): MergeApprovalRefusal {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("MAIN_MERGE_APPROVAL_ROW_TAMPERED");
  }
  const refusal = value as Record<string, unknown>;
  if (Object.keys(refusal).some((key) => !["code", "changed", "unverified", "reason"].includes(key))
    || typeof refusal.code !== "string" || refusal.code.length < 1 || refusal.code.length > 64
    || !Array.isArray(refusal.changed) || refusal.changed.length > MAX_MERGE_REFUSAL_CHANGED
    || refusal.changed.some((name) => typeof name !== "string" || name.length < 1 || name.length > 40)
    || (refusal.unverified !== undefined
      && (!Array.isArray(refusal.unverified) || refusal.unverified.length > MAX_MERGE_REFUSAL_CHANGED
        || refusal.unverified.some((name) => typeof name !== "string" || name.length < 1 || name.length > 40)))
    || (refusal.reason !== undefined
      && (typeof refusal.reason !== "string" || refusal.reason.length > MAX_MERGE_REJECT_REASON))) {
    throw new Error("MAIN_MERGE_APPROVAL_ROW_TAMPERED");
  }
  return refusal as unknown as MergeApprovalRefusal;
}

/** Constant-time compare of two hex digests; a length or alphabet mismatch is simply not equal. */
function equalDigest(left: string, right: string): boolean {
  if (!HASH_PATTERN.test(left) || !HASH_PATTERN.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function mergeApprovalPrompt(
  task: CandidateTask,
  preview: CandidateCompletionPreview,
  previewDigest: string,
  blockers: string[],
  overwrite: OverwriteScan,
  hooks: PromotionFacts["hooks"],
): string {
  return [
    ...(overwrite.ignored.length === 0 ? [] : [
      `這次 merge 會覆蓋 main 上這些被忽略的檔案（git 會靜默覆蓋、回傳成功、事後仍回報工作樹乾淨）：`
        + `${overwrite.ignored.join("、")}。`,
    ]),
    hooks.hooks.length === 0
      ? `本次 promotion 不會執行任何 repo hook（hooksPath ${hooks.hooksPath || "預設"}）。`
      : `本次 promotion 會以你的身分、無沙箱執行下列 repo hook：`
        + `${hooks.hooks.map((hook) => `${hook.name}（sha256 ${hook.sha256.slice(0, 12)}）`).join("、")}。`,
    `即將要求核准的動作：把 candidate ${task.candidatePath} 的這個精確 snapshot merge 進 canonical main ${task.mainPath}`
      + `（分支 ${task.mainBranch}）。目前尚未修改 main。`,
    `Candidate HEAD ${preview.candidateHead}；main HEAD ${preview.mainHead}；base ${preview.baseMainHead}；`
      + `preview ${previewDigest}。`,
    `檔案 ${preview.fileCount} 個，新增 ${preview.additions} 行，刪除 ${preview.deletions} 行，`
      + `模式變更 ${preview.modeChanges} 個，submodule ${preview.submodules.length} 個。`,
    `復原點：${preview.recovery.ref}（指向 ${preview.recovery.head}）。`,
    preview.mergeable ? "已模擬 merge：沒有內容衝突。" : `已模擬 merge：${preview.mergeConflicts.length} 個檔案衝突。`,
    blockers.length === 0
      ? `本次核准只適用於這一個 snapshot，只能使用一次，且只授權 merge；請 Owner 在頁內 dialog 輸入 ${MERGE_APPROVAL_CONFIRMATION}。`
      : `目前不可核准：${blockers.join("、")}。請先處理後重新 preview 再詢問。`,
  ].join(" ");
}

function reservedIdentifiers(value: unknown): ReservedIdentifiers {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("CANDIDATE_REQUEST_ROW_TAMPERED");
  const input = value as Record<string, unknown>;
  const keys = ["taskId", "candidateId", "checkpointId", "completionId"];
  if (Object.keys(input).some((key) => !keys.includes(key))) throw new Error("CANDIDATE_REQUEST_ROW_TAMPERED");
  for (const key of keys) {
    const held = input[key];
    if (held !== undefined && (typeof held !== "string" || !UUID_PATTERN.test(held))) {
      throw new Error("CANDIDATE_REQUEST_ROW_TAMPERED");
    }
  }
  if (typeof input.taskId !== "string") throw new Error("CANDIDATE_REQUEST_ROW_TAMPERED");
  return input as unknown as ReservedIdentifiers;
}

/** Durable candidate lifecycle metadata; it does not constrain native host capabilities. */
export class CandidateRegistry {
  readonly path: string;
  readonly #dataDirectory: string;
  readonly #db: DatabaseSync;
  readonly #worktrees: WorktreeBroker;
  readonly #git: GitBroker;
  readonly #now: () => number;
  readonly #maxFiles: number;
  /** Keys currently executing in this process. Exact liveness, unlike a wall-clock window. */
  readonly #executing = new Set<string>();
  /** Keys whose attempt reached the point of creating a durable artifact this call. */
  readonly #reachedDurable = new Set<string>();
  /** Opaque token this call held when it took the reservation; proof of ownership for discard. */
  readonly #ownerToken = new Map<string, string>();
  /**
   * Last preview recomputation per approval, reused only on observation paths and only while the
   * approval row is byte-identical. In-process and non-durable on purpose: it is a throttle, not a
   * record, and a restarted process must recompute rather than inherit anyone's stale answer.
   */
  readonly #previewMemo = new Map<string, { rowHash: string; at: number; digest?: string; failure?: string }>();
  /**
   * When each unresolved promotion was last re-observed by this process. In-process and
   * non-durable, exactly like `#previewMemo`: it throttles an expensive read for callers that have
   * not authenticated, and it never turns a refusal into a permission.
   */
  readonly #promotionResolvedAt = new Map<string, number>();
  /**
   * Notified after an observation path has durably invalidated a drifted approval. The registry owns
   * durable state and knows nothing about the audit chain or the room ledger, so the record that has
   * to reach the owner is written by whoever supplied this.
   */
  readonly #onDrift: ((event: MergeApprovalDriftEvent) => void) | undefined;
  /**
   * Notified after every durable promotion transition, success and failure alike. Same contract as
   * `#onDrift`: the durable row is committed first, so a listener can never record a transition that
   * did not happen, and a listener that throws cannot undo one that did.
   */
  readonly #onPromotion: ((event: MergePromotionEvent) => void) | undefined;
  /**
   * Test-only interruption points. The shipped service leaves this unset; the crash tests pass a
   * function that kills their own process at a named step, which is the only way to exercise a
   * `kill -9` in the middle of a SQLite write from outside.
   */
  readonly #faultPoint: ((point: string) => void) | undefined;
  #closed = false;

  constructor(dataDirectory: string, options: {
    now?: () => number;
    maxFiles?: number;
    /** Test/embedded-code dependency injection; the shipped service leaves this unset. */
    gitBroker?: GitBroker;
    /** Sink for observation-time drift invalidations; see #onDrift. */
    onMergeApprovalInvalidated?: (event: MergeApprovalDriftEvent) => void;
    /** Sink for durable promotion transitions; see #onPromotion. */
    onMergePromotion?: (event: MergePromotionEvent) => void;
    /** Test-only; see #faultPoint. */
    faultPoint?: (point: string) => void;
  } = {}) {
    this.#dataDirectory = realpathSync(dataDirectory);
    this.#now = options.now ?? Date.now;
    this.#onDrift = options.onMergeApprovalInvalidated;
    this.#onPromotion = options.onMergePromotion;
    this.#faultPoint = options.faultPoint;
    this.#maxFiles = options.maxFiles ?? 500;
    this.#git = options.gitBroker ?? new GitBroker();
    if (!Number.isSafeInteger(this.#maxFiles) || this.#maxFiles < 1 || this.#maxFiles > 10_000) {
      throw new Error("CANDIDATE_MAX_FILES_INVALID");
    }
    this.path = join(this.#dataDirectory, "candidate-registry.sqlite");
    this.#worktrees = new WorktreeBroker(this.#dataDirectory);
    this.#db = openOwnerDatabase(this.path);
    try {
      this.#db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON; PRAGMA busy_timeout=5000;");
      verifyOwnerDatabaseFiles(this.path);
      const quick = this.#db.prepare("PRAGMA quick_check").get() as { quick_check?: string };
      if (quick.quick_check !== "ok") throw new Error("CANDIDATE_REGISTRY_CORRUPT");
      const version = Number((this.#db.prepare("PRAGMA user_version").get() as { user_version?: number }).user_version ?? 0);
      if (!Number.isSafeInteger(version) || version < 0 || version > SCHEMA_VERSION) {
        throw new Error("CANDIDATE_REGISTRY_SCHEMA_UNSUPPORTED");
      }
      if (version === 0) this.#migrate();
      else if (version < SCHEMA_VERSION) this.#upgrade(version);
      this.#assertPromotionExclusivity();
      this.#assertPromotionGroupColumns();
      if (this.#db.prepare("PRAGMA foreign_key_check").all().length > 0) {
        throw new Error("CANDIDATE_REGISTRY_FOREIGN_KEY_VIOLATION");
      }
      this.#verify();
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }

  async start(input: {
    actor: string;
    clientRequestId: unknown;
    roomId: string;
    mainPath: string;
    task: string;
    acceptanceCriteria?: string;
  }): Promise<CandidateTask> {
    return this.#exclusive(requestKey(input.clientRequestId), () => this.#startLocked(input));
  }

  async #startLocked(input: {
    actor: string;
    clientRequestId: unknown;
    roomId: string;
    mainPath: string;
    task: string;
    acceptanceCriteria?: string;
  }): Promise<CandidateTask> {
    this.#assertOpen();
    await this.reconcileCreating();
    const roomId = text(input.roomId, "CANDIDATE_ROOM_INVALID", 48);
    if (!ROOM_PATTERN.test(roomId)) throw new Error("CANDIDATE_ROOM_INVALID");
    const mainPath = await canonicalWorkspace(input.mainPath);
    const task = text(input.task, "CANDIDATE_TASK_TEXT_INVALID", 20_000);
    const acceptanceCriteria = input.acceptanceCriteria === undefined
      ? undefined
      : text(input.acceptanceCriteria, "CANDIDATE_ACCEPTANCE_INVALID", 20_000);
    const actor = text(input.actor, "CANDIDATE_ACTOR_INVALID", MAX_ACTOR);
    const clientRequestId = requestKey(input.clientRequestId);
    const reservation = this.#beginRequest({
      actor,
      clientRequestId,
      operation: "start",
      roomId,
      digest: requestDigest("start", {
        roomId, mainPath, task, acceptanceCriteria: acceptanceCriteria ?? null,
      }),
      mint: () => ({ taskId: randomUUID(), candidateId: randomUUID() }),
    });
    const ownerToken = reservation.ownerToken;
    this.#ownerToken.set(clientRequestId, ownerToken);
    // Two independent protections. The hash proves no other process re-stamped the reservation
    // between our reserve and our abort. `fresh` proves the reservation is ours to drop at all:
    // an adopted one may already own a candidate row, a worktree, or a recovery ref.
    if (!reservation.fresh) this.#reachedDurable.add(clientRequestId);
    const reserved = reservation.reserved;
    if (!reserved.candidateId) throw new Error("CANDIDATE_REQUEST_ROW_TAMPERED");
    const priorRow = this.#rowByTask(reserved.taskId);
    if (priorRow) {
      const recovered = this.#public(priorRow);
      // Distinct from CANDIDATE_REQUEST_IN_FLIGHT, which means the key is executing right now. Here
      // the earlier attempt left a half-created candidate and reconcileCreating has not yet aged it
      // out, so the wait is governed by the recovery grace rather than by another live call.
      if (recovered.status === "creating") {
        // Adopting stamped OUR pid onto the reservation on the way in. Bailing out without undoing
        // that would advertise a live owner for a call that is making no progress, and this seat is
        // long-lived — one retry inside the grace would guard the row for the life of the process,
        // leaving the key permanently unconvergeable and a new key the only way forward.
        this.#restoreOwnerPid(clientRequestId, ownerToken, reservation.priorOwnerPid);
        throw new Error("CANDIDATE_REQUEST_RECOVERING");
      }
      if (recovered.status === "failed") {
        try { this.#settleRequest(clientRequestId, ownerToken, "failed"); } catch { /* keep the original verdict */ }
        throw new Error("CANDIDATE_REQUEST_FAILED_RETRY_WITH_NEW_KEY");
      }
      // A start replay must not hand back a task that has moved on. Returning the current row would
      // present a completed — later possibly merged — candidate as a fresh start, complete with its
      // completion payload and an instruction to go on working in a worktree that may be gone.
      if (recovered.status !== "active") throw new Error("CANDIDATE_REQUEST_TASK_NO_LONGER_ACTIVE");
      this.#settleSucceeded(clientRequestId, ownerToken);
      return recovered;
    }
    if (reservation.replay) throw new Error("CANDIDATE_REQUEST_RECEIPT_MISSING");
    const inspection = await this.#git.inspect(mainPath);
    const ignored = await this.#ignoredInventory(mainPath);
    const baseMainHead = await this.#git.headSha(mainPath);
    const mainBranch = await this.#mainBranch(mainPath);
    const taskId = reserved.taskId;
    const candidateId = reserved.candidateId;
    const candidatePath = join(this.#dataDirectory, "candidates", candidateId);
    const candidateBranch = `orchestratory/candidate-${candidateId}`;
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("CANDIDATE_TIME_INVALID");
    const baselineJson = JSON.stringify(baseline(inspection, ignored));
    const bare: Omit<CandidateRow, "row_hash"> = {
      task_id: taskId,
      candidate_id: candidateId,
      room_id: roomId,
      main_path: mainPath,
      main_branch: mainBranch,
      base_main_head: baseMainHead,
      candidate_path: candidatePath,
      candidate_branch: candidateBranch,
      task_text: task,
      acceptance_criteria: acceptanceCriteria ?? null,
      status: "creating",
      baseline_json: baselineJson,
      completion_json: null,
      created_at_ms: now,
      updated_at_ms: now,
      completed_at_ms: null,
    };
    const row: CandidateRow = { ...bare, row_hash: rowHash(bare) };
    this.#reachedDurable.add(clientRequestId);
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#insert(row);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
    try {
      const created = await this.#worktrees.createCandidate(mainPath, candidateId, baseMainHead);
      if (created.workspace !== await canonicalWorkspace(candidatePath) || created.sourceWorkspace !== mainPath
        || created.branch !== candidateBranch || created.headSha !== baseMainHead) {
        throw new Error("CANDIDATE_WORKTREE_SCOPE_MISMATCH");
      }
      const active = this.#transition(row, { status: "active", updated_at_ms: this.#now() });
      this.#settleSucceeded(clientRequestId, ownerToken);
      return active;
    } catch (error) {
      // The task verdict and the key verdict are written together or not at all. A worktree that was
      // built and then failed only its final read is a `creating` row with a real candidate behind
      // it; calling that `failed` orphans the worktree and the branch, and burning the key with it
      // removes the only handle entitled to them. Left alone, the row stays half-created — which is
      // what it is — and reconcileCreating resolves it from the evidence on disk once no live
      // reservation holds it, activating it when the worktree is there and failing it when it is not.
      if (determinateRequestFailure(error)) {
        try { this.#transition(row, { status: "failed", updated_at_ms: this.#now() }); } catch { /* retain original failure */ }
        this.#settleFailedVerdict(clientRequestId, ownerToken, error);
      }
      throw error;
    }
  }

  async checkpoint(input: {
    actor: string;
    clientRequestId: unknown;
    taskId: string;
    roomId: string;
    mainPath: string;
    summary: string;
  }): Promise<CandidateCheckpoint> {
    return this.#exclusive(requestKey(input.clientRequestId), () => this.#checkpointLocked(input));
  }

  async #checkpointLocked(input: {
    actor: string;
    clientRequestId: unknown;
    taskId: string;
    roomId: string;
    mainPath: string;
    summary: string;
  }): Promise<CandidateCheckpoint> {
    this.#assertOpen();
    const summary = text(input.summary, "CANDIDATE_CHECKPOINT_SUMMARY_INVALID", 2_000);
    const actor = text(input.actor, "CANDIDATE_ACTOR_INVALID", MAX_ACTOR);
    const roomId = text(input.roomId, "CANDIDATE_ROOM_INVALID", 48);
    if (!ROOM_PATTERN.test(roomId)) throw new Error("CANDIDATE_ROOM_INVALID");
    if (typeof input.taskId !== "string" || !UUID_PATTERN.test(input.taskId)) throw new Error("CANDIDATE_TASK_NOT_FOUND");
    const mainPath = await canonicalWorkspace(input.mainPath);
    this.#assertScoped(input.taskId, roomId, mainPath);
    const clientRequestId = requestKey(input.clientRequestId);
    const reservation = this.#beginRequest({
      actor,
      clientRequestId,
      operation: "checkpoint",
      roomId,
      digest: requestDigest("checkpoint", { taskId: input.taskId, roomId, mainPath, summary }),
      mint: () => ({ taskId: input.taskId, checkpointId: randomUUID() }),
    });
    const ownerToken = reservation.ownerToken;
    this.#ownerToken.set(clientRequestId, ownerToken);
    // Two independent protections. The hash proves no other process re-stamped the reservation
    // between our reserve and our abort. `fresh` proves the reservation is ours to drop at all:
    // an adopted one may already own a candidate row, a worktree, or a recovery ref.
    if (!reservation.fresh) this.#reachedDurable.add(clientRequestId);
    const reservedCheckpointId = reservation.reserved.checkpointId;
    if (!reservedCheckpointId) throw new Error("CANDIDATE_REQUEST_ROW_TAMPERED");
    const priorCheckpoint = this.#db.prepare("SELECT * FROM candidate_checkpoints WHERE id=?")
      .get(reservedCheckpointId) as unknown as CheckpointRow | undefined;
    if (priorCheckpoint) {
      const recovered = this.#publicCheckpoint(priorCheckpoint);
      this.#settleSucceeded(clientRequestId, ownerToken);
      return recovered;
    }
    if (reservation.replay) throw new Error("CANDIDATE_REQUEST_RECEIPT_MISSING");
    const task = await this.#activeScoped(input.taskId, roomId, mainPath);
    const expectedRowHash = this.#rowByTask(task.taskId)?.row_hash;
    if (!expectedRowHash) throw new Error("CANDIDATE_CONCURRENT_UPDATE");
    const candidate = await this.#worktrees.inspectCandidate(task.candidateId);
    if (candidate.workspace !== task.candidatePath || candidate.sourceWorkspace !== task.mainPath
      || candidate.branch !== task.candidateBranch) throw new Error("CANDIDATE_WORKTREE_SCOPE_MISMATCH");
    const state = await this.#git.inspect(candidate.workspace);
    if (!state.clean) throw new Error("CANDIDATE_CHECKPOINT_REQUIRES_CLEAN_WORKTREE");
    const now = this.#now();
    const checkpointId = reservedCheckpointId;
    const recoveryRef = this.#checkpointRef(task.taskId, checkpointId);
    this.#reachedDurable.add(clientRequestId);
    try {
      await this.#createCheckpointRef(task.mainPath, recoveryRef, candidate.headSha);
    } catch (error) {
      // Ref creation sits outside the DB transaction, so a verdict recorded here is the only thing
      // that stops a key retrying the same deterministic failure forever. It is recorded ONLY for a
      // verdict: an unwritable ref store or a git that could not be spawned says nothing about this
      // request, and the same key must still be able to converge once the repository is writable.
      this.#settleFailedVerdict(clientRequestId, ownerToken, error);
      throw error;
    }
    const bare: Omit<CheckpointRow, "row_hash"> = {
      id: checkpointId,
      task_id: task.taskId,
      candidate_head: candidate.headSha,
      recovery_ref: recoveryRef,
      summary,
      created_at_ms: now,
    };
    const row = { ...bare, row_hash: checkpointHash(bare) };
    let created!: CandidateCheckpoint;
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.#rowByTask(task.taskId);
      if (!current || current.row_hash !== expectedRowHash || current.status !== "active") {
        throw new Error("CANDIDATE_CONCURRENT_UPDATE");
      }
      this.#db.prepare("INSERT INTO candidate_checkpoints VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(row.id, row.task_id, row.candidate_head, row.recovery_ref, row.summary, row.created_at_ms, row.row_hash);
      this.#replace(current, this.#mutate(current, { updated_at_ms: now }));
      created = this.#publicCheckpoint(row);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      // The transaction rolled back, so nothing about this key was persisted here and a lost race,
      // a busy database or an I/O error is an unknown outcome rather than a verdict. The ref written
      // just above survives, and the retry adopts it rather than conflicting with it.
      this.#settleFailedVerdict(clientRequestId, ownerToken, error);
      throw error;
    }
    this.#settleSucceeded(clientRequestId, ownerToken);
    return created;
  }

  async complete(input: {
    actor: string;
    clientRequestId: unknown;
    taskId: string;
    roomId: string;
    mainPath: string;
    summary: string;
    tests?: unknown;
    knownRisks?: unknown;
  }): Promise<CandidateCompletionResult> {
    return this.#exclusive(requestKey(input.clientRequestId), () => this.#completeLocked(input));
  }

  async #completeLocked(input: {
    actor: string;
    clientRequestId: unknown;
    taskId: string;
    roomId: string;
    mainPath: string;
    summary: string;
    tests?: unknown;
    knownRisks?: unknown;
  }): Promise<CandidateCompletionResult> {
    this.#assertOpen();
    const summary = text(input.summary, "CANDIDATE_COMPLETION_SUMMARY_INVALID", 4_000);
    const checkedTests = tests(input.tests);
    const checkedRisks = risks(input.knownRisks);
    const actor = text(input.actor, "CANDIDATE_ACTOR_INVALID", MAX_ACTOR);
    const roomId = text(input.roomId, "CANDIDATE_ROOM_INVALID", 48);
    if (!ROOM_PATTERN.test(roomId)) throw new Error("CANDIDATE_ROOM_INVALID");
    if (typeof input.taskId !== "string" || !UUID_PATTERN.test(input.taskId)) throw new Error("CANDIDATE_TASK_NOT_FOUND");
    const mainPath = await canonicalWorkspace(input.mainPath);
    this.#assertScoped(input.taskId, roomId, mainPath);
    const clientRequestId = requestKey(input.clientRequestId);
    const reservation = this.#beginRequest({
      actor,
      clientRequestId,
      operation: "complete",
      roomId,
      digest: requestDigest("complete", {
        taskId: input.taskId, roomId, mainPath, summary,
        tests: checkedTests, knownRisks: checkedRisks,
      }),
      mint: () => ({ taskId: input.taskId, checkpointId: randomUUID(), completionId: randomUUID() }),
    });
    const ownerToken = reservation.ownerToken;
    this.#ownerToken.set(clientRequestId, ownerToken);
    // Two independent protections. The hash proves no other process re-stamped the reservation
    // between our reserve and our abort. `fresh` proves the reservation is ours to drop at all:
    // an adopted one may already own a candidate row, a worktree, or a recovery ref.
    if (!reservation.fresh) this.#reachedDurable.add(clientRequestId);
    const reservedCheckpointId = reservation.reserved.checkpointId;
    const reservedCompletionId = reservation.reserved.completionId;
    if (!reservedCheckpointId || !reservedCompletionId) throw new Error("CANDIDATE_REQUEST_ROW_TAMPERED");
    const priorRow = this.#rowByTask(input.taskId);
    if (priorRow?.completion_json) {
      const priorTask = this.#public(priorRow);
      const priorCheckpointRow = this.#db.prepare("SELECT * FROM candidate_checkpoints WHERE id=?")
        .get(reservedCheckpointId) as unknown as CheckpointRow | undefined;
      if (priorTask.completion && priorTask.completion.id === reservedCompletionId && priorCheckpointRow) {
        const recovered: CandidateCompletionResult = {
          task: priorTask,
          completion: priorTask.completion,
          checkpoint: this.#publicCheckpoint(priorCheckpointRow),
        };
        this.#settleSucceeded(clientRequestId, ownerToken);
        return recovered;
      }
    }
    if (reservation.replay) throw new Error("CANDIDATE_REQUEST_RECEIPT_MISSING");
    const task = await this.#activeScoped(input.taskId, roomId, mainPath);
    const expectedRowHash = this.#rowByTask(task.taskId)?.row_hash;
    if (!expectedRowHash) throw new Error("CANDIDATE_CONCURRENT_UPDATE");
    const candidate = await this.#worktrees.inspectCandidate(task.candidateId);
    if (candidate.workspace !== task.candidatePath || candidate.sourceWorkspace !== task.mainPath
      || candidate.branch !== task.candidateBranch) throw new Error("CANDIDATE_WORKTREE_SCOPE_MISMATCH");
    const candidateState = await this.#git.inspect(candidate.workspace);
    if (!candidateState.clean) throw new Error("CANDIDATE_COMPLETION_REQUIRES_CLEAN_WORKTREE");
    const checkpointId = reservedCheckpointId;
    const recoveryRef = this.#checkpointRef(task.taskId, checkpointId);
    const { preview, previewDigest, mainState, mainIgnored, mainHead } = await this.#previewSnapshot({
      task,
      candidateWorkspace: candidate.workspace,
      candidateHead: candidate.headSha,
      recoveryRef,
      tests: checkedTests,
      knownRisks: checkedRisks,
    });
    const completionId = reservedCompletionId;
    const createdAtMs = this.#now();
    const prompt = [
      `我已在 candidate ${task.candidatePath} 完成工作，尚未修改 main ${task.mainPath}。`,
      `Candidate HEAD ${candidate.headSha}；main HEAD ${mainHead}；preview ${previewDigest}。`,
      `檔案 ${preview.fileCount} 個，新增 ${preview.additions} 行，刪除 ${preview.deletions} 行，`
        + `模式變更 ${preview.modeChanges} 個，submodule ${preview.submodules.length} 個。`,
      preview.mergeable
        ? "已模擬 merge：沒有衝突。"
        : `已模擬 merge：${preview.mergeConflicts.length} 個檔案衝突${preview.mergeConflictsTruncated ? "（已截斷）" : ""}。`,
      "是否要將這個精確 candidate snapshot merge 到 main？目前尚未執行；同意後將進入 snapshot-bound 核准與 promotion。",
    ].join(" ");
    const completion: CandidateCompletion = {
      id: completionId,
      summary,
      createdAt: new Date(createdAtMs).toISOString(),
      previewDigest,
      preview,
      mergeDecision: "owner-required",
      next: "Ask the owner whether to merge this candidate into main",
      prompt,
    };
    const checkpointBare: Omit<CheckpointRow, "row_hash"> = {
      id: checkpointId,
      task_id: task.taskId,
      candidate_head: candidate.headSha,
      recovery_ref: recoveryRef,
      summary: `Completion: ${summary}`.slice(0, 2_000),
      created_at_ms: createdAtMs,
    };
    const checkpointRow = { ...checkpointBare, row_hash: checkpointHash(checkpointBare) };
    const currentCandidate = await this.#worktrees.inspectCandidate(task.candidateId);
    const currentCandidateState = await this.#git.inspect(currentCandidate.workspace);
    const currentMainState = await this.#git.inspect(task.mainPath);
    const currentMainIgnored = await this.#ignoredInventory(task.mainPath);
    const currentMainHead = await this.#git.headSha(task.mainPath);
    if (currentCandidate.headSha !== candidate.headSha || !currentCandidateState.clean
      || currentMainHead !== mainHead || currentMainState.fingerprint !== mainState.fingerprint
      || currentMainIgnored.fingerprint !== mainIgnored.fingerprint) {
      throw new Error("CANDIDATE_COMPLETION_SNAPSHOT_CHANGED");
    }
    this.#reachedDurable.add(clientRequestId);
    try {
      await this.#createCheckpointRef(task.mainPath, recoveryRef, candidate.headSha);
    } catch (error) {
      // The costliest key in the system to burn: by this line the candidate is finished work that
      // an owner is about to be asked to merge. A read-only ref store or a git that failed to spawn
      // must therefore leave the key retryable — the alternative is merge-ready work reachable only
      // through a new key, which knows nothing about what this one already wrote.
      this.#settleFailedVerdict(clientRequestId, ownerToken, error);
      throw error;
    }
    const completionJson = JSON.stringify(completion);
    let completed!: CandidateCompletionResult;
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#rowByTask(task.taskId);
      if (!row || row.row_hash !== expectedRowHash || row.status !== "active") {
        throw new Error("CANDIDATE_CONCURRENT_UPDATE");
      }
      this.#db.prepare("INSERT INTO candidate_checkpoints VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(checkpointRow.id, checkpointRow.task_id, checkpointRow.candidate_head,
          checkpointRow.recovery_ref, checkpointRow.summary, checkpointRow.created_at_ms, checkpointRow.row_hash);
      const next = this.#mutate(row, {
        status: "completed", completion_json: completionJson,
        updated_at_ms: createdAtMs, completed_at_ms: createdAtMs,
      });
      this.#replace(row, next);
      completed = {
        task: this.#public(next),
        completion,
        checkpoint: this.#publicCheckpoint(checkpointRow),
      };
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      // Same rule as the checkpoint transaction: a rollback persisted nothing, so the outcome is
      // unknown unless the failure names itself as a verdict.
      this.#settleFailedVerdict(clientRequestId, ownerToken, error);
      throw error;
    }
    this.#settleSucceeded(clientRequestId, ownerToken);
    return completed;
  }

  get(taskIdValue: string): CandidateTask | undefined {
    this.#assertOpen();
    const taskId = text(taskIdValue, "CANDIDATE_TASK_ID_INVALID", 36);
    if (!UUID_PATTERN.test(taskId)) throw new Error("CANDIDATE_TASK_ID_INVALID");
    const row = this.#rowByTask(taskId);
    return row ? this.#public(row) : undefined;
  }

  async status(input: { roomId: string; mainPath: string; taskId?: string }): Promise<CandidateTaskStatus[]> {
    this.#assertOpen();
    await this.reconcileCreating();
    const roomId = text(input.roomId, "CANDIDATE_ROOM_INVALID", 48);
    if (!ROOM_PATTERN.test(roomId)) throw new Error("CANDIDATE_ROOM_INVALID");
    const mainPath = await canonicalWorkspace(input.mainPath);
    if (input.taskId !== undefined && !UUID_PATTERN.test(input.taskId)) throw new Error("CANDIDATE_TASK_ID_INVALID");
    const rows = input.taskId === undefined
      ? this.#db.prepare("SELECT * FROM candidates WHERE room_id=? AND main_path=? ORDER BY created_at_ms DESC LIMIT ?")
        .all(roomId, mainPath, MAX_LIST) as unknown as CandidateRow[]
      : [this.#rowByTask(text(input.taskId, "CANDIDATE_TASK_ID_INVALID", 36))].filter(Boolean) as CandidateRow[];
    let sharedMainHead: string | undefined;
    let sharedMainDirty: boolean | undefined;
    let sharedMainFingerprint: string | undefined;
    let sharedMainIgnoredFingerprint: string | undefined;
    if (rows.length > 0) {
      try {
        sharedMainHead = await this.#git.headSha(mainPath);
        const mainState = await this.#git.inspect(mainPath);
        const mainIgnored = await this.#ignoredInventory(mainPath);
        sharedMainDirty = !mainState.clean;
        sharedMainFingerprint = mainState.fingerprint;
        sharedMainIgnoredFingerprint = mainIgnored.fingerprint;
      } catch { /* report missing/unverifiable main for every scoped task */ }
    }
    const output: CandidateTaskStatus[] = [];
    for (const row of rows) {
      this.#assertRow(row);
      if (row.room_id !== roomId || row.main_path !== mainPath) throw new Error("CANDIDATE_SCOPE_MISMATCH");
      const task = this.#public(row);
      let candidateHead: string | undefined;
      let candidateDirty: boolean | undefined;
      let recoveryReady = false;
      let candidateIdentity = false;
      const checkpoints = this.#checkpoints(task.taskId);
      try {
        const candidate = await this.#worktrees.inspectCandidate(task.candidateId);
        candidateHead = candidate.headSha;
        candidateDirty = !(await this.#git.inspect(candidate.workspace)).clean;
        candidateIdentity = candidate.workspace === task.candidatePath && candidate.sourceWorkspace === task.mainPath
          && candidate.branch === task.candidateBranch;
      } catch { /* report missing/unverifiable recovery without inventing it */ }
      const recovery = task.completion?.preview.recovery;
      const latestCheckpoint = checkpoints.at(-1);
      if (recovery) {
        recoveryReady = await this.#checkpointRefMatches(task.mainPath, recovery.ref, recovery.head);
      } else if (latestCheckpoint) {
        recoveryReady = await this.#checkpointRefMatches(
          task.mainPath, latestCheckpoint.recoveryRef, latestCheckpoint.candidateHead,
        );
      } else {
        recoveryReady = candidateIdentity && candidateHead === task.baseMainHead;
      }
      const completionStale = Boolean(task.completion && (
        candidateHead !== task.completion.preview.candidateHead
        || candidateDirty !== false
        || sharedMainHead !== task.completion.preview.mainHead
        || sharedMainFingerprint !== task.completion.preview.mainDirty.fingerprint
        || sharedMainIgnoredFingerprint !== task.completion.preview.mainDirty.ignoredFingerprint
      ));
      output.push({
        ...task,
        checkpoints,
        // Bar item 1: `state` here used to come straight off the stored row, so a granted approval
        // whose snapshot had moved still read `approved` on the surface every agent is told to
        // consult. The bindings are re-checked against live state first, and a drifted approval is
        // invalidated durably before it is summarised.
        mergeApprovals: await this.#observedMergeApprovalSummaries(task.taskId, "candidate-status"),
        live: {
          ...(candidateHead ? { candidateHead } : {}),
          ...(candidateDirty === undefined ? {} : { candidateDirty }),
          ...(sharedMainHead ? { mainHead: sharedMainHead } : {}),
          ...(sharedMainDirty === undefined ? {} : { mainDirty: sharedMainDirty }),
          completionStale,
          recoveryReady,
        },
      });
    }
    return output;
  }

  /** Recover an interrupted create without deleting either the Git branch or worktree. */
  async reconcileCreating(graceMs = CREATING_RECOVERY_GRACE_MS): Promise<{ activated: number; failed: number }> {
    this.#assertOpen();
    if (!Number.isSafeInteger(graceMs) || graceMs < 0 || graceMs > 24 * 60 * 60_000) {
      throw new Error("CANDIDATE_RECOVERY_GRACE_INVALID");
    }
    const cutoff = this.#now() - graceMs;
    const rows = this.#db.prepare(
      "SELECT * FROM candidates WHERE status='creating' AND updated_at_ms<=? ORDER BY created_at_ms",
    ).all(cutoff) as unknown as CandidateRow[];
    // Reaping mutates the AUTHORITATIVE table, so it must not decide liveness from the clock alone.
    // A `creating` row whose reservation is still live belongs to an attempt that is running right
    // now — worktree creation on a large repository, or a machine that slept mid-checkout, both
    // outlast any grace. Reaping it made the creator's own transition CAS-fail, burned its key, and
    // the documented "mint a new key" recovery then produced a second candidate plus an orphan
    // worktree and branch: one logical request, two durable artifacts.
    const guarded = this.#reservedCreatingTaskIds();
    let activated = 0;
    let failed = 0;
    for (const observed of rows) {
      if (guarded.has(observed.task_id)) continue;
      this.#assertRow(observed);
      let status: CandidateStatus = "failed";
      try {
        const candidate = await this.#worktrees.inspectCandidate(observed.candidate_id);
        if (candidate.workspace === observed.candidate_path && candidate.sourceWorkspace === observed.main_path
          && candidate.branch === observed.candidate_branch && candidate.headSha === observed.base_main_head) {
          status = "active";
        }
      } catch { /* retain metadata and mark the interrupted creation as failed */ }
      this.#db.exec("BEGIN IMMEDIATE");
      try {
        const current = this.#rowByTask(observed.task_id);
        if (current?.status === "creating" && current.row_hash === observed.row_hash) {
          const now = this.#now();
          this.#replace(current, this.#mutate(current, { status, updated_at_ms: now }));
          if (status === "active") activated += 1;
          else failed += 1;
        }
        this.#db.exec("COMMIT");
      } catch (error) {
        this.#db.exec("ROLLBACK");
        throw error;
      }
    }
    return { activated, failed };
  }

  inventory(): {
    database: string;
    schemaVersion: number;
    databaseBytes: number;
    tasks: number;
    active: number;
    completed: number;
    checkpoints: number;
    /**
     * The idempotency ledger has no TTL and no prune: every settled request keeps its row so a late
     * retry can still be answered. Growth is bounded by legitimate call volume, not by anyone with a
     * malformed request, but it only ever grows — so it is reported here rather than left invisible.
     */
    requests: number;
    requestsPending: number;
    /** Merge approvals ever recorded, and the subset that is still answerable. Same growth story. */
    mergeApprovals: number;
    mergeApprovalsOpen: number;
  } {
    this.#assertOpen();
    const row = this.#db.prepare(`SELECT
      (SELECT COUNT(*) FROM candidates) tasks,
      (SELECT COUNT(*) FROM candidates WHERE status IN ('creating','active')) active,
      (SELECT COUNT(*) FROM candidates WHERE status='completed') completed,
      (SELECT COUNT(*) FROM candidate_checkpoints) checkpoints,
      (SELECT COUNT(*) FROM candidate_requests) requests,
      (SELECT COUNT(*) FROM candidate_requests WHERE state='pending') requestsPending,
      (SELECT COUNT(*) FROM candidate_merge_approvals) mergeApprovals,
      (SELECT COUNT(*) FROM candidate_merge_approvals WHERE state IN ('requested','approved')) mergeApprovalsOpen`)
      .get() as {
        tasks: number; active: number; completed: number; checkpoints: number;
        requests: number; requestsPending: number; mergeApprovals: number; mergeApprovalsOpen: number;
      };
    return { database: this.path, schemaVersion: SCHEMA_VERSION, databaseBytes: statSync(this.path).size, ...row };
  }

  integrity(): { schemaVersion: number; quickCheck: string; rowsValid: boolean } {
    this.#assertOpen();
    const quickCheck = String((this.#db.prepare("PRAGMA quick_check").get() as { quick_check?: string }).quick_check ?? "unknown");
    let rowsValid = true;
    try { this.#verify(); } catch { rowsValid = false; }
    return { schemaVersion: SCHEMA_VERSION, quickCheck, rowsValid };
  }

  /** Recovery refs with no owning checkpoint row. Reported, never deleted: removing refs from the
   *  owner's canonical repository is a destructive Git action that requires scoped approval. */
  async orphanRecoveryRefs(mainPath: string): Promise<Array<{ ref: string; head: string }>> {
    this.#assertOpen();
    const workspace = await canonicalWorkspace(mainPath);
    const listing = await this.#gitCommand(
      workspace,
      ["for-each-ref", "--format=%(refname) %(objectname)", "refs/orchestratory/checkpoints"],
      ORPHAN_REF_SCAN_BYTES,
    );
    const orphans: { ref: string; head: string }[] = [];
    for (const line of listing.split("\n")) {
      if (!line) continue;
      // A refname can never contain a space, so a record that is not exactly two fields is output
      // this method does not understand. Guessing at it could report a ref that does not exist.
      const boundary = line.indexOf(" ");
      if (boundary < 1 || line.includes(" ", boundary + 1)) throw new Error("CANDIDATE_ORPHAN_REF_SCAN_INVALID");
      const ref = line.slice(0, boundary);
      const head = line.slice(boundary + 1);
      // Anything under this namespace that is not a well-formed checkpoint ref is somebody else's
      // ref; it is neither reported nor acted on.
      if (!CHECKPOINT_REF_PATTERN.test(ref) || !HEAD_PATTERN.test(head)) continue;
      const checkpointId = ref.slice(ref.lastIndexOf("/") + 1);
      const owning = this.#db.prepare("SELECT id FROM candidate_checkpoints WHERE id=?")
        .get(checkpointId) as unknown as { id: string } | undefined;
      if (owning) continue;
      orphans.push({ ref, head });
      if (orphans.length >= MAX_ORPHAN_RECOVERY_REFS) break;
    }
    return orphans;
  }

  /**
   * Recomputes, from live state, the exact snapshot an owner would be asked to approve, and writes
   * nothing whatsoever — no row, no ref, no worktree.
   *
   * The gates that make a snapshot approvable are reported as `blockers` rather than thrown, because
   * the owner has to be able to SEE why a candidate cannot be merged; a bare error code would hide
   * the conflicting paths that are the whole explanation.
   */
  async previewMainMerge(input: { taskId: string; roomId: string; mainPath: string }): Promise<MergeApprovalPreview> {
    this.#assertOpen();
    const scope = await this.#mergeScope(input.taskId, input.roomId, input.mainPath);
    const { preview, previewDigest } = await this.#previewSnapshot({
      task: scope.task,
      candidateWorkspace: scope.candidateWorkspace,
      candidateHead: scope.candidateHead,
      recoveryRef: scope.recoveryRef,
      tests: scope.completion.preview.tests,
      knownRisks: scope.completion.preview.knownRisks,
    });
    // The owner is shown the promotion gates at the same time as the snapshot, because being asked
    // to approve a merge that the promotion path will refuse is being asked a question with no
    // answer — and because the ignored-file list is the whole warning: those files are destroyed
    // without git saying anything at all.
    // Recomputed live, on purpose: these are facts about main RIGHT NOW, so the owner sees the same
    // gate the promotion will apply, while the digest they sign stays a description of the snapshot.
    const live = await this.#liveGates(scope.task.mainPath, preview);
    const blockers = [...mergeBlockers(preview), ...live.blockers];
    return {
      taskId: scope.task.taskId,
      completionId: scope.completion.id,
      previewDigest,
      preview,
      recoveryRef: scope.recoveryRef,
      approvable: blockers.length === 0,
      blockers,
      overwrites: { checked: live.overwrite.checked, ignored: live.overwrite.ignored, untracked: live.overwrite.untracked },
      hooks: live.hooks,
      confirmationPhrase: MERGE_APPROVAL_CONFIRMATION,
      prompt: mergeApprovalPrompt(scope.task, preview, previewDigest, blockers, live.overwrite, live.hooks),
      mainMutation: false,
    };
  }

  /**
   * Records an agent's REQUEST that the owner be asked. It is not an approval and confers nothing:
   * the row it writes is `requested`, carries no secret, and cannot be consumed.
   *
   * The caller must present the `previewDigest` it just showed the owner. If live state has moved
   * since, the recomputed digest will not match and the request is refused, so a request can never
   * be raised against a snapshot nobody looked at.
   */
  async requestMainMerge(input: {
    actor: string;
    clientRequestId: unknown;
    taskId: string;
    roomId: string;
    mainPath: string;
    completionId: string;
    previewDigest: string;
  }): Promise<MergeApproval> {
    this.#assertOpen();
    const actor = text(input.actor, "CANDIDATE_ACTOR_INVALID", MAX_ACTOR);
    const clientRequestId = mergeRequestKey(input.clientRequestId);
    if (typeof input.completionId !== "string" || !UUID_PATTERN.test(input.completionId)) {
      throw new Error("MAIN_MERGE_COMPLETION_MISMATCH");
    }
    if (typeof input.previewDigest !== "string" || !HASH_PATTERN.test(input.previewDigest)) {
      throw new Error("MAIN_MERGE_PREVIEW_DIGEST_STALE");
    }
    const scope = await this.#mergeScope(input.taskId, input.roomId, input.mainPath);
    const digest = sha(JSON.stringify(["main-merge-request", {
      taskId: scope.task.taskId,
      roomId: scope.task.roomId,
      mainPath: scope.task.mainPath,
      completionId: input.completionId,
      previewDigest: input.previewDigest,
    }]));
    const replayed = this.#mergeApprovalByKey(clientRequestId);
    if (replayed) {
      if (replayed.input_digest !== digest) throw new Error("MAIN_MERGE_REQUEST_IDEMPOTENCY_CONFLICT");
      return this.#publicMergeApproval(replayed);
    }
    if (scope.completion.id !== input.completionId) throw new Error("MAIN_MERGE_COMPLETION_MISMATCH");
    this.#sweepExpiredMergeApprovals(scope.task.taskId);
    // Bar item 4: after a drift invalidation the owner must be able to be asked again immediately.
    // The open-approval slot is structural — one unanswered question per task — so an approval that
    // has silently stopped applying would otherwise hold that slot until its TTL ran out and block
    // the very re-ask the invalidation exists to prompt. Asking is an observation of the approval as
    // much as reading it is, so the same check runs, with the same durable record.
    await this.#observeOpenMergeApproval(scope.task.taskId, "merge-request");
    if (this.#openMergeApproval(scope.task.taskId)) throw new Error("MAIN_MERGE_APPROVAL_ALREADY_PENDING");
    // Nobody may be asked to approve a merge into a main whose last promotion is unaccounted for.
    // `requestMainMerge` already proved scope by resolving the task, the room and the workspace, and
    // it is the surface an owner uses to get a stuck task moving again, so it is not throttled.
    await this.#assertNoUnresolvedPromotion(scope.task.taskId, { authenticated: true });
    if (this.#countMergeApprovals(scope.task.taskId) >= MAX_MERGE_APPROVALS_PER_TASK) {
      throw new Error("MAIN_MERGE_APPROVAL_TASK_LIMIT_REACHED");
    }
    const { preview, previewDigest } = await this.#previewSnapshot({
      task: scope.task,
      candidateWorkspace: scope.candidateWorkspace,
      candidateHead: scope.candidateHead,
      recoveryRef: scope.recoveryRef,
      tests: scope.completion.preview.tests,
      knownRisks: scope.completion.preview.knownRisks,
    });
    if (previewDigest !== input.previewDigest) throw new Error("MAIN_MERGE_PREVIEW_DIGEST_STALE");
    const blockers = mergeBlockers(preview);
    if (blockers.includes("MERGE_CONFLICTS_PRESENT")) throw new Error("MAIN_MERGE_PREVIEW_CONFLICTED");
    // Bar item 5: an owner must not be asked to sign for content the preview could not show them.
    if (blockers.length > 0) throw new Error("MAIN_MERGE_PREVIEW_TRUNCATED");
    // And they must not be asked at all when the promotion would be refused: a question whose only
    // possible answer is refused later is not a question, it is a wasted owner decision.
    const live = await this.#liveGates(scope.task.mainPath, preview);
    if (live.blockers.length > 0) throw new MergePromotionRefusedError(live.blockers, live.overwrite);
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("CANDIDATE_TIME_INVALID");
    const bare: Omit<MergeApprovalRow, "row_hash"> = {
      id: randomUUID(),
      client_request_id: clientRequestId,
      input_digest: digest,
      task_id: scope.task.taskId,
      completion_id: scope.completion.id,
      room_id: scope.task.roomId,
      main_path: scope.task.mainPath,
      main_branch: scope.mainBranch,
      candidate_path: scope.task.candidatePath,
      base_main_head: scope.task.baseMainHead,
      candidate_head: preview.candidateHead,
      main_head: preview.mainHead,
      main_fingerprint: preview.mainDirty.fingerprint,
      main_ignored_fingerprint: preview.mainDirty.ignoredFingerprint,
      recovery_ref: scope.recoveryRef,
      preview_digest: previewDigest,
      preview_json: JSON.stringify(preview),
      grant_action: MERGE_APPROVAL_GRANT,
      state: "requested",
      token_hash: null,
      actor,
      decided_by: null,
      refusal_json: null,
      created_at_ms: now,
      updated_at_ms: now,
      expires_at_ms: now + MERGE_APPROVAL_REQUEST_TTL_MS,
    };
    const row: MergeApprovalRow = { ...bare, row_hash: mergeApprovalHash(bare) };
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#insertMergeApproval(row);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      // Two writers racing the same key, or two keys racing the same task, both land here. Re-read
      // before deciding: a duplicate key carrying identical input is this request arriving twice,
      // not a conflict, and the row the winner wrote is the answer both callers are owed.
      const existing = this.#mergeApprovalByKey(clientRequestId);
      if (existing) {
        if (existing.input_digest !== digest) throw new Error("MAIN_MERGE_REQUEST_IDEMPOTENCY_CONFLICT");
        return this.#publicMergeApproval(existing);
      }
      if (this.#openMergeApproval(scope.task.taskId)) throw new Error("MAIN_MERGE_APPROVAL_ALREADY_PENDING");
      throw error;
    }
    return this.#publicMergeApproval(row);
  }

  /**
   * The owner's decision, and the only place authority is created. The whole binding is verified
   * against live state again here, so a request raised minutes ago against a snapshot that has since
   * moved is refused rather than quietly re-pointed at the new one.
   */
  async grantMainMerge(input: {
    approvalId: string;
    roomId: string;
    mainPath: string;
    previewDigest: string;
    confirmation: string;
    decidedBy: "local-web" | "local-tui";
  }): Promise<{ approval: MergeApproval; approvalToken: string; expiresAt: string }> {
    this.#assertOpen();
    if (input.decidedBy !== "local-web" && input.decidedBy !== "local-tui") {
      throw new Error("MAIN_MERGE_APPROVAL_ACTOR_INVALID");
    }
    const row = await this.#scopedMergeApprovalRow(input.approvalId, input.roomId, input.mainPath);
    if (row.state !== "requested") throw new Error("MAIN_MERGE_APPROVAL_NOT_PENDING");
    this.#assertMergeApprovalLive(row);
    // A request raised under the previous release was never checked against the promotion gates, so
    // there is no answer the owner could give it that would be safe to act on. It is retired by name
    // rather than granted and refused later, and the slot it held is released.
    if (this.#retirePredatingApproval(row)) throw new Error(PREVIEW_PREDATES_PROMOTION_GATES);
    if (input.confirmation !== MERGE_APPROVAL_CONFIRMATION) throw new Error("MAIN_MERGE_CONFIRMATION_MISMATCH");
    // The surface has to name the digest it displayed. Approving a row whose preview the caller never
    // saw is exactly the failure the whole binding exists to prevent.
    if (typeof input.previewDigest !== "string" || input.previewDigest !== row.preview_digest) {
      throw new Error("MAIN_MERGE_PREVIEW_DIGEST_MISMATCH");
    }
    const { changed, unverified } = await this.#verifyMergeBinding(row);
    if (changed.length > 0) {
      this.#settleMergeApproval(row, "invalidated", driftRefusal(changed, "grant", unverified));
      throw new MergeApprovalBindingError(changed, unverified);
    }
    // Nothing moved, but something could not be read, so this grant is refused and the request stays
    // exactly where it was — still `requested`, still answerable once the repository is readable.
    // Settling it here would destroy the owner's open question over a permission bit.
    if (unverified.length > 0) throw new MergeApprovalBindingUnverifiableError(unverified);
    const token = randomBytes(32).toString("base64url");
    const now = this.#now();
    const granted = this.#writeMergeApproval(row, {
      state: "approved",
      token_hash: sha(token),
      decided_by: input.decidedBy,
      updated_at_ms: Math.max(row.created_at_ms, now),
      expires_at_ms: Math.max(row.created_at_ms + 1, now + MERGE_APPROVAL_GRANT_TTL_MS),
    });
    return {
      approval: this.#publicMergeApproval(granted),
      approvalToken: token,
      expiresAt: new Date(granted.expires_at_ms).toISOString(),
    };
  }

  /**
   * Refusing, or withdrawing a grant the owner changed their mind about. It touches the approval row
   * and nothing else: no Git command runs, no candidate row changes, and no ref is removed. Refusal
   * is not a cleanup authorization, and the owner can be asked again after a fresh preview.
   */
  async rejectMainMerge(input: {
    approvalId: string;
    roomId: string;
    mainPath: string;
    decidedBy: "local-web" | "local-tui";
    reason?: string;
  }): Promise<MergeApproval> {
    this.#assertOpen();
    if (input.decidedBy !== "local-web" && input.decidedBy !== "local-tui") {
      throw new Error("MAIN_MERGE_APPROVAL_ACTOR_INVALID");
    }
    const row = await this.#scopedMergeApprovalRow(input.approvalId, input.roomId, input.mainPath);
    if (row.state !== "requested" && row.state !== "approved") throw new Error("MAIN_MERGE_APPROVAL_NOT_PENDING");
    const rejected = this.#writeMergeApproval(row, {
      state: "rejected",
      token_hash: null,
      decided_by: input.decidedBy,
      refusal_json: JSON.stringify(boundedRefusal({
        code: "OWNER_REJECTED",
        changed: [],
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      })),
      updated_at_ms: Math.max(row.created_at_ms, this.#now()),
    });
    return this.#publicMergeApproval(rejected);
  }

  /**
   * Everything that must hold before an approval may be spent, and nothing that spends it.
   *
   * It re-verifies the entire binding against live state a SECOND time — creation-time verification
   * alone would let anything that moved in between slip through — and it runs the gates that only
   * matter when main is actually about to be written. Every refusal here happens with the approval
   * still `approved`, so an owner whose working tree was dirty can clean it and try again. Only two
   * things end an approval on this path, and both of them are conditions no retry could fix: drift,
   * which ends it wherever it is noticed, and a snapshot older than the promotion gates themselves.
   */
  async #authorizeMainMerge(input: {
    approvalId: string;
    token: string;
    action: string;
    taskId: string;
    roomId: string;
    mainPath: string;
  }): Promise<{ row: MergeApprovalRow; preview: CandidateCompletionPreview; restore: GitRestorePoint }> {
    if (typeof input.approvalId !== "string" || !UUID_PATTERN.test(input.approvalId)) {
      throw new Error("MAIN_MERGE_APPROVAL_ID_INVALID");
    }
    // Bar item 4: the approval names one action. Anything else is refused before the row is read, so
    // no other operation can even attempt to spend it.
    if (input.action !== MERGE_APPROVAL_GRANT) throw new Error("MAIN_MERGE_APPROVAL_ACTION_NOT_GRANTED");
    if (typeof input.token !== "string" || !MERGE_APPROVAL_TOKEN_PATTERN.test(input.token)) {
      throw new Error("MAIN_MERGE_APPROVAL_TOKEN_INVALID");
    }
    const row = this.#mergeApprovalRow(input.approvalId);
    if (!row) throw new Error("MAIN_MERGE_APPROVAL_NOT_FOUND");
    this.#assertMergeApprovalRow(row);
    // Before anything about the approval is judged: an unresolved promotion means nobody knows what
    // state main is in, and spending anything against it would write on top of an unknown state with
    // no later record able to untangle the two. It is FIRST because every other refusal here is a
    // consequence — the approval that started the unresolved promotion is also, necessarily, already
    // spent — and "your token was used" sends the owner to the wrong problem. The one they have to
    // act on is their repository. (The state of an approval is already visible before the token is
    // checked, so this changes nothing about what an unauthenticated caller can learn.)
    //
    // The full re-observation behind it is expensive, so it is offered on proof rather than on
    // request: a caller that can show the token gets it unconditionally, and one that cannot is
    // throttled and refused. That changes nothing about which answer a legitimate owner receives.
    const authenticated = row.token_hash !== null && equalDigest(sha(input.token), row.token_hash);
    await this.#assertNoUnresolvedPromotion(row.task_id, { authenticated });
    // And the same question about the REPOSITORY rather than about this task: one main, one
    // promotion applying. Asked here, before any live gate, so that "somebody else is writing this
    // project right now" is the answer the owner gets instead of "your working tree is dirty" —
    // which is what the first merge's own output made true a moment later.
    await this.#assertMainNotBusy(row.main_path, row.task_id, { authenticated });
    if (row.state === "consumed") throw new Error("MAIN_MERGE_APPROVAL_ALREADY_CONSUMED");
    if (row.state !== "approved") throw new Error("MAIN_MERGE_APPROVAL_NOT_APPROVED");
    this.#assertMergeApprovalLive(row);
    if (row.token_hash === null || !equalDigest(sha(input.token), row.token_hash)) {
      throw new Error("MAIN_MERGE_APPROVAL_TOKEN_INVALID");
    }
    // What the caller believes it is about to do has to match what the owner agreed to. Scoping the
    // lookup by room and path instead would answer "not found" and never name the value that differs.
    const intent: string[] = [];
    if (input.taskId !== row.task_id) intent.push("taskId");
    if (input.roomId !== row.room_id) intent.push("roomId");
    let mainPath: string | undefined;
    try { mainPath = await canonicalWorkspace(input.mainPath); } catch { /* unresolvable is "changed" */ }
    if (mainPath !== row.main_path) intent.push("mainPath");
    if (intent.length > 0) throw new MergeApprovalBindingError(intent);
    const { changed, unverified } = await this.#verifyMergeBinding(row, { throttle: false });
    if (changed.length > 0) {
      this.#settleMergeApproval(row, "invalidated", driftRefusal(changed, "consume", unverified));
      throw new MergeApprovalBindingError(changed, unverified);
    }
    // Fail closed on the action, open on the decision: the merge does not proceed, and the grant is
    // still there to be spent when the check can actually run.
    if (unverified.length > 0) throw new MergeApprovalBindingUnverifiableError(unverified);
    const preview = assertPreviewShape(JSON.parse(row.preview_json) as unknown);
    // The gates that only exist because this call writes to main, re-checked against LIVE state
    // immediately before the approval is spent rather than trusted from preview time. `mergeable:
    // true` says the CONTENTS do not conflict; that is a statement about two trees and says nothing
    // about the working tree the merge is about to be written into, or about which code that working
    // tree will execute while it happens.
    const restore = await this.#git.restorePoint(row.main_path);
    const overwrite = await this.#overwriteScan(row.main_path, preview);
    const blockers = promotionBlockers(restore, overwrite);
    if (blockers.length > 0) throw new MergePromotionRefusedError(blockers, overwrite);
    // The hook inventory the owner approved must still be the hook inventory that is about to run.
    // A linked candidate worktree shares main's common `.git`, so a terminal agent can rewrite both
    // `core.hooksPath` and the hook itself between the preview and this moment.
    const approved = promotionFacts(preview);
    // A snapshot recorded before Phase 5-5 carries none of these, which is not "nothing changed":
    // it was never checked against any of them, and it is refused by name rather than defaulted.
    // Reachable: the integrity check no longer collapses "older than this feature" into "tampered",
    // so a promotion attempted directly against a previous-release approval arrives here and gets
    // this answer instead of a corruption error it can do nothing with.
    if (!approved) {
      this.#retirePredatingApproval(row);
      throw new MergePromotionRefusedError([PREVIEW_PREDATES_PROMOTION_GATES], overwrite);
    }
    if (approved.hooks.fingerprint !== restore.hooks.fingerprint) {
      this.#settleMergeApproval(row, "invalidated", driftRefusal(["hookEnvironment"], "consume"));
      throw new MergeApprovalBindingError(["hookEnvironment"]);
    }
    if (approved.mainIgnored.fingerprint !== restore.ignoredFingerprint) {
      this.#settleMergeApproval(row, "invalidated", driftRefusal(["mainIgnoredContent"], "consume"));
      throw new MergeApprovalBindingError(["mainIgnoredContent"]);
    }
    return { row, preview, restore };
  }

  /**
   * Spends the approval and merges the candidate into canonical main. This is the only code path in
   * the product that writes to the owner's project.
   *
   * The one thing that cannot be made atomic is "spend the approval" and "write main": one is a
   * SQLite transaction, the other is a subprocess. What IS made atomic is spending the approval and
   * recording, durably, that main is about to be written — a single transaction, committed before
   * git is invoked. From that moment on there is no crash point that leaves no record: the promotion
   * row says a promotion was under way, and the observation that resolves it READS the repository
   * rather than retrying the merge. "This needs a human to look" is a valid answer here; "I am not
   * sure, so let me try again" is not, because a second attempt on an unknown main is a second write.
   */
  async promoteMainMerge(input: {
    approvalId: string;
    token: string;
    action: string;
    taskId: string;
    roomId: string;
    mainPath: string;
    /**
     * Upper bound on the merge subprocess and everything it starts. Bounded on both sides: a hook
     * can hang forever, and a deadline a caller could set to zero or to a day would be no deadline.
     */
    mergeTimeoutMs?: number;
  }): Promise<MergePromotionResult> {
    this.#assertOpen();
    const mergeTimeoutMs = input.mergeTimeoutMs ?? MERGE_TIMEOUT_MS;
    if (!Number.isSafeInteger(mergeTimeoutMs) || mergeTimeoutMs < 1_000 || mergeTimeoutMs > MERGE_TIMEOUT_MS) {
      throw new Error("MAIN_MERGE_TIMEOUT_INVALID");
    }
    const { row, preview, restore } = await this.#authorizeMainMerge(input);
    const startedAt = this.#now();
    if (!Number.isSafeInteger(startedAt) || startedAt < 0) throw new Error("CANDIDATE_TIME_INVALID");
    const pending: MergePromotionObservation = {
      code: "PROMOTION_STARTED",
      mainHead: restore.head,
      authorizedMergeCommit: null,
      mergeInProgress: null,
      worktreeRestored: null,
      stashRestored: null,
      reflogPreserved: null,
      recoveryRefIntact: null,
      ownerBootAtSec: bootAtSec(),
      observedAt: new Date(startedAt).toISOString(),
    };
    const bare: Omit<PromotionRow, "row_hash"> = {
      id: randomUUID(),
      approval_id: row.id,
      task_id: row.task_id,
      room_id: row.room_id,
      main_path: row.main_path,
      main_branch: row.main_branch,
      candidate_head: row.candidate_head,
      recovery_ref: row.recovery_ref,
      main_head_before: restore.head,
      main_head_after: null,
      restore_json: JSON.stringify(restore),
      observation_json: JSON.stringify(pending),
      state: "applying",
      owner_pid: process.pid,
      started_at_ms: startedAt,
      updated_at_ms: startedAt,
      // No group yet, and that is a fact rather than a gap: git has not been spawned. It becomes a
      // number in `#recordMergePgid`, through the same write that puts it in the observation.
      merge_pgid: null,
      merge_boot_at_sec: null,
    };
    let promotion: PromotionRow = { ...bare, row_hash: mergePromotionHash(bare) };
    // Step one: the intent record, on disk, BEFORE the approval is spent and long before any Git
    // command that writes. A crash between here and the next step leaves an intent row beside an
    // approval that is still `approved`, and that pair says unambiguously that main was never
    // touched — the merge cannot start until the approval is spent.
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#faultPoint?.("promotion-intent-write");
      this.#insertPromotion(promotion);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      // The UNIQUE index on approval_id is one of the two exclusive markers: two callers holding the
      // same token race here, before either has run a Git command, and exactly one wins. The loser is
      // told what actually happened rather than shown a storage error, and it has written nothing.
      if (this.#db.prepare("SELECT id FROM candidate_merge_promotions WHERE approval_id=?").get(row.id)) {
        throw new Error("MAIN_MERGE_PROMOTION_ALREADY_STARTED");
      }
      // The other marker is exclusivity over the REPOSITORY: one main, one promotion applying. Two
      // different tasks with two different approvals over one project satisfy the first index and are
      // stopped only by this one, which is held for exactly as long as the promotion is under way.
      const busy = this.#db.prepare(
        "SELECT id FROM candidate_merge_promotions WHERE main_path=? AND state='applying'",
      ).get(row.main_path) as { id?: string } | undefined;
      if (busy?.id !== undefined) throw new Error("MAIN_MERGE_PROMOTION_MAIN_PATH_BUSY");
      throw error;
    }
    // The first of the two HEAD observations bar item 5 requires, recorded before anything is spent
    // and long before anything is written.
    this.#emitPromotion(promotion, "started", { mergeTimeoutMs, mainMutation: false });
    let consumed: MergeApprovalRow;
    // Step two: spend the approval. Once this commits, the approval is terminally spent — there is
    // no path that returns it to `approved` or issues another token. A failure after this point
    // means the owner previews and asks again, which is deliberate friction, not an oversight.
    try {
      this.#faultPoint?.("approval-consume-write");
      consumed = this.#writeMergeApproval(row, {
        state: "consumed",
        token_hash: null,
        updated_at_ms: Math.max(row.created_at_ms, startedAt),
      });
    } catch (error) {
      // The compare-and-set is the single-use guarantee. A loser here did not arrive late, it arrived
      // at the same instant. Nothing was written to main on this path, and the intent row is settled
      // as such rather than left looking like an interrupted merge.
      promotion = this.#writePromotion(promotion, {
        state: "rolled-back",
        observation_json: JSON.stringify({
          ...pending,
          code: "APPROVAL_NOT_SPENT_NO_GIT_COMMAND_RAN",
          observedAt: new Date(this.#now()).toISOString(),
        }),
        updated_at_ms: Math.max(promotion.started_at_ms, this.#now()),
      });
      const current = this.#mergeApprovalRow(row.id);
      if (current?.state === "consumed") throw new Error("MAIN_MERGE_APPROVAL_ALREADY_CONSUMED");
      throw error;
    }
    const authorization: MergeAuthorization = {
      approvalId: consumed.id,
      grants: consumed.grant_action,
      notAuthorized: MERGE_APPROVAL_NOT_AUTHORIZED,
      singleUse: true,
      binding: mergeBinding(consumed),
      preview,
      consumedAt: new Date(consumed.updated_at_ms).toISOString(),
    };
    let attempt: { exitCode: number; timedOut: boolean };
    // False until the runner actually hands back a result. Amendment (O): "this process watched the
    // merge leader close" is the strongest evidence any path here has, and a synthesised result for
    // a spawn that never happened is not it.
    let leaderExitObserved = false;
    try {
      // Step three, and the first thing that writes: the merge. Its process group is persisted the
      // instant it is spawned, because the subprocess is detached and outlives this process — a
      // `kill -9` here does not stop the merge, and without the group id a later reader cannot tell
      // "still being written" from "finished, unrecorded" and freezes the wrong answer over a
      // repository that is still changing.
      // git's own trace stream, written outside main, so the hooks it runs and their exit codes are
      // OBSERVED rather than summarised as "hooks: ok" from a flag nobody checked.
      const trace = this.#promotionTracePath(promotion.id);
      try { mkdirSync(join(this.#dataDirectory, "promotion-traces"), { recursive: true, mode: 0o700 }); }
      catch { /* a trace that cannot be written costs an observation, never the merge */ }
      attempt = await this.#git.mergeIntoHead(
        row.main_path, row.candidate_head, mergeTimeoutMs,
        (pgid) => { promotion = this.#recordMergePgid(promotion, pgid); },
        trace,
      );
      leaderExitObserved = true;
    } catch {
      // git could not even be run. Main may still be untouched, but that is a claim, not a reading,
      // so it goes through exactly the same observation as every other outcome.
      attempt = { exitCode: -1, timedOut: false };
    }
    if (attempt.exitCode !== 0) {
      // A merge git could not finish leaves the index and working tree mid-merge. Undoing that is
      // what returns main to where it was; it is not a second attempt at anything.
      try {
        if (await this.#git.mergeInProgress(row.main_path)) await this.#git.abortMerge(row.main_path);
      } catch { /* the observation below decides what actually happened, not this call's success */ }
    }
    promotion = await this.#settlePromotion(promotion, attempt, { leaderExitObserved });
    return {
      promotion: this.#publicPromotion(promotion),
      authorization,
      mainMutated: promotion.state === "applied",
    };
  }

  /**
   * Every promotion recorded for this exact Room and project, newest first, each one re-observed.
   *
   * This is the surface that answers "what happened to my repository" after a crash, so an
   * unresolved row is resolved by LOOKING at main: an authorized merge commit means applied, an
   * untouched working tree at the recorded head means it never ran, and anything else stays
   * unresolved and says so. A row whose owning process is still alive is a promotion in flight and
   * is reported as such without being settled.
   */
  async promotions(input: { roomId: string; mainPath: string; taskId?: string }): Promise<
    Array<MergePromotion | UnreadableMergePromotion>> {
    this.#assertOpen();
    const roomId = text(input.roomId, "CANDIDATE_ROOM_INVALID", 48);
    if (!ROOM_PATTERN.test(roomId)) throw new Error("CANDIDATE_ROOM_INVALID");
    const mainPath = await canonicalWorkspace(input.mainPath);
    if (input.taskId !== undefined && (typeof input.taskId !== "string" || !UUID_PATTERN.test(input.taskId))) {
      throw new Error("CANDIDATE_TASK_ID_INVALID");
    }
    const rows = input.taskId === undefined
      ? this.#db.prepare(`SELECT * FROM candidate_merge_promotions WHERE room_id=? AND main_path=?
          ORDER BY started_at_ms DESC, id LIMIT ?`).all(roomId, mainPath, MAX_LIST) as unknown as PromotionRow[]
      : this.#db.prepare(`SELECT * FROM candidate_merge_promotions WHERE room_id=? AND main_path=? AND task_id=?
          ORDER BY started_at_ms DESC, id LIMIT ?`)
        .all(roomId, mainPath, input.taskId, MAX_LIST) as unknown as PromotionRow[];
    const promotions: Array<MergePromotion | UnreadableMergePromotion> = [];
    for (const row of rows) {
      try {
        this.#assertPromotionRow(row);
      } catch {
        // Derived from the row every time, never from what some earlier call happened to return.
        promotions.push(this.#unreadableView(row));
        continue;
      }
      promotions.push(this.#publicPromotion(await this.#resolvePromotion(row)));
    }
    return promotions;
  }

  /** Merge approvals recorded for this exact Room/workspace, newest first. */
  async mergeApprovals(input: { roomId: string; mainPath: string; taskId?: string }): Promise<MergeApproval[]> {
    this.#assertOpen();
    const roomId = text(input.roomId, "CANDIDATE_ROOM_INVALID", 48);
    if (!ROOM_PATTERN.test(roomId)) throw new Error("CANDIDATE_ROOM_INVALID");
    const mainPath = await canonicalWorkspace(input.mainPath);
    if (input.taskId !== undefined && (typeof input.taskId !== "string" || !UUID_PATTERN.test(input.taskId))) {
      throw new Error("CANDIDATE_TASK_ID_INVALID");
    }
    const rows = input.taskId === undefined
      ? this.#db.prepare(`SELECT * FROM candidate_merge_approvals WHERE room_id=? AND main_path=?
          ORDER BY created_at_ms DESC, id LIMIT ?`).all(roomId, mainPath, MAX_LIST) as unknown as MergeApprovalRow[]
      : this.#db.prepare(`SELECT * FROM candidate_merge_approvals WHERE room_id=? AND main_path=? AND task_id=?
          ORDER BY created_at_ms DESC, id LIMIT ?`)
        .all(roomId, mainPath, input.taskId, MAX_LIST) as unknown as MergeApprovalRow[];
    const approvals: MergeApproval[] = [];
    for (const row of rows) {
      // Same reason as `status`: the owner-facing list must not present a decision that has stopped
      // describing anything. An unreadable row still throws here, as it did before — this listing is
      // what the approval dialog is opened from, so a row it cannot verify is not shown at all.
      this.#assertMergeApprovalRow(row);
      const observed = await this.#observeMergeApproval(row, "merge-approval-list");
      approvals.push({
        ...this.#publicMergeApproval(observed.row),
        ...(observed.check.checked || observed.check.unavailable !== undefined
          ? { bindingCheck: observed.check }
          : {}),
      });
    }
    return approvals;
  }

  /**
   * The approval plus a live re-verification of its binding, for a surface that has to decide whether
   * to keep its confirm control enabled.
   *
   * It can move an approval exactly one way: a drifted one becomes terminally `invalidated`. That is
   * Phase 5-4's requirement, and it is not a widening of what a polling dialog may do — the row was
   * already unusable the moment its bindings moved, and recording that fact is what stops the same
   * dead approval from being presented as live to the next reader, in this process or another. It
   * still cannot grant, consume, revive or delete anything, and an owner who steps away from an
   * undrifted approval finds it exactly as they left it.
   */
  async inspectMergeApproval(input: { approvalId: string; roomId: string; mainPath: string }): Promise<{
    approval: MergeApproval;
    binding: MergeApprovalBindingCheck;
    overwrites: { checked: boolean; ignored: string[]; untracked: string[]; unavailable?: string };
  }> {
    this.#assertOpen();
    const row = await this.#scopedMergeApprovalRow(input.approvalId, input.roomId, input.mainPath);
    const observed = await this.#observeMergeApproval(row, "merge-approval-inspect");
    // Live, and carried on the surface the owner actually looks at.
    //
    // The hook inventory and the configuration keys are inside the bound preview, so the dialog
    // already had them. This list is not: it is a fact about live main — which files sitting there
    // right now would be silently replaced — and it is the one the owner cannot discover any other
    // way, because git overwrites those files, exits zero and reports a clean tree afterwards. The
    // agent-facing preview surface has shown it since Phase 5-5 began; the approval screen showed a
    // count and a fingerprint, which is [[PITFALLS]] #86's shape: a number instead of the facts.
    const overwrite = await this.#overwriteScan(
      row.main_path, assertPreviewShape(JSON.parse(row.preview_json) as unknown),
    );
    return {
      approval: {
        ...this.#publicMergeApproval(observed.row),
        ...(observed.check.checked || observed.check.unavailable !== undefined
          ? { bindingCheck: observed.check }
          : {}),
      },
      binding: observed.check,
      overwrites: {
        checked: overwrite.checked,
        ignored: overwrite.ignored,
        untracked: overwrite.untracked,
        ...(overwrite.unavailable === undefined ? {} : { unavailable: overwrite.unavailable }),
      },
    };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }

  /**
   * Existence and scope check that does NOT require `active`. Reserving an idempotency key commits a
   * durable row, so a bogus or foreign taskId must be rejected before reservation — otherwise every
   * failed call leaves a permanent ledger row that nothing prunes.
   */
  #assertScoped(taskId: string, roomId: string, mainPath: string): void {
    const row = this.#rowByTask(taskId);
    if (!row) throw new Error("CANDIDATE_NOT_ACTIVE");
    this.#assertRow(row);
    if (row.room_id !== roomId || row.main_path !== mainPath) throw new Error("CANDIDATE_SCOPE_MISMATCH");
  }

  async #activeScoped(taskIdValue: string, roomIdValue: string, mainPathValue: string): Promise<CandidateTask> {
    const taskId = text(taskIdValue, "CANDIDATE_TASK_ID_INVALID", 36);
    if (!UUID_PATTERN.test(taskId)) throw new Error("CANDIDATE_TASK_ID_INVALID");
    const roomId = text(roomIdValue, "CANDIDATE_ROOM_INVALID", 48);
    const mainPath = await canonicalWorkspace(mainPathValue);
    const row = this.#rowByTask(taskId);
    if (!row || row.status !== "active") throw new Error("CANDIDATE_NOT_ACTIVE");
    this.#assertRow(row);
    if (row.room_id !== roomId || row.main_path !== mainPath) throw new Error("CANDIDATE_SCOPE_MISMATCH");
    return this.#public(row);
  }

  async #gitCommand(workspace: string, args: string[], outputLimitBytes = 1_048_576): Promise<string> {
    const result = await runProcess({
      executable: await resolveExecutable("git"),
      args,
      cwd: workspace,
      timeoutMs: 30_000,
      outputLimitBytes,
      env: minimalGitEnvironment(),
    });
    if (result.exitCode !== 0 || result.terminationReason) throw new Error("CANDIDATE_GIT_COMMAND_FAILED");
    return result.stdout;
  }

  async #gitNulTokens(workspace: string, args: string[], onToken: (token: string) => void): Promise<void> {
    const decoder = new StringDecoder("utf8");
    let pending = "";
    const consume = (chunk: Buffer): void => {
      pending += decoder.write(chunk);
      for (;;) {
        const boundary = pending.indexOf("\0");
        if (boundary < 0) return;
        const token = pending.slice(0, boundary);
        pending = pending.slice(boundary + 1);
        if (token.includes("\uFFFD")) throw new Error("CANDIDATE_GIT_PATH_ENCODING_INVALID");
        onToken(token);
      }
    };
    const result = await runProcess({
      executable: await resolveExecutable("git"),
      args,
      cwd: workspace,
      timeoutMs: 30_000,
      outputLimitBytes: 262_144,
      env: minimalGitEnvironment(),
      stdoutConsumer: consume,
    });
    pending += decoder.end();
    // A deadline is reported as a deadline. It is still a failure and still fails closed, but the
    // owner of a repository that has simply outgrown the 30-second budget needs to be able to tell
    // that apart from a repository that cannot be read at all.
    if (result.terminationReason === "timeout") throw new Error(MERGE_PREVIEW_DEADLINE_CODE);
    if (result.exitCode !== 0 || result.terminationReason) throw new Error("CANDIDATE_GIT_COMMAND_FAILED");
    if (pending.length > 0) throw new Error("CANDIDATE_GIT_STREAM_TRUNCATED");
  }

  #checkpointRef(taskId: string, checkpointId: string): string {
    if (!UUID_PATTERN.test(taskId) || !UUID_PATTERN.test(checkpointId)) throw new Error("CANDIDATE_CHECKPOINT_REF_INVALID");
    return `refs/orchestratory/checkpoints/${taskId}/${checkpointId}`;
  }

  /**
   * The ref is written before the row that records it, so an interrupted or rolled-back attempt can
   * leave the ref alone on disk. `update-ref <ref> <new> ""` means "must not exist", which would make
   * every retry of that exact reserved checkpoint fail forever. Adopt a ref that already names the
   * exact head instead, and refuse only when it names something else.
   */
  async #createCheckpointRef(mainPath: string, ref: string, head: string): Promise<void> {
    if (!CHECKPOINT_REF_PATTERN.test(ref) || !HEAD_PATTERN.test(head)) throw new Error("CANDIDATE_CHECKPOINT_REF_INVALID");
    // One read, not two: asking "does it match?" and then "does it exist?" as separate subprocesses
    // let a concurrent writer land the identical ref in between and turn an adoptable ref into a
    // spurious conflict.
    const existing = await this.#checkpointRefValue(mainPath, ref);
    if (existing === head) return;
    if (existing !== undefined) throw new Error("CANDIDATE_CHECKPOINT_REF_CONFLICT");
    await this.#gitCommand(mainPath, ["update-ref", ref, head, ""]);
    if (!await this.#checkpointRefMatches(mainPath, ref, head)) throw new Error("CANDIDATE_CHECKPOINT_REF_VERIFY_FAILED");
  }

  async #checkpointRefValue(mainPath: string, ref: string): Promise<string | undefined> {
    if (!CHECKPOINT_REF_PATTERN.test(ref)) return undefined;
    try {
      const value = (await this.#gitCommand(mainPath, ["rev-parse", "--verify", `${ref}^{commit}`], 16_384)).trim();
      return HEAD_PATTERN.test(value) ? value : undefined;
    } catch { return undefined; }
  }

  async #checkpointRefMatches(mainPath: string, ref: string, head: string): Promise<boolean> {
    if (!CHECKPOINT_REF_PATTERN.test(ref) || !HEAD_PATTERN.test(head)) return false;
    try {
      return (await this.#gitCommand(mainPath, ["rev-parse", "--verify", `${ref}^{commit}`], 16_384)).trim() === head;
    } catch { return false; }
  }

  /**
   * The same question as `#checkpointRefMatches`, but with three answers instead of two.
   *
   * `--quiet` is what makes the third separable: git exits 1 with empty output for a ref that simply
   * is not there, and uses 128 (or dies outright) when it cannot read the repository. Collapsing both
   * into `false`, as the boolean form does, is exactly how an unreadable `.git` gets reported to the
   * owner as "your recovery point is gone" — so the drift check uses this form and lets an
   * unreadable repository throw.
   */
  async #checkpointRefState(mainPath: string, ref: string, head: string): Promise<"matches" | "differs"> {
    if (!CHECKPOINT_REF_PATTERN.test(ref) || !HEAD_PATTERN.test(head)) return "differs";
    const result = await runProcess({
      executable: await resolveExecutable("git"),
      args: ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
      cwd: mainPath,
      timeoutMs: 30_000,
      outputLimitBytes: 16_384,
      env: minimalGitEnvironment(),
    });
    if (result.terminationReason) throw new Error("CANDIDATE_GIT_COMMAND_FAILED");
    if (result.exitCode === 1) return "differs";
    if (result.exitCode !== 0) throw new Error("CANDIDATE_GIT_COMMAND_FAILED");
    return result.stdout.trim() === head ? "matches" : "differs";
  }

  async #ignoredInventory(workspace: string): Promise<{ files: number; fingerprint: string }> {
    const fingerprint = createHash("sha256");
    let files = 0;
    await this.#gitNulTokens(
      workspace,
      ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"],
      (path) => {
        if (!path) return;
        files += 1;
        fingerprint.update(path, "utf8").update("\0");
      },
    );
    return { files, fingerprint: fingerprint.digest("hex") };
  }

  /**
   * `--raw` rather than `--name-status`, because name-status discards the file modes. Without them a
   * pure permission change (644 -> 755) is an ordinary `M` with zero line changes, and a submodule
   * pointer move (mode 160000) is indistinguishable from an edited file — both invisible to the owner
   * being asked to approve the merge.
   */
  async #diff(base: string, head: string, workspace: string): Promise<Pick<CandidateCompletionPreview,
    "files" | "fileCount" | "filesTruncated" | "additions" | "deletions" | "binaryEntries" |
    "modeChanges" | "submodules" | "submodulesTruncated" | "largeFiles" | "largeFileScanTruncated">> {
    const files: CandidateFileChange[] = [];
    const submodules: string[] = [];
    let fileCount = 0;
    let modeChanges = 0;
    let submoduleCount = 0;
    let record: { from: string; to: string; code: string } | undefined;
    let first: string | undefined;
    await this.#gitNulTokens(
      workspace,
      ["diff", "--raw", "-z", "--find-renames", base, head, "--"],
      (token) => {
        if (record === undefined) {
          // A record this parser cannot fully read is refused, never guessed at: an unparsed mode
          // silently becomes "no mode change reported".
          record = parseRawDiffRecord(token);
          return;
        }
        const fromMode = record.from;
        const toMode = record.to;
        const code = record.code;
        if ((code === "R" || code === "C") && first === undefined) {
          if (!token) throw new Error("CANDIDATE_DIFF_INVALID");
          first = token;
          return;
        }
        if (!token) throw new Error("CANDIDATE_DIFF_INVALID");
        const submodule = fromMode === SUBMODULE_MODE || toMode === SUBMODULE_MODE;
        const modeChanged = fromMode !== toMode && fromMode !== ABSENT_MODE && toMode !== ABSENT_MODE;
        fileCount += 1;
        if (modeChanged) modeChanges += 1;
        if (submodule) {
          submoduleCount += 1;
          if (submodules.length < MAX_PREVIEW_SUBMODULES) submodules.push(token);
        }
        if (files.length < this.#maxFiles) {
          const operation = code === "R" ? "rename" : code === "C" ? "copy"
            : code === "A" ? "add" : code === "M" ? "modify" : code === "D" ? "delete"
              : code === "T" ? "type-change" : code === "U" ? "unmerged" : "unknown";
          files.push({
            path: token,
            operation,
            ...(first === undefined ? {} : { previousPath: first }),
            ...(modeChanged ? { mode: { from: fromMode, to: toMode } } : {}),
            ...(submodule ? { submodule: true as const } : {}),
          });
        }
        record = undefined;
        first = undefined;
      },
    );
    if (record !== undefined || first !== undefined) throw new Error("CANDIDATE_DIFF_INVALID");
    let additions = 0;
    let deletions = 0;
    let binaryEntries = 0;
    await this.#gitNulTokens(workspace, ["diff", "--numstat", "-z", "--no-renames", base, head, "--"], (record) => {
      if (!record) return;
      const firstTab = record.indexOf("\t");
      const secondTab = firstTab < 0 ? -1 : record.indexOf("\t", firstTab + 1);
      if (firstTab < 0 || secondTab < 0) throw new Error("CANDIDATE_DIFF_INVALID");
      const added = record.slice(0, firstTab);
      const removed = record.slice(firstTab + 1, secondTab);
      if (added === "-" || removed === "-") binaryEntries += 1;
      else {
        if (!/^\d+$/u.test(added) || !/^\d+$/u.test(removed)) throw new Error("CANDIDATE_DIFF_INVALID");
        additions += Number(added);
        deletions += Number(removed);
      }
    });
    const largeFiles: string[] = [];
    for (const file of files) {
      // A gitlink names a commit that need not exist in this repository at all, so asking for its
      // blob size is not a size question with an answer — it is a command that fails.
      if (file.operation === "delete" || file.submodule) continue;
      try {
        const sizeText = await this.#gitCommand(workspace, ["cat-file", "-s", `${head}:${file.path}`], 16_384);
        const size = Number(sizeText.trim());
        if (!Number.isSafeInteger(size) || size < 0) throw new Error("CANDIDATE_DIFF_INVALID");
        file.bytes = size;
        if (size > LARGE_FILE_BYTES) largeFiles.push(file.path);
      } catch (error) {
        if (file.operation !== "type-change") throw error;
      }
    }
    return {
      files,
      fileCount,
      filesTruncated: fileCount > files.length,
      additions,
      deletions,
      binaryEntries,
      modeChanges,
      submodules,
      submodulesTruncated: submoduleCount > submodules.length,
      largeFiles,
      // Derived from the same condition as filesTruncated above, so the two always agree. The
      // approval dialog blocks on either; a stored preview where they disagree is a tamper signal,
      // not a state this code can produce.
      largeFileScanTruncated: fileCount > files.length,
    };
  }

  async #mainBranch(mainPath: string): Promise<string> {
    const branch = (await this.#gitCommand(mainPath, ["branch", "--show-current"], 16_384)).trim();
    if (!branch || branch.length > 255 || branch.includes("\0")) throw new Error("CANDIDATE_MAIN_BRANCH_REQUIRED");
    return branch;
  }

  /**
   * The entire snapshot an owner is asked to act on, computed from live state and nothing else.
   *
   * `complete` freezes it into the completion; the merge approval path recomputes it, because an
   * approval must be bound to what is true when it is asked for rather than to what was true when
   * the work finished. Both go through this one function so the two previews cannot drift apart in
   * shape — the digest that binds the approval is a digest of this exact object.
   */
  async #previewSnapshot(input: {
    task: CandidateTask;
    candidateWorkspace: string;
    candidateHead: string;
    recoveryRef: string;
    tests: CandidateTestResult[];
    knownRisks: string[];
  }): Promise<{
    preview: CandidateCompletionPreview;
    previewDigest: string;
    mainState: GitInspection;
    mainIgnored: { files: number; fingerprint: string };
    mainHead: string;
  }> {
    const task = input.task;
    // One restore point, reused: it carries the inspection, the head, the ignored inventory with
    // content, the hook environment and every promotion blocker. Computing them separately would
    // both double the cost and let the preview and the promotion gate drift apart.
    const restore = await this.#git.restorePoint(task.mainPath);
    const mainState = restore.inspection;
    const mainIgnored = await this.#ignoredInventory(task.mainPath);
    const mainHead = restore.head;
    const diff = await this.#diff(task.baseMainHead, input.candidateHead, input.candidateWorkspace);
    // Simulated in the candidate worktree against the observed main head. Nothing about main is
    // written, checked out or refreshed; the owner is simply no longer asked to approve a merge
    // whose conflicts are unknown until it is attempted.
    const merge = await this.#mergePreview(input.candidateWorkspace, mainHead, input.candidateHead);
    const preview: CandidateCompletionPreview = {
      baseMainHead: task.baseMainHead,
      candidateHead: input.candidateHead,
      mainHead,
      mainDrift: mainHead !== task.baseMainHead,
      candidatePath: task.candidatePath,
      mainPath: task.mainPath,
      ...diff,
      tests: input.tests,
      knownRisks: input.knownRisks,
      conflicts: [
        ...(mainHead === task.baseMainHead ? [] : ["MAIN_DRIFT_REQUIRES_FRESH_MERGE_PREVIEW"]),
        ...(task.baseline.clean ? [] : ["DIRTY_MAIN_BASELINE_WAS_RECORDED_BUT_NOT_COPIED_TO_CANDIDATE"]),
        ...(mainState.clean ? [] : ["CURRENT_DIRTY_MAIN_CHANGES_ARE_EXCLUDED_FROM_CANDIDATE"]),
      ],
      ...merge,
      mainDirty: baseline(mainState, mainIgnored),
      recovery: { ready: true, kind: "git-checkpoint-ref", ref: input.recoveryRef, head: input.candidateHead },
    };
    // Computed last, because the overwrite scan needs the file list the diff just produced. Folding
    // it into the preview is what puts the hook inventory and the ignored-content fingerprint inside
    // `previewDigest`, and therefore inside the approval binding, without a schema change.
    const overwrite = await this.#overwriteScan(task.mainPath, preview);
    // ONLY the values that describe the snapshot the owner is signing for. The live gates —
    // `.git/index.lock`, a merge another process left in progress — are deliberately NOT here: they
    // are facts about this instant, and folding them into the digest would make a lock another
    // process held for a second into permanent drift that destroys the owner's approval, which is
    // the exact "transient failure burns a durable decision" shape PITFALLS #85 records. A mutation
    // test put this bug in the tree; a real one caught it.
    preview.promotion = {
      mainIgnored: { files: restore.ignoredFiles, fingerprint: restore.ignoredFingerprint },
      hooks: restore.hooks,
    };
    return { preview, previewDigest: sha(JSON.stringify(preview)), mainState, mainIgnored, mainHead };
  }

  /**
   * Simulates merging the candidate head into the observed main head and reports the paths that
   * actually conflict.
   *
   * `git merge-tree --write-tree` computes the merge entirely in the object database: it writes no
   * ref, checks out nothing, and never touches either worktree, which is the only reason a real merge
   * result can be offered as a PREVIEW at all. It runs in the candidate worktree, which shares main's
   * object store, so main is not even the working directory of the subprocess.
   *
   * Exit status 1 is the documented "merged with conflicts" answer, not a failure. It is also what
   * git returns when it cannot merge the arguments at all, so the exit code alone decides nothing:
   * the stdout shape does. Anything that does not parse fails closed, because the one answer this
   * method must never invent is `mergeable: true`.
   */
  async #mergePreview(workspace: string, mainHead: string, candidateHead: string): Promise<Pick<
    CandidateCompletionPreview, "mergeConflicts" | "mergeConflictsTruncated" | "mergeable">> {
    if (!HEAD_PATTERN.test(mainHead) || !HEAD_PATTERN.test(candidateHead)) {
      throw new Error("CANDIDATE_MERGE_PREVIEW_UNAVAILABLE");
    }
    const decoder = new StringDecoder("utf8");
    const mergeConflicts: string[] = [];
    let pending = "";
    let bytes = 0;
    let tree: string | undefined;
    let listEnded = false;
    let conflictCount = 0;
    const consume = (chunk: Buffer): void => {
      bytes += chunk.length;
      if (bytes > MERGE_TREE_OUTPUT_BYTES) throw new Error("CANDIDATE_MERGE_PREVIEW_UNAVAILABLE");
      pending += decoder.write(chunk);
      for (;;) {
        const boundary = pending.indexOf("\0");
        if (boundary < 0) return;
        const token = pending.slice(0, boundary);
        pending = pending.slice(boundary + 1);
        if (token.includes("\uFFFD")) throw new Error("CANDIDATE_GIT_PATH_ENCODING_INVALID");
        // The record after the empty terminator is git's human-readable explanation of each
        // conflict. It is not parsed and never surfaces: only the machine-readable paths do.
        if (listEnded) continue;
        if (tree === undefined) {
          tree = token;
          continue;
        }
        if (token === "") {
          listEnded = true;
          continue;
        }
        conflictCount += 1;
        if (mergeConflicts.length < MAX_MERGE_CONFLICTS) mergeConflicts.push(token);
      }
    };
    let result;
    try {
      result = await runProcess({
        executable: await resolveExecutable("git"),
        args: ["merge-tree", "--write-tree", "--name-only", "-z", mainHead, candidateHead],
        cwd: workspace,
        timeoutMs: 60_000,
        outputLimitBytes: MERGE_TREE_OUTPUT_BYTES,
        env: minimalGitEnvironment(),
        stdoutConsumer: consume,
      });
    } catch {
      // A missing git, an over-budget stream, a path this parser refuses to transcode, a spawn
      // failure: every one of them means the merge was not simulated, and none of them may be
      // reported as a merge that simulated cleanly.
      throw new Error("CANDIDATE_MERGE_PREVIEW_UNAVAILABLE");
    }
    pending += decoder.end();
    // A conflicted answer is a whole shape, not an exit status: status 1 AND the empty terminator
    // that closes the conflict list AND at least one conflicted path. Git exits 1 for its own errors
    // too ("not something we can merge"), printing the reason to stderr and nothing to stdout, and a
    // process killed on the timeout also surfaces as status 1 with a half-read list. Neither may be
    // allowed to look like a merge result, so everything that is not exactly one of the two
    // documented shapes fails closed under a single verdict.
    const conflicted = result.exitCode === 1 && listEnded && conflictCount > 0;
    // Same reason as #gitNulTokens: the simulation running out of time is a distinct, actionable
    // fact, and collapsing it into the generic verdict is what made a large repository look broken.
    if (result.terminationReason === "timeout") throw new Error(MERGE_PREVIEW_DEADLINE_CODE);
    if (result.terminationReason || pending.length > 0 || tree === undefined || !HEAD_PATTERN.test(tree)
      || (!conflicted && (result.exitCode !== 0 || listEnded || conflictCount > 0))) {
      throw new Error("CANDIDATE_MERGE_PREVIEW_UNAVAILABLE");
    }
    return {
      mergeConflicts,
      mergeConflictsTruncated: conflictCount > mergeConflicts.length,
      mergeable: !conflicted,
    };
  }

  #migrate(): void {
    this.#db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE candidates (
        task_id TEXT PRIMARY KEY CHECK(length(task_id)=36),
        candidate_id TEXT NOT NULL UNIQUE CHECK(length(candidate_id)=36),
        room_id TEXT NOT NULL CHECK(length(room_id) BETWEEN 1 AND 48),
        main_path TEXT NOT NULL CHECK(length(main_path) BETWEEN 1 AND 4096),
        main_branch TEXT NOT NULL CHECK(length(main_branch) BETWEEN 1 AND 255),
        base_main_head TEXT NOT NULL CHECK(length(base_main_head) BETWEEN 40 AND 64),
        candidate_path TEXT NOT NULL UNIQUE CHECK(length(candidate_path) BETWEEN 1 AND 4096),
        candidate_branch TEXT NOT NULL UNIQUE CHECK(length(candidate_branch) BETWEEN 1 AND 320),
        task_text TEXT NOT NULL CHECK(length(task_text) BETWEEN 1 AND 20000),
        acceptance_criteria TEXT CHECK(acceptance_criteria IS NULL OR length(acceptance_criteria) BETWEEN 1 AND 20000),
        status TEXT NOT NULL CHECK(status IN ('creating','active','completed','retained','rejected','merged','failed')),
        baseline_json TEXT NOT NULL CHECK(length(baseline_json) BETWEEN 2 AND 20000),
        completion_json TEXT CHECK(completion_json IS NULL OR length(completion_json) BETWEEN 2 AND 1000000),
        created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
        updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= created_at_ms),
        completed_at_ms INTEGER CHECK(completed_at_ms IS NULL OR completed_at_ms >= created_at_ms),
        row_hash TEXT NOT NULL CHECK(length(row_hash)=64)
      ) STRICT;
      CREATE INDEX candidates_room_created ON candidates(room_id, created_at_ms DESC);
      CREATE TABLE candidate_checkpoints (
        id TEXT PRIMARY KEY CHECK(length(id)=36),
        task_id TEXT NOT NULL REFERENCES candidates(task_id),
        candidate_head TEXT NOT NULL CHECK(length(candidate_head) BETWEEN 40 AND 64),
        recovery_ref TEXT NOT NULL UNIQUE CHECK(length(recovery_ref) BETWEEN 1 AND 512),
        summary TEXT NOT NULL CHECK(length(summary) BETWEEN 1 AND 2000),
        created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
        row_hash TEXT NOT NULL CHECK(length(row_hash)=64)
      ) STRICT;
      CREATE INDEX candidate_checkpoints_task_created ON candidate_checkpoints(task_id, created_at_ms, id);
      ${REQUESTS_TABLE_SQL}
      ${MERGE_APPROVALS_TABLE_SQL}
      ${MERGE_PROMOTIONS_TABLE_SQL}
      PRAGMA user_version=${SCHEMA_VERSION}; COMMIT;`);
  }

  /**
   * Every supported upgrade is purely additive, so existing rows are left byte-identical and their
   * hashes stay valid; a failure rolls the whole step back.
   */
  /**
   * Whether every stored completion can still be read by the current reader.
   *
   * The v1 and v3 upgrade branches add tables and move no row, which makes the STORAGE layer purely
   * additive — and that is not the same as the database opening. A candidate completed before
   * `a75e904` carries a `completion_json` the current preview validator rejects, so the registry
   * fails to open at all, with a generic `CANDIDATE_COMPLETION_PREVIEW_INVALID` that names neither
   * the cause nor the version. Asked BEFORE any DDL, so a database that cannot be upgraded is left
   * exactly as it was and gives the same named answer on every subsequent open.
   */
  #assertCompletionsReadable(): void {
    const rows = this.#db.prepare(
      "SELECT completion_json FROM candidates WHERE completion_json IS NOT NULL",
    ).all() as unknown as Array<{ completion_json: string }>;
    for (const row of rows) {
      try {
        this.#completion(JSON.parse(row.completion_json) as unknown);
      } catch {
        throw new Error("CANDIDATE_REGISTRY_PRE_V4_COMPLETION_UNSUPPORTED");
      }
    }
  }

  /**
   * Makes sure the exclusive marker exists on a database this build did not create.
   *
   * The promotion table shipped in v5 without it, so a v5 database written by an earlier commit is
   * schema-current and unprotected — and bumping the version to add one index would rewrite nothing
   * while adding an upgrade branch to get wrong. Creating it here is idempotent and needs no version
   * change.
   *
   * If two `applying` rows over one main already exist, the index cannot be created, and that is the
   * invariant already broken: the answer is a named refusal to open rather than a silent downgrade
   * to no exclusivity at all. Nothing is deleted and nothing is rewritten to make it fit.
   */
  #assertPromotionExclusivity(): void {
    const present = this.#db.prepare(
      "SELECT name FROM sqlite_schema WHERE type='index' AND name='candidate_merge_promotions_applying'",
    ).get();
    if (present) return;
    try {
      this.#db.exec(MERGE_PROMOTIONS_EXCLUSIVE_SQL);
    } catch {
      throw new Error("CANDIDATE_MERGE_PROMOTION_MAIN_PATH_NOT_EXCLUSIVE");
    }
  }

  /**
   * Gives the merge process group its own columns on a database this build did not create.
   *
   * Same shape and same reasoning as `#assertPromotionExclusivity` above: the promotion table
   * shipped in v5 without them, so a v5 database written by an earlier commit is schema-current and
   * keeps the group only inside `observation_json` — the one field that is worthless exactly when it
   * is needed. `ADD COLUMN` is additive, appends NULL to every existing row, and `mergePromotionHash`
   * ignores the pair while both are null, so no stored hash moves and no existing row is rewritten.
   *
   * The version DOES move (v5 → v6), and this still runs unconditionally. The two answer different
   * questions: the version is what makes an older build refuse the database by name instead of
   * failing inside SQLite mid-write, and this is what makes the columns appear on a database whose
   * version was already current. Neither substitutes for the other, and running both is idempotent.
   *
   * If the columns cannot be added, opening fails by name rather than continuing with the defect the
   * columns exist to close.
   */
  #assertPromotionGroupColumns(): void {
    const present = new Set((this.#db.prepare(
      "SELECT name FROM pragma_table_info('candidate_merge_promotions')",
    ).all() as unknown as Array<{ name: string }>).map((column) => column.name));
    for (const column of MERGE_PROMOTIONS_GROUP_COLUMNS) {
      if (present.has(column)) continue;
      try {
        this.#db.exec(`ALTER TABLE candidate_merge_promotions ADD COLUMN ${column} INTEGER;`);
      } catch {
        throw new Error("CANDIDATE_MERGE_PROMOTION_GROUP_COLUMNS_MISSING");
      }
    }
  }

  #upgrade(from: number): void {
    if (from === 1 || from === 3) this.#assertCompletionsReadable();
    if (from === 1) {
      // v1 holds only candidates and checkpoints. Adding the request ledger, the merge approval
      // table and the promotion ledger is additive, so existing rows stay byte-identical and their
      // hashes stay valid.
      this.#db.exec(`BEGIN IMMEDIATE;
        ${REQUESTS_TABLE_SQL}
        ${MERGE_APPROVALS_TABLE_SQL}
        ${MERGE_PROMOTIONS_TABLE_SQL}
        PRAGMA user_version=${SCHEMA_VERSION}; COMMIT;`);
      return;
    }
    if (from === 3) {
      // v3 already carries the request ledger; the approval and promotion tables are new, and no v3
      // row moves.
      this.#db.exec(`BEGIN IMMEDIATE;
        ${MERGE_APPROVALS_TABLE_SQL}
        ${MERGE_PROMOTIONS_TABLE_SQL}
        PRAGMA user_version=${SCHEMA_VERSION}; COMMIT;`);
      return;
    }
    if (from === 4) {
      // v4 carries approvals but no promotion ledger; promotion is what Phase 5-5 adds. Purely
      // additive again: no approval, candidate or checkpoint row is read, rewritten or re-hashed.
      this.#db.exec(`BEGIN IMMEDIATE;
        ${MERGE_PROMOTIONS_TABLE_SQL}
        PRAGMA user_version=${SCHEMA_VERSION}; COMMIT;`);
      return;
    }
    if (from === 5) {
      // v5 is this schema without the two merge-group columns. `#assertPromotionGroupColumns` adds
      // them a moment from now and is idempotent, so the only thing left is the version itself.
      // `mergePromotionHash` leaves the pair out while both are null, so every v5 row keeps the
      // hash it was stored with and nothing is rewritten ([[PITFALLS]] #100).
      this.#db.exec(`BEGIN IMMEDIATE; PRAGMA user_version=${SCHEMA_VERSION}; COMMIT;`);
      return;
    }
    // v2 carried the request ledger without `owner_token`. It was never committed or released, so
    // refusing it costs nothing in the wild and is the only option that fails CLOSED: dropping the
    // ledger would silently un-answer already-`succeeded` keys, and the replay that follows creates
    // a duplicate durable candidate rather than merely losing a replay.
    throw new Error("CANDIDATE_REGISTRY_SCHEMA_UNSUPPORTED");
  }

  #insert(row: CandidateRow): void {
    this.#db.prepare("INSERT INTO candidates VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
      row.task_id, row.candidate_id, row.room_id, row.main_path, row.main_branch, row.base_main_head,
      row.candidate_path, row.candidate_branch, row.task_text, row.acceptance_criteria, row.status,
      row.baseline_json, row.completion_json, row.created_at_ms, row.updated_at_ms, row.completed_at_ms, row.row_hash,
    );
  }

  #rowByTask(taskId: string): CandidateRow | undefined {
    return this.#db.prepare("SELECT * FROM candidates WHERE task_id=?").get(taskId) as unknown as CandidateRow | undefined;
  }

  #mutate(row: CandidateRow, fields: Partial<CandidateRow>): CandidateRow {
    const merged = { ...row, ...fields };
    const { row_hash: _old, ...bare } = merged;
    return { ...bare, row_hash: rowHash(bare) };
  }

  #transition(row: CandidateRow, fields: Partial<CandidateRow>): CandidateTask {
    const next = this.#mutate(row, fields);
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#replace(row, next);
      this.#db.exec("COMMIT");
      return this.#public(next);
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  #replace(previous: CandidateRow, next: CandidateRow): void {
    const result = this.#db.prepare(`UPDATE candidates SET status=?,completion_json=?,updated_at_ms=?,completed_at_ms=?,row_hash=?
      WHERE task_id=? AND row_hash=?`).run(
      next.status, next.completion_json, next.updated_at_ms, next.completed_at_ms,
      next.row_hash, next.task_id, previous.row_hash,
    );
    if (Number(result.changes) !== 1) throw new Error("CANDIDATE_CONCURRENT_UPDATE");
  }

  /**
   * Runs one mutation per idempotency key at a time; a concurrent call is refused, not raced. If the
   * attempt aborts before creating any durable artifact, the reservation is removed so the key does
   * not linger as a phantom interrupted mutation.
   */
  async #exclusive<T>(clientRequestId: string, run: () => Promise<T>): Promise<T> {
    if (this.#executing.has(clientRequestId)) throw new Error("CANDIDATE_REQUEST_IN_FLIGHT");
    this.#executing.add(clientRequestId);
    try {
      return await run();
    } catch (error) {
      const owned = this.#ownerToken.get(clientRequestId);
      if (owned !== undefined && !this.#reachedDurable.has(clientRequestId)) {
        this.#discardRequest(clientRequestId, owned);
      }
      throw error;
    } finally {
      this.#executing.delete(clientRequestId);
      this.#reachedDurable.delete(clientRequestId);
      this.#ownerToken.delete(clientRequestId);
    }
  }

  /**
   * Drops a reservation whose attempt aborted before persisting anything. Leaving it `pending` would
   * make the key look like an interrupted mutation and permanently occupy the ledger for a call that
   * created nothing. Only a still-`pending` row is removed, so a settled verdict is never erased.
   */
  #discardRequest(clientRequestId: string, ownerToken: string): void {
    // Everything here is best effort and must never replace the caller's original error, so the
    // transaction is opened inside the guard rather than beside it.
    try {
      this.#db.exec("BEGIN IMMEDIATE");
      try {
        // The CAS is on the opaque token THIS call held. If another process adopted the reservation
        // it minted a fresh token, so the delete correctly matches nothing. Unlike a timestamp, the
        // token changes even when both attempts land in the same millisecond.
        this.#db.prepare("DELETE FROM candidate_requests WHERE client_request_id=? AND owner_token=? AND state='pending'")
          .run(clientRequestId, ownerToken);
        this.#db.exec("COMMIT");
      } catch (error) {
        this.#db.exec("ROLLBACK");
        throw error;
      }
    } catch { /* keep the caller's original failure */ }
  }

  /**
   * Task ids held by a `pending` reservation whose owner is still alive.
   *
   * Age deliberately plays no part. The scenarios that make a creator outlive any grace — a
   * large-repository worktree checkout, a laptop that slept mid-create — are exactly the ones where
   * the reservation is old AND the creator is alive, so an age test fails precisely when it matters:
   * reaping then CAS-fails the creator's own transition, burns its key, and the documented "mint a
   * new key" recovery produces a second candidate plus an orphan worktree and branch.
   *
   * Guarding on `pending` alone is equally wrong in the opposite direction: a creator killed
   * mid-create leaves a row that is never reaped, never resolvable by its own key, and counted as
   * active — a permanent stall whose only escape is the very duplicate the guard exists to prevent.
   *
   * Both failures come from the same gap: a reservation had no liveness at all. `owner_pid` supplies
   * it, and a provably dead owner is simply not guarded, so the row resolves from the worktree
   * evidence already on disk. Nothing is written here — settling the reservation would put the
   * artifacts it owns out of reach of the only key entitled to them. A retry that adopts and then
   * finds nothing to do hands the prior pid back (see #restoreOwnerPid) rather than advertising
   * itself as the live owner of work it is not doing.
   */
  #reservedCreatingTaskIds(): Set<string> {
    const live = new Set<string>();
    // Scoped to reservations that actually name a `creating` candidate. A `checkpoint` or `complete`
    // reservation whose mutation committed but whose best-effort settle never landed has nothing to
    // do with reaping, and touching it would destroy the replay it is holding open.
    const rows = this.#db.prepare(`SELECT r.owner_pid, r.reserved_json FROM candidate_requests r
      WHERE r.state='pending' AND r.operation='start'`).all() as unknown as
      Array<Pick<RequestRow, "owner_pid" | "reserved_json">>;
    for (const row of rows) {
      let taskId: string;
      try {
        taskId = reservedIdentifiers(JSON.parse(row.reserved_json) as unknown).taskId;
      } catch { continue; /* a corrupt advisory row must not stop recovery of the authoritative table */ }
      // A dead owner is simply not guarded, so reconcileCreating resolves the row on the evidence it
      // already has. Nothing is written here: settling the reservation would make the retry that owns
      // those artifacts unable to reach them, which is how the previous attempt at this reintroduced
      // the duplicate candidate it was meant to prevent.
      if (this.#ownerAlive(row.owner_pid)) live.add(taskId);
    }
    return live;
  }

  /** True when the reservation's owner process is this one, or is still running. */
  #ownerAlive(pid: number): boolean {
    if (pid === process.pid) return true;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      // EPERM means the pid exists but belongs to another user, so the owner is alive.
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  }

  /**
   * Hands liveness back to the attempt that actually owns the half-created candidate. Called when a
   * retry adopted the reservation and then found it had nothing to do; without it the retry's own
   * pid keeps the row guarded from recovery.
   */
  #restoreOwnerPid(clientRequestId: string, ownerToken: string, priorOwnerPid: number | undefined): void {
    if (priorOwnerPid === undefined || priorOwnerPid === process.pid) return;
    try {
      this.#db.exec("BEGIN IMMEDIATE");
      try {
        const current = this.#requestRow(clientRequestId);
        if (current && current.owner_token === ownerToken && current.state === "pending") {
          this.#assertRequestRow(current);
          this.#writeRequest(current, ownerToken, { owner_pid: priorOwnerPid });
        }
        this.#db.exec("COMMIT");
      } catch (error) {
        this.#db.exec("ROLLBACK");
        throw error;
      }
    } catch { /* best effort: the caller's RECOVERING answer must stand either way */ }
  }

  #requestRow(clientRequestId: string): RequestRow | undefined {
    return this.#db.prepare("SELECT * FROM candidate_requests WHERE client_request_id=?")
      .get(clientRequestId) as unknown as RequestRow | undefined;
  }

  /**
   * Reserves the idempotency key before any mutation runs and hands back the identifiers this
   * logical request owns. `replay` means the request already succeeded, so the caller rebuilds the
   * answer from durable state rather than repeating Git or SQLite work. A `pending` or `failed` row
   * means a previous attempt died mid-flight, so the retry reuses the same reserved identifiers and
   * converges on whatever that attempt managed to persist. A key reused with different operation,
   * room, or input fails closed before anything is touched.
   */
  #beginRequest(input: {
    actor: string;
    /** Already validated by requestKey() before the lock was taken. */
    clientRequestId: string;
    operation: CandidateRequestOperation;
    roomId: string;
    digest: string;
    mint: () => ReservedIdentifiers;
  }): { replay: boolean; fresh: boolean; reserved: ReservedIdentifiers; ownerToken: string; priorOwnerPid?: number } {
    const actor = text(input.actor, "CANDIDATE_ACTOR_INVALID", MAX_ACTOR);
    const clientRequestId = input.clientRequestId;
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("CANDIDATE_TIME_INVALID");
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.#requestRow(clientRequestId);
      if (existing) {
        this.#assertRequestRow(existing);
        if (existing.operation !== input.operation || existing.room_id !== input.roomId
          || existing.input_digest !== input.digest) {
          throw new Error("CANDIDATE_REQUEST_IDEMPOTENCY_CONFLICT");
        }
        const reserved = reservedIdentifiers(JSON.parse(existing.reserved_json) as unknown);
        // `pending` and `failed` mean different things and must not be treated alike. `pending` is
        // "outcome unknown" — the attempt died mid-flight or its settle never landed — so the retry
        // re-arms and converges. `failed` is a recorded verdict: retrying the same key would repeat
        // the same deterministic failure, so the caller is told to mint a new one instead of looping.
        if (existing.state === "failed") throw new Error("CANDIDATE_REQUEST_FAILED_RETRY_WITH_NEW_KEY");
        const replay = existing.state === "succeeded";
        // Adopting another attempt's `pending` reservation MUST change the row hash. The in-memory
        // lock only covers this process, and each MCP seat is a separate process on the same data
        // directory; leaving the row untouched made the creator's and the adopter's CAS identical,
        // so an aborting creator could delete a reservation the adopter was actively using and the
        // next retry would then mint a second candidate.
        const adopted = replay ? existing : this.#writeRequest(existing, existing.owner_token, {
          owner_token: randomUUID(),
          owner_pid: process.pid,
          // A clock that steps backwards (NTP correction, sleep/wake) would otherwise violate
          // CHECK(updated_at_ms >= created_at_ms) and break every retry of this key.
          updated_at_ms: Math.max(existing.created_at_ms, now),
        });
        this.#db.exec("COMMIT");
        return { replay, fresh: false, reserved, ownerToken: adopted.owner_token, priorOwnerPid: existing.owner_pid };
      }
      const reserved = input.mint();
      const bare: Omit<RequestRow, "row_hash"> = {
        client_request_id: clientRequestId,
        owner_token: randomUUID(),
        owner_pid: process.pid,
        actor,
        operation: input.operation,
        room_id: input.roomId,
        input_digest: input.digest,
        reserved_json: JSON.stringify(reserved),
        state: "pending",
        receipt_json: null,
        created_at_ms: now,
        updated_at_ms: now,
      };
      const row: RequestRow = { ...bare, row_hash: requestHash(bare) };
      this.#db.prepare("INSERT INTO candidate_requests VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
        row.client_request_id, row.owner_token, row.owner_pid, row.actor, row.operation, row.room_id, row.input_digest,
        row.reserved_json, row.state, row.receipt_json, row.created_at_ms, row.updated_at_ms, row.row_hash,
      );
      this.#db.exec("COMMIT");
      return { replay: false, fresh: true, reserved, ownerToken: row.owner_token };
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * The only way to UPDATE an existing `candidate_requests` row, and it cannot be called without
   * proving ownership. (Insert and the ownership-checked delete in #discardRequest are the other two
   * statements that touch the table; nothing else may.) This is deliberately structural rather than
   * a check at each call site: the ledger has more than one state-changing verb, and wiring
   * ownership into only some of them is exactly how a stale seat was able to overwrite a live one's
   * verdict. Any update verb added later inherits the rule because it has nowhere else to write.
   *
   * `ownerToken` is the token the CALLER holds. The adopt path in #beginRequest is the single place
   * allowed to hand over ownership, and it does so by minting the next token inside the same
   * transaction that re-reads the row.
   */
  #writeRequest(previous: RequestRow, ownerToken: string, fields: Partial<RequestRow>): RequestRow {
    if (previous.owner_token !== ownerToken) throw new Error("CANDIDATE_REQUEST_NOT_OWNED");
    // `succeeded` is terminal. Without this a loser in a race can overwrite the winner's verdict and
    // mark a demonstrably completed operation as failed.
    if (previous.state === "succeeded" && fields.state !== undefined && fields.state !== "succeeded") {
      throw new Error("CANDIDATE_REQUEST_ALREADY_SUCCEEDED");
    }
    const merged = { ...previous, ...fields };
    const { row_hash: _old, ...bare } = merged;
    const next: RequestRow = { ...bare, row_hash: requestHash(bare) };
    const result = this.#db.prepare(`UPDATE candidate_requests SET owner_token=?,owner_pid=?,state=?,receipt_json=?,updated_at_ms=?,row_hash=?
      WHERE client_request_id=? AND owner_token=? AND row_hash=?`).run(
      next.owner_token, next.owner_pid, next.state, next.receipt_json, next.updated_at_ms, next.row_hash,
      next.client_request_id, ownerToken, previous.row_hash,
    );
    if (Number(result.changes) !== 1) throw new Error("CANDIDATE_REQUEST_CONCURRENT_UPDATE");
    return next;
  }

  /**
   * Records the durable outcome. The receipt is a fixed-size marker, never the mutation payload, so
   * a large completion can never make settling fail. Settling runs after the mutation has already
   * committed, so a settle failure must not be reported as a mutation failure: the row simply stays
   * `pending` and the next attempt with the same key converges on the persisted artifacts.
   */
  #settleRequest(clientRequestId: string, ownerToken: string, state: "succeeded" | "failed"): void {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.#requestRow(clientRequestId);
      if (!existing) throw new Error("CANDIDATE_REQUEST_MISSING");
      this.#assertRequestRow(existing);
      this.#writeRequest(existing, ownerToken, {
        state,
        receipt_json: state === "succeeded" ? SETTLED_RECEIPT : null,
        // Clamped for the same reason as the adopt path: a backwards clock would otherwise violate
        // CHECK(updated_at_ms >= created_at_ms) and leave the row `pending` forever.
        updated_at_ms: Math.max(existing.created_at_ms, this.#now()),
      });
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Best-effort settle for an already-committed mutation; never converts success into failure. */
  #settleSucceeded(clientRequestId: string, ownerToken: string): void {
    try { this.#settleRequest(clientRequestId, ownerToken, "succeeded"); } catch { /* row stays pending; retry converges */ }
  }

  /**
   * The only path that writes the terminal `failed` state, and it refuses to do so for a failure it
   * cannot name as a verdict (see DETERMINATE_REQUEST_FAILURES).
   *
   * Declining to settle is not "assume it worked" — the caller still rethrows, so the action is
   * refused either way. It changes one thing only: whether the idempotency key survives to be
   * retried. An unknown outcome leaves the row `pending`, which is precisely what `pending` records,
   * and the next attempt with that key re-reads durable state and converges on whatever it finds.
   * Every write it could make is still guarded by #writeRequest's ownership and
   * already-succeeded checks, so a late settle can never demote a mutation that landed.
   */
  #settleFailedVerdict(clientRequestId: string, ownerToken: string, error: unknown): void {
    if (!determinateRequestFailure(error)) return;
    try { this.#settleRequest(clientRequestId, ownerToken, "failed"); } catch { /* retain original failure */ }
  }

  #assertRequestRow(row: RequestRow): void {
    const { row_hash: actual, ...bare } = row;
    if (!HASH_PATTERN.test(actual) || requestHash(bare) !== actual
      || !UUID_PATTERN.test(row.client_request_id) || !UUID_PATTERN.test(row.owner_token)
      || !Number.isSafeInteger(row.owner_pid) || row.owner_pid < 1
      || !ROOM_PATTERN.test(row.room_id)
      || !HASH_PATTERN.test(row.input_digest) || row.actor.length < 1 || row.actor.length > MAX_ACTOR
      || (row.state === "succeeded") !== (row.receipt_json !== null)) {
      throw new Error("CANDIDATE_REQUEST_ROW_TAMPERED");
    }
    reservedIdentifiers(JSON.parse(row.reserved_json) as unknown);
  }

  #assertRow(row: CandidateRow): void {
    const { row_hash: actual, ...bare } = row;
    if (!HASH_PATTERN.test(actual) || rowHash(bare) !== actual || !UUID_PATTERN.test(row.task_id)
      || !UUID_PATTERN.test(row.candidate_id) || !ROOM_PATTERN.test(row.room_id)
      || !isAbsolute(row.main_path) || !isAbsolute(row.candidate_path)
      || !HEAD_PATTERN.test(row.base_main_head)) throw new Error("CANDIDATE_ROW_TAMPERED");
    validateBaseline(JSON.parse(row.baseline_json) as unknown);
    const completedState = ["completed", "retained", "rejected", "merged"].includes(row.status);
    if (completedState !== Boolean(row.completion_json) || completedState !== Boolean(row.completed_at_ms)) {
      throw new Error("CANDIDATE_COMPLETION_STATE_INVALID");
    }
    if (row.completion_json) this.#completion(JSON.parse(row.completion_json) as unknown);
  }

  #assertCheckpoint(row: CheckpointRow): void {
    const { row_hash: actual, ...bare } = row;
    if (!HASH_PATTERN.test(actual) || checkpointHash(bare) !== actual || !UUID_PATTERN.test(row.id)
      || !UUID_PATTERN.test(row.task_id) || !HEAD_PATTERN.test(row.candidate_head)
      || !CHECKPOINT_REF_PATTERN.test(row.recovery_ref)
      || row.recovery_ref !== this.#checkpointRef(row.task_id, row.id)) {
      throw new Error("CANDIDATE_CHECKPOINT_ROW_TAMPERED");
    }
  }

  #completion(value: unknown): CandidateCompletion {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("CANDIDATE_COMPLETION_INVALID");
    const completion = value as CandidateCompletion;
    if (!UUID_PATTERN.test(completion.id) || !HASH_PATTERN.test(completion.previewDigest)
      || completion.mergeDecision !== "owner-required"
      || completion.next !== "Ask the owner whether to merge this candidate into main"
      || typeof completion.prompt !== "string" || completion.prompt.length > 20_000
      || typeof completion.summary !== "string" || completion.summary.length > 4_000
      || !Number.isFinite(Date.parse(completion.createdAt))
      || typeof completion.preview !== "object" || completion.preview === null
      || sha(JSON.stringify(completion.preview)) !== completion.previewDigest) {
      throw new Error("CANDIDATE_COMPLETION_INVALID");
    }
    assertPreviewShape(completion.preview);
    return completion;
  }

  #public(row: CandidateRow): CandidateTask {
    this.#assertRow(row);
    return {
      taskId: row.task_id,
      candidateId: row.candidate_id,
      roomId: row.room_id,
      mainPath: row.main_path,
      mainBranch: row.main_branch,
      baseMainHead: row.base_main_head,
      candidatePath: row.candidate_path,
      candidateBranch: row.candidate_branch,
      task: row.task_text,
      ...(row.acceptance_criteria ? { acceptanceCriteria: row.acceptance_criteria } : {}),
      status: row.status,
      baseline: validateBaseline(JSON.parse(row.baseline_json) as unknown),
      ...(row.completion_json ? { completion: this.#completion(JSON.parse(row.completion_json) as unknown) } : {}),
      createdAt: new Date(row.created_at_ms).toISOString(),
      updatedAt: new Date(row.updated_at_ms).toISOString(),
      ...(row.completed_at_ms === null ? {} : { completedAt: new Date(row.completed_at_ms).toISOString() }),
    };
  }

  #publicCheckpoint(row: CheckpointRow): CandidateCheckpoint {
    this.#assertCheckpoint(row);
    return {
      id: row.id, taskId: row.task_id, candidateHead: row.candidate_head,
      recoveryRef: row.recovery_ref,
      summary: row.summary, createdAt: new Date(row.created_at_ms).toISOString(),
    };
  }

  #checkpoints(taskId: string): CandidateCheckpoint[] {
    const rows = this.#db.prepare(
      "SELECT * FROM candidate_checkpoints WHERE task_id=? ORDER BY created_at_ms,id",
    ).all(taskId) as unknown as CheckpointRow[];
    return rows.map((row) => this.#publicCheckpoint(row));
  }

  #verify(): void {
    for (const row of this.#db.prepare("SELECT * FROM candidates").all() as unknown as CandidateRow[]) this.#assertRow(row);
    for (const row of this.#db.prepare("SELECT * FROM candidate_checkpoints").all() as unknown as CheckpointRow[]) {
      this.#assertCheckpoint(row);
      if (!this.#rowByTask(row.task_id)) throw new Error("CANDIDATE_CHECKPOINT_PARENT_MISSING");
    }
    // candidate_merge_approvals is deliberately NOT verified here either, for the same reason and
    // with no loss of strictness: every read of an approval verifies its row hash and re-derives its
    // preview digest, so a tampered approval can never be listed, granted or consumed. Failing the
    // constructor instead would put the candidates, checkpoints and recovery refs the owner needs in
    // order to recover out of reach because one approval row was edited.
    // candidate_requests is deliberately NOT verified here. It is an advisory retry ledger, while
    // candidates and candidate_checkpoints are the authoritative record. Failing the constructor on
    // one unreadable retry row would make the durable candidate data unreachable — the opposite of
    // what this table exists for. Each row is validated by #assertRequestRow when it is read, so a
    // corrupt row poisons only its own idempotency key.
    // candidate_merge_promotions is deliberately NOT verified here for the same reason, and the
    // reason is sharper for this table than for any other: it is the record of what happened to the
    // owner's project. Refusing to open the registry because one promotion row was edited would take
    // away the only account of a merge at exactly the moment someone needs to read it. Each row is
    // verified when it is read and an unreadable one is REPORTED as unreadable rather than skipped.
  }

  /**
   * The candidate a merge approval could be raised against, or a refusal saying exactly why not.
   *
   * A completed candidate whose worktree has moved past its own completion is refused rather than
   * re-previewed at the new head: the completion's recovery ref names the completed head, so merging
   * a later one would be a merge with no verified recovery point behind it.
   */
  async #mergeScope(taskIdValue: unknown, roomIdValue: string, mainPathValue: string): Promise<{
    task: CandidateTask;
    completion: CandidateCompletion;
    candidateWorkspace: string;
    candidateHead: string;
    recoveryRef: string;
    mainBranch: string;
  }> {
    const roomId = text(roomIdValue, "CANDIDATE_ROOM_INVALID", 48);
    if (!ROOM_PATTERN.test(roomId)) throw new Error("CANDIDATE_ROOM_INVALID");
    if (typeof taskIdValue !== "string" || !UUID_PATTERN.test(taskIdValue)) throw new Error("MAIN_MERGE_TASK_NOT_FOUND");
    const mainPath = await canonicalWorkspace(mainPathValue);
    const row = this.#rowByTask(taskIdValue);
    if (!row) throw new Error("MAIN_MERGE_TASK_NOT_FOUND");
    this.#assertRow(row);
    if (row.room_id !== roomId || row.main_path !== mainPath) throw new Error("MAIN_MERGE_TASK_NOT_FOUND");
    const task = this.#public(row);
    const completion = task.completion;
    // A candidate that has already been merged is terminal, and saying so by name matters: if the
    // owner reverted that merge afterwards, a second promotion would silently re-apply exactly the
    // change they deliberately took back.
    if (task.status === "merged") throw new Error("MAIN_MERGE_CANDIDATE_ALREADY_MERGED");
    if (task.status !== "completed" || !completion) throw new Error("MAIN_MERGE_CANDIDATE_NOT_COMPLETED");
    const candidate = await this.#worktrees.inspectCandidate(task.candidateId);
    if (candidate.workspace !== task.candidatePath || candidate.sourceWorkspace !== task.mainPath
      || candidate.branch !== task.candidateBranch) throw new Error("CANDIDATE_WORKTREE_SCOPE_MISMATCH");
    if (candidate.headSha !== completion.preview.candidateHead) throw new Error("MAIN_MERGE_CANDIDATE_HEAD_CHANGED");
    if (!(await this.#git.inspect(candidate.workspace)).clean) throw new Error("MAIN_MERGE_CANDIDATE_WORKTREE_DIRTY");
    const recoveryRef = completion.preview.recovery.ref;
    if (!await this.#checkpointRefMatches(task.mainPath, recoveryRef, candidate.headSha)) {
      throw new Error("MAIN_MERGE_RECOVERY_POINT_MISSING");
    }
    return {
      task,
      completion,
      candidateWorkspace: candidate.workspace,
      candidateHead: candidate.headSha,
      recoveryRef,
      mainBranch: await this.#mainBranch(task.mainPath),
    };
  }

  /**
   * Re-checks every bound value against live state and separates two answers that must never be
   * conflated: values that were read and moved, and values that could not be read at all.
   *
   * The distinction is the whole point. "The repository was momentarily unreadable" is not evidence
   * that anything moved, and treating it as drift makes the approval terminally `invalidated` with
   * its token cleared — a state nothing can undo once the volume remounts or the permission bit comes
   * back. So every probe here is attempted individually and its failure is recorded against the
   * specific field it would have compared, rather than one `catch` collapsing a whole group into
   * "changed". A value only reaches `changed` when the comparison actually ran.
   *
   * It collects rather than short-circuits, so a refusal can say "mainHead, mainBranch" instead of
   * only the first thing it noticed. Identity is checked before anything is spawned, because once the
   * task, room or paths have moved there is nothing meaningful left to compare.
   */
  async #verifyMergeBinding(
    row: MergeApprovalRow, options: { throttle: boolean } = { throttle: false },
  ): Promise<MergeBindingVerification> {
    const candidateRow = this.#rowByTask(row.task_id);
    if (!candidateRow) return { changed: ["taskId"], unverified: [] };
    this.#assertRow(candidateRow);
    const task = this.#public(candidateRow);
    const identity: string[] = [];
    if (task.roomId !== row.room_id) identity.push("roomId");
    if (task.mainPath !== row.main_path) identity.push("mainPath");
    if (task.candidatePath !== row.candidate_path) identity.push("candidatePath");
    if (task.baseMainHead !== row.base_main_head) identity.push("baseMainHead");
    if (task.status !== "completed") identity.push("candidateStatus");
    if (task.completion?.id !== row.completion_id) identity.push("completionId");
    if (identity.length > 0) return { changed: identity, unverified: [] };
    const changed: string[] = [];
    const unverified: string[] = [];
    let candidateWorkspace: string | undefined;
    let candidate: CandidateWorktree | undefined;
    try {
      candidate = await this.#worktrees.inspectCandidate(task.candidateId);
    } catch {
      // The candidate could not be inspected: its directory is gone, an external volume dropped, git
      // failed to spawn. None of that says the worktree changed, and an absent candidate cannot be
      // merged either way — consume re-runs this check and refuses. So it is reported as unread.
      unverified.push("candidateWorktree", "candidateHead", "candidateWorktreeClean");
    }
    if (candidate) {
      const scoped = candidate.workspace === task.candidatePath
        && candidate.sourceWorkspace === task.mainPath && candidate.branch === task.candidateBranch;
      if (!scoped) changed.push("candidateWorktree");
      if (candidate.headSha !== row.candidate_head) changed.push("candidateHead");
      candidateWorkspace = candidate.workspace;
      try {
        if (!(await this.#git.inspect(candidate.workspace)).clean) changed.push("candidateWorktreeClean");
      } catch { unverified.push("candidateWorktreeClean"); }
    }
    try {
      const mainBranch = await this.#mainBranch(task.mainPath);
      if (mainBranch !== row.main_branch) changed.push("mainBranch");
    } catch (error) {
      // `CANDIDATE_MAIN_BRANCH_REQUIRED` is git answering successfully that main is on no branch at
      // all — a detached HEAD is a real difference from the branch name the owner approved against.
      // Anything else is a failed read.
      if (error instanceof Error && error.message === "CANDIDATE_MAIN_BRANCH_REQUIRED") changed.push("mainBranch");
      else unverified.push("mainBranch");
    }
    try {
      const mainHead = await this.#git.headSha(task.mainPath);
      if (mainHead !== row.main_head) changed.push("mainHead");
    } catch { unverified.push("mainHead"); }
    try {
      const mainFingerprint = (await this.#git.inspect(task.mainPath)).fingerprint;
      if (mainFingerprint !== row.main_fingerprint) changed.push("mainDirtyFingerprint");
    } catch { unverified.push("mainDirtyFingerprint"); }
    try {
      const mainIgnored = (await this.#ignoredInventory(task.mainPath)).fingerprint;
      if (mainIgnored !== row.main_ignored_fingerprint) changed.push("mainIgnoredFingerprint");
    } catch { unverified.push("mainIgnoredFingerprint"); }
    try {
      if (await this.#checkpointRefState(task.mainPath, row.recovery_ref, row.candidate_head) === "differs") {
        changed.push("recoveryRef");
      }
    } catch { unverified.push("recoveryRef"); }
    // A snapshot recomputed from values that could not all be read is not a comparison, so the digest
    // step is skipped whenever anything above is unknown. Skipped is reported as unread, not as equal.
    if (changed.length > 0 || unverified.length > 0) return { changed, unverified };
    if (candidateWorkspace === undefined) return { changed, unverified: ["previewDigest"] };
    // Only now is recomputing the whole snapshot meaningful — and it is still done, because the
    // scalar checks above are a summary and the digest is the thing the owner actually approved.
    //
    // On an observation path the last recomputation is reused for a few seconds. What that reuse is
    // and is not covered by, precisely: both heads, both working-tree fingerprints, the ignored
    // inventory, the branch and the recovery ref have already been compared against live state on
    // this very pass, unthrottled, immediately above — so a throttled digest cannot hide a change in
    // any of them. It CAN hide, for up to the throttle window, a change to the two values that live
    // only inside `preview.promotion`: the hook environment and the ignored-content fingerprint.
    // Those are not left to this path. `#authorizeMainMerge` re-reads both from live main and
    // compares them by name immediately before the approval is spent, unthrottled, which is the
    // comparison that actually gates the write; this one only decides what a read surface displays.
    // The cache is keyed on the approval's own row hash, so any change to the approval discards it.
    const memo = options.throttle ? this.#previewMemo.get(row.id) : undefined;
    if (memo && memo.rowHash === row.row_hash && this.#now() - memo.at < MERGE_PREVIEW_RECOMPUTE_THROTTLE_MS) {
      if (memo.digest !== undefined) {
        if (memo.digest !== row.preview_digest) changed.push("previewDigest");
        return { changed, unverified };
      }
      return {
        changed,
        unverified: [...unverified, "previewDigest"],
        ...(memo.failure === undefined ? {} : { unavailable: memo.failure }),
      };
    }
    try {
      const { previewDigest } = await this.#previewSnapshot({
        task,
        candidateWorkspace,
        candidateHead: row.candidate_head,
        recoveryRef: row.recovery_ref,
        tests: task.completion?.preview.tests ?? [],
        knownRisks: task.completion?.preview.knownRisks ?? [],
      });
      this.#rememberPreview(row, { digest: previewDigest });
      if (previewDigest !== row.preview_digest) changed.push("previewDigest");
    } catch (error) {
      // Recomputing the preview streams every changed file and simulates the merge. On a large or
      // dirty repository it is also the step most likely to hit the 30s command deadline, which is
      // precisely why its failure may not be allowed to read as "the digest moved" — and why the
      // deadline is reported as a deadline instead of as an anonymous failure. An owner told only
      // "the check failed" cannot tell a repository that is too big from one that is corrupt.
      const failure = error instanceof Error && error.message === MERGE_PREVIEW_DEADLINE_CODE
        ? MERGE_PREVIEW_DEADLINE_CODE
        : undefined;
      this.#rememberPreview(row, failure === undefined ? {} : { failure });
      unverified.push("previewDigest");
      return failure === undefined
        ? { changed, unverified }
        : { changed, unverified, unavailable: failure };
    }
    return { changed, unverified };
  }

  /** Bounded memo of the last preview recomputation, so observation cannot become a treadmill. */
  #rememberPreview(row: MergeApprovalRow, outcome: { digest?: string; failure?: string }): void {
    if (this.#previewMemo.size >= MAX_LIST) this.#previewMemo.clear();
    this.#previewMemo.set(row.id, { rowHash: row.row_hash, at: this.#now(), ...outcome });
  }

  /**
   * Looks in LIVE main for files that are not tracked there but sit at paths this merge will write.
   *
   * The path list comes from the approved preview, which is already bound to the approval and
   * already refused when truncated, so a complete answer here is only possible for a snapshot the
   * owner could see in full. Deletions are excluded: a path the merge removes cannot clobber
   * anything at that path.
   */
  /**
   * The gates that describe LIVE main, recomputed at every decision point and never digested.
   *
   * They are separate from the approval's bound values on purpose: `.git/index.lock` and a merge
   * some other process left behind are conditions of this instant, and a promotion must refuse for
   * them without destroying the owner's decision, which is precisely what folding them into the
   * preview digest would do.
   */
  async #liveGates(mainPath: string, preview: CandidateCompletionPreview): Promise<{
    blockers: string[];
    overwrite: OverwriteScan;
    hooks: PromotionFacts["hooks"];
  }> {
    const overwrite = await this.#overwriteScan(mainPath, preview);
    try {
      const restore = await this.#git.restorePoint(mainPath);
      return { blockers: promotionBlockers(restore, overwrite), overwrite, hooks: restore.hooks };
    } catch {
      // Unread is a closed gate, never an open one.
      //
      // The previous comment here said this branch could not be reached, because `#previewSnapshot`
      // reads the restore point earlier and throws first. That is true of a PERSISTENT failure and
      // false of the interesting one: `previewMainMerge` reads the restore point for one `mainPath`
      // TWICE, and a failure that arrives between the two — an external disk blinking out, a
      // permission bit changed for a moment, a deadline hit on a large repository — reaches exactly
      // here. Measured with an injected broker that fails only the second read: the call returned
      // `["MAIN_WORKING_TREE_UNREADABLE"]`, from this line.
      //
      // What has NOT changed is the answer: the overwrite scan's own `unavailable` is still not
      // carried up beside it. One blocker is enough to refuse, a second would say nothing the first
      // does not, and the decision is recorded here so the next reader does not have to rediscover
      // that it was a decision.
      return {
        blockers: ["MAIN_WORKING_TREE_UNREADABLE"],
        overwrite,
        hooks: {
          hooksPath: "", hooks: [], drivers: [], filters: [], programs: [], configDigest: "",
          unreadable: true, fingerprint: "",
        },
      };
    }
  }

  async #overwriteScan(mainPath: string, preview: CandidateCompletionPreview): Promise<OverwriteScan> {
    if (preview.filesTruncated) {
      return { checked: false, ignored: [], untracked: [], unavailable: "OVERWRITE_SCAN_FILE_LIST_TRUNCATED" };
    }
    const paths = [...new Set(preview.files
      .filter((file) => file.operation !== "delete")
      .map((file) => file.path))];
    if (paths.length > MAX_OVERWRITE_SCAN_PATHS) {
      return { checked: false, ignored: [], untracked: [], unavailable: "OVERWRITE_SCAN_PATHSPEC_TOO_LARGE" };
    }
    try {
      const found = await this.#git.untrackedAtPaths(mainPath, paths);
      return {
        checked: true,
        ignored: found.ignored.slice(0, MAX_OVERWRITE_REPORTED_PATHS),
        untracked: found.untracked.slice(0, MAX_OVERWRITE_REPORTED_PATHS),
      };
    } catch {
      // The scan not running is not evidence that nothing would be overwritten.
      return { checked: false, ignored: [], untracked: [], unavailable: "OVERWRITE_SCAN_UNAVAILABLE" };
    }
  }

  /**
   * Refuses anything that would act on a task whose last promotion left main in an unknown state —
   * after looking again, rather than after reading a conclusion somebody wrote once.
   *
   * Re-observing here is what makes the gate an account of the repository instead of a permanent
   * verdict. Two real situations resolve themselves and neither involves this product writing
   * anything: an orphaned merge that outlived the crash and finished, and an owner who read the
   * named differences and put their own repository back. Freezing the first answer turned both into
   * a task that could never be promoted again.
   */
  async #assertNoUnresolvedPromotion(taskId: string, options: { authenticated: boolean }): Promise<void> {
    const rows = this.#db.prepare(
      "SELECT * FROM candidate_merge_promotions WHERE task_id=? AND state IN ('applying','needs-manual-review')",
    ).all(taskId) as unknown as PromotionRow[];
    for (const row of rows) {
      try {
        this.#assertPromotionRow(row);
      } catch {
        // A promotion row that fails its own hash is not evidence that main is fine.
        throw new Error("MAIN_MERGE_PROMOTION_UNRESOLVED");
      }
      // Cheap first, and it is also the commonest answer: a promotion still being written is decided
      // by two `kill(pid, 0)` probes and no Git at all.
      if (this.#promotionPending(row) !== undefined) {
        throw new Error("MAIN_MERGE_PROMOTION_UNRESOLVED");
      }
      // Re-observation streams the whole working tree and can take up to the content-hash deadline.
      // A caller that has not proved it holds the token gets it at most once per throttle window,
      // and a window it is not entitled to fails CLOSED — refusing costs nobody a repository, while
      // an unauthenticated caller able to demand an unbounded number of full-tree hashes is a denial
      // of service against the owner's own machine.
      const last = this.#promotionResolvedAt.get(row.id) ?? 0;
      if (!options.authenticated && this.#now() - last < MERGE_PREVIEW_RECOMPUTE_THROTTLE_MS) {
        throw new Error("MAIN_MERGE_PROMOTION_UNRESOLVED");
      }
      if (this.#promotionResolvedAt.size >= MAX_LIST) this.#promotionResolvedAt.clear();
      this.#promotionResolvedAt.set(row.id, this.#now());
      const resolved = await this.#resolvePromotion(row);
      if (resolved.state === "applying" || resolved.state === "needs-manual-review") {
        throw new Error("MAIN_MERGE_PROMOTION_UNRESOLVED");
      }
    }
  }

  /**
   * Refuses a promotion into a repository another promotion is already applying to.
   *
   * The per-task gate above cannot answer this: two tasks in one project have two approvals and two
   * task ids, and each is perfectly unresolved-free with respect to the other. The exclusive marker
   * is the partial unique index on `main_path`, and this is where that marker is READ, so the owner
   * is told which condition actually stopped them. Without it the second promotion was refused by
   * the dirty-working-tree gate — true only because the first merge had already written something,
   * and therefore not true in the window before it did.
   *
   * Cheap first for the same reason as the per-task gate: a live process is two `kill(pid, 0)`
   * probes, and only a row nobody is driving is worth re-observing.
   */
  async #assertMainNotBusy(
    mainPath: string, taskId: string, options: { authenticated: boolean },
  ): Promise<void> {
    const rows = this.#db.prepare(
      "SELECT * FROM candidate_merge_promotions WHERE main_path=? AND task_id<>? AND state='applying'",
    ).all(mainPath, taskId) as unknown as PromotionRow[];
    for (const row of rows) {
      try {
        this.#assertPromotionRow(row);
      } catch {
        // Its own answer, not the busy one. Both refuse, and that is right — an unreadable row is
        // not evidence that main is fine — but they are different problems with different exits, and
        // collapsing them told every other task in the project "somebody is promoting" while the
        // truth was "one row here cannot be read and nothing you do to promotions will help".
        // Measured: one corrupted `row_hash` refused every other task in the project forever, and
        // the release that could have cleared it answered `MAIN_MERGE_PROMOTION_NOT_FOUND`.
        //
        // The phrase is a constant and goes to everyone, because it is the way out. The pids do not:
        // they are facts about the owner's machine, and a caller that has not proved it holds a
        // token has no claim on them. An owner reading the listing gets them either way.
        const requirement = this.#unreadableRelease(row);
        throw new MergeUnreadablePromotionError(typeof row.id === "string" ? row.id : "", {
          confirmation: requirement.confirmation,
          alive: options.authenticated ? requirement.alive : [],
          recordedGroups: options.authenticated ? requirement.recordedGroups : [],
          // Carried even for an unauthenticated caller: it says whether the empty list above means
          // anything, and withholding it would leave "no pids shown" ambiguous in both directions.
          probeReadable: requirement.probeReadable,
        });
      }
      if (this.#promotionPending(row) !== undefined) {
        throw new Error("MAIN_MERGE_PROMOTION_MAIN_PATH_BUSY");
      }
      const last = this.#promotionResolvedAt.get(row.id) ?? 0;
      if (!options.authenticated && this.#now() - last < MERGE_PREVIEW_RECOMPUTE_THROTTLE_MS) {
        throw new Error("MAIN_MERGE_PROMOTION_MAIN_PATH_BUSY");
      }
      if (this.#promotionResolvedAt.size >= MAX_LIST) this.#promotionResolvedAt.clear();
      this.#promotionResolvedAt.set(row.id, this.#now());
      // A crashed promotion converges here exactly as it does for its own task: re-observed, never
      // retried. Only a row that is STILL applying afterwards holds the marker.
      if ((await this.#resolvePromotion(row)).state === "applying") {
        throw new Error("MAIN_MERGE_PROMOTION_MAIN_PATH_BUSY");
      }
    }
  }

  /**
   * Reads the repository and reports what it finds. It runs no Git command that writes, and it never
   * infers: a value it could not read stays `null`.
   */
  async #observeMain(
    row: PromotionRow,
    conclusion: MergeWriteConclusion,
    attempt?: { exitCode: number; timedOut: boolean },
  ): Promise<{
    observation: MergePromotionObservation;
    state: MergePromotionState;
    headAfter: string | null;
  }> {
    const restore = JSON.parse(row.restore_json) as GitRestorePoint;
    const previous = JSON.parse(row.observation_json) as MergePromotionObservation;
    // Every source, for the same reason `promotionPending` reads every source: this is the other
    // half of the decision that hands the owner a recovery command, and it was reading one. It
    // arrives as a whole conclusion rather than as a trace so that this path cannot be handed a
    // trace-less reading by a caller that has one — the mutation that did exactly that survived a
    // full green run last round (amendment (R)).
    const identity = conclusion.standing.reading.identity;
    // Re-asked on every pass, and a group established to be over is written out as `null` rather
    // than carried into the next record. Carrying it forever is what let a number belonging to a
    // long-dead process — or, after a reboot, to something else entirely — keep answering "the
    // merge is still writing" for the rest of the row's life.
    //
    // Asked even when this process ran the merge itself. `attempt === undefined ? … : "gone"` was an
    // ASSUMPTION that the subprocess this process waited for is the only merge there could be, and
    // the whole subject of amendment (O) is that a conclusion may not come from anywhere but a
    // reading. Where the assumption holds the probe agrees with it and nothing changes.
    const trace = conclusion.trace;
    const group = mergeGroupState(identity);
    const observation: MergePromotionObservation = {
      code: "PROMOTION_OUTCOME_UNDETERMINED",
      mainHead: null,
      authorizedMergeCommit: null,
      mergeInProgress: null,
      worktreeRestored: null,
      stashRestored: null,
      reflogPreserved: null,
      recoveryRefIntact: null,
      ...(attempt === undefined ? {} : { attempt }),
      mergePgid: group === "gone" || group === "none" ? null : identity?.pgid ?? null,
      mergeGroup: group === "gone" || group === "none" ? null : identity,
      ...(group === "merge-done-group-alive" && identity !== null
        ? { mergeGroupSurvivors: { pgid: identity.pgid, inspect: inspectGroupCommand(identity.pgid) } }
        : {}),
      ...(previous.mergeGroupDisowned === undefined
        ? {} : { mergeGroupDisowned: previous.mergeGroupDisowned }),
      // An owner decision is carried into every later record for the same reason the group one is:
      // it is what keeps the row from waiting again on a number the owner already ruled on.
      ...(previous.ownerProcessDisowned === undefined
        ? {} : { ownerProcessDisowned: previous.ownerProcessDisowned }),
      ...(previous.mergeAccountAbandoned === undefined
        ? {} : { mergeAccountAbandoned: previous.mergeAccountAbandoned }),
      ...(previous.ownerBootAtSec === undefined ? {} : { ownerBootAtSec: previous.ownerBootAtSec }),
      // Named rather than left to be inferred from which command `recovery` ended up holding.
      mergeConclusion: conclusion.reason,
      // Amendment (N): the one write that records the merge's group is the only evidence that group
      // exists, and its failure used to leave no trace at all. Named here so a reader can tell
      // "this record never had the number" from "this promotion never spawned git".
      ...(trace.unrecorded === null ? {} : { mergeIdentityUnrecorded: true as const }),
      observedAt: new Date(this.#now()).toISOString(),
    };
    const hooks = await readExecutedHooks(this.#promotionTracePath(row.id));
    if (hooks !== null) observation.hooksExecuted = hooks;
    try {
      observation.mergeInProgress = await this.#git.mergeInProgress(row.main_path);
    } catch { /* stays null: not read is not "no merge in progress" */ }
    try {
      observation.mainHead = await this.#git.headSha(row.main_path);
    } catch { /* stays null */ }
    try {
      observation.recoveryRefIntact =
        await this.#checkpointRefMatches(row.main_path, row.recovery_ref, row.candidate_head);
    } catch { /* stays null */ }
    if (observation.mainHead !== null && observation.mainHead !== row.main_head_before) {
      try {
        const parents = await this.#git.commitParents(row.main_path, observation.mainHead);
        observation.authorizedMergeCommit = parents.length === 2
          && parents[0] === row.main_head_before && parents[1] === row.candidate_head;
      } catch { /* stays null */ }
    }
    // Every aspect in which main now differs from the intent record, by name. This is the whole of
    // what a crashed promotion is allowed to do, and saying "needs manual review" without saying
    // WHICH aspects moved is not an answer the owner can act on.
    try {
      observation.differences = await this.#git.differencesFrom(row.main_path, restore);
    } catch { /* stays undefined: unread is not "no differences" */ }
    if (observation.differences !== undefined) {
      const moved = new Set(observation.differences);
      observation.worktreeRestored = !moved.has("trackedWorkingTree") && !moved.has("index")
        && !moved.has("untrackedFiles") && !moved.has("ignoredFiles");
      observation.stashRestored = !moved.has("stash");
      observation.reflogPreserved = !moved.has("reflog");
    }
    // Three answers, and only two of them are conclusive. Everything that is not one of the two
    // documented shapes is a repository a human has to look at, which is a valid answer — and the
    // one it must give after a kill during a hook, where the index and working tree can be fully
    // rewritten while HEAD has not moved and no MERGE_HEAD exists at all.
    if (observation.mergeInProgress === false && observation.authorizedMergeCommit === true) {
      observation.code = "AUTHORIZED_MERGE_COMMIT_OBSERVED_IN_MAIN";
      return { observation, state: "applied", headAfter: observation.mainHead };
    }
    // "Back where it was" is about the repository's CONTENT and git state: HEAD, the index, tracked,
    // untracked and ignored files, the stash, the reflog and the absence of leftover merge state.
    // `hookEnvironment` is reported alongside them but does not disqualify, and that distinction is
    // load-bearing rather than a convenience. A promotion never writes `.git/hooks`; what a failure
    // leaves is an owner who has to CHANGE the hook — remove the one that hung, fix the one that
    // exited non-zero — before anything can succeed again. Counting that as "main did not come back"
    // meant the only action that makes a retry possible was also the action that permanently sealed
    // the previous attempt as unresolved, which sealed the task with it. What the hook inventory
    // gates is the approval binding, checked live immediately before the merge, not this.
    const blocking = (observation.differences ?? []).filter((name) => name !== "hookEnvironment");
    if (observation.mergeInProgress === false && observation.mainHead === row.main_head_before
      && observation.differences !== undefined && blocking.length === 0) {
      observation.code = "MAIN_OBSERVED_IDENTICAL_TO_PRE_PROMOTION_FINGERPRINTS";
      return { observation, state: "rolled-back", headAfter: null };
    }
    // A fourth shape, measured rather than imagined: a merge orphaned by a crash commits the merge
    // the owner authorized and is then killed before git clears `MERGE_HEAD`/`AUTO_MERGE`. Main
    // carries the authorized commit — `git status --porcelain` is completely empty — while git still
    // considers a merge to be in progress. That is not finished, and it is emphatically not
    // undetermined: saying "undetermined" here is what made the record freeze on an answer that had
    // stopped being true. It is named, it stays gated until the leftovers are gone, and the command
    // offered is a read-only look at the merge rather than anything that would undo it. Clearing the
    // named leftovers is the owner's move; the next observation then reports `applied`.
    if (observation.authorizedMergeCommit === true) {
      observation.code = "AUTHORIZED_MERGE_COMMIT_OBSERVED_WITH_MERGE_STATE_LEFT_BEHIND";
      return { observation, state: "needs-manual-review", headAfter: observation.mainHead };
    }
    observation.code = "PROMOTION_OUTCOME_UNDETERMINED";
    return { observation, state: "needs-manual-review", headAfter: observation.mainHead };
  }

  /**
   * The copy-and-paste command an owner needs, chosen from what was just OBSERVED rather than fixed
   * at the moment the promotion started. It is never executed here.
   *
   * `reset --hard <pre-promotion head>` is correct only while main does not carry the merge. Once an
   * authorized merge commit has been seen at HEAD — which happens when a merge orphaned by a crash
   * runs to completion after this process is gone — that same command silently throws away a merge
   * that really did succeed. So the moment the merge is observed, the offer becomes a read-only look
   * at it, and the record says which of the two it is instead of leaving the owner to read the verb.
   */
  #recoveryHint(
    row: PromotionRow, observation: MergePromotionObservation, conclusion: MergeWriteConclusion,
  ): void {
    if (observation.authorizedMergeCommit === true && observation.mainHead !== null) {
      observation.recovery = `git -C ${row.main_path} show --stat ${observation.mainHead}`;
      observation.recoveryKind = "inspect-observed-merge";
      return;
    }
    // Amendment (O) and (S). This is the function that decides whether the owner is handed
    // `git reset --hard`, and the ninth round's own path inventory left it out — it read ONE field
    // of `observation_json`, so a promotion whose merge no source could account for fell through to
    // the destructive offer by default. The offer now requires the same positive evidence every
    // other exit requires, asked of the row and its outside sources rather than of one field this
    // same observation had just written.
    //
    // Deliberately BEFORE the disowned-group check rather than after it: the two answer different
    // questions ("is a specific number still alive" versus "does anything account for this merge at
    // all"), and a record that cannot answer the second must not be rescued by the first happening
    // to find nothing.
    if (!conclusion.concluded) {
      observation.recovery = searchMergeCommand(row.candidate_head);
      observation.recoveryKind = "search-for-unaccounted-merge";
      return;
    }
    // A promotion the owner disowned while its merge leader was alive is the one shape where this
    // record exists at all and a `git merge` may still be writing the index it describes. Handing
    // over `reset --hard` there is handing over PITFALLS #94: the reset does not undo the write, it
    // races it, and it deletes ignored files the merge overwrote rather than restoring them. Asked
    // again on every read, so once that process really is gone the normal offer comes back.
    const disowned = observation.mergeGroupDisowned;
    if (disowned !== undefined && mergeGroupState({
      pgid: disowned.pgid,
      bootAtSec: disowned.bootAtSec ?? null,
      spawnedAt: disowned.at,
    }) === "merge-running") {
      observation.recovery = inspectGroupCommand(disowned.pgid);
      observation.recoveryKind = "inspect-live-merge";
      return;
    }
    observation.recovery = `git -C ${row.main_path} reset --hard ${row.main_head_before}`;
    observation.recoveryKind = "reset-to-pre-promotion";
  }

  /**
   * Records the outcome of the attempt this process just made.
   *
   * `leaderExitObserved` is this path's own positive evidence and the reason it may conclude at all:
   * `ProcessRunner` does not resolve a terminated child until its whole process group is gone, so a
   * result in hand means this process watched the merge leader close. It is passed as `false` when
   * `mergeIntoHead` THREW, because then nothing was watched — the previous shape wrote a synthetic
   * `{ exitCode: -1 }` and every later reader treated it exactly like an observed exit.
   */
  async #settlePromotion(
    row: PromotionRow,
    attempt: { exitCode: number; timedOut: boolean },
    options: { leaderExitObserved: boolean },
  ): Promise<PromotionRow> {
    const conclusion = this.#promotionConclusion(row, {
      leaderExitObserved: options.leaderExitObserved,
    });
    const observed = await this.#observeMain(row, conclusion, attempt);
    // Amendment (O). A terminal state is a conclusion too — it hands the project's exclusive marker
    // back to every other task — so it needs the same evidence the recovery command needs. `applied`
    // is exempt because an authorized merge commit AT HEAD is itself the observation that the write
    // this record is about completed.
    if (!conclusion.concluded && observed.state !== "applied") {
      observed.observation.code = "MERGE_UNACCOUNTED_FOR_NOTHING_CONCLUDED";
      observed.state = "applying";
      observed.headAfter = null;
    }
    if (observed.state !== "applied") this.#recoveryHint(row, observed.observation, conclusion);
    this.#faultPoint?.("promotion-outcome-write");
    const next = this.#writePromotion(row, {
      state: observed.state,
      main_head_after: observed.headAfter,
      observation_json: JSON.stringify(observed.observation),
      updated_at_ms: Math.max(row.started_at_ms, this.#now()),
    });
    if (observed.state === "applied") this.#markCandidateMerged(row.task_id);
    this.#emitPromotion(next, "settled");
    return next;
  }

  /**
   * Re-observes a promotion nobody is driving, and reports what the repository says NOW.
   *
   * It runs on every read of a non-terminal row, not once. "Needs manual review" used to be written
   * once and never looked at again, which made it a permanent verdict rather than an account: an
   * orphaned merge that finished after the crash, and an owner who put their own repository back
   * after reading the named differences, both left the record frozen on an answer that had stopped
   * being true, with a `reset --hard` still on offer that would have destroyed a merge that
   * succeeded. Re-observing costs only reads, and it is the only thing that can make either of those
   * situations resolve without this product writing to main.
   *
   * Two things stop it. A row whose owner process is still alive is a promotion in flight. And a row
   * whose merge subprocess group still exists is a promotion whose write is still in flight even
   * though the orchestrator that started it is gone — `detached` means killing this process does not
   * kill git, and settling mid-write would record a conclusion about a repository that is still
   * being changed.
   */
  async #resolvePromotion(row: PromotionRow): Promise<PromotionRow> {
    if (row.state === "applied" || row.state === "rolled-back") return row;
    if (this.#promotionPending(row) !== undefined) return row;
    const conclusion = this.#promotionConclusion(row);
    // Strictly read-only. No reset, no checkout, no `merge --abort`, no `clean`, no touching
    // `.git/config` and no removing a lock file: after a kill during a hook the rewritten index is
    // bit-for-bit indistinguishable from work the owner staged themselves, so an automatic rollback
    // here would be this product deleting the owner's work while reporting success.
    const observed = await this.#observeMain(row, conclusion);
    // The approval was spent only if it reached `consumed`. An intent row beside an approval that is
    // still answerable means the crash happened before anything could run, and that is not a state
    // anyone needs to inspect by hand. It is the same reading `promotionPending` above was given, so
    // the gate and the settlement cannot disagree about whether a Git command ever ran.
    const spent = this.#promotionApprovalSpent(row);
    if (!spent && observed.state !== "applied") {
      observed.observation.code = "APPROVAL_NEVER_SPENT_NO_GIT_COMMAND_RAN";
      observed.state = "rolled-back";
      observed.headAfter = null;
    }
    if (observed.state !== "applied") this.#recoveryHint(row, observed.observation, conclusion);
    try {
      const next = this.#writePromotion(row, {
        state: observed.state,
        main_head_after: observed.headAfter,
        observation_json: JSON.stringify(observed.observation),
        updated_at_ms: Math.max(row.started_at_ms, this.#now()),
      });
      if (observed.state === "applied") this.#markCandidateMerged(row.task_id);
      // Only a transition is worth a ledger entry: re-observation runs on every read, and an entry
      // per read would bury the ones that mean something.
      if (next.state !== row.state) this.#emitPromotion(next, "re-observed");
      return next;
    } catch {
      // Another reader observed the same repository at the same instant and wrote first. Its record
      // stands; this reader reports what the store now holds rather than an answer it failed to save.
      const current = this.#promotionRow(row.id);
      return current ?? row;
    }
  }

  /**
   * Writes the merge subprocess group into the intent record, synchronously, at spawn time.
   *
   * A failure here is swallowed rather than aborting the merge: the merge is already running, and
   * refusing to proceed at this point would leave a repository being written by a process nobody is
   * waiting on. Losing the group id degrades this promotion to the previous behaviour — the crash
   * reader falls back to re-observation, which is what actually converges the answer.
   */
  #recordMergePgid(row: PromotionRow, pgid: number): PromotionRow {
    const identity: MergeProcessGroupIdentity = {
      pgid,
      bootAtSec: bootAtSec(),
      spawnedAt: new Date(this.#now()).toISOString(),
    };
    try {
      this.#faultPoint?.("merge-pgid-record");
      const observation = JSON.parse(row.observation_json) as MergePromotionObservation;
      return this.#writePromotion(row, {
        observation_json: JSON.stringify({ ...observation, mergePgid: pgid, mergeGroup: identity }),
        updated_at_ms: Math.max(row.started_at_ms, this.#now()),
      });
    } catch {
      // Amendment (N). The merge is already running, so refusing to proceed here would leave a
      // repository being written by a process nobody is waiting on — the failure still may not abort
      // anything. What it may no longer do is vanish: this is the ONE write that records the number,
      // and losing it silently made "not recorded" and "nothing to record" the same bytes on disk.
      // Measured with nothing forged at all: another process holding the database across this write
      // (the ordinary condition PITFALLS #65 documents) left a perfectly readable row reporting
      // "not blocked on any process" and offering `git reset --hard` while `ps -g` listed the merge.
      //
      // The mark goes to a FILE, because the thing that just failed is writing to this database.
      this.#markMergeIdentityUnrecorded(row.id, identity);
      return row;
    }
  }

  /**
   * Records, outside SQLite, that the write which was carrying this merge's group id did not happen.
   *
   * Best effort by necessity — there is no third place to put it if this fails too — but it fails in
   * the direction that keeps the question open: with neither the row nor this marker, git's own
   * trace still proves a merge was started and the reading stays unanswered.
   */
  #markMergeIdentityUnrecorded(promotionId: string, identity: MergeProcessGroupIdentity): void {
    try {
      mkdirSync(join(this.#dataDirectory, "promotion-traces"), { recursive: true, mode: 0o700 });
      writeFileSync(
        this.#promotionSpawnRecordPath(promotionId),
        JSON.stringify({ pgid: identity.pgid, bootAtSec: identity.bootAtSec, at: identity.spawnedAt }),
        { mode: 0o600 },
      );
    } catch { /* the trace file still says a merge was started; the reading stays unanswered */ }
  }

  #promotionRow(id: string): PromotionRow | undefined {
    const row = this.#db.prepare("SELECT * FROM candidate_merge_promotions WHERE id=?")
      .get(id) as unknown as PromotionRow | undefined;
    if (!row) return undefined;
    try {
      this.#assertPromotionRow(row);
    } catch { return undefined; }
    return row;
  }

  /**
   * Moves the candidate to `merged` once, and only after an authorized merge commit was OBSERVED in
   * main. A failure here does not undo the promotion record: the promotion row is the authoritative
   * account of what happened to the repository, and the candidate status is a summary of it.
   */
  #markCandidateMerged(taskId: string): void {
    try {
      const row = this.#rowByTask(taskId);
      if (!row || row.status === "merged") return;
      this.#assertRow(row);
      const { row_hash: _old, ...bare } = { ...row, status: "merged" as CandidateStatus, updated_at_ms: Math.max(row.updated_at_ms, this.#now()) };
      const next: CandidateRow = { ...bare, row_hash: rowHash(bare) };
      this.#db.exec("BEGIN IMMEDIATE");
      try {
        this.#replace(row, next);
        this.#db.exec("COMMIT");
      } catch (error) {
        this.#db.exec("ROLLBACK");
        throw error;
      }
    } catch { /* the promotion row already records the observed truth about main */ }
  }

  #insertPromotion(row: PromotionRow): void {
    // Columns named explicitly, not positionally: this table gains columns by `ADD COLUMN` on
    // databases written by earlier builds, and a positional INSERT is the statement that silently
    // starts meaning something else when that happens ([[PITFALLS]] #59).
    this.#db.prepare(`INSERT INTO candidate_merge_promotions (
        id,approval_id,task_id,room_id,main_path,main_branch,candidate_head,recovery_ref,
        main_head_before,main_head_after,restore_json,observation_json,state,owner_pid,
        started_at_ms,updated_at_ms,row_hash,merge_pgid,merge_boot_at_sec
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      row.id, row.approval_id, row.task_id, row.room_id, row.main_path, row.main_branch,
      row.candidate_head, row.recovery_ref, row.main_head_before, row.main_head_after,
      row.restore_json, row.observation_json, row.state, row.owner_pid, row.started_at_ms,
      row.updated_at_ms, row.row_hash, row.merge_pgid, row.merge_boot_at_sec,
    );
  }

  /**
   * The only way to UPDATE a promotion, compare-and-set on the previous row hash and state.
   *
   * The merge-group columns are not accepted from the caller: they are DERIVED here from the
   * observation being written. That is deliberately structural rather than a convention every call
   * site has to remember ([[PITFALLS]] #74). The two must agree — the columns exist so the group
   * survives a damaged payload, not so it can be recorded twice with two different answers — and a
   * group written into the columns but not cleared when an observation establishes the merge is over
   * would be the stale-pid defect this project has already had once ([[PITFALLS]] #102).
   */
  #writePromotion(previous: PromotionRow, fields: Partial<PromotionRow>): PromotionRow {
    const merged = { ...previous, ...fields };
    const identity = promotionGroupIdentity(merged);
    const { row_hash: _old, ...bare } = {
      ...merged,
      merge_pgid: identity?.pgid ?? null,
      merge_boot_at_sec: identity?.bootAtSec ?? null,
    };
    const next: PromotionRow = { ...bare, row_hash: mergePromotionHash(bare) };
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.#db.prepare(`UPDATE candidate_merge_promotions
        SET main_head_after=?,observation_json=?,state=?,updated_at_ms=?,row_hash=?,
            merge_pgid=?,merge_boot_at_sec=?
        WHERE id=? AND row_hash=? AND state=?`).run(
        next.main_head_after, next.observation_json, next.state, next.updated_at_ms, next.row_hash,
        next.merge_pgid, next.merge_boot_at_sec,
        next.id, previous.row_hash, previous.state,
      );
      if (Number(result.changes) !== 1) throw new Error("MAIN_MERGE_PROMOTION_CONCURRENT_UPDATE");
      this.#db.exec("COMMIT");
      return next;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  #assertPromotionRow(row: PromotionRow): void {
    const { row_hash: actual, ...bare } = row;
    if (!HASH_PATTERN.test(actual) || mergePromotionHash(bare) !== actual
      || !UUID_PATTERN.test(row.id) || !UUID_PATTERN.test(row.approval_id) || !UUID_PATTERN.test(row.task_id)
      || !ROOM_PATTERN.test(row.room_id) || !isAbsolute(row.main_path)
      || !HEAD_PATTERN.test(row.candidate_head) || !HEAD_PATTERN.test(row.main_head_before)
      || (row.main_head_after !== null && !HEAD_PATTERN.test(row.main_head_after))
      || !CHECKPOINT_REF_PATTERN.test(row.recovery_ref)
      || row.main_branch.length < 1 || row.main_branch.length > 255
      || !Number.isSafeInteger(row.owner_pid) || row.owner_pid <= 0
      || (row.merge_pgid !== null && !Number.isSafeInteger(row.merge_pgid))
      || (row.merge_boot_at_sec !== null && !Number.isSafeInteger(row.merge_boot_at_sec))
      || row.updated_at_ms < row.started_at_ms) {
      throw new Error("MAIN_MERGE_PROMOTION_ROW_TAMPERED");
    }
    JSON.parse(row.restore_json);
    JSON.parse(row.observation_json);
    // The two columns are one fact written together: every write that sets either sets both, and a
    // row written before they existed carries NULL in BOTH. Half of the pair is therefore damage in
    // either direction, and this is the half of the bidirectional check that CAN be made without
    // mistaking an upgrade for tampering.
    if ((row.merge_pgid === null) !== (row.merge_boot_at_sec === null)) {
      throw new Error("MAIN_MERGE_PROMOTION_ROW_TAMPERED");
    }
    // The column and the observation are one fact written twice, so disagreement is damage. Only
    // this direction can be an error: a row written before these columns existed carries the group
    // solely in `observation_json`, and a null column beside a payload that names a group is an
    // upgrade, not tampering (bar item 11). The MIRROR of it — a null column, a payload that names
    // nothing, and a merge that some source outside the row can still see — is the shape this check
    // cannot name and `durableMergeIdentity` refuses instead, because the record and the upgrade
    // look identical here and only a probe tells them apart.
    if (row.merge_pgid !== null && promotionPgid(row) !== row.merge_pgid) {
      throw new Error("MAIN_MERGE_PROMOTION_ROW_TAMPERED");
    }
  }

  #publicPromotion(row: PromotionRow): MergePromotion {
    const pending = this.#promotionPending(row);
    return {
      id: row.id,
      approvalId: row.approval_id,
      taskId: row.task_id,
      roomId: row.room_id,
      mainPath: row.main_path,
      mainBranch: row.main_branch,
      candidateHead: row.candidate_head,
      recoveryRef: row.recovery_ref,
      mainHeadBefore: row.main_head_before,
      ...(row.main_head_after === null ? {} : { mainHeadAfter: row.main_head_after }),
      state: row.state,
      observation: JSON.parse(row.observation_json) as MergePromotionObservation,
      ownerAlive: row.state === "applying" ? ownerProcessAlive(row) : null,
      // Derived on every read, not stored: it is a statement about processes that are alive right
      // now, and a stored copy of it would be out of date the moment it was written.
      ...(pending === undefined ? {} : { pending }),
      startedAt: new Date(row.started_at_ms).toISOString(),
      updatedAt: new Date(row.updated_at_ms).toISOString(),
    };
  }

  /**
   * Where git writes the trace stream for one promotion. Inside the owner-only data directory and
   * never inside main: a file written into the repository would become an untracked file and change
   * the very fingerprints the promotion is about to compare against.
   */
  #promotionTracePath(promotionId: string): string {
    return join(this.#dataDirectory, "promotion-traces", `${promotionId}.jsonl`);
  }

  /**
   * Where the failure of the one write that records a merge's process group is marked.
   *
   * Beside the trace, which is the same directory `GIT_TRACE2_EVENT` points into — and that
   * variable IS handed to every hook. This path is therefore derivable by one line of shell inside
   * any hook the promotion runs, and the previous comment here claimed the opposite.
   *
   * It is not hidden and nothing about this location is a boundary ([[PITFALLS]] #120: hiding is not
   * a boundary, and the round that tried it was the round that got walked through). What makes the
   * marker safe to read is amendment (O): neither its presence nor its absence can move any
   * decision towards a conclusion, so an attacker who can write it, delete it, or replace its
   * contents gains nothing but a record that refuses to conclude.
   */
  #promotionSpawnRecordPath(promotionId: string): string {
    return join(this.#dataDirectory, "promotion-traces", `${promotionId}.spawn-record.json`);
  }

  /**
   * What git's own trace says about this row's merge — the one source of that fact that is not in
   * the database.
   *
   * Read from the row's `id` column, which is a plain TEXT column an unreadable payload does not
   * touch. An id that is not a string names no file and this answers nothing, which is the correct
   * answer for a row that damaged even that.
   */
  /**
   * Whether this promotion's approval was ever spent — the one positive fact that says a Git command
   * capable of writing main was invoked at all.
   *
   * Amendment (O) and (Q). Every other source that could answer "did a merge start" lives in a file
   * beside the trace whose path this product hands to every hook it runs; this one lives in the
   * hash-chained database, and the merge cannot reach past the chain to change it. The ordering in
   * `promoteMainMerge` is what makes it evidence: the approval is committed as `consumed` BEFORE
   * `mergeIntoHead` is called, so an approval that is not consumed means no merge was ever spawned.
   *
   * Every failure answers `true`, which is the direction that keeps the question open: a missing
   * approval row, an id that is not a string, and a row whose own integrity check fails all mean
   * "this cannot be used to prove nothing ran".
   */
  #promotionApprovalSpent(row: PromotionRow): boolean {
    const id = row.approval_id;
    if (typeof id !== "string" || !UUID_PATTERN.test(id)) return true;
    const approval = this.#mergeApprovalRow(id);
    if (approval === undefined) return true;
    try {
      this.#assertMergeApprovalRow(approval);
    } catch { return true; }
    return approval.state === "consumed";
  }

  /** `promotionPending` with this row's own two outside inputs supplied, so no caller can omit one. */
  #promotionPending(row: PromotionRow): MergePromotionPending | undefined {
    return promotionPending(row, this.#promotionTrace(row), {
      approvalSpent: this.#promotionApprovalSpent(row),
    });
  }

  /** The same, for the four paths that answer about a row whose integrity check FAILED. */
  #unreadableRelease(row: PromotionRow): ReturnType<typeof unreadableReleaseRequirement> {
    return unreadableReleaseRequirement(row, this.#promotionTrace(row), {
      approvalSpent: this.#promotionApprovalSpent(row),
    });
  }

  #unreadableView(row: PromotionRow): UnreadableMergePromotion {
    return unreadablePromotionView(row, this.#promotionTrace(row), {
      approvalSpent: this.#promotionApprovalSpent(row),
    });
  }

  /** Everything a path needs to decide whether this promotion may be concluded about. */
  #promotionConclusion(
    row: PromotionRow, options: { leaderExitObserved?: boolean } = {},
  ): MergeWriteConclusion {
    return mergeWriteConclusion(row, this.#promotionTrace(row), {
      approvalSpent: this.#promotionApprovalSpent(row),
      recordTrusted: true,
      ...(options.leaderExitObserved === undefined
        ? {} : { leaderExitObserved: options.leaderExitObserved }),
    });
  }

  #promotionTrace(row: PromotionRow): TraceMergeReading {
    if (typeof row.id !== "string" || !UUID_PATTERN.test(row.id)) return NO_TRACE_READING;
    const traced = traceMergeIdentity(this.#promotionTracePath(row.id));
    const unrecorded = unrecordedMergeIdentity(this.#promotionSpawnRecordPath(row.id));
    if (unrecorded === null) return traced;
    return {
      spawned: true,
      identity: traced.identity,
      unrecorded,
    };
  }

  /**
   * The owner's way out of a promotion that is blocked on a process group, without this product
   * killing anything or touching main.
   *
   * It does not settle the promotion and it does not decide what happened. All it does is stop the
   * record from waiting on one specific pid, after the owner has named that exact pid — proof they
   * read the record rather than clicked past it. The next read then re-observes the repository and
   * reaches whichever of the three answers the fingerprints support, which for a merge that really
   * was interrupted will be `needs-manual-review` with every difference listed by name.
   *
   * A leader that is still answering "alive" is refused on the first attempt and requires
   * `MERGE_LIVE_ABANDON_CONFIRMATION` on the second, and for as long as that process lives the
   * record offers only a read-only look at it — never `reset --hard` over a tree git may be writing.
   *
   * Two states are handled here rather than elsewhere because they arrive at this same door: a row
   * this release cannot READ (which used to answer `MAIN_MERGE_PROMOTION_NOT_FOUND` and leave the
   * whole project blocked), and a row whose owner process is alive TOO (which used to answer
   * `MAIN_MERGE_PROMOTION_STILL_OWNED` and point at a release that refused right back).
   */
  async abandonMergeProcessGroup(input: {
    promotionId: string;
    roomId: string;
    mainPath: string;
    /** The pgid exactly as the record reports it. A mismatch refuses rather than guessing. */
    pgid: number;
    /**
     * `MERGE_GROUP_ABANDON_CONFIRMATION`, or `MERGE_LIVE_ABANDON_CONFIRMATION` when the record
     * reports `MERGE_SUBPROCESS_STILL_RUNNING`. The record names which one applies in
     * `pending.release`.
     */
    confirmation: string;
    decidedBy: string;
  }): Promise<MergePromotion | UnreadableMergePromotion> {
    this.#assertOpen();
    if (typeof input.promotionId !== "string" || !UUID_PATTERN.test(input.promotionId)) {
      throw new Error("MAIN_MERGE_PROMOTION_ID_INVALID");
    }
    const roomId = text(input.roomId, "CANDIDATE_ROOM_INVALID", 48);
    if (!ROOM_PATTERN.test(roomId)) throw new Error("CANDIDATE_ROOM_INVALID");
    const mainPath = await canonicalWorkspace(input.mainPath);
    const decidedBy = text(input.decidedBy, "MERGE_GROUP_ABANDON_DECIDED_BY_INVALID", 64);
    // Read WITHOUT the integrity check first. `#promotionRow` drops an unreadable row, and dropping
    // it here is what made one corrupted row retire a whole project: the row still held the
    // exclusive marker, and the only action that could have freed it answered "not found".
    const raw = this.#promotionRowRaw(input.promotionId);
    if (!raw || raw.room_id !== roomId || raw.main_path !== mainPath) {
      throw new Error("MAIN_MERGE_PROMOTION_NOT_FOUND");
    }
    if (!this.#promotionRowReadable(raw)) {
      return this.#releaseUnreadablePromotion(raw, input.confirmation, decidedBy, input.pgid);
    }
    const row = raw;
    if (row.state === "applied" || row.state === "rolled-back") {
      throw new Error("MAIN_MERGE_PROMOTION_ALREADY_SETTLED");
    }
    // Only a group that is actually the reason may be abandoned. An owner process that is still
    // alive is a promotion in flight in another window, and disowning its merge would let two
    // readers describe one repository.
    const pending = this.#promotionPending(row);
    if (pending === undefined) throw new Error("MAIN_MERGE_PROMOTION_NOT_BLOCKED");
    if (pending.code === "PROMOTION_OWNER_AND_MERGE_STILL_RUNNING") {
      throw new MergePromotionDoublyBlockedError(
        pending.pid, pending.alsoBlockedBy?.pid ?? 0,
        [pending.inspect, ...(pending.alsoBlockedBy === undefined ? [] : [pending.alsoBlockedBy.inspect])],
      );
    }
    if (pending.code === "OWNER_PROCESS_STILL_RUNNING") throw new Error("MAIN_MERGE_PROMOTION_STILL_OWNED");
    // Amendment (O), the exit from the state that has no number. Every branch below asks the owner
    // to quote the pid the record reports, which is what proves they read it; here the record
    // reports none, because "nothing accounts for this merge" is precisely the state. So the phrase
    // carries the whole weight — and it is a different phrase, which says what it is abandoning
    // rather than which record is being edited. Without this the wait would be a dead end with no
    // product-side exit, and a fail-closed dead end is still the state bar item 11 forbids.
    if (pending.code === "MERGE_IDENTITY_UNACCOUNTED") {
      if (input.confirmation !== MERGE_UNACCOUNTED_ABANDON_CONFIRMATION) {
        throw new Error("MERGE_GROUP_ABANDON_CONFIRMATION_MISMATCH");
      }
      const at = new Date(this.#now()).toISOString();
      const abandoned = {
        ...JSON.parse(row.observation_json) as MergePromotionObservation,
        mergeAccountAbandoned: { at, decidedBy },
      } satisfies MergePromotionObservation;
      const released = this.#writePromotion(row, {
        observation_json: JSON.stringify(abandoned),
        updated_at_ms: Math.max(row.started_at_ms, this.#now()),
      });
      this.#emitPromotion(released, "merge-group-abandoned", {
        // Null rather than a placeholder: the trail must not name a number nobody read.
        pgid: null,
        unaccounted: true,
        decidedBy,
        mainMutation: false,
      });
      return this.#publicPromotion(await this.#resolvePromotion(released));
    }
    // Two stages, because the two states are not the same risk. A group nobody can decide about is
    // released with the ordinary phrase; a group whose LEADER answers "alive" is a `git merge` that
    // `ps` can still show writing to the owner's project, and the first attempt at it is refused by
    // name so that the owner has to say what they are actually abandoning. Measured before this
    // existed: the ordinary phrase disowned a provably live merge and the record immediately offered
    // `git reset --hard` over the tree that merge was writing.
    const running = pending.code === "MERGE_SUBPROCESS_STILL_RUNNING";
    const required = running ? MERGE_LIVE_ABANDON_CONFIRMATION : MERGE_GROUP_ABANDON_CONFIRMATION;
    if (running && input.confirmation === MERGE_GROUP_ABANDON_CONFIRMATION) {
      throw new MergeAbandonStillRunningError(pending.pid, pending.inspect, required);
    }
    if (input.confirmation !== required) throw new Error("MERGE_GROUP_ABANDON_CONFIRMATION_MISMATCH");
    if (!Number.isSafeInteger(input.pgid) || input.pgid !== pending.pid) {
      throw new Error("MERGE_GROUP_ABANDON_PGID_MISMATCH");
    }
    const observation = JSON.parse(row.observation_json) as MergePromotionObservation;
    const disowned = {
      ...observation,
      mergePgid: null,
      mergeGroup: null,
      mergeGroupDisowned: {
        pgid: input.pgid,
        at: new Date(this.#now()).toISOString(),
        decidedBy,
        // Kept so the number stays identifiable after it stops being waited on: the recovery hint
        // asks this same question again on every read, and a bare pid could not be asked safely.
        bootAtSec: bootAtSec(),
        whileRunning: running,
      },
    } satisfies MergePromotionObservation;
    const updated = this.#writePromotion(row, {
      observation_json: JSON.stringify(disowned),
      updated_at_ms: Math.max(row.started_at_ms, this.#now()),
    });
    this.#emitPromotion(updated, "merge-group-abandoned", {
      pgid: input.pgid,
      decidedBy,
      whileRunning: running,
      mainMutation: false,
    });
    return this.#publicPromotion(await this.#resolvePromotion(updated));
  }

  /**
   * The owner's way out of a promotion that is waiting on the process which STARTED it.
   *
   * Symmetric with `abandonMergeProcessGroup`, and it exists for the symmetric reason: `owner_pid`
   * is a number the operating system reuses. Scoping it to a boot removes the cross-reboot case, and
   * classifying `EPERM` as "somebody else's" removes the other-user case, but WITHIN one boot the
   * same user's next process can hold that number and no probe can tell. Without this the row waits
   * forever, every later approval for that task is refused as unresolved, and the task is retired
   * with nothing on the product side able to clear it.
   *
   * It kills nothing and it does not touch main. What it refuses to do is release the wait while the
   * merge subprocess is also in the way: that would be disowning the caller and the writer at once,
   * and the record would then describe a repository something is still writing. That refusal used to
   * be a wall — the merge release refused on the owner and this one refused on the merge — so it now
   * hands back `abandonPromotionEntirely`'s phrase and both pids instead.
   */
  async abandonPromotionOwnerProcess(input: {
    promotionId: string;
    roomId: string;
    mainPath: string;
    /** The owner pid exactly as the record reports it. A mismatch refuses rather than guessing. */
    pid: number;
    confirmation: string;
    decidedBy: string;
  }): Promise<MergePromotion> {
    this.#assertOpen();
    if (typeof input.promotionId !== "string" || !UUID_PATTERN.test(input.promotionId)) {
      throw new Error("MAIN_MERGE_PROMOTION_ID_INVALID");
    }
    const roomId = text(input.roomId, "CANDIDATE_ROOM_INVALID", 48);
    if (!ROOM_PATTERN.test(roomId)) throw new Error("CANDIDATE_ROOM_INVALID");
    const mainPath = await canonicalWorkspace(input.mainPath);
    if (input.confirmation !== MERGE_OWNER_ABANDON_CONFIRMATION) {
      throw new Error("MERGE_OWNER_ABANDON_CONFIRMATION_MISMATCH");
    }
    const decidedBy = text(input.decidedBy, "MERGE_GROUP_ABANDON_DECIDED_BY_INVALID", 64);
    const row = this.#promotionRow(input.promotionId);
    if (!row || row.room_id !== roomId || row.main_path !== mainPath) {
      throw new Error("MAIN_MERGE_PROMOTION_NOT_FOUND");
    }
    if (row.state === "applied" || row.state === "rolled-back") {
      throw new Error("MAIN_MERGE_PROMOTION_ALREADY_SETTLED");
    }
    const pending = this.#promotionPending(row);
    // The combined state is refused HERE too, and with the route rather than a wall. Falling through
    // to the merge-still-running refusal below would be the same answer the cycle used to give.
    if (pending?.code === "PROMOTION_OWNER_AND_MERGE_STILL_RUNNING") {
      throw new MergePromotionDoublyBlockedError(
        pending.pid, pending.alsoBlockedBy?.pid ?? 0,
        [pending.inspect, ...(pending.alsoBlockedBy === undefined ? [] : [pending.alsoBlockedBy.inspect])],
      );
    }
    if (pending === undefined || pending.code !== "OWNER_PROCESS_STILL_RUNNING") {
      throw new Error("MAIN_MERGE_PROMOTION_NOT_OWNER_BLOCKED");
    }
    if (!Number.isSafeInteger(input.pid) || input.pid !== pending.pid) {
      throw new Error("MERGE_OWNER_ABANDON_PID_MISMATCH");
    }
    // No separate "is the merge alive?" check here: reaching `OWNER_PROCESS_STILL_RUNNING` at all
    // now MEANS the merge group is not in the way, because `promotionPending` reports the two-alive
    // case as its own state and it is refused above with the phrase that releases both. A second
    // check for it here would be unreachable, and unreachable guards cannot be tested.
    const observation = JSON.parse(row.observation_json) as MergePromotionObservation;
    const disowned = {
      ...observation,
      ownerProcessDisowned: {
        pid: input.pid,
        at: new Date(this.#now()).toISOString(),
        decidedBy,
      },
    } satisfies MergePromotionObservation;
    const updated = this.#writePromotion(row, {
      observation_json: JSON.stringify(disowned),
      updated_at_ms: Math.max(row.started_at_ms, this.#now()),
    });
    this.#emitPromotion(updated, "owner-process-abandoned", {
      pid: input.pid,
      decidedBy,
      mainMutation: false,
    });
    return this.#publicPromotion(await this.#resolvePromotion(updated));
  }

  /**
   * The way out of the state where the two releases above refuse each other.
   *
   * Both are correct in isolation and together they were a cycle with no product-side exit, which is
   * the state bar item 11 forbids. This one requires BOTH numbers exactly as the record reports them
   * and a phrase that says both that two processes are being abandoned and that one of them may
   * still be writing to main. It kills nothing, it does not touch main, and it does not decide what
   * happened: the next read re-observes the repository and reaches whichever of the three answers
   * the fingerprints support.
   *
   * It is refused whenever the narrower releases would work, so the longer phrase can never be used
   * to skip the safer confirmation the actual state calls for.
   */
  async abandonPromotionEntirely(input: {
    promotionId: string;
    roomId: string;
    mainPath: string;
    /** The owner pid exactly as the record reports it. */
    pid: number;
    /** The merge pgid exactly as the record reports it, in `pending.alsoBlockedBy`. */
    pgid: number;
    confirmation: string;
    decidedBy: string;
  }): Promise<MergePromotion> {
    this.#assertOpen();
    if (typeof input.promotionId !== "string" || !UUID_PATTERN.test(input.promotionId)) {
      throw new Error("MAIN_MERGE_PROMOTION_ID_INVALID");
    }
    const roomId = text(input.roomId, "CANDIDATE_ROOM_INVALID", 48);
    if (!ROOM_PATTERN.test(roomId)) throw new Error("CANDIDATE_ROOM_INVALID");
    const mainPath = await canonicalWorkspace(input.mainPath);
    if (input.confirmation !== MERGE_PROMOTION_ABANDON_CONFIRMATION) {
      throw new Error("MERGE_PROMOTION_ABANDON_CONFIRMATION_MISMATCH");
    }
    const decidedBy = text(input.decidedBy, "MERGE_GROUP_ABANDON_DECIDED_BY_INVALID", 64);
    const row = this.#promotionRow(input.promotionId);
    if (!row || row.room_id !== roomId || row.main_path !== mainPath) {
      throw new Error("MAIN_MERGE_PROMOTION_NOT_FOUND");
    }
    if (row.state === "applied" || row.state === "rolled-back") {
      throw new Error("MAIN_MERGE_PROMOTION_ALREADY_SETTLED");
    }
    const pending = this.#promotionPending(row);
    if (pending === undefined || pending.code !== "PROMOTION_OWNER_AND_MERGE_STILL_RUNNING"
      || pending.alsoBlockedBy === undefined) {
      throw new Error("MAIN_MERGE_PROMOTION_NOT_DOUBLY_BLOCKED");
    }
    if (!Number.isSafeInteger(input.pid) || input.pid !== pending.pid) {
      throw new Error("MERGE_OWNER_ABANDON_PID_MISMATCH");
    }
    if (!Number.isSafeInteger(input.pgid) || input.pgid !== pending.alsoBlockedBy.pid) {
      throw new Error("MERGE_GROUP_ABANDON_PGID_MISMATCH");
    }
    const observation = JSON.parse(row.observation_json) as MergePromotionObservation;
    // `whileRunning` is what the owner's trail says they were told they were abandoning, and it is
    // asked of EVERY source rather than of the payload alone — the payload is exactly the source a
    // failed pgid write leaves empty, and a `false` here would record the owner as having abandoned
    // a merge that was over when `ps -g` was listing it. Read through the same conclusion every
    // other exit uses, so it cannot drift away from what the record showed them.
    const running = this.#promotionConclusion(row).standing.blocking?.state === "merge-running";
    const at = new Date(this.#now()).toISOString();
    const disowned = {
      ...observation,
      mergePgid: null,
      mergeGroup: null,
      mergeGroupDisowned: {
        pgid: input.pgid,
        at,
        decidedBy,
        bootAtSec: bootAtSec(),
        whileRunning: running,
      },
      ownerProcessDisowned: { pid: input.pid, at, decidedBy },
    } satisfies MergePromotionObservation;
    const updated = this.#writePromotion(row, {
      observation_json: JSON.stringify(disowned),
      updated_at_ms: Math.max(row.started_at_ms, this.#now()),
    });
    this.#emitPromotion(updated, "promotion-abandoned", {
      pid: input.pid,
      pgid: input.pgid,
      decidedBy,
      whileRunning: running,
      mainMutation: false,
    });
    return this.#publicPromotion(await this.#resolvePromotion(updated));
  }

  /** The stored row exactly as SQLite holds it, integrity UNVERIFIED. Callers must decide. */
  #promotionRowRaw(id: string): PromotionRow | undefined {
    const row = this.#db.prepare("SELECT * FROM candidate_merge_promotions WHERE id=?")
      .get(id) as unknown as PromotionRow | undefined;
    if (!row || typeof row.room_id !== "string" || typeof row.main_path !== "string") return undefined;
    return row;
  }

  #promotionRowReadable(row: PromotionRow): boolean {
    try {
      this.#assertPromotionRow(row);
      return true;
    } catch { return false; }
  }

  /**
   * Moves an unreadable promotion row out of `applying` so it stops claiming the whole project.
   *
   * Nothing here repairs the row, decides what happened to main, or promises the owner anything
   * about their repository. It writes one column's worth of meaning — this record no longer holds
   * the exclusive marker — and records that the owner said so. The row remains unresolved for its
   * OWN task, which is the honest consequence of a record nobody can read: `#assertNoUnresolvedPromotion`
   * still refuses every approval for it, and that is a one-task cost rather than a whole project's.
   *
   * The scope check that got us here compared the row's plain `room_id` and `main_path` columns,
   * which an integrity failure does not make trustworthy. It is the strongest check available for a
   * row whose hash is wrong, and the action it authorises writes only to that same row.
   *
   * What it refuses to do with the short phrase is release a marker while anything this record was
   * waiting on can still be seen. That is not a hypothetical ordering: measured on this code, a
   * `git merge` whose hook `ps -g` still listed, with main already half-applied, had the project's
   * marker released out from under it and the pgid argument ignored entirely.
   */
  #releaseUnreadablePromotion(
    row: PromotionRow, confirmation: unknown, decidedBy: string, pgid: unknown,
  ): UnreadableMergePromotion {
    const id = typeof row.id === "string" ? row.id : "";
    const taskId = typeof row.task_id === "string" ? row.task_id : "";
    if (row.state !== "applying") throw new Error("MAIN_MERGE_PROMOTION_NOT_BLOCKED");
    // Asked HERE rather than trusted from a caller, and asked again on every attempt: it is a
    // statement about processes that are alive right now.
    const requirement = this.#unreadableRelease(row);
    if (confirmation !== requirement.confirmation) {
      throw new MergeUnreadablePromotionError(id, requirement);
    }
    // When a merge group can still be seen, the owner has to quote its number, exactly as every
    // other release requires. This path used to ignore the argument completely — `999999` was
    // accepted against a `git merge` that `ps` was still listing. Nothing is required when nothing
    // can be seen, because there is then no number on the record to quote.
    //
    // A live OWNER process raises the phrase but adds no number requirement, and that is a decision
    // rather than an oversight: this call carries one number, the merge group is the thing that
    // writes main, and asking the owner to quote a pid into a parameter named for a process group
    // would be a worse instruction than asking for nothing.
    //
    // When the record's sources disagree, more than one group can be alive at once. Quoting ANY of
    // the numbers the record reports is accepted, because the owner is being asked to prove they
    // read the record — not to resolve a contradiction this code could not resolve either.
    const merges = requirement.alive.filter((entry) => entry.kind === "merge");
    if (merges.length > 0
      && (!Number.isSafeInteger(pgid) || !merges.some((entry) => entry.pid === pgid))) {
      throw new Error("MERGE_GROUP_ABANDON_PGID_MISMATCH");
    }
    const at = new Date(this.#now()).toISOString();
    // The declaration is written into the row's own observation column so it can be READ BACK. The
    // previous shape returned it once and stored nothing, which left every later read unable to say
    // whether the release had happened. Preserved as text rather than merged into a parsed object:
    // this row's JSON is exactly as untrustworthy as the rest of it, and overwriting it would
    // destroy the only evidence of what the record used to claim.
    let observation: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(String(row.observation_json));
      observation = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? { ...parsed as Record<string, unknown> }
        : { unparsedObservation: String(row.observation_json).slice(0, 4_096) };
    } catch {
      observation = { unparsedObservation: String(row.observation_json).slice(0, 4_096) };
    }
    observation.unreadableRecordReleased = {
      at,
      decidedBy,
      aliveAtRelease: requirement.alive.map((entry) => ({ kind: entry.kind, pid: entry.pid })),
      // Without this, `aliveAtRelease: []` reads as "nothing was running" — and it was measured
      // being written exactly that way while `ps` proved three processes alive, because the group
      // could not be read at all. `unverifiedSource` beside it does not cover this: it says the
      // values came from a row whose hash failed, not that a question went unanswered.
      probeReadable: requirement.probeReadable,
      // Every number the record named, attributed. When the sources disagreed, both are here: the
      // record must not keep the one this code happened to prefer and drop the other.
      recordedGroups: requirement.recordedGroups,
    };
    // Written with a raw UPDATE rather than `#writePromotion`: that helper recomputes the row hash
    // over every column, which would hand a corrupted record a valid signature and make it look like
    // something this product wrote. The row stays unreadable, deliberately.
    const result = this.#db.prepare(
      "UPDATE candidate_merge_promotions SET state='needs-manual-review', observation_json=? WHERE id=? AND state='applying'",
    ).run(JSON.stringify(observation), id);
    if (Number(result.changes) !== 1) throw new Error("MAIN_MERGE_PROMOTION_CONCURRENT_UPDATE");
    try {
      // Every field that would be a fact about the REPOSITORY is null, because none of them was
      // observed: an unreadable row is exactly the case where a record must not assert anything.
      //
      // That sentence used to sit directly above four fields — `mainBranch`, `candidateHead`,
      // `recoveryRef`, `mainHeadBefore` — being copied straight out of a row whose integrity check
      // had just failed, into the audit chain, with no mark on them. They are still carried, because
      // a trail that names nothing an owner can look up is not much of a trail, but they are carried
      // in `detail.unverifiedRowValues` under a flag that says where they came from, and the
      // top-level fields the chain treats as observations stay null.
      this.#onPromotion?.({
        phase: "unreadable-record-released",
        promotionId: id,
        approvalId: typeof row.approval_id === "string" ? row.approval_id : "",
        taskId,
        roomId: row.room_id,
        mainPath: row.main_path,
        mainBranch: null,
        candidateHead: null,
        recoveryRef: null,
        mainHeadBefore: null,
        mainHeadAfter: null,
        mainHeadUnchanged: null,
        state: "needs-manual-review",
        observation: {
          code: "PROMOTION_RECORD_UNREADABLE",
          mainHead: null,
          authorizedMergeCommit: null,
          mergeInProgress: null,
          worktreeRestored: null,
          stashRestored: null,
          reflogPreserved: null,
          recoveryRefIntact: null,
          observedAt: at,
        },
        mainMutated: false,
        decidedBy: null,
        previewDigest: null,
        approvalState: null,
        at,
        detail: {
          decidedBy,
          mainMutation: false,
          recordRepaired: false,
          /** True for every value below: read from a row whose hash did not verify. */
          unverifiedSource: true,
          unverifiedRowValues: {
            mainBranch: typeof row.main_branch === "string" ? row.main_branch : null,
            candidateHead: typeof row.candidate_head === "string" ? row.candidate_head : null,
            recoveryRef: typeof row.recovery_ref === "string" ? row.recovery_ref : null,
            mainHeadBefore: typeof row.main_head_before === "string" ? row.main_head_before : null,
          },
          aliveAtRelease: requirement.alive.map((entry) => ({ kind: entry.kind, pid: entry.pid })),
          /** False when the merge group could not be read; the empty list above then asserts nothing. */
          probeReadable: requirement.probeReadable,
          /** Every group the record named, attributed to its source. Two entries is a disagreement. */
          recordedGroups: requirement.recordedGroups,
        },
      });
    } catch { /* the durable row has already moved; an audit sink must not undo that */ }
    // Re-read, and rendered by the same function every listing uses. A hand-built answer here is how
    // this call came to report two fields no later read could produce.
    const stored = this.#promotionRowRaw(id);
    return stored === undefined
      ? {
        id, taskId, state: "unreadable", unreadable: true,
        storedState: "needs-manual-review", holdsProjectExclusiveMarker: false,
        releasedFromExclusiveMarker: { at, decidedBy },
      }
      : this.#unreadableView(stored);
  }

  /**
   * Hands one committed promotion transition to the audit chain and the room ledger.
   *
   * It runs AFTER the durable write, so the trail can never describe a transition that did not
   * happen, and a sink that throws is swallowed — an audit failure must not become a second write to
   * main, and the promotion row remains the reconstructible primary record either way (bar item 5).
   * Every value is copied out of the committed row; nothing is measured again for the ledger, so
   * there is no way for the two to disagree.
   */
  #emitPromotion(row: PromotionRow, phase: MergePromotionEvent["phase"], detail?: Record<string, unknown>): void {
    if (this.#onPromotion === undefined) return;
    try {
      const observation = JSON.parse(row.observation_json) as MergePromotionObservation;
      const approval = this.#mergeApprovalRow(row.approval_id);
      const headAfter = row.main_head_after ?? observation.mainHead;
      this.#onPromotion({
        phase,
        promotionId: row.id,
        approvalId: row.approval_id,
        taskId: row.task_id,
        roomId: row.room_id,
        mainPath: row.main_path,
        mainBranch: row.main_branch,
        candidateHead: row.candidate_head,
        recoveryRef: row.recovery_ref,
        mainHeadBefore: row.main_head_before,
        mainHeadAfter: headAfter,
        mainHeadUnchanged: headAfter === null ? null : headAfter === row.main_head_before,
        state: row.state,
        observation,
        mainMutated: row.state === "applied",
        decidedBy: approval?.decided_by ?? null,
        previewDigest: approval?.preview_digest ?? null,
        approvalState: approval?.state ?? null,
        at: new Date(row.updated_at_ms).toISOString(),
        ...(detail === undefined ? {} : { detail }),
      });
    } catch { /* the durable promotion row has already committed and remains the primary record */ }
  }

  async #scopedMergeApprovalRow(idValue: unknown, roomIdValue: string, mainPathValue: string): Promise<MergeApprovalRow> {
    if (typeof idValue !== "string" || !UUID_PATTERN.test(idValue)) throw new Error("MAIN_MERGE_APPROVAL_ID_INVALID");
    const roomId = text(roomIdValue, "CANDIDATE_ROOM_INVALID", 48);
    if (!ROOM_PATTERN.test(roomId)) throw new Error("CANDIDATE_ROOM_INVALID");
    const mainPath = await canonicalWorkspace(mainPathValue);
    const row = this.#mergeApprovalRow(idValue);
    if (!row) throw new Error("MAIN_MERGE_APPROVAL_NOT_FOUND");
    this.#assertMergeApprovalRow(row);
    // A caller scoped to another Room or project is told the approval does not exist rather than that
    // it exists elsewhere: Room membership is the authorization boundary.
    if (row.room_id !== roomId || row.main_path !== mainPath) throw new Error("MAIN_MERGE_APPROVAL_NOT_FOUND");
    return row;
  }

  #mergeApprovalRow(id: string): MergeApprovalRow | undefined {
    return this.#db.prepare("SELECT * FROM candidate_merge_approvals WHERE id=?")
      .get(id) as unknown as MergeApprovalRow | undefined;
  }

  #mergeApprovalByKey(clientRequestId: string): MergeApprovalRow | undefined {
    const row = this.#db.prepare("SELECT * FROM candidate_merge_approvals WHERE client_request_id=?")
      .get(clientRequestId) as unknown as MergeApprovalRow | undefined;
    if (row) this.#assertMergeApprovalRow(row);
    return row;
  }

  /**
   * Runs the drift check over the one approval that can currently hold a task's open slot. A row
   * that cannot be verified is left alone: it can never be granted either way, and invalidating on
   * a failed check would let a bad read destroy an owner decision.
   */
  async #observeOpenMergeApproval(taskId: string, observedOn: MergeApprovalObservation): Promise<void> {
    const open = this.#openMergeApproval(taskId);
    if (!open) return;
    try {
      this.#assertMergeApprovalRow(open);
    } catch { return; }
    await this.#observeMergeApproval(open, observedOn);
  }

  #openMergeApproval(taskId: string): MergeApprovalRow | undefined {
    return this.#db.prepare(
      "SELECT * FROM candidate_merge_approvals WHERE task_id=? AND state IN ('requested','approved')",
    ).get(taskId) as unknown as MergeApprovalRow | undefined;
  }

  #countMergeApprovals(taskId: string): number {
    const row = this.#db.prepare("SELECT COUNT(*) AS total FROM candidate_merge_approvals WHERE task_id=?")
      .get(taskId) as { total: number };
    return Number(row.total);
  }

  /** Records lapsed approvals as terminal so the single open slot cannot be held by a dead question. */
  #sweepExpiredMergeApprovals(taskId: string): void {
    const now = this.#now();
    const rows = this.#db.prepare(
      "SELECT * FROM candidate_merge_approvals WHERE task_id=? AND state IN ('requested','approved') AND expires_at_ms<?",
    ).all(taskId, now) as unknown as MergeApprovalRow[];
    for (const row of rows) {
      try {
        this.#assertMergeApprovalRow(row);
        this.#writeMergeApproval(row, {
          state: "expired",
          token_hash: null,
          updated_at_ms: Math.max(row.created_at_ms, now),
        });
      } catch { /* a row that cannot be verified is left alone; it can never be granted either way */ }
    }
  }

  #assertMergeApprovalLive(row: MergeApprovalRow): void {
    const now = this.#now();
    if (now <= row.expires_at_ms) return;
    // Recording the lapse is what makes it terminal. A row that merely looks expired to one reader
    // could otherwise still be granted by another, and an expired approval must never come back.
    this.#settleMergeApproval(row, "expired");
    throw new Error("MAIN_MERGE_APPROVAL_EXPIRED");
  }

  /**
   * The observation-time drift check, and the whole of Phase 5-4's detection half.
   *
   * 5-3 verified the binding at grant and at consume. That leaves the interval between them, and an
   * approval that stopped applying during it stayed on every read surface looking exactly like one
   * that still applied — `state` comes from the stored row, and nothing was re-reading live state.
   * Every read of an approval now goes through here first, so drift is noticed at the next
   * observation rather than at the moment someone tries to act on it.
   *
   * Three outcomes, deliberately distinct:
   *  - not applicable: the row is already terminal, or its deadline has passed. Nothing is compared
   *    and nothing is written; an expired approval is refused on its own terms.
   *  - unavailable: at least one bound value could not be read, and none of the ones that could be
   *    read had moved. The approval is NOT invalidated, its token is NOT cleared, and no row is
   *    written at all — a `chmod`, an unmounted volume or a spawn failure must not destroy an owner
   *    decision, which is the same reasoning the 5-2 bar records for burning an idempotency key. It
   *    is not reported as valid either: `checked` is false, `unavailable` carries the stable code,
   *    and `unverified` names the fields that could not be read. Once the repository is readable the
   *    next observation reports it valid again and it can still be consumed.
   *  - drifted: at least one bound value was actually compared and moved. Only those values are
   *    named in `changed`; anything unread on the same pass is reported separately in `unverified`
   *    and never presented as a value that moved. The row is invalidated durably before it is
   *    reported, so the refusal survives the process that noticed it.
   *
   * Nothing here touches the candidate, a checkpoint, a recovery ref or main. The only write is the
   * approval row's own transition to a terminal state it could never have escaped anyway.
   */
  async #observeMergeApproval(row: MergeApprovalRow, observedOn: MergeApprovalObservation): Promise<{
    row: MergeApprovalRow;
    check: MergeApprovalBindingCheck;
  }> {
    if (MERGE_APPROVAL_TERMINAL.has(row.state) || this.#now() > row.expires_at_ms) {
      return { row, check: { checked: false, valid: false, changed: [] } };
    }
    // Before anything is compared: an approval taken before the promotion gates existed can never
    // become usable, whatever live state says. Recording that as its own terminal state is what frees
    // the task's single open-question slot, so the owner can be asked again against a fresh snapshot.
    const retired = this.#retirePredatingApproval(row);
    if (retired) return { row: retired, check: { checked: false, valid: false, changed: [] } };
    let verification: MergeBindingVerification;
    try {
      verification = await this.#verifyMergeBinding(row, { throttle: true });
    } catch (error) {
      return {
        row,
        check: { checked: false, valid: false, changed: [], unavailable: bindingCheckFailure(error) },
      };
    }
    const { changed, unverified } = verification;
    if (changed.length === 0 && unverified.length > 0) {
      // Nothing was found to have moved and something could not be read. The approval is left exactly
      // as the owner left it: not reported valid, not invalidated, and still consumable once whatever
      // was unreadable comes back. The code names the deadline when that is what happened, because a
      // repository too large to re-verify inside the deadline is a state the owner must be able to
      // recognise rather than a failure that looks like every other failure.
      return {
        row,
        check: {
          checked: false,
          valid: false,
          changed: [],
          unverified,
          unavailable: verification.unavailable ?? "MAIN_MERGE_APPROVAL_BINDING_CHECK_FAILED",
        },
      };
    }
    if (changed.length === 0) return { row, check: { checked: true, valid: true, changed: [] } };
    return {
      row: this.#invalidateDrifted(row, changed, observedOn, unverified) ?? row,
      check: {
        checked: true,
        valid: false,
        changed,
        ...(unverified.length > 0 ? { unverified } : {}),
      },
    };
  }

  /**
   * Records a drifted approval as terminally invalidated, then reports it exactly once.
   *
   * The compare-and-set inside #writeMergeApproval is what makes the report single: two readers that
   * notice the same drift in the same instant both try, one wins, and only the winner notifies. A
   * listener that throws is swallowed, because the durable row is the primary record and an audit
   * sink that is unavailable must not undo an invalidation or break the read that found it.
   */
  #invalidateDrifted(
    row: MergeApprovalRow, changed: string[], observedOn: MergeApprovalObservation,
    unverified: string[] = [],
  ): MergeApprovalRow | undefined {
    let next: MergeApprovalRow;
    try {
      next = this.#writeMergeApproval(row, {
        state: "invalidated",
        token_hash: null,
        refusal_json: JSON.stringify(boundedRefusal(driftRefusal(changed, observedOn, unverified))),
        updated_at_ms: Math.max(row.created_at_ms, this.#now()),
      });
    } catch {
      // Another writer settled it first. Its record stands and describes the same drift, but this
      // reader must report what the store now says rather than the stale row it read a moment ago —
      // otherwise the loser of a race between two observations still shows the approval as live.
      const current = this.#mergeApprovalRow(row.id);
      if (!current) return undefined;
      try {
        this.#assertMergeApprovalRow(current);
      } catch { return undefined; }
      return current;
    }
    try {
      this.#onDrift?.({
        approvalId: next.id,
        taskId: next.task_id,
        roomId: next.room_id,
        mainPath: next.main_path,
        candidateHead: next.candidate_head,
        mainHead: next.main_head,
        previewDigest: next.preview_digest,
        changed: [...changed],
        ...(unverified.length > 0 ? { unverified: [...unverified] } : {}),
        wasGranted: row.decided_by !== null,
        previousState: row.state,
        observedOn,
        at: new Date(next.updated_at_ms).toISOString(),
      });
    } catch { /* the durable invalidation has already committed and is the primary record */ }
    return next;
  }

  /**
   * Retires an approval whose snapshot predates the promotion gates, by name, and returns the row the
   * store now holds — or `undefined` when there was nothing to retire.
   *
   * This is the whole of the upgrade path for an owner decision made under the previous release. It
   * spends nothing, runs no Git command and touches no candidate: the approval was already unusable,
   * and the only thing that changes is that the store now SAYS so, which is what lets `reject`,
   * `request` and expiry all work again instead of every surface throwing "tampered".
   */
  #retirePredatingApproval(row: MergeApprovalRow): MergeApprovalRow | undefined {
    if (MERGE_APPROVAL_TERMINAL.has(row.state) || !previewPredatesPromotionGates(row)) return undefined;
    this.#settleMergeApproval(row, "invalidated", {
      code: PREVIEW_PREDATES_PROMOTION_GATES,
      changed: ["promotionGates"],
    });
    const current = this.#mergeApprovalRow(row.id);
    if (!current) return undefined;
    try {
      this.#assertMergeApprovalRow(current);
    } catch { return undefined; }
    return current;
  }

  /** Best-effort terminal transition used on refusal paths; it must never replace the real refusal. */
  #settleMergeApproval(row: MergeApprovalRow, state: MergeApprovalState, refusal?: MergeApprovalRefusal): void {
    try {
      this.#writeMergeApproval(row, {
        state,
        token_hash: null,
        ...(refusal === undefined ? {} : { refusal_json: JSON.stringify(boundedRefusal(refusal)) }),
        updated_at_ms: Math.max(row.created_at_ms, this.#now()),
      });
    } catch { /* another writer already settled it; the caller's refusal stands either way */ }
  }

  /**
   * The only way to UPDATE a merge approval, and it cannot move a terminal row.
   *
   * This is structural rather than a check at each call site: grant, reject, expire, invalidate and
   * consume are five verbs on one row, and a state machine whose "terminal" is enforced in only some
   * of them is a state machine where a spent approval can be brought back. The compare-and-set on
   * both the previous row hash and the previous state is what makes consumption single-use.
   */
  #writeMergeApproval(previous: MergeApprovalRow, fields: Partial<MergeApprovalRow>): MergeApprovalRow {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const next = this.#updateMergeApprovalRow(previous, fields);
      this.#db.exec("COMMIT");
      return next;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * The UPDATE itself, without a transaction of its own, so that promotion can put it in the SAME
   * transaction as the durable intent to write main. That co-commit is the whole of bar item 1:
   * spending the approval and recording that main is about to change are one decision or neither.
   */
  #updateMergeApprovalRow(previous: MergeApprovalRow, fields: Partial<MergeApprovalRow>): MergeApprovalRow {
    if (MERGE_APPROVAL_TERMINAL.has(previous.state)) throw new Error("MAIN_MERGE_APPROVAL_NOT_PENDING");
    const merged = { ...previous, ...fields };
    const { row_hash: _old, ...bare } = merged;
    const next: MergeApprovalRow = { ...bare, row_hash: mergeApprovalHash(bare) };
    const result = this.#db.prepare(`UPDATE candidate_merge_approvals
      SET state=?,token_hash=?,decided_by=?,refusal_json=?,updated_at_ms=?,expires_at_ms=?,row_hash=?
      WHERE id=? AND row_hash=? AND state=?`).run(
      next.state, next.token_hash, next.decided_by, next.refusal_json, next.updated_at_ms,
      next.expires_at_ms, next.row_hash, next.id, previous.row_hash, previous.state,
    );
    if (Number(result.changes) !== 1) throw new Error("MAIN_MERGE_APPROVAL_CONCURRENT_UPDATE");
    return next;
  }

  #insertMergeApproval(row: MergeApprovalRow): void {
    this.#db.prepare("INSERT INTO candidate_merge_approvals VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
      row.id, row.client_request_id, row.input_digest, row.task_id, row.completion_id, row.room_id,
      row.main_path, row.main_branch, row.candidate_path, row.base_main_head, row.candidate_head,
      row.main_head, row.main_fingerprint, row.main_ignored_fingerprint, row.recovery_ref,
      row.preview_digest, row.preview_json, row.grant_action, row.state, row.token_hash, row.actor,
      row.decided_by, row.refusal_json, row.created_at_ms, row.updated_at_ms, row.expires_at_ms,
      row.row_hash,
    );
  }

  /**
   * Degrades per row rather than throwing. A summary is not authority — grant and consume still read
   * the row through #assertMergeApprovalRow and still refuse an unreadable one — so a single corrupt
   * approval must not take out `candidate_status` for the whole Room. That tool is what every error
   * path tells the agent to call in order to learn the real state; losing it is how a small
   * corruption becomes an outage. An unreadable row is reported as such, not hidden.
   */
  async #observedMergeApprovalSummaries(
    taskId: string, observedOn: MergeApprovalObservation,
  ): Promise<Array<MergeApprovalSummary | UnreadableMergeApproval>> {
    const rows = this.#db.prepare(
      "SELECT * FROM candidate_merge_approvals WHERE task_id=? ORDER BY created_at_ms DESC, id LIMIT ?",
    ).all(taskId, MAX_LIST) as unknown as MergeApprovalRow[];
    const summaries: Array<MergeApprovalSummary | UnreadableMergeApproval> = [];
    for (const row of rows) {
      try {
        // Integrity first. A row that fails its own hash is not a description of anything live, so
        // it is never compared against live state and never invalidated on that basis.
        this.#assertMergeApprovalRow(row);
        const observed = await this.#observeMergeApproval(row, observedOn);
        summaries.push({
          ...this.#mergeApprovalSummary(observed.row),
          ...(observed.check.checked || observed.check.unavailable !== undefined
            ? { bindingCheck: observed.check }
            : {}),
        });
      } catch {
        summaries.push({
          id: typeof row.id === "string" ? row.id : "",
          taskId,
          state: "unreadable" as const,
          unreadable: true as const,
        });
      }
    }
    return summaries;
  }

  #mergeApprovalSummary(row: MergeApprovalRow): MergeApprovalSummary {
    this.#assertMergeApprovalRow(row);
    return {
      id: row.id,
      taskId: row.task_id,
      state: row.state,
      previewDigest: row.preview_digest,
      candidateHead: row.candidate_head,
      mainHead: row.main_head,
      createdAt: new Date(row.created_at_ms).toISOString(),
      updatedAt: new Date(row.updated_at_ms).toISOString(),
      expiresAt: new Date(row.expires_at_ms).toISOString(),
      expired: !MERGE_APPROVAL_TERMINAL.has(row.state) && this.#now() > row.expires_at_ms,
      ...(row.refusal_json === null
        ? {}
        : { refusal: assertRefusal(JSON.parse(row.refusal_json) as unknown) }),
    };
  }

  #publicMergeApproval(row: MergeApprovalRow): MergeApproval {
    return {
      ...this.#mergeApprovalSummary(row),
      clientRequestId: row.client_request_id,
      grants: row.grant_action,
      notAuthorized: MERGE_APPROVAL_NOT_AUTHORIZED,
      requestedBy: row.actor,
      ...(row.decided_by === null ? {} : { decidedBy: row.decided_by }),
      binding: mergeBinding(row),
      preview: assertPreviewShape(JSON.parse(row.preview_json) as unknown),
      mainMutation: false,
    };
  }

  #assertMergeApprovalRow(row: MergeApprovalRow): void {
    const { row_hash: actual, ...bare } = row;
    if (!HASH_PATTERN.test(actual) || mergeApprovalHash(bare) !== actual
      || !UUID_PATTERN.test(row.id) || !UUID_PATTERN.test(row.client_request_id)
      || !UUID_PATTERN.test(row.task_id) || !UUID_PATTERN.test(row.completion_id)
      || !HASH_PATTERN.test(row.input_digest) || !HASH_PATTERN.test(row.preview_digest)
      || !HASH_PATTERN.test(row.main_fingerprint) || !HASH_PATTERN.test(row.main_ignored_fingerprint)
      || !ROOM_PATTERN.test(row.room_id) || !isAbsolute(row.main_path) || !isAbsolute(row.candidate_path)
      || !HEAD_PATTERN.test(row.base_main_head) || !HEAD_PATTERN.test(row.candidate_head)
      || !HEAD_PATTERN.test(row.main_head) || !CHECKPOINT_REF_PATTERN.test(row.recovery_ref)
      || row.grant_action !== MERGE_APPROVAL_GRANT
      || row.main_branch.length < 1 || row.main_branch.length > 255
      || row.actor.length < 1 || row.actor.length > MAX_ACTOR
      || row.expires_at_ms <= row.created_at_ms || row.updated_at_ms < row.created_at_ms
      // A usable secret may exist only while the approval is usable; anything else means a spent or
      // refused approval is still carrying one.
      || (row.state === "approved") !== (row.token_hash !== null)
      || (row.token_hash !== null && !HASH_PATTERN.test(row.token_hash))) {
      throw new Error("MAIN_MERGE_APPROVAL_ROW_TAMPERED");
    }
    const preview = assertPreviewShape(JSON.parse(row.preview_json) as unknown);
    // The scalar columns are redundant with the stored preview on purpose: that redundancy is the
    // integrity check, so no single edited field can change what the approval appears to bind.
    if (sha(JSON.stringify(preview)) !== row.preview_digest
      || preview.candidateHead !== row.candidate_head || preview.mainHead !== row.main_head
      || preview.baseMainHead !== row.base_main_head || preview.mainPath !== row.main_path
      || preview.candidatePath !== row.candidate_path || preview.recovery.ref !== row.recovery_ref
      || preview.mainDirty.fingerprint !== row.main_fingerprint
      || preview.mainDirty.ignoredFingerprint !== row.main_ignored_fingerprint
      // Bar item 5 on the read path as well: a truncated or conflicted preview is not approvable, so
      // a stored approval carrying one is not an approval anything may act on.
      || mergeBlockers(preview).length > 0) {
      throw new Error("MAIN_MERGE_APPROVAL_ROW_TAMPERED");
    }
    if (row.refusal_json !== null) assertRefusal(JSON.parse(row.refusal_json) as unknown);
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("CANDIDATE_REGISTRY_CLOSED");
  }
}
