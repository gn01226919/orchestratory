# 安全架構

## 1. 系統視圖

```text
TUI / Local Web UI / CLI
          │ untrusted user input
          ▼
    Application Controller
          │
          ├── Policy Engine ─── Hard-limit configuration
          ├── Approval Service ─ Human decisions
          ├── Workflow Engine ─ State machine/checkpoints
          ├── Event Bus ─────── Redacted typed events
          ├── Room Ledger ───── Numbered/redacted/tamper-evident local chat
          ├── Usage Guard ───── Calls/time/budget/circuit breaker
          │
          ├── Workspace Broker ─ Canonical paths/read/write leases/worktrees/MCP
          ├── Command Broker ─── Allowlisted executable + argv
          ├── Git Broker ─────── Read/checkpoint/diff operations
          └── Provider Adapters
                 ├── Codex CLI
                 ├── Claude Code CLI
                 ├── Grok Build CLI
                 └── Optional API clients

Local SQLite metadata + OS credential store
```

模型永遠不取得 Command Broker、secrets、任意 filesystem 或通用 process capability。唯一例外是
Claude Writer 可看見一個能力極小的本機 Workspace MCP facade；每個 tool call 仍由 broker 做
canonical path、type、size、敏感路徑、call count 與 optimistic hash 驗證，且沒有 delete、rename、
Git、shell 或 network 工具。

## 2. 信任邊界

### Boundary A：人類介面到 Controller

輸入可能包含惡意 prompt、路徑、model ID 或設定。所有欄位做 schema、長度、枚舉、canonical path 與授權驗證。

### Boundary B：Controller 到 Provider CLI/API

只傳送任務需要的最小內容。子程序使用 argv array、最小環境、受控 cwd、timeout、輸出上限與 process-group termination。

唯讀訂閱 CLI 在 owner-only 空白 scratch cwd 執行，provider 的 built-in shell、filesystem、network、
subagent 與 plugin 能力停用。Claude Writer 同樣在 scratch cwd 執行，只從 mode `0600` 的短生命週期
MCP config 取得被批准 worktree 的 broker；config 不放在 process argv，呼叫結束後刪除 scratch。

### Boundary C：Controller 到 Workspace

Repository 完全不可信。其文件、hooks、設定、測試與 executable 可能惡意。所有 I/O 經 Workspace Broker；Git hooks 預設停用或在隔離環境處理。

### Boundary D：模型輸出到 Tool Execution

模型輸出一律視為建議。結構化 schema 驗證之後仍需 policy、scope、risk 與 approval 檢查。

### Boundary E：Backend 到 Web Browser

Browser 是較低信任環境。Secrets、完整環境與 provider credentials 永不送到前端。Origin、Host、session、CSRF 與 message schema 均驗證。

## 3. 核心元件

### 3.1 Policy Engine

唯一的安全決策點，純函式優先、default deny。輸入包含 actor、action、resource、workflow state、limits 與 approval；輸出只能是 allow、deny 或 require-approval，並附 machine-readable reason。

UI、workflow 或 provider adapter 不得自行繞過 policy。

### 3.2 Workflow Engine

使用明確 state machine，不以模型自由文字決定控制流。每個 transition 驗證前置條件、遞增 counters、檢查 hard limits 並寫入 checkpoint。

每輪 writer 完成並通過 Git/file/symlink limits 後，SQLite 只保存 checkpoint ID、round、phase、
workspace fingerprint 與 counters，不保存 task、prompt、模型輸出或檔案內容。Process restart 先把
run 標成 `INTERRUPTED_RESTART`；人工 restore 必須重新提交 workflow、使用原 workspace、通過
fingerprint/profile 驗證並消耗 `restore-checkpoint` approval。恢復後跳過已完成的 writer，重新執行
planner/test/reviewer；不做自動 replay。

### 3.3 Workspace Broker

負責：

- Workspace allowlist 與 canonicalization。
- 一次擷取並限長的 status、tracked diff 與 bounded untracked text context 給所有 reviewer；並在平行 reviewer 前後驗證包含 changed file content 的同一 Git fingerprint。
- 每個 task 一份 active Writer Lease；task、room、workspace、worktree、executor 與單調遞增 epoch
  綁定。交接先保存 checkpoint，再撤銷舊 lease 及其所有子 Agent capability。
