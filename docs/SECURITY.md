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
- Approval 是 single-use、short-lived、task/path/HEAD/preview-bound。
- Promotion 前建立 recovery point；建立或驗證失敗時不得宣稱 ready。
- Main/candidate drift、preview mismatch、scope expansion 或未預期 conflict 均停止並重新詢問。
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

## 10. Persistence、audit 與 retention

- 只保存 Room/thread/task/candidate/approval/promotion 所需的最小 metadata。
- 不保存 raw reasoning、provider session、完整環境或無必要 terminal capture。
- Audit 至少包含 actor、source/target、task/thread、candidate/main HEAD、approval scope、結果與時間。
- Audit hash 能偵測意外變更，但同帳號寫入者可重算；不得宣稱為不可否認簽章。
- Candidate/recovery retention 由 Owner 控制，清理前顯示完整 preview。

## 11. 供應鏈與發布

- Dependency、CI action 與 release artifact 維持 pin、SBOM、secret/history scan 與人工 release gate。
- 正式 LaunchAgent 只能指向 SHA-256 已驗證、實體安裝的 compiled runtime；拒絕 TypeScript checkout、
  npm-link 與 Git working tree。Backend 與 Web assets 必須來自同一 release，並以 UI protocol fail closed。
- Schema migration 前保存 SQLite online backup 與相容舊 runtime；只接受已知 schema/index/CHECK
  fingerprint 與有效 row hash，未知變體、ledger receipt 不一致或交易失敗都不得切換正式服務。
- Main merge approval 不構成 Git push、GitHub PR、公開 repository 或 release 授權。
- 文件必須同時標示 target spec、runtime status 與殘餘風險。

## 12. 安全事件

發現未經流程的 main 修改、candidate/recovery 遺失、identity spoof、approval replay 或秘密洩漏時：

1. 停止新的 promotion 及外部副作用；
2. 保存不含秘密的狀態與差異證據；
3. 通知 Owner 實際 main/candidate/recovery 狀況；
4. 提供可驗證的 rollback／restore 選項，不自動 destructive reset；
5. 修正後重新建立 preview 與 approval，不重用舊 nonce。
