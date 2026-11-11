# macOS 构建指南（内部分发 / 未签名）

## 范围

- 产出 **两份** DMG：`darwin-arm64`（Apple Silicon）与 `darwin-x64`（Intel）
- **不签名、不公证**；仅供内部分发
- 必须在 **macOS** 上构建（本机 Mac 或 GitHub Actions `macos-*`）
- Windows 本机**不能**交叉打出可运行的 Mac 包

## 推荐：GitHub Actions

仓库 workflow：

| Workflow | 触发 | 说明 |
|----------|------|------|
| **`build-mac`** | push `develop`（路径过滤同 build-win）或手动 | 双架构 Pre-release（tag 带 `-mac` 后缀） |
| **`release-mac`** | `v*` tag 或手动填 tag | 正式 Release 挂两份 DMG（可与 win zip 同 tag） |

说明：push 触发的路径为 `extensions/su-ai/**`、`branding/**`、`scripts/**`、`patches/**`、`.github/workflows/build-mac.yml`。macOS runner 较贵，无关文档-only 改动不会触发。

Runner：`macos-15` → arm64；`macos-15-intel` → x64（`macos-14` / `macos-13` 已退役）。

产物名示例：`su-darwin-arm64-0.4.1-*.dmg`、`su-darwin-x64-0.4.1-*.dmg`。

## 本机 Mac（可选）

```bash
# 需 Node 24、Python 3.11+、PowerShell 7+
pwsh ./scripts/bootstrap.ps1

export SU_DARWIN_ARCH=arm64   # 或 x64
pwsh ./scripts/build-mac.ps1
pwsh ./scripts/package-mac.ps1
```

产物：`out/su-darwin-<arch>-<version>-<stamp>.dmg`，旁路说明见 `out/darwin-<arch>/INSTALL-INTERNAL.txt`。

## 首次打开（Gatekeeper）

未公证包可能被拦截：

1. 将 `su.app` 拖到「应用程序」
2. **右键** →「打开」→「仍要打开」
3. 或：`xattr -cr "/Applications/su.app"`

## Branding

- Bundle ID：`com.su.editor`（`apply-branding.ps1` / overlay）
- 图标：若存在 `branding/icons/darwin/code.icns` 则覆盖上游；否则在 Mac 上可由 `build-mac.ps1` / `export-app-icons.py` 从 PNG 生成

## 明确不做

- Apple 公证 / Developer ID 签名
- Universal 胖包
- App Store
- Linux

## 相关

- Windows：[build-windows.md](build-windows.md)
- 更新检测：[updates.md](updates.md)
- Skill：`.cursor/skills/su-mac-build/SKILL.md`
