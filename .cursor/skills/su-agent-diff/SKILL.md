---
name: su-agent-diff
description: Agent 多文件编辑与 Inline Diff 审阅（v0.4+）。
---

# su-agent-diff

## 状态

已实现于 v0.4（MVP）。

## 必读

- `docs/acceptance/v0.4.md`
- `docs/decisions/ADR-0002-agent-tool-boundary.md`
- `extensions/su-ai/src/agent/*`

## 约定

- 默认工具：工作区内 `list_dir` / `read_file` / `write_file` / `replace_in_file`
- `run_terminal`：需 `su.agent.enableTerminal`，且每次 UI 确认
- 写入进入 `DiffReviewService`；`Su: 审阅 Agent 改动` → Keep / Reject
- Chat 面板 **Agent** 模式触发；中转与 Chat 共用
- 不自动提权 / 不写工作区外路径

## 验收

见 `docs/acceptance/v0.4.md`。
