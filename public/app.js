const state = {
  csrf: "",
  providers: [],
  testerProfiles: [],
  recoverableCheckpoints: [],
  workspaceRoots: [],
  hardLimits: null,
  chatBusy: false,
  chatConsent: false,
  activeRun: null,
  pendingWorkflowRequests: [],
  workspacePreview: null,
  workspaceReturnFocus: null,
};

const PROFILES = {
  normal: { maxRounds: 5, maxProviderCalls: 15, workflowTimeoutMs: 2_700_000, providerTimeoutMs: 600_000 },
  long: { maxRounds: 15, maxProviderCalls: 45, workflowTimeoutMs: 10_800_000, providerTimeoutMs: 600_000 },
};

const PROVIDER_PRESENTATION = {
  codex: { label: "Codex", icon: "cx", defaultModel: "gpt-5.6-sol" },
  claude: { label: "Claude", icon: "cl", defaultModel: "claude-fable-5" },
  grok: { label: "Grok", icon: "gk", defaultModel: "grok-4.5" },
  fake: { label: "測試模型（不用額度）", icon: "f", defaultModel: "fake" },
};

const byId = (id) => document.getElementById(id);

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(state.csrf ? { "X-CSRF-Token": state.csrf } : {}),
      ...(options.headers || {}),
    },
    credentials: "same-origin",
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
  return value;
}

function humanError(error) {
  const code = error instanceof Error ? error.message : String(error);
  const known = {
    WORKSPACE_NOT_ALLOWED: "這個專案尚未授權。",
    WORKSPACE_NOT_CLEAN: "專案有未提交的變更。對話仍可使用；真正寫檔前，請先整理 Git 狀態。",
    WORKSPACE_MUST_START_CLEAN: "專案有未提交或未追蹤的檔案。對話仍可使用；安全 workflow 必須從乾淨的 Git 狀態開始（先 git commit 或 stash）。",
    GIT_HEAD_REQUIRED: "專案還沒有初始 Git commit，無法建立安全分支。",
    WORKSPACE_MUST_BE_GIT_ROOT: "選擇的資料夾不是 Git repository 根目錄。",
    WRITER_PROVIDER_IS_READ_ONLY: "選擇的 AI 不能直接寫入檔案；目前只有 Claude 可擔任寫程式角色。",
    SELECTED_WRITER_PROVIDER_IS_READ_ONLY: "選擇的 AI 不能直接寫入檔案；目前只有 Claude 可擔任寫程式角色。",
    RUN_ACTION_REJECTED: "這個操作目前無法執行。",
    CHAT_TURN_ALREADY_RUNNING: "上一個回答還在生成，請稍候。",
    SESSION_TURN_LIMIT_REACHED: "這個對話已達輪數上限，請按『新對話』清空內容。",
    SESSION_PROVIDER_CALL_LIMIT_REACHED: "這次啟動已達模型呼叫硬上限（owner 設定檔可調）。請重新啟動 Orchestrator。",
    PROVIDER_STRUCTURED_OUTPUT_MISSING_TEXT: "模型回傳格式不完整，系統已阻止原始資料顯示。請再試一次。",
    PROVIDER_EXITED: "模型程序已結束，請確認對應的 CLI 已登入後重試。",
    INVALID_PROVIDER_ID: "不支援這個 AI provider。",
    INVALID_MODEL_ID: "模型 ID 格式不正確。",
    MAIN_AGENT_REQUIRES_SUBSCRIPTION_PROVIDER: "主代理只能使用訂閱模式的 AI。",
    MAX_CONCURRENT_WORKFLOWS_REACHED: "已有工作流在執行中，請等它結束。",
    TESTER_PROFILE_NOT_CONFIGURED: "選擇的測試設定不存在。",
    API_MODE_NOT_CONFIRMED: "付費 API 模式需要明確勾選同意。",
    INVALID_WORKSPACE_PATH: "請輸入有效的專案路徑。",
    WORKSPACE_PATH_NOT_FOUND: "找不到這個資料夾，請確認路徑後再試。",
    WORKSPACE_ROOT_NOT_DIRECTORY: "選擇的路徑不是資料夾。",
    WORKSPACE_PREVIEW_LIMIT_REACHED: "待確認的專案太多，請稍後再試。",
    WORKSPACE_PREVIEW_NOT_FOUND: "這張安全預覽已失效，請重新檢查。",
    WORKSPACE_PREVIEW_EXPIRED: "安全預覽已逾時，請重新檢查。",
    WORKSPACE_PREVIEW_BLOCKED: "安全檢查未通過，無法從 Web 加入這個資料夾。",
    WORKSPACE_CONFIRMATION_MISMATCH: "確認文字不相符，安全預覽已作廢，請重新檢查。",
    WORKSPACE_PREVIEW_PATH_CHANGED: "確認前資料夾或符號連結發生變化，請重新檢查。",
    WORKSPACE_ALREADY_ALLOWED: "這個資料夾已在授權範圍內。",
    NATIVE_WORKSPACE_PICKER_UNAVAILABLE: "這個平台目前沒有原生資料夾選擇器，請改用路徑輸入。",
    NATIVE_WORKSPACE_PICKER_TIMEOUT: "資料夾選擇器已逾時，請再試一次。",
    NATIVE_WORKSPACE_PICKER_FAILED: "無法開啟資料夾選擇器，請改用路徑輸入。",
    NATIVE_WORKSPACE_PICKER_INVALID_PATH: "選擇器回傳的路徑無法安全使用。",
  };
  return known[code] || code;
}

/* ---------- stream helpers ---------- */

function scrollStream() {
  const stream = byId("chat-messages");
  stream.scrollTop = stream.scrollHeight;
}

function appendNote(text) {
  const note = document.createElement("div");
  note.className = "note";
  note.textContent = text;
  byId("chat-messages").append(note);
  scrollStream();
}

