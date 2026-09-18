# su 应用图标

确认稿：**A2**（圆角黑底 + 蓝绿小篆「溯」），主字形再放大。

## 目录

| 路径 | 说明 |
|------|------|
| `preview/` | 设计确认稿（v1a / v1b / v1a2 / final-master） |
| `master/su-1024.png` | 导出母版 1024²（圆角透明） |
| `png/su-{16..1024}.png` | 多尺寸 PNG |
| `win32/code.ico` | Windows 打包主图标（多尺寸 ICO） |
| `win32/code_150x150.png` / `code_70x70.png` | Win32 资源附加图 |
| `su.ico` | 同主图标副本，便于文档引用 |

## 重新导出

修改确认母版后：

```powershell
# 将确认图覆盖到 preview/su-icon-final-master.png 后执行
python .\scripts\export-app-icons.py
```

`scripts/apply-branding.ps1` 会在存在 `vendor/vscode/resources/win32` 时自动覆盖 `code.ico` 等。

## 设计约定

- 背景：黑
- 字形：说文风格小篆「溯」
- 字色：蓝绿（teal，约 `#14B8A6`）
- 外形：圆角方标（squircle）
