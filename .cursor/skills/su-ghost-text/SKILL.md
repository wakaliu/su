---
name: su-ghost-text
description: Ghost Text 行内补全（v0.3+）。实现 InlineCompletion 时使用。
---

# su-ghost-text

## 状态

已实现于 v0.3：`extensions/su-ai/src/ghostText.ts`。

## 必读

- `docs/acceptance/v0.3.md`
- `docs/modules/su-ai.INDEX.md`
- `su-openai-client`（`completeChat` 非流式）

## 约定

- API：`vscode.languages.registerInlineCompletionItemProvider`
- 触发：停顿输入 → 防抖 `su.ghostText.debounceMs` → 请求中转
- 接受：编辑器默认 **Tab**
- 开关：`su.ghostText.enabled` / 命令 `su.toggleGhostText`
- 模型：与 Chat 相同（`su.baseUrl` / SecretStorage / `su.model`）
- 输出：仅插入文本；去掉 ``` 围栏与前缀回声
- 不做 Agent / 多文件编辑（v0.4）

## 验收

见 `docs/acceptance/v0.3.md`。
