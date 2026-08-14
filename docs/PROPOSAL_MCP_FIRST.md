# Orchestratory MCP-first Native Full-Trust 規格

狀態：**Accepted design / exact-seat phase implemented in development source; live acceptance pending**

更新：2026-08-01

依據：`OWNER_DECISION_FULL_CONTROL.md`、ADR-028

本版取代原本「MCP 只提供唯讀 worker、terminal 只能由 GUI 單向交辦」的提案。既有 `ask_*` worker
可保留，但不得冒充 live terminal-to-terminal collaboration。

## 0A. Supervisor 與 MCP 邊界

每小時督導由本機 `scripts/supervisor-audit.mjs` 執行；Git 使用 bounded read process，Room 與 SQLite
store 使用 read-only/query-only connection，因此不透過一般 runtime 觸發 migration/recovery。它不是
MCP seat、不讀 HMAC key、不得偽造 sender identity、不得寫 Room ledger，也不會把模型回答當成 Owner 決策。launchd 範本
只負責排程；若未來要派遣 Claude/Codex，必須另有明確 provider、quota、identity 與 failure policy，
因此目前保持停用。

## 1. 一句話總結

Codex／Claude Code 原生 TUI 是具完整能力的 Supervisor／Worker；Orchestratory MCP 提供 exact-seat
即時協作、Room Ledger、candidate 任務狀態與 main merge decision，而不是限制原生 coding tools。

## 2. 目前 runtime 與目標差距

目前已完成：Room membership、standby approval、`room_wait`、ack/reply/fail、Room Ledger、read-only
`ask_*` workers，以及 development branch 上的 exact terminal discovery、authenticated `room_send`、
delivery-scoped `room_await_reply`、thread metadata、source identity 與 v3→v4 inbox migration。這一批已通過
synthetic/cross-process tests，但尚未切換已安裝 MCP，也尚未完成兩個真實 host 的人工驗收。

目前尚未完成：

- 真實 Codex／Claude Code terminal-to-terminal live acceptance；
- `room_reply_and_wait`／thread cancel 等 convenience tools；
- candidate task lifecycle 與 completion checkpoint；
- 任務完成後主動產生「是否 merge main」詢問；
- snapshot-bound promotion approval、main drift、recovery 與 verify。

MCP `tools/list` 只能列出 development runtime 已實作的工具；下列標示 deferred 的 convenience 工具
不得提前宣稱可用。

## 3. 身分與共同欄位

每個 MCP session 建立 server-bound `presenceId`，工具 payload 不能指定 sender。共同 identity：

```ts
type Seat = {
  seatId: string;
  presenceId: string;
  displayName: string;
  kind: "native-terminal" | "managed" | "provider-worker";
  provider?: string;
  room: string;
  workspace: string;
  wakeable: boolean;
  capabilitySource: "native-host" | "gui-managed" | "worker-profile";
};
```

`native-host` 代表 Orchestratory 保留 host 原本能力；它不代表 server 授予整台 Mac 權限。

## 4. 席位與 peer thread 工具

### `list_agents`（擴充）

```ts
input: {}
output: {
  providers: ProviderWorker[];
  terminalSeats: Seat[];
  workspaceRoots: WorkspaceRef[];
}
```

`providers` 與 `terminalSeats` 必須分開，避免把新 worker 當成既有終端。目前輸出只包含 same Room
已加入席位的 bounded public identity、standby/wakeable 與 self；不包含 PID、stdio 或 provider session。

### `room_list_seats`（deferred convenience）

```ts
input: { room?: string }
output: { room: string; self: Seat; seats: Seat[] }
```

- 只列出目前 session 已加入之 Room 的可見席位。
- 不回傳私有 lease、stdio/process、provider session 或 host secrets。

### `room_send`（已實作）

```ts
input: {
  targetPresenceId: string;
  text: string;
  clientRequestId: string;
  threadId?: string;
  replyToDeliveryId?: string;
  taskId?: string;
  waitForReplyMs?: number;
}
output: {
  message: RoomMessage;
  delivery: RoomDelivery;
  target: { id: string; provider: string; displayName: string };
  dispatch: { wakeable: boolean; immediate: boolean };
  replyWait?: { timeout: boolean; delivery?: RoomDelivery; reply?: RoomMessage };
}
```

