# 安全政策與控制基線

狀態：**Native Full-Trust 目標規格**

依據：`OWNER_DECISION_FULL_CONTROL.md`、ADR-028、`THREAT_MODEL.md`

本版取消將「削弱所有 Agent 的能力」視為安全承諾。Native Full-Trust 下，安全重點是 main 邊界、
精確身分、merge 核准、候選成果保存與 recovery；GUI Managed 仍可使用較嚴格的工具 sandbox。

## 1. 安全承諾

Orchestratory 承諾：

- 不因加入協作器而暗中降低原生 TUI Agent 能力；
- 不因加入協作器而替 Agent 暗中升權；
- 日常任務預設使用 candidate，並在任務終點主動詢問是否 merge main；
- 不把 membership、standby、Room 訊息、commit 或 review PASS 當成 merge approval；
- Exact-seat 工作不 fallback 到常駐模型；

Supervisor audit 是告警控制，不是安全邊界：它只讀取並報告 branch/main drift、dirty worktree、
Room chain、SQLite quick/foreign-key integrity 與 handoff 缺口；它不能修復、merge、push、發布或刪除
資料。它以 read-only SQLite connection 避免 migration/recovery，且不碰 HMAC key。報告只保存必要的
bounded metadata，固定小於等於 64 KiB，使用 workspace 外的 0700 directory 與原子 0600 report file；provider dispatch 預設關閉，避免把每小時稽核
誤變成未授權的模型額度或外部副作用。
- Merge approval 綁定精確快照，main/candidate drift 即失效；
- 保留可驗證的 recovery metadata，誠實揭露 Full-Trust 不能強制隔離同帳號程序。

## 2. 資料分類

### Restricted

- Provider session/token、API keys、cookies、SSH/private keys、credential store 內容。
- 不得進入 source、Room、thread、log、DB、fixture、snapshot metadata 或 UI。

### Sensitive

- 私有 source/diff、prompt/output、絕對路徑、個資、candidate/main/recovery metadata。
- 只在完成任務、協作、preview、audit 或 recovery 所需範圍內處理，設定 retention。

### Public

- 已審查的文件、release notes、公開 source 與去識別化統計。

## 3. Native Full-Trust 能力政策

- Orchestratory 對外接 TUI session 不加 read-only、workspace jail、工具白名單或 Writer Lease。
- 不覆寫 host 自己的 permission/sandbox 設定，也不自動啟用全域 skip-permissions。
- Capability provenance 必須顯示為 native-host，不得從 Room join mode 推導。
- Host 原生工具操作不經 Orchestratory policy engine；Orchestratory 自己執行的 control-plane、promotion、
  cleanup 與外部副作用仍需 schema、identity、scope 與 audit。

## 4. Candidate 與 main

- Candidate 使用明確 task/candidate ID、base main、canonical path 與 checkpoint。
- Main path 必須有醒目標記，避免 Agent 因 cwd 或多 worktree 混淆。
- Agent 準備直接修改 main 時，依 `AGENTS.md` 主動說明並等待使用者同意。
- 任務完成由 Completion Service 凍結 snapshot 並主動建立 merge decision。
- Approval 是 single-use、short-lived、task/path/HEAD/preview-bound。Agent 只能**提出請求**；請求不含
  token、授權不了任何事，核准只能由本機 owner 介面以精確短語 `MERGE INTO MAIN` 與 dialog 實際顯示的
  `previewDigest` 產生。綁定在建立、核准與消耗三個時點各驗一次，任一值改變即拒絕並指名改變的欄位，
  不靜默重算。Single-use 由持久狀態的 compare-and-set 保證，並行消耗只有一個成功。
- 截斷或模擬出衝突的 preview 完全不可核准：Owner 不對看不到的內容簽名。
- 本機 Web 最終動作不把 raw approval token 交給瀏覽器。server 在同一呼叫內 grant 並立即 promotion；
  response loss 後的重送只依 durable `approval_id` 回讀同一筆 promotion，不能再次執行 Git。只有
  `state=applied` 且 `authorizedMergeCommit=true` 的重新觀察可顯示成功。
