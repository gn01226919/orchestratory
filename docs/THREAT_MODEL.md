# 威脅模型

## 1. 範圍與假設

系統在單一使用者的本機執行，管理一或多個不可信程式碼 repository，並呼叫官方 provider CLI 或選配 API。v1 Web UI 只允許 loopback。

不假設模型可靠、不假設 repository 善意、不假設 dependency 無漏洞，也不把本機登入使用者遭完全攻陷列為可由應用程式完全防止的情境。

## 2. 主要資產

1. Provider 訂閱 session 與 API secrets。
2. 私有 source、diff、prompt、output 與測試資料。
3. 使用者個資、本機路徑與 repository metadata。
4. 本機檔案、Git history、開發工具與其他專案。
5. API/訂閱額度、CPU、記憶體、磁碟與網路資源。
6. Orchestrator policy、hard-limit config、audit integrity。
7. 發布 artifacts、套件簽章與 GitHub release 權限。

## 3. 威脅來源

- 惡意或被污染的 repository、dependency、Git hook、測試與建置腳本。
- Repository 中的 prompt injection 或社交工程文字。
- 被操縱、出錯或過度自主的模型輸出。
- 惡意網站對 localhost 的 CSRF、DNS rebinding 或 WebSocket 攻擊。
- 惡意第三方 package、更新伺服器或 CI action。
- 誤操作、錯誤設定、過度批准或不慎發布的合法使用者。
- 能提交 pull request 或 issue 的外部貢獻者。
- 取得本機一般使用者權限的惡意程式。

## 4. 高優先級濫用案例