- `sourceSeatId` 只由 server 從 authenticated presence 產生。
- 驗證 same Room、canonical workspace 與 membership。
- Target 不 wakeable 時可以 queued，但不得 fallback 到 provider worker。
- 每個 logical send 使用穩定 UUID `clientRequestId`；同一 authenticated presence 且 source/target route
  仍有效時，transport retry 會取回同一 ledger message／delivery；相同 key 若改 payload、target、thread
  或 task 必須拒絕。
  MCP host 完全退出後的跨 presence orphan recovery 尚待 stable seat identity／durable outbox 階段。
- 新 thread ID 由 server 產生；延續既有 thread 必須同時引用 `threadId` 與該 thread 的
  `replyToDeliveryId`，participants 與 task 不得中途替換。

### `room_wait`

保留既有收件語意，但 delivery 增加 source seat、thread、task 與引用欄位；candidate lifecycle 已讓
UUID task ID 在 send 時重驗 Candidate Registry 的 Room／workspace scope。Transport timeout
只結束本次 long-poll，不結束 thread；session-scoped standby 核准持續到撤銷、session EOF 或 lease
失效，不應要求每個對話回合重新經 GUI 核准。

### `room_await_reply`（已實作）

```ts
input: { deliveryId: string; timeoutMs?: number }
output: { timeout: boolean; delivery?: RoomDelivery; reply?: RoomMessage }
```

- 只能等待 `sourcePresenceId` 等於呼叫者 authenticated presence 的 delivery；其他席位即使知道 ID 也拒絕。
- `timeoutMs` 有 transport 上限；沒有 thread round ceiling。

### `room_reply`

擴充既有工具，使 reply 綁定 authenticated seat 與 thread；重試維持 idempotent。Immutable reply prepare
是 reply／cancel 的線性化點：prepare 前已觀察到 cancel 則不得寫 ledger；prepare 後 reply 勝出並必須
完成 receipt，避免 ledger orphan。若 process 在 prepare 後、delivery receipt 尚未確定時失聯，lease expiry
先 fail closed 為 `REPLY_COMMIT_UNCERTAIN`；`room_await_reply`／原 responder retry 只有在 durable ledger
idempotency receipt 的 key、Room、author 精確吻合時可正向 reconcile 為 replied。沒有 receipt 時不得用
一般 retry 猜測性重播。

### `room_reply_and_wait`（deferred convenience）

```ts
input: {
  deliveryId: string;
  message: string;
  timeoutMs?: number;
}
output: {
  reply: ThreadMessage;
  next: ThreadMessage[];
  timedOut: boolean;
}
```

原子完成本輪回覆並繼續等待同 thread，減少協作摩擦。它不增加或削弱 host coding 能力。

### `room_cancel_thread`（deferred convenience）

```ts
input: { threadId: string; reason?: string }
output: { threadId: string; state: "cancelled" }
```

Owner 或 thread participant 可停止協作；不得因達到固定往返數自動取消。

## 5. Candidate 任務工具

### `candidate_start`（已實作）

```ts
input: {
  room?: string;
  task: string;
  acceptanceCriteria?: string;
  mainPath: string;
}
output: {
  taskId: string;
  candidateId: string;
  candidatePath: string;
  mainPath: string;
  baseMainHead: string;
  status: "active";
}
```

建立 candidate、inventory 與 recovery metadata。此工具不限制 Native Agent 對其他路徑的原生存取。
它會新增 shared Git branch/worktree metadata，但不改 canonical main branch/worktree。

### `candidate_checkpoint`（已實作）

```ts
input: { taskId: string; summary: string }
output: { checkpointId: string; candidateHead: string; createdAt: string }
```

### `candidate_complete`（已實作；promotion 由獨立 Owner action 執行）

```ts
input: {
  taskId: string;
  summary: string;
  tests?: TestResult[];
  knownRisks?: string[];
}
output: {
  completionId: string;
  candidateHead: string;
  mainHead: string;
  preview: MergePreview;
  mergeDecision: "owner-required";
  next: "Ask the owner whether to merge this candidate into main";
}
```

