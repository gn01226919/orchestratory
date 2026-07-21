# 安全政策與控制基線

## 1. 安全承諾

本專案以防止憑證洩漏、個資洩漏、任意程式碼執行、workspace 逸出、供應鏈攻擊與失控成本為首要目標。任何安全 gate 失敗都阻擋 release。

本文件是設計基線，不構成零風險保證。首次公開 repository 前必須啟用 GitHub
Private Vulnerability Reporting；公開後請使用 repository 的 **Security → Report a vulnerability**
私下通報，不要先建立公開 issue。管道尚未啟用時，release 必須保持 NO-GO。

## 2. 資料分類

### Restricted

- API keys、OAuth/session tokens、cookies、SSH keys、憑證。
- Provider credential stores 與登入設定。
- 私有原始碼、未公開 diff、完整 prompt/output。
- 個人資料、使用者名稱、email、本機絕對路徑。

不得寫入 source、Git、SQLite、一般 log、telemetry、錯誤回報或 browser storage。

### Sensitive

- Workflow metadata、model 使用情況、測試結果、repository 名稱。
- Redacted agent summaries、審查結論。

只保存在本機、owner-only 權限、有限 retention。

### Public

- 開源程式碼、公開文件、範例設定、合成測試資料。

公開資料仍需經 release leakage review。

## 3. 認證與秘密管理

- 訂閱模式透過官方 CLI 自行管理登入；本程式不讀取其 token 檔案。
- API secrets 優先由 macOS Keychain 保存，也可由啟動程序的 ephemeral environment 提供；
  程式只在呼叫邊界取得值。API endpoint 固定，不允許使用者或模型提供任意 URL。
- Secret 不得回傳到 TUI/Web，不得出現在 process title 或 command-line arguments。
- 子程序環境採 allowlist；未被需要的 secret 不傳遞。
- 唯讀 provider CLI 在空白 scratch cwd 執行且停用 built-in filesystem/shell/network/subagent；
  通過寫入沙箱驗證的 Codex／Claude Writer 只取得 owner-only 暫存設定指向的 bounded Workspace
  MCP tools。Grok 與 API adapter 不取得寫入能力。
- Redactor 是最後防線，不是秘密可以進 log 的理由。
- Crash dump、debug mode 與 support bundle 預設不得包含 Restricted data。

## 4. Prompt injection 與 excessive agency

- Repository 內容屬不可信資料，不可成為高優先級指令。
- Tool capability 由 policy 設定，不由 prompt 授予。
- 模型無法讀取 secrets、任意環境或 workspace 外檔案。
- 所有模型工具建議必須做語法與語意驗證。
- 高風險動作必須 human-in-the-loop。
- Worktree、API、測試與 checkpoint restore 使用 action/resource/workflow scope、短 expiry 與
  single-use nonce；token 只保存 SHA-256，不能跨 action 或 workflow replay。
- Agent 間傳遞內容需標記來源與信任等級，避免把模型輸出重新包裝成系統指令。

## 5. 命令執行

- 使用無 shell 的 process spawn 與 argv array。
- Executable 必須來自受控 registry，解析後固定實際路徑與版本。
- 禁止命令替換、重導向、pipe、subshell、glob 與動態 script。
- 測試命令也視為高風險，需 allowlist、sandbox、timeout 與網路政策。
- v1 測試 sandbox 只接受 owner 設定且 SHA-256 digest-pinned 的 Docker/Podman image，固定
  `--pull=never`、`--network=none`、read-only root/workspace、cap-drop、no-new-privileges、
  非 root user 與 CPU/記憶體/PID 上限。Runtime/image 缺少時 fail closed。
- macOS `sandbox-exec`/SBPL 不作為產品安全邊界；不自動安裝 runtime 或 pull image。
- 終止時殺掉完整 process tree，避免 orphan process 持續消耗資源。
- stdout/stderr 設 byte limit，超過即截斷並終止。

