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
| F15 | Candidate mutation 回應遺失後被盲目重送 | 三個 mutation 均要求 stable UUID `clientRequestId`；`candidate_requests` 以 `client_request_id` 為主鍵 reserve-execute-settle，同 key 同 operation/room/digest 從 durable state 重建同一結果、不同則 fail closed；識別碼於 reserve 時鑄造、checkpoint ref 已存在且同 head 即採納，使 crash 與重連後的重試收斂；同一把 key 由記憶體內鎖確保同時只有一個執行中（併發回 `CANDIDATE_REQUEST_IN_FLIGHT`），`succeeded` 為終局，且 settle 與 discard 都以 owner token CAS，因此陳舊的席位無法覆寫或刪除現任持有者的判決（先前僅 discard 帶 token，settle 沒有，已實測可讓一個邏輯請求產出兩份 durable 成果）；已判定 `failed` 回 `CANDIDATE_REQUEST_FAILED_RETRY_WITH_NEW_KEY` 且換新 key 必有前進路徑；未產生 durable artifact 的中止會刪除保留；canonical main 不被修改 | seat 身分刻意不入 key（重連會重鑄 display name），因此同 Room 內取得他人 `clientRequestId` 者可觸發一次 replay 讀到同一份結果——Room 成員資格即授權邊界，且 replay 無法變更狀態；記憶體鎖只涵蓋單一程序，而每個 MCP seat 是獨立 OS process 共用同一 data directory：跨 process 的同 key 併發改由 **reservation 的不透明 `owner_token`** 擋下——採用既有保留時重鑄 token，原建立者中止時的 discard CAS 不再匹配，無法刪掉他人正在使用的保留。token 不從時鐘推導（時間戳在同一毫秒內不變，曾使該保護失效）；輸家會收到錯誤（可能是下游 UNIQUE 的原始訊息而非穩定碼）而非排隊。暫時性 Git 失敗**不再燒掉該 key**：終局 `failed` 改由 allowlist `DETERMINATE_REQUEST_FAILURES`（7 個確定性錯誤碼）決定，其餘一律視為「結果未知」而讓該列維持 `pending`，同一把 key 在環境恢復後可重試收斂。方向仍是 fail-closed——不 settle 不等於當作成功，動作照樣被拒絕，改變的只有 key 是否還活著。**新的殘餘風險**：確定性但未列入 allowlist 的失敗會讓該列永久停在 `pending`（由 `inventory().requestsPending` 曝露），caller 每次重試都收到同一個真實錯誤——以可見的重複錯誤換掉不可逆的誤燒。孤兒 recovery ref 現有唯讀出口 `orchestrator candidates orphan-refs <workspace>`（只列不刪，過 workspace allowlist）。`CANDIDATE_REQUEST_RECOVERING` 的等待由 `CREATING_RECOVERY_GRACE_MS`（5 分鐘）而非記憶體鎖決定。row-hash 為完整性保護非簽章，無法防禦同帳號的惡意寫入 |
| F20 | 半建立的 candidate 被誤判為「無人擁有」而遭回收，或被誤判為「有人擁有」而永遠不解析 | `candidate_requests` 記錄 `owner_pid`；`reconcileCreating` 只跳過擁有者仍存活的 `operation='start'` 保留（同程序、`kill(pid,0)` 成功、或 `EPERM`）。擁有者可證明已死時不守護該列，由既有的 worktree 證據解析；**不寫入帳本**，因此同一把 key 的重試仍能收斂到它自己保留所擁有的成果。守衛只涵蓋 `start` 保留，`checkpoint`／`complete` 的 pending 保留不受影響 | **pid 不是持久身分，兩個方向都會錯。誤判「還活著」**：pid 重用（macOS 約 99999 後回繞；**重開機後 pid 從低號重新開始，而重開機正是最可能造成保留被遺棄的原因**）、zombie 程序未被回收 → 該列被永久守護、`inventory()` 仍計為 active、同 key 永遠回 `CANDIDATE_REQUEST_RECOVERING`。**誤判「已死」**：資料目錄放在共享或同步磁碟上時，他機的 pid 在本機無意義；不同 pid namespace（容器）；`process.kill` 拋出 `ESRCH`／`EPERM` 以外的錯誤 → 可能回收仍在執行的建立者，其 transition CAS 失敗、key 被燒掉、依文件鑄新 key 即產生第二個 candidate。**現況接受此不確定性**：兩個方向的最壞結果都不會把錯誤內容寫進 canonical main，且都在 Owner 可見的 `candidate_status`／`inventory()` 中留下痕跡。另有一個**與 pid 正確性無關**的失效曾存在並已修復：寬限期內的重試會 adopt 保留並蓋上自己的 pid，接著回 `CANDIDATE_REQUEST_RECOVERING` 而不推進；由於 MCP seat 是長壽程序，該列會被守護到程序結束、同一把 key 永遠無法收斂。現行實作在 bail 前把原 pid 寫回（`#restoreOwnerPid`），因此寬限過後同一把 key 會收斂到原本的 candidate。**兩個方向若必須擇一，本設計偏好「誤判還活著」（永不解析、Owner 可在 `candidate_status` 與 `inventory()` 看見並手動處理）而非「誤判已死」（可能回收仍在執行的建立者並產生第二份成果）**——前者可見且可逆，後者會靜默增生 durable 成果。要完全消除須改用持久身分（pid ＋ process start time ＋ boot id）或保留期間持有的 lock file |
| F23 | Merge preview 依 repository 自身設定執行任意命令 | `candidate_complete` 的 `merge-tree` 預覽會套用 `.gitattributes` 指定的 merge driver，而 driver 定義是 `.git/config` 中的一段 shell 字串，因此 preview 會以 owner 的 uid spawn `/bin/sh -c <字串>`。緩解：driver 定義**只能**來自 repo 自身設定——`minimalGitEnvironment` 設 `GIT_CONFIG_NOSYSTEM=1`、`GIT_CONFIG_GLOBAL=/dev/null`、`core.hooksPath=/dev/null`，故 global／system 設定與 hooks 均被抑制；受管制的 Workspace MCP 寫入路徑拒絕任何含 `.git` 的路徑（`workspace-server.ts:36`），因此無法經由該路徑植入 driver | 單靠 `.gitattributes` 不足以觸發（未定義的 driver 名會退回內建 text merge），需要寫入 `.git/config`。Native Full-Trust seat 依設計本來就有 shell，因此**這不是權限提升**，但誠實的陳述是：**preview 會繼承 repository 自己的設定叫 git 執行什麼**。若日後要對不可信 repository 做 preview，必須另行加上 `-c merge.<driver>.driver=` 覆寫或改用不套用 driver 的比較方式 |
| F24 | Merge 核准被重放、套用到別的 snapshot，或在綁定值改變後仍生效 | 核准是 schema v4 `candidate_merge_approvals` 的一列，至少綁 `taskId`／`completionId`／`roomId`／`mainPath`／`mainBranch`／`candidatePath`／`baseMainHead`／`candidateHead`／`mainHead`／main dirty 與 ignored fingerprint／`recoveryRef`／`previewDigest`，並在**建立、核准、消耗三個時點各驗一次**；任一值改變即回 `MAIN_MERGE_APPROVAL_BINDING_CHANGED:<欄位名>` 並轉為終局 `invalidated`。Single-use 由 `state`＋`row_hash` 的 compare-and-set 保證（並行只有一個贏家），唯一的 UPDATE 出口結構性禁止移動終局列。Token 為 32 bytes 隨機值，只在 `approved` 期間以 SHA-256 存在，離開該狀態即清除，且不寫入 audit 鏈或 Room ledger。request 15 分鐘、grant 5 分鐘後逾時記為 `expired`。截斷或有衝突的 preview 不可核准。核准只授權 `merge-candidate-into-main`，其他 action 一律 `MAIN_MERGE_APPROVAL_ACTION_NOT_GRANTED` | 同帳號程序仍可直接改 approval store；row-hash 與 scalar／preview 互為冗餘的校驗只讓竄改**可偵測且不可用**，不讓它不可能。核准不涵蓋 hooks 行為，且 `mergeable: true` 只保證「沒有內容衝突」——這兩條 5-4 的殘餘風險**已於 5-5 失效並關閉**：hook 指紋已納入綁定（見 F26），live main 的乾淨判準見 F25。**2026-08-06 更正**：本列原本寫「本階段 `consumeMainMerge` 沒有任何 MCP／HTTP 出口」，該方法已完全移除——5-5 把消耗核准與寫入 main 合併為 `promoteMainMerge` 這一個不可分割的操作，正是為了消滅「核准被燒掉但 merge 沒發生」的中間態。`promoteMainMerge` **目前同樣沒有任何 MCP／HTTP 出口**（只有測試會呼叫），接線屬第二輪，屆時仍須確保消耗與實際 merge 是同一個受保護流程。另：由**前一個版本**寫下的核准（`preview` 早於 promotion gates）不視為完整性失敗，而是以具名終局狀態 `PREVIEW_PREDATES_PROMOTION_GATES` 失效——把「快照比這個功能舊」折疊成「這列被竄改」會讓該 task 的唯一未決問題槽永久卡住（[[PITFALLS]] #85） |
| F25 | 核准存活期間發生漂移，卻在每一條讀取路徑上仍顯示為 `approved`，或失效得無聲無息 | 每一條 approval 讀取路徑（`candidate_status`、approval 列表、`inspect`，以及重新提出請求時）在回報那一列之前先對 live state 重驗綁定；漂移者在被回報前就已持久轉成終局 `invalidated`，`refusal` 帶改變的欄位名與偵測它的介面，並以 compare-and-set 保證恰好一筆稽核事件與一則 Room ledger 訊息（帳本為公開面，只列欄位名，不含路徑／id／token；owner-only audit 另記 `ownerHadGranted`，使「核准過但漂移作廢」與「從未核准」可區分）。**綁定檢查逐欄位獨立探測**：讀到且值不同才進 `changed`，讀不到一律進 `unverified`，例外絕不轉成「已改變」。`changed` 為空而 `unverified` 非空時 approval **不**失效、`token_hash` **不**清除、**不寫任何列**，只回 `bindingCheck.unavailable = MAIN_MERGE_APPROVAL_BINDING_CHECK_FAILED` 加 `unverified` 欄位名；環境恢復後下一次觀察即回報有效且仍可 consume。`grant`／`consume` 遇此情形以獨立錯誤型別`MergeApprovalBindingUnverifiableError`（`MAIN_MERGE_APPROVAL_BINDING_CHECK_FAILED:<欄位名>`）拒絕該次動作，但不轉為任何終局狀態。真的刪掉 recovery ref 仍算漂移（`rev-parse --verify --quiet` 的 exit 1 = ref 不存在，其餘 = 讀不到）。`test/merge-approval-drift.test.ts` 以 `chmod 000`、worktree 改名離開再放回、PATH 內無 git 三種真實失敗驗證，並斷言恢復後仍可成功 consume | 偵測是觀察時觸發，沒有背景輪詢：沒有人讀就沒有人發現，最終仍靠 grant／consume 各自重驗一次。讀取路徑因此會寫入——唯一可能的轉移是把已無法使用的核准記成終局失效（fail-closed 方向，無法授權、復活或刪除任何東西），但 `GET /api/rooms/merge-approvals/inspect` 在 CSRF 意義上不再是純讀取。**2026-08-06 更正**：本列原本寫「`mainIgnoredFingerprint` 仍只涵蓋 ignored 檔案的路徑而非內容」——5-5 已把它升級為**涵蓋內容**（`GitRestorePoint.ignoredFingerprint`），並在消耗核准前對 live main 重驗一次；observation 路徑上的節流快取仍只覆蓋 scalar 綁定值，hook 環境與 ignored 內容指紋由 `#authorizeMainMerge` 不節流地重讀（見 F26）。該 GET 端點目前**沒有 Origin／Referer 檢查**，實際緩解只有 `HttpOnly; SameSite=Strict` session cookie（`src/ui/web.ts:371`）、Host pinning（`src/ui/web.ts:345-346`，不符回 421）與 loopback-only 來源檢查（`src/ui/web.ts:341-343`）；放寬其中任何一項都會讓它變成可被跨站觸發的寫入。另：暫時失敗改為不失效之後，**大 repo 上 dialog 每 5 秒重算完整 preview 撞上 30 秒 deadline** 會讓觀察持續回 `unavailable`、confirm 一直不可用（不再永久失效，但仍是 5-5 前必須處理的成本問題，見 [[DECISIONS]] ADR-034 殘餘風險表）。此外，紀錄不再宣告 candidate／checkpoint／recovery ref 目前是否存在，只宣告「這次失效沒有刪除任何東西」；要知道現況必須另行查詢 |
| F26 | Promotion 以 Owner 身分、無沙箱執行 repo `.git` 內設定的 hook 與 merge driver，且 candidate 的 linked worktree 與 main 共用同一個 common `.git` | 這是 5-5 引入的新信任邊界，刻意不隱藏：**真實 merge 會執行 Owner 設定的 hook，preview 永遠不會**（所有唯讀 Git 指令固定 `core.hooksPath=/dev/null`，只有 promotion 用 `promotionGitEnvironment()`）。本次會執行的 hook 檔名與 SHA-256、`core.hooksPath`、`merge.*.driver` 與 `filter.*` 設定全部納入 `previewDigest`，因此也納入 approval 綁定，並在核准畫面上逐項列出；消耗核准前再比對一次 hook 指紋，不符即 `MAIN_MERGE_APPROVAL_BINDING_CHANGED:hookEnvironment` 且不執行任何東西。`filter.*.clean/smudge`（含 LFS）一律**偵測到即拒絕**；attributes 側的判準見下方 2026-08-06 第二次更正。**2026-08-06 更正**：本列原本寫「`.gitattributes` 內的 `filter=`」，而實作只讀了 **root** 的那一份——實測 `sub/deep/.gitattributes filter=lfs`、`.git/info/attributes`、被 ignore 的 `.gitattributes` 與 `core.attributesFile` 四種寫法全部漏掉，`approvable` 仍為 `true`。現在掃描的來源是：`git ls-files -- '*.gitattributes'`（**任意層級**，預設 pathspec glob 會跨 `/`，已實測）、ignored inventory 內任何 `.gitattributes`、`$GIT_DIR/info/attributes`、以及 repo-local `core.attributesFile`；數量／大小超限或讀不到一律 `MAIN_ATTRIBUTES_UNREADABLE`（讀不到不是「沒有 filter」）。**2026-08-06 第二次更正（第二輪審查）**：上一句的「任何一份 attributes 檔」是**假宣稱**——實測 `git check-attr` 在產品的確切環境下又找出兩個漏掉的來源：(a) `core.attributesFile` 寫成 `~/attrs` 時 git 用 `expand_user_path` 展開，而產品把它 `join(workspace, ...)` 成 `<main>/~/attrs` → ENOENT → 零 blocker；(b) 完全不設 `core.attributesFile` 時 git 仍讀 `$XDG_CONFIG_HOME/git/attributes`，`GIT_CONFIG_GLOBAL=/dev/null` 只覆蓋全域 **config** 檔、不覆蓋全域 **attributes** 檔（已用 `git check-attr` 證實）。修法不是再加一個檔案位置，而是**直接問 git**：以 `git check-attr -z --stdin filter` 在 `promotionGitEnvironment()`（就是 merge 會用的那個環境）下詢問一組代表性路徑＋本 repo 全部 tracked 路徑＋ignored 路徑，任何答案不是 `unspecified`／`unset` 即拒絕。列舉那半邊**保留**，因為它能抓到「規則指向此刻不存在的路徑」（例如 repo 內還沒有 `.psd` 時的 `*.psd filter=lfs`），而 check-attr 那半邊能抓到「這份程式碼不知道怎麼找到的 attributes 檔」。**兩半各自都不完備，合起來仍不宣稱完備**：一份全域 attributes 檔若其 pattern 既不匹配本 repo 任何路徑、也不匹配代表性清單，兩邊都看不到——這一條列在 [[VERIFICATION]] 殘餘風險表。merge 子程序有固定逾時、輸出上限與整個 PGID 的終止（以會掛住的 hook 實測，並斷言 hook 自己的 pid 已消失）。`test/merge-promotion.test.ts`、`test/merge-approval-drift.test.ts` | hook 一旦通過綁定就是以 Owner 權限執行的任意程式碼，Orchestratory 不沙箱它、不限制它能碰什麼；同帳號完全失陷仍不在信任邊界內。`.git/config` 可被有終端的 Native agent 直接寫入，因此保護來自「綁定＋揭露＋消耗前重驗」，不是來自阻止寫入 |
| F16 | Provider／API 無限花費 | Owner 選擇 provider、API explicit opt-in、native host controls、usage telemetry | 不使用固定 thread ceiling；provider 自身或 Agent 仍可能持續呼叫 |
| F17 | Runtime 尚未完成但 GUI 宣稱安全／可用 | capability negotiation、pending label、integration tests、truthful docs | 人工驗收仍可能漏掉版本不一致 |
| F18 | 回應不確定的 transport retry 造成重複派工 | 同一 authenticated presence 使用 caller-stable UUID request ID、ledger idempotency、inbox source/request unique binding | MCP host 完全退出後會取得新 presence；跨 host lifetime 的 orphan recovery 仍需後續 stable seat identity／outbox。Caller 若換 ID，系統也不能判斷其意圖相同 |
| F21 | 「本機模型」endpoint 被指到外部主機，成為 prompt／source 外傳通道 | endpoint 預設不註冊、只允許 `127.0.0.1`／`[::1]`／`localhost`（固定成 `127.0.0.1`）＋明確 port、拒絕非 http scheme／帶憑證 URL／path/query/fragment、不跟隨 redirect（3xx 直接失敗）、單次嘗試＋timeout＋輸出 byte 上限、不載入任何 credential、錯誤只回穩定 `LOCAL_*` 代碼 | 同帳號程序仍可在 loopback port 上架設反向代理再往外送；Orchestratory 只保證連線目的地是本機介面，不保證本機那個程序的行為。本機模型輸出仍是不可信內容 |
| F22 | 「無金額成本」被當成「無限制」：免費本機端點上的 agent loop 無節制燒 CPU／RAM／磁碟與時間，或未來新 provider 因政策查表落空而默默繼承免預留 | no-cost 為 provider 明確宣告（`src/providers/billing.ts` 對 `ProviderId` 完整，漏分類即編譯失敗、執行期未宣告 fail closed）；只跳過金額預留，呼叫數（soft/hard＋跨程序 24 小時 governor）、輪數、單次 timeout、workflow 期限、併發、連續失敗、總輸出上限與 kill switch／kill epoch 全數保留；no-cost provider 禁止 `authMode: "api"`；帳目一律記明確 0 與 `billing` 標記 | 本機模型的 CPU／RAM／磁碟用量不受 Orchestratory 配額控制，只受呼叫數與時間上限間接約束；`local` 不佔 `maxSubprocesses` 名額（它不啟動子程序）；本機推論可能長時間佔滿硬體，使用者仍需自行監看主機資源 |
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
- Candidate 半建立列的回收依賴 `owner_pid` 這個**非持久**的 liveness 判準（見 F20）；pid 重用（重開機後 pid 從低號重啟，而重開機正是最常造成保留被遺棄的原因）或跨主機共享資料目錄都會使它判斷錯誤；兩個方向的後果分別是「永不解析」與「重複 candidate」，皆不影響 canonical main 內容。設計上偏好前者，因為它可見且可逆。
- Candidate mutation 已具 durable request idempotency（見 F15）。殘餘限制：記憶體鎖只涵蓋單一程序，
  跨 process 的同 key 併發由 reservation 的不透明 `owner_token` 擋下——**每一個對 `candidate_requests` 的寫入都必須帶 token**（結構性不變式，非逐呼叫點檢查），輸家會收到錯誤而非排隊；
  暫時性 Git 失敗**不再燒掉該 key**（終局 `failed` 改由 7 個確定性錯誤碼的 allowlist 決定，其餘視為
  結果未知並維持 `pending`）。新的殘餘：確定性但未列入 allowlist 的失敗會讓該列永久停在 `pending`。
  孤兒 recovery ref 已有唯讀 CLI 出口 `orchestrator candidates orphan-refs <workspace>`（只列不刪）。
- Dirty-state 完整內容雜湊每次 inspection 共用 30 秒 deadline；極大或極慢檔案會 fail closed，要求 Owner
  處理工作區狀態後重試，不會以 partial fingerprint 冒充穩定 snapshot。