完成時必須凍結 preview 並主動讓 GUI/TUI 詢問是否 merge；不自動 promotion。

`candidate_start`／`candidate_checkpoint`／`candidate_complete` 均**要求** stable UUID `clientRequestId`，
每個邏輯呼叫一組、重試時必須沿用完全相同的值。若 stdio／transport 回應不確定，Agent 直接以同一組
`clientRequestId` 重送即可：同 key 同 digest 會回傳同一個結果，不會建立第二個 candidate、checkpoint ref
或 completion。同 key 搭配不同 operation、room 或 input 會以 `CANDIDATE_REQUEST_IDEMPOTENCY_CONFLICT`
fail closed 且不執行任何 mutation。

識別碼（taskId／candidateId／checkpointId／completionId）在 reserve 階段即鑄造並持久化，程序在 mutation
中途崩潰後的重試會沿用同一組識別碼而收斂；答案一律從 durable state 重建，而非回放快取的 payload。
`candidate_status` 仍是查詢與稽核入口，但不再是重試前的必要步驟。canonical main branch/worktree 在上述
任何路徑都不會被覆寫。

重試時可能遇到下列狀態碼，每一個都有明確的下一步：

| 狀態碼 | 意義 | 下一步 |
|---|---|---|
| `CANDIDATE_REQUEST_IN_FLIGHT` | 同一把 key **此刻正在執行**。由記憶體內精確鎖判定，非時間窗。 | 稍候以**同一把 key** 重試 |
| `CANDIDATE_REQUEST_RECOVERING` | 先前嘗試留下半建立的 candidate，仍在 `CREATING_RECOVERY_GRACE_MS`（5 分鐘）回收寬限內，或其建立者程序仍存活。**這一項由 wall clock 與建立者的 pid liveness 共同決定**，與記憶體鎖無關；等待是有界的，且寬限過後同一把 key 會收斂到原本那個 candidate，不需要鑄新 key。 | 稍後以同一把 key 重試；若之後回 `FAILED_RETRY_WITH_NEW_KEY` 則改鑄新 key |
| `CANDIDATE_REQUEST_FAILED_RETRY_WITH_NEW_KEY` | 該 key 的嘗試已被判定失敗。 | **鑄造新的 `clientRequestId`**，不要對舊 key 重試 |
| `CANDIDATE_REQUEST_TASK_NO_LONGER_ACTIVE` | 這把 key 建立的 task 已離開 `active`（已完成／已處置）。 | 改呼叫 `candidate_status`，不要重試 |
| `CANDIDATE_REQUEST_RECEIPT_MISSING` | ledger 記為成功但 durable artifact 不存在。 | 呼叫 `candidate_status` 釐清後鑄新 key |
| `CANDIDATE_REQUEST_ROW_TAMPERED` | 該列完整性驗證失敗，只毒化這把 key。 | 鑄造新 key；其他 key 不受影響 |
| `CANDIDATE_REQUEST_IDEMPOTENCY_CONFLICT` | 同 key 但 operation／room／input 不同。 | 檢查呼叫端邏輯；未執行任何 mutation |

跨程序併發另有兩點須知：每個 MCP seat 是獨立 OS process，記憶體鎖只涵蓋自己那一個；跨 process 的同 key
競賽由 reservation 的不透明 `owner_token` 擋下（不從時鐘推導，且**每一個帳本寫入都必須帶 token**），輸家收到的可能是下游儲存層的原始錯誤訊息而非上述穩定碼。**未列於上表的錯誤一律不要盲目重試——先呼叫 `candidate_status` 確認真實狀態。**

本次呼叫自己建立、且未產生任何 durable artifact 就中止的嘗試（例如 candidate worktree 不 clean）會刪除該
保留，因此同一把 key 可以立即重用。**採用他人保留的嘗試不適用**：該保留可能已擁有 candidate row、worktree
或 recovery ref，因此即使當次沒產生成果也會留下 `pending` 列。recovery ref 建立失敗會記為 `failed`，即使當次
沒有產生任何成果。`CANDIDATE_REQUEST_RECOVERING` 與 `CANDIDATE_REQUEST_TASK_NO_LONGER_ACTIVE` 只由
`candidate_start` 產生。