| ID | 濫用案例 | 主要控制 | 殘餘風險 |
|---|---|---|---|
| T01 | Repo 文字要求 agent 讀取憑證並上傳 | Prompt trust labels、無 secret capability、無任意網路 | Provider 本身仍會看到被選入的專案內容 |
| T02 | 模型輸出 shell injection | 無 shell spawn、argv schema、allowlist | 被允許工具自身可能有漏洞 |
| T03 | `../`、Unicode 或 symlink 逸出 workspace | Canonicalization、descriptor checks、特殊檔案拒絕 | OS/filesystem race 需持續測試 |
| T04 | 惡意測試 script 讀取其他本機資料 | Digest-pinned Docker/Podman、no pull、最小 env、read-only mount/root、network off、resource limits、approval | Container runtime/daemon 與已批准 image 自身仍是高權限信任邊界；本機尚未完成真實 runtime smoke test |
| T05 | 無限 loop、非整數／超大 hard-limit 設定消耗資源或訂閱/API 額度 | 每欄編譯期絕對 ceiling、count/time/byte safe-integer gate、跨欄關係驗證、quota reservation、timeout、circuit breaker | Provider 計量延遲可能造成小幅超額；編譯期 ceiling 仍需 release review 才能變更 |
| T06 | Web 頁面控制 localhost dashboard | Loopback、Host/Origin、CSRF、session、CSP | 瀏覽器或 extension 遭入侵 |
| T07 | Log/DB 洩漏 prompt、key、個資 | 欄位 allowlist、redaction、最小 retention | Redaction 無法保證辨識所有秘密 |
| T08 | 惡意 dependency/postinstall 接管主機 | Pinning、no-script install、review、SBOM、scan | 上游合法版本被入侵仍可能影響 |
| T09 | Agent／同機程序以 symlink、hardlink、寬鬆權限或超大檔修改 hard limits、provider/tester/workspace/retention policy | Policy/config 分離、restart required、owner `0700` directory、descriptor `O_NOFOLLOW`、regular-file/UID/精確 `0600`/single-link/1 MiB 驗證；異常不自動修權限而是 fail closed | 本機帳號被完全攻陷後不可保證 |
| T10 | 多 agent 同時修改造成覆蓋或隱藏 diff | 每 task 單一 epoch-fenced Writer Lease、同 provider child 各自隔離 worktree、跨 provider child 唯讀、所有 reviewer 共用同一 captured status/tracked diff/untracked context、審查前後 content fingerprint | 不同 task 的 worktree 最終套回來源仍需 owner 逐一審查衝突；外部程式仍可能形成 TOCTOU |
| T11 | Cancel 前後的競態仍啟動 child、leader 先退出使 grandchild 逃逸，或延遲 SIGKILL 誤傷重用的 PID/PGID | realpath 前後雙重 pre-abort gate、listener 註冊後重驗、process-group TERM→KILL、leader close 後持續確認整個 group 已 ESRCH、cleanup deadline 與明確失敗 | PGID 快速重用仍有極窄平台競態；OS 級不可中斷程序會以 `PROCESS_TREE_CLEANUP_FAILED` 停止而非宣稱取消完成 |
| T12 | 公開 GitHub 時洩漏 history 或 screenshot | Full-history scan、artifact scan、human gate | 掃描器可能有 false negative |
| T13 | Fork PR 竊取 CI secrets | Read-only permissions、無 secrets、禁用危險 trigger | Maintainer 錯誤變更 workflow |
| T14 | Terminal escape sequence 偽造 UI 或 clipboard | ANSI/control sanitization、長度限制 | 終端機實作差異 |
| T15 | 偽造 human approval 或 replay | Scoped nonce、expiry、run binding、audit | 已登入本機使用者可批准危險行為 |
| T16 | `git worktree add` 觸發惡意 hook/filter/fsmonitor | 明確確認、固定 base SHA、忽略 global/system config、停用 hooks、拒絕 local external filter/fsmonitor | Git 本身或未辨識的 checkout extension 仍可能有漏洞 |
| T17 | 任意 model ID 搭配過期價格繞過 API 預算 | Owner-only model/price/max-output allowlist、byte-token 最壞情境 reservation、每次/run/日/月 gate | Provider 在文件外計費或價格設定錯誤仍可能造成差異 |
| T18 | 崩潰後自動重播造成重複寫入或計費 | Restart 先 fail closed、writer-complete checkpoint、Git fingerprint、人工 scoped restore nonce、沿用 counters/budget run | Restore 會重新執行 planner/reviewer，仍可能產生新額度；首次 writer 完成前無可恢復 checkpoint |
| T19 | 選取未授權 workspace，或以 sibling/prefix/symlink／preview 後替換混淆 | Owner-only empty-by-default allowlist、realpath canonicalization、exact root/descendant；Web 封鎖 broad/sensitive/non-Git/unsafe roots，以短效 single-use preview、精確 `ALLOW <name>` 及 directory／`.git` inode/device/mode/owner 重驗後 atomic 寫入 | 合法 owner 仍能故意授權含敏感內容的 Git 專案；本機帳號或瀏覽器完全失陷後無法保證 |
| T20 | 重放、過期或快照變更後仍執行 purge/cleanup | Preview-first、snapshot binding、短效 single-use approval、核心維護服務再驗證 | 合法 owner 仍可人工批准刪除，因此不自動排程 |
| T21 | SQLite path／sidecar 被 symlink、hardlink、寬鬆權限或 pathname race 替換，或 event 被修改、migration 部分成功 | 十個 store 共用 owner `0700` directory 與 owner `0600` single-link regular main/WAL/SHM/journal preflight、主檔 `O_EXCL|O_NOFOLLOW` 預建、`DatabaseSync` 前後 inode/device 重驗、首次 WAL 後 sidecar 重驗、transactional migration、quick/foreign-key/version check、per-run SHA-256 tamper-evident chain | Node `DatabaseSync` 不接受 fd，仍有極窄 pathname open TOCTOU；具有本機寫權者也可重算整條 hash chain，這不是簽章或外部時間錨 |
| T22 | CI action tag 被篡改或 fork PR 藉 token 提權 | 完整 commit SHA、`contents: read`、checkout 不保留 credential、無 secrets | GitHub 平台或已 pin action commit 自身仍是供應鏈信任邊界 |
| T23 | Provider CLI 在唯讀角色濫讀 home 或其他專案 | 空白 scratch cwd、最小環境、停用 built-in filesystem/shell/network/subagent/plugin | Provider CLI binary 本身仍以本機使用者執行並可讀取自己的登入設定；需持續追蹤上游行為 |
| T24 | Writer 以 stale write、symlink/hardlink 或敏感路徑逸出 | Live Writer worktree、custom Workspace MCP、canonical path、UTF-8/size/type gate、SHA-256 compare、new-file no-clobber、無 delete/shell/network | 本機其他程序可製造 filesystem TOCTOU；真實 Claude CLI/MCP smoke test 尚待額度批准 |
| T25 | Untracked/binary/large file 規避 diff 與 reviewer | changed file content fingerprint、50 MiB byte ceiling、40-file ceiling、bounded untracked context、敏感/oversize fail closed、binary summary | 模式式 sensitive-path 偵測可能漏掉未知秘密格式；啟用遠端 provider 前仍需人類確認資料範圍 |
| T26 | 原生 PTY bridge 載入寬鬆 provider 設定、寫檔或冒名紀錄 | 預設關閉的 owner-only gate、fixed provider/argv、Codex read-only+never、Grok plan+empty tools、無 shell、混合畫面身分、RAM/time/turn bounds | Provider 自有設定與上游行為仍是信任邊界；無 controlling TTY 的 CI 無法取代 owner live smoke |
| T27 | Room 對話或 Writer 面板藉交辦繞過 workspace 邊界直接寫檔 | Session/Origin/CSRF、room-derived allowlisted workspace、後端建立 worktree、task/epoch/executor/capability 每次 mutation fencing、browser 不持有 capability、apply-back 仍 preview＋人工批准 | 合法 owner 仍可指派惡意任務；真實 provider 可能在受控 worktree 內產生破壞性內容，套回前必須看風險與 diff |
| T28 | 惡意 localhost 頁面或擴充套件誘導 owner 用 Web 擴大 workspace | Loopback Host/Origin/session/CSRF、固定原生 picker、手動路徑 preview、敏感 root 封鎖、精確專案名確認、single-use TTL 與 confirm-time revalidation；不提供 Agent 自動申請／批准入口 | 已控制同源頁面、瀏覽器或本機 owner 的攻擊者仍可能模擬合法操作；Web 不是對完全失陷終端的安全邊界 |
| T29 | 未加入的 MCP 終端被偷偷錄音、兩個 Codex 視窗混成同一人，或已關閉終端仍留在辦公室 | owner-only presence SQLite、canonical workspace binding、terminal-side `room_join_request` 加 GUI session/Origin/CSRF 雙重明確加入、未申請不列於 GUI、per-process UUID、host PID correlation、5s heartbeat/15s lease、EOF unregister、交易式不回收 alias、常駐工作站與臨時席位分離、hook event dedupe、raw session id hash-only、legacy hook no-op | 本機同一帳號的惡意程序可觀察或模擬 process relationship；突然 crash 最多在 lease 期間顯示暫時在線，且 hooks 的上游欄位契約仍需隨 CLI 更新重新驗證 |

