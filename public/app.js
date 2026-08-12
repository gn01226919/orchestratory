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
  applyBack: {
    runId: "",
    preview: null,
    /* 確認短語只能來自後端；留白啟動，拿不到就不可核准。 */
    phrase: "",
    diffText: "",
    diffState: "idle",
    diffError: "",
    blockers: [],
    scrolled: false,
    decided: false,
    applying: false,
    expiredRendered: false,
    ticker: null,
    returnFocus: null,
    onApplied: null,
  },
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

/* @pure-start provider-cost
 * Provider 計費模型的鏡像（瀏覽器側）。
 *
 * 這份清單必須與 src/providers/billing.ts 的 PROVIDER_BILLING_MODEL 裡所有標成
 * no-cost 的 provider 逐字一致。瀏覽器無法 import TypeScript，所以由 test/web.test.ts
 * 直接讀這個檔案與那張表比對——任何一邊改了而另一邊沒改都會讓測試失敗。
 *
 * 不要在別處再寫第二份清單。GUI 曾經只硬寫死排除 fake，於是地端模型（local）被開放成
 * 可選的 planner／reviewer 之後，確認框仍然對使用者說「即將使用已登入的 AI 訂閱額度」，
 * 而使用者選 local 的核心理由正是不花額度。 */
const NO_COST_PROVIDER_IDS = Object.freeze(["fake", "local"]);

function isNoCostProvider(providerId) {
  return NO_COST_PROVIDER_IDS.includes(String(providerId));
}

/* 團隊裡只要有一個會計費的 provider，這次執行就會動用訂閱／API 額度。 */
function teamUsesPaidQuota(members) {
  return (Array.isArray(members) ? members : [])
    .some((member) => !isNoCostProvider(member && typeof member === "object" ? member.provider : member));
}

/* 提案卡「額度」那一列描述整個團隊，不只 Writer。 */
function quotaFactValue(members) {
  return teamUsesPaidQuota(members) ? "訂閱" : "不使用";
}

/*
 * 執行 coding team 前要不要攔一次、攔的時候要說什麼。
 * 回傳空字串＝這次執行不花任何額度，不需要也不應該彈出「會使用訂閱額度」的確認。
 * 訊息本身寫在這裡而不是寫在呼叫點，測試才能直接執行它、對文案本身下斷言。
 */
function runConsentMessage(members) {
  return teamUsesPaidQuota(members)
    ? "即將使用已登入的 AI 訂閱額度執行 coding team。變更只會進入本機安全分支，不會自動合併或上傳。確定開始嗎？"
    : "";
}

