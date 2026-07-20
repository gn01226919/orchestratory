const page = new URL(window.location.href);
const state = {
  csrf: "",
  room: "",
  rooms: [],
  after: 0,
  poll: null,
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

const AUTHOR_COLORS = { you: "#dde0e4", system: "#5f636b", claude: "#3ecf8e", codex: "#5e9eff", grok: "#f5a623" };
function providerForAgent(agent) {
  if (agent === "you" || agent === "system") return agent;
  const managed = state.managedAgents.find((entry) => entry.displayName === agent);
  if (managed) return managed.provider;
  return state.presences.find((session) => session.displayName === agent)?.provider ||
    String(agent).match(/^(codex|claude|grok)/)?.[1] || agent;
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
      : "已排隊（外接終端未值班，無法喚醒）"
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
    alert(error.message);
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
    const mention = message.text.match(/^@(codex|claude|grok|fake)\s+[\s\S]+$/);
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
    alert(error.message);
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
    } else if (message.kind === "chat" && ["codex", "claude", "grok"].includes(providerForAgent(message.author))) {
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
    displayName: session.displayName || "",
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
  const pendingCount = sessions.filter((session) => session.requested && !session.joined).length;
  byId("office-presence-count").textContent = `${joinedCount} 外接收件匣 · ${state.managedAgents.length} 可喚醒`;
  const room = state.rooms.find((entry) => entry.id === state.room);
  if (room) room.pendingAgentRequests = pendingCount;
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
        ? `${session.client || "MCP"} · ${session.listening ? "值班中 · GUI @ 會立即喚醒" : "線上但休班 · GUI 不會喚醒；訊息僅排入收件匣"}`
        : selected
          ? "已選取 · 核准後會等待第一則 GUI 任務"
          : `${session.client || "MCP"} · 點擊選取`;
      identity.append(dot, label, detail);
      identity.addEventListener("click", () => {
        state.selectedPresenceId = selected ? "" : session.id;
        renderPresencePanel();
      });
      let nameInput;
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
      }
      const action = document.createElement("button");
      action.type = "button";
      action.textContent = session.joined
        ? "移除外接值班席位"
        : "核准並建立值班席位";
      action.className = session.joined ? "leave" : "join";
      action.addEventListener("click", () => {
        void changePresenceMembership(session, action);
      });
      row.append(identity, action);
      if (nameInput) row.append(nameInput);
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
  byId("office-presence-count").textContent = `${joinedCount} 外接收件匣 · ${state.managedAgents.length} 可喚醒`;
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
        ? "受控即時 Agent · 回覆中（請勿打擾）"
        : `受控即時 Agent · ${agent.model} · GUI 可直接喚醒`;
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
    alert(error.message);
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
      }),
    });
    if (joining && value.session) {
      state.presences = [...(state.presences || []).filter((entry) => entry.id !== value.session.id), value.session];
      delete state.presenceLabels[session.id];
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
    byId("connection").textContent = `Agent 加入失敗：${error.message}`;
    alert(error.message);
    renderPresencePanel();
  }
}

async function refreshPresence(force = false) {
  if (!state.room || state.presenceRefreshing) return;
  if (!force && Date.now() < state.presenceNextAt) return;
  state.presenceRefreshing = true;
  state.presenceNextAt = Date.now() + 1800;
  try {
    const previous = new Map((state.presences || []).map((session) => [session.id, session]));
    const [value, managedValue, deliveryValue, writerValue] = await Promise.all([
      api(`/api/rooms/presence?room=${encodeURIComponent(state.room)}`),
      api(`/api/rooms/managed-agents?room=${encodeURIComponent(state.room)}`),
      api(`/api/rooms/deliveries?room=${encodeURIComponent(state.room)}`),
      api(`/api/rooms/writers?room=${encodeURIComponent(state.room)}`),
    ]);
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
      }
      for (const [id, before] of previous) {
        if (before.joined && !state.presences.some((session) => session.id === id)) {
          addOfficeNotification("presence", `${before.displayName || before.provider} 已離線`, "終端已關閉，人物與辦公桌已自動移除。", false);
        }
      }
    }
    if (presenceChanged) renderPresencePanel();
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
  if (!state.room || state.searching || state.mode !== "live") return;
  try {
    const previousAfter = state.after;
    const value = await api(`/api/rooms/messages?room=${encodeURIComponent(state.room)}&after=${state.after}`);
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
    byId("connection").textContent = `連線錯誤：${error.message}`;
    byId("connection").className = "conn error";
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
    byId("connection").textContent = `載入失敗：${error.message}`;
    byId("connection").className = "conn error";
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
}

