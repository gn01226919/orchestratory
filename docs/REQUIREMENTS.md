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

所有由督導觸發的 filesystem read（含 Git cwd/config、Room/SQLite open、handoff mirror、metadata 與 report
path 驗證）必須被包含在獨立 process group 的 hard deadline 內；不得只以 `Promise.race` 包住仍在執行的
`readFile`。Deadline 到期時父程序必須終止整個 group，在固定時間內輸出
`FILESYSTEM_READ_DEADLINE_EXCEEDED`、盡力寫入 bounded report 並非零退出。launchd 不直接讀 iCloud；它只讀
owner-only 本機 mirror 與 manifest。Manifest 必須以 bounded schema 記錄每份 source、mirror、SHA-256 digest、
bytes、`mirroredAt` 與 `staleness`（期限及是否 stale）；缺檔、digest/size 不符、schema 壞掉或到期均具名 ALERT，
且不得 fallback 回 iCloud。互動式 mirror refresh 同樣以可終止 process group bounded，manifest 最後原子提交。

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
- 本機 Owner 在最終按鈕送出後，產品必須於同一次操作內核准並執行 promotion；不得停在只有
  `approved`、卻沒有任何可用 promotion 出口的狀態。只有 durable promotion 為 `applied`、且重新觀察到
  `authorizedMergeCommit=true` 與實際 `mainHeadAfter` 時，GUI 才能顯示「Merge 成功」。
- 確認短語必須有就地、可存取的即時回饋：非 exact phrase 時欄位保持可修正、~~主要按鈕保持停用~~
  真正提交保持阻擋，並明示
  「尚未送出、尚未 Merge、main 未修改」與正確短語；exact phrase 只能顯示「可送出但尚未 Merge」。因
  ~~scroll gate、re-preview、blocker 或 terminal state 鎖定輸入時，輸入框旁必須具名原因與恢復方式。~~
  pending approval 且 confirmation phrase 可用時，輸入框必須保持可輸入；scroll gate、re-preview 與
  blocker 只阻擋最終提交。按鈕使用 `aria-disabled` 表達尚不可提交但仍接收 intent click：該 click 只聚焦／
  高亮缺少的 input、內層 diff 或 re-preview，並以 live status 明示未送出／未 Merge，不得發出 HTTP。
  只有 terminal state、已逾時或缺少 phrase 才 native-disable 並清空輸入；
  逾時 copy 必須明示該 approval 不可復活、需由 candidate 提出新的 snapshot-bound request。
  已輸入文字只可在同一 approval id 的 re-preview／re-render 保留，切換至新 approval 必須清空。
- 內層變更清單必須可由鍵盤聚焦及捲動，具可見 focus indicator，且以 `aria-describedby` 關聯明示
  「內層清單、不是外層 dialog」的 live scroll hint；不能把滑鼠操作當成唯一通過 scroll gate 的方式。
- 只有 exact phrase、內層 diff 已捲到底、零 blocker、未逾時且非 terminal 的同一 snapshot 可由 intent
  handler 進入既有 approval POST；任何未就緒 click 都必須可見有反應但 fail closed。
- 確認輸入框的 Enter 不得直接執行最高風險動作：未就緒時走相同 intent guidance；已就緒時只把焦點
  移到 final button 並要求第二次明確 activation。POST 在途時 client 必須鎖住重送並顯示「處理中，不會
  重複送出」；結束或失敗後可靠 `finally` 釋放。相同 guidance 的重複 activation 必須重新觸發 aria-live，
  target 改變時移除舊 attention 並重新計算，不得讓 screen reader 或可視焦點停在舊缺口。
- 核准 POST 被拒絕後，即使重新讀取 live approval 也失敗，GUI 仍必須保留原拒絕原因、具名 refresh
  failure 並明示「這不是 Merge 成功」；nested read error 不得把結果變成沉默或成功。
- 核准在 promotion intent／任何 Git 寫入前失敗時，舊 approval 必須保持 terminal 且不可復活；Owner
  可由同一 dialog 明確要求重新讀取 live state，系統建立**不同 approval id** 的新 snapshot-bound request、
  自動切換並恢復輸入。此操作不得自動 grant／Merge；若舊 approval 已有 promotion row 或狀態不確定，
  必須導向 Merge 紀錄人工核對，不得提供重複 apply 出口。
- 只有 durable positive observation 已顯示「Merge 成功」後，結果卡片才可提供「完成並回到 Room 主畫面」；
  該控制只關閉 dialog、切回帳本直播並聚焦發言框，不得新增 HTTP／MCP 呼叫、再次 promotion 或清除 durable
  Merge 紀錄。`rolled-back`、`needs-manual-review`、讀不到與其他不確定結果不得顯示成功返回控制。
- Durable promotion restore point 必須以 UTF-8 bytes 設定有限上界，不得只把 SQLite TEXT 上限無界放大。
  ignored path 顯示清單可以截斷，但必須持久保存 schema version、總數與 truncation flag；完整 path＋content
  fingerprint 不得截斷。省略顯示路徑不得被解讀為「已恢復」或「沒有差異」，malformed／不一致 legacy 或
  current payload 必須 fail closed。Candidate 寫入路徑的 overwrite scan 仍須使用完整 preview 清單。
- 待處理區只顯示仍可回答且未逾時的 `requested` 記錄；零筆時整個 task control 消失，不留下 `0` 或
  歷史總數 badge。Durable 結果檔案必須是獨立、無數字徽章的「Merge 紀錄」入口；只有 classifier
  找到 `needs-manual-review`、malformed／不完整 promotion 或沒有 promotion 的非終局 approval 時，入口
  才顯示不帶數字的「需檢查」提示。Dialog 內才分成
  「已 Merge」「需要檢查」「未進入 Merge」：只有 promotion=`applied`、
  `authorizedMergeCommit=true` 且非空 `mainHeadAfter` 才能計入綠色「已 Merge」；缺任一正向事實的
  promotion、malformed row 或沒有 promotion 的非終局 approval 都進「需要檢查」；只有 rejected／expired／
  invalidated 且沒有 promotion 的 approval 才進「未進入 Merge」。結果必須在 daemon restart 後仍可依
  Room/workspace 查核，並顯示 approval/promotion/task、前後 HEAD、candidate HEAD、recovery ref、狀態、
  時間、observation 與已觀察到的 hooks；不得包含 approval token 或秘密。關閉檔案不刪除、不歸零；
  讀取失敗只在紀錄 dialog 內具名，不得在側欄重新出現數字或把讀不到說成零筆。

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
- Merge 最終按鈕在執行期間顯示「核准並執行 promotion」；失敗、rolled-back、`applying` 或
  `needs-manual-review` 必須與成功使用不同文案，且不得自動重試或重複 apply。

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
15. 真實 Owner HTTP 操作必須一次完成 grant＋single-use promotion，response loss 後重送只能回讀同一筆
    durable promotion；成功項目離開 pending 並出現在可於重啟後重建的 Merge 歷史。
