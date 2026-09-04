# 快速開始

從安裝到第一次 merge 核准的完整流程。這一節原本在 `README.md`，搬過來是因為篇幅：
README 的工作是讓第一次看到這個專案的人在一分鐘內知道它是什麼、以及它**不**保證什麼；
逐步教學是給決定要試的人看的，兩者的讀者不同。

## 從本機 source 安裝

目前專案尚未公開發布，先從取得的本機 source folder 安裝。需要 Node.js 22.20 以上；不得使用
`sudo npm link`、不得放寬系統目錄權限。鎖定依賴、停用 package lifecycle scripts，並在建立
使用者層級 link 前完成驗證：

```text
cd "/path/to/orchestratory"
node --version
npm ci --ignore-scripts
npm run check
npm_config_ignore_scripts=true npm_config_prefix="$HOME/.local" npm link
"$HOME/.local/bin/orchestrator" --help
"$HOME/.local/bin/orchestrator" doctor
```

若一般的 `orchestrator` 顯示 command not found，先使用上方完整路徑；檢查自己的 `PATH` 後再由
owner 決定是否修改 shell profile，不要讓安裝程序自行改寫。也可以把以下自然語言交給 coding
agent；這段授權只涵蓋安裝與唯讀驗證：

```text
請在本機安全安裝目前這個 Orchestratory 專案。先確認 Node.js 至少為 22.20；只使用 repository
既有的 package-lock，執行 npm ci --ignore-scripts 與 npm run check。不得使用 sudo、不得修改
系統目錄、shell profile 或放寬檔案權限。驗證通過後，使用
npm_config_ignore_scripts=true npm_config_prefix="$HOME/.local" npm link。最後只執行
"$HOME/.local/bin/orchestrator" --help 與 "$HOME/.local/bin/orchestrator" doctor；不要啟動模型。
遇到 PATH、權限、測試或依賴問題時停止並回報，不要自行繞過。
```

## 快速開始：從安裝到第一次 merge 核准

裝完之後，這一節帶你走完一次完整的流程。**十步，每步一行指令。**

先說清楚這個產品在做什麼，後面每一步才有意義：

> **Agent 在一個獨立的工作區（candidate）做事，不直接動你的專案。**
> **做完之後，系統把差異攤開給你看，問你要不要併進去。你不點頭，agent 的變更不會進入你的專案。**

一個誠實的但書：**若你的專案自己設定了 merge driver**（`.gitattributes` 加 `.git/config` 裡的
自訂合併程式），預覽為了算出真實結果**會執行你設定的那支程式**——而那是任意程式，**它能做什麼就
真的能做什麼**（留下暫存檔、覆寫檔案、寫到專案外），而且發生在你點頭之前。跑的是**你自己的程式**、
不是 agent 寫的；但 agent 改動的檔案內容會被 git 當參數餵給它，所以那支程式若不謹慎處理輸入，
agent 的內容仍可能被執行（見 [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) F23）。
**多數專案沒有設 merge driver，也就完全不會遇到這件事。**

`main` 在本文件裡一律指**你自己的專案目錄**，不是 GitHub 上的分支。

---

### 1. 告訴它哪個資料夾可以碰

```bash
orchestrator workspaces allow /path/to/your-project --label my-project
```

**預設是什麼都不准碰**，沒有這一步後面全部會失敗。這個指令會把**正規化後的完整路徑**印在終端機上，
要你**親手打字確認**——因為它只接受實體 TTY 的輸入，agent 沒辦法代替你按。

### 2. 啟動

```bash
orchestrator
```

會同時開終端機對話和本機網頁介面（GUI）。GUI **只綁在 loopback**，外面連不進來。
只要 GUI 的話用 `orchestrator gui`。

**GUI 是你的控制台。** 後面所有「核准」都在那裡按，不在終端機。

### 3. 建立房間

```bash
orchestrator room init
```

房間是這個專案的協作單位：一份**只能往後追加、不能改寫**的共用帳本，加上一份席位名單。
同一個資料夾重複執行會回傳原本那間，不會建第二間。

### 4. 把 Orchestratory 掛給你的 coding CLI

在 Codex 或 Claude Code 的 MCP 設定裡新增一個 **stdio** server，指令是：

```bash
orchestrator mcp --actor codex
```

`--actor` 是這個席位的身分，**由啟動設定決定，agent 不能自己改**。名稱只接受小寫字母開頭、
最長 32 字元；`you` 和 `system` 一律拒絕，因為那兩個會冒充系統或你本人。

### 5. 叫 agent 自己申請進房

直接跟你的 agent 說：**「請呼叫 `room_join_request` 加入房間。」**

**不要叫它跑 shell 指令去 join。** 進房必須由 agent 透過 MCP 提出申請，
這樣系統才知道**是哪一個活著的程序**在要求進來——shell 指令做不到這件事。

### 6. 你在 GUI 按核准

GUI 會跳出加入請求，你選這個席位的協作模式後核准。

**加入房間不會改變 agent 的任何權限**——它的 sandbox、工具、shell、網路全部由它自己的 host 決定，
Orchestratory 不升權也不降權。加入只是授權「協作」。

接著叫 agent 呼叫 **`room_wait`**，GUI 會再跳一次待命核准。這兩個是**不同的授權**：
前者是「可以進來」，後者是「可以被指派工作」。

### 7. 開一個任務

叫 agent 呼叫 **`candidate_start`**。

系統會建立一個獨立的 Git 分支與工作區，並記下你專案**當下的 HEAD**。
**你未提交的修改會原地保留**，不會被複製進去，也不會被清掉、stash 或 reset。

### 8. Agent 在 candidate 裡做事

它有完整的原生能力。過程中可以隨時呼叫 **`candidate_checkpoint`** 存一個可復原的快照
（必須是已 commit 的乾淨狀態，否則會被拒絕——這樣快照才真的救得回來）。

### 9. 任務完成，系統開始問你

叫 agent 呼叫 **`candidate_complete`**，接著 **`main_merge_preview`**。

你會拿到：**變更的檔案、衝突、測試結果、風險、復原點**，以及**一句你必須逐字打出來的確認語**。

如果預覽**顯示不完整**（檔案太多被截斷、或模擬合併有衝突），它會回報 `approvable: false`——
**系統不會請你為你沒看過的內容簽名。**

### 10. 核准，才會寫進你的專案

叫 agent 呼叫 **`main_merge_request`**。**提出申請不等於核准**——它只是登記一個問題，
而且**不帶任何 agent 能用的 token**。

然後你在 GUI 裡：**把 diff 捲到底** → 逐字打出確認語 → 按核准。

這時系統才會真的寫入你的專案。這份核准**只能用一次**，而且綁死在那個快照上：
只要 candidate HEAD、你的專案 HEAD、路徑、預覽摘要**任何一個變了，核准立刻失效**，必須重新預覽再問一次。

---

### 三件反直覺、但刻意如此的事

1. **agent 不能核准自己的 merge。** `main_merge_request` 只能「問」。
   能核准的介面只有你的 GUI 或實體 TTY——因為 agent 摸不到那兩個地方的輸入。
2. **拒絕不等於刪除。** 你說不要或先擱著，candidate 和它的紀錄都會留著。
3. **candidate 不是 OS 沙箱。** 同一個 macOS 帳號下的 full-trust agent，技術上仍然可以繞過去。
   它提供的是**可追溯、可復原、有紀錄**，不是強制隔離。這一點文件裡不會給你更好聽的說法。
