# 0003-menubar-help

## 目的

vscode 1.136 的扩展菜单白名单（`apiMenus`）不再包含 `MenubarHelpMenu` / `MenubarPreferencesMenu`。
`package.json` 里写了帮助菜单项也会被直接跳过，所以「用户手册」不会出现。

## 触达文件

- `vendor/vscode/src/vs/workbench/services/actions/common/menusExtensionPoint.ts`

## 改动

把这两个菜单 id 加回白名单（标注 `// [su]`），使 `su-ai` 的「帮助 → 用户手册」生效。

## 应用

由 `scripts/apply-patches.ps1` 幂等写入。已安装的包还需重编 workbench，或热补 `workbench.desktop.main.js` 后完全退出再开。
