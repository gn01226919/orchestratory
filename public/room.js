const page = new URL(window.location.href);
const ROOM_UI_PROTOCOL = 2;
/* How long the "it was already listening" receipt is kept. A floor, not a ceiling: it stays at least
   this long, and it goes on the next repaint after that -- which the click schedules, but which an
   unrelated presence change can also bring forward or a later click can push back (see wakeNoticeTimers). */
const WAKE_NOOP_NOTICE_MS = 15_000;
/*
 * Provider 選單的單一來源（瀏覽器側）。
 *
 * 這兩份清單必須與 src/providers/selection.ts 的 roomResident / roomMention
 * surface 逐字一致；瀏覽器無法 import TypeScript，所以由
 * test/provider-selection.test.ts 直接讀這個檔案比對——任何一邊改了而另一邊沒改
 * 都會讓測試失敗，不會像過去一樣靜靜地漏掉一個 provider。
 *
 * 地端模型（local）刻意不在這裡：room 席位與 room_mention 的契約由控制面與
 * collab MCP 決定，理由寫在 selection.ts 的表格內，不是遺漏。
 */
const ROOM_RESIDENT_PROVIDER_IDS = Object.freeze(["codex", "claude", "grok"]);
const ROOM_MENTION_PROVIDER_IDS = Object.freeze(["codex", "claude", "grok", "fake"]);
const RESIDENT_PROVIDER_ALTERNATION = ROOM_RESIDENT_PROVIDER_IDS.join("|");
const MENTION_PROVIDER_ALTERNATION = ROOM_MENTION_PROVIDER_IDS.join("|");
const RESIDENT_PREFIX_PATTERN = new RegExp(`^(${RESIDENT_PROVIDER_ALTERNATION})`);
const EXTERNAL_MENTION_PATTERN =
  new RegExp(`^@((?:${RESIDENT_PROVIDER_ALTERNATION})(?:[1-9][0-9]*|（[^）\\r\\n]{1,24}）))\\s`, "u");
const MENTION_MESSAGE_PATTERN = new RegExp(`^@(${MENTION_PROVIDER_ALTERNATION})\\s+[\\s\\S]+$`);
const MENTION_TARGET_PATTERN =
  new RegExp(`^@(${MENTION_PROVIDER_ALTERNATION})(?::([A-Za-z0-9._:/-]{1,128}))?\\s+([\\s\\S]+)$`);
const MENTION_WORD_PATTERN = new RegExp(`^@(${MENTION_PROVIDER_ALTERNATION})\\b`);
const MENTION_DRAFT_PATTERN =
  new RegExp(`^@(?:${MENTION_PROVIDER_ALTERNATION})(?::[^\\s]+)?\\s*`);
const state = {
  csrf: "",
  room: "",
  rooms: [],
  after: 0,
  poll: null,
  polling: false,
  controlPoll: null,
  searching: false,
  mode: page.searchParams.get("mode") === "history" ? "history" : "live",
  historyBefore: 0,
  historyMessages: [],
  cancelledMentions: new Set(),
  providers: [],
  pendingWorkflowRequests: [],
  activeRuns: [],
  workflowEvents: new Map(),
  trackedRuns: new Map(),
  notifications: [],
  notificationSequence: 0,
  controlInitialized: false,
  controlRefreshing: false,
  roomInitialized: false,
  selectedAgent: "",
  selectedPresenceId: "",
  presenceLabels: {},
  /* One repaint timer PER SEAT. A single shared timer meant a second seat's click cancelled the
     first seat's repaint, so that first receipt could sit on screen well past its window -- and the
     comment on WAKE_NOOP_NOTICE_MS claimed it could not. */
  wakeNoticeTimers: {},
  /* Declared like its siblings so the defensive guards elsewhere (two `|| {}` reads and one
     `if (state.wakeNotices)`) stop being load-bearing. Keyed by presence id; entries carry their own
     kind and timestamp. */
  wakeNotices: {},
  presenceJoinModes: {},
  presenceTurnSync: {},
  presenceViewSignature: "",
  presences: [],
  knownExternalNames: new Set(),
  managedAgents: [],
  deliveries: [],
  writers: { leases: [], delegations: [], candidates: [], busyLeaseIds: [] },
  managedAgentViewSignature: "",
  presenceRefreshing: false,
  presenceNextAt: 0,
  quietMode: false,
  idleEnabled: true,
  dayMode: false,
  officePositions: {},
  officeLayouts: {},
  writerCompleteConfirm: "",
  /*
   * Writer apply-back 的核准狀態。phrase 一律留白啟動：確認短語只能來自後端，
   * 前端不預設一份文案，沒拿到就不可核准（方向倒向「不核准」，不是倒向預設值）。
   */
  writerApplyBack: {
    taskId: "",
    runId: "",
    preview: null,
    phrase: "",
    stageNote: "",
    diffText: "",
    diffError: "",
    diffState: "idle",
    scrolled: false,
    blockers: [],
    decided: false,
    applying: false,
    expiredRendered: false,
    ticker: null,
    returnFocus: null,
  },
  mergeApprovals: [],
  mergeApproval: null,
  mergeApprovalBinding: { valid: true, changed: [] },
  /* null＝這個對話框還沒拿到覆蓋掃描的結果，而不是「掃過了，沒有東西會被覆蓋」。 */
  mergeApprovalOverwrites: null,
  mergeApprovalBlockers: [],
  mergeApprovalScrolled: false,
  mergeApprovalDecided: false,
  mergeApprovalSubmitting: false,
  /* Typed confirmation belongs only to the approval currently loaded in this dialog. */
  mergeApprovalInputApprovalId: "",
  mergeApprovalReturnFocus: null,
  mergeApprovalTicker: null,
  mergeApprovalPoll: null,
  mergeConfirmationPhrase: "MERGE INTO MAIN",
  mergeNotAuthorized: [],
  mergeApprovalsRoom: "",
  mergeHistory: [],
  mergeUnpromotedApprovals: [],
  mergeHistoryLoaded: false,
  mergeHistoryRoom: "",
  mergeHistoryReturnFocus: null,
};
const byId = (id) => document.getElementById(id);
let sessionRecovery;

async function recoverWebSession() {
  if (sessionRecovery) return sessionRecovery;
  sessionRecovery = (async () => {
    const pageResponse = await fetch(`/room?renew=${Date.now()}`, {
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!pageResponse.ok) throw new Error(`SESSION_RECOVERY_FAILED_${pageResponse.status}`);
    await pageResponse.text();
    const bootResponse = await fetch("/api/bootstrap", {
      credentials: "same-origin",
      cache: "no-store",
    });
    const boot = await bootResponse.json().catch(() => ({}));
    if (!bootResponse.ok || typeof boot.csrf !== "string") {
      throw new Error(boot.error || `SESSION_RECOVERY_FAILED_${bootResponse.status}`);
    }
    state.csrf = boot.csrf;
  })().finally(() => { sessionRecovery = undefined; });
  return sessionRecovery;
}

async function api(path, options = {}, recovered = false) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(state.csrf ? { "X-CSRF-Token": state.csrf } : {}),
      ...(options.headers || {}),
    },
    credentials: "same-origin",
  });
  if (response.status === 401 && !recovered) {
    await recoverWebSession();
    return api(path, options, true);
  }
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
  return value;
}

/*
 * Room 專用的錯誤翻譯表。app.js 另有一份 humanError()，兩者涵蓋不同端點的代碼；
 * 目前無法合併成共用檔案，因為靜態資產是 src/ui/web.ts 的固定 allowlist（/room.js、
 * /app.js、/styles.css），新增共用 script 需要後端變更。
 */
const ROOM_ERROR_MESSAGES = {
  TARGET_AGENT_STANDBY_NOT_APPROVED: "這個終端已加入房間，但 room-wait 待命還沒核准，所以收不到訊息。",
  /* A seat that is not listening is exactly the seat that accumulates queued work, so this ceiling is
     reachable in ordinary use and a bare error code is the least helpful thing to show when it is hit.
     Queued work does age out twelve hours after the last ask, but that is far too slow to help here:
     by the time the ceiling is hit, whether those thirty-two are live or merely recent is not
     something this message can tell -- what it can say is that they are all still waiting. */
  ROOM_INBOX_SEAT_LIMIT_REACHED: "這個席位已經有 32 則交辦還沒結束（排隊中或處理中都算），所以這一則沒有送出。先讓那個終端把手上的做完或回覆掉。",
  TARGET_AGENT_OFFLINE: "這個終端目前不在線；請等它重新連上或改選其他席位。",
  SEAT_OFFLINE: "這個席位目前不在線；請等它重新連上或改選其他席位。",
  SOURCE_SEAT_OFFLINE: "來源席位已離線，訊息沒有送出。",
  MANAGED_AGENT_BUSY: "這個受控 Agent 正在回覆上一則訊息，請稍候。",
  MANAGED_AGENT_NOT_FOUND: "找不到這個受控 Agent，可能已被移除。",
  MANAGED_AGENT_NOT_BUSY: "這個受控 Agent 目前沒有在回覆，不需要取消。",
  MANAGED_AGENT_REPLY_CANCELLED: "已取消這次回覆；帳本沒有留下模型內容。",
  MANAGED_AGENT_REPLY_FAILED: "受控 Agent 回覆失敗，請確認對應的 CLI 已登入後再試。",
  MANAGED_AGENT_PROVIDER_UNAVAILABLE: "這個模型來源目前無法使用。",
  MANAGED_AGENT_DISPLAY_NAME_IN_USE: "這個名稱已被使用，請換一個。",
  MANAGED_AGENT_REMOVED: "這個受控 Agent 已被移除。",
  EMPTY_AGENT_MESSAGE: "只有 @名稱沒有內容；請在名稱後面加上要交辦的訊息。",
  RATE_LIMITED: "操作太頻繁，請稍等幾秒再試。",
  ROOM_NOT_FOUND: "找不到這個房間，可能已被移除；請重新選擇。",
  ROOM_RECORDING_OFF: "這個房間的收錄已關閉，訊息不會入帳。",
  ROOM_RECORDING_PAUSED: "收錄已暫停；請先按「恢復收錄」再發言。",
  ROOM_LEDGER_FULL: "帳本已達容量上限，請先整理或改用新房間。",
  ROOM_MENTION_NOT_FOUND: "找不到這則等待中的呼叫，可能已經結束。",
  ROOM_MENTION_CANCELLED: "已取消這次模型呼叫。",
  ROOM_WAIT_CANCELLED: "終端的 room_wait 等待已被取消。",
  ROOM_STANDBY_REVOKED: "這個終端的 room-wait 待命已被撤銷。",
  ROOM_BINARY_MESSAGE_DENIED: "訊息含有不允許的二進位內容，沒有送出。",
  PRESENCE_NOT_FOUND: "找不到這個終端席位，可能已離線。",
  PRESENCE_NOT_JOINED: "這個終端還沒被核准加入房間。",
  PRESENCE_ALREADY_JOINED: "這個終端已經在房間裡了。",
  PRESENCE_JOIN_NOT_REQUESTED: "這個終端尚未提出加入申請。",
  PRESENCE_STANDBY_NOT_REQUESTED: "這個終端還沒申請 room-wait 待命，無法核准。",
  PRESENCE_DISPLAY_NAME_IN_USE: "這個名稱已被使用，請換一個。",
  PRESENCE_LIMIT_REACHED: "席位數量已達上限。",
  PRESENCE_WORKSPACE_MISMATCH: "這個終端的專案路徑與房間不符，已拒絕加入。",
  DELIVERY_NOT_FOUND: "找不到這筆投遞紀錄，可能已完成或過期。",
  DELIVERY_NOT_RETRYABLE: "這筆投遞目前不能重新排隊。",
  DELIVERY_ATTEMPTS_EXHAUSTED: "投遞重試次數已用完；請確認終端仍在線再重新送出。",
  DELIVERY_CANCELLED: "這筆投遞已取消。",
  WRITER_LEASE_NOT_ACTIVE: "目前沒有進行中的 Writer Lease。",
  WRITER_LEASE_ALREADY_ACTIVE: "這個任務已經有進行中的 Writer；請先完成或交接。",
  WRITER_EPOCH_STALE: "Writer 狀態已被其他操作更新；請重新開啟面板再試。",
  WRITER_CHECKPOINT_REQUIRED: "完成或交接前必須填寫 checkpoint。",
  WRITER_NOT_REVIEW_READY: "這個任務還沒進入待回寫狀態。",
  WRITER_TASK_ALREADY_RUNNING: "這個任務正在執行中，請等它結束。",
  WRITER_TASK_ALREADY_APPLIED: "這個任務已經回寫過主專案，不會重複套用。",
  WRITER_BASE_COMMIT_REQUIRED: "此專案尚無基準 commit；請先在終端建立第一個 commit，再指派 Writer。",
  WRITER_CANDIDATE_WRITE_NOT_ALLOWED: "這個人選不能擔任 Writer（沒有寫入能力）。",
  WRITER_RUN_FAILED: "Writer 執行失敗；主專案沒有被修改。",
  DELEGATION_TASK_ALREADY_RUNNING: "同一個 task worktree 正在執行中，系統會序列執行，請稍候。",
  DELEGATION_WRITE_NOT_ALLOWED: "跨類型子 Agent 只能唯讀，無法取得寫入權。",
  DELEGATION_NOT_ACTIVE: "這個子 Agent 已失效。",
  APPLY_BACK_NOT_FOUND_OR_EXPIRED: "回寫預覽已失效或逾時，請重新產生預覽。",
  APPLY_BACK_CONFIRMATION_MISMATCH: "確認文字不相符，沒有任何主專案檔案被修改。",
  APPLY_BACK_SOURCE_CHANGED: "來源自預覽後已變動，為安全起見已中止；請重新產生預覽。",
  APPLY_BACK_SOURCE_FILE_CHANGED: "有檔案在預覽後被改動，已中止回寫；請重新產生預覽。",
  APPLY_BACK_SOURCE_HEAD_CHANGED: "主專案 HEAD 已變動，已中止回寫；請重新產生預覽。",
  APPLY_BACK_WORKTREE_HEAD_CHANGED: "Writer worktree 已變動，已中止回寫；請重新產生預覽。",
  APPLY_BACK_FAILED: "回寫失敗；系統已停止，請檢查預覽與復原區。",
  SESSION_PROVIDER_CALL_LIMIT_REACHED: "這次啟動已達模型呼叫硬上限（owner 設定檔可調）。請重新啟動 Orchestrator。",
  CHAT_TURN_ALREADY_RUNNING: "上一個回答還在生成，請稍候。",
  PROVIDER_FAILED: "模型程序失敗，請確認對應的 CLI 已登入後重試。",
  PROVIDER_EXITED: "模型程序已結束，請確認對應的 CLI 已登入後重試。",
  REQUEST_BODY_TOO_LARGE: "內容太長，請縮短後再送出。",
  UI_PROTOCOL_MISMATCH_RESTART_REQUIRED: "網頁版本與後端不一致；請重新啟動 Orchestrator 或重新整理頁面。",
  MAIN_MERGE_APPROVAL_NOT_FOUND: "找不到這筆合併核准，可能已由其他介面決定；main 沒有被修改。",
  MAIN_MERGE_APPROVAL_NOT_PENDING: "這筆合併核准已經有結果，不能再決定一次；main 沒有被修改。",
  MAIN_MERGE_APPROVAL_ALREADY_CONSUMED: "這筆核准已經被使用過，single-use 不可重放；main 沒有被再次修改。",
  MAIN_MERGE_APPROVAL_EXPIRED: "核准視窗已逾時，必須重新產生預覽再問一次；main 沒有被修改。",
  MAIN_MERGE_APPROVAL_NOT_APPROVED: "這筆核准目前不在已核准狀態；main 沒有被修改。",
  MAIN_MERGE_CONFIRMATION_MISMATCH: "確認短語不相符，必須完全等於 MERGE INTO MAIN；main 沒有被修改。",
  MAIN_MERGE_PREVIEW_DIGEST_MISMATCH: "送出的預覽摘要與後端記錄不同，已拒絕；請重新產生預覽。",
  MAIN_MERGE_PREVIEW_DIGEST_STALE: "這份預覽已經不是目前的狀態，已拒絕；請重新產生預覽。",
  MAIN_MERGE_PREVIEW_TRUNCATED: "預覽被截斷，看不到全部內容就不可核准；請重新產生預覽。",
  MAIN_MERGE_PREVIEW_CONFLICTED: "模擬 merge 有衝突，這份預覽不可核准；請先在草稿版端解決衝突。",
  MAIN_MERGE_CANDIDATE_WORKTREE_DIRTY: "草稿區有未提交變更，已拒絕；請先在草稿版端提交或整理。",
  MAIN_MERGE_CANDIDATE_HEAD_CHANGED: "草稿版 HEAD 在預覽之後改變，已拒絕；請重新產生預覽。",
  MAIN_MERGE_RECOVERY_POINT_MISSING: "找不到還原點 ref，為安全起見已拒絕；請重新產生預覽。",
  MAIN_MERGE_APPROVAL_CONCURRENT_UPDATE: "同一筆核准正在被另一個操作更新，請重新讀取後再決定。",
  MAIN_MERGE_APPROVAL_ACTION_NOT_GRANTED: "這筆核准只授權把草稿版併入 main，其他動作都不在授權範圍。",
  INVALID_MERGE_APPROVAL_ID: "核准編號格式不正確，沒有送出任何決定。",
  INVALID_MERGE_APPROVAL_REQUEST: "核准請求格式不正確，沒有送出任何決定。",
};

const MERGE_BINDING_LABELS = {
  taskId: "任務 taskId",
  completionId: "完成紀錄 completionId",
  roomId: "房間 roomId",
  mainPath: "main 路徑 mainPath",
  mainBranch: "main 分支 mainBranch",
  candidatePath: "草稿版路徑 candidatePath",
  baseMainHead: "基準 main baseMainHead",
  candidateHead: "草稿版 HEAD candidateHead",
  mainHead: "main HEAD mainHead",
  mainFingerprint: "main 工作樹指紋 mainFingerprint",
  mainIgnoredFingerprint: "main ignored 指紋 mainIgnoredFingerprint",
  recoveryRef: "還原點 recoveryRef",
  previewDigest: "預覽摘要 previewDigest",
};

function bindingFieldLabel(field) {
  return MERGE_BINDING_LABELS[field] || String(field);
}

function humanError(error) {
  const code = error instanceof Error ? error.message : String(error);
  if (code.startsWith("MAIN_MERGE_APPROVAL_BINDING_CHANGED:")) {
    const changed = code.slice("MAIN_MERGE_APPROVAL_BINDING_CHANGED:".length)
      .split(",").filter(Boolean).map(bindingFieldLabel);
    return `綁定值已改變，這份核准只適用於它綁定的那個 snapshot，已拒絕（${changed.join("、")}）；main 沒有被修改，請重新產生預覽再問一次。`;
  }
  return ROOM_ERROR_MESSAGES[code] || code;
}

function pendingStandbySession(session) {
  if (session?.joined && session.standbyRequested && !session.standbyApproved) return session;
  return (state.presences || []).find(
    (entry) => entry.joined && entry.standbyRequested && !entry.standbyApproved,
  );
}

function showRoomError(error, options = {}) {
  const code = error instanceof Error ? error.message : String(error);
  const connection = byId("connection");
  if (!connection) return;
  connection.textContent = "";
  connection.className = "conn error";
  const text = document.createElement("span");
  text.textContent = options.prefix ? `${options.prefix}：${humanError(error)}` : humanError(error);
  connection.append(text);
  const target = code === "TARGET_AGENT_STANDBY_NOT_APPROVED"
    ? pendingStandbySession(options.session)
    : undefined;
  if (target) {
    const approve = document.createElement("button");
    approve.type = "button";
    approve.className = "conn-action";
    approve.textContent = `核准 ${target.displayName || target.provider} 的 room-wait 待命`;
    approve.addEventListener("click", () => void changePresenceStandby(target, "approve", approve));
    connection.append(approve);
  }
}

const AUTHOR_COLORS = { you: "#dde0e4", system: "#5f636b", claude: "#3ecf8e", codex: "#5e9eff", grok: "#f5a623" };
function providerForAgent(agent) {
  if (agent === "you" || agent === "system") return agent;
  const managed = state.managedAgents.find((entry) => entry.displayName === agent);
  if (managed) return managed.provider;
  return state.presences.find((session) => session.displayName === agent)?.provider ||
    String(agent).match(RESIDENT_PREFIX_PATTERN)?.[1] || agent;
}
function authorColor(author) { return AUTHOR_COLORS[author] || AUTHOR_COLORS[providerForAgent(author)] || "#8a8f98"; }

function renderMessage(message) {
  const item = document.createElement("article");
  item.className = "msg";
  item.dataset.seq = String(message.seq);
  const avatar = document.createElement("span");
  avatar.className = "avatar";
  avatar.textContent = `#${message.seq}`;
  const body = document.createElement("div");
  const label = document.createElement("small");
  label.textContent = `${message.author} · ${message.at.slice(11, 19)}`;
  label.style.color = authorColor(message.author);
  const content = document.createElement("p");
  if (message.kind === "system") content.style.color = "#5f636b";
  renderTextWithRefs(content, message.text);
  body.append(label, content);
  renderDeliveryReceipt(body, message.seq);
  item.append(avatar, body);
  return item;
}

const DELIVERY_LABELS = {
  queued: "已排隊",
  delivered: "已送達終端",
  read: "終端已確認取件",
  working: "處理中",
  replied: "已回覆",
  /* Not "失敗". Nothing went wrong here -- it sat in the inbox long enough that it stopped being
     worth doing, most often because the owner did it themselves. Calling that a failure puts it in
     the same colour as things that broke, and a list where everything is red is a list nobody reads. */
  expired: "已過期（排隊太久）",
  failed: "投遞失敗",
  cancelled: "已取消",
};

function deliveryForSeq(seq) {
  return state.deliveries.find((delivery) => delivery.ledgerSeq === Number(seq));
}

function renderDeliveryReceipt(body, seq) {
  body.querySelector(".delivery-receipt")?.remove();
  const delivery = deliveryForSeq(seq);
  if (!delivery) return;
  const receipt = document.createElement("div");
  receipt.className = `delivery-receipt is-${delivery.state}`;
  const text = document.createElement("small");
  const target = state.presences.find((session) => session.id === delivery.targetPresenceId);
  /* The receipt is read at the moment someone is deciding whether to keep waiting, so where it can, it
     says what that means for them rather than naming the internal state. Only where it can: this
     wording needs the target's seat to still be in the current presence list, and when it is not,
     the plain state label is all there is to say.
     Through seatListeningState, not a second hand-written copy of its branches: that copy existed,
     it collapsed two states into one line, and it sat directly under a comment claiming there was
     one answer per state "where it cannot drift". */
  const targetState = target ? seatListeningState(target) : undefined;
  const deliveryLabel = delivery.state === "queued" && targetState
    ? targetState.key === "listening"
      ? "它正在收聽，正在送過去"
      : `已排隊：${targetState.text}`
    : DELIVERY_LABELS[delivery.state] || delivery.state;
  text.textContent = `${deliveryLabel} · ${delivery.targetDisplayName} · 嘗試 ${delivery.attempt}/${delivery.maxAttempts}`;
  receipt.append(text);
  if (["queued", "delivered", "read", "working"].includes(delivery.state)) {
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = delivery.state === "working" ? "請求取消" : "取消";
    cancel.addEventListener("click", () => void changeDelivery(delivery, "cancel", cancel));
    receipt.append(cancel);
  /* `expired` too. Ageing work out removed the path it used to have -- it would have sat queued until
     the seat came back -- so without a way to send it again the owner's only option is to retype the
     request. Retrying records a fresh ask, which is what the expiry clock counts from. */
  } else if (["failed", "cancelled", "expired"].includes(delivery.state)) {
    const retry = document.createElement("button");
    retry.type = "button";
    retry.textContent = "重新排隊";
    retry.addEventListener("click", () => void changeDelivery(delivery, "retry", retry));
    receipt.append(retry);
  }
  body.append(receipt);
}

function refreshDeliveryReceipts() {
  for (const item of byId("ledger")?.querySelectorAll("article.msg[data-seq]") || []) {
    const body = item.querySelector(":scope > div");
    if (body) renderDeliveryReceipt(body, Number(item.dataset.seq));
  }
}

async function changeDelivery(delivery, action, button) {
  button.disabled = true;
  try {
    const value = await api(`/api/rooms/deliveries/${action}`, {
      method: "POST",
      body: JSON.stringify({ room: state.room, deliveryId: delivery.id }),
    });
    state.deliveries = state.deliveries.map((item) => item.id === value.delivery.id ? value.delivery : item);
    refreshDeliveryReceipts();
  } catch (error) {
    showRoomError(error, { prefix: "投遞操作失敗" });
  } finally {
    button.disabled = false;
  }
}

const REF_PATTERN = /#(\d{1,6})(?:-(\d{1,6}))?/g;

function renderTextWithRefs(node, text) {
  let last = 0;
  for (const match of text.matchAll(REF_PATTERN)) {
    node.append(document.createTextNode(text.slice(last, match.index)));
    const ref = document.createElement("a");
    ref.textContent = match[0];
    ref.href = "javascript:void(0)";
    ref.className = "refl";
    ref.dataset.from = match[1];
    ref.dataset.to = match[2] || match[1];
    node.append(ref);
    last = match.index + match[0].length;
  }
  node.append(document.createTextNode(text.slice(last)));
}

async function toggleQuote(refElement) {
  const existing = refElement.closest("article").querySelector(".quote");
  if (existing) { existing.remove(); return; }
  const from = Number(refElement.dataset.from);
  const to = Math.min(Number(refElement.dataset.to), from + 19);
  try {
    const value = await api(`/api/rooms/messages?room=${encodeURIComponent(state.room)}&after=${from - 1}`);
    const quoted = value.messages.filter((m) => m.seq >= from && m.seq <= to);
    if (!quoted.length) return;
    const block = document.createElement("blockquote");
    block.className = "quote";
    for (const m of quoted) {
      const line = document.createElement("p");
      line.textContent = `#${m.seq} ${m.author}: ${m.text.slice(0, 500)}`;
      block.append(line);
    }
    refElement.closest("article").querySelector("div").append(block);
  } catch { /* 引用不存在時安靜略過 */ }
}

function updateAuthorStats(stats) {
  const box = byId("author-stats");
  box.textContent = "";
  for (const s of stats) {
    const row = document.createElement("div");
    row.className = "rail-row";
    const dot = document.createElement("i");
    dot.className = "dot on";
    dot.style.background = authorColor(s.author);
    const span = document.createElement("span");
    const name = document.createElement("b");
    name.textContent = s.author;
    const detail = document.createElement("small");
    detail.textContent = `${s.messages} 則 · ${(s.chars / 1000).toFixed(1)}k 字`;
    span.append(name, detail);
    row.append(dot, span);
    box.append(row);
  }
}

function mentionLifecycle(messages, index, target, seq) {
  const later = messages.slice(index + 1);
  const reference = `（提及 #${seq}）`;
  const started = later.some((message) =>
    message.kind === "system" && message.text.includes(`@${target} 回應處理中`) &&
    message.text.includes(reference));
  const resolved = later.some((message) =>
    message.author === target ||
    (message.kind === "system" && message.text.includes(reference) &&
      !message.text.includes("回應處理中")));
  return { started, resolved };
}

function updateWaitingIndicator(messages) {
  byId("waiting-row")?.remove();
  let pending = null;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.kind !== "chat") continue;
    const mention = message.text.match(MENTION_MESSAGE_PATTERN);
    if (!mention || mention[1] === message.author) continue;
    if (state.cancelledMentions.has(message.seq)) continue;
    const target = mention[1];
    const lifecycle = mentionLifecycle(messages, index, target, message.seq);
    if (lifecycle.started && !lifecycle.resolved) pending = { target, seq: message.seq };
  }
  if (!pending) return;
  const row = document.createElement("div");
  row.id = "waiting-row";
  row.className = "note waiting";
  const label = document.createElement("span");
  label.className = "waiting-label";
  label.textContent = `⟳ 等待 ${pending.target} 回應 #${pending.seq}…`;
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "cancel-pending";
  cancel.textContent = "取消等待";
  cancel.addEventListener("click", () => void cancelPending(pending, cancel));
  row.append(label, cancel);
  byId("ledger").append(row);
}

async function cancelPending(pending, button) {
  button.disabled = true;
  button.textContent = "取消中…";
  try {
    const value = await api("/api/rooms/mention/cancel", {
      method: "POST",
      body: JSON.stringify({ room: state.room, seq: pending.seq }),
    });
    if (value.cancelled || value.cleared) state.cancelledMentions.add(pending.seq);
    byId("waiting-row")?.remove();
    byId("connection").textContent = value.cancelled ? "已取消模型呼叫" : "已清除等待狀態";
    await poll();
  } catch (error) {
    button.disabled = false;
    button.textContent = "取消等待";
    showRoomError(error, { prefix: "取消等待失敗" });
  }
}

/* @pure-start ledger-day-groups
 * Grouping a ledger by day, with no DOM and no clock of its own.
 *
 * The ledger is append-only and grows without bound — this room is at 816 messages — so a flat
 * list makes the oldest and newest entries equally prominent, which is exactly backwards: what
 * happened in the last hour is what anyone is here to read.
 *
 * `at` is a UTC ISO string but a day boundary is a LOCAL question: a message posted at 23:30
 * Taipei belongs to that evening, not to the next UTC morning. The date is therefore derived
 * through the platform's local calendar rather than by slicing the ISO string, which would silently
 * be wrong by one day for eight hours out of every twenty-four.
 *
 * `todayKey` is a parameter, not `new Date()` inside: a function that reads the clock cannot be
 * tested for what it does at a boundary, and "today" is precisely the boundary that matters here.
 */
