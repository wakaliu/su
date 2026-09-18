# branding 模块索引

## 职责

将 Code-OSS 重塑为产品 **su**：应用名、数据目录名、图标、product overlay。

## 文件

| 路径 | 说明 |
|------|------|
| `branding/product.overlay.json` | 合并进上游 `product.json` 的字段 |
| `branding/version.json` | 产品版本 + GitHub 仓库（供更新检查） |
| `branding/icons/` | 应用图标（小篆「溯」黑底蓝绿；见 `icons/README.md`） |
| `scripts/apply-branding.ps1` | 合并 overlay、复制 win32 图标 |
| `scripts/export-app-icons.py` | 从确认母版导出 PNG/ICO 套件 |
| `scripts/inject-extension.ps1` | 注入 su-ai 并写入 `version.json` |

## 关键字段（overlay）

- `nameShort` / `nameLong` / `applicationName` → su
- `dataFolderName` → `.su`
- `win32MutexName` 等 Windows 标识避免与 Code 冲突
- `extensionsGallery` → Open VSX（若启用市场）
- `builtInExtensions` / 注入路径由 bootstrap 将 su-ai 拷入 `extensions/`

## 验证

启动后窗口标题/关于页显示 su；用户数据目录为 `.su`。
