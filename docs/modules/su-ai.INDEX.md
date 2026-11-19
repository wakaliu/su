# su-ai 模块索引

## 职责

内置 AI 扩展：模型配置、LLM 客户端、Chat、Ghost Text、Agent、Inline Diff（按 ROADMAP 分期）；含产品壳级 **检查更新**；v0.6 起支持 **Agent Window ⇄ IDE**。

## 入口

| 路径 | 说明 |
|------|------|
| `extensions/su-ai/package.json` | 扩展清单、命令、配置、侧栏 Chat、快捷键 |
| `extensions/su-ai/src/extension.ts` | activate / 审阅命令 / 待审状态栏 / Agent Window 入口 |
| `extensions/su-ai/src/openaiClient.ts` | 流式 / 非流式 / tools 调用 |
| `extensions/su-ai/src/chat/chatViewProvider.ts` | Chat + Agent UI；IDE 侧栏与 Agent Window 共用消息/会话 |
| `extensions/su-ai/src/chat/replyMarkdown.ts` | 答复 Markdown（标题/表格/列表/图片）渲染；注入 Webview；Chat 灯箱放大 |
| `extensions/su-ai/src/chat/chatCore.ts` | 共享核心再导出（Ask/Agent runners、附件、Rules、@） |
| `extensions/su-ai/src/chat/chatSessions.ts` | 多会话存储 / 迁移 |
| `extensions/su-ai/src/chat/askRunner.ts` | Ask 只读 list_dir / read_file 循环 |
| `extensions/su-ai/src/chat/workspaceContext.ts` | 工作区快照（目录 / README / git） |
| `extensions/su-ai/src/chat/rulesCatalog.ts` | `.su/rules` 注入 |
| `extensions/su-ai/src/chat/atMentions.ts` | `@` 引用候选 |
| `extensions/su-ai/src/ghostText.ts` | Ghost Text |
| `extensions/su-ai/src/agent/agentRunner.ts` | Agent 工具循环 |
| `extensions/su-ai/src/agent/tools.ts` | 工作区工具；终端对话区授权（一次/本会话总是/拒绝） |
| `extensions/su-ai/src/agent/diffReview.ts` | Keep / Reject |
| `extensions/su-ai/src/workbench.ts` | Sessions 窗跳回经典编辑器 |
| `extensions/su-ai/src/config.ts` | 配置 / 多模型目录 / Auto 解析 |
| `extensions/su-ai/src/modelsUi.ts` | 编辑模型列表命令 UI |
| `extensions/su-ai/media/USER_GUIDE.md` | 用户手册（帮助菜单打开） |
| `extensions/su-ai/src/userGuide.ts` | 打开用户手册预览 |
| `extensions/su-ai/src/update.ts` / `version.ts` / `secrets.ts` | 更新 / 版本 / 密钥 |

## 当前版本（v0.6）

- **IDE Window**：经典编辑器 + 右侧 Su Chat（现状）
- **Agent Window**：独立 OS 窗口（`su.openAgentWindow` → `moveEditorToNewWindow`）；顶栏「IDE ↗」切回；与侧栏共用会话/工作区
- 换项目：`su.openFolderNewWindow` / `su.openFolderCurrentWindow`（Chat ⋯ 菜单）；无文件夹可纯聊天
- 入口：Chat 顶栏「Agent ↗」、状态栏、命令面板、帮助菜单 Su
- v0.5 能力保留：拖图/文件、/ Skills、@、Rules、工作区快照、Ask 只读工具
- Agent：**处理过程**进度默认展开；终端在对话区授权（允许一次 / 本会话总是允许 / 拒绝），不再弹系统模态框
- 验收：[docs/acceptance/v0.6.md](../acceptance/v0.6.md)；v0.5 见 [v0.5.md](../acceptance/v0.5.md)
- 产品版本见 `branding/version.json`

## 禁止

- 硬编码密钥；apiKey 进 settings.json
- 默认无人值守执行危险 shell（见 ADR-0002）
- 用上游 `agent-sessions` / Pitch your idea 冒充 Agent Window

## 相关 Skill

- `su-openai-client` / `su-chat` / `su-ghost-text` / `su-agent-diff`
