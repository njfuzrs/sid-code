---
Status: implemented
Date: 2026-11-19
Source: 缓存断裂归因失效与命中口径-缺陷复核与修复方案（2026-11-19）
---
# 缓存命中率按 promptTotal 钳制，三个读出口统一不超过 100%

## 决定了什么

`packages/core/src/session/state.ts`：

- `getNormalizedCacheUsage()` 的循环内按 `promptTotal` 钳制三段：先 `hit = min(hit, promptTotal)`，
  再 `write = min(write, promptTotal - hit)`，超出部分归入 `uncachedInputTokens`。
  这保证恒等式 `uncached + hit + write === promptTotal` 恒成立，**所有读侧**（Footer、`/cost`、
  用量账本）天然 ≤ 100%——钳制只做在一个地方，不是每个出口各修一遍。
- `updateUsage()` 末尾新增越界 WARN：用**未钳制的原始值**判据（钳完再判永远不触发），
  按 `model::provider` 去重（`warnedCacheOverflow`，不进快照/不 hydrate——它只是本进程日志去重状态，
  落盘会带来跨进程假去重）。日志用三参形式 `warn(category, message, data)`。
- 只告警不改记账：原始 token 是 provider 报的，改它等于伪造账单；钳制只在读侧做展示兜底。

## 放弃了什么（以及为什么不选）

- **否决「在每个读出口各加一次 `Math.min(100, ...)`」**：Footer / `/cost` / 账本三处会各写一份，
  新增读侧必然漏掉一个——缺陷本身就是「三个出口不一致」。钳制放单一事实源后，新读侧自动正确。
- **否决「在 `getCacheHitRate()` 里钳制并告警」**：它是无参方法，被 `cost-bridge.ts:69` 与
  `app.ts:10103` 高频只读调用；往里塞写副作用会刷屏，也破坏「只读查询」语义。
- **否决「用钳制后的值判断是否越界」**：钳完必然 ≤ promptTotal，WARN 永远不触发，等于没加。
- **否决「改 `getCacheHitRate` 的整数契约或 `/cost` 的 1 位小数契约」**：Footer 与 `/cost`
  的渲染依赖这两条契约，修口径不该顺带改展示格式。

## 拿什么证明它生效了

- 新增 `cache-usage-overflow.test.ts`（9 个用例），夹具用真实错配形态（anthropic 用量配
  `provider="openai"`，命中 580%）：
  ① 三段恒等式成立（`uncached + hit + write === promptTotal`）；
  ② `getCacheHitRate() <= 100`；
  ③ `buildCostReport().main.cacheHitRate <= 100`；
  ④ WARN 按 `model::provider` 去重，连续两次 `updateUsage` 只报一条；
  ⑤ 不同 provider 各自告警一次；
  ⑥ 未越界的正常 usage 不告警。
- 变异自证：循环内两处 `Math.min` 改回裸值 → ①②③ 十条断言同源变红
  （`Expected: <= 100, Received: 500`；`Expected: 1000, Received: 5000`），
  合法用例与 WARN 用例仍绿（说明不是靠环境凑红）。恢复后 9 pass / 0 fail。
- 命令：`bun test ./packages/core/tests/session/` → 383 pass / 0 fail（41 files）；
  `bun run lint` / `format:check` / `lint:boundary` / `lint:command-system` / `lint:legacy-tool` 全通过。