function ledgerDayKey(at) {
  /* A timestamp here is an ISO-shaped string, or a Date this module built itself (ledgerDayLabel
     walks back a day to work out "yesterday"). `new Date(null)` is the epoch and `new Date(0)` is a
     real instant, so a NaN check alone files a missing timestamp under 1970-01-01 -- a real day
     bucket, presented with the same confidence as a true one. Everything else belongs in the undated
     bucket, where it is visibly not a day. */
  if (typeof at !== "string" && !(at instanceof Date)) return "";
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "";
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function ledgerDayLabel(key, todayKey) {
  if (!key) return "日期不明";
  if (key === todayKey) return "今天";
  const [year, month, day] = key.split("-");
  const yesterday = new Date(`${todayKey}T12:00:00`);
  yesterday.setDate(yesterday.getDate() - 1);
  if (key === ledgerDayKey(yesterday)) return "昨天";
  const sameYear = todayKey.slice(0, 4) === year;
  return sameYear ? `${Number(month)} 月 ${Number(day)} 日` : `${year} 年 ${Number(month)} 月 ${Number(day)} 日`;
}

/**
 * Messages in, day buckets out, oldest first so the newest sits nearest the input box where the
 * stream already scrolls. `openKey` names the one day that should be expanded: the newest, because
 * a reader arriving at a room wants the current conversation, not the archive.
 *
 * Ordered by the DATE, not by the order the messages arrived. An earlier version kept insertion
 * order and called the last bucket the newest, which is only true while the input happens to be
 * sorted oldest-first -- and the ledger is about to be served newest-first with older pages loaded
 * on scroll, which is exactly the case that breaks it. Keys are `YYYY-MM-DD`, so a plain string
 * compare is a date compare.
 *
 * The undated bucket (`""`, from a timestamp that is not a real instant) sorts to the FRONT, and no
 * DATED bucket ever loses `openKey` to it. Putting it last would park it next to the input box and
 * auto-expand it, which would read as "the newest thing that happened" -- the one thing it definitely
 * is not. If every message is undated there is no dated bucket to prefer, `openKey` is `""`, and that
 * group opens; that is the honest answer rather than opening nothing at all.
 */
function ledgerDayGroups(messages, todayKey) {
  const byKey = new Map();
  for (const message of Array.isArray(messages) ? messages : []) {
    const key = ledgerDayKey(message?.at);
    if (!byKey.has(key)) byKey.set(key, { key, label: ledgerDayLabel(key, todayKey), messages: [] });
    byKey.get(key).messages.push(message);
  }
  const groups = [...byKey.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const dated = groups.filter((group) => group.key !== "");
  return { groups, openKey: dated.length > 0 ? dated[dated.length - 1].key : "" };
}
/* @pure-end ledger-day-groups */

/* The clock time of a ledger line, for a receipt that names when the record is dated. Falls back to
   an em dash rather than to "now": the whole point of showing this is that it may not be now. */
function wakeClock(at) {
  if (typeof at !== "string") return "—";
  const date = new Date(at);
  return Number.isNaN(date.getTime())
    ? "—"
    : `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/* @pure-start seat-listening-state */
/**
 * What a seat is doing right now, in the words a person would use.
 *
 * Every one of these facts was already on screen, spelled in the vocabulary of the mechanism:
 * "待命已核准，但終端目前未掛起 room_wait". That sentence is exact and it is useless to anyone who
 * has not read the source, because the reader's actual question is not which call is open -- it is
 * "if I send this now, will anything happen?" So each state answers that question first and names
 * the mechanism second.
 *
 * The distinction that matters most is the one that used to be hardest to see: JOINED and LISTENING
 * are different things. A seat can be present, approved, and still deaf, and work sent to it just
 * waits. Nothing here can wake it -- MCP cannot push to a terminal that is not asking -- so the
 * honest thing is to say the message will queue, not to imply someone is about to pick it up.
 *
 * Each state carries a MARK as well as a colour. A row that is only ever green-or-grey says nothing
 * to a reader who cannot separate those two, and this is the row that decides whether they wait.
 *
 * `send` and `fix` live here too, and that is the point. They were written twice -- once in the seat
 * row, once in the office -- with slightly different conditions, and the two copies contradicted each
 * other on the states nobody had thought about: the office told a seat with NO standby authority that
 * its work "會排隊等著" when in fact the send is refused outright, and offered "go make it call
 * room_wait again" to a seat whose standby was simply waiting for the owner to click approve. One
 * function, one answer per state, and the difference between "queues" and "refused" stated where it
 * cannot drift.
 */
/*
 * One vocabulary for every surface: the sidebar badge, the office desk label, the task rows and
 * the chips all read `text` (可交辦 / 排隊中 / 等你核准 / 不可交辦), so the pixel floor and the
 * drawers cannot drift from the row the way the earlier hand-written copies did.
 */
function seatListeningState(session) {
  const joined = Boolean(session?.joined);
  if (!joined) {
    return {
      key: "not-joined",
      mark: "·",
      text: "還沒加入",
      title: "這個終端還沒被核准進入房間。",
      send: "還不能送。它還沒加入房間。",
      fix: "先核准它加入房間。",
      cls: "",
    };
  }
  /* Every state below has its own mark as well as its own colour, including the two greys: the row is
     what a reader uses to decide whether to keep waiting, and colour alone excludes anyone who cannot
     separate these two. */
  if (session?.listening) {
    return {
      key: "listening",
      mark: "●",
      /* "可交辦", not "正在待命". On this screen 待命 already means "approved for standby" (stage two,
         the approve/revoke buttons) and it is the difference between the two that this badge exists
         to show. One word cannot carry both halves of the distinction it is drawing. */
      text: "可交辦",
      send: "交辦會直接送到它手上。",
      fix: "",
      /* Not "馬上收到": the liveness lease runs for up to 15s and the GUI polls every 5s, so a seat
         killed a moment ago still reads as listening for a short while. Saying the delivery goes
         straight to it is true of what we do; promising arrival is a claim about the other end. */
      title: "剛才它還在等工作，交辦會直接送過去。",
      cls: "is-listening",
    };
  }
  if (session?.standbyApproved) {
    return {
      key: "not-listening",
      mark: "○",
      text: "排隊中",
      send: "交辦會進它的收件匣排隊，等它下次 room_wait。（每席最多 32 則還沒結束的交辦，滿了就送不出去。）",
      fix: "到那個終端機視窗，讓它再呼叫一次 room_wait。在那之前交辦會排隊等它，但距離你上次要求超過 12 小時、而且還在排隊的話就會過期（紀錄留著，也可以再按一次重新排隊）。"
        + "不要按撤銷——撤銷之後只有那個終端能自己申請回來。",
      /* This one DOES say what happens next, unlike the ledger line, which is forbidden from doing so.
         The difference is retractability: this is a live view that re-renders every five seconds and
         corrects itself the moment the seat starts listening. A ledger line is permanent, so a
         prediction written there stays on the record after it stops being true. */
      title: "它在房間裡，但現在沒有在等工作。交辦會先排隊，等它下次呼叫 room_wait 才拿得到；沒有辦法從這裡叫醒它。",
      cls: "is-silent",
    };
  }
  if (session?.standbyRequested) {
    return {
      key: "awaiting-approval",
      mark: "◌",
      text: "等你核准",
      /* Refused, not queued: postToExternal throws TARGET_AGENT_STANDBY_NOT_APPROVED before anything
         is enqueued. And the fix is a button right here, not a trip to the terminal. */
      send: "還不能送，先在這裡按核准。",
      fix: "按這一列（或通知抽屜）的「核准」就可以了。",
      title: "它申請了待命，你按核准之後才能交辦。",
      cls: "is-pending",
    };
  }
  /*
   * Deliberately not "還沒申請待命". Revoking standby clears the request and the approval together, so
   * a seat you just revoked is indistinguishable in the data from one that never asked -- and telling
   * the person who revoked it that it "hasn't asked yet" is simply false. This says what is true of
   * both: there is no standby authority right now, and only the terminal can ask for it.
   */
  return {
    key: "no-standby",
    mark: "–",
    text: "不可交辦",
    send: "還不能送，它沒有待命授權，只有那個終端能自己再申請。",
    fix: "只有那個終端能自己再呼叫一次 room_wait 來申請待命，你在這裡按不回來。",
    title: "這個席位現在沒有待命授權，交辦不到它。要恢復，得由那個終端自己再呼叫一次 room_wait。",
    cls: "",
  };
}
/* @pure-end seat-listening-state */

/* @pure-start seat-identity
 * What tells two terminals of the same provider apart before the owner names them: the seat's own
 * id and the workspace directory. The host pid is deliberately not shown -- the presence API
 * withholds it from the browser and test/web.test.ts pins that. A terminal can read its own id
 * from list_agents and say "I am 68589d86", which is the whole point of showing it here. Only
 * the last path segment is shown, anywhere: the sidebar is 248px wide, and a full path under a
 * home directory is a name that does not belong in the DOM.
 */
function workspaceLabel(workspace) {
  const parts = String(workspace || "").split("/").filter((part) => part.length > 0);
  return parts.length > 0 ? parts[parts.length - 1] : "";
}

function seatTag(seatId) {
  return String(seatId || "").split("-")[0].slice(0, 8);
}

function seatIdentityText(session) {
  const dir = workspaceLabel(session?.workspace);
  const tag = seatTag(session?.id);
  if (tag) return dir ? `席位 ${tag} · ${dir}` : `席位 ${tag}`;
  return dir;
}
/* @pure-end seat-identity */

/**
 * The day a message is filed under, and the group element that holds it.
 *
 * Creating a group is the ONLY place its open/closed state is decided. Once a reader has collapsed
 * a day, arriving messages must not reopen it — a stream that keeps overriding what you just did is
 * worse than one that never grouped at all.
 */
function ledgerDayGroupElement(ledger, key, todayKey) {
  const existing = ledger.querySelector(`details.day[data-day="${key}"]`);
  if (existing) return existing;
  const group = document.createElement("details");
  group.className = "day";
  group.dataset.day = key;
  /* New groups arrive at the bottom, which is where the newest day belongs, so a group created
   * while the room is live IS the current day and opens. Older days rendered by a history load are
   * closed by showMessages afterwards, which knows the full set and can tell newest from older. */
  group.open = true;
  const summary = document.createElement("summary");
  const label = document.createElement("span");
  label.className = "day-label";
  label.textContent = ledgerDayLabel(key, todayKey);
  const count = document.createElement("span");
  count.className = "day-count";
  summary.append(label, count);
  group.append(summary);
  ledger.append(group);
  return group;
}

function refreshLedgerDayCounts(ledger) {
  for (const group of ledger.querySelectorAll("details.day")) {
    const total = group.querySelectorAll("article.msg").length;
    const count = group.querySelector(".day-count");
    if (count) count.textContent = `${total} 則`;
  }
}

function showMessages(messages, replace) {
  const ledger = byId("ledger");
  if (replace) ledger.textContent = "";
  ledger.querySelector(".welcome")?.remove();
  const todayKey = ledgerDayKey(new Date());
  const { openKey } = ledgerDayGroups(messages, todayKey);
  for (const message of messages) {
    const key = ledgerDayKey(message.at);
    ledgerDayGroupElement(ledger, key, todayKey).append(renderMessage(message));
  }
  if (replace) {
    /* Only a full rebuild knows which day is newest; live appends must leave the reader's own
     * expand/collapse decisions alone. */
    for (const group of ledger.querySelectorAll("details.day")) {
      group.open = group.dataset.day === openKey;
    }
  }
  refreshLedgerDayCounts(ledger);
  if (!replace) ledger.scrollTop = ledger.scrollHeight;
}

function updateRoomInfo(room) {
  if (!room) return;
  const recording = room.recording === "on";
  const paused = room.recording === "paused";
  byId("rec-state").textContent = recording ? "收錄中 ● REC" : paused ? "已暫停 ⏸" : "已關閉 ■";
  byId("rec-dot").className = recording ? "dot on" : "dot";
  byId("room-stats").textContent = `${room.messages} 則 · ${(room.bytes / 1024).toFixed(1)} KiB`;
  /* 頂欄只留一個狀態符號與最新編號（● #824）；完整說明留在房間選單裡，按鈕本身仍是同一顆 rec-toggle。 */
  const seq = Number(state.after) > 0 ? Number(state.after) : Number(room.messages || 0);
  const topDot = byId("topbar-rec-dot");
  if (topDot) topDot.className = recording ? "dot on" : paused ? "dot paused" : "dot off";
  const topState = byId("topbar-rec-state");
  if (topState) topState.textContent = `${recording ? "" : paused ? "⏸ " : "■ "}#${seq}`;
  const toggle = byId("rec-toggle");
  toggle.dataset.next = recording ? "paused" : "on";
  toggle.title = recording
    ? `收錄中 · 最新 #${seq} · 點一下暫停收錄`
    : paused ? "已暫停收錄 · 點一下恢復" : "收錄已關閉 · 點一下恢復";
  toggle.setAttribute("aria-label", toggle.title);
  renderTopbarCounts();
}

function ingestRoomNotifications(messages) {
  for (const message of messages) {
    if (message.kind === "system" && /失敗|停止|取消/u.test(message.text)) {
      addOfficeNotification("error", "Room 工作需要注意", message.text);
    } else if (message.kind === "chat" && ROOM_RESIDENT_PROVIDER_IDS.includes(providerForAgent(message.author))) {
      addOfficeNotification("message", `${message.author} 有新回覆`, message.text);
    }
  }
}

function presenceViewSignature(sessions) {
  return JSON.stringify((sessions || []).map((session) => ({
    id: session.id,
    provider: session.provider,
    client: session.client || "",
    model: session.model || "",
    joined: Boolean(session.joined),
    requested: Boolean(session.requested),
    listening: Boolean(session.listening),
    standbyRequested: Boolean(session.standbyRequested),
    standbyApproved: Boolean(session.standbyApproved),
    displayName: session.displayName || "",
    collaborationMode: session.collaborationMode || "",
    syncTurns: Boolean(session.syncTurns),
  })));
}

function renderPresencePanel() {
  const sessions = state.presences || [];
  const focusedInput = document.activeElement?.classList?.contains("presence-name-input")
    ? {
        id: document.activeElement.dataset.presenceId,
        list: document.activeElement.closest(".office-presence-list")?.id,
        start: document.activeElement.selectionStart,
        end: document.activeElement.selectionEnd,
      }
    : null;
  state.presenceViewSignature = presenceViewSignature(sessions);
  const joinedCount = sessions.filter((session) => session.joined).length;
  const pendingJoinCount = sessions.filter((session) => session.requested && !session.joined).length;
  const pendingStandbyCount = sessions.filter(
    (session) => session.joined && session.standbyRequested && !session.standbyApproved,
  ).length;
  const wakeableCount = sessions.filter((session) => session.wakeable).length;
  const presenceCount = byId("office-presence-count");
  if (presenceCount) {
    presenceCount.textContent =
      `${joinedCount} 已加入 · ${wakeableCount} 可交辦 · ${state.managedAgents.length} 子 Agent`;
  }
  const room = state.rooms.find((entry) => entry.id === state.room);
  if (room) {
    room.pendingAgentRequests = pendingJoinCount;
    room.pendingStandbyRequests = pendingStandbyCount;
  }
  renderRoomCatalog();
  for (const listId of ["office-presence-list", "sidebar-presence-list"]) {
    const list = byId(listId);
    if (!list) continue;
    list.textContent = "";
    if (!sessions.length) {
      const empty = document.createElement("p");
      empty.textContent = "目前沒有在線終端提出加入申請；帳本中的舊名稱只是歷史紀錄，離線後不建立空工位。";
      list.append(empty);
      continue;
    }
    sessions.forEach((session, index) => {
      const row = document.createElement("div");
      const selected = state.selectedPresenceId === session.id;
      row.className = `office-presence-row ${session.joined ? "is-joined" : ""} ${selected ? "is-selected" : ""}`;
      const identity = document.createElement("button");
      identity.type = "button";
      identity.className = "office-presence-identity";
      identity.setAttribute("aria-pressed", String(selected));
      const dot = document.createElement("i");
      dot.style.background = authorColor(session.provider);
      const label = document.createElement("b");
      /* Before approval a seat has no display name, and "claude 申請 1 / claude 申請 2" told the
         owner nothing about which terminal was asking. The seat tag goes in the title: two seats in
         the same workspace share the directory name, so the tag is the only thing that tells them
         apart, and the title column is narrow enough (an approve button sits beside it) that a
         directory name there was cut to "orchestrat…" in a real browser. The directory sits on the
         line below, where wrapping is fine. */
      const identityText = seatIdentityText(session);
      const tag = seatTag(session.id);
      label.textContent = session.displayName
        || (tag ? `${session.provider} · ${tag}` : `${session.provider} 申請 ${index + 1}`);
      /* The hover title repeats the identity text, not the full path: the same minimal-disclosure
         line that keeps host_pid out of the browser keeps a home-directory path out of the DOM. */
      identity.title = identityText;
      const listening = seatListeningState(session);
      const badge = document.createElement("span");
      badge.className = `seat-listening ${listening.cls}`;
      badge.title = listening.title;
      badge.textContent = `${listening.mark} ${listening.text}`;
      const detail = document.createElement("small");
      /* The answer first, the technical identity after it. The reader's question is what happens if
         they send something now; five terms of provenance ahead of it is five terms of delay. */
      detail.textContent = session.joined
        ? `${listening.send} · Native Full-Trust · host 能力不變 · ${session.collaborationMode === "room-first" ? "全程帳本協作" : "僅加入房間"} · ${session.syncTurns ? "終端對話同步" : "終端對話不入帳"}`
        : selected
          ? "已選取 · 請確認協作與對話同步模式"
          : `${workspaceLabel(session.workspace) ? `${workspaceLabel(session.workspace)} · ` : ""}點擊選取`;
      identity.append(dot, label, badge, detail);
      /* A joined seat keeps its identity on its own short line instead of inside the capability
         sentence, which was already long before it carried a pid and a directory. */
      if (session.joined && identityText) {
        const seatLine = document.createElement("small");
        seatLine.className = "seat-identity";
        seatLine.textContent = identityText;
        identity.append(seatLine);
      }
      identity.addEventListener("click", () => {
        state.selectedPresenceId = selected ? "" : session.id;
        renderPresencePanel();
      });
      let nameInput;
      let modeSelect;
      let syncLabel;
      if (!session.joined) {
        nameInput = document.createElement("input");
        nameInput.type = "text";
        nameInput.className = "presence-name-input";
        nameInput.dataset.presenceId = session.id;
        nameInput.maxLength = 24;
        nameInput.value = state.presenceLabels[session.id] || "";
        nameInput.placeholder = "取名或編號（可留空）";
        nameInput.setAttribute("aria-label", `為 ${session.provider} 設定名稱或編號`);
        nameInput.addEventListener("input", () => {
          state.presenceLabels[session.id] = nameInput.value;
          for (const peer of document.querySelectorAll(`.presence-name-input[data-presence-id="${CSS.escape(session.id)}"]`)) {
            if (peer !== nameInput) peer.value = nameInput.value;
          }
          detail.textContent = nameInput.value.trim()
            ? `將建立 ${session.provider}（${nameInput.value.trim()}）`
            : "留空則由系統自動編號";
        });
        nameInput.addEventListener("click", (event) => event.stopPropagation());

        modeSelect = document.createElement("select");
        modeSelect.className = "presence-mode-select";
        modeSelect.dataset.presenceId = session.id;
        modeSelect.setAttribute("aria-label", `選擇 ${session.provider} 的協作模式`);
        const roomFirst = document.createElement("option");
        roomFirst.value = "room-first";
        roomFirst.textContent = "全程帳本協作（MCP 路由，建議）";
        const seatOnly = document.createElement("option");
        seatOnly.value = "seat-only";
        seatOnly.textContent = "僅加入房間（非 room-first）";
        modeSelect.append(roomFirst, seatOnly);
        modeSelect.value = state.presenceJoinModes[session.id] || "room-first";
        state.presenceJoinModes[session.id] = modeSelect.value;
        modeSelect.addEventListener("change", () => {
          state.presenceJoinModes[session.id] = modeSelect.value;
          for (const peer of document.querySelectorAll(`.presence-mode-select[data-presence-id="${CSS.escape(session.id)}"]`)) {
            if (peer !== modeSelect) peer.value = modeSelect.value;
          }
        });
        modeSelect.addEventListener("click", (event) => event.stopPropagation());

        syncLabel = document.createElement("label");
        syncLabel.className = "presence-sync-label";
        const syncInput = document.createElement("input");
        syncInput.type = "checkbox";
        syncInput.className = "presence-sync-input";
        syncInput.dataset.presenceId = session.id;
        syncInput.checked = state.presenceTurnSync[session.id] !== false;
        state.presenceTurnSync[session.id] = syncInput.checked;
        syncInput.addEventListener("change", () => {
          state.presenceTurnSync[session.id] = syncInput.checked;
          for (const peer of document.querySelectorAll(`.presence-sync-input[data-presence-id="${CSS.escape(session.id)}"]`)) {
            if (peer !== syncInput) peer.checked = syncInput.checked;
          }
        });
        syncLabel.addEventListener("click", (event) => event.stopPropagation());
        syncLabel.append(syncInput, document.createTextNode(" 同步此終端的使用者／Assistant 可見對話"));
      }
      const actions = seatActionButtons(session, listening);
      /*
       * 加入房間與 room-wait 待命是兩個不同的授權，但對使用者來說是同一個 Agent 的
       * 第一步與第二步；用漸進式卡片呈現，避免看起來像重複詢問。核准鈕就在同一列。
       */
      const stages = document.createElement("div");
      stages.className = "presence-stages";
      const standbyPending = Boolean(session.joined && session.standbyRequested && !session.standbyApproved);
      const stageOne = document.createElement("span");
      stageOne.className = `presence-stage ${session.joined ? "is-done" : "is-waiting"}`;
      stageOne.textContent = session.joined ? "① 已加入房間" : "① 待核准加入房間";
      const stageTwo = document.createElement("span");
      stageTwo.className = `presence-stage ${
        session.standbyApproved ? "is-done" : standbyPending ? "is-waiting" : ""
      }`;
      stageTwo.textContent = !session.joined
        ? "② 待命（加入後由終端自行申請）"
        : session.standbyApproved
          ? session.listening
            ? "② 待命已核准 · 可交辦"
            : "② 待命已核准 · 排隊中"
          : standbyPending ? "② 待命待核准" : "② 沒有待命授權";
      stages.append(stageOne, stageTwo);
      if (standbyPending) {
        const hint = document.createElement("small");
        hint.className = "presence-stage-hint";
        hint.textContent = "同一個 Agent 的第二步：加入房間決定是否入帳，待命決定它能不能收工作。";
        stages.append(hint);
      }
      /*
       * Telling someone a seat is deaf without telling them what to do about it leaves them with one
       * visible button on this row -- the red "撤銷 room-wait 待命" -- which makes it worse and cannot
       * be undone from here: revoking clears both the request and the approval, so neither standby
       * button renders afterwards and only the terminal itself can ask again. So the row says what
       * actually helps, in the place where the wrong action is easiest to reach.
       */
      if (session.joined && listening.fix) {
        const action = document.createElement("small");
        action.className = "presence-stage-hint is-action";
        action.textContent = `怎麼辦：${listening.fix}`;
        stages.append(action);
      }
      /*
       * Each kind shown for as long as what it says stays true.
       *
       * "recorded" is about an ongoing silence: left standing after the seat returns it would sit
       * under a "正在收聽" badge, with the button and the "怎麼辦" line already gone, reading as "I
       * rang and it came back" -- every time, as the ordinary ending, not as a race.
       *
       * "noop" is about the click itself, so it is NOT gated on the seat being silent. It cannot be:
       * the only way to produce it is the seat turning out to be listening.
       */
      const wakeEntry = (state.wakeNotices || {})[session.id];
      const wakeNotice = !wakeEntry
        ? ""
        : wakeEntry.kind === "noop"
          ? (Date.now() - wakeEntry.at < WAKE_NOOP_NOTICE_MS ? wakeEntry.text : "")
          : (listening.key === "not-listening" ? wakeEntry.text : "");
      if (wakeNotice) {
        const notice = document.createElement("small");
        notice.className = "presence-stage-hint is-wake-notice";
        /* role=status because this sentence is the only thing standing between the click and the
           wrong conclusion. Weaker than the other one-shot receipts here, which are pre-existing empty
           live regions whose textContent changes -- a region inserted together with its content is
           often not announced at all. Kept because it costs nothing and sometimes helps; not claimed
           as equivalent. */
        notice.setAttribute("role", "status");
        notice.textContent = wakeNotice;
        stages.append(notice);
      }
      row.append(identity, actions, stages);
      if (nameInput) row.append(nameInput);
      if (modeSelect) row.append(modeSelect);
      if (syncLabel) row.append(syncLabel);
      list.append(row);
    });
  }
  if (focusedInput?.id && focusedInput.list) {
    const restored = byId(focusedInput.list)?.querySelector(
      `.presence-name-input[data-presence-id="${CSS.escape(focusedInput.id)}"]`,
    );
    if (restored) {
      restored.focus({ preventScroll: true });
      restored.setSelectionRange(focusedInput.start, focusedInput.end);
    }
  }
  renderSeatChips();
  renderTaskCenter();
}

/*
 * The three buttons a seat row can carry, built once for both the sidebar row and the office task
 * drawer. The text, ordering and demotion rules are the ones the sidebar row settled on; the drawer
 * must not get a second hand-written copy of them.
 */
function seatActionButtons(session, listening) {
  const actions = document.createElement("div");
  actions.className = "presence-actions";
  /* First in the row, ahead of both destructive controls. Someone looking at a seat that is not
     answering is reaching for "do something about this", and the two controls beside this one --
     revoke standby, remove from room -- both make that seat harder to reach, not easier. The safe
     action should be the one their hand lands on. */
  /*
   * Offered only where it can do its one job. On a listening seat there is nothing to record; on
   * a seat with no standby authority a nudge cannot help, and offering it there would put a
   * plausible-looking action next to a problem it does not touch -- which is how someone ends up
   * clicking instead of doing the thing that works.
   */
  if (listening.key === "not-listening") {
    const wake = document.createElement("button");
    wake.type = "button";
    wake.className = "presence-wake";
    /* Not a bell. 🔔 means "summon" in every UI vocabulary there is, and it would be the most
       conspicuous character in the row -- the text would say "record" while the icon said "ring",
       and the icon is what gets believed. */
    wake.textContent = "📝 在帳本記一筆：我找過它";
    /* Does not promise the seat will see it, and the reason has narrowed rather than gone away.
       There is now exactly one path that would show it: a terminal that REJOINS gets a briefing
       with the newest fifty ledger lines, so a note still inside that window would be in front of
       it. A seat that simply resumes standby gets no tail, and agents are told to re-enter
       room_wait rather than to call room_read. So: possible on a rejoin, not otherwise, and never
       something to count on. What we can state is what we do. */
    /* Says what it is FOR, not only what it is not. The disclaimer was clean and the value
       proposition was missing entirely, which leaves a reader with no answer to "then why would I
       press this". The honest answer is small and it is real: a timestamped record, for you. */
    wake.title = "在帳本記下「你在這個時間找過它」，給你自己留個時間點。這不會叫醒它，Orchestratory 沒辦法從這裡叫醒終端機，也不保證它會去讀帳本。要它真的做事，直接交辦——交辦會排隊等它。";
    wake.addEventListener("click", () => void requestPresenceWake(session, wake));
    actions.append(wake);
  }
  if (session.joined && session.standbyRequested && !session.standbyApproved) {
    const standby = document.createElement("button");
    standby.type = "button";
    standby.textContent = "核准 room-wait 待命";
    standby.className = "join";
    standby.addEventListener("click", () => void changePresenceStandby(session, "approve", standby));
    actions.append(standby);
  } else if (session.joined && session.standbyApproved) {
    const standby = document.createElement("button");
    standby.type = "button";
    standby.textContent = "撤銷 room-wait 待命";
    /* Demoted while the seat is deaf. Revoking is the one destructive action on this row and, on a
       seat that is not listening, it is also the action a reader is most likely to reach for --
       it is the only standby control in sight and it sounds like it addresses the problem. It does
       the opposite and cannot be undone from the GUI. */
    standby.className = listening.key === "not-listening" ? "leave is-demoted" : "leave";
    standby.title = listening.key === "not-listening"
      ? "撤銷不會讓它重新收聽，反而會拿掉它的待命授權，而且只有那個終端能自己申請回來。"
      : "撤銷之後這個席位不能再收工作，要由該終端自己重新呼叫 room_wait。";
    standby.addEventListener("click", () => void changePresenceStandby(session, "revoke", standby));
    actions.append(standby);
  }
  const membership = document.createElement("button");
  membership.type = "button";
  membership.textContent = session.joined ? "移出房間" : "核准加入房間";
  membership.className = session.joined ? "leave" : "join";
  membership.addEventListener("click", () => {
    void changePresenceMembership(session, membership);
  });
  actions.append(membership);
  return actions;
}

function managedAgentViewSignature(agents) {
  return JSON.stringify((agents || []).map((agent) => ({
    id: agent.id,
    displayName: agent.displayName,
    provider: agent.provider,
    model: agent.model,
    busy: Boolean(agent.busy),
  })));
}

function renderManagedAgents() {
  state.managedAgentViewSignature = managedAgentViewSignature(state.managedAgents);
  const joinedCount = state.presences.filter((session) => session.joined).length;
  const wakeableCount = state.presences.filter((session) => session.wakeable).length;
  const presenceCount = byId("office-presence-count");
  if (presenceCount) {
    presenceCount.textContent =
      `${joinedCount} 已加入 · ${wakeableCount} 可交辦 · ${state.managedAgents.length} 子 Agent`;
  }
  for (const listId of ["sidebar-managed-agent-list", "office-managed-agent-list"]) {
    const list = byId(listId);
    if (!list) continue;
    list.textContent = "";
    if (!state.managedAgents.length) {
      const empty = document.createElement("p");
      empty.textContent = "尚未建立受控即時 Agent。";
      list.append(empty);
      continue;
    }
    for (const agent of state.managedAgents) {
      const row = document.createElement("div");
      row.className = `office-presence-row is-managed ${agent.busy ? "is-busy" : ""}`;
      const identity = document.createElement("button");
      identity.type = "button";
      identity.className = "office-presence-identity";
      const dot = document.createElement("i");
      dot.style.background = authorColor(agent.provider);
      const name = document.createElement("b");
      name.textContent = agent.displayName;
      const detail = document.createElement("small");
      detail.textContent = agent.busy
        ? "GUI Managed · 回覆中（請勿打擾）"
        : `GUI Managed · 對話唯讀 · ${agent.model} · Writer 需另行授權`;
      identity.append(dot, name, detail);
      identity.addEventListener("click", () => focusAgentComposer(agent.displayName));
      const action = document.createElement("button");
      action.type = "button";
      action.className = agent.busy ? "cancel" : "leave";
      action.textContent = agent.busy ? "取消回覆" : "移除子 Agent";
      action.addEventListener("click", () => void changeManagedAgent(agent, action));
      row.append(identity, action);
      list.append(row);
    }
  }
  renderSeatChips();
  renderTaskCenter();
}

async function changeManagedAgent(agent, button) {
  button.disabled = true;
  try {
    const value = await api(`/api/rooms/managed-agents/${agent.busy ? "cancel" : "archive"}`, {
      method: "POST",
      body: JSON.stringify({ room: state.room, agentId: agent.id }),
    });
    if (!agent.busy && value.agent) {
      state.managedAgents = state.managedAgents.filter((entry) => entry.id !== agent.id);
    }
    await refreshPresence(true);
    await poll();
  } catch (error) {
    showRoomError(error, { prefix: "受控 Agent 操作失敗" });
  } finally {
    button.disabled = false;
  }
}

async function changePresenceMembership(session, button) {
  if (!state.room) return;
  button.disabled = true;
  const joining = !session.joined;
  button.textContent = joining ? "建立中…" : "移除中…";
  try {
    const value = await api(`/api/rooms/presence/${joining ? "join" : "leave"}`, {
      method: "POST",
      body: JSON.stringify({
        room: state.room,
        presenceId: session.id,
        ...(joining && state.presenceLabels[session.id]?.trim()
          ? { label: state.presenceLabels[session.id].trim() }
          : {}),
        ...(joining
          ? {
              collaborationMode: state.presenceJoinModes[session.id] || "room-first",
              syncTurns: state.presenceTurnSync[session.id] !== false,
            }
          : {}),
      }),
    });
    if (joining && value.session) {
      state.presences = [...(state.presences || []).filter((entry) => entry.id !== value.session.id), value.session];
      delete state.presenceLabels[session.id];
      delete state.presenceJoinModes[session.id];
      delete state.presenceTurnSync[session.id];
      state.selectedPresenceId = "";
    } else if (!joining) {
      state.presences = (state.presences || []).filter((entry) => entry.id !== session.id);
      if (state.selectedPresenceId === session.id) state.selectedPresenceId = "";
    }
    renderPresencePanel();
    syncOfficeDesks();
    if (!byId("office").hidden) updateOffice(state.recent || []);
    await refreshPresence(true);
    await poll();
  } catch (error) {
    showRoomError(error, { prefix: joining ? "核准加入房間失敗" : "移出房間失敗", session });
    renderPresencePanel();
  }
}

/*
 * Record that the owner wanted this seat's attention.
 *
 * It does not wake anything. MCP over stdio is request/response -- the server cannot push to a
 * terminal that is not asking -- so a button that appeared to wake a seat would be the most harmful
 * thing this panel could contain: an owner who believes help is coming stops looking for the reason
 * it is not. Everything this function shows is therefore written to be readable as "recorded", never
 * as "sent" or "woken" -- with one deliberate exception, the branch that reports the seat turned out
 * to be listening and therefore says nothing was recorded at all.
 *
 * What it does do is real, and smaller than it first sounds: the line lands in the ledger, where that
 * seat CAN read it with room_read, and one path now puts it in front of them without being asked: a
 * terminal that REJOINS receives a briefing carrying the newest fifty ledger lines. That is narrow --
 * it needs a rejoin, and the note has to still be inside that window -- and a seat that merely resumes
 * standby gets no tail at all, while agents are told to re-enter room_wait rather than to read. So
 * being seen is a possibility with one real route, not a guarantee. The part that does not depend on
 * the other end is still the owner's own timestamped record of having looked for it.
 */
async function requestPresenceWake(session, button) {
  if (!state.room) return;
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "記錄中…";
  try {
    const value = await api("/api/rooms/presence/nudge", {
      method: "POST",
      body: JSON.stringify({ room: state.room, presenceId: session.id }),
    });
    /*
     * Deliberately NOT re-inserting the session at the end of state.presences, unlike the standby and
     * membership handlers. Those splice because the server state genuinely changed, and their next
     * refresh restores the server's ordering. A nudge changes nothing, so `presenceChanged` stays
     * false and the reordering would never be undone: clicking a button that does nothing to the seat
     * would move that seat to the bottom of the list, permanently.
     *
     * The session IS adopted, though -- in place. An earlier version of this comment said there was
     * nothing to merge, and the line directly below it merged. The seat may have started listening
     * since the last poll, which is exactly the case the no-op receipt reports, and the row must not
     * keep saying otherwise for the five seconds until the throttle lets a refresh through.
     */
    /*
     * Adopt the session the server just returned, IN PLACE.
     *
     * On the no-op path the click has just proved the panel is stale: the seat is listening and this
     * row still says it is not. `refreshPresence` is throttled to five seconds and `poll()` does not
     * force it, so without this the receipt would read "它其實已經在收聽了" beside a badge saying
     * "○ 沒在收聽", a wake button, and instructions to go restart a room_wait that is already open --
     * for up to five seconds. In place rather than re-appended, because a nudge changes nothing about
     * the seat and must not reorder the list: the handlers that do splice are corrected by their next
     * refresh, and this one would never be.
     */
    if (value.session) {
      state.presences = (state.presences || []).map((entry) => (entry.id === value.session.id ? value.session : entry));
    }
    /* The outcome sentence is the whole point of this button, so it goes on screen rather than into a
       tooltip, and it never says the seat was reached. */
    /*
     * Two different sentences with two different lifetimes, so they carry which kind they are.
     *
     * "recorded" describes a silence that is still going on, so it belongs on screen for as long as
     * that silence lasts and must vanish when it ends. "noop" describes THIS CLICK -- the seat turned
     * out to be listening -- and gating that on the seat being silent, which an earlier version did,
     * made it unreachable: the only way to see it is the case where the condition is false. The user
     * then got a button that vanished, a badge that flipped to 正在收聽, and no words at all, which
     * is precisely the "I rang and it came back" reading this whole item exists to prevent.
     */
    state.wakeNotices = { ...(state.wakeNotices || {}), [session.id]: value.listening
      ? { kind: "noop", at: Date.now(), text: "它其實已經在收聽了，所以沒有記錄——直接交辦就會送過去。" }
      /* Names the time on the record, not the time of this click. A second press inside the same
         minute lands on the line the first one wrote; saying "已記一筆（含時間）" then would name a
         timestamp that belongs to the earlier press. */
      : { kind: "recorded", at: Date.now(), text: value.fresh
          ? `已在帳本記一筆（${wakeClock(value.recordedAt)}）。它不一定會讀到。`
          : `這一分鐘已經記過了（${wakeClock(value.recordedAt)}），沒有再記一筆。它不一定會讀到。` } };
    if (value.listening) {
      /* Only the no-op receipt needs a repaint: it expires on a clock and nothing else re-renders this
         panel while the seat stays listening. The recorded one expires when the seat stops being
         silent, which IS a presence change, so scheduling one for it would rebuild every row -- and
         rebuilding drops any open <select> and the focus inside it -- for no reason. */
      clearTimeout(state.wakeNoticeTimers[session.id]);
      state.wakeNoticeTimers[session.id] = setTimeout(() => {
        delete state.wakeNoticeTimers[session.id];
        renderPresencePanel();
      }, WAKE_NOOP_NOTICE_MS + 250);
    }
    renderPresencePanel();
    /* No shortened refresh interval, unlike approving standby: a nudge changes nothing about the seat,
       so there is nothing new to look for. The one case where the panel WAS stale -- the seat turned
       out to be listening -- is corrected above from the session the server just returned, rather than
       by asking again. */
    await poll();
  } catch (error) {
    showRoomError(error, { prefix: "記錄失敗" });
    button.disabled = false;
    button.textContent = original;
  }
}

async function changePresenceStandby(session, action, button) {
  if (!state.room) return;
  button.disabled = true;
  button.textContent = action === "approve" ? "核准中…" : "撤銷中…";
  try {
    const value = await api(`/api/rooms/presence/standby/${action}`, {
      method: "POST",
      body: JSON.stringify({ room: state.room, presenceId: session.id }),
    });
    if (value.session) {
      state.presences = [...state.presences.filter((entry) => entry.id !== value.session.id), value.session];
    }
    renderPresencePanel();
    renderOfficeNotifications();
    syncOfficeDesks();
    if (!byId("office").hidden) updateOffice(state.recent || []);
    await refreshPresence(true);
    /*
     * Look again sooner than the usual five seconds. The terminal picks up an approval on its own
     * 200ms poll, so the refresh that runs immediately after the click almost always still reads
     * "not listening" -- and the row then tells the owner to go make that terminal call room_wait
     * again, while that terminal is already inside one. Following that advice interrupts the very
     * thing they just enabled.
     */
    state.presenceNextAt = Date.now() + 800;
    await poll();
  } catch (error) {
    showRoomError(error, { prefix: "room-wait 待命變更失敗" });
    renderPresencePanel();
  }
}

async function refreshPresence(force = false) {
  if (!state.room || state.presenceRefreshing) return;
  if (!force && Date.now() < state.presenceNextAt) return;
  state.presenceRefreshing = true;
  state.presenceNextAt = Date.now() + 5000;
  const room = state.room;
  try {
    const previous = new Map((state.presences || []).map((session) => [session.id, session]));
    const [value, managedValue, deliveryValue, writerValue] = await Promise.all([
      api(`/api/rooms/presence?room=${encodeURIComponent(room)}`),
      api(`/api/rooms/managed-agents?room=${encodeURIComponent(room)}`),
      api(`/api/rooms/deliveries?room=${encodeURIComponent(room)}`),
      api(`/api/rooms/writers?room=${encodeURIComponent(room)}`),
    ]);
    if (state.room !== room) return;
    const nextPresences = Array.isArray(value.sessions) ? value.sessions : [];
    const nextManagedAgents = Array.isArray(managedValue.agents) ? managedValue.agents : [];
    const nextDeliveries = Array.isArray(deliveryValue.deliveries) ? deliveryValue.deliveries : [];
    for (const session of [...state.presences, ...nextPresences]) {
      if (session.joined && session.displayName) state.knownExternalNames.add(session.displayName);
    }
    /*
     * A wake notice belongs to one stretch of silence. Once the seat is listening the ask is over, so
     * the notice is dropped rather than merely hidden -- otherwise it would reappear the next time
     * that seat went quiet, telling the owner "已在帳本記下你找過它" about a request from an hour ago.
     * Seats that have gone away entirely lose theirs too, so the map cannot grow without bound.
     */
    if (state.wakeNotices) {
      /* Two rules, because the two kinds of notice are about different things.
         A `recorded` notice belongs to one stretch of silence, so it is dropped the moment that seat
         stops being silent -- using the SAME predicate the renderer uses, not an approximation.
         (`!listening` is a wider set, also true for awaiting-approval and no-standby, so a notice on a
         seat passing through those was hidden but kept, and reappeared an hour later.)
         A `noop` notice is about one click, so only time retires it. It is deliberately NOT tied to
         the seat still being present or still listening: it says what happened when the button was
         pressed, and that stays true whatever the seat does next. The cost is that a seat which
         vanishes inside the window leaves its entry until the window ends. */
      const stillSilent = new Set(
        nextPresences.filter((session) => seatListeningState(session).key === "not-listening").map((session) => session.id),
      );
      for (const [id, entry] of Object.entries(state.wakeNotices)) {
        if (entry.kind === "noop") {
          if (Date.now() - entry.at >= WAKE_NOOP_NOTICE_MS) delete state.wakeNotices[id];
        } else if (!stillSilent.has(id)) {
          delete state.wakeNotices[id];
        }
      }
    }
    const presenceChanged = presenceViewSignature(nextPresences) !== state.presenceViewSignature;
    const managedChanged = managedAgentViewSignature(nextManagedAgents) !== state.managedAgentViewSignature;
    state.presences = nextPresences;
    state.managedAgents = nextManagedAgents;
    state.deliveries = nextDeliveries;
    state.writers = {
      leases: Array.isArray(writerValue.leases) ? writerValue.leases : [],
      delegations: Array.isArray(writerValue.delegations) ? writerValue.delegations : [],
      candidates: Array.isArray(writerValue.candidates) ? writerValue.candidates : [],
      busyLeaseIds: Array.isArray(writerValue.busyLeaseIds) ? writerValue.busyLeaseIds : [],
    };
    if (state.controlInitialized) {
      for (const session of state.presences) {
        const before = previous.get(session.id);
        if (!before && !session.joined) {
          addOfficeNotification("presence", `${session.provider} 申請加入 Room`, "請在左側「新增 Agents」審核；批准前不會記錄內容。", false);
        }
        if (session.joined && session.standbyRequested && !before?.standbyRequested) {
          addOfficeNotification(
            "presence",
            `${session.displayName || session.provider} 申請 room-wait 待命`,
            "同一個 Agent 的第二步（① 已加入 → ② 待命待核准）。核准只是「允許它收工作」，不代表它隨時在收聽——它要自己呼叫 room_wait 才收得到，而且沒辦法從這裡叫醒它。可直接在這裡核准。",
            false,
            { kind: "standby-approve", presenceId: session.id },
          );
        }
      }
      for (const [id, before] of previous) {
        if (before.joined && !state.presences.some((session) => session.id === id)) {
          addOfficeNotification("presence", `${before.displayName || before.provider} 已離線`, "終端已關閉，人物與辦公桌已自動移除。", false);
        }
      }
    }
    if (presenceChanged) {
      renderPresencePanel();
      renderOfficeNotifications();
    }
    if (managedChanged) renderManagedAgents();
    refreshDeliveryReceipts();
    renderWriterControl();
    syncOfficeDesks();
    if (!byId("office").hidden) updateOffice(state.recent || []);
  } catch {
    byId("office-presence-count").textContent = "偵測暫時中斷";
  } finally {
    state.presenceRefreshing = false;
  }
}

async function poll() {
  if (!state.room || state.searching || state.mode !== "live" || state.polling || document.hidden) return;
  state.polling = true;
  const room = state.room;
  try {
    const previousAfter = state.after;
    const value = await api(`/api/rooms/messages?room=${encodeURIComponent(room)}&after=${state.after}`);
    if (state.room !== room) return;
    if (value.messages.length) {
      if (state.roomInitialized && previousAfter > 0) {
        ingestRoomNotifications(value.messages.filter((message) => message.seq > previousAfter));
      }
      showMessages(value.messages, false);
      state.after = value.messages[value.messages.length - 1].seq;
      state.recent = [...(state.recent || []), ...value.messages].slice(-30);
    }
    state.roomInitialized = state.after >= Number(value.room?.messages || state.after);
    updateWaitingIndicator(state.recent || []);
    updateRoomInfo(value.room);
    if (Array.isArray(value.authorStats)) {
      updateAuthorStats(value.authorStats);
      state.stats = value.authorStats;
    }
    void refreshPresence();
    if (!byId("office").hidden) updateOffice(state.recent || []);
    byId("connection").textContent = "直播中";
    byId("connection").className = "conn ready";
  } catch (error) {
    showRoomError(error, { prefix: "連線錯誤" });
  } finally {
    state.polling = false;
  }
}

async function loadHistory(reset) {
  if (!state.room || state.searching) return;
  const before = reset ? 0 : state.historyBefore;
  try {
    const value = await api(`/api/rooms/messages?room=${encodeURIComponent(state.room)}&before=${before}`);
    state.historyMessages = reset
      ? value.messages
      : [...value.messages, ...state.historyMessages];
    state.recent = state.historyMessages.slice(-30);
    showMessages(state.historyMessages, true);
    state.historyBefore = state.historyMessages[0]?.seq || 0;
    byId("older-history").hidden = !value.hasMoreBefore;
    byId("older-history").disabled = false;
    updateRoomInfo(value.room);
    if (Array.isArray(value.authorStats)) updateAuthorStats(value.authorStats);
    if (!byId("office").hidden) updateOffice(state.recent);
    byId("connection").textContent = `歷史模式 · 已載入 ${state.historyMessages.length}/${value.room.messages} 則`;
    byId("connection").className = "conn ready";
    byId("ledger").scrollTop = reset ? byId("ledger").scrollHeight : 0;
  } catch (error) {
    byId("older-history").disabled = false;
    showRoomError(error, { prefix: "載入失敗" });
  }
}

async function selectRoom(id) {
  if (state.room) state.officeLayouts[state.room] = { ...state.officePositions };
  state.room = id;
  state.after = 0;
  state.historyBefore = 0;
  state.historyMessages = [];
  state.officeChatSignature = "";
  state.presences = [];
  state.managedAgents = [];
  state.writers = { leases: [], delegations: [], candidates: [], busyLeaseIds: [] };
  state.knownExternalNames = new Set();
  state.deliveries = [];
  closeMergeApprovalDialog();
  state.mergeApprovals = [];
  state.mergeApprovalsRoom = "";
  renderMergeApprovalBadge();
  state.mergeHistory = [];
  state.mergeUnpromotedApprovals = [];
  state.mergeHistoryLoaded = false;
  state.mergeHistoryRoom = "";
  renderMergeHistoryBadge();
  state.selectedPresenceId = "";
  state.presenceLabels = {};
  state.presenceViewSignature = "";
  state.managedAgentViewSignature = "";
  state.officePositions = { ...(state.officeLayouts[id] || {}) };
  state.presenceNextAt = 0;
  state.roomInitialized = false;
  state.cancelledMentions.clear();
  byId("ledger").textContent = "";
  const roomInfo = state.rooms.find((room) => room.id === id);
  byId("office-chat-room").textContent = roomInfo?.projectName || id || "LIVE";
  byId("office-chat-room").title = roomInfo ? `${roomInfo.workspace} · 內部 Room ID：${id}` : id;
  closeOfficeSidePanels();
  byId("office-agent-card").hidden = true;
  state.selectedAgent = "";
  const next = new URL(window.location.href);
  next.searchParams.set("room", id);
  if (state.mode === "history") next.searchParams.set("mode", "history");
  else next.searchParams.delete("mode");
  window.history.replaceState(null, "", next);
  byId("live-link").href = `/room?room=${encodeURIComponent(id)}`;
  byId("history-link").href = `/room?mode=history&room=${encodeURIComponent(id)}`;
  if (state.mode === "history") await loadHistory(true);
  else {
    await refreshPresence(true);
    await poll();
  }
  await refreshMergeApprovals();
  try { await refreshMergeHistory(); } catch { /* 歷史讀不到不阻斷 Room 切換。 */ }
}

function roomOptionLabel(room) {
  const pending = roomPendingCount(room);
  const project = room.projectName || room.workspace?.split("/").filter(Boolean).at(-1) || room.id;
  return `${project} — ${room.id}${pending > 0 ? ` · ${pending} 件申請` : ""}`;
}

function roomPendingCount(room) {
  return Number(room?.pendingAgentRequests || 0) + Number(room?.pendingStandbyRequests || 0);
}

function renderRoomCatalog() {
  const select = byId("room-select");
  if (!select) return;
  const selected = state.room || select.value;
  select.textContent = "";
  for (const room of state.rooms) select.append(new Option(roomOptionLabel(room), room.id));
  if (state.rooms.some((room) => room.id === selected)) select.value = selected;
  const globalPending = state.rooms.reduce((sum, room) => sum + roomPendingCount(room), 0);
  const badge = byId("agent-request-count");
  badge.textContent = String(globalPending);
  badge.hidden = globalPending === 0;
  const pendingProjects = state.rooms.filter((room) => roomPendingCount(room) > 0);
  const opener = byId("agent-requests-open");
  if (opener) opener.title = pendingProjects.length === 1 && pendingProjects[0]?.id !== state.room
    ? `終端席位（${pendingProjects[0].projectName} 有申請 · ${globalPending} 件）`
    : globalPending > 0 ? `終端席位（${globalPending} 件申請待核准）` : "終端席位與子 Agent";
  const menuLabel = byId("room-menu-label");
  const current = state.rooms.find((room) => room.id === selected);
  if (menuLabel) menuLabel.textContent = current ? (current.projectName || current.id) : (state.rooms.length ? "選擇房間" : "Room 控制室");
  renderTopbarCounts();
}

/*
 * 頂欄三個數字：終端（已加入房間的 MCP 席位）、子 Agent（GUI Managed）、任務（待確認＋執行中）。
 * 只讀既有 state，不打新的 API；帳本每次輪詢與席位每次重繪都會重算，所以不需要自己的計時器。
 */
function renderTopbarCounts() {
  const terminals = (state.presences || []).filter((session) => session.joined).length;
  const managed = (state.managedAgents || []).length;
  const tasks = (state.pendingWorkflowRequests || []).length + (state.activeRuns || []).length;
  const set = (id, value) => {
    const node = byId(id);
    if (node) node.textContent = String(value);
  };
  set("topbar-terminal-count", terminals);
  set("topbar-managed-count", managed);
  set("topbar-task-count", tasks);
  const dot = byId("room-menu-dot");
  const connection = byId("connection");
  if (dot && connection) {
    dot.className = connection.classList.contains("ready") ? "dot on"
      : connection.classList.contains("error") ? "dot error" : "dot";
  }
}

async function refreshRoomCatalog() {
  const value = await api("/api/rooms");
  state.rooms = Array.isArray(value.rooms) ? value.rooms : [];
  renderRoomCatalog();
  return state.rooms;
}

async function bootstrap() {
  const boot = await api("/api/bootstrap");
  if (boot.roomUiProtocol !== ROOM_UI_PROTOCOL) throw new Error("UI_PROTOCOL_MISMATCH_RESTART_REQUIRED");
  state.csrf = boot.csrf;
  await refreshOfficeControlPlane(boot);
  const rooms = await refreshRoomCatalog();
  const select = byId("room-select");
  if (!rooms.length) {
    select.textContent = "";
    select.append(new Option("尚無房間；請先在專案跑 orchestrator room init", ""));
    return;
  }
  const requestedRoom = page.searchParams.get("room");
  const pendingRoom = rooms.find((room) => roomPendingCount(room) > 0);
  const selected = rooms.some((room) => room.id === requestedRoom)
    ? requestedRoom
    : pendingRoom?.id || rooms[0].id;
  select.value = selected;
  byId(state.mode === "history" ? "history-link" : "live-link").classList.add("active");
  byId("post-form").hidden = state.mode === "history";
  byId("summarize").hidden = state.mode === "history";
  byId("office-chat-form").hidden = state.mode === "history";
  byId("writer-handoff-toggle").hidden = state.mode === "history";
  /* Owner 定案畫面以辦公室為主：直播模式直接進辦公室，只有歷史模式才顯示帳本翻頁視圖。 */
  switchView(state.mode === "history" ? "ledger" : "office");
  await selectRoom(selected);
  if (state.mode === "live") {
    state.poll = setInterval(poll, 2000);
    state.controlPoll = setInterval(() => {
      if (!document.hidden) void refreshOfficeControlPlane();
    }, 10000);
  }
}

function setConnectionState(text, variant) {
  const connection = byId("connection");
  if (!connection) return;
  connection.textContent = text;
  connection.className = variant ? `conn ${variant}` : "conn";
}

/*
 * poll() 在 document.hidden 時直接 return（背景分頁、被完全遮蔽的視窗都算），
 * 所以指示器不能繼續停在「直播中」；否則畫面靜止時指示器等於說謊。
 */
document.addEventListener("visibilitychange", () => {
  if (state.mode !== "live") return;
  if (document.hidden) {
    setConnectionState("已暫停（分頁在背景）· 回到前景會自動補抓", "paused");
    return;
  }
  setConnectionState("補抓中…", "paused");
  void poll();
  void refreshPresence(true);
  void refreshOfficeControlPlane();
});

byId("ledger").addEventListener("click", (event) => {
  const ref = event.target.closest?.("a.refl");
  if (ref) void toggleQuote(ref);
});
byId("room-select").addEventListener("change", () => void selectRoom(byId("room-select").value));
byId("agent-requests-open").addEventListener("click", async () => {
  const current = state.rooms.find((room) => room.id === state.room);
  const pendingRooms = state.rooms.filter((room) => roomPendingCount(room) > 0);
  if (roomPendingCount(current) === 0 && pendingRooms.length === 1) {
    byId("room-select").value = pendingRooms[0].id;
    await selectRoom(pendingRooms[0].id);
  }
  const opening = byId("agent-requests-panel").hidden;
  setAgentRequestsOpen(opening);
  if (opening) void refreshPresence(true);
});
byId("agent-requests-close")?.addEventListener("click", () => {
  setAgentRequestsOpen(false);
  byId("agent-requests-open").focus();
});

/*
 * 頂欄一次只開一個浮層：房間選單與終端抽屜互斥；aria-expanded 跟著真實狀態走。
 * Esc 與關閉鈕都把焦點還給開它的那顆按鈕（見 keydown 與 agent-requests-close）。
 */
function setRoomMenuOpen(open) {
  const panel = byId("room-menu-panel");
  const toggle = byId("room-menu-toggle");
  if (!panel || !toggle) return;
  panel.hidden = !open;
  toggle.setAttribute("aria-expanded", String(open));
  if (open) setAgentRequestsOpen(false);
}
function setAgentRequestsOpen(open) {
  const panel = byId("agent-requests-panel");
  const opener = byId("agent-requests-open");
  if (!panel || !opener) return;
  panel.hidden = !open;
  opener.setAttribute("aria-expanded", String(open));
  if (open) setRoomMenuOpen(false);
}
byId("room-menu-toggle")?.addEventListener("click", () => setRoomMenuOpen(byId("room-menu-panel").hidden));
byId("topbar-managed-open")?.addEventListener("click", () => {
  if (byId("agent-requests-panel").hidden) byId("agent-requests-open").click();
  byId("managed-agent-label")?.focus();
});
byId("topbar-task-open")?.addEventListener("click", () => {
  if (byId("office").hidden) switchView("office");
  byId("office-task-toggle")?.click();
});
byId("room-select").addEventListener("change", () => setRoomMenuOpen(false));
document.addEventListener("click", (event) => {
  const menu = byId("room-menu");
  const panel = byId("room-menu-panel");
  if (menu && panel && !panel.hidden && !menu.contains(event.target)) setRoomMenuOpen(false);
});
byId("older-history").addEventListener("click", () => {
  byId("older-history").disabled = true;
  void loadHistory(false);
});
byId("rec-toggle").addEventListener("click", async () => {
  try {
    const value = await api("/api/rooms/recording", {
      method: "POST",
      body: JSON.stringify({ room: state.room, state: byId("rec-toggle").dataset.next || "paused" }),
    });
    updateRoomInfo(value.room);
  } catch (error) { showRoomError(error, { prefix: "收錄設定失敗" }); }
});
byId("summarize").addEventListener("click", async () => {
  if (!state.room) return;
  if (!window.confirm("會呼叫一次訂閱模型（Codex）閱讀房間近況並把摘要入帳。繼續嗎？")) return;
  byId("summarize").disabled = true;
  byId("summarize").textContent = "摘要中…";
  try {
    await api("/api/rooms/summarize", { method: "POST", body: JSON.stringify({ room: state.room, provider: "codex" }) });
    await poll();
  } catch (error) { showRoomError(error, { prefix: "摘要失敗" }); }
  byId("summarize").disabled = false;
  byId("summarize").textContent = "🧾 摘要這個房間";
});
byId("stop-all").addEventListener("click", async () => {
  try {
    const value = await api("/api/stop-all", { method: "POST", body: "{}" });
    setConnectionState(`已停止 ${value.stopped} 個工作流`, "");
  } catch (error) { showRoomError(error, { prefix: "緊急停止失敗" }); }
});

function joinedPresenceMention(text) {
  const joined = state.presences
    .filter((session) => session.joined && session.displayName)
    .sort((left, right) => right.displayName.length - left.displayName.length);
  return joined.find((session) => {
    const prefix = `@${session.displayName}`;
    return text.startsWith(`${prefix} `) || text.startsWith(`${prefix}\n`) || text.startsWith(`${prefix}\t`);
  });
}

function managedAgentMention(text) {
  return [...state.managedAgents]
    .sort((left, right) => right.displayName.length - left.displayName.length)
    .find((agent) => {
      const prefix = `@${agent.displayName}`;
      return text.startsWith(`${prefix} `) || text.startsWith(`${prefix}\n`) || text.startsWith(`${prefix}\t`);
    });
}

function offlineExternalMention(text) {
  const known = [...state.knownExternalNames]
    .sort((left, right) => right.length - left.length)
    .find((name) => text.startsWith(`@${name} `) || text.startsWith(`@${name}\n`) || text.startsWith(`@${name}\t`));
  if (known) return known;
  return text.match(EXTERNAL_MENTION_PATTERN)?.[1];
}

const DOUBLE_ENTER_WINDOW_MS = 1600;
const composerEnterState = new WeakMap();
const suppressComposerEnterKeyup = new WeakSet();

function installMacComposerKeyboard(input, form, submitButton) {
  input.addEventListener("keydown", (event) => {
    if (event.isComposing || event.keyCode === 229) {
      composerEnterState.delete(input);
      suppressComposerEnterKeyup.add(input);
      return;
    }
    if (event.key !== "Enter") {
      composerEnterState.delete(input);
      return;
    }
    const commandSend = event.metaKey && !event.shiftKey && !event.altKey && !event.ctrlKey;
    if (commandSend) {
      event.preventDefault();
      composerEnterState.delete(input);
      suppressComposerEnterKeyup.add(input);
      if (!submitButton.disabled) form.requestSubmit();
      return;
    }
    if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey || event.repeat) {
      composerEnterState.delete(input);
      return;
    }
    const armed = composerEnterState.get(input);
    const unchanged = armed && input.value === armed.value &&
      input.selectionStart === armed.start && input.selectionEnd === armed.end;
    if (unchanged && performance.now() - armed.at <= DOUBLE_ENTER_WINDOW_MS) {
      event.preventDefault();
      composerEnterState.delete(input);
      suppressComposerEnterKeyup.add(input);
      if (!submitButton.disabled) form.requestSubmit();
      return;
    }
    composerEnterState.delete(input);
  });
  input.addEventListener("keyup", (event) => {
    if (event.key !== "Enter") return;
    if (suppressComposerEnterKeyup.delete(input)) return;
    if (
      event.isComposing || event.keyCode === 229 || event.shiftKey || event.altKey ||
      event.ctrlKey || event.metaKey
    ) {
      composerEnterState.delete(input);
      return;
    }
    composerEnterState.set(input, {
      value: input.value,
      start: input.selectionStart,
      end: input.selectionEnd,
      at: performance.now(),
    });
  });
  input.addEventListener("blur", () => composerEnterState.delete(input));
}

async function submitRoomText(text, explicitPresenceId = "", explicitManagedAgentId = "") {
  const managedTarget = explicitManagedAgentId
    ? state.managedAgents.find((agent) => agent.id === explicitManagedAgentId)
    : managedAgentMention(text);
  if (explicitManagedAgentId && !managedTarget) throw new Error("MANAGED_AGENT_NOT_FOUND");
  if (managedTarget) {
    const prefix = `@${managedTarget.displayName}`;
    const message = text.startsWith(prefix) ? text.slice(prefix.length).trim() : text.trim();
    if (!message) throw new Error("EMPTY_AGENT_MESSAGE");
    return api("/api/rooms/managed-agents/mention", {
      method: "POST",
      body: JSON.stringify({ room: state.room, agentId: managedTarget.id, text: message }),
    });
  }
  const presenceTarget = explicitPresenceId
    ? state.presences.find((session) => session.id === explicitPresenceId && session.joined && session.displayName)
    : joinedPresenceMention(text);
  if (explicitPresenceId && !presenceTarget) throw new Error("TARGET_AGENT_OFFLINE");
  if (presenceTarget) {
    const prefix = `@${presenceTarget.displayName}`;
    const message = text.startsWith(prefix) ? text.slice(prefix.length).trim() : text.trim();
    if (!message) throw new Error("EMPTY_AGENT_MESSAGE");
    return api("/api/rooms/presence/post", {
      method: "POST",
      body: JSON.stringify({
        room: state.room,
        presenceId: presenceTarget.id,
        text: message,
      }),
    });
  }
  if (offlineExternalMention(text)) throw new Error("TARGET_AGENT_OFFLINE");
  const mention = text.match(MENTION_TARGET_PATTERN);
  if (mention) {
    const target = mention[2] ? `${mention[1]}:${mention[2]}` : mention[1];
    return api("/api/rooms/mention", {
      method: "POST",
      body: JSON.stringify({ room: state.room, target, text: mention[3] }),
    });
  }
  return api("/api/rooms/post", { method: "POST", body: JSON.stringify({ room: state.room, text }) });
}

installMacComposerKeyboard(
  byId("post-input"),
  byId("post-form"),
  byId("post-form").querySelector('button[type="submit"]'),
);
installMacComposerKeyboard(
  byId("office-chat-input"),
  byId("office-chat-form"),
  byId("office-chat-send"),
);

byId("post-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = byId("post-input").value.trim();
  if (!text || !state.room) return;
  try {
    const result = await submitRoomText(text);
    if (result?.delivery?.id) {
      state.deliveries = [...state.deliveries.filter((item) => item.id !== result.delivery.id), result.delivery];
    }
    byId("post-input").value = "";
    await poll();
  } catch (error) {
    if (error.message === "ROOM_MENTION_CANCELLED") {
      byId("post-input").value = "";
      await poll();
    } else showRoomError(error, { prefix: "發言失敗", session: joinedPresenceMention(text) });
  }
});
byId("room-search").addEventListener("input", async () => {
  const query = byId("room-search").value.trim();
  state.searching = Boolean(query);
  if (!query) { await selectRoom(state.room); return; }
  try {
    const value = await api(`/api/rooms/messages?room=${encodeURIComponent(state.room)}&after=0&query=${encodeURIComponent(query)}`);
    showMessages(value.messages, true);
  } catch { /* 查詢格式錯誤時保持現畫面 */ }
});


