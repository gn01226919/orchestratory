import type { RoomMessage } from "./room-ledger.ts";
import { RoomLedger } from "./room-ledger.ts";
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
  MergeApprovalBindingError,
  type CandidateCheckpoint,
  type CandidateCompletion,
  type CandidateTask,
  type CandidateTaskStatus,
  type MergeApproval,
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
  #closed = false;

  constructor(dataDirectory: string, options: {
    writerWorktrees?: WriterWorktreeLifecycle;
    maxCandidateFiles?: number;
  } = {}) {
    this.ledger = new RoomLedger(dataDirectory);
    this.presence = new RoomPresenceStore(dataDirectory);
    this.inbox = new RoomInboxStore(dataDirectory);
    this.managedAgents = new ManagedRoomAgentStore(dataDirectory);
    this.writerLeases = new WriterLeaseStore(dataDirectory);
    this.writerDelegations = new WriterDelegationStore(dataDirectory);
    this.audit = new CollaborationAuditLog(dataDirectory);
    this.candidates = new CandidateRegistry(dataDirectory, {
      ...(options.maxCandidateFiles === undefined ? {} : { maxFiles: options.maxCandidateFiles }),
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

  async inspectMergeApproval(input: {
    roomId: string;
    workspace: string;
    approvalId: string;
  }): Promise<{ approval: MergeApproval; binding: { valid: boolean; changed: string[] } }> {
    this.#assertRoomWorkspace(input.roomId, input.workspace);
    return await this.candidates.inspectMergeApproval({
      approvalId: input.approvalId, roomId: input.roomId, mainPath: input.workspace,
    });
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
            reason: "MAIN_MERGE_APPROVAL_BINDING_CHANGED",
            mainMutation: false,
          },
        });
        this.#candidateLedger(input.roomId, undefined,
          `merge 核准已失效：綁定值改變（${error.changed.join("、")}）；candidate、checkpoint 與復原點皆保留，`
            + `請重新 preview 後再詢問。`,
          `candidate:merge-approval:${input.approvalId}:invalidated`);
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
        candidateRetained: true,
        checkpointsRetained: true,
        recoveryRefRetained: true,
        mainMutation: false,
      },
    });
    this.#candidateLedger(input.roomId, approval.binding.taskId,
      `Owner 未同意這次 main merge；candidate、checkpoint 與復原點完整保留，可重新 preview 後再詢問。`,
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