| T30 | GUI 將新 provider call 冒充成既有外接終端、把只在線的席位誤報成可喚醒，把普通 `@provider` 帳本文字誤報成永久執行中，或受控即時 Agent 藉對話擴權寫檔 | 外接終端與 managed-subagent 使用分離 endpoint/seat ID；`room_join_request` 保持至 GUI 核准並開始第一段 bounded wait，之後只由原終端的 active `room_wait` 收件；API/UI 明示 `active-tool-pull`、`wakeable` 與休班 queued 狀態；常駐 provider 等待只由 `room_mention` 的 start/outcome lifecycle event 驅動，不由文字推測；直接 managed wake 固定唯讀。外接 Writer 另標示 via Writer Companion，HMAC audit 保存雙重身份；寫入只經 Writer Lease | 受控即時 Agent 每次直接喚醒不是 provider 原生持續 session；MCP 無法替完全 idle 的外部 host 發起新 turn；Writer Companion 代表執行而非原生終端程序，UI 與文件不得模糊三者 |
| T31 | GUI 訊息投遞給錯誤 Codex/Claude 視窗，或離線後 fallback 到同名常駐 Agent | per-process presence UUID、room/workspace exact binding、owner join、target presence id、delivery lease token、完整 receipt state、無 fallback、離線 fail、idempotent reply | 終端未持續呼叫 `room_wait` 時只能排隊或明確失敗，無法保證原生 CLI 被動接收 unsolicited input |
| T32 | Writer 交接後舊 Writer／子 Agent 繼續寫，或技術 executor 冒充顯示身份 | monotonic lease epoch、RAM capability、每次 Workspace MCP mutation 重驗、父 lease 撤銷連帶 child、same-provider-only child write、HMAC dual-identity audit | daemon crash 後 RAM capability 遺失，active lease 必須由 owner 重新建立或交接；本機 owner 完全失陷不在邊界內 |
| T33 | 雙 Enter 送出與中文 IME、換行、長按或異步送出衝突，造成未預期訊息／provider call | 只接受 1.6 秒內、內容／selection 完全不變的第二次無修飾 Enter；IME `isComposing`/229 連 keyup 壓制、repeat 拒絕、modifier/blur/其他鍵清除、disabled submit 不重送；Shift/Option 換行、Command+Enter 為明確快速送出 | 瀏覽器／輸入法對 composition event 的上游行為可能改變；可視鍵盤與 assistive technology 仍可使用可見送出按鈕 |