/* ── Agents 辦公室視圖（原創 Orbie，走動＋閒聊＝免費裝飾；點擊喚醒＝真對話）── */
const BASE_OFFICE_AGENTS = Object.freeze(["you", ...ROOM_RESIDENT_PROVIDER_IDS]);
const OFFICE_AGENTS = [...BASE_OFFICE_AGENTS];
/*
 * Stage geometry at --desk-scale 1, in CSS pixels. Seats are laid out from the floor's real width and
 * height (updateOfficeCapacity), never from a fixed minimum width, so the floor can always be 100% wide
 * and the viewport never grows a horizontal scrollbar. When the rows do not fit, the desks and figures
 * shrink together through --desk-scale; the name plate and the status word keep their 10px text.
 */
const OFFICE_DESK = Object.freeze({ width: 170, height: 112, plate: 54, colGap: 18, rowGap: 12, minScale: 0.46 });
const OFFICE_WALL_RATIO = 0.24;
const OFFICE_FLOOR_MIN_HEIGHT = 400;
/* The glass draft room owns the right-hand strip of the floor; the desk grid lives left of it. */
const OFFICE_DRAFT_ROOM = Object.freeze({ left: 73.5, seat: { x: 86.5, y: 63 } });
const OFFICE_GRID_FALLBACK = Object.freeze({ columns: 3, rows: 1, scale: 1, left: 3, width: 68, top: 42, pitch: 25 });
let officeGrid = null;
/* Which Writer (identity · lease · draft) last had its desk placed in the draft room; see placeOfficeWriter. */
let officeWriterKey = "";
const ORBIE_HTML =
  '<span class="orbie-shadow"></span><span class="orbie-body">' +
  '<span class="orbie-antenna"></span><span class="orbie-visor">' +
  '<span class="orbie-eye l"><i></i></span><span class="orbie-eye r"><i></i></span></span>' +
  '<span class="orbie-mouth"></span><span class="orbie-prop"><i></i></span>' +
  '<span class="orbie-arm l"></span><span class="orbie-arm r"></span>' +
  '<span class="orbie-badge"></span><span class="orbie-foot l"></span>' +
  '<span class="orbie-foot r"></span></span>';
const IDLE_ACTIVITIES = Object.freeze([
  { id: "coffee", mood: "happy", label: "喝咖啡", bubble: "☕ 補充一下能量", duration: 5600 },
  { id: "reading", mood: "focused", label: "看文件", bubble: "📖 翻翻技術筆記", duration: 6800 },
  { id: "music", mood: "content", label: "聽音樂", bubble: "🎧 放空一首歌", duration: 6200 },
  { id: "stretch", mood: "surprised", label: "伸懶腰", bubble: "🙌 起來動一動", duration: 4800 },
  { id: "nap", mood: "sleepy", label: "打個盹", bubble: "zZ… 五分鐘就好", duration: 5900 },
  { id: "snack", mood: "curious", label: "吃點心", bubble: "🍪 這塊是誰的？", duration: 5200 },
]);
const IDLE_ACTIVITY_CLASSES = IDLE_ACTIVITIES.flatMap((activity) => [
  `activity-${activity.id}`,
  `mood-${activity.mood}`,
]);
function saveOfficePositions() {
  state.officeLayouts[state.room] = { ...state.officePositions };
}

/*
 * Seat order on the floor: the three resident models come first, external terminals and managed agents
 * follow in arrival order, and rows wrap at the measured column count (officeGrid) -- on a wide floor
 * the residents are the whole first row, on a very narrow one even they wrap. The owner's desk is not
 * on this grid at all: it lives in the sticky band at the bottom of the viewport (createOfficeDesk).
 * Everything else is a percentage of the floor so drag-and-drop keeps working.
 */
function defaultOfficeHome(agent) {
  const grid = officeGrid || OFFICE_GRID_FALLBACK;
  const columnX = (column, inRow) => grid.left + ((column + 0.5) / Math.max(1, inRow)) * grid.width;
  if (agent === "you") return { x: 50, y: 50 };
  const residents = OFFICE_AGENTS.filter((name) => ROOM_RESIDENT_PROVIDER_IDS.includes(name));
  const guests = OFFICE_AGENTS.filter((name) => name !== "you" && !ROOM_RESIDENT_PROVIDER_IDS.includes(name));
  const residentRows = Math.ceil(residents.length / grid.columns);
  const placeInGroup = (group, index, firstRow) => {
    const row = Math.floor(index / grid.columns);
    const rowStart = row * grid.columns;
    const inRow = Math.min(grid.columns, group.length - rowStart);
    return { x: columnX(index - rowStart, inRow), y: grid.top + (firstRow + row) * grid.pitch };
  };
  const residentIndex = residents.indexOf(agent);
  if (residentIndex >= 0) return placeInGroup(residents, residentIndex, 0);
  return placeInGroup(guests, Math.max(0, guests.indexOf(agent)), residentRows);
}

/* The agent whose desk belongs in the draft room right now: the active Writer, if it has a desk. */
function officeWriterAgent() {
  const name = activeWriterLease()?.writer?.displayName || "";
  return name !== "you" && OFFICE_AGENTS.includes(name) ? name : "";
}

/*
 * What the draft room can truthfully say about a lease: the draft's id and its checkpoint SHA.
 * The id comes from the lease itself or from the merge approval for the same task. The SHA comes only
 * from fields the server types as a git head (MergeApprovalSummary.candidateHead and
 * MergeApprovalBinding.candidateHead, both validated against HEAD_PATTERN, 40-64 hex, before they are
 * stored) -- never from lease.checkpoint, which is free text written on completion. Anything else is
 * reported as absent rather than guessed.
 */
function officeDraftIdentity(lease) {
  if (!lease) return { candidateId: "", sha: "" };
  const approval = (state.mergeApprovals || []).find((entry) => entry.taskId === lease.taskId);
  const text = (value) => (typeof value === "string" ? value : "");
  /* The typed source for the id is MergeApprovalBinding.candidatePath, whose last segment is the
     draft's directory name (the candidate uuid); the explicit id fields are read first in case a
     future payload carries one. */
  const candidateId = text(lease.candidateId) || text(approval?.candidateId)
    || text(approval?.binding?.candidateId) || workspaceLabel(text(approval?.binding?.candidatePath));
  const sha = [approval?.candidateHead, approval?.binding?.candidateHead]
    .map(text)
    .find((value) => /^[0-9a-f]{40,64}$/u.test(value)) || "";
  return { candidateId, sha };
}

/*
 * Put the Writer's desk in the draft room ONCE per hand-over. The key is the Writer's stable identity,
 * the lease id, its epoch and the resolved draft id -- not the task id or anything else that a routine
 * poll, a task text update or an approval refresh can touch. Only when the key changes does the desk
 * get a new default position, so a desk the owner dragged afterwards stays where it was dropped. When
 * the lease ends the desk's draft-room position is dropped and it returns to its grid home.
 */
function placeOfficeWriter() {
  const lease = activeWriterLease();
  const writerAgent = officeWriterAgent();
  const identity = lease?.writer?.actorId || lease?.writer?.displayName || "";
  const key = writerAgent
    ? `${writerAgent}·${identity}·${lease?.id || ""}·${lease?.epoch ?? ""}·${officeDraftIdentity(lease).candidateId}`
    : "";
  if (key === officeWriterKey) return;
  const previous = officeWriterKey.split("·")[0];
  if (previous && previous !== writerAgent) delete state.officePositions[previous];
  if (writerAgent) state.officePositions[writerAgent] = { ...OFFICE_DRAFT_ROOM.seat };
  officeWriterKey = key;
  saveOfficePositions();
}

function officeHome(agent) {
  return state.officePositions[agent] || defaultOfficeHome(agent);
}

/* The word under a desk when nothing is happening there. External seats answer "can it take work",
   managed agents are read-only by construction, resident models are simply idle. */
function officeIdleLabel(agent) {
  const seat = presenceForAgent(agent);
  if (seat) return seatListeningState(seat).text;
  return isManagedAgent(agent) ? "唯讀" : "閒置";
}
const AGENT_DEFAULTS = Object.freeze({
  codex: { label: "Codex", model: "gpt-5.6-sol", access: "唯讀／實驗性 Writer" },
  claude: { label: "Claude", model: "claude-fable-5", access: "受控 Writer" },
  grok: { label: "Grok", model: "grok-4.5", access: "唯讀" },
  you: { label: "You", model: "本機 Owner", access: "人工控制" },
});
const WORK_LABELS = Object.freeze({
  planner: "規劃任務",
  writer: "撰寫程式",
  reviewer: "審查變更",
  tester: "執行測試",
});

function providerInfo(agent) {
  const providerId = providerForAgent(agent);
  const managed = state.managedAgents.find((item) => item.displayName === agent);
  const session = state.presences.find((item) => item.displayName === agent);
  const capability = state.providers.find((provider) => provider.id === providerId);
  const fallback = AGENT_DEFAULTS[providerId] || { label: agent, model: "—", access: "唯讀" };
  return {
    label: managed?.displayName || session?.displayName || capability?.displayName || fallback.label,
    model: managed?.model || session?.model || capability?.subscriptionModels?.[0] || capability?.suggestedModels?.[0] || fallback.model,
    access: agent === "you"
      ? fallback.access
      : managed ? "GUI Managed · 對話唯讀／Writer 另行授權"
      : session ? "Native Full-Trust · host-controlled"
      : providerId === "codex" && capability?.canWriteSubscription
        ? "唯讀／實驗性 Writer"
        : capability?.canWriteSubscription ? "受控 Writer" : fallback.access,
  };
}

/*
 * Office wording, applied where a notification enters the drawer rather than at every source: the
 * bilingual tail is dropped, and the listed templates are re-said in the office vocabulary. The
 * list is exact strings from known sources, not a global word swap, so a title that happens to
 * contain the same characters is left alone.
 *   - refreshMergeApprovals: "有候選要求合併進 main · merge into main requested"
 */
const OFFICE_NOTIFICATION_REWRITES = Object.freeze([
  ["有候選要求合併進 main", "有草稿版要求合併進 main"],
]);

