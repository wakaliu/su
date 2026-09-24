# su-ai 模块索引

## 职责

内置 AI 扩展：模型配置、LLM 客户端、Chat、Ghost Text、Agent、Inline Diff（按 ROADMAP 分期）；含产品壳级 **检查更新**。

## 入口

| 路径 | 说明 |
|------|------|
| `extensions/su-ai/package.json` | 扩展清单、命令、配置、侧栏 Chat |
| `extensions/su-ai/src/extension.ts` | activate / 审阅命令 |
| `extensions/su-ai/src/openaiClient.ts` | 流式 / 非流式 / tools 调用 |
| `extensions/su-ai/src/chat/chatViewProvider.ts` | Chat + Agent 模式 UI |
| `extensions/su-ai/src/ghostText.ts` | Ghost Text |
| `extensions/su-ai/src/agent/agentRunner.ts` | Agent 工具循环 |
| `extensions/su-ai/src/agent/tools.ts` | 工作区工具（+ 确认后终端） |
| `extensions/su-ai/src/agent/diffReview.ts` | Keep / Reject |
| `extensions/su-ai/src/workbench.ts` | Sessions 窗跳回经典编辑器 |
| `extensions/su-ai/src/config.ts` | 配置 / 多模型目录 / Auto 解析 |
| `extensions/su-ai/src/modelsUi.ts` | 编辑模型列表命令 UI |
| `extensions/su-ai/media/USER_GUIDE.md` | 用户手册（帮助菜单打开） |
| `extensions/su-ai/src/userGuide.ts` | 打开用户手册预览 |
| `extensions/su-ai/src/update.ts` / `version.ts` / `secrets.ts` | 更新 / 版本 / 密钥 |

## 当前版本（v0.4）

- Chat / Ghost（v0.2–v0.3）仍可用；Chat 容器在**右侧** `secondarySidebar`（对齐 Cursor）
- Chat / Agent 可切换已配置模型（`su.model` + `su.models`），支持 **Auto**（= 默认 `su.model`）
- 帮助菜单：**用户手册**（内置 `media/USER_GUIDE.md` 预览）
- Agent：Chat 面板切换 Agent；工具读写工作区；可选确认后 `run_terminal`
- Diff：`Su: 审阅 Agent 改动` / Keep All / Reject All
- 边界：ADR-0002
- 产品版本：`0.4.0`
- 验收：[docs/acceptance/v0.4.md](../acceptance/v0.4.md)

## 禁止

- 硬编码密钥；apiKey 进 settings.json
- 默认无人值守执行危险 shell（见 ADR-0002）

## 相关 Skill

- `su-openai-client` / `su-chat` / `su-ghost-text` / `su-agent-diff`
