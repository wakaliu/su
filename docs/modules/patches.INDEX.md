# patches 模块索引

## 约定

- 每个补丁文件顶部或改动行附近标注 `// [su]`
- 本表登记：ID、目的、触达文件、验证方式
- 由 `scripts/apply-patches.ps1` 幂等应用到 `vendor/vscode`（bootstrap / build-win 调用）

| ID | 文件 | 目的 | 验证 |
|----|------|------|------|
| 0001-skip-copilot-shim | `patches/0001-skip-copilot-shim.md` → `build/lib/copilot.ts` | OSS 跳过 Copilot 时，打包不因 ripgrep shim throw 失败 | `vscode-win32-x64-ci` 成功且日志可见 skip |
| 0002-tsgo-exit2-tolerance | `patches/0002-tsgo-exit2-tolerance.md` → `build/lib/tsgo.ts` | tsgo 原生崩溃（exit 2 且 0 条 error 行）不阻断打包；真实类型错误仍挡构建 | CI 日志见 `[su] tsgo exited ... treating as non-blocking`，链条继续 |
