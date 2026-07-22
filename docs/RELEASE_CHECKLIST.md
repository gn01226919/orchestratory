# 公開與發布安全閘門

此清單適用於首次公開 GitHub、每個 release、套件發布與可執行檔分發。任一必要項未通過即禁止發布。

## A. 人類授權

- [x] 使用者明確批准建立 sanitized Private GitHub repository 並首次 push；未批准公開或 npm publish。
- [x] Repository visibility、owner、名稱與 license 已確認：`gn01226919/orchestratory`、Private、Apache-2.0。
- [x] 確認沒有自動 publish 或 auto top-up；GitHub push 只限本次明確授權範圍。
- [ ] 安全關鍵變更已由人類逐項審查；模型 review 只作輔助。

## B. 資料與個資

- [ ] `git ls-files` 中只有預期公開檔案。
- [ ] `.env`、DB、logs、sessions、cache、coverage、screenshots、private fixtures 未被追蹤。
- [ ] Working tree、staged content、完整 history、branches、tags 均完成 secret scan。
- [ ] Build output、source maps、archives、SBOM、provenance 均完成 secret/PII scan。
- [ ] 無私人 email、使用者名稱、本機絕對路徑、私有 repository URL 或 session ID。
- [ ] Git author email 符合使用者的公開隱私偏好。
- [ ] 若曾發現秘密，已先撤銷/輪替，再清理 history 並重新掃描。

## C. 程式安全

- [ ] 無 `shell: true`、eval、任意 executable path 或未驗證 plugin loading。
- [ ] Workspace canonicalization、symlink、特殊檔案與 TOCTOU 測試通過。
- [ ] Command allowlist、argv schema、timeout、output limit 與 process-tree cleanup 通過。
- [ ] Prompt injection 不能提高權限或取得秘密。
- [ ] Long-run/API mode 不能繞過 hard limits。
- [ ] API fallback、auto top-up 與危險 auto-approval 預設關閉。
- [ ] Web 僅 loopback，Host/Origin/CSRF/session/CSP 測試通過。
- [ ] TUI control-sequence sanitization 測試通過。
- [ ] TUI setup fail-closed、bounded dashboard render 與二次取消確認測試通過。
- [ ] Log/DB/UI secret canary 測試通過。

## D. 品質與供應鏈

- [ ] Formatting、lint、typecheck、unit、integration、security、fuzz smoke tests 全部通過。
- [ ] Dependency vulnerability、license、malware/typosquat 檢查通過。
- [ ] Lockfile 與 runtime/package-manager versions 已 pin。
- [ ] CI actions pin 到 commit SHA，permissions 最小化。
- [ ] Fork PR 無法取得 secrets 或高權限 token。
- [x] 乾淨、隔離的 committed-HEAD clone 可離線重現安裝、型別、完整測試、SBOM 與安全掃描。
- [ ] 產生 SBOM、checksums 與 provenance；簽章流程無長期 secret。

## E. 文件與操作

- [ ] README 清楚標示 local-first、資料流、限制與非保證事項。
- [ ] SECURITY、THREAT_MODEL、AGENTS 與架構文件反映實際行為。
- [ ] 安裝文件不鼓勵 pipe-to-shell 或跳過權限。
- [ ] API/訂閱模式、成本限制與資料 retention 有清楚說明。
- [ ] 提供安全 uninstall、資料清除與 credential revocation 指引。
- [ ] 已列出已知限制與殘餘風險。

## F. 發布後

- [ ] 驗證 GitHub repository 實際可見檔案與 release assets。
- [ ] 驗證 package registry metadata、來源與 checksum。
- [ ] 啟用 secret scanning、dependency alerts、branch protection 與必要 review。
- [ ] 建立安全通報管道與處理 SLA。
- [ ] 監控發布後異常，但不收集使用者 prompt/source/credentials。

## 發布決策紀錄

```text
版本／commit：
日期：
批准者：
掃描工具與版本：
測試證據位置：
已知風險：
是否發布：GO / NO-GO
```

## 目前本機證據（不等於發布批准）

- [x] Dependency-free repository-source format/hygiene lint 通過：UTF-8/LF、tab/trailing-space/final-newline、
  JSON、regular/executable mode 與 debugger/eval/dynamic Function/`shell: true` 規則均由 release gate 阻擋。
- [x] 274/274 deterministic tests 通過；line 94.98%、branch 85.06%、functions 96.82%，通過
  固定 90%／85%／90% 覆蓋率門檻。
- [x] CycloneDX 1.5 SBOM 已驗證；3 個 components，dependency/lockfile 無 drift。
- [x] Working-tree 與完整 Git history 掃描通過。
- [x] 完整 npm dependency audit（含 dev toolchain）為 0 vulnerabilities；offline clean package-snapshot
  reproduction 與實際 tgz 離線安裝均驗證 86 個由 tracked allowlist 建出的 runtime 檔案；test、CI、Agent instructions、
  package lock 與非 runtime scripts 均不進入 artifact。
- [x] CI 使用完整 action commit SHA、`contents: read`、不保留 checkout credential、不使用 secrets。
- [x] `npm run repro:smoke` 以 `--no-hardlinks` 複製 committed `HEAD`，驗證相同 commit、clean status、
  offline `npm ci --ignore-scripts` 與完整 `npm run check`；再由 clone 建實際 tgz、離線安裝並驗證
  runtime-only manifest、pinned TS-to-JS build、`.bin` link／mode、CLI help 與正負向本機 audit；不依賴 dirty tree。
- [x] Source manifest 保持 `private: true`，並將 `publishConfig.registry` 固定到 loopback sink，
  避免一般 `npm publish` 把 source tree 傳到外部 registry；`npm pack` 只能產生未驗證的 source
  snapshot，不是 release artifact。唯一支援的本機候選版路徑是
  `npm run build:package`。它要求乾淨的
  committed HEAD，重用上述完整驗證，最後只把 publishable tgz 與 SHA-256 保留於 owner-only、Git ignored
  的 `dist/release/`；產生本機 artifact 不代表核准任何 registry／GitHub 發布。
- [x] Artifact persistence 使用 `O_NOFOLLOW` descriptor 與 `O_CREAT|O_EXCL`，經 fd write、fsync、fstat；
  collision 先驗 regular file、owner、single link、0600 與精確 bounded size 才讀取比較。symlink、hardlink、
  oversized 與 0644 負向測試均 fail closed，且不修改 target。
- [ ] Release artifact checksum、signature/provenance 等待實際發布授權。
- [ ] GitHub Private Vulnerability Reporting、secret scanning、dependency alerts 與 branch protection 需在建立 repository 後啟用。
- [ ] Codex／Claude 最小 live smoke 已完成；Grok、API 與 container smoke 仍等待額度、runtime／image 與逐次授權。
- [ ] 2026-07-22 受控 Chrome 已驗證 Room 精確切換、external join/approve、exact-seat 與常駐
  Codex／Claude 喚醒回覆、bounded wait timeout、雙 Enter、Writer grant/run/checkpoint 與零變更
  apply-back；HTTP/Web 安全整合測試已通過。真實 macOS 中文 IME、雙埠 cookie、child executor 與
  非零檔案 apply-back 仍待個別人工驗收。
- [ ] 人類對公開 visibility、npm publish 與正式 release 仍為 NO-GO；本次只批准 Private source push。
- [x] Owner 已選擇由 sanitized snapshot 建立全新 repository；既有含 live project/Room metadata 的
  內部 Git history 不得推送。
