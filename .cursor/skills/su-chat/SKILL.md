---
name: su-chat
description: Chat 面板与上下文（v0.2+）。实现 Chat UI/命令、拖图拖文件、/ Skills 时使用。
---

# su-chat

## 状态

v0.2 起侧栏 Webview `su.chat`；v0.5 拖图/文件、/ Skills、Rules、@；v0.6 Agent Window ⇄ IDE。

## 必读

- `su-openai-client` Skill
- `docs/acceptance/v0.5.md` / `docs/acceptance/v0.6.md`
- `extensions/su-ai/src/chat/chatViewProvider.ts` / `chatCore.ts`

## 约定

- 快捷键：`Ctrl+L` → `su.openChat`；`Ctrl+I` → `su.focusAgent`；`Esc` → `su.stopGeneration`
- `su.openAgentWindow` / `su.openIdeWindow`：对话大窗 ⇄ 经典 IDE（共用会话；非微软 Sessions）
- 拖入图片 → 多模态 `image_url`；拖入文件 → 文本上下文；侧栏/标签需 **Shift** 或右键 `su.addToChat`
- `/` Skills；`@` 文件/选区；`.su/rules` + `su.rules.enabled`
- 工作区快照注入；Ask 只读 list/read；Agent 终端确认

## 验收

见 `docs/acceptance/v0.5.md` 与 `v0.6.md`。
