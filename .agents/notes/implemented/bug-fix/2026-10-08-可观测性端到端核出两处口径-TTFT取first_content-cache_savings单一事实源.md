---
Status: implemented
Date: 2026-10-08
---
# 可观测性端到端核出的两处口径：TTFT 取 first_content、cache_savings 单一事实源

这两条不在 20260927 审计的 38 条里。是 PR #184–#195 合入后用 `sc-dev -p` 跑端到端核出来的
（会话 `20261008-104407-5a9c8b52`，3 轮主循环加 1 个 explore 子代理）。

## 决定了什么

- **A. chat span 的 TTFT 改取 lifecycle 层 `first_content` 的同一个值。** 以前 `query/loop.ts`
  在 `processStream` 的可视文本回调里自己计时，纯 tool_use / thinking 的轮次恒为 undefined。
  实测 3 轮只有 end_turn 那一轮有 `sidcode.ttft_ms`，前两轮的 StreamPhase 分别是 9614ms、5623ms。
  这违反 CLAUDE.md 的 TTFT 铁律：首个任意内容 chunk 都算，每次 fetch 单独计。
  - `trace/stream-observer.ts` 新增 `_firstContentTtft` 表。emit `first_content` 时按快照 key 覆盖写，
    `takeFirstContentTtft(index)` 读一次就清掉。
  - 这张表不放进 `_snapshots`。快照在 race settle 的 finally 里就被清了，而 AfterModel 是在那之后才组装的。
  - `clearAllSnapshots` / `cleanupAgentSnapshots` / `init` / `reset` 会一并清这张表，避免泄漏。
  - 主循环每轮发请求前先 take 一次丢掉残留。主循环轮和强制总结轮（index = turnCount + 1）的 AfterModel 都改为调用 take。
- **B. cache_savings 只算一次，span 和 metric 用同一个数。** 以前同一次调用 span 记 0.0661、metric 记 0.0858：
  - span 的值来自 `tokenMeter.calculateCacheSavings(model, usage, provider)`，不带 baseURL；
  - metric 的值是 `TokenMeter.record` 内部自算的：带 baseURL 的 `thisCost` 减去不带 baseURL 的全价，减法两边口径不一致；
  - 两个数都不等于 `/cost` 累加用的 `SessionState.calculateSavings`。

  现在主循环直接调 `sessionState.calculateSavings(model, usage, provider, baseURL)`，总结轮也一样，再经 AfterModel 透传。
  `TokenRecordParams` 新增可选字段 `cacheSavingsUSD`，有值就原样用，缺省才自算（子代理路径没有这个值）。
- 删掉 `TokenMeter.calculateCacheSavings`。改完后它没有生产调用方了，留着就是第二个事实源。
  两条测试只为它而存在，一并删除。

## 放弃了什么（以及为什么不选）

- **不保留文本回调计时作为兜底。** 两个源混用，同一个指标里就会有两种口径。没有 first_content 时宁可是 undefined，也不填一个偏大的数。
- **不让 TokenMeter 的 CostCalculator 改为接收 baseURL 来对齐。** 这样 TokenMeter 会变成第二个定价入口，以后还会漂移。
  只算一次再透传更直接。
- **不修改子代理路径。** SubagentStop 的载荷里没有 savings 字段，自算是唯一来源，不存在两套口径。

## 拿什么证明它生效了

- `packages/core/tests/telemetry/ttft-and-cache-savings-caliber.test.ts`（12 条）。
  - A：纯 tool_use 轮能取到 TTFT；读一次即清；重试时取最后一次的值；清快照不会顺带清 TTFT；按 agentId 隔离；非法值不入表；三种收尾都会清表；
    还有一条结构门禁，要求 loop.ts 不再出现 `ttftStart`，且两处 `ttft_ms` 都来自 `takeFirstContentTtft`。
  - B：AfterModel 带了 savings 时，metric 的值与 span 属性严格相等；对照组：不带时仍然自算；
    结构门禁：两处都走带 baseURL 的 `calculateSavings`，`calculateCacheSavings` 没有调用也没有定义。
- 变异自证共 6 个，逐个撤回修复点后都会转红：不透传、忽略入参、不入表、take 不清、清快照时连带清 TTFT、总结轮漏传 baseURL。
- 端到端：重新构建后再跑一次 `sc-dev -p`，确认每个 chat span 都有 `sidcode.ttft_ms`，且同一次调用的 span savings 与 metric savings 相等。
