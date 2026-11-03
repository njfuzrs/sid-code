---
Status: implemented
Date: 2026-11-03
---
# CompactQuality 事件接上消费方：/trace 报压缩次数与最低覆盖率

## 决定了什么

PR #528 把压缩摘要覆盖率从 `/tmp` 的 `compact-quality.jsonl` 改落 `events.jsonl` 的
`CompactQuality` 事件，但**没有消费方** —— 属于「采了不看」，与 JIT 第 1 批同型的缺口。
本次补上这条链的读侧：

- `packages/core/src/trace/digest.ts`：`SessionLevelMetrics` 增加两个字段
  `compact_quality_n`（可测质量的样本数）与 `compact_coverage_min`（最低覆盖率），
  `aggregateSessionMetrics` 消费 `CompactQuality` 事件，`renderHuman` 增加一段
  「上下文压缩: N 次（可测质量 M 次） 最低覆盖率 X%」。
- `packages/core/src/query/compact/quality-check.ts`：`COVERAGE_WARN_THRESHOLD`
  由 `const` 改 `export`，供 digest 复用同一阈值。

三个口径决定，每个都是刻意选的：

1. **`compactions` 与 `compact_quality_n` 是两个分母，都保留。** 前者数 `PreCompact`
   （压了几次），后者只数 `totalAnchors > 0` 的 `CompactQuality`（几次真的量到了质量）。
   无原文+摘要配对的 reactive/collapse 压缩不落质量事件 —— 合并成一个数会让覆盖率
   看起来覆盖了全部压缩。
2. **无锚点样本（`totalAnchors = 0`）不计入质量分母，也不参与最低覆盖率。**
   `checkCompactQuality` 约定无锚点时 coverage 恒为 1；把它算进来，一个真正塌陷的
   0.1 会被「洗」成看起来还行。
3. **没有可测样本时 `compact_coverage_min` 留 `undefined`，不落 0。**
   0 会被读成「摘要全是垃圾」，与「压根没测」是两件事。

## 放弃了什么（以及为什么不选）

- **不放 `session-index.jsonl`。** `compact_quality_n` / `compact_coverage_min` 只进
  digest 报告，不进索引行。跨会话趋势确实有价值，但索引 schema 一改就要处理历史行
  迁移与消费侧兼容，而当前最急的是「这条指标有没有人在看」。等这版报告稳定后再谈入索引。
- **不改 `recommendParams` 的规则和阈值。** 方案文档明确列为「不做」：样本口径修好之前
  调参是在猜。
- **不识别「自动截断」占位摘要。** T2 验收发现 `[自动截断] 之前有 N 条消息被截断…`
  这类降级占位文本会被当成摘要算覆盖率（必然 0%）。判据应落在 `usedLLM=false` /
  占位前缀上，但那是 `recordCompactQuality` 的调用契约问题，与「digest 有没有消费方」
  是两个关注点，另案。
- **不给 40 个写入点逐个加 `isPersistBlocked`。** 那属于 T1（PR #530）已合的兜底，
  这里是读侧，不做重复防护。

## 拿什么证明它生效了

新增 `packages/core/tests/trace/compact-quality-digest.test.ts`，8 条用例，两次变异自证：

```
bun test packages/core/tests/trace/compact-quality-digest.test.ts   # 8 pass / 0 fail
```

变异 1（去掉 `totalAnchors > 0` 过滤）：`无锚点样本不计入质量分母` 变红，其余 7 绿。
变异 2（把事件名改成 `CompactQualityX`）：4 条渲染用例变红（含「低于告警阈值 50%」那条
报 `Received: …可测质量 0 次…`），4 绿。两次都恢复了源码并确认回 8 pass。

T2 验收（方案文档要求的离线重算）用真实代码跑了 4 个会话 23 条 `[COMPACT_QUALITY]` 日志：

- 未覆盖锚点列全的 13 条里，修后 100% 的 7 条；另 6 条只差 `types.ts` 一个 —— 它命中
  `AMBIGUOUS_BASENAMES`（泛名不单独走 basename 档），属于方案的**预期行为**，不是缺陷。
- 方案文档预判的「12 次到 100%」偏乐观（实际 7 次），原因是它按纯 basename 口径离线
  估的，而落地代码还带了泛名豁免这一档。
- 08:28:34 与 08:48:28 两次「一个都找不到」查清了：**它们的摘要只有 35/36 字符，是
  `[自动截断] 之前有 N 条消息被截断以释放上下文空间。` 这句降级占位**，压根没有摘要正文。
  所以覆盖率 0% 是**正确判定**，不是口径 miss —— 是 auto-compact 熔断/失败降级到简单截断
  （`auto-compact.ts:214`、`:466`），摘要本来就不存在。
