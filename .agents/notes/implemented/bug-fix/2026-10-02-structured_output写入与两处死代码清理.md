---
Status: implemented
Date: 2026-10-02
---
# `--json-schema` 的校验载荷写进 `result.structured_output`；删 `cleanupIDEDiffTabs`；改 LSP 操作数注释（B26）

## 决定了什么

1. **`structured_output` 接线**：`sdk/schemas.ts` 早就给 `result` 定义了这个字段，全仓却没有一处写它，
   于是 StructuredOutput 工具校验通过的载荷在收尾时被丢掉，官网 `extend/headless.md` 只能写成「坑二：拿不到」。
   - `SDKQueryEngineDriver` 加可选的 `getStructuredOutput()`；`finalizeResult` 只在 `success` 上、且值非 undefined 时写字段。
   - `app.ts` 记住 `--json-schema` 注册的那个工具实例，`-p --output-format json` 与 stream-json 两条路径读同一个 `capturedStructuredOutput()`。
   - 取的是工具里**最后一次校验通过**的载荷，被打回重试的输入不会混进来。
2. **删 `cleanupIDEDiffTabs`**（`ide/tool-hooks.ts`）：生产零调用方，注释却说「主循环 end_turn / abort 时调用」。
   B23 已裁决不做 IDE 扩展，所以删函数，`extend/ide.md` 那句「残留 diff 标签页自动清理」一并删（D88）。
3. `cli.ts` 注释「9 操作」改为 10（`tool/lsp.ts` 的 `LSP_OPERATIONS` 已含 `codeAction`）。
4. `extend/headless.md` 坑二改写成用法：「从 `structured_output` 取」（D92）。

## 放弃了什么（以及为什么不选）

- **把 `cleanupIDEDiffTabs` 接进主循环而不是删**：没有扩展端，接上也只是对一个不存在的 IDE RPC 发请求，
  等于把死代码变成「有调用、零效果」的假接线，更难发现。
- **错误结果也带 `structured_output`**：错误 schema 没有这个字段，而且失败时手里只有一份可能来自中途的载荷，
  让它冒充结果会给消费者错误信号。没捕获到就**不写字段**（不写 null / {}），与 `permission_denials` 同一约定。
- **在 SDK 引擎里自己从消息历史里捞 StructuredOutput 的 tool_use 入参**：那拿到的是未经校验的输入，
  恰好是文档原先教用户的做法，也是要消灭的那个坑；校验结果只在工具实例里有。

## 拿什么证明它生效了

- 单测 `packages/core/tests/sdk/e2e.test.ts`「B26：…」：有载荷时 `result.structured_output` 等于载荷且过 `SDKMessageSchema()`；
  无载荷时字段不出现。**变异自证**：删掉 `finalizeResult` 里那一行展开，该测试变红（1 fail），恢复后转绿。
- 编译产物端到端（worktree 内 `make build` 的二进制，GLM-5.2）：
  - `-p … --json-schema schema.json --output-format json --max-turns 4` → `structured_output = {"language":"TypeScript","functionCount":2}`
  - 同上 `--output-format stream-json --verbose` → 末条 result `{"subtype":"success","num_turns":3,"structured_output":{"functionCount":2,"language":"TypeScript"}}`
- `bun run affected-tests:run` 2019 pass / 0 fail；`make build` 自检通过且无 `will always be undefined`。

**顺带发现（不在本次范围，未修）**：第一次端到端不带 `--max-turns`，模型在 StructuredOutput 已返回成功后
又连续调了它 99 次同参（`trace-digest 20261002-212543-660c152b`：`observation_entropy_zero run=99`，
102 次 API、$1.06），最后被手动停掉。工具成功后没有任何东西让主循环收尾——SubAgent 路径靠
`hasCapturedOutput` 旁路结束，顶层 `-p` 路径没有这个出口。这是独立缺陷，应另开条目。
