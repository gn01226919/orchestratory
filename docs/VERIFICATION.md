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
   **未追蹤檔案**、**ignored 檔案的路徑與內容**、stash、
   **reflog（判準為「既有項目不得被移除或改寫、順序不變」，不是逐位元相等）**、
   `.git/config`、`core.hooksPath`、
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
   （存在即拒絕，**不等待**），並在整個期間持有一個可觀察的排他標記。
   必須有一條測試模擬外部程序在 checkout 與 commit 之間推進 main。
   （綁定檢查與實際 merge 之間的 TOCTOU 窗，在 5-5 從幾毫秒放大到整個 checkout＋hook 執行時間。）

   **2026-08-06 主代理裁決：原本要求的「期間偵測到 main 被外部改動即中止」移入殘餘風險。**
   這是**主代理的決定，不是實作者自行放寬**——記在此處是因為本專案反覆出現的失效模式，
   正是「標準被實作者悄悄放寬」（見 [[PITFALLS]] #87）。放寬時更要留下痕跡。

   **理由**：`git merge` 是外部程序，控制面在它執行期間**沒有中止點**，單機 git 上做不到「期間中止」。
   成立的是**事後偵測**：`authorizedMergeCommit` 的雙親判準使「外部推進被誤記為 applied」
   在結構上不可能——已實測，外部程序推進 main 時 git 自己就會 exit 128
   （`cannot lock ref 'HEAD'`）。開始前的 `index.lock` 檢查仍為必要，未放寬。

   **2026-08-06 更正（第三輪審查指出，主代理接受）**：上一版裁決寫「排他標記仍為必要、未放寬」——
   **那句話與實作不符，是我自己犯的一次未驗證宣稱**（[[PITFALLS]] #77 同形）。
   實際的排他標記是 `candidate_merge_promotions.approval_id` 的 UNIQUE 索引，**只序列化同一把核准**；
   `#assertNoUnresolvedPromotion` 以 `task_id` scope，**對 `mainPath` 沒有任何鎖**。
   審查員實測（`p6-exclusive.mjs`）：task A 被 kill 後 task B 的 preview 被拒，
   **原因是 main 剛好變髒而非有人持有排他權**——「靠巧合擋住」不是「靠設計擋住」。
   **因此排他粒度必須明寫**：見下方第 7 項的補正要求。

   **何時失效**：若未來 promotion 改為由控制面自行實作 merge（而非呼叫 `git merge` 外部程序），
   或開放多 candidate 併發 promotion，此項立即回復為必須。

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

### v2 的一處更正（2026-08-06，由實作代理指出、經主代理親手實測確認）

v2 第 4 項原本要求回滾後 reflog 回到操作前的狀態。**這在結構上不可能滿足**：
reflog 是 append-only，`git merge --abort` **必然** append 一筆 `reset: moving to HEAD`，
且既有項目的選擇器全部往後移一位（`HEAD@{0}`→`HEAD@{1}`）。已用獨立的臨時 repo 實測確認。

因此判準改為「**既有項目不得被移除或改寫、順序不變**」——這才是真正的安全屬性，
而且比原本的寫法更有意義（逐位元相等會逼出破壞性改寫 reflog 的「合規」實作）。
實作上比對必須用 `%gs`（訊息）不能用 `%gd`（選擇器），後者會重新編號。

**這是修掉一個不可能滿足的要求，不是移動終點線。** 把它留著只會逼出假的合規。
記為 [[PITFALLS]] #96。

### v2 的第二處補正（2026-08-06，第一輪審查後）

第一輪審查不通過，並指出**標準本身的三個漏洞**——其中一個讓本輪最嚴重的損害
**完整滿足了十項的每一個字**。補正如下，新增為第 11～13 項：

11. **升級與向後相容。** 用**前一個 commit 寫出的資料庫**開啟一次，斷言**每一個既有讀寫面都可用**
    （list／inspect／reject／request／promote／expiry sweep）。
    「儲存層是純加表」不足以證明相容——本輪的洞完全在**讀取層的 assert**：
    一筆 row_hash 驗過且未變的既有核准被讀成 `MAIN_MERGE_APPROVAL_ROW_TAMPERED`，
    而正確的具名答案就在同一份程式碼裡卻永遠到不了。
    **「這份快照早於某個 gate」與「這列資料被竄改」必須是兩個不同的答案**（[[PITFALLS]] #85／#100）。
    另：任何會佔用「每 task 一個未決問題」這個結構性槽位的狀態，
    **必須有產品側路徑可以釋放它**，否則一次失敗就永久報廢該 task。

12. **促進程序被殺之後，它啟動的破壞性子程序也必須被涵蓋。**
    原第 2 項只要求「子程序在結束或中止時已終止」——但 `detached: true` 讓 `git merge` 自成
    process group，`kill -9` orchestrator 之後它 PPID 變 1 **繼續把 main 寫完**。
    因此：**merge 子程序的 pgid 必須寫進意圖紀錄，且在該 pgid 仍存在時不得下任何結論。**
    測試必須涵蓋「發起者已死、被它啟動的 merge 還活著」這個組合。

    **2026-08-07 補正 (G)（第七輪審查後）**：原文照字面可以被「settle 在錯的號碼上、探測到它已死、
    於是下結論」完整滿足——第七輪的洞正是這個形狀。措辭改為：
    **「pgid 仍存在，或無法確定 pgid 是哪一個時，都不得下結論。」**

    **第八輪的實作對照（逐句查過，不是憑印象）**：
    - 「無法確定是哪一個」現在是一個明確的狀態。`durableMergeIdentity()` 對~~三~~**四**個來源分別讀
      （第九輪加入 `spawn-record`），
      兩個 in-row 來源答案不同時回 `readable: false`，並把**每一個**候選都交出去探測；
      `unreadableReleaseRequirement()` 逐一探測而不是只探測「偏好的那一個」，
      任何一個答 `merge-running` 或 `unknown` 都進 `alive`，短短語即不可用。
    - ~~「可讀的列」不可能發生來源不一致：`#assertPromotionRow` 對
      `merge_pgid !== null && promotionPgid(row) !== merge_pgid` 直接判 `ROW_TAMPERED`，
      該列因此走不可讀路徑而不是 `promotionPending()`。這條檢查有測試守著（突變 M15／本輪突變 E）。~~
      **⛔ 第八輪實測證偽（2026-08-07）。這是一句全稱宣稱，而它是假的。**
      那條檢查是**單向**的（`merge_pgid !== null && …`），所以它的鏡像
      ——欄位 NULL、payload 說沒有 group、而 row 外的來源指著一個活著的 merge——
      逐字通過完整性檢查，`promotionPending()` 照樣回 `undefined`。
      `p8-race.mjs` 在**零竄改、零雜湊偽造**下產生了一個：另一個程序對 registry DB 取
      `BEGIN EXCLUSIVE`（[[PITFALLS]] #65 記載的日常條件），`#recordMergePgid` 的寫入失敗被吞掉，
      git 已經 detached 跑起來；產品回報 `waiting nothing — this record is not blocked on any process`
      並遞出 `git reset --hard <pre-op>`，而 `ps -g` 同時列出 `git merge`＋hook＋`sleep 900`。
      正確的敘述是：**「可讀的列」也會發生來源不一致，而且不一致必須在下結論之前被探測到。**
      第九輪的修法不是把宣稱改強，是把判斷改對——見下方 (I) 的實作對照。
    - `mergeGroupState()` 的 `unknown` 與 `merge-running` 在阻擋上同等處理，
      所以「探測不出來」與「還活著」導向同一個動作，不折疊成任何一邊（[[PITFALLS]] #85）。

13. **凡是還會變的狀態，紀錄不得一次寫死。**
    每次讀取重新觀察，或紀錄自稱「as observed at T」並可重算。
    實測後果：reconciliation 寫成 `needs-manual-review` 後永不再觀察，於是
    **main 已完整套用且乾淨，紀錄卻說「不確定」，`mainHeadAfter` 記的是 pre-op HEAD，
    而且仍在叫 Owner 執行 `git reset --hard <pre-HEAD>`——照做會靜默丟掉一次真的成功了的 merge。**
    一次觀察後凍結，是 [[PITFALLS]] #86 戴上「這是觀察來的」徽章的版本。

**另外補正第 3 項的措辭**：「乾淨」清單裡每一個項目都必須寫**用什麼證據判定**，不只寫要檢查什麼。
實測本輪三處都選了最省事的讀法：`.gitattributes` 只掃根目錄（子目錄與 `.git/info/attributes` 皆漏）、
sparse-checkout 用字串 `=== "true"` 比對（`1`／`yes`／`on` 皆漏而 git 確實照做）、
submodule 只看 `.gitmodules` 是否存在（index 有 `160000` gitlink 但無該檔時零 blocker）。
判準明定為：`.gitattributes` **掃全部層級＋`.git/info/attributes`**；
boolean **一律 `git config --type=bool`**；submodule **看 index 的 `160000` 條目**。

**第 5 項的分輪裁決**：audit chain 與 room ledger 的 promotion 紀錄在「刻意不接出口」的第一輪
結構上不可能完成。標準因此區分**核心紀錄**（第一輪必須有）與 **ledger／audit 紀錄**（第二輪），
否則被切成兩輪的階段無法被公平裁決。

### 第二輪修正紀錄（2026-08-06，對照第一輪審查的十項發現）

每一列的「突變」欄都是**實際跑過**的：把該修正拿掉、跑完整份 `test/merge-promotion.test.ts`、
記下變紅的測試名，然後還原並以 SHA-256 確認原始碼逐位元回復。九個突變全部變紅，沒有一個是全綠。

| 發現 | 修正 | 守它的測試 | 突變（拿掉修正後變紅的測試） |
| --- | --- | --- | --- |
| **N1** v4→v5 升級把 Owner 既有核准讀成「已竄改」，並永久佔住每 task 一個未決問題的槽位 | `#assertMergeApprovalRow` 不再把 `preview.promotion === undefined` 併入完整性失敗；改由 `#retirePredatingApproval` 轉成具名終局 `invalidated` + `PREVIEW_PREDATES_PROMOTION_GATES`，槽位釋放，`reject`／`request`／expiry sweep 全部恢復可用 | 三條：升級後每個讀寫面可用且可重新 promote／可 reject／不可 grant（用**真的 v4 資料庫**：以現行程式建庫後 `DROP TABLE candidate_merge_promotions`、`PRAGMA user_version=4`、把 `preview_json` 還原成 v4 形狀並重算 hash，開啟時跑真正的 v4→v5 升級）。v4 形狀的等價性另以 `df075b7` 實測過：v4 的 `preview_json` 就是 v5 的減去尾端 `promotion` 一鍵，鍵序與結構完全相同 | 把 `|| preview.promotion === undefined` 加回 assert → 3 條變紅 |
| **N2** `kill -9` 之後被孤兒化的 `git merge` 繼續寫完 main，而紀錄永遠凍結在「不確定」，還叫 Owner `reset --hard` | (a) merge 子程序 pgid 於 spawn 當下寫入意圖紀錄，group 仍存在即不 settle；(b) 非終局紀錄每次讀取重新觀察；(c) 觀察到被授權的 merge commit 時復原指令改為唯讀的 `git show --stat` | 「孤兒 merge 跑完後被觀察為 applied，而不是凍結成未知」（實測 HEAD 移動、`status` 空白、記錄先具名 `...WITH_MERGE_STATE_LEFT_BEHIND`、Owner 清掉殘留後轉 `applied`、candidate 轉 `merged`） | 三個各自的突變：不查 pgid → 2 條紅；改回 `if (row.state !== "applying") return row;` → 2 條紅；復原指令改回永遠 `reset --hard` → 1 條紅 |
| **N3** 兩個突變全綠＝兩條關鍵路徑零覆蓋 | 無程式修正（M1 是既有行為的證明），M5 把未結促進 gate 移到 `#authorizeMainMerge` 的最前面，使它成為**第一個也是唯一**會回答的拒絕 | (a)「crash reconciliation 一個位元都不改」——整棵樹含 `.git` 的內容＋權限指紋，**兩種情境**：沒有 `MERGE_HEAD` 可 abort 的、以及孤兒 merge 完成後留著 `MERGE_HEAD`（後者 `merge --abort` 真的有效，會毀掉成功的 merge）；(b)「未結促進期間核准不可被消耗」 | 在 reconciliation 前插入 `merge --abort` → 3 條紅（含 (a) 的第二種情境）；拿掉 consume 端 gate → 1 條紅 |
| **N4／N5／N6** 三個「乾淨」判準用了最省事的讀法 | attributes 掃 `git ls-files -- '*.gitattributes'`（任意層級）＋ignored inventory 內的 `.gitattributes`＋`$GIT_DIR/info/attributes`＋repo-local `core.attributesFile`，讀不到／超限一律 `MAIN_ATTRIBUTES_UNREADABLE`；boolean 改 `git config --type=bool`（git 拒絕的值＝關閉的閘門）；submodule 改看 index 的 `160000` 條目（`.gitmodules` 檢查保留） | 拒絕表從 8 條擴為 17 條：sparse 的 `true`／`1`／`yes`／`on`、`160000` gitlink 且完全沒有 `.gitmodules`（先斷言 `status` 為空）、`filter=` 的 5 個位置 | 只讀 root `.gitattributes` → 4 條紅；sparse 用字串比對 → 3 條紅；submodule 只看 `.gitmodules` → 1 條紅 |
| **N7** hook 只是跑太久就把 main 留在半套用狀態，且沒有出路 | 出路來自 N2(b)：Owner 自己把 main 復原後，下一次讀取重新觀察即收斂為 `rolled-back`，task 解封、可重新 preview→核准→promote。產品仍然一個位元都不寫 | 「Owner 自行復原 main 後 needs-manual-review 自動結案」（真實 hook 逾時→半套用→Owner 手動 `reset --hard` 與清殘留→新程序讀取→`rolled-back`→重新 promote 成功） | 同 N2(b) 的突變 → 該測試變紅 |
| **N8** 證據測試自身間歇失敗 | `test/merge-promotion.test.ts` 的雙 promise 改為逐一建立，第二個 rejection 不會在 handler 掛上前被判為 unhandled | 同一條測試 | 不適用（這是測試自身的缺陷修正） |
| **N9／N10** 文件過期與數字不符 | `PROPOSAL_MCP_FIRST.md` 與 `THREAT_MODEL.md` F24 的 `consumeMainMerge` 敘述、F25 的 `mainIgnoredFingerprint` 敘述、F26 的 `.gitattributes` 敘述、`candidate-registry.ts` 節流快取的註解，全部改為與程式一致並標註更正日期；gate 數字改以乾淨 clone 為準 | `test/merge-dialog-acceptance.test.ts` 的 digest guard 仍在原位 | 不適用（文件） |

**一處判準放寬，分開講。** 「main 回到操作前」的判定不再把 `hookEnvironment` 算進去（仍照實列在
`differences` 裡）。這不是為了讓測試變綠：讓 promotion 失敗的往往就是那個 hook，而移除或修好它是重試
唯一可能成功的前提，把它算成「main 沒回來」會讓唯一的出路同時永久封死上一次嘗試與整個 task。
第 4 項的清單本身也沒有列 hook 檔案內容（它列的是 `core.hooksPath`）。hook 清單真正把關的地方是
approval 綁定，在 merge 前一刻對 live main **不節流**地重驗。

**2026-08-06 補充（第四輪）**：`hookEnvironment` 這個指紋現在也包含 main 的**整份 config digest**，
所以上述放寬連帶涵蓋它：促進失敗後若 `.git/config` 有變動，`differences` 會列出 `hookEnvironment`，
但不會因此判定「main 沒有回到操作前」。理由與 hook 相同——config 不是 main 的內容，而修掉造成失敗的
設定往往是重試唯一可能成功的前提。**真正把關的仍是綁定**：消耗核准前對 live main 不節流地重驗一次，
不符即拒絕且不執行任何東西。

**一處行為順序改變，分開講。** `#authorizeMainMerge` 內的「未結促進」檢查移到最前面，因此對一個
已被消耗的核准，回答從 `MAIN_MERGE_APPROVAL_ALREADY_CONSUMED` 變成 `MAIN_MERGE_PROMOTION_UNRESOLVED`。
兩者都拒絕、都不寫入任何東西；改變的是 Owner 被指向哪個問題——「你的 token 用過了」會把人帶去錯的地方，
真正要處理的是那個沒人能描述狀態的 repository。

**關於資訊揭露的原句不精確，在此改寫（第二輪指出）。** 原文寫「資訊揭露沒有變化：核准狀態原本就在
token 檢查之前可見」。核准狀態確實原本就可見，但**這次揭露的是一類新事實**：未認證呼叫者現在可以分辨
「這個 task 的上一次促進未結」與「這個 task 一切正常」——那是促進帳本的狀態，不是核准的狀態，
先前不存在於任何 token 前的回答裡。裁決是**接受這個揭露**（它只說「你的 repository 有個沒人能描述的
狀態」，不含路徑、commit、指紋或 pid），但同時修掉它附帶的**成本**問題：未認證呼叫者原本可以無限次
觸發最長 30 秒的全樹雜湊。現在的順序是「便宜的程序探測 → 節流 → 昂貴的重新觀察」，
昂貴那一段只對能出示 token 的呼叫者無條件提供，其餘一律 fail closed 地拒絕
（`test/merge-promotion.test.ts`「an unauthenticated caller cannot make the unresolved-promotion gate
re-read the repository」以注入的 GitBroker **數**全樹讀取次數，不靠計時）。

### 第三輪修正紀錄（2026-08-06，對照第二輪審查的七項發現）

第二輪不通過。第一輪的七項必修經審查員獨立複驗確認全部真的修好；以下是**新**的問題與這一輪的處置。
每一列的「突變」欄都是實際跑過的（清單與輸出見本節末）。

| 發現 | 修正 | 守它的測試 |
| --- | --- | --- |
| **R1（嚴重）** pgid 被當成「還在寫入」的代理品：hook 只要在背景留下任何子程序（起 dev server／watcher／log tailer 都是這個形狀），整個 process **group** 就永遠活著，於是 main 已完整套用且乾淨、紀錄卻永遠停在 `applying`，且產品側零路徑可釋放。`mergeGroupStillRunning` 對該 group 沒有任何身分驗證，非 `ESRCH` 錯誤（如 `EPERM`）一律算「還活著」，而 pid 會回繞、重開機後從低號重來——[[PITFALLS]] #67 原地復發 | 四件事。(a) **改成問 group leader 而不是整個 group**：子程序 `detached`＝leader 的 pid 就是 pgid，leader 就是那個 `git merge`，它的生死才是「main 是否還在被寫」的判準；背景殘留的孫程序改為具名回報 `mergeGroupSurvivors`（含唯讀 `ps -g <pgid>` 指令）而不再阻擋收斂。(b) **加上身分**：pgid 連同 `bootAtSec`（本機開機時刻）一起記，跨開機的 pgid 一律不採信；`EPERM` 從「還活著」改判為「這個 pid 現在屬於別人，因此不是我們的 merge」。(c) **一旦觀察到已結束就把 `mergePgid`／`mergeGroup` 寫成 `null`**，拿掉無條件 carry-forward。(d) **具名 + 出路**：非終局的促進在每次讀取時重新導出 `pending.{code,pid,inspect,release}`，並新增產品側動作 `abandonMergeProcessGroup()`——Owner 必須寫出記錄上的**確切 pgid** 與確認短語 `STOP WAITING FOR THIS PROCESS GROUP`，產品**不殺任何程序、不碰 main**，只停止等待那一個 pid，並把這件事**歸屬給 Owner**（`mergeGroupDisowned.decidedBy`）而不是偽裝成觀察 | 四條：「a hook that leaves a background process behind does not freeze the promotion forever」（實測 group 在收斂當下仍活著）、「a promotion that has been observed to be over stops carrying its process group id」、「a process group recorded before a reboot is not believed to be the running merge」（只改寫記錄中的開機時刻、真實 merge 仍在跑）、「the owner can stop a promotion waiting on a process group, without anything being killed」（斷言整棵樹逐位元不變、程序仍活著、錯 pgid／錯短語各被拒絕一次） |
| **R2（嚴重）** `.gitattributes` 還漏兩個 git 真的會讀的來源（`core.attributesFile` 寫成 `~/attrs`；`$XDG_CONFIG_HOME/git/attributes`），而註解與 F26 又宣稱窮盡 | 採納審查員的建議：**改成直接問 git**。`git check-attr -z --stdin filter` 在 `promotionGitEnvironment()`（merge 會用的那個環境）下詢問「代表性路徑＋本 repo 全部 tracked 路徑＋ignored 路徑」，任何答案不是 `unspecified`／`unset` 即拒絕；讀不到一律 `MAIN_ATTRIBUTES_UNREADABLE`。**列舉那一半保留**，理由分開講（見下）。`~` 展開一併修好。兩句假宣稱（`git-broker.ts` 註解、`THREAT_MODEL` F26）都已改寫 | 兩條新的拒絕測試，各自**先斷言 git 自己確實會套用 filter**（`git check-attr`），再斷言產品拒絕；原有的五個位置測試不動 |
| **R3（嚴重）** 標準第 5 項（audit／room ledger）完全沒有實作，也沒有任何地方記錄實際執行過的 hook 檔名與退出碼 | 新增 `onMergePromotion` sink（與既有 `onMergeApprovalInvalidated` 同形），由 `CollaborationService` 接到 audit chain 與 room ledger；`started` 與 `settled` 兩個 phase 都寫，成功與失敗都寫。**hook 檔名與退出碼是觀察來的**：merge 以 `GIT_TRACE2_EVENT` 寫出 git 自己的 trace（檔案在 owner-only data directory，**不在 repo 內**，否則它自己就會變成未追蹤檔案並污染指紋），事後解析 `child_class:"hook"` 的 `child_start`／`child_exit` 取得 `hook_name` 與 `code`。**未讀到是 `null`、讀到但沒有 hook 是 `[]`**，兩者不折疊。before／after HEAD 各記一次並另記 `mainHeadUnchanged` | 一條測試走**產品接線**（`new CollaborationService(data)`）跑成功與失敗兩條路徑，斷言 `audit.verify()` 為 true **並且**斷言事件筆數（2）、`outcome`、兩個 HEAD、`decidedBy`／`previewDigest`／`approvalState` 指向真實 approval row，以及 `hooksExecuted` 精確等於 `[["pre-merge-commit",0],["post-merge",3]]`／`[["pre-merge-commit",1]]`；ledger `verifyChain` 為 true 且不含專案路徑或 approval id |
| **R4（中）** 第 1 項另外三個 kill 窗仍無測試 | 新增 test-only `faultPoint` 注入點（前例：v5 migration rollback 的 fault point）。三條測試各自在**子程序內部**於指定步驟對自己送 `SIGKILL`，再由新程序從 durable 狀態重建答案 | 「intent-record 寫入中」（交易未 commit → 完全沒有促進列 → 同一把 token 仍可用並成功）、「核准消耗寫入中」（意圖列＋仍 `approved` 的核准＝沒有任何 Git 指令跑過 → `APPROVAL_NEVER_SPENT_NO_GIT_COMMAND_RAN`；同一把核准無法再啟動第二次促進，Owner 的路徑是 reject → 重新 request，已實測不卡死）、「終局結果寫入中」（merge 已完成 → 新程序重新觀察為 `applied`） |
| **R5（中）** 第 7 項外部程序競態測試不存在 | 新增測試：`pre-merge-commit` hook 在 merge 途中把 `refs/heads/main` 推到另一個 commit。**實測結果**：git 自己偵測到並以 exit 128（`cannot lock ref 'HEAD'`）中止，main 的 HEAD 停在那個外部 commit，index 帶著已合併的內容。斷言產品**不**把它記成 `applied`（`authorizedMergeCommit` 為 false，因為第一個 parent 不是 pre-op HEAD）、具名列出 `HEAD` 差異、candidate **不**轉為 `merged` | 「an external process that advances main mid-merge is not reported as an applied promotion」。關於「事後偵測是否足夠」的提議見下方裁決請求 |
| **R6（中）** preview 節流零測試 | 新增測試，fixture **真的**超過 deadline：`.gitattributes` 的 `f.txt merge=slow` ＋ `merge.slow.driver` 是一個在 gate 檔案存在時 `sleep 300` 的指令，`git merge-tree --write-tree` 確實會呼叫它（已實測）。第一次觀察耗時 >60 秒並回 `bindingCheck.unavailable = MAIN_MERGE_PREVIEW_DEADLINE_EXCEEDED`（可讀狀態、核准不失效），節流窗內第二次觀察 <5 秒且回同一個可讀狀態，移除 gate 後同一把核准仍可 promote 成功 | 「a preview recompute that exceeds its deadline is a readable state, throttled, and still grantable」。附帶實測發現：被中止的 merge driver 會在 candidate worktree 留下 git 自己的 `.merge_file_XXXXXX` 暫存檔，測試按名逐一移除以還原被綁定的狀態（**不是** `git clean`） |
| **R7（低）** 其餘五項 | (a) `#assertNoUnresolvedPromotion` 順序不變（回答仍先指向 repository），但昂貴那一段改成「便宜的程序探測 → 節流 → 重新觀察」，且只對能出示 token 的呼叫者無條件提供；(b) `REBASE_HEAD`／`CHERRY_PICK_HEAD`／`REVERT_HEAD`／`AUTO_MERGE`／`MERGE_MSG` 各補一條拒絕測試（拒絕表 17 → 22 條）；(c) `VERIFICATION.md` 的「資訊揭露沒有變化」已改寫（見上）；(d) `#upgrade` 的 `from === 1`／`from === 3` 分支見殘餘風險表新增列 | 「an unauthenticated caller cannot make the unresolved-promotion gate re-read the repository」以**注入的 GitBroker 計數**全樹讀取次數（不靠計時）；五條新的 leftover 拒絕測試 |

