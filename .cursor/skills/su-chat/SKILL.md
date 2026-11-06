---
name: su-chat
description: Chat 面板与上下文（v0.2+）。实现 Chat UI/命令时使用。
---

# su-chat

## 状态

已实现于 v0.2，并在 v0.4.1 抛光信息架构。侧栏 Webview `su.chat`（`ChatViewProvider`）。

## 必读

- `su-openai-client` Skill
- `docs/acceptance/v0.2.md` / `docs/acceptance/v0.4.1.md`
- `extensions/su-ai/src/chat/chatViewProvider.ts`

## 约定

- 快捷键：`Ctrl+L` → `su.openChat`；`Ctrl+I` → `su.focusAgent`；`Esc` → `su.stopGeneration`（when `su.chatStreaming`）
- 视图容器：`secondarySidebar` → `su-ai` → view `su.chat`
- 顶栏：标题 + Diff 角标 + 新对话 + 历史 + 三点菜单（模型列表 / Key / 中转 / 手册）
- 底部：**Ask | Agent** pill + 模型下拉（Auto / `su.models`）+ 选区 chip
- 空状态：配 Key / 发对话 / 切 Agent / 手册
- 代码块：复制、应用到当前编辑器（选区替换或插入）
- 消息协议：webview `send`/`stop`/`applyCode`/`keepAllDiffs` 等 ↔ 扩展流式 `assistantDelta`
- 历史：多会话（workspaceState）；流式结束后 Markdown 渲染

## 验收

见 `docs/acceptance/v0.4.1.md`。