/* 同上，用於對話的第一次呼叫。地端模型與測試模型都不需要額度確認。 */
function chatConsentMessage(providerId) {
  return isNoCostProvider(providerId)
    ? ""
    : "即將呼叫已登入的訂閱 CLI，會使用你的訂閱額度。只會傳送已授權專案與這個對話所需的受限內容。確定繼續嗎？";
}
/* @pure-end provider-cost */

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
    APPLY_BACK_RUN_NOT_COMPLETED: "這個工作流還沒完成，不能回寫主專案。",
    APPLY_BACK_NOT_FOUND_OR_EXPIRED: "這份回寫預覽已失效或逾時，請按「重新產生預覽」再問一次；主專案沒有被修改。",
    APPLY_BACK_PENDING_LIMIT_REACHED: "待處理的回寫預覽太多，請先完成或等既有預覽逾時。",
    APPLY_BACK_CONFIRMATION_MISMATCH: "確認短語不相符；主專案沒有被修改。",
    APPLY_BACK_SOURCE_CHANGED: "主專案在預覽之後被改動過，回寫已阻斷。請重新產生預覽。",
    APPLY_BACK_SOURCE_HEAD_CHANGED: "主專案的 Git HEAD 在預覽之後改變，回寫已阻斷。請重新產生預覽。",
    APPLY_BACK_SOURCE_FILE_CHANGED: "有檔案在預覽之後被改動，逐檔比對失敗，回寫已阻斷。請重新產生預覽。",
    APPLY_BACK_WORKTREE_HEAD_CHANGED: "安全分支的 Git HEAD 在預覽之後改變，回寫已阻斷。",
    APPLY_BACK_WORKTREE_BASE_MISMATCH: "安全分支與主專案的基準 commit 不一致，回寫已阻斷。",
    APPLY_BACK_PREVIEW_TAMPERED: "預覽摘要與後端記錄不符，回寫已阻斷。",
    APPLY_BACK_STATE_CHANGED: "回寫前的狀態重新驗證失敗，已阻斷；主專案沒有被部分寫入。",
    APPLY_BACK_PARTIAL_ROLLBACK_FAILED: "回寫失敗且自動回復也失敗。請不要再操作，先用對話框裡的還原指令檢查主專案狀態。",
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
  const consentMessage = state.chatConsent ? "" : chatConsentMessage(provider);
  if (consentMessage) {
    if (!window.confirm(consentMessage)) return;
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
  /* 這一列描述整個團隊，不只 Writer：planner／reviewer 用 no-cost provider 時也不該說要花額度。 */
  fact("額度", quotaFactValue([team.planner, team.writer, ...team.reviewers]));
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
  const runConsent = runConsentMessage([team.planner, team.writer, ...team.reviewers]);
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
    if (runConsent && !window.confirm(runConsent)) return;
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
  /*
   * 這條路徑以前是一個 window.confirm 就寫回主專案：沒有風險等級、沒有變更內容、沒有短語。
   * 現在一律走 in-page 核准對話框，與 room.js 的 merge approval 同一套摩擦（P0-3）。
   */
  const openApplyBack = async () => {
    if (applyBackDone) return;
    await openApplyBackApproval(runId, () => {
      applyBackDone = true;
      applyBackButton.disabled = true;
      applyBackButton.classList.remove("primary");
      applyBackButton.textContent = "已套用回主專案";
    });
  };
  applyBackButton.addEventListener("click", () => { void openApplyBack(); });
  card.autoApplyBack = openApplyBack;

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
        applyBackButton.classList.add("primary");
        /*
         * 不自動開啟核准對話框：preview TTL 只有 120 秒，在使用者還沒看結果前就開始倒數
         * 幾乎一定逾時；而且最高風險動作不該在沒人要求時自己跳出來。
         */
        appendNote("要寫回主專案時按「套用回主專案」：對話框會逐條列出風險、顯示要寫回的內容，捲到底並輸入 MERGE INTO MAIN 才會解鎖。");
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

/* ---------- apply-back approval dialog (main workspace) ---------- */

/*
 * 主工作區的 apply-back 與 Room 的 merge approval 是同一件事：把隔離 worktree 的變更寫回
 * 主專案，而且不可逆。room.js 那條路徑要求捲完整份變更、輸入 MERGE INTO MAIN、看得到 TTL
 * 倒數，而且阻擋項會壓住主要按鈕；這一條以前只有一個 window.confirm。同一個產品裡兩條
 * 寫回主專案的路徑一嚴一鬆，比任一端的絕對嚴格度更傷害信任，所以這裡採用同一套語意、
 * 同一組短語與同一個 .workspace-onboarding／.merge-approval 元件，不另立設計語言。
 * 原生對話框在這條路徑上一律不使用：它可被瀏覽器永久靜音，開啟期間頁面凍結，
 * 而 preview TTL 只有 120 秒——倒數在它底下物理上不可能顯示。
 */

/* @pure-start apply-back-gate
 * 這一段刻意不碰 DOM、不碰網路，只做輸入→輸出的判斷，好讓 test/web.test.ts 直接執行它、
 * 對行為本身下斷言，而不是對「原始碼裡有沒有某一行字串」下斷言。 */
const APPLY_BACK_CONFIRMATION_PHRASE = "MERGE INTO MAIN";
const APPLY_BACK_RISK_LABELS = {
  low: "低風險 · LOW",
  medium: "中風險 · MEDIUM",
  high: "高風險 · HIGH",
};

/* 風險等級未知或缺漏時一律當成高風險，不當成低風險。 */
function applyBackRisk(preview, blockerCount) {
  if (Number(blockerCount) > 0) return { key: "high", text: APPLY_BACK_RISK_LABELS.high };
  const risk = preview && typeof preview === "object" ? preview.risk : null;
  const level = risk && typeof risk === "object" ? String(risk.level) : "";
  const text = Object.prototype.hasOwnProperty.call(APPLY_BACK_RISK_LABELS, level)
    ? APPLY_BACK_RISK_LABELS[level]
    : "";
  return text ? { key: level, text } : { key: "high", text: APPLY_BACK_RISK_LABELS.high };
}

function applyBackScrolledToBottom(metrics) {
  const top = Number(metrics ? metrics.scrollTop : Number.NaN);
  const view = Number(metrics ? metrics.clientHeight : Number.NaN);
  const total = Number(metrics ? metrics.scrollHeight : Number.NaN);
  if (!Number.isFinite(top) || !Number.isFinite(view) || !Number.isFinite(total)) return false;
  return top + view >= total - 4;
}

/*
 * 阻擋項＝「在這個狀態下不可以簽名」的理由。全部逐條顯示，並且壓住確認輸入與主要按鈕。
 * 看不到內容就不可核准：變更內容還沒載入或載入失敗，是阻擋項而不是提示。
 */
function applyBackBlockers(view) {
  const blockers = [];
  const preview = view && typeof view === "object" ? view.preview : null;
  if (!preview || typeof preview !== "object") {
    blockers.push("尚未取得預覽，沒有可核准的內容。 · No preview has been fetched yet.");
    return blockers;
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
 * scroll-gate：沒捲到底、還有阻擋項、或這筆已經有結果時，確認輸入框保持 disabled 並清空，
 * 主要按鈕跟著鎖住。「我捲完了」比「我抄完了」更能證明使用者看過內容。
 */
function applyBackGate(view) {
  const blockerCount = Array.isArray(view && view.blockers) ? view.blockers.length : 0;
  const blocked = blockerCount > 0;
  const scrolled = Boolean(view && view.scrolled);
  const decided = Boolean(view && view.decided);
  const ready = !blocked && scrolled && !decided;
  const phrase = view && typeof view.phrase === "string" && view.phrase
    ? view.phrase
    : APPLY_BACK_CONFIRMATION_PHRASE;
  const typed = ready ? String((view && view.typed) || "") : "";
  return {
    ready,
    inputDisabled: !ready,
    inputValue: typed,
    confirmDisabled: !ready || typed !== phrase,
    hint: decided
      ? "這筆回寫已經有結果，不能再決定一次。 · This apply-back has already been decided."
      : blocked
        ? "阻擋區還有項目：確認輸入與「套用回主專案」保持停用。 · Blocking items remain; the confirmation input and the primary button stay disabled."
        : scrolled
          ? `變更內容已捲到底：輸入 ${phrase} 即可解鎖「套用回主專案」。 · Scrolled to the end; type the phrase to enable the primary button.`
          : "請把上面的變更內容捲到底（展開檔案後會重新計算），確認輸入才會解鎖。 · Scroll the change content to the bottom to enable the confirmation input.",
  };
}

function formatApplyBackBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value)) return "—";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function formatApplyBackCountdown(ms) {
  const total = Math.max(0, Math.floor(Number(ms) / 1000));
  const minutes = String(Math.floor(total / 60)).padStart(2, "0");
  const seconds = String(total % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}
/* @pure-end apply-back-gate */

/*
 * 這裡以前有一個 APPLY_BACK_API_CONFIRMATION = "APPLY BACK TO SOURCE"：畫面要 Owner 打
 * MERGE INTO MAIN，送出去的卻是另一句常數，於是後端比對的那句話 Owner 從來沒有打過，
 * 「Owner 打過這句話」不是後端收得到的事實。現在短語由 /api/apply-back/prepare 隨預覽送來
 * （state.applyBack.phrase），畫面印它、比對它、送出的也是 Owner 實際打進輸入框的那一份。
 */
const APPLY_BACK_TRASH_ROOT = "~/trash-pending/orchestratory";
const APPLY_BACK_OPERATION_LABELS = {
  write: "寫入 · Write",
  delete: "移到 trash-pending · Move to trash-pending",
};

function applyBackNode(tag, className, id, text) {
  const node = element(tag, className, text);
  if (id) node.id = id;
  return node;
}

function buildApplyBackDialog() {
  const dialog = applyBackNode("section", "workspace-onboarding merge-approval", "apply-back-approval");
  dialog.hidden = true;
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-labelledby", "apply-back-approval-title");
  const card = element("div", "workspace-onboarding-card merge-approval-card");

  const header = document.createElement("header");
  const heading = document.createElement("span");
  heading.append(
    element("small", "", "APPLY BACK TO THE MAIN PROJECT"),
    applyBackNode("b", "", "apply-back-approval-title", "套用回主專案 · Apply back to the main project"),
  );
  const closeButton = applyBackNode("button", "", "apply-back-close", "×");
  closeButton.type = "button";
  closeButton.setAttribute("aria-label", "關閉套用回主專案");
  header.append(heading, closeButton);

  const head = element("div", "merge-approval-head");
  const identity = element("div", "merge-approval-identity");
  identity.append(
    applyBackNode("em", "merge-approval-risk", "apply-back-risk", "—"),
    applyBackNode("code", "", "apply-back-run", "—"),
  );
  head.append(identity, applyBackNode(
    "p",
    "merge-approval-route",
    "apply-back-route",
    "安全分支 worktree → 主工作區 · safe-branch worktree → main workspace",
  ));

  const risks = applyBackNode("div", "merge-approval-risks", "apply-back-risks");

  const blocking = applyBackNode("section", "merge-approval-blocking", "apply-back-blocking");
  blocking.hidden = true;
  const repreview = applyBackNode("button", "", "apply-back-repreview", "↻ 重新產生預覽 · Re-preview");
  repreview.type = "button";
  blocking.append(
    element("b", "", "無法核准 · Blocking"),
    element("p", "", "下列項目存在期間，確認輸入與「套用回主專案」保持停用。 · While any of these is present the confirmation input and the primary button stay disabled."),
    applyBackNode("ul", "", "apply-back-blockers"),
    repreview,
  );

  const stats = applyBackNode("div", "merge-approval-stats", "apply-back-stats");
  const diffLabel = element(
    "p",
    "merge-approval-diff-label",
    "要寫回的變更（請捲到底） · Changes to be written back (scroll to the bottom)",
  );
  const diff = applyBackNode("div", "merge-approval-diff", "apply-back-diff");
  diff.tabIndex = 0;

  const recovery = element("section", "merge-approval-recovery");
  const copy = applyBackNode("button", "", "apply-back-copy", "⧉ 複製還原指令 · Copy restore command");
  copy.type = "button";
  recovery.append(
    element("b", "", "復原點 · Recovery point"),
    applyBackNode("div", "merge-approval-recovery-facts", "apply-back-recovery-facts"),
    applyBackNode("code", "", "apply-back-restore", ""),
    element("small", "", `刪除只會移到 ${APPLY_BACK_TRASH_ROOT}，不會永久刪除；Orchestratory 不會替你執行還原指令。 · Deletions are moved to trash-pending, never permanently deleted; Orchestratory does not run the restore command for you.`),
    copy,
  );

  const ttl = element("div", "merge-approval-ttl");
  const ttlText = document.createElement("span");
  ttlText.append(
    element("small", "", "預覽視窗剩餘 · Preview window"),
    applyBackNode("b", "", "apply-back-ttl", "—"),
  );
  const refresh = applyBackNode("button", "", "apply-back-refresh", "↻ 重新產生預覽 · Re-preview");
  refresh.type = "button";
  ttl.append(ttlText, refresh);

  const confirmArea = applyBackNode("div", "", "apply-back-confirm-area");
  const label = document.createElement("label");
  label.htmlFor = "apply-back-confirmation";
  label.append(
    document.createTextNode("輸入 "),
    /* 空字串起始：這句話由後端隨預覽送來，前端沒有一份自己的文案可以先印上去。 */
    applyBackNode("code", "", "apply-back-phrase", ""),
    document.createTextNode(" 確認把變更寫回主專案 · type the phrase to confirm"),
  );
  const input = applyBackNode("input", "", "apply-back-confirmation");
  input.type = "text";
  input.maxLength = 64;
  input.autocomplete = "off";
  input.spellcheck = false;
  input.disabled = true;
  confirmArea.append(
    label,
    input,
    applyBackNode("p", "merge-approval-scroll-hint", "apply-back-scroll-hint", ""),
  );

  const actions = element("div", "workspace-onboarding-actions merge-approval-actions");
  const cancel = applyBackNode("button", "", "apply-back-cancel", "取消 · Cancel");
  cancel.type = "button";
  const confirmButton = applyBackNode("button", "danger", "apply-back-confirm", "套用回主專案 · Apply back to main");
  confirmButton.type = "button";
  confirmButton.disabled = true;
  actions.append(cancel, confirmButton);

  const status = applyBackNode("p", "workspace-onboarding-status", "apply-back-status", "");
  status.setAttribute("aria-live", "polite");

  card.append(header, head, risks, blocking, stats, diffLabel, diff, recovery, ttl, confirmArea, actions, status);
  dialog.append(card);
  document.body.append(dialog);
  return dialog;
}

function ensureApplyBackDialog() {
  const existing = byId("apply-back-approval");
  if (existing) return existing;
  const dialog = buildApplyBackDialog();
  byId("apply-back-close").addEventListener("click", closeApplyBackApproval);
  byId("apply-back-cancel").addEventListener("click", closeApplyBackApproval);
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) closeApplyBackApproval();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !dialog.hidden) closeApplyBackApproval();
  });
  byId("apply-back-diff").addEventListener("scroll", () => {
    if (applyBackScrolledToBottom(byId("apply-back-diff"))) state.applyBack.scrolled = true;
    updateApplyBackGate();
  });
  /* 展開一個檔案會多出還沒看過的內容，因此重新評估捲動門檻，而不是沿用舊結果。 */
  byId("apply-back-diff").addEventListener("toggle", () => {
    state.applyBack.scrolled = applyBackScrolledToBottom(byId("apply-back-diff"));
    updateApplyBackGate();
  }, true);
  byId("apply-back-confirmation").addEventListener("input", updateApplyBackGate);
  byId("apply-back-confirm").addEventListener("click", () => { void confirmApplyBack(); });
  byId("apply-back-refresh").addEventListener("click", () => { void loadApplyBackPreview(); });
  byId("apply-back-repreview").addEventListener("click", () => { void loadApplyBackPreview(); });
  byId("apply-back-copy").addEventListener("click", async () => {
    const status = byId("apply-back-status");
    try {
      await navigator.clipboard.writeText(byId("apply-back-restore").textContent || "");
      status.textContent = "已複製還原指令；Orchestratory 沒有執行它。 · Restore command copied; Orchestratory did not run it.";
    } catch {
      status.textContent = "瀏覽器不允許自動複製，請手動選取上面的指令。 · Clipboard access was refused; select the command above manually.";
    }
  });
  return dialog;
}