**兩項本輪自己找出來的問題，一併修掉並分開講。**

- **`owner_pid` 有和 pgid 一模一樣的缺陷，只是高一層。** 修 pgid 的時候才看清楚：`applying` 的紀錄
  以 `kill(owner_pid, 0)` 判斷「另一個視窗還在跑」，而重開機之後那個號碼指向別的程序、答案是「還活著」，
  於是那一列永遠等下去——**而重開機正是最可能留下未結促進的原因**，本專案的 `THREAT_MODEL` F20 早就
  對 `owner_pid` 寫過同一句話。修法與 pgid 相同：連同開機時刻一起記，跨開機的 owner pid 一律不採信。
  測試把**這個測試程序自己的 pid**（保證活著）寫進 owner 欄位，先斷言它確實會被等待，
  再只改記錄中的開機時刻，斷言它不再被等待。
- **`#upgrade` 的 `from === 1`／`from === 3` 現在會以具名錯誤 fail loud。** 加表本身是純加表沒錯，
  但那不等於資料庫打得開：`a75e904` 之前完成的 candidate 帶著現行 reader 讀不了的 `completion_json`，
  於是整個 registry（含權威的 candidates 與 checkpoints）以一個既不指出原因也不指出版本的
  `CANDIDATE_COMPLETION_PREVIEW_INVALID` 開不起來。現在在**任何 DDL 之前**先問一次，
  讀不了就丟 `CANDIDATE_REGISTRY_PRE_V4_COMPLETION_UNSUPPORTED`，資料庫原樣不動、每次開啟答案一致。
  **這不是修好那個缺口**，缺口本身仍列在殘餘風險表。

**一處建議被採納但沒有照字面做，分開講。** 審查員建議「與其列舉檔案位置，改成用 `git check-attr` 直接問 git」，
理由是任何列舉都會被 git 的下一個版本或下一個設定鍵繞過。**這一點完全同意，並已實作為主要判準。**
但列舉那一半**保留**，理由是兩者各自覆蓋對方看不到的東西：`check-attr` 只能就**具體路徑**回答，
所以一條指向「此刻不存在的路徑」的規則（repo 內還沒有 `.psd` 時的 `*.psd filter=lfs`）它答不出來；
反過來，列舉答不出它不知道怎麼找到的檔案。合起來**仍不宣稱完備**，未覆蓋的形狀已列入殘餘風險表。

**一項需要 Owner 裁決（不自行改標準）。** 標準第 7 項要求「在整個期間持有一個可觀察的排他標記；
期間偵測到 main HEAD／index 被外部改動即中止」。實作提議：**真正的「期間偵測」在單機 git 上做不到**——
`git merge` 是一個外部程序，控制面在它執行期間沒有任何 hook 點可以中止它，而任何輪詢都只是把 TOCTOU
窗縮小而非關閉。目前成立的是**事後偵測**：`authorizedMergeCommit` 要求 HEAD 是一個雙親 commit，
第一個 parent 恰為 pre-op HEAD、第二個恰為被授權的 candidate head，任何外部推進都無法滿足它，
因此**不可能被誤記為 applied**，且差異會逐項具名。**提議把「期間偵測」從第 7 項移入殘餘風險表**，
並註明失效條件：若未來 promotion 改為由控制面自己分步執行（checkout／commit 分離），
或開放多 candidate 併發，事後偵測就不再足夠，必須改為真正的排他鎖。**此項待 Owner 裁決，尚未執行。**


### 第三輪的突變測試（十四個，全部實際跑過並附輸出）

方法與前兩輪相同：把樹複製一份、套用**一個**編輯、跑完整份 `test/merge-promotion.test.ts`、記下變紅的
測試名。**全綠要當成發現回報，不是好消息**（[[PITFALLS]] #97）。

| # | 突變 | 結果 |
| --- | --- | --- |
| A | `mergeGroupState` 改回問整個 process **group** 而不是 group leader | 1 條紅：a hook that leaves a background process behind does not freeze the promotion forever |
| B | 拿掉 pgid 的開機時刻身分檢查 | 1 條紅：a process group recorded before a reboot is not believed to be the running merge |
| C | 恢復「無條件 carry-forward pgid」 | 3 條紅：stops carrying its process group id／recorded before a reboot／a kill inside the final-result write |
| D | 不再具名回報「是哪個程序讓它還沒有答案」 | 6 條紅：killed during a hook／orphaned merge finishes／stops carrying its pgid／recorded before a reboot／owner can stop a promotion waiting／owning process id from a previous boot |
| E | 拿掉 attributes 閘門的 `check-attr` 那一半（只留列舉） | 1 條紅：a filter comes from the XDG global attributes file |
| F | 不再讀回 git 實際執行了哪些 hook | 1 條紅：both promotion paths are written to the audit chain and the room ledger |
| G | 不再通知 audit chain 與 ledger「促進已收斂」 | 1 條紅：both promotion paths are written to the audit chain and the room ledger |
| H | 允許 Owner 不寫出紀錄上的 pgid 就釋放等待 | 1 條紅：the owner can stop a promotion waiting on a process group |
| I | 未認證呼叫者也無條件跑昂貴的重新觀察 | **第一次全綠 → 這是一項發現**（見下）；修好測試後 1 條紅 |
| J | 拿掉 `owner_pid` 的開機時刻身分檢查 | 1 條紅：an owning process id from a previous boot does not keep a promotion waiting |
| K | 讓 pre-v4 資料庫在完成紀錄讀不了時照樣靜默升級 | 1 條紅：a pre-v4 database whose completions this release cannot read is refused by name |
| L | `probe()` 的 `EPERM` 改回「還活著」（也就是修正前的舊解讀） | **主代理設計、第一次全綠 → 第二項發現**（見下）；補測試後 1 條紅：a process group id now held by another user is not our merge |
| M | `probe()` 的第四個答案 `unknown` 改成「已死」（第二輪 N-2 的方向） | 1 條紅：a process group nobody can decide about blocks the answer |
| N | 在呼叫端把 `unknown` 的 group 當成可以收斂 | 1 條紅：a process group nobody can decide about blocks the answer |

**突變 I 第一次全綠，這是本輪最重要的發現，照規定當成發現回報。** 那條測試用一個 64 字元十六進位字串
當「錯誤的 token」，而 `MERGE_APPROVAL_TOKEN_PATTERN` 是 43 個 base64url 字元——**形狀就不對，
在到達那個閘門之前就被拒了**，所以整條測試從頭到尾沒有碰過它宣稱在測的東西。
把 token 改成正確形狀（`"A".repeat(43)`）之後，同一個突變讓它變紅（`pass=56 fail=1`）。
與 [[PITFALLS]] #97 同形：突變測試告訴你的不是「測試有沒有效」，而是**測試實際上在測什麼**。

**突變 L 全綠，是本輪第二項發現，而且是主代理設計的突變抓到的，不是我的。** `probe()` 對 `EPERM` 的
判讀（「這個 pid 存在但屬於別人，所以不是我們的 merge」）是本輪的核心安全決定之一——它決定「別人回收的
pid」會不會讓一個已完成的 promotion 永遠無法收斂——而**我的十一個突變沒有一個碰到它**，
第二輪審查員的 N-2 突變往相反方向打時**當時也是全綠**。也就是說這個分支**兩個方向都沒有任何測試在看**。
與突變 I 同類：測試從沒到達它宣稱在測的地方。補上兩條測試：
- **EPERM（真實）**：在執行期從 `ps` 找出一個屬於別的 uid、且 `kill(pid,0)` 確實回 `EPERM` 的 pid
  （本機量到 211 個），先斷言這個前提成立，再把它寫進紀錄的 `mergePgid`，斷言紀錄**不再等待**它。
  找不到這種 pid（例如以 root 執行）時測試**大聲失敗**，不靜靜通過。
- **`unknown`（受限）**：POSIX 上 `kill(pid, 0)` 帶合法正整數只會回 `ESRCH` 或 `EPERM`，
  所以第四個答案**在公開介面上不可達**——**2026-08-07 更正：這句是錯的**。沒有任何一層驗證過那個號碼真的是一個 pid：`promotionPgid` 接受到 2^53、`owner_pid` 的 CHECK 只有 `> 0`，而 **≥ 2³¹ 的號碼會讓 `process.kill` 丟 `ERR_INVALID_ARG_TYPE`**（既非 `ESRCH` 也非 `EPERM`），實測 `2147483648`／`4294967296`／`2**53-1` 全部回 `unknown`。**兩條分支都可從公開介面到達，且當時都沒有測試**（見第七輪 F-6，兩條新測試不需要替換 `process.kill`）。下面這條測試仍然保留，因為它涵蓋的是另一個輸入——一個**看起來像 pid** 的號碼配上既非 `ESRCH` 也非 `EPERM` 的 errno。它把全域 `process.kill`**只針對那一個 pid** 換掉
  ——那正是模組實際呼叫的函式，分支真的被執行。**它證明的是分類與釋放路徑，不證明真實作業系統會產生
  該錯誤**，這個界線寫在測試裡而不是含糊帶過。

**`EPERM` 判成「不是我們的」是刻意的，不是漏判。** N-2 那個方向（非 `ESRCH` 一律當已死）現在有 M／N
兩個突變守著 `unknown`；而 `EPERM` 本身被判為「已死」是**本輪的修正內容**（身分論證：這次 promotion 的
merge 以 Owner 身分執行，一個屬於別人的 pid 不可能是它），由突變 L 反方向守著。

**跑過的樹。** A–H 第一次是在加入 J／K 之前跑的，之後**在當時的最終樹上整批重跑一次**，每一個仍然
變紅（A/B/E/F/G/H 各 `pass=58 fail=1`、C `pass=56 fail=3`、D `pass=53 fail=6`——D 多出來的一條是新加的
owner-pid 測試）；I/J/K 在同一棵樹上跑（各 `fail=1`），基準線 `pass=59 fail=0`。
L/M/N 是在**加入那兩條新測試之後**的樹上跑的，各 `pass=60 fail=1`，基準線 `pass=61 fail=0`。
A–K 與 L/M/N 之間唯一的差異是那兩條新測試，它們只增加覆蓋、不改任何產品程式碼。

### v2 的第三處補正（2026-08-06，第三輪審查後）

第三輪不通過，根因打穿第 3 與第 10 項，且審查員指出**標準本身的四個漏洞**：

**(A) 第 3 項只點名四個 config 鍵，那是一份名詞清單不是判準。**
實測：candidate worktree 在**核准之後**寫入 `commit.gpgsign=true` ＋ `gpg.program=<evil>`，
`git merge --no-ff` 建立 merge commit 時**以 Owner 身分執行了它**，
而綁定、揭露、消耗前重驗三道防線全部看不到（`gpg.*` 不在 `hookEnvironment()` 指紋內）。
對照組證明缺口是特定的：`core.hooksPath` 與 `merge.*.driver` 都被正確拒絕。

**判準改為**：**promotion 環境下 git 可能 spawn 的每一個「由設定指定的可執行檔」都必須納入
綁定與揭露**；不得以列舉四個鍵了事。已知同類至少還有 `gpg.program`＋`commit.gpgsign`、
`core.fsmonitor`（已被釘死）、`core.sshCommand`、`credential.helper`。
**該清單本身必須有一條測試證明它跟得上 git**，或改為在 `promotionGitEnvironment()` 用
`GIT_CONFIG_KEY_n` 把它們全部釘死並在文件寫明。
（這是 [[PITFALLS]] #101／#103 在同一輪的原地復發：attributes 那半已改成「直接問 git」，
這半仍是手寫列舉——而且專案自己知道這個類別，`process-runner.ts` 特地釘死了 `core.fsmonitor`。）

**(B) 第 5 項要求「觀察來的」但沒要求「觀察不到時必須可區分」。**
本輪程式做對了（讀不到＝欄位缺席、讀到但無 hook＝`[]`，兩者不折疊），但**沒有測試**——
把兩個 `return null` 改成 `return []` 時 61/61 全綠。
**補**：凡宣稱「未讀到」與「讀到而為空」不折疊者，**必須有一條讓讀取真的失敗的測試**。

**(C) 第 7 項「可觀察的排他標記」沒寫粒度。**
per-approval 的 UNIQUE 索引照字面就滿足，但那對 main 沒有任何保護。
**補**：排他標記**必須對 `mainPath` 排他**（例如以 `main_path` 為鍵、`state='applying'` 的 partial
unique index）。若做不到，必須由 Owner 明確把「對 main 排他」一併移入殘餘風險並寫下失效條件——
**不得停留在「裁決說沒放寬、實作其實沒有」的狀態**。

**(D) 沒有任何一項管「Owner 側的釋放／放棄動作」。**
第 11 項只說「必須有產品側路徑可以釋放」，於是本輪新增的 `abandonMergeProcessGroup()`
一出生就沒有標準約束它——實測它會接受一個 `ps` 證明**還在寫 main** 的 merge，
並**當場遞出可複製貼上的 `git reset --hard`**（[[PITFALLS]] #94 的災難形狀）。
**補**：任何釋放／放棄型動作**必須有自己的拒絕條件測試**，
且**不得在破壞性操作進行中遞出破壞性復原指令**；確認短語必須說出正在放棄的是什麼。

### 第四輪修正紀錄（2026-08-06，對照第三輪審查的 P0／P1／P2）

第三輪不通過。以下逐項對照，每一列的「守它的測試」都在 `test/merge-promotion.test.ts`，
每一列的「突變」都是**實際跑過整份檔案**的（清單與輸出見本節末）。

| 發現 | 修正 | 守它的測試 |
| --- | --- | --- |
| **P0（BLOCKER）** `gpg.program` 是一條完全沒被綁定的任意程式執行路徑。實測：candidate worktree 在**核准之後**寫入 `commit.gpgsign=true`＋`gpg.program=<script>`，`git merge --no-ff` 建立 merge commit 時**以 Owner 身分執行了它**；綁定、揭露、消耗前重驗三道全部看不到，因為 `hookEnvironment()` 只收 `core.hooksPath`＋hook 檔雜湊＋`merge.*.driver`＋`filter.*`。對照組 `core.hooksPath` 與 `merge.evil.driver` 被正確拒絕，證明缺口是特定的 | **兩個機制並用，理由分開講。** (a) **釘死**：`promotionGitEnvironment()` 用 `GIT_CONFIG_KEY_n`（command-line 優先序，蓋過 `.git/config`）把 `core.fsmonitor`／`commit.gpgsign`／`tag.gpgsign`／`merge.verifySignatures` 全部設為 false。選它是因為「哪個 `gpg.program` 的值代表不要執行任何東西」沒有答案，而 `commit.gpgsign=false` 讓 git 根本不去問。**代價明寫：promotion 產生的 merge commit 不簽章，也不驗證被合併方的簽章。** (b) **綁定整份 config**：`hookEnvironment().configDigest` 是 main 在 promotion 環境下 `git config --list -z` **原始輸出**的 SHA-256（含這份程式碼從未聽過的鍵與其值），納入 `previewDigest` → 綁定 → 消耗前重驗。**(b) 不是清單**，這是它存在的理由：(a) 與揭露用的 `programs` 都是列舉，而列舉外部系統一定落後於它（[[PITFALLS]] #103）。揭露側 `programs` 只列**鍵名不列值**（`credential.helper` 之類的值可能夾帶秘密，值由 digest 覆蓋）。另：config 的列舉刻意在**移除產品自己的 `-c` 釘子**之後才讀，否則核准畫面會把產品的常數當成 repo 的設定回報給 Owner | 五條。四條是「核准後才寫入 → 拒絕且不執行」，形狀比照審查員的 `p3c`：`gpg.program`＋`commit.gpgsign`（**先斷言不裝產品的情況下 git 真的會執行它**，再斷言產品拒絕、marker 不存在、main HEAD 未動、candidate 仍為 `completed`）、`core.sshCommand`、`credential.helper`、以及 **git 裡根本不存在的鍵 `future.someTool.program`**——最後一條就是標準補正 (A) 要的「清單跟得上 git」的證明方式：**綁定那一半沒有清單**。第五條把簽章程式設在**核准之前**（因此沒有漂移可偵測），斷言 promotion 成功、程式**沒有被執行**、commit 的 `%G?` 為 `N`，且核准畫面逐項揭露了三個鍵、畫面上不含任何設定值 |
| **P1／F2** `abandonMergeProcessGroup()` 可對一個 `ps` 證明還在寫 main 的 merge 使用，並立刻遞出 `git reset --hard`（[[PITFALLS]] #94 的形狀） | 兩段式確認 + 復原指令改為觀察來的。leader 仍回答「活著」時，第一次呼叫**拒絕**並丟 `MergeAbandonStillRunningError`（帶 pid、唯讀 `ps` 指令、以及第二段短語）；第二段短語是 `STOP WAITING FOR A MERGE THAT MAY STILL BE WRITING TO MAIN`——**它說出正在放棄的是什麼**。`pending.release` 也隨狀態改變：leader 活著給長句，`MERGE_PROCESS_GROUP_UNDECIDABLE` 才給原本的短句。並且**只要那個 pid 還活著，`#recoveryHint` 一律不產生 `reset-to-pre-promotion`**，改為唯讀的 `inspect-live-merge`；這是每次讀取重新問的，程序真的結束後正常的復原指令會自己回來 | 既有的「the owner can stop a promotion waiting on a process group」擴充：斷言 `pending.release` 是長句、用短句呼叫被具名拒絕（並比對 pid 與回傳的短語）、成功釋放後 `recoveryKind === "inspect-live-merge"` 且指令**不含 `reset`**、`mergeGroupDisowned.whileRunning === true`；原本的「整棵樹逐位元不變、程序沒有被殺、錯 pgid／錯短語各拒一次」全部保留 |
| **P1／F4** 突變 J 全綠：`MAIN_MERGE_PROMOTION_STILL_OWNED` 守衛零覆蓋 | 守衛不變（它本來就是對的），補測試 | 新測試「a promotion whose owner process is still running cannot have its merge disowned」：把**這個測試程序自己的 pid**（保證活著、同一次開機）寫進 `owner_pid`，斷言 abandon 被 `MAIN_MERGE_PROMOTION_STILL_OWNED` 拒絕，**且拒絕的路上一個位元都沒寫**（`mergeGroupDisowned` 仍不存在、`mergePgid` 仍是原值） |
| **P1／F5** `owner_pid` 的 `EPERM` 判成「還活著」，與 pgid 的 `foreign` 相反，且無出路 | 兩件事。(a) **判準對齊**：`processAlive` 的 `EPERM` 改判為 `false`——這次 promotion 的 orchestrator 以 Owner 身分執行，一個屬於別人的 pid 不可能是它（與 `probe()` 完全相同的身分論證）。(b) **對稱的出路**：新增 `abandonPromotionOwnerProcess()`，短語 `STOP WAITING FOR THIS PROMOTION'S OWNER PROCESS`，要求記錄上的確切 pid，**不殺任何程序、不碰 main**，並且**在 merge leader 還活著時拒絕**（那會同時放棄呼叫者與寫入者）。Owner 的宣告寫進 `ownerProcessDisowned` 並在後續每次讀取都被尊重——它是決定，不是探測結果 | 兩條。「an owner pid now held by another user is not our process」用執行期從 `ps` 找出的、真的回 `EPERM` 的 pid（先斷言前提成立，找不到就**大聲失敗**），斷言該列不再等待；「the owner can stop a promotion waiting on its own owner process, but not while the merge runs」斷言：merge 還活著時被 `MERGE_ABANDON_REFUSED_MERGE_STILL_RUNNING` 拒絕、錯短語／錯 pid 各拒一次、成功後整棵樹逐位元不變、宣告在**重讀後仍然有效**、最後 Owner 自己復原 main 後同一個 task 可以重新 promote 成功 |
| **P2／排他粒度**（標準補正 C） | 排他標記改為**對 `main_path` 排他**：`CREATE UNIQUE INDEX ... ON candidate_merge_promotions(main_path) WHERE state='applying'`（結構性，未來的呼叫點不可能忘記——[[PITFALLS]] #74），並在 `#authorizeMainMerge` 內於**任何 live gate 之前**讀它，因此 Owner 得到的答案是「這個專案正在被另一次 promotion 寫入」而不是「你的工作樹很髒」（後者只是第一次 merge 剛好已經弄髒了它）。舊 v5 資料庫在開啟時補建該 index；補建失敗（代表同一個 main 已經有兩列 `applying`）以 `CANDIDATE_MERGE_PROMOTION_MAIN_PATH_NOT_EXCLUSIVE` **拒絕開啟**，不靜默降級 | 新測試「one project has one promotion applying at a time」：**第二個 task 的核准在任何東西開始寫入之前就取得**（所以拒絕不可能來自髒工作樹），第一個 promotion 的 hook 掛住時對第二個呼叫 `promoteMainMerge`，斷言拒絕碼是 `MAIN_MERGE_PROMOTION_MAIN_PATH_BUSY`、第二把核准**沒有被消耗**；另外直接對 SQLite 插入第二列 `applying` 並斷言資料庫自己拒絕 |
| **P2／突變 D 全綠**（`readExecutedHooks` 的兩個 `return null` 改 `return []`） | 程式不變，補測試 | 新測試「a hook trace that could not be read is absent, not an empty list of hooks」直接對 `readExecutedHooks()` 斷言四種輸入：不存在的路徑 → `null`、目錄 → `null`、**讀得到但沒有 hook 事件 → `[]`**、有一筆 hook → 精確的 `[{name, path, exitCode}]`。前兩者讓突變變紅，後兩者證明空陣列不是這條測試永遠的答案 |
| **P2／`foreign` 分支的記錄行為** | 無程式變更 | 既有的「a process group id now held by another user」除了「不阻擋」之外，另斷言記錄裡 `mergePgid === null` 與 `mergeGroup === null`（＝這一輪不再把那個號碼帶著走） |
| **P2／文件** | `docs/VERIFICATION.md` 原寫「第三輪 57 條」，實際 61 條，已更正；`docs/THREAT_MODEL.md` F26 與 `docs/DECISIONS.md` 的「全部納入綁定」是四個鍵的清單，已改寫為「釘死＋整份 config digest」並明說兩者都不宣稱窮盡（[[PITFALLS]] #104） | — |

**一項刻意的行為改變，分開講。** 把整份 config 納入綁定的代價是：核准存活期間**任何一次**對 main 的
`git config` 寫入（包含良性的）都會讓該次核准以 `MAIN_MERGE_APPROVAL_BINDING_CHANGED` 終局失效，
Owner 必須重新 preview 與核准。這是刻意選的方向（fail closed），已列入殘餘風險表。

**一項新的資訊揭露，分開講。** `MAIN_MERGE_PROMOTION_MAIN_PATH_BUSY` 讓能出示 approvalId 的呼叫者
（不必持有 token）分辨「這個專案正在被另一個 task 促進」。與第三輪已接受的
`MAIN_MERGE_PROMOTION_UNRESOLVED` 同類：不含路徑、commit、指紋或 pid，且昂貴的重新觀察沿用同一套
「便宜探測 → 節流 → 只對能出示 token 者無條件提供」。

### 第五輪修正紀錄（2026-08-07，對照第四輪審查的 P0／P1／P2）

第四輪不通過。根因是**第 3 項與第 10 項要求的揭露「根本沒有到達 Owner」**：資料在 payload 裡，
`public/room.js` 一個字都沒有渲染。以下逐項對照，每一列的「守它的測試」都指名檔案與測試名，
每一列的「突變」都是**實際跑過整份檔案**的（清單與輸出見本節末）。

