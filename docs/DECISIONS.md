# 架構決策紀錄

> **Normative status update（2026-08-01）：** ADR-028 是目前最高優先產品決策。
> 下表標示的舊規則已被取代；保留原文只為歷史追溯，不得再當成 Native Full-Trust 的實作要求。

| 舊 ADR | 目前狀態 | ADR-028 後的適用範圍 |
|---|---|---|
| ADR-004／004A | 部分取代 | 原生 TUI 仍是主要 host；「模型只能提案、不能取得工具權限」不適用 Native Full-Trust |
| ADR-005 | 部分取代 | 用量／API hard limits 可保留；不得用它限制 Native terminal thread 或原生工具能力 |
| ADR-006 | **已取代** | Native 模式不再強制單一 Writer；GUI Managed 可保留 lease |
| ADR-007 | **已取代** | Broker 不再是 Native Agent 唯一 filesystem／Git／process／network 路徑 |
| ADR-011 | 部分取代 | Candidate 成為預設；任務終點必須詢問是否 merge main，不自動 push／cleanup |
| ADR-012 | 部分取代 | GUI/API managed worker 可維持限制；Native terminal 不受此限 |
| ADR-013 | 部分取代 | Managed test profile 可保留；Native host 測試不強制 container |
| ADR-015 | **已取代** | Workspace allowlist 用於 Room/candidate/main 身分，不限制 Native Agent 整台 Mac 存取 |
| ADR-019 | **已取代** | Read-only scratch／Workspace MCP 唯一寫入只適用 GUI Managed |
| ADR-022 | **已取代** | Native terminal 不再由 Orchestratory 強制唯讀；provenance/redaction 原則保留 |
| ADR-023 | **已取代** | Writer Lease／Companion 只保留給 GUI Managed，不限制 Native terminal／subagent |
| ADR-024 | 擴充 | Exact inbox 與 no-fallback 保留，新增 terminal-to-terminal sender/thread |
| ADR-025 | 部分取代 | GUI managed 授權保留；task completion 後的 main merge 必須是獨立決定 |
| ADR-026 | 部分取代 | Room/recording 選擇保留；不得用 join mode 升降 Native capability |
| ADR-027 | 擴充 | Membership/standby 分離保留；reply-and-wait 不逐回合重批，thread 無固定回合上限 |

## ADR-029 — 每小時唯讀督導（2026-08-13）

採用 deterministic local supervisor 作為進度與完整性偵測面，launchd 每 3600 秒執行一次。它檢查
canonical branch、main/origin drift、dirty worktree、diff check、Room chain、control-plane
SQLite quick/foreign-key integrity 與 Obsidian handoff marker；SQLite 僅以 read-only/query-only 開啟，
不啟動 migration/recovery、不讀 HMAC key。偏離時只 alert-and-stop，不能自動改寫任何成果或呼叫模型。
Provider/Claude dispatch 保持 optional 且 disabled by default。這不改變 Native Full-Trust、candidate
邊界或 merge approval，也不提供不可繞過的 OS 級保證。

## ADR-001：Local-first

**決策：** v1 完全在使用者本機執行，不依賴 Supabase、遠端 orchestrator 或公開 Web service。

**理由：** 降低攻擊面、資料外流與營運複雜度。未來遠端功能需獨立 threat model。

## ADR-002：訂閱 CLI 優先

**決策：** 預設以 Codex、Claude Code、Grok Build 官方 CLI 的登入與 headless 介面執行。

**理由：** 使用既有訂閱額度，且不需要 Orchestrator 管理其 session token。

**限制：** 訂閱額度與 token metadata 可能不完整，需以 calls/time/output 做保守限制。

## ADR-003：API 是明確選配

**決策：** API provider 預設 disabled，逐 provider 啟用，不自動 fallback，不自動加值。

**理由：** 防止意外計費與遭攻擊後無限制消耗。

## ADR-004：TUI 預設、Web 選配

**決策：** `orchestrator` 同時啟動自然語言 TUI session 與 loopback GUI。一般輸入一律是對話，
本機操作才使用斜線指令。主代理預設 Codex GPT-5.6 Sol，Claude Fable 5 與完整 coding team 以固定
tools 註冊；唯讀委派可自動執行，寫入前仍需 `RUN`。`orchestrator tui`／`gui` 可單獨啟動介面。

**理由：** 符合 Claude Code 類終端工作流、降低欄位誤填，且 Web 不成為必要攻擊面。

## ADR-004A：模型選工具，不讓模型取得工具權限

**決策：** CLI 不支援原生 function-calling transport 時，使用嚴格的單行結構化 tool marker 作為
相容層；只有整段輸出精確匹配固定 schema 才形成工具提案。工具提案仍由本機 policy 與 approval 執行。

**理由：** 保留自然語言 routing 體驗，同時避免 prompt injection 將任意文字升級成 shell、Git 或寫檔權限。

## ADR-005：軟限制與硬限制分離

**決策：** UI 可調 soft limits；hard limits 只能由本機 owner-only config 修改並重啟生效。

**理由：** 即使 UI、session 或模型被操縱，也不能把安全上限全部關閉。

## ADR-006：單一 Writer（由 ADR-023 細化）

**決策：** 同一 workspace 同一時間只有一個 agent 可寫入；reviewer 使用 immutable snapshot。

**理由：** 避免競態、覆寫、不可審查 diff 與惡意 agent 互相隱藏變更。

## ADR-007：Broker 與 Policy 架構

**決策：** 模型不直接操作 filesystem、Git、process 或 network；所有動作經 Workspace/Command/Git Broker 與中央 Policy Engine。

**理由：** 防止 prompt injection 與 excessive agency 直接轉成主機權限。

## ADR-008：SQLite 最小持久化

**決策：** 使用本機 SQLite 保存最小 workflow metadata，不保存 secrets，預設不保存完整 prompt/output。

**理由：** 易於備份與崩潰恢復，同時避免雲端資料庫與額外帳號。

## ADR-009：v1 不支援任意 Plugin

**決策：** v1 adapter 為程式內明確註冊，不載入未知第三方程式碼。

**理由：** Plugin 是高風險供應鏈與任意程式碼執行邊界，需另行設計簽章、capability 與 sandbox。

## ADR-010：開源前採阻擋式洩漏審查

**決策：** 首次 GitHub 公開與每次 release 都必須掃描 working tree、完整 history 與 artifacts，並經人類 GO/NO-GO。

**理由：** `.gitignore` 無法移除已提交的秘密，且個資常藏在 history、screenshot、log 與 source map。

## ADR-011：每 workflow 可選 Git worktree/branch 隔離

**決策：** 經人類逐次確認後，從已驗證的 base commit 建立 UUID branch 與獨立 worktree；
保留單一 Writer，且不自動 merge、push、刪 branch 或 cleanup。

**理由：** 降低 agent 修改原始工作目錄的 blast radius，也為未來平行的獨立任務建立邊界。
此設計參考 Composio Agent Orchestrator 的 per-session worktree 概念，但不採用其自動 PR/CI、
plugin 或自動 merge 權限。參考：<https://github.com/ComposioHQ/agent-orchestrator>。

## ADR-012：API Writer 暫不開放

**決策：** API adapter 只能唯讀規劃或審查；唯一 Writer 仍透過受控 coding CLI 執行。

**理由：** 一般文字 API 沒有可信 workspace sandbox。直接套用模型 patch 需要新的 schema、path、
TOCTOU、binary、rename 與 rollback 安全邊界，不能用方便性取代獨立 threat review。

## ADR-013：Repository 測試採 digest-pinned container profile

**決策：** 測試預設停用；owner 可在 owner-only policy 中建立 Docker/Podman profile，image 必須
鎖定 SHA-256 digest。執行固定 no pull、network none、read-only root/workspace、non-root、
cap-drop、no-new-privileges 與 CPU/記憶體/PID/output/timeout 限制，並逐 workflow 人工批准。

**理由：** 任意 repository test 是 host code execution。macOS `sandbox-exec`/SBPL 不是適合作為
公開產品長期契約的安全邊界；container 仍有 daemon/image 殘餘風險，但能提供明確、可測試且
fail-closed 的 filesystem/network/resource policy。

## ADR-014：崩潰恢復只允許人工 checkpoint restore

**決策：** 每輪 writer 完成後只保存 fingerprint/counters metadata。Restart 不自動 replay；只有
`INTERRUPTED_RESTART` run、匹配 checkpoint/workspace/profile、短效 single-use approval 才可恢復，
並沿用原 run counters 與 API reservation。

**理由：** 自動重播可能重複修改或計費；保存完整 prompt/output 又會擴大隱私風險。人工重新提交
workflow 並驗證 Git fingerprint，在可恢復性、成本與最小資料間提供較保守邊界。

## ADR-015：Workspace 授權採顯式 allowlist

**決策：** Owner-only allowlist 預設為空，不自動授權 cwd、home 或其他專案。只有
canonical exact root 或 descendant 可執行 workflow。

**理由：** 路徑便利不應擴大模型可讀寫範圍；sibling prefix、symlink alias 與預設目錄都不是授權。

## ADR-016：Purge 與 worktree cleanup 是 preview-bound 維護操作

**決策：** 兩者預設只顯示 preview；執行需精確文字確認與短效 single-use approval，
核心 `MaintenanceService` 再消耗 token、重驗 snapshot 並拒絕 active run。不 force、不刪 branch、不自動排程。

**理由：** 不可逆操作的授權必須跟具體快照綁定，且不能只依賴 CLI/GUI 介面層確認。

## ADR-017：SQLite schema v2 採交易 migration 與 tamper-evident event chain

**決策：** 啟動執行 quick/foreign-key/schema-version 檢查，migration 完全交易化；每個 run
的 event 以 SHA-256 前向串鏈驗證，異常時 fail closed。

**限制：** 該 chain 沒有外部簽章錨點；具有本機寫權者可重算內容，因此只宣稱 tamper-evident。

## ADR-018：供應鏈與釋出 gate 必須可決定性重現

**決策：** 依賴精確 pin、關閉 install scripts、使用 CycloneDX SBOM、deterministic fuzz、
離線 package snapshot reproduction、working-tree/history scan 與完整 SHA-pinned read-only CI。

**理由：** 不將 tag、可變 cache、長期 secret 或只在開發機成功的環境當成 release 證據。

## ADR-019：Provider CLI 與 Workspace capability 分離（由 ADR-023 細化）

