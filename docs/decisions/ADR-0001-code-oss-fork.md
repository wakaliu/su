# ADR-0001：采用 Code-OSS + branding + 内置扩展

## 状态

已采纳（2026-09-16）

## 背景

需要个人可用的 Cursor 类编辑器，支持自定义 OpenAI 兼容模型与中转；仓库从空仓库起步。

## 决策

1. Fork/二次开发基于 **microsoft/vscode tag 1.136.1**，非纯 Marketplace 插件产品形态
2. AI 能力放在内置扩展 **su-ai**，品牌用 **branding overlay**
3. 核心渲染优先复用上游 Inline Completions / Diff，不首版改 C++

## 后果

- 构建重、需 Windows 原生工具链
- 可通过扩展快速迭代 Chat/Agent
- 上游升级需受控 rebase