function updateApplyBackGate() {
  const input = byId("apply-back-confirmation");
  const confirmButton = byId("apply-back-confirm");
  const hint = byId("apply-back-scroll-hint");
  if (!input || !confirmButton || !hint) return;
  const view = state.applyBack;
  const gate = applyBackGate({
    blockers: view.blockers,
    scrolled: view.scrolled,
    decided: view.decided,
    typed: input.value,
    /* 後端送來的那一句；沒有就是空字串，而空字串由阻擋項壓住整個 gate。 */
    phrase: view.phrase,
  });
  if (input.value !== gate.inputValue) input.value = gate.inputValue;
  input.disabled = gate.inputDisabled;
  confirmButton.disabled = gate.confirmDisabled;
  hint.textContent = gate.hint;
}

function renderApplyBackRisks(preview) {
  const host = byId("apply-back-risks");
  if (!host) return;
  host.textContent = "";
  const reasons = preview && preview.risk && Array.isArray(preview.risk.reasons)
    ? preview.risk.reasons
    : [];
  const lines = reasons.map((reason) => `風險原因 · Risk reason：${reason}`);
  lines.push("這個動作會直接修改主專案，且不會經過 Git commit；只有刪除可以從 trash-pending 復原。 · This writes into the main project directly; only deletions can be recovered from trash-pending.");
  if (reasons.length === 0) {
    lines.unshift("後端沒有回報任何風險原因；這不等於沒有風險，仍請逐檔檢視下方變更。 · The backend declared no risk reasons; that is not the same as there being none.");
  }
  for (const line of lines) host.append(element("p", "", line));
}

