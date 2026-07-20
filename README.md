# Orchestratory

Security-first、local-first 的多模型 coding-agent orchestrator。預設透過已登入的 Codex、Claude Code 與 Grok Build 官方 CLI 使用訂閱額度；API 模式是逐 provider、明確批准、預設關閉的選配功能。

> 目前處於未發布的安全預覽階段。先用測試 repository 驗證，不要把 Web 介面暴露到公開網路。

## 目標介面

```text
orchestrator             # Codex 自然語言 session＋loopback GUI
orchestrator tui         # 只啟動終端對話 session
orchestrator gui         # 只啟動 loopback GUI（web 是相容別名）
orchestrator mcp --actor claude  # stdio MCP server；actor 固定由啟動設定提供，不能由 tool call 偽造
orchestrator run         # 從 stdin 接收結構化 JSON workflow
orchestrator doctor      # 工具鏈與 CLI 健檢
orchestrator audit       # 本機安全檢查
orchestrator models list <fake|codex|claude|grok> [--api] # 顯示驗證後的可選模型
orchestrator workspaces list # 列出明確允許的 workspace roots
orchestrator workspaces allow <path> --label <name> # TTY 輸入 ALLOW 後加入 owner-only policy
orchestrator worktrees list # 列出保留的隔離 worktree run IDs（唯讀）
orchestrator worktrees cleanup <run-id> # 只預覽；加 --execute 後逐次確認移除乾淨 worktree，保留 branch
orchestrator data inventory # 顯示 SQLite、retention 與保留 worktree 清單（唯讀）
orchestrator data integrity # quick/foreign-key/audit-chain 完整性報告（唯讀）
orchestrator data retention show # 查看有限 retention policy
orchestrator data retention set --terminal-days 30 --max-runs 500 # TTY 確認後改設定，不刪資料
orchestrator data purge     # 只產生不可變 preview；加 --execute 後才逐次確認
```

## 安全預設

- 每個 task 同時只有一份 active Writer Lease；Writer 可由 owner 在 resident、managed 或已核准的
  external 席位之間交接。每次交接必須帶 checkpoint 並遞增不可回收的 epoch，舊 Writer 與其子
  Agent 的寫入能力立即失效。
- Workspace allowlist 預設為空；新 workflow 必須位於人類明確加入的 canonical root，否則 fail closed。
- 可明確批准每個 workflow 建立獨立 Git branch/worktree；不自動 merge、push 或清理。
- 只有通過 provider 寫入沙箱驗證的 Codex／Claude 訂閱 adapter 能被 GUI 選為 Writer；Grok 與
  API adapter 目前保持唯讀。無論 Writer 顯示為常駐、管理型或外接席位，受控寫入都只能發生在
  task 綁定的隔離 worktree。
- Live Writer 的 provider process 在空白 scratch cwd 執行，內建 shell／檔案／網路工具全部停用；只能透過本機 Workspace MCP broker 列檔、讀 UTF-8 text、逐層建目錄及原子寫檔。
- MCP 寫入必須提供剛讀取內容的 SHA-256；新檔採 no-clobber 建立，不提供刪除、rename、Git、shell、網路或敏感路徑工具。
- Reviewer 唯讀；模型輸出不是授權。
- 對話 session 只接受固定註冊的 `read_files`、`ask_claude` 與 `coding_team` 工具；未知或格式錯誤的 tool call 視為普通文字。`read_files` 與 `ask_claude` 永遠唯讀，`coding_team` 在寫檔前仍要求本機精確輸入 `RUN`。
- `read_files` 不給模型檔案系統權限：路徑由本機 Workspace broker 驗證（拒絕逸出、symlink/hardlink、敏感路徑、binary、超大檔），每輪最多 2 次、每次最多 8 個檔案且總量受限；檔案清單由 Git 產生並排除敏感與 ignored 路徑。
- 對話歷史只保存在 RAM，最多 30 輪／32 KiB；`/new` 只清除內容，不重設不可逆的 provider call 計數。
- 所有 reviewer 取得同一份預先擷取、限長的 Git status、tracked diff 與經模式篩除的 bounded untracked text，審查前後再次驗證內容指紋。
- 每輪 writer 完成後保存不含 prompt/file content 的 checkpoint metadata；崩潰恢復必須人工批准且指紋一致。
- 無 shell process spawn、命令與參數 allowlist。
- Soft limits 可調；hard limits 只能修改 owner-only 本機設定並重啟。
- API 不自動 fallback、不自動加值。
- API 僅供唯讀 Planner/Reviewer；Writer 必須使用受控訂閱 CLI。
- API 呼叫前依 owner-only 模型價格政策預留最壞情況預算，並執行每次、run、日、月限制。
- 不讀取或複製 provider token。
- 不保存完整 prompt、reasoning、raw output 或秘密。
- SQLite schema migration 使用交易；啟動時執行 quick/foreign-key/audit hash-chain 驗證。
- Retention 有有限預設；purge 與 worktree cleanup 都是 preview-first、TTY、短效 scoped nonce，且永不自動執行。
- Web 僅綁定 loopback，無 telemetry。
- 不自動 commit、push、建立 GitHub repository 或發布。
- 測試只允許 digest-pinned Docker/Podman profile，禁止網路、自動 pull、host write 與額外 capabilities。