function officeText(value) {
  let text = String(value || "").replace(/\s*·\s*[A-Za-z][A-Za-z0-9 ,.'\-]*$/u, "");
  for (const [from, to] of OFFICE_NOTIFICATION_REWRITES) text = text.replace(from, to);
  return text;
}

function addOfficeNotification(kind, title, detail, unread = true, action) {
  const latest = state.notifications[0];
  if (latest && latest.kind === kind && latest.title === title && latest.detail === detail) return;
  state.notificationSequence += 1;
  state.notifications.unshift({
    id: state.notificationSequence,
    kind,
    title: officeText(title).slice(0, 120),
    detail: officeText(detail).slice(0, 240),
    at: new Date().toISOString(),
    unread,
    ...(action ? { action } : {}),
  });
  state.notifications = state.notifications.slice(0, 30);
  renderOfficeNotifications();
}


/*
 * Which notifications still have a button that does something. A standby request the owner has
 * not answered and a merge approval still pending are the two; everything else -- including those
 * same two once they are decided or lapsed -- is information.
 */
function officeNotificationLive(item) {
  if (item.action?.kind === "standby-approve") {
    const session = (state.presences || []).find((entry) => entry.id === item.action.presenceId);
    return Boolean(session?.joined && session.standbyRequested && !session.standbyApproved);
  }
  if (item.action?.kind === "merge-approval") {
    return mergeApprovalPending((state.mergeApprovals || []).find((entry) => entry.id === item.action.approvalId));
  }
  return false;
}

function renderOfficeNotifications() {
  const list = byId("office-notification-list");
  if (!list) return;
  list.textContent = "";
  const actionable = state.notifications.filter(officeNotificationLive);
  const informational = state.notifications.filter((item) => !officeNotificationLive(item));
  const groupHead = (text) => {
    const head = document.createElement("small");
    head.className = "office-drawer-group";
    head.textContent = text;
    return head;
  };
  const buildRow = (item) => {
    const row = document.createElement("article");
    row.className = `office-notification ${item.unread ? "is-unread" : ""}`;
    row.dataset.kind = item.kind;
    const title = document.createElement("b");
    title.textContent = item.title;
    const time = document.createElement("small");
    time.textContent = item.at.slice(11, 16);
    row.append(title, time);
    return row;
  };
  if (!state.notifications.length) {
    const empty = document.createElement("p");
    empty.className = "office-panel-empty";
    empty.textContent = "目前沒有通知。";
    list.append(empty);
  }
  if (actionable.length) {
    list.append(groupHead("要你動手"));
    for (const item of actionable) {
      const row = buildRow(item);
      row.classList.add("is-actionable");
      const actions = document.createElement("div");
      actions.className = "office-notification-actions";
      if (item.action.kind === "standby-approve") {
        const session = (state.presences || []).find((entry) => entry.id === item.action.presenceId);
        row.dataset.kind = "presence";
        const approve = document.createElement("button");
        approve.type = "button";
        approve.className = "office-notification-action primary";
        approve.textContent = "核准";
        approve.title = `核准 ${session.displayName || session.provider} 的 room-wait 待命：允許它收工作，不代表它隨時在收聽。`;
        approve.addEventListener("click", () => void changePresenceStandby(session, "approve", approve));
        const reject = document.createElement("button");
        reject.type = "button";
        reject.className = "office-notification-action";
        reject.textContent = "拒絕";
        reject.title = "拒絕後只有那個終端能自己再呼叫 room_wait 申請。";
        reject.addEventListener("click", () => void changePresenceStandby(session, "revoke", reject));
        actions.append(approve, reject);
      } else {
        row.dataset.kind = "proposal";
        const open = document.createElement("button");
        open.type = "button";
        open.className = "office-notification-action primary";
        open.textContent = "核准併入 ▸";
        open.title = "打開核准併入的檢視；核准前 main 不會被修改。";
        open.addEventListener("click", () => openMergeApprovalDialog(item.action.approvalId));
        actions.append(open);
      }
      row.append(actions);
      list.append(row);
    }
  }
  if (informational.length) {
    list.append(groupHead("知道就好"));
    for (const item of informational) {
      const row = buildRow(item);
      if (item.detail) {
        const detail = document.createElement("p");
        detail.textContent = item.detail;
        row.append(detail);
      }
      if (item.action?.kind === "standby-approve") {
        const session = (state.presences || []).find((entry) => entry.id === item.action.presenceId);
        const done = document.createElement("small");
        done.className = "office-notification-done";
        /*
         * "已處理" used to cover two opposite outcomes. room_wait's approval wait defaults to 30
         * seconds, so an owner who does not click within half a minute leaves the seat back at
         * no-standby -- the most ordinary human outcome there is -- and this panel, which is where
         * the owner SAW the request, told them it had been handled while the seat's own badge said
         * it could not receive work at all.
         */
        const seatState = session ? seatListeningState(session) : undefined;
        done.textContent = !session
          ? "席位已離線，不需處理"
          : seatState?.key === "not-joined"
            ? "② 這個席位已經離開房間，這則申請不需要處理了。"
            : seatState?.key === "no-standby"
            ? `② 這個申請已經失效，${session.displayName || session.provider} 現在收不到工作。${seatState.fix}`
            : "② 待命已核准";
        row.append(done);
      }
      if (item.action?.kind === "merge-approval") {
        const done = document.createElement("small");
        done.className = "office-notification-done";
        done.textContent = "這筆核准併入已有結果";
        row.append(done);
      }
      list.append(row);
    }
  }
  const unread = state.notifications.filter((item) => item.unread).length;
  const badge = byId("office-notification-count");
  badge.textContent = String(unread);
  badge.hidden = unread === 0;
  const title = byId("office-notification-title");
  if (title) title.textContent = unread ? `通知 · ${unread}` : "通知";
}

function markOfficeNotificationsRead() {
  for (const item of state.notifications) item.unread = false;
  renderOfficeNotifications();
}

function latestRunEvent(runId) {
  const events = state.workflowEvents.get(runId) || [];
  return events[events.length - 1];
}


/* Which task rows the owner has opened. Kept outside `state` because it is view chrome, not data. */
const officeTaskExpanded = new Set();

function officeClock(value) {
  const ms = typeof value === "number" ? value : Date.parse(String(value || ""));
  if (!Number.isFinite(ms)) return "—";
  const date = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/*
 * One row of the task drawer: dot, name, one status word, ▸. Everything else waits behind the
 * caret. `details` is a list of [term, value] pairs; `actions` is a list of buttons.
 */
function officeTaskRow({ key, color, name, status, statusCls = "", details = [], actions = [], title = "" }) {
  const row = document.createElement("article");
  row.className = "office-task-row";
  row.dataset.key = key;
  const expanded = officeTaskExpanded.has(key);
  const head = document.createElement("button");
  head.type = "button";
  head.className = "office-task-row-head";
  head.setAttribute("aria-expanded", String(expanded));
  if (title) head.title = title;
  const dot = document.createElement("i");
  dot.style.background = color;
  const label = document.createElement("b");
  label.textContent = name;
  const word = document.createElement("span");
  word.className = `office-task-state ${statusCls}`;
  word.textContent = status;
  const caret = document.createElement("em");
  caret.setAttribute("aria-hidden", "true");
  caret.textContent = "▸";
  head.append(dot, label, word, caret);
  const body = document.createElement("div");
  body.className = "office-task-row-body";
  body.hidden = !expanded;
  if (details.length) {
    const dl = document.createElement("dl");
    for (const [term, value] of details) {
      if (!value) continue;
      const dt = document.createElement("dt");
      dt.textContent = term;
      const dd = document.createElement("dd");
      dd.textContent = value;
      dl.append(dt, dd);
    }
    body.append(dl);
  }
  if (actions.length) {
    const bar = document.createElement("div");
    bar.className = "office-task-row-actions";
    bar.append(...actions);
    body.append(bar);
  }
  head.addEventListener("click", () => {
    const open = body.hidden;
    if (open) officeTaskExpanded.add(key);
    else officeTaskExpanded.delete(key);
    body.hidden = !open;
    head.setAttribute("aria-expanded", String(open));
    row.classList.toggle("is-open", open);
  });
  row.classList.toggle("is-open", expanded);
  row.append(head, body);
  return row;
}

function officeButton(text, onClick, cls = "") {
  const button = document.createElement("button");
  button.type = "button";
  if (cls) button.className = cls;
  button.textContent = text;
  button.addEventListener("click", onClick);
  return button;
}

/*
 * Everything currently being worked on, from the sources this page already holds: a pending
 * room mention, busy managed seats, workflow provider work, live runs, active Writer leases and
 * proposals waiting for confirmation. No new route; this is a regrouping of what the old task
 * centre and the office floor each showed part of.
 */
function officeRunningRows() {
  const rows = [];
  const messages = state.recent || [];
  const pending = detectPendingWork(messages);
  const workflow = workflowAgentWork();
  const covered = new Set();
  if (pending) {
    rows.push({
      key: `room:${pending.target}`, color: authorColor(pending.target), name: pending.target,
      status: `回覆 Room #${pending.seq}`, statusCls: "is-busy",
      details: [["任務", pending.text], ["最近帳本", `#${pending.seq}`]],
      actions: [officeButton("看對話", () => focusAgentComposer(pending.target))],
    });
  }
  for (const agent of state.managedAgents) {
    if (!agent.busy) continue;
    rows.push({
      key: `managed:${agent.id}`, color: authorColor(agent.provider), name: agent.displayName,
      status: "即時回覆中", statusCls: "is-busy",
      details: [["來源", `${agent.provider} · ${agent.model || "—"}`], ["權限", "GUI Managed · 對話唯讀"]],
      actions: [officeButton("取消回覆", (event) => void changeManagedAgent(agent, event.currentTarget), "cancel")],
    });
  }
  for (const [provider, work] of Object.entries(workflow)) {
    covered.add(work.runId);
    rows.push({
      key: `workflow:${provider}:${work.runId}`, color: authorColor(provider), name: provider,
      status: work.label, statusCls: "is-busy",
      details: [["任務", work.detail], ["模型", work.model], ["RUN", String(work.runId || "").slice(0, 8)]],
    });
  }
  for (const run of state.activeRuns || []) {
    if (covered.has(run.id)) continue;
    const event = latestRunEvent(run.id);
    rows.push({
      key: `run:${run.id}`, color: "#ef736d", name: run.workspaceLabel || "RUN",
      status: `Round ${run.counters?.rounds ?? 0}`, statusCls: "is-busy",
      details: [["最近事件", event?.summary || "Workflow 正在執行。"], ["呼叫", `${run.counters?.providerCalls ?? 0} 次`], ["RUN", String(run.id || "").slice(0, 8)]],
    });
  }
  for (const lease of (state.writers?.leases || []).filter((entry) => entry.state === "active")) {
    const busy = (state.writers?.busyLeaseIds || []).includes(lease.id);
    const children = (state.writers?.delegations || []).filter((child) => child.parentLeaseId === lease.id && child.state === "active");
    rows.push({
      key: `lease:${lease.id}`, color: authorColor(lease.writer?.displayName || lease.writer?.provider), name: lease.writer?.displayName || "Writer",
      status: `${lease.taskId} · ${workspaceLabel(lease.worktree).slice(0, 8)}`, statusCls: busy ? "is-busy" : "is-writer",
      title: busy ? "Writer 正在執行" : "Writer 持有寫入權，目前沒在執行",
      details: [
        ["任務", lease.taskId],
        ["草稿區", workspaceLabel(lease.worktree).slice(0, 8)],
        ["存檔點", lease.checkpoint || "—"],
        ["開始", officeClock(lease.grantedAtMs)],
        ["狀態", `第 ${lease.epoch} 任 · ${children.length} 個子 Agent · ${busy ? "執行中" : "未 complete"}`],
      ],
      actions: [
        officeButton("交辦", () => focusAgentComposer(lease.writer?.displayName)),
        officeButton("Writer 抽屜 ▸", () => openOfficeDrawer("writer-handoff"), "primary"),
      ],
    });
  }
  for (const request of state.pendingWorkflowRequests || []) {
    rows.push({
      key: `request:${request.id}`, color: "#e7b45f", name: `提案 ${String(request.id || "").slice(0, 8)}`,
      status: "等待確認", statusCls: "is-pending",
      details: [["任務", String(request.task || "未命名任務").slice(0, 220)], ["Writer", request.writer?.provider || "claude"]],
      actions: [Object.assign(document.createElement("a"), { href: "/", textContent: "到主工作區確認 →", className: "office-task-link" })],
    });
  }
  return rows;
}

function officeSeatRows() {
  const activeLeases = (state.writers?.leases || []).filter((entry) => entry.state === "active");
  return (state.presences || []).map((session, index) => {
    const listening = seatListeningState(session);
    const tag = seatTag(session.id);
    const isWriter = activeLeases.some((lease) => lease.writer?.displayName === session.displayName);
    const details = [["席位", seatIdentityText(session)]];
    const actions = [];
    if (session.joined) {
      details.push(
        ["模式", `${session.collaborationMode === "room-first" ? "全程帳本協作" : "僅加入房間"} · ${session.syncTurns ? "終端對話同步" : "終端對話不入帳"}`],
        ["交辦", listening.send],
        ...(listening.fix ? [["怎麼辦", listening.fix]] : []),
      );
      actions.push(officeButton("交辦", () => focusAgentComposer(session.displayName)));
    } else {
      details.push(["申請", "等你核准加入房間；核准前不記錄它的內容。名稱與模式在左側「新增 Agents」設定。"]);
    }
    actions.push(...seatActionButtons(session, listening).children);
    return {
      key: `seat:${session.id}`, color: authorColor(session.provider),
      name: session.displayName || (tag ? `${session.provider} · ${tag}` : `${session.provider} 申請 ${index + 1}`),
      status: session.joined ? (isWriter ? `Writer · ${listening.text}` : listening.text) : "待核准加入",
      statusCls: session.joined ? listening.cls : "is-pending",
      title: listening.title,
      details, actions,
    };
  });
}

function officeChildRows() {
  const rows = state.managedAgents.map((agent) => ({
    key: `child:${agent.id}`, color: authorColor(agent.provider), name: agent.displayName,
    status: agent.busy ? "回覆中" : "唯讀 · 閒置", statusCls: agent.busy ? "is-busy" : "",
    details: [["來源", `${agent.provider} · ${agent.model || "—"}`], ["權限", "GUI Managed · 對話唯讀 · Writer 需另行授權"]],
    actions: [
      officeButton("交辦", () => focusAgentComposer(agent.displayName)),
      officeButton(agent.busy ? "取消回覆" : "移除子 Agent", (event) => void changeManagedAgent(agent, event.currentTarget), agent.busy ? "cancel" : "leave"),
    ],
  }));
  for (const child of (state.writers?.delegations || []).filter((entry) => entry.state === "active")) {
    rows.push({
      key: `delegation:${child.id}`, color: authorColor(child.provider || child.displayName), name: child.displayName,
      status: child.access === "write" ? "共用草稿區" : "跨類型唯讀",
      details: [["來源", child.provider || "—"], ["權限", child.access === "write" ? "與 Writer 共用草稿區、序列執行；不可再轉派" : "唯讀；不可再轉派"]],
    });
  }
  return rows;
}

/* @pure-start candidate-id-from-approval
 * The real draft-area id behind an approval, or null. The task id is a different identifier and
 * must not stand in for it: the footer names the thing the owner would look for on disk. The only
 * place the id is carried today is the candidate path the registry builds as
 * <data>/candidates/<candidateId>, so it is read from there and from nowhere looser: the segment
 * before the last must be exactly `candidates` and the last must be a UUID. A trailing slash, a
 * malformed id or any other directory yields null rather than a guess.
 */
const CANDIDATE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

function candidateIdFromApproval(approval) {
  const direct = approval?.candidateId ?? approval?.binding?.candidateId;
  if (typeof direct === "string" && CANDIDATE_ID_PATTERN.test(direct)) return direct;
  const path = approval?.binding?.candidatePath;
  if (typeof path !== "string") return null;
  const parts = path.split("/");
  const last = parts[parts.length - 1];
  const parent = parts[parts.length - 2];
  return parent === "candidates" && CANDIDATE_ID_PATTERN.test(last) ? last : null;
}
/* @pure-end candidate-id-from-approval */

/* What the drawer last painted. A poll that changes nothing the drawer shows must not rebuild it:
   rebuilding drops the scroll position and whatever button had focus. */
let officeTaskSignature = "";

function renderTaskCenter(force = false) {
  const list = byId("office-task-list");
  if (!list) return;
  const groups = [
    ["執行中", officeRunningRows()],
    ["終端", officeSeatRows()],
    ["子 Agent", officeChildRows()],
  ];
  const approvals = mergeTaskSummary(state.mergeApprovals).pending
    .map((approval) => ({ approval, candidateId: candidateIdFromApproval(approval) }))
    .filter((entry) => entry.candidateId);
  const running = groups[0][1].length;
  const badge = byId("office-task-count");
  if (badge) {
    badge.textContent = String(running + approvals.length);
    badge.hidden = running + approvals.length === 0;
  }
  const signature = JSON.stringify({
    groups: groups.map(([name, rows]) => [name, rows.map((row) => [
      row.key, row.name, row.status, row.statusCls, row.title, row.details,
      row.actions.map((action) => `${action.tagName}:${action.textContent}:${action.className}:${action.disabled}`),
    ])]),
    approvals: approvals.map((entry) => [entry.approval.id, entry.candidateId]),
  });
  if (!force && signature === officeTaskSignature) return;
  officeTaskSignature = signature;
  /* Keep the reader's place: scroll offset, opened rows (officeTaskExpanded, read by officeTaskRow)
     and the focused control, found again by row key and label after the rebuild. */
  const scrollTop = list.scrollTop;
  const active = document.activeElement;
  const focused = active && list.contains(active)
    ? {
        row: active.closest(".office-task-row")?.dataset.key || "",
        head: active.classList.contains("office-task-row-head"),
        text: active.textContent,
      }
    : null;
  list.textContent = "";
  for (const [name, rows] of groups) {
    const head = document.createElement("small");
    head.className = "office-drawer-group";
    head.textContent = `${name} · ${rows.length}`;
    list.append(head);
    if (!rows.length) {
      const empty = document.createElement("p");
      empty.className = "office-task-empty";
      empty.textContent = name === "執行中" ? "沒有人在忙。" : name === "終端" ? "還沒有終端申請加入。" : "還沒有子 Agent。";
      list.append(empty);
      continue;
    }
    for (const row of rows) list.append(officeTaskRow(row));
  }
  list.scrollTop = scrollTop;
  if (focused?.row) {
    const row = list.querySelector(`.office-task-row[data-key="${CSS.escape(focused.row)}"]`);
    const target = focused.head
      ? row?.querySelector(".office-task-row-head")
      : [...(row?.querySelectorAll("button, a") || [])].find((node) => node.textContent === focused.text);
    target?.focus({ preventScroll: true });
  }
  const footer = byId("office-task-footer");
  if (footer) {
    footer.textContent = "";
    footer.hidden = approvals.length === 0;
    if (approvals.length) {
      /* One row whatever the count. With several pending, the approval dialog's own picker lists
         them; the footer only says how many are waiting, never picks one on the owner's behalf. */
      const open = officeButton("", () => openMergeApprovalDialog(approvals[0].approval.id), "office-task-approval");
      const label = document.createElement("span");
      label.textContent = approvals.length === 1
        ? `📁 草稿版 ${approvals[0].candidateId.slice(0, 8)} 待核准`
        : `📁 ${approvals.length} 筆草稿版待核准`;
      const go = document.createElement("b");
      go.textContent = "核准併入 ▸";
      open.append(label, go);
      open.title = approvals.length === 1
        ? `${approvals[0].approval.taskId} · 需要 Owner 逐項檢視後核准；核准前 main 不會被修改。`
        : "打開核准併入的檢視，在裡面選擇要看哪一筆；核准前 main 不會被修改。";
      footer.append(open);
    }
  }
}

function workflowAgentWork() {
  const result = {};
  for (const run of state.activeRuns || []) {
    const active = new Map();
    for (const event of state.workflowEvents.get(run.id) || []) {
      const provider = String(event.metadata?.provider || event.actor || "");
      const role = String(event.metadata?.role || "");
      if (event.type === "provider.started" && ROOM_RESIDENT_PROVIDER_IDS.includes(provider)) {
        active.set(`${provider}:${role}`, { provider, role, model: String(event.metadata?.model || ""), event });
      } else if (event.type === "provider.completed") {
        active.delete(`${provider}:${role}`);
      }
    }
    for (const work of active.values()) {
      result[work.provider] = {
        kind: "workflow",
        label: WORK_LABELS[work.role] || "處理任務",
        detail: `${run.workspaceLabel} · Round ${run.counters?.rounds ?? 0}`,
        role: work.role,
        model: work.model,
        runId: run.id,
      };
    }
  }
  return result;
}

async function refreshOfficeControlPlane(initialValue) {
  if (state.controlRefreshing) return;
  state.controlRefreshing = true;
  try {
    const value = initialValue || await api("/api/bootstrap");
    if (!initialValue) await refreshRoomCatalog();
    state.csrf = value.csrf || state.csrf;
    const previousPending = new Set((state.pendingWorkflowRequests || []).map((request) => request.id));
    const previousRuns = new Map(state.trackedRuns);
    state.providers = Array.isArray(value.providers) ? value.providers : [];
    state.pendingWorkflowRequests = Array.isArray(value.pendingWorkflowRequests) ? value.pendingWorkflowRequests : [];
    state.activeRuns = Array.isArray(value.activeRuns) ? value.activeRuns : [];
    for (const run of state.activeRuns) {
      const eventsValue = await api(`/api/events?runId=${encodeURIComponent(run.id)}&after=0`);
      state.workflowEvents.set(run.id, Array.isArray(eventsValue.events) ? eventsValue.events : []);
      state.trackedRuns.set(run.id, run);
    }
    if (state.controlInitialized) {
      for (const request of state.pendingWorkflowRequests) {
        if (!previousPending.has(request.id)) {
          addOfficeNotification("proposal", "新的 Writer 提案等待確認", String(request.task || "請前往主工作區檢視。"));
        }
      }
      const activeIds = new Set(state.activeRuns.map((run) => run.id));
      for (const [runId, previous] of previousRuns) {
        if (activeIds.has(runId)) continue;
        try {
          const usage = await api(`/api/view?runId=${encodeURIComponent(runId)}&kind=usage`);
          const finished = usage.run || usage;
          const succeeded = finished.status === "completed";
          showOfficeOutcome(succeeded ? "completed" : "failed", succeeded ? "任務完成，所有 Reviewer 已通過。" : `任務停止：${finished.errorCode || finished.status}`);
          addOfficeNotification(
            succeeded ? "success" : "error",
            succeeded ? "Workflow 已完成" : "Workflow 未完成",
            `${previous.workspaceLabel} · ${finished.errorCode || finished.status}`,
          );
        } catch { /* run 已被清理時不擴大查詢範圍 */ }
        state.trackedRuns.delete(runId);
      }
    }
    await refreshMergeApprovals();
    state.controlInitialized = true;
    renderTaskCenter();
    renderOfficeNotifications();
    if (!byId("office").hidden) updateOffice(state.recent || []);
  } catch { /* 控制面板失敗不得影響 Room 帳本輪詢 */ }
  finally { state.controlRefreshing = false; }
}

function buildOffice() {
  const floor = byId("office-floor");
  if (!floor.querySelector(".office-back-wall")) floor.insertAdjacentHTML("afterbegin", `
    <div class="ambient-beam beam-left" aria-hidden="true"></div>
    <div class="ambient-beam beam-right" aria-hidden="true"></div>
    <div class="office-back-wall" aria-hidden="true">
      <div class="office-bookshelf">
        <span class="book b1"></span><span class="book b2"></span><span class="book b3"></span>
        <span class="book b4"></span><span class="book b5"></span><span class="book b6"></span>
        <span class="book b7"></span><span class="book b8"></span><span class="book b9"></span>
      </div>
      <div class="office-window"><i></i><i></i><span class="city-lights"></span></div>
      <div class="studio-sign"><b>ORCHESTRATORY</b></div>
      <div class="wall-clock"><i></i></div>
    </div>
    <div class="office-status-wall" id="office-status-wall" role="status" aria-label="狀態牆">
      <span class="office-status-chip is-rec" id="office-chip-rec"></span>
      <span class="office-status-chip is-writer" id="office-chip-writer" hidden></span>
      <span class="office-status-chip is-approvals" id="office-chip-approvals" hidden></span>
    </div>
    <div class="ceiling-light light-left" aria-hidden="true"><i></i></div>
    <div class="ceiling-light light-right" aria-hidden="true"><i></i></div>
    <div class="floor-perspective" aria-hidden="true"></div>
    <div class="floor-inlay" aria-hidden="true"></div>
    <div class="office-draft-room is-empty" id="office-draft-room" aria-label="草稿區">
      <div class="office-draft-door" id="office-draft-door"><b>草稿區</b><span id="office-draft-candidate"></span><span id="office-draft-checkpoint" hidden></span></div>
      <small class="office-draft-note">草稿區＝獨立副本，看得到、可退回、有紀錄；不是沙盒</small>
    </div>
    <div class="office-lounge" id="office-lounge" aria-label="休息區">
    <div class="office-sofa" aria-hidden="true"><i></i><i></i></div>
    <div class="coffee-table" aria-hidden="true"><span></span></div>
    <div class="office-plant plant-left" aria-hidden="true"><i></i><i></i><i></i><i></i><b></b></div>
    <div class="office-plant plant-right" aria-hidden="true"><i></i><i></i><i></i><i></i><b></b></div>
    <div class="floor-lamp" aria-hidden="true"><i></i><b></b></div>
    <div class="office-pet pet-cat" role="img" aria-label="橘色虎斑貓 Miso 正在辦公室輕快巡邏">
      <span class="pet-shadow" aria-hidden="true"></span>
      <span class="pet-rig cat-rig" aria-hidden="true">
        <span class="cat-tail"><i></i><b></b></span>
        <span class="cat-leg cat-leg-rear-far"><i></i></span><span class="cat-leg cat-leg-front-far"><i></i></span>
        <span class="cat-body"><i></i><b></b><em></em></span>
        <span class="cat-leg cat-leg-rear-near"><i></i></span><span class="cat-leg cat-leg-front-near"><i></i></span>
        <span class="cat-head"><span class="cat-ear left"></span><span class="cat-ear right"></span><i></i><b></b><em></em><u></u></span>
      </span>
      <span class="pet-name"><b>MISO</b><small>curious scout</small></span>
    </div>
    <div class="office-pet pet-dino" role="img" aria-label="綠色小恐龍 Byte 正在辦公室踏步巡邏">
      <span class="pet-shadow" aria-hidden="true"></span>
      <span class="pet-rig dino-rig" aria-hidden="true">
        <span class="dino-tail"><i></i><b></b></span>
        <span class="dino-leg dino-leg-far"><i></i></span>
        <span class="dino-body"><i></i><b></b><em></em></span>
        <span class="dino-spikes"><i></i><i></i><i></i><i></i></span>
        <span class="dino-leg dino-leg-near"><i></i></span>
        <span class="dino-arm far"><i></i></span><span class="dino-arm near"><i></i></span>
        <span class="dino-head"><i></i><b></b><em></em><u></u></span>
      </span>
      <span class="pet-name"><b>BYTE</b><small>tiny debugger</small></span>
    </div>
    </div>
  `);
  ensureOfficeOwnerBand();
  syncOfficeDesks();
  startOfficeLife();
}

/*
 * The owner's band: the front strip of the room, drawn as the floor's bottom edge but sitting outside
 * the scrolling viewport, so the owner's desk and the approval tray are always in view and never cover
 * a seat. Created on demand because desks can be synced (presence refresh) before the office is shown.
 */
function ensureOfficeOwnerBand() {
  const viewport = byId("office-viewport");
  if (!viewport) return null;
  if (!byId("office-owner-band")) {
    viewport.insertAdjacentHTML("afterend", `
    <div class="office-owner-band" id="office-owner-band">
      <button type="button" class="office-approval-tray is-empty" id="office-approval-tray" aria-label="核准托盤：沒有待核准"><i aria-hidden="true">📁</i><b id="office-approval-tray-count" hidden></b></button>
    </div>
    `);
  }
  const tray = byId("office-approval-tray");
  if (tray && !tray.dataset.wired) {
    tray.dataset.wired = "true";
    tray.addEventListener("click", (event) => {
      event.stopPropagation();
      /* The tray only opens the existing gate; it never decides anything itself. */
      if (mergeTaskSummary(state.mergeApprovals).count > 0) openMergeApprovalDialog();
      else byId("office-caption").textContent = "核准托盤是空的 · 目前沒有草稿版等你核准併入";
    });
  }
  return byId("office-owner-band");
}

/*
 * Fit every seat on the floor without ever cropping one or growing a horizontal scrollbar. Columns come
 * from the measured grid width divided by one desk pitch; if the rows then do not fit the floor's
 * height, --desk-scale shrinks desks and figures together (and the extra width buys more columns) until
 * they do. The result is published as officeGrid for defaultOfficeHome. A hidden floor measures 0 wide;
 * the previous grid is kept for it and the next visible sync re-measures.
 */
function updateOfficeCapacity(agents) {
  const floor = byId("office-floor");
  const viewport = byId("office-viewport");
  const width = floor.clientWidth;
  let height = Math.max(OFFICE_FLOOR_MIN_HEIGHT, (viewport?.clientHeight || 0) - 16);
  floor.classList.toggle("office-expanded", agents.length > 4);
  const publish = (scaleValue) => {
    floor.style.setProperty("--office-min-height", `${height}px`);
    /* On the owner's band as well: it sits below the viewport, not inside the floor. */
    for (const node of [floor, byId("office-owner-band")]) node?.style.setProperty("--desk-scale", scaleValue.toFixed(3));
  };
  if (!width) {
    officeGrid ||= { ...OFFICE_GRID_FALLBACK };
    publish(officeGrid.scale);
    return;
  }
  const residents = agents.filter((agent) => ROOM_RESIDENT_PROVIDER_IDS.includes(agent)).length;
  const guests = agents.filter((agent) => agent !== "you" && !ROOM_RESIDENT_PROVIDER_IDS.includes(agent)).length;
  const gridLeftPx = width * 0.03;
  const gridWidthPx = Math.max(1, width * (OFFICE_DRAFT_ROOM.left / 100 - 0.03) - 10);
  const wallPx = (floorHeight) => floorHeight * OFFICE_WALL_RATIO + 10;
  const colPitch = OFFICE_DESK.width + OFFICE_DESK.colGap;
  const rowPitch = (scaleValue) => OFFICE_DESK.height * scaleValue + OFFICE_DESK.plate + OFFICE_DESK.rowGap;
  const rowsFor = (columnCount) => Math.ceil(residents / columnCount) + Math.ceil(guests / columnCount);
  /* Try every column count the width could hold, from one up, and keep the one that lets the desks
     stay largest: more columns cost width per desk, fewer columns cost rows and therefore height. */
  const maxColumns = Math.max(1, Math.floor(gridWidthPx / (colPitch * OFFICE_DESK.minScale)));
  let columns = 1;
  let scale = 0;
  for (let candidate = 1; candidate <= maxColumns; candidate += 1) {
    const candidateRows = rowsFor(candidate);
    const byWidth = gridWidthPx / (candidate * colPitch);
    const byHeight = ((height - wallPx(height) - 18) / candidateRows - OFFICE_DESK.plate - OFFICE_DESK.rowGap) / OFFICE_DESK.height;
    const fit = Math.min(1, byWidth, byHeight);
    if (fit > scale + 0.001) {
      scale = fit;
      columns = candidate;
    }
  }
  if (scale < OFFICE_DESK.minScale) {
    /* Below the minimum the desks stop being readable, so the floor grows downward instead and the
       viewport scrolls vertically (the owner's band sits outside it and stays put). Sideways it never
       scrolls: the column count is recomputed for the width at this scale. */
    scale = OFFICE_DESK.minScale;
    columns = Math.max(1, Math.floor(gridWidthPx / (colPitch * scale)));
    height = Math.ceil((rowsFor(columns) * rowPitch(scale) + 28) / (1 - OFFICE_WALL_RATIO));
  }
  const rows = rowsFor(columns);
  const topPx = wallPx(height);
  const pitchPx = rowPitch(scale);
  publish(scale);
  officeGrid = {
    columns,
    rows,
    scale,
    left: (gridLeftPx / width) * 100,
    width: (gridWidthPx / width) * 100,
    top: ((topPx + pitchPx / 2) / height) * 100,
    pitch: (pitchPx / height) * 100,
  };
}

function positionOfficeSeat(agent, point, instant = false) {
  /* The owner's desk is pinned by the band's own layout, never by floor coordinates. */
  if (agent === "you") return;
  const cube = [...byId("office-floor").querySelectorAll(".cubicle[data-agent]")]
    .find((node) => node.dataset.agent === agent);
  const desk = byId(`desk-${agent}`);
  if (instant) desk?.classList.add("is-dragging");
  if (cube) {
    cube.style.left = `${point.x}%`;
    cube.style.top = `${point.y}%`;
  }
  if (desk) {
    desk.style.left = `${point.x}%`;
    desk.style.top = `${point.y - 2}%`;
  }
  if (instant) requestAnimationFrame(() => desk?.classList.remove("is-dragging"));
}

function enableOfficeSeatDrag(cube, desk, agent) {
  let drag = null;
  cube.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    drag = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, moved: false };
    cube.setPointerCapture(event.pointerId);
    cube.classList.add("is-dragging");
    desk.classList.add("is-dragging");
  });
  cube.addEventListener("pointermove", (event) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 5) return;
    drag.moved = true;
    const rect = byId("office-floor").getBoundingClientRect();
    const point = {
      x: Math.max(8, Math.min(92, ((event.clientX - rect.left) / rect.width) * 100)),
      y: Math.max(34, Math.min(91, ((event.clientY - rect.top) / rect.height) * 100)),
    };
    clearIdleActivity(agent);
    desk.classList.remove("walking");
    positionOfficeSeat(agent, point, true);
    state.officePositions[agent] = point;
    event.preventDefault();
  });
  const finish = (event) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const moved = drag.moved;
    drag = null;
    cube.classList.remove("is-dragging");
    desk.classList.remove("is-dragging");
    if (cube.hasPointerCapture(event.pointerId)) cube.releasePointerCapture(event.pointerId);
    if (moved) {
      cube.dataset.dragMoved = "true";
      saveOfficePositions();
      setTimeout(() => delete cube.dataset.dragMoved, 0);
    }
  };
  cube.addEventListener("pointerup", finish);
  cube.addEventListener("pointercancel", finish);
}

function createOfficeDesk(agent) {
    /* The owner's desk goes in the sticky band, every other desk on the floor. */
    const owner = agent === "you";
    const floor = owner ? ensureOfficeOwnerBand() || byId("office-floor") : byId("office-floor");
    const home = officeHome(agent);
    const provider = providerForAgent(agent);
    const cube = document.createElement("div");
    cube.className = "cubicle desk-arriving";
    cube.dataset.agent = agent;
    cube.dataset.provider = provider;
    cube.style.left = `${home.x}%`;
    cube.style.top = `${home.y}%`;
    /* The plate carries the name and, directly under it, one status word. Nothing else: the message
       count lives in the status card. The word sits in the plate rather than under the figure so it
       stays legible at every --desk-scale instead of landing on the desk top when desks shrink. */
    const plate = document.createElement("div");
    plate.className = "name-plate";
    const plateName = document.createElement("span");
    plateName.textContent = agent;
    const stat = document.createElement("div");
    stat.className = "desk-stat";
    stat.id = `stat-${agent}`;
    stat.textContent = officeIdleLabel(agent);
    plate.append(plateName, stat);
    cube.innerHTML =
      '<div class="workstation-mat"></div>' +
      '<div class="monitor"><i></i><i></i><em></em><span></span></div>' +
      '<div class="desk-lamp"><i></i></div><div class="desk-mug"><i></i></div>' +
      '<div class="keyboard"></div><div class="desk-mouse"></div><div class="desk-top"></div>' +
      '<div class="desk-leg left"></div><div class="desk-leg right"></div><div class="chair"></div>';
    cube.prepend(plate);
    if (owner) {
      cube.classList.add("office-owner-desk");
      cube.style.left = "";
      cube.style.top = "";
    }
    if (agent !== "you") {
      cube.tabIndex = 0;
      cube.setAttribute("role", "button");
      cube.setAttribute("aria-label", `在對話框選擇 ${agent}`);
      cube.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          focusAgentComposer(agent);
        }
      });
    }
    cube.addEventListener("click", () => {
      if (!cube.dataset.dragMoved) focusAgentComposer(agent);
    });
    /* The tray is part of the band and must stay to the right of the owner's desk. */
    if (owner && byId("office-approval-tray")?.parentElement === floor) floor.insertBefore(cube, byId("office-approval-tray"));
    else floor.append(cube);

    const desk = document.createElement("div");
    desk.className = "desk idle desk-arriving";
    desk.id = `desk-${agent}`;
    desk.dataset.agent = agent;
    desk.dataset.provider = provider;
    desk.style.left = `${home.x}%`;
    desk.style.top = `${home.y - 2}%`;
    const orbie = document.createElement("div");
    orbie.className = "orbie";
    orbie.dataset.agent = agent;
    orbie.dataset.provider = provider;
    orbie.style.setProperty("--orbie", authorColor(agent));
    orbie.innerHTML = ORBIE_HTML;
    /* The figure scales through a wrapper: its own transform belongs to the walk/hop/breathe keyframes. */
    const orbieScale = document.createElement("div");
    orbieScale.className = "orbie-scale";
    orbieScale.append(orbie);
    desk.append(orbieScale);
    desk.addEventListener("click", () => focusAgentComposer(agent));
    if (owner) {
      desk.classList.add("office-owner-figure");
      desk.style.left = "";
      desk.style.top = "";
    }
    floor.append(desk);
    /* The owner's desk is pinned in the band; it is the one desk that cannot be dragged. */
    if (!owner) enableOfficeSeatDrag(cube, desk, agent);
    setTimeout(() => {
      cube.classList.remove("desk-arriving");
      desk.classList.remove("desk-arriving");
    }, 700);
}

function syncOfficeDesks() {
  const floor = byId("office-floor");
  if (!floor) return;
  const desired = [
    ...BASE_OFFICE_AGENTS,
    ...(state.presences || []).filter((session) => session.joined && session.displayName)
      .map((session) => session.displayName),
    ...(state.managedAgents || []).map((agent) => agent.displayName),
  ];
  OFFICE_AGENTS.splice(0, OFFICE_AGENTS.length, ...desired);
  updateOfficeCapacity(desired);
  placeOfficeWriter();
  for (const node of floor.querySelectorAll(".cubicle[data-agent], .desk[data-agent]")) {
    if (!desired.includes(node.dataset.agent)) node.remove();
  }
  for (const agent of desired) {
    if (!byId(`desk-${agent}`)) createOfficeDesk(agent);
    const home = officeHome(agent);
    const cube = [...floor.querySelectorAll(".cubicle[data-agent]")]
      .find((node) => node.dataset.agent === agent);
    if (cube) positionOfficeSeat(agent, home);
    const desk = byId(`desk-${agent}`);
    if (desk && !desk.classList.contains("walking")) positionOfficeSeat(agent, home);
    /* A desk whose terminal stopped asking should not look like one that is working. The figure is
       the most glanceable thing on this screen, so leaving it bright and wandering is the strongest
       claim the UI makes -- and for a deaf seat it is a false one. */
    const deskSeat = presenceForAgent(agent);
    const deskSilent = Boolean(deskSeat) && !deskSeat.listening;
    if (desk) desk.classList.toggle("seat-not-listening", deskSilent);
    /* The whole desk, not just the figure: the plate and the status word dim with it. */
    if (cube) cube.classList.toggle("seat-not-listening", deskSilent);
    if (desk && deskSilent) {
      /* Stop the story, not just the colour. Dimming a figure that is still strolling to the coffee
         machine and thinking in a speech bubble does not read as "this one cannot hear you". */
      desk.classList.remove("walking");
      if (desk.dataset.activity) clearIdleActivity(agent);
    }
  }
  updateOfficeDraftRoom();
  updateOfficeApprovalTray();
  if (state.selectedAgent && !desired.includes(state.selectedAgent)) {
    state.selectedAgent = "";
    byId("office-agent-card").hidden = true;
  }
}

/*
 * The status wall: three live chips where the fake sprint board used to hang. Recording state and the
 * latest ledger number, the active Writer and its epoch, and how many drafts wait for the owner's
 * approval. Nothing here is written by hand; a chip with nothing true to say is hidden, not padded.
 */
function updateOfficeStatusWall(messages) {
  const rec = byId("office-chip-rec");
  const writer = byId("office-chip-writer");
  const approvals = byId("office-chip-approvals");
  if (!rec || !writer || !approvals) return;
  const room = (state.rooms || []).find((entry) => entry.id === state.room);
  const lastSeq = messages.length ? messages[messages.length - 1].seq : room?.messages;
  const seqText = Number.isFinite(Number(lastSeq)) && lastSeq !== undefined && lastSeq !== null ? ` · #${lastSeq}` : "";
  const recording = room?.recording;
  rec.textContent = recording === "on"
    ? `● 收錄中${seqText}`
    : recording === "paused"
      ? `⏸ 已暫停${seqText}`
      : recording
        ? `■ 已關閉${seqText}`
        : "○ 尚未選擇房間";
  rec.classList.toggle("is-on", recording === "on");
  const lease = activeWriterLease();
  writer.hidden = !lease;
  if (lease) {
    const name = lease.writer?.displayName || lease.writer?.actorId || "Writer";
    writer.textContent = `✎ ${name} · 第 ${Number(lease.epoch) || 1} 任`;
  }
  const count = mergeTaskSummary(state.mergeApprovals).count;
  approvals.hidden = count === 0;
  approvals.textContent = `⑂ 待核准 ${count}`;
}

/* The tray beside the owner's desk: a red count while drafts wait, greyed out with no label when none do. */
function updateOfficeApprovalTray() {
  const tray = byId("office-approval-tray");
  const badge = byId("office-approval-tray-count");
  if (!tray || !badge) return;
  const count = mergeTaskSummary(state.mergeApprovals).count;
  tray.classList.toggle("is-empty", count === 0);
  badge.hidden = count === 0;
  badge.textContent = `${count} 待核准`;
  tray.setAttribute("aria-label", count ? `核准托盤：${count} 件待核准，按下開啟核准併入` : "核准托盤：沒有待核准");
  tray.title = count ? `${count} 件草稿版等你核准併入 main` : "核准托盤（目前沒有待核准）";
}

/*
 * The glass room is the draft area: while a Writer holds the lease its desk is moved inside, and the
 * door plate names the draft (candidate id when the lease or its approval carries one, else the task id)
 * and the checkpoint when one is known. With no lease the room goes dark and the plate is blank.
 */
function updateOfficeDraftRoom() {
  const room = byId("office-draft-room");
  const candidate = byId("office-draft-candidate");
  const checkpoint = byId("office-draft-checkpoint");
  if (!room || !candidate || !checkpoint) return;
  const lease = activeWriterLease();
  room.classList.toggle("is-empty", !lease);
  const writerAgent = officeWriterAgent();
  for (const node of byId("office-floor").querySelectorAll(".cubicle[data-agent], .desk[data-agent]")) {
    node.classList.toggle("is-writer", Boolean(writerAgent) && node.dataset.agent === writerAgent);
  }
  if (!lease) {
    candidate.textContent = "";
    checkpoint.hidden = true;
    return;
  }
  /* Only a real draft id gets called one; without one the plate says the room is in use and nothing
     more. Likewise the checkpoint: a typed git head or nothing (see officeDraftIdentity). */
  const { candidateId, sha } = officeDraftIdentity(lease);
  candidate.textContent = candidateId ? `草稿版 ${candidateId.slice(0, 8)}` : "草稿區使用中";
  checkpoint.hidden = !sha;
  checkpoint.textContent = sha ? `存檔點 ${sha.slice(0, 8)}` : "";
}

function seatOrbie(agent) {
  const desk = byId(`desk-${agent}`);
  const home = officeHome(agent);
  if (!desk || !home) return;
  desk.classList.remove("walking");
  desk.style.left = `${home.x}%`;
  desk.style.top = `${home.y - 2}%`;
}

function wanderAll() {
  if (!state.idleEnabled || document.hidden || byId("office").hidden) return;
  for (const agent of OFFICE_AGENTS) {
    const desk = byId(`desk-${agent}`);
    const home = officeHome(agent);
    /* seat-not-listening excluded: the desk itself transitions over four seconds, so dimming the
       figure while it keeps drifting around the floor still reads as someone who is around. */
    /* The owner's figure is pinned in the band and has no floor to wander on. */
    if (agent === "you" || !desk || !home || desk.dataset.activity || desk.classList.contains("real-busy")
      || desk.classList.contains("seat-not-listening")) continue;
    if (Math.random() < 0.32) {
      desk.style.left = `${home.x + (Math.random() * 7 - 3.5)}%`;
      desk.style.top = `${home.y - 2 + (Math.random() * 5 - 2.5)}%`;
      desk.classList.add("walking");
      setTimeout(() => seatOrbie(agent), 3600);
    }
  }
}

function clearIdleActivity(agent, activityId) {
  const desk = byId(`desk-${agent}`);
  if (!desk || (activityId && desk.dataset.activity !== activityId)) return;
  delete desk.dataset.activity;
  desk.classList.remove(...IDLE_ACTIVITY_CLASSES);
  const stat = byId(`stat-${agent}`);
  if (stat?.dataset.activity === "true") {
    delete stat.dataset.activity;
    /* Not "待命": that word already means "approved for standby" one panel over and "currently
       listening" in the header count. Three meanings on one screen is how a reader ends up unable to
       act on any of them. */
    stat.textContent = officeIdleLabel(agent);
  }
  clearBubble(agent);
}

function startIdleActivity() {
  if (!state.idleEnabled || document.hidden || byId("office").hidden) return;
  const activeCount = OFFICE_AGENTS.filter((agent) => byId(`desk-${agent}`)?.dataset.activity).length;
  if (activeCount >= 2) return;
  const candidates = OFFICE_AGENTS.filter((agent) => {
    const desk = byId(`desk-${agent}`);
    /* The owner is a person at a pinned desk, not a figure that takes coffee breaks on the floor. */
    return agent !== "you" && desk?.classList.contains("idle") && !desk.dataset.activity
      && !desk.classList.contains("walking")
      /* A seat that cannot hear you does not get to look like it is taking a coffee break. */
      && !desk.classList.contains("seat-not-listening");
  });
  if (!candidates.length) return;
  const agent = candidates[Math.floor(Math.random() * candidates.length)];
  const activity = IDLE_ACTIVITIES[Math.floor(Math.random() * IDLE_ACTIVITIES.length)];
  const desk = byId(`desk-${agent}`);
  const stat = byId(`stat-${agent}`);
  if (!desk || !stat) return;
  seatOrbie(agent);
  desk.dataset.activity = activity.id;
  desk.classList.add(`activity-${activity.id}`, `mood-${activity.mood}`);
  stat.dataset.activity = "true";
  stat.textContent = activity.label;
  if (!state.quietMode) setBubble(agent, activity.bubble, false);
  setTimeout(() => clearIdleActivity(agent, activity.id), activity.duration);
}

function startOfficeLife() {
  if (state.officeLife) return;
  state.officeLife = [setInterval(wanderAll, 4400), setInterval(startIdleActivity, 3200)];
  setTimeout(startIdleActivity, 900);
}

function isJoinedPresenceAgent(agent) {
  return state.presences.some((session) => session.joined && session.displayName === agent);
}

/*
 * The seat behind a desk, if that desk belongs to an external terminal.
 *
 * The office is where work actually gets handed over -- click a desk, the composer prefills @name,
 * send. So the office is where "is anyone listening" has to be answered, and it was the one view
 * that did not answer it. Worse, it asserted the opposite: the status line read "可對話 · 待命" for a
 * seat whose stdio had stopped asking, and Orbie kept wandering around the floor. A person watching
 * that screen has every reason to expect a reply.
 */
function presenceForAgent(agent) {
  return state.presences.find((session) => session.joined && session.displayName === agent);
}

function isManagedAgent(agent) {
  return state.managedAgents.some((entry) => entry.displayName === agent);
}

/*
 * The strip above the ledger: one chip per seat that can be addressed, each carrying the same
 * mark and word as the task drawer. Clicking a chip does what clicking a desk does.
 */
function renderSeatChips() {
  const strip = byId("office-seat-chips");
  if (!strip) return;
  strip.textContent = "";
  const chips = [];
  for (const session of (state.presences || []).filter((entry) => entry.joined && entry.displayName)) {
    const listening = seatListeningState(session);
    chips.push({ agent: session.displayName, text: `${listening.mark} ${session.displayName}`, cls: `seat-chip ${listening.cls}`, title: listening.title, color: authorColor(session.provider) });
  }
  for (const agent of state.managedAgents) {
    chips.push({ agent: agent.displayName, text: `◇ ${agent.displayName}`, cls: `seat-chip is-managed ${agent.busy ? "is-busy" : ""}`, title: agent.busy ? "回覆中" : "GUI Managed · 對話唯讀", color: authorColor(agent.provider) });
  }
  for (const provider of ROOM_RESIDENT_PROVIDER_IDS) {
    chips.push({ agent: provider, text: provider, cls: "seat-chip is-resident", title: "常駐模型；送出後才會喚醒", color: authorColor(provider) });
  }
  for (const chip of chips) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `${chip.cls} ${state.selectedAgent === chip.agent ? "is-selected" : ""}`;
    button.textContent = chip.text;
    button.title = chip.title;
    button.style.setProperty("--chip", chip.color);
    button.setAttribute("aria-pressed", String(state.selectedAgent === chip.agent));
    button.addEventListener("click", () => focusAgentComposer(chip.agent));
    strip.append(button);
  }
}

function focusAgentComposer(agent) {
  if (!byId("writer-handoff")?.hidden) {
    const candidate = (state.writers?.candidates || []).find((entry) => entry.displayName === agent || entry.actorId === agent);
    if (candidate?.eligible) {
      const key = `${candidate.origin}:${candidate.actorId}`;
      const option = [...byId("writer-candidate").options].find((entry) => entry.dataset.key === key);
      if (option) {
        byId("writer-candidate").value = option.value;
        byId("writer-live-status").textContent = `已選擇 ${candidate.displayName}；按「${activeWriterLease() ? "交接 Writer" : "指派 Writer"}」才會生效。`;
        renderWriterControl();
        return;
      }
    }
  }
  const input = byId("office-chat-input");
  if (!input) return;
  /* A desk click lands in the conversation drawer with the seat's card docked above the composer. */
  openOfficeDrawer("office-drawer-chat");
  document.querySelectorAll(".cubicle.is-selected, .desk.is-selected")
    .forEach((node) => node.classList.remove("is-selected"));
  renderAgentCard(agent);
  renderSeatChips();
  document.querySelector(`.cubicle[data-agent="${agent}"]`)?.classList.add("is-selected");
  byId(`desk-${agent}`)?.classList.add("is-selected");
  if (agent === "you" || agent === "system") {
    delete input.dataset.target;
    delete input.dataset.presenceId;
    delete input.dataset.managedAgentId;
    byId("office-chat-hint").textContent = "這是你的工位；請選擇其他 agent 開始對話";
    input.focus();
    return;
  }
  clearIdleActivity(agent);
  const previousTarget = input.dataset.target;
  const draft = previousTarget && input.value.startsWith(`@${previousTarget}`)
    ? input.value.slice(previousTarget.length + 1).trimStart()
    : input.value.replace(/^@[a-z][a-z0-9-]{0,31}(?::[^\s]+)?\s*/u, "");
  input.value = `@${agent} ${draft}`;
  input.dataset.target = agent;
  const presenceTarget = state.presences.find((session) => session.joined && session.displayName === agent);
  const managedTarget = state.managedAgents.find((entry) => entry.displayName === agent);
  if (presenceTarget) input.dataset.presenceId = presenceTarget.id;
  else delete input.dataset.presenceId;
  if (managedTarget) input.dataset.managedAgentId = managedTarget.id;
  else delete input.dataset.managedAgentId;
  const hintSeat = presenceForAgent(agent);
  const hintListening = hintSeat ? seatListeningState(hintSeat) : undefined;
  byId("office-chat-hint").textContent = isJoinedPresenceAgent(agent)
    ? `已選擇 ${agent} · ${hintListening ? hintListening.send : "訊息會進入房間收件匣"}`
    : isManagedAgent(agent)
      ? `已選擇 ${agent} · 送出後即時喚醒，以獨立席位名稱回覆`
    : `已選擇 ${agent} · 按送出才會喚醒模型`;
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

function detectPendingWork(messages) {
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i];
    if (m.kind !== "chat") continue;
    const mention = m.text.match(MENTION_MESSAGE_PATTERN);
    if (!mention || mention[1] === m.author) continue;
    if (state.cancelledMentions.has(m.seq)) continue;
    const target = mention[1];
    const lifecycle = mentionLifecycle(messages, i, target, m.seq);
    if (lifecycle.started && !lifecycle.resolved) {
      return { target, seq: m.seq, text: String(m.text).replace(/^@\S+\s+/u, "") };
    }
  }
  return null;
}

