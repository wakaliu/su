---
name: su-mac-build
description: macOS darwin-arm64/x64 未签名 DMG 编译与打包。在需要产出 Mac 内部分发包或排查 mac CI 时使用。
---

# su-mac-build

## 必读

- `docs/build-macos.md`
- `docs/updates.md`

## 步骤（CI）

1. push `develop`（改动触及 su-ai / branding / scripts / patches / build-mac.yml）会自动跑 **build-mac**；也可 Actions 手动，或 **release-mac**（`v*` / 手动 tag）
2. 等待 matrix：`macos-14`+arm64、`macos-13`+x64
3. 从 Pre-release / Release 下载对应 DMG

## 步骤（本机 Mac）

1. `pwsh ./scripts/bootstrap.ps1`
2. `$env:SU_DARWIN_ARCH='arm64'; pwsh ./scripts/build-mac.ps1`（或 `x64`）
3. `pwsh ./scripts/package-mac.ps1`
4. 记录 `out/su-darwin-*-*.dmg`

## 验收

- 两架构各有一份 `.dmg`
- 目标机器可启动 su（清隔离 / 右键打开后）
- Chat 面板可用

## 坑

- Windows 主机无法出 Mac 包
- 未签名：Gatekeeper 需右键打开或 `xattr -cr`
- `macos-13` 下线后需改交叉构建方案

## 相关

- `su-bootstrap` / `su-win-build` / `su-release-gate`
