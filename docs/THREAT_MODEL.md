# 威脅模型

狀態：**Native Full-Trust 目標規格；取代舊 workspace-jail 威脅模型**

依據：`OWNER_DECISION_FULL_CONTROL.md`、ADR-028

## 1. 範圍與安全目標

Orchestratory 在單一使用者的 Mac 上協調一或多個原生 TUI Agent。Native Full-Trust Agent 以登入
使用者的既有權限執行，能存取 filesystem、shell、Git、network、plugin 與 subagent。系統的主要
安全目標不是限制 Agent 能力，而是：

1. 讓多 Agent 的身分、傳訊、進度與候選成果可追溯；
2. 將日常任務成果預設保存在 candidate，不與 canonical main 混在一起；
3. 在任務終點以精確預覽與使用者核准決定是否 merge main；
4. 對誤刪、錯誤 merge、main drift 與崩潰提供偵測及復原資料；
5. 不洩漏 provider secrets 或把外部副作用混入 main merge 授權。

## 2. 非安全保證

同一 macOS 帳號下擁有完整能力的 Agent，可以繞過 Orchestratory，直接修改 main、刪除 candidate／
備份或停止監控。Candidate 因此不是不可突破的 OS sandbox；Native Full-Trust 是 recovery-first 的
協作模式，而非針對惡意同帳號程式的強隔離。

若產品需要強制 main 保護，必須另用不同 OS 身分、root-owned helper、唯讀 volume 或外部不可變
備份，並建立獨立模式及 threat model。

## 3. 主要資產

1. Canonical main 的 source、Git refs、working tree、hooks、mode 與使用者既有 dirty state。
2. Candidate branches、commits、untracked files、checkpoint 與 task metadata。
3. Provider session、API secrets、SSH keys、cookies 與其他本機敏感資料。
4. Room Ledger、exact-seat identity、inbox/thread、approval 與 audit integrity。
5. Recovery snapshots、Time Machine／外部備份狀態與 rollback 資訊。
6. 使用者的其他檔案與專案，以及 CPU、磁碟、網路、訂閱／API 額度。
7. 發布、push、deployment、package registry 與 GitHub 權限。

## 4. 信任角色

- **Owner**：唯一能核准 candidate → main merge 及外部副作用的人。
- **Native Full-Trust terminal seat**：有完整主機能力；在協作協議上不受信任，但預期遵守 main
  boundary 提示規範。
- **GUI Managed worker**：依 Owner 選擇受 bounded policy 控制。
- **Orchestratory control plane**：負責身份、ledger、thread、candidate metadata、preview、approval、
  promotion 與 audit；其資料與判斷仍可能有 bug。
- **Repository／dependency／外部內容**：不可信，可能包含 prompt injection 或惡意程式。
- **同帳號其他程序**：能與 Full-Trust Agent 一樣修改應用資料；不可假設為隔離。

## 5. 高優先級濫用案例

| ID | 濫用案例 | 主要控制 | 殘餘風險 |
|---|---|---|---|
| F01 | Agent 未經詢問直接修改 main | candidate-first prompt、canonical path 標記、main drift monitor、audit、recovery point | 同帳號完整權限可繞過或停止監控；只能 best-effort 偵測／復原 |
| F02 | 舊 approval 被 replay 到不同 candidate/main | single-use nonce、task/path/HEAD/preview digest binding、expiry | Owner 或同帳號程序若能改 approval store，仍可破壞應用層可信度 |
| F03 | 詢問後 candidate 或 main 改變 | confirm-time HEAD、tree、dirty-state、inode/fingerprint 重驗 | 重驗與 Git 操作間仍可能有同帳號 TOCTOU |
| F04 | Merge 隱含新刪除、rename 或 conflict resolution | 完整 preview、risk summary、scope expansion stop、重新核准 | Git／diff 分析 bug 可能漏報；需可恢復備份 |
| F05 | 兩個 Agent 覆蓋彼此工作 | per-agent branch/candidate、thread coordination、Git conflict detection、checkpoint | Agent 可選擇共享同一 working tree，仍可能產生非 Git 覆蓋 |
| F06 | Exact-seat 訊息被偽造成 Owner／其他 Agent，或第三席插入既有 thread | authenticated presence、source server-side binding、Room/workspace、reply-to participant/task binding、server-generated thread root、no fallback | MCP host 或本機 identity store 被同帳號篡改後不可強保證 |
| F07 | 指定 terminal 工作被改送常駐 worker，或 source/target unregister race 留下幽靈 queue／無人 await 的工作 | exact target ID、no-fallback invariant、presence delete-first、ledger/enqueue 前後雙端 reconciliation、delivery receipt、UI provenance | Terminal offline 時工作只能 failed／cancelled／拒絕，不能保證即時完成；跨 store 線性化仍靠 reconciliation 而非單一交易 |
| F08 | 固定回合 ceiling 中斷協作 | thread 無 round ceiling、transport wait 可重連、explicit cancel | 無限活躍 thread 仍可能耗用儲存／注意力，需 retention 而非對話上限 |
| F09 | Repo prompt 要求讀取或外傳 secrets | 系統規範、host 原生批准、secret redaction、audit minimization | Full-Trust Agent 技術上能讀取／傳送；Orchestratory 無法強制阻止 |
| F10 | Candidate 或 backup 被誤刪 | checkpoint、Git object verification、separate recovery copy、cleanup approval | 同帳號 Agent 可刪除所有可寫副本；外部備份才有較強恢復性 |
| F11 | Main merge approval 被誤當作 push／publish 核准 | action-specific approval、UI separation、audit scope | Full-Trust Agent 可自行執行外部命令；應由 host 原生批准與規範補強 |
| F12 | 惡意測試／dependency 破壞主機 | candidate、backup、host 原生 permission prompts、optional managed test mode | Native Full-Trust 執行任意 repo 程式即是主機 code execution |
| F13 | Room／log 洩漏 source、個資或 token | bounded schema、redaction、minimal retention、no raw reasoning/session data | Redaction 無法辨識所有秘密；Agent 可在訊息中主動貼出 |
| F14 | Web 頁面控制 localhost GUI | loopback、Host/Origin/CSRF/session checks、CSP | 瀏覽器、extension 或同帳號程序遭入侵 |
| F15 | Candidate mutation 回應遺失後被盲目重送 | MCP instructions 要求先 `candidate_status`；durable registry 可找回 task/checkpoint/completion prompt；canonical main 不被修改 | start/checkpoint 尚非 idempotent，complete retry 可能回 not-active；Phase 5 promotion 前必須補 durable request receipt 與 stable `clientRequestId` |
| F16 | Provider／API 無限花費 | Owner 選擇 provider、API explicit opt-in、native host controls、usage telemetry | 不使用固定 thread ceiling；provider 自身或 Agent 仍可能持續呼叫 |
| F17 | Runtime 尚未完成但 GUI 宣稱安全／可用 | capability negotiation、pending label、integration tests、truthful docs | 人工驗收仍可能漏掉版本不一致 |
| F18 | 回應不確定的 transport retry 造成重複派工 | 同一 authenticated presence 使用 caller-stable UUID request ID、ledger idempotency、inbox source/request unique binding | MCP host 完全退出後會取得新 presence；跨 host lifetime 的 orphan recovery 仍需後續 stable seat identity／outbox。Caller 若換 ID，系統也不能判斷其意圖相同 |
| F19 | 長駐舊 backend 從開發 repo 現讀新版 Web asset，或中途 migration 讓 DB 同時不相容新舊 runtime | digest-pinned physical release、source daemon install 拒絕、backend/UI protocol、精確 schema fingerprint、交易 migration、WAL-safe DB＋舊 runtime 成對備份 | 同帳號程序仍可修改 release/data；正式切換與 rollback 程序必須逐次驗證 digest、plist、DB integrity 與 ledger receipts |

