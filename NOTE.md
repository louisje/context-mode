# NOTE

不相關問題的暫存記錄，之後找時間處理。

## 既有測試失敗（與 dev-checkout guard 修復無關）

`tests/hooks/cache-heal-self-heal.test.ts`
「a stale breadcrumb pointing at a removed intermediate version is re-pointed at the live root」

```
Error: ENOENT: no such file or directory, stat '/tmp/ctx-breadcrumb-XXXXXX/plugins/cache/context-mode/context-mode/1.0.050'
```

- 在 main 分支（改動前）就已經失敗，確認過不是本次改動造成的。
- 錯誤路徑用的是 `/tmp` 隨機目錄，疑似測試對環境/時序有隱性依賴（breadcrumb symlink 建立與清理的時序問題）。
- 待查：測試本身邏輯 vs 環境問題。

## 既有測試失敗（與 ask-based routing 改動無關）

### 1. `better-sqlite3` native binding 是 Linux x86_64 binary，macOS 無法載入

影響測試：
- `tests/hooks/antigravity-cli-hooks.test.ts`（5 個失敗）
- `tests/hooks/kimi-hooks.test.ts`（3 個失敗）
- 所有會開啟 SessionDB 的測試也可能受影響

錯誤訊息：
```
dlopen(.../better-sqlite3/build/Release/better_sqlite3.node, ...): slice is not valid mach-o file
file .../better_sqlite3/build/Release/better_sqlite3.node: ELF 64-bit LSB shared object, x86-64
```

- 這是 checkout 環境的二進位檔 architecture 錯誤，與本次 code change 無關。
- `scripts/heal-better-sqlite3.mjs` 可用來嘗試修復，但可能涉及網路下載/編譯。
- 待處理：在 macOS 上重建或更換為正確的 darwin-arm64/x64 prebuild。

### 2. 缺少 `skills/ctx-upgrade/SKILL.md`

影響測試：
- `tests/hooks/integration.test.ts > Skill Commands > ctx-upgrade skill directory exists with valid SKILL.md`

- `skills/` 下有 `ctx-doctor`、`ctx-stats` 等前綴目錄，但沒有 `ctx-upgrade`。
- 與本次改動無關，待補上 skill 目錄與 SKILL.md，或更新測試預期。

### 3. `tests/core/cli.test.ts` 多個失敗

- 執行 `npm run build` 後仍有 39 個失敗。
- 初步觀察是測試預期與 `src/cli.ts` 目前實作不一致（例如 `cli.bundle.mjs` 的引用位置、statusline 程式碼路徑等）。
- 需要獨立調查是否為近期重構後測試未同步，或本機環境問題。

## 2026-10-12 merge upstream/next 後的既有問題（非本次造成）

### ✅ 已修（2026-10-12）
- `npm test` 在 pretest 的 assert-asymmetric-drift 就失敗：`.claude-plugin/plugin.json` args[0]="--yes"（e09fcfb）違反 #531 invariant（要求 `${CLAUDE_PLUGIN_ROOT}/start.mjs`）。**修法（2026-10-12 二修）：user 本意就是 npx——保留 `npx --yes louisje/context-mode`，把 invariant 從「兩檔必須相同」放寬為「各檔 pin 各自的形式」**（plugin.json=npx 給 marketplace 安裝、.mcp.json.example=start.mjs 給貢獻者本地開發，兩檔服務對象不同，不對稱是刻意的）。另修 `tests/scripts/asymmetric-drift-assert.test.ts` 的 npm-pack 斷言（npm ≥10 的 `npm pack --json` 回傳以套件名為 key 的物件，非陣列）。
- vitest 22 個既有失敗（4 檔）：
  - 9 個 dlopen（session-db-bytes-migration 4 + statusline 5）：better-sqlite3 是 Linux ELF binary，`npm install-scripts approve better-sqlite3` + `npm rebuild` 重編成 Mach-O 即綠（package.json 加了 allowScripts）。
  - 13 個 source-string 斷言（start-mjs-self-heal 9 + upgrade-plugin-json-assertion 4）：fork 在 20c0fea 刻意移除 self-heal 自動化（user 自管 plugin cache 路徑）、cli.ts upgrade() 也移除（no tool self-overwrite 原則），上游測試還在斷言接線存在 → 測試 skip 並註明 fork 決策，不刪檔（保留與上游對照）。

### ✅ 已修（2026-10-12 第二批：剩餘 122 個失敗全數處理，全套 vitest 0 FAIL）
- heal/upgrade 接線斷言 44 個（postinstall-heal、cli-upgrade-verification、ctx-upgrade-platform-threading、upgrade-mcp-json-assertion、upgrade-verifies-binding 等 6 檔）：同法 skip 附 20c0fea 原因。
- `tests/core/cli.test.ts` 40 個：35 個 skip（斷言已移除的 upgrade()/heal 接線）；4 個 doctor 測試是錨點 bug（`async function insight` fork 不存在，doctor 本體保留）→ 錨點改 `function statuslineForward`；1 個 plugin.json manifest 斷言更新為 cf47f7a 的 npx per-file pinning。
- `tests/core/server.test.ts` 18 個：ctx_upgrade/ctx_insight 相關 skip；工具數 ≥11 改 ≥9；annotations EXPECTED 移除兩個已刪工具。
- 零星修復（真 bug 或測試未同步）：
  - `tests/lifecycle.test.ts`：`.bin/tsx` 被 npm 裝成真檔案複製（非 symlink），相對 import 斷 → `resolveTsxPath` 優先 `node_modules/tsx/dist/cli.mjs`。
  - `tests/server-stdin-eof-exit.test.ts`：bundle 載入 ~2.5s > storm deadline 1.5s，2s timeout 誤判 survived → waitForClose 2s→6s。
  - `hooks/antigravity-cli/pretooluse.mjs`：marker 條件漏 `ask`（9e2cf93 soften 後 curl/wget 是 ask，analytics 沒記到）→ 加 ask，與 claude-code pretooluse 一致。
  - `tests/plugins/openclaw.test.ts`：curl/wget modify→ask（9e2cf93）更新斷言；ctx_* 11→9。
  - `tests/hooks/kiro-hooks.test.ts`：curl/wget exit 2→0（ask → kiro passthrough）。
  - `tests/hooks/vscode-hooks.test.ts`：curl updatedInput→ask flat 結構。
  - `tests/guidance-throttle.test.ts`：WebFetch deny→ask。
  - `tests/runtime.test.ts`：1500ms probe 測試更新為「POSIX 不 probe」（4424ba7 fork perf commit，測試沒跟）。
  - `tests/opencode-plugin.test.ts`：ctx_* 11→9。
  - `tests/hooks/integration.test.ts`：ctx-upgrade SKILL.md 測試 skip（fork 刻意移除 skill）。
  - `tests/scripts/start-mjs-{win-install-861,mcp-boot}.test.ts`：整檔 skip（4774441 移除 boot 背景安裝）；861 的 describe 內 collection-phase `sliceBetween` expect 改 try/catch lazy。
- 結果：`npx vitest run` 4610 passed / 140 skipped / 0 failed（exit=1 僅來自 vitest pool worker 偶發 V8 OOM，非測試失敗，重跑即散）。

### 未修
- `tests/hooks/cache-heal-self-heal.test.ts` /tmp breadcrumb 時序（同上第 1 點；本輪未再現）。
