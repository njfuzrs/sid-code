---
Status: implemented
Date: 2026-10-07
---
# 可观测性缺陷 4–11：metric 队列上限、权限漏斗分子分母同口径、HITL 等待时长、/telemetry 与 invoke_agent 的 token 口径

## 决定了什么

- **缺陷 4**：`TelemetryBus.recordMetric` 和 `enqueueSpan` 一样受 `maxQueueSize` 约束，超限时丢掉最旧的 10%。
- **缺陷 5**：子代理（`agent/tool-executor.ts` 两个分支、`sub-agent.ts`）和 forked（`forked-agent.ts`）路径补上 `logPermissionAllow`，与 deny 覆盖同一组执行路径。`logPermissionAllow` / `logPermissionDeny` 的 `context` 由可选（缺省 `"main"`）改为**必填**，以后漏传会在类型层报出来，不会再静默归进 main 桶。哨兵加了一条「deny 用到的每个 context，allow 也必须用到」。
- **缺陷 6**：`noteGuardrailToolSuccess` 去掉 `export`。
- **缺陷 7**：`aggregateSessionMetrics` 从 `events.jsonl` 的 `PermissionDecision(prompted=true)` 派生 `hitl_prompts / hitl_wait_n / hitl_wait_total_ms / hitl_wait_p95_ms`，digest 的「端到端耗时」段落会显示等人确认的次数和时长。之前只有 `had_hitl` 一个布尔值，只能把整轮剔除，不能从耗时里减掉等人的那一段。
- **缺陷 8**：hook-probe 写 TTFT event 时，同时写属性 `ATTR.TTFT_MS`（`sidcode.ttft_ms`）。`/telemetry` 改用常量读这个属性。
- **缺陷 9**：`/telemetry` 的 TTFT 改为按 model 分组，报 P50/P95 和 n，不再报跨 model 的均值。没有样本时显示「无样本」，不再省掉整行。
- **缺陷 10**：`/telemetry` 的输入 token 改为取末轮的值（当前上下文大小），不再逐 chat span 累加 stock。output、cost 是 flow，继续累加。
- **缺陷 11**：invoke_agent（运行时根、子代理、重建根）不再写 `gen_ai.usage.*`，改写 `sidcode.agent.cumulative_input_tokens / output_tokens / cumulative_cache_*`，口径固定为 flow。运行时根取的是 `total_cumulative_prompt_tokens`，原先取的是末次的 `total_tokens_sent`。

## 放弃了什么（以及为什么不选）

- **缺陷 5 保留 `context` 缺省值、只补调用点**：没选。缺省值就是文档里点名的那个陷阱：漏传和「确实是 main」在数据里长得一模一样。改成必填的成本只是 4 个主循环调用点和 4 处测试各加一行。
- **缺陷 7 新增一个 `blocked_on_user` span 或新 trace 事件**：没选。`PermissionDecision` 已经逐条落进 events.jsonl（B11），并且带 `prompted` 和 `duration_ms`。这次缺的只是聚合这一步，再加一个事件会多出第二个事实源。补 hook fire 点属于缺陷 1 标注的另行立项范围。
- **缺陷 10 给 chat span 加一个累计 input 属性，再让 `/telemetry` 求和**：没选。chat span 本来就是单次调用，「末轮 = 当前上下文」是用户在这一屏真正关心的数。累计 flow 已经在 invoke_agent 的新属性和轨迹 `total_cumulative_prompt_tokens` 上有了。
- **缺陷 11 保留 `gen_ai.usage.input_tokens`，只把值改成 flow**：没选。按 OTel 语义它表示单次 LLM 调用的输入，值改对了，贴在 agent span 上照样会被外部后端按标准语义和每轮值混在一起 sum。

## 拿什么证明它生效了

- `bun run affected-tests:run`：选测 6 个目标，**4319 pass / 0 fail**。
- `make build`：exit 0，没有 `will always be undefined` warning。lint、format:check、lint:boundary、`docs:gen-reference --check` 全绿。
- 变异自证：
  - 删掉 forked 路径的 `logPermissionAllow`：哨兵「deny 覆盖的每条执行路径 allow 也覆盖」变红（1 fail）。
  - 把 bus.ts 的 metric 队列上限判断改成 `if (false)`：「metricQueue 受 maxQueueSize 约束」变红（1 fail）。
- 新测试 `packages/cli/tests/command/telemetry-command.test.ts` 走真实 `TelemetryCommand` 和真实 bus：三轮输入 1000/2000/3000，显示「当前上下文 3,000」，不再出现 6,000；TTFT 显示 `a: P50 100ms / P95 300ms (n=2)`。
- 还没做：真实交互会话里 `/telemetry` 的人工走查；HITL 时长在真实弹窗会话里的样本（headless 恒为 n=0，这与 CLAUDE.md「更安全」表那一格的 ⚠️ 一致）。
