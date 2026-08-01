# Orchestratory V2 Roadmap

狀態：待辦／尚未實作。本文只記錄產品方向，不代表已授權遠端監聽、雲端部署、外部資料傳輸或新增權限。

> **2026-08-01 scope note：** ADR-028 已把本機原生 TUI session 定義為 Native Full-Trust。
> 本文件描述的是跨裝置 Remote Room，屬不同信任邊界，尚待依新 Owner Decision 重新審查；本文的
> 「遠端唯讀」草案不得反向套用到本機 terminal，也不代表遠端最終權限決策已定案。

## V2.1 Remote Room Seat（Orchestratory Satellite）

### 目標

允許另一台電腦上的 Codex、Claude 或 Grok，經該電腦上的本機 MCP connector，以可驗證的遠端
session 身分申請加入指定 Room。Owner 核准後，遠端 Agent 可參與共享帳本討論、引用訊息、接收
精確席位交辦並回覆。

預期拓撲：

```text
Remote Codex / Claude / Grok
          │ local MCP stdio
          ▼
Orchestratory Satellite Connector
          │ outbound authenticated encrypted channel
          ▼
Remote Room Gateway
          │
          ▼
Existing Room Ledger / Presence / Inbox / Owner GUI
```

Remote Room Gateway 必須是獨立的新信任邊界。不得直接把現有 loopback Web server 改綁
`0.0.0.0`，也不得讓遠端 client 直接存取本機 SQLite、GUI Owner API、Workspace MCP 或 provider
credentials。

### 第一階段範圍：遠端唯讀討論席位

- Owner 產生綁定單一 Room、短效且 single-use 的邀請。
- Remote connector 在遠端裝置本機產生裝置金鑰；長期私鑰不得出現在邀請碼、argv、Room 帳本或 server log。
- 初次配對後使用相互驗證的加密連線；server identity 必須 pin，連線與訊息必須防 replay。
- 遠端 presence 使用裝置公鑰指紋、session id 與短租約，不依賴本機 PID／PPID。
- 沿用 `room_join_request` 的 membership 核准語意；加入 Room 不代表可待命。
- 沿用獨立的 `room_wait` standby 核准、active wait、heartbeat、lease expiry、Owner revoke 與 no-fallback 語意。
- 沿用 exact-seat inbox 與 `room_ack`／`room_reply`／`room_fail` 狀態機。
- Owner 仍需明確選擇 `room-first` 或 `seat-only`；遠端 Agent 不能自行變更模式或跨 Room 使用 membership。
- Ledger 訊息維持 bounded、redacted、append-only、編號與完整性驗證。
- 每個遠端裝置、session、Room 與權限範圍必須獨立可撤銷，並有連線、訊息與 provider-call rate limits。
- Technical audit 必須記錄遠端裝置指紋、session、Room、動作與結果，但不得保存私鑰、完整 prompt、reasoning 或 raw provider output。

### 第一階段明確不提供

- 不對外開放現有 loopback GUI。
- 不允許遠端 Agent 讀取本機 workspace、絕對路徑、環境、secrets 或 provider 登入資料。
- 不允許遠端 Agent 取得 Workspace MCP、Writer Lease、worktree capability 或 apply-back 權限。
- 不允許遠端 Agent 批准 workflow、測試、API 花費、workspace allowlist、發布或其他 Owner 動作。
- 不允許遠端 Agent 未經 Owner 核准消耗本機 provider 訂閱或 API 額度。
- 不提供遠端 SQLite、filesystem、Git、shell、任意 network 或管理 API。
- 邀請碼不得作為可長期重放的 bearer token。

### 後續里程碑

1. **Private-network prototype**
   - 先驗證同一 Owner 的兩台電腦。
   - 透過受信任私人網路測試加入、核准、待命、收件、回覆、撤銷與斷線恢復。
2. **Invite-based external seats**
   - 新增獨立 Gateway 與 Satellite connector。
   - 支援外部使用者的一次性配對、裝置身分、Room-scoped membership 與即時撤銷。
3. **Controlled Context Packets**
   - Owner 只可從已授權 workspace 選擇 bounded UTF-8 text。
   - 分享前顯示檔案、bytes、敏感路徑檢查與接收席位的 immutable preview。
   - Context 必須短效、可撤銷，且不得包含本機絕對路徑或隱含 workspace 存取權。
4. **Remote contribution proposal**
   - 遠端 Agent 最多提交 bounded proposal 或 patch suggestion。
   - 真正寫入仍由本機受控 Writer Companion 在隔離 worktree 執行。
   - 此階段需要另一份獨立 threat model 與 Owner scoped approval；不得由第一階段權限自動升級。

### 實作前安全 Gate

- 新增 Remote Room 專用 threat model 與 ADR，重新定義遠端人類、遠端 Agent、Gateway、Relay 與本機 Owner 的信任邊界。
- 驗證 invitation theft/replay、MITM、server impersonation、stolen device key、惡意遠端 client、
  connection flood、message flood、quota abuse、cross-room access、stale presence、revocation race、
  reconnect replay、oversized payload、metadata leakage 與 compromised remote device。
- 遠端 transport、identity、key rotation、revocation、retention、版本相容與升級失敗皆需 fail closed。
- 公開網路測試前完成獨立安全審查；未完成前只允許明確的私人測試環境。

### V2 驗收結果

只有在下列條件全部成立後，才能宣稱支援 Remote Room：

- 外部 Agent 只能看見 Owner 明確分享的 Room／Context 範圍。
- 邀請、membership、standby 與 provider 額度授權無法互相替代或升級。
- 遠端斷線、撤銷或 lease 過期後，該 session 立即失去收件與發言能力。
- 遠端 Agent 無法取得本機 workspace、Writer、approval、secrets 或管理能力。
- GUI 能誠實區分 local、remote、managed、external-terminal 與 Writer Companion 身分。
- 所有安全與負向測試、跨程序／跨裝置整合測試及人工驗收均有可重現證據。
