# su 应用图标

小写 **su** 字标：深蓝圆角底，白色 `s` 与薄荷绿 `u`。使用粗笔画和留白，确保缩小到标题栏 16 px 时仍可辨认。

| 路径 | 用途 |
|---|---|
| `master/su.svg` | 唯一设计母版，也是自绘标题栏资源 |
| `master/su-1024.png` / `png/su-*.png` | 导出的 PNG |
| `win32/code.ico` / `su.ico` | 16–256 px 多尺寸 ICO（Windows 应用图标） |
| `win32/code_150x150.png` / `code_70x70.png` | Windows 附加资源 |
| `darwin/code.icns` / `darwin/su-1024.png` | macOS 应用图标及 PNG 母版 |
| `preview/` | 旧版小篆设计存档，不参与构建 |

## 更新图标

母版使用圆角矩形和带圆角描边的折线（导出器支持的 SVG 子集）。修改后，使用已安装 Pillow 的 Python 重新导出并同步提交资源：

```powershell
python .\scripts\export-app-icons.py
```

`apply-branding.ps1` 将打包图标复制到上游平台资源目录；`apply-patches.ps1` 应用 `0004-workbench-icon`，替换工作台自绘标题栏中的图标。已安装的旧包需要重建后替换，既有桌面快捷方式若仍显示旧图，建议重新创建。
