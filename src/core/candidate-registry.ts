import { createHash, randomUUID } from "node:crypto";
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
  live: {
    candidateHead?: string;
    candidateDirty?: boolean;
    mainHead?: string;
    mainDirty?: boolean;
    completionStale: boolean;
    recoveryReady: boolean;
  };
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

/** Identifiers minted once per idempotency key so a retried mutation reuses them instead of duplicating work. */
interface ReservedIdentifiers {
  taskId: string;
  candidateId?: string;
  checkpointId?: string;
  completionId?: string;
}

const SCHEMA_VERSION = 3;
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
  #closed = false;

  constructor(dataDirectory: string, options: {
    now?: () => number;
    maxFiles?: number;
    /** Test/embedded-code dependency injection; the shipped service leaves this unset. */
    gitBroker?: GitBroker;
  } = {}) {
    this.#dataDirectory = realpathSync(dataDirectory);
    this.#now = options.now ?? Date.now;
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
    const mainBranch = (await this.#gitCommand(mainPath, ["branch", "--show-current"], 16_384)).trim();
    if (!mainBranch || mainBranch.length > 255 || mainBranch.includes("\0")) throw new Error("CANDIDATE_MAIN_BRANCH_REQUIRED");
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
    const mainState = await this.#git.inspect(task.mainPath);
    const mainIgnored = await this.#ignoredInventory(task.mainPath);
    const mainHead = await this.#git.headSha(task.mainPath);
    const diff = await this.#diff(task.baseMainHead, candidate.headSha, candidate.workspace);
    // Simulated in the candidate worktree against the observed main head. Nothing about main is
    // written, checked out or refreshed; the owner is simply no longer asked to approve a merge
    // whose conflicts are unknown until it is attempted.
    const merge = await this.#mergePreview(candidate.workspace, mainHead, candidate.headSha);
    const checkpointId = reservedCheckpointId;
    const recoveryRef = this.#checkpointRef(task.taskId, checkpointId);
    const preview: CandidateCompletionPreview = {
      baseMainHead: task.baseMainHead,
      candidateHead: candidate.headSha,
      mainHead,
      mainDrift: mainHead !== task.baseMainHead,
      candidatePath: task.candidatePath,
      mainPath: task.mainPath,
      ...diff,
      tests: checkedTests,
      knownRisks: checkedRisks,
      conflicts: [
        ...(mainHead === task.baseMainHead ? [] : ["MAIN_DRIFT_REQUIRES_FRESH_MERGE_PREVIEW"]),
        ...(task.baseline.clean ? [] : ["DIRTY_MAIN_BASELINE_WAS_RECORDED_BUT_NOT_COPIED_TO_CANDIDATE"]),
        ...(mainState.clean ? [] : ["CURRENT_DIRTY_MAIN_CHANGES_ARE_EXCLUDED_FROM_CANDIDATE"]),
      ],
      ...merge,
      mainDirty: baseline(mainState, mainIgnored),
      recovery: { ready: true, kind: "git-checkpoint-ref", ref: recoveryRef, head: candidate.headSha },
    };
    const previewDigest = sha(JSON.stringify(preview));
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
  } {
    this.#assertOpen();
    const row = this.#db.prepare(`SELECT
      (SELECT COUNT(*) FROM candidates) tasks,
      (SELECT COUNT(*) FROM candidates WHERE status IN ('creating','active')) active,
      (SELECT COUNT(*) FROM candidates WHERE status='completed') completed,
      (SELECT COUNT(*) FROM candidate_checkpoints) checkpoints,
      (SELECT COUNT(*) FROM candidate_requests) requests,
      (SELECT COUNT(*) FROM candidate_requests WHERE state='pending') requestsPending`).get() as
      { tasks: number; active: number; completed: number; checkpoints: number; requests: number; requestsPending: number };
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
      largeFileScanTruncated: fileCount > files.length,
    };
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
      PRAGMA user_version=${SCHEMA_VERSION}; COMMIT;`);
  }

  /**
   * v1 stores only candidates and checkpoints. Adding the request ledger is additive, so existing
   * rows are left byte-identical and their hashes stay valid; a failure rolls the whole step back.
   */
  #upgrade(from: number): void {
    if (from === 1) {
      // v1 holds only candidates and checkpoints. Adding the request ledger is additive, so existing
      // rows stay byte-identical and their hashes stay valid.
      this.#db.exec(`BEGIN IMMEDIATE;
        ${REQUESTS_TABLE_SQL}
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
    tests(completion.preview.tests);
    risks(completion.preview.knownRisks);
    const preview = completion.preview;
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
    // candidate_requests is deliberately NOT verified here. It is an advisory retry ledger, while
    // candidates and candidate_checkpoints are the authoritative record. Failing the constructor on
    // one unreadable retry row would make the durable candidate data unreachable — the opposite of
    // what this table exists for. Each row is validated by #assertRequestRow when it is read, so a
    // corrupt row poisons only its own idempotency key.
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("CANDIDATE_REGISTRY_CLOSED");
  }
}