帳本沒有 TTL 也沒有 prune：每一筆已結算的請求都保留該列，好讓遲到的重試仍能被回答。成長由合法呼叫量決定
（格式錯誤或未知 taskId 不會增長帳本），並由 `inventory()` 的 `requests`／`requestsPending` 曝露。

**Key 的範圍是 room，不是 seat。** `client_request_id` 單獨作為主鍵，`actor` 只記錄不參與比對。這是刻意的：
presence lease 逾時後重連會重鑄 seat display name，若把它放進 key，斷線重連後的重試——也就是這個機制唯一
存在的理由——反而會鑄出第二個 candidate。殘餘風險是同一 Room 內若有席位取得他人的 `clientRequestId`，
可觸發一次 replay 並看到同一份結果；Room 成員資格本身即為授權邊界，且 replay 只能取回與原請求完全相同的
內容，無法變更任何狀態。

### `candidate_status`（已實作）

目前列出 active/completed 狀態、checkpoint、live HEAD/dirty、completion stale 與 branch recovery
readiness；merged/rejected/retained 與更完整的 Agent branch/thread 呈現由 promotion/GUI 階段補齊。

## 6. Main merge 工具

### `main_merge_preview`（已實作）

```ts
input: { taskId: string; room?: string }
output: {
  taskId: string;
  completionId: string;
  previewDigest: string;
  preview: CandidateCompletionPreview;   // 與 candidate_complete 完全同型
  recoveryRef: string;
  approvable: boolean;
  blockers: string[];                    // PREVIEW_FILES_TRUNCATED / PREVIEW_SUBMODULES_TRUNCATED /
                                         // PREVIEW_MERGE_CONFLICTS_TRUNCATED / MERGE_CONFLICTS_PRESENT
  confirmationPhrase: "MERGE INTO MAIN";
  prompt: string;
  mainMutation: false;
  sharedGitMetadataMutation: false;
}
```

**唯讀。** 它不建立 approval、不寫 Git ref、不碰任何 worktree，只從 live state 重算整份 snapshot。
`prompt` 明確說明即將修改 canonical main、綁定值、復原點，並詢問 Owner 是否同意該精確快照。

不可核准的原因以 `blockers` 回報而非丟出錯誤：Owner 必須**看得到**衝突路徑才知道為什麼不能核准。
結構性問題仍然是錯誤：`MAIN_MERGE_CANDIDATE_NOT_COMPLETED`、`MAIN_MERGE_CANDIDATE_HEAD_CHANGED`
（candidate 走過自己的 completion，該 completion 的 recovery ref 已不指向現在的 HEAD）、
`MAIN_MERGE_CANDIDATE_WORKTREE_DIRTY`、`MAIN_MERGE_RECOVERY_POINT_MISSING`、
`CANDIDATE_MERGE_PREVIEW_UNAVAILABLE`。

### `main_merge_request`（已實作）

```ts
input: {
  clientRequestId: string;   // stable UUID，重試必須重用
  taskId: string;
  completionId: string;
  previewDigest: string;     // 必須是剛剛給 Owner 看過的那一份
  room?: string;
}
output: {
  approval: MergeApproval;   // state: "requested"，無 token
  approved: false;
  state: "requested";
  mergeDecision: "owner-required";
  mainMutation: false;
  sharedGitMetadataMutation: false;
  next: string;
}
```

**要求不等於核准。** Agent 只能建立請求，不能自行把文字回覆轉換成 approval token；`requested` 記錄
不含任何秘密，也無法被消耗。`previewDigest` 必須與此刻重算的結果一致，否則回
`MAIN_MERGE_PREVIEW_DIGEST_STALE`——因此不可能對「沒有人看過的快照」提出請求。截斷的 preview 回
`MAIN_MERGE_PREVIEW_TRUNCATED`，模擬出衝突回 `MAIN_MERGE_PREVIEW_CONFLICTED`，兩者都不建立任何列。
同一個 task 同時只允許一個未決問題（`MAIN_MERGE_APPROVAL_ALREADY_PENDING`，由 partial unique index
結構性保證）。同一把 key 重放回同一個 approval；輸入不同則 `MAIN_MERGE_REQUEST_IDEMPOTENCY_CONFLICT`。

