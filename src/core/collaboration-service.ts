import type { RoomMessage } from "./room-ledger.ts";
import { RoomLedger } from "./room-ledger.ts";
import { recordTelemetryCounter } from "./telemetry.ts";
import {
  managedAgentDisplayName,
  ManagedRoomAgentStore,
  type ManagedAgentProvider,
  type ManagedRoomAgent,
} from "./managed-room-agent.ts";
import {
  RoomPresenceStore,
  type PresenceCollaborationMode,
  type PresenceHookInput,
  type PresenceInfo,
  type PresenceRegistration,
} from "./room-presence.ts";
import {
  RoomInboxStore,
  type ClaimedRoomDelivery,
  type RoomDelivery,
  type RoomDeliveryOutcome,
} from "./room-inbox.ts";
import { safeSummary } from "../security/redact.ts";
import { realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  WriterLeaseStore,
  type GrantedWriterLease,
  type WriterIdentity,
  type WriterLease,
  type WriterProvider,
} from "./writer-lease.ts";
import {
  WriterDelegationStore,
  type GrantedWriterDelegation,
  type WriterDelegation,
} from "./writer-delegation.ts";
import { WorktreeBroker } from "./worktree-broker.ts";
import { CollaborationAuditLog, type AuditOutcome } from "./collaboration-audit.ts";
import {
  CandidateRegistry,
  MERGE_APPROVAL_CONFIRMATION,
  MergeApprovalBindingError,
  MergeApprovalBindingUnverifiableError,
  type CandidateCheckpoint,
  type CandidateCompletion,
  type CandidateTask,
  type CandidateTaskStatus,
  type MergeApproval,
  type MergeApprovalBindingCheck,
  type MergeApprovalDriftEvent,
  type MergePromotion,
  type MergePromotionEvent,
  type MergePromotionResult,
  type MergeApprovalPreview,
} from "./candidate-registry.ts";

export type WriterCandidate =
  | { origin: "resident"; provider: WriterProvider }
  | { origin: "managed"; actorId: string };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function ledgerSummary(value: string, maxLength = 320): string {
  return safeSummary(value, maxLength).replace(/[\r\n\t]+/gu, " ");
}

export interface CollaborationRoomView {
  sessions: Array<PresenceInfo & {
    kind: "external-pull";
    executionClass: "native-full-trust";
    capabilityAuthority: "host";
    hostCapabilities: "unchanged";
    wakeMode: "active-tool-pull";
    listening: boolean;
    wakeable: boolean;
  }>;
  deliveries: RoomDelivery[];
  managedAgents: ManagedRoomAgent[];
  writerLeases: WriterLease[];
  writerDelegations: WriterDelegation[];
}

export interface WriterWorktreeLifecycle {
  begin(input: {
    runId: string;
    roomId: string;
    taskId: string;
    workspace: string;
    worktree: string;
  }): Promise<void>;
  fail(runId: string, reason: string): Promise<void>;
}

/**
 * Shared room control plane used by GUI, TUI and MCP processes.
 *
 * Each process owns one service instance, while SQLite WAL + the append-only room
 * ledger provide the cross-process source of truth and global per-room sequence.
 */
export class CollaborationService {
  readonly ledger: RoomLedger;
  readonly presence: RoomPresenceStore;
  readonly inbox: RoomInboxStore;
  readonly managedAgents: ManagedRoomAgentStore;
  readonly writerLeases: WriterLeaseStore;
  readonly writerDelegations: WriterDelegationStore;
  readonly audit: CollaborationAuditLog;
  readonly candidates: CandidateRegistry;
  readonly #worktrees: WorktreeBroker;
  readonly #writerWorktrees: WriterWorktreeLifecycle | undefined;
  readonly #dataDirectory: string;
  readonly #ownerPromotionsInFlight = new Set<string>();
  #closed = false;

  constructor(dataDirectory: string, options: {
    writerWorktrees?: WriterWorktreeLifecycle;
    maxCandidateFiles?: number;
  } = {}) {
    this.#dataDirectory = dataDirectory;
    this.ledger = new RoomLedger(dataDirectory);
    this.presence = new RoomPresenceStore(dataDirectory);
    this.inbox = new RoomInboxStore(dataDirectory);
    this.managedAgents = new ManagedRoomAgentStore(dataDirectory);
    this.writerLeases = new WriterLeaseStore(dataDirectory);
    this.writerDelegations = new WriterDelegationStore(dataDirectory);
    this.audit = new CollaborationAuditLog(dataDirectory);
    this.candidates = new CandidateRegistry(dataDirectory, {
      ...(options.maxCandidateFiles === undefined ? {} : { maxFiles: options.maxCandidateFiles }),
      onMergeApprovalInvalidated: (event) => this.#recordMergeApprovalDrift(event),
      onMergePromotion: (event) => this.#recordMergePromotion(event),
    });
    this.#worktrees = new WorktreeBroker(dataDirectory);
    this.#writerWorktrees = options.writerWorktrees;
  }

  roomView(roomId: string, workspace: string): CollaborationRoomView {
    this.#assertRoomWorkspace(roomId, workspace);
    this.#reconcileUnavailableDeliveries(roomId, workspace, "SEAT_OFFLINE");
    const sessions = this.presence.list(workspace, roomId);
    return {
      sessions: sessions
        .filter((session) => session.joined || session.requested)
        .map((session) => {
          const listening = session.joined && session.standbyApproved &&
            this.inbox.isListening(session.id, roomId);
          return {
            ...session,
            kind: "external-pull" as const,
            executionClass: "native-full-trust" as const,
            capabilityAuthority: "host" as const,
            hostCapabilities: "unchanged" as const,
            wakeMode: "active-tool-pull" as const,
            listening,
            wakeable: listening,
          };
        }),
      deliveries: this.inbox.list(roomId),
      managedAgents: this.managedAgents.list(roomId),
      writerLeases: this.writerLeases.list(roomId),
      writerDelegations: this.writerDelegations.list(roomId),
    };
  }

  reconcileExternalPresence(roomId: string, workspace: string): RoomDelivery[] {
    this.#assertRoomWorkspace(roomId, workspace);
    return this.#reconcileUnavailableDeliveries(roomId, workspace, "SEAT_OFFLINE");
  }

  requestExternalJoin(presenceId: string, roomId: string, workspace: string): PresenceInfo {
    this.#assertRoomWorkspace(roomId, workspace);
    return this.presence.requestJoin(presenceId, roomId, workspace);
  }

  cancelExternalJoinRequest(presenceId: string, roomId: string, workspace: string): PresenceInfo {
    this.#assertRoomWorkspace(roomId, workspace);
    const current = this.presence.get(presenceId);
    if (!current || current.workspace !== workspace) throw new Error("PRESENCE_NOT_FOUND");
    return this.presence.cancelJoinRequest(presenceId, roomId);
  }

  requestExternalStandby(presenceId: string, roomId: string, workspace: string): PresenceInfo {
    this.#assertRoomWorkspace(roomId, workspace);
    const current = this.presence.get(presenceId);
    if (!current || current.workspace !== workspace) throw new Error("PRESENCE_NOT_FOUND");
    const requested = this.presence.requestStandby(presenceId, roomId);
    if (!current.standbyRequested && !current.standbyApproved && requested.standbyRequested) {
      this.ledger.appendSystem(roomId, `${requested.displayName ?? requested.provider} 申請 room-wait 待命（等待 GUI 核准）`);
    }
    return requested;
  }

  cancelExternalStandbyRequest(presenceId: string, roomId: string, workspace: string): PresenceInfo {
    this.#assertRoomWorkspace(roomId, workspace);
    const current = this.presence.get(presenceId);
    if (!current || current.workspace !== workspace) throw new Error("PRESENCE_NOT_FOUND");
    return this.presence.cancelStandbyRequest(presenceId, roomId);
  }

  approveExternalStandby(presenceId: string, roomId: string, workspace: string): PresenceInfo {
    this.#assertRoomWorkspace(roomId, workspace);
    const current = this.presence.get(presenceId);
    if (!current || current.workspace !== workspace) throw new Error("PRESENCE_NOT_FOUND");
    const approved = this.presence.approveStandby(presenceId, roomId);
    if (!current.standbyApproved) {
      this.ledger.appendSystem(roomId, `${approved.displayName ?? approved.provider} 的 room-wait 待命申請已核准`);
    }
    return approved;
  }

  revokeExternalStandby(presenceId: string, roomId: string, workspace: string): PresenceInfo {
    this.#assertRoomWorkspace(roomId, workspace);
    const current = this.presence.get(presenceId);
    if (!current || current.workspace !== workspace) throw new Error("PRESENCE_NOT_FOUND");
    const revoked = this.presence.revokeStandby(presenceId, roomId);
    if (current.standbyApproved || current.standbyRequested) {
      this.ledger.appendSystem(roomId, `${revoked.displayName ?? revoked.provider} 的 room-wait 待命已撤銷`);
    }
    return revoked;
  }

