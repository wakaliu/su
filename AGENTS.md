# su — Agent 开发总规范

个人 Cursor 类 AI 编辑器（Code-OSS Fork）。**仓库内短事实源优先于对话记忆。**

## 任何改动前必读（按顺序）

1. [ROADMAP.md](ROADMAP.md) — 当前版本边界，禁止跨版本偷做
2. [docs/INDEX.md](docs/INDEX.md) — 文档总目录
3. 相关 [docs/modules/*.INDEX.md](docs/modules/) — 模块地图
4. 对应 [.cursor/skills/*/SKILL.md](.cursor/skills/) — 任务步骤与验收

## 硬性约束

- 产品名：**su**；开发分支：**develop**；平台：Windows x64
- 模型协议：OpenAI 兼容（Base URL / API Key / Model），支持中转
- **禁止**无 patch 直接改 `vendor/vscode`；改动必须进 `patches/` 并带 `// [su]`
- **禁止**提交 API Key、`.env` 密钥；密钥只用 SecretStorage / 本机凭据
- 功能合入必须同步：模块 INDEX、本版 `docs/acceptance/v0.x.md`；重大决策写 ADR
- 发版前加载 Skill：`su-release-gate`

## 仓库边界

| 路径 | 职责 |
|------|------|
| `extensions/su-ai/` | 一等公民 AI 扩展（主业务） |
| `branding/` | 应用名、图标、product overlay |
| `patches/` | 上游最小补丁 |
| `scripts/` | bootstrap / 构建 / 打包 |
| `vendor/vscode/` | 钉死 tag 的上游源码（本地拉取，默认不整库提交） |
| `docs/` | 索引、架构、构建、验收 |
| `.cursor/rules/` | 常驻防跑偏 |
| `.cursor/skills/` | 按任务缩小上下文 |

## 沟通

对用户使用简体中文。涉及 C#/`{ }` 风格、Lua/C# 飞书规范时，仅在写对应语言时遵守；本仓库主语言为 TypeScript。

## Git 推送约定

当前 Agent 环境可能无 GitHub SSH/`gh` 登录。**需要推远程时由维护者本机手动 `git push`**；Agent 负责本地 commit 与说明。