function detectPendingTarget(messages) { return detectPendingWork(messages)?.target || null; }

function setBubble(agent, text, think) {
  const desk = byId(`desk-${agent}`);
  if (!desk) return;
  let bubble = desk.querySelector(".bubble");
  if (!bubble) { bubble = document.createElement("div"); bubble.className = "bubble"; desk.append(bubble); }
  bubble.classList.toggle("think", Boolean(think));
  bubble.textContent = text.length > 40 ? `${text.slice(0, 40)}…` : text;
  bubble.classList.add("show");
}
function clearBubble(agent) { byId(`desk-${agent}`)?.querySelector(".bubble")?.classList.remove("show"); }

function showOfficeOutcome(status, detail) {
  const office = byId("office");
  const panel = byId("office-outcome");
  if (!office || !panel) return;
  office.classList.remove("outcome-completed", "outcome-failed");
  office.classList.add(status === "completed" ? "outcome-completed" : "outcome-failed");
  panel.className = `office-outcome is-${status}`;
  panel.querySelector("b").textContent = status === "completed" ? "✓ 工作流完成" : "! 工作流需要注意";
  panel.querySelector("span").textContent = String(detail).slice(0, 180);
  panel.hidden = false;
  clearTimeout(state.outcomeTimer);
  state.outcomeTimer = setTimeout(() => {
    panel.hidden = true;
    office.classList.remove("outcome-completed", "outcome-failed");
  }, 6500);
}

function selectedAgentWork(agent, messages) {
  const pending = detectPendingWork(messages);
  if (pending?.target === agent) {
    return { kind: "room", label: `回覆 Room #${pending.seq}`, detail: pending.text, role: "responder" };
  }
  return workflowAgentWork()[agent] || null;
}


function renderAgentCard(agent, messages = state.recent || []) {
  const card = byId("office-agent-card");
  if (!card || !agent || !OFFICE_AGENTS.includes(agent)) return;
  const info = providerInfo(agent);
  const work = selectedAgentWork(agent, messages);
  const last = [...messages].reverse().find((message) => message.author === agent && message.kind === "chat");
  const stats = (state.stats || []).find((entry) => entry.author === agent);
  state.selectedAgent = agent;
  card.hidden = false;
  const seatBehindDesk = presenceForAgent(agent);
  const managedBehindDesk = state.managedAgents.find((entry) => entry.displayName === agent);
  /* The title is the seat the owner clicked, by the name they know it by; which provider and model
     sit behind it is the secondary line. */
  byId("office-agent-name").textContent = seatBehindDesk
    ? (seatBehindDesk.displayName || `${seatBehindDesk.provider} · ${seatTag(seatBehindDesk.id)}`)
    : agent === "you" ? "YOU" : managedBehindDesk?.displayName || agent;
  byId("office-agent-provider").textContent = seatBehindDesk
    ? `${seatBehindDesk.provider} 終端`
    : managedBehindDesk ? `${managedBehindDesk.provider} · GUI Managed` : info.label;
  byId("office-agent-dot").style.background = authorColor(agent);
  const deskListening = seatBehindDesk ? seatListeningState(seatBehindDesk) : undefined;
  const status = byId("office-agent-status");
  status.textContent = work
    ? `⛔ ${work.label}`
    : deskListening
      ? `${deskListening.mark} ${deskListening.text}`
      : isManagedAgent(agent) ? "◇ 唯讀 · 閒置" : "閒置";
  status.className = `seat-listening ${work ? "is-busy" : deskListening?.cls || ""}`;
  status.title = work ? `請勿打擾：${work.detail || work.label}` : deskListening?.title || "";
  byId("office-agent-access").textContent = info.access;
  byId("office-agent-model").textContent = work?.model || info.model;
  byId("office-agent-last").textContent = last ? `最近 #${last.seq} · ${last.at.slice(11, 16)}` : "尚無發言";
  byId("office-agent-messages").textContent = `訊息 ${stats?.messages ?? 0} 則`;
  /*
   * Two lines, and a third only when the third is the answer to "will anything happen if I send
   * this": a seat that cannot hear you gets its sentence and its fix on screen, not in a tooltip.
   */
  const detail = byId("office-agent-detail");
  const deaf = Boolean(deskListening && deskListening.key !== "listening");
  detail.hidden = !deaf && !work;
  detail.textContent = work
    ? `請勿打擾：${work.detail || "Agent 正在處理已核准的工作。"}`
    : deaf
      ? `${deskListening.send} 怎麼辦：${deskListening.fix}`
      : "";
  byId("office-agent-mention").hidden = agent === "you" || agent === "system";
}


const OFFICE_DRAWER_IDS = Object.freeze(["office-drawer-chat", "office-task-center", "office-notifications", "writer-handoff"]);

/*
 * The rail's state model. Exactly one of the four drawer buttons is pressed, or none. While the ⚙
 * menu is open the pressed state is suspended -- the menu is what the owner is operating, and two
 * "active" controls on one rail would read as two things open at once -- and the open drawer is
 * carried on aria-current instead, so it stays identifiable and comes back as pressed when the
 * menu closes.
 */
function syncOfficeRail() {
  const menuOpen = !(byId("office-settings-menu")?.hidden ?? true);
  for (const button of document.querySelectorAll(".office-rail-button[data-drawer]")) {
    const drawer = byId(button.dataset.drawer);
    const open = Boolean(drawer && !drawer.hidden);
    button.setAttribute("aria-pressed", String(open && !menuOpen));
    if (open && menuOpen) button.setAttribute("aria-current", "true");
    else button.removeAttribute("aria-current");
  }
}

function closeOfficeSidePanels(except = "") {
  for (const id of OFFICE_DRAWER_IDS) {
    if (id !== except) byId(id).hidden = true;
  }
  syncOfficeRail();
}

/* One drawer at a time. Opening one closes the others and refreshes what that drawer shows. */
function openOfficeDrawer(id) {
  const panel = byId(id);
  if (!panel) return;
  closeOfficeSidePanels(id);
  panel.hidden = false;
  if (id === "office-task-center") renderTaskCenter(true);
  if (id === "office-notifications") {
    renderOfficeNotifications();
    markOfficeNotificationsRead();
  }
  if (id === "writer-handoff") prepareWriterDrawer();
  if (id === "office-drawer-chat") {
    renderSeatChips();
    const stream = byId("office-chat-stream");
    if (stream) stream.scrollTop = stream.scrollHeight;
  }
  syncOfficeRail();
}

function fireWire(from, to) {
  const floor = byId("office-floor");
  const df = byId(`desk-${from}`), dt = byId(`desk-${to}`);
  if (!df || !dt) return;
  const fr = floor.getBoundingClientRect(), a = df.getBoundingClientRect(), b = dt.getBoundingClientRect();
  const ax = a.left + a.width / 2 - fr.left, ay = a.top + a.height / 2 - fr.top;
  const bx = b.left + b.width / 2 - fr.left, by = b.top + b.height / 2 - fr.top;
  const len = Math.hypot(bx - ax, by - ay);
  const wire = document.createElement("div");
  wire.className = "office-wire fire";
  wire.style.left = `${ax}px`;
  wire.style.top = `${ay}px`;
  wire.style.width = `${len}px`;
  wire.style.transform = `rotate(${Math.atan2(by - ay, bx - ax) * 180 / Math.PI}deg)`;
  floor.append(wire);
  setTimeout(() => wire.remove(), 1100);
}

function renderOfficeChat(messages) {
  const stream = byId("office-chat-stream");
  if (!stream) return;
  const recent = messages
    .filter((message) => message.kind === "chat" || message.kind === "system")
    .slice(-18);
  const signature = recent.map((message) => `${message.seq}:${message.text.length}`).join("|");
  if (signature === state.officeChatSignature) return;
  state.officeChatSignature = signature;
  stream.textContent = "";
  if (!recent.length) {
    const empty = document.createElement("div");
    empty.className = "office-chat-empty";
    empty.textContent = "還沒有對話；點一個工位或席位晶片開始。";
    stream.append(empty);
    return;
  }
  for (const message of recent) {
    const item = document.createElement("article");
    item.className = "office-chat-message";
    item.dataset.author = message.author;
    const meta = document.createElement("div");
    const author = document.createElement("b");
    author.textContent = message.author;
    author.style.color = authorColor(message.author);
    const time = document.createElement("time");
    time.textContent = `#${message.seq} · ${message.at.slice(11, 16)}`;
    const text = document.createElement("p");
    text.textContent = message.text.length > 240 ? `${message.text.slice(0, 240)}…` : message.text;
    meta.append(author, time);
    item.append(meta, text);
    stream.append(item);
  }
  stream.scrollTop = stream.scrollHeight;
}

let officeLastSeq = 0;
function updateOffice(messages) {
  buildOffice();
  renderOfficeChat(messages);
  const pending = detectPendingWork(messages);
  const workflowWork = workflowAgentWork();
  const lastChat = [...messages].reverse().find((m) => m.kind === "chat");
  const lastAt = lastChat ? Date.parse(lastChat.at) : 0;
  const speaker = lastChat && Date.now() - lastAt < 8000 && !String(lastChat.text).startsWith("@")
    ? lastChat.author
    : null;
  if (lastChat && lastChat.seq > officeLastSeq) {
    officeLastSeq = lastChat.seq;
    const m = String(lastChat.text).match(MENTION_WORD_PATTERN);
    if (m && lastChat.author !== m[1]) {
      const targetDesk = OFFICE_AGENTS.find((agent) => providerForAgent(agent) === m[1]) || m[1];
      fireWire(lastChat.author, targetDesk);
    }
  }
  let busyCount = 0;
  let busyCaption = "";
  for (const agent of OFFICE_AGENTS) {
    const desk = byId(`desk-${agent}`);
    if (!desk) continue;
    const managed = state.managedAgents.find((entry) => entry.displayName === agent);
    const work = managed?.busy
      ? { kind: "room", label: "即時回覆中", detail: "正在處理指定給此席位的任務" }
      : pending?.target === agent
      ? { kind: "room", label: `回覆 Room #${pending.seq}`, detail: pending.text }
      : workflowWork[agent];
    if ((work || agent === speaker) && desk.dataset.activity) clearIdleActivity(agent);
    /* An external seat's desk label answers the same question as its badge. Writing "待命" here every
       poll put the word back on the most glanceable element on the floor -- and for a seat that is
       not listening it is the exact claim this whole item exists to remove. Seats that are not
       terminals keep the plain idle label, which for them is simply true. */
    const deskSeatState = presenceForAgent(agent);
    if (!desk.dataset.activity) {
      /* One status word under the desk, never a message count: the count moved into the status card.
         A seat that cannot hear you says so here first; every other seat gets its idle word from
         officeIdleLabel (the listening state's own text, 唯讀 for managed agents, 閒置 for residents).
         The first branch is the wiring anchor test/web.test.ts pins for the not-listening label. */
      const deskLabelState = deskSeatState ? seatListeningState(deskSeatState) : undefined;
      byId(`stat-${agent}`).textContent = deskLabelState && deskLabelState.key !== "listening"
        ? deskLabelState.text
        : officeIdleLabel(agent);
    }
    desk.classList.remove("idle", "speaking", "waking", "real-busy", "workflow-busy", "mood-focused");
    /* The status word lives on the cubicle's plate, so the busy state has to reach the cubicle too. */
    document.querySelector(`.cubicle[data-agent="${CSS.escape(agent)}"]`)?.classList.toggle("real-busy", Boolean(work));
    if (work) {
      busyCount += 1;
      busyCaption ||= `${agent} · ${work.label}`;
      desk.classList.add("real-busy", "mood-focused", work.kind === "workflow" ? "workflow-busy" : "waking");
      /* Short on the floor, full in the tooltip and the status card: the desk only has to say that
         this seat cannot take work right now. */
      byId(`stat-${agent}`).textContent = "⛔ 工作中";
      desk.title = `請勿打擾：${work.label}${work.detail ? ` · ${work.detail}` : ""}`;
      setBubble(agent, work.kind === "room" ? "⛔ 思考回覆中…" : `⛔ ${work.label}`, true);
    }
    else if (agent === speaker) { desk.classList.add("speaking"); setBubble(agent, String(lastChat.text), false); }
    else {
      desk.classList.add("idle");
      desk.removeAttribute("title");
      if (!desk.dataset.activity && desk.querySelector(".bubble.think")) clearBubble(agent);
    }
  }
  byId("office-live-state").textContent = busyCount ? `DND ${busyCount}` : "LIVE";
  byId("office-live-state").classList.toggle("is-busy", busyCount > 0);
  byId("office-caption").textContent = busyCount
    ? `⛔ 請勿打擾 · ${busyCaption}${busyCount > 1 ? ` · 另有 ${busyCount - 1} 位執行中` : ""}`
    : speaker ? `${speaker} 正在發言 · 點選工位開始對話`
      : OFFICE_AGENTS.length > 4
        ? `已擴編至 ${OFFICE_AGENTS.length} 席 · 可拖曳辦公桌調整位置`
        : "點選任一 agent 工位開始對話";
  updateOfficeStatusWall(messages);
  updateOfficeApprovalTray();
  updateOfficeDraftRoom();
  if (state.selectedAgent) {
    renderAgentCard(state.selectedAgent, messages);
    /*
     * The hint sits beside the send button and was written once, when the seat was picked. A seat
     * that went silent in between left that line saying the delivery would go straight over, right
     * where the person is about to press send. It has to be re-derived on the same poll as everything
     * else on this screen.
     */
    /*
     * Bound to the composer's delivery target, NOT to the visual selection. Sending clears
     * dataset.presenceId but leaves state.selectedAgent set, so keying off the selection kept the
     * line saying "已選擇 codex1 · …會進收件匣排隊" next to a composer that no longer had a target --
     * and the next thing typed there would post to the room addressed to nobody. The hint must
     * describe the route the send will actually take.
     */
    const composer = byId("office-chat-input");
    const selectedSeat = presenceForAgent(state.selectedAgent);
    if (selectedSeat && composer?.dataset.presenceId === selectedSeat.id) {
      byId("office-chat-hint").textContent =
        `已選擇 ${state.selectedAgent} · ${seatListeningState(selectedSeat).send}`;
    }
  }
}

function switchView(view) {
  const office = view === "office";
  byId("office").hidden = !office;
  byId("ledger").hidden = office;
  byId("post-form").hidden = office || state.mode === "history";
  byId("view-office")?.classList.toggle("is-active", office);
  byId("view-ledger")?.classList.toggle("is-active", !office);
  document.body.classList.toggle("view-office", office);
  if (office) {
    buildOffice();
    updateOffice(state.recent || []);
    if (OFFICE_DRAWER_IDS.every((id) => byId(id)?.hidden)) openOfficeDrawer("office-task-center");
    else renderTaskCenter();
    syncOfficeRail();
    syncOfficeSettingsMenu();
    void refreshOfficeControlPlane();
  }
}
byId("view-office")?.addEventListener("click", () => switchView("office"));
byId("view-ledger")?.addEventListener("click", () => switchView("ledger"));


function toggleOfficePanel(id) {
  const panel = byId(id);
  if (!panel) return;
  if (!panel.hidden) {
    closeOfficeSidePanels("");
    return;
  }
  openOfficeDrawer(id);
}

for (const button of document.querySelectorAll(".office-rail-button[data-drawer]")) {
  button.addEventListener("click", () => toggleOfficePanel(button.dataset.drawer));
}
for (const button of document.querySelectorAll("[data-drawer-close]")) {
  button.addEventListener("click", () => {
    byId(button.dataset.drawerClose).hidden = true;
    syncOfficeRail();
  });
}
byId("office-notification-clear").addEventListener("click", markOfficeNotificationsRead);
byId("office-agent-close").addEventListener("click", () => {
  byId("office-agent-card").hidden = true;
  state.selectedAgent = "";
  document.querySelectorAll(".cubicle.is-selected, .desk.is-selected")
    .forEach((node) => node.classList.remove("is-selected"));
  renderSeatChips();
});
byId("office-agent-mention").addEventListener("click", () => {
  if (state.selectedAgent) focusAgentComposer(state.selectedAgent);
});

/*
 * ⚙ menu. Every item forwards to the stage toolbar's own button, so the two can never disagree
 * about what a toggle does; the toolbar itself is hidden by CSS. Checkbox items mirror the source
 * button's aria-pressed after each click.
 */
function syncOfficeSettingsMenu() {
  for (const item of document.querySelectorAll("#office-settings-menu [data-office-action]")) {
    const source = byId(item.dataset.officeAction);
    item.disabled = !source;
    if (source && item.getAttribute("role") === "menuitemcheckbox") {
      item.setAttribute("aria-checked", source.getAttribute("aria-pressed") || "false");
    }
  }
  const rec = byId("rec-toggle");
  const recLabel = byId("office-rec-label");
  if (rec && recLabel) recLabel.textContent = rec.textContent;
}

/*
 * The menu is not a drawer: opening it leaves the rail's pressed state alone, it owns its own
 * aria-expanded on the ⚙ button, and closing it hands focus back there unless the close came from a
 * click somewhere else on the page (where stealing focus would be the surprise).
 */
function setOfficeSettingsMenu(open, { restoreFocus = true } = {}) {
  const menu = byId("office-settings-menu");
  if (!menu) return;
  const wasOpen = !menu.hidden;
  menu.hidden = !open;
  byId("office-settings-toggle").setAttribute("aria-expanded", String(open));
  syncOfficeRail();
  if (open) {
    syncOfficeSettingsMenu();
    menu.querySelector("button:not(:disabled)")?.focus();
  } else if (wasOpen && restoreFocus) {
    byId("office-settings-toggle").focus();
  }
}

byId("office-settings-menu").addEventListener("keydown", (event) => {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  const items = [...byId("office-settings-menu").querySelectorAll("button:not(:disabled)")];
  const index = items.indexOf(document.activeElement);
  if (index < 0) return;
  event.preventDefault();
  items[(index + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length].focus();
});

byId("office-settings-toggle").addEventListener("click", () => setOfficeSettingsMenu(byId("office-settings-menu").hidden));
for (const item of document.querySelectorAll("#office-settings-menu [data-office-action]")) {
  item.addEventListener("click", () => {
    byId(item.dataset.officeAction)?.click();
    syncOfficeSettingsMenu();
    if (item.getAttribute("role") !== "menuitemcheckbox") setOfficeSettingsMenu(false);
  });
}
byId("office-disclaimer-open").addEventListener("click", () => {
  setOfficeSettingsMenu(false);
  byId("office-disclaimer").hidden = false;
  byId("office-disclaimer-close").focus();
});
byId("office-disclaimer-close").addEventListener("click", () => {
  byId("office-disclaimer").hidden = true;
  byId("office-settings-toggle").focus();
});
byId("office-disclaimer").addEventListener("click", (event) => {
  if (event.target === event.currentTarget) byId("office-disclaimer").hidden = true;
});
document.addEventListener("click", (event) => {
  const menu = byId("office-settings-menu");
  if (!menu || menu.hidden) return;
  if (menu.contains(event.target) || byId("office-settings-toggle").contains(event.target)) return;
  /* A menu item forwards its click to the hidden toolbar button, and that synthetic click bubbles
     here too; it is the menu acting, not the owner clicking away from it. */
  if (event.target.closest?.(".office-toolbar, [data-office-toolbar]")) return;
  setOfficeSettingsMenu(false, { restoreFocus: false });
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (!byId("office-settings-menu").hidden) setOfficeSettingsMenu(false);
  else if (!byId("office-disclaimer").hidden) byId("office-disclaimer").hidden = true;
});

byId("managed-agent-create").addEventListener("submit", async (event) => {
  event.preventDefault();
  const provider = byId("managed-agent-provider").value;
  const label = byId("managed-agent-label").value.trim();
  const button = event.currentTarget.querySelector('button[type="submit"]');
  const status = byId("managed-agent-create-status");
  if (!state.room || !label) return;
  button.disabled = true;
  button.textContent = "建立中…";
  status.textContent = "";
  try {
    const value = await api("/api/rooms/managed-agents", {
      method: "POST",
      body: JSON.stringify({ room: state.room, provider, label }),
    });
    state.managedAgents = [...state.managedAgents, value.agent];
    byId("managed-agent-label").value = "";
    status.textContent = `${value.agent.displayName} 已建立，可從辦公室直接對話。`;
    renderManagedAgents();
    syncOfficeDesks();
    await poll();
  } catch (error) {
    status.textContent = `建立失敗：${humanError(error)}`;
  } finally {
    button.disabled = false;
    button.textContent = "＋ 建立即時子 Agent";
  }
});

byId("office-theme-toggle").addEventListener("click", () => {
  state.dayMode = !state.dayMode;
  byId("office").classList.toggle("day-mode", state.dayMode);
  const button = byId("office-theme-toggle");
  button.setAttribute("aria-pressed", String(state.dayMode));
  button.textContent = state.dayMode ? "☾ 夜間" : "☀ 日間";
});

byId("office-quiet-toggle").addEventListener("click", () => {
  state.quietMode = !state.quietMode;
  byId("office").classList.toggle("quiet-mode", state.quietMode);
  const button = byId("office-quiet-toggle");
  button.setAttribute("aria-pressed", String(state.quietMode));
  button.textContent = state.quietMode ? "🔔 顯示休息區" : "🔕 安靜";
  if (state.quietMode) {
    for (const agent of OFFICE_AGENTS) {
      const desk = byId(`desk-${agent}`);
      if (desk?.dataset.activity) clearBubble(agent);
    }
  }
});

byId("office-idle-toggle").addEventListener("click", () => {
  state.idleEnabled = !state.idleEnabled;
  byId("office").classList.toggle("idle-disabled", !state.idleEnabled);
  const button = byId("office-idle-toggle");
  button.setAttribute("aria-pressed", String(state.idleEnabled));
  button.textContent = state.idleEnabled ? "🧘 活動" : "▶ 休閒";
  if (!state.idleEnabled) for (const agent of OFFICE_AGENTS) clearIdleActivity(agent);
});

byId("office-layout-reset").addEventListener("click", () => {
  state.officePositions = {};
  delete state.officeLayouts[state.room];
  /* A tidy-up puts the Writer back in the draft room as well. */
  officeWriterKey = "";
  syncOfficeDesks();
  byId("office-caption").textContent = `已重新排列 ${OFFICE_AGENTS.length} 個工位 · 可繼續拖曳調整`;
});

function updateFullscreenButton() {
  const active = document.fullscreenElement === byId("office") || byId("office").classList.contains("focus-mode");
  const button = byId("office-fullscreen-toggle");
  button.setAttribute("aria-pressed", String(active));
  button.textContent = active ? "↙ 離開全螢幕" : "⛶ 全螢幕";
}

byId("office-fullscreen-toggle").addEventListener("click", async () => {
  const office = byId("office");
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else if (office.requestFullscreen) await office.requestFullscreen();
    else office.classList.toggle("focus-mode");
  } catch {
    office.classList.toggle("focus-mode");
  }
  updateFullscreenButton();
});
document.addEventListener("fullscreenchange", updateFullscreenButton);

/* The grid is measured from the floor, so a resized window (or fullscreen) has to re-measure it. A
   timer rather than requestAnimationFrame: frames do not run in a background tab, and a window resized
   while this tab was hidden should still be laid out correctly the moment it is shown. */
let officeResizeTimer = null;
window.addEventListener("resize", () => {
  if (byId("office").hidden) return;
  clearTimeout(officeResizeTimer);
  officeResizeTimer = setTimeout(() => syncOfficeDesks(), 80);
});

function activeWriterLease() {
  const taskId = byId("writer-task-id")?.value.trim();
  const active = (state.writers?.leases || []).filter((lease) => lease.state === "active");
  return active.find((lease) => lease.taskId === taskId) || active[0];
}

/*
 * 與 activeWriterLease() 相同：找不到符合輸入框 taskId 的 lease 時退回最新一筆，
 * 否則面板重開後自動填入的新 taskId 會讓「待回寫」的任務整個從 UI 消失。
 */
function reviewReadyWriterLease() {
  const taskId = byId("writer-task-id")?.value.trim();
  const ready = (state.writers?.leases || [])
    .filter((lease) => lease.state === "completed" && lease.taskPhase === "review-ready")
    .sort((left, right) => Number(right.grantedAtMs || 0) - Number(left.grantedAtMs || 0));
  return ready.find((lease) => lease.taskId === taskId) || ready[0];
}

function terminalWriterLease() {
  const taskId = byId("writer-task-id")?.value.trim();
  const terminal = (state.writers?.leases || [])
    .filter((lease) => ["applying", "applied"].includes(lease.taskPhase))
    .sort((left, right) => Number(right.grantedAtMs || 0) - Number(left.grantedAtMs || 0));
  return terminal.find((lease) => lease.taskId === taskId) || terminal[0];
}

function pendingWriterLease() {
  return activeWriterLease() || reviewReadyWriterLease();
}

function renderWriterControl() {
  const select = byId("writer-candidate");
  if (!select) return;
  const selected = select.selectedOptions[0]?.dataset.key || "";
  select.textContent = "";
  for (const candidate of state.writers?.candidates || []) {
    const option = document.createElement("option");
    const key = `${candidate.origin}:${candidate.actorId}`;
    option.dataset.key = key;
    option.dataset.candidate = JSON.stringify(candidate.origin === "resident"
      ? { origin: "resident", provider: candidate.provider }
      : { origin: candidate.origin, actorId: candidate.actorId });
    option.value = key;
    option.disabled = !candidate.eligible;
    option.textContent = `${candidate.displayName} · ${candidate.origin}${candidate.eligible ? "" : `（${candidate.reason || "不可寫"}）`}`;
    if (key === selected) option.selected = true;
    select.append(option);
  }
  const active = activeWriterLease();
  const reviewReady = active ? undefined : reviewReadyWriterLease();
  const terminal = active || reviewReady ? undefined : terminalWriterLease();
  const summary = byId("writer-active-summary");
  const summaryName = byId("writer-active-name");
  const summaryMeta = byId("writer-active-meta");
  const children = active
    ? (state.writers?.delegations || []).filter((child) => child.parentLeaseId === active.id && child.state === "active")
    : [];
  const executor = byId("writer-executor");
  const selectedExecutor = executor.value;
  executor.textContent = "";
  const writerOption = document.createElement("option");
  writerOption.value = "";
  writerOption.textContent = active ? `Writer 本人：${active.writer.displayName}` : "目前 Writer 本人";
  executor.append(writerOption);
  for (const child of children) {
    const option = document.createElement("option");
    option.value = child.id;
    option.textContent = `${child.displayName} · ${child.access === "write" ? "共用草稿區（序列執行）" : "跨類型唯讀"}`;
    executor.append(option);
  }
  executor.value = children.some((child) => child.id === selectedExecutor) ? selectedExecutor : "";
  const executionId = executor.value || active?.id || "";
  const executionBusy = Boolean(executionId && (state.writers?.busyLeaseIds || []).includes(executionId));
  summary.classList.toggle("is-active", Boolean(active));
  const shown = active || reviewReady || terminal;
  summaryName.textContent = shown ? `${shown.writer.displayName} · 第 ${shown.epoch} 任` : "尚未指派 Writer";
  summaryMeta.textContent = active
    ? `${active.taskId} · 草稿區 ${workspaceLabel(active.worktree).slice(0, 8)}${active.companionId ? " · via Writer Companion" : ""} · ${children.length} 個子 Agent`
    : reviewReady
      ? `${reviewReady.taskId} · 寫作完成，尚未 apply-back`
      : terminal?.taskPhase === "applied"
        ? `${terminal.taskId} · 已由 Owner 核准並 apply-back`
        : terminal?.taskPhase === "applying"
          ? `${terminal.taskId} · apply-back 狀態待人工確認（fail-closed）`
      : "指派後會建立獨立草稿區；交接時舊任與子 Agent 的寫入權立即失效。";
  byId("writer-assign").textContent = active ? "交接 Writer" : "指派 Writer";
  byId("writer-handover").disabled = !active;
  const completeButton = byId("writer-complete");
  if (!active) state.writerCompleteConfirm = "";
  const awaitingCompleteConfirm = Boolean(active) &&
    state.writerCompleteConfirm === `${active.taskId}:${active.epoch}`;
  completeButton.disabled = !active && !reviewReady;
  /* test/web.test.ts pins these two labels; the drawer keeps them rather than the mock-up's shorter
     "結束並 apply-back", because "準備回寫" is the honest tense -- pressing it revokes write access and
     only PREPARES the apply-back preview. */
  completeButton.textContent = awaitingCompleteConfirm
    ? "再按一次：結束 Writer 並撤銷寫入權"
    : active
      ? "結束 Writer 並準備回寫"
      : reviewReady ? "重新檢視回寫風險" : "結束 Writer 並準備回寫";
  completeButton.classList.toggle("danger", awaitingCompleteConfirm);
  byId("writer-delegate").disabled = !active;
  byId("writer-run-cancel").hidden = !executionBusy;
  byId("writer-run-cancel").disabled = !executionBusy;
  byId("writer-run-cancel").textContent = executor.value ? "取消子 Agent 執行" : "取消 Writer 執行";
  if (!byId("writer-handoff-submit").disabled) {
    byId("writer-handoff-submit").textContent = active ? "交給目前 Writer 執行" : "建立待確認提案";
  }
}

async function cancelWriterRun() {
  const active = activeWriterLease();
  const delegationId = byId("writer-executor").value;
  const status = byId("writer-handoff-status");
  if (!active) {
    status.textContent = "目前沒有執行中的 Writer 任務。";
    return;
  }
  try {
    await api("/api/rooms/writers/cancel", {
      method: "POST",
      body: JSON.stringify({
        room: state.room,
        taskId: active.taskId,
        ...(delegationId ? { delegationId } : {}),
      }),
    });
    status.textContent = delegationId ? "已要求取消精確子 Agent 執行。" : "已要求取消精確 Writer 執行。";
    await refreshPresence(true);
  } catch (error) {
    status.textContent = `取消失敗：${humanError(error)}`;
  }
}

async function assignWriter() {
  const option = byId("writer-candidate").selectedOptions[0];
  const candidate = option?.dataset.candidate ? JSON.parse(option.dataset.candidate) : undefined;
  const taskId = byId("writer-task-id").value.trim();
  const checkpoint = byId("writer-checkpoint").value.trim();
  const status = byId("writer-live-status");
  if (!candidate || !taskId) {
    status.textContent = "請選擇 Writer 並填入任務識別。";
    return;
  }
  const active = activeWriterLease();
  try {
    status.textContent = active ? "正在凍結舊 Writer 並建立交接 checkpoint…" : "正在建立草稿區（獨立副本）與 Writer Lease…";
    if (active) {
      if (!checkpoint) throw new Error("交接前必須填寫存檔點");
      await api("/api/rooms/writers/switch", {
        method: "POST",
        body: JSON.stringify({ room: state.room, taskId: active.taskId, expectedEpoch: active.epoch, checkpoint, candidate }),
      });
    } else {
      await api("/api/rooms/writers/grant", {
        method: "POST",
        body: JSON.stringify({ room: state.room, taskId, candidate }),
      });
    }
    byId("writer-checkpoint").value = "";
    await refreshPresence(true);
    status.textContent = active ? "Writer 已交接；舊 epoch 與子權限已撤銷。" : "Writer 已指派並建立草稿區（獨立副本）。";
  } catch (error) {
    status.textContent = `Writer 操作失敗：${humanError(error)}`;
  }
}

/*
 * 兩個階段必須分開回報：階段 1（結束 Writer）一旦成功，Writer 與所有子 Agent 的寫入權
 * 就已經撤銷；此時階段 2 失敗不能再顯示成「完成失敗」，否則使用者會以為什麼都沒發生。
 */
async function completeWriterLease() {
  const active = activeWriterLease();
  const reviewReady = active ? undefined : reviewReadyWriterLease();
  const checkpoint = byId("writer-checkpoint").value.trim();
  const status = byId("writer-live-status");
  if (!active && !reviewReady) {
    status.textContent = "目前沒有可結束或待 apply-back 的 Writer 任務。";
    return;
  }
  if (active && !checkpoint) {
    status.textContent = "結束前必須填寫存檔點。";
    return;
  }
  if (active) {
    const confirmKey = `${active.taskId}:${active.epoch}`;
    const children = (state.writers?.delegations || [])
      .filter((child) => child.parentLeaseId === active.id && child.state === "active");
    if (state.writerCompleteConfirm !== confirmKey) {
      state.writerCompleteConfirm = confirmKey;
      status.textContent = `這個動作會先結束 Writer ${active.writer.displayName}（${active.taskId} · epoch ${active.epoch}），` +
        `立即撤銷它與 ${children.length} 個子 Agent 的寫入權，之後才產生 apply-back 預覽；` +
        "撤銷後不能繼續寫作，只能重新指派 Writer。確定的話請再按一次按鈕。";
      renderWriterControl();
      return;
    }
    state.writerCompleteConfirm = "";
  }
  const taskId = active?.taskId || reviewReady.taskId;
  let preview;
  let phrase = "";
  try {
    status.textContent = active
      ? "階段 1／2：正在結束 Writer 並撤銷寫入權…"
      : "正在重新產生回寫預覽…";
    const value = active
      ? await api("/api/rooms/writers/complete", {
        method: "POST",
        body: JSON.stringify({ room: state.room, taskId: active.taskId, epoch: active.epoch, checkpoint }),
      })
      : await api("/api/rooms/writers/apply-back/prepare", {
        method: "POST",
        body: JSON.stringify({ room: state.room, taskId: reviewReady.taskId }),
      });
    preview = value.preview;
    /* 短語跟著預覽一起來。前端沒有自己的一份，因此後端改了字，畫面上那句就跟著改。 */
    phrase = typeof value.confirmationPhrase === "string" ? value.confirmationPhrase : "";
  } catch (error) {
    status.textContent = active
      ? `階段 1／2（結束 Writer）失敗：${humanError(error)}。Writer 與子 Agent 的寫入權仍然有效，主專案沒有變更。`
      : `重新產生回寫預覽失敗：${humanError(error)}。主專案沒有變更。`;
    renderWriterControl();
    return;
  }
  await refreshPresence(true);
  if (!preview) {
    status.textContent = active
      ? "階段 1／2 完成：Writer 已結束、寫入權已撤銷；但沒有取得回寫預覽。請按「重新檢視回寫風險」再試一次。"
      : "沒有取得回寫預覽，請稍後再試；主專案沒有變更。";
    return;
  }
  await openWriterApplyBackApproval(
    taskId,
    preview,
    phrase,
    active ? "階段 1／2 完成：Writer 已結束、寫入權已撤銷。" : "",
  );
}

/*
 * ── Writer 回寫主專案的核准對話框 · writer apply-back approval dialog ────────
 *
 * 這條路徑以前是一個 window.prompt（P0-2）。原生對話框有三個各自獨立的破壞方式：
 *   1. 瀏覽器可以永久靜音它。之後 prompt 直接回傳 null，走到取消分支顯示「已保留在隔離
 *      worktree」——那句話當下為真，卻掩蓋了「核准 UI 已經永久失效」；使用者只覺得按鈕壞了。
 *   2. 短語印在訊息最底部，而變更清單會把訊息撐開，超過瀏覽器的高度上限就被裁掉：
 *      使用者看不到自己要打什麼。
 *   3. prompt 開啟期間整頁凍結，而預覽 TTL 只有 120 秒——倒數在它底下物理上不可能顯示。
 *
 * 換成 in-page 對話框才同時處理這三個：對話框不能被靜音、短語有自己的位置不會被裁掉、
 * 倒數每秒在走。沿用 .workspace-onboarding / .merge-approval 元件，不另立設計語言。
 */

/* @pure-start writer-apply-back-gate
 * 這一段刻意不碰 DOM、不碰網路、不碰 state，只做輸入→輸出的判斷，好讓 test/web.test.ts
 * 直接執行它、對行為本身下斷言，而不是對「原始碼裡有沒有某一行字串」下斷言（[[PITFALLS]] #83）。 */
const WRITER_APPLY_BACK_RISK_LABELS = {
  low: "低風險 · LOW",
  medium: "中風險 · MEDIUM",
  high: "高風險 · HIGH",
};

/* 風險等級未知或缺漏時一律當成高風險：缺席只能往嚴的方向移動。 */
function writerApplyBackRisk(preview, blockerCount) {
  if (Number(blockerCount) > 0) return { key: "high", text: WRITER_APPLY_BACK_RISK_LABELS.high };
  const risk = preview && typeof preview === "object" ? preview.risk : null;
  const level = risk && typeof risk === "object" ? String(risk.level) : "";
  const text = Object.prototype.hasOwnProperty.call(WRITER_APPLY_BACK_RISK_LABELS, level)
    ? WRITER_APPLY_BACK_RISK_LABELS[level]
    : "";
  return text ? { key: level, text } : { key: "high", text: WRITER_APPLY_BACK_RISK_LABELS.high };
}

function writerApplyBackScrolledToBottom(metrics) {
  const top = Number(metrics ? metrics.scrollTop : Number.NaN);
  const view = Number(metrics ? metrics.clientHeight : Number.NaN);
  const total = Number(metrics ? metrics.scrollHeight : Number.NaN);
  if (!Number.isFinite(top) || !Number.isFinite(view) || !Number.isFinite(total)) return false;
  return top + view >= total - 4;
}

/*
 * 阻擋項＝「在這個狀態下不可以簽名」的理由。全部逐條顯示，並且壓住確認輸入與主要按鈕。
 * 每一條的方向都一樣：讀不到、來不及、對不上，一律往「不可核准」倒，不往「可以按了」倒。
 */
