# ADR-0002：Agent 工具边界（v0.4）

## 状态

已采纳（2026-09-22）

## 背景

v0.4 需要「计划并改代码」能力。若默认自动执行任意 shell，风险过高。

## 决策

1. 默认工具仅限**当前工作区**：`list_dir` / `read_file` / `write_file` / `replace_in_file`
2. `run_terminal` **可选**（`su.agent.enableTerminal`），且**每次命令需用户确认**
3. 写文件变更进入 Pending Diff，用户 **Keep / Reject**（可全部操作）
4. 不做无人值守的联网安装、提权、删除工作区外文件
5. **Ask 模式（v0.5）**可使用只读工具 `list_dir` / `read_file`，并自动注入工作区快照；**不可**写文件或跑终端

## 后果

- 与 Cursor 全自动 Agent 仍有差距；安全性与可审阅性优先
- Ask 可总结/浏览当前打开项目；改代码与 shell 仍走 Agent + 确认
- 后续版本可在 ADR 更新后放宽（例如白名单命令）
