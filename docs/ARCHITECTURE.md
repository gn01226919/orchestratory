# Orchestratory 架構

狀態：**Native Full-Trust 目標架構；runtime 尚未完成**

依據：`OWNER_DECISION_FULL_CONTROL.md`、ADR-028

本版取代「所有 provider 必須在唯讀 scratch cwd、只能透過 Workspace MCP 寫入、單一 Writer Lease」
作為全產品架構的舊設計。這些元件只保留給 GUI Managed 模式。

## 0A. Supervisor audit plane

`scripts/supervisor-audit.mjs` 是獨立的 read-only operational plane。它以 bounded child-process
讀取 Git，並用 SQLite `readOnly + query_only` 連線驗證 Room chain 與各 store 的 quick/foreign-key
integrity；它不啟動會 migration/recovery 的一般 runtime，也不讀取或複製 HMAC key。結果寫入
workspace 外、64 KiB 上限、owner-only 的原子 `last-report.json`；
它不取得 candidate/main mutation authority，也不執行 provider call。`ops/com.orchestratory.supervisor.example.plist`
只含可移植 placeholder，是 macOS launchd 每小時入口的範本；實際安裝時才以本機絕對路徑 materialize，
不把 username、Node version 或 Obsidian vault path 發佈進 source/package。安裝仍是獨立本機作業，不等於 merge 或部署。

## 1. 系統視圖

```text
┌──────────────────────────────────────────────────────────────────────┐
│ Native hosts                                                        │
│ Codex TUI              Claude Code TUI              other TUI        │
│ 原生完整能力            原生完整能力                 原生完整能力       │
└──────────────┬──────────────────────┬──────────────────────┬─────────┘
               │ MCP stdio            │ MCP stdio            │
               ▼                      ▼                      ▼
┌──────────────────── Orchestratory Collaboration Plane ──────────────┐
│ Presence/Identity  Room Ledger  Exact-seat Inbox/Thread  Task state │
│ Candidate Registry  Completion Checkpoint  Approval  Audit/Recovery │
└──────────────┬──────────────────────────────────────────┬────────────┘
               │ default work destination                │ owner action
               ▼                                         ▼
┌─────────────────────────────┐       preview/approve  ┌──────────────┐
│ Candidate workspace(s)      │ ─────────────────────▶ │ Canonical main│
│ agent branches + integration│       promote/verify   │ + recovery   │
└─────────────────────────────┘                        └──────────────┘

┌──────────────────────── GUI Managed（選配） ─────────────────────────┐
│ read-only worker / Writer Lease / Workspace MCP / managed workflow  │
└──────────────────────────────────────────────────────────────────────┘
```

Native host 是 Supervisor 與 coding runtime。Orchestratory 不代替它的工具，也不把加入 Room 變成權限
降低事件。

## 2. 核心邊界

### A. Native host ↔ Collaboration Plane

- MCP payload 是 control-plane 訊息，不代表 host 工具權限。
- Session 建立 authenticated presence；source identity 由 server 綁定，不接受 payload 冒名。
- 加入 Room、待命、傳訊與 merge approval 是不同狀態。

### B. Exact-seat ↔ Exact-seat

- Sender 以 presence ID 指定另一個已加入的 seat。
- Server 驗證 same Room、same canonical workspace、membership 與 target state。
- 不做 provider fallback；target 不可用時 queued、timeout、cancel 或 failed。
- Thread 保存連續上下文，不設固定往返上限。

### C. Candidate ↔ Canonical main

- Candidate 是預設寫入目的地與成果保存邊界。
- Main mutation 是唯一由 Orchestratory 新增的任務終點人工閘門。
- Approval 綁定 task、candidate/main path、HEAD、preview digest 與 operation。
- Promotion 前後重驗 main/candidate drift，並建立 recovery point。
- Native Agent 技術上可繞過此邊界；monitor 與 recovery 屬 best-effort。

### D. GUI Managed ↔ Native Full-Trust

- GUI Managed policy 只能限制由 GUI 啟動及管理的 worker。
- Native terminal 的 capability provenance 來自其 host，不能被 GUI join mode 或 Writer Lease 覆寫。
- UI 必須清楚顯示兩種模式，不能用相同「Writer」標籤混淆。
- Runtime 對 Native seat 固定回傳 `executionClass=native-full-trust`、`capabilityAuthority=host`、
  `hostCapabilities=unchanged`；GUI Managed 固定回傳 managed policy provenance。
