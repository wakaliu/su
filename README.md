# su

个人使用的 Cursor 类 AI 代码编辑器（Code-OSS 二次开发）。

- 自定义 OpenAI 兼容模型与中转
- 开发分支：`develop`
- 当前版本：见 [ROADMAP.md](ROADMAP.md)
- Agent 规范入口：[AGENTS.md](AGENTS.md)
- 文档索引：[docs/INDEX.md](docs/INDEX.md)

## 快速开始（开发）

```powershell
.\scripts\bootstrap.ps1
cd extensions\su-ai
npm install
npm run compile
```

完整 Windows IDE 构建见 [docs/build-windows.md](docs/build-windows.md)。

## 许可

本仓库 Apache-2.0；上游 `vendor/vscode` 为 MIT（Code-OSS）。