## 從本機 source 安裝

目前專案尚未公開發布，先從取得的本機 source folder 安裝。需要 Node.js 22.20 以上；不得使用
`sudo npm link`、不得放寬系統目錄權限。鎖定依賴、停用 package lifecycle scripts，並在建立
使用者層級 link 前完成驗證：

```text
cd "/path/to/orchestratory"
node --version
npm ci --ignore-scripts
npm run check
npm_config_ignore_scripts=true npm_config_prefix="$HOME/.local" npm link
"$HOME/.local/bin/orchestrator" --help
"$HOME/.local/bin/orchestrator" doctor
```

若一般的 `orchestrator` 顯示 command not found，先使用上方完整路徑；檢查自己的 `PATH` 後再由
owner 決定是否修改 shell profile，不要讓安裝程序自行改寫。也可以把以下自然語言交給 coding
agent；這段授權只涵蓋安裝與唯讀驗證：

```text
請在本機安全安裝目前這個 Orchestratory 專案。先確認 Node.js 至少為 22.20；只使用 repository
既有的 package-lock，執行 npm ci --ignore-scripts 與 npm run check。不得使用 sudo、不得修改
系統目錄、shell profile 或放寬檔案權限。驗證通過後，使用
npm_config_ignore_scripts=true npm_config_prefix="$HOME/.local" npm link。最後只執行
"$HOME/.local/bin/orchestrator" --help 與 "$HOME/.local/bin/orchestrator" doctor；不要啟動模型。
遇到 PATH、權限、測試或依賴問題時停止並回報，不要自行繞過。
```

## 開發

Node.js 22.20+ 可直接執行此專案的可剝離型別 TypeScript。正式 typecheck 需安裝鎖定的 dev dependencies。

```text
npm install --ignore-scripts
npm run check
```

本機啟動：

```text
npm start                # 對話 TUI＋本機 GUI
npm run web              # http://127.0.0.1:4317
npm run doctor           # 不消耗模型額度的 CLI 版本檢查
```

若要在任何終端機直接使用 `orchestrator`，只把 link 建在使用者擁有且已列入 `PATH` 的 npm
prefix；不要使用 `sudo npm link` 或放寬 `/usr/local` 權限。

首次執行 workflow 前必須明確加入最小必要 root：

```text
orchestrator workspaces allow /path/to/projects --label Projects
```

此命令要求 TTY 精確輸入 `ALLOW`，並把 canonical path 寫入 mode `0600` 的本機 policy。不要把整個
home directory 加入 allowlist。Web/TUI 仍會在核心層重新驗證，不能靠竄改表單繞過。

也可以在本機 GUI 按「＋ 新增專案」，選擇資料夾或貼上路徑。介面會先顯示 canonical Git root、
owner／權限與敏感範圍檢查，只有輸入指定的 `ALLOW <專案資料夾名>` 後才會寫入同一份 policy；
確認時會重驗路徑與 `.git`，preview 後被替換就拒絕。這是 owner 的直接授權入口，不是交給 Agent
申請再由同一人批准。Agent 的安裝、登入與能力開關仍在終端完成，GUI 只顯示已可用的 Agent。

