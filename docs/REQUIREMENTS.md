# 產品需求與驗收條件

狀態：**Native Full-Trust 目標規格；runtime 尚未完成**

依據：`OWNER_DECISION_FULL_CONTROL.md`、ADR-028

本版取代過去要求所有模型唯讀、禁止 shell／Git／network、單一 Writer Lease 與固定最大 Agent
往返輪數的需求。舊能力可保留給 GUI Managed，但不得限制原生 TUI Agent。

## 1. 產品範圍

Orchestratory 是本機多 Agent 協作器：讓多個原生 Codex／Claude Code 等終端 session 保留完整能力，
同時透過 Room Ledger、exact-seat thread、candidate workspace、checkpoint、main merge 核准與 recovery
一起完成任務。

產品不是 provider 的替代聊天 host，也不是把 Agent 關進低能力 sandbox 的 policy engine。

## 1A. 每小時督導稽核

產品必須提供 `scripts/supervisor-audit.mjs` 形式的唯讀督導：每次檢查 canonical workspace 的
branch、HEAD/main/origin-main 關係、工作樹、working/staged diff check、Room hash chain，以及各 SQLite
store 的 read-only quick/foreign-key integrity
與 Obsidian handoff marker。檢查失敗只能產生 bounded report 與明確導正建議，不得自動 switch、reset、
merge、push、publish、deploy、delete 或呼叫 provider。macOS launchd 範本以 `StartInterval=3600`
提供持續排程；repository 只保存 placeholder example，安裝時才 materialize 本機絕對路徑，不得提交
username、Node version 或 vault path。模型督導不是必要依賴，預設不得消耗 provider 額度。

## 2. 執行模式

### 2.1 Native Full-Trust

- 外接 TUI／MCP terminal seat 的預設模式。
- 不改寫 provider host 原本授予的 filesystem、shell、Git、network、plugin 或 subagent 能力。
- 不強制 read-only provider flags、Workspace MCP 唯一寫入、Writer Companion 或 Writer Lease。
- 不限制 Agent 只能存取 allowlisted workspace；allowlist 只用來識別 Room、candidate 與 canonical main。
- 不設 Agent thread 固定最大往返輪數。
- Orchestratory 不主動啟用 host 的 skip-permissions 或等價升權旗標。

### 2.2 GUI Managed

- Owner 可在 GUI 對 managed worker 選擇 read-only、writer 或 full-trust。
- 既有 bounded worker、Writer Lease、Workspace MCP 與 worktree workflow 可繼續作為 managed 選項。
- GUI Managed policy 不能溯及或降級外接 Native Full-Trust session。

## 3. Agent 身分與即時協作

- `list_agents` 必須同時列出 provider workers 與目前已加入 Room 的 exact terminal seats，並清楚區分。
- Exact seat 身分至少包含不可偽造的 presence/seat ID、display name、provider、session、Room、workspace、
  wakeable 狀態與支援能力。
- 同一 Room 及 canonical workspace 的 seats 能直接建立 thread、傳訊、引用、等待、回覆、失敗、取消
  與恢復等待。
- Terminal sender 必須以其 authenticated presence 入帳；不得硬編碼為 `you`。
- 指定 exact seat 時不得 fallback 到同 provider 常駐 worker，也不得新開一個唯讀 worker 冒充回覆。
- Ledger 保存共享進度；thread/inbox 提供即時協作。訊息需能引用 task、candidate 與 ledger seq。
- Transport long-poll 可有 timeout、撤銷與重連；thread 不因 timeout 結束，也沒有固定回合數 ceiling。
- Agent 回覆後若任務未結束，可以原子地「回覆並繼續等待」，避免每一輪重新經 GUI 批准。

## 4. Candidate 任務模型

每項會修改專案的協作任務必須建立：

- task ID 與 Room ID；
- canonical main path 與建立時 main HEAD；
- 獨立 candidate path 與 candidate ID；
- Agent branches 或等價的可追溯 checkpoint；
- 建立前的 main／dirty state inventory；
- recovery metadata 與保存狀態。

Candidate 是預設修改目的地，但不是 OS 權限 sandbox。Agent 可讀取或操作整台 Mac；協作器只要求
Agent 在準備修改 canonical main 時觸發 main boundary protocol。

多 Agent 可以使用不同 candidate、同一 candidate 下不同 branch，或經 Owner 選擇共享整合 branch。
產品不得用「每個 task 只能有一個 Writer」取代正常的 Git 衝突檢查與協作協調。

## 5. 任務完成與 main merge

### 5.1 完成條件

當執行 Agent 宣告 acceptance criteria 已完成，Orchestratory 必須凍結一個 candidate completion
checkpoint，彙整：

- candidate/base/main HEAD；
- changed／added／deleted／renamed files；
- diff 摘要與完整可檢視 diff；
- 已執行與未執行的測試；
- merge conflict、main drift、large/binary、權限與刪除風險；
- recovery point 與 rollback 說明。

### 5.2 主動詢問

每個任務完成後必須主動詢問：

> 是否將這個 candidate 的精確完成快照 merge／promote 到 main？

此詢問不可被 commit、review PASS、Room membership、standby approval、GUI Writer 選擇或先前任務的
批准取代。

### 5.3 核准語意