**舊決策（已由 ADR-028 對 Native terminal 取代）：** ~~所有 provider CLI 都在空白 scratch cwd
執行並停用 built-in filesystem、shell、network、subagent 與 plugin。Task-scoped Writer 可由 owner
在 Codex／Claude 常駐、管理型或外接身分間切換，但 provider 本體仍強制 read-only sandbox，寫入
只能透過 task／worktree／executor／epoch 綁定的 Workspace MCP tools。外接 Writer 由 Writer
Companion 代為執行；Grok/API Writer 保持停用。~~

**vNext replacement：** 上述限制只保留給 GUI Managed／legacy worker。Native terminal 的 capability
authority 在 host；join、standby 與 Room mode 都不得改寫或降低 host 能力，也不再列入 Writer Lease 候選。

**理由：** CLI 的「唯讀」權限不必然代表不能讀取 workspace 外檔案。把 provider cwd 與實際
workspace 分開，再用 text-only、hash-bound、無 delete/shell/network 的 broker 縮小 blast radius。

**限制：** 真實 Claude CLI/MCP 相容性需要使用訂閱額度的 smoke test；未經 owner 批准前只執行
fake-CLI、protocol 與 broker regression tests。

## ADR-020：Reviewer context 必須涵蓋 untracked 內容與 content fingerprint

**決策：** Reviewer 取得同一份 bounded tracked diff 與 bounded untracked text；敏感路徑、過大檔案
或總 context 超限時停止。Fingerprint 納入 tracked/untracked changed file 實際 bytes，changed bytes
另有固定 50 MiB ceiling，binary 內容不直接傳送。

**理由：** 只看 `git diff` 會漏掉新檔；只看 status、size 或 mtime 會漏掉 same-size mutation，讓
惡意或外部程序在 review 前後隱藏變更。

## ADR-021：訊息只做短生命週期記憶體 view，deadline 可中斷 in-flight call

**決策：** TUI/Web 的 Messages view 不寫 SQLite，每 run 最多 64 KiB，終止 15 分鐘後清除。
Workflow absolute deadline 由獨立 timer 直接 abort provider/test process tree，不只在 round 邊界檢查。

**理由：** 提供即時監控時仍維持最小持久化；並避免單次掛起呼叫繞過整體 workflow wall-time hard stop。

## ADR-022：原生 PTY Room bridge 預設關閉且不冒充結構化 turn

**舊決策（已由 ADR-028 取代）：** ~~macOS 僅允許 owner 以 mode 0600 的精確 capability gate 啟用
Codex/Grok PTY bridge。Provider、argv 與唯讀模式固定，不接受額外 flags、不經 shell。Capture 只保存
RAM bounded tail，入帳作者固定為 `codex-terminal`／`grok-terminal` 並標明混合畫面。~~

**vNext replacement：** Orchestratory 不包裝或降權既有 Native Codex／Claude Code host；MCP 只提供
協作控制面。Legacy PTY bridge 可留作 GUI Managed 相容功能，不得冒充 Native Full-Trust 路徑。

**理由：** 原生 TUI 對使用者最熟悉，但 PTY stream 同時含輸入、輸出與 redraw，不能可靠切割為
agent turn；provider 自有設定也不等於 Orchestratory approval。預設關閉、固定唯讀 capability 與
誠實 provenance 能保留 UX，而不把較弱的觀測能力包裝成較強的安全保證。

**限制：** 無 controlling TTY 的自動測試只能驗證 argv、bounds、redaction 與平台命令 probe；
真實互動 relay、上游 CLI 行為及訂閱消耗仍需 owner opt-in smoke test。

## ADR-023：Task-scoped Writer Lease、Writer Companion 與單層委派

**決策：** 每個 GUI Managed task 同時只有一份 active Writer Lease，綁定 room、workspace、worktree、executor
與單調遞增 epoch。~~Owner 可在 resident、managed、external 身分間交接；外接身分的受控寫入由
Writer Companion 執行。~~ vNext 只允許 resident／GUI Managed 候選；Native external 不進入此路徑。
Room 帳本自然語言揭露代理關係，HMAC technical audit 保存
`on_behalf_of`、`executed_by` 與 `lease_epoch`。同 provider child 與父 Writer 共用 task
worktree，並由持久化 run lock 序列執行；跨 provider child 唯讀。Codex／Claude 使用 revocable
read-only Workspace MCP；Grok 只讀控制面生成的 bounded Git snapshot，不取得 worktree 或
filesystem tools。所有 child 禁止再轉派並隨父 lease 撤銷。apply-back 先進入持久化 `applying`
狀態，成功後才標記 `applied`；不確定狀態維持 fail closed，不能重新授權。

**理由：** Writer 必須能依任務切換，也必須允許擴充分工；把寫入權綁在 task、epoch 與技術
executor，而不是 UI 名稱或 provider 類型，才能兼顧彈性、可追責與 stale-write 防護。

## ADR-024：外接 MCP 席位使用精確 pull inbox，不做 provider fallback

**狀態：** pull inbox 與 no-fallback 決策仍有效；「加入後直接開始首輪收件」已由 ADR-027 取代。

**決策：** Owner 對外接席位的 GUI 訊息同時進 Room Ledger 與該 presence 的 owner-only inbox。
外接終端以 bounded `room_wait` 收件；
後續終端以 bounded `room_wait` 收件，依序 ack read／working，最後 reply 或 fail；每筆 delivery 使用
私有短 lease、bounded retry、cancel/offline terminal state 與 idempotent reply receipt。未值班時
GUI 與 API 誠實顯示 `wakeable: false`，禁止改送常駐模型或由 GUI 冒充原終端。需要不依賴外部
host pull 的立即喚醒時，使用分離身分的受控即時 Agent。

**理由：** MCP stdio 無法由 server 對任意原生 CLI 注入 unsolicited keystrokes。精確 pull inbox
保留每個終端自己的上下文與身份，同時避免「看似回覆、實際由另一個模型處理」的錯誤協作。

Room 選單以專案 basename 為主顯示、內部 Room ID 為輔，而實際授權與路由仍以 canonical workspace
exact match 為準。這避免 `room-default-*` 等技術 ID 讓 owner 誤以為不同專案共用一間 Room，同時不冒險改寫
已存在的 append-only ledger 身份。待核准數為跨 Room 全域提示，但核准動作仍只作用於該申請原本綁定的 Room。

常駐 provider 呼叫的 GUI 等待狀態使用 append-only lifecycle event，不以任意 `@provider` 文字當作執行證據。
只有 `room_mention` 寫入「回應處理中（提及 #N）」後才為 pending；同一 #N 的 reply、failure、cancel 或 clear
收旂。新的 `room_post` 若使用 provider-prefixed `@mention` 會 fail closed 並要求改用 `room_mention`；
這同時避免工具誤用、從舊帳本重載或 daemon 重啟後產生幽靈等待。

## ADR-025：Loopback GUI 的 owner 操作是可逆 Writer 工作的明確授權

**決策：** 當 GUI 由本機終端啟動、只綁定 loopback，且 session、Host、Origin 與
CSRF 全數驗證通過時，owner 在 Writer 面板主動點選「交接、執行、取消、完成、單層委派」
即構成對該次可逆、隔離、worktree-only 動作的明確授權。Backend 創建並綁定 worktree；
瀏覽器永不取得 Workspace capability。Apply-back、刪除、發布、遠端寫入、API 花費與
repository test 仍需獨立、範圍化、短效且 single-use 的 human approval。

**理由：** GUI 是 owner 的本機控制面，重複要求同一人為每個可逆步驟再輸入 nonce 只會增加
摩擦，不會增加不同的授權來源。安全邊界放在 worktree isolation、Writer Lease epoch fencing、
bounded Workspace MCP、完整 ledger／HMAC audit 與最後 apply-back 的人工風險審核。

**限制：** 這不是無限權限，也不允許模型自行把 proposal 升級成 owner 操作。任何非
loopback、session／Origin／CSRF 不符、繞過 worktree、stale epoch 或無法完整記錄的請求一律 fail closed。

## ADR-026：Room collaboration mode 由 Owner 核准並由 broker 強制

**決策：** 外接 MCP session 呼叫 `room_join_request` 後，GUI Owner 必須選擇 `room-first` 或
`seat-only`，另以 boolean 決定 supported structured hooks 是否同步可見 user／assistant turns。
選擇綁定 exact presence＋Room＋canonical workspace，Agent 不能自行選擇、變更或跨 workspace 使用。
room-first 將所有 Orchestratory `ask_*`／`compare_agents` 經同一 Room ledger 執行；每次保存
`readThroughSeq`，append mention／lifecycle／reply，compare 依序執行。seat-only 只提供精確 GUI
inbox／席位，standalone worker call 不宣稱入帳。

**理由：** MCP 註冊、加入房間、可被 GUI 交辦、可見對話同步與所有 broker 協作入帳是不同能力。
把它們混為單一隱含狀態，會造成偷偷錄音或「以為其他 Agent 看過帳本、實際走了旁路」；由 Owner
在加入點做一次明確選擇，並由 server 路由而非 prompt 自律，才能讓帳本成為可驗證的第一手資訊面。

**限制：** MCP 只能強制它所代理的呼叫；provider 原生且繞過 Orchestratory 的 subagent／host
協作無法攔截，UI 與文件必須誠實標示此邊界。Snapshot cursor 只代表該次呼叫開始前已讀至哪一則，
不保證在 provider 執行期間持續看到新訊息。

## ADR-027：Room membership 與 session-scoped `room_wait` 待命分離

**決策：** `room_join_request` 只提出並等待 Room membership 核准，核准後返回。已加入的精確
MCP session 呼叫 `room_wait` 時，控制面建立另一筆 GUI 待命申請；Owner 核准後，同一個 open
tool call 才能成為 `wakeable: true`。核准綁定 exact presence＋Room＋canonical workspace，Owner
可撤銷；client cancellation、stdio EOF、presence lease 過期或四小時 hard timeout 都會終止 active
wait。待命未核准時拒絕新的精確席位交辦。終端必須在每次 timeout、回覆或失敗後再次呼叫
`room_wait` 才持續待命，系統不建立 managed proxy 或 provider fallback。

**理由：** 「已加入房間」、「Owner 允許 GUI 對該 session 派工」與「原終端目前正阻塞等待工作」
是三個不同事實。分離狀態後，終端關閉仍能由既有 EOF／lease 機制自動移除，而 GUI 也不會把只是
在線或只是加入的 Agent 誤報成可喚醒。一次 session-scoped 核准保留低摩擦，active wait 則提供
可驗證的精確喚醒路徑。