- Merge 結果檔案來自 tamper-evident promotion rows 與 audit chain，不來自 browser storage。只有
  applied＋authorized observation＋非空 main HEAD after 能標成「已 Merge」；讀不到、row malformed、
  audit chain 失效、`applying`、`needs-manual-review` 或缺少正向事實都不得折疊成「沒有紀錄」「已安全」
  或綠色成功。關閉檔案只關閉 dialog，不刪除 durable row；sidebar 不顯示任何 archive count。Classifier
  只可在確有 review bucket 時顯示不帶數字的人工檢查提示；rejected／expired／invalidated 等 terminal-only
  rows 不得觸發。讀取失敗只在 dialog 內具名，而非沿用未標示的成功數字、偽稱已清除或重新建立任務徽章。
- 舊版已回給 browser 的 raw token 在新版沒有任何 HTTP/MCP 消耗入口；strict approve schema 也拒絕
  `approvalToken` 欄位。重啟後一筆 `approved` 且沒有 promotion intent 的列會被具名退休並清除 token
  hash；回歸測試持有真實舊 token，證明退休後直接呼叫核心也得到 `NOT_APPROVED` 且 main 不變。
- Approval 只授權「把這個 snapshot merge 進 main」，並在授權物件內明列不被授權的動作；拒絕、失效與
  逾時不執行任何 Git 指令，candidate、checkpoint 與 recovery ref 完整保留。
- Promotion 前建立 recovery point；建立或驗證失敗時不得宣稱 ready。
- Main/candidate drift、preview mismatch、scope expansion 或未預期 conflict 均停止並重新詢問。
- Promotion 對 clean/smudge filter 必須在 live gate 以 promotion 環境的 `git check-attr` 檢查完整
  preview 將寫入的每一個非刪除候選路徑；新增路徑也必須檢查，路徑截斷或 Git 無法回答時 fail closed。
- Merge 後不自動 push、publish、deploy 或 cleanup。

## 5. Room 與 exact-seat

- Source identity 由 authenticated MCP session 伺服器端綁定。
- 每筆 delivery 包含 source、target、Room、workspace、thread、task/candidate 與狀態。
- 禁止 payload 覆寫 actor、跨 Room/workspace 投遞或以 Owner 身分發言。
- 指定 terminal seat 時禁止 provider fallback。
- Thread 沒有固定回合上限；transport timeout、heartbeat 與 cancellation 只管理連線生命週期。
- Long-lived thread 使用 retention、archival、Owner stop 與資源 telemetry 管理，不硬切正常協作。

## 6. Prompt injection 與秘密

- Repo、Room、thread、issue、commit、測試與 provider 回覆皆為不可信內容。
- 不可信內容不能修改 system/Owner 規格、偽造 merge approval 或要求 control plane 揭露秘密。
- Full-Trust Agent 技術上能讀取本機資料；產品不得宣稱 Orchestratory 可強制阻止它。
- Orchestratory 自己不得讀取、攔截、解密或重用 provider session。
- Redaction 是降低意外洩漏的防線，不是完整 secret detector。

## 7. GUI 與 Web

- GUI 預設只監聽 loopback，驗證 Host、Origin、CSRF、session 與 content security policy。
- GUI 必須區分 Native Full-Trust、GUI Managed、provider worker、Owner 與 system。
- GUI Managed 的 read-only/writer/full-trust 選擇只套用到它啟動的 managed worker。
- Join、standby、send work、managed writer、merge main、cleanup 與 external side effect 使用不同操作與
  approval scope。
- Merge 確認短語的 client-side gate 只改善可理解性，不是新的授權來源：錯字、大小寫或多餘空白時
  不得送出 HTTP，輸入框維持可編輯並以 live region 明示「尚未送出、尚未 Merge、main 未修改」；
  精確短語也只能明示「尚未 Merge，仍須按下最終按鈕」。重新預覽、未捲到底、blocker 與終局狀態
  必須各自具名，不能以 disabled control 讓 Owner 猜測結果。Server 端仍須獨立重驗 confirmation、
  snapshot binding、TTL 與 single-use state，不能信任瀏覽器 gate。server 拒絕後的 live-state refresh 若也
  失敗，client 必須保留兩個具名錯誤並固定標示非成功；nested failure 不得吞掉拒絕結果。
