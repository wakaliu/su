# branding 模块索引

## 职责

将 Code-OSS 重塑为产品 **su**：应用名、数据目录名、图标、product overlay。

## 文件

| 路径 | 说明 |
|------|------|
| `branding/product.overlay.json` | 合并进上游 `product.json` 的字段 |
| `branding/version.json` | 产品版本 + GitHub 仓库（供更新检查） |
| `branding/icons/` | 应用图标（小篆「溯」黑底蓝绿；见 `icons/README.md`） |
| `scripts/apply-branding.ps1` | 合并 overlay、复制 win32 图标 |
| `scripts/export-app-icons.py` | 从确认母版导出 PNG/ICO 套件 |
| `scripts/inject-extension.ps1` | 注入 su-ai 并写入 `version.json` |

## 关键字段（overlay）

- `nameShort` / `nameLong` / `applicationName` → su
- `dataFolderName` → `.su`
- `win32MutexName` 等 Windows 标识避免与 Code 冲突
- `extensionsGallery` → Open VSX（若启用市场）
- `builtInExtensions` / 注入路径由 bootstrap 将 su-ai 拷入 `extensions/`

## 验证

启动后窗口标题/关于页显示 su；用户数据目录为 `.su`（实际路径 `%APPDATA%\su`）。

预期**经典编辑器**主界面：欢迎页大字 **su**、菜单 **文件/帮助**、状态栏 **Su Chat**。  
若出现 Pitch your idea / Sessions / MCP Servers，那是上游 vscode 1.136 的 **Agents/Sessions** 窗口（不是 Cursor）；运行 `scripts/reset-ui-state.ps1` 或确认 `product.overlay.json` 的 `configurationDefaults` 已生效。

## 默认配置（overlay → configurationDefaults）

| 键 | 值 | 目的 |
|----|----|------|
| `chat.disableAIFeatures` | `true` | 关闭微软 Agents/Chat 壳，改用 su-ai |
| `workbench.startupEditor` | `welcomePage` | 启动显示欢迎页 |
| `window.restoreWindows` | `none` | 避免恢复上次的 `agent-sessions.code-workspace` |
