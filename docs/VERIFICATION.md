# MVP 驗證矩陣

> **vNext evidence notice（2026-08-01）：** exact-seat peer discovery/send/await/thread 已在隔離 development
> branch 完成 synthetic multi-connection 驗證；candidate lifecycle 亦已完成 Git/SQLite/MCP synthetic
> 驗證，另以雙 OS process 驗證 inbox migration 競態。尚未切換
> 已安裝 MCP，也尚未完成真實 Codex＋Claude Code
> host 驗收。下表其餘舊測試保留作為 GUI Managed 回歸證據，不得拿來冒充 Native Full-Trust、
> 已安裝 runtime 或 main merge decision 已完成。

## Phase 5-2 通過標準（開工前先訂，2026-08-05）

Phase 5-1 在**沒有通過標準**的情況下跑了十輪對抗式審查，十輪皆 No；收斂的槓桿不是審得更兇，而是
第九輪首度訂出「五條 yes 標準 ＋ 明列可接受殘餘風險」。**本節是把那根槓桿前移到 5-2 開工前**，
避免同一個模式重演。第一輪對抗式審查**只准對照本節裁決**，不得引入本節以外的新終點線；
要新增要求者，必須說明它為何屬於標準而非殘餘風險。

### 不變式

> **一個 `previewDigest` ⇒ 至多一種 merge 結果。**
> preview 若宣稱 `mergeable: true`，在同一 snapshot 下實際執行 merge 不得出現 preview 未列出的衝突；
> preview 若列出衝突，那些路徑必須是實際會衝突的路徑。

5-3 的核准會綁定 `previewDigest`，5-5 會依它寫入 canonical main——**preview 說謊等於核准了不存在的東西**。

### Yes 標準（五條）

1. **Preview 不得改變 canonical main 的可見狀態**：不動任何 ref、不動 worktree、不動 index。
   （`merge-tree --write-tree` 會寫入不可達的 tree object，這是可接受的，見殘餘風險。）
2. **Preview 與實際 merge 一致**：以已知會衝突與已知不衝突的 fixture 各驗一組，preview 的
   `mergeable` 與衝突路徑集合必須與實際 merge 的結果相符。
3. **Mode change 與 submodule 可辨識**：純權限變更（644→755）與 submodule 指標變更
   （mode `160000`）不得與一般 modify 混淆。
4. **無法計算即 fail closed**：`merge-tree` 不可用、輸出畸形、或任何非「衝突退出碼」的失敗，
   一律以穩定錯誤碼拒絕，**不得回傳 `mergeable: true`，也不得省略衝突欄位**。
5. **新欄位納入完整性鏈**：全部進 `previewDigest`，並在讀取路徑以同等嚴格度驗證；
   completion 經 close／reopen 後仍必須通過驗證。

### 可接受的殘餘風險（本階段）

| 項目 | 理由 | 5-5 前是否失效 |
|---|---|---|
| 檔案／衝突／submodule 清單有上限，超過只回報截斷旗標 | preview 是決策輔助，不是完整審計 | **會失效**——promotion 若基於截斷的 preview 核准，Owner 等於對看不到的內容簽名。5-5 前必須改為「截斷即不可核准」或提供分頁 |
| `merge-tree` 產生的 tree object 留在 object DB | 不可達、等 gc、不影響 main 可見狀態 | 否 |
| preview 與實際 promotion 之間的 drift | 屬 5-4（drift invalidation）範圍 | 否（由 5-4 關閉） |
| 二進位／過大檔案只標示不顯示內容 | 顯示無意義且會撐爆界限 | 否 |
| **Hooks 不會執行**（實測：`pre-merge-commit` 的 marker 不出現） | `minimalGitEnvironment` 釘 `core.hooksPath=/dev/null` | **必須在 5-5 前處理**——實測分歧方向為真：preview 回 `mergeable: true`，實際 merge 因 `pre-merge-commit` 回 1 而把工作樹留在 merge 中途 |
| Submodule 遞迴更新不會執行 | `merge-tree` 不遞迴進 submodule | 否——submodule 指標變更本身有偵測（`submodules` 欄位） |
| **`.gitattributes` merge driver 會執行**（原本本表宣稱不會，**該宣稱經實測證偽**） | driver 定義只能來自 repo 自身的 `.git/config`（`GIT_CONFIG_NOSYSTEM=1`、`GIT_CONFIG_GLOBAL=/dev/null` 已抑制 global/system）。保真度因此**優於**原本宣稱：driver 在 preview 與實際 merge 兩邊都跑，結果一致 | 否（保真度面）。**但安全面見 [[THREAT_MODEL]] F23**——preview 會依 repo config spawn `/bin/sh -c <字串>` |

### 5-5 開工前必須關閉的既有項（第九輪判為殘餘的理由屆時失效）

第九輪把一串缺陷判為可接受，理由明寫是**「這些都不會把錯誤內容寫進 canonical main」**。
到 5-5（promotion）這個理由整條失效。**兩項皆已於 2026-08-06 關閉**：

- [x] ~~**暫時性 Git 失敗即判 `failed` 燒掉 key**~~：終局 `failed` 改由 allowlist
  `DETERMINATE_REQUEST_FAILURES`（7 個確定性錯誤碼）決定，其餘一律視為「結果未知」而維持 `pending`，
  同一把 key 在環境恢復後可收斂。用真實失敗驗證，含**時鐘倒退**（NTP 校時／睡眠喚醒）打在啟用那一刻
  導致 worktree 已完整建好卻被判 failed 的情境；每一條都先在修復前的基準確認會失敗。
- [x] ~~**`orphanRecoveryRefs()` 沒有任何出口**~~：新增唯讀 CLI
  `orchestrator candidates orphan-refs <workspace>`，只列不刪、過 workspace allowlist。

**其餘四項前置條件的本質都是「必須在 5-5 裡處理、單獨做沒有意義」**（hooks 在真實 merge 會執行、
`mergeable:true` 需乾淨 main 工作樹、`mainIgnoredFingerprint` 只涵蓋路徑、preview 無節流），
已全部併入下方的 5-5 通過標準第 3 項。**可以獨立關的兩項已經關完。**

## Phase 5-3 通過標準（開工前先訂，2026-08-06）

同 5-2：**第一輪對抗式審查只准對照本節裁決**，要新增要求者須說明它為何屬於標準而非殘餘風險。

### 不變式

> **一個 approval ⇒ 至多一次 promotion，且只適用於它綁定的那個精確 snapshot。**

5-5 會依這個 approval 寫入 canonical main。**approval 一旦能被重放、能套用到別的 snapshot、
或能在綁定值改變後仍生效，Owner 核准的就不是他看到的那個東西。**

### Yes 標準（六條）

1. **綁定完整**：approval 至少綁 `taskId`、`candidateHead`、`mainHead`、`previewDigest` 與目標路徑。
   任一綁定值改變即失效，且失效必須是**拒絕**而非靜默重新計算。
2. **Single-use**：已使用的 approval 不可重放；兩個並行使用只有一個能成功，另一個以穩定錯誤碼拒絕。
   短效——逾時後失效。
3. **拒絕不等於刪除授權**：Owner 拒絕或不決定時，candidate、checkpoint 與 recovery ref 完整保留，
   且可重新 preview 再問一次。拒絕本身不得觸發任何清理。
4. **授權不得外溢**：approval 只授權「把這個 snapshot merge 進 main」。不得被當成 push、publish、
   deploy、刪除或任何其他外部副作用的授權。
5. **截斷的 preview 不可核准**（提前關閉 5-2 記錄的到期項）：`filesTruncated`、`submodulesTruncated`
   或 `mergeConflictsTruncated` 任一為真時，approval 必須拒絕。**Owner 不得對看不到的內容簽名。**
6. **核准介面**（D-001／D-002 已由 Owner 核准）：頁內 dialog，**不得使用 `window.prompt`／`alert`／
   `confirm`**；短語為語意化的 `MERGE INTO MAIN`（不含 taskId）；**scroll-gate**——diff 未捲到底或
   衝突區有未確認項目時，輸入框與主要按鈕保持 disabled；說明文字採中英對照。

### 可接受的殘餘風險（本階段）

