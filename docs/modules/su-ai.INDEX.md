# su-ai 模块索引

## 职责

内置 AI 扩展：模型配置、LLM 客户端、Chat、Ghost Text、Agent、Inline Diff（按 ROADMAP 分期）；v0.1 含产品壳级 **检查更新**。

## 入口

| 路径 | 说明 |
|------|------|
| `extensions/su-ai/package.json` | 扩展清单、命令、配置贡献点 |
| `extensions/su-ai/src/extension.ts` | activate / deactivate |
| `extensions/su-ai/src/config.ts` | 读取设置（Base URL / Model 等） |
| `extensions/su-ai/src/update.ts` | GitHub Releases 检查 / 下载提示 |
| `extensions/su-ai/src/version.ts` | 产品版本与 semver 比较 |
| `extensions/su-ai/version.json` | 注入的产品版本戳（源：`branding/version.json`） |

## 当前版本（v0.1）

- 命令：`su.openSettings` — 打开 Su AI 设置（过滤 `@ext:su.su-ai`）
- 命令：`su.checkForUpdates` — 检查 GitHub Releases 新版本并提示下载
- 入口：左侧活动栏 **Su AI**、状态栏 **Su AI**、菜单 **帮助 → Su**
- 启动后约 8s 自动检查更新（`su.update.checkOnStartup`，可关）
- 配置占位：`su.baseUrl`、`su.apiKey`、`su.model`、`su.timeoutMs`
- 更新配置：`su.update.checkOnStartup` / `su.update.repo` / `su.update.includePrerelease`
- 尚无真实 LLM 调用（v0.2）
- 资源：`media/su.svg`（活动栏图标）
- 说明文档：[docs/updates.md](../updates.md)

## 禁止

- 在扩展内硬编码密钥
- 绕过 SecretStorage 持久化 apiKey（v0.2 起强制；v0.1 配置可为明文占位并在文档标明风险）

## 相关 Skill

- `su-openai-client`（v0.2）
- `su-chat` / `su-ghost-text` / `su-agent-diff`