**風險與回滾：** 部分 MCP client 可能自行施加低於四小時的 request timeout；此時 active wait
結束後 GUI 必須立即顯示不可喚醒，不能延長或冒充。若需回滾，只能縮短 bounded wait 或恢復每次
`room_wait` 的核准；不得回到「加入即待命」或用同 provider 新回合代收。

## ADR-028：Native Full-Trust、Peer Thread 與 Candidate → Main Merge Decision

**狀態：Accepted / Normative**

**日期：2026-08-01**

**Owner 決策：** Orchestratory 採用「完整控制優先」。由原生 Codex／Claude Code 等 TUI host 執行
的 terminal Agent，加入 Orchestratory 前後必須保留 host 原本提供的完整能力。Orchestratory 不對
它加上 read-only、workspace jail、Writer Lease、Workspace MCP 唯一寫入、subagent 禁止、network
禁止或固定 thread 往返上限，也不主動替它啟用 provider 的全域 skip-permissions。

每項修改型任務預設建立 candidate workspace。Candidate 是成果與 canonical main 的工作分流，
不是限制 Agent 整台 Mac 權限的 OS sandbox。Agent 準備直接修改 main 時，必須主動說明將離開
candidate 修改邊界、列出精確路徑、操作、diff、風險與復原點，並等待使用者同意。

任務完成時，系統必須凍結 candidate completion checkpoint，顯示 candidate/main HEAD、diff、測試、
刪除、衝突、main drift 與 recovery readiness，然後主動詢問：

> 是否將這個 candidate 的精確完成快照 merge／promote 到 main？

核准只適用一次，綁定 task、candidate path/HEAD、main path/HEAD、operation 與 preview digest。任何
drift、scope expansion 或未預覽 conflict 都使核准失效並要求重新預覽。拒絕或暫緩時保留 candidate；
成功 merge 後不自動 push、publish、deploy 或 cleanup。

已加入同一 Room/canonical workspace 的 exact terminal seats 必須能彼此發現、直接傳訊、引用、等待、
回覆與持續 thread。Sender identity 由 authenticated presence 綁定，不得硬編碼成 `you`；指定 exact
seat 時不得 fallback 到同 provider 常駐 worker。Transport wait 可以 timeout/reconnect，但 thread 不設
8、16 或其他固定最大往返輪數。

GUI Managed 是另一個明確模式，可由 Owner 選擇 read-only、writer 或 full-trust，並沿用 Writer
Lease、Workspace MCP 等控制。Managed policy 不得暗中套用到 Native Full-Trust terminal。

**理由：** 使用者採用協作器是為了放大多個原生 Agent 的協作與因應能力。如果協作器讓 Agent 比
單獨使用原生 TUI 更受限，就失去產品價值。將風險控制集中在 candidate/main 分流、任務終點決定、
快照、備份與復原，可以保留能力並降低誤刪或錯誤套入主線的影響。

**誠實限制：** 同一 macOS 帳號下具完整權限的 Agent 可以繞過 Orchestratory，直接修改 main、刪除
備份或停止監控。因此 Native Full-Trust 是 behavior + monitoring + recovery 邊界，不是不可繞過的
安全 sandbox。若需要強制 main 保護，必須另採不同 OS 身分、root-owned guardian、唯讀 volume 或
外部不可變備份，且不得在 Native Full-Trust 名義下偷偷降權。

**取代與擴充：** 本 ADR 依本文件開頭矩陣取代 ADR-004A、005、006、007、011、012、013、015、
019、022、023、025、026、027 的衝突部分，並擴充 ADR-024 的 exact inbox/no-fallback 設計。

## ADR-029：正式 daemon 使用 digest-pinned runtime，migration 與舊 binary 成對復原

**狀態：Accepted / Normative**

**日期：2026-08-02**

**決策：** macOS LaunchAgent 不得指向 Git working tree、TypeScript source 或 npm-link。正式服務只能
由已通過 release gate 的 tgz 安裝到 artifact digest 識別的實體目錄，backend 與 public assets 一起
切換；Room GUI 另以 bootstrap protocol 拒絕混版。Source checkout 執行 `daemon install` 必須 fail closed。

任何持久資料 schema cutover 前，保存 SQLite online backup、plist、舊 release source/artifact 與 digest。
Migration 只接受精確已知 schema/index/CHECK fingerprint 與有效 row hash，在單一 `BEGIN IMMEDIATE`
交易內重建；未知 variant、內容/ledger receipt 不一致或任何 SQL 失敗都 rollback。正式驗收後仍保留
上一 binary＋DB recovery set，不做自動清理。

**理由：** 長駐 Node backend 會把模組留在記憶體，但舊 Web server 可在 request 時重新讀取磁碟上的
public asset。若正式安裝直接連著開發 repo，就可能形成舊 backend＋新 frontend；開發中的中途 schema
也可能先改到正式 DB。版本與資料成對切割，才能讓 candidate/main 分流之外也有可靠的 runtime/data
復原邊界。

## ADR-030：本機模型只走 loopback-only adapter，且必須由 Owner 明確設定

**狀態：Accepted / Normative**

**日期：2026-08-05**

**決策：** 新增 `local` provider adapter，透過既有 `ProviderAdapter` 介面與 registry 註冊，用來驅動
Ollama、LM Studio 與 llama.cpp 這類提供 OpenAI 相容 HTTP 介面的本機模型伺服器。Base URL 由 Owner
提供，未提供時不註冊該 provider，任何查詢 fail closed。

Endpoint 驗證是硬性安全邊界：只接受 `http://127.0.0.1:<port>`、`http://[::1]:<port>` 與
`http://localhost:<port>`，且 `localhost` 會被固定成 `127.0.0.1`。非 loopback host、非 http scheme、
帶帳號密碼的 URL、含 path/query/fragment 的 URL 以及缺少 port 一律以穩定代碼拒絕。Adapter 不跟隨
redirect，收到任何 3xx 直接失敗。每次呼叫只嘗試一次，具明確 timeout 與輸出 byte 上限，模型探索
（`/v1/models`，缺席時退到 `/api/tags`）必須 schema 驗證且不得退化成空清單。傳輸錯誤只以
`LOCAL_*` 代碼呈現，不外洩原始 socket／errno 字串。

本機模型不使用 credential、不進入 API 模式，因此也不進入計費預算路徑；`prepareApiCall` 對 `local`
直接 fail closed。Writer 能力關閉，只作為唯讀 provider。

**理由：** 本機模型不消耗訂閱額度，是明顯的產品需求；但「可設定 base URL 的 provider」若不限制目的地，
等於在產品內建一條把 prompt 與 source 外送任意主機的通道。把目的地限制在 loopback、拒絕 redirect，
並讓未設定時完全不存在，才能在提供功能的同時維持預設拒絕。

**誠實限制：** 同帳號程序仍可在本機 port 上架反向代理再往外轉送；本 ADR 只保證連線目的地是本機
介面，不保證本機那個程序的行為。本機模型輸出與其他 provider 輸出一樣是不可信內容。

**尚未完成：** GUI/TUI 進入點（provider 選單、endpoint 設定畫面）由後續工作負責；在那之前 `local`
無法被 workflow request 選取。無成本預算路徑已由 ADR-031 補上。

## ADR-031：無金額成本是 provider 明確宣告，且只免除金額預留一項

**狀態：Accepted / Normative**

**日期：2026-08-05**

**決策：** 新增 `src/providers/billing.ts`，以兩張對 `ProviderId` 完整（`satisfies Record<ProviderId, …>`）
的宣告表定義每個 provider 的 `ProviderBillingModel`（`billed` / `no-cost`）與 `ProviderExecutionModel`
（`subprocess` / `in-process`）。`fake` 與 `local` 宣告為 `no-cost` 與 `in-process`；`codex`／`claude`／
`grok` 為 `billed` 與 `subprocess`。查表落空時丟 `PROVIDER_BILLING_MODEL_UNDECLARED`／
`PROVIDER_EXECUTION_MODEL_UNDECLARED` 而非回傳預設值。

`WorkflowService` 依宣告分流：`no-cost` 不執行 `reserveApiBudget`，改以 `provider.no-cost` 事件記錄
「刻意跳過金額預留」；`billed` 維持原本的 `prepareApiCall` ＋ per-call／per-run／per-day／per-month
預留。宣告為 `no-cost` 的 provider 若帶 `authMode: "api"`，直接 `NO_COST_PROVIDER_HAS_NO_API_MODE`
fail closed。子程序計數改由 `ProviderExecutionModel` 決定，`local` 不再佔用 `maxSubprocesses` 名額。
`provider.completed` 事件一律帶 `billing`，且 `no-cost` 呼叫必定帶 `estimatedCostUsd: 0`；TUI dashboard
把 no-cost provider 顯示為 `no cost` 而非 `subscription`，usage 明細另列一行標明 `measured cost $0.00`。

**理由：** 產品規範要求 API 模式必須有四層金額上限，但本機模型沒有金額可扣，硬要預留只會擋掉它或
寫下無意義數字。相對地，「沒有金額成本」絕不等於「沒有限制」：免費端點上的 agent loop 正是硬上限
要擋的失控情境。把兩者分開，並讓免除路徑成為必須逐 provider 宣告的能力，才能同時避免「本機模型被
預算擋死」與「未來 provider 因遺漏而默默免預算」。

**誠實限制：** `local` 不啟動子程序，所以 `maxSubprocesses` 對它不適用；其資源消耗只由呼叫數、輪數與
時間上限間接約束。本機推論仍可長時間佔用 CPU／RAM／磁碟，Orchestratory 沒有、也不宣稱有主機資源
配額控制。詳見威脅模型 F22。

**尚未完成：** `local` 仍未進入任何 GUI/TUI provider allowlist（`src/ui/request.ts`、`src/ui/tui.ts`、
`src/ui/web.ts`、`src/core/workflow-request-store.ts`），因此本次變更後仍無法由 workflow request 選取。

## ADR-032：Merge preview 以 `git merge-tree --write-tree` 實際試算，而非以啟發式推測

**日期：** 2026-08-06
**狀態：** Accepted

### 背景

`candidate_complete` 產生的 preview 是 Owner 決定是否 merge 的唯一依據，而 Phase 5-3 之後
**核准會綁定 `previewDigest`**。在此之前，preview 的 `conflicts` 只有三句與 drift／dirty main 有關的
罐頭字串——**從未實際試算過合併**，等於請 Owner 對一個「衝突未知」的 merge 簽名。

