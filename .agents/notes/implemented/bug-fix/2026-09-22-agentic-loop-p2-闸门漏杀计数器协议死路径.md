---
Status: implemented
Date: 2026-09-22
---
# Agentic Loop 八条 P2：闸门漏杀、计数器只增不清、协议死路径

来源：`docs-research/sid-code/bugfixes/todo/20260920-AgenticLoop主循环审查-对照博客核出的缺陷.md` 的 P2-1…P2-8。P0 已在 #69/#73 落地、P1 在上一个 PR 落地；本 PR 只修 P2，不带 P3。

## 决定了什么

1. **P2-1**：`detectUnansweredEndTurn` 改用 `isEndTurnLikeStopReason`（与 loop 的收尾白名单同一份，补上 `stop_sequence`）；形态 B 的硬条件 `thinkingCount === 1` 放宽到「无 text、无 tool_use」，thinking 段数不限；Anthropic 的 `message_delta` 补发 `_rawOutputTokensZero`（口径取**累积** `cumulativeOutput === 0`，不是本帧增量）。此前形态 A 对 Anthropic 整条死掉——`stream-processor` 的初值恒 `false`，只有 openai.ts 发这个标记。
2. **P2-2**：AfterAgent 的 `clearContext` 改成置标志位，由闸门链**放行后**的三个真实收尾出口（forceStop / unanswered 耗尽 / 正常收尾）执行；hook `success === false` 至少 `log.warn`。
3. **P2-3**：`StopHookResult` 加 `passed`（真跑了验证且全通过），loop 据此清零 `stopHookRetryCount`；预算耗尽后**仍执行验证**，只是不再注入修复提示、不再 continue。`hypothesisGateRetryCount` 在「登记表已结清」那一轮（门禁的 `else` 分支）清零。
4. **P2-4**：Token Budget 的 `DiminishingReturnsDetector` 不再显式传 `diminishingThreshold: 500`，回到默认 150（2026-07-07 已收紧，写回 500 等于在本路径撤销那次修复）；`consumed` 与基线收敛到新的 `tokenBudgetConsumed()` 单一事实源；`DiminishingReturnsOptions` 的注释默认值改成引用常量。
5. **P2-5**：`pause_turn` 不再 `setTransition({type:"tool_use"}); continue;`，改为 fall-through 到「未识别停止原因」的显式收尾。
6. **P2-6**：四条压缩路径统一「真压动即清零 `consecutiveCompactFailures`」——此前只有流式阶段的 `reactiveCompact` 成功路径清零，连接阶段那条和两处 `autoCompact` 只补失败。
7. **P2-7**：F1 空参数耗尽的顶部注释改写成与实现一致（**硬停**，不是「放行走 end_turn」），并显式 `turnStopReason = "other"`。
8. **P2-8**：`ToolExecutorDeps` 加 `awaitPrecomputedResult`，`executeTools` 在**预检循环**里 await 抢跑落地再读缓存；app.ts 用一张 `_streamingToolInflight` 表把「抢跑还在跑」暴露出来（`finally` 刻意不 delete——要能 await 到一个已 settle 的 promise）。

## 放弃了什么（以及为什么不选）