- File count、size、type 與 diff 限制。
- Symlink、path traversal、特殊檔案與 mount boundary 防護。
- UTF-8 text-only MCP、敏感路徑拒絕、SHA-256 compare-before-replace、new-file no-clobber 與 atomic replace。
- 一層式 bounded directory creation；不提供 delete 或 rename。

隔離模式會從啟動時驗證的 base commit 建立 `orchestratory/run-<uuid>` branch 與 owner-only
runtime directory 下的 Git worktree。建立前拒絕 repository-local external clean/smudge/process
filter 與 fsmonitor，並在 Git broker 中忽略 system/global config、停用 hooks。Orchestrator 不自動
merge、push、刪 branch 或移除 worktree。

### 3.4 Command Broker

不得接受 shell script 字串。內部資料模型：

```text
CommandRequest {
  executable_id,
  argv[],
  cwd_id,
  timeout_ms,
  network_policy,
  output_limit_bytes
}
```

`executable_id` 對應本機受信任 registry；不得由模型提供任意 executable path。

### 3.5 Provider Adapter

每個 adapter 封裝：

- Capability discovery。
- Model discovery/validation。
- Prompt/context serialization。
- Streaming event normalization。
- Timeout、cancel 與 process-tree cleanup。
- Usage/error normalization。

Subscription adapter 不接觸 credential store。API adapter 只在 call boundary 向 Secret Provider 取得短生命週期 secret handle。

目前 capability matrix：owner 可將 Codex／Claude 常駐、管理型或外接身分指定為 task-scoped
Writer；provider 仍強制 read-only sandbox，唯一寫入途徑是 epoch-fenced Workspace MCP 與隔離
worktree。外接 Writer 由 Writer Companion 執行並保留雙重身份。Grok subscription 與所有 API
adapter 只允許 Planner/Reviewer；Writer 不能選 in-place。

### 3.9 Room、MCP 席位與原生 PTY

Room Ledger 是 owner-only SQLite 的 append-only 編號帳本，訊息在持久化前先清除控制碼與遮蔽
秘密，並以 per-room SHA-256 chain 驗證。每個 allowlisted workspace 內啟動的 Codex／Claude／Grok
MCP stdio process 另在 owner-only `room-presence.sqlite` 註冊短租約；五秒 heartbeat、十五秒 lease、
stdio EOF 主動 unregister。單純在線不會出現在 GUI；該終端必須先對目標 Room 呼叫
`room_join_request`，側欄「新增 Agents」才顯示這個精確 session。Owner 再按加入，才以交易配置
不回收的 `codex1`／`codex2` 等 display identity、建立額外工位並允許 Room 寫入。原有
Codex／Claude／Grok／You 是常駐工作站，不會被 presence 租約取代或因臨時終端離線而移除。
未加入、跨 workspace、過期或已加入其他 Room 的 session 全部 fail closed，且 GUI 不取得 host PID、
raw session id 或 transcript path。Codex／Claude 官方 structured hooks 只使用 bounded
`session_id`／`turn_id`／`prompt`／`last_assistant_message` 欄位；session id 只保存 SHA-256，重試以
event key 去重。Legacy `room log-hook` 已改成 no-op，避免舊設定在沒有 GUI membership 時繼續錄音。

Room 與專案的邊界使用 canonical workspace exact match，不依賴相似的顯示名稱。`/api/rooms` 同時回傳
專案 basename、待核准數與可喚醒席位數；GUI 以「專案名 — 內部 Room ID」顯示，並將所有專案的申請數
納入全域提示。切換 GUI 只改變目前查看的帳本，不會改寫 presence 原本的 workspace/room 綁定。

原生 macOS fallback 仍可由 owner 以 `orchestrator room pty codex|grok` 主動啟動
`/usr/bin/script` PTY relay。`orchestrator room join` 已保留為明確錯誤提示，避免 agent 把 PTY
誤認為 MCP 席位；MCP 終端只能直接呼叫 `room_join_request`。
Relay 不落地 transcript，只將畫面同步到目前終端，同時在 RAM 保存固定大小尾段。由於 PTY 畫面
混合了 owner input、provider output 與 redraw，持久化作者固定為 `codex-terminal`／
`grok-terminal` 並附 provenance 警告；不可把它當成結構化 agent turn。Codex 固定使用 read-only
sandbox、never approval 並停用 shell/hooks/plugins；Grok 固定 plan mode、空 tools 並停用 web、
subagents 與 memory。這個 owner 互動 session 有四小時／30 Grok turns 上限，但無法可靠觀測原生
TUI 內每輪 token，不能取代自動 workflow governor。

