---
name: su-chat
description: Chat 面板与上下文（v0.2+）。实现 Chat UI/命令时使用。
---

# su-chat

## 状态

已实现于 v0.2：侧栏 Webview `su.chat`（`ChatViewProvider`）。

## 必读

- `su-openai-client` Skill
- `docs/acceptance/v0.2.md`
- `extensions/su-ai/src/chat/chatViewProvider.ts`

## 约定

- 快捷键：`Ctrl+L` / `Cmd+L` → `su.openChat`（`!terminalFocus`）
- 活动栏容器 `su-ai` → view `su.chat`
- 消息协议：webview `send`/`stop`/`setApiKey`/`openSettings` ↔ 扩展流式 `assistantDelta`
- 可选上下文：勾选「附带当前选区」
- 历史：workspaceState 持久化；「新对话」清空
- 流式结束后 Markdown 渲染（先 HTML escape）
- 不做 Agent / 多文件 Diff（v0.4）

## 验收

见 `docs/acceptance/v0.2.md`「Chat 流式主流程」。
