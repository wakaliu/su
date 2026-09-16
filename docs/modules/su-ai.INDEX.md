# su-ai 模块索引

## 职责

内置 AI 扩展：模型配置、LLM 客户端、Chat、Ghost Text、Agent、Inline Diff（按 ROADMAP 分期）。

## 入口

| 路径 | 说明 |
|------|------|
| `extensions/su-ai/package.json` | 扩展清单、命令、配置贡献点 |
| `extensions/su-ai/src/extension.ts` | activate / deactivate |
| `extensions/su-ai/src/config.ts` | 读取设置（Base URL / Model 等） |

## 当前版本（v0.1）

- 命令：`su.openSettings` — 打开 su 相关设置
- 配置占位：`su.baseUrl`、`su.apiKey`、`su.model`、`su.timeoutMs`
- 尚无真实 LLM 调用（v0.2）

## 禁止

- 在扩展内硬编码密钥
- 绕过 SecretStorage 持久化 apiKey（v0.2 起强制；v0.1 配置可为明文占位并在文档标明风险）

## 相关 Skill

- `su-openai-client`（v0.2）
- `su-chat` / `su-ghost-text` / `su-agent-diff`