- Pending approval 的 input／intent button 可互動不等於授權：未捲完內層 diff、存在 blocker 或 phrase
  不精確時，final submission 必須保持阻擋。按鈕以 `aria-disabled` 呈現；click handler 的 pure target
  分流只聚焦缺少條件、顯示「未送出／未 Merge」，不得呼叫 API。只有 exact＋scrolled＋zero-blocker 才
  進既有 approve path，server 仍獨立重驗。只有 terminal、expired 或
  missing-phrase 才鎖定並清空 input；expired copy 必須說明該 approval 已死且 re-preview 不會復活。
  confirmation value 以 approval id 為 scope：同一筆 re-preview 可保留，切換新 approval 必須清空，避免
  舊意圖被誤帶到不同 snapshot。內層 scroll region 必須可由鍵盤聚焦／捲動並有可見焦點。
- Terminal approval 的 input 鎖定是 single-use 保護，不得移除；恢復路徑必須建立新 approval id。Web retry
  端點只接受 terminal、未建立 promotion row 的舊核准，重新跑 live preview 與全部 server gates，且只寫
  `requested` row；舊 token/state 不複製。已有 promotion 或讀不到 outcome 時 fail closed 到 history review。
- `restore_json` 的限制以 UTF-8 bytes 在程式與 SQLite 各驗一次，最大 64 KiB。ignored path list 的 omission
  必須有 total/truncated metadata，完整內容 fingerprint 不省略；legacy list 若不能證明完整即拒讀。Schema
  migration 交易式複製 hash-bound rows，malformed row 即使重算無金鑰 row hash 也不得成為正向收斂事實。
- Enter 在 confirmation input 內不得直接 submit；ready 只 focus final button，要求另一個明確按鍵／click。
  Client `mergeApprovalSubmitting` 必須在第一個 await 前阻擋第二次 activation，並以 `finally` 收斂；這只
  避免重疊 UI，不能取代 server single-use。aria-live guidance 以 versioned clear→next-frame set 重播，
  取消舊 callback 與舊 highlight，避免過時提示誘導新的 activation。
- 未完成的 runtime capability 顯示 pending/unsupported，不得只靠文件或按鈕假裝成功。

## 8. Recovery-first 控制

- 建立 candidate 前 inventory main HEAD、dirty files、untracked/ignored 與必要權限 metadata。
- Candidate checkpoint 必須能列舉並驗證，不只保存 UI 狀態。
- Main drift monitor 保存變更時間、HEAD/tree 與差異；但明示它可被同帳號程序停止。
- Promotion recovery 可使用 Git refs/bundle、獨立 copy、APFS snapshot、Time Machine 或外部備份；UI
  必須分別顯示「已請求」「已建立」「已驗證可讀」。
- Cleanup 與 merge 分離，preview-first；拒絕 merge 不等於允許清理。
- 不得以 destructive reset 覆蓋使用者原有 dirty state。

## 9. 命令、測試與外部副作用

- Native Agent 的 shell/test/network 由原生 host 與使用者掌控，Orchestratory 不另外降權。
- GUI Managed 可提供 container、allowlist 或 bounded runner，且必須清楚標示模式。
- Orchestratory promotion/cleanup service 使用結構化參數，拒絕未驗證的動態 shell 字串。
- Push、公開 repository、release、package publish、deploy、付費 API、寄信或其他遠端寫入需要與 main
  merge 分離的精確授權。

## 10. 本機模型 endpoint（local provider）

- 本機模型 adapter 預設不註冊；必須由 Owner 明確提供 base URL 才存在，未設定時查詢一律 fail closed。
- Endpoint 只接受 `http://127.0.0.1:<port>`、`http://[::1]:<port>` 與 `http://localhost:<port>`；
  `localhost` 會被固定成 `127.0.0.1`，避免 hosts 檔或 resolver 把連線移出 loopback。
