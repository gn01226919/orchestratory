# 架構決策紀錄

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

**決策：** 所有 provider CLI 都在空白 scratch cwd 執行並停用 built-in filesystem、shell、
network、subagent 與 plugin。Task-scoped Writer 可由 owner 在 Codex／Claude 常駐、管理型或外接
身分間切換，但 provider 本體仍強制 read-only sandbox，寫入只能透過 task／worktree／
executor／epoch 綁定的 Workspace MCP tools。外接 Writer 由 Writer Companion 代為執行；Grok/API
Writer 保持停用。

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

**決策：** macOS 僅允許 owner 以 mode 0600 的精確 capability gate 啟用 Codex/Grok PTY bridge。
Provider、argv 與唯讀模式固定，不接受額外 flags、不經 shell。Capture 只保存 RAM bounded tail，
入帳作者固定為 `codex-terminal`／`grok-terminal` 並標明混合畫面。

**理由：** 原生 TUI 對使用者最熟悉，但 PTY stream 同時含輸入、輸出與 redraw，不能可靠切割為
agent turn；provider 自有設定也不等於 Orchestratory approval。預設關閉、固定唯讀 capability 與
誠實 provenance 能保留 UX，而不把較弱的觀測能力包裝成較強的安全保證。

**限制：** 無 controlling TTY 的自動測試只能驗證 argv、bounds、redaction 與平台命令 probe；
真實互動 relay、上游 CLI 行為及訂閱消耗仍需 owner opt-in smoke test。

## ADR-023：Task-scoped Writer Lease、Writer Companion 與單層委派

**決策：** 每個 task 同時只有一份 active Writer Lease，綁定 room、workspace、worktree、executor
與單調遞增 epoch。Owner 可在 resident、managed、external 身分間交接；外接身分的受控寫入由
Writer Companion 執行，Room 帳本自然語言揭露代理關係，HMAC technical audit 保存
`on_behalf_of`、`executed_by` 與 `lease_epoch`。同 provider child 與父 Writer 共用 task
worktree，並由持久化 run lock 序列執行；跨 provider child 唯讀。Codex／Claude 使用 revocable
read-only Workspace MCP；Grok 只讀控制面生成的 bounded Git snapshot，不取得 worktree 或
filesystem tools。所有 child 禁止再轉派並隨父 lease 撤銷。apply-back 先進入持久化 `applying`
狀態，成功後才標記 `applied`；不確定狀態維持 fail closed，不能重新授權。

**理由：** Writer 必須能依任務切換，也必須允許擴充分工；把寫入權綁在 task、epoch 與技術
executor，而不是 UI 名稱或 provider 類型，才能兼顧彈性、可追責與 stale-write 防護。

## ADR-024：外接 MCP 席位使用精確 pull inbox，不做 provider fallback

**決策：** Owner 對外接席位的 GUI 訊息同時進 Room Ledger 與該 presence 的 owner-only inbox。
`room_join_request` 保持原 host tool call 等待 GUI 核准，核准後直接進入第一段 bounded 收件；
後續終端以 bounded `room_wait` 收件，依序 ack read／working，最後 reply 或 fail；每筆 delivery 使用
私有短 lease、bounded retry、cancel/offline terminal state 與 idempotent reply receipt。未值班時
GUI 與 API 誠實顯示 `wakeable: false`，禁止改送常駐模型或由 GUI 冒充原終端。需要不依賴外部
host pull 的立即喚醒時，使用分離身分的受控即時 Agent。

**理由：** MCP stdio 無法由 server 對任意原生 CLI 注入 unsolicited keystrokes。精確 pull inbox
保留每個終端自己的上下文與身份，同時避免「看似回覆、實際由另一個模型處理」的錯誤協作。

Room 選單以專案 basename 為主顯示、內部 Room ID 為輔，而實際授權與路由仍以 canonical workspace
exact match 為準。這避免 `room-default-*` 等技術 ID 讓 owner 誤以為不同專案共用一間 Room，同時不冒險改寫
已存在的 append-only ledger 身份。待核准數為跨 Room 全域提示，但核准動作仍只作用於該申請原本綁定的 Room。

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
