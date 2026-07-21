# 公開與發布安全閘門

此清單適用於首次公開 GitHub、每個 release、套件發布與可執行檔分發。任一必要項未通過即禁止發布。

## A. 人類授權

- [ ] 使用者明確批准本次公開/發布範圍。
- [ ] Repository visibility、owner、名稱與 license 已確認。
- [ ] 確認沒有自動 push、auto publish 或 auto top-up。
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

- [x] 272/272 deterministic tests 通過；line 94.98%、branch 85.11%、functions 96.80%，通過
  固定 90%／85%／90% 覆蓋率門檻。
- [x] CycloneDX 1.5 SBOM 已驗證；3 個 components，dependency/lockfile 無 drift。
- [x] Working-tree 與完整 Git history 掃描通過。
- [x] 完整 npm dependency audit（含 dev toolchain）為 0 vulnerabilities；offline clean package-snapshot
  reproduction 與 package dry-run 均驗證 87 個明確 allowlist 檔案；test、CI、Agent instructions、
  package lock 與非 runtime scripts 均不進入 artifact。
- [x] CI 使用完整 action commit SHA、`contents: read`、不保留 checkout credential、不使用 secrets。
- [x] `npm run repro:smoke` 以 `--no-hardlinks` 複製 committed `HEAD`，驗證相同 commit、clean status、
  offline `npm ci --ignore-scripts` 與完整 `npm run check`；package snapshot 另驗證 TS typecheck、
  CLI help 與本機 audit；不依賴 working tree 的未提交檔案。
- [ ] Release artifact checksum、signature/provenance 等待實際發布授權。
- [ ] GitHub Private Vulnerability Reporting、secret scanning、dependency alerts 與 branch protection 需在建立 repository 後啟用。
- [ ] 真實 provider/container smoke tests 等待額度、runtime 與 image 授權。
- [ ] 完整 GUI 視覺點擊 QA 尚未涵蓋主儀表板所有流程；Room 辦公室切換、agent 預填、右側聊天與 Writer 面板已完成 Browser 驗收，HTTP/Web 安全整合測試已通過。
- [ ] 人類 GO/NO-GO、名稱、license、Git identity、GitHub 公開範圍仍未批准。