function roomOptionLabel(room) {
  const pending = Number(room.pendingAgentRequests || 0);
  const project = room.projectName || room.workspace?.split("/").filter(Boolean).at(-1) || room.id;
  return `${project} — ${room.id}${pending > 0 ? ` · ${pending} 件申請` : ""}`;
}

function renderRoomCatalog() {
  const select = byId("room-select");
  if (!select) return;
  const selected = state.room || select.value;
  select.textContent = "";
  for (const room of state.rooms) select.append(new Option(roomOptionLabel(room), room.id));
  if (state.rooms.some((room) => room.id === selected)) select.value = selected;
  const globalPending = state.rooms.reduce((sum, room) => sum + Number(room.pendingAgentRequests || 0), 0);
  const badge = byId("agent-request-count");
  badge.textContent = String(globalPending);
  badge.hidden = globalPending === 0;
  const pendingProjects = state.rooms.filter((room) => Number(room.pendingAgentRequests || 0) > 0);
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
  const pendingRoom = rooms.find((room) => Number(room.pendingAgentRequests || 0) > 0);
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
    state.poll = setInterval(poll, 1000);
    state.controlPoll = setInterval(() => void refreshOfficeControlPlane(), 5000);
  }
}

byId("ledger").addEventListener("click", (event) => {
  const ref = event.target.closest?.("a.refl");
  if (ref) void toggleQuote(ref);
});
byId("room-select").addEventListener("change", () => void selectRoom(byId("room-select").value));
byId("agent-requests-open").addEventListener("click", async () => {
  const current = state.rooms.find((room) => room.id === state.room);
  const pendingRooms = state.rooms.filter((room) => Number(room.pendingAgentRequests || 0) > 0);
  if (Number(current?.pendingAgentRequests || 0) === 0 && pendingRooms.length === 1) {
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
  } catch (error) { alert(error.message); }
});
byId("summarize").addEventListener("click", async () => {
  if (!state.room) return;
  if (!window.confirm("會呼叫一次訂閱模型（Codex）閱讀房間近況並把摘要入帳。繼續嗎？")) return;
  byId("summarize").disabled = true;
  byId("summarize").textContent = "摘要中…";
  try {
    await api("/api/rooms/summarize", { method: "POST", body: JSON.stringify({ room: state.room, provider: "codex" }) });
    await poll();
  } catch (error) { alert(error.message); }
  byId("summarize").disabled = false;
  byId("summarize").textContent = "🧾 摘要這個房間";
});
byId("stop-all").addEventListener("click", async () => {
  try {
    const value = await api("/api/stop-all", { method: "POST", body: "{}" });
    byId("connection").textContent = `已停止 ${value.stopped} 個工作流`;
  } catch (error) { alert(error.message); }
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
  return text.match(/^@((?:codex|claude|grok)(?:[1-9][0-9]*|（[^）\r\n]{1,24}）))\s/u)?.[1];
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
  const mention = text.match(/^@(codex|claude|grok|fake)(?::([A-Za-z0-9._:/-]{1,128}))?\s+([\s\S]+)$/);
  if (mention) {
    const target = mention[2] ? `${mention[1]}:${mention[2]}` : mention[1];
    return api("/api/rooms/mention", {
      method: "POST",
      body: JSON.stringify({ room: state.room, target, text: mention[3] }),
    });
  }
  return api("/api/rooms/post", { method: "POST", body: JSON.stringify({ room: state.room, text }) });
}

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
    } else alert(error.message);
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
const BASE_OFFICE_AGENTS = Object.freeze(["you", "codex", "claude", "grok"]);
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
      : managed ? "受控即時 Agent · 唯讀"
      : providerId === "codex" && capability?.canWriteSubscription
        ? "唯讀／實驗性 Writer"
        : capability?.canWriteSubscription ? "受控 Writer" : fallback.access,
  };
}

