---
Status: implemented
Date: 2026-10-18
---
# 加载行的输出 token 箭头改用 TOKEN_OUT（↓），与 Footer 统一

## 决定了什么

`packages/cli/src/ui/components/LoadingIndicator.tsx` 显示本轮输出 token 时原先硬编码 `↑ N tokens`，
而 Footer 用 `figures.ts` 的 `TOKEN_IN = "↑"`（输入）/ `TOKEN_OUT = "↓"`（输出）。同一屏上同一个
输出 token 数，加载行朝上、状态栏朝下，用户会把加载行那个数读成输入 token。
现在加载行改为引用 `TOKEN_OUT`，箭头语义只有 `figures.ts` 一处来源。

## 放弃了什么（以及为什么不选）

- **保持 `↑`，对齐 claude-code**：cc 的加载行确实是 `↑ N tokens`，原注释写的就是“对标 cc”。
  但 cc 的状态栏没有 sid-code 这种 `↑in ↓out` 双向计数。照抄过来就和我们自己的 Footer 语义冲突了，
  同一个界面内部一致比对齐外部产品更重要。
- **改 Footer，让 `↑` 表示输出**：Footer 的 `↑ 输入 / ↓ 输出` 已经写进 `figures.ts` 注释、
  官网文档和用户的使用习惯，改动面更大，也和用户期望的“输出朝下”相反。
- **加载行去掉箭头只写 `N tokens`**：能消除冲突，但会丢掉“这是输出”的方向信息。

## 拿什么证明它生效了

- `packages/cli/tests/ui/components/LoadingIndicator.test.tsx` 新增用例，断言帧内含
  `` `${TOKEN_OUT} 142.59k tokens` ``，且不含 `TOKEN_IN` 形态。
- 变异自证：临时把实现改回 `↑`，该用例变红，Received 正是
  `(esc 取消, 5s · ↑ 142.59k tokens)`，和用户截图一致；恢复后变绿。
- `bun run affected-tests:run`：2590 pass / 0 fail；`make build` 自检通过；lint、format:check、
  typecheck:gate（66/66，无新增）全绿。