- 舊 Writer Lease parser 與候選 API 不接受 `origin=external`；Native terminal 的寫入不經此舊降權路徑。

### E. Local ↔ External side effects

- Main merge 不包含 push、publish、deploy、付費 API 或其他遠端寫入。
- 每一類外部副作用維持獨立、精確的人類授權。

## 3. 核心元件

### 3.1 Presence and Identity Service

保存 session、presence、display label、provider、Room、workspace、capability provenance、heartbeat 與
wakeable state。Exact identity 由連線建立並由 server 注入所有 delivery/audit 記錄。

### 3.2 Room Ledger

Append-only 共享記憶，保存可見訊息、引用、task/candidate linkage 與 lifecycle。Ledger 不取代直接
thread，也不代表每位 Agent 已即時讀完所有訊息。

### 3.3 Exact-seat Inbox and Thread Service

在既有 queued → delivered → read → working → replied/failed/cancelled 狀態機上增加：

- authenticated source seat；
- target exact seat；
- thread ID、reply-to、task 與 ledger reference；UUID task ID 若對應 Candidate Registry，send 時重驗同一
  Room／workspace，delivery 以該 task ID 保留 candidate linkage；
- send、wait reply、reply-and-wait、reconnect 與 cancel；
- 無固定 thread round ceiling。

### 3.4 Candidate Registry

建立及追蹤 task、base main、candidate path/HEAD、Agent branch、integration branch、dirty-state inventory、
checkpoint、completion 與 retention。它不嘗試限制 Native Agent 的 filesystem scope。

隔離開發分支目前已交付第一段 lifecycle：SQLite row-hash registry、Git candidate worktree、dirty main
inventory（ignored 只保存數量與路徑指紋，不讀內容）、clean-commit checkpoint、completion preview、
drift/status 與獨立 `refs/orchestratory/checkpoints/<task>/<checkpoint>` recovery ref。status 會解析並驗證
ref 仍指向該 checkpoint commit；candidate branch 後續前進不會破壞舊復原點。Git diff 與 ignored
inventory 採不保留內容的串流解析，大量檔案只會截斷明細清單並標示 truncated，不會因輸出 byte cap、
固定 candidate 數量或預覽筆數而禁止 Agent 完成工作。

### 3.5 Completion Service

Agent 宣告完成時建立穩定 checkpoint，彙整 diff、delete/rename、tests、main drift、conflicts、binary/
large changes 與 recovery readiness，然後建立「是否 merge 到 main」的 Owner decision request。

Diff 以 `git diff --raw` 解析，保留檔案 mode，因此純權限變更（644→755）與 submodule pointer 變更
（mode 160000）都會各自標示，不再混入一般 modify。Conflicts 分成兩種事實：`conflicts` 只陳述 main
drift 與 dirty main，`mergeConflicts`／`mergeable` 則是以 `git merge-tree --write-tree` 實際模擬 merge
的結果。該指令只在 object database 計算，不寫 ref、不 checkout、不碰任何 worktree，因此可以在不修改
canonical main 的前提下先告訴 Owner 會不會衝突、衝突在哪些路徑。清單有上限並各自標示 truncated。
模擬失敗（git 拒絕合併、輸出超出 byte 預算、逾時或輸出格式無法解析）一律 fail closed，回報
`CANDIDATE_MERGE_PREVIEW_UNAVAILABLE`，不得推定 `mergeable: true`。

MCP completion 產生上述 preview 與 Owner-required 問句，但不含 approval token，也沒有 main mutation
工具；single-use snapshot-bound approval 由 3.6 Merge Approval Service 承接。

### 3.6 Merge Approval Service 與 Promotion Service

**Merge Approval Service（已實作）** 把「Agent 提出請求」與「Owner 授權」分成兩件事。
`main_merge_preview` 由 live state 重算整份 snapshot 且不寫入任何東西；`main_merge_request` 以 stable
UUID `clientRequestId` 建立一筆 `requested` 記錄——它不含 token，也授權不了任何事。核准只能由本機
owner 介面產生，需精確短語 `MERGE INTO MAIN` 與 dialog 實際顯示的 `previewDigest`。