function writerApplyBackBlockers(view) {
  const blockers = [];
  const preview = view && typeof view === "object" ? view.preview : null;
  if (!preview || typeof preview !== "object") {
    blockers.push("尚未取得回寫預覽，沒有可核准的內容。 · No apply-back preview has been fetched yet.");
    return blockers;
  }
  /*
   * 短語只能來自後端。前端不留一份常數當備援：備援會讓「畫面上那句話」與「後端要的那句話」
   * 再次分家，而那正是這次要修掉的東西。
   */
  const phrase = view.phrase;
  if (typeof phrase !== "string" || phrase.length === 0) {
    blockers.push("後端沒有給這次回寫的確認短語，無法確認你要簽的是哪一句。 · The backend supplied no confirmation phrase for this apply-back.");
  }
  const deadline = Date.parse(String(preview.expiresAt));
  const now = Number(view.now);
  if (!Number.isFinite(deadline) || !Number.isFinite(now)) {
    blockers.push("預覽沒有可解析的到期時間，無法確認它仍然有效。 · The preview carries no parsable expiry.");
  } else if (deadline - now <= 0) {
    blockers.push("預覽視窗已逾時，必須重新產生預覽再問一次。 · The preview window expired; re-preview and ask again.");
  }
  if (view.diffState !== "loaded") {
    blockers.push(view.diffState === "failed"
      ? "變更內容讀取失敗；看不到要寫回什麼就不可核准。 · The change content failed to load; you must not sign for content you cannot see."
      : "變更內容尚未載入完成。 · The change content is not loaded yet.");
  }
  const listed = Array.isArray(preview.changes) ? preview.changes.length : 0;
  if (listed !== Number(preview.files)) {
    blockers.push(`變更清單只列出 ${listed} 筆，預覽宣稱共 ${Number(preview.files)} 筆；清單不完整就不可核准。 · The change list is incomplete.`);
  }
  if (view.applying) {
    blockers.push("這筆回寫正在執行中，不能重複送出。 · This apply-back is already running.");
  }
  return blockers;
}

/*
 * scroll-gate：沒捲到底、還有阻擋項、已經有結果、或後端沒給短語時，確認輸入框保持
 * disabled 並清空，主要按鈕跟著鎖住。「我捲完了」比「我抄完了」更能證明使用者看過內容。
 */
function writerApplyBackGate(view) {
  const blockerCount = Array.isArray(view && view.blockers) ? view.blockers.length : 0;
  const blocked = blockerCount > 0;
  const scrolled = Boolean(view && view.scrolled);
  const decided = Boolean(view && view.decided);
  const phrase = view && typeof view.phrase === "string" ? view.phrase : "";
  const ready = !blocked && scrolled && !decided && phrase.length > 0;
  const typed = ready ? String((view && view.typed) || "") : "";
  return {
    ready,
    phrase,
    inputDisabled: !ready,
    inputValue: typed,
    confirmDisabled: !ready || phrase.length === 0 || typed !== phrase,
    hint: decided
      ? "這筆回寫已經有結果，不能再決定一次。 · This apply-back has already been decided."
      : blocked
        ? "阻擋區還有項目：確認輸入與「回寫主專案」保持停用。 · Blocking items remain; the confirmation input and the primary button stay disabled."
        : phrase.length === 0
          ? "後端沒有給確認短語，這筆回寫不可核准。 · No confirmation phrase was supplied; this apply-back cannot be approved."
          : scrolled
            ? `變更內容已捲到底：輸入 ${phrase} 即可解鎖「回寫主專案」。 · Scrolled to the end; type the phrase to enable the primary button.`
            : "請把上面的變更內容捲到底（展開檔案後會重新計算），確認輸入才會解鎖。 · Scroll the change content to the bottom to enable the confirmation input.",
  };
}

function formatWriterApplyBackBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value)) return "—";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function formatWriterApplyBackCountdown(ms) {
  const total = Math.max(0, Math.floor(Number(ms) / 1000));
  const minutes = String(Math.floor(total / 60)).padStart(2, "0");
  const seconds = String(total % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}
/* @pure-end writer-apply-back-gate */

const WRITER_APPLY_BACK_TRASH_ROOT = "~/trash-pending/orchestratory";
const WRITER_APPLY_BACK_OPERATION_LABELS = {
  write: "寫入 · Write",
  delete: "移到 trash-pending · Move to trash-pending",
};

function writerApplyBackNode(tag, className, id, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (id) node.id = id;
  if (text !== undefined) node.textContent = text;
  return node;
}

function buildWriterApplyBackDialog() {
  const dialog = writerApplyBackNode("section", "workspace-onboarding merge-approval", "writer-apply-back");
  dialog.hidden = true;
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-labelledby", "writer-apply-back-title");
  const card = writerApplyBackNode("div", "workspace-onboarding-card merge-approval-card");

  const header = document.createElement("header");
  const heading = document.createElement("span");
  heading.append(
    writerApplyBackNode("small", "", "", "WRITER APPLY BACK TO THE MAIN PROJECT"),
    writerApplyBackNode("b", "", "writer-apply-back-title", "把 Writer 的變更回寫主專案 · Apply the Writer's changes back"),
  );
  const closeButton = writerApplyBackNode("button", "", "writer-apply-back-close", "×");
  closeButton.type = "button";
  closeButton.setAttribute("aria-label", "關閉回寫核准");
  header.append(heading, closeButton);

  const head = writerApplyBackNode("div", "merge-approval-head");
  const identity = writerApplyBackNode("div", "merge-approval-identity");
  identity.append(
    writerApplyBackNode("em", "merge-approval-risk", "writer-apply-back-risk", "—"),
    writerApplyBackNode("code", "", "writer-apply-back-task", "—"),
  );
  head.append(identity, writerApplyBackNode(
    "p",
    "merge-approval-route",
    "writer-apply-back-route",
    "隔離 Writer worktree → 主專案工作目錄 · isolated writer worktree → main project working tree",
  ));

  const risks = writerApplyBackNode("div", "merge-approval-risks", "writer-apply-back-risks");

  const blocking = writerApplyBackNode("section", "merge-approval-blocking", "writer-apply-back-blocking");
  blocking.hidden = true;
  const repreview = writerApplyBackNode("button", "", "writer-apply-back-repreview", "↻ 重新產生預覽 · Re-preview");
  repreview.type = "button";
  blocking.append(
    writerApplyBackNode("b", "", "", "無法核准 · Blocking"),
    writerApplyBackNode("p", "", "", "下列項目存在期間，確認輸入與「回寫主專案」保持停用。 · While any of these is present the confirmation input and the primary button stay disabled."),
    writerApplyBackNode("ul", "", "writer-apply-back-blockers"),
    repreview,
  );

  const stats = writerApplyBackNode("div", "merge-approval-stats", "writer-apply-back-stats");
  const diffLabel = writerApplyBackNode(
    "p",
    "merge-approval-diff-label",
    "",
    "要寫回的變更（全部列出，請捲到底） · Every change to be written back (scroll to the bottom)",
  );
  const diff = writerApplyBackNode("div", "merge-approval-diff", "writer-apply-back-diff");
  diff.tabIndex = 0;

  const recovery = writerApplyBackNode("section", "merge-approval-recovery");
  const copy = writerApplyBackNode("button", "", "writer-apply-back-copy", "⧉ 複製查看指令 · Copy inspection command");
  copy.type = "button";
  recovery.append(
    writerApplyBackNode("b", "", "", "還原點"),
    writerApplyBackNode("div", "merge-approval-recovery-facts", "writer-apply-back-recovery-facts"),
    writerApplyBackNode("code", "", "writer-apply-back-restore", ""),
    /*
     * 這裡只給唯讀的查看指令。跨程序之後產品沒有第一手觀察，遞出去的字串就不得帶
     * reset --hard／clean -f／stash push 這類會再毀一次的動作（[[PITFALLS]] #94）。
     */
    writerApplyBackNode("small", "", "", `上面是唯讀查看指令，Orchestratory 不會替你執行；刪除只會移到 ${WRITER_APPLY_BACK_TRASH_ROOT}，不會永久刪除。 · Read-only inspection commands; Orchestratory does not run them for you.`),
    copy,
  );

  const ttl = writerApplyBackNode("div", "merge-approval-ttl");
  const ttlText = document.createElement("span");
  ttlText.append(
    writerApplyBackNode("small", "", "", "預覽視窗剩餘 · Preview window"),
    writerApplyBackNode("b", "", "writer-apply-back-ttl", "—"),
  );
  const refresh = writerApplyBackNode("button", "", "writer-apply-back-refresh", "↻ 重新產生預覽 · Re-preview");
  refresh.type = "button";
  ttl.append(ttlText, refresh);

  const confirmArea = writerApplyBackNode("div", "", "writer-apply-back-confirm-area");
  const label = document.createElement("label");
  label.htmlFor = "writer-apply-back-confirmation";
  label.append(
    document.createTextNode("輸入 "),
    /* 空字串起始：這句話由後端供給，前端沒有一份自己的文案可以顯示。 */
    writerApplyBackNode("code", "", "writer-apply-back-phrase", ""),
    document.createTextNode(" 確認把變更寫回主專案 · type the phrase to confirm"),
  );
  const input = writerApplyBackNode("input", "", "writer-apply-back-confirmation");
  input.type = "text";
  input.maxLength = 64;
  input.autocomplete = "off";
  input.spellcheck = false;
  input.disabled = true;
  confirmArea.append(
    label,
    input,
    writerApplyBackNode("p", "merge-approval-scroll-hint", "writer-apply-back-scroll-hint", ""),
  );

  const actions = writerApplyBackNode("div", "workspace-onboarding-actions merge-approval-actions");
  const cancel = writerApplyBackNode("button", "", "writer-apply-back-cancel", "取消 · Cancel");
  cancel.type = "button";
  const confirmButton = writerApplyBackNode("button", "danger", "writer-apply-back-confirm", "回寫主專案 · Apply back to the main project");
  confirmButton.type = "button";
  confirmButton.disabled = true;
  actions.append(cancel, confirmButton);

  const status = writerApplyBackNode("p", "workspace-onboarding-status", "writer-apply-back-status", "");
  status.setAttribute("aria-live", "polite");

  card.append(header, head, risks, blocking, stats, diffLabel, diff, recovery, ttl, confirmArea, actions, status);
  dialog.append(card);
  document.body.append(dialog);
  return dialog;
}

function ensureWriterApplyBackDialog() {
  const existing = byId("writer-apply-back");
  if (existing) return existing;
  const dialog = buildWriterApplyBackDialog();
  byId("writer-apply-back-close").addEventListener("click", closeWriterApplyBackApproval);
  byId("writer-apply-back-cancel").addEventListener("click", closeWriterApplyBackApproval);
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) closeWriterApplyBackApproval();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !dialog.hidden) closeWriterApplyBackApproval();
  });
  byId("writer-apply-back-diff").addEventListener("scroll", () => {
    if (writerApplyBackScrolledToBottom(byId("writer-apply-back-diff"))) state.writerApplyBack.scrolled = true;
    updateWriterApplyBackGate();
  });
  /* 展開一個檔案會多出還沒看過的內容，因此重新評估捲動門檻，而不是沿用舊結果。 */
  byId("writer-apply-back-diff").addEventListener("toggle", () => {
    state.writerApplyBack.scrolled = writerApplyBackScrolledToBottom(byId("writer-apply-back-diff"));
    updateWriterApplyBackGate();
  }, true);
  byId("writer-apply-back-confirmation").addEventListener("input", updateWriterApplyBackGate);
  byId("writer-apply-back-confirm").addEventListener("click", () => { void confirmWriterApplyBack(); });
  byId("writer-apply-back-refresh").addEventListener("click", () => { void loadWriterApplyBackPreview(); });
  byId("writer-apply-back-repreview").addEventListener("click", () => { void loadWriterApplyBackPreview(); });
  byId("writer-apply-back-copy").addEventListener("click", async () => {
    const status = byId("writer-apply-back-status");
    try {
      await navigator.clipboard.writeText(byId("writer-apply-back-restore").textContent || "");
      status.textContent = "已複製查看指令；Orchestratory 沒有執行它。 · Inspection command copied; Orchestratory did not run it.";
    } catch {
      status.textContent = "瀏覽器不允許自動複製，請手動選取上面的指令。 · Clipboard access was refused; select the command above manually.";
    }
  });
  return dialog;
}

function updateWriterApplyBackGate() {
  const input = byId("writer-apply-back-confirmation");
  const confirmButton = byId("writer-apply-back-confirm");
  const hint = byId("writer-apply-back-scroll-hint");
  if (!input || !confirmButton || !hint) return;
  const view = state.writerApplyBack;
  const gate = writerApplyBackGate({
    blockers: view.blockers,
    scrolled: view.scrolled,
    decided: view.decided,
    typed: input.value,
    phrase: view.phrase,
  });
  if (input.value !== gate.inputValue) input.value = gate.inputValue;
  input.disabled = gate.inputDisabled;
  confirmButton.disabled = gate.confirmDisabled;
  hint.textContent = gate.hint;
}

function renderWriterApplyBackRisks(preview) {
  const host = byId("writer-apply-back-risks");
  if (!host) return;
  host.textContent = "";
  const reasons = preview && preview.risk && Array.isArray(preview.risk.reasons) ? preview.risk.reasons : [];
  const lines = reasons.map((reason) => `風險原因 · Risk reason：${reason}`);
  lines.push("這個動作會直接修改主專案，且不會經過 Git commit；只有刪除可以從 trash-pending 復原。 · This writes into the main project directly; only deletions can be recovered from trash-pending.");
  if (reasons.length === 0) {
    lines.unshift("後端沒有回報任何風險原因；這不等於沒有風險，仍請逐檔檢視下方變更。 · The backend declared no risk reasons; that is not the same as there being none.");
  }
  for (const line of lines) host.append(writerApplyBackNode("p", "", "", line));
}

function renderWriterApplyBackStats(preview) {
  const host = byId("writer-apply-back-stats");
  if (!host) return;
  host.textContent = "";
  const entries = [
    ["檔案 · Files", String(preview ? Number(preview.files) : 0)],
    ["寫入 · Writes", String(preview ? Number(preview.writes) : 0)],
    ["移到 trash-pending · Deletes", String(preview ? Number(preview.deletes) : 0)],
    ["內容大小 · Total bytes", formatWriterApplyBackBytes(preview ? preview.totalBytes : Number.NaN)],
    ["基準 commit · Base SHA", preview ? String(preview.baseSha).slice(0, 12) : "—"],
  ];
  for (const [label, value] of entries) {
    const cell = document.createElement("span");
    cell.append(writerApplyBackNode("small", "", "", label), writerApplyBackNode("b", "", "", value));
    host.append(cell);
  }
}

/*
 * 全部列出，不截斷。舊的 prompt 只印前 24 筆再補一句「另有 N 筆未列出」——
 * 那句話誠實，但 Owner 沒看到的那幾筆一樣會被寫進主專案。
 */
function renderWriterApplyBackChanges(view) {
  const region = byId("writer-apply-back-diff");
  if (!region) return;
  region.textContent = "";
  const preview = view.preview;
  const changes = preview && Array.isArray(preview.changes) ? preview.changes : [];
  if (!preview) {
    region.append(writerApplyBackNode("p", "merge-file-empty", "", "尚未取得預覽。 · No preview yet."));
    return;
  }
  if (changes.length === 0) {
    region.append(writerApplyBackNode("p", "merge-file-empty", "", "這份預覽沒有列出任何檔案變更。 · This preview lists no file changes."));
  }
  for (const change of changes) {
    const item = writerApplyBackNode("details", "merge-file");
    const summary = document.createElement("summary");
    const operation = writerApplyBackNode("i", `merge-file-op is-${change.operation}`);
    operation.textContent = WRITER_APPLY_BACK_OPERATION_LABELS[change.operation] || String(change.operation);
    const path = writerApplyBackNode("b", "", "", String(change.path));
    const delta = writerApplyBackNode("em", "merge-file-delta", "", formatWriterApplyBackBytes(change.bytes));
    summary.append(operation, path, delta);
    const detail = writerApplyBackNode("div", "merge-file-detail");
    const facts = [
      `動作 · Operation：${WRITER_APPLY_BACK_OPERATION_LABELS[change.operation] || change.operation}`,
      `大小 · Size：${formatWriterApplyBackBytes(change.bytes)}`,
      change.operation === "delete"
        ? `這個檔案會被移到 ${WRITER_APPLY_BACK_TRASH_ROOT}，不會永久刪除。 · Moved to trash-pending, not permanently deleted.`
        : "這個檔案會以草稿區（獨立副本）的內容寫入主專案。",
    ];
    for (const fact of facts) detail.append(writerApplyBackNode("p", "", "", fact));
    item.append(summary, detail);
    region.append(item);
  }
  region.append(writerApplyBackNode(
    "p",
    "merge-approval-diff-label",
    "",
    "草稿區（獨立副本）的逐行變更（後端 bounded 輸出，可能被截斷）",
  ));
  if (view.diffState === "loaded") {
    region.append(writerApplyBackNode("pre", "apply-back-diff-text", "", view.diffText));
  } else {
    region.append(writerApplyBackNode(
      "p",
      "merge-file-truncated",
      "",
      view.diffState === "failed"
        ? `變更內容讀取失敗，因此不可核准：${view.diffError || "未知原因"} · The change content failed to load, so this cannot be approved.`
        : "變更內容讀取中… · Loading the change content…",
    ));
  }
  region.append(writerApplyBackNode("p", "merge-diff-end", "", "── 變更內容結束 · end of change content ──"));
}

function renderWriterApplyBackRecovery(preview) {
  const host = byId("writer-apply-back-recovery-facts");
  const command = byId("writer-apply-back-restore");
  if (!host || !command) return;
  host.textContent = "";
  const workspace = preview ? String(preview.sourceWorkspace) : "";
  const facts = [
    ["主專案 · Main workspace", workspace],
    ["基準 commit · Base SHA", preview ? String(preview.baseSha) : ""],
    ["主專案指紋 · Source fingerprint", preview ? String(preview.sourceFingerprint).slice(0, 16) : ""],
    ["Writer worktree 指紋 · Worktree fingerprint", preview ? String(preview.worktreeFingerprint).slice(0, 16) : ""],
    ["刪除去向 · Deletions go to", WRITER_APPLY_BACK_TRASH_ROOT],
  ];
  for (const [label, value] of facts) {
    const row = document.createElement("span");
    row.append(writerApplyBackNode("small", "", "", label), writerApplyBackNode("code", "", "", value || "—"));
    host.append(row);
  }
  const target = workspace || ".";
  command.textContent = [
    `git -C ${target} status --short`,
    `git -C ${target} diff --stat`,
    `ls ${WRITER_APPLY_BACK_TRASH_ROOT}`,
  ].join("\n");
}

function tickWriterApplyBackTtl() {
  const node = byId("writer-apply-back-ttl");
  const view = state.writerApplyBack;
  if (!node) return;
  const deadline = Date.parse(String(view.preview ? view.preview.expiresAt : ""));
  if (!Number.isFinite(deadline)) {
    node.textContent = "—";
    node.className = "";
    return;
  }
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    node.textContent = "已逾時 · expired";
    node.className = "is-expired";
    if (!view.expiredRendered) {
      view.expiredRendered = true;
      renderWriterApplyBackApproval();
      byId("writer-apply-back-status").textContent =
        "預覽視窗已逾時；這是刻意的摩擦，不是錯誤。請按「重新產生預覽」再問一次；主專案沒有被修改。 · The preview window expired; re-preview and ask again.";
    }
    return;
  }
  node.textContent = `${formatWriterApplyBackCountdown(remaining)}（${new Date(deadline).toLocaleTimeString("zh-TW", { hour12: false })} 到期 · expires）`;
  node.className = remaining < 30_000 ? "is-urgent" : "";
}

function renderWriterApplyBackApproval() {
  const view = state.writerApplyBack;
  if (!byId("writer-apply-back")) return;
  view.blockers = writerApplyBackBlockers({
    preview: view.preview,
    phrase: view.phrase,
    diffState: view.diffState,
    applying: view.applying,
    now: Date.now(),
  });
  const risk = writerApplyBackRisk(view.preview, view.blockers.length);
  const badge = byId("writer-apply-back-risk");
  badge.textContent = risk.text;
  badge.className = `merge-approval-risk is-${risk.key}`;
  byId("writer-apply-back-task").textContent = view.taskId ? `task ${view.taskId}` : "—";
  byId("writer-apply-back-route").textContent = view.preview
    ? `隔離 Writer worktree → 主專案工作目錄 · isolated writer worktree → main project working tree：${view.preview.sourceWorkspace}`
    : "隔離 Writer worktree → 主專案工作目錄 · isolated writer worktree → main project working tree";
  /* 短語直接印後端給的值：改掉後端那個值，這一行就跟著變。 */
  byId("writer-apply-back-phrase").textContent = view.phrase;
  renderWriterApplyBackRisks(view.preview);
  renderWriterApplyBackStats(view.preview);
  renderWriterApplyBackChanges(view);
  renderWriterApplyBackRecovery(view.preview);
  const blocking = byId("writer-apply-back-blocking");
  const list = byId("writer-apply-back-blockers");
  list.textContent = "";
  blocking.hidden = view.blockers.length === 0;
  for (const blocker of view.blockers) list.append(writerApplyBackNode("li", "", "", blocker));
  tickWriterApplyBackTtl();
  /* 內容比視窗短時本來就已經在底部；展開檔案會讓它重新變成未讀完。 */
  view.scrolled = writerApplyBackScrolledToBottom(byId("writer-apply-back-diff"));
  updateWriterApplyBackGate();
}

async function loadWriterApplyBackDiff() {
  const view = state.writerApplyBack;
  const runId = view.preview ? String(view.preview.runId || "") : "";
  if (!runId) {
    view.diffText = "";
    view.diffState = "failed";
    view.diffError = "預覽沒有帶 runId，無法讀取變更內容。 · The preview carries no runId.";
    return;
  }
  try {
    const value = await api(`/api/view?runId=${encodeURIComponent(runId)}&kind=diff`);
    const diff = typeof value.diff === "string" ? value.diff : "";
    view.diffText = diff;
    view.diffState = diff ? "loaded" : "failed";
    if (!diff) view.diffError = "後端沒有回傳任何變更內容。 · The backend returned no change content.";
  } catch (error) {
    view.diffText = "";
    view.diffState = "failed";
    view.diffError = humanError(error);
  }
}

async function loadWriterApplyBackPreview() {
  const view = state.writerApplyBack;
  const status = byId("writer-apply-back-status");
  view.preview = null;
  view.phrase = "";
  view.diffText = "";
  view.diffError = "";
  view.diffState = "loading";
  view.scrolled = false;
  view.expiredRendered = false;
  renderWriterApplyBackApproval();
  status.textContent = "正在重新產生預覽並讀取變更內容（唯讀；主專案還沒有被修改）… · Preparing the preview and reading the change content (read-only)…";
  try {
    const prepared = await api("/api/rooms/writers/apply-back/prepare", {
      method: "POST",
      body: JSON.stringify({ room: state.room, taskId: view.taskId }),
    });
    view.preview = prepared.preview;
    view.phrase = typeof prepared.confirmationPhrase === "string" ? prepared.confirmationPhrase : "";
  } catch (error) {
    view.diffState = "failed";
    view.diffError = humanError(error);
    renderWriterApplyBackApproval();
    status.textContent = `無法產生預覽 · Preview failed：${humanError(error)}。主專案沒有變更。`;
    return;
  }
  await loadWriterApplyBackDiff();
  renderWriterApplyBackApproval();
  status.textContent = view.diffState === "loaded"
    ? "這是唯讀預覽；在你捲完內容、輸入短語並按下「回寫主專案」之前，主專案不會被修改。 · Read-only preview; nothing is written until you scroll, type the phrase and press the primary button."
    : `變更內容讀取失敗，因此無法核准：${view.diffError} · The change content failed to load, so this cannot be approved.`;
}

async function openWriterApplyBackApproval(taskId, preview, phrase, stageNote = "") {
  const dialog = ensureWriterApplyBackDialog();
  const view = state.writerApplyBack;
  view.returnFocus = document.activeElement;
  view.taskId = String(taskId || "");
  view.preview = preview || null;
  view.phrase = typeof phrase === "string" ? phrase : "";
  view.stageNote = stageNote || "";
  view.decided = false;
  view.applying = false;
  view.scrolled = false;
  view.expiredRendered = false;
  view.diffText = "";
  view.diffError = "";
  view.diffState = "loading";
  dialog.hidden = false;
  document.body.classList.add("workspace-modal-open");
  byId("writer-apply-back-status").textContent = stageNote
    ? `${stageNote} 變更仍在隔離 Writer worktree；主專案尚未被修改。`
    : "";
  if (!view.ticker) view.ticker = setInterval(tickWriterApplyBackTtl, 1000);
  renderWriterApplyBackApproval();
  /* 取消是預設焦點：最高風險動作不得預先對準破壞性按鈕。 */
  byId("writer-apply-back-cancel").focus();
  await loadWriterApplyBackDiff();
  renderWriterApplyBackApproval();
}

function closeWriterApplyBackApproval() {
  const dialog = byId("writer-apply-back");
  if (!dialog || dialog.hidden) return;
  const view = state.writerApplyBack;
  dialog.hidden = true;
  document.body.classList.remove("workspace-modal-open");
  if (view.ticker) clearInterval(view.ticker);
  view.ticker = null;
  view.preview = null;
  view.phrase = "";
  view.diffText = "";
  view.diffState = "idle";
  view.scrolled = false;
  view.blockers = [];
  byId("writer-apply-back-confirmation").value = "";
  byId("writer-apply-back-confirmation").disabled = true;
  byId("writer-apply-back-confirm").disabled = true;
  if (!view.decided) {
    byId("writer-live-status").textContent =
      `${view.stageNote ? `${view.stageNote} ` : ""}回寫核准已關閉；變更仍保留在 Writer 的草稿區（獨立副本），主專案沒有變更，可按「重新檢視回寫風險」再看一次。`;
  }
  view.returnFocus?.focus?.();
  view.returnFocus = null;
}

async function confirmWriterApplyBack() {
  const view = state.writerApplyBack;
  const status = byId("writer-apply-back-status");
  const input = byId("writer-apply-back-confirmation");
  if (!view.preview || view.blockers.length > 0 || !view.scrolled || view.decided) return;
  /* 送出去的就是 Owner 打的那一句，不是另外一個常數。 */
  if (!view.phrase || input.value !== view.phrase) return;
  const confirmation = input.value;
  const previewId = view.preview.id;
  view.applying = true;
  renderWriterApplyBackApproval();
  status.textContent = "階段 2／2：正在重新驗證 source、逐檔雜湊與風險快照…";
  byId("writer-live-status").textContent = "階段 2／2：正在重新驗證 source、逐檔雜湊與風險快照…";
  try {
    const value = await api("/api/rooms/writers/apply-back/apply", {
      method: "POST",
      body: JSON.stringify({ room: state.room, taskId: view.taskId, previewId, confirmation }),
    });
    view.applying = false;
    view.decided = true;
    renderWriterApplyBackApproval();
    const summary = `Owner 已核准回寫：${value.result.writes} 個寫入；${value.result.deletesMovedToTrash} 個刪除移至可復原區。`;
    status.textContent = `${summary} · Applied.`;
    byId("writer-live-status").textContent = summary;
  } catch (error) {
    /* 失敗後這份預覽已不可信：清掉它，強制重新產生預覽、重新捲、重新輸入短語。 */
    view.applying = false;
    view.preview = null;
    view.diffState = "idle";
    view.scrolled = false;
    renderWriterApplyBackApproval();
    status.textContent = `階段 2／2（回寫主專案）失敗：${humanError(error)}。可按「重新產生預覽」再試。`;
    byId("writer-live-status").textContent =
      `階段 2／2（回寫主專案）失敗：${humanError(error)}。可按「重新檢視回寫風險」重新產生預覽再試。`;
  }
  await refreshPresence(true);
  await poll();
}

async function delegateWriter() {
  const active = activeWriterLease();
  const childProvider = byId("writer-child-provider").value;
  const label = byId("writer-child-label").value.trim();
  const status = byId("writer-live-status");
  if (!active || !label) {
    status.textContent = "請先指派 Writer，並輸入子 Agent 名稱。";
    return;
  }
  try {
    const value = await api("/api/rooms/writers/delegate", {
      method: "POST",
      body: JSON.stringify({ room: state.room, taskId: active.taskId, childProvider, label }),
    });
    byId("writer-child-label").value = "";
    await refreshPresence(true);
    status.textContent = value.delegation.access === "write"
      ? `${value.delegation.displayName} 已取得同一草稿區的受控寫入權；系統會與 Writer／其他子 Agent 序列執行。`
      : `${value.delegation.displayName} 已加入，但因跨類型而保持唯讀。`;
  } catch (error) {
    status.textContent = `派駐失敗：${humanError(error)}`;
  }
}


/* What the Writer drawer needs fresh each time it opens: statuses cleared, a task id to work on. */
function prepareWriterDrawer() {
  byId("writer-live-status").textContent = "";
  state.writerCompleteConfirm = "";
  const taskInput = byId("writer-task-id");
  if (!taskInput.value.trim()) {
    /* 有進行中或待 apply-back 的 lease 時沿用它的 taskId，不要蓋掉待核准的任務。 */
    taskInput.value = pendingWriterLease()?.taskId || `task-${Date.now().toString(36)}`;
  }
  renderWriterControl();
}

function setWriterHandoff(open) {
  if (!open) {
    byId("writer-handoff").hidden = true;
    syncOfficeRail();
    return;
  }
  openOfficeDrawer("writer-handoff");
}

byId("writer-handover").addEventListener("click", () => {
  const active = activeWriterLease();
  byId("writer-live-status").textContent = active
    ? `交接：選好人選、填交接存檔點，再按「交接 Writer」；${active.writer.displayName} 的寫入權會在那一刻失效。`
    : "目前沒有 Writer 可交接。";
  byId("writer-candidate").focus();
});
/* 清空 only clears the proposal form; the drawer that hosts it stays where it is. */
byId("writer-handoff-cancel").addEventListener("click", () => {
  byId("writer-task").value = "";
  byId("writer-acceptance").value = "";
  byId("writer-handoff-status").textContent = "";
  byId("writer-handoff-form").hidden = false;
  byId("writer-handoff-result").hidden = true;
});
/* Opening the proposal fold carries the composer draft over, as the old panel did on open. */
byId("office-workflow-proposal").addEventListener("toggle", () => {
  const fold = byId("office-workflow-proposal");
  if (!fold.open) return;
  const task = byId("writer-task");
  const draft = byId("office-chat-input").value.replace(MENTION_DRAFT_PATTERN, "").trim();
  if (!task.value.trim() && draft) task.value = draft;
  renderWriterControl();
  task.focus();
});
byId("writer-assign").addEventListener("click", assignWriter);
byId("writer-complete").addEventListener("click", completeWriterLease);
byId("writer-delegate").addEventListener("click", delegateWriter);
byId("writer-run-cancel").addEventListener("click", cancelWriterRun);
byId("writer-task-id").addEventListener("input", renderWriterControl);
byId("writer-executor").addEventListener("change", renderWriterControl);
byId("writer-handoff-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const task = byId("writer-task").value.trim();
  const acceptanceCriteria = byId("writer-acceptance").value.trim();
  const submit = byId("writer-handoff-submit");
  const status = byId("writer-handoff-status");
  if (!task || !state.room) return;
  submit.disabled = true;
  const active = activeWriterLease();
  submit.textContent = active ? "Writer 執行中…" : "建立中…";
  status.textContent = active ? "正在喚醒精確 Writer 席位…" : "正在建立待人工確認的 workflow 提案…";
  try {
    const delegationId = active ? byId("writer-executor").value : "";
    const endpoint = !active
      ? "/api/rooms/workflow-request"
      : delegationId
        ? "/api/rooms/writers/delegations/run"
        : "/api/rooms/writers/run";
    const value = await api(endpoint, {
      method: "POST",
      body: JSON.stringify({
        room: state.room,
        ...(active ? { taskId: active.taskId, ...(delegationId ? { delegationId } : {}) } : {}),
        task,
        ...(acceptanceCriteria ? { acceptanceCriteria } : {}),
      }),
    });
    if (active) {
      status.textContent = `${value.reply?.author || active.writer.displayName} 已回覆；請檢查 checkpoint、diff 與風險後再完成或交接。`;
      await poll();
    } else {
      byId("writer-handoff-form").hidden = true;
      const result = byId("writer-handoff-result");
      result.hidden = false;
      result.querySelector("b").textContent = `提案 ${String(value.request?.id || "").slice(0, 8)} 已建立，尚未啟動`;
    }
  } catch (error) {
    status.textContent = `建立失敗：${humanError(error)}`;
  } finally {
    submit.disabled = false;
    renderWriterControl();
  }
});

byId("office-chat-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = byId("office-chat-input");
  const button = byId("office-chat-send");
  const text = input.value.trim();
  if (!text || !state.room || state.mode === "history") return;
  button.disabled = true;
  button.textContent = "送出中…";
  try {
    await submitRoomText(
      text,
      input.dataset.presenceId || "",
      input.dataset.managedAgentId || "",
    );
    input.value = "";
    delete input.dataset.target;
    delete input.dataset.presenceId;
    delete input.dataset.managedAgentId;
    document.querySelectorAll(".cubicle.is-selected, .desk.is-selected")
      .forEach((node) => node.classList.remove("is-selected"));
    byId("office-chat-hint").textContent = "點一個工位或席位晶片就能指名交辦；沒有指名的話，這則只會留在房間帳本裡，不會進任何人的收件匣";
    renderSeatChips();
    await poll();
  } catch (error) {
    if (error.message === "ROOM_MENTION_CANCELLED") {
      input.value = "";
      await poll();
    } else {
      const targetId = input.dataset.presenceId || "";
      showRoomError(error, {
        prefix: "送出失敗",
        session: (targetId && state.presences.find((entry) => entry.id === targetId)) ||
          joinedPresenceMention(text),
      });
    }
  } finally {
    button.disabled = false;
    button.textContent = "送出";
  }
});

/*
 * ── 合併進 main 的核准對話框 · merge-into-main approval dialog ─────────────
 * 沿用 .workspace-onboarding 元件（role="dialog" aria-modal、Esc 關閉、背景點擊關閉、焦點返回、
 * 輸入短語與捲完 diff 才解鎖最終按鈕），只多一個 variant。全程不得使用 window.alert／confirm／prompt：原生對話框
 * 可被瀏覽器永久靜音，而且在它開啟期間頁面凍結，TTL 倒數物理上不可能顯示。
 */

const MERGE_CONFIRMATION_PHRASE = "MERGE INTO MAIN";

/* @pure-start merge-approval-gate
 * DOM-free so regression tests execute the exact feedback and gate semantics the browser uses.
 */
function mergeApprovalGate(view) {
  const blockers = Array.isArray(view?.blockers) ? view.blockers : ["unavailable"];
  const scrolled = view?.scrolled === true;
  const decided = view?.decided === true;
  const expired = view?.expired === true;
  const phrase = typeof view?.phrase === "string" ? view.phrase : "";
  const typed = typeof view?.typed === "string" ? view.typed : "";
  const inputEnabled = !decided && !expired && phrase.length > 0;
  const ready = inputEnabled && blockers.length === 0 && scrolled;
  let hint;
  let feedback;
  let tone = "";
  let ariaInvalid = false;
  if (decided) {
    hint = "這筆核准已經有結果，不能再決定一次。";
    feedback = "輸入已鎖定：請從併入紀錄核對結果，不要把鎖定狀態當成新的成功。";
  } else if (expired) {
    hint = "這筆核准已逾時且不能復活；輸入已鎖定。草稿版端必須提出一筆新的 snapshot-bound 核准。";
    feedback = "輸入已鎖定並清空：重新產生預覽不會讓這筆逾時核准恢復，尚未送出、尚未 Merge。";
  } else if (phrase.length === 0) {
    hint = "後端沒有給確認短語，這筆併入不可核准。";
    feedback = "輸入已鎖定：缺少確認短語；沒有送出、沒有 Merge，main 未修改。";
  } else if (blockers.length > 0) {
    hint = "阻擋區還有項目：「核准併入 main」不可提交；按它只會帶你到阻擋項目，不會送出。輸入框仍可修改。";
    if (typed.length === 0) {
      feedback = `輸入框可用，但阻擋項目尚未排除；尚未送出、尚未 Merge。可先輸入 ${phrase}，仍須重新產生有效預覽。`;
    } else if (typed !== phrase) {
      feedback = `✗ 確認短語不正確，而且阻擋項目尚未排除；輸入框仍可修改，尚未送出、尚未 Merge，main 未修改。請完整輸入 ${phrase}。`;
      tone = "is-invalid";
      ariaInvalid = true;
    } else {
      feedback = "✓ 確認短語正確，但阻擋項目尚未排除；「核准併入 main」仍停用，尚未 Merge。";
      tone = "is-waiting";
    }
  } else if (!scrolled) {
    hint = "輸入框現在可用；仍須在上方深色『變更檔案』方框內捲到底（不是外層視窗）才能提交。現在按「核准併入 main」只會帶你到內層清單，不會送出。";
    if (typed.length === 0) {
      feedback = `尚未 Merge。你可以先輸入 ${phrase}；最終按鈕會等到內層變更清單捲到底才解鎖。`;
    } else if (typed !== phrase) {
      feedback = `✗ 確認短語不正確；輸入框仍可修改。另請在上方深色變更清單方框內捲到底；尚未送出、尚未 Merge，main 未修改。請完整輸入 ${phrase}。`;
      tone = "is-invalid";
      ariaInvalid = true;
    } else {
      feedback = "✓ 確認短語正確，但還沒捲完內層變更清單（不是捲外層視窗）；尚未 Merge。可按「核准併入 main」讓畫面帶你回未讀處，該次不會送出。";
      tone = "is-waiting";
    }
  } else if (typed.length === 0) {
    hint = `變更清單已捲到底：輸入 ${phrase} 即可解鎖「核准併入 main」。`;
    feedback = `尚未輸入確認短語；尚未送出、尚未 Merge。請完整輸入 ${phrase}。`;
  } else if (typed !== phrase) {
    hint = `變更清單已捲到底：輸入 ${phrase} 即可解鎖「核准併入 main」。`;
    feedback = `✗ 確認短語不正確；尚未送出、尚未 Merge，main 沒有被修改。請完整輸入 ${phrase}（區分大小寫，不接受多餘空白）。`;
    tone = "is-invalid";
    ariaInvalid = true;
  } else {
    hint = `變更清單已捲到底：輸入 ${phrase} 即可解鎖「核准併入 main」。`;
    feedback = "✓ 確認短語正確；目前仍尚未 Merge。按下「核准併入 main」才會送出。";
    tone = "is-valid";
  }
  return {
    ready,
    inputDisabled: !inputEnabled,
    inputValue: inputEnabled ? typed : "",
    confirmDisabled: !ready || typed !== phrase,
    hint,
    feedback,
    tone,
    ariaInvalid,
  };
}

function mergeApprovalInputScope(currentApprovalId, loadedApprovalId, typed) {
  const current = typeof currentApprovalId === "string" ? currentApprovalId : "";
  const loaded = typeof loadedApprovalId === "string" ? loadedApprovalId : "";
  return {
    approvalId: loaded,
    value: loaded.length > 0 && current === loaded && typeof typed === "string" ? typed : "",
  };
}

function mergeApprovalIntentTarget(view) {
  const phrase = typeof view?.phrase === "string" ? view.phrase : "";
  const typed = typeof view?.typed === "string" ? view.typed : "";
  if (!view || view.decided === true || view.expired === true || phrase.length === 0) return "unavailable";
  if (Array.isArray(view.blockers) && view.blockers.length > 0) return "blockers";
  if (typed !== phrase) return "input";
  if (view.scrolled !== true) return "diff";
  return "submit";
}