## 6. 檔案系統

- 所有使用者路徑正規化並限制於 allowlisted root。
- 禁止 device、socket、FIFO 與 workspace 外 symlink target。
- 寫入使用安全 temporary file、正確權限與 atomic replace。
- 不修改 provider/auth/config home directories。
- 每個 task 的 Writer Lease 保證同一時間只有一個主寫入者，且以 monotonic epoch fencing；交接時
  舊 Writer 與其所有子 Agent capability 立即失效。
- Live Writer 強制使用 task 綁定的 worktree；同 provider 子 Agent 與父 Writer 共用同一 task
  worktree，並由持久化跨程序 task run lock 序列執行；跨 provider 子 Agent 唯讀。Grok Writer
  與所有 API Writer 保持停用。
- Workspace MCP 只允許 UTF-8 text list/read、逐層 create-directory 與 hash-bound atomic write；
  `.git`、`.orchestratory`、`.env*`、key/certificate 類路徑、symlink、hardlink、special file 與
  workspace escape 全部拒絕，且不提供 delete、rename、Git 或 process tool。
- 新檔使用 no-clobber 建立；既有檔必須提供最近一次 read 的 SHA-256，stale write 直接拒絕。
- 修改超過 file/diff limit 時必須停止並要求批准。

## 7. Web/TUI

### TUI

- 不顯示 secret、raw environment 或 provider auth details。
- Paste/輸出中的 control sequences 必須消毒，防止 terminal escape injection。
- 所有非斜線輸入皆可能觸發訂閱 provider call；啟動畫面必須明示額度影響。斜線指令由本機解析，不得送入模型。
- Sub-agent tools 必須是固定白名單與 bounded schema；模型不能註冊新工具。任何混合文字或無法完整解析的 tool marker 均不得執行。
- 自動委派只允許唯讀工具；寫檔型 `coding_team` 必須顯示 task、agent、worktree 與上限，並要求精確 `RUN`。
- 對話內容只在 RAM，最大 32 KiB／30 turns；`/new` 不得重設 provider-call 防濫用計數。
- Dashboard 所有 task、workspace、event、message 與 diff 行在繪製前必須消毒並依 terminal bounds 截斷。
- Provider JSONL/stream event 不得直接顯示；只允許 adapter 驗證後的最終文字。格式漂移或缺少文字時 fail closed，避免洩漏 thread/usage metadata。
- Allowlist 空白時不得繼續收集 task/provider；單一 root 才可成為預選值，home directory 不得隱含授權。
- 執行中取消需五秒內二次按鍵；第一次只顯示 bounded confirmation notice。
- 外部 URL 不自動開啟。

### Web

- v1 僅允許 loopback；拒絕非預期 Host 與 Origin。
- 高熵 ephemeral session、HttpOnly、SameSite、Secure when applicable。
- 所有狀態變更要求 CSRF 防護。
- CSP、無 inline script、無第三方 CDN、無遠端 analytics。
- 首頁對話只允許已授權 canonical workspace；聊天可在 dirty repository 唯讀進行，但任何寫檔仍必須轉入既有 approval-gated workflow。
- 對話 turns 受 hard limits 約束；所有真實 provider calls 另由 owner-only SQLite 的 24 小時全域
  governor 原子計數。TUI、Web、MCP 或重開程序都不能把該 ceiling 歸零；fake provider 不占真實額度。
- WebSocket/SSE 驗證 session、origin、message schema 與速率。
- Browser localStorage 不保存秘密或完整任務資料。
- Room 辦公室任務中心與 Agent 狀態卡只讀取既有 bootstrap、Room ledger 與 redacted workflow
  events；DND、目前工作與完成動畫不是批准介面。通知與日夜／安靜／休閒／全螢幕偏好只存頁面
  RAM，重新整理即清除，不使用 localStorage，也不新增第三方資源。Miso／Byte 的巡邏、腳步與表情
  是本機 CSS 動畫，不讀資料、不呼叫 provider、不建立外部請求。
