# 0001-skip-copilot-shim

## 目的

vscode 1.136 的 `vscode-*-ci` 打包尾声会调用 `prepareBuiltInCopilotRipgrepShim`。
若未执行 `compile-copilot-extension-build`（OSS / su 故意跳过微软 Copilot），该函数对缺失的
`extensions/copilot` SDK **直接 throw**，导致整包失败。

## 触达文件

- `vendor/vscode/build/lib/copilot.ts`

## 改动

当 `copilotSdkBase` 不存在时：**跳过并 return**（标注 `// [su]`），不再 throw。

## 应用

由 `scripts/apply-patches.ps1` 幂等写入；`bootstrap.ps1` / `build-win.ps1` 会调用。

## 验证

- CI / 本机：`gulp vscode-win32-x64-ci` 在跳过 Copilot 时不再因 shim 失败
- 产物中无内置 Copilot 属预期（su-ai 另注入）
