# 產品需求與驗收條件

## 1. 產品範圍

建立一個本機多 agent orchestrator，管理官方 coding CLI 與選配 API provider，支援規劃、實作、審查、測試及條件式迴圈，同時以可驗證的 policy engine 限制權限、成本、時間與資料流。

## 2. Provider 與模型

### 2.1 訂閱模式

第一版支援：

- OpenAI Codex CLI 的官方非互動介面。
- Anthropic Claude Code CLI 的官方 print/headless 介面。
- xAI Grok Build CLI 的官方 headless 介面。

必要行為：

- 使用者先在各 CLI 完成官方登入。
- Orchestrator 只檢查「可否正常執行」，不讀取憑證內容。
- CLI 不可用、額度耗盡或登入失效時，workflow 安全停止並通知使用者。
- 不得自動改用 API。

### 2.2 API 模式

- 初始狀態為 disabled。
- 可逐 provider 切換，不要求全域切換。
- 啟用前顯示 provider、model、預算、資料傳輸範圍與確認資訊。
- API secrets 不出現在前端、log、SQLite 或 crash report。
- 每次、workflow、日、月預算均為必填硬限制。
- API fallback 必須逐次由人類明確批准。
- 第一個安全版本的 API agent 僅能擔任 Planner 或 Reviewer。通過寫入沙箱驗證的 Codex／Claude
  訂閱 adapter 可由 owner 指派為 task-scoped Writer，必須在隔離 worktree 中且只能使用內建
  Workspace MCP broker。Grok/API Writer 保持停用；未來開放前需獨立 sandbox 與 threat review。

### 2.3 模型選擇

- TUI 與 Web UI 必須提供 provider/model selector。
- 優先透過官方 CLI 支援的 discovery 命令取得模型列表。
- 無 discovery 時允許手動 model ID，但需格式驗證與確認。
- 角色與模型不得寫死；profile 只提供預設值。

## 3. Agent 角色與工作流程

預設角色：

- Planner：唯讀，產出計畫與驗收條件。
- Writer：每個 task 唯一持有 active epoch-fenced lease 的主寫入者；可交接，並可派一層同
  provider 可寫子 Agent（與父 Writer 共用 task worktree、由持久化鎖序列執行）或跨 provider
  唯讀子 Agent。
- Reviewer：唯讀，檢查 correctness、安全與需求符合度。
- Tester：只能啟動核准的測試命令並回報結果。

工作流程必須支援：

- 有向節點與條件邊。
- 序列與受控平行 reviewer。
- 依測試、review 結果返回 writer。
- max rounds、max calls、timeout、budget 與 circuit breaker。
- pause、resume、cancel、human approval。
- 崩潰後從安全 checkpoint 恢復。

平行 reviewer 只能讀取同一 immutable snapshot；不得平行寫入。

## 4. TUI、Web 與 CLI

### 4.1 TUI

執行 `orchestrator` 直接開啟終端機互動介面。至少提供：

- 啟動即建立以 Codex 為主代理的 RAM-only 自然語言 session；一般輸入不需要指令前綴。
- 只有 `/help`、`/agents`、`/status`、`/new`、`/gui`、`/advanced`、`/exit` 等本機操作使用斜線前綴，斜線指令不得傳給模型。
- Sub-agents 以固定白名單 tools 註冊；主代理可以自動選擇唯讀工具，但任何寫入型 workflow 仍需人類 scoped approval。
- Workflow 採三段式資訊層級：工具提案、執行確認、與開始後的獨立即時儀表板。
- Allowlist 空白時停止並顯示唯一修正動作；只有一個已授權專案時預選該專案，不以 home directory 作預設。
- Web 可用原生資料夾 picker 或手動路徑新增單一 Git root；必須先顯示 canonical 安全 preview，
  封鎖 broad／sensitive／unsafe root，再以短效 single-use 精確確認及 confirm-time TOCTOU 重驗寫入
  owner-only policy。不得讓 Agent 透過聊天或 request queue 自行擴大 workspace。
