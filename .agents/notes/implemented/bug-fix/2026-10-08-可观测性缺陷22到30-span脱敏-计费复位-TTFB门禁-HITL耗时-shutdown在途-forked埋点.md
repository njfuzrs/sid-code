---
Status: implemented
Date: 2026-10-08
---
# 可观测性缺陷 22–27 / 29 / 30：span 脱敏、计费时段复位与去重窗口、TTFB 门禁、HITL 确认耗时、shutdown 在途批次、forked 工具埋点

## 决定了什么

- **缺陷 22**：hook-probe 的 `execute_tool`（PostToolUse / PermissionDenied 两处）与 `blocked_on_user` 的 span name 和 `gen_ai.tool.name` 改走 `sanitizeToolName`，MCP 工具一律记成 `mcp_tool`。复用 `content-tracing.ts` 里已有的 `sanitizedToolName`（改为导出），所以 analytics、内容级 tracing、span 三条通道用的是同一条规则。
- **缺陷 23**：`recordError` 的错误摘要改用新增的 `maskedErrorSummary`：先过 `maskSensitiveData`，再按 UTF-8 字节截到 200 字节。脱敏模块不可用时只写占位，不回退到原文。
- **缺陷 24**：新增 `resetPriceTierCounts()`，只清时段计数，在 `trace/collector.ts` 的 `handleSessionStart` 里和 `resetSideCallStats()` 一起调用。删掉零调用点的 `clearBillingDedupe`。
- **缺陷 25**：fetchId 去重改成双桶轮换（`seen` + `seenPrev`）。这样任何 id 在其后至少 4096 次上报内都能被记住，内存上界是 2×4096。
- **缺陷 26**：加了一条结构门禁：扫 core/cli 全部生产源码，`latency-by-model.ts` 之外只要出现 `ttfb_p50` / `ttfbP95` / `ttfb_avg` 这类字段声明或字面量键就报红。注释里提到这些名字不算违规，并且有变异自证。
- **缺陷 27**：新增 metric `sidcode.permission.hitl_wait`（单位秒，桶边界 0.5…300s）。主循环弹窗时开始计时，三路竞争出结果后上报，带 outcome / source / 脱敏后的工具名。
- **缺陷 29（复核后改了判定）**：审计原文说「shutdown 只 flush 一个 batch ⇒ 最多丢 1536 条」，**复核结论是不成立**：`enqueueSpan` / `recordMetric` 在队列达到 batchSize 时就同步 splice 走一批，队列长度恒小于 batchSize（实测默认配置下峰值 511），单次 flush 一定能排空。真实的丢失在旁边：达到阈值和定时器触发的 flush 都是 fire-and-forget，shutdown 只 await 它自己那一批，导出器慢的时候前面几批还在路上，就被 `exporter.shutdown()` 和进程退出截掉了。所以改为登记在途批次（`inFlight`），新增 `drain()` 在退出前等它们全部落地。总时限 450ms，比 graceful-shutdown 的 500ms flush 硬超时短；超时会打一条 warn。
- **缺陷 30**：forked-agent 的工具执行补齐 `logToolCall/Success/Failure`（失败分型和子代理一致：invalid_input / tool_error / exception / aborted），并**直接在总线上**创建 `execute_tool` span（detached，带 `sidcode.execution_context=forked` 和 `sidcode.forked.query_source`）。

## 放弃了什么（以及为什么不选）

- **缺陷 30 让 forked 去 fire PreToolUse / PostToolUse hook，借 hook-probe 产生 span**：没选。forked 的调用方全是内部旁路（记忆抽取 / dream / session-memory / `/btw`）。fire 用户 hook 会让用户的拦截脚本、通知和改参逻辑作用在内部 side-call 上，这跟 B33 不对 forked fire PermissionDenied 是同一个理由。观测要补，但不能顺带扩大用户 hook 的语义范围。
- **缺陷 24 在 handleSessionStart 里直接调 `resetBillingSink()`**：没选。它会清掉 app 构造期只注册一次的计费观察者，换会话后 fork 的钱就再也不入账，等于用一个高估 bug 换来一个漏记 bug。
- **缺陷 25 用真正的 LRU**：没选。双桶已经给出了文档要求的保证（任何 id 至少存活一个整桶周期），只多一个字段；LRU 要逐次维护顺序，而这里的重复只发生在相邻时间窗内。
- **缺陷 29 按审计原文写 `while (queue.length) flush()`**：没选，因为那个循环永远只跑一次，修的是一个不存在的 bug，真实缺口还留着。测试照原文的写法也测不出来：均匀延迟下先发的批次先到，必须做成「后台批次慢、shutdown 那批快」才能复现。
- **缺陷 26 的门禁只扫 `ProviderDigestStats` / `SessionLevelMetrics` 两个类型**：没选。复发不一定发生在这两个类型上，扫全部生产源码才能覆盖「另一个文件里新增一个字段」这种形态。

## 拿什么证明它生效了

- 新增 `packages/core/tests/telemetry/observability-d22-d30.test.ts`，15 条，全绿。
- 变异自证：把源文件逐个回退到 origin/main 版本，再跑这个文件：
  - `hook-probe.ts` 回退：缺陷 22（MCP 服务名外泄）和缺陷 23（密钥进 error.message）各红 1 条。
  - `billing-sink.ts` 回退：导入 `resetPriceTierCounts` 失败，整个文件红。
  - `bus.ts` 回退：缺陷 29 两条都红（在途批次丢失、`drain` 不存在）。
  - `forked-agent.ts` 回退：缺陷 30 两条都红。
  - 缺陷 26 有内置变异用例：在别处声明 `ttfb_p50` 会被抓到，注释里出现不会误报。
- `bun run affected-tests:run`：4251 pass / 0 fail。`make build` 自检通过；lint、lint:boundary、`docs:gen-reference --check` 全绿。
- 还缺一项（如实记录）：这几条在**真实会话**里的触发都还没有轨迹样本。后续要看的是：有记忆抽取的会话里出现 `sidcode.execution_context=forked` 的 execute_tool span；开了 OTLP 的会话里，`sidcode.permission.hitl_wait` 有非零样本。
