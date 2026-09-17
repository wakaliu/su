---
name: su-bootstrap
description: 拉取钉死 tag 的 vscode、应用 branding、注入 su-ai。在初始化仓库、重置 vendor、或首次本地开发时使用。
---

# su-bootstrap

## 必读

- `docs/upstream.md`
- `docs/modules/branding.INDEX.md`
- `docs/build-windows.md`

## 步骤

1. 在仓库根执行：`.\scripts\bootstrap.ps1`
2. 确认 `vendor/vscode` 存在且 `git describe --tags` 为 `1.136.1`（或文档钉死值）
3. 确认 `vendor/vscode/product.json` 已合并 su 品牌字段
4. 确认 `vendor/vscode/extensions/su-ai` 存在（或脚本约定的注入位置）
5. 确认 `scripts/apply-patches.ps1` 已跑过（`build/lib/copilot.ts` 含 `// [su]`）

## 验收

- bootstrap 无错误退出
- `docs/upstream.md` 与实际 tag 一致
- `docs/modules/patches.INDEX.md` 与已应用补丁一致

## 坑

- 已有 `vendor/vscode` 时脚本应可复用或提示；勿重复全量 clone 浪费时间
- 公司网络可能需代理才能访问 GitHub
- 无 patch 登记勿改 `vendor/vscode`；补丁经 `apply-patches.ps1` 写入
