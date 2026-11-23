---
name: su-agent-diff
description: Agent 多文件编辑与 Inline Diff 审阅（v0.4+）。
---

# su-agent-diff

## 状态

已实现于 v0.4；v0.4.1 补齐面板入口与状态栏角标。

## 必读

- `docs/acceptance/v0.4.md` / `docs/acceptance/v0.4.1.md`
- `docs/decisions/ADR-0002-agent-tool-boundary.md`
- `extensions/su-ai/src/agent/*`

## 约定

- 默认工具：工作区内 `list_dir` / `read_file` / `write_file` / `replace_in_file`
- `run_terminal`：需 `su.agent.enableTerminal`，对话区确认（一次/本会话总是/拒绝）
- `ask_user`：抉择关闭=继续不扩展；建议关闭=结束本轮；复杂任务可多次
- 写入进入 `DiffReviewService`；`Su: 审阅 Agent 改动` → Keep / Reject
- Chat：Diff 角标、待审条（Keep All / Reject All / 审阅）；状态栏 `待审 N`
- Chat 面板 **Agent** 模式触发；也可从 **Plan** 点 Build 注入计划后进入 Agent（见 ADR-0002 / v0.6.1）
- Plan 本身不写文件、不跑终端；执行仍走 Keep/Reject 与终端授权
- 支持本轮拖入图片（`image_url` 多模态，需视觉模型）；历史仍存文本摘要
- 不自动提权 / 不写工作区外路径

## 验收

见 `docs/acceptance/v0.4.md`、`v0.4.1.md` Diff 节；Plan→Agent 闭环见 `v0.6.1.md`。
