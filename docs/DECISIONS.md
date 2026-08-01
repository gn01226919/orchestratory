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