| 項目 | 理由 | 5-5 前是否失效 |
|---|---|---|
| approval 不涵蓋 hooks 行為（`pre-merge-commit` 等） | preview 本身不跑 hooks（見 5-2 表） | **會失效**——5-5 執行真實 merge 時 hooks 會跑，approval 綁的 preview 沒算進去 |
| approval 不保證 merge 一定成功，只保證「沒有內容衝突」 | dirty main 會讓實際 merge 在衝突解析前中止 | **會失效**——5-5 必須要求乾淨的 main 工作樹 |
| 同帳號程序可直接改 approval store | 與整個產品的信任模型一致（見 §2 非安全保證） | 否 |
| approval 過期後需重新 preview，成本由 Owner 承擔 | 這是刻意的摩擦，不是缺陷 | 否 |

## Phase 5-4 通過標準（開工前先訂，2026-08-06）

**第一輪對抗式審查只准對照本節裁決。**

### 不變式

> **approval 存活期間，任何綁定值的漂移都必須讓它失效——而且失效是「拒絕並說出哪一項變了」，
> 不是靜默重算成新的樣子。**

5-3 已在 grant 與 consume 兩點驗證綁定。5-4 要處理的是**兩點之間**：漂移發生時，Owner 與 agent
必須在**下一次觀察時**就知道，而不是等到 consume 才發現；而且失效必須留下可稽核的紀錄。

### Yes 標準（五條）

1. **主動偵測，不只被動驗證**：main 或 candidate 的綁定值在 approval 存活期間改變時，該 approval
   必須在**下一次任何觀察路徑**（`candidate_status`、approval 列表、inspect）就顯示為失效，
   不得只在 consume 時才發現。
2. **失效必須具名**：回報哪些綁定值改變了，用與 5-3 相同的名稱集合。不得只說「已失效」。
3. **失效必須留痕**：invalidation 寫進 durable 狀態與稽核鏈，Owner 事後查得到「那次核准為何沒有生效」。
   一次無聲的失效與一次從未發生的核准，在紀錄上必須可區分。
4. **失效不得破壞任何東西**：candidate、checkpoint、recovery ref、main 全部 byte-identical；
   且 Owner 可立即重新 preview 再問一次。
5. **不得誤殺**：與綁定無關的變動（例如 ignored 檔案內容、無關的 branch、index refresh）不得使
   approval 失效。5-3 審查已實測出四種這類變動；它們必須維持不失效。

### 可接受的殘餘風險（本階段）

| 項目 | 理由 | 5-5 前是否失效 |
|---|---|---|
| 偵測是觀察時觸發，不是背景輪詢 | 本產品沒有常駐背景掃描；觀察路徑涵蓋 GUI dialog 的 5 秒 inspect 與所有 MCP 讀取 | 否 |
| `mainIgnoredFingerprint` 只涵蓋 ignored 檔案的**路徑**，不涵蓋內容 | 5-3 審查 Finding 3 已記錄 | **會失效**——5-5 的真實 checkout 會靜默覆蓋 ignored 檔案 |
| 漂移與 consume 之間仍有極窄的 TOCTOU 窗 | consume 會再驗一次，窗內失敗即 fail closed | 否 |
| 同帳號程序可直接改 approval store | 與產品信任模型一致 | 否 |
| 每次觀察重算完整 preview、無上限 | 每個未決 approval 每次觀察都串流雜湊所有變更檔案並模擬 merge，共用 30 秒 deadline；dialog 每 5 秒 inspect 一次 | **會失效**——大 repo ＋ dirty main 會反覆撞上 deadline，觀察持續回 `unavailable`、confirm 一直不可用。5-5 前需節流／快取／提高上限 |
| 讀取路徑會寫入，而該 GET 端點沒有 Origin 檢查 | 實際緩解只有 `HttpOnly; SameSite=Strict` cookie（`src/ui/web.ts:371`）＋ Host pinning（`src/ui/web.ts:345-346`）＋ loopback-only（`src/ui/web.ts:341-343`）；唯一可能的寫入是 fail-closed 方向的失效 | 否（本階段可接受），但**任何放寬 cookie 或 Host pinning 的變更都必須同時為它補上 Origin 檢查** |
| 紀錄不再宣告 candidate／checkpoint／recovery ref 目前是否存在 | 舊版寫死 `*Retained: true`，實測為假；現在只宣告「這次失效沒有刪除任何東西」 | 否——要知道現況請查 `candidate_status` 或 Git |

完整清單（含已解決項目與其歷史）見 [[DECISIONS]] ADR-034「代價與殘餘風險」。

## Merge approval dialog 真實瀏覽器驗收（2026-08-06）

**為什麼需要這一列**：dialog 有 704 行新程式碼，先前的「測試」形如
`assert(/input.disabled = !ready;/)`——只要那行字串存在就通過，**即使它從未執行**。
未接上的 listener、上方提早 return、字串內被改名的變數，全都照樣通過。
而 scroll-gate 是 Owner 用來取代抄寫 taskId 的唯一保護，不能只有源碼證據。

**方法**：Chrome 載入真實 `public/room.html` 與真實 `public/room.js`（loopback 靜態伺服器），
用真實 DOM、真實 `scroll`／`input` 事件與真實 `setInterval` 時鐘驅動，讀取真實的
`input.disabled` / `button.disabled`。所有數值都是瀏覽器回報的，不是對源碼比對。

| 行為 | 實測結果 | 證據 |
| --- | --- | --- |
| diff 未捲到底 → 輸入框鎖住 | 通過 | 區塊真的溢出（scrollHeight 2250 / clientHeight 284）、60 列真實 DOM、scrollTop 0 → `inputDisabled true` |
| 捲到一半 → 仍鎖住 | 通過 | scrollTop 983 → `mergeApprovalScrolled false`、`inputDisabled true` |
| 捲到底 → 輸入框解鎖、按鈕仍鎖 | 通過 | scrollTop 1966.5 → `inputDisabled false`、`buttonDisabled true`（scroll listener 確實有掛上） |
| 短語必須精確相符 | 通過 | 尾端多一空白 → 鎖住；全小寫 → 鎖住；`MERGE INTO MAIN` → 解鎖 |
| 阻擋項壓住一切 | 通過 | 模擬衝突（2 項）、檔案清單截斷（1 項）、綁定失效（1 項）三種情況下 `inputDisabled` 與 `buttonDisabled` 皆 true，風險徽章翻成「高風險 · HIGH」 |
| 阻擋解除後不得帶著舊短語自動解鎖 | 通過 | 走完整轉換（已武裝 → 出現阻擋 → 阻擋解除）後 `input.value === ""` 且 `buttonDisabled true`，必須重打 |
| TTL 真的倒數並在到期時停用 | 通過 | 真實時鐘連續取樣 `00:03 → 00:02 → 00:01 → 00:00 → 已逾時 · expired`；到期當下按鈕由 false 翻成 true、加上逾時阻擋項、狀態列顯示重新產生預覽的指示 |

**觀察（非缺陷）**：`formatCountdown` 用 floor，所以到期前最後 <1 秒顯示 `00:00` 而按鈕仍可按。
方向是安全的——它在仍然有效時顯示 00:00，而不是在已逾時後還顯示剩餘時間。

**這一列沒有涵蓋的部分（誠實邊界）**：
- 只涵蓋 client 端的 gate。**沒有**涵蓋伺服器往返：實際 POST 消耗核准、CSRF、以及伺服器端
  重新驗證 13 個綁定值的路徑，仍然只有 Node 端測試涵蓋。
- 沒有涵蓋 `openMergeApprovalDialog()` 的載入路徑（它需要後端）；ticker 是依照
  `public/room.js:3195` 同樣的方式手動啟動的。
- 未涵蓋鍵盤操作、螢幕閱讀器與觸控裝置上的捲動判定。
- **殘餘風險**：這是一次手動驗收，不會在 CI 重跑。它會隨 dialog 改動而失效。
  真正的修補是 DOM 測試執行器，已列為 D-006 待 Owner 裁決（新增執行期相依 ＋ SBOM 變更）。

## Merge approval dialog 第二次瀏覽器驗收（2026-08-06，含一個 fail-open 缺陷的修復）

**為什麼會有第二次**：第一次驗收之後 `0fbee58` 改動了 `mergeApprovalBlockers()`——那正是第一次驗收
四項行為之一（「阻擋項壓住按鈕」）所依賴的函式。新加的
`test/merge-dialog-acceptance.test.ts` 在第一次執行時就抓到這件事：它把驗收涵蓋的九個函式雜湊起來，
與本檔記錄的值比對，不符即紅燈。**驗收紀錄過期的問題不再靠記性發現。**

