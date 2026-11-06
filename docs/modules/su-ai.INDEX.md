# su-ai 模块索引

## 职责

内置 AI 扩展：模型配置、LLM 客户端、Chat、Ghost Text、Agent、Inline Diff（按 ROADMAP 分期）；含产品壳级 **检查更新**。

## 入口

| 路径 | 说明 |
|------|------|
| `extensions/su-ai/package.json` | 扩展清单、命令、配置、侧栏 Chat、快捷键 |
| `extensions/su-ai/src/extension.ts` | activate / 审阅命令 / 待审状态栏 |
| `extensions/su-ai/src/openaiClient.ts` | 流式 / 非流式 / tools 调用 |
| `extensions/su-ai/src/chat/chatViewProvider.ts` | Chat + Agent UI（顶栏瘦身 / pills / 空状态 / 代码块） |
| `extensions/su-ai/src/chat/chatSessions.ts` | 多会话存储 / 迁移 |
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

## 当前版本（v0.4.1）

- Chat 容器在**右侧** `secondarySidebar`；启动自动打开
- 顶栏：标题 + Diff 角标 + `+` + 历史 + `⋯`（设置类进溢出菜单）
- 底部：**Ask / Agent** pill、模型下拉（含 Auto）、选区 chip
- 空状态引导；代码块 **复制 / 应用到当前文件**
- Agent 待审：消息区下方 Keep All / Reject All / 审阅；状态栏 `待审 N`
- 快捷键：`Ctrl+L` Chat、`Ctrl+I` Agent、`Esc` 停止（`su.chatStreaming`）
- 产品版本：`0.4.1`
- 验收：[docs/acceptance/v0.4.md](../acceptance/v0.4.md) · [v0.4.1.md](../acceptance/v0.4.1.md)
- 下一版验收稿：[v0.5.md](../acceptance/v0.5.md)

## 禁止

- 硬编码密钥；apiKey 进 settings.json
- 默认无人值守执行危险 shell（见 ADR-0002）

## 相关 Skill

- `su-openai-client` / `su-chat` / `su-ghost-text` / `su-agent-diff`
