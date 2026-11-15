---
Status: implemented
Date: 2026-11-15
Source: X1H2 追踪结构 落地方案（2026-11-02）
---
# execute_tool span 改为执行前开，forked 后台任务显式挂会话根

## 决定了什么

一次 PR 收掉 X1H2 方案剩余的 T2 / T3 / T6，并给 T5 一个「不做」的明确结论。

**T2（`packages/core/src/telemetry/hook-probe.ts`）**：`execute_tool` span 从「PostToolUse\* 里事后创建、按 duration_ms 倒推起点」改为「PreToolUse 建、Post 系列取用」。

- 新增 `toolSpans: Map<tool_use_id, { span, startedAt }>`；`handlePreToolUse` 建 span，父取 `scopedParent() ?? 会话根`。
- `handlePostToolUse` / `PostToolUseFailure` / `PermissionDenied` 优先按 `tool_use_id` 取出并结束；取不到（无 id / 子代理 spawn / 事件乱序）退回原来倒推补建，标 `sidcode.tool.span_backfilled=true`，不静默丢树。
- `PermissionDenied` 复用 Pre span 时带 `sidcode.tool.permission_wait_ms`（= 拒绝时刻 − Pre 时刻），把「等用户 30s 才拒」与「秒拒」分开。
- `handleSubagentStart` 优先用 `parent_tool_use_id` 找 `execute_tool sub_agent` 的 span 作父；取不到才回落作用域/根。
- `handleSessionEnd` 在根 `end()` **之前**遍历 `toolSpans`，标 `sidcode.tool.abandoned=true` 并 end；`/clear` 的 SessionStart 里兜底再收一遍。

**T3（`forked-agent.ts` / `hook-probe.ts`）**：`TelemetryHookProbe.rootSpanId()` 暴露会话根 id；`recordForkedToolSpan` 新增 `parentSpanId` 参数，4 处调用点传 `mainContext.rootSpanId`；`runForkedAgent` 的模型调用前后直接建 `chat` span（父 = 根，`sidcode.execution_context=forked`），因为 forked 路径不走 hook、此前模型调用在树上完全不存在。`app.ts` 两处 `ForkedAgentContext` 构造点注入 `rootSpanId: this.telemetryProbe?.rootSpanId()`。

**T6（`bus.ts`）**：`startTrace` 注释从「每次用户请求调用一次」改为「每个会话一次；`/clear` 换新 trace」，并写明旧说法的误导后果（按旧说法读会把每轮当独立 trace，在 T4 判据下误读成多根）。

**T5 决定不做**：spawn 模式本地实际用过 2 次（`~/.sid-code/logs/*.log` 的「spawn 模式完成」），但 `packages/cli/src/entrypoints/headless.ts` 头部明确写「❌ 权限检查 / Hook / MCP / Plan Mode / TUI」——子进程**不初始化 hook 探针、不产生任何 span**。传 `TRACEPARENT` 没有消费者，做了也不会让树变完整。要做得先在 headless 接 telemetry，那是另一个方案。

## 放弃了什么（以及为什么不选）

- **放弃「只修 forked 的父、不改工具 span 时机」**：T2 与 T3 有同一根源——父在子开跑时还不存在。只改 forked 的话，主循环的 `sub_agent` 仍是「子代理与工具调用互为兄弟」，T4 判据②（找不到的父）在子代理并发时照样红。
- **放弃在 PreToolUse 里同时写结果属性**：Pre 时刻不知道 success/denial，硬塞会让「工具失败」在 trace 上看不出来。结果属性一律由 Post 系列补，Pre 只负责起点和身份。
- **放弃为 `permission_wait_ms` 单独建 span**：会多出一层与 `execute_tool` 同名的 span，消费方按 name 聚合时反而更难读；属性足够。
- **放弃 btw 命令的 rootSpanId**：`/btw` 是用户可见的同步问答，不属于「后台任务」，且它的 ctx 拿不到 probe。保持改造前行为，已在代码注释里写明。
- **放弃 T5 的 TRACEPARENT**：见上，headless 无 telemetry consumer。

## 拿什么证明它生效了

```text
$ bun test packages/core/tests/telemetry/hook-probe-tool-spans.test.ts
7 pass / 0 fail        # Pre 建 span、Post 复用（无 backfilled）、并发不串父、
                       # PermissionDenied 带 permission_wait_ms、SessionEnd abandoned、
                       # 无 Pre 回退 backfilled、SubagentStart 挂 execute_tool

$ bun test packages/core/tests/agent/forked-agent-span.test.ts
3 pass / 0 fail        # chat span 父=根、工具 span 父=根（不是栈顶 chat）、无 rootSpanId 时不崩

$ bun test packages/cli/tests/app/signal-root-span-persisted.test.ts
3 pass / 0 fail        # 真进程 + 真信号 + 真 jsonl 落盘：
                       # SIGHUP / SIGINT / exit 三路都查到了 invoke_agent sid-code 根，
                       # 且工具 span 的 parentSpanId === 根的 spanId
```

变异自证（已实际执行）：

- 注释掉 `handlePreToolUse` 里的 `this.toolSpans.set(...)` → 7 条 T2 测试中 5 条红（无 backfilled、并发父、denial wait、abandoned 均依赖它）。
- 删掉 `handleSessionEnd` 里收 `toolSpans` 的循环 → abandoned 那条红。
- 把 `recordForkedToolSpan` 的 `parentSpanId` 参数去掉 → forked 测试的「父=根」两条红（父变 undefined）。

其余门禁：`bun run lint` 0 warning / 0 error；`make build` 通过（产物自检 5 项全绿）；`bun run typecheck:gate` 无新增错误（62/62 基线）。