**重跑時發現的缺陷（已修）**：`valid === false` 的分支額外要求 `changed` 非空才推入阻擋項。
若伺服器回 `{valid:false, changed:[], unavailable:undefined}`，**畫面上一個阻擋項都沒有，
而且「合併進 main」是可按的**——在寫入 main 前的最後一道關卡上 fail open。

**可達性**（不是理論風險）：`src/core/candidate-registry.ts:3263` 對終局或已逾時的核准回傳的正是
`{checked:false, valid:false, changed:[]}`。此時若瀏覽器的倒數尚未跑到（時鐘偏移、tick 未觸發），
`approval.state` 仍是 `requested`、`approval.expired` 仍是 false，三個分支同時落空。
修法：`valid === false` 一律推入阻擋項；有具名欄位就列出，沒有就明說「伺服器判定不再有效但未指出欄位」。
**修正 lie 的方式是說實話，不是沉默。**

**實測結果**（真實 Chrome、真實 DOM／事件、修復後的程式碼）：

| 情況 | 阻擋項 | 輸入框 | 按鈕 |
| --- | --- | --- | --- |
| 綁定正常 | 0 | 可用 | 可按（唯一該可核准的） |
| 綁定確實改變（具名欄位） | 1，列出欄位 | 停用 | 停用 |
| 檢查無法完成（`unavailable`） | 1，說明無法比對 | 停用 | 停用 |
| **`valid:false` 但 `changed` 空** | **1（修復前為 0）** | **停用** | **停用** |

**方法上的一個教訓**：第一次重測時，`valid:false + changed 空` 仍顯示 0 個阻擋項——因為**瀏覽器
快取了舊的 `room.js`**，我測到的是修復前的程式碼。現在測試腳本會先斷言執行中的函式含有新訊息，
**舊快取會直接拋錯而不是產生假通過**。這一條寫進 PITFALLS。

**已接受的 gate digest**：`b7d2dc961e7ae5f415e9d35dcf58a2bf53d140d8d57e5165c779cff0d4ae2c8b`

**這一列沒有涵蓋的**：仍然只涵蓋 client 端；伺服器往返、CSRF 與 13 個綁定值的伺服器端重驗只有 Node
測試涵蓋。**仍然是手動驗收**，只是現在有東西會在它過期時叫你。真正的修補是 DOM 測試執行器（D-006，
待 Owner 裁決：新增執行期相依＋SBOM 變更）。

## Phase 5-5 通過標準（開工前先訂，2026-08-06；**同日修訂 v2**）

**5-5 是第一個真的寫入 canonical main 的操作。** 前面每一階段失敗的代價是浪費一個 worktree；
從這裡開始，失敗的代價是 Owner 的主專案。

**v2 修訂的理由**：v1 寫好後、實作開工前，派了一位審查員專門攻擊這份標準本身
（做法源自 5-4 的教訓——5-4 的標準也是開工前先訂的，仍有三項是靠措辭漏洞過關）。
它在臨時 repo 上用真實 git 跑出三個實測，證明 v1 **可以被完整滿足、同時弄壞 Owner 的主專案**：

- **實測 A**：main 的 `git status --porcelain` **完全乾淨**（滿足 v1 的「工作樹不乾淨時拒絕」），
  `git merge` 仍**靜默覆蓋** Owner 的 ignored 檔案內容，零警告零衝突。
- **實測 B**：接著用 `git reset --hard <前一個 HEAD>` 回滾——那個檔案**直接消失**，
  不是還原成原內容。v1 第 4 項的「工作樹回到操作前的狀態」用最自然的實作方式**證明做不到**，
  而 v1 列的四種失敗測試沒有一種會設置出這個情境。
- **實測 C**：在 `pre-merge-commit` hook 執行中 `kill -9` 掉 git。結果 **HEAD 沒動、沒有 `MERGE_HEAD`、
  `git merge --abort` 用不了**，但 **index 與工作樹已被完整改寫**，`git status` 顯示成一般的
  「Changes to be committed」——**與 Owner 自己 stage 的工作在位元層級無法區分**。
  隨後一次無關的 `git commit` 把那次半套用的 merge **靜默包了進去**。
  這正是不變式宣稱不存在的狀態，而 v1 的四個中斷點照字面測**會給出綠燈**。

另已實測：**candidate worktree 可經 `git config --local` 直接寫進 main 的 `.git/config`**
（linked worktree 共用 common dir）。因此一個 Native Full-Trust 終端 agent 可以在 preview 之後、
promotion 之前設定 `core.hooksPath` 指向 candidate 內的檔案，**promotion 會以 Owner 身分、
無沙箱、無逾時執行它**。5-5 是第一個執行 `.git` 內程式碼的階段，這是它引入的新信任邊界。

**審查員只准對照下列清單裁決。** 認為標準仍有漏洞是獨立的一項發現，要分開講。

### 不變式

一次 promotion 的結果只能是兩者之一：**完整套用到 main 並被記錄**，或
**main 與 candidate 都回到操作前的狀態並被記錄**。不存在「部分套用而且沒有人知道」的中間態。

**在對 main 執行第一個會寫入的 Git 指令之前，必須先持久化一筆 `promoting` 意圖紀錄**，內含：
approvalId、pre-HEAD、**pre-index 指紋、pre-工作樹指紋（含 ignored 路徑與其內容雜湊）**、
以及將被執行的 hook 清單與其內容雜湊。任何崩潰點重啟後，系統只從 durable 狀態重建答案，
並回報**已套用／未套用／需要人工檢查**三者之一。
**「需要人工檢查」是合格答案，「我不確定，所以幫你重試一次」不是。**

**重啟後的 reconciliation 一律唯讀**：可以讀 Git、比對指紋、回報，但**不得對 main 執行任何寫入型
Git 指令**（不得 `reset`、`checkout`、`merge --abort`、`clean`、`stash`、改 `.git/config`、刪任何 `*.lock`）。
復原動作一律由 Owner 在看到具名差異後手動執行。
（理由：v1 只禁「自行重試」沒禁「自行回滾」，而依實測 C，自動回滾無法區分半套用的 index 與
Owner 自己的工作，`git clean` 更會刪掉未追蹤與 ignored 檔案——這是 v1 之下最可能真實發生的災難。）

### 通過標準（十項，全部成立才算通過）

1. **只有仍描述現況的核准能寫入 main，且 promotion 是有意圖紀錄的兩段式操作。**
   順序固定為：驗證綁定 → 寫入 `promoting` 意圖紀錄（含全部 pre-op 指紋）→ 消耗核准 → 寫 main →
   寫入終局結果。**任何相鄰兩步之間的崩潰都必須能由意圖紀錄唯一決定後續判讀**，結果必須是三態之一。
   以下四個窗各以真實 `kill -9` 驗證一次：意圖紀錄寫入中、核准消耗的 SQLite 寫入中、merge 寫入中、
   終局結果寫入中。
   **核准一旦消耗即為終局，任何路徑都不得把它改回 `approved` 或重新發放 token**——
   失敗時 Owner 重新 preview 再問一次，這是刻意的摩擦。
   （SQLite 交易與 Git commit 不可能是同一個原子單位，所以 v1 要求的「兩者不得同時存在」
   沒有任何實作能真的滿足；正確的形狀是寫前意圖紀錄＋確定性收斂，這也正是 `CLAUDE.md`
   對 apply-back 早已寫下的規則「必須先持久化進入 `applying` 才能修改主專案」。）

2. **崩潰安全，用真實的 kill 證明，且必須在新的 OS 程序中重啟。**
   可中斷點至少：核准消耗後／checkout 前、**merge 已寫入 index 與工作樹但尚未 commit（hook 執行中）**、
   merge commit 寫入中、hook 執行中且該 hook 會修改工作樹、記錄寫入前。
   每一個中斷點都必須：
   - 以 `kill -9` 對**真實 OS 程序**執行，重啟必須是**另一個新程序**，答案只能從 durable 狀態重建；
     **不得在同一程序內呼叫 reconcile 函式冒充重啟**。
   - 回報三態之一，**且在「需要人工檢查」時具名列出 main 目前與 pre-op 指紋不同的每一個面向**
     （HEAD／index／工作樹路徑／ignored 路徑／殘留的 `MERGE_HEAD`、`AUTO_MERGE`、`index.lock`）。
     **「需要人工檢查」而不說出哪裡不同，等同不合格。**
   - **不得自行重試，也不得自行回滾。**
   - candidate 與 recovery ref 完好，Owner 有一條**可複製貼上的**復原指令。
   - **promotion 啟動的所有子程序（含 hook 及其子孫）必須在結束或中止時被證明已終止**
     （斷言整個 PGID 消失）。實測 C 顯示 git 被 kill 之後 hook 的子程序仍然活著。