- 非 loopback host、非 http scheme、帶帳號密碼的 URL、含 path/query/fragment 的 URL 與缺少 port 一律拒絕。
- 不跟隨 redirect：任何 3xx 直接以 `LOCAL_ENDPOINT_REDIRECT_DENIED` 失敗，避免被導向 loopback 之外。
- 每次呼叫只有一次嘗試，具明確 timeout 與輸出 byte 上限，無重試、無串流、無 workspace 寫入權限。
- 不載入、不傳送、不保存任何 credential；本機模型不進入 API 模式與計費預算路徑。
- 傳輸錯誤只以穩定的 `LOCAL_*` 代碼回報，不外洩原始 socket／errno 字串；探索失敗不得退化成空模型清單。

### 10.1 無金額成本路徑（no-cost path）

- 「無金額成本」必須由 provider 明確宣告，不得因政策查表落空而預設取得。宣告表
  （`src/providers/billing.ts`）對 `ProviderId` 是完整的：新增 provider 而未分類即編譯失敗；
  執行期查不到宣告一律丟 `PROVIDER_BILLING_MODEL_UNDECLARED`，不得視為免費。
- `no-cost` 只跳過「金額預留」一項。以下非金額硬上限對本機呼叫完全不變：
  呼叫數（soft/hard `maxProviderCalls` 與跨程序 24 小時 governor ceiling）、輪數 `maxRounds`、
  單次 timeout 與 workflow 絕對期限、`maxConcurrentWorkflows`、連續失敗 `maxConsecutiveErrors`、
  總輸出 byte 上限，以及共享 kill switch／kill epoch。
- 宣告為 `no-cost` 的 provider 不得以 `authMode: "api"` 執行；出現即 fail closed
  （`NO_COST_PROVIDER_HAS_NO_API_MODE`），不是免預留的通行證。
- 使用量必須誠實：無金額成本的呼叫一律記錄「明確的 0」與 `billing` 標記，不得留空欄位讓讀者
  誤讀為「尚未量測」。計費 provider 未回報金額時維持空缺，不得偽裝成量測到的 0。
- `local` 不啟動子程序，因此不佔 `maxSubprocesses` 名額；其資源上限由呼叫數與時間上限承擔。
  本機模型仍會消耗 CPU／RAM／磁碟，本產品不宣稱對其有資源配額控制。

## 11. Persistence、audit 與 retention

- 只保存 Room/thread/task/candidate/approval/promotion 所需的最小 metadata。
- 不保存 raw reasoning、provider session、完整環境或無必要 terminal capture。
- Audit 至少包含 actor、source/target、task/thread、candidate/main HEAD、approval scope、結果與時間。
- Audit hash 能偵測意外變更，但同帳號寫入者可重算；不得宣稱為不可否認簽章。
- Candidate/recovery retention 由 Owner 控制，清理前顯示完整 preview。

## 12. 供應鏈與發布

- Dependency、CI action 與 release artifact 維持 pin、SBOM、secret/history scan 與人工 release gate。
- 正式 LaunchAgent 只能指向 SHA-256 已驗證、實體安裝的 compiled runtime；拒絕 TypeScript checkout、
  npm-link 與 Git working tree。Backend 與 Web assets 必須來自同一 release，並以 UI protocol fail closed。
- Schema migration 前保存 SQLite online backup 與相容舊 runtime；只接受已知 schema/index/CHECK
  fingerprint 與有效 row hash，未知變體、ledger receipt 不一致或交易失敗都不得切換正式服務。
- Main merge approval 不構成 Git push、GitHub PR、公開 repository 或 release 授權。
- 文件必須同時標示 target spec、runtime status 與殘餘風險。

## 13. 安全事件

發現未經流程的 main 修改、candidate/recovery 遺失、identity spoof、approval replay 或秘密洩漏時：

1. 停止新的 promotion 及外部副作用；
2. 保存不含秘密的狀態與差異證據；
3. 通知 Owner 實際 main/candidate/recovery 狀況；
4. 提供可驗證的 rollback／restore 選項，不自動 destructive reset；
5. 修正後重新建立 preview 與 approval，不重用舊 nonce。