## 5. STRIDE 摘要

### Spoofing

- 偽造 provider executable、Web session、approval actor。
- 控制：固定 executable identity、版本/來源檢查、ephemeral session、scoped approval。

### Tampering

- 修改 policy、SQLite、checkpoint、release artifact。
- 控制：owner-only permissions、integrity check、tamper-evident event hash chain、signed release/provenance。

### Repudiation

- 否認批准或執行高風險動作。
- 控制：redacted audit event、approval ID、timestamp、scope、decision reason。

### Information Disclosure

- Prompt、source、key、路徑、個資進入 log/UI/provider。
- 控制：data minimization、secret isolation、field allowlist、retention、公開前掃描。

### Denial of Service

- 無限 agent loop、超大輸出、process bomb、磁碟填滿。
- 控制：quota、timeout、process/output/file limits、circuit breaker、disk guard。

### Elevation of Privilege

- 模型取得 shell、網路、workspace 外讀寫或修改 hard limits。
- 控制：broker architecture、default deny、sandbox、human approval、config separation。

## 6. 必須持續驗證的安全假設

- 官方 CLI headless mode 不要求暴露 session token。
- CLI 可在受限環境中可靠取消並回報結束。
- OS credential store 與檔案權限符合平台預期。
- Loopback Web 服務可正確防止瀏覽器跨站控制。
- 所使用的 sandbox 能涵蓋 child process 與 file/network access。
- Provider/model 參數不會導致 CLI 退回較寬鬆權限。

每次 CLI、runtime、OS 或 provider 行為重大更新後都必須重新驗證。

## 7. 明確殘餘風險

- 發送給 provider 的 prompt/context 受各 provider 政策與基礎設施保護，本機控制無法消除遠端處理風險。
- 本機帳號或 kernel 已完全遭攻陷時，本應用無法保證秘密與資料安全。
- 任意 repository 測試本質上具有程式碼執行風險；在成熟 sandbox 完成前，預設要求人工批准。
- 自動 secret detection 可能漏判未知格式，因此必須搭配最小資料策略與人工發布審查。
- Worktree 共用來源 repository 的 Git object database 與 refs，不等同 VM/container 隔離；因此仍不允許模型自行執行 Git、merge、push 或 cleanup。
- API worst-case reservation 依使用者維護的官方價格設定；若價格過期，應用無法保證與 provider 帳單完全一致，故 API 預設保持 disabled。
- SQLite audit chain 能偵測意外或未同步竄改，但不是密碼簽章；取得本機資料庫寫權者可能重寫內容並重算 hash。
- Workspace MCP 已拒絕可辨識的 path/link/type/race 狀態，但 Node 的 path-based filesystem API
  不是完整 descriptor-based transaction；同一帳號下的惡意並行程序仍可能形成窄 TOCTOU window。
- Provider CLI 參數與 MCP protocol 會隨上游版本變動；在未完成使用者批准的真實 smoke test 前，
  只宣稱 synthetic fake-CLI 與本機 protocol 測試通過，不宣稱 live provider 已驗證。
- Native PTY 畫面不是結構化訊息，可能混合輸入、輸出與 redraw；redaction 也無法保證辨識所有秘密。
  因此 bridge 預設關閉、只保存 bounded tail，且不可用它推斷精確 agent 身分、turn 或 token 用量。