function renderApplyBackStats(preview) {
  const host = byId("apply-back-stats");
  if (!host) return;
  host.textContent = "";
  const entries = [
    ["檔案 · Files", String(preview ? Number(preview.files) : 0)],
    ["寫入 · Writes", String(preview ? Number(preview.writes) : 0)],
    ["移到 trash-pending · Deletes", String(preview ? Number(preview.deletes) : 0)],
    ["內容大小 · Total bytes", formatApplyBackBytes(preview ? preview.totalBytes : Number.NaN)],
    ["基準 commit · Base SHA", preview ? String(preview.baseSha).slice(0, 12) : "—"],
  ];
  for (const [label, value] of entries) {
    const cell = document.createElement("span");
    cell.append(element("small", "", label), element("b", "", value));
    host.append(cell);
  }
}

function renderApplyBackChanges(view) {
  const region = byId("apply-back-diff");
  if (!region) return;
  region.textContent = "";
  const preview = view.preview;
  const changes = preview && Array.isArray(preview.changes) ? preview.changes : [];
  if (!preview) {
    region.append(element("p", "merge-file-empty", "尚未取得預覽。 · No preview yet."));
    return;
  }
  if (changes.length === 0) {
    region.append(element("p", "merge-file-empty", "這份預覽沒有列出任何檔案變更。 · This preview lists no file changes."));
  }
  for (const change of changes) {
    const item = element("details", "merge-file");
    const summary = document.createElement("summary");
    const operation = element("i", `merge-file-op is-${change.operation}`);
    operation.textContent = APPLY_BACK_OPERATION_LABELS[change.operation] || String(change.operation);
    const path = element("b", "", String(change.path));
    const delta = element("em", "merge-file-delta", formatApplyBackBytes(change.bytes));
    summary.append(operation, path, delta);
    const detail = element("div", "merge-file-detail");
    const facts = [
      `動作 · Operation：${APPLY_BACK_OPERATION_LABELS[change.operation] || change.operation}`,
      `大小 · Size：${formatApplyBackBytes(change.bytes)}`,
      change.operation === "delete"
        ? `這個檔案會被移到 ${APPLY_BACK_TRASH_ROOT}，不會永久刪除。 · Moved to trash-pending, not permanently deleted.`
        : "這個檔案會以安全分支的內容寫入主專案；若主專案的內容在預覽後改變，回寫會整批阻斷。 · Written from the safe branch; any drift in the main project blocks the whole apply-back.",
    ];
    for (const fact of facts) detail.append(element("p", "", fact));
    item.append(summary, detail);
    region.append(item);
  }
  region.append(element(
    "p",
    "merge-approval-diff-label",
    "安全分支的逐行變更（後端 bounded 輸出，可能被截斷） · Line-level diff of the safe branch (bounded backend output, may be truncated)",
  ));
  if (view.diffState === "loaded") {
    region.append(element("pre", "apply-back-diff-text", view.diffText));
  } else {
    region.append(element(
      "p",
      "merge-file-truncated",
      view.diffState === "failed"
        ? `變更內容讀取失敗，因此不可核准：${view.diffError || "未知原因"} · The change content failed to load, so this cannot be approved.`
        : "變更內容讀取中… · Loading the change content…",
    ));
  }
  region.append(element("p", "merge-diff-end", "── 變更內容結束 · end of change content ──"));
}

