# su ROADMAP

## 当前版本

**进行中：v0.6.1 — Plan 模式（Ask / Plan / Agent）**

v0.6（Agent Window ⇄ IDE）功能已合入，验收见 `docs/acceptance/v0.6.md`（回归项待人工勾选）。  
Plan 见 `docs/acceptance/v0.6.1.md`。

## 版本一览

| 版本 | 目标 | 状态 |
|------|------|------|
| v0.1 | Code-OSS 品牌壳、su-ai 空壳、Windows 打包、防幻觉体系 | 已完成 |
| v0.2 | 模型/中转配置 + Chat 流式主流程 | 已完成 |
| v0.3 | Ghost Text 行内补全 | 已完成（验收见 `docs/acceptance/v0.3.md`） |
| v0.4 | Agent + Inline Diff（Keep/Reject） | 已完成（验收见 `docs/acceptance/v0.4.md`） |
| v0.4.1 | Chat 信息架构 / Diff 入口 / 快捷键抛光 | 已完成（见 `docs/acceptance/v0.4.1.md`） |
| v0.5 | 轻量上下文、Rules、拖图/拖文件、/ Skills、@ | 功能完成（验收见 `docs/acceptance/v0.5.md`） |
| v0.6 | 自研 Agent Window（独立 OS 窗）⇄ IDE Window（非微软 Sessions） | 功能完成（见 `docs/acceptance/v0.6.md`） |
| v0.6.1 | Plan：只读讨论 → 可编辑 Markdown 计划 → Build 交给 Agent；长任务稳定性与过程 UX | 阶段一实现完成，待本地编译/IDE 人工验收（见 `docs/acceptance/v0.6.1.md`） |
| v0.7 | 上下文与代码理解：忽略规则、增量摘要、符号搜索、上下文来源透明 | 规划中 |
| v0.8 | 多文件 Diff、Checkpoint、冲突提示与任务回滚 | 规划中 |
| v0.9 | 后台任务、会话恢复、有限重试 | 规划中 |
| v1.0 | 性能指标、本地诊断与隐私安全观测 | 规划中 |

## 规则

- 当前版本验收通过前，不开始下一版本功能实现
- 每版必须产出 Windows 可安装/便携包，并附 `docs/acceptance/v0.x.md`
- 上游钉死版本见 [docs/upstream.md](docs/upstream.md)