額外席位明確分成兩種。`external-terminal` 由 presence 短租約建立，保留外部 CLI 上下文；
GUI 將訊息同時寫入共同帳本與該精確 presence 的 owner-only inbox，不另外呼叫 provider 冒充
終端。`room_join_request` 在提出申請後保持同一 host tool call，等 GUI 核准後立即進入第一段
bounded 收件等待；之後終端只有在這段等待或 `room_wait` 長輪詢期間才是「正在值班」，並以 delivery lease token
依序確認 `delivered/read/working/replied` 或 `failed`。取消、離線、租約過期、重送與 reply
idempotency 都由 inbox state machine 處理，絕不 fallback 到同 provider 的常駐席位。
完全 idle 的既有 MCP host 不能接受 server-initiated turn，休班時的 GUI 工作只會 queued；API 以
`wakeMode: active-tool-pull` 與 `wakeable: false` 明確揭露，不把 presence 誤報成可喚醒。
常駐 provider 的等待指示也不從 `@provider` 文字推測；`room_mention` 在真正開始 provider call 前追加
綁定原 mention sequence 的「回應處理中」system event，並以 reply/failure/cancel/clear 收旂。
沒有 start event 的舊帳本文字不會顯示永久等待；新的 `room_post` 若以 `@claude` 等 provider
提及開頭則 fail closed，明確要求 host 改用會真正發起呼叫的 `room_mention`。
`managed-subagent`（GUI 名稱「受控即時 Agent」）由 owner
在 GUI 明確建立，獨立身分保存於 owner-only `managed-room-agents.sqlite`，使用 per-row SHA-256
偵測竄改，每房最多 12 個活躍席位。每次 GUI 喚醒都是獨立、可取消、納入同一 quota 的
read-only planner 呼叫，注入有界 Room 尾段，並以席位完整名稱回覆。席位可不限次重複交談；
只限制同一席位同時一個進行中回覆。直接喚醒仍是唯讀；若 owner 將 resident、managed 或
external 身分指派為 Writer，控制面會為該 task 建立隔離 worktree 與 epoch-fenced capability。
外接 Writer 使用受控 Writer Companion，Room 帳本以自然語言顯示代理關係，獨立 HMAC technical
audit 保存 `on_behalf_of`、`executed_by` 與 `lease_epoch`。Writer 只能派一層子 Agent：同
provider 子 Agent 與父 Writer 共用同一 task worktree，透過 SQLite task run lock 與 5 秒心跳在
多個 GUI 程序間序列執行；跨 provider 子 Agent 只有唯讀能力。Codex／Claude 透過 revocable
read-only Workspace MCP；Grok 只取得控制面產生的 bounded Git snapshot，在空白 scratch 且無
filesystem tools 的程序中執行。禁止再轉派。父 Writer 交接、完成或席位移除時，所有 child
capability 同步失效。Writer 完成後先產生風險預覽；Owner 精確確認後，task 先持久化為
`applying` 才套回主專案，成功後才成為不可重開的 `applied`。新 GUI 啟動時若看到另一程序仍在
更新 task run heartbeat，會保留該 lease 且不能取得其 RAM capability；只有沒有活鎖的舊 lease
才以 fail-closed 方式撤銷。Writer 面板可依目前實際執行者精確取消 Writer 或單一 child run，並
區分 `review-ready`、`applying` 與 `applied`，不會把已回寫任務再次顯示成待回寫。
GUI 對 Room 提供兩個明確模式：直播可發言與喚醒模型；歷史模式只讀 owner-only 帳本，從最新訊息
開始每頁最多 100 則向前翻閱。兩者都以 allowlist 重新授權房間 workspace，不能藉歷史端點跨專案
讀取。PTY 尾段入帳前也會遮蔽 Codex resume session UUID。
辦公室是既有控制面的投影：Room 待回覆狀態來自 ledger，終端人物／桌位來自短租約 presence，
執行中角色與完成狀態來自
`/api/bootstrap` 與已遮蔽的 workflow events。它可顯示 Agent DND／目前工作、任務中心、通知與
完成／失敗動畫，但不能從這些卡片批准、啟動或修改 workflow。Agent 點擊只預填 `@agent`，仍需
owner 送出才會喚醒 provider。點 `@codex1` 會把訊息寫入帳本並排入該精確 MCP 席位的 inbox；
host 必須仍在 `room_join_request` 的核准後等待或正在呼叫 `room_wait` 才會即時收件，不會偷偷建立另一筆 provider call，也不會改送常駐
Codex。只有 `@codex`／`@claude`／`@grok` 才沿用明確的常駐 wake 語意。日夜、安靜、休閒與全螢幕偏好，以及頁內通知，全部只存在目前頁面
RAM，不新增持久化資料或權限。Miso 與 Byte 是純 HTML/CSS 的裝飾性辦公室夥伴，四足／雙足步態、
巡邏路徑與表情只在瀏覽器動畫層執行，不讀帳本、不呼叫 provider，也沒有控制面權限。