- Web 的「新增專案」只允許固定原生資料夾 picker 或手動路徑；兩者都先產生 RAM-only、短效、
  single-use preview，顯示 canonical path、Git／owner／mode／敏感範圍檢查，再要求精確
  `ALLOW <folder-name>`。Confirm 重新驗證 inode、device、mode、owner、`.git` 與敏感範圍，
  任一變動 fail closed；Web 不接受 shell、任意 executable 或遞迴掃描整個 home。
- Room 的一般 coding workflow 提案仍只能建立 owner-only pending metadata；Writer 面板則是
  owner 專用控制面，可選 resident／managed／external Writer 並建立、交接、執行、取消或完成
  task-scoped lease。Workspace 由已授權 Room 反查，worktree 由後端建立；瀏覽器拿不到 capability。
  每次 Workspace MCP mutation 都重新驗證 task、epoch、executor 與 RAM-only capability。

## 8. 用量與阻斷濫用

- 每個 workflow 有 calls、rounds、wall time、output、subprocess、files、diff 限制。
- 全域有 concurrency、持久 24 小時 provider-call ceiling，以及 API 每日與每月限制。
- API 有預算 reservation 與 hard stop。
- API 模型缺少 owner 設定的價格／最大輸出政策時 fail closed；預算採最壞情境 reservation，
  不把 provider 回傳的事後 usage 當成唯一防線。
- Subscription CLI 無精確 token 時，以 calls/time/output 的保守限制補足。
- Provider call 有 call/time/output/subprocess/circuit-breaker 上限；v1 不自動 retry，因此不會因
  backoff 邏輯重複消耗額度。`maxRetries` 是未來實作不得超過的硬 ceiling，目前實際值固定為 0。
- Long-run mode 不能變更 hard limits。
- Hard limits、API model、tester、workspace 與 retention JSON 一律從 owner `0700` 資料目錄內的
  owner `0600`、single-link regular file descriptor 讀取；`O_NOFOLLOW`、1 MiB 上限，任何 mode、owner、
  type 或 link 異常皆 fail closed，不得由程式自動 chmod 掩蓋可能的竄改。
- Hard-limit JSON 只能在編譯期 ceiling 內調整：同時 workflows 4、單次 provider 30 分鐘、workflow
  24 小時、calls 1,000、subprocesses 500、單次輸出 8 MiB、變更 200 檔／100,000 lines、連續錯誤
  20、retries 10、rounds 100、API 預算每 run/day/month 分別 250/500/2,500 USD。資源 count/time/byte
  一律要求 positive safe integer，預算可為正小數；timeout、round/call、run/day/month 關係也會
  fail closed 驗證。這是最外層災損 ceiling，不代表建議用量或自動批准費用。
- Kill switch 必須在 UI、TUI 與 OS signal 下都能運作；共享 kill epoch 會 abort 跨程序 in-flight
  call，既有 workflow 在下一個 provider/test 邊界也必須以 `GLOBAL_EMERGENCY_STOP` fail closed。
- MCP provider 類型由啟動參數 `--actor` 固定，tool arguments 不得改寫。每個 stdio process 另有
  owner-only presence id；只有該 live session 先對同一 canonical workspace 的 Room 呼叫
  `room_join_request`，且 GUI 再對精確 session 明確加入後，
  `room_post`／`room_mention` 才能以交易配置且不回收的 `codex1` 等 display identity 寫入。
  這仍是本機 display identity，不是遠端密碼學身分證明。
- GUI 對外接席位的交辦進入 owner-only 精確 inbox；終端必須主動執行 bounded `room_wait`，並以
  私有 delivery lease token 呼叫 `room_ack`、`room_reply` 或 `room_fail`。狀態只允許
  queued/delivered/read/working/replied/failed/cancelled；離線、取消、重送、過期與去重均 fail
  closed，且不會 fallback 到同 provider 的常駐 Agent。
