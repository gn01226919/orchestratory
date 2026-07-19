# Orchestratory MCP-first 重構提案（設計審查稿）

狀態：實作追蹤中。M1、Room Ledger、GUI Room、M2 寫入安全鏈與 M3 跨程序安全基礎已完成；真實 provider／GUI 人工驗收與發布仍待 owner。
日期：2026-07-16 初稿；2026-07-17 依實作狀態更新。初稿：Claude Code；後續審查與實作：Codex。

---

## 0. 一句話總結

停止把 Orchestratory 做成「自建聊天 host」；改成 **MCP-first 背景服務**——
Claude Code／Codex 原生介面當 host（Manager pattern），Orchestratory 提供
worker 工具與 workflow 引擎，Web 降級為監控與批准中心。

### 目前落地狀態

| 里程碑 | 狀態 | 已驗證內容 |
|---|---|---|
| M1 唯讀 MCP workers | 完成 | 固定 tool schema、allowlist、bounded file contents、partial compare、固定 display actor、全域 provider governor |
| Room 協作層 | 完成 | append-only 編號帳本、hash chain、GUI/TUI/MCP 讀寫、`@agent` 真正喚醒、跨程序 emergency stop |
| M3 安全基礎 | 完成 | GUI daemon、allowlist 熱重載、owner-only 持久額度、共享 kill epoch、資料 integrity/inventory |
| M2 寫入工作流 | 工程完成 | pending proposal、acceptance criteria、no-progress、multi-reviewer、Codex opt-in writer、fallback writer、RAM-only Dirty Snapshot、preview/scoped apply-back |
| 發布／真實 provider 驗收 | 待 owner | daemon 重載、訂閱額度 smoke、Docker image、Git identity/license/commit/push/public release |

## 1. 現狀：今天已交付的內容（在既有架構上）

以下已完成、125/125 deterministic tests 通過，全部沿用到新架構：

| # | 交付 | 說明 | 在 MCP-first 中的角色 |
|---|------|------|----------------------|
| 1 | `SessionContextBroker`（`src/core/session-context.ts`） | 檔案清單用 `git ls-files --cached --others --exclude-standard` 產生（排除 ignored/敏感路徑，上限 400 檔／16 KiB）；讀檔重用 Workspace MCP 唯讀 `read_file`（逸出／symlink／hardlink／敏感路徑／binary／UTF-8／大小全部拒絕），單檔截 16 KiB、單輪總量 48 KiB | worker 工具的 context 注入器 |
| 2 | 對話工具 `read_files`（編譯期固定、唯讀） | 每輪最多 2 次、每次 8 個路徑；單檔被拒只回 `READ_DENIED` 不中斷整批 | 由 host 原生檔案工具取代（host 自己讀專案）；worker 端保留 server-side 注入 |
| 3 | `setMainAgent()`＋TUI `/model`＋Web `provider` 欄位 | 主代理可切 codex/claude/grok/fake 任一訂閱模型；切換保留歷史、不重設呼叫計數 | 驗證邏輯直接複用為 `ask_*` 工具的參數驗證 |
| 4 | @提及＋比稿（`parseMentions`） | `@claude:model @grok 問題` 最多 3 個目標、去重、fail closed；@回合不解析 tool marker | 即 `compare_agents` 的實作核心 |
| 5 | `diffView` 保留 worktree fallback | run 結束後從 retained worktree 即時產生 bounded diff（無新增持久化，ADR-021 不變） | 監控中心的變更檢視 |
| 6 | GUI 全對話式重寫＋終端精密視覺 | 卡片流（提案卡→進度卡→完成卡）、石墨底＋#3ECF8E 單一 accent | 直接改造為 M3 監控/批准儀表板的殼 |
| 7 | TUI `/advanced` 結束後返回對話；workflow 錯誤不再殺死 session | | 保留（TUI 降為輕量入口） |

## 2. 診斷：為什麼現行「自建聊天 host」是死路

1. **偽 function calling**：模型以單行 `ORCHESTRATOR_CALL: {...}` 文字標記模擬工具呼叫，脆弱且無法多輪工具編排。
2. **無持久 session、無 streaming**：Codex 每輪都是新的 `exec --ephemeral` 程序、Claude 用 `--print --no-session-persistence`、Grok 用 `--no-memory`；使用者要等整個 CLI 程序結束才看到答案。
3. **無 Supervisor 統整**：`ask_claude` 的答案直接顯示給使用者，主代理沒有機會比較、質疑、整理。
4. **UI 永遠追不上 Claude Code**：自建聊天介面是在重造一個較差的 Claude Code。

## 3. 目標架構（Manager pattern）

