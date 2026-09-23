---
Status: implemented
Date: 2026-09-23
---
# 状态栏行1 新增 API 调用次数列 `⟳ N ✘M`，口径收口到 requests 单一事实源

## 决定了什么

Footer 行1 末尾（scroll 之前）新增一列 `⟳ 12 ✘3`：`12` = 本次会话累计 API 调用次数，
`✘3` = 其中作废（重试白烧）的次数。白烧是**子集**语义，不是 12+3；占比 >20% 转黄，
≤20% 保持暗色；零调用时整列不渲染（不显示 `⟳ 0`）。

数据源定在 `SessionState` 新增的两个 getter，作为本指标的单一事实源：

- `getTotalRequests()` = 各模型 `requests` 之和。口径是**实际发出的 HTTP 请求数**，
  含作废重试、含子代理调用、含 maxTurns 强制总结轮，**不含** side-call（那些只走
  `addSideCost`，自有 `side-call-sink` 计数）。
- `getDiscardedRequests()` = 各模型 `discardedRequests` 之和，是上者的子集。

顺带把**已存在的 4 处逐字重复**收口到这个 getter（此前每处各抄一份
`Object.values(modelUsage).reduce((s, m) => s + m.requests, 0)`）：`buildSessionEndStats`
的 `total_api_calls`、`countApiCallsForCrash`、`StatsDialog` 面板、`/stats text`。
最后一处的变量名 `totalToolCalls` 与它渲染出的标签「API 请求」不符，一并改名
`totalRequests`——同一个数字在同一文件里有两个名字是误读的温床。

**连带修掉一个真 bug**：`hydrateUsage` 回灌了 `requests` 却漏读 `discardedRequests` /
`discardedPromptTokens`，而 `serializeUsageSnapshot` 是整个 `modelUsage` 深拷贝、
盘上本来就有这两个字段。漏读的后果不是"少个调试字段"：resume 后分母连续、分子归零，
`⟳ 12 ✘3` 变成 `⟳ 12`，表现为**重试白烧凭空消失**——而"跨 resume 口径一致"正是
requests 被选中的理由，这个洞不补，本方案的立足点就没了。

展示链路沿用 Footer 既有的 5 个刷新点（初始 state / `tool_end` / `done` / 轮末 finally /
异常收尾），未新增推送通道；`/clear` 补进 `getConversationClearedPatch` 一起归零。

## 放弃了什么（以及为什么不选）

- **`SessionState.absoluteTurnCount`（会话累计轮次）—— 主要否决对象**。它看起来
  更贴近"agent 走到第几步"，但会与同一行的邻居自相矛盾，两条都已在源码核实：
  ① **不持久化、不 hydrate**（全仓仅 4 处引用，无落盘路径），resume 后从 0 重数，
  而 token/cost 是回灌的 → 同一行出现「$0.43 全会话」+「3 轮 本进程」；
  ② **不被 `resetCounters()` 清零**，`/clear` 后邻居归零、它继续数。
  状态栏一行里的数字互相矛盾，比少一个数字更糟——用户会开始怀疑旁边的钱也是错的。
- **`LoopState.turnCount`（循环迭代数）**：每条用户消息归零，且只活在 core 内部，
  没有任何 yield 事件把它带出来。要用它得新开一条事件通道，成本远大于收益。
- **SDK 的 `num_turns`**：压根不在 TUI 路径上。TUI 走 `query/engine.ts` 的
  `QueryEngine`，那个计数器在 `sdk/query-engine.ts`，只服务 headless / SDK 消费者。
- **追求"实时跳动"**：`updateUsage` 在 `processStream` **之后**才调，所以流式输出
  全程 requests 是冻结的，往 TUI 高频推也不会更早。选择如实呈现"响应回来才 +1"，
  不为了数字好看去挂一个轮首自增的计数器——那等于用一个口径不一致的数换视觉动效。
  「agent 是否还活着」已由 LoadingIndicator 的流式字符数探针回答，不该由本列兼任。
- **不 import `digest.ts` 的 `RETRY_WASTED_RATIO_THRESHOLD`**：阈值数确实都取 20%，
  但**分母不同**——digest 是 token 占比（白烧 prompt token ÷ 已记账 input），本列是
  次数占比（作废次数 ÷ 总调用次数）。绑上常量会让两个口径被误当成一个（CLAUDE.md
  铁律 3：分母必须和指标一起写死）。只借用"20% 以上算病态"的量级判断，注释里写明不同源。
- **`dropOrder` 没有把 scroll 改成 7**，而是给新段取 5.5：`fitRow` 用严格 `>` 取最大值、
  同值时先出现的先丢，改动既有值会连带打乱那批段之间的相对丢弃次序。

## 拿什么证明它生效了

- **整帧渲染**（L5.2 ①，布局改动必须走这条）：新增
  `packages/cli/tests/ui/components/footer-requests-column.test.tsx` 8 个用例，
  8 pass / 0 fail。覆盖：段落真的落在行1（同行能搜到 model）、`⟳ 12 ✘3` 文本正确且
  不出现 `15`、无白烧时不出现 `✘`、props 省略/为 0 时整帧无 `⟳`、宽终端行不超宽、
  窄终端（40 列 / 30 列）该段被丢而不是把行撑爆且固定段 model 保留。
  断言先按 `⟳` 过滤出目标行再断言，没有用全帧 `includes`（该坑 L5.2 明确点过）。
- **临时预览实跑**（用完即删）：在 140 列下渲染出
  `… · ⚡63% · $0.049 saved · ⟳ 12 ✘3`，与既有计量流同行、行2 右对齐未受影响。
- **纯函数**：`status-line-data.test.ts` 新增 8 个 `deriveRequests` 用例（含 20% 边界
  取严格 `>`、脏快照 `discarded > total` 钳位、负数按 0），27 pass / 0 fail。
- **口径与回灌**：`usage-stats-persistence.test.ts` 新增 7 个用例，12 pass / 0 fail。
  其中 `回归：resume 后白烧数不得凭空消失` 直接钉住上面那个 hydrate bug（改之前必红）；
  另有 `resetCounters()` 后 requests/discarded/token/cost **四者同时归零** 的断言，
  钉住"选 requests 而非 absoluteTurn"的那条理由。
- `bun run affected-tests:run`（选测 2 目标：`packages/cli/`、
  `packages/core/tests/session/`）：**1732 pass / 0 fail**。
- `bunx tsc --noEmit`：27 个错误，与改动前基线**逐条相同**，且全部落在本次未触碰的
  文件（`cli.ts`、`trace/backfill.ts`、`trace/collector.ts` 及若干测试）——
  先记基线再对比，避免"本来就红"被当成本次引入。
- `make build` 通过（自检 4 项全绿）；`oxfmt --check` 与 `oxlint` 对本次 13 个文件全绿。