function renderApplyBackRecovery(preview) {
  const host = byId("apply-back-recovery-facts");
  const command = byId("apply-back-restore");
  if (!host || !command) return;
  host.textContent = "";
  const workspace = preview ? String(preview.sourceWorkspace) : "";
  const facts = [
    ["主工作區 · Main workspace", workspace],
    ["基準 commit · Base SHA", preview ? String(preview.baseSha) : ""],
    ["主工作區指紋 · Source fingerprint", preview ? String(preview.sourceFingerprint).slice(0, 16) : ""],
    ["安全分支指紋 · Worktree fingerprint", preview ? String(preview.worktreeFingerprint).slice(0, 16) : ""],
    ["刪除去向 · Deletions go to", APPLY_BACK_TRASH_ROOT],
  ];
  for (const [label, value] of facts) {
    const row = document.createElement("span");
    row.append(element("small", "", label), element("code", "", value || "—"));
    host.append(row);
  }
  const target = workspace || ".";
  command.textContent = [
    `git -C ${target} status --short`,
    `git -C ${target} stash push --include-untracked --message orchestratory-before-restore`,
    `git -C ${target} clean -nd`,
    `ls ${APPLY_BACK_TRASH_ROOT}`,
  ].join("\n");
}

function tickApplyBackTtl() {
  const node = byId("apply-back-ttl");
  const view = state.applyBack;
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
      renderApplyBackApproval();
      byId("apply-back-status").textContent =
        "預覽視窗已逾時；這是刻意的摩擦，不是錯誤。請按「重新產生預覽」再問一次；主專案沒有被修改。 · The preview window expired; re-preview and ask again.";
    }
    return;
  }
  node.textContent = `${formatApplyBackCountdown(remaining)}（${new Date(deadline).toLocaleTimeString("zh-TW", { hour12: false })} 到期 · expires）`;
  node.className = remaining < 30_000 ? "is-urgent" : "";
}

