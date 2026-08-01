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
  largeFiles: string[];
  largeFileScanTruncated: boolean;
  tests: CandidateTestResult[];
  knownRisks: string[];
  conflicts: string[];
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

const SCHEMA_VERSION = 1;
const MAX_LIST = 100;
const MAX_TESTS = 32;
const MAX_RISKS = 32;
const MAX_STATUS_SUMMARY = 16_000;
const LARGE_FILE_BYTES = 5 * 1_048_576;
const CREATING_RECOVERY_GRACE_MS = 5 * 60_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ROOM_PATTERN = /^[a-z][a-z0-9-]{0,47}$/u;
const HEAD_PATTERN = /^[0-9a-f]{40,64}$/u;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const CHECKPOINT_REF_PATTERN = /^refs\/orchestratory\/checkpoints\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/u;

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

/** Durable candidate lifecycle metadata; it does not constrain native host capabilities. */
export class CandidateRegistry {
  readonly path: string;
  readonly #dataDirectory: string;
  readonly #db: DatabaseSync;
  readonly #worktrees: WorktreeBroker;
  readonly #git: GitBroker;
  readonly #now: () => number;
  readonly #maxFiles: number;
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
    const inspection = await this.#git.inspect(mainPath);
    const ignored = await this.#ignoredInventory(mainPath);
    const baseMainHead = await this.#git.headSha(mainPath);
    const mainBranch = (await this.#gitCommand(mainPath, ["branch", "--show-current"], 16_384)).trim();
    if (!mainBranch || mainBranch.length > 255 || mainBranch.includes("\0")) throw new Error("CANDIDATE_MAIN_BRANCH_REQUIRED");
    const taskId = randomUUID();
    const candidateId = randomUUID();
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
      return this.#transition(row, { status: "active", updated_at_ms: this.#now() });
    } catch (error) {
      try { this.#transition(row, { status: "failed", updated_at_ms: this.#now() }); } catch { /* retain original failure */ }
      throw error;
    }
  }

