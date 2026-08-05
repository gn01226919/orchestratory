const page = new URL(window.location.href);
const ROOM_UI_PROTOCOL = 2;
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
  mergeApprovals: [],
  mergeApproval: null,
  mergeApprovalBinding: { valid: true, changed: [] },
  mergeApprovalBlockers: [],
  mergeApprovalScrolled: false,
  mergeApprovalDecided: false,
  mergeApprovalReturnFocus: null,
  mergeApprovalTicker: null,
  mergeApprovalPoll: null,
  mergeConfirmationPhrase: "MERGE INTO MAIN",
  mergeNotAuthorized: [],
  mergeApprovalsRoom: "",
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
  MAIN_MERGE_PREVIEW_CONFLICTED: "模擬 merge 有衝突，這份預覽不可核准；請先在候選端解決衝突。",
  MAIN_MERGE_CANDIDATE_WORKTREE_DIRTY: "候選 worktree 有未提交變更，已拒絕；請先在候選端提交或整理。",
  MAIN_MERGE_CANDIDATE_HEAD_CHANGED: "候選 HEAD 在預覽之後改變，已拒絕；請重新產生預覽。",
  MAIN_MERGE_RECOVERY_POINT_MISSING: "找不到復原點 ref，為安全起見已拒絕；請重新產生預覽。",
  MAIN_MERGE_APPROVAL_CONCURRENT_UPDATE: "同一筆核准正在被另一個操作更新，請重新讀取後再決定。",
  MAIN_MERGE_APPROVAL_ACTION_NOT_GRANTED: "這筆核准只授權把候選合併進 main，其他動作都不在授權範圍。",
  INVALID_MERGE_APPROVAL_ID: "核准編號格式不正確，沒有送出任何決定。",
  INVALID_MERGE_APPROVAL_REQUEST: "核准請求格式不正確，沒有送出任何決定。",
};