function renderApplyBackApproval() {
  const view = state.applyBack;
  if (!byId("apply-back-approval")) return;
  view.blockers = applyBackBlockers({
    preview: view.preview,
    diffState: view.diffState,
    applying: view.applying,
    now: Date.now(),
  });
  /*
   * 短語只能來自後端。拿不到就不可核准——不得退回前端自帶的一份文案，
   * 那份文案會讓畫面看起來可以按，而後端要的其實是別的字（[[PITFALLS]] #86）。
   */
  if (typeof view.phrase !== "string" || view.phrase.length === 0) {
    view.blockers.push("後端沒有給這次回寫的確認短語，無法確認你要簽的是哪一句。 · The backend supplied no confirmation phrase for this apply-back.");
  }
  const risk = applyBackRisk(view.preview, view.blockers.length);
  const badge = byId("apply-back-risk");
  badge.textContent = risk.text;
  badge.className = `merge-approval-risk is-${risk.key}`;
  byId("apply-back-run").textContent = view.runId ? `run ${view.runId}` : "—";
  /* 短語直接印後端給的值：改掉後端那個值，這一行就跟著變。 */
  byId("apply-back-phrase").textContent = view.phrase || "";
  byId("apply-back-route").textContent = view.preview
    ? `安全分支 worktree → 主工作區 · safe-branch worktree → main workspace：${view.preview.sourceWorkspace}`
    : "安全分支 worktree → 主工作區 · safe-branch worktree → main workspace";
  renderApplyBackRisks(view.preview);
  renderApplyBackStats(view.preview);
  renderApplyBackChanges(view);
  renderApplyBackRecovery(view.preview);
  const blocking = byId("apply-back-blocking");
  const list = byId("apply-back-blockers");
  list.textContent = "";
  blocking.hidden = view.blockers.length === 0;
  for (const blocker of view.blockers) list.append(element("li", "", blocker));
  tickApplyBackTtl();
  /* 內容比視窗短時本來就已經在底部；展開檔案會讓它重新變成未讀完。 */
  view.scrolled = applyBackScrolledToBottom(byId("apply-back-diff"));
  updateApplyBackGate();
}