- 專案與 workflow profile 選擇。
- 任務輸入。
- agent/provider/model 選擇。
- 訂閱/API 模式顯示與切換。
- 即時狀態、事件、訊息、diff、測試與用量頁籤。
- 暫停、繼續、批准、拒絕、終止。
- 清楚顯示目前有效軟限制與不可由 UI 解除的硬限制。
- 執行中以單鍵切換 Activity、Messages、Diff、Tests、Usage；取消採短時間內二次按鍵確認。

### 4.2 Web UI

- 由 `orchestrator web` 啟動。
- v1 僅監聽 loopback address。
- 使用每次啟動產生的高熵 session secret 與 SameSite cookie。
- 必須防止 CSRF、WebSocket/SSE cross-origin 濫用與 DNS rebinding。
- 不得將 provider secret 傳送到 browser。

### 4.3 非互動模式

- 支援結構化輸入與 JSONL/事件輸出。
- 非互動模式不得隱含批准危險操作。
- 無 TTY 時，所有需要人類批准的步驟都必須 fail closed 或進入 paused 狀態。

## 5. 限制與長時間模式

限制分為：

- Soft limits：可在 TUI/Web 修改，例如一般 workflow 的輪數與時間。
- Hard limits：只能修改本機設定檔並重啟；前端與 agent 不得覆蓋。

硬限制至少涵蓋：

- 同時 workflow 數。
- 單次 provider timeout。
- workflow 絕對最長時間。
- 絕對最大 provider calls。
- 最大子程序數與輸出 bytes。
- 最大修改檔案數與 diff 大小。
- 最大連續錯誤與重試。
- API 絕對預算。

長時間模式可以提高或移除部分 soft limits，但不得取消 hard limits、kill switch、timeout、circuit breaker、workspace jail 與批准控制。

## 6. Workspace 與 Git

- 使用者明確選擇 allowlisted workspace root。
- 所有讀寫都必須停留在 canonical workspace root。
- 預設禁止追蹤 symlink；若未來支援，必須有不可逸出的驗證。
- 啟動前記錄 repository 狀態，不得覆蓋既有未提交變更。
- 每輪建立可識別 checkpoint；checkpoint 不等於自動 commit 或 push。
- 回復操作需人類批准，且不得使用破壞性 Git 指令。
- v1 不要求 GitHub，且永不自動 push。
- 可選 worktree 模式為每個 workflow 建立固定 base SHA 的本機 branch/worktree；建立需明確
  確認，完成後不自動 merge、push、刪 branch 或 cleanup。

## 7. 持久化與隱私

- 使用本機 SQLite 儲存最小必要 metadata。
- 預設不持久化完整 prompt、模型 reasoning、原始 stdout/stderr 或檔案內容。
- 需要除錯內容時才可採 opt-in、短 retention、明確警告與可一鍵清除；v1 尚未提供 raw debug
  capture，因此任何啟用要求必須 fail closed，不得默默保存內容或假裝受 retention 保護。
- DB、log 與 session 檔案使用 owner-only 權限。
- 提供資料 inventory、retention 設定與安全刪除流程。
- 不依賴 Supabase 或其他雲端資料庫。

## 8. 安全驗收條件

發布 MVP 前必須證明：

1. 惡意 repository 指令不能提高 agent 權限。
2. 模型輸出不能繞過 command/path/policy validation。
3. Symlink 與路徑編碼無法逸出 workspace。
4. Web 介面無法被非 loopback origin 控制。
5. Secrets 不會進入 log、DB、UI、trace、Git 或 build artifact。
6. Soft-limit bypass 不能修改 hard limits。
7. API 模式不能在未確認時啟用或自動加值。
8. Provider/CLI 掛起、超大輸出或重複失敗會被終止。
9. Cancel 能終止整個 process tree，而非只停止父程序。
10. 在乾淨 clone 中可重現建置與測試。

各項目前實作、測試證據與需 owner 批准的驗證分界見 `VERIFICATION.md`。