| 發現 | 修正 | 守它的測試 |
| --- | --- | --- |
| **P0（BLOCKER）** 揭露那半沒有到達 Owner。實測：`public/room.js` 對 `promotion`／`hooks`／`programs`／`configDigest`／`overwrites`／`ignored` 的引用次數**全部為 0**，33 個 `merge-approval-*` DOM 元素裡沒有任何一個是給 hook 清單、設定鍵或被覆蓋的 ignored 路徑用的，`renderMergeRisks()` 只印 `knownRisks`／`conflicts`／`tests`／`mainDirty`。因此 Owner 在打 `MERGE INTO MAIN` 的那一頁看不到會以自己的身分執行哪些程式、雜湊是多少、哪些 ignored 檔案會被靜默覆蓋。`grantMainMerge` 有 GUI 出口（`src/ui/web.ts:1192`），所以不適用「第一輪刻意不接出口」的分輪豁免 | 三件事。(a) **新增 `renderMergePromotionDisclosure()`**，把 hook 檔名＋完整 SHA-256、`hooksPath`、`merge.*.driver`、`filter.*`、`programs` 鍵名與 `configDigest` 逐項渲染；(b) **覆蓋清單成為核准畫面的一等資料**：`inspectMergeApproval()` 每次回傳 live 的 `overwrites{checked,ignored,untracked,unavailable}`（先前只有 agent 面的 `previewMainMerge` 有，核准畫面只有一個數量與指紋——[[PITFALLS]] #86 的形狀），並納入輪詢簽章，所以對話框開著期間新出現的 ignored 檔案會重新渲染並重新上鎖；(c) **計入 scroll-gate**：揭露渲染在 `#merge-approval-diff`（scroll-gate 量測的那個區域）**之內**且在檔案清單之前，因此 Owner 必須捲過它才可能到底。四種情況各自是**具名阻擋條件**，且「沒讀到」與「讀到而為空」不折疊：快照早於閘門、`hooks.unreadable`、`overwrites` 缺席、`overwrites.checked !== true`（帶 unavailable 代碼），以及每一條 ignored／untracked 路徑各一條 | 兩層。**行為層（Node）**：`test/merge-promotion.test.ts`「the approval surface carries what would run and what would be silently overwritten」——真實 repo，斷言 approval 上的 hook 檔名與**實際檔案內容算出的 SHA-256**相等、driver 列出、`programs` 含 `gpg.ssh.defaultkeycommand`、`configDigest` 為 64 hex、`programs` **不含任何值**；接著在**核准之後**才於 main 放一個 ignored 檔案（`git status` 完全空白），斷言 `inspectMergeApproval().overwrites.ignored` 精確等於 `["secrets.env"]` 且該檔案的位元組未被動過。**渲染與閘門層**：真實瀏覽器 DOM 驗收，八個情境，見下方專節與 gate digest |
| **P0（文字）** 兩句全稱宣稱被證偽（[[PITFALLS]] #104）：`git-broker.ts:34`「Every configuration key present in this repository whose value can name a program git runs」與 `candidate-registry.ts:436`「every key in main's config that can name a program git runs」。反例 `gpg.ssh.defaultKeyCommand` 不在 `programs` 裡，而同檔 `git-broker.ts:165-170` 的註解**正確地**寫「explicitly NOT claimed to be all of them」——同一份程式碼裡兩句互相矛盾 | 兩句都改寫成「這個表達式**認得**的鍵，明確不是全部」，並把被證偽的那個反例寫進註解本身，讓下一個讀者看到的是證據不是保證。另把 `gpg\..+\.(?:program\|defaultkeycommand)` 加進 `CONFIG_NAMES_A_PROGRAM`——**這是修掉一個遺漏，不是宣稱下一個已被預料到**；完整性仍然只由 `configDigest` 承擔 | 同上那條測試斷言 `programs` 含 `gpg.ssh.defaultkeycommand`（突變 M8 拿掉該分支即變紅） |
| **P1／F-A（嚴重）** 兩個釋放動作互相鎖死，產生零產品路徑的死結。實測（審查員 `p-deadend.mjs`）：真實 merge 已被完全殺掉、`owner_pid` 與 `mergePgid` 各自被回收給同一使用者的活程序（同一次開機，正是 [[PITFALLS]] #105 的形狀）→ `abandonMergeProcessGroup` 回 `MAIN_MERGE_PROMOTION_STILL_OWNED`、`abandonPromotionOwnerProcess` 回 `MERGE_ABANDON_REFUSED_MERGE_STILL_RUNNING`、`can the task ever be promoted again: NO` | 三件事。(a) **具名**：`promotionPending` 把「兩個號碼同時活著」報成它自己的狀態 `PROMOTION_OWNER_AND_MERGE_STILL_RUNNING`，兩個 pid 都列出（`pid` ＋ `alsoBlockedBy.pid`），`release` 給的是真的能用的短語；(b) **第三條出路** `abandonPromotionEntirely()`，短語 `STOP WAITING FOR BOTH PROCESSES OF A PROMOTION THAT MAY STILL BE WRITING TO MAIN`——依補正 (D) 它**說出正在放棄的是兩個程序，而且其中一個可能還在寫 main**；要求記錄上的**兩個**確切號碼，**不殺任何程序、不碰 main**，並歸屬給 Owner；(c) **拒絕即路線**：兩個窄的釋放在這個狀態下都改丟 `MergePromotionDoublyBlockedError`（帶兩個 pid、兩條唯讀 `ps` 指令、能用的短語），不再是牆。順帶移除 `abandonPromotionOwnerProcess` 內已成為**不可達**的 `group === "merge-running"` 分支——不可達的守衛無法被測試 | 「both of a promotion's waits can be opened together when neither can be opened alone」：斷言 pending 具名且兩個 pid 都在、兩條 inspect 指令都不含 `reset`／`kill`／`clean`／`checkout`、兩個窄釋放各被 `MERGE_ABANDON_REFUSED_BOTH_PROCESSES_RUNNING` 拒絕一次、錯短語／錯 pid／錯 pgid 各拒一次、成功後**整棵樹逐位元不變**、**程序仍活著**、`recoveryKind === "inspect-live-merge"` 且指令不含 `reset`、宣告重讀後仍有效，最後 **Owner 自己結束 merge 並復原 main 後同一個 task 重新 promote 成功**（＝把 `NO` 變成 `YES`）。既有的兩條窄釋放測試各自調整成**只有一個**號碼在檔，所以它們仍然守著自己的狀態 |
| **P1／F-B（嚴重）** 排他索引把「一列讀不了」的爆炸半徑從一個 task 放大成整個專案。實測（`p-tamper.mjs`）：損毀一列 `applying` 的 `row_hash` 後，`promotions()` 具名回報 `unreadable`（好），但 task B 的 promote 被 `MAIN_MERGE_PROMOTION_MAIN_PATH_BUSY` 永久擋住，而唯一的釋放動作因為 `#promotionRow` 丟掉讀不了的列而回 `MAIN_MERGE_PROMOTION_NOT_FOUND`。[[PITFALLS]] #100 在新粒度上復發 | 兩件事。(a) **具名**：`#assertMainNotBusy` 對讀不了的列改丟 `MergeUnreadablePromotionError`（`MAIN_MERGE_PROMOTION_ROW_UNREADABLE`，帶該用的短語）——兩者都拒絕是對的（讀不了不等於 main 沒事），但那是兩個不同的問題、兩個不同的出口；(b) **受理**：`abandonMergeProcessGroup` 先用**不驗證完整性**的讀取取得那一列，讀不了時走 `#releaseUnreadablePromotion`，短語 `STOP LETTING AN UNREADABLE PROMOTION RECORD BLOCK THIS PROJECT`，只把 `state` 從 `applying` 移出，**刻意用裸 UPDATE 而不是 `#writePromotion`**——後者會重算 row hash，等於替一列損壞資料重新背書（[[PITFALLS]] #28／#57）。**該列仍然讀不了、仍然未結案**，它自己的 task 仍被 `#assertNoUnresolvedPromotion` 擋著；改變的只有「一列壞資料不再退休整個專案」 | 「one unreadable promotion row is named, and does not retire the whole project」：兩個 task 共用一個 main，第二個的核准在任何東西開始寫入**之前**取得（所以拒絕不可能來自髒工作樹），斷言拒絕碼是 `MAIN_MERGE_PROMOTION_ROW_UNREADABLE` 且帶短語、錯短語被同一個具名錯誤拒絕、釋放後**整棵樹逐位元不變**、程序沒有被殺、該列**仍為 `unreadable`**（沒有被「修好」）、`storedState` 為 `needs-manual-review`，最後 Owner 復原 main 後**第二個 task 一路 promote 成功** |
| **P1／F-C（文件）** 殘餘風險表寫「Owner 的路徑是 CLI／API 的 `promotions()`」，而 `grep -rn promotions src/main.ts src/ui src/mcp` 為零，`orchestrator candidates` 只有 `orphan-refs` 一個子指令 | 該欄改寫為更正，明說**沒有任何 CLI／HTTP 出口**、唯一呼叫方式是自己寫 Node script，並把「目前 Owner 沒有可用的成品路徑」列為未關閉項而不是既有能力（[[PITFALLS]] #77／#109 同形） | — |
| **P2** `promotionFacts()` 的第二個條件從未被測試到達（既有測試用 `rewindToV4()` 會整個 drop 掉 `promotion` 鍵，第一行 `if (facts === undefined)` 先接住）。[[PITFALLS]] #106 同形 | 程式不變（它本來就是對的），補測試 | 「a v5 snapshot taken before the configuration fields existed is terminal, not usable」：**v5 資料庫、`promotion` 鍵在、user_version 仍為 5**，只刪掉本輪新增的欄位，`configDigest` 與 `programs` **各跑一次**；在一個什麼都還沒讀過的 registry 上**先呼叫 `grantMainMerge`**（所以拒絕是 grant 路徑自己產生的，不是繼承自某次讀取），斷言 `PREVIEW_PREDATES_PROMOTION_GATES`、該列終局 `invalidated`、槽位釋放後可重新 request |
| **P2** 對活著的 merge 放棄等待**不會**釋放 task | 文件（見殘餘風險表新增列）。這是刻意的：釋放改變的是「這筆紀錄還在不在等某個 pid」，不是「main 發生了什麼」；後者只能靠重新觀察指紋收斂 | 既有的兩條釋放測試都在結尾斷言「Owner 自己復原 main 後才 `rolled-back` 並可重新 promote」，本輪新增的兩條也是 |

**一項刻意的行為改變，分開講。** `inspectMergeApproval` 現在每次都跑一次覆蓋掃描（**原文寫「一條有界
pathspec 的 `git` 指令」，2026-08-07 第五輪審查指出並更正：實際是兩條**——`git-broker.ts` 的
`untrackedAtPaths` 對同一份 pathspec 跑一次帶 `--ignored`、一次不帶，各有 30 秒逾時）。
它比同一條路徑上原本就在跑的綁定重驗便宜得多，但它確實是新增的每次輪詢成本，
且揭露的是 live main 的檔案路徑——那是 Owner 自己的專案，而這個端點本來就已回傳 `mainPath`
與逐檔清單，因此不擴大既有的揭露面。

**一項刻意的取捨，分開講。** 前端把「沒拿到 `overwrites`」當成阻擋條件，也就是說**舊 backend 配新前端**
會讓核准畫面完全鎖住。這是 fail closed 的方向，而反過來（沒拿到就當成沒事）正是 [[PITFALLS]] #89
說的 fail-open。

### 第五輪的突變測試（十個，全部實際跑過並附輸出）

方法與前三輪相同：把工作樹複製一份到臨時目錄、套用**一個**編輯、跑完整份
`test/merge-promotion.test.ts`、記下變紅的測試名，然後把該檔案從原始樹複製回去並以 SHA-256 確認
逐位元相同（每一列都印出 `restored=true`）。**基準線 `pass=77 fail=0`**（同一份臨時樹先跑過一次）。
**全綠要當成發現回報，不是好消息**（[[PITFALLS]] #97）——本輪**沒有任何一個是全綠**。

| # | 突變 | 結果 |
| --- | --- | --- |
| M1 | `promotionPending` 不再把「兩個號碼同時活著」報成它自己的狀態（退回第四輪的行為） | `pass=75 fail=2`：both of a promotion's waits can be opened together／the owner can stop a promotion waiting on its own owner process |
| M2 | `abandonPromotionEntirely` 不比對 pgid | `pass=76 fail=1`：both of a promotion's waits can be opened together |
| M3 | `abandonPromotionEntirely` 不比對確認短語 | `pass=76 fail=1`：同上 |
| M4 | `#assertMainNotBusy` 對讀不了的列退回 `MAIN_MERGE_PROMOTION_MAIN_PATH_BUSY` | `pass=76 fail=1`：one unreadable promotion row is named |
| M5 | `abandonMergeProcessGroup` 退回「讀不了就 NOT_FOUND」 | `pass=76 fail=1`：同上 |
| M6 | 讀不了的列不需要短語即可釋放 | `pass=76 fail=1`：同上 |
| M7 | `promotionFacts()` 改回 `return facts`（**審查員指名的那一個**） | `pass=76 fail=1`：a v5 snapshot taken before the configuration fields existed |
| M8 | `CONFIG_NAMES_A_PROGRAM` 拿掉 `defaultkeycommand`（改動 `src/core/git-broker.ts`） | `pass=76 fail=1`：the approval surface carries what would run |
| M9 | `inspectMergeApproval` 不再回傳被覆蓋的 ignored 路徑 | `pass=76 fail=1`：同上 |
| M12 | **反方向**（[[PITFALLS]] #107）：`mergeBlocking` 一律為真，也就是把「已結束的 group」也當成還在擋 | `pass=61 fail=16`，含 crash reconciliation、orphaned merge、pgid 身分、owner pid 身分等既有測試全部變紅 |

**兩件事沒有被自動化突變覆蓋，分開講。**
- **`public/room.js` 的渲染與 scroll-gate**：拿掉 `renderMergePromotionDisclosure()` 的呼叫只會讓
  `test/merge-dialog-acceptance.test.ts` 的 digest guard 變紅（那正是它的設計），**不會有任何行為測試變紅**，
  因為專案沒有 DOM 測試執行器。守它的是本輪的真實瀏覽器驗收＋digest guard，已列入殘餘風險表。
- **`collaboration-service.ts` 新增的兩段 ledger 文案分支**（`promotion-abandoned`、
  `unreadable-record-released`）**沒有測試**。它們只決定公開帳本上顯示哪一句中文，寫入 audit 的
  `detail` 由同一份既有程式碼組出；既有的 `merge-group-abandoned`／`owner-process-abandoned`
  兩段（第三／四輪加的）同樣沒有測試。**這是明說的缺口，不是宣稱已覆蓋。**

**另外兩個直接對審查員自己的 probe 跑的實測**（不是我的測試，是把 `/tmp/r4probes/` 的腳本
加上對新出口的呼叫後重跑）：

- `p-deadend.mjs`：`pending.code` 為 `PROMOTION_OWNER_AND_MERGE_STILL_RUNNING`、
  兩個 pid 都列出、四種窄釋放全部回 `MERGE_ABANDON_REFUSED_BOTH_PROCESSES_RUNNING`、
  `abandonPromotionEntirely(both numbers)` **ACCEPTED**，Owner 自行復原 main 後狀態轉 `rolled-back`，
  最後一行從 **`can the task ever be promoted again: NO`** 變成 **`YES requested`**。
- `p-tamper.mjs`：`task B promote` 從 `REFUSED MAIN_MERGE_PROMOTION_MAIN_PATH_BUSY` 變成
  `REFUSED MAIN_MERGE_PROMOTION_ROW_UNREADABLE`（具名），
  `release the unreadable row (correct phrase)` **ACCEPTED**，
  之後 task B 的拒絕碼變成 `MAIN_MERGE_APPROVAL_BINDING_CHANGED:mainDirtyFingerprint`
  ——也就是**不再被那一列擋住**，改為被「main 現在真的很髒」這個完全不同的條件擋住。

### 第六輪修正紀錄（2026-08-07，對照第五輪審查的 F1–F7 與標準第 11 項）

第五輪不通過。以下是這一輪的處置。每一列的「守它的測試」都實際跑過；突變清單見下一節。

| 發現 | 修正 | 守它的測試 |
| --- | --- | --- |
| **F1（P1）** 排他標記可在 merge 正在寫 main 時被無條件釋放：`ps -g` 證明 `git merge`＋hook＋`sleep` 三個程序都活著、main 已半套用（`A  a.txt`），`#releaseUnreadablePromotion` 仍**接受**短語 `STOP LETTING AN UNREADABLE PROMOTION RECORD BLOCK THIS PROJECT`——**一個字都沒提 main 可能正在被寫**——而且**傳進去的 pgid 完全被忽略**（`999999` 照樣接受）。擋住第二個 task 的是 `mainDirtyFingerprint`，正是「靠巧合擋住」（[[PITFALLS]] #109） | 三件事，都不依賴 row_hash（那正是壞掉的東西）：(a) 新增 `unreadableReleaseRequirement()`，用 `promotionGroupIdentity`／`mergeGroupState`／`ownerProcessAlive`（**這句在寫下的當下就是假的：那三者對讀不到的 `observation_json` 回 `null`，而 `null` 被當成「沒有 merge 活著」——見第七輪 F-1**）盡力探測 merge pgid 與 `owner_pid`，**`unknown` 也算活著**；(b) 任一還活著時短語改為 `MERGE_UNREADABLE_LIVE_ABANDON_CONFIRMATION` = `STOP LETTING AN UNREADABLE RECORD BLOCK THIS PROJECT WHILE ONE OF ITS PROCESSES IS STILL ALIVE AND MAY BE WRITING TO MAIN`，**短語說出 main 可能正在被寫**；(c) 看得到 merge group 時**必須寫出那個確切 pgid**。同一個要求也從 `#assertMainNotBusy` 的拒絕錯誤裡遞出去，兩處共用同一個函式，不可能各說各話 | 兩條，**兩個方向各一次**（[[PITFALLS]] #107）：「one unreadable promotion row is named…」（merge 真的活著——**先斷言 `groupAlive(pgid)` 為 true** 才往下測，[[PITFALLS]] #106——短語與 `MERGE_LIVE_ABANDON_CONFIRMATION` 兩種錯短語各拒一次、`pgid 999999` 拒一次、拒絕後 `storedState` 仍為 `applying`，正確短語＋正確 pgid 才接受）、「an unreadable record whose processes are gone is released with the shorter phrase…」（什麼都不活著時**長短語被拒**、短短語成立） |
| **F2（P1）** live 覆蓋掃描的 fail-closed 分支零測試：把 `#overwriteScan` 的 `catch` 改成 fail-open **594/594 全綠**。這條路徑經 `promotionBlockers()` 進 preview **與 authorize** 的閘門 | 無程式修正（既有行為本來就是 fail-closed），補的是它從來沒有的測試。**兩條都是真實失敗**：`-dash.txt` 是一個可以合法 commit 的檔名，broker 拒絕把開頭是 `-` 的路徑放進 git 的參數列（`INVALID_GIT_PATHSPEC`）；authorize 那一條在**核准之後**把 `.git` 的權限拿掉**只在那一次掃描期間**，`untrackedAtPaths` 本身完全沒有被替換，真的跑了一次 `git ls-files` 而它真的失敗 | 三條：「a scan that could not run is a closed gate at preview…」（`blockers` **精確等於** `["OVERWRITE_SCAN_UNAVAILABLE"]`——工作樹本身讀得到，所以這是唯一的理由——`overwrites.checked=false`、`requestMainMerge` 拒絕；同專案的另一個 task 仍可核准）、「…at the moment the approval is spent」（promote 拒絕且具名、main HEAD 與 `status` 不變、權限復原後**同一把 token 仍可成功**）、「a change set with more paths than one bounded pathspec is a closed gate, named」（2001 條 gitlink，`filesTruncated=false`，`OVERWRITE_SCAN_PATHSPEC_TOO_LARGE`） |
| **F3（P2）** 未經驗證的 repo 事實被寫進 audit chain，而註解宣稱它們全是 null | `mainBranch`／`candidateHead`／`recoveryRef`／`mainHeadBefore` 四個頂層欄位改為 `null`；row 自己的副本改放 `detail.unverifiedRowValues`，並以 `detail.unverifiedSource: true` 標明來源。**那句假註解已改寫，並明說它先前描述的與程式不符** | 一條走**產品接線**（`new CollaborationService(data)`）的測試，`promotion-abandoned` 與 `unreadable-record-released` **兩段 ledger 文案各一段斷言**：事件筆數各為 1、`audit.verify()` 為 true、四個欄位為 `null`、`unverifiedSource` 為 true、`unverifiedRowValues` 的兩個 head 為 40-hex 而 `mainBranch` 為 `main`、ledger 兩句中文各出現一次且不含專案路徑、`verifyChain` 為 true |
| **F4（P2）** 「已釋放」與「仍佔著排他標記」在下一次讀取被折疊回一個答案（違反第 13 項）：`storedState`／`releasedFromExclusiveMarker` 只存在於執行釋放那一次呼叫的回傳值 | 新增 `unreadablePromotionView(row)`，`promotions()` 與釋放動作的回傳值**共用同一個函式**（結構性，兩者不可能不一致）。`storedState` 直接來自 `state` 欄位、`holdsProjectExclusiveMarker` **每次讀取從 `state` 重新導出**、`release`（短語＋還活著的號碼＋唯讀 `ps` 指令）只在還佔著標記時出現且每次重新探測。Owner 的宣告本身改為**寫進該列的 `observation_json`**（原始文字保留，不重算 row hash，所以那一列仍然讀不了）才能被讀回來 | 上述兩條測試；釋放之後的每一項斷言都透過**另一個 `CandidateRegistry` 實例**讀取，包含「再釋放一次會被拒」 |
| **F5（P2）** `abandonPromotionEntirely` 的「只在雙重阻擋時受理」零覆蓋（拿掉守衛 77/77 全綠） | 無程式修正；補兩個方向的拒絕測試 | 一條：「the release that opens both waits is refused when only one of them is in the way」——**只有 merge 擋住**時拒絕、**只有 owner process 擋住**時也拒絕，且兩種狀態各自的窄釋放短語仍是可用的出路（所以拒絕不是死路） |
| **F6（P3）** `credential.<url>.helper` 的**鍵名**可把秘密渲染到核准畫面（瀏覽器實測 `SECRET_IN_PROGRAM_KEY_RENDERED: true`）。註解說「值不顯示是因為值可能夾帶秘密」，但秘密在**鍵**裡 | `git-broker.ts` 新增 `redactConfigSubsection()`，在鍵離開 `hookEnvironment()` **之前**遮蔽：`credential` 開頭的鍵，或任何 subsection 含 `://`／`@` 的鍵，一律變成 `<section>.<redacted>.<name>`。~~因此秘密既不上畫面，**也不進 SQLite 的 `preview_json`**。~~ **這句是全稱宣稱，已被第七輪證偽**：`redactConfigSubsection()` 當時只接到 `programs`，同一函式裡的 `drivers`／`filters` 整條繞過，秘密照樣上畫面也照樣入庫（見第七輪 F-2；鍵名已於第七輪修好，值仍逐字顯示並列在殘餘風險表）。`merge.<name>.driver`／`difftool.<name>.cmd` 這類「subsection 是 Owner 自己取的名字」不動 | 一條在 `test/git-broker.test.ts`，用真實 `git config` 寫入 `credential.https://x-access-token:<token>@github.com.helper`，斷言**整個 `HookEnvironment` 的 JSON 裡找不到那個 token**（不是斷言鍵變短——那會變成格式測試），並斷言 `credential.helper`／`difftool.mine.cmd`／`gpg.ssh.defaultkeycommand` 仍逐字列出，以及 `configDigest` 仍會因為改動該鍵的值而改變 |
| **F7（P3）** `repollMergeApproval` 每 5 秒觸發且**沒有 in-flight 守衛**（本輪為它新增了兩條各 30 秒逾時的 git 子程序）；`renderMergeDiff` 重繪**不重置** `region.scrollTop`（實測 22.5），而呼叫端註解宣稱會歸零——假註解 | 加上 `state.mergeApprovalPollInFlight`，並在 **`finally`** 清除（簽章沒變時上面會直接 `return`，清在 `catch` 會讓輪詢永久停住）；`renderMergeDiff` 結尾加 `region.scrollTop = 0`，並把那段註解改寫成陳述這一行的存在理由 | **真實瀏覽器 DOM**（見「第四次瀏覽器驗收」）：重繪後 `scrollTop 1504 → 0`、`scrolled true → false`、輸入框清空並鎖住，而 `blockers` 前後都是 0（所以原因只可能是重繪本身）；三次併發 tick 只送出 1 個請求，回應落地後守衛解除、下一次 tick 通過，簽章未變的 early-return 路徑也解除 |
| **標準第 11 項**（主代理裁決）：三個釋放動作與 `promotions()` 沒有任何 CLI／HTTP／MCP／GUI 出口，唯一觸發方式是 Owner 自己寫 Node script 打私有 SQLite | 新增 `orchestrator candidates promotions <workspace>`（列出；**第七輪更正：這裡原寫「唯讀列出」，而列出會重新觀察並寫入未結的紀錄，見第七輪 F-3**）與 `… release <promotion-id> --confirm <phrase> [--pid N] [--pgid N]`。**列出與需短語的釋放是兩個動詞**；呼叫哪一個釋放由 Owner 引用了哪些號碼決定（兩個號碼→`abandonPromotionEntirely`、只有 `--pid`→owner、只有 `--pgid` 或都沒有→`abandonMergeProcessGroup`，最後一種是讀不了的列唯一沒有號碼可引用的狀態）。路徑過 `workspaces.assertAllowed()`（比照 `orphan-refs`），room 由 workspace 反查。**這不是為 `promoteMainMerge` 開出口**——它仍然刻意沒有產品側路徑 | 兩層。純渲染與參數處理在 `test/main-cli.test.ts`（空清單／可讀列／讀不了的列各一段輸出斷言、六種被拒的參數形狀、四種分派各打一次並斷言呼叫序列精確等於 `["group:77","owner:88","both:88:77","group:NaN"]`、`helpText()` **不得**出現 `promote`）；**真實 registry＋真實被卡住的 promotion** 在 `test/merge-promotion.test.ts`（列出時輸出含真實 pgid 與唯讀 `ps` 指令、列出後紀錄仍是 `applying`、錯短語與錯 pgid 各拒一次、釋放後程序仍活著、整棵樹逐位元不變、`head` 不變） |

