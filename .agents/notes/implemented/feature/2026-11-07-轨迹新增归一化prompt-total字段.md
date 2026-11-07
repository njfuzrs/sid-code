---
Status: implemented
Date: 2026-11-07
---
# 轨迹新增归一化 flow 字段 `prompt_total`（计量与成本 T1 第一步）

## 决定了什么

按《20261104-X1H1-计量与成本-落地方案》T1 的裁决 1，先做**纯增量**的一步：新增
`prompt_total`（累计输入 prompt，flow 且**跨 provider 归一化**），旧字段一个都不动。

- 数据来源只有一处：每轮 `normalizeCacheUsage(usage, provider).promptTotal` 累加
  （Anthropic = 未命中+命中+写入，OpenAI 族 = prompt_tokens 全量）。
  SessionEnd 时用 `SessionState.getNormalizedCacheUsage().promptTotal` 覆盖为权威值。
- 落盘五处：`hook/types.ts` 的 SessionEndStats、`cli/src/app.ts` 的
  `buildSessionEndStats()`、`trace/collector.ts` 的 metadata（含崩溃会话的逐轮累加）、
  `trace/builder.ts` 的 traj metadata、`trace/digest.ts` 的 `TrajectoryDigest.promptTotal`。
- `TraceMetadata` / `TrajectoryMetaOutput` 里该字段是可选的；老轨迹没有它，
  digest 读侧拿到 undefined，明确退回 `total_cumulative_prompt_tokens`。

## 放弃了什么（以及为什么不选）

- **不在这一步顺手把 `total_cumulative_prompt_tokens` 归一化。** 方案里确实有这一条，
  但它是**行为变更**：`digest.ts:3216` 的 `ledger_cost_zero_with_tokens` 判据（`tokensSent > 5000`）
  与 `session-index.ts:433` 的跨会话聚合都在读旧字段。混在同一个 PR 里，一旦命中率变化
  就无法判断是「新字段有问题」还是「旧字段口径变了」，也没法单独回滚。方案自己也写了
  「先加字段、后改注释和归一化，分两个 PR」。
- **不新增一个与 `tokensSentCumulative` 同值的 digest 字段就收工。** `digest.ts:1488`
  早有 `tokensSentCumulative`（来自旧 flow 字段），但它同样未归一化；只加渲染不落新数据
  等于没修。所以新字段必须从采集侧开始，digest 只是读取端。
- **不在 `collector.ts` 里改 `total_tokens_sent` 的 stock 口径。** 那是第二步
  （归一化 stock + 注释降级）。本 PR 只加字段，`total_tokens_sent` 的值与语义保持原样，
  测试里专门断言旧字段仍是 2700（未归一化），防止后来者把「顺手归一化」当成无害修改。

## 拿什么证明它生效了

- `bun test ./packages/core/tests/trace/prompt-total-normalized.test.ts`：**2 pass**。
  - 同一真实用量（未命中 1000 + 命中 500 + 写入 200 = 1700）在 anthropic / openai
    两种 provider 表达下，`normalizeCacheUsage().promptTotal` 都等于 1700；
  - 走 TraceCollector 落盘两轮（一轮 anthropic、一轮 openai）后，
    `session.traj` 的 `metadata.prompt_total` = 3400，而
    `metadata.total_cumulative_prompt_tokens` = 2700 —— 新字段归一化、旧字段保持原值。
- **变异自证**：把 collector 的累加临时改回 `+= inputTokens`，测试红
  （`Expected: 3400, Received: 2700`）；恢复后 2 pass。
- 落盘隔离：TraceCollector 的 `outputDir` 指向 tmpdir，不碰 `~/.sid-code`。
