# 上游钉死版本

| 项 | 值 |
|----|-----|
| 仓库 | https://github.com/microsoft/vscode |
| Tag | **1.136.1** |
| 许可证 | MIT（Code-OSS） |
| 拉取目录 | `vendor/vscode/` |
| 拉取方式 | `scripts/bootstrap.ps1`（shallow clone + checkout tag） |

## Proposed API（随版本追加）

v0.1：无（空壳扩展不依赖 proposed）。

后续在启用时登记：扩展 ID、proposal 名、用途、验证命令。

## Rebase 注意

1. 只升 tag，不跟 main 漂
2. 升 tag 后重放 `patches/`，冲突解决后更新 `patches.INDEX.md`
3. 同步检查 `branding/product.overlay.json` 字段是否仍被上游识别
4. 记录 ADR：为何升版本