**一項本輪自己找到、但沒有修的，分開講。** `#liveGates` 的 `catch`（工作樹讀不到）**丟掉了覆蓋掃描自己的
答案**。原本想順手把它也帶上，當時判斷**那個 catch 在 preview 與 request 兩條路徑上都到不了**：
`#previewSnapshot` 更早就讀了 restore point 並直接拋出。**2026-08-07 更正：這個理由只對了一半。**
持久失敗（`chmod 000`）確實會先炸在 `#previewSnapshot`；但 `previewMainMerge` 對同一個 `mainPath` **讀了兩次** restore point，只讓**第二次**失敗（暫時性失敗：外接碟瞬斷、權限短暫改動、大 repo 逾時）
就會執行到這個 catch，實測回傳 `blockers = ["MAIN_WORKING_TREE_UNREADABLE"]`。
**不加第二個阻擋項這個決定維持不變**（一個阻擋項就足以拒絕），但假理由已改寫，並補上了第七輪的兩方向測試。

### 第六輪的突變測試（十一個，全部實際跑過）

方法與前幾輪相同：把工作樹複製一份到臨時目錄（`rsync --exclude .git --exclude node_modules`，
`node_modules` 以 symlink 共用）、套用**一個**編輯、跑完整份測試檔、記下變紅的測試名。
**基準線 `pass=84 fail=0`**（`test/merge-promotion.test.ts`）／`pass=7 fail=0`（`test/git-broker.test.ts`）
／`pass=6 fail=0`（`test/main-cli.test.ts`）。**全綠要當成發現回報，不是好消息**（[[PITFALLS]] #97）。

| # | 突變 | 檔案 | 結果 |
| --- | --- | --- | --- |
| M1 | `#releaseUnreadablePromotion` 不再問「有沒有東西還活著」，短語永遠是短的那句（**F1 的核心**） | `candidate-registry.ts` | `pass=83 fail=1`：one unreadable promotion row is named, and does not retire the whole project |
| M2 | 讀不了的列釋放時**忽略 pgid 參數**（審查員實測的原始行為，`999999` 照收） | `candidate-registry.ts` | `pass=83 fail=1`：同上 |
| M3 | **反方向**（[[PITFALLS]] #107）：短語永遠是長的那句，也就是「沒有東西活著」時也要求說出 main 可能正在被寫 | `candidate-registry.ts` | `pass=83 fail=1`：an unreadable record whose processes are gone is released with the shorter phrase, and stays released |
| M4 | `promotions()` 退回手寫的 `{state:"unreadable"}`（無 `storedState`／`holdsProjectExclusiveMarker`／`release`，**F4 的核心**） | `candidate-registry.ts` | `pass=81 fail=3`：one unreadable promotion row is named／an unreadable record whose processes are gone／the owner's two release declarations are recorded |
| M5 | `#overwriteScan` 的 `catch` 改成 fail-open `{checked:true, ignored:[], untracked:[]}`（**審查員指名的那一個**，先前 594/594 全綠） | `candidate-registry.ts` | `pass=82 fail=2`：a scan that could not run is a closed gate at preview／a scan that could not run refuses the promotion at the moment the approval is spent |
| M6 | 拿掉 `paths.length > MAX_OVERWRITE_SCAN_PATHS` 這個提前回答，讓它落到 broker 的通用失敗 | `candidate-registry.ts` | `pass=83 fail=1`：a change set with more paths than one bounded pathspec is a closed gate, named |
| M7 | `abandonPromotionEntirely` 的「只在雙重阻擋時受理」守衛改為只擋 `pending === undefined`（**F5 的核心**） | `candidate-registry.ts` | `pass=83 fail=1`：the release that opens both waits is refused when only one of them is in the way |
| M8 | 設定鍵不再遮蔽（`redactConfigSubsection` 拿掉，**F6 的核心**） | `git-broker.ts` | `pass=6 fail=1`：a secret carried in a configuration KEY is never disclosed, and keys that name nothing secret are |
| M9 | `unreadable-record-released` 的四個頂層欄位改回直接複製那一列的值（**F3 的核心**） | `candidate-registry.ts` | `pass=83 fail=1`：the owner's two release declarations are recorded, attributed, and assert nothing they did not read |
| M10 | CLI 不再依 Owner 引用的號碼分派，全部走同一個釋放動作 | `main.ts` | `pass=5 fail=1`：promotion records are listable and releasable from the CLI, and the two are separate verbs |
| M11 | CLI 拿掉 `release` 這個子指令名的檢查，任何參數都會觸發釋放（觀察與釋放不再是兩個動詞） | `main.ts` | `pass=5 fail=1`：同上 |

**三件事沒有被自動化突變覆蓋，分開講。**
- **`public/room.js` 的 `region.scrollTop = 0` 與 in-flight 守衛**：拿掉任一個只會讓
  `test/merge-dialog-acceptance.test.ts` 的 digest guard 變紅（那正是它的設計），**不會有任何行為測試變紅**，
  因為專案沒有 DOM 測試執行器。守它的是本輪的真實瀏覽器驗收＋digest guard，已列在殘餘風險表。
- **`collaboration-service.ts` 的兩段 ledger 文案**現在**有**測試（第六輪補上，見上表 F3 那一列），
  但那條測試斷言的是「這一句中文出現一次且不含專案路徑」，不是文案的內容正確——
  它擋得住分支被刪掉，擋不住句子被改成另一句同樣不含路徑的話。
- **M1／M2／M3 這三個突變跑在一份比最終交付樹早兩個編輯的複本上**：兩個編輯分別是
  (a) `#assertMainNotBusy` 只對能出示 token 的呼叫者附上 pid 清單（短語仍給所有人）、
  (b) `#releaseUnreadablePromotion` 內一段解釋「為什麼活著的 owner process 不額外要求號碼」的註解。
  兩者都不在被突變的行上，也沒有任何突變打在 `#assertMainNotBusy`；M4–M9 的複本則已同步到最終版本
  （已逐一 `diff` 確認，除該突變外逐行相同）。**這是明說的差異，不是宣稱等價。**

### 第六輪的完整 gate（2026-08-07，靜止樹，實際輸出）

`npm run check`（hygiene → syntax → typecheck → coverage 測試 → fuzz → SBOM → 本機掃描 → history 掃描）
**exit code 0**。實際數字：

```
ℹ tests 603
ℹ pass 603
ℹ fail 0
ℹ all files                         |  95.64 |    87.60 |   97.15 |
```

門檻為 line 90／branch 85／function 90，以 command exit code 為準而不是抄畫面百分比（[[PITFALLS]] #34）。
`test/merge-promotion.test.ts` 單獨跑為 `pass=84 fail=0`（第五輪基準為 77）。
**這是開發 repo 的數字；乾淨 clone 的數字未在本輪重測**，因此不宣稱兩者相同。

### 第七輪修正紀錄（2026-08-07，對照第六輪審查的 F-1～F-6）

第六輪不通過。**這一輪有兩句我自己寫下的全稱宣稱被證偽**（[[PITFALLS]] #104），各自標在下表對應列，
並已在原處改寫，不是刪掉。

| 發現 | 修正 | 守它的測試 |
| --- | --- | --- |
| **F-1（BLOCKER）** 第六輪的修復只覆蓋「損毀剛好沒碰到 payload」的子情況。第五輪的 probe 只把 `row_hash` 歸零；審查員把 `observation_json` 也一起損毀（兩種模式：整段非 JSON、以及合法 JSON 但缺 `mergePgid`／`mergeGroup`），第五輪的三個症狀全部回來：短短語被接受、`--pgid 999999` 被接受、排他標記在 `ps -g` 證明 merge leader＋hook＋sleep 都活著時被交還。**根因是結構性的**：`owner_pid` 有自己的欄位，`mergePgid`／`mergeGroup` 只存在 `observation_json`——而那正是損毀時第一個不能信的東西。`promotionGroupIdentity()` 對讀不到的 JSON 回 `null`，`unreadableReleaseRequirement()` 把 `null` 當成「沒有 merge 活著」，也就是往不安全方向決定（[[PITFALLS]] #85）。**被證偽的宣稱**：第六輪 F1 那列寫「三者都已把不可解析的 `observation_json` 當成『不決定任何事』」——已在原處標記並改寫 | 三件事。(a) **把 merge 的 pgid 與開機時刻搬進 `candidate_merge_promotions` 的獨立欄位** `merge_pgid`／`merge_boot_at_sec`（比照 `owner_pid`）。欄位不由呼叫端傳入，而是在 `#writePromotion` 內**從即將寫入的 observation 推導**，所以走過那個 helper 的列不會持有兩個不同的答案，也不會有人忘記在 merge 結束時清掉它（[[PITFALLS]] #74／#102）。**唯一不維護這一對的寫入是 `#releaseUnreadablePromotion`**（它刻意以 raw UPDATE 改一列本來就讀不了的 payload），而 `#assertPromotionRow` 無論如何都把「欄位與 payload 不一致」判為損壞。(b) 新增 `durableMergeIdentity()`：~~欄位優先、`observation_json` 次之（給沒有欄位的舊列）~~**——「欄位優先」已於第八輪被實測證偽並改寫，見下方第八輪 P0 那列：欄位非 null 就 return、永遠不看 payload，正是第七輪 P0 的根因。現在三個來源都讀，兩個來源打架時答案是「不可讀」**——並回傳 `readable` 旗標——**「讀不到 merge 身分」與「探測不出來」一樣算活著、一樣只給長短語**。(c) 相容性：`mergePromotionHash()` 只在兩個欄位至少有一個非 null 時才把它們納入雜湊，所以前一個 commit 寫出的列雜湊不變；欄位以 `ALTER TABLE ADD COLUMN` 在開啟時冪等補上（比照既有的 `#assertPromotionExclusivity`），~~不需要版本號變更~~**——第八輪 P2-11 更正：不動版本號讓「降版」方向沒有名字，舊 build 會在 SQLite 內部炸出 `has 19 columns but 17 values were supplied`。版本已改為 v6** | 三條。「a promotion row whose payload is destroyed with its hash still names the merge writing main」——**先斷言 `groupAlive(pgid)` 為 true**（[[PITFALLS]] #106）並在每一步重新斷言，兩種損毀模式各跑一次，各自斷言短短語被拒、`pgid 999999` 被拒、拒絕後 `storedState` 仍為 `applying`、`release.alive` 精確等於 `[["merge", pgid]]`；接著**連欄位也毀掉**，斷言 `alive` 為空但 `probeReadable` 為 `false`、短短語仍被拒、釋放後 merge 仍活著且整棵樹逐位元不變。同一條測試裡另有一段**雜湊有效但欄位與 payload 不一致**的情境（`observation_json` 被改成「沒有 group」並把雜湊算回去），斷言該列被判為不可讀且仍具名那個 `ps -g` 看得到的 pgid——這一段是突變 M15 打出來的缺口。「a destroyed payload does not make a finished merge block the project forever」是**反方向**（[[PITFALLS]] #107）：同樣毀掉 payload，但 merge 真的結束了，於是短短語才是能用的那一句、長短語被拒；**第三段**是欄位為空且 payload 明說 `mergePgid: null` 時短短語仍然成立——這一段是突變 M3 打出來的缺口。「a promotion row written before the merge-group columns existed still opens, and still blocks」覆蓋標準第 11 項 |
| **F-2（P2）** `redactConfigSubsection()` 只接到 `programs`，同一個函式裡三行之外的 `drivers`／`filters` 整條繞過。實測（真實 `git config` 寫入合成 token）：兩份清單各自逐字帶出 URL 形狀鍵裡的 token，token 同時上核准畫面（`public/room.js:3005-3006`）也同時以位元組存在 SQLite。**被證偽的宣稱**：第六輪 VERIFICATION F6 與 THREAT_MODEL F26 第五次更正都寫「所以秘密既不上畫面也不進資料庫」——**這是 [[PITFALLS]] #108 在同一輪原地復發**，兩處都已標記並改寫 | `drivers`／`filters` 的**鍵名**改走同一個 `redactConfigSubsection()`。**值仍逐字顯示**，這是刻意的取捨並已在殘餘風險表寫明：對這兩份清單而言值就是 git 會執行的指令 | 一條新的，在 `test/git-broker.test.ts`，用真實 `git config` 寫入**非 `credential`** 的 URL 形狀鍵（`merge.<url>.driver` 與 `filter.<url>.clean`）——既有測試只打到遮蔽函式的第一臂，這條才打得到第二臂。斷言整個 `HookEnvironment` 的 JSON 裡找不到那兩個 token、`merge.mine.driver` 與 `filter.lfs.clean` 仍逐字列出（含值）、`configDigest` 與 `fingerprint` 仍會因為改動該鍵的值而改變 |
| **F-3（P2）** `orchestrator candidates promotions` 自稱唯讀，實際會寫入權威列、audit chain 與 room ledger。審查員以 `orphan-refs` 為對照組實測：對照組的 promotion row、audit 筆數與三個 sqlite 摘要全部未變，這一條全變（該對照組本輪未由我重跑；我重跑的是寫入側，見右欄測試）。**寫入本身是第 13 項要求的收斂，不是 bug；標示才是** | CLI 表頭、`helpText()`、`describePromotions()` 的註解與殘餘風險表四處全部改成實話：「列出時會重新觀察並更新未結的紀錄；這裡沒有任何東西會寫入 main」。**節流沒有一致化**，理由分開講（見下） | 兩條。`test/main-cli.test.ts` 斷言新文案存在、`Read-only.` 不再出現、`helpText()` 不再有 `# read-only`；`test/merge-promotion.test.ts` 的「listing promotions re-observes and updates the record」用真實 registry 斷言一次列出就讓 `state` 與 `row_hash` 都改變、且送出恰好一筆 `re-observed` 事件，第二次列出不再送 |
| **F-4（P2）** `#liveGates` 的 fail-closed catch 零測試，而上一輪寫下的「到不了」理由只對了一半：持久失敗確實先炸在 `#previewSnapshot`，但 `previewMainMerge` 對同一個 `mainPath` **讀了兩次** restore point，只讓第二次失敗就會執行到那個 catch | 註解改寫成實話並附上實測結果。**不加第二個阻擋項這個決定維持不變**，理由寫在原處 | 一條，兩個方向各打一次：先斷言一次 preview 確實讀了 **2 次**（否則這條測試在測別的東西），再讓**第 1 次**失敗（拋出，也就是舊註解描述的那條路）與讓**第 2 次**失敗（回傳 `blockers` 精確等於 `["MAIN_WORKING_TREE_UNREADABLE"]`、`hooks.unreadable` 為 true），最後斷言恢復後同一份 snapshot 的 `previewDigest` 不變且重新可核准（暫時性失敗不得燒掉東西） |
| **F-5（P3）** `unreadable-record-released` 的 `detail.aliveAtRelease` 在 F-1 情境下寫成 `[]`，而 `ps` 證明三個程序活著；旁邊的 `unverifiedSource: true` 不涵蓋這一個 | `unreadableReleaseRequirement()` 多回一個 `probeReadable`，並帶進三個地方：`UnreadableMergePromotion.release`、`MergeUnreadablePromotionError`、以及寫進該列 `observation_json` 的 `unreadableRecordReleased` 與 audit `detail`。CLI 在 `probeReadable === false` 時多印一行 `alive UNKNOWN — …that is not the same as nothing running` | F-1 那條測試斷言 `release.probeReadable` 為 `false`、錯誤物件上的 `probeReadable` 為 `false`、以及**durable 紀錄裡**的 `unreadableRecordReleased.probeReadable` 為 `false`；`test/main-cli.test.ts` 斷言 CLI 那一行存在且該情況下不印 `--pgid` |
| **F-6（P3）** `unknown` 的兩條分支都沒有測試，而它們可達：任何 pid ≥ 2³¹ 讓 `process.kill` 丟 `ERR_INVALID_ARG_TYPE`（既非 `ESRCH` 也非 `EPERM`）。`promotionPgid` 允許到 2⁵³、`owner_pid` 的 CHECK 只有 `> 0`。**被證偽的宣稱**：第三輪寫的「第四個答案在公開介面上不可達」，已在原處標記並改寫 | 加上具名的 `MAX_PID = 2**31 - 1`，在 `probe()`（對絕對值，因為 group 探測傳的是 `-pgid`）與 `processAlive()` 兩處回 `unknown`／`null`。**刻意不在 `promotionPgid` 那一層拒絕**：把一個無法探測的號碼過濾成「沒有記錄任何 group」就是 fail-open | 兩條新測試，都不需要替換 `process.kill`：「a recorded process group too large to be a pid blocks the answer instead of settling it」與「an owning process id too large to be a pid keeps the record waiting rather than settling it」。兩條都**先實測 `process.kill` 對這個號碼確實丟出既非 `ESRCH` 也非 `EPERM` 的錯誤**（[[PITFALLS]] #106），再斷言產品阻擋、並斷言各自的釋放動作仍是能用的出路 |

**F-3 的「順帶」項沒有一致化，理由分開講。** 審查員指出 `promotions()` 每次呼叫都跑一次無節流的全樹重新雜湊，
而 `#assertNoUnresolvedPromotion` 對同一件事有節流。查證後**刻意不改**：`#assertNoUnresolvedPromotion`
的節流是針對**未認證呼叫者**（`options.authenticated === false`）的阻斷式防護，而 `promotions()`
在整個產品裡只有一個呼叫端——`src/main.ts` 的 CLI（`grep -rn "\.promotions(" src` 只有兩個呼叫點，`src/main.ts:363` 與 `src/main.ts:387`，都在
`runCandidatePromotionsCommand` 內），是 Owner 自己在終端執行的。給它加節流會讓「重新觀察」這個
它唯一存在理由的動作在 Owner 連按兩次時靜默回傳舊答案，那正是第 13 項禁止的形狀。
**這是一個決定，不是遺漏。**

### 第七輪的突變測試（十六個，全部實際跑過）

方法與前幾輪相同：把工作樹複製到臨時目錄（`rsync --exclude .git --exclude node_modules`，
`node_modules` 以 symlink 共用）、套用**一個**編輯、跑測試、記下變紅的測試名。
**與前幾輪不同的一點要先說清楚**：本輪用 `--test-name-pattern` 只跑相關子集（`test/merge-promotion.test.ts`
單檔完整跑一次要約 7–25 分鐘，跑十六次不可行）。因此下表的 `pass/fail` 是**該子集**的數字，
每一列都附上它的基準線。這是明說的方法差異，不是宣稱等價。

**子集基準線**（未突變的樹，實際輸出）：
`payload` → `tests 2 / pass 2`；`payload|shorter phrase` → `3/3`；`payload|process group` → `8/8`；
`merge-group columns` → `1/1`；`too large to be a pid` → `2/2`；`second read` → `1/1`；
`test/git-broker.test.ts` 的 `configuration KEY|filter KEY` → `2/2`；
`test/main-cli.test.ts` 的 `promotion records are listable` → `1/1`。

| # | 突變 | 檔案 | 結果 |
| --- | --- | --- | --- |
| M1 | `unreadableReleaseRequirement` 退回只讀 `observation_json`（**F-1 的核心**） | `candidate-registry.ts` | `pass=1 fail=1`：a promotion row whose payload is destroyed with its hash still names the merge writing main |
| M2 | 讀不到的 payload 被當成「沒有 merge」（`readable: true`） | `candidate-registry.ts` | `pass=1 fail=1`：同上 |
| M16 | 讀不到 merge 身分時**不**升級成長短語（只看 `alive.length`） | `candidate-registry.ts` | `pass=1 fail=1`：同上 |
| M3 | **反方向**（[[PITFALLS]] #107）：`readable` 永遠 `false`，也就是「payload 明說沒有 group」時也要求長短語 | `candidate-registry.ts` | **第一次全綠 → 這是一項發現**（見下）；補測試後 `pass=2 fail=1`：a destroyed payload does not make a finished merge block the project forever |
| M4 | `#writePromotion` 把上一列的 `merge_pgid` carry-forward，而不是從即將寫入的 observation 重新推導（[[PITFALLS]] #102 的形狀） | `candidate-registry.ts` | `pass=7 fail=1`：the owner can stop a promotion waiting on a process group, without anything being killed |
| M15 | 拿掉「欄位與 payload 必須一致」的檢查 | `candidate-registry.ts` | **第一次全綠 → 第二項發現**（見下）；補測試後 `pass=1 fail=1`：a promotion row whose payload is destroyed… |
| M5 | `mergePromotionHash` 一律把兩個新欄位納入雜湊（也就是破壞前一個 commit 寫出的列） | `candidate-registry.ts` | `pass=0 fail=1`：a promotion row written before the merge-group columns existed still opens, and still blocks |
| M6 | `#assertPromotionGroupColumns()` 變成不呼叫（舊資料庫拿不到欄位） | `candidate-registry.ts` | `pass=0 fail=1`：同上 |
| M7 | `probe()` 對超出 `MAX_PID` 的號碼回 `"gone"`（fail-open 方向） | `candidate-registry.ts` | `pass=1 fail=1`：a recorded process group too large to be a pid blocks the answer instead of settling it |
| M8 | `processAlive()` 對超出 `MAX_PID` 的號碼回 `false` | `candidate-registry.ts` | `pass=1 fail=1`：an owning process id too large to be a pid keeps the record waiting rather than settling it |
| M14 | 直接拿掉 `probe()` 的 `MAX_PID` 守衛 | `candidate-registry.ts` | **全綠——已查證為等價突變**（見下） |
| M13 | 釋放紀錄不再寫入 `probeReadable`（**F-5 的核心**） | `candidate-registry.ts` | `pass=1 fail=1`：a promotion row whose payload is destroyed… |
| M10 | `#liveGates` 的 `catch` 改成 fail-open（`blockers: []`）（**F-4 的核心**） | `candidate-registry.ts` | `pass=0 fail=1`：a restore point that fails only on the second read is a closed gate, not an open one |
| M9 | `drivers`／`filters` 的鍵名不再遮蔽（**F-2 的核心**） | `git-broker.ts` | `pass=1 fail=1`：a secret in a merge driver or filter KEY is not disclosed, and the command it runs still is |
| M11 | CLI 表頭改回 `Read-only.`（**F-3 的核心**） | `main.ts` | `pass=0 fail=1`：promotion records are listable and releasable from the CLI, and the two are separate verbs |
| M12 | CLI 拿掉 `probeReadable === false` 那一行揭露 | `main.ts` | `pass=0 fail=1`：同上 |

**M3 第一次全綠，這是本輪第一項發現，照 [[PITFALLS]] #107 的三段排除法查過。**
不是「測試前置條件沒被滿足」（#106）：兩條 payload 測試都跑到了。也不是等價突變：
`durableMergeIdentity` 最後那個 `return` 決定「欄位為空、payload 解析得開、而且 payload 明說沒有 group」
算不算一個**答案**。M3 把它改成「永遠不算答案」，於是短短語永遠不可用——那是「安全但把唯一出路關掉」，
正是標準第 11 項禁止的形狀，而**沒有任何測試打得到那一格**，因為我原本兩條測試的列都還有欄位。
補了第三段情境（欄位為空 ＋ payload 明說 `mergePgid: null` ＋ 什麼都沒活著 → 短短語成立）之後才變紅。

**M15 第一次全綠，這是第二項發現。** `#assertPromotionRow` 新增的「欄位與 payload 必須一致」檢查
在既有測試裡打不到，因為那些情境的 `row_hash` **本來就已經壞了**，拿不拿掉這個檢查都是不可讀。
真正需要它的形狀是**雜湊有效而內容不一致**——也就是有人改了 payload 又把雜湊算回去。
補了那條測試（觀察 payload 被改成「沒有 group」但欄位仍指向一個 `ps -g` 看得到的 merge，
斷言該列被判為不可讀且仍具名那個 pgid）之後才變紅。**沒有這個檢查，那一列會讀起來完全正常、
回報沒有任何 pending，然後被下一次觀察結案——而 merge 還在寫。**