`orchestrator` 啟動後立即建立 RAM-only 對話 session；主代理預設是 Codex GPT-5.6 Sol，可用
`/model <provider> <model>` 隨時切換為 Codex、Claude 或 Grok 的任一訂閱模型，切換時保留對話
歷史且不重設呼叫計數。所有不以 `/` 開頭的輸入都是自然語言，會使用主代理的訂閱額度；主代理可
透過 `read_files` 讀取受限的專案檔案、呼叫唯讀 Claude Fable 5 第二意見，或提出 `coding_team`
workflow。只有涉及 worktree／寫檔時才會顯示範圍並要求輸入 `RUN`。本機指令為 `/help`、
`/agents`、`/model`、`/status`、`/new`、`/gui`、`/advanced`、`/exit`。

訊息開頭用 `@codex`、`@claude`、`@grok`（可加 `:model-id`）可把該輪直接交給指定訂閱模型唯讀
直答；多個 `@` 會把同一問題並排比稿（最多 3 個模型，各算一次模型呼叫）。@提及回合不解析
tool marker，模型輸出一律視為純文字。

Web GUI 的首頁同樣是對話，而不是 workflow 表單。左側選擇已授權專案與主代理（Codex、Claude、
Grok 任一訂閱模型，切換保留歷史），右側直接輸入自然語言；一般唯讀聊天不要求 repository 乾淨。
首頁左側另有整塊可點擊的「Room 即時協作」與「歷史紀錄」入口。Room 歷史模式不呼叫模型，從
append-only 帳本最新處開始，每次向前載入最多 100 則；切換房間時 URL 會保存 room id。
模型提出 `coding_team` 時只會顯示待確認卡片，
不會直接寫檔；使用者進入進階 workflow、完成 Git/worktree 與額度確認後才可能執行。TUI 與 Web
各自保存獨立的 RAM-only 對話內容；真實 provider calls 由 owner-only SQLite 保存 24 小時全域
計數，因此新對話、切換 workspace/model 或重開 TUI／GUI／MCP 都不會把 hard ceiling 歸零。

### 原生終端加入 Room（macOS）

已先在專案執行 `orchestrator room init` 且 workspace 仍在 allowlist 時，可從同一專案目錄啟動：

```text
orchestrator room pty codex
orchestrator room pty grok
```

此橋接預設關閉。Owner 必須先建立
`~/Library/Application Support/Orchestratory/native-room-pty.json`，內容精確為 `{"enabled":true}`，
且檔案 mode 必須是 `0600`、單一 hardlink、非 symlink；Application Support 資料夾本身須為
owner-only。任何條件不符都只會得到 `ROOM_PTY_OWNER_OPT_IN_REQUIRED`，不會啟動 provider。
`codex-writer.json` 現在也使用同一份 owner gate 驗證；舊的寬鬆權限檔需先由 owner 修成 `0600`。

開啟後會保留 Codex／Grok 自己的互動式 TUI，並把有上限的終端尾段同步進 Room。為避免冒名，紀錄
固定標成 `codex-terminal`／`grok-terminal`，並明示它是混合 PTY 畫面，可能同時含使用者輸入、
模型輸出與畫面重繪，不宣稱是乾淨的模型訊息。Wrapper 只允許這兩個固定 provider，不接受額外
CLI flags、不經 shell；Codex 固定 `read-only` sandbox＋`never` approval 並停用 shell/hooks/plugins，
Grok 固定 plan mode、空 tools、無 web/subagents/memory。逐字稿只在 RAM 留下 128 KiB 尾段，經
控制碼清除、secret redaction 與 12,000 字上限後才入帳；session 最長四小時。它是 owner 主動啟動
的原生訂閱 CLI，不能精確計算
每個 TUI turn 的 token 或 provider-call 數，因此不應用來取代有完整 governor 的自動 workflow。
Codex 結束畫面的 resume session UUID 會在未來入帳前遮蔽；既有 append-only 訊息不會被靜默改寫。

### MCP-first 協作（建議的主要用法）

把 Claude Code 或 Codex 原生介面當 host，Orchestratory 提供唯讀 worker 工具：

```text
claude mcp add --scope user orchestrator -- orchestrator mcp --actor claude
codex mcp add orchestrator -- orchestrator mcp --actor codex
grok mcp add orchestrator -- orchestrator mcp --actor grok
```

