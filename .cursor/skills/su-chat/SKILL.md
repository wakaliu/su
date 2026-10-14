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

- 快捷键：`Ctrl+L` / `Cmd+L` → `su.openChat`（右侧辅助栏）
- 视图容器：`secondarySidebar` → `su-ai` → view `su.chat`
- 消息协议：webview `send`/`stop`/`setApiKey`/`openSettings` ↔ 扩展流式 `assistantDelta`
- 可选上下文：勾选「附带当前选区」
- 模型：页脚下拉 **Auto**（=`su.model`）或 `su.models` 中的 id；选择写入 workspaceState
- 历史：**多会话**（workspaceState）；`+` 新建、历史面板切换/删除；旧单线程自动迁移
- 模式：底部 **Ask | Agent** 下拉（不再用顶部分段按钮）
- 流式结束后 Markdown 渲染（先 HTML escape）

## 验收

见 `docs/acceptance/v0.2.md`「Chat 流式主流程」。