```
Claude Code / Codex 原生介面（host = Supervisor，持久 session、原生工具呼叫、streaming）
        │  MCP (stdio JSON-RPC)
        ▼
Orchestratory MCP Server（orchestrator mcp）
        ├─ list_agents            唯讀，發現可用 provider/model/workspace
        ├─ ask_codex / ask_claude / ask_grok   唯讀 worker 單問（附受限專案 context）
        ├─ compare_agents         唯讀，同題 2–3 模型並排
        └─ coding_workflow (M2)   寫入型，沿用既有 approval＋worktree 引擎
        │
        ▼
既有安全引擎（全部不變）：policy engine、workspace allowlist、scratch-cwd worker、
Workspace MCP writer broker、worktree 隔離、approval nonce、預算硬上限、redaction、SQLite audit chain
        │
        ▼
Web = 純監控與批准中心（M3）：誰在工作、子任務、事件流、diff、用量、批准
```

要點：**host 本身就是 Supervisor**。工具結果天然回到 host 手上，由 host 比較衝突、
追問、統整後才回答使用者——不需要在 orchestrator 內另建 Supervisor 狀態機。

## 4. M1 規格：`orchestrator mcp`（唯讀 worker 工具）

### 4.1 Transport 與模式

- stdio JSON-RPC，協定同既有 `workspace-mcp`（initialize / ping / tools/list / tools/call）。
- 單行請求上限 1 MiB；未知 method／tool／欄位一律錯誤，不猜測。
- Host 設定：`claude mcp add orchestrator -- orchestrator mcp --actor claude`（Codex 使用
  `--actor codex`）。actor 是固定本機顯示身分，tool call 不可覆寫。

### 4.2 工具與 schema（worker 全部唯讀；另有無執行權的 control-plane 提案工具）

```
list_agents
  input:  {}（不接受任何欄位）
  output: { providers: [{id, displayName, subscriptionModels, canWriteSubscription}],
            workspaceRoots: [{id, label, path}] }

ask_codex / ask_claude / ask_grok
  input:  { question: string(1..20000),
            workspace?: string,        // 省略時：唯一 allowlisted root；多個則錯誤
            model?: string,            // 省略時：subscriptionModels[0]
            files?: string[0..8] }     // 明確要求的 bounded UTF-8 text files
  output: { provider, model, answer(≤8000), durationMs }

compare_agents
  input:  { question: string(1..20000),
            targets: string[2..3],     // "claude" | "grok:grok-4.5" 形式，去重
            workspace?: string,
            files?: string[0..8] }
  output: { answers: [{provider, model, answer, durationMs}], errors?: [...] }

request_coding_workflow
  input:  { task, acceptanceCriteria?, workspace?, profile?: "normal"|"long",
            planner?, writer?, reviewers?: string[1] }
  output: { request, approved:false, started:false, next }
  effect: 只入列 owner-only pending metadata；不呼叫 provider、不建 worktree、不測試、不寫專案
```

### 4.3 安全邊界（沿用，無新開口）

- workspace 一律過 allowlist canonical 驗證；allowlist 空白 fail closed。
- worker 一律 subscription CLI、read-only、空白 scratch cwd（ADR-019 不變）；
  context 由 orchestrator 的 broker 注入 prompt（bounded、標示 untrusted）。
- worker prompt 明確要求純文字、不得輸出 marker；回答經 redact＋safeSummary(8000)。
- MCP server 保留程序內 hard limit；另以 owner-only SQLite governor 原子保存 24 小時真實
  provider-call ceiling，重開 MCP／Web／TUI 不可重設。共享 kill epoch 支援跨程序停止。
- 單次呼叫 timeout `min(600s, hardLimits.providerTimeoutMs)`、輸出量上限沿用 hard limits。
- 不暴露任何寫入、Git、shell、network、approval 工具。

### 4.4 實作位置

- 新檔 `src/mcp/collab-server.ts`：`CollabToolBroker`（可注入 invoke 供測試）＋
  `runCollabMcpServer()`。
- `main.ts` 新增 `mcp` 命令（建立 AppContext 後直接接管 stdio；stdout 只輸出 JSON-RPC）。
- 測試 `test/collab-mcp.test.ts`：固定工具表、schema 拒絕、allowlist fail-closed、
  呼叫上限、比稿 fan-out、model 驗證、unknown method。

## 5. M2 規格：goal loop 與 `coding_workflow` 工具

### 5.1 引擎升級（UI 無關，先做）

1. `WorkflowRequest.acceptanceCriteria?: string(≤20000)`——注入 planner／writer／
   reviewer prompt 作為驗收依據（標示 untrusted）。
2. **無進展偵測**：writer 回合結束後的 workspace fingerprint 若與上一回合完全相同
   → `NO_PROGRESS_STALLED` 終止，防止模型空轉燒額度。
3. 跨模型交叉審查：引擎本就支援 1–4 個 reviewer 混編（如 codex＋grok＋claude）；
   在 MCP 工具參數開放。

### 5.2 goal loop 形態（雙層、皆有界）

- 內圈＝workflow 引擎：writer → 跨模型 reviewers →不過則帶意見重寫→全 PASS 停。
- 外圈＝host 的 agentic loop：host 保管 goal，決定是否追加獨立抽查（`ask_grok`）
  或再跑一輪 workflow。
