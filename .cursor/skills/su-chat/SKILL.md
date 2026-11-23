---
name: su-chat
description: Chat 面板与上下文（v0.2+）。实现 Chat UI/命令、拖图拖文件、/ Skills 时使用。
---

# su-chat

## 状态

v0.2 起侧栏 Webview `su.chat`；v0.5 拖图/文件、/ Skills、Rules、@；v0.6 Agent Window ⇄ IDE；v0.6.1 Plan 模式。

## 必读

- `su-openai-client` Skill
- `docs/acceptance/v0.5.md` / `docs/acceptance/v0.6.md` / `docs/acceptance/v0.6.1.md`
- `extensions/su-ai/src/chat/chatViewProvider.ts` / `chatCore.ts` / `plan.ts` / `planRunner.ts`

## 约定

- 快捷键：`Ctrl+L` → `su.openChat`；`Ctrl+I` → `su.focusAgent`；`Esc` → `su.stopGeneration`
- `su.openAgentWindow` / `su.openIdeWindow`：独立 OS 对话窗 ⇄ 经典 IDE（共用会话；非微软 Sessions）
- `su.openFolderNewWindow` / `su.openFolderCurrentWindow`：换项目；无工作区可纯聊
- pill：**Ask | Plan | Agent**（`ChatMode` = `chat` \| `plan` \| `agent`）；会话可存 `planDraft`
- Plan：只读 list/read；`<su-plan>` 解析后亮计划卡；**View** → `.su/plans/*.plan.md` 编辑器打开（保存回写）；**Build** → `setMode('agent')` + Agent 执行；未 Build 不改业务代码
- 拖入图片 → 多模态 `image_url`；拖入文件 → 文本上下文；侧栏/标签需 **Shift** 或右键 `su.addToChat`
- 图片点击灯箱放大（composer / 用户消息 / Markdown `![]()`）；Esc 关闭
- `/` Skills；`@` 文件/选区；`.su/rules` + `su.rules.enabled`
- 工作区快照注入；Ask/Plan 只读 list/read；Agent 终端对话区授权；`ask_user` 反馈卡（可多次）；工具进度可见
- 答复格式：`replyMarkdown.ts` 渲染标题/GFM 表格；Ask/Plan/Agent 共用 `SU_REPLY_FORMAT_HINT`（结构化 + 分区 emoji 如 🔬🗺️⚠️▶️，优化时勿去掉）

## 验收

见 `docs/acceptance/v0.5.md`、`v0.6.md`、`v0.6.1.md`。
