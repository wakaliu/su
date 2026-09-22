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
| `extensions/su-ai/src/openaiClient.ts` | OpenAI 兼容流式 + 非流式 `chat/completions` |
| `extensions/su-ai/src/chat/chatViewProvider.ts` | 侧栏 Chat（Ctrl+L） |
| `extensions/su-ai/src/ghostText.ts` | Ghost Text（`InlineCompletionItemProvider`） |
| `extensions/su-ai/src/workbench.ts` | 若误进上游 Agents/Sessions 窗则跳回经典编辑器 |
| `extensions/su-ai/src/update.ts` | GitHub Releases 检查 / 下载提示 |
| `extensions/su-ai/src/version.ts` | 产品版本与 semver 比较 |
| `extensions/su-ai/version.json` | 注入的产品版本戳（源：`branding/version.json`） |

## 当前版本（v0.3）

- Chat（v0.2）：`su.openChat` / Ctrl+L、流式对话、历史、Markdown
- Ghost Text：`InlineCompletionItemProvider`；设置 `su.ghostText.*`；命令 `su.toggleGhostText`
- 共用：`su.baseUrl` + SecretStorage Key + `su.model`（中转）
- 产品版本：`0.3.0`
- 验收：[docs/acceptance/v0.3.md](../acceptance/v0.3.md)

## 禁止

- 在扩展内硬编码密钥
- 将 apiKey 持久化进 settings.json（必须用 SecretStorage）

## 相关 Skill

- `su-openai-client` / `su-chat` / `su-ghost-text`
- `su-agent-diff`（v0.4）