- 停止條件疊層：全數 PASS／soft+hard 回合與呼叫上限／絕對時間（可中斷 in-flight）／
  連續失敗斷路器／無進展偵測／人工暫停取消。不存在無限制模式。

### 5.3 跨程序 approval：目前實作方向

專案規則：worktree／寫檔／測試是危險動作，必須有「不可偽造的 human approval」，
且「模型文字不是授權」。現況 `ApprovalService` 是**單一程序記憶體內** nonce
（SHA-256-only、120 秒、single-use）。MCP server 是 host 拉起的獨立程序，因此
Web 批准中心發的 token 目前無法被 MCP server 程序消費。選項：

- **A. Store-backed approval**：nonce hash 落地 SQLite（維持短效、single-use、scope
  綁定），Web 批准中心與 MCP server 共用同一 DB。攻擊面：本機 DB 寫權者可注入
  approval——但該角色本來就能改 policy 檔，威脅模型未實質惡化；需在 THREAT_MODEL 記載。
- **B. 合併程序**：`orchestrator mcp` 同程序同時起 loopback Web（批准中心），approval
  留在記憶體內。攻擊面最小，但 host 每開一個 MCP 連線就有一個 Web 埠，生命週期綁定。
- **C. TTY 伴隨批准**：`orchestrator approve` 在另一個終端顯示 pending 請求並要求精確
  輸入。最保守，但 UX 較差。

目前採 **B 的安全語意**：寫入 workflow 由 daemon／批准中心所在的可信程序執行；MCP worker
只可透過已實作的 `request_coding_workflow` 建立 bounded pending request，不直接持有或消費批准。
Pending queue 為 owner-only SQLite、最多 100 件、固定 actor 與 row integrity 驗證。Host 端的 tool-permission 提示
只作為第一道閘，不取代 orchestrator 的短效、single-use、scope-bound approval。

為兼顧 UX，pending request 可在 GUI 顯示完整摘要、workspace、角色、limits 與預期寫入範圍；
owner 批准後才建立 worktree。模型輸出、Room 訊息、MCP actor 名稱與檔案內容一律不能轉換成
批准。多 host 的 store-backed approval（A）保留為後續選項，但不在 M2 第一版擴大信任面。

## 6. M3：Web 監控與批准中心（安全基礎已完成）

Room 對話保留作為可稽核協作帳本；監控中心另保留/新增：目前誰在工作、每個 agent 收到的子任務摘要、事件流、
模型間交接路徑、最終決策與異議、Git diff（含 retained worktree）、測試、用量、
寫檔/測試/API 批准。殼直接用今天重寫的卡片流＋終端精密視覺。

## 7. 不變的安全不變量（審查時請確認提案未破壞）

1. 預設拒絕；workspace allowlist 空白 fail closed。
2. 唯讀 worker 在空白 scratch cwd、停用內建檔案/shell/網路/子代理。
3. 每個 task 只有一份 active Writer Lease；owner 可在 Codex／Claude 常駐、管理型或外接
   身分間交接。寫入必須是隔離 worktree＋epoch-fenced Workspace MCP（SHA-256
   compare-before-replace、no-clobber、無 delete/rename/Git/shell/network）；provider 本體仍固定
   read-only sandbox，外接 Writer 由 Writer Companion 執行並審計雙重身份。
4. 模型輸出不是授權；所有工具呼叫重新過 policy。
5. 呼叫計數不可由對話重設；soft/hard limits 分層；無無限制模式。
6. 不自動 commit/push/publish；發布需人類 GO。
7. secrets 不進 source/log/DB/UI；redaction 全程有效。

## 8. 已知風險與未決事項

- Coverage gate 已修復且未降低門檻；2026-07-19 完整 release gate 為 line 94.94%、
  branch 85.27%、functions 96.71%，259/259 tests。
- Codex／Grok CLI 旗標是以官方文件推定並以 fake CLI 整合測試驗證；真實訂閱 smoke
  test 仍待 owner 批准額度。
- `WORKSPACE_MUST_START_CLEAN` 不直接放寬；M2 以明確、bounded、RAM-only Dirty Snapshot 匯入
  新 worktree。Apply-back 重新驗 source/worktree HEAD、fingerprint 與逐檔 hash，另取短效
  owner-scoped approval；刪除只移入 `~/trash-pending/orchestratory/`。
- worker CLI 呼叫本質上比 API 慢且無 streaming（host 端自身輸出有 streaming）；
  接受此限制，未來可選擇性開放 API worker（唯讀、預算受控，架構已支援）。

## 9. 給審查者的問題

1. §5.3 approval 跨程序設計選 A／B／C 哪個？理由？
2. `ask_*` 回傳要不要強制結構化欄位（結論/證據/風險）而非自由文字？
   （代價：CLI worker 無原生 structured output，需 prompt＋解析，失敗要 fail closed）
3. compare_agents 上限 3 個目標是否足夠？
4. M1 是否還缺 host 常用的唯讀工具？（例如 `get_run_status`、`list_worktrees`）