- `room_join_request` 會把同一 MCP tool call 保持到 GUI 核准，核准後直接進入第一段 bounded wait；
  預設核准 30 秒加首輪收件 20 秒，總和低於常見的 60 秒 MCP request timeout；client 的
  `notifications/cancelled` 會傳入 AbortSignal、清除待核准請求與 wait lease，程序死亡後 lease 也在
  bounded TTL 內失效。
  後續只有活躍的 join/wait call 可被 GUI 即時喚醒。完全 idle 的外部 host 不支援 server-initiated
  turn，API/UI 必須回報 `wakeable: false` 並讓工作維持 queued；不得用新 provider call 冒充它。
- macOS Room PTY join 只允許固定 `codex`／`grok` executable，不接受額外 provider flags、不經
  shell，且必須由 owner 在已授權 workspace 的實體 TTY 主動啟動。Codex 強制 read-only sandbox、
  never approval 並停用 shell/hooks/plugins；Grok 強制 plan mode、空 tools 與停用 web/subagents/
  memory。終端內容只保留 RAM 中的
  128 KiB 尾段，清除控制碼、redact、縮至 12,000 字後，以 `*-terminal` 身分和「混合畫面」標籤
  入帳；不冒充乾淨模型回覆。Session 四小時硬停。原生 TUI 內每輪 token/call 無法可靠觀測，故
  此功能不得作為自動 workflow 的 governor 替代品。
- Codex Writer 與 native Room PTY capability gate 均預設關閉。Loader 使用 `O_NOFOLLOW` 開檔後
  以 descriptor 重驗 regular file、owner UID、mode 0600、single hardlink、1 KiB 上限與精確
  `{"enabled":true}` schema；資料目錄本身也必須 owner-only。任一條件不符一律回到 disabled。
- `request_coding_workflow` 唯一副作用是向 owner-only SQLite 寫入 bounded control-plane metadata；
  pending 上限 100、row integrity 驗證、actor 由 MCP 啟動參數固定。它不含 approval token、不能
  啟動 provider／worktree／tester，也不能讀寫專案；只有本機 GUI 的 owner 動作能將提案帶入既有
  scoped approval 流程。
- Dirty Snapshot 與 apply-back 都不接受模型文字作為授權。兩者各自使用 RAM-only、短 TTL、
  bounded pending state 與獨立 scope-bound single-use nonce。Snapshot 拒絕敏感/自動執行路徑、
  binary、非 UTF-8、symlink、hardlink、特殊檔、可執行 mode、路徑 alias、大小與數量超限；來源或
  target 任一變動即 fail closed。
- Apply-back 僅接受 completed retained worktree，且 source 仍在 allowlist。Preview/套用兩階段都
  重驗 HEAD、fingerprint 與逐檔 hash；刪除只移入 owner-only `~/trash-pending/orchestratory/`，
  不呼叫永久刪除。多檔中途失敗執行 bounded rollback，無法完整 rollback 時留下明確 error event。
- 新 Room presence hooks 不讀 transcript：只接受官方 structured event 的 bounded 欄位，raw
  session id 只做 SHA-256 correlation，不回傳 GUI。未加入、lease 過期、workspace/PID 不符、
  recording 非 on 或重複 event 一律不新增 chat entry；legacy `room log-hook` fail closed 為 no-op。

## 9. Log、audit 與 retention

- 使用 typed structured event，不直接傾倒 provider raw output。
- Log 前做欄位 allowlist、大小限制與 secret/PII redaction。
- 預設記錄決策與摘要，不記錄完整 prompt、reasoning 或檔案內容。
- Writer／子 Agent 的自然語言行為寫入 Room 帳本；另以 owner-only HMAC chain 記錄
  `on_behalf_of`、`executed_by`、`lease_epoch`、操作與結果。HMAC key 與 SQLite 分離，sandboxed
  Writer 無法取得；這提供本機 tamper evidence，不宣稱外部時間戳或不可否認性。
