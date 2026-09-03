# Orchestratory

**讓 Codex、Claude Code 與 Grok 在同一個房間裡協作，而你保留唯一的核准權。**

Security-first、local-first 的多模型 coding-agent orchestrator。它透過你**已經登入**的官方 CLI
使用訂閱額度；它不保管金鑰，API 模式的 key 由啟動環境或 macOS Keychain 提供，且是逐 provider、
明確批准、預設關閉的選配功能。

它要解決的問題是：多個 coding agent 同時動一個 repo 時，你既看不到誰改了什麼，也擋不住任何一次
寫入。Orchestratory 把兩件事拆開——**協作**發生在一份只能往後追加的共用帳本與各自的 candidate
工作區裡；**寫入你的專案**是一道獨立的閘門，必須由你在本機 GUI 或實體終端逐字打出確認語才會發生。

> **狀態：尚未對外發布的安全預覽。** 請先用測試 repository 驗證，不要把 GUI 暴露到公開網路。

## 一句話的保證，以及它的邊界

**保證：** agent 在獨立的 candidate 工作區做事。要把成果併進你的專案，系統會先攤開 diff、衝突、
測試與復原點，然後要求一次**只能用一次、綁死該快照**的核准；快照任一處改變，核准立刻失效。
Agent 呼叫 `main_merge_request` 只是**登記一個問題**，它拿不到任何可以自己核准的 token。