function appendMessage(role, text, source = "", model = "") {
  byId("chat-messages").querySelector(".welcome")?.remove();
  const provider = source || byId("chat-provider").value || "codex";
  const presentation = PROVIDER_PRESENTATION[provider] || PROVIDER_PRESENTATION.codex;
  const item = document.createElement("article");
  item.className = `msg ${role}`;
  const avatar = document.createElement("span");
  avatar.className = "avatar";
  avatar.textContent = role === "user" ? "你" : role === "error" ? "!" : presentation.icon;
  const body = document.createElement("div");
  const label = document.createElement("small");
  label.textContent = role === "user"
    ? "你"
    : role === "error"
      ? "系統"
      : `${presentation.label}${model ? ` · ${model}` : ""}`;
  const content = document.createElement("p");
  content.textContent = text;
  body.append(label, content);
  item.append(avatar, body);
  byId("chat-messages").append(item);
  scrollStream();
  return item;
}

/* ---------- sidebar / chat ---------- */

function updateAgentRail() {
  const provider = byId("chat-provider").value || "codex";
  const presentation = PROVIDER_PRESENTATION[provider] || PROVIDER_PRESENTATION.codex;
  byId("main-agent-name").textContent = provider;
  byId("main-agent-model").textContent = `${byId("chat-model").value || presentation.defaultModel} · 主代理 · 可讀專案檔案`;
}

async function loadChatModels(preserveSelection = false) {
  const provider = byId("chat-provider").value || "codex";
  const presentation = PROVIDER_PRESENTATION[provider] || PROVIDER_PRESENTATION.codex;
  const select = byId("chat-model");
  const previous = select.value;
  let models = [presentation.defaultModel];
  try {
    const value = await api(`/api/models?provider=${encodeURIComponent(provider)}&authMode=subscription`);
    if (Array.isArray(value.models) && value.models.length) {
      models = [...new Set([presentation.defaultModel, ...value.models])];
    }
  } catch {
    // The pinned per-provider default remains available if discovery fails.
  }
  select.textContent = "";
  for (const model of models) {
    const option = document.createElement("option");
    option.value = model;
    option.textContent = model;
    select.append(option);
  }
  select.value = preserveSelection && models.includes(previous) ? previous : presentation.defaultModel;
  updateAgentRail();
}

async function loadSecondModels(preserveSelection = false) {
  const provider = byId("second-provider").value || "claude";
  const presentation = PROVIDER_PRESENTATION[provider] || PROVIDER_PRESENTATION.claude;
  const select = byId("second-model");
  const previous = select.value;
  let models = [presentation.defaultModel];
  try {
    const value = await api(`/api/models?provider=${encodeURIComponent(provider)}&authMode=subscription`);
    if (Array.isArray(value.models) && value.models.length) {
      models = [...new Set([presentation.defaultModel, ...value.models])];
    }
  } catch { /* keep pinned default */ }
  select.textContent = "";
  for (const model of models) select.append(new Option(model, model));
  select.value = preserveSelection && models.includes(previous) ? previous : presentation.defaultModel;
}

function updateChatUsage(status) {
  const turns = Number(status?.turns || 0);
  const calls = Number(status?.providerCalls || 0);
  const cap = state.hardLimits?.maxProviderCalls ?? "?";
  byId("chat-usage").textContent = `${turns} 輪 · ${calls}/${cap} 呼叫`;
}

function setChatBusy(busy) {
  state.chatBusy = busy;
  byId("chat-send").disabled = busy || !byId("chat-workspace").value;
  byId("chat-input").disabled = busy;
  byId("chat-workspace").disabled = busy;
  byId("chat-provider").disabled = busy;
  byId("chat-model").disabled = busy;
  byId("chat-send").textContent = busy ? "思考中…" : "送出";
}

async function submitChat() {
  const message = byId("chat-input").value.trim();
  const workspace = byId("chat-workspace").value;
  const provider = byId("chat-provider").value || "codex";
  const model = byId("chat-model").value;
  if (!message || state.chatBusy) return;
  if (!workspace) {
    appendMessage("error", "尚未授權任何專案。請先在終端機執行 orchestrator workspaces allow <path>。");
    return;
  }
  if (!state.chatConsent && provider !== "fake") {
    if (!window.confirm("即將呼叫已登入的訂閱 CLI，會使用你的訂閱額度。只會傳送已授權專案與這個對話所需的受限內容。確定繼續嗎？")) return;
    state.chatConsent = true;
  }
  appendMessage("user", message);
  byId("chat-input").value = "";
  setChatBusy(true);
  const thinking = appendMessage("assistant", "正在思考…", provider);
  thinking.classList.add("thinking");
  try {
    const value = await api("/api/chat", {
      method: "POST",
      body: JSON.stringify({ workspace, provider, model, message, secondProvider: byId("second-provider").value || "claude", secondModel: byId("second-model").value || "claude-fable-5" }),
    });
    thinking.remove();
    const decision = value.decision || {};
    if (decision.kind === "message") {
      appendMessage("assistant", decision.message, decision.source, decision.model || "");
    } else if (decision.kind === "compare" && Array.isArray(decision.answers)) {
      for (const answer of decision.answers) {
        appendMessage("assistant", answer.message, answer.provider, answer.model || "");
      }
    } else if (decision.kind === "tool" && decision.tool === "coding_team") {
      appendProposalCard({ task: decision.input, workspace });
    } else {
      appendMessage("error", "模型回傳了無法辨識的決策；系統沒有執行任何動作。");
    }
    updateChatUsage(value.status);
  } catch (error) {
    thinking.remove();
    appendMessage("error", humanError(error));
  } finally {
    setChatBusy(false);
    byId("chat-input").focus();
  }
}

/* ---------- proposal card ---------- */

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function fillRoleSelect(select, writable) {
  select.textContent = "";
  for (const provider of state.providers) {
    if (!provider.subscription) continue;
    if (writable && !provider.canWriteSubscription) continue;
    const option = document.createElement("option");
    option.value = provider.id;
    option.textContent = provider.id === "fake" ? "測試模型（不用額度）" : provider.displayName;
    select.append(option);
  }
}

