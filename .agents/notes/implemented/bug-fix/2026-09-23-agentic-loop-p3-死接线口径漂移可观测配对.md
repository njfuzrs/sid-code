---
Status: implemented
Date: 2026-09-23
---

# Agentic Loop 六条 P3：死接线、口径漂移、可观测配对

来源：`docs-research/sid-code/bugfixes/todo/20260920-AgenticLoop主循环审查-对照博客核出的缺陷.md`
的 P3-1…P3-6，是那份文档的最后一组。P0 在 #69/#73、P1 在 #79、P2 在 #84 落地，本 PR 收尾。

这一组的共同形态是**不会让任何测试变红**：死变体、零调用的类、写反的注释、同值的两层阈值、
`index: -1` 的事件。它们都不影响当前功能，所以只能靠"有人去读"发现——也因此每一条都配了
反漂移锁，而不是只改代码。

## 决定了什么

1. **P3-1**（`goal_budget_warning` 零接线）：**接上，不删**。`GoalGateResult` 加
   `budgetWarning`，由 `handleGoalGate` 的每条 `shouldContinue: true` 返回带出，loop 在
   `budgetStatus === "warning"` 且即将 continue 时把 `ContinueReason` 记成
   `goal_budget_warning`。**替换而非追加** `goal_gate_retry`——一次 continue 只对应一条
   transition，追加会让「按 type 数续跑次数」的分母凭空多一份（分母口径一变曲线整体平移）。
   核对过 15 个变体：这是唯一一个真零调用的（`token_budget_continuation` 在
   `loop.ts:4139`，见下方"踩到的坑"）。

2. **P3-2**（Stop 双实现）：**删死代码**。`hook/stop-hook-orchestrator.ts` 整文件 +
   `hook/index.ts` 的再导出 + 零引用的 `getMaxStopHookRetries()`。删而不是接，因为两者
   **耗尽语义相反**：live 是「耗尽后仍验证但放行」（`forceStop: false`，blog §5.3/§9.4 的
   刻意取舍），编排器是 `preventContinuation: true` 强制停。谁把它接进 loop，Stop 耗尽就从
   「放行」翻成「强制停」，且不会有任何东西报错。在 `stop-hooks.ts` 文件头写明"这是唯一实现"。

3. **P3-3**（子代理总结轮）：补**两个半边**。① 发送前 `finalizeMessagesForSend`——总结轮跑在
   while 之外，吃不到循环内 `agentic-loop.ts:491` 那道兜底，而"未知 stopReason 带未执行
   tool_use → break"这条路径进来时历史已破配对；② 响应后 `filter(b => b.type !== "tool_use")`
   ——本轮没下发 tools，响应里的 tool_use 无法执行，入历史就是**新造**一个孤儿。只修一边都会
   留 400，而总结轮是把 maxTurns 轮产出落地成结论的唯一机会，它 400 掉整段只剩 salvage。

4. **P3-4**（`types.ts` 注释漂移）：改注释对齐实现（入口调一次，不是 while 每轮），并写明
   照旧注释改会怎样坏：`turnCount` 是消息内的 API 迭代数，在 while 顶部重设会让端到端口径从
   「用户回车 → 最终答复」退化成「最后一次 fetch 耗时」，工具往返/等待全被剔除 → p95 系统性
   **虚低**（"看起来变快了"）。这是 TTFT 那次事故的同形态。

5. **P3-5**（心跳与 watchdog 同值 720s）：拆出独立的
   `streamHeartbeatTimeoutMs`（600s，settings + `SID_CODE_STREAM_HEARTBEAT_TIMEOUT_MS` 可调），
   **不回落** `watchdogNoProgressMs`。关键不是"数值撞车"而是**谓词不同**：心跳在 switch 之前
   无条件刷新 `lastActivityTime`（任意 SSE 事件，含 ping/keep-alive），watchdog 只认快照里的
   `lastContentProgressAt`（只有 text_delta/tool_use/reasoning）。于是"网关只回 keep-alive"
   这个最常见形态里心跳被每个 ping 续命、**永不开枪**，两层防线实际只有一层。600s 的位置刻意在
   provider 档② 480s 与 watchdog 720s 之间：谓词更宽松的一层不该比更严的那层更晚开枪。

6. **P3-6**（`emitTimeoutFired(-1, …)`）：`AgentStreamOptions` 加 `observerIndex` /
   `observerAgentId`，两处生产调用分别传 `agentStreamIndex`（10000+turns）与
   `summaryStreamIndex`（20000+turns），与各自的 `emitStreamPhase` 逐字节同源。`-1` 拼出的
   快照 key 对不上任何快照：既 push 不进 `snapshot.timeoutsFired`（fallback 的 reopenReason
   读它），也无法按轮次聚合 → 子代理超时在 digest 里像没发生过。

## 放弃了什么（以及为什么不选）

