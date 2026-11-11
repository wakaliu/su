# darwin 图标

将 `code.icns` 放在本目录后，`scripts/apply-branding.ps1` 会覆盖上游 `resources/darwin/code.icns`。

生成方式（需 macOS）：

```bash
python3 ./scripts/export-app-icons.py
# 或由 ./scripts/build-mac.ps1 在缺失时用 sips + iconutil 从 png 生成
```