3. **關閉前置條件 3／4／5／6，每一項各有測試。**
   - **Hooks**：必須實測 hook 真的被執行過（hook 寫檔案，斷言檔案存在），且必須**各別**實測
     `pre-merge-commit` 非零退出與 `post-merge` 非零退出，並**斷言失敗後 main 的 index 與工作樹
     已回到 pre-op 指紋**。hook 必須有**明確的逾時、輸出上限與程序樹終止**，以一個會掛住的 hook 實測。
     **`core.hooksPath`、`.git/hooks/**` 的內容雜湊、`merge.*.driver` 與 `filter.*.clean/smudge`
     設定必須納入 approval 綁定**，並在核准畫面上**逐項列出本次會執行的 hook 檔名與雜湊**。
   - **main 工作樹不乾淨時拒絕**：「乾淨」必須明文定義，且必須**同時**排除：`git status --porcelain` 非空、
     存在 `skip-worktree`／`assume-unchanged` 項目、啟用 sparse-checkout、存在 `MERGE_HEAD`／
     `REBASE_HEAD`／`CHERRY_PICK_HEAD`／`index.lock`、存在 submodule 且其工作樹非乾淨、
     `.gitattributes` 或 `.git/config` 含 `filter=lfs` 或任何 `clean`／`smudge` filter。各有一條拒絕測試。
     （已實測：`git update-index --skip-worktree` 讓 `status` 完全空白，真實 merge 卻以 exit 2 中止，
     且**每次重試都會以同樣方式失敗**——第 4 項的「恢復後可重新成功」在此形狀下永遠為假。）
   - **ignored 檔案內容**：`mainIgnoredFingerprint` **必須升級為涵蓋內容**（在既有 30 秒串流雜湊預算內），
     並在核准畫面上**逐一列出**「這次合併會覆蓋的 ignored 檔案路徑」。
     **「顯示一句通用警告」不滿足本項**——一行常數文案是 PITFALLS #86 的同形違反。
     必須有一條測試：main 有一個 ignored 檔案、candidate 的 commit 含同路徑，
     斷言在核准前就具名呈現，且 Owner 未確認即拒絕。
   - **preview 重算節流**：逾時必須是可讀狀態，且必須以一個實測會超過原 deadline 的 fixture
     證明節流後 dialog 仍可達到可核准狀態。

4. **失敗必須可回復，用真實失敗證明，而且「回到操作前」以指紋定義。**
   「操作前的狀態」＝意圖紀錄中的 pre-op 指紋，逐項比對：HEAD、index、tracked 工作樹內容、
   **未追蹤檔案**、**ignored 檔案的路徑與內容**、stash、reflog、`.git/config`、`core.hooksPath`、
   worktree 註冊、submodule 的 HEAD 與工作樹、sparse-checkout／`skip-worktree` 位元，
   以及 `.git` 內不得殘留 `MERGE_HEAD`／`AUTO_MERGE`／`MERGE_MSG`／任何 `*.lock`。
   至少用**五種**真實失敗各驗一次：磁碟唯讀、hook 非零退出、merge driver 失敗、中途 kill、
   **main 上存在會被覆蓋的 ignored 檔案**。
   每一種都必須額外斷言「環境恢復後仍可正常重新發起並成功」，且**「環境恢復」只允許是
   「還原被刻意破壞的外部條件」與「重啟程序」；測試不得手動修改或刪除 `.git` 內的任何檔案**。
   **回滾不得使用 `git clean` 的任何形式，也不得使用會刪除未追蹤或 ignored 檔案的指令**；
   若某種失敗無法在不破壞這類檔案的前提下回滾，**正確答案是事前拒絕該次 promotion，不是事後清理**。

5. **留痕，而且痕跡必須為真、必須涵蓋失敗。**
   audit 與公開帳本必須記錄成功與失敗**兩條路徑**，每一個事實斷言都必須是觀察來的：
   - main 的 **HEAD 在 promotion 前與後各觀察一次並都記錄**；若兩者相同，必須明說
     「main 未產生新 commit（no-op）」，**不得只記一個 commit id 就宣稱已套用**。
   - 記錄實際執行過的 hook 檔名與退出碼（觀察來的），不得記 `hooks: ok`。
   - 失敗與回滾也必須各留一筆終局紀錄，含具名失敗原因與**回滾後逐項指紋比對的結果**。
     **一次無聲的失敗與一次從未發生的 promotion，在紀錄上必須可區分。**
   - **audit／ledger 寫入失敗不得觸發任何對 main 的寫入**；已套用就是已套用，
     必須以 fail-loud 的獨立錯誤碼標記，並在下次啟動時仍能由意圖紀錄重建。
   - 「誰核准」必須指向可稽核的 approval row 與其 `decided_by`／`previewDigest`，不得是自由文字常數。
   - audit hash chain 與 room chain 事後 `verify()` 必須為 true，
     **並且必須另外斷言預期的紀錄筆數與內容存在**——空鏈永遠 verify true，不算證據。

6. **同一個 candidate 只能被套用一次。** promotion 成功後 candidate 必須轉為終局 `merged`；
   對已 `merged` 的 candidate 再次 preview／request／promote 一律拒絕並具名。
   必須有一條測試：完成一次 promotion 後重新 preview 並嘗試第二次，斷言在核准前即被拒絕。
   （`CandidateStatus` 已有 `merged` 這個值，目前程式碼裡沒有任何地方設它。
   若 Owner 在中間 revert 了那次合併，第二次 promotion 會**靜默地把 Owner 明確撤銷的變更重新套回去**。）

7. **promotion 期間對 main 具有排他性。** 開始前必須確認 `.git/index.lock` 不存在
   （存在即拒絕，**不等待**），並在整個期間持有一個可觀察的排他標記；
   期間偵測到 main HEAD／index 被外部改動即中止並走第 4 項的回復路徑。
   必須有一條測試模擬外部程序在 checkout 與 commit 之間推進 main。
   （綁定檢查與實際 merge 之間的 TOCTOU 窗，在 5-5 從幾毫秒放大到整個 checkout＋hook 執行時間。）

8. **取消語意明文化。** promotion 一旦開始即不可取消：UI 不得呈現取消控制項；
   任何關閉分頁／中斷連線都不影響已開始的 promotion，其結果由第 1／2 項的意圖紀錄決定。

9. **真實瀏覽器驗收，但第一次不准打在真實主專案上。**
   - 先在**拋棄式 repo** 上由 Owner 在 GUI 完成一次成功 promotion **與一次真實失敗＋回滾**，
     兩者各記一列 dated live-acceptance。
   - 之後才允許對真實 main 執行，且執行前必須有**已驗證可還原的完整備份（含 `.git`）**
     與已記錄的 pre-HEAD，備份完成的事實由 Owner 確認後才可繼續。
   - gate digest 必須**同時涵蓋伺服器端 promotion 路徑的函式**，不得只雜湊 `public/room.js`。
   （v1 要求「走完一次真實 promotion」卻沒規定在哪個 repo、沒要求備份——
   **滿足那一項的動作本身就是風險事件**。）

10. **明文承認並列入殘餘風險表**：promotion 會以 Owner 身分、在無沙箱的情況下執行 repo `.git` 內
    設定的 hook 與 merge driver。此項若不納入第 3 項的綁定與揭露，**即為未關閉的前置條件，
    不得以殘餘風險接受**。

### 可接受的殘餘風險（連同「何時失效」一起列，未列出的不得事後補認）

