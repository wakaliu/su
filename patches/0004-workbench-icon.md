# 0004-workbench-icon

<!-- [su] Workbench asset replacement -->

Windows 自绘标题栏左上角使用 `src/vs/workbench/browser/media/code-icon.svg`，不读取打包的 `code.ico`。
`scripts/apply-patches.ps1` 幂等地用 `branding/icons/master/su.svg` 替换这个资源。
复用现有标题栏节点和样式，不改变窗口菜单、拖拽区或全屏隐藏行为。

构建或 `run-dev.ps1` 后确认自绘标题栏左上角为小写 `su`。Windows 原生标题栏及桌面图标由应用程序图标资源负责。
