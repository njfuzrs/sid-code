---
Status: implemented
Date: 2026-10-15
---
# 整体超时只计单次尝试：退避停表、新尝试重新起表

## 决定了什么

事故 20261015-114502-c596be23：3 个并行 task 子代理第 5 轮撞网关 429「当前分组上游负载已饱和」，
漏斗退避 6s→11s→24s→43s→86s；从该轮 fetch_sent 起正好 180.0s，`agent_overall_timeout`
把 3 个子代理全部砍掉，第 6 次重试还在退避中，`maxRetries=10` 被时间架空。

根因：`agent/stream-processor.ts` 用 `createStreamLifecycle` 包的是**整个** `streamWithResilience` 漏斗，
Layer 3 overall 从流开始绝对计时，实际语义是「本轮全部重试 + 退避」总上限。#284（B1）去掉了
`deadlineAt` 这一个截断点，这一层同值（180s）同口径，接替成了杀手。idle 层同病：`retry_backoff`
是首个事件，新尝试的等首字节改用 idle 档（60s）判。主循环 `query/stream-processor.ts` 2026-10-12
已扣退避，但 overall 仍从整条流起算，多次尝试本身的耗时会累加，是同型残留。

改法：

- `llm/stream-lifecycle.ts` 新增 `classifyRetryBoundary`：`retry_backoff start` 三层停表；
  `retry_backoff end` / `stream_restart` 三层重新起表、idle 回首字节档；`system_api_error` 忽略。
  控制事件不计 totalEvents、不触发 TTFT。provider 内部流没有这些事件，行为不变。
- `query/stream-processor.ts` 同口径：新尝试重置 overall 起点与首字节档。
- 三者各管一件事：次数 → `maxRetries`；单次卡死 → overall / idle / content；总时长失控 → 子代理硬 kill
  （timeout × 3），side-call 由 `withSideCallDeadline` + `deadlineAt` 管。

## 放弃了什么

- 调大 180s 或缩短退避阶梯：仍是「次数听时间的」，换个负载形态还会撞。
- 直接去掉子代理 overall 层：失去「持续吐内容永不结束」的单次尝试兜底。

## 拿什么证明它生效了

- `packages/core/tests/agent/subagent-overall-timeout-excludes-backoff.test.ts`：端到端复刻事故（缩比），
  回退源码后 2 条红。
- `packages/core/tests/llm/stream-lifecycle-retry-boundary.test.ts`：三层停表 / 重新起表 / 观测口径 / 负向对照。
- `packages/core/tests/query/retry-count-decoupled-from-watchdog.test.ts`：新增 3 条，回退源码后 2 条红。
- `packages/core/tests/config/timeout-ladder-sentinel.test.ts`：改为结构断言（`startOverall` 只在起流和
  attempt_start 两处调用）。
- 线上口径：`TimeoutFired(layer=agent_overall_timeout)` 不再出现在 `RetryTelemetry(type=retry)` 之后的退避窗口内。