同時 `#diff` 使用 `git diff --name-status`，該格式丟棄 file mode，因此純權限變更（644→755）與
submodule 指標變更（mode `160000`）都與一般 modify 無法區分。

### 決策

1. **改用 `git diff --raw -z --find-renames`** 保留新舊 mode，並以錨定的精確 regex 解析；不符即以
   `CANDIDATE_DIFF_INVALID` 拒絕，不做猜測。`mode` 只在兩側皆非零且相異時輸出（對 `000000` 的
   新增／刪除不是權限變更）。
2. **新增 `#mergePreview`，執行 `git merge-tree --write-tree --name-only -z`**，cwd 設為 candidate
   worktree（與 main 共用 object store）。它不動任何 ref、index 或工作樹，符合「preview 不得修改
   canonical main」的規則。
3. **退出碼單獨決定不了任何事。** git 對自身錯誤同樣回 exit 1（實測：`not something we can merge`），
   因此只有 stdout 形狀吻合兩種已記載格式之一才接受結果，其餘一律以
   `CANDIDATE_MERGE_PREVIEW_UNAVAILABLE` fail closed——**絕不以省略或預設值回報 `mergeable: true`**。
4. 新欄位（`mergeable`／`mergeConflicts`／`modeChanges`／`submodules` 與其截斷旗標）全部位於
   `preview` 內，因此自動納入 `previewDigest`，並在讀取路徑以同等嚴格度驗證。

### 為什麼不是啟發式

「同一個檔案兩邊都改就算衝突」這類啟發式會在最常見的情況下答錯：兩邊改同一檔的不重疊區段，
git 會自動合併。實際試算是唯一能讓 preview 與真實 merge 一致的方法，而一致性正是 5-3 綁定核准的前提。

### 代價與殘餘風險

- `--write-tree` 會在共用 object store 寫入不可達的 tree/blob（實測 `git fsck --unreachable` 確認），
  不影響 main 的可見狀態，待 gc 回收。
- **merge driver 會執行**：`.gitattributes` 指定的 driver 來自 repo 自身 `.git/config`，preview 因此
  會 spawn `/bin/sh -c <字串>`。保真度因此優於原先預期（兩邊都跑、結果一致），但安全面須誠實記載，
  見威脅模型 **F23**。global／system 設定與 hooks 已由 `minimalGitEnvironment` 抑制。
- **Hooks 不執行**，而實際 merge 會跑；實測分歧方向為真（preview 說可合併，實際 merge 因
  `pre-merge-commit` 失敗而停在中途）。**必須在 Phase 5-5 promotion 之前處理。**
- 清單有上限（衝突與 submodule 各 100 筆）並回報截斷旗標。**Phase 5-5 之前必須改為「截斷即不可核准」
  或提供分頁**——否則 Owner 是對看不到的內容簽名。
- `mergeable: true` 的語意是「沒有內容衝突」，不是「merge 一定會成功」：dirty main 會讓實際 merge
  在進入衝突解析前就中止。該情況由 `conflicts` 的 `CURRENT_DIRTY_MAIN_CHANGES_ARE_EXCLUDED_FROM_CANDIDATE`
  與完整的 `mainDirty` baseline 另行呈現；**5-5 必須要求乾淨的 main 工作樹**。

## ADR-033：Merge 核准是 snapshot-bound、single-use、只授權 merge 的獨立記錄

**日期：** 2026-08-06
**狀態：** Accepted

### 背景

ADR-032 讓 preview 說真話，Phase 5-5 會依 preview 寫入 canonical main。中間缺的是核准本身：
**一份能被重放、能套用到別的 snapshot、或能在綁定值改變後仍生效的核准，等於 Owner 核准的不是他看到的
那個東西。**「同意」在此之前只是 `candidate_complete` 回傳的一句問話，沒有任何結構承載它。

### 決策

1. **要求與核准分離。** `main_merge_preview`（唯讀，不寫任何東西）→ `main_merge_request`（Agent 建立
   `requested` 記錄，**不含 token、授權不了任何事**）→ Owner 在本機介面以精確短語 `MERGE INTO MAIN`
   核准 → 5-5 消耗一次。Agent 不得把自己的文字或 Room 訊息換成核准。
2. **請求必須先預覽。** `main_merge_request` 要求呈交剛給 Owner 看過的 `previewDigest`，與此刻重算的
   結果不符即 `MAIN_MERGE_PREVIEW_DIGEST_STALE`。因此不可能對沒有人看過的快照提出請求。
3. **綁定在三個時點各驗一次**：建立、核准、消耗。只在建立時驗證，等於放行建立之後發生的一切變化，
   而那正是核准存在的期間。任一綁定值改變即以 `MAIN_MERGE_APPROVAL_BINDING_CHANGED:<欄位名>` 拒絕
   ——**拒絕，不是靜默重算**——並把該 approval 轉為終局 `invalidated`。**拒絕會指名改變的欄位**，
   因為只說「有東西變了」的拒絕，讓 Owner 沒有任何可行動的資訊。
4. **獨立的表，不是既有帳本的擴充。** schema v4 新增 `candidate_merge_approvals`，沿用同一套 row-hash
   紀律。`candidate_requests` 記錄「mutation 有沒有發生」，這張表記錄「Owner 授權了什麼」：生命週期、
   終局狀態與出錯後果都不同，而那本歷經十一輪審查的帳本不該為此改形。approval 的 durable artifact 就是
   它自己那一列，所以 idempotency 由 `client_request_id` 的 UNIQUE 欄位承擔，不需要第二套 reservation。
5. **Single-use 由儲存層保證，不由檢查保證。** 消耗是 `state` ＋ `row_hash` 的 compare-and-set；並行
   消耗只有一個能改到那一列，輸家收到 `MAIN_MERGE_APPROVAL_ALREADY_CONSUMED`。終局狀態在唯一的
   UPDATE 出口結構性禁止再被移動——五個動詞共用一列，把「終局」只寫在其中幾個動詞裡的狀態機，就是
   一個已用掉的核准可以復活的狀態機。
6. **截斷即不可核准**（提前關閉 ADR-032 記下的到期項）。`filesTruncated`／`submodulesTruncated`／
   `mergeConflictsTruncated` 任一為真、或模擬出衝突，都使該 snapshot 不可核准，寫入路徑與讀取路徑
   都擋。Owner 不對看不到的內容簽名。
7. **授權不得外溢。** 每筆 approval 帶固定 `grants: "merge-candidate-into-main"`，消耗時必須指名同一個
   action，其餘一律 `MAIN_MERGE_APPROVAL_ACTION_NOT_GRANTED`；授權物件另以 `notAuthorized` 明列
   push／publish／deploy／delete-candidate／delete-recovery-ref／cleanup-worktree 等**不**被授權的動作，
   讓下游不必自行推論邊界。
8. **拒絕不是刪除授權。** 拒絕、失效與逾時完全不執行 Git 指令；candidate、checkpoint 與 recovery ref
   逐位元不變，Owner 可重新 preview 再問一次。已核准者亦可由 Owner 撤回。

### 為什麼核准不是 RAM-only

既有的 `ApprovalService` 是行程內、RAM-only 的。Merge 核准跨行程：提出請求的是 MCP seat，核准的是
GUI，消耗的是未來的 promotion service。RAM-only 的核准在 GUI 重啟後消失，而**「並行消耗只有一個成功」
必須由持久狀態的 compare-and-set 保證**，不能靠某一個行程的記憶體。

### 代價與殘餘風險

- **本階段不寫入 canonical main。** `consumeMainMerge` 只驗證與轉移狀態，且刻意沒有任何 MCP／HTTP
  出口——否則 Agent 可以在沒有 merge 的情況下把 Owner 的核准燒掉。實際 promotion 屬 Phase 5-5。
- Approval **不涵蓋 hooks 行為**，且 `mergeable: true` 只保證「沒有內容衝突」。兩者在 5-5 都會失效，
  屆時必須要求乾淨的 main 工作樹並處理 hooks（見 ADR-032 與 [[VERIFICATION]] Phase 5-3 殘餘風險）。
- 逾時後必須重新 preview，成本由 Owner 承擔。**這是刻意的摩擦，不是缺陷。**
- 同帳號程序可直接改 approval store——與整個產品的信任模型一致（見 [[THREAT_MODEL]] §2）；row-hash 與
  scalar／preview 互為冗餘的校驗只讓竄改「可偵測且不可用」，不讓它「不可能」。
- 帳本無 TTL：每個 task 上限 50 筆 approval，總量由 `inventory()` 的 `mergeApprovals`／
  `mergeApprovalsOpen` 曝露，超過即 fail closed 而非默默成長。

## ADR-034：綁定漂移在下一次觀察時就失效，並留下可稽核的紀錄

**日期：** 2026-08-06
**狀態：** Accepted

### 背景

ADR-033 在**建立、核准、消耗**三個時點驗證綁定。中間仍有一段沒人看的區間：核准存活期間 main 或
candidate 動了，approval 依然在每一條讀取路徑上顯示成 `approved`——因為 `state` 直接來自那一列，
沒有任何讀取會重看 live state。Owner 與 agent 因此可能一直看著一個「已經不描述任何東西」的決定，
直到有人試圖消耗它才發現。**一個沉默失效的核准，和一個從未發生的核准，在紀錄上也無法區分。**

### 決策

1. **每一條 approval 讀取路徑先驗綁定，再回報那一列。** `candidate_status`、approval 列表與
   `inspect` 共用同一個 `#observeMergeApproval`；漂移者在被回報之前就已**持久**轉成終局
   `invalidated`，`refusal` 帶 ADR-033 同一套欄位名稱與偵測它的介面。因此「顯示為失效」不需要每個
   surface 各自實作，它就是那一列本身的狀態。
2. **「重新詢問」也是一種觀察。** `main_merge_request` 在檢查「每個 task 只有一個未決問題」之前
   先跑同一個檢查。否則一個已經停止適用的核准會佔住那個結構性名額直到 TTL 到期，而它擋掉的正是
   失效本身要促成的那次重問——直接違反「失效不得破壞任何東西，Owner 可立即重問」。