只需為準備當作 host 的官方 CLI 註冊；重新開啟該 Agent session 後生效。各自的 `--actor` 固定
provider 類型；每個 MCP stdio process 會在同一個 allowlisted workspace 取得獨立短租約。
Room 也以 canonical workspace 精確綁定：每個專案使用自己的 Room，不會把其他專案的申請、帳本或席位混入。GUI 以
「專案名 — 內部 Room ID」顯示這層對應，並會在任一專案有待核准申請時於全域顯示數量。
MCP 終端必須先呼叫 `room_join_request`，才會在 Room 辦公室右側列為「待核准」；沒有申請的終端
不會出現在 GUI。Owner 按「＋ 加入」後才分配 `codex1`、`codex2` 等不回收身分、建立人物與辦公桌
並開始允許該 session 入帳。`room_join_request` 會保持目前 host 回合等待核准，核准後立刻進入第一段
bounded `room_wait`，因此 Owner 可直接從 GUI 交辦第一則工作；若要持續值班，終端在 timeout 或回覆後
必須立即再次呼叫 `room_wait`。未加入完全不記錄；終端正常
關閉會立即移除，crash 最遲在約十五秒 lease 到期後移除。不同 workspace 不能互相加入，GUI 也
看不到 PID 或 raw provider session id。

一般呼叫 `room_join_request` 只需傳 `room`；不要自行帶入 timeout。預設核准等待 30 秒、首輪值班等待
20 秒，明確上限分別為 120 秒與 25 秒；超出時 fail closed，不會產生一筆看似成功的申請。

自動記錄原生 host 的 user/assistant turn 另需 structured hooks。先用下列命令只看預覽；它不會
修改任何設定：

```text
orchestrator room hooks --provider codex
orchestrator room hooks --provider claude
orchestrator room hooks --provider grok
```

三個 provider 都只會在 owner 明確加 `--install` 後寫入各自的使用者設定，且先備份既有設定；預設命令
只輸出預覽。這項全域設定不會由專案或模型自動安裝。舊 `room log-hook` 已停用為 no-op，
避免「曾經 room init」被誤當成目前同意錄音。

之後可在 Claude Code、Codex 或 Grok 裡直接說：「請使用 Orchestratory MCP，在目前專案建立或
重用一個 Room。把我的需求寫入房間，再分別喚醒 Codex、Claude、Grok 提出方案；引用每段回覆的
#編號，最後整理共識與分歧。」Host 會依序使用 `room_init`、`room_post`、`room_mention` 與
`room_read`。每次 mention 都會消耗對應 Agent 的一次訂閱呼叫。

也可以直接說「讓 Grok 和 Codex 分別檢查這個架構，再比較給我建議」，host 會
呼叫 `ask_grok`／`ask_codex`／`compare_agents`（最多 3 個模型並排），收回 bounded 純文字回
答後自行比較統整。所有 worker 皆唯讀、跑在空白 scratch cwd，由 Orchestratory 注入受限的專
案檔案清單；host 也可在 `files` 明確指定最多 8 個相對路徑，內容仍經相同唯讀邊界與總量上限。
workspace 必須在 allowlist 內；程序內計數之外，真實呼叫還受跨程序持久 governor 約束。
終端必須先呼叫 `room_join_request`；只有同專案、live 且有 MCP 的精確 session 才會進入 GUI
「新增 Agents」待審核。Owner 加入後才建立 `codex1` 等臨時工位並開始記錄；終端關閉會移除
臨時人物，Codex／Claude／Grok／You 四個常駐工位不受影響。加入後的 Room 作者由 presence
membership 固定，tool call 無法冒名。Owner 從 GUI 對精確席位交辦後，訊息會進入 owner-only
收件匣並依序呈現 `queued → delivered → read → working → replied`；終端以 bounded
`room_wait` 長輪詢收件，再用私有 lease token 呼叫 `room_ack`、`room_reply` 或 `room_fail`。
離線、取消、重送與 idempotent reply 都有明確狀態，不會 fallback 到同 provider 的常駐模型。
外接終端沒有執行 `room_join_request` 的核准等待或 `room_wait` 時，GUI 會誠實標示「線上但休班」，
`@` 訊息只會排入精確收件匣，不宣稱已即時喚醒。MCP 協定不能向已經完全 idle 的既有 CLI host
注入一個新 turn；需要不依賴外部 host 值班的 GUI 即時喚醒時，請建立「受控即時 Agent」，由
Orchestratory 明確發起 bounded provider call，且不冒充外接終端。

