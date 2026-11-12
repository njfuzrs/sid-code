---
Status: implemented
Date: 2026-11-12
Source: /cost 口径不一致与面板重做-修复与验收方案（2026-11-10）D4
---
# /cost 分两块显示主循环与辅助调用的 token，并在每个指标上标明统计范围

## 决定了什么

`/cost` 的「总费用」含辅助调用（`totalCostUSD + sideCostUSD`），但 token / 请求数 /
缓存命中率 / 省钱 / API 耗时都只来自主循环（`modelUsage` / `totalAPIDuration`）。
两种范围混在一个面板上却不标注，用户拿「费用 ÷ token」估单价必然偏高、
「省钱 vs 费用」也是两个不同范围在比（违反北极星铁律 3：分母口径必须和指标一起写死）。

本次在 `packages/cli/src/command/commands/cost/cost.ts`：

- **总费用**行加 `（含辅助调用）` —— 它是面板上唯一含辅助调用的指标。
- **token 段标题**（main 上 D3 已先把它改成「Token 用量:」）改成
  「主循环 Token 用量（不含辅助调用；含子代理）」，并新增 `请求: N 次`
  （`getTotalRequests()`，同样只含主循环）。「含子代理」必须写：子代理经 usage-sink
  走同一个 `updateUsage`，本来就在这段数字里。**标题刻意不写「累计」**：D3 在下面并列了
  flow（累计发送）与 stock（当前上下文）两行，写「累计」会和 stock 行自相矛盾
  —— 这是本 PR 合并 D3（PR #760）时实际踩到并解决的问题。
- **缓存命中率 / 省钱**行加 `（仅主循环，不含辅助调用）`。
- **API 耗时**行加 `（仅主循环）` —— `totalAPIDuration` 只在主循环 `updateUsage` 累加。
- **新增「辅助调用 Token 用量」段**（导出纯函数 `formatSideCallTokenSection`）：
  调用次数 + 输入 / 输出 token，无辅助调用时整段省略。数据源是**会话维度**
  `getSessionSideStats()`（回灌基线 + 本进程记录），不是进程维度 `getSideStats()`。
- 「按模型统计」标题的参照对象改成「上方主循环汇总」，避免用户以为汇总含辅助调用。
- `CostCommand` 的统计读取函数做成第二个构造参数（默认读真实 `getSessionSideStats`），
  测试可注入假快照 —— `side-call-sink` 是进程级单例，测试直接 `recordSideCall`
  会让别的测试文件的 `/cost` 输出凭空多出辅助段。

官网 `website/use/cost.md` 的示例输出与「每个数字的口径」表同步更新
（新增「辅助调用 Token 用量」一行，给 `输入` / `输出` / `缓存命中率` / `省钱` 补上
「仅主循环」的范围说明）。

## 放弃了什么（以及为什么不选）

1. **不把辅助调用并进 `modelUsage`。** 那会污染 stock 口径的上下文大小：
   `ModelUsageStats.stockPromptTokens` 表达的是「当前上下文有多大」，辅助调用的 prompt
   不是主对话上下文，混进来会让状态栏 `↑` 和 `/context` 类的判断全部失真
   （`session/state.ts` 的 `addSideCost` 注释已写明这是刻意设计）。
   分两块显示能同时满足「口径可比」和「上下文不失真」。
2. **不取进程维度 `getSideStats()`（方案文档 D4 原文写的是它）。** `getSideStats()` 只含
   本次启动后的记录，而 `/cost` 的费用是会话累计（`sideCostUSD` 有 resume 回灌基线）。
   用进程维度会做出「token 只含本次启动、费用含全会话」——正是 D4 要消除的那种
   分子分母范围不同。`getSessionSideStats()` = 基线 + 本进程，与费用同口径。
3. **不给 `/cost` 加 `/stats`、`/debug`、Footer 的范围标注。** 那三处属于方案文档 D19 /
   PR-B 的范围（`/stats` 要整段改读 `buildCostReport`）；本 PR 只做 D4 的 `/cost`
   单元，避免把一个「改文案 + 补一段」的 PR 变成面板重做。
4. **不做 D8 的「辅助调用耗时」显示。** D8 与本项共用辅助调用段，但它的修法要改
   `SideCallRecord.durationMs` 的入账路径（billing 观察者目前写死 0），是另一处契约变更；
   本 PR 只把 API 耗时标注成「仅主循环」，不新增耗时数字。
5. **不加千分位、不改颜色 / 分区**（D5、D15）。范围标注是数据正确性问题，视觉重做是
   另一个 PR；混在一起会让「改文案」的 diff 里塞满排版变更。

## 拿什么证明它生效了

- 新增 `packages/cli/tests/command/cost-side-scope.test.ts`（11 条）：
  - 纯函数：无辅助调用返回空数组（整段省略）；有辅助调用写出次数与输入 / 输出 token。
  - 接线：总费用含辅助标注、主循环标题与请求数、缓存行标注、API 耗时标注。
  - 两块互不包含：主循环输入 10000 + 辅助 547419 分别出现，**相加值 557419 绝不出现**；
    辅助段排在主循环各块之后。
  - 静态接线：默认统计源是 `getSessionSideStats`，import 与默认值两处都不出现
    `getSideStats`（注释里提到被否决的函数名不算违规）。
- **变异自证 2 轮（先红后恢复）**：
  1. 断开 `lines.push(...formatSideCallTokenSection(...))` → 3 条辅助段断言变红
     （8 pass / 3 fail），恢复后 11 pass；
  2. 删掉总费用行的 `（含辅助调用）` → 对应 1 条变红（10 pass / 1 fail），恢复后 11 pass。
- 既有 `cost-pending-tasks.test.ts` 9 条、`cost-protocol-hint.test.ts` 6 条保持全绿
  （它们断言的行首 `总费用:` / `API 耗时:` 前缀没变，只在行尾追加范围标注）。
- 门禁：`bun run affected-tests:run` / `make build` / `bun run lint` /
  `bun run format:check` / `bun run typecheck:gate` / `bun run lint:boundary` /
  `bun run lint:command-system` / `bun run lint:legacy-tool` / `bun run docs:gen-reference`
  结果见 PR 正文。
