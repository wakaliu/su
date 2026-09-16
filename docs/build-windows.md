# Windows 构建指南

## 前置

- Windows 10/11 x64
- Git
- Node.js 20+（推荐与上游一致；当前开发机可用 22）
- Python 3.10+
- Visual Studio 2019/2022 Build Tools（含「使用 C++ 的桌面开发」）
  - **必须**安装对应工具集的 **Spectre 缓解库**（MSVC Spectre-mitigated libs），否则 `@vscode/spdlog` 等原生模块会报 `MSB8040`
- 磁盘：建议 ≥ 30GB 可用
- 若本机原生编译困难：推送 `develop` 后在 GitHub Actions 手动运行 workflow **`build-win`** 出包

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
### 安装 Spectre 缓解库（本机 VS2019）

报错 `MSB8040` 且路径在 `G:\6\VS2019\Community` 时，请安装：

**单个组件（推荐勾这两个）：**

1. `MSVC v142 - VS 2019 C++ x64/x86 Spectre-mitigated libs`（Latest / v14.29）
2. （可选）`C++ ATL for latest v142 build tools with Spectre Mitigations (x86 & x64)`

**图形界面：**

1. 打开 **Visual Studio Installer**
2. 对 **VS 2019 Community** 点「修改」
3. 「单个组件」搜索 `Spectre`
4. 勾选上面两项 → 修改

**管理员 PowerShell（可复制）：**

```powershell
& "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\setup.exe" modify `
  --installPath "G:\6\VS2019\Community" `
  --add Microsoft.VisualStudio.Component.VC.Runtimes.x86.x64.Spectre `
  --add Microsoft.VisualStudio.Component.VC.14.29.16.11.x86.x64.Spectre `
  --passive --norestart
```

装完后确认存在目录：

`G:\6\VS2019\Community\VC\Tools\MSVC\14.29.30133\lib\spectre\x64`

然后在仓库根目录重跑：`.\scripts\build-win.ps1`

### 用 GitHub Actions 出 Windows 验收包（推荐）

本机若遇 Spectre / `delayimp.lib` / GitHub API 403（ripgrep）等问题，改用 CI：

1. **推送**本地 `develop` 全部提交：`git push origin develop`
2. 打开仓库 Actions：https://github.com/wakaliu/su/actions
3. 左侧选择 workflow **`build-win`**
4. 点 **Run workflow** → Branch 选 **`develop`** → Run
5. 等待结束（常要 1–3 小时，`windows-latest` 工具链较全）
6. 打开该次 run → **Artifacts** → 下载 **`su-win32-x64`**
7. 解压后按 [acceptance/v0.1.md](acceptance/v0.1.md) 验收

若 Actions 未出现 workflow：确认 `.github/workflows/build-win.yml` 已在 `develop`，并启用仓库 Actions 权限。

| Actions 上 node-gyp 找不到 VS | workflow 已用 `ilammy/msvc-dev-cmd`；`build-win.ps1` 用 vswhere 导入 vcvars（含 VS 18） |
| GitHub API 403 ripgrep | Actions 已注入 `GITHUB_TOKEN`；本机可设 PAT 到 `GITHUB_TOKEN` |
