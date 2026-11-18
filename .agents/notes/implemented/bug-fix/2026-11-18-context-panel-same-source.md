---
Status: implemented
Date: 2026-11-18
Source: /context 面板取数不准与信息缺失 — 修复与验收方案（2026-11-17）PR1
---
# /context 面板与 footer 改成同一个表达式的返回值，thinking 分类由决策侧那条循环产出

## 决定了什么

三处取数出口收敛成一条计算链，任何一处都不再有自己的一份实现：

1. **分类由决策侧的同一个循环产出**。`estimateConversationTokens` 新增可选访问者
   `visit(part, tokens)`（`context/token.ts`），`getTokenBreakdown` 不再自己写第 7 份手写
   if/else 链，改成订阅这份循环。归类规则收敛到 `categorizeBlock` 一个**穷尽 switch**：
   `text` 按 role 分 user/assistant，`thinking` / `redacted_thinking` / `provider_reasoning`
   统一归入新增的「思考链」一档，`tool_use` / `tool_result` 各一档，`default` 里做 `never`
   赋值——新增块类型时**编译期**报错，而不是像旧 if 链那样漏了也不报。
   访问者不传时零额外开销（决策热路径行为与性能不变），且契约是
   `Σ 上报量 === 返回值`：块自身的结构开销（tool_use +20 / tool_result +10）与该块合并上报，
   不再可能出现「总量算进去了、分类没算」。

2. **面板 total 与 footer used 是同一个表达式的返回值**。抽出三个私有方法：
   `calibrate(raw)`（全类唯一换算入口，统一 `ceil`，此前 `round`/`ceil` 两套取整并存）、
   `localReductionTokens()`（全类唯一减项入口）、
   `sendTokensFrom(estimated)`（`max(0, estimated − freed)`）。
   `getContextUsageForDisplay().used`、`getTokenBreakdown().total`、`getCompactionLevel()`
   的判定基数全部改调 `sendTokensFrom`，同源由调用关系保证，不再靠三处自觉抄同一段代码。

3. **分类值用最大余数法分配到校准后总量上**。新增 `packages/shared/src/utils/allocate.ts`
   的 `allocateByWeight(weights, total)`，保证 `Σ 分类 === 校准后总量`。落 shared 而不是
   core 或 cli，是因为两个包都要用（core 做校准分配、cli 做网格格子分配），
   而 core 不能反向依赖 cli。

4. **`ContextTokenBreakdown` 新增四个字段、删除一个**：新增 `grossTokens`（扣减前的毛估算，
   `= Σ categories`）、`anchorLiftTokens`（实测下界高于校准估算的部分，恒 ≥ 0）、
   `freed.{tokens,byStrategy}`（本地释放量及其按策略细目）、
   `thresholds.{maskingAt,compressionAt,emergencyAt,blockingAt}`（换算成「已用 token 数」的
   四档刻度，UI 不必再自己拿 `maxTokens − remaining` 换算）、`level` / `percentOfTrigger`；
   删除 `effectiveWindow`（它恒等于 `maxTokens`，却让 UI 误以为「分母被减过」）。

5. **`CompactionThresholds.effectiveWindow` 保留但注释改准**：`rg effectiveWindow` 确认
   `query/compact/index.ts` 与 3 处测试仍在读它，所以不删；注释改为「当前恒等于 maxTokens，
   完成缓冲区是靠抬高剩余门槛生效的，不是减分母」。

6. **ContextDialog 最小适配**（不改布局、不动边框）：新增 thinking 分类色、
   「实测校正 +N」「本地已释放 −N」两行、网格里工具结果按**净值**分格、
   校准文案从「已按真实用量校准」改为「分类为估算值，总量已按真实用量校准」
   （此前那句话在总量含锚点抬升时并不成立）。

## 放弃了什么（以及为什么不选）

- **R1 把锚点抬升按比例摊进各分类**：差额来自哪一类块被低估我们并不知道，按比例摊派等于
  **伪造归因**——用户会看到「工具结果」凭空涨一截，然后去做错误的清理。单列一行
  `anchorLiftTokens`，账目可核对且不撒谎。
- **R4 反过来让 footer 改用 `breakdown.total`**：方向反了。footer 与压缩决策同源，是事实源；
  面板应该向它对齐。而且 `getTokenBreakdown` 在热路径上被禁止调用。
