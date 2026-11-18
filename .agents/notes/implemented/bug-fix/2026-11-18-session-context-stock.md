---
Status: implemented
Date: 2026-11-18
Source: 20261117-context面板取数不准与信息缺失-修复与验收方案（2026-11-17）
---
# 「当前上下文」改为会话级单值，子代理 sink 不再写 stock

## 决定了什么

`SessionState` 新增 `mainContextStock`（会话级「当前上下文」单值），`getStockPromptTokens()`
改为直接返回它，**不再跨模型求和**。footer `↑` 与 `/cost` 的 `contextNow` 同源于此。

写入规则（`updateUsage` 新增第 9 个位置参数 `stock: "main" | "none"`，默认 `"main"`）：

- **主循环的有效调用**写：`loop.ts` 的 3 处调用（正常轮、作废重试、maxTurns 强制总结轮）
  都发的是主会话的上下文，均按默认 `"main"` 传；
- **子代理 usage-sink 不写**：`agent/usage-sink.ts` 显式传 `"none"`。子代理有自己的上下文
  窗口，它的输入大小与主会话无关；何况 sink 传进来的是几十轮的**累计值**；
- **作废重试不写**：沿用既有 `discarded` 语义（那次响应根本没进上下文）；
- `/model` 切换是**覆盖**：每次主循环调用直接改写该字段，不叠加两个上下文窗口。

各模型自己的 `stats.stockPromptTokens` 仍照常写（`/stats`、`/cost` 的按模型明细用），
只是不参与会话级口径。会话快照带 `mainContextStock`；恢复**旧快照**（无该字段）时，
回退到「当前主模型」那一份 `stockPromptTokens`，**不回退到求和**。`resetCounters()`
（`/clear`）一并归零。

## 放弃了什么（以及为什么不选）

1. **保留求和、只在求和里排除子代理模型**：做不到。子代理可能和主会话用同一个模型名
   （P6 复现里两者都是 `deepseek-chat`），按模型名排除会把主循环自己的值也排除掉；
   按"是否有子代理"排除则无法表达"子代理与主循环交替入账"。
2. **在 `usage-sink` 里另建一个子代理专用统计器**：sink 必须继续入账费用与 `requests`
   （G6 的真实请求数口径），新开通道等于把同一笔 usage 抄两份，两个口径迟早漂移。
   改成一个布尔语义的 `stock` 选项，入账仍是一条路。
3. **把 `stock` 并进现有 `discarded` 参数**：两者语义无关——作废重试是「主会话的一次
   失败调用」，子代理是「另一个窗口的成功调用」。合并后「子代理的作废重试」这种组合
   无从表达。现在它们各管各的：`discarded=true` 不覆盖，`stock="none"` 不入会话级单值。
4. **旧快照回退到跨模型求和**：那正是本 PR 要修的病。`/model` 切换过的旧会话会在
   resume 后把两个上下文窗口叠成一个数；宁可回退到当前主模型那份，拿不到当前模型时
   保持 0（不显示错数）。
5. **把 `stock` 参数插在 `at` 之前**：`at` 占第 8 位、已有调用点按位传 `Date`
   （`cost-report` 的时段测试），插在它前面会把 `Date` 静默当成 stock 值。放在末尾
   需要 sink 多传一个 `undefined` 占位，这个丑陋是刻意的兼容代价。

## 拿什么证明它生效了

1. **变异自证**（方案 §8.2 第 9 条）：把 `usage-sink.ts` 的 `"none"` 删掉（退回默认
   `"main"`），跑 `bun test ./packages/core/tests/session/session-context-stock.test.ts`，
   P6 用例在第 2 步变红，失败信息为 `Expected: 129031 / Received: 1200000` ——
   正是方案要求的「1,200,000 ≠ 129,031」。恢复后 8 例全绿。
2. **P6 探针转成的回归用例**（附录 B 四步）：`129031 → 129031 → 129031 → 131000` 逐位成立；
   另外覆盖「子代理仍写按模型明细」「`/model` 切换不叠加」「`discarded` 不覆盖」
   「新快照 round-trip」「旧快照回退到当前主模型」「旧快照无当前模型时保持 0」
   「`/clear` 归零」。
3. **原有断言更新**：`cache-usage.test.ts` 的「多模型简单求和」断言改为「取末次调用，
   不叠加」——旧断言本身锁定的就是要修的错口径。
4. **门禁**：`bun run affected-tests:run` → 4496 pass / 0 fail（450 文件）；
   `make build` 成功且产物自检通过；`bun run lint` 0 warning / 0 error；
   `bun run format:check` 通过；`bun run typecheck:gate` 62/62（无新增）。
5. **端到端**：footer `↑` 与 `/cost` 的 `contextNow` 都经 `getStockPromptTokens()` 取数
   （`ui/cost-bridge.ts`、`session/cost-report.ts`），无第二份求和实现——本 PR 后
   「`/stats`、`/debug` 与状态栏同口径」这句话才真正成立。