| 殘餘風險 | 為什麼此階段可接受 | 何時失效 |
| --- | --- | --- |
| promotion 是本機單機操作，不處理遠端 push | 專案守則禁止自動 push，發布一律需人類批准 | 若未來加入自動化發布，立即失效 |
| 不支援 merge 進行中的互動式衝突解決；有衝突就拒絕 | 有衝突時 Owner 本來就該自己看 | 若要支援 rebase／squash 等策略，需重訂 |
| 單一 candidate → 單一 main，不處理多 candidate 排隊 | 結構上每 task 僅一筆未結核准 | 若開放多 candidate 併發 promotion，立即失效 |
| submodule 與 LFS **偵測到即拒絕**，不做完整支援 | 兩者都會讓「回到操作前」變成無法保證 | 若 Owner 的專案開始使用，必須改為完整支援；**不檢查不算可接受** |
| P0-2（Writer apply-back 仍是 `window.prompt`）不在 5-5 範圍 | 那是另一條寫回路徑，與 candidate promotion 不同機制 | **9/1 之前必須有結論**：要嘛做，要嘛明文記為不做 |

**已從殘餘風險移除、改列為必修**：

| 原殘餘風險 | 裁決 |
| --- | --- |
| `mainIgnoredFingerprint` 只涵蓋路徑不涵蓋內容 | **不接受。** 實測 A＋B 證明是兩段式資料損毀：merge 靜默覆蓋 Owner 的 ignored 檔案內容，回滾時該檔案被刪除。必須升級為內容指紋並逐項揭露，**不得以「讓 Owner 看見風險」了結** |

### 明確不在 5-5 範圍

- Phase 5-6（rollback／recovery 的專用介面）。**建議 5-5 完成即為 Phase 5 停點**：
  recovery ref、`orchestrator candidates orphan-refs` 與 dialog 內可複製的 `git reset --hard <ref>`
  已構成可用的復原路徑；5-6 是把已存在的路徑包裝得更好。**此項需 Owner 裁決。**
- 所有 UX P1／P2。

## 主工作區 apply-back dialog 瀏覽器驗收（2026-08-06）

**背景**：UX P0-3。`public/app.js` 的 apply-back 原本按一下 `window.confirm` 就把隔離 worktree 的
變更寫回主專案——**沒有風險等級、沒有 diff、沒有確認短語**，而同一產品的 candidate → main 路徑
要求捲完 diff 再打 `MERGE INTO MAIN`。這一項先前被靜默丟掉，紀錄還誤記為已完成。

**方法**：Chrome 載入真實 `public/index.html` 與真實 `public/app.js`（loopback 靜態伺服器），
依真實流程 `ensureApplyBackDialog()` → `dialog.hidden = false` 顯示後再渲染，
用真實 DOM、真實 `scroll` / `input` 事件驅動，讀取真實的 `input.disabled` / `button.disabled`。
**測試開頭先斷言區域幾何確實溢出**（clientHeight 284 / scrollHeight 5874），否則作廢——
零高度的區域「已經在底部」，會讓 scroll-gate 假通過。

| 行為 | 實測結果 |
| --- | --- |
| 未捲動 → 輸入框鎖住 | 通過（`inputDisabled true`，`scrolled false`） |
| 捲到一半 → 仍鎖住 | 通過（scrollTop 2795 → 仍 `false`，scroll listener 確實有掛上） |
| 捲到底 → 輸入解鎖、按鈕仍鎖 | 通過（scrollTop 5590 → `inputDisabled false` / `buttonDisabled true`） |
| 短語尾端多空白 | 通過（按鈕維持鎖住） |
| 短語全小寫 | 通過（按鈕維持鎖住） |
| 短語精確相符 | 通過（按鈕解鎖） |
| **diff 讀取失敗 → 阻擋項** | 通過（輸入框重新鎖住**且值被清空**——看不到要寫回什麼就不可核准） |

這一列補上了實作代理明確列為無法自行驗證的部分：**scroll 事件真的有綁上、`disabled` 真的有寫回 DOM**。
它自己的測試是用 `node:vm` 執行抽出的純函式（並附突變測試證明測試不是空的），涵蓋邏輯但不涵蓋佈線。

**已接受的 gate digest**：`a3e2ca3b2d7dfdfa2043c0fb514b7167c6a225a5d24aa8076724511a0ec53c98`

**這一列沒有涵蓋的**：
- 後端仍是 `/api/apply-back/*`，其 preview hash、逐檔 CAS、single-use approval 只有 Node 測試涵蓋。
- **使用者輸入的短語是 UI gate，不是送給後端的協定 token**（後端要的是 `APPLY BACK TO SOURCE`，
  由前端當常數自動送出）。room.js 那條是與 preview 密碼學綁定的，**這一條不是**——
  這是兩條路徑之間尚存的實質差異，不只是文案差異。
- TTL 只有 120 秒，捲完長 diff 再打短語仍可能逾時；broker 的 pending 上限是 4。

**仍未關閉的第三條路徑**：`public/room.js:2561` 的 Writer apply-back（P0-2）**仍是 `window.prompt`**，
短語仍是識別碼化的 `APPLY WRITER <taskId> TO PROJECT`。P0-3 修完後落差從 2:1 變成 1:2，並未消滅。

## ADR-028 vNext 待驗證矩陣