Approval 存在 candidate registry schema v4 的獨立 `candidate_merge_approvals` 表，沿用同一套 row-hash
完整性紀律；它刻意不是 `candidate_requests` 的擴充，因為那張表記錄「mutation 有沒有發生」，這張表記錄
「Owner 授權了什麼」，兩者的生命週期、終局狀態與出錯後果都不同。scalar 欄位與存下來的 preview 互為
冗餘校驗，因此改動任一單一欄位都無法改變 approval 看起來綁定了什麼。`state IN ('requested','approved')`
的 partial unique index 結構性保證每個 task 同時只有一個未決問題。

綁定至少涵蓋 `taskId`、`completionId`、`roomId`、`mainPath`、`mainBranch`、`candidatePath`、
`baseMainHead`、`candidateHead`、`mainHead`、main dirty 與 ignored fingerprint、`recoveryRef` 與
`previewDigest`，並在**建立、核准與消耗三個時點各驗一次**——只在建立時驗證等於放行期間發生的一切變化。
任一值改變即以 `MAIN_MERGE_APPROVAL_BINDING_CHANGED:<欄位名>` 拒絕並轉為終局 `invalidated`，不靜默重算。
Single-use 由 `state` ＋ `row_hash` 的 compare-and-set 保證，並行消耗只有一個贏家。Token 只在 `approved`
期間以 SHA-256 存在。截斷或有衝突的 preview 完全不可核准（寫入與讀取路徑都擋）。拒絕、失效與逾時
不執行任何 Git 指令，candidate、checkpoint 與 recovery ref 逐位元不變，Owner 可重新 preview 再問一次。
Approval 只授權 `merge-candidate-into-main`，消耗時帶其他 action 一律拒絕，授權物件並明列 `notAuthorized`。

~~**Promotion Service（待實作）**~~ **Promotion Service（已實作；2026-08-14 補齊本機 Owner 產品出口）**
只接受 single-use snapshot-bound approval。流程為：

1. 重新驗證 candidate/main identity、HEAD 與 working state；
2. 建立並驗證 recovery point；
3. 執行預覽中的 merge/promotion；
4. 若 scope 擴張或 conflict 需要新決策，停止並重新詢問；
5. 驗證最終 main HEAD／tree／diff；
6. 保存結果，不自動 push 或 cleanup。

本機 Web 的最終 `POST /api/rooms/merge-approvals/approve` 不再只回傳 raw token。它呼叫
`approveAndPromoteMainMerge()`：token 只在 server 記憶體中產生，立即交給 `promoteMainMerge()` 消耗，
不離開 service boundary。若 transport response 遺失，同一 approval 的重送先依 `approval_id` 查 durable
promotion，回傳同一列的重新觀察結果，不再執行 Git。grant 後、promotion intent 前失敗時，因尚無任何
Git 寫入可能，該孤兒 grant 以 `PROMOTION_NOT_STARTED_AFTER_GRANT` 明確退休；intent 一旦存在，只有
promotion observer 能描述 `applied`／`rolled-back`／`needs-manual-review`，前端不得自行推論。
daemon 若在 grant 與 intent 中間被殺，重啟後 exact POST retry 或 Merge 歷史讀取會發現
`approved` 且沒有任何 promotion row，撤銷 token hash、轉為同一具名 rejected 狀態，並在 history 的
`unpromotedApprovals` 顯示。正常在途操作以 service-local approval id set 標記，避免同一 daemon 的 history
讀取把合法的極短窗口誤判成 orphan；併發第二個 owner POST 以 `MAIN_MERGE_PROMOTION_IN_FLIGHT` 拒絕。

`GET /api/rooms/merge-history` 是 Room/workspace-scoped 的 durable history surface。它直接讀
`candidate_merge_promotions` 並重新觀察未結紀錄；因此可能更新 reconciliation metadata，但不會自行
重跑 merge、rollback、push 或 cleanup。GUI pending badge 僅計 `requested` approvals；history 另列
promotion id、approval/task、前後 HEAD、candidate HEAD、recovery、observation 與 hooks；沒有 promotion
row 的 terminal approval 另列為「核准未進入 promotion」，不會消失也不會冒充成功。

Promotion live gate 的 attributes 檢查由 `GitBroker.restorePoint(main, candidatePaths)` 執行。它把完整
preview 中所有非刪除目標路徑傳給 `git check-attr`，因此候選新增的、main 尚不存在的副檔名也會被全域
attributes 規則涵蓋；preview 截斷時仍由既有 blocker 拒絕，不以不完整路徑清單放行。

