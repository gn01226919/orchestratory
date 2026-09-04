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
import { createHash, randomUUID } from "node:crypto";
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

/*
 * How long a delivery stays worth doing after the last time someone asked for it.
 *
 * Twelve hours is the owner's number, and the reasoning behind it is not about machines: a task still
 * waiting the next morning has usually either been done by hand or stopped mattering, and a list that
 * keeps both kinds is a list that stops being read. Nothing is deleted when this elapses -- the row
 * moves to `expired`, keeps everything else, and can be asked for again.
 */
const DELIVERY_EXPIRY_MS = 12 * 60 * 60 * 1_000;

/*
 * How much of the ledger a joining agent is shown by default, and the most it can ask for.
 *
 * Fifty is the owner's number and it is the same slice the GUI shows: enough to see what the room is
 * currently doing, small enough that it is a briefing rather than the archive. The ceiling exists so
 * that "give me the context" cannot quietly become "give me everything".
 */
const BRIEFING_MESSAGES = 50;
/* Matched to the ledger's own range cap. Asking for more would silently return less, which is the
   kind of gap between a stated bound and a real one this codebase keeps having to correct. */
const MAX_BRIEFING_MESSAGES = 100;

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
/*
 * Which inbox failures are allowed to degrade, and what to say about the one that is.
 *
 * Degrading on ANY construction error was the first version and it was wrong in a way worth
 * recording. "This build is older than the database" and "this database is corrupt" both arrive as
 * a thrown Error, and only the first is a version mismatch with a known, ordinary fix. Treating
 * corruption or a permission failure as a reason to carry on quietly would hide a data problem
 * behind a message about runtimes -- the product would keep running while something was actually
 * wrong with the owner's records. Only the schema case degrades; everything else still fails the
 * whole service, loudly, which is the correct answer for "something is wrong with your data".
 */
const DEGRADABLE_INBOX_ERRORS: ReadonlySet<string> = new Set(["ROOM_INBOX_SCHEMA_UNSUPPORTED"]);