  async checkpoint(input: { taskId: string; roomId: string; mainPath: string; summary: string }): Promise<CandidateCheckpoint> {
    this.#assertOpen();
    const task = await this.#activeScoped(input.taskId, input.roomId, input.mainPath);
    const expectedRowHash = this.#rowByTask(task.taskId)?.row_hash;
    if (!expectedRowHash) throw new Error("CANDIDATE_CONCURRENT_UPDATE");
    const summary = text(input.summary, "CANDIDATE_CHECKPOINT_SUMMARY_INVALID", 2_000);
    const candidate = await this.#worktrees.inspectCandidate(task.candidateId);
    if (candidate.workspace !== task.candidatePath || candidate.sourceWorkspace !== task.mainPath
      || candidate.branch !== task.candidateBranch) throw new Error("CANDIDATE_WORKTREE_SCOPE_MISMATCH");
    const state = await this.#git.inspect(candidate.workspace);
    if (!state.clean) throw new Error("CANDIDATE_CHECKPOINT_REQUIRES_CLEAN_WORKTREE");
    const now = this.#now();
    const checkpointId = randomUUID();
    const recoveryRef = this.#checkpointRef(task.taskId, checkpointId);
    await this.#createCheckpointRef(task.mainPath, recoveryRef, candidate.headSha);
    const bare: Omit<CheckpointRow, "row_hash"> = {
      id: checkpointId,
      task_id: task.taskId,
      candidate_head: candidate.headSha,
      recovery_ref: recoveryRef,
      summary,
      created_at_ms: now,
    };
    const row = { ...bare, row_hash: checkpointHash(bare) };
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.#rowByTask(task.taskId);
      if (!current || current.row_hash !== expectedRowHash || current.status !== "active") {
        throw new Error("CANDIDATE_CONCURRENT_UPDATE");
      }
      this.#db.prepare("INSERT INTO candidate_checkpoints VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(row.id, row.task_id, row.candidate_head, row.recovery_ref, row.summary, row.created_at_ms, row.row_hash);
      this.#replace(current, this.#mutate(current, { updated_at_ms: now }));
      this.#db.exec("COMMIT");
      return this.#publicCheckpoint(row);
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  async complete(input: {
    taskId: string;
    roomId: string;
    mainPath: string;
    summary: string;
    tests?: unknown;
    knownRisks?: unknown;
  }): Promise<{ task: CandidateTask; completion: CandidateCompletion; checkpoint: CandidateCheckpoint }> {
    this.#assertOpen();
    const task = await this.#activeScoped(input.taskId, input.roomId, input.mainPath);
    const expectedRowHash = this.#rowByTask(task.taskId)?.row_hash;
    if (!expectedRowHash) throw new Error("CANDIDATE_CONCURRENT_UPDATE");
    const summary = text(input.summary, "CANDIDATE_COMPLETION_SUMMARY_INVALID", 4_000);
    const checkedTests = tests(input.tests);
    const checkedRisks = risks(input.knownRisks);
    const candidate = await this.#worktrees.inspectCandidate(task.candidateId);
    if (candidate.workspace !== task.candidatePath || candidate.sourceWorkspace !== task.mainPath
      || candidate.branch !== task.candidateBranch) throw new Error("CANDIDATE_WORKTREE_SCOPE_MISMATCH");
    const candidateState = await this.#git.inspect(candidate.workspace);
    if (!candidateState.clean) throw new Error("CANDIDATE_COMPLETION_REQUIRES_CLEAN_WORKTREE");
    const mainState = await this.#git.inspect(task.mainPath);
    const mainIgnored = await this.#ignoredInventory(task.mainPath);
    const mainHead = await this.#git.headSha(task.mainPath);
    const diff = await this.#diff(task.baseMainHead, candidate.headSha, candidate.workspace);
    const checkpointId = randomUUID();
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
      mainDirty: baseline(mainState, mainIgnored),
      recovery: { ready: true, kind: "git-checkpoint-ref", ref: recoveryRef, head: candidate.headSha },
    };
    const previewDigest = sha(JSON.stringify(preview));
    const completionId = randomUUID();
    const createdAtMs = this.#now();
    const prompt = [
      `我已在 candidate ${task.candidatePath} 完成工作，尚未修改 main ${task.mainPath}。`,
      `Candidate HEAD ${candidate.headSha}；main HEAD ${mainHead}；preview ${previewDigest}。`,
      `檔案 ${preview.fileCount} 個，新增 ${preview.additions} 行，刪除 ${preview.deletions} 行。`,
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
    await this.#createCheckpointRef(task.mainPath, recoveryRef, candidate.headSha);
    const completionJson = JSON.stringify(completion);
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
      this.#db.exec("COMMIT");
      return {
        task: this.#public(next),
        completion,
        checkpoint: this.#publicCheckpoint(checkpointRow),
      };
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
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
    let activated = 0;
    let failed = 0;
    for (const observed of rows) {
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
  } {
    this.#assertOpen();
    const row = this.#db.prepare(`SELECT
      (SELECT COUNT(*) FROM candidates) tasks,
      (SELECT COUNT(*) FROM candidates WHERE status IN ('creating','active')) active,
      (SELECT COUNT(*) FROM candidates WHERE status='completed') completed,
      (SELECT COUNT(*) FROM candidate_checkpoints) checkpoints`).get() as
      { tasks: number; active: number; completed: number; checkpoints: number };
    return { database: this.path, schemaVersion: SCHEMA_VERSION, databaseBytes: statSync(this.path).size, ...row };
  }

  integrity(): { schemaVersion: number; quickCheck: string; rowsValid: boolean } {
    this.#assertOpen();
    const quickCheck = String((this.#db.prepare("PRAGMA quick_check").get() as { quick_check?: string }).quick_check ?? "unknown");
    let rowsValid = true;
    try { this.#verify(); } catch { rowsValid = false; }
    return { schemaVersion: SCHEMA_VERSION, quickCheck, rowsValid };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
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

  async #createCheckpointRef(mainPath: string, ref: string, head: string): Promise<void> {
    if (!CHECKPOINT_REF_PATTERN.test(ref) || !HEAD_PATTERN.test(head)) throw new Error("CANDIDATE_CHECKPOINT_REF_INVALID");
    await this.#gitCommand(mainPath, ["update-ref", ref, head, ""]);
    if (!await this.#checkpointRefMatches(mainPath, ref, head)) throw new Error("CANDIDATE_CHECKPOINT_REF_VERIFY_FAILED");
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

  async #diff(base: string, head: string, workspace: string): Promise<Pick<CandidateCompletionPreview,
    "files" | "fileCount" | "filesTruncated" | "additions" | "deletions" | "binaryEntries" |
    "largeFiles" | "largeFileScanTruncated">> {
    const files: CandidateFileChange[] = [];
    let fileCount = 0;
    let status: string | undefined;
    let first: string | undefined;
    await this.#gitNulTokens(
      workspace,
      ["diff", "--name-status", "-z", "--find-renames", base, head, "--"],
      (token) => {
        if (status === undefined) {
          if (!token) throw new Error("CANDIDATE_DIFF_INVALID");
          status = token;
          return;
        }
        const code = status[0];
        if ((code === "R" || code === "C") && first === undefined) {
          if (!token) throw new Error("CANDIDATE_DIFF_INVALID");
          first = token;
          return;
        }
        if (!token) throw new Error("CANDIDATE_DIFF_INVALID");
        fileCount += 1;
        if (files.length < this.#maxFiles) {
          if (code === "R" || code === "C") {
            files.push({ path: token, previousPath: first!, operation: code === "R" ? "rename" : "copy" });
          } else {
            const operation = code === "A" ? "add" : code === "M" ? "modify" : code === "D" ? "delete"
              : code === "T" ? "type-change" : code === "U" ? "unmerged" : "unknown";
            files.push({ path: token, operation });
          }
        }
        status = undefined;
        first = undefined;
      },
    );
    if (status !== undefined || first !== undefined) throw new Error("CANDIDATE_DIFF_INVALID");
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
      if (file.operation === "delete") continue;
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
      largeFiles,
      largeFileScanTruncated: fileCount > files.length,
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
      PRAGMA user_version=${SCHEMA_VERSION}; COMMIT;`);
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
    if (!HEAD_PATTERN.test(preview.baseMainHead) || !HEAD_PATTERN.test(preview.candidateHead)
      || !HEAD_PATTERN.test(preview.mainHead) || !isAbsolute(preview.candidatePath) || !isAbsolute(preview.mainPath)
      || !Array.isArray(preview.files) || !Array.isArray(preview.largeFiles) || !Array.isArray(preview.conflicts)
      || !Number.isSafeInteger(preview.fileCount) || preview.fileCount < preview.files.length
      || !Number.isSafeInteger(preview.additions) || preview.additions < 0
      || !Number.isSafeInteger(preview.deletions) || preview.deletions < 0
      || !Number.isSafeInteger(preview.binaryEntries) || preview.binaryEntries < 0
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
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("CANDIDATE_REGISTRY_CLOSED");
  }
}
