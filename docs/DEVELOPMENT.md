# 安全開發與驗證流程

> **2026-08-01 normative update：** 開發流程以 ADR-028 與 `AGENTS.md` 為準。Provider、workspace、
> command broker 的舊限制只適用 GUI Managed；Native Full-Trust 的必要安全測試改為 exact-seat identity、
> peer thread、candidate/main snapshot、merge approval、drift、recovery 與 capability 不降級。

## 1. Toolchain

- 使用當時仍受支援的 Node.js LTS，並以版本檔精確 pin。
- TypeScript strict mode；安全邊界不接受隱式 `any`。
- Package manager 與 lockfile 精確 pin，CI 使用 frozen install。
- 不依賴全域 package 的隱含版本；provider CLI 版本需在 `doctor` 中記錄與驗證。

已完成 child-process cancellation、TUI control-sequence handling、SQLite permissions 與 loopback
Web security spike。Repository test 不採未公開穩定契約的 macOS `sandbox-exec`，改採 digest-pinned
Docker/Podman；本機 runtime smoke test 仍待 owner 安裝 runtime 後執行。

## 2. Repository 結構目標

```text
apps/
  cli/
  tui/
  web/
packages/
  core/
  policy/
  workflow/
  workspace-broker/
  command-broker/
  providers/
  persistence/
  security/
  collaboration/
  candidate/
  promotion/
  recovery/
docs/
tests/
  unit/
  integration/
  security/
  fixtures-synthetic/
```

安全核心與 UI 分離，UI 不得直接 import 低階 secret、process 或 filesystem 實作。

## 3. Coding rules

- 所有外部輸入先解析成 typed value，再進 domain logic。
- 不使用 shell、eval、動態 require/import 未信任路徑。
- 不在 error 中附帶 raw request、environment、prompt 或 provider response。
- Path、URL、model ID、command args、event payload 都有明確 schema 與大小限制。
- Security decision 回傳 typed reason code，避免呼叫者靠解析字串決定行為。
- Cancel、timeout 與 cleanup 使用 `finally`，且測試 process tree 清理。
- Sensitive objects 避免被一般 serializer 接受；必要時以 opaque handle 表示。
- 所有 log 欄位使用 allowlist；禁止任意 object spread 到 logger。

## 4. 測試層次

### Unit

- Policy decision matrix。
- Path canonicalization 與 escape corpus。
- Command argv validation。
- Redaction 與 data classification。
- Limits、quota、retry、circuit breaker。
- Approval state machine。

### Integration

- 使用 fake provider CLI，不使用真實帳號或 secrets。
- CLI 掛起、崩潰、部分 JSON、超大輸出與取消。
- SQLite migration、崩潰恢復與 concurrent access。
- Git dirty tree、外部修改與 checkpoint。
- TUI/Web 與相同 application layer 的權限一致性。

### Security

- Prompt injection corpus。
- Shell/argument injection corpus。
- Symlink、Unicode、特殊檔案與 race 測試。
- CSRF、Host/Origin、WebSocket schema、rate limit。
- ANSI/OSC terminal escape injection。
- Secret canary 確認不進 log、DB、UI、artifact。
- Resource exhaustion 與 process tree cleanup。

### Fuzz/property tests

- Path parser、command schema、event decoder、redactor 與 state transitions。
- 重要 invariant：任何生成輸入都不能讓 action 超出 policy allowlist。

## 5. Coverage 與 Gate

- 自動 gate：line 至少 90%、branch 至少 85%、functions 至少 90%。
- Policy、path、command、secret、approval 與 limits 模組要求接近完整 branch coverage，未覆蓋分支需書面理由。
- 型別、lint、測試、dependency、secret、license 與 build scan 任一失敗即阻擋合併。
- 不允許以 skip、ignore、降低 severity 或更新 snapshot 方式掩蓋安全失敗。
- `npm run check` 會先對全部 tracked 與非 ignored untracked text 執行 LF／UTF-8／tab／trailing-space／final-newline／JSON／
  executable-mode 與危險 code-pattern hygiene lint，再執行 syntax、strict typecheck、上述 coverage gate、deterministic fuzz、SBOM drift、
  working-tree scan 與完整 Git history scan；`npm run check:release` 再加入 dependency audit、offline
  committed-HEAD clean clone 與實際 tgz 安裝／bin／audit reproduction。
- 目前證據：290/290 tests；line 95.23%、branch 85.13%、functions 96.80%；verified runtime tgz
  為 86 個由 tracked allowlist 建出的檔案。

Source manifest 保持 `private: true`，並把 `publishConfig.registry` 固定到 loopback sink，避免一般
`npm publish` 將 source tree 傳至外部 registry；直接 `npm pack` 只會產生含 TypeScript 與開發 scripts
的未驗證 source snapshot，不是 release artifact。以乾淨 committed HEAD
執行 `npm run build:package`，它會完成與
release gate 相同的 clean-clone、tgz、離線安裝、CLI 與正負 audit 驗證，並把候選 tgz 與 SHA-256
寫入 owner-only、Git ignored 的 `dist/release/`。任何 push、registry publish 或 release upload 仍需
owner 對版本、package ownership 與發布範圍另行明確核准。

## 6. Dependency policy

新增 dependency 前記錄：

- 為何標準函式庫或現有依賴無法完成。
- 維護者、release 頻率、下載來源與 package ownership。
- 直接與 transitive dependencies。
- 安裝 scripts、native code、網路與 filesystem 行為。
- License 與已知漏洞。
- 替代方案與移除成本。

高權限核心優先使用小型、可審查實作，避免把安全邊界委託給大型依賴樹。

## 7. CI 原則

- Workflow permissions 預設 read-only，逐 job 最小化。
- 外部 PR 不提供 repository/environment secrets。
- 不以高權限事件執行 PR 可修改的程式碼。
- Actions pin 到完整 commit SHA。
- Checkout 不持久化 credential；workflow 只有 `contents: read`，無 secrets，自動 dependency cache 關閉。
- Build 與 test runner 不使用長期雲端 credentials。
- Release job 與一般 CI 分離，採人類批准與短期身分。
- 產生 SBOM、checksums、provenance 與掃描結果。

## 8. 安全變更模板

每個安全相關 PR/變更需回答：

```text
資產與信任邊界：
新增能力或權限：
可被攻擊的輸入：
失敗時是否 fail closed：
新增/調整的 hard limits：
秘密與個資資料流：
測試證據：
殘餘風險：
Rollback：
```