async function syncRoleModel(providerSelect, modelInput) {
  const provider = providerSelect.value;
  const presentation = PROVIDER_PRESENTATION[provider];
  try {
    const value = await api(`/api/models?provider=${encodeURIComponent(provider)}&authMode=subscription`);
    modelInput.value = value.models?.[0] || presentation?.defaultModel || "default";
  } catch {
    modelInput.value = presentation?.defaultModel || "default";
  }
}

function buildTuneDrawer(card) {
  const tune = element("details", "tune");
  tune.append(element("summary", "", "調整（團隊、時間、隔離、測試）"));
  const body = element("div", "tune-body");

  const grid = element("div", "tune-grid");
  const teamLabel = element("label", "", "AI 團隊");
  const teamSelect = document.createElement("select");
  for (const [value, text] of [
    ["codex-claude", "Codex 規劃＋Claude 寫＋Codex 審（推薦）"],
    ["claude", "全部 Claude"],
    ["fake", "介面測試（不用額度）"],
    ["custom", "自訂角色與模型"],
  ]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = text;
    teamSelect.append(option);
  }
  teamLabel.append(teamSelect);

  const profileLabel = element("label", "", "執行時間");
  const profileSelect = document.createElement("select");
  for (const [value, text] of [
    ["normal", "標準 · 5 回合"],
    ["long", "長時間 · 15 回合"],
    ["custom", "自訂上限"],
  ]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = text;
    profileSelect.append(option);
  }
  profileLabel.append(profileSelect);

  const modeLabel = element("label", "", "檔案隔離");
  const modeSelect = document.createElement("select");
  for (const [value, text] of [
    ["worktree", "安全分支（推薦，不動主專案）"],
    ["in-place", "直接操作主專案（進階）"],
  ]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = text;
    modeSelect.append(option);
  }
  modeLabel.append(modeSelect);
  grid.append(teamLabel, profileLabel, modeLabel);
  body.append(grid);

  const dirtySnapshotCheck = element("label", "check");
  const dirtySnapshotConfirm = document.createElement("input");
  dirtySnapshotConfirm.type = "checkbox";
  dirtySnapshotCheck.append(
    dirtySnapshotConfirm,
    document.createTextNode("把目前未提交的文字變更匯入安全分支（短效 RAM snapshot；不改主專案）"),
  );
  body.append(dirtySnapshotCheck);

  const customTeam = element("div", "tune-grid");
  customTeam.hidden = true;
  const roles = {};
  for (const [role, title, writable] of [
    ["planner", "規劃者", false],
    ["writer", "寫程式", true],
    ["reviewer", "審查者", false],
  ]) {
    const label = element("label", "", title);
    const providerSelect = document.createElement("select");
    fillRoleSelect(providerSelect, writable);
    const modelInput = document.createElement("input");
    modelInput.type = "text";
    modelInput.spellcheck = false;
    label.append(providerSelect, modelInput);
    providerSelect.addEventListener("change", () => { void syncRoleModel(providerSelect, modelInput); });
    customTeam.append(label);
    roles[role] = { providerSelect, modelInput };
  }
  body.append(customTeam);

  const fallbackCheck = element("label", "check");
  const fallbackConfirm = document.createElement("input");
  fallbackConfirm.type = "checkbox";
  const codexWritable = state.providers.some(
    (provider) => provider.id === "codex" && provider.canWriteSubscription,
  );
  fallbackConfirm.disabled = !codexWritable;
  fallbackCheck.append(
    fallbackConfirm,
    document.createTextNode(codexWritable
      ? "Claude 額度／程序失敗時，讓 Codex Writer 接手該回合（仍在同一安全分支）"
      : "Codex fallback 尚未啟用（需先由 owner 開啟 Codex Writer gate）"),
  );
  body.append(fallbackCheck);

  const customLimits = element("div", "tune-grid");
  customLimits.hidden = true;
  const limits = {};
  for (const [key, title, initial] of [
    ["rounds", "最多回合", "5"],
    ["calls", "最多模型呼叫", "15"],
    ["workflowMinutes", "整體分鐘", "45"],
    ["providerMinutes", "單次模型分鐘", "10"],
  ]) {
    const label = element("label", "", title);
    const input = document.createElement("input");
    input.type = "number";
    input.min = "1";
    input.value = initial;
    label.append(input);
    customLimits.append(label);
    limits[key] = input;
  }
  body.append(customLimits);

  let testerControls = null;
  if (state.testerProfiles.length > 0) {
    const testLabel = element("label", "", "隔離測試（digest-pinned、離線、唯讀）");
    const testSelect = document.createElement("select");
    testSelect.append(new Option("不執行 container 測試", ""));
    for (const profile of state.testerProfiles) {
      testSelect.append(new Option(`${profile.displayName} · ${profile.runtime}`, profile.id));
    }
    const testCheck = element("label", "check");
    const testConfirm = document.createElement("input");
    testConfirm.type = "checkbox";
    testCheck.append(testConfirm, document.createTextNode("我同意執行這個測試 image。"));
    testLabel.append(testSelect);
    body.append(testLabel, testCheck);
    testerControls = { testSelect, testConfirm };
  }

  const modeNote = element("p", "tune-note", "");
  body.append(modeNote);

  teamSelect.addEventListener("change", () => {
    customTeam.hidden = teamSelect.value !== "custom";
    if (!customTeam.hidden) {
      roles.planner.providerSelect.value = "codex";
      roles.writer.providerSelect.value = "claude";
      roles.reviewer.providerSelect.value = "codex";
      roles.planner.modelInput.value = "gpt-5.6-sol";
      roles.writer.modelInput.value = "claude-fable-5";
      roles.reviewer.modelInput.value = "gpt-5.6-sol";
    }
    updateFacts(card);
  });
  profileSelect.addEventListener("change", () => {
    customLimits.hidden = profileSelect.value !== "custom";
    updateFacts(card);
  });
  modeSelect.addEventListener("change", () => {
    modeNote.textContent = modeSelect.value === "in-place"
      ? "注意：直接操作模式僅供進階情境；一般請使用安全分支。"
      : "";
    dirtySnapshotConfirm.disabled = modeSelect.value !== "worktree";
    if (dirtySnapshotConfirm.disabled) dirtySnapshotConfirm.checked = false;
    updateFacts(card);
  });
  dirtySnapshotConfirm.addEventListener("change", () => updateFacts(card));
  fallbackConfirm.addEventListener("change", () => updateFacts(card));

  tune.append(body);
  card.tune = {
    teamSelect,
    profileSelect,
    modeSelect,
    roles,
    limits,
    testerControls,
    dirtySnapshotConfirm,
    fallbackConfirm,
  };
  return tune;
}