3. **「查到了、值不同」與「根本查不到」必須分開，因為兩者的後果相反。** 綁定檢查逐欄位獨立探測：
   每一個探測各自 try/catch，成功但值不同記入 `changed`，讀不到則記入 `unverified`，**任何例外都不會
   變成「已改變」**。只有 `changed` 非空才會失效；`changed` 為空而 `unverified` 非空時，approval
   **不**失效、`token_hash` **不**清除、**完全不寫任何列**，只回
   `bindingCheck = {checked:false, valid:false, changed:[], unverified:[…],
   unavailable:"MAIN_MERGE_APPROVAL_BINDING_CHECK_FAILED"}`；環境恢復後下一次觀察即回到
   `{checked:true, valid:true, changed:[]}`，該核准仍可正常 consume。`grant`／`consume` 遇到同樣情形
   以獨立錯誤型別 `MergeApprovalBindingUnverifiableError`
   （`MAIN_MERGE_APPROVAL_BINDING_CHECK_FAILED:<欄位名>`，與漂移碼不同）**拒絕該次動作**，但不把
   approval 轉為任何終局狀態——requested 仍是 requested，approved 仍是 approved。
   以暫時性失敗燒掉 Owner 的決定，正是 [[VERIFICATION]] Phase 5-2 已判定必須在 5-5 前關閉的那個模式。
   **這一條原本寫著而實作沒做到**：先前兩處 `catch` 把例外一律轉成「已改變」，因此 main 的 `.git`
   短暫 `chmod 000`、candidate worktree 短暫離開外接碟、git 無法啟動，都會列出八個「已改變」欄位
   （其中一個都沒真的變）並永久失效。現行行為由 `test/merge-approval-drift.test.ts` 的
   「a real transient failure refuses the action without burning the owner's decision」（三種真實
   失敗：`chmod 000`、目錄改名離開再放回、PATH 內無 git）與「a transient failure at grant leaves the
   owner's question open instead of destroying it」驗證，兩者都斷言**環境恢復後仍可成功 consume**。
   反向也有測試：真的刪掉 recovery ref 仍然算漂移（`#checkpointRefState` 以 `rev-parse --verify
   --quiet` 的 exit 1 區分「ref 不存在」與「repo 讀不到」，後者才拋錯）。
   `refusal.changed`／`bindingCheck.changed`／drift 事件的 `changed` 一律只含**實際比對過**的欄位，
   讀不到的欄位改以獨立的 `unverified` 呈現——因為 `changed` 會原樣進入 audit 鏈與**公開的 Room
   ledger**，把沒讀到的欄位混進去等於向整個 Room 宣告 main HEAD 動過，而 main 從頭到尾沒動。
4. **恰好一次的紀錄。** 失效以 `#writeMergeApproval` 的 compare-and-set 寫入，只有贏家會通知
   sink，因此三條路徑同時看到同一次漂移也只產生一筆稽核事件與一則帳本訊息。輸家改讀 store 目前的
   內容再回報，所以每一個觀察者看到的都是 `invalidated`，不是自己手上那份過期的列。
5. **稽核在 service 層、durable 在 registry 層。** registry 擁有持久狀態且不認識稽核鏈與 Room ledger，
   因此以建構期注入的 sink 回報。**帳本是公開的**，訊息只列改變的欄位名（以及本次讀不到、因此未比對的
   欄位）並明說**這次失效沒有刪除 candidate、checkpoint 或復原點，也沒有修改 main**，不含路徑、id 或
   token；完整細節走 owner-only 的 audit 鏈，並記錄 `ownerHadGranted`——「Owner 核准過但漂移作廢」與
   「沒人回答過」是兩件不同的事。**紀錄只描述這次動作，不宣告現況**：先前 audit detail 寫死
   `candidateRetained`／`checkpointsRetained`／`recoveryRefRetained: true`，帳本文案寫死「完整保留」，
   但這條路徑從來沒有去看過那三樣東西——先刪掉 recovery ref 再觸發漂移，紀錄仍宣稱「復原點完整保留」。
   現行 detail 改為單一 `deletedByThisInvalidation: "nothing"`（失效路徑不執行任何 Git 指令、只寫
   approval 那一列，所以這是結構性為真的敘述），三個舊常數已移除。由
   `test/merge-approval-drift.test.ts`「the invalidation record describes what it did, not the state
   of things it never looked at」驗證（刪 ref → 觀察 → 斷言 detail 不含 `recoveryRefRetained`、帳本
   不含「完整保留」）。
6. **不需要 schema 變更。** durable 語意（終局 `invalidated` ＋ 具名 `refusal`）在 v4 已經存在；5-4
   加的是「誰在什麼時候發現」，`refusal.reason` 就能承載。v1→v4、v3→v4 升級路徑與 v2 拒絕維持不變。

### 代價與殘餘風險

每一項都標「到 5-5 是否仍可接受」，欄位語意與 [[VERIFICATION]]「可接受的殘餘風險（本階段）」表一致。

| 項目 | 說明與緩解 | 到 5-5 是否仍可接受 |
|---|---|---|
| 偵測是觀察時觸發，不是背景輪詢 | 沒有人讀就沒有人發現。GUI dialog 每 5 秒 inspect，所有 MCP 讀取都會經過，而真正的授權關卡（grant／consume）仍各自重驗一次 | **可接受**，不需在 5-5 前處理 |
| 讀取路徑現在會寫入 | 唯一可能的轉移是「已經無法使用的核准被記成終局失效」，不能授權、復活或刪除任何東西，方向恆為 fail-closed。但 `GET /api/rooms/merge-approvals/inspect` 在 CSRF 意義上**不再是純讀取**。**實際緩解只有兩項，且都不在這個端點裡**：（a）session cookie 是 `HttpOnly; SameSite=Strict`（`src/ui/web.ts:371`），跨站請求不會帶上它；（b）Host pinning——`request.headers.host` 必須等於 origin 的 host，否則回 421（`src/ui/web.ts:345-346`），另有 loopback-only 來源檢查（`src/ui/web.ts:341-343`）。**沒有 Origin／Referer 檢查，也沒有 CSRF token。** 因此這一列同時是給未來的警告：**任何把 cookie 放寬成 `SameSite=Lax`／`None`、或放寬 Host pinning 的變更，都會讓這個 GET 端點變成可被跨站觸發的寫入**，必須同時為它補上 Origin 檢查 | **可接受（本階段）**，但列為 5-5 的 gating 前提：5-5 促成真正的 main 寫入後，任何 cookie／Host 檢查的放寬都必須先補 Origin 檢查 |
| 每次觀察重算完整 preview、無上限 | 每個仍未決的 approval（每個 task 結構上至多一個）在每次觀察都重算整份 preview：串流雜湊所有變更檔案並模擬 merge，共用 30 秒 deadline。GUI dialog 每 5 秒 inspect 一次，大 repo ＋ dirty main 會每 5 秒重跑一遍 | **5-5 前必須處理。** 撞上 30 秒 deadline 即拋錯；修復後這只會讓該次觀察回 `unavailable`（`unverified: ["previewDigest"]`）而不再永久失效，但等於「Owner 的 dialog 在大 repo 上會反覆顯示無法檢查、confirm 一直不可用」。需要節流、快取或提高上限 |
| audit sink 拋錯時該次稽核事件遺失 | 失效仍已持久化，durable 那一列是主要紀錄 | **可接受**，不需在 5-5 前處理 |
| 檢查無法完成＝永久失效（**已解決**） | 曾經：`#verifyMergeBinding` 兩處 `catch` 把任何例外轉成「已改變」，Git／檔案系統的暫時失敗會把 approval 寫成終局 `invalidated` 並清掉 token，恢復後也救不回來 | **已解決**（本 ADR 決策 3）：例外改記為 `unverified`，不失效；`grant`／`consume` 以獨立錯誤碼拒絕該次動作。回歸測試斷言環境恢復後仍可 consume |
| `refusal.changed` 可能列出沒真的變的欄位，且會進公開帳本（**已解決**） | 曾經：一次 `chmod 000` 會讓 refusal 列出八個欄位、寫進 audit 鏈與公開 Room ledger，向 Owner 與其他 agent 宣告 main HEAD 變了 | **已解決**（本 ADR 決策 3）：`changed` 只含實際比對過的欄位，讀不到的改以 `unverified` 呈現 |
| audit／ledger 的保留宣告是常數不是觀察（**已解決**） | 曾經：`candidateRetained`／`checkpointsRetained`／`recoveryRefRetained` 寫死 `true`、帳本寫死「完整保留」；刪掉 recovery ref 後觀察，紀錄仍宣稱復原點完整保留 | **已解決**（本 ADR 決策 5）：改為只描述本次動作的 `deletedByThisInvalidation: "nothing"`。**注意這是範圍縮小而非替代**：現在沒有任何自動紀錄可以證明 candidate／checkpoint／recovery ref 目前仍存在；要知道現況必須另行 `candidate_status` 或讀 Git |
| 一次觀察可能同時「有欄位變了」又「有欄位讀不到」 | 此時仍以漂移處理並失效（實際觀察到的變動是 fail-closed 的正確依據），`unverified` 一併記入 refusal、audit detail 與帳本 | **可接受**：方向恆為 fail-closed，且不會因純粹的暫時失敗觸發 |

## ADR-035：Promotion 是「先寫意圖、再消耗核准、再寫 main」，崩潰後的收斂一律唯讀

**背景。** Phase 5-5 是全產品第一個真的寫入 Owner 主專案的操作。開工前訂的通過標準（v1）在實作開始後
被一位專門攻擊標準本身的審查員以真實 git 推翻了三處，三個實測都直接決定了下面的設計：

1. main 的 `git status --porcelain` **完全乾淨**時，`git merge` 仍會**靜默覆蓋** ignored 檔案的內容、
   exit 0，而且事後仍回報工作樹乾淨。
2. 接著用最自然的回滾方式 `git reset --hard <pre-HEAD>`，那個檔案**直接消失**，不是還原成原內容。
3. 在 `pre-merge-commit` hook 執行中 `kill -9` git：**HEAD 沒動、沒有 `MERGE_HEAD`、`merge --abort` 用不了**，
   但 index 與工作樹已被完整改寫，`git status` 顯示成一般的「Changes to be committed」——
   與 Owner 自己 stage 的工作在位元層級無法區分。

**決定。**

- **順序固定**：驗證綁定 → 寫入 durable `applying` 意圖紀錄 → 消耗核准 → 寫 main → 寫入終局結果。
  SQLite 交易與 Git commit 不可能是同一個原子單位，所以「兩者不得同時存在」沒有任何實作能真的滿足；
  正確的形狀是**寫前意圖紀錄＋確定性收斂**，與 `CLAUDE.md` 對 apply-back 早已寫下的
  「必須先持久化進入 `applying` 才能修改主專案」同形。意圖紀錄在任何 Git 寫入前就含全部 pre-op 指紋。
- **核准一旦消耗即為終局**，沒有任何路徑會把它改回 `approved` 或重新發 token。失敗時 Owner 重新
  preview 再問一次；這是刻意的摩擦。
