# 架构

## 一句话

su = **钉死 tag 的 microsoft/vscode（Code-OSS）** + **branding overlay** + **内置扩展 su-ai** + **最小 patches**。

## 分层

```
┌─────────────────────────────────────┐
│  branding（产品名/图标/product.json） │
├─────────────────────────────────────┤
│  extensions/su-ai（Chat/补全/Agent） │
├─────────────────────────────────────┤
│  patches（仅 API 不够时的 core 补丁） │
├─────────────────────────────────────┤
│  vendor/vscode（上游，勿无补丁直改）  │
└─────────────────────────────────────┘
```

## 设计原则

1. **业务优先写在 su-ai**：设置、LLM 客户端、Chat、Ghost Text、Agent、Diff 审阅
2. **product.json 开启**内置扩展与必要 proposed API
3. **patches 最小**：每个补丁在 `patches.INDEX.md` 有目的与验证方式
4. Ghost Text / Diff 优先用上游已有能力；C++ 渲染改动不在 v0.1–v0.4 范围

## 与 Cursor 的差异（产品）

- 可配置任意 OpenAI 兼容端点与中转
- 个人使用，无会员模型墙
- 不依赖微软 Copilot 专有代码
