---
name: su-openai-client
description: OpenAI 兼容客户端与中转配置（v0.2+）。实现或修改 LLM 请求时使用。
---

# su-openai-client

## 状态

已实现于 v0.2：`extensions/su-ai/src/openaiClient.ts` + `secrets.ts`。

## 必读

- `docs/modules/su-ai.INDEX.md`
- `docs/acceptance/v0.2.md`
- 设置：`su.baseUrl`、`su.model`、`su.timeoutMs`
- 密钥：SecretStorage（命令 `su.setApiKey`），禁止写入 settings

## 约定

- URL：`{baseUrl}/chat/completions`（用户自行把 `/v1` 写进 baseUrl）
- 流式 SSE（`data:` 行）；`[DONE]` 结束；支持 `AbortSignal`
- 非流式：`completeChat()`（Ghost Text）
- 错误：401/404/429 等转成可读中文提示
- 调用入口：`streamChatCompletion()` / `completeChat()`

## 验收

见 `docs/acceptance/v0.2.md`「配置与密钥」与 Chat 流式条目。