- **P2-1 形态 B 多 thinking 块时也转正文**：「极短 thinking ≤500 转正文」只在**唯一**一块时才谈得上"把这一句直答转出来"，多块时转哪一块都是猜。多块一律判未答复走重试。
- **P2-1 Anthropic 用本帧增量 `deltaOutput === 0` 当判据**：增量为 0 只说明「这一帧没新增」，不等于整条响应 output 为 0，而 `stream-processor` 是「任一帧报 true 即置位」，用增量会在多帧场景误置位。
- **P2-2 把 AfterAgent 升级成可 block**：`hook/types.ts` 写明 AfterAgent 不可 block，那是产品取舍。本条只修「清历史的时机」，不改 hook 契约。
- **P2-3 用 `!shouldContinue && !forceStop` 当清零条件**：那把「耗尽仍失败」和「hook 抛异常」也算成通过，预算会永远回满。只认真正跑过且全通过的 `passed`。
- **P2-3 耗尽时仍注入修复提示**：注入了却不 continue，等于往历史里塞一条永远不会被回应的提醒（下一条用户消息还会看到），是纯污染。
- **P2-5 真做 server-tool 续接**：需要 anthropic.ts 先保留 `server_tool_use` 块（现在被当未知块丢成空 text），两者缺一不可。本仓 `web_search` 是本地工具，这条分支目前是死路径；未实现之前如实收尾比假装推进正确。
- **P2-7 改成 fall-through 走 end_turn 闸门链**：走到那里的事实是「模型连续 3 次吐不出工具参数」，而每道门都是靠注入提示再续一轮起作用——对已退化的模型续命只会把同一个退化再跑一遍（CC 死亡螺旋那条教训）。且此时 stopReason 不一定是 end_turn，fall-through 还要先伪造一个正常收尾语义。故选硬停、改注释对齐实现。
- **P2-8 把并行/串行批次里那两处同步读也改成 await**：预检循环跑在所有批次之前，在那一个位置等干净就够；逐处改反而多出「漏改某一处就留窗口」的风险。
- **本 PR 顺手修 P3**：用户范围是 P2。

## 拿什么证明它生效了

四个新测试文件，35 个用例（含既有 `stop-hooks.test.ts` 的 5 个）：

- `packages/core/tests/query/agentic-loop-p2-unanswered-detector.test.ts`（P2-1，9 例，含「检测器认的 stopReason 集合 = `isEndTurnLikeStopReason` 的集合」反漂移锁）
- `packages/core/tests/query/agentic-loop-p2-gates.test.ts`（P2-2/3/4/5/7，15 例）
- `packages/core/tests/query/agentic-loop-p2-compact-counter.test.ts`（P2-6，2 例）
- `packages/core/tests/query/agentic-loop-p2-streaming-prefetch-race.test.ts`（P2-8，4 例）

**每条修复都逐个回退验证过测试会红**（否则测试什么都没锁住）。两次实测教训值得记下来：

1. P2-8 第一版用「测试自己 resolve 的 promise」当未落地的抢跑 —— 它只隔几个微任务，而 `executeTools` 预检之后还有若干 `await`（权限/hook），微任务 churn 足以让抢跑在批次那次同步读之前落地，于是**把修复去掉测试照样绿**。改成挂在 `setTimeout`（宏任务）才真正区分：无修复 2 次执行、有修复 1 次。
2. P2-6 第一版断言 `compactCalls > 3`，而实测两种实现分别是 **4**（累计语义）和 **6**（连续语义）—— `> 3` 两边都满足。改成断言确切值 `6`。

`bun run affected-tests:run`：3980 pass / 0 fail（300 文件）。`make build`、`make lint`、`bun run format:check`、`bun run lint:boundary` 均通过。

## 埋的坑 / 后续

- P2-5 之后 `pause_turn` 走的是「未识别停止原因」分支，用户会看到一条 terminal 提示。真要支持 Anthropic server tool，改动点是 anthropic.ts 保留 `server_tool_use` 块 + loop 侧回传续接，**两者缺一不可**；届时再开分支，别复活那个 `continue`。
- P2-4 的 `tokenBudgetConsumed()` 刻意不含 `cacheRead`（按钱计价，不按上下文体积）。代价是在「大上下文 + 高命中」的长工具链里账面 consumed 明显低于真实喂进去的量。改它之前先想清楚要计价的是钱还是体积，并同步那段注释。
- P2-8 的 `_streamingToolInflight` 随每轮 `processStream` 重建、流重开时 `clear()`。整张表在一轮内不删条目（executeTools 要 await 到已 settle 的 promise），靠重建避免跨轮堆积。
