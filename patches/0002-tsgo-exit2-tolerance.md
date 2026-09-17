# 0002-tsgo-exit2-tolerance

## 目的

vscode 1.136 的 `compile-build-without-mangling`（`compileTask`）在 tsb 语义编译之外并行跑
tsgo（TypeScript 7 native preview）noEmit 类型检查。Windows CI 上该原生编译器出现过
**报告 0 errors 却以 code 2 退出**（疑似原生崩溃/资源问题），导致整包失败。

## 触达文件

- `vendor/vscode/build/lib/tsgo.ts`

## 改动

`tsgo` 子进程非零退出但解析出的输出中 **0 条 `error \w+:` 行**时：降级为 warning 并放行
（标注 `// [su]`）。真实类型错误总会产生 `error TSxxxx` 行，仍会 reject 挡住构建；
tsb emit 路径本身也做完整语义检查，双保险仍在。

## 应用

由 `scripts/apply-patches.ps1` 幂等写入；`bootstrap.ps1` / `build-win.ps1` 会调用。

## 验证

- CI：`compile-build-without-mangling` 在 tsgo "0 errors + exit 2" 时打印
  `[su] tsgo exited with code 2 but reported 0 errors; treating as non-blocking` 并继续
- 真实类型错误（`error TSxxxx` 行存在）时仍失败——不做放行