- **崩潰後的 reconciliation 一律唯讀。** 因為實測 3，自動回滾在「半套用的 index」與「Owner 自己的工作」
  之間無法區分，而 `git clean` 更會刪掉未追蹤與 ignored 檔案。所以重啟後只讀、只比對、只**具名**回報
  差異，並給出一行可複製的復原指令；復原由 Owner 自己執行。
  同一程序內、merge 剛失敗時的 `merge --abort` 不在此限：那不是重試，而且事後以指紋逐項驗證。
- **`mainIgnoredFingerprint` 升級為涵蓋內容**，並在核准畫面上**逐一列出**這次合併會覆蓋的 ignored 檔案；
  有任何一個就在核准前拒絕。因為實測 1＋2，「顯示一句警告」不夠——那是兩段式資料損毀。
  **無法在不破壞未追蹤／ignored 檔案的前提下回滾的失敗，正確答案是事前拒絕，不是事後清理。**
- **「乾淨」寫死為一組具名條件**，而不是 `git status --porcelain` 是否為空：已實測
  `git update-index --skip-worktree` 讓 `status` 完全空白，真實 merge 卻以 exit 2 中止，
  而且**每次重試都會以同樣方式失敗**，「恢復後可重新成功」在該形狀下永遠為假。
  submodule 與 LFS／clean-smudge filter 一律**偵測到即拒絕**，不做部分支援。
- **Promotion 執行 repo hook，preview 永遠不執行。** 這是 5-5 引入的新信任邊界（[[THREAT_MODEL]] F26）：
  所有唯讀 Git 指令固定 `core.hooksPath=/dev/null`，只有 `promotionGitEnvironment()` 解除它。
  因此本次會執行的 hook 檔名與內容雜湊、`core.hooksPath`、`merge.*.driver` 與 `filter.*` 納入
  `previewDigest`（＝納入 approval 綁定）並在核准畫面逐項揭露，消耗前再比對一次。
  **2026-08-06 更正（第三輪審查）**：上一句原本寫「全部納入」，而那是**四個鍵的清單**，不是判準——
  實測 `commit.gpgsign`＋`gpg.program` 在核准後寫入即以 Owner 身分被執行，三道防線都沒看到。
  現在的判準是「**不要列舉 git，直接問它**」：main 在 promotion 環境下的**整份 effective config**
  （`git config --list -z` 原始輸出）雜湊進 `hookEnvironment().configDigest` → `previewDigest` → 綁定 →
  消耗前重驗，因此**核准後新增的任何設定鍵**（包含這份程式碼從未聽過的）都會變成
  `MAIN_MERGE_APPROVAL_BINDING_CHANGED`。已知會 spawn 程式的行為另以 `GIT_CONFIG_KEY_n` 釘死
  （`core.fsmonitor`／`commit.gpgsign`／`tag.gpgsign`／`merge.verifySignatures` 全部 false），
  **代價是 promotion 產生的 merge commit 不簽章、也不驗證被合併方的簽章**——明寫的取捨。
  揭露側的 `programs`（可指名程式的設定鍵，**只列鍵名不列值**，因為 `credential.helper` 之類的值可能夾帶秘密）
  是一份**明確不宣稱完整**的清單，只決定哪些鍵會被逐項顯示；完整性由 digest 那一半承擔。
  merge 子程序有固定逾時、輸出上限與整個 PGID 的終止。
  **2026-08-06 第二次更正（第四輪審查）**：上面兩處「在核准畫面逐項揭露」與（`mainIgnoredFingerprint`
  那一條的）「在核准畫面上**逐一列出**這次合併會覆蓋的 ignored 檔案」，**在寫下的當下都不成立**——
  實測 `public/room.js` 對 `promotion`／`hooks`／`programs`／`configDigest`／`overwrites` 的引用次數
  全部為 0，資料在 payload 裡但一個字都沒有被渲染。已補上：揭露渲染在 scroll-gate 量測的區域**之內**
  且在檔案清單之前，覆蓋清單由 `inspectMergeApproval` 每次回傳 live 掃描結果，
  「沒讀到」「掃描沒跑」「hook 目錄讀不到」「快照早於閘門」各自是具名阻擋條件（缺席≠空）。
  已用真實瀏覽器 DOM 驗收，見 [[VERIFICATION]]。
- **live 的 `.git` 狀態刻意不納入 digest。** 第一版把它放進去，實測立刻顯示：別的程序短暫持有一秒的
  `index.lock` 會讓綁定「改變」，永久燒掉 Owner 的核准——PITFALLS #85 的同形違反。
  綁定值只描述**快照**，`.git` 的當下狀態每次決策點重新計算，而且是「拒絕但不消耗」。
- **`merged` 是終局。** 成功後 candidate 轉 `merged`，再次 preview／request 一律具名拒絕。
  否則 Owner 在中間 revert 掉那次合併後，第二次 promotion 會靜默把他明確撤銷的變更重新套回去。

**殘餘風險。** hook 一旦通過綁定就是以 Owner 權限執行的任意程式碼，本產品不沙箱它；
`.git/config` 可被有終端的 Native agent 直接寫入，保護來自「綁定＋揭露＋消耗前重驗」而非阻止寫入。
把整份 config 納入綁定的**代價**是：核准存活期間任何一次對 main 的 `git config` 寫入（包含良性的）
都會讓該次核准以 `MAIN_MERGE_APPROVAL_BINDING_CHANGED` 終局失效，Owner 必須重新 preview 與核准。
這是刻意選的方向（fail closed），不是疏漏。
promotion 期間若外部程序推進 main，目前是**事後偵測**（觀察到的 HEAD 不是被授權的 merge commit →
`needs-manual-review` 並具名），不是期間中止；**2026-08-06 更正**：這一項已於第二輪補上測試
（見下方「第二輪對抗式審查後的修正」），但「事後偵測是否足以取代期間偵測」仍待 Owner 裁決。

### 第一輪對抗式審查後的修正（2026-08-06）

第一輪判定**不通過**。三處決定被實測推翻，全部是「把不確定折疊成一個確定答案」的同一種病：

- **「快照早於 promotion gates」曾被讀成「這列被竄改」。** 用前一個 commit（`df075b7`）建立、含一筆
  Owner **已核准** approval 的 v4 資料庫，用本 commit 開啟：`row_hash` 完全正確、儲存層的升級也確實
  是純加表，但讀取層的 assert 把 `preview.promotion === undefined` 和完整性失敗放進**同一個 `throw`**，
  於是 list／inspect／reject／promote 全部丟 `MAIN_MERGE_APPROVAL_ROW_TAMPERED`，
  同一份程式碼裡正確的具名答案 `PREVIEW_PREDATES_PROMOTION_GATES` 永遠到不了。
  更糟的是 expiry sweep 走同一個 assert，於是那一列**永久佔著「每 task 一個未決問題」的結構性槽位**：
  request 永遠 `ALREADY_PENDING`、reject 永遠拋錯，24 小時後仍然如此，該 task 永久報廢且產品側零路徑可清。
  **現在兩者是兩個答案**：完整性失敗仍是 `MAIN_MERGE_APPROVAL_ROW_TAMPERED`；
  「這份快照早於這個功能」是具名終局狀態 `PREVIEW_PREDATES_PROMOTION_GATES`，
  槽位因此被釋放，Owner 可以立刻被重新詢問。這是 [[PITFALLS]] #85 的教科書版本。
- **`kill -9` 殺不掉它自己啟動的 merge。** `runProcess` 用 `detached`，`git merge` 自成 process group；
  殺掉 orchestrator 之後它 PPID 變 1，**繼續把 main 寫完**（實測 HEAD 移動到真正被授權的 merge commit、
  `git status --porcelain` 完全空白）。而 `#resolvePromotion` 第一行是
  `if (row.state !== "applying") return row;`——一旦寫成 `needs-manual-review` 就**永不再觀察**。
  結果是不變式被繞成「完整套用，而產品的紀錄說不確定」，`mainHeadAfter` 是過期的事實斷言，
  而給 Owner 的 `git reset --hard <pre-HEAD>` **會靜默丟掉一次真的成功了的 merge**。
  三項修正：**(a)** merge 子程序的 pgid 在 spawn 當下寫進意圖紀錄，該 group 仍存在時不得下任何結論；
  **(b)** 取消凍結——非終局的紀錄每次讀取重新觀察，孤兒 merge 跑完、或 Owner 自己把 main 復原，
  都會在下一次讀取自行收斂，這也是 `needs-manual-review` 唯一的出路（產品仍然一個位元都不寫）；
  **(c)** 復原指令改為**觀察來的**——看到被授權的 merge commit 就只提供唯讀的 `git show --stat`，
  永不提供會毀掉它的 `reset --hard`。
- **三個「乾淨」判準用了最省事的讀法**（[[PITFALLS]] #93 應驗在自己身上）：`.gitattributes` 只讀 root、
  boolean 用 `=== "true"` 比字串、submodule 只看 `.gitmodules` 是否存在。實測 `sub/deep/.gitattributes`、
  `.git/info/attributes`、被 ignore 的 `.gitattributes`、`core.attributesFile`、
  `core.sparseCheckout` 的 `1`／`yes`／`on`、以及 index 內的 `160000` gitlink（無 `.gitmodules`、
  `status` 完全空白）全部通過為 `approvable: true`。判準改為：attributes **掃全部來源**；
  boolean 一律 `git config --type=bool`（git 拒絕的值視為讀不到 → 關閉的閘門）；
  submodule 看 **index 的 `160000` 條目**。

**一處判準放寬，明說理由。** 「main 回到操作前」的判定**不再把 `hookEnvironment` 算進去**（仍照實回報）。
理由是它會製造死路：讓 promotion 失敗的往往就是那個 hook，而移除／修好它是重試唯一可能成功的前提，
把它算成「main 沒回來」等於讓唯一的出路同時永久封死上一次嘗試，連帶封死整個 task。
hook 清單真正把關的地方是 approval 綁定，在 merge 前一刻對 live main 不節流地重驗，不是這裡。

### 第二輪對抗式審查後的修正（2026-08-06）

第二輪也判定**不通過**。第一輪的七項必修經獨立複驗全部成立；新的問題有三處嚴重，全部收斂到同一句話：
**一個名字不是一個身分。**