function cardTeam(card) {
  const preset = card.tune.teamSelect.value;
  if (preset === "fake") {
    return {
      planner: { role: "planner", provider: "fake", model: "fake", authMode: "subscription" },
      writer: { role: "writer", provider: "fake", model: "fake", authMode: "subscription" },
      reviewers: [{ role: "reviewer", provider: "fake", model: "fake", authMode: "subscription" }],
    };
  }
  if (preset === "claude") {
    return {
      planner: { role: "planner", provider: "claude", model: "claude-fable-5", authMode: "subscription" },
      writer: { role: "writer", provider: "claude", model: "claude-fable-5", authMode: "subscription" },
      reviewers: [{ role: "reviewer", provider: "claude", model: "claude-fable-5", authMode: "subscription" }],
    };
  }
  if (preset === "custom") {
    const roles = card.tune.roles;
    return {
      planner: { role: "planner", provider: roles.planner.providerSelect.value, model: roles.planner.modelInput.value.trim(), authMode: "subscription" },
      writer: { role: "writer", provider: roles.writer.providerSelect.value, model: roles.writer.modelInput.value.trim(), authMode: "subscription" },
      reviewers: [{ role: "reviewer", provider: roles.reviewer.providerSelect.value, model: roles.reviewer.modelInput.value.trim(), authMode: "subscription" }],
    };
  }
  return {
    planner: { role: "planner", provider: "codex", model: "gpt-5.6-sol", authMode: "subscription" },
    writer: { role: "writer", provider: "claude", model: "claude-fable-5", authMode: "subscription" },
    reviewers: [{ role: "reviewer", provider: "codex", model: "gpt-5.6-sol", authMode: "subscription" }],
  };
}

function cardSoftLimits(card) {
  const profile = card.tune.profileSelect.value;
  if (profile === "custom") {
    const limits = card.tune.limits;
    return {
      maxRounds: Number(limits.rounds.value),
      maxProviderCalls: Number(limits.calls.value),
      workflowTimeoutMs: Number(limits.workflowMinutes.value) * 60_000,
      providerTimeoutMs: Number(limits.providerMinutes.value) * 60_000,
    };
  }
  return PROFILES[profile] || PROFILES.normal;
}

function updateFacts(card) {
  const team = cardTeam(card);
  const soft = cardSoftLimits(card);
  const mode = card.tune.modeSelect.value;
  card.facts.textContent = "";
  const fact = (label, value) => {
    const wrap = element("span", "", `${label} `);
    wrap.append(element("b", "", value));
    card.facts.append(wrap);
  };
  fact("團隊", `${team.planner.provider} → ${team.writer.provider} → ${team.reviewers[0].provider}`);
  fact("上限", `${soft.maxRounds} 回合 / ${soft.maxProviderCalls} 呼叫`);
  fact("檔案", mode === "worktree" ? "安全分支" : "直接操作");
  if (card.tune.dirtySnapshotConfirm.checked) fact("未提交變更", "短效 snapshot，另行確認");
  if (card.tune.fallbackConfirm.checked) fact("備援", "Codex Writer（僅 provider 程序失敗）");
  fact("額度", team.writer.provider === "fake" ? "不使用" : "訂閱");
}

function appendProposalCard(input) {
  byId("chat-messages").querySelector(".welcome")?.remove();
  const card = element("section", "card");
  card.dataset.kind = "proposal";
  const head = element("div", "card-head");
  card.stateLabel = element("span", "state pending", "待確認");
  card.meta = element("span", "meta", "coding team");
  head.append(card.stateLabel, card.meta);
  card.append(head);
  card.append(element("p", "task", input.task));
  card.facts = element("div", "facts");
  card.append(card.facts);
  card.append(buildTuneDrawer(card));

  if (input.proposal) {
    const proposal = input.proposal;
    card.tune.teamSelect.value = "custom";
    card.tune.teamSelect.dispatchEvent(new Event("change"));
    for (const [role, selected] of [
      ["planner", proposal.planner],
      ["writer", proposal.writer],
      ["reviewer", proposal.reviewers?.[0]],
    ]) {
      if (!selected || !card.tune.roles[role]) continue;
      card.tune.roles[role].providerSelect.value = selected.provider;
      card.tune.roles[role].modelInput.value = selected.model;
    }
    card.tune.profileSelect.value = proposal.profile === "long" ? "long" : "normal";
    card.tune.profileSelect.dispatchEvent(new Event("change"));
    card.meta.textContent = `${proposal.actor} 提案 · 尚未批准`;
  }

  const actions = element("div", "card-actions");
  card.runButton = element("button", "primary", "▶ RUN");
  card.dismissButton = element("button", "", "略過");
  actions.append(card.runButton, card.dismissButton, element("span", "hint", "尚未修改任何檔案；執行前會建立安全分支"));
  card.append(actions);
  card.actions = actions;

  card.runButton.addEventListener("click", () => { void startRun(card, input); });
  card.dismissButton.addEventListener("click", async () => {
    if (input.requestId) {
      try {
        await api("/api/workflow-requests/resolve", {
          method: "POST",
          body: JSON.stringify({ id: input.requestId, decision: "declined" }),
        });
      } catch (error) {
        appendNote(`無法更新提案狀態：${humanError(error)}`);
        return;
      }
    }
    card.stateLabel.textContent = "已略過";
    card.stateLabel.className = "state";
    card.runButton.disabled = true;
    card.dismissButton.disabled = true;
  });

  updateFacts(card);
  byId("chat-messages").append(card);
  scrollStream();
  return card;
}

/* ---------- run lifecycle ---------- */