function mergeApprovalFailureStatus(approvalFailure, refreshFailure = "") {
  const primary = typeof approvalFailure === "string" && approvalFailure.length > 0
    ? approvalFailure
    : "unavailable";
  const refresh = typeof refreshFailure === "string" ? refreshFailure : "";
  return refresh.length > 0
    ? `核准失敗：${primary}；live state 重新讀取也失敗：${refresh}。這不是 Merge 成功，請稍後從併入紀錄核對。`
    : `核准失敗：${primary}。這不是 Merge 成功；若畫面顯示「建立新的預覽與核准」，可安全建立一筆全新的 snapshot-bound 核准再試。`;
}

function mergeApprovalRetryEligible(approval) {
  return Boolean(approval) && ["rejected", "invalidated", "expired"].includes(approval.state);
}
/* @pure-end merge-approval-gate */

const MERGE_OPERATION_LABELS = {
  add: "新增",
  modify: "修改",
  delete: "刪除",
  rename: "改名",
  copy: "複製",
  "type-change": "類型變更",
  unmerged: "未合併",
  unknown: "未知",
};
const MERGE_TEST_LABELS = {
  passed: "通過",
  failed: "失敗",
  "not-run": "未執行",
};

/* @pure-start merge-approval-pending */
function mergeApprovalPending(approval) {
  return Boolean(approval) && approval.state === "requested" && approval.expired !== true;
}
/* @pure-end merge-approval-pending */

/* @pure-start merge-task-summary */
function mergeTaskSummary(approvals) {
  const pending = (Array.isArray(approvals) ? approvals : []).filter(mergeApprovalPending);
  return { pending, count: pending.length, visible: pending.length > 0 };
}
/* @pure-end merge-task-summary */

function mergeConfirmationPhrase() {
  return state.mergeConfirmationPhrase || MERGE_CONFIRMATION_PHRASE;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function shortSha(value) {
  return typeof value === "string" && value.length > 12 ? value.slice(0, 12) : String(value || "—");
}

function renderMergeApprovalBadge() {
  const button = byId("merge-approvals-open");
  const badge = byId("merge-approval-count");
  if (!button || !badge) return;
  const summary = mergeTaskSummary(state.mergeApprovals);
  const activeTask = byId("merge-active-task");
  badge.textContent = String(summary.count);
  badge.hidden = false;
  badge.setAttribute("aria-label", `${summary.count} 件待核准`);
  button.disabled = !summary.visible;
  if (activeTask) activeTask.hidden = !summary.visible;
  const label = button.querySelector("span");
  if (label) label.textContent = "⑂";
  button.title = `${summary.count} 件草稿版待核准併入 main`;
  button.setAttribute("aria-label", button.title);
}

async function refreshMergeApprovals() {
  if (!state.room) {
    state.mergeApprovals = [];
    renderMergeApprovalBadge();
    return [];
  }
  try {
    const value = await api(`/api/rooms/merge-approvals?room=${encodeURIComponent(state.room)}`);
    const approvals = Array.isArray(value.approvals) ? value.approvals : [];
    const known = new Set((state.mergeApprovals || []).map((approval) => approval.id));
    /* 剛切換房間時整批都是「新的」，那不是新事件，不該灌通知。 */
    const sameRoom = state.mergeApprovalsRoom === state.room;
    const initialized = state.controlInitialized && sameRoom;
    state.mergeApprovalsRoom = state.room;
    state.mergeApprovals = approvals;
    if (typeof value.confirmationPhrase === "string") state.mergeConfirmationPhrase = value.confirmationPhrase;
    if (Array.isArray(value.notAuthorized)) state.mergeNotAuthorized = value.notAuthorized;
    for (const approval of approvals.filter(mergeApprovalPending)) {
      if (initialized && !known.has(approval.id)) {
        addOfficeNotification(
          "proposal",
          "有草稿版要求核准併入 main",
          `${approval.taskId} · 需要 Owner 逐項檢視後核准；核准前 main 不會被修改。`,
          true,
          { kind: "merge-approval", approvalId: approval.id },
        );
      }
    }
    renderMergeApprovalBadge();
    return approvals;
  } catch {
    /* 待核准計數失敗不得影響帳本輪詢；徽章維持上一次已知值。 */
    return state.mergeApprovals || [];
  }
}

/* @pure-start merge-history-buckets
 * Durable records are untrusted input.  The green count is intentionally narrow: if any positive
 * fact is missing, the row belongs to review rather than being rounded up to success.
 */
function mergeHistorySucceeded(entry) {
  return entry?.state === "applied" && entry?.observation?.authorizedMergeCommit === true
    && typeof entry?.mainHeadAfter === "string" && entry.mainHeadAfter.trim().length > 0;
}

/*
 * Why a closed record is split again by whether it can be re-asked.
 *
 * A closed approval and a finished piece of work are different facts. An approval can lapse while
 * its task goes into main on a later approval, and then re-asking is not just refused, it is
 * meaningless -- the thing is already there. Grouping on state alone put both kinds under one
 * heading with the same button, and the button was right to refuse every time.
 *
 * `retry` comes from the server, which can see the task. When it is absent -- an older response,
 * or a record fetched by a path that does not compute it -- the row goes to `blockedApprovals`
 * with no reason rather than to `retryableApprovals`: an unknown is not a yes.
 */
function mergeRetryReason(approval) {
  const blocked = approval?.retry?.blockedBy;
  if (blocked === "ALREADY_MERGED") {
    return "這份工作已經進入 main 了（由另一次核准完成），所以不需要、也不能再併入一次。";
  }
  if (blocked === "NOT_COMPLETED") {
    return "草稿版還沒回報完成，要先完成才談得上併入。";
  }
  if (blocked === "APPROVAL_PENDING") {
    return "這個草稿版已經有一筆還沒回答的核准請求；同一份工作一次只問一個問題。先回答那一筆。";
  }
  if (blocked === "TASK_NOT_FOUND") {
    return "找不到對應的草稿版任務紀錄，無法重新產生預覽。核准本身仍保留為紀錄。";
  }
  if (blocked === "NOT_A_CLOSED_APPROVAL") {
    return "這筆核准還沒結案，不需要重新發起。";
  }
  return "這筆紀錄沒有附帶可否重新發起的判定，因此不提供按鈕。";
}

/*
 * Expiry is a knowable reason, not a missing one. Nobody refuses an approval by letting it lapse,
 * so `refusal` is empty and the field used to read "unavailable" -- which says the system lost the
 * reason, when in fact there is nothing to lose. The two windows are told apart by their length:
 * the question gets fifteen minutes, a granted authorization five.
 */
function mergeApprovalClosedReason(approval) {
  const stated = approval?.refusal?.reason || approval?.refusal?.code;
  if (stated) return String(stated);
  if (approval?.state !== "expired") return "";
  const opened = Date.parse(approval?.createdAt ?? "");
  const closed = Date.parse(approval?.expiresAt ?? "");
  const minutes = Number.isFinite(opened) && Number.isFinite(closed)
    ? Math.round((closed - opened) / 60000)
    : undefined;
  if (approval?.decidedBy) {
    return `已核准，但授權窗口${minutes ? ` ${minutes} 分鐘` : ""}內沒有完成併入，授權作廢。`;
  }
  return `送出後${minutes ? ` ${minutes} 分鐘` : ""}內沒有人核准，問題窗口關閉。沒有人拒絕它。`;
}

function mergeHistoryBuckets(promotions, unpromotedApprovals) {
  const mergedPromotions = [];
  const reviewPromotions = [];
  const notStartedApprovals = [];
  const retryableApprovals = [];
  const blockedApprovals = [];
  const reviewApprovals = [];
  for (const promotion of Array.isArray(promotions) ? promotions : []) {
    (mergeHistorySucceeded(promotion) ? mergedPromotions : reviewPromotions).push(promotion);
  }
  for (const approval of Array.isArray(unpromotedApprovals) ? unpromotedApprovals : []) {
    if (["rejected", "expired", "invalidated"].includes(approval?.state)) {
      notStartedApprovals.push(approval);
      (approval?.retry?.eligible === true ? retryableApprovals : blockedApprovals).push(approval);
    } else {
      /* approved/consumed/malformed without a promotion row is not a closed non-event. */
      reviewApprovals.push(approval);
    }
  }
  return {
    mergedPromotions,
    reviewPromotions,
    notStartedApprovals,
    retryableApprovals,
    blockedApprovals,
    reviewApprovals,
    otherCount: reviewPromotions.length + reviewApprovals.length + notStartedApprovals.length,
  };
}
/* @pure-end merge-history-buckets */

/* @pure-start merge-history-unattested
 * Records the daemon says are still holding this project, because it cannot vouch for them.
 *
 * BOTH conditions, and the reason is the one that took two attempts to get right.  This control
 * decides a record is not in flight from its `state` column — and on a row whose integrity check
 * failed, that column is one of the bytes nobody can trust.  So a corrupt row is not offered this
 * button even though it is holding the project: its exit is the dedicated unreadable release, which
 * probes the processes the record names and escalates the phrase when any of them might be alive.
 * Offering the project-wide phrase instead would drop that protection rather than reuse it.
 *
 * `holdsProjectExclusiveMarker` is the SAME condition the main-write gates apply, re-derived by the
 * daemon on every read, so the button appears exactly when a promotion would be refused for a reason
 * this button can actually address.
 */
function mergeHistoryUnattested(promotions) {
  return (Array.isArray(promotions) ? promotions : []).filter(
    (entry) => entry?.state === "unreadable"
      && entry?.holdsProjectExclusiveMarker === true
      && entry?.unreadableReason === "promotion-attestation",
  );
}
/* @pure-end merge-history-unattested */

/* @pure-start merge-records-attention */
function mergeRecordsAttention(buckets) {
  return Boolean(buckets)
    && ((buckets.reviewPromotions?.length || 0) + (buckets.reviewApprovals?.length || 0)) > 0;
}
/* @pure-end merge-records-attention */

function renderMergeHistoryBadge() {
  const recordsButton = byId("merge-history-open");
  const attention = byId("merge-records-attention");
  if (!recordsButton || !attention) return;
  if (!state.mergeHistoryLoaded) {
    attention.hidden = true;
    recordsButton.setAttribute("aria-label", "開啟併入紀錄；紀錄數量尚未讀取");
    recordsButton.disabled = false;
    return;
  }
  const requiresReview = mergeRecordsAttention(
    mergeHistoryBuckets(state.mergeHistory, state.mergeUnpromotedApprovals),
  );
  attention.hidden = !requiresReview;
  recordsButton.setAttribute(
    "aria-label",
    requiresReview
      ? "開啟併入紀錄；有需要人工檢查的結果，不是已完成任務"
      : "開啟併入紀錄；durable audit records，不是待辦",
  );
  recordsButton.disabled = false;
}

function historyFact(list, label, value) {
  const term = document.createElement("dt");
  term.textContent = label;
  const detail = document.createElement("dd");
  detail.textContent = value === undefined || value === null ? "未讀到" : String(value);
  list.append(term, detail);
}

function mergeHistoryEmpty(host, text) {
  const empty = document.createElement("p");
  empty.className = "merge-history-note";
  empty.textContent = text;
  host.append(empty);
}

function renderPromotionHistoryEntry(host, entry) {
  const item = document.createElement("article");
  item.className = "merge-history-entry";
  const header = document.createElement("header");
  const title = document.createElement("strong");
  const succeeded = mergeHistorySucceeded(entry);
  title.textContent = succeeded
    ? "併入成功"
    : entry?.state === "applied"
      ? "併入驗證不完整"
      : entry?.state === "applying"
        ? "Promotion 結果尚未收斂"
        : entry?.state === "needs-manual-review"
          ? "必須人工核對"
          : entry?.state === "rolled-back"
            ? "Promotion 已回復，仍需核對"
            : "紀錄不完整，必須核對";
  const stateTag = document.createElement("span");
  stateTag.className = `merge-history-state is-${String(entry?.state || "unknown")}`;
  stateTag.textContent = String(entry?.state || "unknown");
  header.append(title, stateTag);
  const facts = document.createElement("dl");
  historyFact(facts, "時間", entry?.updatedAt);
  historyFact(facts, "Task", entry?.taskId);
  historyFact(facts, "Promotion", entry?.id);
  historyFact(facts, "Approval", entry?.approvalId);
  historyFact(facts, "main HEAD before", entry?.mainHeadBefore);
  historyFact(facts, "main HEAD after", entry?.mainHeadAfter);
  historyFact(facts, "Candidate HEAD", entry?.candidateHead);
  historyFact(facts, "Recovery ref", entry?.recoveryRef);
  historyFact(facts, "Observation", entry?.observation?.code);
  /* The two commits are already on screen; what was missing was the one line that turns them into
     an answer. Only offered when both ends were observed -- half a range inspects nothing. */
  if (typeof entry?.mainPath === "string" && typeof entry?.mainHeadBefore === "string"
    && typeof entry?.mainHeadAfter === "string") {
    historyCopyable(
      facts,
      "檢視這次併入",
      `git -C ${entry.mainPath} log --oneline ${entry.mainHeadBefore}..${entry.mainHeadAfter}`,
      "已複製指令",
    );
  }
  const hooks = entry?.observation?.hooksExecuted;
  historyFact(facts, "Hooks", Array.isArray(hooks)
    ? (hooks.length ? hooks.map((hook) => `${hook.name}(exit ${hook.exitCode ?? "?"})`).join("、") : "none observed")
    : "未讀到");
  item.append(header, facts);
  if (!succeeded) {
    const action = document.createElement("p");
    action.className = "merge-history-action";
    action.textContent = "不要再次 apply。先重新讀取 observation；若仍停在此區，依還原點 ref 人工核對 main。";
    item.append(action);
  }
  renderPromotionWaitRelease(item, entry);
  host.append(item);
}

/*
 * A fact nobody can act on is decoration. The worktree path and the inspection command are the two
 * things an owner actually wants from this archive -- "what did that merge change" and "where is
 * the work" -- and both used to require copying a UUID out of the dialog and assembling a path by
 * hand. The value stays visible and selectable; the button only saves the typing.
 */
function historyCopyable(list, label, value, copiedNote) {
  if (typeof value !== "string" || value.trim().length === 0) return;
  const term = document.createElement("dt");
  term.textContent = label;
  const detail = document.createElement("dd");
  detail.className = "merge-history-copyable";
  const shown = document.createElement("code");
  shown.textContent = value;
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "merge-history-copy";
  copy.textContent = "⧉ 複製";
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(value);
      copy.textContent = copiedNote || "已複製";
    } catch {
      copy.textContent = "無法自動複製，請手動選取";
    }
  });
  detail.append(shown, copy);
  list.append(term, detail);
}

/* @pure-start merge-wait-release
 * What a record says it is waiting on, and what ending that wait requires right now.
 *
 * Returns null unless the daemon reported BOTH a phrase and, where the record names one, the number
 * it names — the same two pieces of evidence the terminal has always demanded.  A record that names
 * no way out gets no control, because inventing one here would mean guessing at a pid.
 */
function mergeWaitRelease(entry) {
  const pending = entry && typeof entry === "object" ? entry.pending : null;
  if (!pending || typeof pending !== "object") return null;
  if (typeof pending.release !== "string" || !pending.release) return null;
  const both = pending.code === "PROMOTION_OWNER_AND_MERGE_STILL_RUNNING";
  const owner = pending.code === "OWNER_PROCESS_STILL_RUNNING";
  const pid = typeof pending.pid === "number" ? pending.pid : null;
  const also = pending.alsoBlockedBy && typeof pending.alsoBlockedBy === "object"
    ? pending.alsoBlockedBy.pid : null;
  if (both) {
    if (typeof pid !== "number" || typeof also !== "number") return null;
    return { confirmation: pending.release, pid, pgid: also, code: pending.code };
  }
  if (owner) {
    if (typeof pid !== "number") return null;
    return { confirmation: pending.release, pid, code: pending.code };
  }
  // Everything else is about the merge's own group. `MERGE_IDENTITY_UNACCOUNTED` is the one state
  // with no number to quote — the phrase carries it — so a missing pid is allowed only there.
  if (typeof pid === "number") return { confirmation: pending.release, pgid: pid, code: pending.code };
  return pending.code === "MERGE_IDENTITY_UNACCOUNTED"
    ? { confirmation: pending.release, code: pending.code }
    : null;
}
/* @pure-end merge-wait-release */

/*
 * The owner ending one wait, told to the daemon rather than to a terminal that is about to exit.
 *
 * These declarations were reachable only from the CLI, which was survivable while the daemon could
 * read one back out of the promotion row.  It no longer may — those bytes are writable by the
 * merge's own hooks — so without this control a merge that ran a hook stays unaccounted for with
 * nothing the owner can do from here.
 */
function renderPromotionWaitRelease(item, entry) {
  const release = mergeWaitRelease(entry);
  if (!release) return;
  const box = document.createElement("section");
  box.className = "merge-history-action";
  const what = document.createElement("p");
  what.textContent = `這筆紀錄正在等：${release.code}`
    + `${typeof release.pid === "number" ? ` · 發起程序 pid ${release.pid}` : ""}`
    + `${typeof release.pgid === "number" ? ` · 併入程序群組 ${release.pgid}` : ""}`;
  const warn = document.createElement("p");
  warn.textContent = "釋放這筆等待不會終止任何程序、不會寫入 main、不會修復紀錄，也不代表產品判斷併入已"
    + "結束。它只表示你已自行查看過這些編號。確認語逐字如下，按下即等於你說出這句話：";
  const phrase = document.createElement("code");
  phrase.textContent = release.confirmation;
  const act = document.createElement("button");
  act.type = "button";
  act.className = "merge-history-release";
  act.textContent = "釋放這筆等待";
  act.addEventListener("click", async () => {
    act.disabled = true;
    try {
      await api("/api/rooms/merge-promotions/release", {
        method: "POST",
        body: JSON.stringify({
          room: state.room,
          promotionId: entry.id,
          ...(typeof release.pid === "number" ? { pid: release.pid } : {}),
          ...(typeof release.pgid === "number" ? { pgid: release.pgid } : {}),
          confirmation: release.confirmation,
        }),
      });
      await refreshMergeHistory();
    } catch (error) {
      act.disabled = false;
      const failed = document.createElement("p");
      failed.textContent = `未送出：${error && error.message ? error.message : "unknown"}`;
      box.append(failed);
    }
  });
  box.append(what, warn, phrase, act);
  item.append(box);
}

function renderApprovalHistoryEntry(host, approval, reviewRequired = false) {
  const item = document.createElement("article");
  item.className = "merge-history-entry";
  const header = document.createElement("header");
  const title = document.createElement("strong");
  title.textContent = reviewRequired
    ? "核准與 promotion 關聯不完整"
    : "未進入併入";
  const stateTag = document.createElement("span");
  stateTag.className = reviewRequired ? "merge-history-state" : "merge-history-state is-closed";
  stateTag.textContent = String(approval?.state || "unavailable");
  header.append(title, stateTag);
  const facts = document.createElement("dl");
  historyFact(facts, "時間", approval?.updatedAt);
  historyFact(facts, "Task", approval?.taskId);
  historyFact(facts, "Approval", approval?.id);
  historyFact(facts, "Candidate HEAD", approval?.candidateHead || approval?.binding?.candidateHead);
  historyFact(facts, "main HEAD bound", approval?.mainHead || approval?.binding?.mainHead);
  historyFact(facts, "Recovery ref", approval?.binding?.recoveryRef);
  historyFact(facts, "原因", mergeApprovalClosedReason(approval));
  historyCopyable(facts, "草稿區路徑", approval?.binding?.candidatePath);
  item.append(header, facts);
  if (reviewRequired) {
    const action = document.createElement("p");
    action.className = "merge-history-action";
    action.textContent = "不要再次核准或 apply；重新讀取後仍存在時，依 approval 與還原點 ref 人工核對。";
    item.append(action);
  } else if (approval?.retry?.eligible === true) {
    const action = document.createElement("p");
    action.className = "merge-history-action";
    const pick = document.createElement("label");
    pick.className = "merge-history-pick";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "merge-history-select";
    box.dataset.approvalId = String(approval?.id || "");
    box.dataset.taskId = String(approval?.binding?.taskId || approval?.taskId || "");
    box.addEventListener("change", updateMergeRetrySelection);
    pick.append(box, document.createTextNode("選取這筆一起重新發起"));
    action.append(pick, document.createTextNode(
      "草稿版還在等併入；重新發起會依 live main 重算預覽。舊核准仍永久保留為終局紀錄。"));
    const retry = document.createElement("button");
    retry.type = "button";
    retry.textContent = "↻ 建立新的預覽與核准";
    retry.addEventListener("click", () => {
      closeMergeHistory();
      openMergeApprovalDialog(approval.id);
    });
    action.append(retry);
    item.append(action);
  } else {
    /* No button. The reason is the whole content of this row: an owner who can read why does not
       need to press anything to find out, and pressing was the only way to find out before. */
    const action = document.createElement("p");
    action.className = "merge-history-action is-blocked";
    action.textContent = mergeRetryReason(approval);
    item.append(action);
  }
  host.append(item);
}

/*
 * The batch exists because the archive is a list and the owner's problem was a list: twelve rows,
 * each needing the same decision. What it must never become is a way to ask twelve questions at
 * once -- the registry allows exactly one unanswered request per candidate, so a second row for the
 * same task would be refused after the first succeeded, and the owner would read that refusal as a
 * failure of the batch rather than as the rule working. Same-task duplicates are skipped here and
 * named in the summary, so what happened stays legible.
 */
function mergeRetrySelection() {
  return [...document.querySelectorAll(".merge-history-select:checked")]
    .map((box) => ({ approvalId: box.dataset.approvalId, taskId: box.dataset.taskId }))
    .filter((pick) => typeof pick.approvalId === "string" && pick.approvalId.length > 0);
}

function updateMergeRetrySelection() {
  const button = byId("merge-history-retry-selected");
  const all = byId("merge-history-select-all");
  if (!button) return;
  const boxes = [...document.querySelectorAll(".merge-history-select")];
  const picked = mergeRetrySelection();
  button.disabled = picked.length === 0 || state.mergeRetryBatchRunning === true;
  button.textContent = picked.length === 0
    ? "↻ 重新發起選取的核准"
    : `↻ 重新發起選取的 ${picked.length} 筆`;
  if (all) {
    all.checked = boxes.length > 0 && picked.length === boxes.length;
    all.indeterminate = picked.length > 0 && picked.length < boxes.length;
    all.disabled = boxes.length === 0;
  }
}

async function retrySelectedMergeApprovals() {
  const status = byId("merge-history-status");
  const picked = mergeRetrySelection();
  if (picked.length === 0 || state.mergeRetryBatchRunning === true) return;
  state.mergeRetryBatchRunning = true;
  updateMergeRetrySelection();
  const seenTask = new Set();
  const created = [];
  const skipped = [];
  const failed = [];
  for (const pick of picked) {
    if (pick.taskId && seenTask.has(pick.taskId)) {
      skipped.push(pick.approvalId);
      continue;
    }
    status.textContent = `正在重新發起 ${created.length + failed.length + 1}/${picked.length}；不會自動併入…`;
    try {
      /* Sequential on purpose: each request re-previews against live main, and two of them racing
         would have one of them reading a tree the other is about to invalidate. */
      const value = await api("/api/rooms/merge-approvals/retry", {
        method: "POST",
        body: JSON.stringify({ room: state.room, approvalId: pick.approvalId }),
      });
      if (pick.taskId) seenTask.add(pick.taskId);
      created.push(value?.approval?.id || pick.approvalId);
    } catch (error) {
      failed.push(`${String(pick.approvalId).slice(0, 8)}：${error?.message || "unknown"}`);
    }
  }
  state.mergeRetryBatchRunning = false;
  const parts = [`已建立 ${created.length} 筆新的核准請求`];
  if (skipped.length > 0) parts.push(`跳過 ${skipped.length} 筆（同一個草稿版已經有一筆在這批裡）`);
  if (failed.length > 0) parts.push(`失敗 ${failed.length} 筆：${failed.join("；")}`);
  parts.push("main 未因這次操作而改變。");
  status.textContent = parts.join("；");
  await refreshMergeHistory();
}

function renderMergeHistory() {
  const mergedHost = byId("merge-history-merged-list");
  const reviewHost = byId("merge-history-review-list");
  const unpromotedHost = byId("merge-history-unpromoted-list");
  const blockedHost = byId("merge-history-blocked-list");
  if (!mergedHost || !reviewHost || !unpromotedHost || !blockedHost) return;
  mergedHost.textContent = "";
  reviewHost.textContent = "";
  unpromotedHost.textContent = "";
  blockedHost.textContent = "";
  const buckets = mergeHistoryBuckets(state.mergeHistory, state.mergeUnpromotedApprovals);
  byId("merge-history-merged-total").textContent = String(buckets.mergedPromotions.length);
  const reviewCount = buckets.reviewPromotions.length + buckets.reviewApprovals.length;
  byId("merge-history-review-total").textContent = String(reviewCount);
  byId("merge-history-unpromoted-total").textContent = String(buckets.retryableApprovals.length);
  byId("merge-history-blocked-total").textContent = String(buckets.blockedApprovals.length);
  for (const entry of buckets.mergedPromotions) renderPromotionHistoryEntry(mergedHost, entry);
  for (const entry of buckets.reviewPromotions) renderPromotionHistoryEntry(reviewHost, entry);
  for (const approval of buckets.reviewApprovals) renderApprovalHistoryEntry(reviewHost, approval, true);
  for (const approval of buckets.retryableApprovals) renderApprovalHistoryEntry(unpromotedHost, approval);
  for (const approval of buckets.blockedApprovals) renderApprovalHistoryEntry(blockedHost, approval);
  updateMergeRetrySelection();
  if (!buckets.mergedPromotions.length) {
    mergeHistoryEmpty(mergedHost, "尚無已驗證的併入。");
  }
  if (!reviewCount) {
    mergeHistoryEmpty(reviewHost, "目前沒有需人工檢查的 promotion 或核准。");
  }
  renderUnattestedAcknowledgement(reviewHost, mergeHistoryUnattested(state.mergeHistory));
  if (!buckets.notStartedApprovals.length) {
    mergeHistoryEmpty(unpromotedHost, "目前沒有已結案但未開始併入的核准。");
  }
}

/*
 * The owner's way of telling THIS daemon that they checked the project themselves.
 *
 * It is rendered here, and only here, because this is the one screen that lists the records it is
 * about.  The wording is deliberately about what the owner is doing rather than about what the
 * product found: the product cannot tell a promotion it finished from one a repository hook wrote,
 * and a button that implied otherwise would be the same measured falsehood this whole round removed.
 */
function renderUnattestedAcknowledgement(host, unattested) {
  if (!host || !unattested.length) return;
  const box = document.createElement("section");
  box.className = "merge-history-action";
  const explain = document.createElement("p");
  explain.textContent = `這個服務重新啟動過，因此 ${unattested.length} 筆紀錄它無法親自證實——`
    + "紀錄本身、trace 與稽核檔都是同帳號可改寫的位元。在你確認已檢查之前，這個專案不會開始新的併入。";
  const warn = document.createElement("p");
  warn.textContent = "按下這個按鈕不會修復任何紀錄、不會寫入 main、不會結束任何仍在執行的程序，"
    + "也不代表產品驗證過什麼。它只記錄「你看過了」，而且只對目前這個服務有效，重新啟動後會再問一次。";
  const confirm = document.createElement("button");
  confirm.type = "button";
  confirm.className = "merge-history-acknowledge";
  confirm.textContent = "確認已檢查：我已自行檢查這個專案，沒有更早的併入還在執行";
  confirm.addEventListener("click", async () => {
    confirm.disabled = true;
    try {
      await api("/api/rooms/merge-promotions/acknowledge", {
        method: "POST",
        body: JSON.stringify({
          room: state.room,
          confirmation: "I HAVE CHECKED THIS PROJECT MYSELF AND NO EARLIER PROMOTION IS STILL RUNNING",
        }),
      });
      await refreshMergeHistory();
    } catch (error) {
      // Failure is named where the owner is looking, and the button comes back: a disabled control
      // with no message is indistinguishable from having worked.
      confirm.disabled = false;
      const failed = document.createElement("p");
      failed.textContent = `未送出：${error && error.message ? error.message : "unknown"}`;
      box.append(failed);
    }
  });
  box.append(explain, warn, confirm);
  host.append(box);
}

async function refreshMergeHistory() {
  if (!state.room) {
    state.mergeHistory = [];
    state.mergeUnpromotedApprovals = [];
    state.mergeHistoryLoaded = false;
    state.mergeHistoryRoom = "";
    renderMergeHistoryBadge();
    renderMergeHistory();
    return [];
  }
  state.mergeHistoryLoaded = false;
  renderMergeHistoryBadge();
  const value = await api(`/api/rooms/merge-history?room=${encodeURIComponent(state.room)}`);
  state.mergeHistory = Array.isArray(value.promotions) ? value.promotions : [];
  state.mergeUnpromotedApprovals = Array.isArray(value.unpromotedApprovals)
    ? value.unpromotedApprovals : [];
  state.mergeHistoryLoaded = true;
  state.mergeHistoryRoom = state.room;
  renderMergeHistoryBadge();
  renderMergeHistory();
  byId("merge-history-status").textContent = value.chainValid === true
    ? "Audit chain valid；promotion 紀錄已重新從 durable store 讀取。"
    : "Audit chain 無法驗證；promotion 紀錄仍顯示，但不可把缺少的 audit 當成成功證據。";
  return state.mergeHistory;
}

function mergeApprovalBlockers(approval, binding, overwrites) {
  const blockers = [];
  if (!approval) return blockers;
  const preview = approval.preview || {};
  // 促進閘門的三件事，在畫面上各自是一個阻擋條件而不是一句提醒。
  // 「沒讀到」與「讀到而為空」不折疊：前者是阻擋，後者不是（PITFALLS #85）。
  const hooks = preview.promotion?.hooks;
  if (!hooks) {
    blockers.push("這份快照產生於 hook 與設定綁定存在之前，畫面無法列出這次會執行什麼；不可核准。");
  } else if (hooks.unreadable === true) {
    blockers.push("main 的 hook 目錄讀不到，因此不知道這次併入會執行哪些程式。");
  }
  if (!overwrites) {
    blockers.push("沒有拿到「會覆蓋哪些檔案」的掃描結果，看不到就不可核准。");
  } else if (overwrites.checked !== true) {
    blockers.push(`覆蓋掃描沒有執行（${overwrites.unavailable || "OVERWRITE_SCAN_UNAVAILABLE"}）；這不等於沒有檔案會被覆蓋。`);
  } else {
    for (const path of overwrites.ignored || []) {
      blockers.push(`併入會靜默覆蓋 main 上這個 ignored 檔案：${path}`);
    }
    for (const path of overwrites.untracked || []) {
      blockers.push(`併入會覆蓋 main 上這個未追蹤檔案：${path}`);
    }
  }
  if (approval.state !== "requested") {
    blockers.push(`這筆核准已是終局狀態「${approval.state}」，不能再核准。`);
  } else if (approval.expired) {
    blockers.push("核准視窗已逾時，必須重新產生預覽再問一次。");
  }
  // Three outcomes, not two. "The bindings moved" and "the check could not run" are different facts,
  // and reporting the second as the first would tell the owner a snapshot changed when nothing did.
  if (binding && binding.unavailable) {
    blockers.push(`無法比對綁定值（${binding.unavailable}），因此不能確認這份核准仍描述你正在看的東西。`);
  } else if (binding && binding.valid === false) {
    const changed = (binding.changed || []).map(bindingFieldLabel);
    // A named field is better, but "not valid with nothing named" must never go quiet:
    // the server reports exactly that for an approval it already considers expired, and
    // a browser clock that has not ticked yet still shows state "requested". Requiring a
    // named field to raise a blocker left that combination with no blocker at all, and an
    // enabled merge button, on the last screen before main is written.
    blockers.push(
      changed.length > 0
        ? `綁定值已改變，這份核准只適用於它綁定的 snapshot：${changed.join("、")}`
        : "伺服器判定這份核准的綁定不再有效，但沒有指出是哪一個欄位；在查清楚之前不能核准。",
    );
  }
  if (preview.mergeable === false) {
    blockers.push(`模擬 merge 有內容衝突，共 ${(preview.mergeConflicts || []).length} 個檔案。`);
  }
  for (const path of preview.mergeConflicts || []) {
    blockers.push(`衝突檔案：${path}`);
  }
  if (preview.mergeConflictsTruncated) {
    blockers.push("衝突清單已截斷，看不到全部衝突就不可核准。");
  }
  if (preview.filesTruncated) {
    blockers.push("檔案清單已截斷，Owner 不得對看不到的內容簽名。");
  }
  if (preview.submodulesTruncated) {
    blockers.push("Submodule 清單已截斷，看不到全部指標變更就不可核准。");
  }
  if (preview.largeFileScanTruncated) {
    blockers.push("大型檔案掃描已截斷，可能還有未列出的大檔。");
  }
  return blockers;
}

function mergeRiskLevel(approval, blockers) {
  const preview = approval?.preview || {};
  if (blockers.length > 0) return { key: "high", text: "高風險 · HIGH" };
  const risky = (preview.knownRisks || []).length > 0
    || (preview.largeFiles || []).length > 0
    || (preview.submodules || []).length > 0
    || Number(preview.modeChanges || 0) > 0
    || Boolean(preview.mainDirty?.dirty)
    || (preview.tests || []).some((entry) => entry.status !== "passed");
  return risky ? { key: "medium", text: "中風險 · MEDIUM" } : { key: "low", text: "低風險 · LOW" };
}

function renderMergeRisks(approval) {
  const host = byId("merge-approval-risks");
  if (!host) return;
  host.textContent = "";
  const preview = approval?.preview || {};
  const lines = [];
  for (const risk of preview.knownRisks || []) lines.push(`已宣告風險：${risk}`);
  for (const conflict of preview.conflicts || []) lines.push(`預覽形狀提醒：${conflict}`);
  for (const test of preview.tests || []) {
    lines.push(`測試：${test.command} — ${MERGE_TEST_LABELS[test.status] || test.status}${test.summary ? `（${test.summary}）` : ""}`);
  }
  if (preview.mainDirty?.dirty) {
    lines.push(`main 工作樹目前不乾淨：${preview.mainDirty.statusSummary || ""}`);
  }
  if (!lines.length) {
    lines.push("這份預覽沒有附帶任何已宣告風險；這不等於沒有風險，仍請逐檔檢視右側變更。");
  }
  for (const line of lines) {
    const row = document.createElement("p");
    row.textContent = line;
    host.append(row);
  }
}

function renderMergeStats(approval) {
  const host = byId("merge-approval-stats");
  if (!host) return;
  host.textContent = "";
  const preview = approval?.preview || {};
  /* 一行摘要：檔案 18 · +412 −96 · hook 1 · 會覆蓋 2 個 ignored 檔案；零值的細項不佔位。 */
  const hooks = preview.promotion?.hooks;
  const overwrites = state.mergeApprovalOverwrites;
  const entries = [
    ["檔案", String(preview.fileCount ?? 0)],
    ["", `+${preview.additions ?? 0} −${preview.deletions ?? 0}`],
    ["hook", hooks ? (hooks.unreadable === true ? "讀不到" : String((hooks.hooks || []).length)) : "未記錄"],
    ["會覆蓋", overwrites?.checked === true
      ? `${(overwrites.ignored || []).length} 個 ignored 檔案`
      : overwrites ? "掃描未執行" : "掃描未回傳"],
  ];
  if ((preview.binaryEntries ?? 0) > 0) entries.push(["二進位", `${preview.binaryEntries}（整檔取代）`]);
  if ((preview.modeChanges ?? 0) > 0) entries.push(["模式變更", String(preview.modeChanges)]);
  if ((preview.submodules || []).length > 0) entries.push(["Submodule", String(preview.submodules.length)]);
  for (const [label, value] of entries) {
    const cell = document.createElement("span");
    if (label) {
      const name = document.createElement("small");
      name.textContent = label;
      cell.append(name);
    }
    const text = document.createElement("b");
    text.textContent = value;
    cell.append(text);
    host.append(cell);
  }
}

function mergeFileDelta(file) {
  const size = formatBytes(Number(file.bytes));
  if (file.operation === "add") return `+${size}`;
  if (file.operation === "delete") return `−${size}`;
  return `±${size}`;
}

/*
 * 這次促進會執行什麼、會覆蓋什麼——逐項列出，不是一句通用警告。
 *
 * 這些事實一直都在 payload 裡（hook 清單與設定鍵在 `preview.promotion.hooks`，是綁在核准上的；
 * 覆蓋清單是 live main 的觀察），但畫面上一個字都沒有：Owner 在打 MERGE INTO MAIN 的那一頁
 * 看不到會以自己的身分執行哪些程式、雜湊是多少，也看不到哪些 ignored 檔案會被靜默覆蓋。
 * 只顯示數量或一句警告不算揭露（PITFALLS #86）。
 *
 * 它渲染在 scroll-gate 量的那個區域「之內」，而且在檔案清單之前，所以 Owner 必須捲過它
 * 才可能到底、才可能解開確認輸入。放在區域外面就會變成一段可以完全不看的文字。
 */
function renderMergePromotionDisclosure(region, approval, overwrites) {
  const section = document.createElement("section");
  section.className = "merge-promotion-disclosure";
  const block = (title, lines) => {
    const heading = document.createElement("h4");
    heading.textContent = title;
    section.append(heading);
    for (const line of lines) {
      const row = document.createElement("p");
      if (Array.isArray(line)) {
        const name = document.createElement("b");
        name.textContent = line[0];
        const value = document.createElement("code");
        value.textContent = line[1];
        row.append(name, value);
      } else row.textContent = line;
      section.append(row);
    }
  };
  const hooks = approval?.preview?.promotion?.hooks;
  if (!hooks) {
    block("這次併入會執行的程式", [
      "這份快照產生於促進閘門存在之前，沒有記錄任何 hook 或設定；畫面無法列出會執行什麼。",
    ]);
  } else {
    const lines = [["hooksPath", hooks.hooksPath || "（未設定，git 使用預設 .git/hooks）"]];
    if (hooks.unreadable === true) {
      lines.push("hook 目錄讀不到；這不等於沒有 hook。");
    } else if ((hooks.hooks || []).length === 0) {
      lines.push("已讀取 hook 目錄，裡面沒有可執行的 hook。");
    }
    for (const entry of hooks.hooks || []) lines.push([`${entry.name} · SHA-256`, String(entry.sha256)]);
    for (const driver of hooks.drivers || []) lines.push(["merge driver", String(driver)]);
    for (const filter of hooks.filters || []) lines.push(["clean/smudge filter", String(filter)]);
    block("這次併入會以你的身分、無沙箱執行的腳本（hook）", lines);
    block("設定裡可能指名程式的鍵", [
      ...((hooks.programs || []).length === 0
        ? ["這次讀取沒有匹配到任何這類鍵。"]
        : (hooks.programs || []).map((program) => ["設定鍵", String(program)])),
      // 值不顯示（`credential.helper` 之類可能夾帶秘密），而且這份清單刻意不宣稱完整——
      // 完整性由整份 config 的雜湊承擔，未列出的鍵一樣被綁定。
      `這份清單只列鍵名、不列值，且不宣稱完整；沒列出的鍵仍被整份設定的雜湊綁定：configDigest ${shortSha(hooks.configDigest || "")}`,
    ]);
  }
  if (!overwrites) {
    block("會被靜默覆蓋的 ignored 檔案", [
      "沒有拿到覆蓋掃描的結果。",
    ]);
  } else if (overwrites.checked !== true) {
    block("會被靜默覆蓋的 ignored 檔案", [
      `掃描沒有執行（${overwrites.unavailable || "OVERWRITE_SCAN_UNAVAILABLE"}）；這不等於沒有檔案會被覆蓋。`,
    ]);
  } else {
    const paths = [
      ...(overwrites.ignored || []).map((path) => ["ignored（會被靜默覆蓋）", String(path)]),
      ...(overwrites.untracked || []).map((path) => ["untracked", String(path)]),
    ];
    block(`會被靜默覆蓋的 ignored 檔案 · ${(overwrites.ignored || []).length}`, [
      ...(paths.length === 0
        ? ["掃描已執行：這次併入會寫入的路徑上，main 目前沒有未追蹤或 ignored 的檔案。"]
        : paths),
    ]);
  }
  /* 免責第二次出現：在 scroll-gate 量測區域內，Owner 捲到底之前一定會經過。 */
  const boundary = document.createElement("p");
  boundary.className = "merge-disclosure-boundary";
  boundary.textContent = "免責（在閘門內，Owner 必經）：草稿區是紀錄與還原點，不是作業系統層級的隔離；同帳號的 full-trust agent 技術上仍可繞過應用層邊界。需要強制隔離請用容器或另一個帳號。";
  region.append(section, boundary);
}

