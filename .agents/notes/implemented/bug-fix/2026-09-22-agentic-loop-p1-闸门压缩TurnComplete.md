---
Status: implemented
Date: 2026-09-22
---
# Agentic Loop 六条 P1：Stop 真停、耗尽封顶、截断带工具、压缩看 success、TurnComplete 不漏

来源：`docs-research/sid-code/bugfixes/todo/20260920-AgenticLoop主循环审查-对照博客核出的缺陷.md` 的 P1-1…P1-6。P0 已在 #69/#73 落地；本 PR 只修 P1，不带 P2/P3。

## 决定了什么

1. **P1-1**：`handleStopHooks` 把 `continue===false` 提到 `decision:block` 之前；`queryLoop` 对 `forceStop` `yield done; return`。Stop Hook 明确说停，后面的 Todo/Goal/`+k` 不再续命。
2. **P1-2**：`HookAggregator` 的 Stop 与 AfterAgent 一样走 OR；`handleStopHooks` 按 `allOutputs` 收集全部 block 原因。lint 失败 + test 通过不再被 last-wins 放行。
3. **P1-3**：unanswered 续命耗尽后直接收尾，不再 fall-through 到 Goal / Token Budget。
4. **P1-4**：`max_tokens`/`length` 带着非空 `tool_use` 时走现有 F2 执行分支；截断续写只留给纯文本。
5. **P1-5**：`autoCompact` 读 `compactWithSummary().success`。切点无效不得 `recordSuccess` / 不得报 `summarized`；空摘要与切点失败不再双计 `recordFailure`；压不动时跳过 post-compact 重注入。
6. **P1-6**：`willRunForcedSummary` 加上 `!exitedViaReturn`。`yield done; return` 的出口会置位，finally 不再误以为还要跑强制总结而漏发 `TurnComplete`。

## 放弃了什么（以及为什么不选）

- **Stop 改 AND / 加权投票**：Ralph 验证器要的是「任一失败即拦」。AND 会让后一个 allow 继续覆盖，正是原 bug。
- **unanswered 耗尽后只跳过 Goal、仍走 Todo**：文档给了「直接收尾或至少跳过会 continue 的门」两条。直接收尾更短、和 forceStop 同一形状；Todo 在 unanswered 之后，耗尽时模型已经连续空手，再续 Todo 只会把封顶再打穿一次。
- **`max_tokens`+tool_use 另写一套执行器**：复用 F2 fall-through，循环检测 / tool_result / UI 事件不用再抄一份。
- **切点失败时仍 `recordSuccess` 但改 telemetry 标签**：熔断器才是用户能感知的伤害（假成功把已 trip 的熔断复位），只改标签治不了。
- **finally 里无条件发 TurnComplete、总结轮再发一次**：会重复计数，而端到端样本少，重复一次就偏分位数。用 `exitedViaReturn` 让「会不会落到 try 外总结段」和 `willRunForcedSummary` 同源。
- **本 PR 顺手修 P2/P3**：用户范围是 P1。

## 拿什么证明它生效了

- `bun test ./packages/core/tests/query/stop-hooks.test.ts ./packages/core/tests/query/agentic-loop-p1-gates.test.ts ./packages/core/tests/query/auto-compact-success-guard.test.ts ./packages/core/tests/query/auto-compact-outcome.test.ts ./packages/core/tests/query/unanswered-end-turn-loop.test.ts ./packages/core/tests/query/turn-complete-e2e.test.ts ./packages/core/tests/query/loop-transitions.test.ts` → **45 pass / 0 fail**
- `bun run affected-tests:run` → `./packages/core/tests/{hook,query}/` **854 pass / 0 fail**（77 files）
- `make build` 自检通过
- `bun run lint` / `format:check` / `lint:boundary` 全绿
- 源码哨兵：`aggregator.ts` 的 Stop 走 `mergeWithOrDecision`；`loop.ts` 含 `exitedViaReturn` / `isTruncatedWithTools`；`forceStop` 分支含 `yield` `done` + `return`