  approveExternalJoin(input: {
    presenceId: string;
    roomId: string;
    workspace: string;
    collaborationMode: PresenceCollaborationMode;
    syncTurns: boolean;
    label?: string;
  }): PresenceInfo {
    this.#assertRoomWorkspace(input.roomId, input.workspace);
    const before = this.presence.get(input.presenceId);
    const joined = this.presence.join(input.presenceId, input.roomId, input.workspace, {
      collaborationMode: input.collaborationMode,
      syncTurns: input.syncTurns,
      ...(input.label ? { label: input.label } : {}),
    });
    if (this.managedAgents.list(input.roomId).some((agent) => agent.displayName === joined.displayName)) {
      this.presence.leave(input.presenceId, input.roomId);
      throw new Error("PRESENCE_DISPLAY_NAME_IN_USE");
    }
    if (before?.roomId !== input.roomId) {
      const mode = joined.collaborationMode === "room-first" ? "全程帳本協作" : "僅加入席位";
      const turns = joined.syncTurns ? "終端對話同步已開啟" : "終端對話同步未開啟";
      this.ledger.appendSystem(input.roomId, `${joined.displayName} 已加入辦公室（${mode}；${turns}）`);
    }
    return joined;
  }

  removeExternal(input: { presenceId: string; roomId: string; workspace: string }): PresenceInfo {
    this.#assertRoomWorkspace(input.roomId, input.workspace);
    const before = this.presence.get(input.presenceId);
    if (!before || before.workspace !== input.workspace || before.roomId !== input.roomId) {
      throw new Error("PRESENCE_NOT_JOINED");
    }
    this.#revokeWriterIdentity(input.presenceId, "外接席位已由 Owner 移除");
    const pending = this.inbox.list(input.roomId).filter(
      (delivery) => delivery.targetPresenceId === input.presenceId,
    );
    const left = this.presence.leave(input.presenceId, input.roomId);
    for (const delivery of pending) {
      this.inbox.failDeliveryIfTargetUnavailable({
        deliveryId: delivery.id,
        targetPresenceId: input.presenceId,
        reason: "SEAT_REMOVED_BY_OWNER",
      });
    }
    this.ledger.appendSystem(input.roomId, `${before.displayName ?? before.provider} 已離開辦公室`);
    return left;
  }

  postToExternal(input: { roomId: string; workspace: string; presenceId: string; text: string }): {
    message: RoomMessage;
    target: PresenceInfo;
    delivery: RoomDelivery;
    dispatch: { wakeMode: "active-tool-pull"; wakeable: boolean; immediate: boolean };
  } {
    this.#assertRoomWorkspace(input.roomId, input.workspace);
    if (typeof input.text !== "string" || input.text.trim().length < 1) throw new Error("INVALID_PRESENCE_MESSAGE");
    const target = this.presence.get(input.presenceId);
    if (!target || target.workspace !== input.workspace || !target.joined || target.roomId !== input.roomId || !target.displayName) {
      throw new Error("TARGET_AGENT_OFFLINE");
    }
    if (!target.standbyApproved) throw new Error("TARGET_AGENT_STANDBY_NOT_APPROVED");
    const message = this.ledger.append(input.roomId, "you", `@${target.displayName} ${input.text}`);
    try {
      const delivery = this.inbox.enqueue({
        message,
        targetPresenceId: target.id,
        targetDisplayName: target.displayName,
      });
      const wakeable = this.inbox.isListening(target.id, input.roomId);
      return {
        message,
        target,
        delivery,
        dispatch: { wakeMode: "active-tool-pull", wakeable, immediate: wakeable },
      };
    } catch (error) {
      try {
        this.ledger.appendSystem(
          input.roomId,
          `⚠ #${message.seq} 無法投遞給 ${target.displayName}：${safeSummary(error instanceof Error ? error.message : "DELIVERY_FAILED", 160)}`,
        );
      } catch { /* preserve the original delivery failure */ }
      throw error;
    }
  }

  postBetweenExternals(input: {
    roomId: string;
    workspace: string;
    sourcePresenceId: string;
    targetPresenceId: string;
    text: string;
    threadId?: string;
    replyToDeliveryId?: string;
    clientRequestId: string;
    taskId?: string;
  }): {
    message: RoomMessage;
    source: PresenceInfo;
    target: PresenceInfo;
    delivery: RoomDelivery;
    dispatch: { wakeMode: "active-tool-pull"; wakeable: boolean; immediate: boolean };
  } {
    this.#assertRoomWorkspace(input.roomId, input.workspace);
    if (typeof input.text !== "string" || input.text.trim().length < 1) {
      throw new Error("INVALID_PRESENCE_MESSAGE");
    }
    const source = this.presence.get(input.sourcePresenceId);
    const target = this.presence.get(input.targetPresenceId);
    if (
      !source || source.workspace !== input.workspace || !source.joined ||
      source.roomId !== input.roomId || !source.displayName
    ) throw new Error("SOURCE_AGENT_OFFLINE");
    if (
      !target || target.workspace !== input.workspace || !target.joined ||
      target.roomId !== input.roomId || !target.displayName
    ) throw new Error("TARGET_AGENT_OFFLINE");
    if (source.id === target.id) throw new Error("ROOM_DELIVERY_SELF_TARGET");
    if (!target.standbyApproved) throw new Error("TARGET_AGENT_STANDBY_NOT_APPROVED");
    const sourceAvailable = (): boolean => {
      const current = this.presence.get(source.id);
      return Boolean(
        current?.workspace === input.workspace && current.joined &&
        current.roomId === input.roomId && current.displayName === source.displayName,
      );
    };
    const targetAvailable = (): boolean => {
      const current = this.presence.get(target.id);
      return Boolean(
        current?.workspace === input.workspace && current.joined &&
        current.roomId === input.roomId && current.displayName === target.displayName &&
        current.standbyApproved,
      );
    };
    if (!UUID_PATTERN.test(input.clientRequestId)) throw new Error("INVALID_CLIENT_REQUEST_ID");
    if (input.taskId && UUID_PATTERN.test(input.taskId)) {
      const candidate = this.candidates.get(input.taskId);
      if (candidate && (candidate.roomId !== input.roomId || !this.#sameWorkspace(candidate.mainPath, input.workspace))) {
        throw new Error("CANDIDATE_DELIVERY_SCOPE_MISMATCH");
      }
    }
    if ((input.threadId === undefined) !== (input.replyToDeliveryId === undefined)) {
      throw new Error("THREAD_CONTINUATION_FIELDS_MISMATCH");
    }
    if (input.replyToDeliveryId !== undefined) {
      const previous = this.inbox.get(input.replyToDeliveryId);
      if (!previous) throw new Error("REPLY_TO_DELIVERY_NOT_FOUND");
      if (previous.roomId !== input.roomId) throw new Error("THREAD_ROOM_MISMATCH");
      if (!previous.sourcePresenceId) throw new Error("THREAD_PARTICIPANT_MISMATCH");
      const participants = new Set([previous.sourcePresenceId, previous.targetPresenceId]);
      if (!participants.has(source.id) || !participants.has(target.id)) throw new Error("THREAD_PARTICIPANT_MISMATCH");
      if (input.threadId !== undefined && input.threadId !== previous.threadId) throw new Error("THREAD_ID_MISMATCH");
      if ((previous.taskId ?? null) !== (input.taskId ?? null)) throw new Error("THREAD_TASK_MISMATCH");
    }
    const message = this.ledger.appendIdempotent(
      input.roomId,
      source.displayName,
      `@${target.displayName} ${input.text}`,
      `peer-send:${source.id}:${input.clientRequestId}`,
    );
    try {
      if (!sourceAvailable()) throw new Error("SOURCE_AGENT_OFFLINE");
      if (!targetAvailable()) throw new Error("TARGET_AGENT_OFFLINE");
      const delivery = this.inbox.enqueue({
        message,
        sourcePresenceId: source.id,
        sourceDisplayName: source.displayName,
        targetPresenceId: target.id,
        targetDisplayName: target.displayName,
        ...(input.threadId ? { threadId: input.threadId } : {}),
        ...(input.replyToDeliveryId ? { replyToDeliveryId: input.replyToDeliveryId } : {}),
        clientRequestId: input.clientRequestId,
        ...(input.taskId ? { taskId: input.taskId } : {}),
      });
      if (!sourceAvailable()) {
        this.inbox.cancel(delivery.id);
        throw new Error("SOURCE_AGENT_OFFLINE");
      }
      if (!targetAvailable()) {
        this.inbox.failDeliveryIfTargetUnavailable({
          deliveryId: delivery.id,
          targetPresenceId: target.id,
          reason: "SEAT_OFFLINE_DURING_SEND",
        });
        throw new Error("TARGET_AGENT_OFFLINE");
      }
      const wakeable = this.inbox.isListening(target.id, input.roomId);
      return {
        message,
        source,
        target,
        delivery,
        dispatch: { wakeMode: "active-tool-pull", wakeable, immediate: wakeable },
      };
    } catch (error) {
      try {
        this.ledger.appendSystem(
          input.roomId,
          `⚠ #${message.seq} 無法由 ${source.displayName} 投遞給 ${target.displayName}：${safeSummary(
            error instanceof Error ? error.message : "DELIVERY_FAILED",
            160,
          )}`,
        );
      } catch { /* preserve the original delivery failure */ }
      throw error;
    }
  }

  async waitForExternalReply(input: {
    presenceId: string;
    deliveryId: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<RoomDeliveryOutcome | undefined> {
    const delivery = this.inbox.get(input.deliveryId);
    if (!delivery || delivery.sourcePresenceId !== input.presenceId) {
      throw new Error("DELIVERY_NOT_FOUND");
    }
    this.presence.actorFor(input.presenceId, delivery.roomId);
    const canContinue = () => {
      const source = this.presence.get(input.presenceId);
      if (!source?.joined || source.roomId !== delivery.roomId) return false;
      const target = this.presence.get(delivery.targetPresenceId);
      if (
        !target?.joined || target.roomId !== delivery.roomId ||
        target.workspace !== source.workspace || target.displayName !== delivery.targetDisplayName
      ) {
        this.inbox.failDeliveryIfTargetUnavailable({
          deliveryId: delivery.id,
          targetPresenceId: delivery.targetPresenceId,
          reason: "TARGET_SEAT_OFFLINE_DURING_REPLY_WAIT",
        });
      }
      return true;
    };
    return await this.inbox.waitForReply({
      sourcePresenceId: input.presenceId,
      deliveryId: input.deliveryId,
      ledger: this.ledger,
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      ...(input.signal ? { signal: input.signal } : {}),
      canContinue,
    });
  }

  registerExternal(input: PresenceRegistration): PresenceInfo {
    return this.presence.register(input);
  }

  heartbeatExternal(presenceId: string): PresenceInfo {
    return this.presence.heartbeat(presenceId);
  }

  unregisterExternal(presenceId: string, reason = "SEAT_OFFLINE"): void {
    this.#revokeWriterIdentity(presenceId, `外接席位已離線：${ledgerSummary(reason, 160)}`);
    this.presence.unregister(presenceId);
    this.inbox.failTarget(presenceId, reason);
  }

  externalActor(presenceId: string, roomId: string): string {
    return this.presence.actorFor(presenceId, roomId);
  }

  async startCandidate(input: {
    presenceId: string;
    clientRequestId: unknown;
    roomId: string;
    workspace: string;
    task: string;
    acceptanceCriteria?: string;
  }): Promise<CandidateTask> {
    this.#assertRoomWorkspace(input.roomId, input.workspace);
    const actor = this.externalActor(input.presenceId, input.roomId);
    const candidate = await this.candidates.start({
      actor,
      clientRequestId: input.clientRequestId,
      roomId: input.roomId,
      mainPath: input.workspace,
      task: input.task,
      ...(input.acceptanceCriteria === undefined ? {} : { acceptanceCriteria: input.acceptanceCriteria }),
    });
    this.audit.append({
      roomId: input.roomId,
      taskId: candidate.taskId,
      type: "candidate.started",
      actor,
      executedBy: actor,
      action: "candidate-start",
      path: candidate.candidatePath,
      outcome: "succeeded",
      detail: {
        candidateId: candidate.candidateId,
        candidateBranch: candidate.candidateBranch,
        baseMainHead: candidate.baseMainHead,
        mainDirtyRecorded: !candidate.baseline.clean,
        mainMutation: false,
      },
    });
    this.#candidateLedger(input.roomId, candidate.taskId,
      `${actor} 已建立 candidate ${candidate.candidateId}（main 尚未修改）`, `candidate:${candidate.taskId}:started`);
    return candidate;
  }

  async checkpointCandidate(input: {
    presenceId: string;
    clientRequestId: unknown;
    roomId: string;
    workspace: string;
    taskId: string;
    summary: string;
  }): Promise<CandidateCheckpoint> {
    this.#assertRoomWorkspace(input.roomId, input.workspace);
    const actor = this.externalActor(input.presenceId, input.roomId);
    const checkpoint = await this.candidates.checkpoint({
      actor,
      clientRequestId: input.clientRequestId,
      taskId: input.taskId,
      roomId: input.roomId,
      mainPath: input.workspace,
      summary: input.summary,
    });
    this.audit.append({
      roomId: input.roomId, taskId: input.taskId, type: "candidate.checkpointed",
      actor, executedBy: actor, action: "candidate-checkpoint", outcome: "succeeded",
      detail: { checkpointId: checkpoint.id, candidateHead: checkpoint.candidateHead, mainMutation: false },
    });
    this.#candidateLedger(input.roomId, input.taskId,
      `${actor} 已建立 candidate checkpoint ${checkpoint.candidateHead.slice(0, 12)}（main 尚未修改）`,
      `candidate:${input.taskId}:checkpoint:${checkpoint.id}`);
    return checkpoint;
  }

  async completeCandidate(input: {
    presenceId: string;
    clientRequestId: unknown;
    roomId: string;
    workspace: string;
    taskId: string;
    summary: string;
    tests?: unknown;
    knownRisks?: unknown;
  }): Promise<{ task: CandidateTask; completion: CandidateCompletion; checkpoint: CandidateCheckpoint }> {
    this.#assertRoomWorkspace(input.roomId, input.workspace);
    const actor = this.externalActor(input.presenceId, input.roomId);
    const result = await this.candidates.complete({
      actor,
      clientRequestId: input.clientRequestId,
      taskId: input.taskId,
      roomId: input.roomId,
      mainPath: input.workspace,
      summary: input.summary,
      ...(input.tests === undefined ? {} : { tests: input.tests }),
      ...(input.knownRisks === undefined ? {} : { knownRisks: input.knownRisks }),
    });
    this.audit.append({
      roomId: input.roomId, taskId: input.taskId, type: "candidate.completed",
      actor, executedBy: actor, action: "candidate-complete", path: result.task.candidatePath,
      outcome: "succeeded",
      detail: {
        completionId: result.completion.id,
        candidateHead: result.completion.preview.candidateHead,
        mainHead: result.completion.preview.mainHead,
        previewDigest: result.completion.previewDigest,
        mergeDecision: "owner-required",
        mainMutation: false,
      },
    });
    this.#candidateLedger(input.roomId, input.taskId,
      `${actor} 已完成 candidate；main 尚未修改，後續 merge/promotion 必須由 Owner 明確核准。`,
      `candidate:${input.taskId}:completed:${result.completion.id}`);
    return result;
  }