- **P3-1 删掉这个变体**（文档给的另一个选项）：告警文案本来就在进对话，「预算告警续跑」是
  真实存在的控制流事实，缺的只是可观测接线。删掉等于永久放弃这条归因；接上只多一行。
- **P3-1 在 warning 分支处直接 `setTransition`**：那里只是"本轮处于告警档"，**续跑的决定在
  下方评估阶段才做**。在告警处发事件会把"告警了但随后判定完成/不可能"也记成续跑。所以
  `budgetWarning` 的语义刻意是「处于告警档」，由 loop 在真的要 continue 时才换 reason。
- **P3-2 把编排器接进 loop**（文档给的另一个选项）：见上，会把现网的「耗尽放行」翻成
  「强制停」。删死代码的成本是 0，接错的成本是行为回归。
- **P3-5 让 `LIFECYCLE_PRESETS.mainLoop` 也脱钩 BASE**：`mainLoop` 与 watchdog 守的是同一条
  主链路的同一批慢流，同源是 P0-4 明确写下的意图，`timeout-ladder-sentinel` 也在断言它。
  本次只拆哨兵**看不见**的那一对（stream-processor 心跳 ↔ watchdog）。
- **P3-5 直接把心跳默认值改成别的数字、不加字段**：那样用户调 `watchdogNoProgressMs` 时两层
  会一起动，同值形态悄悄回来且无报错（PR14 拆 `fallbackStreamTimeoutMs` 时记下的同一条教训）。
- **P3-6 只补 index、不补 agentId**：`makeSnapshotKey` 无 agentId 时拼的是主循环那把 key，
  子代理超时会**污染主循环快照**，自己的 `timeoutsFired` 仍恒空。传了但传错，比不传更难查。

## 拿什么证明它生效了

**逐条回退验证**（这一组最重要的一步：不会让任何测试变红的缺陷，必须证明新测试真的拦得住）。
每条都是"改回缺陷形态 → 跑测试 → 确认变红 → 恢复"：

| 回退的东西 | 结果 |
| --- | --- |
| P3-1 `setTransition` 改回固定 `goal_gate_retry` | 2 fail（接线用例 + ContinueReason 闭集反漂移锁） |
| P3-2 `git show HEAD:…` 把编排器文件放回 | 1 fail（死编排器已删除） |
| P3-3 去掉响应后 `filter` | 2 fail（集成：真产生孤儿；形态：两道防线都在） |
| P3-3 去掉发送前 `finalizeMessagesForSend` | 2 fail（未知 stop → 总结轮历史有孤儿 + 形态） |
| P3-4 注释写回「while 循环顶部每轮重设」 | 1 fail |
| P3-5 心跳指向改回 `watchdogNoProgressMs` | 1 fail |
| P3-5 默认值改回 720s（与 watchdog 同值） | 1 fail |
| P3-6 心跳超时改回 `emitTimeoutFired(-1, …)` | 2 fail（形态 + 端到端：事件 index 必须是传入号段） |

**门禁全绿**（worktree 内实跑）：
- `bun test`：**12451 pass / 0 fail**（854 文件，165s）。
- 新增两份测试单独跑：20 pass / 60 expect。
- `bun run lint` / `lint:boundary` / `lint:command-system` / `format:check`：全过。
- `make build`：编译产物自检 4 项全过，且**无 `will always be undefined` 导出告警**
  （worktree 路径含 `.claude/`，这条是必查项）。

**中途被门禁抓到一次真问题**，记下来因为它正是这类"文档与源码同源"防线存在的理由：
`docs:gen-reference --check` 红了——我在 `help.ts` 加环境变量时只用了**一个**空格，而
`parseHelpEnvVars` 要求名字后 `\s{2,}`，于是这个变量被判"源码有读取但没写进 --help"，
落到「未列入上表的读取点」那一节。补成两个空格后重新生成，正表从 119 → 120 条，变量进表。
（顺带发现 `SID_CODE_MAX_TURN_DURATION_MS` 有同样的单空格问题、同样掉在那一节里——**本次不动**，
它是存量且与本 PR 无关，避免把无关 diff 混进来。）

**另一条值得留给后人的坑**：写 P3-1 用例时我用「`getProviderForModel` 抛错」来断言评估器没被
调用，结果 transition **一条都不发**，测试红得像"修复没生效"。真因是 `loop.ts` 在
`handleGoalGate` **之前**就无条件解析 provider，而整个 Goal Gate 块套在 try/catch
（"Goal Gate 不得阻断主循环"）里，抛错被静默吞掉——**测试自己把闸门打死了**。改用
`goal.minTurnsBeforeEval: 99` 压在"跳过评估直接 continue"那条路径上。这条坑已写进测试文件的
注释里。P1 那组用例能那么写，是因为它们断言的正是"forceStop 必须在解析 provider 之前就 return"。