async function loadApplyBackPreview() {
  const view = state.applyBack;
  const status = byId("apply-back-status");
  view.preview = null;
  view.phrase = "";
  view.diffText = "";
  view.diffError = "";
  view.diffState = "loading";
  view.scrolled = false;
  view.expiredRendered = false;
  renderApplyBackApproval();
  status.textContent = "正在產生預覽並讀取變更內容（唯讀；主專案還沒有被修改）… · Preparing the preview and reading the change content (read-only)…";
  try {
    const prepared = await api("/api/apply-back/prepare", {
      method: "POST",
      body: JSON.stringify({ runId: view.runId }),
    });
    view.preview = prepared.preview;
    /* 短語跟著預覽一起來，而且只跟著它來。 */
    view.phrase = typeof prepared.confirmationPhrase === "string" ? prepared.confirmationPhrase : "";
  } catch (error) {
    view.diffState = "failed";
    view.diffError = humanError(error);
    renderApplyBackApproval();
    status.textContent = `無法產生預覽 · Preview failed：${humanError(error)}`;
    return;
  }
  try {
    const value = await api(`/api/view?runId=${encodeURIComponent(view.runId)}&kind=diff`);
    const diff = typeof value.diff === "string" ? value.diff : "";
    view.diffText = diff;
    view.diffState = diff ? "loaded" : "failed";
    if (!diff) view.diffError = "後端沒有回傳任何變更內容。 · The backend returned no change content.";
  } catch (error) {
    view.diffText = "";
    view.diffState = "failed";
    view.diffError = humanError(error);
  }
  renderApplyBackApproval();
  status.textContent = view.diffState === "loaded"
    ? "這是唯讀預覽；在你捲完內容、輸入短語並按下「套用回主專案」之前，主專案不會被修改。 · Read-only preview; nothing is written until you scroll, type the phrase and press the primary button."
    : `變更內容讀取失敗，因此無法核准：${view.diffError} · The change content failed to load, so this cannot be approved.`;
}