function renderMergeDiff(approval) {
  const region = byId("merge-approval-diff");
  if (!region) return;
  region.textContent = "";
  renderMergePromotionDisclosure(region, approval, state.mergeApprovalOverwrites);
  const preview = approval?.preview || {};
  const files = Array.isArray(preview.files) ? preview.files : [];
  const largeFiles = new Set(preview.largeFiles || []);
  const submodules = new Set(preview.submodules || []);
  const conflicts = new Set(preview.mergeConflicts || []);
  if (!files.length) {
    const empty = document.createElement("p");
    empty.className = "merge-file-empty";
    empty.textContent = "這份預覽沒有列出任何檔案變更。";
    region.append(empty);
  }
  for (const file of files) {
    const item = document.createElement("details");
    item.className = "merge-file";
    const summary = document.createElement("summary");
    const operation = document.createElement("i");
    operation.className = `merge-file-op is-${file.operation}`;
    operation.textContent = MERGE_OPERATION_LABELS[file.operation] || String(file.operation);
    const path = document.createElement("b");
    path.textContent = file.path;
    const delta = document.createElement("em");
    delta.className = "merge-file-delta";
    delta.textContent = mergeFileDelta(file);
    summary.append(operation, path, delta);
    if (file.submodule || submodules.has(file.path)) {
      const tag = document.createElement("u");
      tag.className = "merge-file-tag is-submodule";
      tag.textContent = "Submodule 指標變更，不是一般檔案編輯";
      summary.append(tag);
    }
    if (file.mode) {
      const tag = document.createElement("u");
      tag.className = "merge-file-tag is-mode";
      tag.textContent = `模式變更 ${file.mode.from} → ${file.mode.to}，不是一般檔案編輯`;
      summary.append(tag);
    }
    if (largeFiles.has(file.path)) {
      const tag = document.createElement("u");
      tag.className = "merge-file-tag is-opaque";
      tag.textContent = "二進位／過大：無法顯示，將整檔取代";
      summary.append(tag);
    }
    if (conflicts.has(file.path)) {
      const tag = document.createElement("u");
      tag.className = "merge-file-tag is-conflict";
      tag.textContent = "此檔在模擬 merge 中衝突";
      summary.append(tag);
    }
    const detail = document.createElement("div");
    detail.className = "merge-file-detail";
    const facts = [
      `動作：${MERGE_OPERATION_LABELS[file.operation] || file.operation}`,
      ...(file.previousPath ? [`原路徑：${file.previousPath}`] : []),
      `大小：${formatBytes(Number(file.bytes))}`,
      ...(file.mode ? [`檔案模式：${file.mode.from} → ${file.mode.to}`] : []),
      ...(file.submodule ? ["這是 submodule 指標；merge 不會遞迴進 submodule。"] : []),
      ...(largeFiles.has(file.path)
        ? ["內容無法顯示，併入時會整檔取代。"]
        : ["這份預覽只帶檔案層級事實（動作、大小、模式），不含逐行內容。"]),
    ];
    for (const fact of facts) {
      const line = document.createElement("p");
      line.textContent = fact;
      detail.append(line);
    }
    item.append(summary, detail);
    region.append(item);
  }
  if (preview.filesTruncated) {
    const note = document.createElement("p");
    note.className = "merge-file-truncated";
    note.textContent = "檔案清單已被截斷，上面不是完整清單。";
    region.append(note);
  }
  const end = document.createElement("p");
  end.className = "merge-diff-end";
  end.textContent = "── 變更清單結束 · 捲到這裡才算讀完 ──";
  region.append(end);
  /*
   * 重繪＝這是另一份內容，捲動必須從頭開始。設在最後（內容已重建完）才有意義。
   * 實測（真實瀏覽器，第五輪）：清空再重建之後 `scrollTop` 停在 22.5，不是 0——
   * 於是「使用者捲完的是上一份」被 `mergeDiffScrolledToBottom()` 算成捲完了這一份，
   * scroll-gate 在內容換掉的當下無聲放行。呼叫端本來就寫著「重繪會把捲動位置歸零」，
   * 在這一行存在之前那是一句假註解。
   */
  region.scrollTop = 0;
}

function renderMergeRecovery(approval) {
  const host = byId("merge-approval-recovery-facts");
  const command = byId("merge-approval-restore");
  if (!host || !command) return;
  host.textContent = "";
  const binding = approval?.binding || {};
  const recovery = approval?.preview?.recovery || {};
  const facts = [
    ["基準 main", binding.baseMainHead],
    ["併入前 main HEAD", binding.mainHead],
    ["草稿版 HEAD", binding.candidateHead],
    ["還原點 ref", recovery.ref || binding.recoveryRef],
    ["還原點指向", recovery.head],
  ];
  for (const [label, value] of facts) {
    const row = document.createElement("span");
    const name = document.createElement("small");
    name.textContent = label;
    const text = document.createElement("code");
    text.textContent = String(value || "—");
    row.append(name, text);
    host.append(row);
  }
  const mainPath = binding.mainPath || ".";
  const mainHead = binding.mainHead || "";
  const ref = recovery.ref || binding.recoveryRef || "";
  command.textContent = [
    `git -C ${mainPath} branch orchestratory-main-before-${shortSha(mainHead)} ${mainHead}`,
    `git -C ${mainPath} reset --hard ${mainHead}`,
    `git -C ${mainPath} rev-parse ${ref}`,
  ].join("\n");
}

function formatCountdown(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = String(Math.floor(total / 60)).padStart(2, "0");
  const seconds = String(total % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function tickMergeApprovalTtl() {
  const node = byId("merge-approval-ttl");
  const approval = state.mergeApproval;
  if (!node || !approval) return;
  const deadline = Date.parse(approval.expiresAt);
  if (!Number.isFinite(deadline)) {
    node.textContent = "—";
    return;
  }
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    node.textContent = "已逾時";
    node.className = "is-expired";
    if (!approval.expired) {
      approval.expired = true;
      renderMergeApproval();
      byId("merge-approval-status").textContent =
        "核准視窗已逾時；這是刻意的摩擦，不是錯誤。請按「重新產生預覽」再問一次。";
    }
    return;
  }
  node.textContent = `${formatCountdown(remaining)}（${new Date(deadline).toLocaleTimeString()} 到期）`;
  node.className = remaining < 60_000 ? "is-urgent" : "";
}

function mergeDiffScrolledToBottom() {
  const region = byId("merge-approval-diff");
  if (!region) return false;
  return region.scrollTop + region.clientHeight >= region.scrollHeight - 4;
}

/*
 * Scroll-gate：pending approval 的確認輸入框保持可編輯；diff 未捲到底或仍有 blocker 時，
 * 只有主要按鈕保持 disabled。「我捲完了」仍是提交條件，不再被誤做成輸入條件。
 */
function currentMergeApprovalGateView() {
  return {
    blockers: state.mergeApprovalBlockers || [],
    scrolled: state.mergeApprovalScrolled,
    decided: state.mergeApprovalDecided,
    expired: state.mergeApproval?.expired === true,
    phrase: mergeConfirmationPhrase(),
    typed: byId("merge-approval-confirmation")?.value || "",
  };
}

function updateMergeApprovalGate() {
  const input = byId("merge-approval-confirmation");
  const confirm = byId("merge-approval-confirm");
  const hint = byId("merge-approval-scroll-hint");
  const feedback = byId("merge-approval-confirmation-feedback");
  if (!input || !confirm || !hint || !feedback) return null;
  const gate = mergeApprovalGate(currentMergeApprovalGateView());
  if (input.value !== gate.inputValue) input.value = gate.inputValue;
  input.disabled = gate.inputDisabled;
  input.setAttribute("aria-invalid", String(gate.ariaInvalid));
  /*
   * Pending 的按鈕不使用 native disabled：disabled 元素吞掉 click，Owner 只會看到「沒反應」。
   * aria-disabled 保留「尚不可提交」語意；click handler 只做具名導引，ready 才進 POST。
   * Terminal/expired/missing-phrase 仍 native disabled，因為它們沒有可完成的本地下一步。
   */
  confirm.disabled = gate.inputDisabled || state.mergeApprovalSubmitting;
  confirm.setAttribute("aria-disabled", String(gate.confirmDisabled || state.mergeApprovalSubmitting));
  hint.textContent = gate.hint;
  feedback.textContent = gate.feedback;
  feedback.className = `merge-confirmation-feedback${gate.tone ? ` ${gate.tone}` : ""}`;
  return gate;
}

function focusMergeApprovalRequirement(node) {
  if (!node) return;
  for (const previous of document.querySelectorAll("#merge-approval-diff.is-attention, #merge-approval-confirmation.is-attention, #merge-approval-repreview.is-attention")) {
    previous.classList.remove("is-attention");
  }
  node.classList.remove("is-attention");
  void node.offsetWidth;
  node.classList.add("is-attention");
  node.focus();
  node.scrollIntoView({ behavior: "smooth", block: "center" });
}

function setMergeApprovalIntentGuide(target, text) {
  const status = byId("merge-approval-status");
  const sequence = String(Number(status.dataset.intentGuideSequence || "0") + 1);
  status.dataset.intentGuide = target;
  status.dataset.intentGuideSequence = sequence;
  status.textContent = "";
  requestAnimationFrame(() => {
    if (status.dataset.intentGuideSequence === sequence && status.dataset.intentGuide === target) {
      status.textContent = text;
    }
  });
}

function clearMergeApprovalIntentGuide() {
  const status = byId("merge-approval-status");
  if (!status?.dataset.intentGuide) return;
  status.dataset.intentGuideSequence = String(Number(status.dataset.intentGuideSequence || "0") + 1);
  delete status.dataset.intentGuide;
  status.textContent = "";
}

async function handleMergeApprovalPrimaryIntent() {
  if (state.mergeApprovalSubmitting) {
    setMergeApprovalIntentGuide("submitting", "併入請求正在處理；不會重複送出。請等待 durable 結果。");
    return;
  }
  const view = currentMergeApprovalGateView();
  const target = mergeApprovalIntentTarget(view);
  updateMergeApprovalGate();
  if (target === "submit") {
    await approveMergeIntoMain();
    return;
  }
  if (target === "diff") {
    focusMergeApprovalRequirement(byId("merge-approval-diff"));
    setMergeApprovalIntentGuide("diff", "尚未送出、尚未 Merge。已將焦點移到內層深色變更清單；請在這個方框內捲到底，再按一次核准併入。");
    return;
  }
  if (target === "input") {
    focusMergeApprovalRequirement(byId("merge-approval-confirmation"));
    setMergeApprovalIntentGuide("input", `尚未送出、尚未 Merge。請先完整輸入 ${mergeConfirmationPhrase()}，再按一次核准併入。`);
    return;
  }
  if (target === "blockers") {
    focusMergeApprovalRequirement(byId("merge-approval-repreview"));
    setMergeApprovalIntentGuide("blockers", "尚未送出、尚未 Merge。阻擋項目仍在；已將焦點移到重新產生預覽。");
    return;
  }
  setMergeApprovalIntentGuide("unavailable", "這筆核准已逾時、終局或缺少確認短語，不能送出；尚未 Merge。請建立新的 snapshot-bound 核准。");
}

async function handleMergeApprovalConfirmationKeydown(event) {
  if (event.key !== "Enter" || event.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  const target = mergeApprovalIntentTarget(currentMergeApprovalGateView());
  if (target !== "submit") {
    await handleMergeApprovalPrimaryIntent();
    return;
  }
  focusMergeApprovalRequirement(byId("merge-approval-confirm"));
  setMergeApprovalIntentGuide("confirm", "尚未送出、尚未 Merge。確認短語與閱讀條件已完成；焦點已移到最終按鈕，請再按一次以明確確認。");
}

function renderMergeApprovalPicker() {
  const field = byId("merge-approval-switch");
  const select = byId("merge-approval-select");
  if (!field || !select) return;
  const pending = (state.mergeApprovals || []).filter(mergeApprovalPending);
  field.hidden = pending.length < 2;
  const others = byId("merge-approval-others-count");
  if (others) others.textContent = String(Math.max(0, pending.length - (state.mergeApproval ? 1 : 0)));
  select.textContent = "";
  for (const approval of pending) select.append(new Option(`${approval.taskId} · ${approval.id.slice(0, 8)}`, approval.id));
  if (state.mergeApproval) select.value = state.mergeApproval.id;
}

function renderMergeApproval() {
  const approval = state.mergeApproval;
  if (!byId("merge-approval")) return;
  const blockers = mergeApprovalBlockers(approval, state.mergeApprovalBinding, state.mergeApprovalOverwrites);
  state.mergeApprovalBlockers = blockers;
  const risk = mergeRiskLevel(approval, blockers);
  const badge = byId("merge-approval-risk");
  badge.textContent = risk.text;
  badge.className = `merge-approval-risk is-${risk.key}`;
  byId("merge-approval-task").textContent = approval ? `${approval.taskId} · ${String(approval.id || "").slice(0, 8)}` : "—";
  const binding = approval?.binding || {};
  byId("merge-approval-route").textContent = approval
    ? `草稿版 ${binding.candidatePath}\n→ 正式版 ${binding.mainBranch}（${binding.mainPath}）`
    : "草稿版 → 正式版 main";
  const blockerCount = byId("merge-approval-blocker-count");
  if (blockerCount) {
    blockerCount.textContent = `阻擋項目 · ${blockers.length}`;
    blockerCount.classList.toggle("is-blocked", blockers.length > 0);
  }
  renderMergeApprovalHistorySummary();
  byId("merge-approval-phrase").textContent = mergeConfirmationPhrase();
  renderMergeApprovalPicker();
  renderMergeRisks(approval);
  renderMergeStats(approval);
  renderMergeDiff(approval);
  renderMergeRecovery(approval);
  const blockingSection = byId("merge-approval-blocking");
  const list = byId("merge-approval-blockers");
  list.textContent = "";
  blockingSection.hidden = blockers.length === 0;
  for (const blocker of blockers) {
    const row = document.createElement("li");
    row.textContent = blocker;
    list.append(row);
  }
  const retryable = mergeApprovalRetryEligible(approval);
  byId("merge-approval-retry-panel").hidden = !retryable;
  const retryLabel = retryable
    ? "↻ 建立新的預覽與核准"
    : "↻ 重新產生預覽";
  byId("merge-approval-repreview").textContent = retryLabel;
  byId("merge-approval-refresh").textContent = retryLabel;
  byId("merge-approval-reject").disabled = !approval || approval.state !== "requested" || state.mergeApprovalDecided;
  tickMergeApprovalTtl();
  /* 內容比視窗短時本來就已經在底部；展開檔案會讓它重新變成未讀完。 */
  state.mergeApprovalScrolled = mergeDiffScrolledToBottom();
  updateMergeApprovalGate();
}

/*
 * 左欄「▤ 併入紀錄」旁的一行摘要。獨立成函式，因為紀錄面板關閉時只該更新這一行：
 * 走 renderMergeApproval() 會重建 diff、把捲動歸零、重算 gate——等於把 Owner 剛通過的 scroll-gate 無聲關掉。
 */
function renderMergeApprovalHistorySummary() {
  const historySummary = byId("merge-approval-history-summary");
  if (!historySummary) return;
  if (state.mergeHistoryLoaded && state.mergeHistoryRoom === state.room) {
    const buckets = mergeHistoryBuckets(state.mergeHistory, state.mergeUnpromotedApprovals);
    historySummary.textContent = `已併入 ${buckets.mergedPromotions.length} · 需檢查 ${buckets.reviewPromotions.length + buckets.reviewApprovals.length} · 未進入 ${buckets.notStartedApprovals.length}`;
  } else historySummary.textContent = "尚未讀取";
}

async function loadMergeApproval(approvalId) {
  const status = byId("merge-approval-status");
  if (!state.room || !approvalId) return;
  status.textContent = "正在重新讀取預覽與綁定值（唯讀，不會決定任何事）…";
  try {
    const value = await api(
      `/api/rooms/merge-approvals/inspect?room=${encodeURIComponent(state.room)}&approvalId=${encodeURIComponent(approvalId)}`,
    );
    const input = byId("merge-approval-confirmation");
    const inputScope = mergeApprovalInputScope(
      state.mergeApprovalInputApprovalId,
      value.approval?.id,
      input.value,
    );
    input.value = inputScope.value;
    state.mergeApprovalInputApprovalId = inputScope.approvalId;
    state.mergeApproval = value.approval;
    state.mergeApprovalBinding = value.binding || { valid: true, changed: [] };
    /* 缺席與空清單不折疊：沒拿到掃描結果是阻擋，拿到而為空不是。 */
    state.mergeApprovalOverwrites = value.overwrites || null;
    if (typeof value.confirmationPhrase === "string") state.mergeConfirmationPhrase = value.confirmationPhrase;
    state.mergeApprovalDecided = value.approval?.state !== "requested";
    renderMergeApproval();
    status.textContent = "";
  } catch (error) {
    status.textContent = `讀取失敗：${humanError(error)}`;
  }
}

function mergeApprovalSignature(approval, binding, overwrites) {
  return [
    approval?.state, approval?.expired, approval?.updatedAt, approval?.expiresAt,
    approval?.previewDigest, binding?.valid, (binding?.changed || []).join(","),
    // 覆蓋清單是 live main 的觀察，會在對話框開著的期間改變（有人剛建立了一個 ignored 檔案）。
    // 不納入簽章就等於「畫面上那份揭露不會更新」，而它是阻擋條件之一。
    overwrites === undefined || overwrites === null
      ? "no-overwrite-scan"
      : `${overwrites.checked}:${(overwrites.ignored || []).join(",")}:${(overwrites.untracked || []).join(",")}`,
  ].join("|");
}

/*
 * 對話框開著時持續重讀 inspect。它是唯讀端點，輪詢不可能讓任何核准落定；
 * 綁定值在期間改變時，阻擋區會立刻出現、主要按鈕停用；短語仍可修改但不能排除 blocker。
 * 沒有實質變化就不重繪：重繪會重建 diff 並把捲動位置歸零，等於把使用者剛通過的
 * scroll-gate 無聲關掉。
 */
async function repollMergeApproval() {
  const approval = state.mergeApproval;
  if (!approval || byId("merge-approval").hidden || state.mergeApprovalDecided) return;
  /*
   * 一次只准有一個在途請求。這個端點每 5 秒觸發一次，而本輪讓它多背了兩條 git 子程序
   * （`untrackedAtPaths` 的 ignored／untracked 各一條，各 30 秒逾時）——大 repo 或慢碟上
   * 單次回應可能遠超過 5 秒，沒有守衛就會愈堆愈多，每一個都在 Owner 自己的機器上跑 git。
   * 慢的時候少問幾次是對的：這是唯讀輪詢，不是狀態機。
   */
  if (state.mergeApprovalPollInFlight) return;
  state.mergeApprovalPollInFlight = true;
  try {
    const value = await api(
      `/api/rooms/merge-approvals/inspect?room=${encodeURIComponent(state.room)}&approvalId=${encodeURIComponent(approval.id)}`,
    );
    if (mergeApprovalSignature(value.approval, value.binding, value.overwrites || null)
      === mergeApprovalSignature(approval, state.mergeApprovalBinding, state.mergeApprovalOverwrites)) return;
    const wasValid = state.mergeApprovalBinding?.valid !== false;
    state.mergeApproval = value.approval;
    state.mergeApprovalBinding = value.binding || { valid: true, changed: [] };
    state.mergeApprovalOverwrites = value.overwrites || null;
    renderMergeApproval();
    if (wasValid && state.mergeApprovalBinding.valid === false) {
      byId("merge-approval-status").textContent =
        `綁定值在你檢視期間改變了（${(state.mergeApprovalBinding.changed || []).map(bindingFieldLabel).join("、")}）；`
        + "主要按鈕已停用，請重新產生預覽再決定。短語仍可修改，但不能排除阻擋項目；main 沒有被修改。";
    }
  } catch { /* 輪詢失敗不改變畫面上的決定狀態 */ } finally {
    /* `finally`，因為簽章相同時上面會直接 return——在 catch 裡清旗標會讓它永遠卡住。 */
    state.mergeApprovalPollInFlight = false;
  }
}

function openMergeApprovalDialog(approvalId) {
  const dialog = byId("merge-approval");
  if (!dialog) return;
  const pending = (state.mergeApprovals || []).filter(mergeApprovalPending);
  const target = approvalId || pending[0]?.id;
  if (!target) return;
  state.mergeApprovalReturnFocus = document.activeElement;
  state.mergeApprovalDecided = false;
  state.mergeApprovalScrolled = false;
  state.mergeApprovalPollInFlight = false;
  /* 上一筆核准的掃描結果不得沿用到這一筆：那會讓「我沒看過」長得像「我看過，沒事」。 */
  state.mergeApprovalOverwrites = null;
  dialog.hidden = false;
  document.body.classList.add("workspace-modal-open");
  byId("merge-approval-status").textContent = "";
  const result = byId("merge-approval-result");
  result.hidden = true;
  result.className = "merge-approval-result";
  result.textContent = "";
  void loadMergeApproval(target);
  if (!state.mergeApprovalTicker) state.mergeApprovalTicker = setInterval(tickMergeApprovalTtl, 1000);
  if (!state.mergeApprovalPoll) state.mergeApprovalPoll = setInterval(() => void repollMergeApproval(), 5000);
  /* 取消是預設焦點：最高風險動作不得預先對準破壞性按鈕。 */
  byId("merge-approval-cancel").focus();
}

function closeMergeApprovalDialog() {
  const dialog = byId("merge-approval");
  if (!dialog || dialog.hidden) return;
  dialog.hidden = true;
  document.body.classList.remove("workspace-modal-open");
  if (state.mergeApprovalTicker) clearInterval(state.mergeApprovalTicker);
  if (state.mergeApprovalPoll) clearInterval(state.mergeApprovalPoll);
  state.mergeApprovalTicker = null;
  state.mergeApprovalPoll = null;
  state.mergeApproval = null;
  state.mergeApprovalSubmitting = false;
  state.mergeApprovalInputApprovalId = "";
  state.mergeApprovalScrolled = false;
  state.mergeApprovalBlockers = [];
  byId("merge-approval-confirmation").value = "";
  byId("merge-approval-confirmation").disabled = true;
  byId("merge-approval-confirm").disabled = true;
  state.mergeApprovalReturnFocus?.focus?.();
  state.mergeApprovalReturnFocus = null;
}

function returnToRoomAfterSuccessfulMerge() {
  closeMergeApprovalDialog();
  /* 主畫面是辦公室；帳本只在歷史模式才是主視圖。 */
  switchView(state.mode === "history" ? "ledger" : "office");
  (state.mode === "history" ? byId("post-input") : byId("office-chat-input"))?.focus();
}

async function approveMergeIntoMain() {
  const approval = state.mergeApproval;
  const status = byId("merge-approval-status");
  const confirm = byId("merge-approval-confirm");
  if (!approval || (state.mergeApprovalBlockers || []).length > 0 || !state.mergeApprovalScrolled) {
    updateMergeApprovalGate();
    return;
  }
  const confirmation = byId("merge-approval-confirmation").value;
  if (confirmation !== mergeConfirmationPhrase()) {
    updateMergeApprovalGate();
    return;
  }
  if (state.mergeApprovalSubmitting) return;
  state.mergeApprovalSubmitting = true;
  confirm.disabled = true;
  clearMergeApprovalIntentGuide();
  status.textContent = "正在核准並執行 single-use promotion；完成前不會顯示併入成功…";
  try {
    try {
      const value = await api("/api/rooms/merge-approvals/approve", {
        method: "POST",
        body: JSON.stringify({
          room: state.room,
          approvalId: approval.id,
          /* 必須是畫面上實際渲染的那一份 digest；後端會拒絕任何不相符。 */
          previewDigest: approval.previewDigest,
          confirmation,
        }),
      });
      state.mergeApproval = value.approval;
      state.mergeApprovalDecided = true;
      renderMergeApproval();
      await refreshMergeHistory();
      const promotion = value.promotion || {};
      const result = byId("merge-approval-result");
      result.textContent = "";
      const title = document.createElement("b");
      const detail = document.createElement("p");
      const log = document.createElement("code");
      const succeeded = mergeHistorySucceeded(promotion) && value.mainMutated === true;
      let returnButton = null;
      if (succeeded) {
        title.textContent = "✓ 併入成功";
        detail.textContent = `main HEAD ${shortSha(promotion.mainHeadBefore)} → ${shortSha(promotion.mainHeadAfter)}；草稿版已從待處理區消失，durable 結果保留於「併入紀錄」。`;
        status.textContent = "併入已完成並由 durable promotion observation 驗證。沒有自動 push、publish、deploy、delete 或 cleanup。";
        returnButton = document.createElement("button");
        returnButton.type = "button";
        returnButton.className = "merge-success-return";
        returnButton.textContent = "完成，回辦公室";
        returnButton.addEventListener("click", returnToRoomAfterSuccessfulMerge);
      } else if (promotion.state === "rolled-back" && value.mainMutated === false) {
        result.classList.add("is-failed");
        title.textContent = "併入未套用";
        detail.textContent = `promotion 已記錄為 rolled-back（${promotion.observation?.code || "未讀到原因"}）；草稿版與還原點 ref 保留。`;
        status.textContent = "沒有顯示成功，也不會自動重試；請從「需要檢查」核對完整紀錄。";
      } else {
        result.classList.add("is-uncertain");
        title.textContent = "尚未能確認併入成功 · 需要檢查";
        detail.textContent = `promotion=${promotion.state || "unavailable"}；observation=${promotion.observation?.code || "unavailable"}。這不是成功，已放入「需要檢查」；請與 recovery 紀錄一起人工確認。`;
        status.textContent = "系統不會把不確定狀態說成成功，也不會重複 apply。";
      }
      log.textContent = `promotion ${promotion.id || "unavailable"} · approval ${approval.id} · recovery ${promotion.recoveryRef || approval.binding?.recoveryRef || "unavailable"}`;
      result.append(title, detail, log);
      if (returnButton) result.append(returnButton);
      result.hidden = false;
      returnButton?.focus();
    } catch (error) {
      /* 先重新讀取（會清空狀態列），再寫入失敗原因，否則訊息會被覆蓋掉。 */
      let refreshError = null;
      try {
        await loadMergeApproval(approval.id);
      } catch (caught) {
        refreshError = caught;
      }
      status.textContent = mergeApprovalFailureStatus(
        humanError(error),
        refreshError ? humanError(refreshError) : "",
      );
    }
    await refreshMergeApprovals();
  } finally {
    state.mergeApprovalSubmitting = false;
    if (!state.mergeApprovalDecided) updateMergeApprovalGate();
  }
}

async function openMergeHistory() {
  const dialog = byId("merge-history");
  state.mergeHistoryReturnFocus = document.activeElement;
  dialog.hidden = false;
  document.body.classList.add("workspace-modal-open");
  byId("merge-history-status").textContent = "正在從 durable store 讀取…";
  try { await refreshMergeHistory(); }
  catch (error) {
    byId("merge-history-status").textContent = `併入紀錄讀取失敗：${humanError(error)}；讀不到不等於沒有紀錄。`;
  }
  byId("merge-history-merged-section")?.focus();
}

function closeMergeHistory() {
  const dialog = byId("merge-history");
  if (!dialog || dialog.hidden) return;
  dialog.hidden = true;
  document.body.classList.remove("workspace-modal-open");
  const navStatus = byId("merge-outcome-nav-status");
  navStatus.textContent = state.mergeHistoryLoaded
    ? "紀錄面板已關閉；歷史仍保留於「併入紀錄」，不會顯示成待處理數字。"
    : "紀錄面板已關閉；目前數量仍是未知，請重新開啟後重試。";
  /* 核准併入層若還開著，只更新左欄那一行摘要：不重建 diff、不動輸入框、焦點、倒數與 gate 狀態。 */
  renderMergeApprovalHistorySummary();
  state.mergeHistoryReturnFocus?.focus?.();
  state.mergeHistoryReturnFocus = null;
}

async function rejectMergeIntoMain() {
  const approval = state.mergeApproval;
  const status = byId("merge-approval-status");
  if (!approval) return;
  byId("merge-approval-reject").disabled = true;
  status.textContent = "正在記錄拒絕…";
  try {
    const value = await api("/api/rooms/merge-approvals/reject", {
      method: "POST",
      body: JSON.stringify({ room: state.room, approvalId: approval.id }),
    });
    state.mergeApproval = value.approval;
    state.mergeApprovalDecided = true;
    renderMergeApproval();
    /*
     * PITFALLS #86／#89：這裡原本讀三個伺服器寫死為 true 的常數，然後印「全部完整保留」——
     * 那是一句對現況的宣告，而拒絕這條路徑一個 Git 指令都沒跑，根本沒有觀察過任何東西。
     * 修正是說實話，不是沉默：改成只描述這次動作做了什麼（沒刪任何東西），
     * 並明說「現況要自己去看」，而不是替使用者宣告現況。
     */
    const deleted = value.deletedByThisRejection === "nothing"
      ? "這次拒絕沒有刪除草稿版、存檔點或還原點，也沒有修改 main"
      : `伺服器回報這次拒絕刪除了：${String(value.deletedByThisRejection || "未說明")}`;
    status.textContent = `已拒絕併入。${deleted}；拒絕不等於刪除授權，之後可以重新產生預覽再問一次。`
      + `（本頁只描述這次動作，未重新讀取 ${approval.binding?.recoveryRef || "還原點"} 目前的狀態。）`;
  } catch (error) {
    await loadMergeApproval(approval.id);
    status.textContent = `拒絕失敗：${humanError(error)}`;
  }
  await refreshMergeApprovals();
}

async function repreviewMergeApproval() {
  const approval = state.mergeApproval;
  const status = byId("merge-approval-status");
  if (!approval) return;
  if (mergeApprovalRetryEligible(approval)) {
    await retryMergeApprovalWithFreshSnapshot();
    return;
  }
  state.mergeApprovalScrolled = false;
  await loadMergeApproval(approval.id);
  const blockers = state.mergeApprovalBlockers || [];
  status.textContent = blockers.length === 0
    ? "已依 live state 重新產生預覽，阻擋項目已清空；尚未 Merge。輸入框仍可使用；請在內層變更清單方框重新捲到底，最終按鈕才會解鎖。"
    : "已依 live state 重新產生預覽；阻擋項目仍在。這份 snapshot 已經無法核准，請讓草稿版端重新提出一次併入要求（main_merge_request）。";
}

async function retryMergeApprovalWithFreshSnapshot() {
  const approval = state.mergeApproval;
  const status = byId("merge-approval-status");
  if (!approval || !mergeApprovalRetryEligible(approval) || state.mergeApprovalSubmitting) return;
  state.mergeApprovalSubmitting = true;
  updateMergeApprovalGate();
  const buttons = [byId("merge-approval-new-request"), byId("merge-approval-repreview"), byId("merge-approval-refresh")];
  for (const button of buttons) button.disabled = true;
  status.textContent = "正在重新讀取 live main 並建立全新的 snapshot-bound 核准；不會重用舊授權，也不會自動併入…";
  try {
    const value = await api("/api/rooms/merge-approvals/retry", {
      method: "POST",
      body: JSON.stringify({ room: state.room, approvalId: approval.id }),
    });
    const fresh = value.approval;
    state.mergeApprovalInputApprovalId = "";
    byId("merge-approval-confirmation").value = "";
    state.mergeApprovalDecided = false;
    state.mergeApprovalScrolled = false;
    state.mergeApprovalOverwrites = null;
    const result = byId("merge-approval-result");
    result.hidden = true;
    result.textContent = "";
    await refreshMergeApprovals();
    await loadMergeApproval(fresh.id);
    status.textContent = `已建立新的核准 ${fresh.id.slice(0, 8)}，舊核准 ${approval.id.slice(0, 8)} 保持終局；尚未 Merge。請重新檢視變更並輸入確認短語。`;
    byId("merge-approval-diff").focus();
  } catch (error) {
    status.textContent = `無法建立新的核准：${humanError(error)}。舊核准仍安全結案，main 未因這次操作而修改；修正阻擋原因後可再次按這個按鈕。`;
  } finally {
    state.mergeApprovalSubmitting = false;
    for (const button of buttons) button.disabled = false;
    updateMergeApprovalGate();
  }
}

byId("merge-approvals-open").addEventListener("click", () => openMergeApprovalDialog(""));
byId("merge-history-open").addEventListener("click", () => void openMergeHistory());
byId("merge-approval-history-open")?.addEventListener("click", () => void openMergeHistory());
byId("merge-history-select-all").addEventListener("change", (event) => {
  for (const box of document.querySelectorAll(".merge-history-select")) {
    box.checked = event.target.checked;
  }
  updateMergeRetrySelection();
});
byId("merge-history-retry-selected").addEventListener("click", retrySelectedMergeApprovals);
byId("merge-history-close").addEventListener("click", closeMergeHistory);
byId("merge-history-done").addEventListener("click", closeMergeHistory);
byId("merge-history-refresh").addEventListener("click", async () => {
  byId("merge-history-status").textContent = "正在重新讀取…";
  try { await refreshMergeHistory(); }
  catch (error) {
    byId("merge-history-status").textContent = `併入紀錄讀取失敗：${humanError(error)}；讀不到不等於沒有紀錄。`;
  }
});
byId("merge-history").addEventListener("click", (event) => {
  if (event.target === byId("merge-history")) closeMergeHistory();
});
byId("merge-approval-close").addEventListener("click", closeMergeApprovalDialog);
byId("merge-approval-cancel").addEventListener("click", closeMergeApprovalDialog);
byId("merge-approval").addEventListener("click", (event) => {
  if (event.target === byId("merge-approval")) closeMergeApprovalDialog();
});
/*
 * Esc 一次只關「最上面」的那一層，順序固定：頂欄浮層（房間選單／終端抽屜，焦點還給觸發按鈕）→
 * 紀錄面板 → 核准併入層。頂欄浮層永遠疊在層之上，所以核准層開著時先按 Esc 只會收起選單，
 * 不會把 Owner 正在審的核准層一起關掉。
 */
function handleEscapeKeydown(event) {
  if (event.key !== "Escape") return;
  const menuPanel = byId("room-menu-panel");
  const drawer = byId("agent-requests-panel");
  if (menuPanel && !menuPanel.hidden) {
    setRoomMenuOpen(false);
    byId("room-menu-toggle")?.focus();
  } else if (drawer && !drawer.hidden) {
    setAgentRequestsOpen(false);
    byId("agent-requests-open")?.focus();
  } else if (!byId("merge-history").hidden) closeMergeHistory();
  else if (!byId("merge-approval").hidden) closeMergeApprovalDialog();
}
document.addEventListener("keydown", handleEscapeKeydown);
byId("merge-approval-diff").addEventListener("scroll", () => {
  if (mergeDiffScrolledToBottom()) {
    state.mergeApprovalScrolled = true;
    clearMergeApprovalIntentGuide();
  }
  updateMergeApprovalGate();
});
/* 展開一個檔案會多出使用者還沒看過的內容，因此重新評估捲動門檻，而不是沿用舊結果。 */
byId("merge-approval-diff").addEventListener("toggle", () => {
  state.mergeApprovalScrolled = mergeDiffScrolledToBottom();
  updateMergeApprovalGate();
}, true);
byId("merge-approval-confirmation").addEventListener("input", () => {
  clearMergeApprovalIntentGuide();
  updateMergeApprovalGate();
});
byId("merge-approval-confirmation").addEventListener("keydown", (event) => void handleMergeApprovalConfirmationKeydown(event));
byId("merge-approval-confirm").addEventListener("click", () => void handleMergeApprovalPrimaryIntent());
byId("merge-approval-reject").addEventListener("click", () => void rejectMergeIntoMain());
byId("merge-approval-repreview").addEventListener("click", () => void repreviewMergeApproval());
byId("merge-approval-refresh").addEventListener("click", () => void repreviewMergeApproval());
byId("merge-approval-new-request").addEventListener("click", () => void retryMergeApprovalWithFreshSnapshot());
byId("merge-approval-select").addEventListener("change", () => {
  state.mergeApprovalDecided = false;
  state.mergeApprovalScrolled = false;
  void loadMergeApproval(byId("merge-approval-select").value);
});
byId("merge-approval-copy").addEventListener("click", async () => {
  const status = byId("merge-approval-status");
  try {
    await navigator.clipboard.writeText(byId("merge-approval-restore").textContent || "");
    status.textContent = "已複製還原指令；Orchestratory 沒有執行它。";
  } catch {
    status.textContent = "瀏覽器不允許自動複製，請手動選取左欄的指令。";
  }
});

bootstrap().catch((error) => {
  const select = byId("room-select");
  select.textContent = "";
  select.append(new Option("載入失敗；正式資料未變更", ""));
  select.disabled = true;
  for (const id of ["post-input", "office-chat-input", "room-search"]) {
    const input = byId(id);
    if (input) input.disabled = true;
  }
  for (const id of ["summarize", "rec-toggle", "stop-all", "office-chat-send"]) {
    const button = byId(id);
    if (!button) continue;
    button.disabled = true;
    /* 停用要說得出原因：緊急停止在載入失敗時沒有可停的工作流，不是壞掉。 */
    button.title = `${button.getAttribute("aria-label") || button.title || button.textContent.trim()}（Room 載入失敗，此控制已停用）`;
  }
  const ledger = byId("ledger");
  if (ledger) {
    ledger.textContent = "";
    const notice = document.createElement("div");
    notice.className = "empty";
    const title = document.createElement("b");
    title.textContent = "Room 載入失敗";
    const detail = document.createElement("span");
    detail.textContent = humanError(error.message ? error : new Error("UNKNOWN"));
    const recovery = document.createElement("small");
    recovery.textContent = "系統已停用發言操作；帳本資料沒有因此被刪除。";
    notice.append(title, detail, recovery);
    ledger.append(notice);
  }
  showRoomError(error, { prefix: "載入失敗" });
});