- **pgid 被當成「還在寫入」的代理品，而代理品會退化。** 第一輪的修正 (a) 把「該 process **group** 仍存在」
  當成「merge 還在寫 main」。實測：hook 只要在背景留下任何子程序（起 dev server、watcher、log tailer
  都是這個形狀），group 就永遠活著——main 已完整套用且 `git status` 完全空白，紀錄卻永遠停在 `applying`，
  且**產品側沒有任何路徑可以釋放它**，紀錄裡也沒告訴 Owner 該去看哪個程序。更糟的是它會傳染：
  那個 pgid 被無限期帶進 `needs-manual-review` 的每一次後續觀察，而該 group 早已死透；
  `mergeGroupStillRunning` 對它**沒有任何身分驗證**，非 `ESRCH` 錯誤（別的使用者持有該 pid 時的 `EPERM`）
  一律算「還活著」，而 macOS pid 約 99999 回繞、**重開機後從低號重來——而重開機正是最可能留下
  `needs-manual-review` 的原因**。這是 [[PITFALLS]] #67 的原地復發：擁有權一旦是別的東西的函數，
  就會有一組輸入讓那個函數退化。四項修正：
  **(a) 問的對象改成 group leader。** 子程序 `detached` 讓它自成 session／group，所以 leader 的 pid
  就是 pgid，而 leader 就是那個 `git merge`——它的生死才是「main 是否還在被寫」的判準。
  背景殘留的孫程序改為**具名回報**（`mergeGroupSurvivors` 附唯讀 `ps -g <pgid>`）而不再阻擋收斂。
  **(b) 加上身分。** pgid 連同本機開機時刻一起記；跨開機的 pgid 一律不採信。
  `EPERM` 從「還活著」改判為「這個 pid 屬於別人，因此不是我們的 merge」——先前的讀法把別人回收的 pid
  當成我們的 merge 還在寫。
  **(c) 觀察到結束就寫成 `null`**，拿掉無條件 carry-forward。
  **(d) 給出路。** 新增 `abandonMergeProcessGroup()`：Owner 必須寫出紀錄上的**確切 pgid** 與確認短語，
  產品**不殺任何程序、不碰 main**，只停止等待那一個 pid，並把這件事**歸屬給 Owner**
  （`mergeGroupDisowned.decidedBy`），不偽裝成觀察（[[PITFALLS]] #86）。
  這一項對應標準第 11 項的附帶條款：**任何佔用結構性槽位的狀態都必須有產品側路徑可以釋放。**
- **列舉 attributes 檔的位置，本質上追不上 git。** 第一輪把來源從 root 一份擴為五個位置，並在註解與
  [[THREAT_MODEL]] F26 宣稱窮盡。實測又漏兩個：`core.attributesFile` 寫成 `~/attrs` 時 git 用
  `expand_user_path` 展開而產品 `join()` 到 workspace 底下（ENOENT → 零 blocker），
  以及完全不設該鍵時 git 仍讀 `$XDG_CONFIG_HOME/git/attributes`——`GIT_CONFIG_GLOBAL=/dev/null`
  只覆蓋全域 **config** 檔、不覆蓋全域 **attributes** 檔。**判準因此改成直接問 git**
  （`git check-attr -z --stdin filter`，在 merge 會用的那個環境下），列舉保留為第二半，
  因為它能答出「規則指向此刻不存在的路徑」這種 check-attr 答不出的形狀。**兩半合起來仍不宣稱完備**，
  未覆蓋的形狀列入殘餘風險表。
  **2026-08-13 補上第三個輸入：** live promotion gate 會把完整 candidate preview 的每個非刪除
  目標路徑一併餵給 `git check-attr`。這關閉了「全域 attributes pattern 只匹配 candidate 新增路徑」的
  已知 PLAUSIBLE 缺口；preview 若截斷或無法讀取仍拒絕，不把不完整清單當成安全證據。
- **`hooks: ok` 之外的唯一誠實選項是去讀 git 自己的紀錄。** 標準第 5 項要求記錄實際執行過的 hook 檔名
  與退出碼，而 `runProcess` 只拿得到 `git merge` 的整體退出碼。決定：merge 以 `GIT_TRACE2_EVENT` 寫出
  git 的 trace（檔案在 owner-only data directory，**不在 repo 內**——寫在 repo 內它自己就會變成
  未追蹤檔案並污染這次促進正要比對的指紋），事後解析 `child_class:"hook"` 取得 `hook_name` 與 `code`。
  **未讀到是 `null`、讀到但沒有 hook 是 `[]`**，兩者不折疊。audit 與 room ledger 由新的
  `onMergePromotion` sink 寫入，與既有的 drift sink 同形：durable 先行、listener 例外被吞、
  帳本只登公開資訊（不含專案路徑、approval id、token）。
- **「A 壞了還可以靠 B」要先問 B 是不是住在 A 裡面（2026-08-07，第七輪審查後）。**
  第六輪把 merge 的 pgid 從 `observation_json` 搬進 `merge_pgid`／`merge_boot_at_sec` 兩個欄位，
  理由是「欄位是損毀的 payload 帶不走的來源」。第七輪實測證明那個理由只覆蓋一半：
  **兩個欄位與 payload 住在同一列**，損毀落在欄位上時，「欄位優先」反而讓產品挑了壞掉的那個當權威
  （`p7-col.mjs col-pgid`／`col-boot`／`col-null-key` 三種形狀全部接受短短語，而 `ps -g`
  同時證明 merge 活著）。決定兩件事：
  (a) **兩個 in-row 來源答案不同時，答案是「不可讀」**，不挑任何一個當權威，
  兩個號碼都探測、都列給 Owner 看（[[PITFALLS]] #85 的一般化）；
  (b) **加入第三個不住在資料庫裡的來源**——同一次促進的 `promotion-traces/<id>.jsonl`。
  git 的 trace2 session id 尾端以十六進位帶著 git 自己的 pid，而 merge 是 `detached` 起的，
  所以 pid 就是 pgid。這個來源唯讀、有界（前 64 KiB）、解析不到就回報「不可讀」而不是「沒有 merge」，
  而且**不宣稱完備**：它依賴 trace2 的 sid 格式，格式改了它會安靜地退回不可讀。
  同時因此規定：任何未來的 trace 保留／清理策略都必須排除「還在 `applying` 的促進」。
- **修好一個判斷之後要問「還有哪幾條路徑做同一個判斷」（2026-08-07，第八輪審查後）。**
  第七輪的三來源比對本身是對的，但只接到「可不可以釋放排他標記」一條路徑；
  「可不可以下結論」那條——也就是會遞給 Owner `git reset --hard` 的那條——仍然只讀
  `observation_json`。實測（`p8-race.mjs`，**零竄改**）：另一個程序對 registry DB 取
  `BEGIN EXCLUSIVE`，`#recordMergePgid` 的寫入失敗被吞掉，git 已 detached 跑起來，
  產品回報 `waiting nothing` 並遞出 `reset --hard`，而 `ps -g` 列出 `git merge`＋hook＋`sleep 900`。
  決定：把比對集中到單一 `mergeIdentityStanding(row, trace)`，並把 `trace` 做成
  `promotionPending()` 的**必要參數**，讓型別系統強迫每一個呼叫點帶上（[[PITFALLS]] #74 的手法
  用在讀取面）。七條會下結論的路徑逐條列在 [[VERIFICATION]]，並各自有測試驅動。
- **被觀察的對象碰得到的來源，只能收緊不能放寬（2026-08-07）。**
  `GIT_TRACE2_EVENT` 的路徑出現在 hook 的環境變數裡，而 hook 是本階段引入的、以 Owner 身分
  無沙箱執行的信任邊界。實測：hook 偽造一個 `start` 事件指向死號碼 → 短短語被接受、排他標記交還，
  而 `ps -g` 同時列出活著的 merge。**考慮過但沒有採用**把 trace 改寫到 hook 看不到的 fd：
  實測 `GIT_TRACE2_EVENT=<fd>` 確實讓 hook 只看到 `3`（也無法用 `: > /dev/fd/3` 截斷），
  但 `lsof -p $$` 仍列得出檔案路徑，**所以那是遮蔽不是邊界**，而它要動 `process-runner`
  這個安全關鍵模組。決定改用明文規則：trace 命名的號碼一律拿去探測（只增加拒絕的理由），
  但**永遠不能讓一列變成「已回答」**；「有沒有回答」由 row 內的來源決定。
- **靜默吞掉的寫入失敗要留下具名痕跡，而痕跡不能寫在剛剛失敗的地方（2026-08-07）。**
  `#recordMergePgid` 的 `catch { return row; }` ＋ `process-runner` 的 `catch {}` 讓
  「pgid 沒記到」與「沒有 pgid 可記」在紀錄上完全相同，而後者讀起來是「沒有東西在跑」。
  決定：失敗時把那次寫入正在攜帶的號碼寫進 `promotion-traces/<id>.spawn-record.json`
  （0600、owner-only 目錄、**不交給任何被觀察的對象**），並讓它一出現就使該列的「已回答」為 false；
  `runProcess` 則在 `ProcessResult` 上回報 `spawnRecordFailed`。
  **仍然不中止 merge**——git 已經在跑，中止只會留下一個沒有人在等的寫入。
- **加欄位不動版本號，會把「降版」的失敗留在 SQLite 內部（2026-08-07）。**
  第六輪以 `ALTER TABLE ADD COLUMN` 加上兩個欄位並刻意不動 `user_version`，理由是「純加欄位、
  雜湊不變、不需要升級分支」。升級方向確實如此，但降版方向沒有名字：舊 build 看到 version 5、
  接受這個資料庫，然後在自己的位置式 INSERT 上炸出
  `table candidate_merge_promotions has 19 columns but 17 values were supplied`。
  決定把 schema 移到 **v6**：舊 build 既有的 `version > SCHEMA_VERSION` 檢查會在**開啟時**
  就以 `CANDIDATE_REGISTRY_SCHEMA_UNSUPPORTED` 拒絕。**代價是明知且不可逆的**——本 build 開過一次，
  digest-pinned 的舊 runtime 就再也打不開那個 data directory，回退需要離線工具。
  這一項列入殘餘風險表並需要 Owner 知情。

**一項提交 Owner 裁決，未自行改標準。** 標準第 7 項要求「promotion 期間偵測外部推進並中止」。
單機 git 上這做不到：`git merge` 是外部程序，控制面在它執行期間沒有中止點，任何輪詢只縮小 TOCTOU 窗。
成立的是**事後偵測**——`authorizedMergeCommit` 要求 HEAD 是雙親 commit 且第一個 parent 恰為 pre-op HEAD，
外部推進無法滿足它（已用「hook 途中 `git update-ref refs/heads/main`」實測：git 自己以 exit 128
`cannot lock ref 'HEAD'` 中止，產品記為 `needs-manual-review` 並具名 `HEAD`，candidate 不轉 `merged`）。
提議把「期間偵測」移入殘餘風險並註明失效條件；**待 Owner 裁決。**

