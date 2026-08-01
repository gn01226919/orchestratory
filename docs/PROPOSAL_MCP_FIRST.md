# Orchestratory MCP-first Native Full-Trust 規格

狀態：**Accepted design / exact-seat phase implemented in development source; live acceptance pending**

更新：2026-08-01

依據：`OWNER_DECISION_FULL_CONTROL.md`、ADR-028

本版取代原本「MCP 只提供唯讀 worker、terminal 只能由 GUI 單向交辦」的提案。既有 `ask_*` worker
可保留，但不得冒充 live terminal-to-terminal collaboration。

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

### `candidate_complete`（已實作；promotion 尚未實作）

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

目前 `candidate_start`／`candidate_checkpoint`／`candidate_complete` 尚未提供 durable request idempotency。
若 stdio／transport 回應不確定，Agent 必須先呼叫 `candidate_status` 找回 task、checkpoint、completion
與原 Owner prompt，不得盲目重送。`candidate_start` 重送會建立額外 candidate，checkpoint 會新增 ref，
而已成功的 complete 重送可能回 `CANDIDATE_NOT_ACTIVE`。這些 artifact 會保留且可見，canonical main
branch/worktree 不會被覆寫；但 Phase 5 promotion 前必須補 required stable `clientRequestId`、durable
request receipt、same-key/same-digest replay 與 crash reconciliation。

### `candidate_status`（已實作）

目前列出 active/completed 狀態、checkpoint、live HEAD/dirty、completion stale 與 branch recovery
readiness；merged/rejected/retained 與更完整的 Agent branch/thread 呈現由 promotion/GUI 階段補齊。

## 6. Main merge 工具

### `main_merge_preview`

```ts
input: { taskId: string; completionId: string }
output: {
  candidateHead: string;
  mainHead: string;
  files: FileChange[];
  tests: TestResult[];
  conflicts: Conflict[];
  risks: string[];
  recovery: RecoveryState;
  previewDigest: string;
  prompt: string;
}
```

`prompt` 必須明確說明即將修改 canonical main，詢問 Owner 是否同意該精確快照。

### `main_merge_request`

```ts
input: {
  taskId: string;
  completionId: string;
  previewDigest: string;
}
output: { approvalRequestId: string; state: "pending-owner" }
```

Agent 只能建立請求，不能自行把文字回覆轉換成 approval token。

### `main_merge_execute`

由本機 GUI/TUI Owner action 或受保護 promotion service 消耗 single-use approval；一般 Agent tool 不
直接接收可重放 token。執行前重驗 candidate/main HEAD、paths、preview digest 與 recovery readiness。

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
