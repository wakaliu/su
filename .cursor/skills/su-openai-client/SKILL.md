---
name: su-openai-client
description: OpenAI 兼容客户端与中转配置（v0.2+）。实现或修改 LLM 请求时使用。
---

# su-openai-client

## 状态

v0.2 实现。v0.1 仅有设置占位。

## 必读

- `docs/modules/su-ai.INDEX.md`
- 设置键：`su.baseUrl`、`su.apiKey`、`su.model`、`su.timeoutMs`

## 约定

- 默认路径：`{baseUrl}/chat/completions`（兼容 `/v1` 前缀由用户配置在 baseUrl）
- 流式 SSE；支持 abort
- 密钥 SecretStorage