const MERGE_BINDING_LABELS = {
  taskId: "任務 taskId",
  completionId: "完成紀錄 completionId",
  roomId: "房間 roomId",
  mainPath: "main 路徑 mainPath",
  mainBranch: "main 分支 mainBranch",
  candidatePath: "候選路徑 candidatePath",
  baseMainHead: "基準 main baseMainHead",
  candidateHead: "候選 HEAD candidateHead",
  mainHead: "main HEAD mainHead",
  mainFingerprint: "main 工作樹指紋 mainFingerprint",
  mainIgnoredFingerprint: "main ignored 指紋 mainIgnoredFingerprint",
  recoveryRef: "復原點 recoveryRef",
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
  const deliveryLabel = delivery.state === "queued" && target
    ? target.wakeable
      ? "喚醒中"
      : target.standbyApproved
        ? "已排隊（待命已核准，等待終端重新掛起 room_wait）"
        : "已排隊（room_wait 待命尚未核准）"
    : DELIVERY_LABELS[delivery.state] || delivery.state;
  text.textContent = `${deliveryLabel} · ${delivery.targetDisplayName} · 嘗試 ${delivery.attempt}/${delivery.maxAttempts}`;
  receipt.append(text);
  if (["queued", "delivered", "read", "working"].includes(delivery.state)) {
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = delivery.state === "working" ? "請求取消" : "取消";
    cancel.addEventListener("click", () => void changeDelivery(delivery, "cancel", cancel));
    receipt.append(cancel);
  } else if (["failed", "cancelled"].includes(delivery.state)) {
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

function showMessages(messages, replace) {
  const ledger = byId("ledger");
  if (replace) ledger.textContent = "";
  ledger.querySelector(".welcome")?.remove();
  for (const message of messages) ledger.append(renderMessage(message));
  if (!replace) ledger.scrollTop = ledger.scrollHeight;
}

function updateRoomInfo(room) {
  if (!room) return;
  byId("rec-state").textContent = room.recording === "on" ? "收錄中 ● REC" : room.recording === "paused" ? "已暫停 ⏸" : "已關閉 ■";
  byId("rec-dot").className = room.recording === "on" ? "dot on" : "dot";
  byId("room-stats").textContent = `${room.messages} 則 · ${(room.bytes / 1024).toFixed(1)} KiB`;
  byId("rec-toggle").textContent = room.recording === "on" ? "⏸ 暫停收錄" : "▶ 恢復收錄";
  byId("rec-toggle").dataset.next = room.recording === "on" ? "paused" : "on";
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
  byId("office-presence-count").textContent =
    `${joinedCount} 已加入 · ${wakeableCount} room-wait 待命中 · ${state.managedAgents.length} 受控`;
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
      label.textContent = session.displayName || `${session.provider} 申請 ${index + 1}`;
      const detail = document.createElement("small");
      detail.textContent = session.joined
        ? `Native Full-Trust · host 能力不變 · ${session.client || "MCP"} · ${session.collaborationMode === "room-first" ? "全程帳本協作" : "僅加入房間"} · ${session.syncTurns ? "終端對話同步" : "終端對話不入帳"} · ${
            session.listening
              ? "room-wait 待命中，可由 GUI 喚醒"
              : session.standbyRequested && !session.standbyApproved
                ? "已申請 room-wait，等待 Owner 核准"
                : session.standbyApproved
                  ? "待命已核准，但終端目前未掛起 room_wait"
                  : "已加入，尚未申請 room-wait"
          }`
        : selected
          ? "已選取 · 請確認協作與對話同步模式"
          : `${session.client || "MCP"} · 點擊選取`;
      identity.append(dot, label, detail);
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
      const actions = document.createElement("div");
      actions.className = "presence-actions";
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
        standby.className = "leave";
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
            ? "② 待命已核准 · room_wait 掛起中"
            : "② 待命已核准 · 等終端重新掛起 room_wait"
          : standbyPending ? "② 待命待核准" : "② 尚未申請待命";
      stages.append(stageOne, stageTwo);
      if (standbyPending) {
        const hint = document.createElement("small");
        hint.className = "presence-stage-hint";
        hint.textContent = "同一個 Agent 的第二步：加入房間決定是否入帳，待命決定能否由 GUI 收件喚醒。";
        stages.append(hint);
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
  byId("office-presence-count").textContent =
    `${joinedCount} 已加入 · ${wakeableCount} room-wait 待命中 · ${state.managedAgents.length} 受控`;
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
            "同一個 Agent 的第二步（① 已加入 → ② 待命待核准）；核准後只有這個終端 session 掛起 room_wait 時可由 GUI 喚醒。可直接在這裡核准。",
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
  const label = byId("agent-requests-open")?.querySelector("span");
  if (label) label.textContent = pendingProjects.length === 1 && pendingProjects[0]?.id !== state.room
    ? `＋ 新增 Agents（${pendingProjects[0].projectName} 有申請）`
    : "＋ 新增 Agents";
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
  const panel = byId("agent-requests-panel");
  const opening = panel.hidden;
  panel.hidden = !opening;
  byId("agent-requests-open").setAttribute("aria-expanded", String(opening));
  if (opening) void refreshPresence(true);
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

function defaultOfficeHome(agent) {
  const baseHomes = {
    codex: { x: 31, y: 43 }, claude: { x: 66, y: 43 },
    grok: { x: 34, y: 73 }, you: { x: 69, y: 73 },
  };
  if (OFFICE_AGENTS.length <= 4 && baseHomes[agent]) return baseHomes[agent];
  const count = Math.max(1, OFFICE_AGENTS.length);
  const columns = count <= 6 ? 3 : count <= 12 ? 4 : 5;
  const rows = Math.ceil(count / columns);
  const index = Math.max(0, OFFICE_AGENTS.indexOf(agent));
  const column = index % columns;
  const row = Math.floor(index / columns);
  return {
    x: ((column + 0.5) / columns) * 100,
    y: rows <= 1 ? 61 : 40 + (row / (rows - 1)) * 47,
  };
}

function officeHome(agent) {
  return state.officePositions[agent] || defaultOfficeHome(agent);
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

function addOfficeNotification(kind, title, detail, unread = true, action) {
  const latest = state.notifications[0];
  if (latest && latest.kind === kind && latest.title === title && latest.detail === detail) return;
  state.notificationSequence += 1;
  state.notifications.unshift({
    id: state.notificationSequence,
    kind,
    title: String(title).slice(0, 120),
    detail: String(detail || "").slice(0, 240),
    at: new Date().toISOString(),
    unread,
    ...(action ? { action } : {}),
  });
  state.notifications = state.notifications.slice(0, 30);
  renderOfficeNotifications();
}

function renderOfficeNotifications() {
  const list = byId("office-notification-list");
  if (!list) return;
  list.textContent = "";
  if (!state.notifications.length) {
    const empty = document.createElement("p");
    empty.className = "office-panel-empty";
    empty.textContent = "目前沒有通知。";
    list.append(empty);
  } else {
    for (const item of state.notifications) {
      const row = document.createElement("article");
      row.className = `office-notification ${item.unread ? "is-unread" : ""}`;
      row.dataset.kind = item.kind;
      const title = document.createElement("b");
      title.textContent = item.title;
      const detail = document.createElement("p");
      detail.textContent = item.detail;
      const time = document.createElement("small");
      time.textContent = item.at.slice(11, 16);
      row.append(title, detail, time);
      if (item.action?.kind === "standby-approve") {
        const session = (state.presences || []).find((entry) => entry.id === item.action.presenceId);
        if (session?.joined && session.standbyRequested && !session.standbyApproved) {
          const approve = document.createElement("button");
          approve.type = "button";
          approve.className = "office-notification-action";
          approve.textContent = `② 核准 ${session.displayName || session.provider} 的 room-wait 待命`;
          approve.addEventListener("click", () => void changePresenceStandby(session, "approve", approve));
          row.append(approve);
        } else {
          const done = document.createElement("small");
          done.className = "office-notification-done";
          done.textContent = session ? "② 待命已處理" : "席位已離線，不需處理";
          row.append(done);
        }
      }
      if (item.action?.kind === "merge-approval") {
        const approval = (state.mergeApprovals || []).find((entry) => entry.id === item.action.approvalId);
        if (mergeApprovalPending(approval)) {
          const open = document.createElement("button");
          open.type = "button";
          open.className = "office-notification-action";
          open.textContent = "檢視合併預覽 · Review merge preview";
          open.addEventListener("click", () => openMergeApprovalDialog(item.action.approvalId));
          row.append(open);
        } else {
          const done = document.createElement("small");
          done.className = "office-notification-done";
          done.textContent = "這筆合併核准已有結果 · already decided";
          row.append(done);
        }
      }
      list.append(row);
    }
  }
  const unread = state.notifications.filter((item) => item.unread).length;
  const badge = byId("office-notification-count");
  badge.textContent = String(unread);
  badge.hidden = unread === 0;
}

function markOfficeNotificationsRead() {
  for (const item of state.notifications) item.unread = false;
  renderOfficeNotifications();
}

function latestRunEvent(runId) {
  const events = state.workflowEvents.get(runId) || [];
  return events[events.length - 1];
}

function renderTaskCenter() {
  const list = byId("office-task-list");
  if (!list) return;
  list.textContent = "";
  const pending = state.pendingWorkflowRequests || [];
  const active = state.activeRuns || [];
  byId("office-task-count").textContent = String(pending.length + active.length);
  if (!pending.length && !active.length) {
    const empty = document.createElement("p");
    empty.className = "office-panel-empty";
    empty.textContent = "目前沒有待確認或執行中的任務。";
    list.append(empty);
    return;
  }
  for (const run of active) {
    const event = latestRunEvent(run.id);
    const card = document.createElement("article");
    card.className = "office-task-card is-running";
    const head = document.createElement("div");
    const title = document.createElement("b");
    title.textContent = `⛔ 執行中 · ${run.workspaceLabel}`;
    const tag = document.createElement("small");
    tag.textContent = `Round ${run.counters?.rounds ?? 0} · ${run.counters?.providerCalls ?? 0} calls`;
    head.append(title, tag);
    const detail = document.createElement("p");
    detail.textContent = event?.summary || "Workflow 正在執行。";
    card.append(head, detail);
    list.append(card);
  }
  for (const request of pending) {
    const card = document.createElement("article");
    card.className = "office-task-card is-pending";
    const head = document.createElement("div");
    const title = document.createElement("b");
    title.textContent = "等待確認 RUN";
    const tag = document.createElement("small");
    tag.textContent = String(request.id || "").slice(0, 8);
    head.append(title, tag);
    const detail = document.createElement("p");
    detail.textContent = String(request.task || "未命名任務").slice(0, 220);
    const assignment = document.createElement("small");
    assignment.textContent = `Writer · ${request.writer?.provider || "claude"}`;
    card.append(head, detail, assignment);
    list.append(card);
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
      <div class="office-pinboard"><b>SPRINT 17</b><i></i><i></i><i></i><small>BUILD · REVIEW · SHIP</small></div>
      <div class="studio-sign"><b>ORCHESTRATORY</b><small>AGENT STUDIO</small></div>
      <div class="wall-clock"><i></i></div>
    </div>
    <div class="ceiling-light light-left" aria-hidden="true"><i></i></div>
    <div class="ceiling-light light-right" aria-hidden="true"><i></i></div>
    <div class="floor-perspective" aria-hidden="true"></div>
    <div class="floor-inlay" aria-hidden="true"></div>
    <div class="office-rug" aria-hidden="true"><span>O</span></div>
    <div class="office-server" aria-hidden="true"><i></i><i></i><i></i><b>LOCAL</b></div>
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
  `);
  syncOfficeDesks();
  startOfficeLife();
}

function updateOfficeCapacity(agents) {
  const floor = byId("office-floor");
  const expanded = agents.length > 4;
  const columns = agents.length <= 6 ? 3 : agents.length <= 12 ? 4 : 5;
  const rows = Math.ceil(Math.max(agents.length, 4) / columns);
  floor.classList.toggle("many-agents", expanded);
  floor.classList.toggle("office-expanded", expanded);
  floor.style.setProperty("--office-min-width", `${Math.max(900, columns * 245)}px`);
  floor.style.setProperty("--office-min-height", `${Math.max(620, 330 + rows * 185)}px`);
}

function positionOfficeSeat(agent, point, instant = false) {
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
    const floor = byId("office-floor");
    const home = officeHome(agent);
    const provider = providerForAgent(agent);
    const cube = document.createElement("div");
    cube.className = "cubicle desk-arriving";
    cube.dataset.agent = agent;
    cube.dataset.provider = provider;
    cube.style.left = `${home.x}%`;
    cube.style.top = `${home.y}%`;
    cube.innerHTML =
      `<div class="name-plate"><span>${agent}</span><small>WORKSTATION</small></div>` +
      '<div class="workstation-mat"></div>' +
      '<div class="monitor"><i></i><i></i><em></em><span></span></div>' +
      '<div class="desk-lamp"><i></i></div><div class="desk-mug"><i></i></div>' +
      '<div class="keyboard"></div><div class="desk-mouse"></div><div class="desk-top"></div>' +
      '<div class="desk-leg left"></div><div class="desk-leg right"></div><div class="chair"></div>';
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
    floor.append(cube);

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
    const stat = document.createElement("div");
    stat.className = "desk-stat";
    stat.id = `stat-${agent}`;
    stat.textContent = "待命";
    desk.append(orbie, stat);
    desk.addEventListener("click", () => focusAgentComposer(agent));
    floor.append(desk);
    enableOfficeSeatDrag(cube, desk, agent);
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
  }
  if (state.selectedAgent && !desired.includes(state.selectedAgent)) {
    state.selectedAgent = "";
    byId("office-agent-card").hidden = true;
  }
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
    if (!desk || !home || desk.dataset.activity || desk.classList.contains("real-busy")) continue;
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
    stat.textContent = "待命";
  }
  clearBubble(agent);
}

function startIdleActivity() {
  if (!state.idleEnabled || document.hidden || byId("office").hidden) return;
  const activeCount = OFFICE_AGENTS.filter((agent) => byId(`desk-${agent}`)?.dataset.activity).length;
  if (activeCount >= 2) return;
  const candidates = OFFICE_AGENTS.filter((agent) => {
    const desk = byId(`desk-${agent}`);
    return desk?.classList.contains("idle") && !desk.dataset.activity && !desk.classList.contains("walking");
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

function isManagedAgent(agent) {
  return state.managedAgents.some((entry) => entry.displayName === agent);
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
  closeOfficeSidePanels();
  document.querySelectorAll(".cubicle.is-selected, .desk.is-selected")
    .forEach((node) => node.classList.remove("is-selected"));
  renderAgentCard(agent);
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
  byId("office-chat-hint").textContent = isJoinedPresenceAgent(agent)
    ? `已選擇 ${agent} · 訊息會進入房間收件匣，該終端同步時可讀取`
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
  panel.querySelector("b").textContent = status === "completed" ? "✓ WORKFLOW COMPLETE" : "! WORKFLOW NEEDS ATTENTION";
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
  state.selectedAgent = agent;
  card.hidden = false;
  byId("office-agent-name").textContent = info.label.toUpperCase();
  byId("office-agent-dot").style.background = authorColor(agent);
  byId("office-agent-status").textContent = work ? `⛔ ${work.label}` : "可對話 · 待命";
  byId("office-agent-access").textContent = info.access;
  byId("office-agent-model").textContent = work?.model || info.model;
  byId("office-agent-last").textContent = last ? `#${last.seq} · ${last.at.slice(11, 16)}` : "尚無發言";
  byId("office-agent-detail").textContent = work
    ? `請勿打擾：${work.detail || "Agent 正在處理已核准的工作。"}`
    : agent === "you"
      ? "這是你的 Owner 工位；所有高風險動作仍需要你明確批准。"
      : isJoinedPresenceAgent(agent)
        ? `這是已加入的 ${providerForAgent(agent)} MCP 終端；點擊會預填 @${agent}，訊息進入房間收件匣，不另花模型額度。`
        : isManagedAgent(agent)
          ? `這是 Orchestratory 管理的即時子 Agent；可重複對話，每席同時只有一個進行中回覆，不會冒用外接終端。`
        : `點擊已在輸入框預填 @${agent}；仍需按送出才會喚醒模型。`;
}

function closeOfficeSidePanels(except = "") {
  for (const id of ["office-task-center", "office-notifications", "writer-handoff"]) {
    if (id !== except) byId(id).hidden = true;
  }
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
    empty.textContent = "還沒有對話；點選場景中的 agent 開始。";
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
  const stats = Object.fromEntries((state.stats || []).map((s) => [s.author, s]));
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
    const st = stats[agent];
    const managed = state.managedAgents.find((entry) => entry.displayName === agent);
    const work = managed?.busy
      ? { kind: "room", label: "即時回覆中", detail: "正在處理指定給此席位的任務" }
      : pending?.target === agent
      ? { kind: "room", label: `回覆 Room #${pending.seq}`, detail: pending.text }
      : workflowWork[agent];
    if ((work || agent === speaker) && desk.dataset.activity) clearIdleActivity(agent);
    if (!desk.dataset.activity) byId(`stat-${agent}`).textContent = st ? `${st.messages} 則` : "待命";
    desk.classList.remove("idle", "speaking", "waking", "real-busy", "workflow-busy", "mood-focused");
    if (work) {
      busyCount += 1;
      busyCaption ||= `${agent} · ${work.label}`;
      desk.classList.add("real-busy", "mood-focused", work.kind === "workflow" ? "workflow-busy" : "waking");
      byId(`stat-${agent}`).textContent = `⛔ ${work.label}`;
      desk.title = `請勿打擾：${work.detail || work.label}`;
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
    : speaker ? `${speaker} 正在發言 · 點選工位可喚醒對話`
      : OFFICE_AGENTS.length > 4
        ? `已擴編至 ${OFFICE_AGENTS.length} 席 · 可拖曳辦公桌調整位置`
        : "待命中 · 點選任一 agent 工位開始對話";
  if (state.selectedAgent) renderAgentCard(state.selectedAgent, messages);
}

function switchView(view) {
  const office = view === "office";
  byId("office").hidden = !office;
  byId("ledger").hidden = office;
  byId("post-form").hidden = office || state.mode === "history";
  byId("view-office").classList.toggle("is-active", office);
  byId("view-ledger").classList.toggle("is-active", !office);
  if (office) {
    buildOffice();
    updateOffice(state.recent || []);
    void refreshOfficeControlPlane();
  }
}
byId("view-office").addEventListener("click", () => switchView("office"));
byId("view-ledger").addEventListener("click", () => switchView("ledger"));

function toggleOfficePanel(id) {
  const panel = byId(id);
  const opening = panel.hidden;
  closeOfficeSidePanels(opening ? id : "");
  panel.hidden = !opening;
  if (opening) {
    byId("office-agent-card").hidden = true;
    state.selectedAgent = "";
    document.querySelectorAll(".cubicle.is-selected, .desk.is-selected")
      .forEach((node) => node.classList.remove("is-selected"));
  }
  if (id === "office-task-center" && opening) renderTaskCenter();
  if (id === "office-notifications" && opening) markOfficeNotificationsRead();
}

byId("office-task-toggle").addEventListener("click", () => toggleOfficePanel("office-task-center"));
byId("office-task-close").addEventListener("click", () => { byId("office-task-center").hidden = true; });
byId("office-notification-toggle").addEventListener("click", () => toggleOfficePanel("office-notifications"));
byId("office-notification-close").addEventListener("click", () => { byId("office-notifications").hidden = true; });
byId("office-notification-clear").addEventListener("click", markOfficeNotificationsRead);
byId("office-agent-close").addEventListener("click", () => {
  byId("office-agent-card").hidden = true;
  state.selectedAgent = "";
  document.querySelectorAll(".cubicle.is-selected, .desk.is-selected")
    .forEach((node) => node.classList.remove("is-selected"));
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
  button.textContent = state.quietMode ? "🔔 顯示泡泡" : "🔕 安靜";
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
    option.textContent = `${child.displayName} · ${child.access === "write" ? "共享 Writer worktree（序列執行）" : "跨類型唯讀"}`;
    executor.append(option);
  }
  executor.value = children.some((child) => child.id === selectedExecutor) ? selectedExecutor : "";
  const executionId = executor.value || active?.id || "";
  const executionBusy = Boolean(executionId && (state.writers?.busyLeaseIds || []).includes(executionId));
  summary.classList.toggle("is-active", Boolean(active));
  summary.textContent = active
    ? `${active.writer.displayName} · ${active.taskId} · epoch ${active.epoch}${active.companionId ? " · via Writer Companion" : ""} · ${children.length} 個子 Agent`
    : reviewReady
      ? `${reviewReady.writer.displayName} · ${reviewReady.taskId} · 寫作完成，尚未回寫主專案`
      : terminal?.taskPhase === "applied"
        ? `${terminal.writer.displayName} · ${terminal.taskId} · 已由 Owner 核准並回寫主專案`
        : terminal?.taskPhase === "applying"
          ? `${terminal.writer.displayName} · ${terminal.taskId} · 回寫狀態待人工確認（fail-closed）`
      : "尚未指派 Writer";
  byId("writer-assign").textContent = active ? "交接 Writer" : "指派 Writer";
  const completeButton = byId("writer-complete");
  if (!active) state.writerCompleteConfirm = "";
  const awaitingCompleteConfirm = Boolean(active) &&
    state.writerCompleteConfirm === `${active.taskId}:${active.epoch}`;
  completeButton.disabled = !active && !reviewReady;
  completeButton.textContent = awaitingCompleteConfirm
    ? "再按一次：結束 Writer 並撤銷寫入權"
    : active
      ? "結束 Writer 並準備回寫"
      : reviewReady ? "重新檢視回寫風險" : "完成 Writer";
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
    status.textContent = active ? "正在凍結舊 Writer 並建立交接 checkpoint…" : "正在建立隔離 worktree 與 Writer Lease…";
    if (active) {
      if (!checkpoint) throw new Error("交接前必須填寫 checkpoint");
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
    status.textContent = active ? "Writer 已交接；舊 epoch 與子權限已撤銷。" : "Writer 已指派並建立隔離 worktree。";
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
    status.textContent = "目前沒有可完成或待回寫的 Writer 任務。";
    return;
  }
  if (active && !checkpoint) {
    status.textContent = "完成前必須填寫 checkpoint。";
    return;
  }
  if (active) {
    const confirmKey = `${active.taskId}:${active.epoch}`;
    const children = (state.writers?.delegations || [])
      .filter((child) => child.parentLeaseId === active.id && child.state === "active");
    if (state.writerCompleteConfirm !== confirmKey) {
      state.writerCompleteConfirm = confirmKey;
      status.textContent = `這個動作會先結束 Writer ${active.writer.displayName}（${active.taskId} · epoch ${active.epoch}），` +
        `立即撤銷它與 ${children.length} 個子 Agent 的寫入權，之後才產生回寫預覽；` +
        "撤銷後不能繼續寫作，只能重新指派 Writer。確定的話請再按一次按鈕。";
      renderWriterControl();
      return;
    }
    state.writerCompleteConfirm = "";
  }
  const taskId = active?.taskId || reviewReady.taskId;
  let preview;
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
  await reviewAndApplyWriter(taskId, preview, active ? "階段 1／2 完成：Writer 已結束、寫入權已撤銷。" : "");
}

async function reviewAndApplyWriter(taskId, preview, stageNote = "") {
  const status = byId("writer-live-status");
  const stagePrefix = stageNote ? `${stageNote} ` : "";
  const riskLabel = preview.risk?.level === "high" ? "高" : preview.risk?.level === "medium" ? "中" : "低";
  const allChanges = preview.changes || [];
  const shown = allChanges.slice(0, 24);
  const changeLines = shown
    .map((change) => `${change.operation === "delete" ? "刪除（移至可復原區）" : "寫入"} · ${change.path} · ${change.bytes} bytes`);
  if (allChanges.length > shown.length) {
    changeLines.push(`（另有 ${allChanges.length - shown.length} 筆變更未列出，共 ${allChanges.length} 筆）`);
  }
  const changes = changeLines.join("\n");
  const phrase = `APPLY WRITER ${taskId} TO PROJECT`;
  const explanation = [
    `任務 ${taskId} 已完成寫作，但尚未改動主專案。`,
    `風險等級：${riskLabel}；${(preview.risk?.reasons || []).join("；")}`,
    `變更：${preview.files} 檔 / ${preview.totalBytes} bytes`,
    changes || "沒有實際檔案變更",
    "若確認回寫，請完整輸入：",
    phrase,
  ].join("\n\n");
  const confirmation = window.prompt(explanation, "");
  if (confirmation === null) {
    status.textContent = `${stagePrefix}階段 2／2（回寫主專案）已取消；變更仍保留在隔離 Writer worktree，主專案沒有變更，可稍後重新檢視。`;
    return;
  }
  if (confirmation !== phrase) {
    status.textContent = `${stagePrefix}階段 2／2（回寫主專案）確認文字不符，沒有任何主專案檔案被修改。`;
    return;
  }
  status.textContent = `${stagePrefix}階段 2／2：正在重新驗證 source、逐檔雜湊與風險快照…`;
  try {
    const value = await api("/api/rooms/writers/apply-back/apply", {
      method: "POST",
      body: JSON.stringify({ room: state.room, taskId, previewId: preview.id, confirmation }),
    });
    status.textContent = `Owner 已核准回寫：${value.result.writes} 個寫入；${value.result.deletesMovedToTrash} 個刪除移至可復原區。`;
  } catch (error) {
    status.textContent = `${stagePrefix}階段 2／2（回寫主專案）失敗：${humanError(error)}。可按「重新檢視回寫風險」重新產生預覽再試。`;
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
      ? `${value.delegation.displayName} 已取得同一 Writer worktree 的受控寫入權；系統會與 Writer／其他子 Agent 序列執行。`
      : `${value.delegation.displayName} 已加入，但因跨類型而保持唯讀。`;
  } catch (error) {
    status.textContent = `派駐失敗：${humanError(error)}`;
  }
}

function setWriterHandoff(open) {
  const panel = byId("writer-handoff");
  const form = byId("writer-handoff-form");
  const result = byId("writer-handoff-result");
  const task = byId("writer-task");
  panel.hidden = !open;
  if (!open) return;
  closeOfficeSidePanels("writer-handoff");
  byId("office-agent-card").hidden = true;
  state.selectedAgent = "";
  result.hidden = true;
  form.hidden = false;
  byId("writer-handoff-status").textContent = "";
  byId("writer-live-status").textContent = "";
  state.writerCompleteConfirm = "";
  const taskInput = byId("writer-task-id");
  if (!taskInput.value.trim()) {
    /* 有進行中或待回寫的 lease 時沿用它的 taskId，不要蓋掉待核准的任務。 */
    taskInput.value = pendingWriterLease()?.taskId || `task-${Date.now().toString(36)}`;
  }
  renderWriterControl();
  const draft = byId("office-chat-input").value
    .replace(MENTION_DRAFT_PATTERN, "")
    .trim();
  if (!task.value.trim() && draft) task.value = draft;
  task.focus();
}

byId("writer-handoff-toggle").addEventListener("click", () => {
  setWriterHandoff(byId("writer-handoff").hidden);
});
byId("writer-handoff-close").addEventListener("click", () => setWriterHandoff(false));
byId("writer-handoff-cancel").addEventListener("click", () => setWriterHandoff(false));
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
    byId("office-chat-hint").textContent = "@codex1 等終端只入帳；@codex 才會另外喚醒模型";
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
 * 輸入短語才解鎖），只多一個 variant。全程不得使用 window.alert／confirm／prompt：原生對話框
 * 可被瀏覽器永久靜音，而且在它開啟期間頁面凍結，TTL 倒數物理上不可能顯示。
 */

const MERGE_CONFIRMATION_PHRASE = "MERGE INTO MAIN";
const MERGE_OPERATION_LABELS = {
  add: "新增 · Added",
  modify: "修改 · Modified",
  delete: "刪除 · Deleted",
  rename: "重新命名 · Renamed",
  copy: "複製 · Copied",
  "type-change": "類型變更 · Type change",
  unmerged: "未合併 · Unmerged",
  unknown: "未知 · Unknown",
};
const MERGE_TEST_LABELS = {
  passed: "通過 · passed",
  failed: "失敗 · failed",
  "not-run": "未執行 · not run",
};

function mergeApprovalPending(approval) {
  return Boolean(approval) && approval.state === "requested" && approval.expired !== true;
}

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
  const pending = (state.mergeApprovals || []).filter(mergeApprovalPending);
  badge.textContent = String(pending.length);
  badge.hidden = pending.length === 0;
  button.disabled = pending.length === 0;
  const label = button.querySelector("span");
  if (label) {
    label.textContent = pending.length > 0
      ? `⑂ ${pending.length} 件合併進 main 待核准 · pending merge approval`
      : "⑂ 合併進 main 待核准 · Merge into main";
  }
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
          "有候選要求合併進 main · merge into main requested",
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

function mergeApprovalBlockers(approval, binding) {
  const blockers = [];
  if (!approval) return blockers;
  const preview = approval.preview || {};
  if (approval.state !== "requested") {
    blockers.push(`這筆核准已是終局狀態「${approval.state}」，不能再核准。 · This approval is terminal (${approval.state}).`);
  } else if (approval.expired) {
    blockers.push("核准視窗已逾時，必須重新產生預覽再問一次。 · The approval window expired; a fresh preview is required.");
  }
  // Three outcomes, not two. "The bindings moved" and "the check could not run" are different facts,
  // and reporting the second as the first would tell the owner a snapshot changed when nothing did.
  if (binding && binding.unavailable) {
    blockers.push(`無法比對綁定值（${binding.unavailable}），因此不能確認這份核准仍描述你正在看的東西。 · The binding check could not be completed, so this approval cannot be confirmed as current.`);
  } else if (binding && binding.valid === false && (binding.changed || []).length > 0) {
    const changed = (binding.changed || []).map(bindingFieldLabel);
    blockers.push(`綁定值已改變，這份核准只適用於它綁定的 snapshot：${changed.join("、")} · Bound values changed; this approval no longer describes what you are looking at.`);
  }
  if (preview.mergeable === false) {
    blockers.push(`模擬 merge 有內容衝突，共 ${(preview.mergeConflicts || []).length} 個檔案。 · The simulated merge conflicts.`);
  }
  for (const path of preview.mergeConflicts || []) {
    blockers.push(`衝突檔案 · Conflicting file：${path}`);
  }
  if (preview.mergeConflictsTruncated) {
    blockers.push("衝突清單已截斷，看不到全部衝突就不可核准。 · The conflict list is truncated.");
  }
  if (preview.filesTruncated) {
    blockers.push("檔案清單已截斷，Owner 不得對看不到的內容簽名。 · The file list is truncated; you must not sign for content you cannot see.");
  }
  if (preview.submodulesTruncated) {
    blockers.push("Submodule 清單已截斷，看不到全部指標變更就不可核准。 · The submodule list is truncated.");
  }
  if (preview.largeFileScanTruncated) {
    blockers.push("大型檔案掃描已截斷，可能還有未列出的大檔。 · The large-file scan is truncated.");
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
  for (const risk of preview.knownRisks || []) lines.push(`已宣告風險 · Declared risk：${risk}`);
  for (const conflict of preview.conflicts || []) lines.push(`預覽形狀提醒 · Preview advisory：${conflict}`);
  for (const test of preview.tests || []) {
    lines.push(`測試 · Test：${test.command} — ${MERGE_TEST_LABELS[test.status] || test.status}${test.summary ? `（${test.summary}）` : ""}`);
  }
  if (preview.mainDirty?.dirty) {
    lines.push(`main 工作樹目前不乾淨 · main worktree is dirty：${preview.mainDirty.statusSummary || ""}`);
  }
  if (!lines.length) {
    lines.push("這份預覽沒有附帶任何已宣告風險；這不等於沒有風險，仍請逐檔檢視下方變更。 · No risks were declared with this preview; that is not the same as there being none.");
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
  const entries = [
    ["檔案 · Files", String(preview.fileCount ?? 0)],
    ["新增行 · Additions", `+${preview.additions ?? 0}`],
    ["刪除行 · Deletions", `−${preview.deletions ?? 0}`],
    ["二進位項目 · Binary", `${preview.binaryEntries ?? 0}（無法顯示，將整檔取代）`],
    ["模式變更 · Mode changes", String(preview.modeChanges ?? 0)],
    ["Submodule 指標 · Submodules", String((preview.submodules || []).length)],
  ];
  for (const [label, value] of entries) {
    const cell = document.createElement("span");
    const name = document.createElement("small");
    name.textContent = label;
    const text = document.createElement("b");
    text.textContent = value;
    cell.append(name, text);
    host.append(cell);
  }
}

function mergeFileDelta(file) {
  const size = formatBytes(Number(file.bytes));
  if (file.operation === "add") return `+${size}`;
  if (file.operation === "delete") return `−${size}`;
  return `±${size}`;
}

function renderMergeDiff(approval) {
  const region = byId("merge-approval-diff");
  if (!region) return;
  region.textContent = "";
  const preview = approval?.preview || {};
  const files = Array.isArray(preview.files) ? preview.files : [];
  const largeFiles = new Set(preview.largeFiles || []);
  const submodules = new Set(preview.submodules || []);
  const conflicts = new Set(preview.mergeConflicts || []);
  if (!files.length) {
    const empty = document.createElement("p");
    empty.className = "merge-file-empty";
    empty.textContent = "這份預覽沒有列出任何檔案變更。 · This preview lists no file changes.";
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
      tag.textContent = "Submodule 指標變更，不是一般檔案編輯 · submodule pointer, not an ordinary edit";
      summary.append(tag);
    }
    if (file.mode) {
      const tag = document.createElement("u");
      tag.className = "merge-file-tag is-mode";
      tag.textContent = `模式變更 ${file.mode.from} → ${file.mode.to}，不是一般檔案編輯 · mode change, not an ordinary edit`;
      summary.append(tag);
    }
    if (largeFiles.has(file.path)) {
      const tag = document.createElement("u");
      tag.className = "merge-file-tag is-opaque";
      tag.textContent = "二進位／過大：無法顯示，將整檔取代 · binary or oversized: cannot be shown, replaced whole-file";
      summary.append(tag);
    }
    if (conflicts.has(file.path)) {
      const tag = document.createElement("u");
      tag.className = "merge-file-tag is-conflict";
      tag.textContent = "此檔在模擬 merge 中衝突 · conflicts in the simulated merge";
      summary.append(tag);
    }
    const detail = document.createElement("div");
    detail.className = "merge-file-detail";
    const facts = [
      `動作 · Operation：${MERGE_OPERATION_LABELS[file.operation] || file.operation}`,
      ...(file.previousPath ? [`原路徑 · Previous path：${file.previousPath}`] : []),
      `大小 · Size：${formatBytes(Number(file.bytes))}`,
      ...(file.mode ? [`檔案模式 · File mode：${file.mode.from} → ${file.mode.to}`] : []),
      ...(file.submodule ? ["這是 submodule 指標；merge 不會遞迴進 submodule。 · submodule pointer; the merge does not recurse into it."] : []),
      ...(largeFiles.has(file.path)
        ? ["內容無法顯示，合併時會整檔取代。 · Content cannot be displayed; the whole file is replaced."]
        : ["這份預覽只帶檔案層級事實（動作、大小、模式），不含逐行內容。 · This preview carries file-level facts only, not line-level content."]),
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
    note.textContent = "檔案清單已被截斷，上面不是完整清單。 · The file list is truncated; what you see above is not the whole change.";
    region.append(note);
  }
  const end = document.createElement("p");
  end.className = "merge-diff-end";
  end.textContent = "── 變更清單結束 · end of change list ──";
  region.append(end);
}

function renderMergeRecovery(approval) {
  const host = byId("merge-approval-recovery-facts");
  const command = byId("merge-approval-restore");
  if (!host || !command) return;
  host.textContent = "";
  const binding = approval?.binding || {};
  const recovery = approval?.preview?.recovery || {};
  const facts = [
    ["基準 main SHA · Base main head", binding.baseMainHead],
    ["合併前 main HEAD · main head now", binding.mainHead],
    ["候選 HEAD · Candidate head", binding.candidateHead],
    ["復原點 ref · Recovery ref", recovery.ref || binding.recoveryRef],
    ["復原點指向 · Recovery ref points at", recovery.head],
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
    node.textContent = "已逾時 · expired";
    node.className = "is-expired";
    if (!approval.expired) {
      approval.expired = true;
      renderMergeApproval();
      byId("merge-approval-status").textContent =
        "核准視窗已逾時；這是刻意的摩擦，不是錯誤。請按「重新產生預覽」再問一次。 · The approval window expired; re-preview and ask again.";
    }
    return;
  }
  node.textContent = `${formatCountdown(remaining)}（${new Date(deadline).toLocaleTimeString()} 到期 · expires）`;
  node.className = remaining < 60_000 ? "is-urgent" : "";
}

function mergeDiffScrolledToBottom() {
  const region = byId("merge-approval-diff");
  if (!region) return false;
  return region.scrollTop + region.clientHeight >= region.scrollHeight - 4;
}

/*
 * Scroll-gate：diff 未捲到底或阻擋區還有項目時，確認輸入框與主要按鈕都保持 disabled。
 * 「我捲完了」比「我抄完了」更能證明使用者看過內容。
 */
function updateMergeApprovalGate() {
  const input = byId("merge-approval-confirmation");
  const confirm = byId("merge-approval-confirm");
  const hint = byId("merge-approval-scroll-hint");
  if (!input || !confirm || !hint) return;
  const blocked = (state.mergeApprovalBlockers || []).length > 0;
  const scrolled = Boolean(state.mergeApprovalScrolled);
  const ready = !blocked && scrolled && !state.mergeApprovalDecided;
  if (!ready) input.value = "";
  input.disabled = !ready;
  confirm.disabled = !ready || input.value !== mergeConfirmationPhrase();
  hint.textContent = state.mergeApprovalDecided
    ? "這筆核准已經有結果，不能再決定一次。 · This approval has already been decided."
    : blocked
      ? "阻擋區還有項目：確認輸入與「合併進 main」保持停用，請先重新產生預覽。 · Blocking items remain; the confirmation input and the primary button stay disabled."
      : scrolled
        ? `變更清單已捲到底：輸入 ${mergeConfirmationPhrase()} 即可解鎖「合併進 main」。 · Diff read to the end; type the phrase to enable the primary button.`
        : "請把上面的變更清單捲到底（展開檔案後會重新計算），確認輸入才會解鎖。 · Scroll the change list to the bottom to enable the confirmation input.";
}

function renderMergeApprovalPicker() {
  const field = byId("merge-approval-switch");
  const select = byId("merge-approval-select");
  if (!field || !select) return;
  const pending = (state.mergeApprovals || []).filter(mergeApprovalPending);
  field.hidden = pending.length < 2;
  select.textContent = "";
  for (const approval of pending) select.append(new Option(`${approval.taskId} · ${approval.id.slice(0, 8)}`, approval.id));
  if (state.mergeApproval) select.value = state.mergeApproval.id;
}

function renderMergeApproval() {
  const approval = state.mergeApproval;
  if (!byId("merge-approval")) return;
  const blockers = mergeApprovalBlockers(approval, state.mergeApprovalBinding);
  state.mergeApprovalBlockers = blockers;
  const risk = mergeRiskLevel(approval, blockers);
  const badge = byId("merge-approval-risk");
  badge.textContent = risk.text;
  badge.className = `merge-approval-risk is-${risk.key}`;
  byId("merge-approval-task").textContent = approval ? `taskId ${approval.taskId}` : "—";
  const binding = approval?.binding || {};
  byId("merge-approval-route").textContent = approval
    ? `候選 worktree · candidate worktree：${binding.candidatePath} → 目標分支 · target branch：${binding.mainBranch}（${binding.mainPath}）`
    : "候選 worktree → 目標分支 · candidate worktree → target branch";
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
  byId("merge-approval-reject").disabled = !approval || approval.state !== "requested" || state.mergeApprovalDecided;
  tickMergeApprovalTtl();
  /* 內容比視窗短時本來就已經在底部；展開檔案會讓它重新變成未讀完。 */
  state.mergeApprovalScrolled = mergeDiffScrolledToBottom();
  updateMergeApprovalGate();
}

async function loadMergeApproval(approvalId) {
  const status = byId("merge-approval-status");
  if (!state.room || !approvalId) return;
  status.textContent = "正在重新讀取預覽與綁定值（唯讀，不會決定任何事）… · Re-reading the preview and its bindings (read-only)…";
  try {
    const value = await api(
      `/api/rooms/merge-approvals/inspect?room=${encodeURIComponent(state.room)}&approvalId=${encodeURIComponent(approvalId)}`,
    );
    state.mergeApproval = value.approval;
    state.mergeApprovalBinding = value.binding || { valid: true, changed: [] };
    if (typeof value.confirmationPhrase === "string") state.mergeConfirmationPhrase = value.confirmationPhrase;
    state.mergeApprovalDecided = value.approval?.state !== "requested";
    renderMergeApproval();
    status.textContent = "";
  } catch (error) {
    status.textContent = `讀取失敗 · Failed to load：${humanError(error)}`;
  }
}

function mergeApprovalSignature(approval, binding) {
  return [
    approval?.state, approval?.expired, approval?.updatedAt, approval?.expiresAt,
    approval?.previewDigest, binding?.valid, (binding?.changed || []).join(","),
  ].join("|");
}

/*
 * 對話框開著時持續重讀 inspect。它是唯讀端點，輪詢不可能讓任何核准落定；
 * 綁定值在期間改變時，阻擋區會立刻出現、確認輸入被清空並停用。
 * 沒有實質變化就不重繪：重繪會重建 diff 並把捲動位置歸零，等於把使用者剛通過的
 * scroll-gate 無聲關掉。
 */
async function repollMergeApproval() {
  const approval = state.mergeApproval;
  if (!approval || byId("merge-approval").hidden || state.mergeApprovalDecided) return;
  try {
    const value = await api(
      `/api/rooms/merge-approvals/inspect?room=${encodeURIComponent(state.room)}&approvalId=${encodeURIComponent(approval.id)}`,
    );
    if (mergeApprovalSignature(value.approval, value.binding)
      === mergeApprovalSignature(approval, state.mergeApprovalBinding)) return;
    const wasValid = state.mergeApprovalBinding?.valid !== false;
    state.mergeApproval = value.approval;
    state.mergeApprovalBinding = value.binding || { valid: true, changed: [] };
    renderMergeApproval();
    if (wasValid && state.mergeApprovalBinding.valid === false) {
      byId("merge-approval-status").textContent =
        `綁定值在你檢視期間改變了（${(state.mergeApprovalBinding.changed || []).map(bindingFieldLabel).join("、")}）；`
        + "確認輸入已停用並清空，請重新產生預覽再決定。main 沒有被修改。 · Bound values moved while the dialog was open; the confirmation input is disabled again.";
    }
  } catch { /* 輪詢失敗不改變畫面上的決定狀態 */ }
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
  dialog.hidden = false;
  document.body.classList.add("workspace-modal-open");
  byId("merge-approval-status").textContent = "";
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
  state.mergeApprovalScrolled = false;
  state.mergeApprovalBlockers = [];
  byId("merge-approval-confirmation").value = "";
  byId("merge-approval-confirmation").disabled = true;
  byId("merge-approval-confirm").disabled = true;
  state.mergeApprovalReturnFocus?.focus?.();
  state.mergeApprovalReturnFocus = null;
}

async function approveMergeIntoMain() {
  const approval = state.mergeApproval;
  const status = byId("merge-approval-status");
  const confirm = byId("merge-approval-confirm");
  if (!approval || (state.mergeApprovalBlockers || []).length > 0 || !state.mergeApprovalScrolled) return;
  const confirmation = byId("merge-approval-confirmation").value;
  confirm.disabled = true;
  status.textContent = "正在重新驗證每一個綁定值與這份預覽摘要… · Re-verifying every bound value against the digest you were shown…";
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
    status.textContent = `已核准 ${approval.taskId}：授權在 ${new Date(value.expiresAt).toLocaleTimeString()} 前有效、single-use，`
      + `且只授權 ${approval.grants}。這一步本身沒有寫入 main（mainMutation: false）；`
      + `不授權 ${(state.mergeNotAuthorized || approval.notAuthorized || []).join("、")}。`
      + " · Approved: single-use, short-lived, and it does not write to main by itself.";
  } catch (error) {
    /* 先重新讀取（會清空狀態列），再寫入失敗原因，否則訊息會被覆蓋掉。 */
    await loadMergeApproval(approval.id);
    status.textContent = `核准失敗 · Approval refused：${humanError(error)}`;
  }
  await refreshMergeApprovals();
}

async function rejectMergeIntoMain() {
  const approval = state.mergeApproval;
  const status = byId("merge-approval-status");
  if (!approval) return;
  byId("merge-approval-reject").disabled = true;
  status.textContent = "正在記錄拒絕… · Recording the rejection…";
  try {
    const value = await api("/api/rooms/merge-approvals/reject", {
      method: "POST",
      body: JSON.stringify({ room: state.room, approvalId: approval.id }),
    });
    state.mergeApproval = value.approval;
    state.mergeApprovalDecided = true;
    renderMergeApproval();
    const retained = [
      value.candidateRetained ? "候選 worktree · candidate" : "",
      value.checkpointsRetained ? "全部 checkpoints · checkpoints" : "",
      value.recoveryRefRetained ? `復原點 ref ${approval.binding?.recoveryRef || ""} · recovery ref` : "",
    ].filter(Boolean);
    status.textContent = `已拒絕合併，沒有觸發任何清理：${retained.join("、")} 全部完整保留，`
      + "拒絕不等於刪除授權；之後可以重新產生預覽再問一次。 · Rejected. The candidate, its checkpoints and its recovery ref are all kept; a rejection is never a deletion.";
  } catch (error) {
    await loadMergeApproval(approval.id);
    status.textContent = `拒絕失敗 · Rejection failed：${humanError(error)}`;
  }
  await refreshMergeApprovals();
}

async function repreviewMergeApproval() {
  const approval = state.mergeApproval;
  const status = byId("merge-approval-status");
  if (!approval) return;
  state.mergeApprovalScrolled = false;
  await loadMergeApproval(approval.id);
  const blockers = state.mergeApprovalBlockers || [];
  status.textContent = blockers.length === 0
    ? "已依 live state 重新產生預覽，阻擋項目已清空。 · Re-previewed against live state; nothing is blocking now."
    : "已依 live state 重新產生預覽；阻擋項目仍在。這份 snapshot 已經無法核准，請讓候選端重新提出一次合併要求（main_merge_request）。 · Re-previewed; this snapshot can no longer be approved — the candidate has to request a fresh one.";
}

byId("merge-approvals-open").addEventListener("click", () => openMergeApprovalDialog(""));
byId("merge-approval-close").addEventListener("click", closeMergeApprovalDialog);
byId("merge-approval-cancel").addEventListener("click", closeMergeApprovalDialog);
byId("merge-approval").addEventListener("click", (event) => {
  if (event.target === byId("merge-approval")) closeMergeApprovalDialog();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !byId("merge-approval").hidden) closeMergeApprovalDialog();
});
byId("merge-approval-diff").addEventListener("scroll", () => {
  if (mergeDiffScrolledToBottom()) state.mergeApprovalScrolled = true;
  updateMergeApprovalGate();
});
/* 展開一個檔案會多出使用者還沒看過的內容，因此重新評估捲動門檻，而不是沿用舊結果。 */
byId("merge-approval-diff").addEventListener("toggle", () => {
  state.mergeApprovalScrolled = mergeDiffScrolledToBottom();
  updateMergeApprovalGate();
}, true);
byId("merge-approval-confirmation").addEventListener("input", () => {
  byId("merge-approval-confirm").disabled = byId("merge-approval-confirmation").disabled ||
    byId("merge-approval-confirmation").value !== mergeConfirmationPhrase();
});
byId("merge-approval-confirm").addEventListener("click", () => void approveMergeIntoMain());
byId("merge-approval-reject").addEventListener("click", () => void rejectMergeIntoMain());
byId("merge-approval-repreview").addEventListener("click", () => void repreviewMergeApproval());
byId("merge-approval-refresh").addEventListener("click", () => void repreviewMergeApproval());
byId("merge-approval-select").addEventListener("change", () => {
  state.mergeApprovalDecided = false;
  state.mergeApprovalScrolled = false;
  void loadMergeApproval(byId("merge-approval-select").value);
});
byId("merge-approval-copy").addEventListener("click", async () => {
  const status = byId("merge-approval-status");
  try {
    await navigator.clipboard.writeText(byId("merge-approval-restore").textContent || "");
    status.textContent = "已複製還原指令；Orchestratory 沒有執行它。 · Restore command copied; Orchestratory did not run it.";
  } catch {
    status.textContent = "瀏覽器不允許自動複製，請手動選取上面的指令。 · Clipboard access was refused; select the command above manually.";
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
    if (button) button.disabled = true;
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
