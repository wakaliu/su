---
name: su-win-build
description: Windows x64 编译与打包 su IDE。在需要产出验收包或排查构建失败时使用。
---

# su-win-build

## 必读

- `docs/build-windows.md`
- `docs/acceptance/v0.1.md`（若打 v0.1 包）

## 步骤

1. 已完成 bootstrap
2. `.\scripts\build-win.ps1`
3. `.\scripts\package-win.ps1`
4. 记录产物路径到验收清单

## 验收

- 生成可启动的 Windows x64 产物
- 启动后产品名为 su

## 相关 Skill

- `su-bootstrap`
- `su-win-build`
- `su-release-gate`

开发态启动：`.\scripts\run-dev.ps1`（见 `docs/build-windows.md`）。