**M14 全綠，且已查證為等價突變，照 #107 的補正條款分開講。**
拿掉 `probe()` 的 `MAX_PID` 守衛之後，`process.kill(2147483648, 0)` 仍然會丟
`ERR_INVALID_ARG_TYPE`，`code` 既不是 `ESRCH` 也不是 `EPERM`，所以 `catch` 照樣回 `"unknown"`
——**可觀察行為完全相同**，任何測試都殺不掉它。守衛留著的理由寫在它自己的註解裡：
讓那個答案來自這裡寫下的決定，而不是來自 Node 的參數驗證剛好往安全方向丟例外。
新測試裡的 `assert.throws(() => process.kill(beyondPid, 0), …)` 就是這個機制的實測。

**沒有被突變覆蓋的部分，分開講。**
`public/room.js` 本輪**一個字都沒改**（`drivers`／`filters` 的遮蔽發生在伺服器端，
畫面上的兩行渲染程式碼不變），所以 `test/merge-dialog-acceptance.test.ts` 的 digest guard 仍然是綠的，
**第六輪的瀏覽器驗收沒有過期，也不需要重跑**。`collaboration-service.ts` 的 ledger 文案本輪未改。

### 第七輪的完整 gate（2026-08-07，靜止樹，實際輸出）

`npm run check`（hygiene → syntax → typecheck → coverage 測試 → fuzz → SBOM → 本機掃描 → history 掃描）
**exit code 0**。實際數字：

```
ℹ tests 611
ℹ pass 611
ℹ fail 0
ℹ all files                         |  95.74 |    87.75 |   97.14 |
EXIT=0
```

門檻為 line 90／branch 85／function 90，以 command exit code 為準而不是抄畫面百分比（[[PITFALLS]] #34）。
`test/merge-promotion.test.ts` 單獨跑為 `tests 91 / pass 91 / fail 0`（第六輪基準為 84）。
**這是開發 repo 的數字；本輪未重測乾淨 clone**，因此不宣稱兩者相同。
**這一段文字是在 gate 跑完之後才寫進本檔的**，也就是那次 gate 跑的樹與交付樹的唯一差異就是這一段；
除此之外沒有任何檔案在 gate 執行期間被修改。

### v2 的第四處補正（2026-08-07，第七輪審查後）—— **這一處是為了停止打地鼠**

第七輪審查員指出一個關於**流程**而非缺陷的模式：

> 第五輪打 `row_hash` → 第六輪修 `row_hash`；第六輪打 `observation_json` → 第七輪修 `observation_json`；
> 我這輪打欄位 → **可以預期第八輪會修欄位**。

**根因在標準，不在實作。** 第 11、12 項都圍繞「不可讀的列」，
但**沒有一句說「不可讀」要用哪些損毀形狀證明**，於是每一輪的修復都精確貼合上一輪 probe 的落點。

**(E) 損毀模型必須以「類」定義，不得列舉欄位名。**
凡涉及「資料損毀後仍須 fail closed」的要求，必須各有一條測試涵蓋下列**三類**：

1. **任一單欄位損毀**（包含新加的欄位——`row_hash`、`observation_json`、`merge_pgid`、
   `merge_boot_at_sec`，以及未來任何新增的）
2. **任兩欄位的組合損毀**（至少涵蓋「一個權威來源壞、另一個完好」這個形狀）
3. **雜湊有效但內容互相矛盾**（沒有任何欄位「壞掉」，但兩個來源給出不同答案）

**加新欄位時，這三類的測試必須跟著擴充**——否則新欄位只是把損毀的**落點集合**縮小，
沒有縮小**結果集合**（第七輪實測：本 build 寫出的列，把 INTEGER 欄位損毀成 NULL 就重現同一結果）。

**(F) 「兩個來源不一致」必須是它自己的答案，不得挑一個當權威。**
第七輪的洞完全落在這裡：`#assertPromotionRow` **已經偵測到**欄位與 payload 不一致並判為
`ROW_TAMPERED`，然後**把那個偵測結果丟掉**——`durableMergeIdentity()` 一看到欄位非 null 就
`return { readable: true }`，**永遠不看 payload**。
**已經發現兩個來源打架，卻挑其中一個當權威、還標成「可讀」。**

規則：**任何「A 優先、B 次之」的讀取，當 A 與 B 都存在且不相等時，答案必須是「不可讀」**，
且回報必須把**兩個**值都列出來。這是 [[PITFALLS]] #85 的一般化——
「我不知道該信哪一個」不得被折疊成「我信這一個」。

**(G) 第 12 項的措辭補強。**
原文只說「pgid 仍存在時不得下結論」。第七輪的洞照字面**完全合規**：
`durableMergeIdentity` 回一個（錯的）號碼、探測到它已死、於是下結論。
改為：「**pgid 仍存在，或無法確定 pgid 是哪一個時**，都不得下結論。」

**(H) 產品對使用者說的話必須為真，且必須有斷言守著。**
13 項裡沒有任何一條要求這件事（[[PITFALLS]] #116）。
本輪修掉 `promotions` 的 `Read-only.`，但 `orphan-refs` 的 `# read-only; lists, never deletes`
**仍然沒有任何「執行前後資料庫位元組相同」的斷言**——它靠的是第六輪審查員手跑的對照組，
而**那份證據住在審查報告裡，不在 repo 裡**（[[PITFALLS]] #81 的形狀）。
規則：任何 CLI 輸出、`helpText()`、畫面文字或 docs 的**性質形容詞**
（「唯讀」「不刪除」「全部」「一律」「既不…也不…」），必須有一條測試或 probe 佐證。

### 第八輪修正紀錄（2026-08-07，對照第七輪審查的 P0／P1／P2／P3）

第七輪不通過。**這一輪也有我自己寫下的全稱宣稱被證偽**（[[PITFALLS]] #104），
標在下表對應列，並在原處改寫而不是刪掉。

審查員的 probe 是 `scratchpad/r7/p7-col.mjs`，五種模式全部由我重跑，**修復前後的實際輸出都在下表**。

| 發現 | 修正 | 守它的測試 |
| --- | --- | --- |
| **P0（BLOCKER）** 三種損毀形狀全部 ACCEPTED（短短語＋`--pgid 999999`），而 `ps -g` 同時證明 `git merge`＋`pre-merge-commit`＋`sleep 900` 三個程序活著、main 已半套用（`A  a.txt`）：(a) `merge_pgid` 改成 999999（payload 完好且指向活著的 merge）、(b) `merge_boot_at_sec` 改成 1、(c) 欄位 NULL＋payload 是合法 JSON 但缺 `mergePgid`。三種情況產品都回報 `alive: []`、`probeReadable: true`、短短語。**根因**：`#assertPromotionRow` 已經偵測到「欄位與 payload 不一致」並判為 `ROW_TAMPERED`，`durableMergeIdentity()` 卻一看到欄位非 null 就 `return { identity: column, readable: true }`，**永遠不看 payload**——已經發現兩個來源打架，卻挑一個當權威還標成可讀。三個 ⛔ 之後 task B 都只被 `MAIN_MERGE_APPROVAL_BINDING_CHANGED:mainDirtyFingerprint` 擋下，也就是**上一輪 commit message 宣稱不再依賴的那個巧合** | 四件事。(a) **`durableMergeIdentity()` 讀三個來源**：兩個欄位、`observation_json`，以及**第三個不住在資料庫裡的來源**——這次促進的 `promotion-traces/<id>.jsonl`（git 自己的 trace2 stream，`sid` 尾端以十六進位帶著 git 程序自己的 pid，而 git 是 detached 起的所以 pid＝pgid）。[[PITFALLS]] #115 要問的正是「B 是不是也住在 A 裡面」——兩個欄位與 payload 共用同一列，trace 檔不是。(b) **兩個 in-row 來源都答且答案不同 → `readable: false`**，而且**每一個候選各自探測**、`alive` 逐一具名，不再只探測「偏好的那一個」。新增 `recordedGroups`（帶來源名的完整清單）進到 `UnreadableMergePromotion.release`、`MergeUnreadablePromotionError`、durable 的 `unreadableRecordReleased` 與 audit `detail`，CLI 也逐行印出並在不一致時多印一行。(c) `columnMergeIdentity()` **拒收半對**（有 pgid 沒 boot）：每一次寫入都同時寫這兩欄，所以半對是損毀不是舊格式（[[PITFALLS]] #105）。(d) 釋放時 pgid 必須等於**任一個**具名的活著 merge，不再是「第一個」 | 三條新測試，各自先 `assert(groupAlive(pgid))` 並在每一步重新斷言（[[PITFALLS]] #106），三種損毀落點一條一條打：`merge_pgid` 改死號碼、`merge_boot_at_sec` 改別的開機、兩欄 NULL＋payload 合法但無 group。各自斷言：`ps -g` 真的看得到 `git merge`、短短語以兩個號碼各試一次都被拒、`--pgid 999999` 連長短語也被拒、`alive` 精確等於 `[["merge", 那個 ps 看得到的 pgid]]`、`probeReadable` 為 `false`、`recordedGroups` 同時含兩個號碼、拒絕後 `storedState` 仍為 `applying`、**task B 以 `MAIN_MERGE_PROMOTION_ROW_UNREADABLE` 被擋（不是 `mainDirtyFingerprint`）**、merge 仍活著、整棵樹逐位元不變 |
| **P1-6** `merge_boot_at_sec` 只有「它存在」的斷言，沒有任何斷言在守「它有用」（[[PITFALLS]] #83 同形）。突變 A（`columnMergeIdentity()` 永遠回 `bootAtSec: null`）12/12 全綠 | 不改行為，補行為測試；並順帶把「半對」定為損毀（見 P0 (c)） | 一條新測試「the merge-group columns are the only source, and the boot in them is part of the answer」，**把 trace 檔刪掉**讓欄位真的是唯一來源，三段互相需要：(1) 產品自己寫的欄位必須具名那個 merge；(2) 同一個**活著**的 pid 配上「另一次開機」的 boot 必須**停止**計數（先斷言 `kill(pgid,0)` 仍成功，否則這段什麼都沒證明）；(3) pgid 在、boot 被 NULL 掉＝(E) 的第二類（兩欄位組合損毀）→ 不可讀、長短語 |
| **P1-7** `durableMergeIdentity` 的「payload 解析出來不是物件」分支零覆蓋，突變 D 12/12 全綠 | 不改行為，補測試 | 一條新測試「a payload that parses to something other than an object answers nothing about the merge」，三種形狀（`[1,2,3]`／`42`／`"a string"`）各打一次。merge **先被結束**、trace 檔**先被刪掉**，所以 `alive` 為空的原因與 payload 無關——這條測的只有短語，而只有 payload 能移動它 |
| **P1-8** 殘餘風險第 126 列被實測證偽（「不可讀路徑會從欄位讀回 pgid 並要求長短語——方向是 fail-closed」）；第 125 列的範圍應從「舊列」擴為「任何 `merge_pgid` 為 NULL 的列」 | 兩列都已改寫（見下方殘餘風險表，原文以刪除線保留）。**第 125 列同時被實作縮小**：`promotion-traces` 這個第三來源讓「欄位 NULL＋payload 說沒有 group」不再等於「沒有 merge 在跑」——只要 trace 檔還在。**trace 檔也不見時仍然無法分辨**，那一格照實留在殘餘風險表 | P0 的第三條測試就是這一格；另有一段把 trace 檔刪掉、斷言 `alive` 為空且 `probeReadable` 為 `false` |
| **P2-9** 上一輪 commit message 的兩句全稱宣稱被證偽 | 在本檔標記並改寫，見本表下方「被證偽的宣稱」小節。**commit message 本身不能改**（歷史不可改寫），所以更正住在這裡 | 不適用（文件） |
| **P2-10** 「值逐字顯示」那一列敘述不完整；merge driver 的 argv 是否真的落進 `promotion-traces/*.jsonl` 只是推論 | 殘餘風險那一列改寫，補上 (a)(b)(c) 三句。**並且實測了那個推論**：見下方「merge driver argv 的實測」 | 不適用（文件＋一次性實測） |
| **P2-11** 降版時 `table candidate_merge_promotions has 19 columns but 17 values were supplied` 是 SQLite 的原始訊息，不是具名錯誤 | **schema 版本 v5 → v6**。舊 build 的 `version > SCHEMA_VERSION` 檢查會在**開啟時**就以 `CANDIDATE_REGISTRY_SCHEMA_UNSUPPORTED` 拒絕，不再走到它自己的位置式 INSERT。`#upgrade` 新增 `from === 5` 分支（只動版本號，欄位仍由冪等的 `#assertPromotionGroupColumns()` 補上，每一列的 `row_hash` 不變） | 一條新測試「a v5 promotion database upgrades by name, and a newer one is refused before anything is written」：先**實測**舊 build 的十七值位置式 INSERT 對 v5 形狀確實有效（否則這條測的是別的東西）、再斷言開啟後版本變 6 且 `row_hash` 逐字不變、最後以 `user_version=7` 走同一個守衛斷言具名拒絕 |
| **P3-12** `src/main.ts:195` 的 doc comment 仍寫「the read-only listing」 | 改寫，並在同一段寫明它為什麼不是唯讀 | 不適用（註解）；同一句話的產品面由 `test/main-cli.test.ts` 的 `Read-only.` 斷言守著 |
| **P3-13** `orphan-refs` 的 `# read-only; lists, never deletes` 沒有任何「執行前後資料庫位元組相同」的斷言，唯一證據住在第六輪審查報告裡（[[PITFALLS]] #81） | 不改行為，補測試 | 一條新測試「\`orphan-refs\` says read-only, and the bytes of every database are the same afterwards」。量測是**成對括起來的**：只開關不做事是基準線，所以比較的是掃描本身而不是開資料庫的代價；而且**先驗敏感度**——一個確實會寫的 bracket 必須讓摘要改變，否則位元相等是為了錯的理由通過（[[PITFALLS]] #97）。同時斷言那個 ref 掃描完仍在（句子的後半） |

**probe 的實際輸出（`scratchpad/r7/p7-col.mjs`，五種模式，修復前後各跑一次）**：

| 模式 | 修復前 | 修復後 |
| --- | --- | --- |
| `baseline`（只毀 `row_hash`，對照組） | REFUSED，`alive=[{merge,pgid}]`，`probeReadable:true` | 不變 |
| `col-pgid` | **ACCEPTED**，`alive=[]`，`probeReadable:true` | REFUSED，`alive=[{merge,那個 ps 看得到的 pgid}]`，`probeReadable:false` |
| `col-boot` | **ACCEPTED**，`alive=[]`，`probeReadable:true` | 同上 |
| `col-null-key` | **ACCEPTED**，`alive=[]`，`probeReadable:true` | 同上 |
| `both-gone` | REFUSED，`alive=[]`，`probeReadable:false` | REFUSED，`alive=[{merge,pgid}]`（trace 具名它），`probeReadable:true` |

三個 ⛔ 之後 task B 的答案也從 `MAIN_MERGE_APPROVAL_BINDING_CHANGED:mainDirtyFingerprint`
變成 `MAIN_MERGE_PROMOTION_ROW_UNREADABLE`。

**被證偽的宣稱（`5363edd` 的 commit message，兩句）。** commit message 不能改寫，更正住在這裡：

- ~~「A merge whose identity cannot be read counts as running.」~~ **假。** `col-null-key` 情境下，
  身分讀不到（欄位 NULL、payload 沒有 group）而產品回報 `alive: []`、`probeReadable: true` 並接受短短語。
  正確的敘述是：**修復後**，「兩個來源打架」與「沒有任何來源答得出來」都算不可讀，而不可讀一律要求長短語；
  但它在第七輪並不成立。
- ~~「turned away by name instead of by the accident of a dirty worktree」~~ **只在損毀落在 payload 時成立。**
  損毀落在欄位時，task B 得到的正是 `mainDirtyFingerprint`。修復後三種落點都以
  `MAIN_MERGE_PROMOTION_ROW_UNREADABLE` 具名擋下（有測試）。

**merge driver argv 的實測（P2-10 的推論改為實測）。** 在 `mktemp -d` 的臨時 repo 上，
以 `merge.mine.driver` 設定一個帶合成 token 的指令、`.gitattributes` 寫 `* merge=mine`，
製造雙邊都改同一檔案的 merge，並以 `GIT_TRACE2_EVENT` 收 trace。結果：

```
{"event":"child_start",...,"child_class":"?","use_shell":true,
 "argv":["/tmp/driver-marker.sh SECRET-TOKEN-abc123 .merge_file_… .merge_file_… .merge_file_… 7 'f.txt'"]}
```

**driver 的完整指令列（含嵌在裡面的 token）逐字進入 trace 檔**，也就是會逐字進入
`promotion-traces/<id>.jsonl`。附帶一個與 `readExecutedHooks` 有關的細節：它的 `child_class` 是 `"?"`
而不是 `"hook"`，所以**不會**出現在 `hooksExecuted` 清單裡——位元組在檔案裡，但那份清單看不到它。

### 第八輪的突變測試（十五個，全部實際跑過並附輸出）

方法與前幾輪相同：`rsync` 複製工作樹到臨時目錄（`node_modules` 以 symlink 共用）、套用**一個**編輯、
跑測試子集、記下變紅的測試名。**子集基準線**（未突變的樹，實際輸出）：
`tests 11 / pass 11 / fail 0`，pattern 為
`payload|a live merge is still named when|only source, and the boot|other than an object|merge-group columns existed|shorter phrase|v5 promotion database|orphan-refs`。
`N` 的基準線是 `test/main-cli.test.ts` 的 `promotion records are listable` → `1/1`。

| # | 突變 | 檔案 | 結果 |
| --- | --- | --- | --- |
| **E** | **欄位優先、看到就 return（第七輪的原形，本輪的核心決定）** | `candidate-registry.ts` | `pass=8 fail=3`：payload is destroyed…／merge_pgid column…／merge_boot_at_sec column… |
| **E2** | **反方向**（[[PITFALLS]] #107）：payload 優先、看到就 return | `candidate-registry.ts` | `pass=9 fail=2`：merge_pgid column…／merge_boot_at_sec column… |
| A | `columnMergeIdentity()` 永遠回 `bootAtSec: null` | `candidate-registry.ts` | `pass=9 fail=2`：merge_boot_at_sec column…／only source, and the boot… |
| B | `#writePromotion` 不把 boot 寫進欄位 | `candidate-registry.ts` | `pass=6 fail=5` |
| C | `columnMergeIdentity()` 接受半對（有 pgid 沒 boot） | `candidate-registry.ts` | `pass=10 fail=1`：only source, and the boot… |
| D | payload 解析出來不是物件時算「有答案」 | `candidate-registry.ts` | `pass=10 fail=1`：parses to something other than an object… |
| F | 拿掉 `promotion-traces` 這個第三來源 | `candidate-registry.ts` | `pass=9 fail=2`：payload is destroyed…／both merge columns are NULL… |
| G | 只探測「達成共識的那一個」，不逐一探測候選 | `candidate-registry.ts` | `pass=8 fail=3` |
| H | 「紀錄說沒有 group，但有一個 group 還活著」不再視為矛盾 | `candidate-registry.ts` | `pass=10 fail=1`：both merge columns are NULL… |
| I | `sameMergeGroup()` 只比 pgid、不比 boot | `candidate-registry.ts` | `pass=10 fail=1`：merge_boot_at_sec column… |
| J | 釋放不再要求引用看得到的號碼 | `candidate-registry.ts` | `pass=7 fail=4` |
| K | `#upgrade` 沒有 `from === 5` 分支 | `candidate-registry.ts` | `pass=10 fail=1`：v5 promotion database upgrades by name… |
| L | `SCHEMA_VERSION` 退回 5 | `candidate-registry.ts` | `pass=10 fail=1`：同上 |
| M | `orphanRecoveryRefs()` 順手寫一次資料庫 | `candidate-registry.ts` | `pass=10 fail=1`：\`orphan-refs\` says read-only… |
| N | CLI 不再印 `recorded …` 那幾行 | `main.ts` | `pass=0 fail=1`：promotion records are listable… |

**十五個全部變紅，沒有需要依 #106／#107 排除的全綠案例。**
這裡只能宣稱「這十五個突變會被抓到」，不能宣稱「所有突變都會被抓到」（[[PITFALLS]] #104）。

**沒有被突變覆蓋的部分，分開講。** `public/room.js` 本輪**一個字都沒改**
（`recordedGroups` 目前只走 CLI 與 API，核准畫面的揭露路徑未動），
所以 `test/merge-dialog-acceptance.test.ts` 的 digest guard 仍然是綠的，
**第六輪的瀏覽器驗收沒有過期**。`src/main.ts:195` 的 doc comment 是註解，沒有突變覆蓋它；
它旁邊那句對使用者說的話由 `test/main-cli.test.ts` 守著。

### 第九輪的突變測試（十八次，全部實際跑過）

方法：`cp -R` 複製工作樹到臨時目錄（`node_modules` **用複製不是 symlink**）、套用**一個**編輯、
跑測試子集、記下變紅的測試名。**基準線**（未突變的樹）：每個子集皆 `fail 0`。

**第一組——(I) 的直接檢驗：把七條路徑中的一條從「四來源」改回「一來源」。**
子集為三個來源類的測試（`no path concludes about a live merge when …`，基準線 `3/3`）。

| # | 突變 | 結果 |
| --- | --- | --- |
| **R1** | **`promotionPending()` 改回只讀 `observation_json`（第八輪 BLOCKER 的原形）** | `pass=1 fail=2`：「列內兩個來源沒拿到 group」「列內兩個來源明說沒有 group」 |
| PATH1 | `#resolvePromotion()` 傳 `NO_TRACE_READING` | `pass=1 fail=2`：同上兩條 |
| PATH2 | `#publicPromotion()` 傳 `NO_TRACE_READING` | `pass=1 fail=2`：同上兩條 |
| PATH5 | `abandonMergeProcessGroup()` 傳 `NO_TRACE_READING` | `pass=1 fail=2`：同上兩條 |
| PATH3 | `#assertNoUnresolvedPromotion()` 傳 `NO_TRACE_READING` | **全綠——等價突變**（見下） |
| PATH4 | `#assertMainNotBusy()` 傳 `NO_TRACE_READING` | **全綠——等價突變**（見下） |

**PATH3／PATH4 全綠，依 [[PITFALLS]] #107 的三段排除法逐條查過，結論是等價突變（第二類），
不是沒有覆蓋。** 前置條件確實成立（#106）：那兩條路徑在測試裡都被驅動到，
`requestMainMerge` 與另一個 task 的 `promoteMainMerge` 都真的被呼叫並真的被拒。
它們全綠的原因是**結構性的**：那兩處的 `promotionPending()` 是一條**快速路徑**——
它下面緊接著就是 `#resolvePromotion(row)`，而 `#resolvePromotion` 自己也問同一個
`promotionPending()`（PATH1），一列還在被寫的促進在那裡一定維持 `applying`，
於是兩條路徑都仍然拋出**同一個錯誤碼**。可觀察行為的差別只有「有沒有做一次全樹雜湊」。
**保留那兩處佈線的理由**：快速路徑存在的目的就是避免那次昂貴的重新觀察，
一個沒接來源的快速路徑會在 `#resolvePromotion` 下次被改動時變成 fail-open。

**第二組——審查員設計的五個突變（P1-5），以及本輪新決定的其餘部分。**

| # | 突變 | 檔案 | 結果 |
| --- | --- | --- | --- |
| **X1** | `traceBootAtSec()` 永遠回 `null` | `candidate-registry.ts` | `fail=2`：the boot a trace-named merge belongs to…／a process group recorded before a reboot…（**兩個方向各一條**） |
| **X3** | trace 的 sid 解析不到時回 `NO_TRACE_READING` | `candidate-registry.ts` | `fail=1`：a trace that proves a merge started without naming it… |
| **X4** | 拿掉 `trace.spawned ?` | `candidate-registry.ts` | `fail=1`：同上 |
| **X5** | 釋放路徑不再把 `unknown` 算活著 | `candidate-registry.ts` | `fail=1`：a recorded group nobody can ask about… |
| **contested** | `contested = false` | `candidate-registry.ts` | `fail=1`：a record whose two in-row sources contradict each other… |
| MTIGHT | 只由 trace 命名的 group 可以讓一列變成「已回答」（取消 (M)） | `candidate-registry.ts` | `fail=1`：a group named only by git's trace… |
| N1 | `#recordMergePgid` 失敗時不寫 spawn-record marker | `candidate-registry.ts` | `fail=1`：a merge whose process-group write failed… |
| **N2** | 「marker 存在 ⇒ 未回答」那條規則整條拿掉 | `candidate-registry.ts` | **第一次全綠 → 查證為第三類（真的沒有覆蓋）→ 補測試後變紅**（見下） |
| DIS | 拿掉「Owner 已放棄的 group 要從每一個來源移除」 | `candidate-registry.ts` | `fail=1`：the owner can stop a promotion waiting on a process group… |
| HALF | 拿掉「兩個欄位半對即損毀」 | `candidate-registry.ts` | `fail=1`：half of the merge-group column pair… |
| CLI | 把 `waiting nothing — this record is not blocked on any process` 放回去 | `main.ts` | `fail=3`：三個來源類的測試全部變紅 |
| SPAWN | `process-runner` 的 `onSpawn` 恢復靜默吞 | `process-runner.ts` | `fail=1`：a spawn listener that throws… |

