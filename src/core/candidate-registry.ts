import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { StringDecoder } from "node:string_decoder";
import { canonicalWorkspace } from "../security/workspace.ts";
import { GitBroker, type GitInspection } from "./git-broker.ts";
import { minimalGitEnvironment, resolveExecutable, runProcess } from "./process-runner.ts";
import { openOwnerDatabase, verifyOwnerDatabaseFiles } from "./sqlite-security.ts";
import { WorktreeBroker } from "./worktree-broker.ts";

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
  /** Names of the bound values that no longer match, so a refusal says what moved. */
  changed: string[];
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
  /** Bound values that moved, named with the same vocabulary grant and consume use. */
  changed: string[];
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
  changed: string[];
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
  confirmationPhrase: string;
  prompt: string;
  mainMutation: false;
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

  constructor(changed: string[]) {
    super(`MAIN_MERGE_APPROVAL_BINDING_CHANGED:${changed.join(",")}`);
    this.name = "MergeApprovalBindingError";
    this.changed = changed;
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

const SCHEMA_VERSION = 4;
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
const MAX_MERGE_REJECT_REASON = 240;
/** Terminal states can never become usable again; only these leave the one-open-approval slot free. */
const MERGE_APPROVAL_TERMINAL: ReadonlySet<MergeApprovalState> =
  new Set<MergeApprovalState>(["consumed", "rejected", "invalidated", "expired"]);

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

function boundedRefusal(refusal: MergeApprovalRefusal): MergeApprovalRefusal {
  const reason = refusal.reason === undefined
    ? undefined
    : refusal.reason.replace(/[\r\n\t\0]+/gu, " ").slice(0, MAX_MERGE_REJECT_REASON).trim();
  return {
    code: refusal.code.slice(0, 64),
    changed: refusal.changed.slice(0, MAX_MERGE_REFUSAL_CHANGED).map((name) => name.slice(0, 40)),
    ...(reason ? { reason } : {}),
  };
}

/**
 * The one shape a drift refusal takes, wherever it is detected. Grant, consume and every observation
 * path go through it so the durable record of "this approval stopped applying" reads the same no
 * matter who noticed, and always names both the values that moved and the surface that saw them.
 */
function driftRefusal(changed: string[], observedOn: MergeApprovalObservation): MergeApprovalRefusal {
  return {
    code: "MAIN_MERGE_APPROVAL_BINDING_CHANGED",
    changed,
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
  if (Object.keys(refusal).some((key) => !["code", "changed", "reason"].includes(key))
    || typeof refusal.code !== "string" || refusal.code.length < 1 || refusal.code.length > 64
    || !Array.isArray(refusal.changed) || refusal.changed.length > MAX_MERGE_REFUSAL_CHANGED
    || refusal.changed.some((name) => typeof name !== "string" || name.length < 1 || name.length > 40)
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
): string {
  return [
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
   * Notified after an observation path has durably invalidated a drifted approval. The registry owns
   * durable state and knows nothing about the audit chain or the room ledger, so the record that has
   * to reach the owner is written by whoever supplied this.
   */
  readonly #onDrift: ((event: MergeApprovalDriftEvent) => void) | undefined;
  #closed = false;

  constructor(dataDirectory: string, options: {
    now?: () => number;
    maxFiles?: number;
    /** Test/embedded-code dependency injection; the shipped service leaves this unset. */
    gitBroker?: GitBroker;
    /** Sink for observation-time drift invalidations; see #onDrift. */
    onMergeApprovalInvalidated?: (event: MergeApprovalDriftEvent) => void;
  } = {}) {
    this.#dataDirectory = realpathSync(dataDirectory);
    this.#now = options.now ?? Date.now;
    this.#onDrift = options.onMergeApprovalInvalidated;
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
      try { this.#transition(row, { status: "failed", updated_at_ms: this.#now() }); } catch { /* retain original failure */ }
      try { this.#settleRequest(clientRequestId, ownerToken, "failed"); } catch { /* retain original failure */ }
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
      // Ref creation sits outside the DB transaction, so record the verdict here or the key would
      // stay `pending` and retry the same deterministic failure forever.
      try { this.#settleRequest(clientRequestId, ownerToken, "failed"); } catch { /* retain original failure */ }
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
      try { this.#settleRequest(clientRequestId, ownerToken, "failed"); } catch { /* retain original failure */ }
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
      try { this.#settleRequest(clientRequestId, ownerToken, "failed"); } catch { /* retain original failure */ }
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
      try { this.#settleRequest(clientRequestId, ownerToken, "failed"); } catch { /* retain original failure */ }
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
    const blockers = mergeBlockers(preview);
    return {
      taskId: scope.task.taskId,
      completionId: scope.completion.id,
      previewDigest,
      preview,
      recoveryRef: scope.recoveryRef,
      approvable: blockers.length === 0,
      blockers,
      confirmationPhrase: MERGE_APPROVAL_CONFIRMATION,
      prompt: mergeApprovalPrompt(scope.task, preview, previewDigest, blockers),
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
    if (input.confirmation !== MERGE_APPROVAL_CONFIRMATION) throw new Error("MAIN_MERGE_CONFIRMATION_MISMATCH");
    // The surface has to name the digest it displayed. Approving a row whose preview the caller never
    // saw is exactly the failure the whole binding exists to prevent.
    if (typeof input.previewDigest !== "string" || input.previewDigest !== row.preview_digest) {
      throw new Error("MAIN_MERGE_PREVIEW_DIGEST_MISMATCH");
    }
    const changed = await this.#verifyMergeBinding(row);
    if (changed.length > 0) {
      this.#settleMergeApproval(row, "invalidated", driftRefusal(changed, "grant"));
      throw new MergeApprovalBindingError(changed);
    }
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
   * Turns an approval into authority exactly once. Phase 5-5 promotion is its only intended caller.
   *
   * Nothing here writes to canonical main, creates or removes a ref, or touches the candidate: it
   * re-verifies the entire binding against live state a SECOND time — creation-time verification
   * alone would let anything that moved in between slip through — and hands back a description of
   * precisely what the owner agreed to, together with what they did not.
   */
  async consumeMainMerge(input: {
    approvalId: string;
    token: string;
    action: string;
    taskId: string;
    roomId: string;
    mainPath: string;
  }): Promise<MergeAuthorization> {
    this.#assertOpen();
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
    const changed = await this.#verifyMergeBinding(row);
    if (changed.length > 0) {
      this.#settleMergeApproval(row, "invalidated", driftRefusal(changed, "consume"));
      throw new MergeApprovalBindingError(changed);
    }
    let consumed: MergeApprovalRow;
    try {
      consumed = this.#writeMergeApproval(row, {
        state: "consumed",
        token_hash: null,
        updated_at_ms: Math.max(row.created_at_ms, this.#now()),
      });
    } catch (error) {
      // The compare-and-set is the single-use guarantee. A loser here did not arrive late, it arrived
      // at the same instant, so it is told the approval is spent rather than shown a storage-level
      // error it cannot act on.
      const current = this.#mergeApprovalRow(row.id);
      if (current?.state === "consumed") throw new Error("MAIN_MERGE_APPROVAL_ALREADY_CONSUMED");
      throw error;
    }
    return {
      approvalId: consumed.id,
      grants: consumed.grant_action,
      notAuthorized: MERGE_APPROVAL_NOT_AUTHORIZED,
      singleUse: true,
      binding: mergeBinding(consumed),
      preview: assertPreviewShape(JSON.parse(consumed.preview_json) as unknown),
      consumedAt: new Date(consumed.updated_at_ms).toISOString(),
    };
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
  }> {
    this.#assertOpen();
    const row = await this.#scopedMergeApprovalRow(input.approvalId, input.roomId, input.mainPath);
    const observed = await this.#observeMergeApproval(row, "merge-approval-inspect");
    return {
      approval: {
        ...this.#publicMergeApproval(observed.row),
        ...(observed.check.checked || observed.check.unavailable !== undefined
          ? { bindingCheck: observed.check }
          : {}),
      },
      binding: observed.check,
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
    const mainState = await this.#git.inspect(task.mainPath);
    const mainIgnored = await this.#ignoredInventory(task.mainPath);
    const mainHead = await this.#git.headSha(task.mainPath);
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
      PRAGMA user_version=${SCHEMA_VERSION}; COMMIT;`);
  }

  /**
   * Every supported upgrade is purely additive, so existing rows are left byte-identical and their
   * hashes stay valid; a failure rolls the whole step back.
   */
  #upgrade(from: number): void {
    if (from === 1) {
      // v1 holds only candidates and checkpoints. Adding the request ledger and the merge approval
      // table is additive, so existing rows stay byte-identical and their hashes stay valid.
      this.#db.exec(`BEGIN IMMEDIATE;
        ${REQUESTS_TABLE_SQL}
        ${MERGE_APPROVALS_TABLE_SQL}
        PRAGMA user_version=${SCHEMA_VERSION}; COMMIT;`);
      return;
    }
    if (from === 3) {
      // v3 already carries the request ledger; only the approval table is new, and no v3 row moves.
      this.#db.exec(`BEGIN IMMEDIATE;
        ${MERGE_APPROVALS_TABLE_SQL}
        PRAGMA user_version=${SCHEMA_VERSION}; COMMIT;`);
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
   * Re-checks every bound value against live state and returns the names of the ones that moved.
   *
   * It collects rather than short-circuits, so a refusal can say "mainHead, mainBranch" instead of
   * only the first thing it noticed. Identity is checked before anything is spawned, because once the
   * task, room or paths have moved there is nothing meaningful left to compare.
   */
  async #verifyMergeBinding(row: MergeApprovalRow): Promise<string[]> {
    const candidateRow = this.#rowByTask(row.task_id);
    if (!candidateRow) return ["taskId"];
    this.#assertRow(candidateRow);
    const task = this.#public(candidateRow);
    const identity: string[] = [];
    if (task.roomId !== row.room_id) identity.push("roomId");
    if (task.mainPath !== row.main_path) identity.push("mainPath");
    if (task.candidatePath !== row.candidate_path) identity.push("candidatePath");
    if (task.baseMainHead !== row.base_main_head) identity.push("baseMainHead");
    if (task.status !== "completed") identity.push("candidateStatus");
    if (task.completion?.id !== row.completion_id) identity.push("completionId");
    if (identity.length > 0) return identity;
    const changed: string[] = [];
    let candidateWorkspace: string | undefined;
    let candidateHead: string | undefined;
    let candidateClean = false;
    let scoped = false;
    try {
      const candidate = await this.#worktrees.inspectCandidate(task.candidateId);
      scoped = candidate.workspace === task.candidatePath && candidate.sourceWorkspace === task.mainPath
        && candidate.branch === task.candidateBranch;
      candidateWorkspace = candidate.workspace;
      candidateHead = candidate.headSha;
      candidateClean = (await this.#git.inspect(candidate.workspace)).clean;
    } catch { /* an absent or unverifiable candidate is reported as changed, never assumed intact */ }
    if (!scoped) changed.push("candidateWorktree");
    if (candidateHead !== row.candidate_head) changed.push("candidateHead");
    if (!candidateClean) changed.push("candidateWorktreeClean");
    let mainBranch: string | undefined;
    let mainHead: string | undefined;
    let mainFingerprint: string | undefined;
    let mainIgnoredFingerprint: string | undefined;
    try {
      mainBranch = await this.#mainBranch(task.mainPath);
      mainHead = await this.#git.headSha(task.mainPath);
      mainFingerprint = (await this.#git.inspect(task.mainPath)).fingerprint;
      mainIgnoredFingerprint = (await this.#ignoredInventory(task.mainPath)).fingerprint;
    } catch { /* same rule for main: unreadable is not "unchanged" */ }
    if (mainBranch !== row.main_branch) changed.push("mainBranch");
    if (mainHead !== row.main_head) changed.push("mainHead");
    if (mainFingerprint !== row.main_fingerprint) changed.push("mainDirtyFingerprint");
    if (mainIgnoredFingerprint !== row.main_ignored_fingerprint) changed.push("mainIgnoredFingerprint");
    if (!await this.#checkpointRefMatches(task.mainPath, row.recovery_ref, row.candidate_head)) {
      changed.push("recoveryRef");
    }
    if (changed.length > 0 || candidateWorkspace === undefined) return changed;
    // Only now is recomputing the whole snapshot meaningful — and it is still done, because the
    // scalar checks above are a summary and the digest is the thing the owner actually approved.
    const { previewDigest } = await this.#previewSnapshot({
      task,
      candidateWorkspace,
      candidateHead: row.candidate_head,
      recoveryRef: row.recovery_ref,
      tests: task.completion?.preview.tests ?? [],
      knownRisks: task.completion?.preview.knownRisks ?? [],
    });
    if (previewDigest !== row.preview_digest) changed.push("previewDigest");
    return changed;
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
   *  - unavailable: the comparison could not be completed. The approval is NOT invalidated — a
   *    transient Git failure must not destroy an owner decision, which is the same reasoning the
   *    5-2 bar records for burning an idempotency key — and it is not reported as valid either.
   *  - drifted: the bound values that moved are named, and the row is invalidated durably before it
   *    is reported, so the refusal survives the process that noticed it.
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
    let changed: string[];
    try {
      changed = await this.#verifyMergeBinding(row);
    } catch (error) {
      return {
        row,
        check: { checked: false, valid: false, changed: [], unavailable: bindingCheckFailure(error) },
      };
    }
    if (changed.length === 0) return { row, check: { checked: true, valid: true, changed: [] } };
    return {
      row: this.#invalidateDrifted(row, changed, observedOn) ?? row,
      check: { checked: true, valid: false, changed },
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
  ): MergeApprovalRow | undefined {
    let next: MergeApprovalRow;
    try {
      next = this.#writeMergeApproval(row, {
        state: "invalidated",
        token_hash: null,
        refusal_json: JSON.stringify(boundedRefusal(driftRefusal(changed, observedOn))),
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
        wasGranted: row.decided_by !== null,
        previousState: row.state,
        observedOn,
        at: new Date(next.updated_at_ms).toISOString(),
      });
    } catch { /* the durable invalidation has already committed and is the primary record */ }
    return next;
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
    if (MERGE_APPROVAL_TERMINAL.has(previous.state)) throw new Error("MAIN_MERGE_APPROVAL_NOT_PENDING");
    const merged = { ...previous, ...fields };
    const { row_hash: _old, ...bare } = merged;
    const next: MergeApprovalRow = { ...bare, row_hash: mergeApprovalHash(bare) };
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.#db.prepare(`UPDATE candidate_merge_approvals
        SET state=?,token_hash=?,decided_by=?,refusal_json=?,updated_at_ms=?,expires_at_ms=?,row_hash=?
        WHERE id=? AND row_hash=? AND state=?`).run(
        next.state, next.token_hash, next.decided_by, next.refusal_json, next.updated_at_ms,
        next.expires_at_ms, next.row_hash, next.id, previous.row_hash, previous.state,
      );
      if (Number(result.changes) !== 1) throw new Error("MAIN_MERGE_APPROVAL_CONCURRENT_UPDATE");
      this.#db.exec("COMMIT");
      return next;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
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