## ADR-036：Owner 最終按鈕是 grant＋promotion 的單一產品操作，成功後進 durable Merge 歷史

**日期：** 2026-08-14
**狀態：** Accepted

### 背景

實際 UI 驗收證明一個產品斷點：Owner 捲完 diff、輸入 `MERGE INTO MAIN` 並按「合併進 main」後，HTTP
只呼叫 `grantMainMerge()`，把 raw token 回給瀏覽器，再把 approval 顯示成終局 `approved`。產品沒有
任何後續 HTTP/MCP promotion 出口，所以畫面既沒有 merge，也不能告訴 Owner 成功或失敗。這違反
ADR-033「不能把核准燒掉但 merge 沒發生」的載重理由，也讓已存在的 promotion audit 對正常使用者不可見。

### 決策

1. 本機 Owner 最終按鈕對應一個 `approveAndPromoteMainMerge()` service operation：先用原有完整綁定
   grant，再把 raw token 只在 server 記憶體內傳給 `promoteMainMerge()`；token 不回瀏覽器、不入 audit、
   不入 Room ledger。
2. HTTP response loss 的 retry 不重新 grant 或 merge。以 exact `approval_id` 查 durable promotion row，
   重驗 confirmation 與 preview digest 後回傳同一筆重新觀察結果。
3. 只有 `promotion.state === "applied"`、`observation.authorizedMergeCommit === true`、有實際
   `mainHeadAfter`，且 response 的 `mainMutated === true` 才顯示「Merge 成功」。`rolled-back` 顯示未套用；
   `applying`／`needs-manual-review`／讀不到顯示需人工檢查，絕不自動重試。
4. Pending 與 outcome archive 是不同工作語意：pending 只計仍可回答且未逾時的 `requested` approvals，
   為零時整個 task control 消失；archive 在 sidebar 只有無總數的「Merge 紀錄」入口，只有 review bucket
   非空時附加不帶數字的人工檢查提示。入口直接來自
   `candidate_merge_promotions` 與沒有 promotion 的 terminal
   approvals，依 Room/workspace scope 讀取並在 restart 後仍可重建。Archive 分成「已 Merge」「需要檢查」
   與「未進入 Merge」；只有 applied＋authorized observation＋非空 main HEAD after 進入第一類，所有缺少
   正向事實或 malformed 的列 fail closed 到第二類，rejected／expired／invalidated 且沒有 promotion 才進
   第三類，三類 count 只顯示在 dialog 內；terminal-only rows 不產生側欄提示。關閉不清除 durable rows，
   讀取失敗在 dialog 內具名。各列保留 promotion/approval/task、前後 HEAD、
   candidate HEAD、recovery、state、timestamps、observation、hooks，不含 token。
5. grant 已提交、但 promotion intent 尚未寫入而同步失敗時，因 `promoteMainMerge` 在 intent 前不會執行
   Git，可安全把該孤兒 grant 以 `PROMOTION_NOT_STARTED_AFTER_GRANT` 退休。daemon 在兩者之間被殺時，
   重啟後 exact retry 或 history 讀取做同一判斷、清除 token hash，並把該 terminal approval 列入
   `unpromotedApprovals`；intent 一旦存在，任何錯誤都不走此路，結果完全交給 ADR-035 observer 收斂。
6. 確認短語採六個可觀察狀態，而不是只靠 disabled input/button 暗示結果：尚未捲完或重新預覽後明示
   ~~input 為何鎖定；~~ pending row 的 input 維持可編輯，並明示應捲「內層變更清單」而不是外層視窗；
   錯誤短語保持可編輯並明示未送出、未 Merge、main 未修改；精確短語明示仍須按下
   最終按鈕；只有第 3 項的 durable positive observation 才顯示 Merge 成功。client gate 不取代 server
   對 confirmation、TTL、binding 與 single-use state 的重驗。server 拒絕後會 best-effort refresh live
   approval；refresh 自身失敗也必須保留原拒絕、具名第二個錯誤並明示非成功，不得讓 nested exception
   使畫面沉默。
7. Pending input 的保存範圍是 exact approval id：同一筆 re-preview 可保留，切換 snapshot/approval 必須
   清空。Expired approval 雖可能仍以 `requested` row 被讀到，但在 UI 視為不可復活，input 鎖定並清空，
   只能由 candidate 另提新 request。內層 scroll region 是安全 gate，因此必須以鍵盤可聚焦／捲動、有
   可見焦點且與 live hint 關聯；不能把滑鼠能力當成 Owner 的前提。
8. 原生 disabled button 會吞掉 click，讓 Owner 無法分辨「安全阻擋」與「產品故障」。Pending 且 phrase
   存在時，final button 改用 `aria-disabled` 表示不可提交但保留 intent click；未就緒 click 只把焦點／
   外層 viewport 帶到缺少條件並在 live status 明示未送出，不得發 HTTP。只有 pure gate 回傳 `submit`
   才進第 1 項 operation；terminal/expired/missing phrase 仍 native-disabled。
9. Confirmation input 的 Enter 不直接觸發第 1 項 operation：未就緒走 guidance，ready 只 focus final
   button，Owner 必須再 activation 一次。Client 以 await 前的 `mergeApprovalSubmitting` 與 `finally`
   防重入，但 exactly-once 仍由 server single-use 保證。Guidance 每次 activation 都 versioned clear/rewrite
   aria-live，並移除舊 target attention，讓重複與狀態變更都不是沉默或過時回饋。

### 代價與殘餘風險

- SQLite grant 與 intent 仍不是同一交易；程序若恰在兩者之間被 SIGKILL，會短暫留下 `approved` row，
  下一次 retry/history 會具名退休。跨行程共用同一 data directory 時，service-local in-flight set 不足以
  區分另一個仍活著的 daemon。若第二行程在 intent commit 前退休 approval，第一行程的 consume CAS 失敗；
  若 intent 已先 commit，仍可能短暫同時存在「intent＋已退休 approval」，但該 intent 會在任何 Git command
  前轉為 `rolled-back`。因此競爭會造成具名的假失敗，不會造成未授權 merge；正式單 daemon 啟動紀律仍是
  避免這種可用性失敗的前提。
- History 的讀取會重新觀察未結 promotion，可能更新 reconciliation row、audit 與 ledger；它不會重跑
  merge、rollback、push 或 cleanup，因此不是純粹「無寫入任何 store」的 GET。
- Native Full-Trust、candidate/main 邊界與外部副作用授權都沒有改變；按鈕只涵蓋已預覽的 main merge，
  不含 push、publish、deploy、delete 或 cleanup。
- 多一個 client-side 狀態機與 accessible live region；它降低 Owner 把錯字或 locked control 誤讀為
  已送出的風險，但無法證明 server 結果，最終事實仍只來自 durable promotion/history。

## ADR-037：Bounded restore schema 與 terminal approval 的 fresh-request 出口

**日期：** 2026-08-19
**狀態：** Accepted

### 背景

正式 repo 的 257 個 ignored paths 產生 13,475-byte `GitRestorePoint`，但
`candidate_merge_promotions.restore_json` 只有 8,000-character CHECK。Owner 已 grant 後，intent insert 在
任何 Git 寫入前失敗；service 正確退休舊 grant，GUI 卻只剩 terminal input，讓人誤以為重新整理應該復活
同一授權。單純放大為無界 TEXT 會把可用性問題改成儲存／解析 DoS；單純丟掉 paths 又會把不完整 restore
描述成完整。

### 決策

1. Schema v7 將 restore constraint 改為 65,536 UTF-8 bytes，writer 與 SQLite BLOB length 雙重驗證。
2. Persisted restore schema v2 保存 `ignoredPathsTotal` 與 `ignoredPathsTruncated`；只有 path display prefix
   可縮短，`ignoredFiles` 與完整 path＋content `ignoredFingerprint` 不變。Legacy row 只有在 list 可證明完整
   時讀取；malformed current/legacy row fail closed。
3. v6→v7 transactionally rebuild promotion table，逐欄複製 payload/hash 並重建 exclusive/task indexes；
   不改寫舊 hash。Crash observer 與 public history 都走同一 strict parser。
4. Terminal、未開始 promotion 的 approval 可由 Owner 建立 fresh request：server 先證明沒有 promotion row，
   重新 preview live state，再產生新 approval UUID。舊 row 不復活、無 token 複製、無自動 Merge；UI 切換
   新 id 時清空 phrase 並重置 scroll gate。已有 intent/consumed/unreadable outcome 必須到 history review。

### 影響

- Native Full-Trust Agent 能力、candidate/main 與 exact-seat 邊界不變；變更只在 GUI Owner promotion control
  plane 與 durable schema。
- 舊 runtime 不支援 schema v7，正式 runtime 切換前需成對備份 DB/runtime；rollback 不能只替換 executable。
- 64 KiB 仍可能拒絕極端非路徑 metadata，這是具名 fail-closed 上限，不是自動壓縮或資料遺失授權。

## ADR-038：Merge 成功後提供不改狀態的返回 Room 動作

**日期：** 2026-08-19
**狀態：** Accepted

### 背景

Owner 已在真實 promotion 畫面看到 durable「Merge 成功」，但結果 dialog 沒有明確完成路徑；只能猜測
關閉符號是否代表完成、清除紀錄或返回。這會把已驗證結果與純 UI navigation 混在一起。

### 決策

1. 只有 ADR-036 的完整正向成功條件成立，結果卡片才建立「完成並回到 Room 主畫面」原生按鈕。
2. activation 只關閉 merge dialog、切回 ledger view 並聚焦 Room composer；不呼叫 API/MCP、不再 promotion、
   不清除或 acknowledge durable Merge History。
3. rolled-back、uncertain、讀不到或 POST failure 不建立按鈕；返回主畫面本身不是成功證據。
4. 按鈕最小高度 44px，成功卡顯示後取得焦點，保留全域可見 `:focus-visible`。

### 影響

- 只影響 GUI Managed/Owner Web 呈現；Native Full-Trust、Room exact-seat、candidate/main 與 approval authority
  均不改變。
- Durable 結果與 recovery artifacts 仍完整保留；同帳號瀏覽器擴充套件仍可竄改畫面，最終核對面是 History、
  main HEAD 與 audit chain。