**N2 的處理過程照 #107 的補正條款走**：全綠 → 先查前置條件（#106，成立：測試確實到達那個分支）
→ 再查是否等價（**不是**：在「列不可讀＋marker 在＋所有號碼都探測已死」這個形狀下，
有無那條規則會給出不同的短語）→ 判為第三類「真的沒有覆蓋」，
於是補了一條專門的測試（`a record whose group was never written asks for the longer phrase even
with nothing alive`，兩個方向各打一次），重跑同一個突變即變紅。

**十八次裡有十六次變紅、兩次全綠且已查證為等價突變。**
這裡只能宣稱「這十八個突變會被抓到」，不能宣稱「所有突變都會被抓到」（[[PITFALLS]] #104）。

**沒有被突變覆蓋的部分，分開講。** `public/room.js` 本輪**一個字都沒改**
（`recordedGroups` 多了一個來源名 `spawn-record`，但它只走 CLI 與 API），
所以 `test/merge-dialog-acceptance.test.ts` 的 digest guard 仍然是綠的，
**第六輪的瀏覽器驗收沒有過期**。

### 第八輪的完整 gate（2026-08-07，靜止樹，實際輸出）

`npm run check`（hygiene → syntax → typecheck → coverage 測試 → fuzz → SBOM → 本機掃描 → history 掃描）
**exit code 0**，開發 repo 與**乾淨 detached clone** 各跑一次，兩者數字相同：

```
ℹ tests 618
ℹ pass 618
ℹ fail 0
ℹ all files                         |  95.79 |    87.67 |   97.23 |
EXIT=0
```

### 第九輪的完整 gate（2026-08-07，實際輸出）

**乾淨 detached clone**（`git clone --no-hardlinks` → `checkout --detach ba273e2` → rsync 交付樹 →
`cp -R node_modules`，跑完 `diff -r -q` 兩棵樹逐檔相同 exit 0）：

```
ℹ tests 631
ℹ pass 631
ℹ fail 0
ℹ all files                         |  95.87 |    87.83 |   97.20 |
CLONE-EXIT=0
```

**同一台機器、同一時刻，對照組 `ba273e2`（不含本輪任何改動）**：618/618、
`all files 95.79 | 87.64 | 97.18`、exit 0。兩者逐項相當，本輪新增 13 條測試。

**靜止的開發工作樹**（同一份樹，機器空閒）：631/631、
`all files 95.86 | 87.81 | 97.25`、`TREE-EXIT=0`。

**這一節與上一節（第五處補正的實作對照）是在上述 gate 跑完之後才寫進本檔的**，
也就是那些 gate 跑的樹與交付樹的唯一差異就是這幾段文字；因此
`npm run check` 在**最終交付樹上——也就是連同這一段文字在內的這一份樹——**又完整跑了一次
（hygiene、`security-scan`、`history-scan` 都會讀 `docs/`）：**631/631、exit 0**。
那一次之後本檔一個字都沒有再改，所以被 gate 的樹與交付樹逐位元相同。

**⚠️ 量測環境的一則實測，值得記下**：先前兩次在**開發工作樹**上跑的 gate（與其他重活同時進行）
量到 `candidate-registry.ts` 只有 58.7%、`all files` 90.7／91.1——仍然 exit 0，但差了五個百分點。
同一份樹在**機器空閒**的乾淨 clone 上是 97.60／95.87，對照組也是 97.74／95.79。
所以那兩個數字是**併發量測的假象**，不是覆蓋率下降；
[[PITFALLS]] #34 說「只能以 exit code 為準」在這裡是字面成立的，
而**在同時跑其他測試的機器上量覆蓋率，量到的百分比不能拿來比較**。

門檻為 line 90／branch 85／function 90，以 command exit code 為準而不是抄畫面百分比（[[PITFALLS]] #34）。
第七輪基準為 611 條，第八輪 618（新增 7 條：三條損毀落點、欄位／boot 行為、非物件 payload、
v5→v6 升級與降版、`orphan-refs` 位元組不變）；第九輪 631（新增 13 條，見上方第五處補正的實作對照）。

**clone 的做法**：`git clone --no-hardlinks` 後 `checkout --detach 8802edd`，
再把工作樹 rsync 上去，`node_modules` **用 `cp -R` 複製而不是 symlink**；
跑完以 `diff -r -q`（排除 `.git`／`node_modules`／`dist`）確認兩棵樹逐檔相同（exit 0）。

**這一段文字是在兩次 gate 都跑完之後才寫進本檔的**，也就是那兩次 gate 跑的樹與交付樹的唯一差異就是這一段；
除此之外沒有任何檔案在 gate 執行期間被修改（所有原始碼與文件的 mtime 都早於 gate 啟動時刻）。

### v2 的第五處補正（2026-08-07，第八輪審查後）—— **打地鼠第二次復發，這次改根**

第四處補正 (E) 已經要求「損毀模型以類定義、不得列舉欄位名」。第八輪的實作仍然是打地鼠：
三個 landing 的標籤與第七輪 probe 的三個模式（`col-pgid`／`col-boot`／`col-null-key`）**一一對應**。
**(E) 被讀成「三個 SQLite 欄位落點」**，於是新增一個不在資料庫裡的來源之後，
三類矩陣沒有跟著擴張——**落點集合縮小了，結果集合沒有**
（第八輪用**可讀的列、零竄改**重現了完全相同的三個症狀）。

**(I) (E) 的「類」以「來源」定義，且「每一條會下結論的路徑」都要各跑一次三類。**
第八輪的 BLOCKER 完全落在後半：三來源比對做得很好，但**只接到「可不可以釋放排他標記」，
沒接到「可不可以下結論」**——而後者才是會遞給 Owner 一行 `git reset --hard` 的那條。
`promotionPending()`／`#resolvePromotion()`／`#observeMain()` 只讀 `observation_json` 一個來源。
規則：**新增或修好一個判斷之後，必須列出「還有哪幾條路徑會做同一個判斷」，並逐條驗證。**

**(J) (F) 擴及「只讀 A、根本不看 B」。**
原文只規範「A 優先、B 次之」的**偏好**。第八輪最嚴重的破口住在這個縫裡——
可讀路徑不是偏好錯來源，是**不知道有 B**。
「偏好錯來源」與「不知道有那個來源」是兩種病，第二種不會被偏好規則涵蓋。

**(K) 第 1 項的 kill 窗不得列舉。**
原文列了四個窗（[[PITFALLS]] #103 的形狀）。第八輪找到**第五個**：
`git merge` 已 spawn、pgid 尚未寫入 SQLite——而它是唯一一個會讓**意圖紀錄無法唯一決定判讀**的窗。
改為：「**每一個會讓意圖紀錄不完整的步驟邊界**」各驗一次。

**(L) (H) 擴及「事實斷言」，不只「性質形容詞」。**
第八輪的 CLI 印出 `waiting nothing — this record is not blocked on any process`，
而 `ps -g` 同時列出 `git merge`＋hook＋`sleep 900`。
**那不是形容詞，是事實斷言，而它是假的**，且沒有任何斷言守著。

**(M) 【新增】觀察來源不得由被觀察的對象控制。**
第八輪把第三來源移出資料庫（git 的 trace 檔）——方向對，
但 **`GIT_TRACE2_EVENT` 的路徑出現在 hook 的環境變數裡**，
而 hook 正是本階段引入的、以 Owner 身分無沙箱執行的新信任邊界。
實測：hook 偽造一個 sid 指向死號碼 → `probeReadable: true`、短短語**被接受**、排他標記交還，
而 `ps -g` 同時列出活著的 merge。**錯號碼的方向是 fail-open。**
規則：**新增任何觀察來源時，必須說明「被觀察的對象碰得到它嗎」**；
碰得到就不得作為放寬的依據，只能作為收緊的依據。
這是 [[PITFALLS]] #115 的下一層：B 不住在 A 裡面了，但 **B 住在「A 要防的那個東西」手上**。

**(N) 靜默吞掉的失敗必須留痕。**
第八輪的零竄改重現路徑是：`#recordMergePgid` 的 `catch { return row; }`
＋ `process-runner` 的 `catch {}` **雙層靜默吞**，
於是「pgid 沒記到」與「沒有 pgid 可記」在紀錄上**完全無法區分**。
規則：凡是「這次寫入是某個事實存在的唯一證據」的地方，
**寫入失敗必須在紀錄裡留下具名痕跡**，並讓後續讀取一律走保守路徑。

### 第五處補正的實作對照（2026-08-07，第九輪修復）

**(I) 「還有哪幾條路徑會做同一個判斷」——全部列出，逐條驗證。**
會決定「可不可以對這次 promotion 下結論」的路徑共**七條**，全部經過同一個
`promotionPending(row, trace)`，而 trace 現在是**必要參數**，型別系統強迫每一個呼叫點帶上
（[[PITFALLS]] #74 的手法，這次用在讀取面）：

| # | 路徑 | 它決定什麼 |
| --- | --- | --- |
| 1 | `promotions()` → `#resolvePromotion()` → `#observeMain()` | 紀錄本身與它遞出的復原指令 |
| 2 | `#publicPromotion()` | 列表／CLI 印出的 `pending` |
| 3 | `#assertNoUnresolvedPromotion()` | 這個 task 的下一次核准 |
| 4 | `#assertMainNotBusy()` | 同一個專案裡**其他每一個** task |
| 5 | `abandonMergeProcessGroup()` | merge group 的釋放 |
| 6 | `abandonPromotionOwnerProcess()` | owner 程序的釋放 |
| 7 | `abandonPromotionEntirely()` | 兩者一起釋放 |

第八輪只有「不可讀列的釋放要求」那一條接到三來源比對；上表七條**全部**讀
`observation_json` 一個來源。第九輪把比對集中到 `mergeIdentityStanding()`，
七條各自驅動一次，測試在
`no path concludes about a live merge when …`（三個來源類各一次，每次跑完七條）。

**(E)＋(I) 三類損毀模型以「來源」定義。** 來源現在有四個：`column`、`payload`（在列裡），
`trace`、`spawn-record`（不在列裡）。三類是：
(1) **列內兩個來源根本沒拿到 group**（p8-race 形狀：那一次寫入失敗）；
(2) **列內兩個來源明說沒有 group**（p8-readable 形狀：雜湊正確重算、列完全通過完整性檢查）；
(3) **列外兩個來源都不回答**（trace 與 marker 都不在，列內那對必須自己撐住）。
**三類都不動 row_hash**——這正是重點：三個形狀走的都是**可讀路徑**。
新增第五個來源時，這張表要跟著加一列。

**(J) 「只讀 A、根本不看 B」。** `promotionPending()`／`#observeMain()` 現在拿
`durableMergeIdentity(row, trace)`。「payload 說沒有 group，但列外來源說有、而且它活著」
的答案是**不得下結論**：那個號碼一律被探測，探到活著就阻擋，並且
`answered` 被拉掉（`outsideRowOnly && alive.length > 0`）。

**(K) 第五個 kill 窗。** 新增 fault point `merge-pgid-record`，測試
`a promotion killed between spawning git and recording its group does not settle`
在 `git merge` 已 spawn、pgid 尚未進 SQLite 的那一刻對真實程序送 **SIGKILL**，
斷言新程序不得下結論、不得遞出復原指令；反方向斷言 merge 結束後紀錄會收斂。

**(L) 事實斷言。** CLI 的 `waiting nothing — this record is not blocked on any process`
改為 `waiting no process this record names is still being waited on`
——描述這一列記到什麼，不宣告 repo 現況。三個來源類的測試各有一條斷言守著它不會在
merge 活著時出現，反方向斷言 merge 結束後它會出現。

**(M) 觀察來源不得由被觀察的對象控制。** 採**明文降級**（reviewer 給的第三個選項）：
trace 命名的號碼只進候選集合去探測（只會增加拒絕的理由），
**永遠不能讓一列變成「已回答」**。`p8-trace.mjs` 四種模式現在全部 REFUSED。
沒有採「寫到 hook 看不到的 fd／路徑」的理由已實測並記在殘餘風險表：
`GIT_TRACE2_EVENT=<fd>` 確實讓 hook 只看到 `3`，但 `lsof -p $$` 仍列得出路徑，
所以那是遮蔽不是邊界。

**(N) 靜默吞掉的失敗留痕。** `#recordMergePgid` 失敗時寫一個
`promotion-traces/<id>.spawn-record.json`（0600，owner-only 目錄，不交給任何被觀察的對象），
內含那次寫入正在攜帶的 pgid 與 boot；讀取端把它當第四個來源，並且
**它一出現，該列的「已回答」一律為 false**。`#observeMain` 把
`mergeIdentityUnrecorded: true` 寫進觀察，CLI 逐字印出。
`process-runner` 的第二層 `catch {}` 改為在 `ProcessResult` 上回報 `spawnRecordFailed`，
兩個方向各有一條測試。

### v2 的第六處補正（2026-08-07，第九輪審查後）—— **換框架，不是再加一個維度**

前五次補正連起來看是一個失敗的方法：

| 輪次 | 標準當時說什麼 | 攻擊者換到哪個維度 |
|---|---|---|
| 7 → 8 | 損毀不得列舉**欄位名** | 新增一個不在資料庫裡的**來源** |
| 8 → 9 | 三類以**來源**定義 | 三類被寫成互斥選項，打**交集** |
| 9 → ? | (M) 來源內容**只能收緊** | 不改內容，把來源**整個抹掉** |

**每一次補正都只關掉剛被打穿的那個維度。** 這是在標準層打地鼠，做了五次。
真正的不變量從頭到尾只有一個：**產品在「證據缺席」時抵達了破壞性結論。**
比對 N 個來源比對得再聰明也擋不住——攻擊者不改內容，他讓證據消失。

**(O) 【取代 (E)／(I) 的三類框架】不得由「證據缺席」抵達任何破壞性結論。**
預設是**無法下結論**。只有**正向證據**能離開這個預設；
任何來源的缺席、沉默、空白、不可讀、解析失敗，**只能往「無法下結論」移動，不得反向**。
測試規則（取代三類矩陣）：
1. 對**每一個**來源，一條測試**刪除**它（不是損毀），斷言結論**沒有變得更寬鬆**；
2. 對來源的**每一個子集**（含全集），同樣斷言；
3. 「更寬鬆」的定義是可測的：`recovery !== null`、`pending === null`、
   短短語可用、排他標記可釋放——**任一項由 false 變 true 即為放寬**。
這不需要枚舉維度，因為它管的是**方向**不是**形狀**。

**(P) 三類（或任何分類）不得寫成互斥選項，必須測交集。**
第九輪的三類是互斥寫的，而 fail-open 的那一格正是「類 1 ∩ 類 3」——
**同一個 actor 在同一次 promotion 內同時可達**。
規則：分類只用來確保覆蓋，不得用來排除組合；
**至少要測「同一個攻擊者一次能同時造成的最大組合」**。

**(Q) 來源的「路徑可達性」與「內容可信度」是兩個獨立屬性，各要一條規則。**
(M) 只管了內容。第九輪把新來源放進 `dirname($GIT_TRACE2_EVENT)`——
那個路徑是產品**親手放進 hook 環境變數**的。
規則：新增任何來源時，必須分別回答
（a）**被觀察對象能不能寫到它、刪掉它、或推導出它的位置**；（b）它說的話能不能信。
(a) 為真時，該來源**連「存在與否」都不得影響結論的寬鬆方向**。

**(R) 「N 條路徑各自接上」必須用突變證明，不是數呼叫點。**
第九輪宣稱七條各自驅動，實測**六條的接線可以一行改回去而測試全綠**
（`#observeMain`／`#settlePromotion`／`recordTrusted`／`#assertMainNotBusy`／
`#releaseUnreadablePromotion`／`abandonPromotionEntirely`）。
規則：每一條宣稱接上的路徑，都要有一個**把那條接線改回舊行為**的突變讓測試變紅；
做不到就不得宣稱它接上了。

**(S) 路徑清單必須由不看實作的人獨立盤出。**
第九輪的表漏了 `#recoveryHint`——**那正是決定要不要遞出 `reset --hard` 的那個函式**——
以及 `unreadableReleaseRequirement` 的四個呼叫點。
實作者列的清單必然是他修過的那份。

### 第十輪：(O)／(P)／(Q)／(R)／(S) 的實作與實測（2026-08-07）

**三句白紙黑字的宣稱被實測推翻，已在原地改掉（保留痕跡）：**

| 原宣稱 | 位置 | 實測結果 |
| --- | --- | --- |
| spawn-record marker「不交給任何被觀察對象」／「a source the observed thing can reach, and this one it cannot」 | `candidate-registry.ts` `#promotionSpawnRecordPath` 與 `unrecordedMergeIdentity`；VERIFICATION (N) | **假。** 它住在 `dirname($GIT_TRACE2_EVENT)`，hook 用 `${GIT_TRACE2_EVENT%.jsonl}.spawn-record.json` 一行 shell 就推導得出；0700 對同 uid 不設防 |
| 「hook 可以刪掉或改寫它，沉默的方向是 fail-closed」 | 殘餘風險表 | **假。** 當列內兩個來源正好沒拿到號碼（這個來源存在的唯一理由）時，沉默的方向是 **fail-OPEN**：`q4-killwindow-hook.mjs hostile` 實測 state 由 `applying` 變 `needs-manual-review`、pending 由 `MERGE_SUBPROCESS_STILL_RUNNING (pid 94997)` 變 `null`、recovery 由 `null` 變 `git -C <main> reset --hard <pre-op>`，而 `ps -g` 同時列出 `git merge`＋hook＋`sleep`，main 已是 `A  a.txt` |
| 「四來源全滅」的觸發者是「還原時漏了 `promotion-traces/`」 | 殘餘風險表 | **假。** 觸發者是本階段自己列為信任邊界、以 Owner 身分無沙箱執行的 **repo hook**，兩行即可 |

**(O) 的實作：`mergeWriteConclusion()` 是唯一的判準，預設是「無法下結論」。**
只有四種**正向**事實能離開預設：(1) approval 從未被消耗（雜湊鏈保護，hook 碰不到）；
(2) 本程序親自 spawn 並看著 merge leader 關閉（`ProcessRunner` 在整個 group 消失前不會 resolve）；
(3) **列內**來源具名了一個號碼、而所有具名號碼都探測為 gone；(4) Owner 具名宣告。
任何來源的刪除、清空、不可讀、解析失敗都只能拿走答案，永遠不能提供答案。
**`namedInRow` 是承重的那一半**：兩個列外來源（trace／spawn-record）只能**增加**要探測的號碼
（只會多一個拒絕的理由），永遠不能成為「已回答」的理由——否則 hook 寫一個指向死號碼的
`start` 事件就替產品提供了它自己的證據（(Q)(a)、[[PITFALLS]] #120）。

**(P) 的實作：三類矩陣作廢，改成四個來源的 16 個子集全枚舉。**
`test/merge-promotion.test.ts` 的 `IDENTITY_SOURCES` × `subsetsOf()` 產生 16 條測試，
每一條在 merge 活著時**刪除**（不是損毀）該子集，斷言四項寬鬆度沒有一項由 false 變 true：
`destructiveOffer`／`notWaiting`／`shortPhraseAccepted`／`markerReleased`。
其中包含空集（基準）與全集（**同一個 hook 一次能造成的最大組合**，即 BLOCKER-1 的形狀）。
分類不再用來排除組合，因為根本不再有分類。

**(Q) 的實作：路徑可達性與內容可信度分開回答。**
spawn-record 與 trace 的 (a)「被觀察對象碰得到嗎」＝**是**，因此它們的**存在與否都不影響
結論的寬鬆方向**；(b)「說的話能不能信」＝只能收緊。CLI 那句由 repo 內容決定的斷言已改為
歸屬式描述（「a marker beside this promotion's trace says…；nothing here can verify who wrote
that marker」），並有反向斷言確認舊句子不會回來。
P1-1 沒被量到的那一半（hook 挑一個活 pid 把 task 卡住）已補測：
`a hook that forges the spawn-record marker cannot make this record conclude, or lie about it`。

**(R)：十七個突變逐一實跑（含 BASE 對照組），十五個變紅、一個存活。**
「N 條路徑各自接上」不再靠數呼叫點。每一個突變都在**交付樹的完整複製**上跑
`merge-promotion.test.ts` + `process-runner.test.ts`（BASE 143/143 全綠）。

| 突變 | 把哪一條接線改回舊行為 | 結果 | 變紅的測試（節錄） |
| --- | --- | --- | --- |
| BASE | 無 | 143/143 綠 | — |
| OBS | `#observeMain` 的身分改回 `promotionGroupIdentity(row)` | **紅** | what an observation records… |
| OBSPROBE | `#observeMain` 在 `attempt` 存在時改回假設 `"gone"` | **紅** | 同上 |
| SETTLE | `#settlePromotion` 傳 `NO_TRACE_READING` 的結論 | **紅** | 同上＋forges the spawn-record marker |
| SETTLEGATE | 拿掉「未下結論就不得進入終局狀態」 | **紅** | forges the spawn-record marker |
| HINT | 拿掉 `#recoveryHint` 的 disowned-alive 分支 | **紅** | 三條釋放測試 |
| OGATE | 拿掉 `#recoveryHint` 的「需要正向證據」分支 | **紅** | forges the spawn-record marker |
| PENDGATE | `promotionPending` 的未帳目分支改回 `undefined` | **紅** | 全集刪除子集＋4 條 |
| NAMEDINROW | 正向證據改回 `standing.answered`（列外來源可以回答） | **紅** | 全集刪除子集＋7 條 |
| MARKERTIGHT | 拿掉「marker 存在即不得下結論」 | **紅** | forges the marker＋longer phrase |
| STOREDCONC | 拿掉「讀回先前那次探測的結論」 | **紅** | 5 條收斂測試 |
| SPENT | `#promotionApprovalSpent` 一律回 `false` | **紅** | 8＋條 |
| RECTRUST | `unreadableReleaseRequirement` 的 `recordTrusted` 改 `true` | **紅** | an unreadable row cannot disown… |
| BUSYUNREAD | `#assertMainNotBusy` 不可讀分支傳 `NO_TRACE_READING` | **紅** | only git's trace names… |
| RELUNREAD | `#releaseUnreadablePromotion` 傳 `NO_TRACE_READING` | **紅** | 同上 |
| ENTIRELY | `abandonPromotionEntirely` 的 `whileRunning` 改回單一來源 | **紅** | the combined release records… |
| **LEADEREXIT** | `leaderExitObserved` 的初值 `false` → `true` | **綠（存活）** | — |

**LEADEREXIT 存活的分析（依 #106 → #107 逐項排除，不寫全稱宣稱）**：
(1) 前置條件：BASE 全綠、其餘十五個突變都紅，測試確實跑得到這個模組；
(2) 等價性：`leaderExitObserved` 是**最後一順位**的證據，只有在
「`mergeIntoHead` 拋出」∧「git 真的 spawn 了」∧「列內兩個來源都沒有號碼」∧「沒有任何號碼探測為活著」
四者同時成立時才會改變答案。`runProcess` 只在 spawn 失敗（此時 git 沒跑，下結論本來就對）
或 `PROCESS_TREE_CLEANUP_FAILED`（此時 group 還活著）兩種情況拋出；後者若 marker 寫成功，
標記會具名那個號碼、探測為活著，第 1 步就擋下來——**所以它在幾乎所有狀態下都是等價突變**。
(3) 唯一不等價的狀態是**三重故障**：`mergeIntoHead` 拋出、pgid 寫入失敗、且 marker 寫入也失敗。
**我沒有能穩定構造這個狀態的方法**（group 存活過 SIGKILL 無法在測試中製造），
因此**不宣稱這一條有覆蓋**；方向是「多一個放寬的可能」，記在殘餘風險表。

**(S)：路徑清單以 11 處為底盤**（見 `test/merge-promotion.test.ts` 的 Round-10 標頭）。
`#recoveryHint`（決定要不要遞出 `reset --hard` 的那個函式）與
`unreadableReleaseRequirement` 的四個呼叫點都在裡面；後兩個入口
（`#observeMain`、`#settlePromotion`）也各自被突變驅動。

**新增的出口（第 11 項要求）**：`MERGE_UNACCOUNTED_ABANDON_CONFIRMATION`
（`STOP WAITING FOR A MERGE THIS RECORD CANNOT ACCOUNT FOR`）。它是唯一不引用號碼的釋放短語，
因為「沒有號碼可引用」正是它要釋放的狀態；產品改為交出一個**唯讀搜尋**
（`ps -eo … | grep -F <candidate head>`，每一次促進的 `git merge` 指令列都帶著那個 commit）。


