# 应用更新（Windows）

## 现状

Code-OSS `quality: oss` **不接**微软更新通道。su 在内置扩展 **su-ai** 中实现：

1. 菜单 **帮助 → Su → 检查更新**（命令 `Su: 检查更新`）
2. 启动约 8 秒后自动检查（可关：`su.update.checkOnStartup`）
3. 发现新版本时提示：**下载并安装** / **打开发布页** / **稍后** / **跳过此版本**

版本源：`branding/version.json`（注入时写入扩展目录 `version.json`）。  
更新源：GitHub Releases（默认仓库 `wakaliu/su`，可改 `su.update.repo`）。

## 发版才能检到更新

应用内检查依赖仓库上存在 **高于当前 `branding/version.json` 的 Release tag**，且资产名尽量包含 `win32`/`windows`/`x64`，扩展名 `.exe` / `.msi` / `.zip`。

### 自动 Pre-release（develop 构建）

workflow **`build-win`** 在 `develop` 推送（或手动 Run）且打包成功后，会自动创建：

- **Pre-release** tag：`v{version}-dev.{YYYYMMDD}.{短sha}`（例：`v0.1.0-dev.20260920.d028d63`）
- 资产：`out/su-win32-x64-*.zip`

默认用户**不会**收到这些更新（`su.update.includePrerelease=false`）。内测可在设置中打开该开关。

### 正式 Release

1. 修改 `branding/version.json` 的 `version`（如 `0.1.1`）
2. 提交并 `git tag v0.1.1 && git push origin v0.1.1`
3. 运行 workflow **`release-win`**（见 `.github/workflows/release-win.yml`），或手动把 zip 挂到该 Release

## 设置项

| 键 | 默认 | 含义 |
|----|------|------|
| `su.update.checkOnStartup` | `true` | 启动后自动检查 |
| `su.update.repo` | `wakaliu/su` | Releases 仓库 |
| `su.update.includePrerelease` | `false` | 是否包含预发布 |

## 验收要点

- 无更高 Release 时手动检查提示「已是最新」
- 有更高 tag + Windows 资产时弹出更新提示，可取消
- 关闭 `checkOnStartup` 后启动不再自动提示