function restoreProposalCard(card, note) {
  card.stateLabel.textContent = "待確認";
  card.stateLabel.className = "state pending";
  card.runButton.disabled = false;
  card.dismissButton.disabled = false;
  if (note) appendNote(note);
}

async function startRun(card, input) {
  if (state.activeRun) {
    appendNote("已有工作流執行中，請先等它結束或取消。");
    return;
  }
  const team = cardTeam(card);
  const soft = cardSoftLimits(card);
  const mode = card.tune.modeSelect.value;
  const tester = card.tune.testerControls;
  const testProfileId = tester?.testSelect.value || "";
  const usesLive = [team.planner, team.writer, ...team.reviewers].some((item) => item.provider !== "fake");
  const profile = card.tune.profileSelect.value;

  const payload = {
    workspace: input.workspace,
    workspaceMode: mode,
    worktreeConfirmed: mode === "worktree",
    dirtySnapshotConfirmed: mode === "worktree" && card.tune.dirtySnapshotConfirm.checked,
    task: input.task,
    ...(input.acceptanceCriteria ? { acceptanceCriteria: input.acceptanceCriteria } : {}),
    profile,
    ...(profile === "custom" ? { softLimits: soft } : {}),
    planner: team.planner,
    writer: team.writer,
    ...(card.tune.fallbackConfirm.checked && team.writer.provider !== "codex"
      ? {
          fallbackWriter: {
            role: "writer",
            provider: "codex",
            model: "gpt-5.6-sol",
            authMode: "subscription",
          },
        }
      : {}),
    reviewers: team.reviewers,
    ...(testProfileId ? { testProfileId } : {}),
    testConfirmed: Boolean(testProfileId) && Boolean(tester?.testConfirm.checked),
    apiModeConfirmed: false,
    apiMaxCostUsdPerCall: 0,
    apiBudgetUsdPerRun: 0,
  };

  try {
    if (testProfileId && !payload.testConfirmed) throw new Error("執行隔離測試前必須勾選同意。");
    if (usesLive && !window.confirm("即將使用已登入的 AI 訂閱額度執行 coding team。變更只會進入本機安全分支，不會自動合併或上傳。確定開始嗎？")) {
      return;
    }
    card.runButton.disabled = true;
    card.dismissButton.disabled = true;
    card.stateLabel.textContent = "準備中";

    if (payload.dirtySnapshotConfirmed) {
      const approval = await api("/api/approvals", {
        method: "POST",
        body: JSON.stringify({
          action: "import-dirty-snapshot",
          confirmation: "APPROVE DIRTY SNAPSHOT",
          workflow: payload,
        }),
      });
      const snapshot = approval.snapshot;
      const snapshotApproved = Boolean(snapshot) && window.confirm(
        `已捕捉 ${snapshot.files} 個檔案（寫入 ${snapshot.writes}、刪除 ${snapshot.deletes}，${snapshot.totalBytes} bytes）。\n` +
        "內容只在 RAM 保存約 2 分鐘，將匯入安全分支；主專案不會被修改。繼續嗎？",
      );
      if (!snapshotApproved) {
        restoreProposalCard(
          card,
          snapshot
            ? "已取消，主專案與安全分支都沒有變更。提案卡已還原，隨時可以再按一次 RUN。"
            : "沒有可匯入的未提交變更快照，已取消；主專案與安全分支都沒有變更。提案卡已還原。",
        );
        return;
      }
      payload.dirtySnapshotId = snapshot.id;
      payload.dirtySnapshotApproval = approval.token;
    }
    if (mode === "worktree") {
      const approval = await api("/api/approvals", {
        method: "POST",
        body: JSON.stringify({ action: "create-worktree", confirmation: "APPROVE WORKTREE", workflow: payload }),
      });
      payload.worktreeApproval = approval.token;
    }
    if (testProfileId) {
      const approval = await api("/api/approvals", {
        method: "POST",
        body: JSON.stringify({ action: "run-test", confirmation: "APPROVE TEST", workflow: payload }),
      });
      payload.testApproval = approval.token;
    }

    const started = await api("/api/runs", { method: "POST", body: JSON.stringify(payload) });
    if (input.requestId) {
      try {
        await api("/api/workflow-requests/resolve", {
          method: "POST",
          body: JSON.stringify({ id: input.requestId, decision: "accepted" }),
        });
      } catch (error) {
        appendNote(`工作已開始，但待辦狀態未能更新：${humanError(error)}`);
      }
    }
    beginMonitoring(card, started.runId, soft);
  } catch (error) {
    card.stateLabel.textContent = "未能開始";
    card.stateLabel.className = "state failed";
    card.runButton.disabled = false;
    card.dismissButton.disabled = false;
    appendNote(humanError(error));
  }
}