GUI 的「等待模型回應」只由真正的 `room_mention` 生命週期事件驅動：開始時寫入
「回應處理中（提及 #N）」，後續必須以回覆、失敗、取消或清除收旂。單純用 `room_post`
寫入以 `@claude` 等字樣開頭的帳本文字會 fail closed 並要求改用 `room_mention`，不再產生「看似等待、實際沒有呼叫」的狀態。

Writer 可在 GUI 依 task 隨時指派或交接。外接席位成為 Writer 時，由受控 Writer Companion 代為
執行；Room 帳本用自然語言標示「由誰代表誰執行」，技術 HMAC audit 另保存 `on_behalf_of`、
`executed_by` 與 `lease_epoch`，不冒充原生終端程序。Writer 可派一層子 Agent：同 provider 子
Agent 與父 Writer 共用同一 task worktree，並由持久化 task lock 跨 GUI 程序序列執行；跨
provider 子 Agent 只能讀。Codex／Claude 的跨 provider 審查走可撤銷唯讀 Workspace MCP；Grok
只取得控制面產生的 bounded Git snapshot，在空白 scratch 且沒有 filesystem tools 的程序中審查。
所有子 Agent 禁止再轉派，父 Writer 完成或交接時一併撤銷。第二個 GUI 啟動時會保留仍有活躍
heartbeat 的 Writer run；只撤銷沒有活鎖、且 RAM capability 已無法恢復的舊 lease。Writer 面板
可精確取消目前 Writer 或選定子 Agent 的執行；完成回寫後會顯示 `applied` 終態，不再誤顯示待回寫。

M2 第一層已提供
`request_coding_workflow`：它只把 bounded 提案寫入 owner-only control-plane queue，固定為
subscription＋安全 worktree 意圖，不會取得 approval、不會啟動 provider、測試或修改專案。GUI
會把它顯示成「尚未批准」提案卡；只有 owner 明確按 RUN，才會走既有短效 scoped approval。
Dirty Snapshot 已可由 GUI 明確勾選：只把 bounded UTF-8 文字變更短暫保留在 RAM，經獨立
scope-bound approval 後匯入新 worktree，不改來源專案。完成後可按「套用回主專案」先看精確
檔案清單，再以另一份短效、single-use approval 套用；source/worktree 的 HEAD、全域 fingerprint
與逐檔 hash 任一改變都會阻斷。刪除不永久移除，只移到 `~/trash-pending/orchestratory/`；不會
自動 commit、merge、push 或清理 worktree。

Workflow 引擎已支援 goal loop 基礎：`acceptanceCriteria` 欄位會注入 planner／writer／
reviewer prompt 作為驗收依據；writer 連續兩輪未改動任何檔案時以 `NO_PROGRESS_STALLED`
終止，防止空轉消耗額度。

Workflow 開始後會切換成 Claude Code 風格的即時儀表板。執行中快捷鍵為 `p` 暫停／繼續、`e`
事件、`m` 暫存模型訊息、`d` diff、`t` 測試、`u` 用量；取消必須在五秒內連按兩次 `c`。
只有一個已授權專案時自動預選；allowlist 空白時直接停止。

`orchestrator run` 從 stdin 接受 JSON，stdout 逐行輸出 `run`、`event`、`result` JSONL。
非互動模式不會產生危險操作的 approval nonce，因此 worktree、API、測試與 checkpoint restore
若未由 TUI/Web 明確批准會 fail closed。

API 預設不可用。要啟用時，先把當下官方價格與最大輸出 token 寫入 owner-only 的
`~/Library/Application Support/Orchestratory/api-models.json`，再從啟動程序的環境提供
`OPENAI_API_KEY`、`ANTHROPIC_API_KEY` 或 `XAI_API_KEY`；macOS 也可在 Keychain 建立 service
`orchestratory.openai-api-key`、`orchestratory.anthropic-api-key`、`orchestratory.xai-api-key`，
account 固定為 `orchestratory`。
不要把密鑰寫進 repository、JSON workflow 或瀏覽器。

