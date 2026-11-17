---
name: su-chat
description: Chat 面板与上下文（v0.2+）。实现 Chat UI/命令、拖图拖文件、/ Skills 时使用。
---

# su-chat

## 状态

v0.2 起侧栏 Webview `su.chat`；v0.4.1 抛光信息架构；v0.5 增加拖图/拖文件引用与 `/` Skills。

## 必读

- `su-openai-client` Skill
- `docs/acceptance/v0.5.md`
- `extensions/su-ai/src/chat/chatViewProvider.ts`
- `extensions/su-ai/src/chat/attachments.ts`
- `extensions/su-ai/src/chat/skillsCatalog.ts`

## 约定

- 快捷键：`Ctrl+L` → `su.openChat`；`Ctrl+I` → `su.focusAgent`；`Esc` → `su.stopGeneration`
- 拖入图片 → 多模态 `image_url`（Ask / Agent）；拖入文件/文件夹 → 文本上下文
- `/` → 扫描工作区 `.cursor/skills`、`.su/skills` 与用户 `~/.cursor/skills`、`~/.cursor/skills-cursor`
- 底部 Ask/Agent pill + 模型下拉 + 选区 chip
- Ask / Agent 本轮均可把拖入图片以 `image_url` 发给模型（需视觉模型）；会话历史仍存 `[图片: name]` 摘要

## 验收

见 `docs/acceptance/v0.5.md` 输入区三节。
