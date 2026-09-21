---
Status: implemented
Date: 2026-09-21
---
# Agentic Loop 三条 P0：压缩保留段、子代理分区、协议兜底

来源：`docs-research/sid-code/bugfixes/todo/20260920-AgenticLoop主循环审查-对照博客核出的缺陷.md` 的 P0-1 / P0-2 / P0-3。F1 连坐与 F2 fall-through 已由 #69 合入；本 PR 补齐那份明确没做的执行器分区，以及子循环仍缺的 loop_recovery 补 result / 发送前兜底，并修掉主循环压缩把近端 GC 掉的口子。

## 决定了什么

1. **P0-1**：`query/loop.ts` 的 blocking / hard 压缩不再在「边界 push 到数组末尾」之后调 `releaseBeforeBoundary`。与 emergency 档同一套 `emergencyTruncate`，近端 tool_result 留给模型。方法本身保留给「边界真插在切点」的调用方与单测，注释写明调用前提。
2. **P0-2**：子代理 `agent/tool-executor.ts` 丢掉两桶分类，改走主循环 `partitionToolCalls` + `getMaxToolConcurrency()`。`Read(a) Edit(c) Read(d)` 保持三批顺序；并行批次有 cap；`isConcurrencySafe` 抛错 fail-closed 当 unsafe。出口缺 idx 走 `yieldMissingToolResults`，N 进必须 N 出。
3. **P0-3 余项**（#69 已做 F1/F2）：
   - 子循环发送前走 `finalizeMessagesForSend`（此前全仓生产调用只在主循环）。
   - 循环检测命中后走 `injectLoopRecovery`，与主循环 `recoverFromLoop` 共用 `buildPendingToolResults`，先补占位再注入 prompt。
   - `isEndTurnLikeStopReason` / `buildPendingToolResults` 抽到 `message-invariants.ts`，主循环删掉本地副本。

## 放弃了什么（以及为什么不选）

- **把 compact_boundary 插到 splitPoint 再 GC 远端**：正确，但要改 `addCompactBoundary` 的 push 语义和所有调用方。blocking/hard 此刻本就不该清近端——与 emergency 对齐「不调用」就能止血，少动一条被多处依赖的插入约定。
- **子代理继续两桶、只加「写完再读」的特判**：特判覆盖不了 `Read → Bash(写) → Read` 这类 `isConcurrencySafe=false` 夹在中间的形状，正是博客禁止的语义。共用 `partitionToolCalls` 才能跟主循环同一份不变量。
- **子循环再抄一份 recoverFromLoop**：主循环漂一次子循环就会再漂（#69 的 D1–D3 共同根因）。本 PR 抽共享纯函数，子循环只接线。
- **本 PR 顺手修 P1/P2/P3**：用户范围是 P0。Stop Hook last-wins、unanswered 耗尽、max_tokens 带 tool_use 都不在这三条里。

## 拿什么证明它生效了

- `bun test ./packages/core/tests/agent/subagent-f1-f2-stop-reason.test.ts ./packages/core/tests/agent/subagent-protocol-defenses.test.ts ./packages/core/tests/agent/subagent-hook-pair-invariant.test.ts ./packages/core/tests/agent/message-invariants.test.ts ./packages/core/tests/context/compaction-integrity.test.ts ./packages/core/tests/query/streaming-tool-executor.test.ts` → **73 pass / 0 fail**
- `bun run affected-tests:run` → `./packages/core/tests/{agent,context,query}/` **1327 pass / 0 fail**（119 files）
- `make build` 自检通过
- `bun run lint` / `format:check` / `lint:boundary` 全绿
- 源码哨兵：`loop.ts` 不再含 `releaseBeforeBoundary(`；子循环含 `finalizeMessagesForSend(` / `injectLoopRecovery(` / `partitionToolCalls(`