### 3.7 Main Drift Monitor

監測 HEAD、refs、working tree、hooks、mode 與重大刪除變化。未經 promotion 的變動會警示、保存證據
並暫停自動 promotion。Full-Trust Agent 可停止此程序，因此不能把 monitor 宣稱為強制隔離。

### 3.8 Recovery Service

管理 Git recovery refs/bundles、candidate checkpoints 與選配的 APFS/Time Machine/external backup
證據。只有實際建立且驗證可讀的 recovery point 才能顯示 ready。

### 3.9 GUI Managed Runtime

封裝既有 provider worker、Writer Lease、Workspace MCP、policy engine 與 managed test runner。此層是
選配模式，不是 Native Full-Trust 的隱藏底層。

### 3.10 Persistence and Audit

保存最小的 identity、Room、thread state、task/candidate metadata、approval scope 與 promotion result。
不保存 secrets、provider session、raw reasoning 或不必要的完整 terminal capture。

## 4. 任務資料流

```text
Owner 建立任務
  → Candidate Registry 建 candidate/base/recovery inventory
  → 多個 Native seats 加入 task thread
  → seats 直接互傳、引用 ledger、在 candidate branches 工作
  → integration/checkpoint
  → executing seat 宣告完成
  → Completion Service 凍結 candidate HEAD 並產生 preview
  → GUI/TUI 主動詢問是否 merge main
      → No/Later：保留 candidate
      → Yes：Promotion Service 消耗綁定快照的單次 approval
  → verify main + audit + keep recovery
```

## 5. 能力不是 Room 權限

Room membership 只回答「這個 session 能否參與哪一間 Room」；standby 只回答「現在能否交辦」；
Native capability 回答「host 原本允許 Agent 做什麼」；merge approval 只回答「是否把這個 candidate
快照寫入這條 main」。四者必須使用分離狀態與 UI。

## 6. 失敗與恢復

- Seat offline：保留 thread 和 candidate，顯示不可喚醒，不 fallback。
- Send 與 source/target unregister 競態：presence delete → inbox reconciliation；ledger/enqueue 前後重驗，
  不讓已離線 target 留下 active queued delivery，也不讓已消失的 source 產生無人可 await 的新工作。
- Transport timeout：同一 thread 可重新 wait，不結束任務。
- Candidate crash：從已驗證 checkpoint 恢復，不能假裝未保存內容存在。
- Main drift：使 pending merge approval 失效，重新 preview。
- Merge conflict：停止；除非預覽已包含明確解法，否則要求新決策。
- Promotion partial failure：保存實際狀態、禁止自動重試，提供 recovery 選項。
- Owner 拒絕：保留 candidate，不視為 cleanup 或 delete 授權。

## 7. 導入相容性

隔離 development branch 已把 inbox 擴充為 schema v5，支援 authenticated source、thread、reply-to、
durable send idempotency、`list_agents.terminalSeats`、`room_send` 與 `room_await_reply`；synthetic
multi-connection peer tests、20 輪 thread、transport reconnect、三席 hijack negative test，以及雙 OS process
migration race已通過。v5 另能以精確 schema/index/CHECK fingerprint 辨識並原子修復缺少
`client_request_id` 的中途 v4；未知 v4 仍 fail closed。真實兩個 MCP stdio host 的 cross-provider
驗收仍待執行。
已安裝 runtime 尚未切換，`ask_*` 仍是分離的唯讀 worker，Writer 路徑仍受 legacy lease 與 Workspace
MCP 限制。導入 ADR-028 時必須使用 feature/capability negotiation，直到真實 peer thread、candidate
completion 與 promotion 全部通過驗收，GUI 才能標示 Native Full-Trust workflow ready。

### 7.1 正式 runtime 與開發樹分離

macOS LaunchAgent 必須指向由已驗證 tgz 安裝出的 physical compiled runtime。該目錄以 artifact
SHA-256／commit 識別，不能是 repo、npm-link 或其他 symlink；同一 runtime 內的 backend 與 public
assets 一起切換。GUI `/api/bootstrap` 回傳 Room UI protocol，前端不相容時顯示復原錯誤並停用發言。
Cutover 保留上一個 runtime、plist 與 WAL-safe SQLite backup，使 binary＋data 能成對 rollback。