**第十輪新增一列殘餘風險（在下表之外先列於此，因為它是本輪自己的突變找到的）**：

| 殘餘風險 | 為什麼此階段可接受 | 何時失效 |
| --- | --- | --- |
| **`leaderExitObserved`（「本程序親眼看著 merge leader 關閉」這條正向證據）在一種三重故障下可能被誤用**：`mergeIntoHead` 拋出 ∧ pgid 寫入失敗 ∧ spawn-record marker 寫入也失敗。此時沒有任何來源具名號碼，而產品仍會以「這次嘗試觀察過」下結論。突變 LEADEREXIT 存活即為證據，**本輪未能構造出可穩定重現的測試** | 三個獨立故障要同時發生；而且 `runProcess` 只有兩種拋出途徑，其中 spawn 失敗代表 git 根本沒跑（下結論正確），另一種 `PROCESS_TREE_CLEANUP_FAILED` 只有在 group 撐過 SIGKILL 時才發生。這一條**不宣稱已覆蓋**（[[PITFALLS]] #104） | **若 `runProcess` 新增任何拋出途徑即失效**——屆時必須重跑 LEADEREXIT 突變並補上能構造該狀態的測試；或把這條證據整個拿掉，代價是每一列 pgid 寫入失敗的促進都要 Owner 多打一句短語 |

### 可接受的殘餘風險（連同「何時失效」一起列，未列出的不得事後補認）

| 殘餘風險 | 為什麼此階段可接受 | 何時失效 |
| --- | --- | --- |
| promotion 是本機單機操作，不處理遠端 push | 專案守則禁止自動 push，發布一律需人類批准 | 若未來加入自動化發布，立即失效 |
| 不支援 merge 進行中的互動式衝突解決；有衝突就拒絕 | 有衝突時 Owner 本來就該自己看 | 若要支援 rebase／squash 等策略，需重訂 |
| 單一 candidate → 單一 main，不處理多 candidate 排隊 | 結構上每 task 僅一筆未結核准 | 若開放多 candidate 併發 promotion，立即失效 |
| submodule 與 LFS **偵測到即拒絕**，不做完整支援 | 兩者都會讓「回到操作前」變成無法保證 | 若 Owner 的專案開始使用，必須改為完整支援；**不檢查不算可接受** |
| P0-2（Writer apply-back 仍是 `window.prompt`）不在 5-5 範圍 | 那是另一條寫回路徑，與 candidate promotion 不同機制 | **9/1 之前必須有結論**：要嘛做，要嘛明文記為不做 |
| **一次促進失敗（hook 逾時、hook 非零退出、崩潰）可以把 main 留在半套用狀態，而清乾淨它是 Owner 的手動工作。** 產品不會替 Owner 動手，只會逐項具名並提供一行可複製的指令 | 這是刻意的：實測 C 證明半套用的 index 與 Owner 自己 stage 的工作在位元層級無法區分，`git clean` 更會刪掉未追蹤與 ignored 檔案（[[PITFALLS]] #94）。自動清理的期望值是負的 | **若 5-6 提供 rollback 介面即失效**——屆時必須是 preview-first、指紋綁定、single-use approval，且仍不得使用 `git clean` 的任何形式 |
| **`needs-manual-review` 沒有「Owner 按一下就結案」的按鈕**；它只能藉由 Owner 真的把 main 復原（或那次 merge 真的完成）而在下一次讀取時自行收斂 | 這正是「唯讀 reconciliation」的必然結果：能結案的唯一證據是重新觀察到的指紋，不是一個宣告。第一輪的缺陷不是「沒有按鈕」，而是**寫死之後永不再觀察**，那已修復並有測試（見下） | **若第二輪接上 GUI 出口**，必須同時提供「重新觀察」的顯式動作與逐項差異的畫面。**2026-08-06 第四輪審查更正（本輪接受）**：上一版這一欄寫「在那之前 Owner 的路徑是 CLI／API 的 `promotions()`」——**那句話與實作不符**。`grep -rn promotions src/main.ts src/ui src/mcp` 為零，`orchestrator candidates` 只有 `orphan-refs` 一個子指令，**`promotions()` 沒有任何 CLI 或 HTTP 出口**；唯一的呼叫方式是自己寫 Node script 直接 `new CandidateRegistry(dataDir)`。這是 [[PITFALLS]] #77／#109 同形（未經驗證就把「有出口」寫進文件）。**目前 Owner 沒有可用的成品路徑**，這件事本身列為未關閉項而不是既有能力。**2026-08-07 第六輪已關閉**：`orchestrator candidates promotions <workspace>` 列出（會重新觀察並更新未結紀錄），`… release …` 為三個釋放動作的出口；此欄保留原文以留下更正的痕跡 |
| **attributes 閘門不宣稱完備。** 兩半合起來仍看不到一種形狀：一份**全域** attributes 檔，其 pattern 既不匹配本 repo 任何 tracked／ignored 路徑，也不匹配 `ATTRIBUTES_PROBE_PATHS` 那份代表性清單 | 這種規則按定義不會套用到本 repo 現有的任何檔案；要生效必須同時有人在 candidate 內新增一個匹配它的新路徑。而 `filter.*.clean/smudge` 的**設定**本身仍是獨立的拒絕條件，那才是 LFS 之類的實際形狀 | **若 promotion 開始接受會新增任意副檔名的 candidate 而不逐一詢問 git**，或若代表性清單停止跟著實務更新，即失效。正確的下一步是把 candidate 即將寫入的**確切路徑**也餵給 `check-attr` |
| **`#upgrade` 的 `from === 1` / `from === 3` 分支對含 completed candidate 的舊庫是假支援**：加表本身成功，但 registry 隨後在讀取層以 `CANDIDATE_COMPLETION_PREVIEW_INVALID` 開不起來 | 這是 `a75e904` 引入的、不是 5-5 造成的，且 v1／v3 都是**未發布**的內部版本；Owner 目前的正式 DB 是 v4→v5 路徑，該路徑有真實資料庫的回歸測試 | **若任何 v1／v3 資料庫需要真的被打開即失效**——屆時必須是真正的 completion 升級，或至少一個具名的 fail-loud 錯誤碼取代目前的通用解析失敗。第二輪已把它記為必須具名；本輪**未實作**，維持列在此處 |
| **每一次 promotion 會在 owner-only data directory 留下一份 git trace 檔案（`promotion-traces/<id>.jsonl`），產品不刪除它。** 檔案內含這次執行過的 hook argv，也就是 Owner 自己 repo 內的指令；`GIT_TRACE2_EVENT` 的路徑同時會出現在 hook 的環境變數裡 | 它是「哪些 hook 真的跑過、退出碼是多少」的**唯一觀察來源**，而且崩潰後仍可讀——刪掉它就等於把第 5 項的事實斷言換回常數。目錄是 0700，hook 本來就以 Owner 身分執行、看得到的東西不比它自己多 | **若 promotion 變成高頻操作即失效**（磁碟成長無上限）；屆時需要有界保留策略，且刪除必須走本專案的兩段式刪除規則。**第八輪追加：這個檔案現在還是 merge 身分的第三個來源**（見 P0），所以任何保留策略都必須把「還在 `applying` 的促進」排除在外，否則清掉它就等於把一列已損毀紀錄的最後一個號碼來源拿走 |
| **標準第 7 項的「期間偵測」目前是事後偵測**（見上方裁決請求），未取得 Owner 裁決前**不算已接受** | `authorizedMergeCommit` 的雙親判準使外部推進不可能被誤記為 applied，且差異逐項具名 | 若 promotion 改為控制面分步執行，或開放多 candidate 併發，立即失效 |
| **把整份 config 納入綁定，代價是良性的 `git config` 寫入也會燒掉核准。** 核准存活期間對 main 的任何一次設定寫入都讓它終局 `invalidated`，Owner 必須重新 preview 與核准 | 這是 fail-closed 的方向，而反過來（只綁一份鍵名清單）已經被實測證明會放行 `gpg.program`。core config 在核准的 15／5 分鐘窗內本來就極少改動 | **若 promotion 變成高頻操作、或 Owner 的工作流程會在該窗內動 `.git/config`（例如自動化的 `git remote`／`branch --track`）即失效**；屆時要改為「只綁會導致執行的鍵，並且那份清單本身要有跟得上 git 的機制」 |
| **`programs`（核准畫面上逐項揭露的設定鍵）明確不宣稱完整。** 它是一條正規表達式，只決定哪些鍵會被**顯示**；沒有匹配到的鍵仍然被 `configDigest` 綁定，但 Owner 在畫面上看不到它的名字 | 完整性由 digest 那一半承擔：沒被列出不等於沒被綁定。要讓一個未列出的鍵生效，攻擊者仍必須在核准之前就把它放好，而那會改變 digest 之外的東西嗎——不會，所以這一條的真正邊界寫在下一欄 | **若某個 git 版本新增一個「core config 已存在、preview 當下就在那裡」的程式執行鍵**，它會被綁定（所以核准後改它會被擋）但**不會被揭露**，Owner 看不到它。修法是把 `programs` 的判準改為「白名單允許的鍵以外，任何值看起來像路徑或指令的鍵一律列出」，或直接拒絕未知鍵 |
| **promotion 產生的 merge commit 不簽章，也不驗證被合併方的簽章**（`commit.gpgsign`／`tag.gpgsign`／`merge.verifySignatures` 被釘為 false） | 促進的授權來自 approval row，不是簽章；而讓 merge 依賴一個由「不可信 worktree 可改寫的同一份設定檔」指名的程式，是用一個有紀錄的缺口換任意程式碼執行 | **若 Owner 的專案要求 main 上每個 commit 都必須有簽章即失效**——屆時正確做法是讓 Owner 明確提供一份簽章設定（不從 repo config 讀），並在核准畫面上揭露將使用哪一個程式 |
| **對活著的 merge 放棄等待，不會釋放那個 task。** 三個釋放動作（process group／owner process／兩者一起）改變的都只是「這筆紀錄還在不在等某個 pid」；task 能不能再促進，取決於下一次重新觀察到的指紋。實測：釋放後 `ps` 仍顯示 merge leader 活著、整棵樹逐位元不變、而 task 仍為 `MAIN_MERGE_PROMOTION_UNRESOLVED` | 這是「唯讀 reconciliation」的必然結果，而且是刻意的：把它做成「釋放＝task 解封」會讓一個 Owner 的宣告蓋過一個還在進行的寫入。Owner 的路徑是先讓那個 merge 真的結束（或自己復原 main），紀錄下一次讀取就自己收斂 | **若 5-6 提供 rollback 介面即失效**——屆時「結束等待」與「決定結果」必須是兩個各自有 approval 的動作，而不是一個 |
| **`abandonPromotionEntirely()` 可以在 merge 真的還在寫 main 時被使用。** 產品不殺程序、不碰 main，但那一刻的「不再等待」是 Owner 的宣告而不是觀察 | 替代方案是把那個狀態留成死結，而死結已實測會永久報廢 task（第 11 項禁止）。風險被壓在三個地方：短語**說出**正在放棄兩個程序且其中一個可能還在寫 main；必須寫出記錄上的**兩個**確切號碼；只要那個 pid 還活著，`#recoveryHint` 一律只給唯讀的 `inspect-live-merge`，永遠不給 `reset --hard`（[[PITFALLS]] #94） | **若未來能對 merge 子程序做真正的身分驗證**（例如以 pidfd／程序啟動時刻比對），這條退化為不必要；在那之前不得再放寬短語或省略號碼 |
| **一列讀不了的促進紀錄，釋放之後仍然讀不了，而它自己的 task 仍然沒有產品側出路。** `#assertNoUnresolvedPromotion` 會對它永遠回 `MAIN_MERGE_PROMOTION_UNRESOLVED` | 本輪修的是**爆炸半徑**（整個專案 → 一個 task），不是損壞本身。要給那個 task 出路，只能是「重算 row hash」，而那等於替一列來源不明的資料重新背書（[[PITFALLS]] #28／#57），代價比留著一個具名的死 task 高 | **若 SQLite 檔案損壞在實務上不只是理論**（例如 Owner 回報過一次）即失效；屆時正確做法是離線的 registry 修復工具＋逐列人工確認，而不是線上重新背書 |
| ~~**`promotions()` 與三個釋放動作沒有任何 CLI 或 HTTP 出口。**~~ **已於第六輪關閉**：`orchestrator candidates promotions <workspace>`（列出；**第七輪更正：原寫「唯讀列出」，實際會重新觀察並更新未結的紀錄**）與 `… release <promotion-id> --confirm <phrase> [--pid N] [--pgid N]`（三個釋放動作，依 Owner 引用的號碼分派）。路徑過 `workspaces.assertAllowed()`，room 由 workspace 反查；輸出只有 id、狀態、pid 與唯讀 `ps` 指令 | 這**不是**替 `promoteMainMerge` 開出口——寫入 main 仍然刻意沒有產品側路徑，`helpText()` 也有一條斷言確認它沒被寫進說明 | 若未來接上 GUI，兩個動詞必須維持分離（觀察不需短語、釋放需要短語＋確切號碼） |
| **`merge.<name>.driver` 與 `filter.<name>.clean/smudge` 的『值』逐字出現在三個地方**（核准畫面、SQLite 的 `preview_json`、以及每次促進的 `promotion-traces/<id>.jsonl`），而 `programs` 只顯示鍵名。**第七輪更正**：這一列在第六輪寫下時，那兩份清單連**鍵名**都沒有遮蔽——實測 `merge.https://u:<token>@github.com.driver` 逐字上畫面也逐字入庫，而同一輪的交付說明宣稱「秘密既不上畫面也不進資料庫」。鍵名已修，值仍如本列所述。**第八輪補三句**：(a) 值同時存在**畫面／SQLite／`promotion-traces` 三處**，不是只有畫面；第三處已**實測**——git 的 trace2 把 driver 的完整指令列（含嵌在裡面的合成 token）以 `child_start.argv` 逐字寫出，見上方「merge driver argv 的實測」。(b) **把值存進 SQLite 不是揭露的必要條件，只是目前的實作選擇**：綁定靠的是 `configDigest`，與揭露清單是兩條路；`inspectMergeApproval` 的 live 掃描已經證明「核准當下重新讀 config 再顯示」是可行的。(c) 觸發條件不需要 Owner 做任何事——**只要 repo 內存在任何 driver／filter 設定**即成立，因為 `.git/config` 是 linked worktree 共用的，不可信的 candidate worktree 在核准之前就能寫進去 | 這是刻意的不對稱：driver／filter 的值**就是會被執行的那個指令**，不顯示它等於把最該看的東西藏起來；`programs` 那一半顯示鍵名就足以說明「有一個 credential helper 會跑」。第六輪修掉的是**鍵名**裡的秘密，不是這一項 | **只要 Owner 的 repo 內存在任何 merge driver 或 content filter 設定即失效**（不需要它含有秘密，也不需要 Owner 主動做什麼）——屆時正確做法是：值改以雜湊呈現＋要求 Owner 到終端自行查看，同時把 `promotion-traces` 的保留改為有界並走本專案的兩段式刪除規則 |
| ~~**一列讀不了的促進紀錄，如果連 `merge_pgid` 欄位也一起壞了，產品無法要求 Owner 引用任何號碼**~~**第八輪已大幅縮小**：`promotion-traces/<id>.jsonl` 現在是第三個來源，而它不住在資料庫裡，所以「兩個欄位＋payload 全毀」的列仍然能具名 pgid 並要求引用（實測：`both-gone` 模式從 `alive=[]` 變成 `alive=[{merge,pgid}]`）。**剩下的那一格是：連 trace 檔也不在**（被刪、寫入失敗、或 data directory 部分遺失）。那一刻剩下的唯一保護是長短語與 `probeReadable: false` 的揭露 | 要求引用一個讀不到的號碼等於把那一列變成死結，而死結已實測會永久報廢 task（第 11 項禁止）。方向仍是 fail-closed：讀不到一律當成活著，短短語一律被拒（有測試） | **若 trace 檔開始被保留策略清理即失效**——屆時保留策略必須把「還在 `applying` 的促進」排除在外；另外若未來能以 pidfd 之類的方式做真正的身分驗證，這一格可以完全關閉 |
| **`promotion-traces/<id>.spawn-record.json` 這個第四來源，其路徑由 `dirname($GIT_TRACE2_EVENT)` 推導得出，因此 repo hook 可以建立、改寫或刪除它。**~~第九輪原文寫「不交給任何被觀察對象」「沉默的方向是 fail-closed」~~ **第十輪實測兩句皆假**（`q3-forge-marker.mjs`／`q4-killwindow-hook.mjs`）。現在的實際狀況是：hook **可以**讓一列促進永遠處於 `MERGE_IDENTITY_UNACCOUNTED`（寫一份 marker，或讓四個來源同時沉默），Owner 必須用 `MERGE_UNACCOUNTED_ABANDON_CONFIRMATION` 這一句才能結束等待 | 補正 (O) 把保證從「這個路徑藏得住」換成「**這個來源的存在與否都不能讓結論變寬鬆**」。剩下的能力只有 fail-CLOSED 一個方向：hook 能讓產品拒絕下結論，不能讓它下結論。代價是 Owner 多一句短語，而 [[PITFALLS]] #120 已證明藏路徑不是邊界（改成繼承 fd 之後 `lsof -p $$` 仍列得出路徑） | **若未來能對 merge 子程序做真正的身分驗證**（pidfd／程序啟動時刻）即可整格關閉；**若 promotion 變成高頻操作即失效**（與 trace 檔同一個保留問題），屆時保留策略必須把「還在 `applying` 的促進」排除在外 |
| ~~**trace 與 spawn-record 都不在、而列內兩個來源同時說「沒有 group」時，一列仍然可能被讀成「沒有 merge 在跑」**~~ **第十輪已關閉，並且原本的裁決理由是錯的。** 原文說觸發條件是「還原時漏了 `promotion-traces/`」，實測觸發者是 repo hook 的兩行；原文說「一律當成活著會讓正常紀錄拿不到出路」，那是把「不下結論」跟「沒有出路」混為一談 | 補正 (O)：四個來源全部沉默時，結論停在 `MERGE_IDENTITY_UNACCOUNTED`，`pending` 不是 `undefined`、`recovery` 不是 `reset --hard`、短短語不可用、排他標記不釋放。出路是一句具名短語＋一個唯讀搜尋指令，不是死結。16 個子集全枚舉的測試守著這件事 | — |
| **一個在同一次開機內被 OS 回收的 pid，會讓一列 `needs-manual-review` 的紀錄重新開始阻擋**（trace 名字裡的號碼現在也會被可讀路徑拿去探測） | 方向是 fail-closed，而且**不是死結**：`abandonMergeProcessGroup` 引用那個號碼即可解除，`promotions()` 會把號碼與 `ps` 指令印給 Owner。相對的另一邊是把 trace 排除在可讀路徑外，而那正是第八輪的 BLOCKER | **若 promotion 變成高頻操作、或 trace 保留期拉長到 pid 迴繞週期以上即失效**；屆時要用 pidfd／程序啟動時刻做真正的身分驗證 |
| **任何 `merge_pgid` 欄位為 NULL 而 `observation_json` 又沒有 `mergePgid` 的列，現在一律停在「無法下結論」，不會自行收斂。**~~原文說這種列「仍會被讀成沒有 merge 在跑」~~ **第十輪把方向整個翻過來**：列內兩個來源沒有具名任何號碼時，列外來源（trace／spawn-record）不能替它回答，因為那兩個來源正是被觀察的 merge 碰得到的。代價是**真實常見的情境**（SQLite 被別的程序鎖住導致 pgid 那次寫入失敗，[[PITFALLS]] #65 說這在本機是日常）會需要 Owner 用 `MERGE_UNACCOUNTED_ABANDON_CONFIRMATION` 結束等待 | 這是補正 (O) 的直接後果，也是刻意的：能替這種列回答的只有 hook 碰得到的檔案，而一列能被 hook 結案的紀錄不算結案。方向是 fail-closed 且有具名出路（第 11 項要求的「有出路」，不是「不用花力氣」）。**由第九輪寫進資料庫的舊列**若帶 `mergePgid: null` 但沒有 `mergeConclusion`，升級後同樣會停在這個狀態，需要同一句短語 | **若未來能對 merge 子程序做真正的身分驗證即可放寬**；在那之前不得把列外來源升格為「已回答」的理由 |
| **`merge_pgid` 欄位與 `observation_json` 由不同版本的程序交錯寫入時可能不一致**（舊 build 只會寫 payload，不會清欄位） | 不一致會被 `#assertPromotionRow` 判為 `MAIN_MERGE_PROMOTION_ROW_TAMPERED`，該列進入不可讀路徑。~~而不可讀路徑會從欄位讀回 pgid 並要求長短語——方向是 fail-closed~~ **第七輪實測證偽：不可讀路徑當時是「欄位優先、看到就 return」，所以它讀回的是那個壞掉的欄位，探測到它已死，然後接受短短語——方向是 fail-OPEN。**第八輪已修：兩個來源不一致時答案是「不可讀」，兩個號碼都探測、都列出，短短語一律不可用（有測試，且突變 E／E2 兩個方向都會變紅）。另外**降版方向現在是具名的**：schema 移到 v6，舊 build 在開啟時就以 `CANDIDATE_REGISTRY_SCHEMA_UNSUPPORTED` 拒絕，不會走到交錯寫入 | **若同一個 data directory 會被兩個不同版本的 orchestrator 同時使用即失效**；本專案的 digest-pinned runtime 規則本來就禁止這件事，而 v6 讓舊 runtime 連開都開不起來 |
| **核准畫面上那段揭露的「渲染」與「scroll-gate 是否真的把它算進去」，只有手動瀏覽器驗收＋digest guard，沒有自動 DOM 測試** | 專案沒有 DOM 測試執行器，加一個是新相依（pending decision D-006，Owner 裁決）。行為那一半（事實有沒有到達 payload）有 Node 測試守著；渲染那一半有 digest guard，程式一改就紅燈，逼人重跑 | **若 Owner 核准新增 DOM 測試執行器即失效**；也**若 digest guard 再被發現有涵蓋不到的角落**（它已被抓到過一次：只認 `^function` 而漏掉 `async function`）即失效 |
| **`promotion-traces` 這個第三來源本身有三個已知限制，都不宣稱完備。** (1) merge 的 pid 是從 trace2 的 `sid` 尾端 `-P<hex>` **解析**出來的，不是問 git 拿的（[[PITFALLS]] #103 的形狀，但這裡沒有可問的對象——那個程序早就結束了）；(2) trace 不記錄開機時刻，所以那個 pid 屬於哪一次開機是**從 git 的啟動時間推導**的（早於本次開機即視為別的開機，容差內視為同一次）；(3) 只讀檔案前 64 KiB 找 `start` 事件；(4) **trace 檔不會被清空**，所以那個號碼在同一次開機內若被 OS 回收給別的程序，一列已損毀的紀錄會因此改要求長短語 | ~~四個限制的失敗方向都是 fail-closed~~ **⛔ 第八輪實測證偽**：第 (1) 條的失敗方向是 fail-OPEN。`GIT_TRACE2_EVENT` 的路徑出現在 hook 的環境變數裡，hook 偽造一個 `start` 事件指向死號碼 → `recordedGroups:[{trace,999999}]`、`alive:[]`、`probeReadable:true`、**短短語被接受、排他標記交還**，而 `ps -g` 同時列出活著的 merge（`p8-trace.mjs forge`）。刪除與截斷兩種模式確實是 fail-closed，偽造不是。**第九輪的修法**：trace 這個來源被明文降級為**只能收緊不能放寬**——它命名的號碼一律拿去探測（只會增加拒絕的理由），但**它自己永遠不能讓一列變成「已回答」**；「有沒有回答」由 row 內的來源決定，而探測只能把那個回答拿掉（見 (M)）。四種模式現在都 REFUSED。另外新增第四個來源 `spawn-record`（見下一列），它寫在 owner-only 資料目錄且**不交給任何被觀察的對象**。第 (2)(3)(4) 條維持原判：推導錯的方向是「不能排除」而不是「可以結案」；(4) 只影響**已經損毀**的列，且長短語＋引用那個號碼仍是出路，不會產生死結（第 11 項禁止的形狀）。而它存在的理由是 [[PITFALLS]] #115——前兩個來源共用同一列，這一個不是 | **若 git 改掉 trace2 的 sid 格式**，這個來源會退回「不可讀」（有測試：`a trace that proves a merge started without naming it is an unanswered question`）；~~不會給出錯的號碼~~ **已證偽——hook 可以讓它給出錯的號碼**，所以現在它給出的號碼只用來收緊，不用來放寬。**殘餘的部分**：hook 仍然可以**刪掉或改寫**這個檔案，那會讓這個來源沉默；沉默的方向是 fail-closed（回到只有 row 內來源，或回到「不可讀」）。把它改寫成 hook 看不到的路徑**沒有做**，理由是實測：把 `GIT_TRACE2_EVENT` 改成繼承的 fd 之後，hook 環境變數確實只剩 `3`，但 `lsof -p $$` 仍然列得出檔案路徑，所以那是遮蔽不是邊界，而它要動的是 `process-runner` 這個安全關鍵模組。保證來自「只能收緊」那條規則，不是來自路徑保密。升級 git 之後要重跑 `p7-col.mjs` 的五種模式與 `p8-trace.mjs` 的四種模式 |
| **schema 移到 v6 之後，任何 `SCHEMA_VERSION = 5` 的既有 runtime 再也打不開這個 data directory**（`CANDIDATE_REGISTRY_SCHEMA_UNSUPPORTED`）。這是刻意的，但它是一個**不可逆的單向動作**：本 build 開過一次，`user_version` 就是 6 | 替代方案是讓舊 build 在 SQLite 內部炸出 `has 19 columns but 17 values were supplied`，那既不具名也不早。方向都是 fail-closed，差別只在「開啟時具名」與「寫入途中無名」 | **若 Owner 需要回到 digest-pinned 的舊 runtime 即失效**——屆時唯一的路是先備份、再以離線工具把兩個欄位 DROP 掉並把 `user_version` 改回 5。**這件事需要 Owner 知情**：在讓本 build 碰正式 data directory 之前先取一份備份 |

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