function beginMonitoring(card, runId, soft) {
  card.dataset.kind = "run";
  card.stateLabel.textContent = "● 執行中";
  card.stateLabel.className = "state running";
  card.meta.textContent = `run ${runId.slice(0, 8)}`;
  card.querySelector("details.tune")?.remove();
  card.actions.textContent = "";

  const progress = element("div", "run-progress");
  const roundsLabel = element("div", "bar-label");
  roundsLabel.append(element("span", "", "回合"), element("span", "", `0 / ${soft.maxRounds}`));
  const roundsBar = element("div", "bar");
  const roundsFill = document.createElement("i");
  roundsBar.append(roundsFill);
  const callsLabel = element("div", "bar-label");
  callsLabel.append(element("span", "", "模型呼叫"), element("span", "", `0 / ${soft.maxProviderCalls}`));
  const callsBar = element("div", "bar");
  const callsFill = document.createElement("i");
  callsBar.append(callsFill);
  progress.append(roundsLabel, roundsBar, callsLabel, callsBar);
  card.insertBefore(progress, card.actions);

  const events = element("div", "run-events");
  card.insertBefore(events, card.actions);

  const pauseButton = element("button", "", "暫停");
  const resumeButton = element("button", "", "繼續");
  resumeButton.disabled = true;
  const cancelButton = element("button", "danger", "取消");
  const diffButton = element("button", "", "查看變更");
  const applyBackButton = element("button", "", "套用回主專案");
  applyBackButton.hidden = true;
  card.actions.append(pauseButton, resumeButton, cancelButton, diffButton, applyBackButton);

  const run = {
    id: runId,
    card,
    soft,
    after: 0,
    poll: null,
    cancelArmedUntil: 0,
    stats: { branch: "", changedFiles: 0, changedLines: 0 },
    finished: false,
  };
  state.activeRun = run;

  const action = async (name) => {
    try {
      await api(`/api/runs/${name}`, { method: "POST", body: JSON.stringify({ runId }) });
      return true;
    } catch (error) {
      appendNote(humanError(error));
      return false;
    }
  };
  pauseButton.addEventListener("click", async () => {
    if (await action("pause")) {
      pauseButton.disabled = true;
      resumeButton.disabled = false;
    }
  });
  resumeButton.addEventListener("click", async () => {
    if (await action("resume")) {
      pauseButton.disabled = false;
      resumeButton.disabled = true;
    }
  });
  cancelButton.addEventListener("click", async () => {
    if (run.cancelArmedUntil > Date.now()) {
      run.cancelArmedUntil = 0;
      cancelButton.textContent = "取消中…";
      await action("cancel");
    } else {
      run.cancelArmedUntil = Date.now() + 5_000;
      cancelButton.textContent = "再按一次確認取消";
      setTimeout(() => {
        if (run.cancelArmedUntil <= Date.now() && !run.finished) cancelButton.textContent = "取消";
      }, 5_100);
    }
  });
  diffButton.addEventListener("click", () => { void toggleDiff(card, runId); });
  let applyBackDone = false;
  const runApplyBackFlow = async () => {
    if (applyBackButton.disabled || applyBackDone) return;
    applyBackButton.disabled = true;
    try {
      const prepared = await api("/api/apply-back/prepare", {
        method: "POST",
        body: JSON.stringify({ runId }),
      });
      const preview = prepared.preview;
      const rows = preview.changes
        .map((change) => `${change.operation === "delete" ? "移到 trash-pending" : "寫入"}：${change.path}`)
        .join("\n");
      const accepted = window.confirm(
        `協作完成，是否把安全分支套用回主專案？\n\n${rows}\n\n共 ${preview.files} 檔、${preview.totalBytes} bytes。` +
        "\n來源與分支若有任何變動會自動阻斷；刪除只會移到 ~/trash-pending。" +
        "\n\n按「確定」套用回；按「取消」先保留（之後可再按「套用回主專案」）。",
      );
      if (!accepted) {
        applyBackButton.disabled = false;
        appendNote("先保留在安全分支；需要時再按「套用回主專案」。");
        return;
      }
      const applied = await api("/api/apply-back/apply", {
        method: "POST",
        body: JSON.stringify({ previewId: preview.id, confirmation: "APPLY BACK TO SOURCE" }),
      });
      applyBackDone = true;
      applyBackButton.textContent = "已套用回主專案";
      appendNote(
        `已安全套用 ${applied.result.writes} 個寫入；${applied.result.deletesMovedToTrash} 個刪除已移到 trash-pending。`,
      );
    } catch (error) {
      applyBackButton.disabled = false;
      appendNote(humanError(error));
    }
  };
  applyBackButton.addEventListener("click", () => { void runApplyBackFlow(); });
  card.autoApplyBack = runApplyBackFlow;

  const addEvent = (event) => {
    const row = element("div", `ev ${event.status}`);
    const time = new Date(event.at).toLocaleTimeString("zh-TW", { hour12: false });
    row.append(element("time", "", time), element("span", "", event.summary));
    events.append(row);
    events.scrollTop = events.scrollHeight;
    if (event.type === "worktree.created" && event.metadata?.branch) {
      run.stats.branch = String(event.metadata.branch);
    }
    if (event.type === "git.diff" && event.metadata) {
      run.stats.changedFiles = Number(event.metadata.changedFiles || 0);
      run.stats.changedLines = Number(event.metadata.changedLines || 0);
    }
  };

  const poll = async () => {
    try {
      const value = await api(`/api/events?runId=${encodeURIComponent(runId)}&after=${run.after}`);
      let terminal = "";
      for (const event of value.events) {
        if (event.id !== undefined) run.after = Math.max(run.after, event.id);
        addEvent(event);
        if (["workflow.completed", "workflow.failed", "workflow.cancelled"].includes(event.type)) {
          terminal = event.type;
        }
      }
      try {
        const usage = await api(`/api/view?runId=${encodeURIComponent(runId)}&kind=usage`);
        const counters = usage.run.counters;
        roundsLabel.lastChild.textContent = `${counters.rounds} / ${soft.maxRounds}`;
        callsLabel.lastChild.textContent = `${counters.providerCalls} / ${soft.maxProviderCalls}`;
        roundsFill.style.width = `${Math.min(100, (counters.rounds / soft.maxRounds) * 100)}%`;
        callsFill.style.width = `${Math.min(100, (counters.providerCalls / soft.maxProviderCalls) * 100)}%`;
        if (terminal) finalize(terminal, usage.run.errorCode || "");
      } catch {
        if (terminal) finalize(terminal, "");
      }
    } catch (error) {
      byId("connection").textContent = `本機連線錯誤：${humanError(error)}`;
      byId("connection").className = "conn error";
    }
  };

  const finalize = (terminalType, errorCode) => {
    if (run.finished) return;
    run.finished = true;
    clearInterval(run.poll);
    state.activeRun = null;
    pauseButton.remove();
    resumeButton.remove();
    cancelButton.remove();
    if (terminalType === "workflow.completed") {
      card.stateLabel.className = "state done";
      card.stateLabel.textContent = `✓ 完成 · ${run.stats.changedFiles} 檔 · ${run.stats.changedLines} 行變更`;
      appendNote(run.stats.branch
        ? `變更保留在本機分支 ${run.stats.branch}，未自動合併；按「查看變更」檢視內容。`
        : "工作流完成。");
      if (run.stats.branch) {
        applyBackButton.hidden = false;
        // Proactively ask whether to apply back (or wait); the button stays for later.
        setTimeout(() => { void card.autoApplyBack?.(); }, 400);
      }
    } else if (terminalType === "workflow.cancelled") {
      card.stateLabel.className = "state failed";
      card.stateLabel.textContent = "已取消";
    } else {
      card.stateLabel.className = "state failed";
      card.stateLabel.textContent = "✗ 失敗";
      if (errorCode) appendNote(humanError(new Error(errorCode)));
    }
  };

  run.poll = setInterval(poll, 750);
  void poll();
  scrollStream();
}