- Audit 事件包含時間、run、actor、action、decision、reason，不含秘密。
- Debug logging 必須明確 opt-in、自動到期並顯示風險警告。
- `workspace-roots.json` 預設空白；canonical root 只能經實體 TTY 精確確認，或 loopback Web 的
  session／Origin／CSRF 防護、短效單次 preview、敏感範圍封鎖、精確確認與 TOCTOU 重驗後加入。
  兩條入口都寫入同一份 owner-only atomic policy；TUI、Web、JSONL 對未授權路徑仍一律 fail closed。
- SQLite 啟動時執行 `quick_check`、foreign-key check、schema version gate 與 per-run SHA-256 event-chain 驗證；migration 交易失敗即 rollback。
- 全部 SQLite store 在任何 schema/query 前共用 owner-only preflight：資料目錄精確 `0700`，主檔與
  `-wal`／`-shm`／`-journal` 精確 `0600`、owner UID、regular file、single hardlink；主檔以
  `O_EXCL|O_NOFOLLOW` 建立並在 `DatabaseSync` pathname open 前後比對 device/inode，首次 WAL
  pragma 後再驗 sidecar。異常權限或連結不會被靜默 chmod，會直接 fail closed。由於 Node
  `DatabaseSync` 不接受 fd，同帳號惡意程序仍可能競逐極窄的 pathname open 視窗，列為殘餘風險。
- 提供 `orchestrator data inventory`、`data integrity` 與有限 retention policy。`data purge` 預設只預覽；
  `--execute` 仍需 TTY 精確文字、短效 scoped nonce 與 snapshot 重驗，且不清除 active run 或 retained worktree。
- Worktree cleanup 同樣 preview-first；拒絕 dirty/mismatched/active worktree、不使用 `--force`、不刪 branch。
- Raw debug capture 尚未實作，`debugCaptureEnabled` 預設 false；任何 true 設定都以
  `DEBUG_CAPTURE_NOT_IMPLEMENTED` fail closed，不會保存 raw prompt/output。

## 10. 供應鏈

- 鎖定 runtime、package manager 與 dependency versions。
- Lockfile 必須提交並以 frozen 模式安裝。
- 新 dependency 需記錄用途、維護狀態、授權、transitive 影響與替代方案。
- CI actions 使用不可變 commit SHA，不只 tag。
- CI permissions 為 read-only、checkout 不保留 credential、不接受 secrets，並關閉自動 dependency cache 與 install scripts。
- 發布產生 SBOM、checksum、provenance；逐步提升 SLSA level。
- 禁止 install script 在未審查下執行任意 postinstall。
- 定期 dependency、license、malware 與 vulnerability scan。
- 目前 deterministic CycloneDX 1.5 SBOM 與 offline package-snapshot reproduction 已成為 gate；release checksum/provenance 只能在 owner 批准的實際 artifact 階段產生。

## 11. 開源與隱私審查

公開前必須掃描：

- Working tree、staging area、完整 Git history、tags。
- Build output、source maps、archives、screenshots、fixtures、snapshots。
- 使用者名稱、email、本機路徑、私有 URL、repository 名稱、session ID。
- 常見 provider secret 格式與高熵字串。
- GitHub Actions permissions、fork/PR secret exposure 與 release credentials。

若秘密曾進入 Git history，單純刪檔不算修復；必須撤銷秘密、清理 history、重新掃描並通知可能受影響者。

## 12. 安全事件

發現疑似洩漏或未授權執行時：

1. 停止所有 workflow 與網路呼叫。
2. 保存不含秘密的事件時間線。
3. 撤銷受影響 credentials/session。
4. 隔離受影響 workspace 與 artifacts。
5. 判定資料、權限與成本影響範圍。
6. 修復根因並新增 regression test。
7. 完成 post-incident review 後才恢復。