### Owner 決定（GUI／TUI，非 Agent 工具）

核准只能在本機 owner 介面產生，不存在對應的 MCP 工具：

- `GET /api/rooms/merge-approvals?room=<id>[&taskId=<uuid>]`
  → `{ approvals: MergeApproval[]; confirmationPhrase; grants; notAuthorized }`
- `GET /api/rooms/merge-approvals/inspect?room=<id>&approvalId=<uuid>`
  → `{ approval; binding: { checked: boolean; valid: boolean; changed: string[]; unavailable?: string };
  confirmationPhrase }`
- `POST /api/rooms/merge-approvals/approve { room, approvalId, previewDigest, confirmation }`
  → `{ approval; promotion; authorization; mainMutated; replayed }`（raw token 不離開 server）
- `POST /api/rooms/merge-approvals/reject { room, approvalId, reason? }`
  → `{ approval; deletedByThisRejection: "nothing"; mainMutation: false }`
- `GET /api/rooms/merge-history?room=<id>[&taskId=<uuid>]`
  → `{ promotions: (MergePromotion | UnreadableMergePromotion)[]; chainValid: boolean }`

`confirmation` 必須精確等於 `MERGE INTO MAIN`（語意化、不含 taskId）；`previewDigest` 必須等於
dialog 實際顯示的那一份。核准當下會**再驗一次**整組綁定值，任一改變即回
`MAIN_MERGE_APPROVAL_BINDING_CHANGED:<欄位名>` 並把該 approval 轉為終局 `invalidated`。
`approvalToken` 只存在於 server 的 grant→promotion 呼叫鏈；資料庫只存 SHA-256，瀏覽器、audit 與 Room
ledger 都看不到 raw token，且一離開 `approved` 狀態即清除。若 response 遺失後重送，server 依 exact
`approvalId` 回讀同一筆 durable promotion；不得再次執行 Git。只有 `applied` 且
`authorizedMergeCommit=true` 可被 GUI 顯示為 Merge 成功。

拒絕與逾時**不執行任何 Git 指令**：candidate、checkpoint 與 recovery ref 逐位元不變，Owner 可重新
preview 再問一次。已核准的 approval 也可由 Owner 撤回（reject）。

**讀取即重驗（ADR-034）。** 上列兩個 `GET`、`candidate_status` 與 `main_merge_request` 都會在回報
approval 之前對 live state 重驗綁定：漂移者在被回報前即持久轉為終局 `invalidated`，其 `refusal`
帶 `code: "MAIN_MERGE_APPROVAL_BINDING_CHANGED"`、改變的欄位名，以及 `reason:
"drift-detected-on:<介面>"`。因此這三個 `GET` **不是純唯讀**：它們唯一可能造成的狀態轉移，是把一個
已經無法使用的核准記成終局失效（fail-closed 方向，無法授權、復活或刪除任何東西）。`bindingCheck`
（列表與 `candidate_status` 上同名欄位；`inspect` 另以 `binding` 回傳同一物件）只在確實比對過時出現，
`unavailable` 表示檢查無法完成——此時 approval **既未**被確認也**未**被失效。

### `main_merge_execute`（Phase 5-5 core 已實作；Owner HTTP outlet 已接線）

由本機 GUI Owner action 經 `approveAndPromoteMainMerge()` 消耗 single-use approval；一般 Agent tool 不
直接接收可重放 token。本輪沒有新增 MCP promotion 工具，Agent 仍只能 preview/request，不能自行核准或
執行 main merge。Owner 的成功／失敗／不確定結果進入 `/api/rooms/merge-history` durable surface。