這句保證有一個例外，寫在這裡而不是留給你自己踩：**如果你的專案自己設定了 merge driver**
（`.gitattributes` 加 `.git/config` 裡的自訂合併程式），預覽為了算出真實結果**會執行你設定的
那支程式**——在你點頭之前。跑的是你自己的程式，但 agent 改動的內容會被 git 當參數餵給它。
多數專案沒有設 merge driver，也就完全不會遇到；細節見下方快速開始與
[`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) F23。

**邊界（同樣重要）：** candidate **不是 OS 沙箱**。同一個作業系統帳號下的 full-trust agent，技術上
仍然可以繞過應用層邊界。這個產品提供的是**可追溯、可復原、有紀錄**，不是強制隔離——文件裡不會
給你更好聽的說法。真正的隔離請用容器或另一個帳號。

加入房間**不會改變 agent 的權限**。它的 sandbox、工具、shell、網路全部由它自己的 host（Codex 或
Claude Code）決定，Orchestratory 不升權也不降權；加入只授權「協作」這件事。

完整威脅模型見 [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md)，設計決策沿革見
[`docs/DECISIONS.md`](docs/DECISIONS.md)，逐項 runtime 行為見
[`docs/RUNTIME_REFERENCE.md`](docs/RUNTIME_REFERENCE.md)。

## 這個產品會連到哪裡

先前這一節的標題是「本機以外，什麼都不送」。那句話是假的，而且是這份文件裡最不該說錯的一句。
下面是**全部**的網路出口，逐條列出比一句漂亮的總結有用：

- **你的 provider CLI 本來就會連它自己的廠商。** 這是整個產品的運作前提——它用你已經登入的
  Codex／Claude Code／Grok，那些 CLI 的流量不歸 Orchestratory 管，也不該被說成不存在。
- **API 模式會把你的 prompt 送到 provider 官方 endpoint。** `src/providers/api.ts` 裡有三個寫死的
  位址（`api.openai.com`／`api.anthropic.com`／`api.x.ai`），request body 直接含 prompt。
  它**預設關閉**、必須逐 provider 明確啟用、不接受自訂 URL、不自動 fallback、不自動加值——
  但它啟用之後就是一條真實的資料出口，而不是「什麼都不送」。
- **Telemetry：出貨狀態送不出任何東西。** `TELEMETRY_HOST` 與 `TELEMETRY_ANON_KEY` 在原始碼裡是
  `null`，建立請求會直接以 `TELEMETRY_ENDPOINT_NOT_PROVISIONED` 被拒（可自行呼叫
  `assertTelemetryUrl` 驗證）。目的地寫在原始碼裡而不是設定檔、環境變數、資料庫或模型輸出，
  所以要改它去哪，得改原始碼——注意這是「改起來看得見」，不是「改不了」：同帳號的 agent
  技術上仍可改原始碼再重啟。同意狀態預設是 `unanswered` 而非 false，因為「還沒問」和
  「問過說不要」不是同一件事。

本機端的性質則是可以斷言的：

- GUI **只綁 loopback**，外面連不進來；沒有帳號、沒有雲端後端。
- **不讀取、不複製 provider token。** 你的 CLI 怎麼登入的，它就怎麼登入。
- 不保存完整 prompt、reasoning、raw output 或秘密。
- 不自動 commit、push、建立 GitHub repository 或發布。

## 命令列介面

```text
orchestrator                         自然語言 TUI ＋ 本機 GUI
orchestrator tui                     只啟動終端對話
orchestrator gui [--port <number>]   只啟動 loopback GUI（web 是相容別名）
orchestrator mcp [--actor <id>]      stdio MCP server；actor 由啟動設定固定，tool call 不能偽造
orchestrator run                     從 stdin 讀一份 JSON workflow，輸出 JSONL
orchestrator doctor                  不消耗額度的 CLI 健檢
orchestrator models list <provider> [--api]
orchestrator room init|list|status|writers|audit|pause|resume|off|tail|export|log
orchestrator room hooks --provider <codex|claude|grok> [--install]   # 預設只預覽
orchestrator room pty codex|grok [--room <id>]                       # macOS；需 owner opt-in
orchestrator workspaces list|allow <path> [--label <name>]
orchestrator worktrees list|cleanup <run-id> [--execute]
orchestrator candidates orphan-refs <workspace>    # 唯讀；只列出，永不刪除
orchestrator candidates promotions <workspace>     # 重新觀察並更新未定案紀錄
orchestrator data inventory|integrity|purge [--execute]
orchestrator data retention show|set [--terminal-days N] [--max-runs N]
orchestrator telemetry status|on|off|log
orchestrator daemon install|uninstall|status
orchestrator config show
orchestrator audit
```

破壞性、計費、worktree、測試與 restore 類動作一律需要核准。以 `orchestrator --help` 為準。

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


## 快速開始：從安裝到第一次 merge 核准

裝完之後，這一節帶你走完一次完整的流程。**十步，每步一行指令。**

先說清楚這個產品在做什麼，後面每一步才有意義：

> **Agent 在一個獨立的工作區（candidate）做事，不直接動你的專案。**
> **做完之後，系統把差異攤開給你看，問你要不要併進去。你不點頭，agent 的變更不會進入你的專案。**

一個誠實的但書：**若你的專案自己設定了 merge driver**（`.gitattributes` 加 `.git/config` 裡的
自訂合併程式），預覽為了算出真實結果**會執行你設定的那支程式**——而那是任意程式，**它能做什麼就
真的能做什麼**（留下暫存檔、覆寫檔案、寫到專案外），而且發生在你點頭之前。跑的是**你自己的程式**、
不是 agent 寫的；但 agent 改動的檔案內容會被 git 當參數餵給它，所以那支程式若不謹慎處理輸入，
agent 的內容仍可能被執行（見 [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) F23）。
**多數專案沒有設 merge driver，也就完全不會遇到這件事。**

`main` 在本文件裡一律指**你自己的專案目錄**，不是 GitHub 上的分支。

---

### 1. 告訴它哪個資料夾可以碰

```bash
orchestrator workspaces allow /path/to/your-project --label my-project
```

**預設是什麼都不准碰**，沒有這一步後面全部會失敗。這個指令會把**正規化後的完整路徑**印在終端機上，
要你**親手打字確認**——因為它只接受實體 TTY 的輸入，agent 沒辦法代替你按。

### 2. 啟動

```bash
orchestrator
```

會同時開終端機對話和本機網頁介面（GUI）。GUI **只綁在 loopback**，外面連不進來。
只要 GUI 的話用 `orchestrator gui`。

**GUI 是你的控制台。** 後面所有「核准」都在那裡按，不在終端機。

### 3. 建立房間

```bash
orchestrator room init
```

房間是這個專案的協作單位：一份**只能往後追加、不能改寫**的共用帳本，加上一份席位名單。
同一個資料夾重複執行會回傳原本那間，不會建第二間。

### 4. 把 Orchestratory 掛給你的 coding CLI

在 Codex 或 Claude Code 的 MCP 設定裡新增一個 **stdio** server，指令是：

```bash
orchestrator mcp --actor codex
```

`--actor` 是這個席位的身分，**由啟動設定決定，agent 不能自己改**。名稱只接受小寫字母開頭、
最長 32 字元；`you` 和 `system` 一律拒絕，因為那兩個會冒充系統或你本人。

### 5. 叫 agent 自己申請進房

直接跟你的 agent 說：**「請呼叫 `room_join_request` 加入房間。」**

**不要叫它跑 shell 指令去 join。** 進房必須由 agent 透過 MCP 提出申請，
這樣系統才知道**是哪一個活著的程序**在要求進來——shell 指令做不到這件事。

### 6. 你在 GUI 按核准

GUI 會跳出加入請求，你選這個席位的協作模式後核准。

**加入房間不會改變 agent 的任何權限**——它的 sandbox、工具、shell、網路全部由它自己的 host 決定，
Orchestratory 不升權也不降權。加入只是授權「協作」。

接著叫 agent 呼叫 **`room_wait`**，GUI 會再跳一次待命核准。這兩個是**不同的授權**：
前者是「可以進來」，後者是「可以被指派工作」。

### 7. 開一個任務

叫 agent 呼叫 **`candidate_start`**。

系統會建立一個獨立的 Git 分支與工作區，並記下你專案**當下的 HEAD**。
**你未提交的修改會原地保留**，不會被複製進去，也不會被清掉、stash 或 reset。

### 8. Agent 在 candidate 裡做事

它有完整的原生能力。過程中可以隨時呼叫 **`candidate_checkpoint`** 存一個可復原的快照
（必須是已 commit 的乾淨狀態，否則會被拒絕——這樣快照才真的救得回來）。

### 9. 任務完成，系統開始問你

叫 agent 呼叫 **`candidate_complete`**，接著 **`main_merge_preview`**。

你會拿到：**變更的檔案、衝突、測試結果、風險、復原點**，以及**一句你必須逐字打出來的確認語**。

如果預覽**顯示不完整**（檔案太多被截斷、或模擬合併有衝突），它會回報 `approvable: false`——
**系統不會請你為你沒看過的內容簽名。**

### 10. 核准，才會寫進你的專案

叫 agent 呼叫 **`main_merge_request`**。**提出申請不等於核准**——它只是登記一個問題，
而且**不帶任何 agent 能用的 token**。

然後你在 GUI 裡：**把 diff 捲到底** → 逐字打出確認語 → 按核准。

這時系統才會真的寫入你的專案。這份核准**只能用一次**，而且綁死在那個快照上：
只要 candidate HEAD、你的專案 HEAD、路徑、預覽摘要**任何一個變了，核准立刻失效**，必須重新預覽再問一次。

---

### 三件反直覺、但刻意如此的事

1. **agent 不能核准自己的 merge。** `main_merge_request` 只能「問」。
   能核准的介面只有你的 GUI 或實體 TTY——因為 agent 摸不到那兩個地方的輸入。
2. **拒絕不等於刪除。** 你說不要或先擱著，candidate 和它的紀錄都會留著。
3. **candidate 不是 OS 沙箱。** 同一個 macOS 帳號下的 full-trust agent，技術上仍然可以繞過去。
   它提供的是**可追溯、可復原、有紀錄**，不是強制隔離。這一點文件裡不會給你更好聽的說法。

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
prefix；不要使用 `sudo npm link` 或放寬 `/usr/local` 權限。`npm link` 只適合開發 CLI，不能安裝
登入常駐 daemon：`orchestrator daemon install` 會拒絕直接從 TypeScript source checkout 啟動。
正式 daemon 必須由 `npm run build:package` 產生、SHA-256 已驗證並安裝在獨立 digest 目錄的 compiled
runtime 啟動；LaunchAgent 不得指向 Git working tree 或 npm-link symlink。

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

更深入的 runtime 行為（TUI／GUI 對話模式、@提及比稿、原生終端加入 Room、MCP-first 協作、
Writer Lease、Dirty Snapshot、workflow 引擎與 API 設定）見
[`docs/RUNTIME_REFERENCE.md`](docs/RUNTIME_REFERENCE.md)。任何貢獻前先讀 `AGENTS.md`；
Claude Code 另讀 `CLAUDE.md`。第一次使用可直接用瀏覽器開啟
`docs/orchestrator-interactive-guide.html`——離線互動教程，裡面所有按鈕都是演示，不會啟動
provider、消耗額度或修改專案。

## V2 待辦

V2 規劃加入 **Remote Room Seat（Orchestratory Satellite）**：讓另一台電腦上的外部 Agent
透過本機 MCP connector 與獨立 Remote Room Gateway，申請加入指定 Room 並參與共享帳本討論。
第一階段只提供遠端唯讀討論席位與 exact-seat inbox，不開放本機 workspace、Writer、approval、
provider 額度或管理權限，也不會把目前的 loopback GUI 直接暴露到網路。

完整範圍、非目標、里程碑與安全 Gate 見 `docs/V2_ROADMAP.md`。

Remote Room 是不同裝置與不同信任邊界；目前 roadmap 保留為待重新審查草案，不會用來反向限制
本機 Native Full-Trust terminal。


## 已驗證範圍

`npm run check` 一次跑完下列全部，任一不過就擋下：source hygiene、`node --check` 語法、strict
TypeScript typecheck、附覆蓋率門檻的完整測試、deterministic fuzz smoke、SBOM 一致性、工作樹密鑰
掃描、以及**全歷史所有 ref 的密鑰掃描**。

- **834 個 deterministic tests，分佈在 63 個測試檔**（2026-09-04 `npm run check` 實測，834/834 通過）。
- 覆蓋率門檻由指令強制：line ≥ 90、branch ≥ 85、function ≥ 90。**分母排除 `src/ui/tui.ts`**（`--test-coverage-exclude`，993 行），所以這個門檻不涵蓋 TUI 那一塊。這裡刻意只寫**門檻**不寫當下
  百分比——門檻是保證，百分比是快照，而快照會在下一次有人加一行時就過期。要當下數字請自己跑
  `npm run test:coverage`。
- Fake-provider 端到端 workflow；loopback Web session、CSRF、Origin、Host 與 CSP。
- symlink escape、輸出洪水、timeout、秘密遮蔽與 API 預算阻斷。
- Git worktree branch 隔離，並拒絕惡意 local filter／fsmonitor。
- scoped／expiring／single-use approval、digest-pinned tester、checkpoint 指紋恢復。
- Workspace allowlist、retention preview/purge rollback、worktree cleanup snapshot、
  SQLite migration 與 audit-chain 竄改偵測。
- CycloneDX SBOM、SHA-pinned least-privilege CI，以及離線乾淨 package snapshot
  （`npm run repro:smoke` 從 committed HEAD 建 `--no-hardlinks` clone、跑完整 gate、產生實際 tgz
  並離線安裝驗證，不以 dirty working tree 代替發布來源）。

已完成受控唯讀 Codex 與 managed Claude 的最小 live smoke；真實 Writer 寫入、Grok、付費 API、
container image 與任何額外額度操作仍需 owner 明確批准。

## 已知限制

- 容器化測試 profile 只驗證到 schema、argv、policy 與 workflow 層；**尚未在真實 Docker/Podman 上跑過**。
- Crash 後先標記 `INTERRUPTED_RESTART`，只允許人工選擇 writer-complete checkpoint；恢復會重新執行 planner/reviewer，可能使用新的訂閱/API 額度，但不會重播 writer。
- Worktree 只隔離 working directory，仍共用來源 repository 的 Git object database/refs，不等同 container 或 VM。
- Reviewer 的 immutable 保證目前由同一份 captured context 加 workspace 前後指紋守衛提供；本機其他程序仍可能形成 TOCTOU 殘餘風險。
- Claude Workspace MCP 的 protocol、path、hash/no-clobber 與 fake CLI 整合已驗證；真實 Claude Code Writer 是否完整接受目前 CLI/MCP 參數仍待使用者批准後以訂閱額度 smoke test。
- GUI Managed legacy workflow 只允許 Codex／Claude resident 或 managed 身分成為 task-scoped Writer；
  Native external terminal 不在候選清單，也不會被 Writer Lease 降權。真實 GUI Managed 寫檔 smoke
  仍需 owner 明確批准訂閱額度；Grok/API Writer 保持停用。
- Raw debug capture 尚未實作；設定為 true 會直接拒絕啟動，而不是假裝啟用 retention 保護。
- Node 22 的內建 `node:sqlite` 仍會顯示 experimental warning。
- GUI 的 HTTP／安全整合測試與 browser 視覺流程已通過；2026-07-22 受控 Chrome 實機驗證了
  專案／Room 精確切換、external join decision、exact-seat wake/reply、bounded wait timeout、
  常駐 Codex／Claude 喚醒、雙 Enter，以及零檔案變更的 Writer 完成／apply-back。瀏覽器自動化
  送鍵會繞過 macOS text-input service，因此中文 IME 由 owner 在真實注音輸入來源下直接操作：
  composition Enter 不送出，後續雙 Enter 只新增一則帳本訊息。雙埠 cookie 視覺確認仍待人工驗收。
- `npm run repro:smoke` 會從 committed HEAD 建立 `--no-hardlinks` clean clone、跑完整 gate，並從該
  clone 產生實際 tgz、離線安裝與驗證 installed bin；不以 dirty working tree 代替發布來源。


## 授權

**PolyForm Noncommercial 1.0.0**（見 [`LICENSE`](LICENSE)）：原始碼公開，允許非商業用途——
個人使用、研究、教育、非營利與政府機構皆可自由使用與修改。**本授權不含商業使用權**；
版權人保留全部商業權利，商業授權另洽版權人（見 [`NOTICE`](NOTICE)）。

依 OSI 定義這是 source-available 而非 open source——差別只在「商用是否也開放」，本專案刻意不開放。
2026-08-29 前的歷史曾標示 Apache-2.0；該期間 repository 為 Private，未曾公開發布。
Private 只證明 visibility，不證明沒有任何人 clone 過——若當時有人取得副本，那份副本仍受
當時的授權條款拘束，本次變更不追溯。就本專案所知未曾對外散布，但這是陳述，不是保證。

## 狀態

尚未對外發布。Owner 已批准以 `gn01226919`、PolyForm-Noncommercial-1.0.0、版本 0.1.0 維持 sanitized
`orchestratory` GitHub repository；舊內部 Git history 不得推送。npm 與其他散布管道仍未批准；
公開 visibility 由 Owner 於準備完成後自行切換，並在同一時段啟用 Private Vulnerability Reporting
（原因與順序見 [`docs/RELEASE_CHECKLIST.md`](docs/RELEASE_CHECKLIST.md)）。