## Merge approval reject 路徑瀏覽器驗收（2026-08-06）＋ digest guard 自身的缺陷修復

**發現經過**：Phase 5-5 的實作代理改掉了 `rejectMergeIntoMain()` 印出的那句謊話
（原本讀伺服器寫死為 `true` 的三個常數，印「candidate、checkpoint 與復原點完整保留」——
而拒絕這條路徑一個 Git 指令都沒跑，根本沒觀察過任何東西），
**但 `test/merge-dialog-acceptance.test.ts` 沒有變紅**。它自己回報了這件事。

**原因是 guard 本身的缺陷**：擷取樣式只認 `^function NAME(`，
而 `rejectMergeIntoMain` 是 **`async function`**。**任何 async 的 dialog 函式都會被靜默漏掉。**
已修為 `^(?:async )?function`，並把 `rejectMergeIntoMain` 納入涵蓋清單。

**瀏覽器實測**（真實 `public/room.js`，攔截 `api()` 模擬伺服器回應，
腳本開頭先斷言執行中的函式含新文案，舊快取會直接拋錯——[[PITFALLS]] #90）：

| 檢查 | 結果 |
| --- | --- |
| 狀態文字不含「完整保留」 | 通過 |
| 明說「未重新讀取 <recoveryRef> 目前的狀態」 | 通過 |
| 只描述本次動作（「這次拒絕沒有刪除…」） | 通過 |
| `mergeApprovalDecided` 設起、核准按鈕停用 | 通過 |
| 送出的請求路徑與 approvalId 正確 | 通過 |

**已接受的 gate digest（room.js，含 reject 路徑）**：
`2c86245615897263677a73481ed39895f3c294fd3f13c05b4290d1ac8ea24488`

**教訓**：一個防「紀錄過期」的機制，自己也會有涵蓋不到的角落。
它這次是**被它想守護的那個變更本身**揭露的——實作代理誠實回報了「我改了但測試沒紅」。

## Merge approval dialog 第三次瀏覽器驗收（2026-08-07）：促進揭露與 scroll-gate

**背景**：Phase 5-5 第四輪審查 P0。標準第 3 項要求「在核准畫面上**逐項列出**本次會執行的 hook 檔名與
雜湊」與「**逐一列出**這次合併會覆蓋的 ignored 檔案路徑」，第 10 項說沒納入揭露就是**未關閉的前置條件**。
實測：`public/room.js` 對 `promotion`／`hooks`／`programs`／`configDigest`／`overwrites` 的引用次數
**全部為 0**——資料在 payload 裡，畫面上一個字都沒有。

**方法**：Chrome 載入**真實** `public/room.html` 與**真實** `public/room.js`（loopback 靜態伺服器，
**換一個沒用過的 port** 強制重新載入——[[PITFALLS]] #90）。腳本**第一件事**是斷言執行中的程式碼確實是
新版（`String(renderMergePromotionDisclosure).includes("configDigest")` 與
`String(mergeApprovalBlockers).includes("OVERWRITE_SCAN_UNAVAILABLE")`，不成立就直接拋錯），
再覆寫全域 `api()` 回傳受控的 inspect payload。之後走**真實流程**
`openMergeApprovalDialog()` → `loadMergeApproval()` → `renderMergeApproval()`，
以真實 DOM、真實 `scroll` / `input` 事件驅動，讀取真實的 `input.disabled` / `button.disabled`。

**先斷言幾何真的溢出**（`clientHeight` 284 / `scrollHeight` 810），否則整個 scroll-gate 是空的；
另外斷言**揭露區塊本身就比可視高度高**（330.98 > 284），也就是它不可能被一眼略過。

| 檢查 | 實測結果 |
| --- | --- |
| 揭露渲染在 scroll-gate 量測的區域**之內** | 通過（`region.querySelector(".merge-promotion-disclosure")` 命中） |
| 逐項列出 hook 檔名與**完整 SHA-256**（兩個 hook） | 通過（`pre-merge-commit` 與兩個 64-hex 雜湊都在畫面文字內） |
| 列出 `merge.*.driver` 與 `filter.*` | 通過（`merge.custom.driver`、`filter.lfs.clean`） |
| 逐項列出 `programs` 鍵名（三個，含 `gpg.ssh.defaultkeycommand`） | 通過 |
| 明說這份清單**不宣稱完整**、完整性由 configDigest 承擔 | 通過 |
| 未捲動 → 輸入框鎖住 | 通過（`inputDisabled true`、`scrolled false`） |
| 捲到**揭露區塊的結尾**（`scrollTop 411`）→ 仍鎖住 | 通過（`scrolled false`——揭露被捲過了，但清單還沒到底） |
| 捲到一半（`scrollTop 263`）→ 仍鎖住 | 通過 |
| 捲到底（`scrollTop 526.5`）→ 輸入解鎖、按鈕仍鎖 | 通過 |
| 短語全小寫 → 按鈕維持鎖住 | 通過 |
| 短語精確相符 → 按鈕解鎖 | 通過 |
| **ignored 檔案會被覆蓋** → 路徑出現在捲動區內，且**每一條路徑各一個阻擋項**，捲到底仍鎖住 | 通過（`.env.local`／`build/cache.bin`／untracked `notes.txt`＝3 個阻擋項，風險徽章 `高風險 · HIGH`） |
| **`overwrites` 缺席** → 具名阻擋，捲到底仍鎖住 | 通過（畫面寫「沒有拿到覆蓋掃描的結果」） |
| **掃描沒有執行**（`checked:false`）→ 阻擋項**帶出代碼** | 通過（`OVERWRITE_SCAN_PATHSPEC_TOO_LARGE` 出現在畫面與阻擋項） |
| **快照早於促進閘門**（無 `promotion`）→ 具名阻擋 | 通過（畫面寫「這份快照產生於促進閘門存在之前」） |
| **hook 目錄讀不到** → 具名阻擋，且**不**顯示「裡面沒有可執行的 hook」 | 通過（「沒讀到」與「讀到而為空」不折疊——[[PITFALLS]] #85） |
| **讀到而為空** → 不同的句子，且**不是**阻擋項，捲到底可解鎖 | 通過（`blockers 0`） |
| **對話框開著期間才出現的 ignored 檔案**（只有 live 掃描改變，approval 與 binding 逐位元相同）→ 輪詢重新渲染、路徑上畫面、阻擋項出現、輸入重新鎖住**且已輸入的短語被清空** | 通過（前：`inputDisabled false` / 已輸入 `MERGE INTO MAIN`；後：路徑在畫面上、阻擋項具名該路徑、`value === ""`、按鈕鎖住） |

Console 無任何 error／exception。

**已接受的 gate digest（room.js，含促進揭露與 scroll-gate）**：
`4665b87688b354e2ee16c9fe4d0fda50731cbd9e09880b66d72e3b926f86306e`

`test/merge-dialog-acceptance.test.ts` 的涵蓋清單同時新增
`renderMergePromotionDisclosure`、`renderMergeDiff`、`loadMergeApproval`、
`mergeApprovalSignature`、`repollMergeApproval`——**五個都在這次瀏覽器驗收裡被實際執行過**。

**這一次沒有涵蓋的**：
- 這是**手動**驗收，不在 CI 重跑；守它的只有 digest guard（改程式就紅燈，逼人重跑）。
- payload 是受控的（覆寫 `api()`），所以它證明的是「拿到這些事實時畫面怎麼做」，
  不證明伺服器會送出正確的事實——那一半由 `test/merge-promotion.test.ts` 的
  「the approval surface carries what would run and what would be silently overwritten」以真實 repo 守著。
- CSS 版面在其他視窗尺寸下的表現沒有測；scroll-gate 的判準是幾何，所以**極寬或極高的視窗**若讓區域不再
  溢出，gate 會像先前一樣「已經在底部」——這是既有行為，不是本次引入的。

## Merge approval dialog 第四次瀏覽器驗收（2026-08-07）：重繪歸零與輪詢守衛

**背景**：Phase 5-5 第五輪審查 F7。兩項：`renderMergeDiff` 重繪**不重置** `region.scrollTop`
（審查員實測重繪後仍為 22.5），而呼叫端 `repollMergeApproval` 上方的註解寫著「重繪會把捲動位置歸零」
——**假註解**，而且方向是危險的：使用者捲完的是上一份內容，換了一份之後 scroll-gate 仍算他讀完了。
另一項是 `repollMergeApproval` 每 5 秒觸發且**沒有 in-flight 守衛**，而本輪為該端點新增了兩條
git 子程序（各 30 秒逾時），慢回應會堆疊。

**方法**：同前三次。Chrome 載入**真實** `public/room.html` 與 `public/room.js`
（loopback 靜態伺服器，**換一個沒用過的 port 47131** 強制重新載入——[[PITFALLS]] #90）。
腳本**第一件事**是斷言執行中的程式碼確實是這一輪的版本
（`String(renderMergeDiff).includes("region.scrollTop = 0")`、
`String(repollMergeApproval).includes("mergeApprovalPollInFlight")`、
`/finally\s*\{[\s\S]*mergeApprovalPollInFlight = false/` 三者皆為 true），
再覆寫全域 `api()`。之後走真實流程 `openMergeApprovalDialog()` → `loadMergeApproval()`
→ 真實 DOM 事件 → 讀真實的 `input.disabled` / `button.disabled`。

| 檢查 | 實測結果 |
| --- | --- |
| 幾何真的溢出（否則整個 gate 是空的） | `clientHeight 284` / `scrollHeight 1788` |
| 揭露渲染在 scroll-gate 量測的區域**之內** | 通過 |
| **設定鍵裡的秘密不上畫面**（`credential.<url>.helper` 形狀） | 通過：`secretOnScreen false`、`credential.<redacted>.helper` 在畫面上、`gpg.ssh.defaultkeycommand` 仍逐字可讀 |
| hook 的完整 SHA-256 逐項在畫面上 | 通過 |
| 未捲動 → 輸入框鎖住 | 通過（`scrollTop 0`、`inputDisabled true`） |
| 捲到底 → 輸入解鎖、按鈕仍鎖 | 通過（`scrollTop 1504`、`inputDisabled false`、`confirmDisabled true`） |
| 輸入 `MERGE INTO MAIN` → 按鈕解鎖 | 通過 |
| **重繪把捲動歸零**（只改 `updatedAt`，**不引入任何阻擋項**，所以結果只可能來自重繪本身） | 通過：`scrollTop 1504 → 0`、`scrolled true → false`、`inputDisabled false → true`、輸入框內容 `"MERGE INTO MAIN" → ""`、`blockers` 前後皆為 0 |
| **in-flight 守衛**：一次慢回應在途時再觸發兩次 | 通過：`calls 1`、`inFlight true`（三次觸發只送出一個請求） |
| 慢回應落地後守衛解除，之後的 tick 能通過 | 通過：`inFlight false`，下一次 tick `calls 2` |
| **簽章沒變的 early return 也會解除守衛**（旗標清在 `finally` 而不是 `catch` 的理由） | 通過：`calls 3` → `inFlight false` → 下一次 tick `calls 4` |
| Console error／exception | 無 |

**已接受的 gate digest（room.js，含重繪歸零與輪詢守衛）**：
`3313bc6c0d72e32b13c096e90dca1b74f28b8be722d51f1461d99a3a4a281c49`

**這一次沒有涵蓋的**：
- 同前：手動驗收、不在 CI 重跑，守它的只有 digest guard。
- **在這個分頁裡 `setTimeout` 被 Chrome 的背景節流卡住**（第一次嘗試以 45 秒 CDP timeout 失敗，
  且一個 2.5 秒的 `setTimeout` 從未觸發）。慢回應因此改用**明確的 deferred promise** 持住，
  而不是計時器。守衛本身與用哪一種等待無關，但這代表**沒有驗證「真的等 5 秒之後」的時序行為**。
- `credential.<url>.helper` 的遮蔽是在**伺服器端**做的，瀏覽器這一半只能證明「payload 裡沒有秘密時
  畫面上也沒有」。秘密不進 payload 那一半由 `test/git-broker.test.ts` 以真實 `git config` 守著。

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
| Promotion/recovery（Phase 5-5，第六輪：核心路徑＋audit／ledger＋**觀察與釋放的 CLI 出口**；寫入 main 仍無出口） | 核心已實作／synthetic＋真實 git 已驗證；**在真實或拋棄式 repo 上的 Owner GUI live 驗收仍未做** | `promoteMainMerge()` 是全產品唯一寫入 canonical main 的路徑，順序固定為「驗證綁定 → 寫入 durable `applying` 意圖紀錄 → 消耗核准 → `git merge --no-ff --no-edit` → 寫入終局結果」。意圖紀錄（schema v5 新表 `candidate_merge_promotions`，純加表升級，v1/v3/v4 皆不動既有列與 row hash）在任何 Git 寫入前就含 pre-HEAD、pre-index 指紋（`ls-files --stage`，非 `write-tree`，因為後者會寫物件並可能取 `index.lock`）、tracked 工作樹指紋、**未追蹤與 ignored 檔案的路徑＋內容指紋**、stash、reflog 與將執行的 hook 清單＋SHA-256，另存 `owner_pid` 以區分「執行中」與「已崩潰」，並在 merge 子程序被 spawn 的當下把它的 **pgid** 寫進同一筆紀錄——`detached` 讓 `git merge` 自成 process group，`kill -9` orchestrator **不會**停下它，它會繼續把 main 寫完（已實測）。**崩潰後的 reconciliation 一律唯讀**：不 `reset`／`checkout`／`merge --abort`／`clean`／`stash`／改 `.git/config`／刪 `*.lock`，只讀取、逐項比對指紋、具名列出每一個不同的面向。**每一次讀取都重新觀察**（不是寫死一次就凍結）：pgid 仍存在時一律回報「仍在寫入」而不下任何結論；孤兒 merge 跑完之後下一次讀取即回報 `AUTHORIZED_MERGE_COMMIT_OBSERVED_WITH_MERGE_STATE_LEFT_BEHIND`（HEAD 已是被授權的 merge commit，但 git 仍留著 `MERGE_HEAD`），Owner 清掉具名的殘留後再讀即為 `applied`；Owner 自己把 main 復原後再讀即為 `rolled-back`。**復原指令是觀察來的，不是寫死的**：一旦觀察到被授權的 merge commit 就改為唯讀的 `git -C <main> show --stat <observed head>`（`recoveryKind: inspect-observed-merge`），只有在沒觀察到它時才提供 `git -C <main> reset --hard <pre-HEAD>`（`recoveryKind: reset-to-pre-promotion`）——否則那行指令會叫 Owner 丟掉一次真的成功了的 merge。`merged` 為終局：成功後 candidate 轉 `merged`，再次 preview／request 一律 `MAIN_MERGE_CANDIDATE_ALREADY_MERGED`。同一 approval 的併發 promotion 由 `approval_id` UNIQUE 索引序列化，輸家在跑任何 Git 指令前就被擋下。**已用真實 git 實測**（`test/merge-promotion.test.ts`，第二輪為 39 條）：hook 真的被執行（hook 寫檔、斷言檔案存在）而 preview 一次都沒執行；`pre-merge-commit` 非零退出後 main 的 HEAD／index／工作樹／未追蹤／ignored／stash／reflog 逐項回到 pre-op 指紋且移除外部條件後可重新成功；`post-merge` 非零退出時 merge 已完成，紀錄照實記為 `applied` 而非失敗；會掛住的 hook 被逾時終止且 **hook 自己的 pid 被斷言已消失**；main 有 ignored 檔案位於 merge 會寫入的路徑時**逐一具名列出並在核准前拒絕**（實測 git 會靜默覆蓋、exit 0、事後仍報工作樹乾淨）；十七種「不乾淨」條件各有一條拒絕測試（tracked 變更、未追蹤檔案、`skip-worktree`、sparse-checkout 的 `true`／`1`／`yes`／`on` **四種寫法**、`MERGE_HEAD`、`index.lock`、`.gitmodules`、**index 內 160000 gitlink 且完全沒有 `.gitmodules`**、LFS/clean-smudge filter、以及 `filter=` 出現在 **root／巢狀／被 ignore 的 `.gitattributes`／`.git/info/attributes`／`core.attributesFile`** 五種位置）；`.git` 唯讀與 merge driver 失敗兩種真實失敗各驗一次回滾與「恢復後重新發起成功」；核准後才出現的 `index.lock`／`MERGE_HEAD` **拒絕但不消耗核准**，清除後同一把 token 仍可成功；**真實 `kill -9` 打在 hook 執行中**，由**另一個新 OS 程序**重開 registry，回報 `needs-manual-review`、具名列出 `index`／`trackedWorkingTree` 等差異、給出可複製的復原指令、不自行重試也不自行回滾，candidate 與 recovery ref 完好。hook 環境與 ignored 內容指紋納入 `previewDigest`（因此納入綁定），消耗前再比對一次；**live 的 `.git` 狀態刻意不納入 digest**——實測發現納入會讓別的程序短暫持有的 `index.lock` 永久燒掉 Owner 的核准（PITFALLS #85 同形）。**第三輪新增**（`test/merge-promotion.test.ts` 61 條，**原文誤寫 57 條，已更正**）：process group 的判準改為 group **leader**＋開機時刻身分，背景殘留的孫程序具名回報而不再阻擋收斂，且新增 Owner 側的 `abandonMergeProcessGroup()` 出路；attributes 閘門改為**直接問 `git check-attr`**（列舉保留為第二半）；promotion 的 audit 與 room ledger 兩條路徑都留痕，**hook 檔名與退出碼由 `GIT_TRACE2_EVENT` 觀察而來**；另外三個 kill 窗、外部程序推進 main、preview 節流、五個 leftover 拒絕條件（拒絕表 17 → 22 條）各補測試。第一輪三次、第二輪九次、第三輪九次突變測試證明測試不是空的（每一次都實際跑過整份檔案並附輸出）：拿掉 ignored 內容雜湊、拿掉 authorize 端 gate、拿掉 hook 綁定；以及在 reconciliation 插入 `merge --abort`、移除 consume 端的未結促進 gate、把「快照早於 gate」折回完整性失敗、不查 merge pgid、把 `needs-manual-review` 改回凍結、把復原指令改回永遠 `reset --hard`、`.gitattributes` 只讀 root、sparse 用字串比對、submodule 只看 `.gitmodules`——**九個突變全部讓對應測試變紅**。**第四輪新增**（詳見「第四輪修正紀錄」）：main 的**整份 effective config** 納入 `previewDigest`／綁定／消耗前重驗，並在 `promotionGitEnvironment()` 釘死 `core.fsmonitor`／`commit.gpgsign`／`tag.gpgsign`／`merge.verifySignatures`（**因此 promotion 不簽章**）——起因是實測 `gpg.program` 在核准後被寫入時**以 Owner 身分執行成功**；`abandonMergeProcessGroup` 對「leader 證明活著」改為兩段式確認，且該狀態下不再產生 `reset --hard` 的復原指令；`processAlive` 的 `EPERM` 與 `probe()` 判準對齊，並新增對稱的 `abandonPromotionOwnerProcess()` 出路；排他標記改為對 `main_path` 的 partial unique index。 | **仍未做**：`promoteMainMerge` 的 HTTP／MCP／GUI 出口（刻意；`grantMainMerge` 有 GUI 出口，促進本身沒有）、第 8 項取消語意的 UI、第 9 項在拋棄式 repo 上的 Owner 瀏覽器驗收（成功一次＋真實失敗回滾一次）與涵蓋伺服器端函式的 gate digest。**已補（第三輪）**：audit／room ledger 的 promotion 紀錄（含觀察來的 hook 檔名與退出碼）、另外三個 kill 窗、第 7 項的外部程序推進 main 測試（結論與裁決請求見第三輪修正紀錄）、preview 節流測試。**已補（第六輪）**：`promotions()` 與三個釋放動作的 CLI 出口（`orchestrator candidates promotions <workspace>` 與 `… release …`，觀察與釋放分開）、讀不了的列在還有程序活著時改用說出「main 可能正在被寫」的短語並要求確切 pgid、`storedState`／`holdsProjectExclusiveMarker` 每次讀取重新導出、覆蓋掃描兩個 fail-closed 分支的測試、設定鍵內秘密的遮蔽、對話框重繪歸零與輪詢 in-flight 守衛（真實瀏覽器驗收） |
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

- 594/594 deterministic tests＋1/1 fuzz smoke（2026-08-07，Phase 5-5 **第五輪**對抗式審查修正後，
  在靜止的工作樹上 `npm run check` **跑了三次，三次都 exit 0**；line 95.53／95.52／95.53、
  branch 87.52／87.50／87.51、functions 97.18／97.10／97.18，gate 為 90／85／90。
  第三次另外以「跑之前與跑之後對全部改動檔案取 SHA-256 並比對」證明樹在該次執行期間**逐位元未變**；
  這一列的第三組數字是那次跑完之後才寫進本檔的，本檔不在覆蓋計算內）。
  **被主張的只有 exit code**，見下方關於數字抖動的說明（[[PITFALLS]] #34）。
  本輪尚未重跑乾淨 clone；branch 餘裕約 2.5 個百分點。
- 576/576 deterministic tests＋1/1 fuzz smoke（2026-08-06，Phase 5-5 **第二輪**對抗式審查修正後，
  在靜止的工作樹上 `npm run check` 一次跑完，**exit 0**；跑了兩次，line 95.42／95.43、
  branch 87.62／87.61、functions 96.99／97.08，gate 為 90／85／90，**兩次都 exit 0**）。**被主張的只有 exit code**，見下方關於數字抖動的說明。
  第二輪之後尚未重跑乾淨 clone；下一列的 clone 數字對應的是第一輪修正後的那棵樹。
- 556/556 deterministic tests＋1/1 fuzz smoke（2026-08-06，Phase 5-5 第一輪對抗式審查修正後，
  `npm run check` 一次跑完，**exit 0**）。
- 最新最終 gate（**以乾淨 clone 為準**）：line 95.26%、branch 87.71%、functions 97.03%；
  gate 分別為 90%、85%、90%，`npm run check` **exit 0**。
  同一份 tree 在開發工作樹上的最終跑法是 line 95.26／branch 87.75／functions 96.97。
  本次一共跑了七次完整 gate（乾淨 clone 兩次、工作樹五次），量到的 line 都在 95.2x、
  branch 都在 87.7x、functions 都在 96.9–97.1，**七次全部 exit 0**。
  **這個值不是決定性的**：同一份 tree 重跑就會小幅移動（實測 line 最低 95.24、最高 95.28），
  所以這裡記的是一次具名的乾淨 clone 量測加上觀察到的量級，**被主張的東西只有「exit 0」**。
  任何把某一個兩位小數當成必須複現的數字的讀法都是錯的（[[PITFALLS]] #34）。
  這個抖動屬 [[PITFALLS]] #34 已記錄的 OS process branch/function 命中時序差異，
  正因為如此：**文件數字一律以乾淨 clone 的最後一次為準，而且只有 exit code 是權威。**
  乾淨 clone 的做法：`git clone --no-hardlinks` 目前 repo、`git checkout 35bcfff`、
  把工作樹的 7 個改動檔逐一覆蓋、複製 `node_modules`，並先斷言四個原始碼檔案的 SHA-256 與工作樹相同。
  branch 餘裕約 2.7 個百分點（實測最低的一次為 87.71%）；仍應假設任何新增分支都要同批補測試。
  （先前此處記為 line 95.14／branch 88.03／functions 96.93，是 Phase 5-4 修正後的 501 條測試在
  開發工作樹上的數字；第一輪 5-5 交付曾記為 95.19／87.74／97.01，審查員在乾淨 clone 實測為
  95.18／87.74／96.92——差異的成因與上面同一條，處理方式是本段的「一律以乾淨 clone 為準」。）
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
