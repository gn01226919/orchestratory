# Owner Decision：Native Full-Trust、Candidate-first 與任務終點 Merge

狀態：**Accepted / Normative**

決策日期：2026-08-01

決策者：Repository Owner

本文件是 Orchestratory 下一版產品規格的最高層決策。凡是過去文件主張「終端 Agent 必須唯讀」、
「不得取得 shell／Git／network／專案外路徑」、「必須使用 Writer Companion 才能寫入」、
「每個 task 只能有一個受限 Writer」或「Agent thread 必須有固定最大往返輪數」，均已被本決策取代。

## 決策

Orchestratory 採用 **完整控制優先**：原生 TUI Agent 保留其 host 本來提供的完整能力，協作器不再以
削弱 Agent 權限作為主要安全模型。任務預設在獨立 candidate workspace 工作；安全與可靠性集中在
候選成果保存、canonical main 邊界、差異預覽、單次 merge 核准、備份與復原。

Orchestratory 不主動替 Agent 升權，也不替它降權。Agent 的實際能力由原生 Codex／Claude Code
host 與使用者選擇的執行模式決定。

## 任務生命週期

```text
建立 task + candidate + base/main snapshot
                  ↓
多個原生 Agent 在 candidate 工作、互傳、等待、調整
                  ↓
Agent 宣告驗收完成，candidate 產生穩定 HEAD/checkpoint
                  ↓
Orchestratory 主動顯示 diff、測試、刪除、衝突與復原點
                  ↓
詢問：「是否將本次 candidate merge 到 main？」
             ↙                         ↘
      否／稍後：保留 candidate       是：single-use snapshot-bound approval
                                              ↓
                                      merge/promote + verify + audit
```

每個任務終結時都必須詢問一次，不得因 Agent 已完成、已 commit、已通過 review 或 GUI 已核准待命而
自動 merge。若 candidate HEAD、main HEAD、目標路徑或 diff 在詢問後改變，原批准失效，必須重新預覽。

## Main 邊界提示文字

Agent 準備直接改動 main，或 Orchestratory 準備 promotion 時，必須用等價且清楚的文字告知：

> 我目前在 candidate 工作區。接下來將對 canonical main `<path>` 執行 `<operation>`。
> 本次候選版本為 `<candidate HEAD>`，main 基準為 `<main HEAD>`；影響、刪除、衝突、測試與復原點如下。
> 是否允許把這個精確快照 merge／promote 到 main？

一般讀取 main、搜尋其他路徑或使用原生工具不構成 merge 核准請求。邊界以「修改 canonical main」
判定，而不是以目前 shell cwd 判定。

## 協作能力

- 同一 Room 的 exact terminal seats 能彼此發現、直接傳訊、引用、等待、回覆與延續 thread。
- Thread 不設固定回合數上限；transport timeout 只代表重新等待，不代表 thread 結束。
- Ledger 負責共享記憶，exact-seat thread 負責即時協作。
- Provider worker 與 exact terminal seat 必須是不同身分；不得把 terminal-to-terminal 訊息改送到新建
  的常駐 worker，也不得以 `you` 冒充 terminal sender。
- TUI Agent 保留原生 filesystem、shell、Git、network、plugin 與 subagent 能力。

## 兩種產品模式

| 模式 | Agent 能力 | Candidate | Main merge |
|---|---|---|---|
| Native Full-Trust | 保留原生 host 完整能力，Orchestratory 不降權 | 預設任務工作區 | 任務終點主動詢問，單次綁定快照 |
| GUI Managed | Owner 可選 read-only／writer／full-trust | 依 GUI workflow 建立 | 與 membership、standby、Writer Lease 分離核准 |

舊有 Writer Lease、Workspace MCP broker 與受控 worker 可以保留給 GUI Managed；不得套用到 Native
Full-Trust terminal seat。

## 誠實限制

Candidate 不是 OS 強制 sandbox。擁有相同 macOS 使用者完整權限的程序，可以直接修改 main、停止
監控或刪除同帳號備份。因此本決策提供的是 recovery-first 與合規協作邊界，不是對惡意同帳號程式
的不可繞過隔離。需要強制保護時，必須另採不同 OS 身分、root-owned guardian、唯讀 volume 或外部
備份，並以獨立模式呈現。

## 導入順序

1. 先更新所有 normative 規格及 ADR，明確廢止相反規則。
2. 再實作 exact-seat peer thread 與 authenticated sender routing。
3. 建立 candidate lifecycle、checkpoint、task completion 與 merge prompt。
4. 實作 snapshot-bound approval、main drift detection、promotion、verification 與 recovery。
5. 最後更新 GUI／TUI 呈現並執行人工驗收。

在 runtime 完成前，文件必須標示「目標規格／尚未實作」，不得把本決策誤報成目前已交付能力。