### 3.6 Approval Service

批准包含 actor、action、resource、workflow、expiry 與 nonce。批准不可泛用、不可跨 workflow 重放、不可由模型自行產生。

### 3.7 Usage Guard

每次呼叫前先檢查並保留 quota；完成後以 provider usage 或保守估算結算。無 usage metadata 時採最壞情境估算，不得假設為零。

目前 API 預算採更保守策略：依 UTF-8 byte 上限、owner 設定的 input/output 價格與最大輸出
token 預留整筆最壞情況費用，而且即使呼叫失敗也不自動釋放，避免 timeout 後無法確認 provider
是否已計費時低估支出。

### 3.8 Persistence

SQLite 僅儲存必要 metadata、狀態、事件摘要與 redacted audit。Secrets 不進資料庫。Schema v2
migration 包在 `BEGIN IMMEDIATE` 交易；啟動先後執行 quick check、版本上限、foreign-key check 與
per-run SHA-256 event-chain 驗證。舊事件在交易內回填 hash，任何錯誤 rollback 並 fail closed。

Owner-only `workspace-roots.json` 預設為空。新 workflow 先 realpath/canonicalize，再驗證位於明確
root 或其 descendant；字串 prefix、symlink alias 與 sibling prefix 不算授權。只有精確 run ID 對應的
app-owned retained worktree 可作人工 checkpoint restore 例外。

新增 root 有兩個 owner 入口：CLI 在實體 TTY 以精確 `ALLOW` 確認；loopback Web 則用固定
`/usr/bin/osascript` 資料夾選擇器或手動路徑，先建立五分鐘、single-use 的 RAM preview，再要求輸入
`ALLOW <folder-name>`。Web preview 封鎖 home、秘密／鑰匙資料夾、app data、`/Volumes`、非 owner、
world-writable、非 Git root 與既有 root；confirm 時重新 realpath 並比對 directory／`.git` 的
device、inode、mode、owner 與 type，防止 preview 後替換。成功後只透過既有 atomic owner-only
policy writer 更新 JSON，重新載入目前程序的 policy；picker 不經 shell，瀏覽器也不接收任意命令。

Retention policy 預設保留終止 run 30 天且最多 500 筆。Purge 先生成包含 run ID/updated-at/counters
的 immutable preview，排除 active/retained-worktree run；執行時重驗 snapshot 並交易刪除 cascade，
之後 secure-delete/WAL truncate/VACUUM。CLI 的 confirmation 與 nonce 不代表自動排程，系統永不自動 purge。
實際 purge 與 worktree cleanup 只能通過 `MaintenanceService`；服務層本身消耗與 preview
精確綁定的短效 single-use approval，並拒絕執行中 workflow。TUI、Web 或未來 adapter
只能發行請求，不能把介面層確認當成服務層授權。

## 4. 執行資料流

```text
使用者建立任務
  → 驗證 workspace/profile/limits
  → 建立 immutable run configuration
  → Planner 讀 snapshot
  → Writer 取得單一 write lease
  → 產生 diff
  → Reviewer 讀 immutable diff/snapshot
  → Tester 執行 allowlisted tests
  → Policy 判斷 finish / approval / next round
  → 保存 redacted summary
```

每個 provider call 前後都檢查 cancel flag、deadline、call count、output size 與 circuit breaker；另有
獨立 absolute workflow timer，可在 provider/test in-flight 時直接 abort。v1 不自動 retry provider call，
因此實際自動重試數為 0；round loop 只由 bounded tester/reviewer 結果觸發。

Tester 不接受模型提供命令。Owner-only `tester-profiles.json` 將固定 profile ID 映射到
Docker/Podman、digest-pinned image、entrypoint 與 argv。Command broker 固定加入 no pull、offline、
read-only、non-root、capability/resource constraints；profile 未設定、approval 缺失、runtime/image
不存在或測試修改 workspace fingerprint 時全部 fail closed。