  /** Read-only recompute of the snapshot an owner would be asked to approve. Writes nothing. */
  async previewMainMerge(input: {
    presenceId: string;
    roomId: string;
    workspace: string;
    taskId: string;
  }): Promise<MergeApprovalPreview> {
    this.#assertRoomWorkspace(input.roomId, input.workspace);
    this.externalActor(input.presenceId, input.roomId);
    return await this.candidates.previewMainMerge({
      taskId: input.taskId, roomId: input.roomId, mainPath: input.workspace,
    });
  }

  /**
   * An agent asking that the owner be asked. It creates a `requested` record and nothing else: no
   * token exists yet, so there is nothing here that could be mistaken for authority.
   */
  async requestMainMerge(input: {
    presenceId: string;
    clientRequestId: unknown;
    roomId: string;
    workspace: string;
    taskId: string;
    completionId: string;
    previewDigest: string;
  }): Promise<MergeApproval> {
    this.#assertRoomWorkspace(input.roomId, input.workspace);
    const actor = this.externalActor(input.presenceId, input.roomId);
    const approval = await this.candidates.requestMainMerge({
      actor,
      clientRequestId: input.clientRequestId,
      taskId: input.taskId,
      roomId: input.roomId,
      mainPath: input.workspace,
      completionId: input.completionId,
      previewDigest: input.previewDigest,
    });
    this.audit.append({
      roomId: input.roomId, taskId: input.taskId, type: "candidate.merge-approval-requested",
      actor, executedBy: actor, action: "main-merge-request", path: approval.binding.mainPath,
      outcome: "succeeded",
      detail: {
        approvalId: approval.id,
        completionId: approval.binding.completionId,
        candidateHead: approval.binding.candidateHead,
        mainHead: approval.binding.mainHead,
        mainBranch: approval.binding.mainBranch,
        previewDigest: approval.binding.previewDigest,
        recoveryRef: approval.binding.recoveryRef,
        grants: approval.grants,
        state: approval.state,
        mainMutation: false,
      },
    });
    this.#candidateLedger(input.roomId, input.taskId,
      `${actor} 要求 Owner 核准把 candidate snapshot ${approval.binding.candidateHead.slice(0, 12)} merge 進 main`
        + `（preview ${approval.binding.previewDigest.slice(0, 12)}）；尚未核准，main 未修改。`,
      `candidate:${input.taskId}:merge-approval:${approval.id}:requested`);
    return approval;
  }

  async listMergeApprovals(input: {
    roomId: string;
    workspace: string;
    taskId?: string;
  }): Promise<MergeApproval[]> {
    this.#assertRoomWorkspace(input.roomId, input.workspace);
    return await this.candidates.mergeApprovals({
      roomId: input.roomId,
      mainPath: input.workspace,
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
    });
  }

  async listMergeHistory(input: {
    roomId: string;
    workspace: string;
    taskId?: string;
  }): Promise<{
    promotions: Awaited<ReturnType<CandidateRegistry["promotions"]>>;
    unpromotedApprovals: MergeApproval[];
  }> {
    this.#assertRoomWorkspace(input.roomId, input.workspace);
    let promotions = await this.candidates.promotions({
      roomId: input.roomId,
      mainPath: input.workspace,
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
    });
    const started = new Set(promotions.flatMap((promotion) =>
      "approvalId" in promotion ? [promotion.approvalId] : []));
    let approvals = await this.candidates.mergeApprovals({
      roomId: input.roomId,
      mainPath: input.workspace,
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
    });
    // A durable grant with no intent row can only be left by the retired two-stage HTTP flow or by
    // a crash between grant and intent. The raw token is no longer available after restart, so it
    // is not authority waiting to be used; it is a failed owner operation waiting to be named.
    // Never race the live call in this process: it marks the approval before grant and holds the
    // mark until either an intent exists or the call has retired the grant itself.
    for (const approval of approvals) {
      if (approval.state !== "approved" || started.has(approval.id)
        || this.#ownerPromotionsInFlight.has(approval.id)) continue;
      try {
        await this.rejectMainMerge({
          roomId: input.roomId,
          workspace: input.workspace,
          approvalId: approval.id,
          decidedBy: "local-web",
          reason: "PROMOTION_NOT_STARTED_AFTER_GRANT",
        });
      } catch (error) {
        // A concurrent intent writer wins safely: re-read both stores rather than calling either
        // outcome "missing". Any other error remains visible to the caller.
        if (!(error instanceof Error) || error.message !== "MAIN_MERGE_APPROVAL_NOT_PENDING") throw error;
      }
    }
    promotions = await this.candidates.promotions({
      roomId: input.roomId,
      mainPath: input.workspace,
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
    });
    approvals = await this.candidates.mergeApprovals({
      roomId: input.roomId,
      mainPath: input.workspace,
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
    });
    const promoted = new Set(promotions.flatMap((promotion) =>
      "approvalId" in promotion ? [promotion.approvalId] : []));
    return {
      promotions,
      unpromotedApprovals: approvals.filter((approval) =>
        approval.state !== "requested" && !promoted.has(approval.id)),
    };
  }

  async inspectMergeApproval(input: {
    roomId: string;
    workspace: string;
    approvalId: string;
  }): Promise<ReturnType<CandidateRegistry["inspectMergeApproval"]>> {
    this.#assertRoomWorkspace(input.roomId, input.workspace);
    return await this.candidates.inspectMergeApproval({
      approvalId: input.approvalId, roomId: input.roomId, mainPath: input.workspace,
    });
  }

  /**
   * Creates a new owner question after a terminal approval that never started a promotion.
   *
   * This does not revive or copy authority from the old row. It proves there is no promotion record,
   * recomputes every live binding and gate, and writes a new `requested` row with a new idempotency
   * key. The browser receives no grant token and canonical main is not mutated.
   */
  async retryMainMergeApproval(input: {
    roomId: string;
    workspace: string;
    approvalId: string;
  }): Promise<{ approval: MergeApproval; supersedesApprovalId: string; mainMutation: false }> {
    this.#assertRoomWorkspace(input.roomId, input.workspace);
    const inspected = await this.candidates.inspectMergeApproval({
      approvalId: input.approvalId, roomId: input.roomId, mainPath: input.workspace,
    });
    const previous = inspected.approval;
    if (!new Set(["rejected", "invalidated", "expired"]).has(previous.state)) {
      throw new Error("MAIN_MERGE_APPROVAL_RETRY_NOT_ELIGIBLE");
    }
    if (await this.candidates.promotionForApproval({
      approvalId: previous.id, roomId: input.roomId, mainPath: input.workspace,
    })) {
      throw new Error("MAIN_MERGE_APPROVAL_RETRY_REQUIRES_HISTORY_REVIEW");
    }
    const preview = await this.candidates.previewMainMerge({
      taskId: previous.binding.taskId, roomId: input.roomId, mainPath: input.workspace,
    });
    if (!preview.approvable) throw new Error(`MAIN_MERGE_APPROVAL_RETRY_BLOCKED:${preview.blockers.join(",")}`);
    const approval = await this.candidates.requestMainMerge({
      actor: "you",
      clientRequestId: randomUUID(),
      taskId: previous.binding.taskId,
      roomId: input.roomId,
      mainPath: input.workspace,
      completionId: preview.completionId,
      previewDigest: preview.previewDigest,
    });
    this.audit.append({
      roomId: input.roomId, taskId: approval.binding.taskId,
      type: "candidate.merge-approval-requested", actor: "you", executedBy: "you",
      action: "main-merge-request", path: approval.binding.mainPath, outcome: "succeeded",
      detail: {
        approvalId: approval.id,
        supersedesApprovalId: previous.id,
        completionId: approval.binding.completionId,
        candidateHead: approval.binding.candidateHead,
        mainHead: approval.binding.mainHead,
        previewDigest: approval.binding.previewDigest,
        state: approval.state,
        freshSnapshot: true,
        mainMutation: false,
      },
    });
    this.#candidateLedger(input.roomId, approval.binding.taskId,
      `Owner 已針對終局核准 ${previous.id.slice(0, 8)} 重新建立 live preview；新核准 ${approval.id.slice(0, 8)}`
        + ` 綁定 candidate ${approval.binding.candidateHead.slice(0, 12)} 與 main ${approval.binding.mainHead.slice(0, 12)}`
        + `。這是新的 single-use 問題，尚未核准、尚未 Merge，main 未修改。`,
      `candidate:${approval.binding.taskId}:merge-approval:${approval.id}:requested`);
    return { approval, supersedesApprovalId: previous.id, mainMutation: false };
  }

  /**
   * The owner's decision. A refusal caused by drift is audited too — an approval that silently
   * disappeared would leave the owner unable to tell a stale snapshot from a lost one.
   */
  async grantMainMerge(input: {
    roomId: string;
    workspace: string;
    approvalId: string;
    previewDigest: string;
    confirmation: string;
    decidedBy: "local-web" | "local-tui";
  }): Promise<{ approval: MergeApproval; approvalToken: string; expiresAt: string }> {
    this.#assertRoomWorkspace(input.roomId, input.workspace);
    let granted;
    try {
      granted = await this.candidates.grantMainMerge({
        approvalId: input.approvalId,
        roomId: input.roomId,
        mainPath: input.workspace,
        previewDigest: input.previewDigest,
        confirmation: input.confirmation,
        decidedBy: input.decidedBy,
      });
    } catch (error) {
      if (error instanceof MergeApprovalBindingError) {
        this.audit.append({
          roomId: input.roomId, type: "candidate.merge-approval-invalidated", actor: "you",
          action: "main-merge-grant", outcome: "denied",
          detail: {
            approvalId: input.approvalId,
            changed: error.changed,
            ...(error.unverified.length > 0 ? { unverified: error.unverified } : {}),
            reason: "MAIN_MERGE_APPROVAL_BINDING_CHANGED",
            deletedByThisInvalidation: "nothing",
            mainMutation: false,
          },
        });
        this.#candidateLedger(input.roomId, undefined,
          `merge 核准已失效：綁定值改變（${error.changed.join("、")}）`
            + (error.unverified.length > 0
              ? `；本次另有無法讀取、因此未比對的欄位（${error.unverified.join("、")}）` : "")
            + `；這次失效沒有刪除 candidate、checkpoint 或復原點，也沒有修改 main，`
            + `請重新 preview 後再詢問。`,
          `candidate:merge-approval:${input.approvalId}:invalidated`);
      }
      if (error instanceof MergeApprovalBindingUnverifiableError) {
        // Refused, not invalidated: the approval is untouched and still answerable. It is audited so
        // an owner whose click did nothing can see why, and deliberately not written to the public
        // ledger — an unreadable repository is not a fact about the candidate, and a transient failure
        // that repeats would otherwise fill the room with notices about a decision that is still fine.
        this.audit.append({
          roomId: input.roomId, type: "candidate.merge-approval-check-unavailable", actor: "you",
          action: "main-merge-grant", outcome: "failed",
          detail: {
            approvalId: input.approvalId,
            reason: "MAIN_MERGE_APPROVAL_BINDING_CHECK_FAILED",
            unverified: error.unverified,
            approvalInvalidated: false,
            mainMutation: false,
          },
        });
      }
      throw error;
    }
    // The single-use token is deliberately absent from both the audit chain and the room ledger.
    this.audit.append({
      roomId: input.roomId, taskId: granted.approval.binding.taskId,
      type: "candidate.merge-approval-granted", actor: "you", action: "main-merge-grant",
      path: granted.approval.binding.mainPath, outcome: "succeeded",
      detail: {
        approvalId: granted.approval.id,
        decidedBy: input.decidedBy,
        candidateHead: granted.approval.binding.candidateHead,
        mainHead: granted.approval.binding.mainHead,
        mainBranch: granted.approval.binding.mainBranch,
        previewDigest: granted.approval.binding.previewDigest,
        grants: granted.approval.grants,
        notAuthorized: granted.approval.notAuthorized,
        singleUse: true,
        expiresAt: granted.expiresAt,
        mainMutation: false,
      },
    });
    this.#candidateLedger(input.roomId, granted.approval.binding.taskId,
      `Owner 已核准把 candidate snapshot ${granted.approval.binding.candidateHead.slice(0, 12)} merge 進 main`
        + `（preview ${granted.approval.binding.previewDigest.slice(0, 12)}）；single-use，${granted.expiresAt} 到期，`
        // The ledger is public and read by agents as well as by the owner. Without this clause a
        // grant line reads as though the merge already happened — and nothing later contradicts it,
        // because an unused grant only lapses quietly in its own row.
        + `僅授權 merge。本階段未寫入 main；實際 merge 屬後續階段。`,
      `candidate:merge-approval:${granted.approval.id}:granted`);
    return granted;
  }

  /**
   * The local Owner's one visible action: grant this exact snapshot and immediately spend that
   * authority on the one operation it names. The raw token never crosses the service boundary.
   *
   * A transport retry first reads the durable promotion by approval id. It therefore returns the
   * same answer after a lost response and can never issue a second Git command. If granting
   * succeeded but promotion never recorded an intent, the orphaned grant is retired explicitly;
   * once an intent exists, only the promotion observer may describe the outcome.
   */
  async approveAndPromoteMainMerge(input: {
    roomId: string;
    workspace: string;
    approvalId: string;
    previewDigest: string;
    confirmation: string;
    decidedBy: "local-web" | "local-tui";
  }): Promise<MergePromotionResult & { approval: MergeApproval; replayed: boolean }> {
    this.#assertRoomWorkspace(input.roomId, input.workspace);
    if (this.#ownerPromotionsInFlight.has(input.approvalId)) {
      throw new Error("MAIN_MERGE_PROMOTION_IN_FLIGHT");
    }
    this.#ownerPromotionsInFlight.add(input.approvalId);
    try {
      const existing = await this.candidates.promotionForApproval({
        approvalId: input.approvalId, roomId: input.roomId, mainPath: input.workspace,
      });
      if (existing) return await this.#replayedPromotion(input, existing);
      const beforeGrant = await this.candidates.inspectMergeApproval({
        approvalId: input.approvalId, roomId: input.roomId, mainPath: input.workspace,
      });
      if (beforeGrant.approval.state === "approved") {
        await this.rejectMainMerge({
          roomId: input.roomId,
          workspace: input.workspace,
          approvalId: input.approvalId,
          decidedBy: input.decidedBy,
          reason: "PROMOTION_NOT_STARTED_AFTER_GRANT",
        });
        throw new Error("MAIN_MERGE_APPROVAL_ORPHANED_NO_PROMOTION");
      }
      const granted = await this.grantMainMerge(input);
      try {
        const result = await this.candidates.promoteMainMerge({
          approvalId: granted.approval.id,
          token: granted.approvalToken,
          action: granted.approval.grants,
          taskId: granted.approval.binding.taskId,
          roomId: input.roomId,
          mainPath: input.workspace,
        });
        const inspected = await this.candidates.inspectMergeApproval({
          approvalId: input.approvalId, roomId: input.roomId, mainPath: input.workspace,
        });
        return { ...result, approval: inspected.approval, replayed: false };
      } catch (error) {
        const durable = await this.candidates.promotionForApproval({
          approvalId: input.approvalId, roomId: input.roomId, mainPath: input.workspace,
        });
        if (!durable) {
          // No intent row means no Git command could have started. Retiring the now-unspendable grant
          // prevents the UI from showing a live authority whose only token has already left memory.
          await this.rejectMainMerge({
            roomId: input.roomId,
            workspace: input.workspace,
            approvalId: input.approvalId,
            decidedBy: input.decidedBy,
            reason: "PROMOTION_NOT_STARTED_AFTER_GRANT",
          });
        }
        throw error;
      }
    } finally {
      this.#ownerPromotionsInFlight.delete(input.approvalId);
    }
  }

  async #replayedPromotion(input: {
    roomId: string;
    workspace: string;
    approvalId: string;
    previewDigest: string;
    confirmation: string;
    decidedBy: "local-web" | "local-tui";
  }, promotion: MergePromotion): Promise<MergePromotionResult & { approval: MergeApproval; replayed: boolean }> {
    const inspected = await this.candidates.inspectMergeApproval({
      approvalId: input.approvalId, roomId: input.roomId, mainPath: input.workspace,
    });
    // Retrying a successful HTTP request may recover its answer, but it may not broaden what was
    // approved or let a caller omit the same proof the original request required.
    if (input.confirmation !== MERGE_APPROVAL_CONFIRMATION) {
      throw new Error("MAIN_MERGE_CONFIRMATION_MISMATCH");
    }
    if (input.previewDigest !== inspected.approval.previewDigest) {
      throw new Error("MAIN_MERGE_PREVIEW_DIGEST_MISMATCH");
    }
    return {
      promotion,
      approval: inspected.approval,
      replayed: true,
      mainMutated: promotion.observation.authorizedMergeCommit === true,
      authorization: {
        approvalId: inspected.approval.id,
        grants: inspected.approval.grants,
        notAuthorized: inspected.approval.notAuthorized,
        singleUse: true,
        binding: inspected.approval.binding,
        preview: inspected.approval.preview,
        consumedAt: inspected.approval.updatedAt,
      },
    };
  }

  /** Refusing or withdrawing. It never deletes a candidate, a checkpoint or a recovery ref. */
  async rejectMainMerge(input: {
    roomId: string;
    workspace: string;
    approvalId: string;
    decidedBy: "local-web" | "local-tui";
    reason?: string;
  }): Promise<MergeApproval> {
    this.#assertRoomWorkspace(input.roomId, input.workspace);
    const approval = await this.candidates.rejectMainMerge({
      approvalId: input.approvalId,
      roomId: input.roomId,
      mainPath: input.workspace,
      decidedBy: input.decidedBy,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    });
    this.audit.append({
      roomId: input.roomId, taskId: approval.binding.taskId,
      type: "candidate.merge-approval-rejected", actor: "you", action: "main-merge-reject",
      outcome: "denied",
      detail: {
        approvalId: approval.id,
        decidedBy: input.decidedBy,
        reason: approval.refusal?.reason ?? null,
        // PITFALLS #86, the same shape that was already fixed on the invalidation path in 6f194af
        // and left standing here: `candidateRetained` / `checkpointsRetained` / `recoveryRefRetained`
        // were the constant `true`, so the record asserted that the recovery point was intact
        // whether or not it was — measured on the neighbouring path by deleting the recovery ref and
        // watching the entry still claim it was fully retained. A rejection cannot observe the state
        // of anything, because it deliberately runs no Git command at all, so it describes only what
        // it DID rather than declaring what now IS.
        deletedByThisRejection: "nothing",
        mainMutation: false,
      },
    });
    this.#candidateLedger(input.roomId, approval.binding.taskId,
      `Owner 未同意這次 main merge；這次拒絕沒有刪除 candidate、checkpoint 或復原點，也沒有修改 main，`
        + `可重新 preview 後再詢問。`,
      `candidate:merge-approval:${approval.id}:rejected`);
    return approval;
  }

  async candidateStatus(input: {
    presenceId: string;
    roomId: string;
    workspace: string;
    taskId?: string;
  }): Promise<CandidateTaskStatus[]> {
    this.#assertRoomWorkspace(input.roomId, input.workspace);
    this.externalActor(input.presenceId, input.roomId);
    return await this.candidates.status({
      roomId: input.roomId,
      mainPath: input.workspace,
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
    });
  }

  async waitExternal(input: { presenceId: string; roomId: string; timeoutMs?: number; signal?: AbortSignal }): Promise<ClaimedRoomDelivery | undefined> {
    this.presence.actorFor(input.presenceId, input.roomId);
    const approved = () => {
      const current = this.presence.get(input.presenceId);
      return Boolean(
        current?.joined &&
        current.roomId === input.roomId &&
        current.standbyApproved,
      );
    };
    if (!approved()) throw new Error("PRESENCE_STANDBY_NOT_APPROVED");
    return await this.inbox.wait({ ...input, ledger: this.ledger, canContinue: approved });
  }

  #reconcileUnavailableDeliveries(roomId: string, workspace: string, reason: string): RoomDelivery[] {
    const failed: RoomDelivery[] = [];
    const observed = this.inbox.list(roomId);
    for (const delivery of observed) {
      if (!["queued", "delivered", "read", "working"].includes(delivery.state)) continue;
      const target = this.presence.get(delivery.targetPresenceId);
      if (
        target?.joined && target.roomId === roomId && target.workspace === workspace &&
        target.displayName === delivery.targetDisplayName
      ) continue;
      const reconciled = this.inbox.failDeliveryIfTargetUnavailable({
        deliveryId: delivery.id,
        targetPresenceId: delivery.targetPresenceId,
        reason,
      });
      if (reconciled) failed.push(reconciled);
    }
    return failed;
  }

  ackExternal(input: { presenceId: string; deliveryId: string; leaseToken: string; phase: "read" | "working" }): RoomDelivery {
    this.#assertSeatDelivery(input.presenceId, input.deliveryId);
    return this.inbox.ack(input);
  }

  async replyExternal(input: { presenceId: string; deliveryId: string; leaseToken: string; text: string }): Promise<{ delivery: RoomDelivery; reply: RoomMessage }> {
    const delivery = this.#assertSeatDelivery(input.presenceId, input.deliveryId);
    const author = this.presence.actorFor(input.presenceId, delivery.roomId);
    return await this.inbox.reply({ ...input, ledger: this.ledger, author });
  }

  failExternal(input: { presenceId: string; deliveryId: string; leaseToken: string; reason: string }): RoomDelivery {
    this.#assertSeatDelivery(input.presenceId, input.deliveryId);
    return this.inbox.fail(input);
  }

  recordHook(input: PresenceHookInput): "recorded" | "ignored" | "duplicate" {
    return this.presence.recordHook(this.ledger, input);
  }

  createManaged(input: { roomId: string; workspace: string; provider: ManagedAgentProvider; model: string; label: string }): ManagedRoomAgent {
    this.#assertRoomWorkspace(input.roomId, input.workspace);
    const desiredName = managedAgentDisplayName(input.provider, input.label);
    if (this.presence.list(input.workspace, input.roomId).some((session) => session.displayName === desiredName)) {
      throw new Error("MANAGED_AGENT_DISPLAY_NAME_IN_USE");
    }
    const agent = this.managedAgents.create(input);
    this.ledger.appendSystem(
      input.roomId,
      `${agent.displayName} GUI Managed Agent 已建立（對話唯讀；寫入需另行 Owner Writer 授權）`,
    );
    return agent;
  }

  archiveManaged(agentId: string, roomId: string, workspace: string): ManagedRoomAgent {
    this.#assertRoomWorkspace(roomId, workspace);
    const agent = this.managedAgents.get(agentId);
    if (!agent || agent.roomId !== roomId || agent.workspace !== workspace) throw new Error("MANAGED_AGENT_NOT_FOUND");
    this.#revokeWriterIdentity(agentId, "受控即時 Agent 已由 Owner 移除");
    const archived = this.managedAgents.archive(agentId, roomId);
    this.ledger.appendSystem(roomId, `${archived.displayName} 受控即時 Agent 已移除`);
    return archived;
  }

  async grantWriter(input: {
    taskId: string;
    roomId: string;
    workspace: string;
    candidate: WriterCandidate;
  }): Promise<GrantedWriterLease> {
    this.#assertRoomWorkspace(input.roomId, input.workspace);
    const writer = this.#resolveWriter(input.candidate, input.roomId, input.workspace);
    const existing = this.writerLeases.taskScope(input.taskId);
    if (existing) {
      if (existing.roomId !== input.roomId || existing.workspace !== input.workspace) throw new Error("WRITER_TASK_SCOPE_MISMATCH");
      if (existing.active) throw new Error("WRITER_LEASE_ALREADY_ACTIVE");
      try {
        realpathSync(existing.worktree);
      } catch {
        throw new Error("WRITER_RETAINED_WORKTREE_MISSING");
      }
      const granted = this.writerLeases.grant({ ...input, worktree: existing.worktree, writer });
      this.#recordWriterGrant(granted.lease);
      return granted;
    }
    const worktreeId = randomUUID();
    let worktree: string;
    try {
      worktree = (await this.#worktrees.create(input.workspace, worktreeId)).workspace;
    } catch (error) {
      if (error instanceof Error && error.message === "WORKTREE_BASE_COMMIT_REQUIRED") {
        throw new Error("WRITER_BASE_COMMIT_REQUIRED");
      }
      throw error;
    }
    try {
      await this.#writerWorktrees?.begin({
        runId: worktreeId,
        roomId: input.roomId,
        taskId: input.taskId,
        workspace: input.workspace,
        worktree,
      });
      const granted = this.writerLeases.grant({ ...input, worktree, writer });
      this.#recordWriterGrant(granted.lease);
      return granted;
    } catch (error) {
      try {
        await this.#writerWorktrees?.fail(
          worktreeId,
          error instanceof Error ? error.message : "WRITER_WORKTREE_REGISTRATION_FAILED",
        );
      } catch { /* the original grant error remains authoritative */ }
      try {
        const preview = await this.#worktrees.previewCleanup(worktreeId);
        await this.#worktrees.cleanup(preview);
      } catch { /* retain isolated worktree for owner inspection */ }
      throw error;
    }
  }

  switchWriter(input: {
    taskId: string;
    roomId: string;
    workspace: string;
    expectedEpoch: number;
    checkpoint: string;
    candidate: WriterCandidate;
  }): GrantedWriterLease {
    this.#assertRoomWorkspace(input.roomId, input.workspace);
    const previous = this.writerLeases.current(input.taskId);
    if (!previous || previous.roomId !== input.roomId || previous.workspace !== input.workspace) {
      throw new Error("WRITER_TASK_SCOPE_MISMATCH");
    }
    const writer = this.#resolveWriter(input.candidate, input.roomId, input.workspace);
    const granted = this.writerLeases.switch({
      taskId: input.taskId,
      expectedEpoch: input.expectedEpoch,
      checkpoint: input.checkpoint,
      writer,
    });
    this.#revokeDelegations(previous, "父 Writer 已交接");
    this.audit.append({
      roomId: previous.roomId, taskId: previous.taskId, type: "writer.revoked",
      actor: "you", onBehalfOf: previous.onBehalfOf, executedBy: previous.executedBy,
      leaseEpoch: previous.epoch, action: "switch", outcome: "succeeded",
      detail: { reason: "handoff", checkpoint: ledgerSummary(input.checkpoint) },
    });
    this.ledger.appendSystemIdempotent(
      input.roomId,
      `${previous.writer.displayName} 已交接任務 ${input.taskId}；checkpoint：${ledgerSummary(input.checkpoint)}`,
      `writer:lease:${previous.id}:revoked`,
    );
    this.#recordWriterGrant(granted.lease);
    return granted;
  }

  completeWriter(input: { taskId: string; roomId: string; workspace: string; epoch: number; checkpoint: string }): WriterLease {
    this.#assertRoomWorkspace(input.roomId, input.workspace);
    const current = this.writerLeases.current(input.taskId);
    if (!current || current.roomId !== input.roomId || current.workspace !== input.workspace) {
      throw new Error("WRITER_TASK_SCOPE_MISMATCH");
    }
    const completed = this.writerLeases.complete(input);
    this.#revokeDelegations(current, "父 Writer 已完成任務");
    this.audit.append({
      roomId: completed.roomId, taskId: completed.taskId, type: "writer.completed",
      actor: "you", onBehalfOf: completed.onBehalfOf, executedBy: completed.executedBy,
      leaseEpoch: completed.epoch, action: "complete", outcome: "succeeded",
      detail: { checkpoint: ledgerSummary(input.checkpoint) },
    });
    this.ledger.appendSystemIdempotent(
      input.roomId,
      `${completed.writer.displayName} 已完成任務 ${input.taskId} 的 Writer 工作；checkpoint：${ledgerSummary(input.checkpoint)}`,
      `writer:lease:${completed.id}:completed`,
    );
    return completed;
  }

  assertWriterWrite(input: {
    taskId: string;
    roomId: string;
    workspace: string;
    epoch: number;
    capabilityToken: string;
    executedBy: string;
  }): WriterLease {
    this.#assertRoomWorkspace(input.roomId, input.workspace);
    const current = this.writerLeases.current(input.taskId);
    if (current?.writer.origin === "external") throw new Error("NATIVE_EXTERNAL_WRITER_LEASE_UNSUPPORTED");
    const lease = this.writerLeases.assertWrite(input);
    if (lease.roomId !== input.roomId || lease.workspace !== input.workspace) throw new Error("WRITER_TASK_SCOPE_MISMATCH");
    this.#assertManagedWriterLease(lease);
    return lease;
  }

  async delegateWriterChild(input: {
    taskId: string;
    roomId: string;
    workspace: string;
    epoch: number;
    capabilityToken: string;
    executedBy: string;
    childProvider: WriterProvider;
    label: string;
  }): Promise<GrantedWriterDelegation> {
    const parent = this.assertWriterWrite(input);
    const id = randomUUID();
    // Same-provider children are part of the same Writer authority. They share
    // the parent task worktree and are serialized by the control plane, so their
    // changes converge into one owner-reviewed apply-back instead of becoming
    // stranded in nested worktrees.
    const childWorkspace = parent.worktree;
    try {
      const granted = this.writerDelegations.create({
        id,
        parent,
        childProvider: input.childProvider,
        label: input.label,
        workspace: childWorkspace,
      });
      this.audit.append({
        roomId: input.roomId, taskId: input.taskId, type: "writer.delegated",
        actor: parent.writer.displayName, onBehalfOf: parent.onBehalfOf,
        executedBy: granted.delegation.executedBy, leaseEpoch: parent.epoch,
        action: "delegate", outcome: "succeeded",
        detail: {
          delegationId: granted.delegation.id,
          parentLeaseId: parent.id,
          childProvider: granted.delegation.childProvider,
          access: granted.delegation.access,
          workspace: granted.delegation.workspace,
          redelegation: "denied",
        },
      });
      const mode = granted.delegation.access === "write"
        ? "共用父 Writer 任務 worktree，控制面序列執行"
        : "跨模型唯讀";
      this.ledger.appendSystemIdempotent(
        input.roomId,
        `${parent.writer.displayName} 已派駐 ${granted.delegation.displayName}（${mode}，不可再轉派）`,
        `writer:delegation:${granted.delegation.id}:created`,
      );
      return granted;
    } catch (error) {
      throw error;
    }
  }

  assertDelegatedWrite(input: {
    delegationId: string;
    taskId: string;
    roomId: string;
    workspace: string;
    capabilityToken: string;
    executedBy: string;
  }): WriterDelegation {
    this.#assertRoomWorkspace(input.roomId, input.workspace);
    const parent = this.writerLeases.current(input.taskId);
    if (!parent || parent.roomId !== input.roomId || parent.workspace !== input.workspace) {
      throw new Error("DELEGATION_PARENT_LEASE_STALE");
    }
    this.#assertManagedWriterLease(parent);
    return this.writerDelegations.assertWrite({
      delegationId: input.delegationId,
      parentLease: parent,
      capabilityToken: input.capabilityToken,
      executedBy: input.executedBy,
    });
  }

  assertDelegatedRead(input: {
    delegationId: string;
    taskId: string;
    roomId: string;
    workspace: string;
    executedBy: string;
  }): WriterDelegation {
    this.#assertRoomWorkspace(input.roomId, input.workspace);
    const parent = this.writerLeases.current(input.taskId);
    if (!parent || parent.roomId !== input.roomId || parent.workspace !== input.workspace) {
      throw new Error("DELEGATION_PARENT_LEASE_STALE");
    }
    this.#assertManagedWriterLease(parent);
    return this.writerDelegations.assertRead({
      delegationId: input.delegationId,
      parentLease: parent,
      executedBy: input.executedBy,
    });
  }

  recordWorkspaceOperation(input: {
    taskId: string;
    roomId: string;
    workspace: string;
    actor: string;
    onBehalfOf: string;
    executedBy: string;
    leaseEpoch: number;
    action: "list_files" | "read_file" | "create_directory" | "write_file";
    path?: string;
    outcome: AuditOutcome;
    detail?: Record<string, unknown>;
  }): void {
    this.#assertRoomWorkspace(input.roomId, input.workspace);
    this.audit.append({ ...input, type: `workspace.${input.action}` });
    const verb = input.action === "write_file" ? "寫入"
      : input.action === "create_directory" ? "建立資料夾"
        : input.action === "read_file" ? "讀取" : "列出檔案";
    const target = input.path ? ` ${ledgerSummary(input.path, 240)}` : "";
    const room = this.ledger.getRoom(input.roomId);
    const nearLedgerLimit = Boolean(room && (room.messages >= 4_500 || room.bytes >= 7 * 1_048_576));
    try {
      if (nearLedgerLimit) throw new Error("ROOM_LEDGER_RESERVED_FOR_CONVERSATION");
      this.ledger.appendSystem(
        input.roomId,
        `${input.actor} ${verb}${target}：${input.outcome}`,
      );
    } catch (error) {
      // The HMAC audit above is the authoritative technical record. A full room
      // ledger must never turn an already-completed filesystem mutation into an
      // apparent tool failure, nor consume the final room capacity needed for
      // Owner/Agent conversation.
      this.audit.append({
        roomId: input.roomId, taskId: input.taskId, type: "workspace.ledger-notification-skipped",
        actor: input.actor, onBehalfOf: input.onBehalfOf, executedBy: input.executedBy,
        leaseEpoch: input.leaseEpoch, action: input.action, outcome: "failed",
        detail: {
          path: input.path,
          reason: error instanceof Error ? error.message : "ROOM_LEDGER_NOTIFICATION_FAILED",
          operationOutcome: input.outcome,
        },
      });
    }
  }

  revokeUnrecoverableWriters(reason = "Owner 控制服務重新啟動，舊 capability 已失效"): number {
    let revoked = 0;
    for (const room of this.ledger.listRooms()) {
      for (const lease of this.writerLeases.list(room.id)) {
        if (lease.state !== "active") continue;
        const legacyExternal = lease.writer.origin === "external";
        if (!legacyExternal && this.writerLeases.hasActiveRun(lease.taskId)) continue;
        const revocationReason = legacyExternal
          ? "vNext：Native external terminal 保留 host authority，不再使用 Writer Lease；舊 capability 已強制撤銷"
          : reason;
        let stale: WriterLease;
        let terminatedRun = false;
        try {
          if (legacyExternal) {
            const result = this.writerLeases.revokeLegacyExternal({
              taskId: lease.taskId,
              epoch: lease.epoch,
              checkpoint: revocationReason,
            });
            stale = result.lease;
            terminatedRun = result.terminatedRun;
          } else {
            stale = this.writerLeases.revoke({
              taskId: lease.taskId,
              epoch: lease.epoch,
              checkpoint: revocationReason,
            });
          }
        } catch (error) {
          if (error instanceof Error && error.message === "WRITER_TASK_ALREADY_RUNNING") continue;
          throw error;
        }
        this.#revokeDelegations(stale, revocationReason);
        this.audit.append({
          roomId: stale.roomId, taskId: stale.taskId, type: "writer.revoked",
          actor: "you", onBehalfOf: stale.onBehalfOf, executedBy: stale.executedBy,
          leaseEpoch: stale.epoch,
          action: legacyExternal ? "revoke-legacy-external" : "revoke-unrecoverable",
          outcome: "succeeded",
          detail: { reason: ledgerSummary(revocationReason), terminatedRun },
        });
        this.ledger.appendSystemIdempotent(
          stale.roomId,
          `${stale.writer.displayName} 的 Writer 權限已撤銷：${ledgerSummary(revocationReason)}`,
          `writer:lease:${stale.id}:revoked`,
        );
        revoked += 1;
      }
    }
    return revoked;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const errors: unknown[] = [];
    for (const close of [
      () => this.candidates.close(),
      () => this.audit.close(),
      () => this.writerDelegations.close(),
      () => this.writerLeases.close(),
      () => this.managedAgents.close(),
      () => this.inbox.close(),
      () => this.presence.close(),
      () => this.ledger.close(),
    ]) {
      try { close(); } catch (error) { errors.push(error); }
    }
    if (errors.length > 0) throw new AggregateError(errors, "COLLABORATION_SERVICE_CLOSE_FAILED");
  }

  #assertRoomWorkspace(roomId: string, workspace: string): void {
    const room = this.ledger.getRoom(roomId);
    if (!room) throw new Error("ROOM_NOT_FOUND");
    if (this.#sameWorkspace(room.workspace, workspace)) return;
    throw new Error("ROOM_WORKSPACE_MISMATCH");
  }

  #sameWorkspace(left: string, right: string): boolean {
    if (left === right) return true;
    try { return realpathSync(left) === realpathSync(right); } catch { return false; }
  }

  /**
   * The audit and ledger half of Phase 5-4. A drift invalidation noticed while merely READING has no
   * caller to report to and no HTTP response to fail — so without this it would be exactly the silent
   * disappearance the bar forbids, and an owner asking "why did my approval never take effect?" would
   * find a terminal row and no account of it.
   *
   * The audit entry carries the whole story, including whether the owner had actually granted it: a
   * decision that lapsed unnoticed and a request nobody answered are different failures. The room
   * ledger is public and read by agents, so it names the moved fields and states plainly that this
   * invalidation destroyed nothing and did not touch main — and carries no path, no id and no secret.
   *
   * What neither of them says is that the candidate, its checkpoints and its recovery ref still
   * exist. This path never looks, so it cannot know: it observes one approval row and writes one
   * state transition. An earlier version asserted `candidateRetained: true` and printed「完整保留」
   * as constants, which read as observations and were provably wrong — deleting the recovery ref and
   * then triggering a drift still produced a record claiming the recovery point was intact. The
   * claim is therefore scoped to the only thing this code actually did.
   */
  #recordMergeApprovalDrift(event: MergeApprovalDriftEvent): void {
    const unverified = event.unverified ?? [];
    try {
      this.audit.append({
        roomId: event.roomId, taskId: event.taskId,
        type: "candidate.merge-approval-invalidated", actor: "orchestratory",
        executedBy: "orchestratory", action: "main-merge-drift-check", path: event.mainPath,
        outcome: "denied",
        detail: {
          approvalId: event.approvalId,
          reason: "MAIN_MERGE_APPROVAL_BINDING_CHANGED",
          // Compared-and-moved only. Values the check could not read are reported separately, because
          // this array is also what the public ledger prints and what an owner reads as "what broke".
          changed: event.changed,
          ...(unverified.length > 0 ? { unverified } : {}),
          observedOn: event.observedOn,
          previousState: event.previousState,
          ownerHadGranted: event.wasGranted,
          candidateHead: event.candidateHead,
          mainHead: event.mainHead,
          previewDigest: event.previewDigest,
          detectedAt: event.at,
          // Scoped to this action, not to the current state of the world: the invalidation path runs
          // no Git command and writes nothing but the approval row.
          deletedByThisInvalidation: "nothing",
          mainMutation: false,
        },
      });
    } catch { /* the durable invalidation has already committed and remains the primary record */ }
    this.#candidateLedger(event.roomId, event.taskId,
      `${event.wasGranted ? "Owner 已核准的 merge" : "待核准的 merge"} 已因綁定漂移自動失效`
        + `（${event.changed.join("、")}）`
        + (unverified.length > 0 ? `；本次另有無法讀取、因此未比對的欄位（${unverified.join("、")}）` : "")
        + `；這次失效沒有刪除 candidate、checkpoint 或復原點，也沒有修改 main，`
        + `請重新 preview 後再詢問。`,
      `candidate:merge-approval:${event.approvalId}:invalidated`);
  }

  /**
   * The audit and ledger trail for the one operation in this product that writes to the owner's
   * project. Both paths, success and failure, and every fact copied from what the promotion row
   * OBSERVED — no constants, no summaries computed here (bar item 5).
   *
   * Nothing in this method can reach main. It runs after the durable transition has committed, and
   * a failure here is recorded under its own name rather than being allowed to change what happened:
   * an applied merge stays applied whether or not its ledger entry survived, and the promotion row
   * is what the next start rebuilds the answer from.
   */
  #recordMergePromotion(event: MergePromotionEvent): void {
    const observation = event.observation;
    const hooks = observation.hooksExecuted;
    const detail: Record<string, unknown> = {
      promotionId: event.promotionId,
      approvalId: event.approvalId,
      phase: event.phase,
      state: event.state,
      code: observation.code,
      // Both observations of HEAD, kept apart. A single commit id with "applied" beside it cannot be
      // told from a promotion that produced nothing at all.
      mainHeadBefore: event.mainHeadBefore,
      mainHeadAfter: event.mainHeadAfter,
      mainHeadUnchanged: event.mainHeadUnchanged,
      mainMutation: event.mainMutated,
      authorizedMergeCommit: observation.authorizedMergeCommit,
      candidateHead: event.candidateHead,
      recoveryRef: event.recoveryRef,
      recoveryRefIntact: observation.recoveryRefIntact,
      // Read back from git's own trace stream. Absent means it was not read; an empty array means it
      // was read and no hook ran. `hooks: ok` would be neither.
      ...(hooks === undefined ? {} : { hooksExecuted: hooks }),
      ...(observation.attempt === undefined ? {} : { attempt: observation.attempt }),
      ...(observation.differences === undefined ? {} : { differences: observation.differences }),
      ...(observation.recovery === undefined ? {} : { recovery: observation.recovery }),
      ...(observation.mergeGroupSurvivors === undefined
        ? {} : { mergeGroupSurvivors: observation.mergeGroupSurvivors }),
      ...(observation.mergeGroupDisowned === undefined
        ? {} : { mergeGroupDisowned: observation.mergeGroupDisowned }),
      // Who approved it, taken from the approval row rather than written as text here.
      decidedBy: event.decidedBy,
      previewDigest: event.previewDigest,
      approvalState: event.approvalState,
      observedAt: observation.observedAt,
      ...(event.detail ?? {}),
    };
    const outcome = event.phase === "started"
      ? "allowed"
      : event.state === "applied" ? "succeeded" : event.state === "rolled-back" ? "failed" : "denied";
    let audited = true;
    try {
      this.audit.append({
        roomId: event.roomId, taskId: event.taskId,
        type: `candidate.main-merge-${event.phase}`, actor: "orchestratory",
        executedBy: "orchestratory", action: "promote-candidate-into-main", path: event.mainPath,
        outcome, detail,
      });
    } catch { audited = false; }
    // Counted once, at the single moment a live promotion settles as applied. A re-observation
    // of the same record reports `applied` again and must not add a second count.
    if (event.phase === "settled" && event.state === "applied") {
      void recordTelemetryCounter("promotion", this.#dataDirectory);
    }
    const head = (value: string | null): string => value === null ? "未讀到" : value.slice(0, 12);
    const hookText = hooks === undefined
      ? "本次未讀到 git 的 hook 追蹤"
      : hooks.length === 0
        ? "git 追蹤顯示本次沒有執行任何 hook"
        : `執行過的 hook：${hooks.map((run) => `${run.name}(exit ${run.exitCode ?? "未讀到"})`).join("、")}`;
    const summary = event.phase === "started"
      ? `已記錄 promotion 意圖（尚未寫入 main）；main HEAD 寫入前為 ${head(event.mainHeadBefore)}`
      : event.phase === "merge-group-abandoned"
        ? "Owner 宣告不再等待 promotion 的程序群；本次沒有修改 main，下次讀取會重新觀察"
      : event.phase === "owner-process-abandoned"
        ? "Owner 宣告不再等待發起這次 promotion 的程序；本次沒有修改 main，下次讀取會重新觀察"
      : event.phase === "promotion-abandoned"
        ? "Owner 宣告不再等待這次 promotion 的兩個程序（發起者與 merge）；"
          + "本次沒有修改 main，也沒有結束任何程序，下次讀取會重新觀察"
      : event.phase === "unreadable-record-released"
        ? "Owner 宣告一筆讀不了的 promotion 紀錄不再佔用本專案的排他標記；"
          + "該紀錄仍然讀不了、仍未結案，本次沒有修改 main，也沒有修復那筆紀錄"
        : event.state === "applied"
          ? `promotion 已套用；main HEAD ${head(event.mainHeadBefore)} → ${head(event.mainHeadAfter)}`
          : event.state === "rolled-back"
            ? `promotion 未套用，main 已回到操作前指紋；HEAD 仍為 ${head(event.mainHeadBefore)}`
            : `promotion 需要人工檢查（${observation.code}）；`
              + `main HEAD 寫入前 ${head(event.mainHeadBefore)}、目前 ${head(event.mainHeadAfter)}；`
              + `差異：${(observation.differences ?? ["未讀到"]).join("、")}`;
    this.#candidateLedger(event.roomId, event.taskId,
      `${summary}；`
      + (event.mainHeadUnchanged === true && event.phase !== "started"
        ? "main 沒有產生新的 commit（no-op）；" : "")
      // The room ledger is public. It names the decision and what was observed; the approval id, the
      // project path and the preview digest stay in the owner-only audit chain.
      + `${hookText}；核准者 ${event.decidedBy ?? "未讀到"}`
      + (audited ? "" : "；CANDIDATE_PROMOTION_AUDIT_WRITE_FAILED：這一筆沒有寫進 audit chain，"
        + "促進紀錄本身仍在 candidate registry 內，可用 promotions() 重建"),
      `candidate:main-merge:${event.promotionId}:${event.phase}:${event.state}`);
  }

  #candidateLedger(roomId: string, taskId: string | undefined, message: string, key: string): void {
    try {
      this.ledger.appendSystemIdempotent(roomId, message, key);
    } catch (error) {
      this.audit.append({
        roomId, ...(taskId === undefined ? {} : { taskId }),
        type: "candidate.ledger-notification-skipped", actor: "orchestratory",
        action: "candidate-ledger-notification", outcome: "failed",
        detail: { reason: error instanceof Error ? error.message : "ROOM_LEDGER_NOTIFICATION_FAILED" },
      });
    }
  }

  #assertManagedWriterLease(lease: WriterLease): void {
    if (lease.writer.origin === "external") throw new Error("NATIVE_EXTERNAL_WRITER_LEASE_UNSUPPORTED");
  }

  #assertSeatDelivery(presenceId: string, deliveryId: string): RoomDelivery {
    const delivery = this.inbox.get(deliveryId);
    if (!delivery || delivery.targetPresenceId !== presenceId) throw new Error("DELIVERY_NOT_FOUND");
    this.presence.actorFor(presenceId, delivery.roomId);
    return delivery;
  }

  #resolveWriter(candidate: WriterCandidate, roomId: string, workspace: string): WriterIdentity {
    if (candidate.origin === "resident") {
      return {
        origin: "resident",
        provider: candidate.provider,
        actorId: candidate.provider,
        displayName: candidate.provider,
      };
    }
    if (candidate.origin === "managed") {
      const agent = this.managedAgents.get(candidate.actorId);
      if (!agent || agent.roomId !== roomId || agent.workspace !== workspace) throw new Error("WRITER_CANDIDATE_NOT_ELIGIBLE");
      return {
        origin: "managed",
        provider: agent.provider,
        actorId: agent.id,
        displayName: agent.displayName,
      };
    }
    throw new Error("WRITER_CANDIDATE_NOT_ELIGIBLE");
  }

  #recordWriterGrant(lease: WriterLease): void {
    const execution = lease.companionId
      ? `，由受管 Writer Companion 代為執行`
      : "";
    this.ledger.appendSystemIdempotent(
      lease.roomId,
      `${lease.writer.displayName} 已成為任務 ${lease.taskId} 的 Writer${execution}（Writer Lease epoch ${lease.epoch}）`,
      `writer:lease:${lease.id}:granted`,
    );
    this.audit.append({
      roomId: lease.roomId, taskId: lease.taskId, type: "writer.granted",
      actor: "you", onBehalfOf: lease.onBehalfOf, executedBy: lease.executedBy,
      leaseEpoch: lease.epoch, action: "grant", outcome: "succeeded",
      detail: {
        leaseId: lease.id,
        origin: lease.writer.origin,
        provider: lease.writer.provider,
        companionId: lease.companionId ?? null,
        worktree: lease.worktree,
      },
    });
  }

  #revokeWriterIdentity(actorId: string, reason: string): WriterLease[] {
    const revoked = this.writerLeases.revokeByActor(actorId, reason);
    for (const lease of revoked) {
      this.#revokeDelegations(lease, reason);
      this.audit.append({
        roomId: lease.roomId, taskId: lease.taskId, type: "writer.revoked",
        actor: "you", onBehalfOf: lease.onBehalfOf, executedBy: lease.executedBy,
        leaseEpoch: lease.epoch, action: "remove-identity", outcome: "succeeded",
        detail: { reason: ledgerSummary(reason) },
      });
      this.ledger.appendSystemIdempotent(
        lease.roomId,
        `${lease.writer.displayName} 的任務 ${lease.taskId} Writer 權限已撤銷；原因：${ledgerSummary(reason)}`,
        `writer:lease:${lease.id}:revoked`,
      );
    }
    return revoked;
  }

  #revokeDelegations(parent: WriterLease, reason: string): WriterDelegation[] {
    const revoked = this.writerDelegations.revokeByLease(parent.id, reason);
    for (const child of revoked) {
      this.audit.append({
        roomId: child.roomId, taskId: child.taskId, type: "writer.delegation-revoked",
        actor: child.onBehalfOf, onBehalfOf: child.onBehalfOf, executedBy: child.executedBy,
        leaseEpoch: child.parentEpoch, action: "revoke-delegation", outcome: "succeeded",
        detail: { delegationId: child.id, parentLeaseId: child.parentLeaseId, reason: ledgerSummary(reason) },
      });
      this.ledger.appendSystemIdempotent(
        child.roomId,
        `${child.displayName} 的子 Agent 權限已撤銷；原因：${ledgerSummary(reason)}`,
        `writer:delegation:${child.id}:revoked`,
      );
    }
    return revoked;
  }
}