async function toggleDiff(card, runId) {
  const existing = card.querySelector("pre.diff");
  if (existing) {
    existing.remove();
    return;
  }
  const pre = element("pre", "diff", "讀取變更中…");
  card.append(pre);
  try {
    const value = await api(`/api/view?runId=${encodeURIComponent(runId)}&kind=diff`);
    pre.textContent = value.diff || "沒有變更內容。";
  } catch (error) {
    pre.textContent = `無法讀取變更：${humanError(error)}`;
  }
  scrollStream();
}

/* ---------- bootstrap ---------- */

function renderWorkspaceRoots(roots, selectedPath = "") {
  state.workspaceRoots = Array.isArray(roots) ? roots : [];
  const workspaceSelect = byId("chat-workspace");
  workspaceSelect.textContent = "";
  if (state.workspaceRoots.length === 0) {
    workspaceSelect.append(new Option("尚未授權專案（按下方新增）", ""));
    byId("chat-send").disabled = true;
    return;
  }
  for (const root of state.workspaceRoots) workspaceSelect.append(new Option(root.label, root.path));
  if (selectedPath && state.workspaceRoots.some((root) => root.path === selectedPath)) {
    workspaceSelect.value = selectedPath;
  }
  byId("chat-send").disabled = false;
}

async function bootstrap() {
  const value = await api("/api/bootstrap");
  state.csrf = value.csrf;
  state.providers = value.providers;
  state.testerProfiles = value.testerProfiles || [];
  state.recoverableCheckpoints = value.recoverableCheckpoints || [];
  state.workspaceRoots = value.workspaceRoots || [];
  state.hardLimits = value.hardLimits;
  state.pendingWorkflowRequests = value.pendingWorkflowRequests || [];

  renderWorkspaceRoots(state.workspaceRoots);
  if (state.workspaceRoots.length === 0) {
    appendMessage("error", "尚未授權任何專案。按左側「＋ 新增專案」，可選擇資料夾或輸入路徑。");
  }

  const providerSelect = byId("chat-provider");
  providerSelect.textContent = "";
  for (const provider of state.providers) {
    if (!provider.subscription) continue;
    const presentation = PROVIDER_PRESENTATION[provider.id];
    if (!presentation) continue;
    providerSelect.append(new Option(presentation.label, provider.id));
  }
  providerSelect.value = "codex";
  const secondSelect = byId("second-provider");
  secondSelect.textContent = "";
  for (const provider of state.providers) {
    if (!provider.subscription) continue;
    const presentation = PROVIDER_PRESENTATION[provider.id];
    if (presentation) secondSelect.append(new Option(presentation.label, provider.id));
  }
  secondSelect.value = "claude";
  await Promise.all([loadChatModels(), loadSecondModels()]);

  if (Array.isArray(value.pendingWorkspaceRequests) && value.pendingWorkspaceRequests.length > 0) {
    appendNote(`⏳ 有 ${value.pendingWorkspaceRequests.length} 件授權申請待批准——在終端執行 orchestrator workspaces approve（或在對話輸入 ! orchestrator workspaces approve）。`);
  }
  if (state.pendingWorkflowRequests.length > 0) {
    appendNote(`⏳ 收到 ${state.pendingWorkflowRequests.length} 件 coding workflow 提案。以下提案尚未批准、未啟動，也尚未使用模型額度。`);
    for (const request of state.pendingWorkflowRequests) {
      appendProposalCard({
        requestId: request.id,
        task: request.task,
        acceptanceCriteria: request.acceptanceCriteria,
        workspace: request.workspace,
        proposal: request,
      });
    }
  }
  byId("connection").textContent = "本機安全連線";
  byId("connection").classList.add("ready");
  byId("chat-input").focus();
}

byId("chat-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void submitChat();
});
byId("chat-input").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    void submitChat();
  }
});
byId("new-chat").addEventListener("click", async () => {
  if (state.chatBusy) return;
  try {
    const value = await api("/api/chat/reset", { method: "POST", body: "{}" });
    appendNote("已清除暫存對話內容（模型呼叫計數不重設）。");
    if (value.status) updateChatUsage(value.status);
    byId("chat-input").focus();
  } catch (error) {
    appendMessage("error", humanError(error));
  }
});
function resetWorkspaceOnboarding() {
  state.workspacePreview = null;
  byId("workspace-onboarding-start").hidden = false;
  byId("workspace-onboarding-preview").hidden = true;
  byId("workspace-onboarding-success").hidden = true;
  byId("workspace-onboarding-status").textContent = "";
  byId("workspace-confirmation").value = "";
  byId("workspace-path").value = "";
  byId("workspace-confirm").textContent = "確認加入專案";
  byId("workspace-confirm").disabled = true;
}

function openWorkspaceOnboarding() {
  state.workspaceReturnFocus = document.activeElement;
  resetWorkspaceOnboarding();
  byId("workspace-onboarding").hidden = false;
  document.body.classList.add("workspace-modal-open");
  byId("workspace-pick").focus();
}

function closeWorkspaceOnboarding() {
  byId("workspace-onboarding").hidden = true;
  document.body.classList.remove("workspace-modal-open");
  state.workspacePreview = null;
  state.workspaceReturnFocus?.focus?.();
  state.workspaceReturnFocus = null;
}

