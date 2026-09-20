# su-ai 模块索引

## 职责

内置 AI 扩展：模型配置、LLM 客户端、Chat、Ghost Text、Agent、Inline Diff（按 ROADMAP 分期）；含产品壳级 **检查更新**。

## 入口

| 路径 | 说明 |
|------|------|
| `extensions/su-ai/package.json` | 扩展清单、命令、配置、侧栏 Chat webview |
| `extensions/su-ai/src/extension.ts` | activate / deactivate |
| `extensions/su-ai/src/config.ts` | 非密钥设置（Base URL / Model / timeout） |
| `extensions/su-ai/src/secrets.ts` | API Key ↔ SecretStorage（含 v0.1 明文迁移） |
| `extensions/su-ai/src/openaiClient.ts` | OpenAI 兼容 `chat/completions` SSE 流式客户端 |
| `extensions/su-ai/src/chat/chatViewProvider.ts` | 侧栏 Chat（Ctrl+L） |
| `extensions/su-ai/src/update.ts` | GitHub Releases 检查 / 下载提示 |
| `extensions/su-ai/src/version.ts` | 产品版本与 semver 比较 |
| `extensions/su-ai/version.json` | 注入的产品版本戳（源：`branding/version.json`） |

## 当前版本（v0.2）

- 命令：`su.openChat`（`Ctrl+L` / `Cmd+L`）— 打开侧栏 Chat
- 命令：`su.openSettings` — 打开中转/模型设置（`@ext:su.su-ai`）
- 命令：`su.setApiKey` / `su.clearApiKey` — SecretStorage 读写密钥
- 命令：`su.checkForUpdates` — 检查 GitHub Releases
- 侧栏活动栏 **Su AI → Chat**：流式对话、停止、可选附带编辑器选区
- 配置：`su.baseUrl` / `su.model` / `su.timeoutMs`（`su.apiKey` 设置项已弃用，仅迁移用）
- 更新配置：`su.update.*`
- 产品版本：`0.2.0`
- 说明：[docs/updates.md](../updates.md) · 验收：[docs/acceptance/v0.2.md](../acceptance/v0.2.md)

## 禁止

- 在扩展内硬编码密钥
- 将 apiKey 持久化进 settings.json（必须用 SecretStorage）

## 相关 Skill

- `su-openai-client` / `su-chat`
- `su-ghost-text`（v0.3）/ `su-agent-diff`（v0.4）