- **R2 改用官方 tokenizer**：基座要服务多个 provider，单一厂商 tokenizer 对别家反而引入新偏差，
  校准回路已把误差收到 5% 以内；且这次的问题是**漏算和不同源**，换 tokenizer 一个都修不了。
- **R6 每个分类各用一个校准系数**：真实 usage 只有「总量」一个观测值，10 个系数**不可辨识**，
  拟合出来的数没有意义。
- **只改文案注明「两套口径」**：用户的问题恰恰是三个数对不上，解释缺陷不等于修掉它。

## 拿什么证明它生效了

新增 `packages/core/tests/context/breakdown-same-source.test.ts`，用**五个状态**
（未校准 / 已校准未抬升 / 已校准抬升 / 清理后 freed>0 / 压缩重置后）覆盖所有取数分支，
每个状态断言三条**严格相等、零容差**的恒等式：
`total === getContextUsageForDisplay().used`、`Σ categories === grossTokens`、
`total === max(0, grossTokens + anchorLiftTokens − freed.tokens)`，以及 `level` /
`percentOfTrigger` 与 footer 同源、freed 按策略细目之和自洽。

夹具用 `satisfies Record<ContentBlock["type"], ContentBlock>` 锁住全 6 种块类型
（新增块类型不补样例就类型报错），工具名取 30+ 字符，避免「漏算工具名」藏在小数字里。

**变异自证**（改坏 → 看到对应断言变红 → 恢复 → 全绿）：

| 变异 | 结果 |
| --- | --- |
| `categorizeBlock` 删掉 thinking 分支 | `bunx tsc` 报 `Type 'ThinkingBlock \| RedactedThinkingBlock \| ProviderReasoningBlock' is not assignable to type 'never'`；去掉 `never` 再跑，thinking 逐类断言 `Expected: > 0, Received: 0` |
| 面板 total 改回 `Σ categories` | 状态 3 `Expected: 5036, Received: 4214`（差 822 = `anchorLiftTokens`）；状态 4 `Expected: 2835, Received: 3357`（差 = `freed.tokens`） |
| 访问者漏掉 tool_use +20 / tool_result +10 | 访问者契约 `Expected: 3929, Received: 3729`，差 200 = 20×7 + 10×6，正好是夹具里 tool_use / tool_result 块数乘结构开销 |

> 变异 3 暴露了一个设计事实：`Σ categories === grossTokens` 由 `allocateByWeight` 的构造
> **恒等保证**，所以它抓不到「访问者漏报」（权重小一点，分配结果仍等于总量，只是比例悄悄错了）。
> 真正能抓住漏报的是更底层的那条契约 `Σ 上报量 === 返回值`，因此单独补了一条测试。

门禁：`bun run lint` 0 warning 0 error；`bun run lint:boundary` 0 处越界；
`bun run typecheck:gate` 62 处 / 基线 62 处（无新增）；`make build` 通过；
`bun run smoke` 42/42；`bun run smoke:tui` 3/3。

## 待核项 W1 的核实结论（本 PR 只记录，不改代码）

**官方文档按模型分档，不是一刀切**（`platform.claude.com`，2026-11-18 抓取）：

- Extended thinking 页原文：*"Claude Opus 4.5 and models numbered 4.6 and higher keep prior
  turns' thinking blocks in context and bill them as input. Claude Sonnet 4.5 (deprecated),
  Claude Haiku 4.5, and earlier models strip them."*
- Preserved thinking 页：*"usable blocks stay in context and are billed as input"*；
  被剥离的块 *"The API drops it for that request and doesn't bill it"*。

结论：**保留型模型（Opus 4.5 / 4.6+ / 新一代）把历史 thinking 计入 input，剥离型模型不计入**。
DeepSeek 侧是协议硬要求（不回传直接 400），必须计入。所以现有「一律计入」的做法：
对保留型模型与 DeepSeek 正确，对剥离型模型（Sonnet 4.5 / Haiku 4.5 等）偏高估——
方向是安全的（更早压缩，不会越界），且本次问题是漏算，不构成删减 thinking 的理由。
**不做按模型分档**：那需要模型级信息注入估算器，且会把「估算偏高」这个安全偏差换成
「估算偏低」的风险；真要分档应另开 PR，并附上各模型的实测比值。