function inboxErrorCode(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/*
 * What to tell whoever asks for the inbox after it failed to open.
 *
 * The message carries three things on purpose: what happened, what is unaffected, and what to do,
 * with the fix written as commands rather than as a description of a fix. The reader is usually an
 * agent relaying to a person who has never heard of a schema version, and "point it at the new
 * digest" is not something that person can act on.
 *
 * It says "tools that do not use the inbox are unaffected BY THIS", not "everything else works".
 * The narrower claim is the true one: this failure does not touch them, which is not a promise that
 * nothing else is broken. The first version promised the second thing.
 */
function describeInboxUnavailable(error: unknown): string {
  const code = inboxErrorCode(error);
  if (code === "ROOM_INBOX_SCHEMA_UNSUPPORTED") {
    return "ROOM_INBOX_UNAVAILABLE:SCHEMA_TOO_NEW — 這個 runtime 認得的收件匣 schema 比資料庫舊，"
      + "所以拒絕開啟（那是刻意的：舊程式碼誤讀新資料比停下來更危險）。"
      + "收件匣相關的工具（room_wait／room_ack／room_reply／room_fail）停用；"
      + "**不使用收件匣的工具不受這件事影響**。"
      + "修法：在專案目錄依序執行 `npm run build:package`、"
      + "`npm run install:runtime -- --artifact <產出的 tgz> --checksum <同名 .sha256>`，"
      + "再把 ~/.local/lib/node_modules/orchestratory 的 symlink 指向新的 digest 目錄。";
  }
  return `ROOM_INBOX_UNAVAILABLE:${code}`;
}


export class CollaborationService {
  readonly ledger: RoomLedger;
  readonly presence: RoomPresenceStore;
  /*
   * The inbox, or the reason it could not be opened.
   *
   * Every other store here is constructed and that is the end of it. This one is allowed to fail
   * because it is the store whose schema moves most often, and because of what its failure used to
   * cost: a development build applies a newer migration, the installed runtime then refuses to open
   * the database -- correctly, refusing an unknown schema is the safe answer -- and the constructor
   * throwing took the entire MCP server down with it. Twenty-one of twenty-seven tools never touch
   * this store, and all of them disappeared. The refusal was right and its blast radius was not.
   *
   * `inbox` stays a getter with the same shape every caller already uses, so the twenty-odd call
   * sites are unchanged and a caller that needs it still gets an error rather than an undefined.
   * What changes is that the error arrives at the call, not at construction.
   */
  readonly #inboxStore: RoomInboxStore | undefined;
  readonly inboxUnavailableReason: string | undefined;

  get inbox(): RoomInboxStore {
    if (!this.#inboxStore) throw new Error(this.inboxUnavailableReason ?? "ROOM_INBOX_UNAVAILABLE");
    return this.#inboxStore;
  }

  /** Whether inbox-backed features can run at all. Cheap, and does not throw. */
  get inboxAvailable(): boolean {
    return this.#inboxStore !== undefined;
  }

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
    /**
     * Presence clock and lease length. `RoomPresenceStore` has always accepted these; the service
     * simply never passed them on, so anything holding a seat through this class was bound to wall
     * clock time whether or not that was the thing under test. Forwarding them costs nothing at
     * runtime — omitting the field keeps the production 15s lease — and it lets a caller that is
     * not exercising expiry stop depending on how long its own setup happens to take.
     */
    presence?: { now?: () => number; leaseMs?: number };
    /**
     * Inbox clock. Same reasoning as the presence one, and it became necessary the moment deliveries
     * grew an age: expiry reads the INBOX's clock, so a caller that moved only the presence clock
     * would watch twelve simulated hours pass and nothing age out — the two stores would be living in
     * different days. Passing one function to both is how a test gets a single timeline.
     */
    inbox?: { now?: () => number };
  } = {}) {
    this.#dataDirectory = dataDirectory;
    this.ledger = new RoomLedger(dataDirectory);
    this.presence = new RoomPresenceStore(dataDirectory, options.presence ?? {});
    /*
     * The one construction that is allowed to fail. The reason is kept verbatim rather than
     * flattened to a boolean, because the caller that eventually asks for the inbox is the one who
     * has to act on it, and "unavailable" tells them nothing they can do.
     */
    let inboxStore: RoomInboxStore | undefined;
    let inboxUnavailableReason: string | undefined;
    try {
      inboxStore = new RoomInboxStore(dataDirectory, options.inbox ?? {});
    } catch (error) {
      /* Only a version mismatch degrades. Corruption, permissions and anything else rethrow, so a
         data problem stays a data problem instead of becoming a quieter product. */
      if (!DEGRADABLE_INBOX_ERRORS.has(inboxErrorCode(error))) throw error;
      inboxStore = undefined;
      inboxUnavailableReason = describeInboxUnavailable(error);
    }
    this.#inboxStore = inboxStore;
    this.inboxUnavailableReason = inboxUnavailableReason;
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
    this.#expireStaleDeliveries(roomId);
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

  /*
   * The owner asking for a seat's attention.
   *
   * It does not wake anything, and it is important that it does not pretend to.
   *
   * MCP over stdio is request/response: this server reads requests from stdin and writes replies to
   * stdout, and it has no way to make a terminal issue a call that terminal did not choose to issue.
   * A seat is reachable only from inside a `room_wait` it opened itself -- that is what
   * `wakeMode: "active-tool-pull"` means -- so when no such call is open there is nothing to deliver
   * into. Even a server-initiated notification would not help: it cannot cause a call that does not
   * exist to return.
   *
   * (An earlier version of this comment cited `tools.listChanged: false` as a measurement of the
   * client. That was wrong three ways: the value is this server's own hardcoded capability
   * declaration in its `initialize` reply, nothing here ever reads a client's capabilities, and
   * list-changed notifications are about the tool list, not about waking anyone. The conclusion held;
   * the evidence for it was invented.)
   *
   * A button that appeared to wake a seat would be the worst thing in this product -- an owner who
   * believes help is on the way stops looking for the reason it is not.
   *
   * What it CAN do is turn an intention that existed only in the owner's head into a line in the
   * ledger, where that seat is able to read it with `room_read`. Able to, not going to: nothing
   * delivers the ledger to a returning seat, and the guidance agents are given is to re-enter
   * `room_wait`, not to read. So this is an opportunity to be seen, not a guarantee of being seen --
   * and the value that does not depend on the other end is the owner's own timestamped record.
   *
   * (The first version of this comment said the seat "reads the ledger when it next comes on duty",
   * which would make the button's whole premise true by assertion. It contradicted this file's own
   * ADR and the button's own tooltip, both written the same day. A maintainer reading only this
   * paragraph would reasonably conclude the tooltip's caveat was surplus and delete it.)
   *
   * Refused for a seat with no standby approval: a nudge cannot help there, and the remedy is a
   * different one (approve it, or have the terminal request standby). Recorded as a no-op when the
   * seat is already listening, so a click that races a seat coming back on duty does not leave a
   * line implying it was absent.
   */
  /*
   * The timestamp of an ask already on the record for this seat in this minute. Undefined only if it
   * genuinely cannot be found, so the receipt falls back to saying nothing rather than to a guess.
   */
  #existingWakeNoteAt(roomId: string, presenceId: string, bucket: number): string | undefined {
    try {
      return this.ledger.getByIdempotencyKey(`wake-request:${roomId}:${presenceId}:${bucket}`)?.at;
    } catch {
      return undefined;
    }
  }

  requestExternalWake(input: { roomId: string; workspace: string; presenceId: string }): {
    session: PresenceInfo;
    listening: boolean;
    recorded: boolean;
    /* Whether THIS press put a line in the ledger, as opposed to landing on one already there for
       this seat in this minute. The caller needs the difference: "已記一筆（含時間）" said after a
       deduped press names a timestamp belonging to the earlier press, not to the click just made. */
    fresh: boolean;
    /* The timestamp of the line that is on the record -- this press's, or the earlier one's. */
    recordedAt?: string;
  } {
    this.#assertRoomWorkspace(input.roomId, input.workspace);
    const target = this.presence.get(input.presenceId);
    if (!target || target.workspace !== input.workspace || !target.joined || target.roomId !== input.roomId) {
      throw new Error("TARGET_AGENT_OFFLINE");
    }
    if (!target.standbyApproved) throw new Error("TARGET_AGENT_STANDBY_NOT_APPROVED");
    const listening = this.inbox.isListening(target.id, input.roomId);
    if (listening) return { session: target, listening: true, recorded: false, fresh: false };
    const name = target.displayName ?? target.provider;
    /* The ledger dedupes on the key; the bucket decides how long one key lasts. Together they mean
       holding the button down, or clicking it in frustration, leaves one line rather than a column of
       them -- and that asking again a minute later is a new ask rather than a swallowed one. Without
       the bucket the key would be permanent and the second ask would silently vanish. */
    const bucket = Math.floor(this.presence.now() / 60_000);
    const before = this.ledger.getRoom(input.roomId)?.messages ?? 0;
    let recordedAt: string | undefined;
    try {
      recordedAt = this.ledger.appendSystemIdempotent(
        input.roomId,
        `📝 Owner 想找 ${name}，但它當時沒有在收聽。這則只是紀錄，Orchestratory 沒有辦法叫醒終端機。`,
        `wake-request:${input.roomId}:${target.id}:${bucket}`,
      ).at;
    } catch (error) {
      /*
       * The key is the room, the seat and the minute; the stored payload hash also covers the seat's
       * display name. So renaming a seat and pressing again inside the same minute is a same-key,
       * different-text write, and the ledger correctly refuses it. There is nothing wrong here -- an
       * ask for this seat in this minute is already on the record -- so it is reported as recorded
       * rather than surfaced to the owner as a failure.
       *
       * The earlier line is then read back, because `recordedAt` exists precisely so the receipt can
       * name the time on the record instead of implying it is now. Swallowing the conflict without
       * recovering it left `recordedAt` undefined on the one path that most needed it, and the UI
       * showed an em dash where the whole point was to show a time.
       */
      if (!(error instanceof Error) || error.message !== "ROOM_IDEMPOTENCY_CONFLICT") throw error;
      recordedAt = this.#existingWakeNoteAt(input.roomId, target.id, bucket);
    }
    /* Read back rather than inferred from which branch ran: a deduped append returns the EARLIER
       message, and the rename conflict returns nothing at all, so neither path can tell the caller on
       its own whether a new line exists. The room's message count can. */
    const fresh = (this.ledger.getRoom(input.roomId)?.messages ?? before) > before;
    return {
      session: target,
      listening: false,
      recorded: true,
      fresh,
      ...(recordedAt === undefined ? {} : { recordedAt }),
    };
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

  /*
   * A delivery that queued for a seat nobody is reading leaves a line in the ledger.
   *
   * The fact was already being returned to the caller as `wakeable: false`, buried in a JSON field
   * whose meaning only someone who has read this file can recover. The ledger is where a person goes
   * afterwards to ask why nothing happened, and without this line the two explanations look identical
   * there: the seat read the task and ignored it, or the seat never received it at all. Those call for
   * opposite responses -- chase the agent, or go wake the terminal.
   *
   * What one line can support is narrower than "which of those two happened": it is a single
   * observation, taken once, at dispatch. The seat may open a wait a moment later and answer, and
   * nothing retracts the line. So it is written as an observation of a moment and should be read as
   * one -- evidence that at #N nobody was on duty, not a verdict on whether the work was ever seen.
   *
   * The line records what was true at dispatch and nothing else. An earlier draft ended with "要等它
   * 下次待命才會拿到", which is a promise about the future and is false in both directions: the seat may
   * start listening a second later and answer immediately, or it may close and have the delivery
   * failed as SEAT_OFFLINE, in which case it never gets it at all. Nothing retracts this line, so it
   * must only say what was true when it was written.
   *
   * Idempotent, keyed to the message. `room_send` promises in its own tool description that a retry
   * with the same clientRequestId cannot duplicate anything, and both the chat line and the delivery
   * honour that. A non-idempotent note would have quietly broken that promise: three transport
   * retries, one delivery, three identical ledger lines.
   */
  #noteQueuedForSilentSeat(roomId: string, seq: number, displayName: string, deliveryId: string): void {
    try {
      /*
       * `enqueue` and `isListening` are two separate observations with no transaction between them --
       * different tables, and for the GUI versus an MCP terminal, different processes. A waiter can
       * claim the delivery in that gap, and this line would then record "nobody was listening" about
       * work that had already been picked up. Re-reading the delivery narrows the gap to almost
       * nothing and fails in the safe direction: a skipped note costs a reader some context, a wrong
       * one costs them their trust in the ledger.
       */
      if (this.inbox.get(deliveryId)?.state !== "queued") return;
      this.ledger.appendSystemIdempotent(
        roomId,
        `ℹ #${seq} 送給 ${displayName} 時，它沒有在收聽，所以這一則進了收件匣排隊。`,
        `silent-seat:${roomId}:${seq}`,
      );
    } catch {
      /* The ledger note is a courtesy to whoever reads this later. The delivery itself is already
         committed and must not be undone because we could not annotate it. */
    }
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
      if (!wakeable) this.#noteQueuedForSilentSeat(input.roomId, message.seq, target.displayName, delivery.id);
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
      if (!wakeable) this.#noteQueuedForSilentSeat(input.roomId, message.seq, target.displayName, delivery.id);
      this.#noteUndeclaredStart(input.roomId, source.id, source.displayName ?? source.provider);
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

  /*
   * Retire deliveries still waiting to be taken on, and say so in the ledger.
   *
   * Driven from `roomView` for the same reason the offline reconciliation is: this product has no
   * background scheduler, so the honest place to age things out is the moment someone looks. That
   * means expiry happens on the next view rather than exactly at twelve hours, which is fine for
   * something whose whole point is that it stopped being urgent -- but it does mean a room nobody
   * opens keeps its backlog until someone does.
   */
  #expireStaleDeliveries(roomId: string): void {
    let expired: RoomDelivery[];
    try {
      expired = this.inbox.expireStaleQueued(roomId, DELIVERY_EXPIRY_MS);
    } catch {
      /* Ageing out old work must never be the reason a room fails to open. */
      return;
    }
    for (const delivery of expired) {
      try {
        this.ledger.appendSystemIdempotent(
          roomId,
          `⌛ #${delivery.ledgerSeq} 給 ${delivery.targetDisplayName} 的交辦已過期：距離上一次有人要求它已超過 12 小時，而它還在等人接手。紀錄保留，沒有刪除。`,
          `delivery-expired:${delivery.id}`,
        );
      } catch {
        /* The delivery is already expired and recorded as such; a missing courtesy line must not
           undo that, and must not stop the rest of the batch from being annotated. */
      }
    }
  }

  /*
   * What is going on in this room right now, for an agent that is about to join it.
   *
   * Joining used to hand back a capability declaration -- what this terminal is allowed to do -- and
   * nothing about what the room is in the middle of. An agent then faced a screenful of history and
   * had to guess whether any of it was its business, which fails in two directions: it picks up
   * someone else's half-finished task, or it ignores a conclusion the room already reached and builds
   * the same thing again.
   *
   * Bounded on purpose. The point is a briefing, not the archive: the newest `messages` entries, the
   * seats and what they are doing, and who is holding write access. `totalMessages` is included so a
   * reader can see how much it is NOT being shown rather than mistaking the slice for the whole.
   *
   * What this does NOT do is read the code. That step is the owner's to ask for: the ledger says why
   * things became this way and the code says what is actually true now, and deciding which to believe
   * when they disagree is not a decision to hand to a process that just walked in.
   */
  roomBriefing(input: { roomId: string; workspace: string; messages?: number }): {
    room: string;
    totalMessages: number;
    shown: number;
    recent: RoomMessage[];
    seats: Array<{ displayName: string; provider: string; listening: boolean; standbyApproved: boolean; pending: number }>;
    writing: Array<{ displayName: string; taskId: string; state: string }>;
  } {
    this.#assertRoomWorkspace(input.roomId, input.workspace);
    const limit = input.messages ?? BRIEFING_MESSAGES;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_BRIEFING_MESSAGES) {
      throw new Error("INVALID_ROOM_BRIEFING_SIZE");
    }
    if (!this.ledger.getRoom(input.roomId)) throw new Error("ROOM_NOT_FOUND");
    /*
     * Age the room the same way `roomView` does, BEFORE reading anything that will be reported.
     *
     * Without the sweeps the briefing counts deliveries the GUI has already retired -- a seat shown
     * with three things waiting while `list_agents` beside it says one, because two were past twelve
     * hours and nothing had triggered the sweep yet. Neither number is invented; they answer the same
     * question at different points in one tick, which is worse than either being wrong alone, because
     * a reader cannot tell which to believe.
     *
     * And every count below is taken after them, from one read. Sweeping and then reporting a total
     * captured beforehand would be the same inconsistency moved inside this function: the sweeps
     * append their own system lines, so the slice would end before a total that had counted them.
     */
    this.#reconcileUnavailableDeliveries(input.roomId, input.workspace, "SEAT_OFFLINE");
    this.#expireStaleDeliveries(input.roomId);
    const info = this.ledger.getRoom(input.roomId);
    if (!info) throw new Error("ROOM_NOT_FOUND");
    /*
     * Read from the END, not from the beginning.
     *
     * `listAfter(roomId, 0)` is itself capped at 100, so taking the last `limit` of THAT returns
     * messages 51-100 of a 126-message room -- the middle, presented as "recent". Any room past a
     * hundred messages would have been briefed on a slice that could never include what was just
     * said, which is the one thing this is for. Asking for the range that ends at the newest sequence
     * is the same query without the trap.
     */
    const from = Math.max(1, info.messages - limit + 1);
    const recent = info.messages > 0 ? this.ledger.getRange(input.roomId, from, info.messages) : [];
    const deliveries = this.inbox.list(input.roomId);
    const seats = this.presence.list(input.workspace, input.roomId)
      .filter((session) => session.joined && session.displayName)
      .map((session) => ({
        displayName: String(session.displayName),
        provider: session.provider,
        listening: session.standbyApproved && this.inbox.isListening(session.id, input.roomId),
        standbyApproved: session.standbyApproved,
        /* Work already addressed to that seat and not yet finished -- the clearest signal of a thread
           somebody else is in the middle of. */
        pending: deliveries.filter((delivery) => delivery.targetPresenceId === session.id
          && ["queued", "delivered", "read", "working"].includes(delivery.state)).length,
      }));
    /* Write access, not "candidates": a lease is the thing that actually says someone is changing
       files right now. A candidate with no lease is not in flight, and claiming this lists every
       candidate would be claiming more than it looks at. */
    const writing = this.writerLeases.list(input.roomId)
      .filter((lease) => lease.state === "active")
      .map((lease) => ({ displayName: lease.writer.displayName, taskId: lease.taskId, state: lease.state }));
    return {
      room: input.roomId,
      totalMessages: info.messages,
      shown: recent.length,
      recent,
      seats,
      writing,
    };
  }

  /*
   * A seat saying which of the two things it is here to do.
   *
   * The briefing tells a joining agent what the room is in the middle of; this is where it says what
   * it intends to do about that. The two answers lead to different work -- picking up the thread that
   * is already running, or starting something beside it -- and the failure the owner described is an
   * agent that never distinguishes them.
   *
   * Recorded in the ledger and nowhere else, deliberately: `presence_id` is a fresh UUID per
   * registration, so the idempotency key is already unique to this session, and a seat that reconnects
   * is a new seat that has not answered rather than one inheriting an old answer. No new column, and
   * the answer lives where the next reader is already looking.
   */
  declareRoomStart(input: {
    roomId: string;
    workspace: string;
    presenceId: string;
    mode: "continue" | "new-task";
    note?: string;
  }): { message: RoomMessage; mode: "continue" | "new-task"; alreadyDeclared: boolean } {
    this.#assertRoomWorkspace(input.roomId, input.workspace);
    if (input.mode !== "continue" && input.mode !== "new-task") throw new Error("INVALID_ROOM_START_MODE");
    const seat = this.presence.get(input.presenceId);
    if (!seat || seat.workspace !== input.workspace || !seat.joined || seat.roomId !== input.roomId) {
      throw new Error("PRESENCE_NOT_JOINED");
    }
    const note = input.note === undefined ? "" : safeSummary(String(input.note), 200);
    const name = seat.displayName ?? seat.provider;
    const already = this.#hasStartDeclaration(input.roomId, input.presenceId);
    const text = input.mode === "continue"
      ? `▶ ${name} 接續房間現有的工作${note ? `：${note}` : ""}`
      /* A divider, so a later reader can see where one line of work stopped and another began. */
      : `── ${name} 從這裡開始新任務${note ? `：${note}` : ""} ──`;
    /*
     * Keyed by what was said, not merely by who said it.
     *
     * A single key per session meant the SAME answer deduped correctly and a CHANGED one threw
     * ROOM_IDEMPOTENCY_CONFLICT -- the ledger comparing payload hashes and finding a different
     * sentence under the same key. That error reached the agent as an opaque code, and it fired on
     * the most natural sequence there is: declare `continue`, read the briefing, realise this is
     * actually a separate task. The flow this feature exists to support was the flow it refused.
     *
     * So a genuine change of mind is a genuine second line, and identical repeats -- transport
     * retries -- still collapse. Both declarations stay on the record, which is the point: "they
     * started out continuing and then split off" is exactly what a later reader needs.
     */
    const message = this.ledger.appendSystemIdempotent(
      input.roomId, text, this.#startKey(input.roomId, input.presenceId, text),
    );
    return { message, mode: input.mode, alreadyDeclared: already };
  }

  /*
   * A seat that started working before saying which of the two things it was doing.
   *
   * This does NOT block the send, and that is not a compromise -- it is the only honest option. MCP
   * returns text; it cannot make an agent read the question, and a gate that refused the work would
   * only teach the next agent to route around it. What can be true is that the room shows what
   * happened: someone acted without saying whether they were continuing or starting something new,
   * and a reader wondering why two lines of work collided has that in front of them.
   *
   * One line per seat per session, so a talkative agent leaves a note, not a column.
   */
  /*
   * Public so the MCP layer can call it at the other places a seat acts on its own initiative --
   * opening a candidate, posting, mentioning. Those go through different service methods, and putting
   * the note at each ACTION rather than inside one of them is what keeps the promise in the join
   * response ("the room records that you acted") the same size as the code.
   */
  noteUndeclaredSeatAction(roomId: string, presenceId: string): void {
    const seat = this.presence.get(presenceId);
    if (!seat || seat.roomId !== roomId || !seat.joined) return;
    this.#noteUndeclaredStart(roomId, presenceId, seat.displayName ?? seat.provider);
  }

  #noteUndeclaredStart(roomId: string, presenceId: string, displayName: string): void {
    if (this.hasDeclaredRoomStart(roomId, presenceId)) return;
    try {
      this.ledger.appendSystemIdempotent(
        roomId,
        `⚠ ${displayName} 還沒說明是接續現有工作還是開始新任務，就先動手了。`,
        `room-start-missing:${roomId}:${presenceId}`,
      );
    } catch {
      /* The work is already committed; a missing annotation must not undo it. */
    }
  }

  /* Whether this seat has said which of the two it is doing, in THIS session. */
  hasDeclaredRoomStart(roomId: string, presenceId: string): boolean {
    return this.#hasStartDeclaration(roomId, presenceId);
  }

  /*
   * One key per DECLARATION, digested from the sentence, so the same answer twice collapses into one
   * line and a genuine change of mind gets its own. There is no separate "anchor" key: writing a
   * second row under a stable key to make lookups easy produced two identical lines on the first
   * declaration -- two consecutive dividers, from the feature whose only job is to mark where one
   * line of work ended.
   */
  #startKey(roomId: string, presenceId: string, text: string): string {
    const digest = createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
    return `room-start:${roomId}:${presenceId}:${digest}`;
  }

  /* Any declaration at all for this seat this session, found by prefix rather than by a marker row. */
  #hasStartDeclaration(roomId: string, presenceId: string): boolean {
    try {
      return this.ledger.hasIdempotencyKeyPrefix(`room-start:${roomId}:${presenceId}:`);
    } catch {
      return false;
    }
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
      /* Not `this.inbox.close()`: the getter throws when the store never opened, and closing a
         service that started degraded must not itself fail. Nothing to close is not an error. */
      () => this.#inboxStore?.close(),
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
