# Orchestratory 架構

狀態：**Native Full-Trust 目標架構；runtime 尚未完成**

依據：`OWNER_DECISION_FULL_CONTROL.md`、ADR-028

本版取代「所有 provider 必須在唯讀 scratch cwd、只能透過 Workspace MCP 寫入、單一 Writer Lease」
作為全產品架構的舊設計。這些元件只保留給 GUI Managed 模式。

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
- thread ID、reply-to、task 與 ledger reference；candidate linkage 由 Candidate Registry 階段加入；
- send、wait reply、reply-and-wait、reconnect 與 cancel；
- 無固定 thread round ceiling。

### 3.4 Candidate Registry

建立及追蹤 task、base main、candidate path/HEAD、Agent branch、integration branch、dirty-state inventory、
checkpoint、completion 與 retention。它不嘗試限制 Native Agent 的 filesystem scope。

### 3.5 Completion Service

Agent 宣告完成時建立穩定 checkpoint，彙整 diff、delete/rename、tests、main drift、conflicts、binary/
large changes 與 recovery readiness，然後建立「是否 merge 到 main」的 Owner decision request。

### 3.6 Promotion Service

只接受 single-use snapshot-bound approval。流程為：

1. 重新驗證 candidate/main identity、HEAD 與 working state；
2. 建立並驗證 recovery point；
3. 執行預覽中的 merge/promotion；
4. 若 scope 擴張或 conflict 需要新決策，停止並重新詢問；
5. 驗證最終 main HEAD／tree／diff；
6. 保存結果，不自動 push 或 cleanup。

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

隔離 development branch 已把 inbox 擴充為 schema v4，支援 authenticated source、thread、reply-to、
durable send idempotency、`list_agents.terminalSeats`、`room_send` 與 `room_await_reply`；synthetic
multi-connection peer tests、20 輪 thread、transport reconnect、三席 hijack negative test，以及雙 OS process
migration race 已通過。真實兩個 MCP stdio host 的 cross-provider 驗收仍待執行。
已安裝 runtime 尚未切換，`ask_*` 仍是分離的唯讀 worker，Writer 路徑仍受 legacy lease 與 Workspace
MCP 限制。導入 ADR-028 時必須使用 feature/capability negotiation，直到真實 peer thread、candidate
completion 與 promotion 全部通過驗收，GUI 才能標示 Native Full-Trust workflow ready。