API endpoint 固定為 provider 官方 HTTPS endpoint，不接受自訂 URL。價格設定刻意不附真實
預設值，避免過期價格造成假的預算保證。API Planner 只接收任務；API Reviewer 會接收任務、
受限 tracked diff 與受限 untracked UTF-8 text。`.env*`、key/certificate 類路徑、過大內容、
binary 或總 context 超限時 fail closed；模式篩選仍不是秘密偵測保證，啟用前必須自行確認傳輸範圍。

隔離測試 profile 位於 owner-only 的
`~/Library/Application Support/Orchestratory/tester-profiles.json`。範例見
`config/tester-profiles.example.json`；範例 digest 是不可執行的 placeholder，必須由 owner 換成
已審查 image 的真實 SHA-256 digest。系統永不自動 pull image；Docker/Podman 或 image 不存在即停止。

詳細設計與安全要求位於 `docs/`。任何貢獻前先閱讀 `AGENTS.md`；Claude Code 另讀取 `CLAUDE.md`。

第一次使用可直接以瀏覽器開啟 `docs/orchestrator-interactive-guide.html`。這份離線互動教程分成
開始、GUI、Agents、Room、安全寫入與排錯六章；其中所有按鈕都是演示，不會啟動 provider、
消耗訂閱額度或修改專案。

## 已驗證範圍

- Strict TypeScript typecheck。
- Fake-provider 端到端 workflow。
- loopback Web session、CSRF、Origin、Host 與 CSP。
- symlink escape、輸出洪水、timeout、秘密遮蔽與 API 預算阻斷。
- Git worktree branch 隔離與惡意 local filter/fsmonitor 拒絕。
- scoped/expiring/single-use approval、digest-pinned tester、checkpoint 指紋恢復。
- Workspace allowlist、retention preview/purge rollback、worktree cleanup snapshot、SQLite migration/audit-chain tamper detection。
- CycloneDX SBOM、deterministic fuzz smoke、SHA-pinned least-privilege CI 與離線乾淨 package snapshot。
- 目前 259 個 deterministic tests；line 94.94%、branch 85.27%、functions 96.71%，門檻由指令阻擋。

真實訂閱/provider 認證與付費 API 呼叫尚未執行，因為它們會使用使用者額度或產生費用。

## 已知限制

- 這台開發機目前沒有 Docker/Podman，因此只驗證了 tester schema、argv、policy 與 workflow；尚未執行真實容器測試。
- Crash 後先標記 `INTERRUPTED_RESTART`，只允許人工選擇 writer-complete checkpoint；恢復會重新執行 planner/reviewer，可能使用新的訂閱/API 額度，但不會重播 writer。
- Worktree 只隔離 working directory，仍共用來源 repository 的 Git object database/refs，不等同 container 或 VM。
- Reviewer 的 immutable 保證目前由同一份 captured context 加 workspace 前後指紋守衛提供；本機其他程序仍可能形成 TOCTOU 殘餘風險。
- Claude Workspace MCP 的 protocol、path、hash/no-clobber 與 fake CLI 整合已驗證；真實 Claude Code Writer 是否完整接受目前 CLI/MCP 參數仍待使用者批准後以訂閱額度 smoke test。
- Codex／Claude 常駐、管理型或外接身分都可被 owner 選為 task-scoped Writer；寫入仍只能經
  read-only provider sandbox 外的 Workspace MCP、隔離 worktree 與 lease epoch fencing。真實寫檔 smoke
  需 owner 明確批准訂閱額度；Grok/API Writer 保持停用。
- Raw debug capture 尚未實作；設定為 true 會直接拒絕啟動，而不是假裝啟用 retention 保護。
- Node 22 的內建 `node:sqlite` 仍會顯示 experimental warning。
- GUI 的 HTTP/安全整合測試已通過；本次執行環境沒有可用 browser instance，所以視覺點擊 QA 尚待補做。
- `npm run repro:smoke` 已驗證乾淨 package snapshot；真正 clean Git clone 仍須先有經 owner 批准的 commit。

## 狀態

尚未發布。Source tree 已放入 Apache-2.0 `LICENSE` 與 `NOTICE`，但首次公開前仍需 owner
確認 copyright 名稱、Git identity、repository 名稱與 visibility。不得在未經 owner 明確批准下公開或散布。
