---
name: su-win-build
description: Windows x64 编译与打包 su IDE。在需要产出验收包或排查构建失败时使用。
---

# su-win-build

## 必读

- `docs/build-windows.md`
- `docs/acceptance/v0.1.md`（若打 v0.1 包）

## 步骤

1. 已完成 bootstrap（含 apply-patches）
2. `.\scripts\build-win.ps1`（链：compile-build-without-mangling → extensions → media → **bundle-vscode** → **vscode-win32-x64-ci**）
3. `.\scripts\package-win.ps1`（zip + `vscode-win32-x64-user-setup` → UserSetup.exe）
4. 记录产物路径到验收清单

## 验收

- 生成可启动的 Windows x64 产物（优先 **UserSetup.exe**）
- UserSetup 默认安装目录：`%LOCALAPPDATA%\Programs\su`
- 启动后产品名为 su

## 坑

- Node 必须 **24.18.0**（`.nvmrc`）；CI 勿用浮动 `24`（24.22.x 上 tree-sitter node-gyp 易挂）
- `build-win.ps1` 需带 `CXXFLAGS=/std:c++20`（脚本已默认设置）
- `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`（脚本已默认；避免 `@playwright/browser-chromium` 拉 CDN 失败）
- 勿再跑 `vscode-win32-x64-min-ci`（除非先 `minify-vscode` 产出 `out-vscode-min`）
- Copilot shim：依赖 patch 0001；否则 OSS 打包会在无 Copilot 时 throw
- Inno setup 需要 `quality: oss`（勿用 stable，会缺 Appx 字段）；AppId 须与 Code - OSS 区分（见 `product.overlay.json`）
- 仅 zip：`SU_SKIP_SETUP=1`

## 相关 Skill

- `su-bootstrap`
- `su-win-build`
- `su-release-gate`

开发态启动：`.\scripts\run-dev.ps1`（见 `docs/build-windows.md`）。