- Approval 必須 single-use、短效且 snapshot-bound。
- Scope 至少包含 Owner、task、candidate path/HEAD、main path/HEAD、operation 與 preview digest。
- Candidate 或 main 發生 drift 時，approval 自動失效並重新詢問。
- 若 merge 過程需要超出預覽的新刪除、衝突解決或其他 main 修改，必須停止並重新說明範圍。
- Owner 拒絕或暫緩時，candidate 預設保留，不刪除、不 merge。
- 成功後驗證實際 main HEAD、工作樹與變更清單，並保存 audit/recovery record。

Promotion 的 live safety gate 必須在 promotion 環境下用 Git 自己解析 clean/smudge attributes；除
main 目前的 tracked／ignored／代表性 probe 路徑外，還必須逐一詢問完整 preview 中候選 merge 將寫入的
非刪除路徑。若 preview 路徑不完整或 attributes 無法判定，必須 fail closed，不得把未知當成沒有 filter。

### 5.4 Agent 直接越界

Agent 準備自行在 shell 中修改 canonical main 時，也必須先主動提及將離開 candidate 修改邊界、說明
精確動作與風險，並取得使用者同意。一般 main 讀取不需要此核准。

## 6. Provider 與 MCP

- 優先使用使用者已登入的官方 CLI，不讀取或複製其 session token。
- MCP server 提供 control-plane 與 collaboration tools，不取代 host 的原生 coding tools。
- Room 工具契約見 `PROPOSAL_MCP_FIRST.md`；development branch 已實作 `list_agents.terminalSeats`、
  `room_send`、`room_await_reply`、stable send idempotency 與 participant/task-bound source/thread metadata，
  仍須真實 Codex＋Claude Code host 驗收。
  既有 `ask_*` worker 保持分離，任何情況都不得拿來代替 exact-seat target。
- Provider worker 工具可以保留，但必須標示它們是新建 worker，而非 live terminal seat。
- API 模式是否啟用、費用與資料傳送仍由 Owner 明確決定；不得自動 fallback 或自動付費。

## 7. GUI 與狀態呈現

- GUI 必須明確區分：Native Full-Trust terminal、GUI Managed worker、provider worker、Owner 與 system。
- 能力標籤必須顯示來源是 native host 或 managed policy，不能以「已加入 Room」推斷權限。
- GUI 顯示 candidate/main 路徑、task、HEAD、Agent branches、thread、完成狀態與待 merge 決定。
- Main merge 使用獨立畫面與批准，不與 join、standby、writer 或 message send 共用按鈕／nonce。
- Runtime 未完成的功能必須顯示 pending，不得用示意 UI 冒充已執行。

## 8. Recovery 與資料保護

- 建立 candidate 前記錄 main HEAD、working tree、untracked/ignored inventory 與必要 metadata。
- Promotion 前建立可驗證 recovery point；備份失敗時不得宣稱可安全 merge。
- 偵測未經流程的 main HEAD、refs、working tree、hooks、mode 或刪除變化並立即警示。
- 監控在 Full-Trust 下屬 best-effort；UI 與文件必須說明同帳號 Agent 技術上可停止或繞過它。
- 不自動刪除 candidate。Cleanup 是與 merge 分離的 preview/approval 操作。
- 建議整合 APFS snapshot、Time Machine 或外部備份，但不得把未驗證的外部備份宣稱成 recovery 保證。

## 9. 隱私與外部副作用

- Secrets 不得進入 Room、audit、source、log、DB、fixture 或 UI。
- Orchestratory 不攔截或重用 provider 認證。
- 自動 push、公開 repository、release、package publish、deployment、付費 API 與遠端寫入仍需精確
  使用者授權；main merge 核准不包含這些動作。
- Loopback GUI 預設不對外開放。遠端 seat 另依 Remote Room threat model 實作。

## 10. 驗收條件

目標版本完成前，必須證明：

1. 兩個不同原生終端 seat 能彼此發現並在不建立替代 worker 的情況下多輪協作。
2. Sender、target、Room、workspace 與 thread 無法被另一 seat 偽造或跨界使用。
3. Agent 原生 coding 能力在加入 Orchestratory 前後一致；協作器不暗中降權。
4. 任務完成時必定產生 candidate completion checkpoint 並主動詢問是否 merge 到 main。
5. 未核准、核准 replay、candidate drift、main drift 或 preview mismatch 都不能由 promotion service 修改 main。
6. Owner 拒絕 merge 後 candidate 仍可恢復工作或稍後重新提出。
7. Merge conflict 或新增刪除範圍會停止並要求新的說明／核准。
8. Merge 成功、失敗與 rollback 都有可驗證紀錄。
9. Thread 沒有固定往返上限；transport timeout 後可延續同一 thread。
10. GUI Managed 限制不會套用到 Native Full-Trust terminal。
11. 文件與 GUI 誠實揭露 Full-Trust 同帳號程序可繞過應用層邊界的殘餘風險。
12. 現有 secrets、loopback Web、identity、audit 與供應鏈保護沒有因模式切換而失效。
13. 正式 daemon 的 backend 與 Web assets 必須來自同一個 digest-pinned compiled runtime；不得由
    npm-link 或 Git working tree 現讀任一檔案。GUI bootstrap 必須驗證 UI protocol，不相容時停用變更操作。
14. SQLite migration 必須辨識精確舊 schema fingerprint、先驗 row integrity、在單一交易內重建，
    未知或中途失敗時 rollback；正式切換前保存 WAL-safe DB backup 與相容舊 runtime。
