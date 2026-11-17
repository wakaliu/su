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

## 当前版本（v0.5）

- Chat 右侧栏；拖入**图片**（多模态）/ **文件·文件夹** chip；输入 `/` 选 Skill
- Ask / **Agent** 本轮均可把图片以 `image_url` 发给模型（`agentRunner` 接受 `userContent` + `systemExtras`）；历史存文本摘要
- Skill 来源：工作区 `.cursor/skills`、`.su/skills` + 用户 `~/.cursor/skills`、`~/.cursor/skills-cursor`
- 相关：`chat/attachments.ts`、`chat/skillsCatalog.ts`
- 顶栏瘦身 + Ask/Agent pill + Diff 角标（v0.4.1）
- 快捷键：`Ctrl+L` / `Ctrl+I` / `Esc`
- 验收：[docs/acceptance/v0.5.md](../acceptance/v0.5.md)（Rules / `@` 检索仍可继续补齐）
- 产品版本见 `branding/version.json`

## 禁止

- 硬编码密钥；apiKey 进 settings.json
- 默认无人值守执行危险 shell（见 ADR-0002）

## 相关 Skill

- `su-openai-client` / `su-chat` / `su-ghost-text` / `su-agent-diff`