**2026-08-06 更正**：這裡原本寫「核心已提供 `CandidateRegistry.consumeMainMerge(...)`」——**該方法已完全
移除**，5-5 把「消耗核准」與「寫入 main」合併成單一不可分割的操作，正是為了消除「核准被消耗但 merge
沒發生」這個中間態。現在唯一的入口是 `CandidateRegistry.promoteMainMerge({ approvalId, token, action,
taskId, roomId, mainPath, mergeTimeoutMs? })`：它第三度重驗 candidate/main HEAD、branch、paths、
dirty/ignored fingerprint、recovery readiness 與 preview digest，再重跑針對 **live main** 的 promotion
gates（工作樹乾淨、hook 指紋、會被覆蓋的 ignored 檔案），然後依固定順序**寫入 `applying` 意圖紀錄 →
以 compare-and-set 消耗核准 → `git merge --no-ff --no-edit` → 寫入終局結果**。並行只會有一個贏家
（`approval_id` UNIQUE 索引在任何 Git 指令之前就擋下輸家），回傳的授權物件內
`grants: "merge-candidate-into-main"` 與 `notAuthorized`
（push／publish／deploy／delete-candidate／delete-recovery-ref／cleanup-worktree…）皆為明文。
帶其他 `action` 消耗一律 `MAIN_MERGE_APPROVAL_ACTION_NOT_GRANTED`。

Promotion live gate 的 attributes 契約是：在 promotion 環境以 `git check-attr` 檢查 main 目前可見的
tracked／ignored／probe 路徑，以及完整 preview 中每個非刪除、候選 merge 將寫入的確切路徑。候選新增
路徑因此不得避開 clean/smudge filter 拒絕；preview 截斷或 Git 無法回答時必須 fail closed。

~~**目前仍無 MCP／HTTP 出口**：`promoteMainMerge` 只有測試會呼叫。~~ **2026-08-14：**仍無 Agent
MCP 出口；本機 Owner HTTP 已接線，且同一操作會實際修改 canonical main。成功判準與 history 契約見上節。

若發生 drift、scope expansion 或未預覽 conflict：

```ts
output: {
  state: "reapproval-required";
  reason: string;
  updatedPreview: MergePreview;
}
```

成功只修改 main；不自動 push、publish、deploy 或 cleanup candidate。

## 7. Provider worker 相容工具

`ask_codex`、`ask_claude`、`ask_grok`、`compare_agents` 可繼續作為「新建 worker」工具。它們必須：

- 在名稱、回傳與 Ledger provenance 上標示 `provider-worker`；
- 不出現在 exact terminal seat 清單；
- 不接收指定 terminal seat 的 fallback 工作；
- 不作為 live Agent 間即時協作的唯一途徑。

是否讓 GUI Managed worker read-only，是 GUI 模式選擇；不得據此限制 Native Full-Trust host。

## 8. Server instructions 更新

MCP initialize instructions 必須告知 host：

1. 加入 Orchestratory 不改變 host 原生能力。
2. 需要與既有 terminal 協作時，使用 seat/thread 工具，不使用 `ask_*` 冒充。
3. Coding 任務預設在 candidate path 工作。
4. 準備直接修改 canonical main 時，先說明並等待使用者同意。
5. 任務完成後呼叫 `candidate_complete`，並主動詢問是否 merge main。
6. 不設固定 thread 往返上限；timeout 後可繼續等待。

## 9. 安全與一致性不變量

- Native capability 不由 MCP join mode 升降。
- Source identity server-bound；payload 不能偽造。
- Exact target no fallback。
- Same Room/workspace routing。
- Thread 無固定 round ceiling。
- Candidate completion 不等於 main approval。
- Merge approval single-use、snapshot-bound；drift 必須重批。
- Main merge 不包含 push/publish/deploy/cleanup。
- Full-Trust 的同帳號繞過風險在 GUI、文件與 audit 中誠實揭露。

## 10. 實作順序

1. 擴充 inbox schema 與 CollaborationService，移除 sender=`you` 硬編碼。
2. 新增 seat discovery、send、wait-reply、reply-and-wait 與 thread tests。
3. 更新 GUI/TUI seat provenance 與 peer thread 顯示。
4. 建立 Candidate Registry、completion checkpoint 與 merge prompt。
5. 建立 snapshot-bound approval、promotion、main drift、recovery 與 rollback tests。
6. 實際以兩個不同終端 Codex／Claude Code 完成端到端人工驗收。
