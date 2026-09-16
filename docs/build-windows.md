# Windows 构建指南

## 前置

- Windows 10/11 x64
- Git
- Node.js 20+（推荐与上游一致；当前开发机可用 22）
- Python 3.10+
- Visual Studio 2022 Build Tools（含「使用 C++ 的桌面开发」）
- 磁盘：建议 ≥ 30GB 可用

## 快速体验（开发态，不全量打包）

```powershell
.\scripts\bootstrap.ps1   # 若尚未拉取上游
.\scripts\run-dev.ps1     # compile 后启动 Electron 开发壳（标题应为 su）
```

在已启动的 su 中：命令面板 → `Su: Open Settings`，确认 `su.*` 配置项。

## 一键完整打包流程

```powershell
# 1. 拉取上游并应用 branding / 注入扩展
.\scripts\bootstrap.ps1

# 2. 安装依赖并编译（耗时长）
.\scripts\build-win.ps1

# 3. 打包 zip（便携包）
.\scripts\package-win.ps1
```

产物目录：`out/win32-x64/`；zip：`out/su-win32-x64-*.zip`。
GitHub Actions：workflow `build-win`（手动或 push develop）。

## 仅验证扩展（不全量编 IDE）

```powershell
cd extensions\su-ai
npm install
npm run compile
# 用 VS Code / 已构建的 su 以 --extensionDevelopmentPath 加载（见 su-bootstrap Skill）
```

## 常见失败

| 现象 | 处理 |
|------|------|
| 缺少 link.exe / MSVC | 安装 VS Build Tools C++ 工作负载 |
| node-gyp / native 模块失败 | 确认 Python、Windows SDK |
| 内存不足 | 关闭其它应用；勿并行多个完整构建 |
| vendor 为空 | 先跑 `bootstrap.ps1` |
| PowerShell 因 npm warn 中断 | 已用 `Invoke-Native` 忽略 stderr 警告；请拉取最新 `scripts/*.ps1` |
| Agent 环境无 GitHub SSH | 由你本机手动 `git push`（约定） |