function addOfficeNotification(kind, title, detail, unread = true) {
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
      if (event.type === "provider.started" && ["codex", "claude", "grok"].includes(provider)) {
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
    const mention = m.text.match(/^@(codex|claude|grok|fake)\s+[\s\S]+$/);
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
    const m = String(lastChat.text).match(/^@(codex|claude|grok|fake)\b/);
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
    status.textContent = `建立失敗：${error.message}`;
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

function reviewReadyWriterLease() {
  const taskId = byId("writer-task-id")?.value.trim();
  return (state.writers?.leases || [])
    .filter((lease) => lease.state === "completed" && lease.taskPhase === "review-ready" && (!taskId || lease.taskId === taskId))
    .sort((left, right) => Number(right.grantedAtMs || 0) - Number(left.grantedAtMs || 0))[0];
}

function terminalWriterLease() {
  const taskId = byId("writer-task-id")?.value.trim();
  return (state.writers?.leases || [])
    .filter((lease) => ["applying", "applied"].includes(lease.taskPhase) && (!taskId || lease.taskId === taskId))
    .sort((left, right) => Number(right.grantedAtMs || 0) - Number(left.grantedAtMs || 0))[0];
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
  byId("writer-complete").disabled = !active && !reviewReady;
  byId("writer-complete").textContent = active ? "完成並檢視風險" : reviewReady ? "重新檢視回寫風險" : "完成 Writer";
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
    status.textContent = `取消失敗：${error.message}`;
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
    status.textContent = error.message === "WRITER_BASE_COMMIT_REQUIRED"
      ? "此專案尚無基準 commit；請先在終端建立第一個 commit，再指派 Writer。"
      : `Writer 操作失敗：${error.message}`;
  }
}

async function completeWriterLease() {
  const active = activeWriterLease();
  const reviewReady = reviewReadyWriterLease();
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
  try {
    const value = active
      ? await api("/api/rooms/writers/complete", {
        method: "POST",
        body: JSON.stringify({ room: state.room, taskId: active.taskId, epoch: active.epoch, checkpoint }),
      })
      : await api("/api/rooms/writers/apply-back/prepare", {
        method: "POST",
        body: JSON.stringify({ room: state.room, taskId: reviewReady.taskId }),
      });
    await refreshPresence(true);
    await reviewAndApplyWriter(active?.taskId || reviewReady.taskId, value.preview);
  } catch (error) {
    status.textContent = `完成失敗：${error.message}`;
  }
}

async function reviewAndApplyWriter(taskId, preview) {
  const status = byId("writer-live-status");
  const riskLabel = preview.risk?.level === "high" ? "高" : preview.risk?.level === "medium" ? "中" : "低";
  const changes = (preview.changes || []).slice(0, 24)
    .map((change) => `${change.operation === "delete" ? "刪除（移至可復原區）" : "寫入"} · ${change.path} · ${change.bytes} bytes`)
    .join("\n");
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
    status.textContent = "已保留在隔離 Writer worktree；尚未回寫主專案，可稍後重新檢視。";
    return;
  }
  if (confirmation !== phrase) {
    status.textContent = "確認文字不符，沒有任何主專案檔案被修改。";
    return;
  }
  status.textContent = "正在重新驗證 source、逐檔雜湊與風險快照…";
  const value = await api("/api/rooms/writers/apply-back/apply", {
    method: "POST",
    body: JSON.stringify({ room: state.room, taskId, previewId: preview.id, confirmation }),
  });
  status.textContent = `Owner 已核准回寫：${value.result.writes} 個寫入；${value.result.deletesMovedToTrash} 個刪除移至可復原區。`;
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
    status.textContent = `派駐失敗：${error.message}`;
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
  if (!byId("writer-task-id").value.trim()) byId("writer-task-id").value = `task-${Date.now().toString(36)}`;
  renderWriterControl();
  const draft = byId("office-chat-input").value
    .replace(/^@(codex|claude|grok|fake)(?::[^\s]+)?\s*/, "")
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
    status.textContent = `建立失敗：${error.message}`;
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
    } else alert(error.message);
  } finally {
    button.disabled = false;
    button.textContent = "送出";
  }
});

bootstrap().catch((error) => {
  byId("connection").textContent = `載入失敗：${error.message}`;
  byId("connection").className = "conn error";
});
