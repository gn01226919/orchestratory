# MVP 驗證矩陣

本表區分「程式已實作且有本機自動證據」與「需要 owner 額度、外部 runtime 或發布決策」。
`已驗證` 不代表第三方認證或零風險；只代表表列測試在目前 source tree 通過。

| 範圍 | 狀態 | 可重現證據 | 尚待事項 |
|---|---|---|---|
| Fake provider 端到端 loop | 已驗證 | `test/workflow.test.ts` | 無 |
| Planner/Reviewer 唯讀 CLI policy | 已驗證（synthetic） | `test/cli-provider.test.ts`、空白 scratch cwd、built-in tools disabled | Codex/Claude/Grok 真實 prompt smoke test需 owner 批准訂閱額度 |
| Claude live Writer Workspace MCP | 已驗證（synthetic） | `test/workspace-mcp.test.ts`、`test/cli-provider.test.ts`；UTF-8、path/link/type/size、hash、no-clobber、call limits、無 delete | 真實 Claude Code Writer/MCP 相容性與寫入 smoke test需 owner 批准訂閱額度 |
| Codex Writer | Synthetic 已驗證、owner opt-in | read-only sandbox＋Workspace MCP-only write path、capability gate、fallback tests | 真實訂閱 smoke 尚待 owner；Grok/API Writer 仍安全停用 |
| Model selector/discovery | 已實作 | TUI、Web `/api/models`、`orchestrator models list`；`test/provider-registry.test.ts`、`test/web.test.ts` | Grok live `models` discovery 尚未人工驗證 |
| Workflow rounds/parallel reviewers | 已驗證 | `test/workflow.test.ts`、`test/policy.test.ts` | 真實多 provider back-and-forth 需額度批准 |
| Absolute timeout/cancel/process tree | 已驗證 | `test/workflow.test.ts`、`test/process-runner.test.ts`；pre-abort 與 realpath race 均不 spawn、忽略 SIGTERM 的 grandchild 必須在整個 PGID 消失後才回報完成、cleanup deadline 明確失敗 | PGID 快速重用仍有極窄平台競態；不可中斷的 OS/kernel 狀態會阻擋完成 |
| Executable trust boundary | 已驗證（synthetic＋local resolution） | 相對 PATH 拒絕、來源與 symlink target 都須在 compiled trusted roots，root/owner regular executable，directory/file group/other-write deny；`test/process-runner.test.ts` 覆蓋 writable file/dir、外部 symlink、directory executable、relative PATH、untrusted root；本機 node/git/security/codex/claude/grok resolution 通過 | 無法在非 root 測試中合成 foreign-owner 檔；Node pathname spawn 前仍有極窄同 uid TOCTOU |
| Pause/resume | 已驗證 | `test/workflow.test.ts` | Pause 只在安全 workflow boundary 生效，不中斷已開始的 provider call |
| Events/Messages/Diff/Tests/Usage | 已實作 | TUI/Web views、`test/workflow.test.ts`、`test/web.test.ts` | Web 視覺點擊 QA 等待可用 browser instance |
| TUI setup/live dashboard | 已驗證（render＋startup smoke） | `test/terminal-dashboard.test.ts`；deterministic render/status/view/cancel bounds；本機 TTY 啟動後於 project selector 退出 | 真實 provider workflow 的人工終端視覺 QA 仍需 owner 批准額度 |
| 自然語言 session/function tools | 已驗證（synthetic＋startup smoke） | `test/session.test.ts`：固定 tools、strict marker、Claude 唯讀委派、coding-team proposal、RAM/call bounds；TTY 驗證 `/agents`、`/status`、`/new`、`/exit` 且 0 provider calls | 真實 Codex/Claude 回覆仍需 owner 批准額度 |
| Web 對話首頁 | 已驗證（HTTP＋synthetic） | `test/web.test.ts`：chat schema、CSRF/Origin、Codex message、coding-team proposal、reset 與累積 call count | Browser 視覺／點擊 QA 待可用 browser instance |
| Messages 隱私 | 已驗證 | 記憶體 64 KiB/run、終止後 15 分鐘到期、不進 SQLite；`test/workflow.test.ts` | Process crash 時直接遺失是刻意行為 |
| Worktree branch isolation | 已驗證 | `test/worktree-broker.test.ts`、`test/workflow.test.ts` | 不自動 merge/push/delete；真實 retained worktree 清理由 owner 逐次批准 |
| Reviewer changed-file integrity | 已驗證 | `test/git-broker.test.ts`；tracked/untracked content fingerprint、byte/file/context limits | 同帳號惡意並行程序仍有窄 TOCTOU 殘餘風險 |
| Workspace allowlist/path escape | 已驗證 | `test/workspace-policy.test.ts`、`test/workspace.test.ts`、`test/workspace-mcp.test.ts` | Owner 不應 allow 整個 home directory |
| Owner-only JSON configuration preflight | 已驗證（synthetic） | hard limits、API model、tester、workspace roots、retention loaders 共用 `O_NOFOLLOW` descriptor 驗證；owner `0700` directory、regular file、UID、精確 `0600`、single hardlink、1 MiB 上限；table-driven `test/config.test.ts` 覆蓋 symlink/hardlink/permissive file/unsafe directory | Descriptor-based read 已封閉已知 path substitution；同帳號完全失陷不在信任邊界內 |
| Hard-limit absolute ceilings | 已驗證（synthetic） | 11 個 count/time/byte 欄位 positive safe integer、3 個預算欄位正有限數、14 欄逐欄 compiled maximum、timeout/round-call/run-day-month 關係；`test/config.test.ts` 逐欄驗證 maximum+1、fractional count 與關係錯誤 | Ceiling 是災損上限，不是費用批准；任何實際 API 使用仍需 scoped owner approval |
| Owner-only SQLite path／sidecar preflight | 已驗證（synthetic） | 十個 store 共用資料目錄 0700、主檔與 WAL/SHM/journal 0600/owner/regular/single-link 驗證；主檔 `O_EXCL|O_NOFOLLOW` 預建、`DatabaseSync` 前後 inode/device 重驗、首次 WAL 後 sidecar 重驗；table-driven `test/sqlite-security.test.ts` 覆蓋 DB symlink/hardlink/0644、WAL symlink、0755 directory | Node `DatabaseSync` 無 fd constructor，極窄 pathname-open TOCTOU 只能以開啟前後 identity 重驗降低，不能完全消除 |
| Web 新增專案 | 已驗證（HTTP／Browser） | `test/workspace-onboarding.test.ts`、`test/web.test.ts`：原生 picker 注入邊界、手動路徑、canonical Git root、owner/mode/sensitive/broad root、expiry、single-use、精確 phrase、inode/mode race、atomic policy refresh；2026-07-17 Browser 在 4391 驗證正常 Git preview 與 home blocked preview，confirm 皆保持停用、未實際新增測試 root | macOS 原生 picker 的 OS 視窗需 owner 實際點選；瀏覽器或本機 owner 完全失陷不在威脅邊界內 |
| API read-only adapters/budget | 已驗證（mock） | `test/api-provider.test.ts`、`test/store.test.ts`、`test/request.test.ts` | 真實 API key、價格政策與付費 call 均等待 owner 決策；不自動 fallback/top-up |
| Container tester policy | 已驗證（argv/policy） | `test/tester-broker.test.ts`、workflow approval tests | 本機尚無已批准 Docker/Podman runtime 與 digest image，未做真實 container smoke test |
| Checkpoint/restart restore | 已驗證 | `test/store.test.ts`、`test/workflow.test.ts` | Restore 會重新跑 planner/reviewer，可能消耗新額度 |
| SQLite integrity/retention/purge | 已驗證（synthetic＋live read-only） | 十個 stores 均有 bounded busy timeout；`test/store.test.ts` 以跨程序短暫 write lock 驗主 store 等待後成功，`test/maintenance.test.ts`；2026-07-21 對 live daemon 並行 `data inventory`／`data integrity` 皆通過且所有 quick/foreign-key/hash/state checks 有效 | 超過 3–5 秒的 lock 仍 fail closed；不刪除現有 app data，任何實際 purge 等 owner 逐次批准 |
| Raw debug capture | 未實作且 fail closed | `test/config.test.ts` 驗證 true 被拒絕 | 若未來實作，需 opt-in、短 retention、明確清除與新 threat review |
| Web loopback security | 已驗證（HTTP＋Browser） | `test/web.test.ts`：session、CSRF、Origin、Host、CSP、每埠獨立 cookie、未授權／讀取／寫入分桶限流；2026-07-17 Browser 在 127.0.0.1 本機頁面確認直播連線、console 無 error 與無水平溢位 | 不可對外綁定；同一埠仍只允許一個服務實例 |
| Pending workflow request（MCP／Room GUI） | 已驗證 | owner-only SQLite、100 pending ceiling、fixed actor、atomic dedupe、row integrity、single resolution；Room GUI 只接受 room/task/acceptance criteria、workspace 由 room 反查、不呼叫 provider；`test/workflow-request-store.test.ts`、`test/collab-mcp.test.ts`、`test/web.test.ts` | Pending metadata 仍不是 approval，不能直接啟動 Dirty Snapshot/workflow/apply-back |
| Room Codex/Grok PTY join | Codex live smoke 已驗證；Grok 未實測 | fixed provider enum、native read-only flags、no shell/no extra flags、TTY/allowlist/room-state/0600 gate、RAM tail、control stripping/redaction/bounds；`test/room-pty.test.ts`、`test/config.test.ts`；受控 Codex smoke 回覆 bounded marker、exit 0 且 Room hash chain valid | PTY 是混合畫面而非結構化 turn；精確 live message sequence、usage 與專案 metadata 不列入可發布文件，Grok 仍會消耗訂閱額度且未批准實測 |
| MCP terminal presence／GUI membership／wake truthfulness | 已驗證（synthetic＋HTTP＋Browser live smoke） | owner-only SQLite、per-process UUID、canonical workspace exact match、5s heartbeat/15s lease、EOF unregister、terminal-side `room_join_request` 後才列於 GUI、join tool 預設 30s 等待 GUI 核准並直接進入 20s 首輪 exact-seat duty wait、MCP cancellation 傳遞與 stale request 清除、crashed waiter TTL、enqueue-before-wait claim、CSRF/Origin/session guarded owner join、API `active-tool-pull`/`wakeable`/HTTP 202 queued、休班 queued 明示、managed/external name collision deny、交易式 non-reuse alias、專案 basename＋內部 Room ID 選單、跨 Room 全域申請數與常駐工作站／臨時席位分離；`test/room-presence.test.ts`、`test/room-inbox.test.ts`、`test/collab-mcp.test.ts`、`test/collaboration-service.test.ts`、`test/web.test.ts`；2026-07-22 Chrome live smoke 完成精確 Room 的申請、GUI 核准、值班中、exact-seat 收件／回覆與 timeout 後休班，並確認切換其他專案 Room 時該席位不會跨房出現 | MCP 不支援對完全 idle 的既有 host 發起 server-initiated turn；此時 UI 明示不可喚醒並安全排隊，真正不依賴 external pull 的 GUI wake 使用受控即時 Agent。既有已啟動的 MCP child 必須由 host 重開才會載入新 tool schema；Codex/Claude 全域 hook 設定需要 owner 明確安裝 |
| Room mention 等待生命週期 | 已驗證（synthetic＋HTTP＋Browser live smoke） | `room_mention` 在真實 provider call 前追加綁定 mention reference 的「回應處理中」system event；GUI 只對 start 且尚無 reply/failure/cancel/clear 的 mention 顯示等待；backend cancel 不把 start event 誤當 resolved；`room_post` 的 provider-prefixed `@mention` 會 fail closed 並要求 `room_mention`；`test/collab-mcp.test.ts`、`test/web.test.ts`；Browser 驗證歷史 plain-text mention 重載後不再顯示幽靈等待 | 這是 append-only UI 狀態修正，不刪除、改寫或偽造既有帳本訊息；舊版進行中但未留 start event 的呼叫在重載後不顯示等待，但 provider timeout/failure 仍會正常入帳 |
| MCP 精確席位收件匣 | 已驗證（synthetic＋跨程序） | `queued→delivered→read→working→replied/failed/cancelled`、`room_wait/ack/reply/fail`、私有 lease token、斷線不誤耗重試、已讀後 bounded retry、取消、離線 fail、idempotent crash recovery、無 provider fallback；`test/room-inbox.test.ts`、`test/collab-mcp.test.ts`、`test/collaboration-service.test.ts` | 真實外接 CLI 必須自行持續呼叫 bounded `room_wait`；在線但未 wait 時 GUI 只標示未值班，不宣稱即時喚醒 |
| Writer Lease／Writer Companion／子 Agent | 已驗證（synthetic＋跨程序 Workspace MCP＋Chrome live smoke） | resident/managed/external 可選 Writer、task-scoped monotonic epoch、checkpoint 交接、精確 GUI cancel、外接 Writer 雙重身份、HMAC technical audit、每次 mutation 重新 fencing；同 provider 子 Agent 與父 Writer 共用 task worktree 並由跨程序鎖序列執行，跨 provider 唯讀、禁止再轉派、父 lease 切換即撤銷；第二個 GUI 保留仍有 heartbeat 的 live run，只撤銷沒有活鎖且 capability 無法恢復的 lease；`test/writer-lease.test.ts`、`test/writer-delegation.test.ts`、`test/collaboration-audit.test.ts`、`test/workspace-mcp.test.ts`、`test/collaboration-service.test.ts`、`test/web.test.ts`；2026-07-22 Chrome 對 resident Codex 完成 grant、實際 provider 回覆、checkpoint、風險確認與零變更 apply-back，帳本有 Writer lifecycle 且主工作樹保持乾淨 | 寫入 capability 只在啟動該 run 的 daemon RAM；其他 GUI 不能取得或冒用。真實非零檔案 mutation／apply-back 與 child executor 點擊仍需獨立、可回復的人工驗收 |
| Room 受控即時 Agents | 已驗證（synthetic＋HTTP＋Claude live smoke） | 外接終端與受控即時席位分離；API 明示 `managed-provider-call`/`wakeable: true`；owner-only `managed-room-agents.sqlite`、0600、strict schema、row hash、每房 12 席上限、room/workspace exact binding、獨立 display identity、per-seat single in-flight/cancel、共用 provider quota、read-only prompt；`test/managed-room-agent.test.ts`、`test/web.test.ts` 驗證建立、列出、獨立作者回覆與移除；受控 Claude live smoke 以同一 managed seat identity 回覆後成功移除，精確訊息 metadata 不列入可發布文件 | 每次喚醒目前是注入有界帳本尾段的無狀態 provider turn，不保證 provider-native session continuity；不得冒充既有外接 CLI session |
| Room GUI 導航、歷史、辦公室與 Writer 交辦 | 已驗證（HTTP／程式層／Browser） | 首頁整塊可點擊直播／歷史入口、room id URL 保留、最新起算每頁 100 則向前分頁與 allowlist；四個可點擊工位、環境光、桌面細節、Orbie 瞳孔／表情與六種固定休閒活動。2026-07-17 Browser 在 4391 驗證：點 Codex 只預填 `@codex` 並顯示內嵌 Agent 卡、歷史 backlog 不誤報新通知、任務中心只讀、日夜／安靜／休閒／全螢幕 fallback 可切換，1440×753 無水平溢位；Miso 四足與 Byte 雙足在 190ms 前後所有取樣 limb/body transforms 均改變、近遠腳反相，角色在地板範圍內且 console 無錯；真實工作 DND、目前角色、完成／失敗動畫由 `test/web.test.ts` 的 HTML／JS／CSS contract 覆蓋；Writer 面板的候選、grant/switch/run/cancel/complete 與 child executor 路由由 HTTP 整合測試覆蓋；2026-07-22 Chrome 實際點擊 Writer grant、run、checkpoint、complete 與零變更 apply-back | child executor 與非零檔案 apply-back 尚未做 Browser live smoke；寵物、休閒與顯示偏好只操作目前 DOM／RAM；真實 provider workflow 未為視覺動畫額外啟動 |
| Room macOS composer 鍵盤操作 | 已驗證（程式層／HTTP static contract＋Chrome double-enter） | 帳本直播與辦公室 textarea 共用 `installMacComposerKeyboard`；Enter 第一次保留換行、1.6s 內第二次送出；Shift/Option 換行、Command+Enter 立即送出；IME composition/229、repeat、內容／caret 變化、blur、disabled submit 防誤送；`test/web.test.ts` 覆蓋 HTML/JS contract；2026-07-22 Chrome 實測第一次 Enter 保留內容並新增換行、第二次 Enter 送出且只新增一則帳本訊息；macOS 當下已選取真實注音輸入來源，但自動化注音鍵序仍以 Latin 字元抵達 textarea，證明控制層繞過系統 text-input service | 仍需 owner 直接操作實際中文 IME 驗收 composition Enter；不得以 DOM 合成 composition event 或自動化文字注入冒充通過。可視鍵盤、語音輸入與 assistive technology 可繼續使用送出按鈕 |
| Dirty Snapshot | 已驗證（synthetic） | RAM-only/TTL/pending ceiling、text/path/link/mode/size/hash/source race、獨立 approval、只匯入 worktree；`test/dirty-snapshot-broker.test.ts`、`test/workflow.test.ts`、`test/web.test.ts` | 未對真實專案執行；daemon 已於 2026-07-17 重載並監聽 127.0.0.1:4317 |
| Apply-back | 已驗證（synthetic＋HTTP） | preview hash、source/worktree HEAD＋fingerprint、逐檔 CAS、短效 single-use approval、rollback、刪除移到 trash-pending；`test/apply-back-broker.test.ts`、`test/web.test.ts` | 多檔案仍有 OS/磁碟故障造成 rollback 也失敗的殘餘風險；會明確記錄 `APPLY_BACK_PARTIAL_ROLLBACK_FAILED` |
| Supply chain/release gate | 已驗證（未發布 tree） | `npm run check:release`、SBOM、audit、secret/history scan、offline committed-HEAD clean clone；tracked package allowlist 排除 test/non-runtime scripts/CI/Agent instructions，pinned TS-to-JS build 產生 runtime-only tgz，離線安裝後驗 `.bin` link/mode、全 JS/MJS syntax、CLI startup 與正負向 audit smoke；候選 artifact 以 `O_NOFOLLOW` descriptor 寫入 owner-only `dist/release`，symlink/hardlink/oversize/mode collision 負向測試通過 | artifact signing/provenance 需先有 owner 批准的 release |
| GitHub 開源發布 | 未批准 | release checklist 保持 NO-GO | 名稱、license、Git identity、remote、visibility、commit/push/release 均待 owner 決策 |

## 目前自動證據

- 274/274 deterministic tests。
- 最新最終 gate：line 94.98%、branch 85.06%、functions 96.82%；gate 分別為 90%、85%、90%。
- 測試不使用真實 credentials、真實私人 repository、模型額度或付費 API。
- CycloneDX SBOM 為 3 components，SHA-256 `259a893bfb419dda2e7a61691ea3f89f5a1e133ee32eac83d308e4113c8fde6c`。
- 完整 npm dependency audit（含 dev toolchain）0 vulnerabilities；offline committed-HEAD clean clone與
  86-file tracked-allowlist runtime tgz build／安裝／bin／audit reproduction 均通過；local/history scan 已覆蓋目前完整 history。

## 不需 owner 批准即可重跑

```text
npm run typecheck
npm run check:syntax
npm run test:coverage
npm run check:release
```

Loopback Web test 在受限 sandbox 中可能需要允許本機 `127.0.0.1` listen；這不代表允許外網、
provider call 或使用者資料修改。