function renderWorkspacePreview(preview) {
  state.workspacePreview = preview;
  byId("workspace-onboarding-start").hidden = true;
  byId("workspace-onboarding-preview").hidden = false;
  byId("workspace-onboarding-success").hidden = true;
  byId("workspace-preview-label").textContent = preview.label;
  byId("workspace-preview-path").textContent = preview.canonicalPath;
  const stateLabel = byId("workspace-preview-state");
  stateLabel.textContent = preview.blocked ? "無法加入" : "安全檢查完成";
  stateLabel.classList.toggle("is-blocked", preview.blocked);
  const checks = byId("workspace-preview-checks");
  checks.textContent = "";
  for (const check of preview.checks) {
    const row = document.createElement("div");
    row.className = `workspace-preview-check is-${check.status}`;
    const icon = document.createElement("i");
    icon.textContent = check.status === "pass" ? "✓" : check.status === "warning" ? "!" : "×";
    const label = document.createElement("b");
    label.textContent = check.label;
    const detail = document.createElement("span");
    detail.textContent = check.detail;
    row.append(icon, label, detail);
    checks.append(row);
  }
  byId("workspace-confirm-area").hidden = preview.blocked;
  byId("workspace-confirmation-phrase").textContent = preview.confirmation;
  byId("workspace-confirmation").value = "";
  byId("workspace-confirm").disabled = true;
  byId("workspace-onboarding-status").textContent = preview.blocked
    ? "這個位置沒有通過 Web 快速加入規則；授權未變更。"
    : preview.resolvedSymlink
      ? "已顯示符號連結的實際位置；請確認後再加入。"
      : "確認前不會修改 workspace allowlist。";
  byId("workspace-preview-back").focus();
}

async function previewWorkspacePath(path) {
  byId("workspace-onboarding-status").textContent = "正在檢查路徑、Git 與權限…";
  try {
    const value = await api("/api/workspaces/preview", {
      method: "POST",
      body: JSON.stringify({ path }),
    });
    renderWorkspacePreview(value.preview);
  } catch (error) {
    byId("workspace-onboarding-status").textContent = humanError(error);
  }
}

byId("request-workspace").addEventListener("click", openWorkspaceOnboarding);
byId("workspace-onboarding-close").addEventListener("click", closeWorkspaceOnboarding);
byId("workspace-success-done").addEventListener("click", closeWorkspaceOnboarding);
byId("workspace-preview-back").addEventListener("click", () => {
  resetWorkspaceOnboarding();
  byId("workspace-pick").focus();
});
byId("workspace-onboarding").addEventListener("click", (event) => {
  if (event.target === byId("workspace-onboarding")) closeWorkspaceOnboarding();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !byId("workspace-onboarding").hidden) closeWorkspaceOnboarding();
});
byId("workspace-path-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const path = byId("workspace-path").value.trim();
  if (path) void previewWorkspacePath(path);
});
byId("workspace-pick").addEventListener("click", async () => {
  const button = byId("workspace-pick");
  button.disabled = true;
  byId("workspace-onboarding-status").textContent = "請在 macOS 視窗選擇 Git 專案資料夾…";
  try {
    const value = await api("/api/workspaces/pick", { method: "POST", body: "{}" });
    if (value.cancelled) {
      byId("workspace-onboarding-status").textContent = "已取消，授權沒有變更。";
    } else renderWorkspacePreview(value.preview);
  } catch (error) {
    byId("workspace-onboarding-status").textContent = humanError(error);
  } finally {
    button.disabled = false;
  }
});
byId("workspace-confirmation").addEventListener("input", () => {
  byId("workspace-confirm").disabled = !state.workspacePreview ||
    byId("workspace-confirmation").value !== state.workspacePreview.confirmation;
});
byId("workspace-confirm").addEventListener("click", async () => {
  const preview = state.workspacePreview;
  if (!preview || preview.blocked) return;
  const confirmation = byId("workspace-confirmation").value;
  const button = byId("workspace-confirm");
  button.disabled = true;
  button.textContent = "加入中…";
  byId("workspace-onboarding-status").textContent = "正在重新驗證路徑並寫入 owner-only allowlist…";
  try {
    const value = await api("/api/workspaces/confirm", {
      method: "POST",
      body: JSON.stringify({ previewId: preview.id, confirmation }),
    });
    const bootstrapValue = await api("/api/bootstrap");
    renderWorkspaceRoots(bootstrapValue.workspaceRoots || [], value.root.path);
    byId("workspace-onboarding-preview").hidden = true;
    byId("workspace-onboarding-success").hidden = false;
    byId("workspace-success-path").textContent = value.root.path;
    byId("workspace-onboarding-status").textContent = "";
    appendNote(`已安全加入專案：${value.root.label}`);
    byId("workspace-success-done").focus();
  } catch (error) {
    state.workspacePreview = null;
    byId("workspace-onboarding-status").textContent = humanError(error);
    button.textContent = "重新檢查後再加入";
  }
});
byId("chat-workspace").addEventListener("change", () => {
  appendNote("已切換專案；下一則訊息會開啟新的對話內容（呼叫計數不重設）。");
});
byId("second-provider").addEventListener("change", async () => {
  await loadSecondModels();
  appendNote(`第二意見代理將自下一則訊息起改為 ${byId("second-provider").value} · ${byId("second-model").value}。`);
});
byId("second-model").addEventListener("change", () => {
  appendNote(`第二意見模型將自下一則訊息起改為 ${byId("second-model").value}。`);
});
byId("chat-provider").addEventListener("change", async () => {
  await loadChatModels();
  if (byId("second-provider").value === byId("chat-provider").value) {
    byId("second-provider").value = byId("chat-provider").value === "claude" ? "codex" : "claude";
    await loadSecondModels();
    appendNote(`第二意見代理自動改為 ${byId("second-provider").value}（避免與主代理重複）。`);
  }
  appendNote(`主代理將自下一則訊息起切換為 ${byId("chat-provider").value} · ${byId("chat-model").value}；對話歷史保留。`);
});
byId("chat-model").addEventListener("change", () => {
  updateAgentRail();
  appendNote(`模型將自下一則訊息起切換為 ${byId("chat-model").value}；對話歷史保留。`);
});

bootstrap().catch((error) => {
  byId("connection").textContent = `本機連線失敗：${humanError(error)}`;
  byId("connection").className = "conn error";
});