async function openApplyBackApproval(runId, onApplied) {
  const dialog = ensureApplyBackDialog();
  const view = state.applyBack;
  view.returnFocus = document.activeElement;
  view.runId = String(runId || "");
  view.decided = false;
  view.applying = false;
  view.onApplied = typeof onApplied === "function" ? onApplied : null;
  dialog.hidden = false;
  document.body.classList.add("workspace-modal-open");
  byId("apply-back-status").textContent = "";
  if (!view.ticker) view.ticker = setInterval(tickApplyBackTtl, 1000);
  /* 取消是預設焦點：最高風險動作不得預先對準破壞性按鈕。 */
  byId("apply-back-cancel").focus();
  await loadApplyBackPreview();
}

function closeApplyBackApproval() {
  const dialog = byId("apply-back-approval");
  if (!dialog || dialog.hidden) return;
  const view = state.applyBack;
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
  byId("apply-back-confirmation").value = "";
  byId("apply-back-confirmation").disabled = true;
  byId("apply-back-confirm").disabled = true;
  view.returnFocus?.focus?.();
  view.returnFocus = null;
}

async function confirmApplyBack() {
  const view = state.applyBack;
  const status = byId("apply-back-status");
  const input = byId("apply-back-confirmation");
  if (!view.preview || view.blockers.length > 0 || !view.scrolled || view.decided) return;
  /* 送出去的就是 Owner 打的那一句，不是另外一個常數。 */
  if (!view.phrase || input.value !== view.phrase) return;
  const confirmation = input.value;
  const previewId = view.preview.id;
  view.applying = true;
  renderApplyBackApproval();
  status.textContent = "正在重新驗證 source／worktree HEAD、fingerprint 與逐檔 hash… · Re-verifying every bound value before anything is written…";
  try {
    const applied = await api("/api/apply-back/apply", {
      method: "POST",
      body: JSON.stringify({ previewId, confirmation }),
    });
    const result = applied.result || {};
    view.applying = false;
    view.decided = true;
    renderApplyBackApproval();
    const summary = `已套用 ${Number(result.writes || 0)} 個寫入；`
      + `${Number(result.deletesMovedToTrash || 0)} 個刪除已移到 ${APPLY_BACK_TRASH_ROOT}`
      + `${result.trashSession ? `/${result.trashSession}` : ""}（未永久刪除）。`;
    status.textContent = `${summary} · Applied.`;
    appendNote(summary);
    view.onApplied?.(result);
  } catch (error) {
    /* 失敗後這份預覽已不可信：清掉它，強制重新產生預覽、重新捲、重新輸入短語。 */
    view.applying = false;
    view.preview = null;
    view.diffState = "idle";
    view.scrolled = false;
    view.phrase = "";
    renderApplyBackApproval();
    status.textContent = `回寫被拒絕，主專案沒有被部分寫入 · Apply-back refused：${humanError(error)}`;
  }
}

/* ---------- telemetry ---------- */

/**
 * Renders the sentence the server produced, verbatim. The GUI does not compose its own
 * wording: `describeTelemetryConsent` on the server is the only place the sentence exists,
 * so this surface and the TUI cannot end up saying different things about the same state.
 */
function renderTelemetry(telemetry) {
  const label = byId("telemetry-state");
  const dot = byId("telemetry-dot");
  if (!label || !dot) return;
  if (!telemetry) {
    label.textContent = "無法讀取設定，因此不會送出。";
    dot.className = "dot";
    return;
  }
  label.textContent = telemetry.readable
    ? telemetry.description
    : "設定讀不到，因此一律不送。";
  dot.className = telemetry.consent === "yes" && telemetry.readable ? "dot on" : "dot";
  const on = byId("telemetry-on");
  const off = byId("telemetry-off");
  if (on) on.disabled = telemetry.consent === "yes";
  if (off) off.disabled = telemetry.consent === "no";
}

async function setTelemetry(consent) {
  try {
    const value = await api("/api/telemetry", {
      method: "POST",
      body: JSON.stringify({ consent }),
    });
    renderTelemetry(value.telemetry);
  } catch (error) {
    const label = byId("telemetry-state");
    if (label) label.textContent = `無法變更：${error.message}`;
  }
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
  renderTelemetry(value.telemetry);

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

byId("telemetry-on").addEventListener("click", () => setTelemetry("yes"));
byId("telemetry-off").addEventListener("click", () => setTelemetry("no"));
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