## 6. STRIDE 摘要

### Spoofing

- 偽造 Owner、terminal seat、provider worker 或 reply source。
- 控制：server-side identity binding、exact presence、session/Room/workspace scope、不可由 payload 覆寫。

### Tampering

- 修改 candidate、main、approval、ledger、audit 或 recovery metadata。
- 控制：Git object IDs、hash/fingerprint、snapshot-bound approval、append-only events、confirm-time recheck。

### Repudiation

- 否認訊息、merge 決定、main 修改或外部副作用。
- 控制：bounded audit 保存 actor、task、thread、candidate/main HEAD、scope、decision 與結果。

### Information Disclosure

- Full-Trust Agent、Room、provider 或 log 暴露 secrets／個資／其他專案。
- 控制：最小 control-plane data、redaction、secret-free audit、清楚的 native-host 信任說明。

### Denial of Service

- 無限活躍 thread、provider loop、process bomb、磁碟填滿或大量 candidate。
- 控制：Owner stop、transport cancellation、resource telemetry、retention/cleanup workflow、provider 原生控制。
- 不以固定 thread 往返輪數處理 DoS，因為它會破壞正常協作。

### Elevation of Privilege

- Orchestratory 偷偷替 Agent 加上或取消 host 權限、GUI Managed policy 污染 Native Full-Trust。
- 控制：mode separation、capability provenance、加入前後能力驗收、禁止 Orchestratory 自動開啟 skip-permissions。

## 7. 必須持續驗證的假設

- Candidate/main canonical path 與 Git identity 能被穩定辨識。
- Provider host 在加入 MCP 前後保持相同的原生能力與批准模型。
- Exact-seat identity 無法由 tool payload 覆寫。
- Main merge approval 能綁定實際 candidate/main snapshot，且 drift 會使其失效。
- Recovery point 可在宣稱成功前實際讀回與驗證。
- Loopback GUI 的 session、Origin、Host 與 CSRF 防護有效。
- Runtime／GUI／文件能透過版本或 capability negotiation 誠實顯示已實作功能。

## 8. 明確殘餘風險

- Full-Trust Agent 能讀寫整台 Mac、執行任意程式並使用網路；若失控，應用層無法提供強隔離。
- 行為規範能約束合規 Agent，但不能阻止惡意或被完全攻陷的同帳號程序。
- Git worktree／clone 與 candidate 不等同 VM；錯誤 Git 指令仍可能影響共用 object database 或 refs。
- Snapshot、Time Machine 與外部備份的實際可恢復性取決於系統設定，必須測試後才能宣稱。
- 不設 thread 回合上限會保留長期資源消耗風險；以使用者停止、provider controls、telemetry 與 retention
  管理，而不是硬切斷協作。
- Provider 與遠端服務會處理收到的內容；本機 Orchestratory 無法消除其政策與基礎設施風險。
- Main merge 以外的直接 host 操作仍依賴 Agent 規範與 provider 自有 permission UX。
- Candidate mutation 目前沒有 request receipt；transport 結果不確定時只能先以 `candidate_status` 復原，
  不可盲目重送。任何 main promotion 上線前，這項限制必須以 durable idempotency 修正。
- Dirty-state 完整內容雜湊每次 inspection 共用 30 秒 deadline；極大或極慢檔案會 fail closed，要求 Owner
  處理工作區狀態後重試，不會以 partial fingerprint 冒充穩定 snapshot。