| 範圍 | 狀態 | 必要證據 |
|---|---|---|
| 加入前後 Native capability 一致 | 待實作／待驗證 | Codex、Claude Code 分別驗證 filesystem/shell/Git/network/subagent 不被 Orchestratory 降權 |
| Exact terminal seat discovery | 已實作／synthetic 已驗證；live 待驗收 | 兩個獨立 service connections／MCP brokers 能列出彼此，`providers` 與 `terminalSeats` 分離，self identity 正確；`test/collab-mcp.test.ts` |
| Authenticated peer send/thread | 已實作／synthetic 已驗證；live 待驗收 | server-bound source、same Room/workspace、standby approval、UUID exact target、stable client request id、無 provider fallback、三席 hijack 拒絕、immutable reply prepare、delivery-scoped await、雙向 follow-up thread；`test/collab-mcp.test.ts`、`test/collaboration-service.test.ts`、`test/room-inbox.test.ts` |
| Thread 無固定 round ceiling | 已實作／synthetic 已驗證；live 待驗收 | 同一 thread 自動驗證 20 輪仍延續；transport timeout 後重新 await／reply 不終止 thread；`test/collaboration-service.test.ts`、`test/collab-mcp.test.ts` |
| Candidate lifecycle | 已實作／synthetic 已驗證；live 待驗收 | Git worktree＋row-hash SQLite 保存 task/base/main/candidate/checkpoint；dirty main 原地保留且不複製，ignored 只記數量／路徑指紋；每個 checkpoint 建立並驗證獨立 Git ref；超過舊 2 MiB ceiling 的 diff/dirty/untracked/ignored inventory 仍以串流精確計數；所有 changed content（含超過 50 MiB）在每次 inspection 共用 30 秒 deadline 內串流雜湊，逾時 fail closed；clean committed HEAD、跨程序狀態、篡改、realpath、unsafe filter、HEAD/dirty/ignored drift、deterministic TOCTOU 拒絕與 canonical main branch/worktree 不變測試；`candidate_status` 對同一查詢的 main snapshot 只讀一次；`test/candidate-registry.test.ts`、`test/worktree-broker.test.ts`、`test/process-runner.test.ts`、`test/git-broker.test.ts`、`test/collaboration-service.test.ts`、`test/collab-mcp.test.ts` |
| Task completion merge prompt | 已實作／synthetic 已驗證；GUI/live 待驗收 | `candidate_complete` 直接詢問是否將精確 snapshot merge 到 main，並回傳 digest、diff/test/risk/conflict/drift/recovery ref 與 `owner-required`；目前不改 canonical main branch/worktree，但會建立 shared Git recovery ref；`test/candidate-registry.test.ts`、`test/collab-mcp.test.ts` |
| Candidate mutation request idempotency | 已實作／synthetic 已驗證；live 待驗收 | `candidate_start`／`candidate_checkpoint`／`candidate_complete` 均要求 stable UUID `clientRequestId`。Registry schema v3 的 `candidate_requests` **以 `client_request_id` 單欄為主鍵**：seat 身分刻意不入 key，因為 presence lease 逾時後重連會重鑄 display name（`codex1`→`codex2`），而那正是本 ledger 要存活的故障；若把它放進 key，重連後的重試會鑄出第二個 candidate。`actor` 保留供稽核。Replay 仍要求 operation、room 與 input digest 三者完全相同，因此重用 key 只可能取回同一個邏輯請求；不同則回 `CANDIDATE_REQUEST_IDEMPOTENCY_CONFLICT` 且不執行任何 mutation。reserve 時即鑄造 taskId／candidateId／checkpointId／completionId 並持久化；replay 與 crash 後的收斂**一律從 durable state 重建答案**，receipt 只是固定大小標記，故大型 completion 不可能撐破 receipt 上限。checkpoint ref 建立採「已存在且指向同一 head 即採納」，避免中斷留下的孤兒 ref 讓同一把 key 永久失敗，指向不同 commit 才回 `CANDIDATE_CHECKPOINT_REF_CONFLICT`。**同一程序內的併發以記憶體內精確鎖處理**：同一把 key 同時只允許一個執行中，併發呼叫回 `CANDIDATE_REQUEST_IN_FLIGHT`（另有 `CANDIDATE_REQUEST_RECOVERING` 表示先前嘗試留下半建立的 candidate：該列由 `CREATING_RECOVERY_GRACE_MS` 的 wall clock **與** 保留的 `owner_pid` liveness 共同決定——擁有者仍存活即持續守護，可證明已死則交由既有 worktree 證據解析，**且不寫入帳本**，因此同一把 key 的重試仍能收斂而非被迫鑄新 key；liveness 判準的不確定性見 [[THREAT_MODEL]] F20）；**跨 OS process** 則由 reservation 的不透明 `owner_token` 擋下——採用既有保留時會重鑄該 token，原建立者中止時的 discard CAS 因此不再匹配，無法刪除他人正在使用的保留。token 刻意不從時鐘推導（時間戳在同一毫秒內不會改變，曾因此讓保護在窄窗內失效），且**每一個對 `candidate_requests` 的寫入都必須帶 token**——這是結構性不變式而非逐呼叫點檢查，因為先前只有 discard 帶 token、settle 沒有，陳舊席位得以覆寫現任持有者的判決並讓一個邏輯請求產出兩份 durable 成果；schema 因此升至 v3，v2→v3 直接重建這張輔助表（僅使升級當下在途的 key 停止重播，不觸碰任何權威資料）；`succeeded` 為終局狀態，輸家無法覆寫贏家的判決（內部不變式，非對外狀態碼）；`start` 的 replay 不會回傳已離開 `active` 的 task，改回 `CANDIDATE_REQUEST_TASK_NO_LONGER_ACTIVE`，避免把已完成甚至已合併的 candidate 當成新 start 交還；已記錄 `failed` 的 key 回 `CANDIDATE_REQUEST_FAILED_RETRY_WITH_NEW_KEY`，並保證換新 key 有前進路徑。**本次呼叫自己建立、且尚未產生任何 durable artifact 就中止的嘗試會刪除該保留**。採用他人保留的嘗試即使沒產生成果也不刪除（保留可能已擁有 candidate row、worktree 或 ref），因此**採用路徑的中止仍會留下 `pending` 列**；ref 建立失敗**不再一律記為 `failed`**：只有 allowlist `DETERMINATE_REQUEST_FAILURES` 內的確定性錯誤碼才終局化，暫時性失敗（權限瞬斷、spawn 失敗、SQLite 錯誤、刻意模糊的 `CANDIDATE_GIT_COMMAND_FAILED`）讓該列維持 `pending` 以便同一把 key 收斂。已用真實失敗驗證（`chmod 500 .git/refs`、`PATH=""`、`chmod 500 .git/worktrees`、以及**時鐘倒退**打在啟用那一刻導致 worktree 已建好卻被判 failed），每一條都先在修復前的基準確認會失敗，且都斷言「環境恢復後同一把 key 仍能成功」。room id 在寫入 request row 前即以 ROOM_PATTERN 驗證，未知或跨房間 taskId 在 reserve 前即被 `#assertScoped` 擋下，寫入嚴格度不低於讀取。**`candidate_requests` 刻意不納入開啟時的 `#verify()`**：它是輔助重試帳本，`candidates`／`candidate_checkpoints` 才是權威記錄，一列不可讀不得讓 durable 資料整體無法開啟；每列改於讀取時以 row-hash 驗證，壞列只毒化自己那把 key。v1 資料庫以純加表方式升級，既有 row 與其 hash 不變。孤兒 recovery ref 可由 `orphanRecoveryRefs()` 唯讀列出且**不自行刪除**（刪 ref 屬破壞性 Git 操作，需 scoped approval），現已有唯讀 CLI 出口 `orchestrator candidates orphan-refs <workspace>`：只列不刪（刪 ref 屬破壞性 Git 操作，需 scoped approval），路徑過 `workspaces.assertAllowed()`，輸出只含 ref 名、commit id、task id 與孤兒理由，掃描達上限會標示。帳本無 TTL 亦無 prune，僅由 `inventory()` 的 `requests`／`requestsPending` 曝露成長。`test/candidate-registry.test.ts`、`test/collab-mcp.test.ts`、`test/collaboration-service.test.ts` |
| Snapshot-bound approval | 已實作（後端）／synthetic 已驗證；頁內 dialog 與 live 待驗收 | `main_merge_preview` 由 live state 重算整份 snapshot 且**不寫入任何東西**（無 row、無 ref、無 worktree）；`main_merge_request` 以 stable UUID `clientRequestId` 建立 `requested` 記錄，**要求不等於核准**——它不含 token、不授權任何事。核准只能由 owner 介面經 `POST /api/rooms/merge-approvals/approve` 產生，需精確短語 `MERGE INTO MAIN` 與 dialog 實際顯示的 `previewDigest`。approval 至少綁 `taskId`／`completionId`／`roomId`／`mainPath`／`mainBranch`／`candidatePath`／`baseMainHead`／`candidateHead`／`mainHead`／main dirty 與 ignored fingerprint／`recoveryRef`／`previewDigest`；**綁定在建立、核准與消耗三個時點各驗一次**，任一值改變即以 `MAIN_MERGE_APPROVAL_BINDING_CHANGED:<改變的欄位名>` 拒絕並把該 approval 轉為終局 `invalidated`，不靜默重算。single-use 由 `state`＋`row_hash` 的 compare-and-set 保證：兩個並行消耗只有一個成功，輸家得到 `MAIN_MERGE_APPROVAL_ALREADY_CONSUMED`；token 只在 `approved` 期間以 SHA-256 存在，離開該狀態即清除。短效：request 15 分鐘、grant 5 分鐘，逾時記為 `expired` 並拒絕。截斷（`filesTruncated`／`submodulesTruncated`／`mergeConflictsTruncated`）與模擬出的衝突都使 preview 不可核准，**寫入路徑與讀取路徑都擋**。拒絕、失效與逾時皆不執行任何 Git 指令，candidate、checkpoint 與 recovery ref 逐位元不變，owner 可重新 preview 再問一次。approval 只授權 `merge-candidate-into-main`，消耗時帶其他 action 一律 `MAIN_MERGE_APPROVAL_ACTION_NOT_GRANTED`，並在授權物件內明列 `notAuthorized`（push／publish／deploy／delete／cleanup…）。**本階段不寫入 canonical main**：`consumeMainMerge` 只做驗證與狀態轉移，沒有任何 MCP／HTTP 出口，promotion 屬 5-5。schema v4 新增獨立 `candidate_merge_approvals` 表（row-hash 完整性、scalar 與 preview 互為冗餘校驗、`state IN ('requested','approved')` 的 partial unique index 保證每個 task 同時只有一個未決問題），未動 v3 的 `candidate_requests` 帳本。`test/merge-approval.test.ts`、`test/merge-approval-web.test.ts`、`test/collab-mcp.test.ts`、`test/candidate-registry.test.ts` |
| Merge approval drift invalidation | 已實作（後端）／synthetic 已驗證；GUI/live 待驗收 | 每一條 approval 讀取路徑（`candidate_status`、`GET /api/rooms/merge-approvals`、`GET /api/rooms/merge-approvals/inspect`，以及 `main_merge_request` 重新提出請求時）在回報那一列之前先對 live state 重驗綁定，共用單一 `#observeMergeApproval`；漂移者在被回報前即持久轉為終局 `invalidated`，`refusal` 帶 5-3 同一套欄位名稱與 `drift-detected-on:<介面>`。**已核准後才漂移**的 approval 逐一驗證九個綁定值（`mainHead`／`mainBranch`／`mainDirtyFingerprint`／`mainIgnoredFingerprint`／`candidateHead`／`candidateWorktreeClean`／`recoveryRef`／`previewDigest`／`candidateStatus`）× 三條讀取路徑皆顯示失效並具名，且其餘兩條路徑立即一致；`token_hash` 於失效時清除。失效為 compare-and-set，三條路徑並行觀察同一次漂移只產生一筆事件，輸家改讀 store 現況回報。durable 那一列保留 `decided_by`，audit 鏈另記 `ownerHadGranted`／`observedOn`／`previousState`，因此「Owner 核准過但漂移作廢」與「從未有人核准」可區分；Room ledger（公開面）只列改變的欄位名，不含路徑、approval id 或 token，chain 與 audit chain 皆 verify 通過。失效後 `candidates`／`candidate_checkpoints` 兩張表、`refs/**`、main HEAD／tree／status 與 candidate HEAD／status 逐位元不變，recovery ref 仍指向該 candidate head，且可立即重新 preview 並提出新請求（`main_merge_request` 本身即為觀察路徑，漂移者不會佔住每個 task 唯一的未決名額）。**不誤殺**：ignored 檔案內容變動、無 `.gitattributes` 綁定的 merge driver、無關 branch／tag、mtime-only touch 後的 `update-index --refresh` 四者累加後 approval 仍為 `approved`、`bindingCheck` 仍為 `{checked:true,valid:true,changed:[]}`，且仍可被消耗。**暫時性失敗不燒核准**：綁定檢查逐欄位獨立探測，讀到且值不同才進 `changed`，讀不到一律進 `unverified`，任何例外都不會轉成「已改變」。`changed` 為空而 `unverified` 非空時，approval **不**失效、`token_hash` **不**清除、**不寫任何列**，只回 `{checked:false, valid:false, changed:[], unverified:[…], unavailable:"MAIN_MERGE_APPROVAL_BINDING_CHECK_FAILED"}`；環境恢復後下一次觀察回到 `{checked:true, valid:true, changed:[]}` 且**仍可成功 consume**。`grant`／`consume` 以獨立錯誤型別 `MergeApprovalBindingUnverifiableError`（`MAIN_MERGE_APPROVAL_BINDING_CHECK_FAILED:<欄位名>`）拒絕該次動作，但不轉為任何終局狀態（requested 仍 requested、approved 仍 approved）。已用**真實** Git／檔案系統失敗驗證三種形狀：main `.git` `chmod 000`、candidate worktree 改名離開再放回、PATH 內無 git 造成 spawn 失敗；三者皆斷言恢復後仍可 consume。反向亦驗證：真的刪掉 recovery ref 仍算漂移（`rev-parse --verify --quiet` exit 1 = ref 不存在，其餘 = 讀不到才拋錯）。同時「有欄位變了」又「有欄位讀不到」時仍以漂移處理，但 `changed` 只列實際比對過的那個。**紀錄不寫死事實斷言**：audit detail 的 `candidateRetained`／`checkpointsRetained`／`recoveryRefRetained` 三個常數已移除（先刪 recovery ref 再觀察，舊版仍宣稱「復原點完整保留」），改為只描述本次動作的 `deletedByThisInvalidation: "nothing"`，帳本文案同步改為「這次失效沒有刪除 candidate、checkpoint 或復原點」。逾時與終局列不重驗。**未動 schema**（v4 既有語意已足），v1→v4／v3→v4 升級與 v2 拒絕不變；未動 `candidate_requests`、`#mergePreview` 或 `#diff`；本階段仍不寫入 canonical main。`test/merge-approval-drift.test.ts`、`test/merge-approval.test.ts`、`test/merge-approval-web.test.ts` |
| Promotion/recovery | 待實作／待驗證 | recovery point 可讀、conflict/scope expansion 重批、成功/失敗/rollback 可驗證 |
| GUI Managed 隔離 | 待實作／待驗證 | Managed policy 不會改變已加入 Native terminal 的 capability |

