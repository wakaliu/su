---
name: su-release-gate
description: 发版/推送验收前检查索引与清单是否与代码一致。在合并 develop、打 tag、请用户验收前使用。
---

# su-release-gate

## 检查清单

1. `ROADMAP.md` 当前版本与本次交付一致
2. `docs/INDEX.md` 链接有效
3. 本版 `docs/acceptance/v0.x.md` 条目覆盖本次功能
4. 变更触及的 `docs/modules/*.INDEX.md` 已更新
5. 若有 patches，`patches.INDEX.md` 有登记
6. 无密钥文件进入提交
7. `docs/upstream.md` tag 与 `vendor`（若本地有）一致

## 输出

向用户给出：通过 / 不通过；不通过项列出路径。