## 5. 介面策略

- TUI 是預設介面，直接連同一 process 內的 application service。
- `orchestrator` 同時建立 RAM-only 對話 session 與 loopback Web server。對話主代理預設 Codex
  GPT-5.6 Sol；非斜線輸入一律送入對話 router，斜線指令在本機攔截且不進 provider prompt。
- Web 首頁建立獨立的 RAM-only 自然語言 session；一般聊天只驗證 workspace allowlist、不要求 Git clean。
  `coding_team` 只形成提案，寫入仍轉交既有 approval-gated workflow。Web server lifetime 累積
  provider-call ceiling，重設對話或切換 workspace/model 不會清零。
- Session tool registry 是編譯期固定白名單：`ask_claude` 為 Claude Fable 5 唯讀第二意見；
  `coding_team` 只能提出 bounded workflow request，必須經 `RUN`、workspace policy 與 scoped nonce 才能寫入。
- MCP 的 `request_coding_workflow` 同樣只建立跨程序 pending proposal：owner-only SQLite、最多
  100 件 pending、固定 actor、啟動時驗證 row integrity。GUI 顯示完整 task／workspace／角色／
  profile；提案本身沒有 nonce，也沒有執行能力。
- Room 辦公室保留 proposal queue 供一般 coding workflow 使用；Writer 面板則是獨立的 owner
  控制面。Owner 可為 task 選 resident、managed 或已加入的 external Writer、建立／交接 lease、
  選 Writer 本人或其子 Agent 執行、取消或完成。每次寫入都在 Workspace MCP mutation 前重新驗證
  task、epoch、executor 與 RAM capability；daemon 重啟後 capability 不會從 SQLite 復原，必須由
  owner 重新建立或交接，避免磁碟狀態自行恢復寫權。
- Owner 可在 GUI 明確選擇 RAM-only Dirty Snapshot：內容不上 SQLite/event/UI，只回傳檔案數、
  writes/deletes/bytes/hash 摘要；snapshot 綁 source HEAD/fingerprint、TTL、pending ceiling 與獨立
  single-use approval，只能匯入剛建立且 base 相符的隔離 worktree。
- 完成後 apply-back 先產生 RAM-only preview，再重新驗 source/worktree HEAD、全域 fingerprint 與
  逐檔 expected hash，使用另一份 scoped approval 才能寫回。寫入沿用 Workspace broker 的 CAS；
  刪除以 rename 移入 `~/trash-pending/orchestratory/`。多檔失敗會用 RAM 舊內容 best-effort rollback，
  rollback 失敗必須記錄 `APPLY_BACK_PARTIAL_ROLLBACK_FAILED`，不得宣稱完成。
- 工具協定要求整段輸出為單行結構化 marker；未知工具、混合文字、損壞 JSON 與超長 input 全部降級為普通文字，不執行。
- Session 歷史 RAM-only 並受 hard limits 約束；清除內容不清除 session call counter。真實 provider
  call 另經 `ProviderCallGovernor` 寫入 owner-only SQLite 的 24 小時全域窗口，跨程序不能重設。
- Workflow 批准後關閉 line-oriented readline，切換成 raw-key、定期重繪的 full-screen
  dashboard；dashboard 只讀取 application views，不直接操作 store、provider 或 Git broker。
- 單一 allowed root 會成為安全預設；沒有 allowed root 時 setup fail closed，不建立 workflow。
- Dashboard 顯示角色狀態、soft/hard usage 與 bounded recent events；取消需五秒內二次 `c`，避免誤觸。
- Web UI 是選配 adapter，不得擁有額外權限。
- TUI/Web 共用 Events、Messages、Diff、Tests、Usage view；Messages 只存在記憶體、每 run 最多 64 KiB、終止後 15 分鐘到期，完整 diff 只在 active run 本機限量讀取，完成後只保留摘要。
- CLI automation 使用同一 command/application layer，不另建繞過安全檢查的捷徑。
- 所有介面的安全決策結果應一致並可測試。

## 6. 擴充策略

v1 不載入任意第三方 plugin。未來擴充以：

- 編譯期註冊或簽章驗證的 adapter。
- 明確 capability manifest。
- 最小權限 sandbox。
- 版本與來源 pinning。
- 獨立 threat review。

為前提；不得以便利性為由直接執行未知 JavaScript、Python 或 shell plugin。