本表區分「程式已實作且有本機自動證據」與「需要 owner 額度、外部 runtime 或發布決策」。
`已驗證` 不代表第三方認證或零風險；只代表下列表列 legacy 測試在目前 source tree 通過。

| 範圍 | 狀態 | 可重現證據 | 尚待事項 |
|---|---|---|---|
| Native Full-Trust／GUI Managed capability split | 已驗證（synthetic＋HTTP） | Native session、join response 與 `list_agents.terminalSeats` 固定回傳 `native-full-trust`／`host`／`unchanged`；GUI 文案明示 join/standby 只控制協作；managed seat 回傳 `gui-managed`／`orchestratory`／`read-only`／`owner-writer-lease-required`；Writer parser/service/API 排除 `origin=external`。`test/collab-mcp.test.ts`、`test/collaboration-service.test.ts`、`test/managed-room-agent.test.ts`、`test/web.test.ts` | 不會改寫既有 host 設定；真實 Codex＋Claude Code 新 session 仍待 vNext RC smoke |
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
| MCP terminal presence／GUI membership／session-scoped standby／wake truthfulness | 已驗證（synthetic＋HTTP＋Chrome live smoke） | owner-only SQLite schema v5、per-process UUID、canonical workspace exact match、5s heartbeat/15s lease、EOF unregister；`room_join_request` 只建立 GUI membership 申請，加入後 `room_wait` 另建立 exact-session 待命申請；Owner 核准後只有 active long-poll 是 `wakeable: true`，待命未核准時新交辦 fail closed，核准但 inactive 時 UI 誠實標示不可即時喚醒；待命 wait 上限四小時，Owner 撤銷、MCP cancellation、EOF 或 lease expiry 都會結束；無 provider fallback／替身。`test/room-presence.test.ts`、`test/room-inbox.test.ts`、`test/collab-mcp.test.ts`、`test/collaboration-service.test.ts`、`test/web.test.ts`。2026-07-23 Chrome 在 `orchestratory` 精確 Room 實測：加入申請→GUI membership 核准→`room_wait` 待命申請→GUI 待命核准→`wakeable`→GUI `@codex6` 精確收件／ack／回覆 `GUI_ROOM_WAIT_OK`→回覆後重新待命；GUI 撤銷立即令 open wait 回傳 `ROOM_STANDBY_REVOKED`，終端 stdio 關閉後 5 秒內人物與授權自動移除。2026-07-22 另已驗證跨專案切換不顯示該席位 | MCP client 可能自行施加低於四小時的 request timeout；任何 client-side 結束都必須由 Agent 再次呼叫 `room_wait`。完全 idle 的既有 host 不能接受 server-initiated turn；真正不依賴 external pull 的 GUI wake 使用分離的受控即時 Agent。既有 MCP child 必須由 host 重開才會載入新 tool schema |
| MCP Room collaboration mode | 已驗證（synthetic＋HTTP＋Chrome live smoke） | join 缺 mode／sync、未知 mode、跨 workspace 皆 fail closed；owner mode 與 turn sync 可獨立設定且 idempotent join 不可偷換；room-first `ask_*`／`compare_agents` 強制讀取 bound Room snapshot、append mention/lifecycle/reply、回傳 `readThroughSeq`，多 Agent 依序且後者能讀前者；seat-only standalone 不入帳；多 allowlist root 省略 workspace 仍使用精確 binding；`test/room-presence.test.ts`、`test/collab-mcp.test.ts`、`test/web.test.ts`。2026-07-22 Chrome 在精確專案 Room 分別核准 room-first＋turn sync off 與 seat-only＋turn sync on；兩個 zero-quota fake worker 的 room-first compare 依序入帳且第二次 cursor 包含第一個 reply，seat-only compare 前後 ledger count 不變；切換其他專案 Room 時兩個席位皆不可見，console 無 error | 只涵蓋 Orchestratory MCP broker；provider 原生 subagent 無法攔截。Structured hook turn sync 仍須 owner 另行安裝官方 CLI hooks，且不擷取 hidden reasoning／raw tools |
| Room mention 等待生命週期 | 已驗證（synthetic＋HTTP＋Browser live smoke） | `room_mention` 在真實 provider call 前追加綁定 mention reference 的「回應處理中」system event；GUI 只對 start 且尚無 reply/failure/cancel/clear 的 mention 顯示等待；backend cancel 不把 start event 誤當 resolved；`room_post` 的 provider-prefixed `@mention` 會 fail closed 並要求 `room_mention`；`test/collab-mcp.test.ts`、`test/web.test.ts`；Browser 驗證歷史 plain-text mention 重載後不再顯示幽靈等待 | 這是 append-only UI 狀態修正，不刪除、改寫或偽造既有帳本訊息；舊版進行中但未留 start event 的呼叫在重載後不顯示等待，但 provider timeout/failure 仍會正常入帳 |
| MCP 精確席位收件匣 | 已驗證（synthetic＋跨程序） | `queued→delivered→read→working→replied/failed/cancelled`、`room_wait/ack/reply/fail`、私有 lease token、斷線不誤耗重試、已讀後 bounded retry、取消、離線 fail、idempotent crash recovery、無 provider fallback；schema v4 保存 authenticated source/thread/reply-to，v3 既有 row 交易遷移並以 delivery ID 建立 legacy thread；`test/room-inbox.test.ts`、`test/collab-mcp.test.ts`、`test/collaboration-service.test.ts` | 真實外接 CLI 必須自行持續呼叫 bounded `room_wait`；待命未核准時新交辦拒絕，核准但沒有 active wait 時 GUI 只標示未值班，不宣稱即時喚醒；已安裝 MCP 尚未切換 vNext |
| Writer Lease／Writer Companion／子 Agent | 已驗證（synthetic＋跨程序 Workspace MCP＋Chrome live smoke） | resident／GUI Managed 可選 Writer；Native external 由 parser、service 與候選 API 排除，不套用 Writer Lease。升級對歷史 external active lease 也 fail closed：即使仍有 live run heartbeat，仍在單一交易中停止 run、撤銷 lease 與子委派，並保留 worktree/audit；assert、Workspace MCP 與 Web run 皆拒絕歷史 capability。task-scoped monotonic epoch、checkpoint 交接、精確 GUI cancel、HMAC technical audit、每次 mutation 重新 fencing；同 provider 子 Agent 與父 Writer 共用 task worktree 並由跨程序鎖序列執行，跨 provider 唯讀、禁止再轉派、父 lease 切換即撤銷；第二個 GUI 只保留 resident/managed 仍有 heartbeat 的 live run；`test/writer-lease.test.ts`、`test/writer-delegation.test.ts`、`test/collaboration-audit.test.ts`、`test/workspace-mcp.test.ts`、`test/collaboration-service.test.ts`、`test/web.test.ts` | 此列只證明 GUI Managed legacy workflow；不能拿來表示 Native terminal 被 Writer Lease 控制。真實非零檔案 mutation／apply-back 與 child executor 點擊仍需獨立、可回復的人工驗收 |
| Room 受控即時 Agents | 已驗證（synthetic＋HTTP＋Claude live smoke） | 外接終端與受控即時席位分離；API 明示 `executionClass=gui-managed`、`capabilityAuthority=orchestratory`、`conversationAccess=read-only`、`writeAccess=owner-writer-lease-required`、`managed-provider-call` 與 `wakeable: true`；owner-only `managed-room-agents.sqlite`、0600、strict schema、row hash、每房 12 席上限、room/workspace exact binding、獨立 display identity、per-seat single in-flight/cancel、共用 provider quota、read-only prompt；`test/managed-room-agent.test.ts`、`test/web.test.ts` 驗證建立、列出、獨立作者回覆與移除 | 每次喚醒目前是注入有界帳本尾段的無狀態 provider turn，不保證 provider-native session continuity；不得冒充既有外接 CLI session |
| Room GUI 導航、歷史、辦公室與 Writer 交辦 | 已驗證（HTTP／程式層／Browser） | 首頁整塊可點擊直播／歷史入口、room id URL 保留、最新起算每頁 100 則向前分頁與 allowlist；四個可點擊工位、環境光、桌面細節、Orbie 瞳孔／表情與六種固定休閒活動。2026-07-17 Browser 在 4391 驗證：點 Codex 只預填 `@codex` 並顯示內嵌 Agent 卡、歷史 backlog 不誤報新通知、任務中心只讀、日夜／安靜／休閒／全螢幕 fallback 可切換，1440×753 無水平溢位；Miso 四足與 Byte 雙足在 190ms 前後所有取樣 limb/body transforms 均改變、近遠腳反相，角色在地板範圍內且 console 無錯；真實工作 DND、目前角色、完成／失敗動畫由 `test/web.test.ts` 的 HTML／JS／CSS contract 覆蓋；Writer 面板的候選、grant/switch/run/cancel/complete 與 child executor 路由由 HTTP 整合測試覆蓋；2026-07-22 Chrome 實際點擊 Writer grant、run、checkpoint、complete 與零變更 apply-back | child executor 與非零檔案 apply-back 尚未做 Browser live smoke；寵物、休閒與顯示偏好只操作目前 DOM／RAM；真實 provider workflow 未為視覺動畫額外啟動 |
| Room macOS composer 鍵盤操作 | 已驗證（程式層／HTTP static contract＋Chrome 實機） | 帳本直播與辦公室 textarea 共用 `installMacComposerKeyboard`；Enter 第一次保留換行、1.6s 內第二次送出；Shift/Option 換行、Command+Enter 立即送出；IME composition/229、repeat、內容／caret 變化、blur、disabled submit 防誤送；`test/web.test.ts` 覆蓋 HTML/JS contract；2026-07-22 Chrome 先由自動化驗證雙 Enter，再由 owner 在真實注音輸入來源直接輸入「測試」：composition Enter 只確認組字，下一個 Enter 換行、再下一個 Enter 送出；截圖與獨立 `room_read(after: 307)` 均確認只新增 #308 一則訊息且輸入框清空 | Browser 自動化送鍵會繞過 macOS text-input service，故真實 IME 必須保留人工驗收；不得以 DOM 合成 composition event 或自動化文字注入冒充通過。可視鍵盤、語音輸入與 assistive technology 可繼續使用送出按鈕 |
| Dirty Snapshot | 已驗證（synthetic） | RAM-only/TTL/pending ceiling、text/path/link/mode/size/hash/source race、獨立 approval、只匯入 worktree；`test/dirty-snapshot-broker.test.ts`、`test/workflow.test.ts`、`test/web.test.ts` | 未對真實專案執行；daemon 已於 2026-07-17 重載並監聽 127.0.0.1:4317 |
| Apply-back | 已驗證（synthetic＋HTTP） | preview hash、source/worktree HEAD＋fingerprint、逐檔 CAS、短效 single-use approval、rollback、刪除移到 trash-pending；`test/apply-back-broker.test.ts`、`test/web.test.ts` | 多檔案仍有 OS/磁碟故障造成 rollback 也失敗的殘餘風險；會明確記錄 `APPLY_BACK_PARTIAL_ROLLBACK_FAILED` |
| Supply chain/release gate | 已驗證（未發布 tree） | `npm run check:release`、SBOM、audit、secret/history scan、offline committed-HEAD clean clone；tracked package allowlist 排除 test/non-runtime scripts/CI/Agent instructions，pinned TS-to-JS build 產生 runtime-only tgz，離線安裝後驗 `.bin` link/mode、全 JS/MJS syntax、CLI startup 與正負向 audit smoke；候選 artifact 以 `O_NOFOLLOW` descriptor 寫入 owner-only `dist/release`，symlink/hardlink/oversize/mode collision 負向測試通過 | artifact signing/provenance 需先有 owner 批准的 release |
| GitHub 開源發布 | 未批准 | release checklist 保持 NO-GO | 名稱、license、Git identity、remote、visibility、commit/push/release 均待 owner 決策 |

## 目前自動證據

- 501/501 deterministic tests＋1/1 fuzz smoke（2026-08-06，Phase 5-4 對抗式審查修正後，`npm run check`
  於當前工作樹一次跑完，exit 0）。
- 最新最終 gate：line 95.14%、branch 88.03%、functions 96.93%；gate 分別為 90%、85%、90%。
  branch 餘裕 3.03 個百分點；仍應假設任何新增分支都要同批補測試。
  （先前此處記為 line 95.02／branch 87.83／functions 96.90，其中 functions 與當時實測的 96.96 不符；
  現行數字一律以本次 `npm run check` 的 coverage 表尾列為準。）
- 測試不使用真實 credentials、真實私人 repository、模型額度或付費 API。
- CycloneDX SBOM 為 3 components，SHA-256 `ea620ec658783639ce0d9dcf64dccc4bf1ccda69d4b5c43f95491891e4b9f99a`。
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
