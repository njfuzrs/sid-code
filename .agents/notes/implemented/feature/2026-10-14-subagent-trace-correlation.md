---
Status: implemented
Date: 2026-10-14
---
# 子代理轨迹关联键统一：规范 id + parent_session_id / parent_tool_use_id + 可追溯残卷

## 决定了什么

事故排查时同一个子代理有三种 id（SubagentStart `subagent-explore-<taskId>`、StreamPhase/RetryTelemetry/BilledRequest
`<parent>-sub-<taskId>`、sidechain 裸 `<taskId>`），`parent_session_id` 恒 undefined，没有 `parent_tool_use_id`，
残卷 `<output-file>` 指向会被 `evictTaskOutput` 删除的 `tasks/*.output`；报错被贴进另一个会话后找父会话花了好几步。

- **规范 id** = `deriveSubAgentSessionId(taskId)` = `<parentSessionId>-sub-<taskId>`。SubagentStart/Stop 的 `agent_id`、hook scope
  （工具事件的 agent_id）、遥测（本来就是）全部统一；自定义路径用「`custom-<type>-c<seq>`」做后缀，hook / 观测身份 / sidechain
  共用同一个序号（此前各自 `++_customAgentSeq`）。旧形态改名 `legacy_agent_id` 保留一个过渡期。
  消费方 grep：`trace/digest.ts`（按 agent_id 精确配对 Start/Stop，不解析前缀）、`telemetry/hook-probe.ts`（map key）、
  `ttft-cache-buckets` / `latency-by-model`（分组键）——都只做相等比较，不依赖前缀形态；`plugins/` 无消费方。
- `parent_session_id` 传真值；新增 `parent_tool_use_id`：主循环 / 子代理两个工具执行器在 `stripInternalFields` **之后**只给 `sub_agent`
  注入 `_parentToolUseId = block.id`（加入 `INTERNAL_FIELDS`，模型伪造会被剥掉），经 `tool.ts` 透传进 `SubAgentTask`。
- `sidechain_start` 补 `parentSessionId` / `parentToolUseId` / `canonicalAgentId`（文件名仍用 taskId 短键，恢复扫描不变）。
- 残卷 `<output-file>` 改指 sidechain transcript（不会被驱逐，未落盘时才退回旧路径），并追加 `<parent-session>`。
- `scripts/trace-digest.ts <session> --agent <id>`（`trace/agent-view.ts`）：给出「父调用 → Start/Stop → 每条请求」视图；
  接受规范 id、legacy id 或 taskId 后缀，旧轨迹无 parent_tool_use_id 时如实标注，不按时间戳猜。

## 放弃了什么（以及为什么不选）

- 把子代理事件拆到独立轨迹目录：见 `rejected/architecture/2026-10-14-subagent-separate-trajectory-dir.md`。
- 直接把 `agent_id` 换成新形态、不留 legacy：外部 hook 脚本可能按旧形态写了匹配，保留一个周期的 `legacy_agent_id` 成本几乎为零。
- 通过 ALS 传 parent tool_use_id：sub_agent 工具只有两个执行入口，显式注入 + 内部字段剥离比隐式上下文更可审计，也与 `_agentId` 同一套机制。

## 拿什么证明它生效了

- `tests/agent/subagent-canonical-id.test.ts`（走生产入口 `SubAgent.execute`）：SubagentStart/Stop、RetryTelemetry.agentId、
  sidechain_start.canonicalAgentId 同值；`parent_session_id` / `parent_tool_use_id` 与派发方一致；失败残卷 `<output-file>` 指向
  sidechain 且 `evictTaskOutput` 全部任务后仍存在、含 `<parent-session>`；执行器只给 sub_agent 注入且覆盖伪造值。
  变异（已跑）：agentId 退回 `subagent-${type}-${taskId}` → 红；`<output-file>` 退回 `tasks/*.output` → 红。
- 回放旧轨迹：`bun scripts/trace-digest.ts 20261014-110202 --agent aoiyka2wx` 合并出两种旧 id 下的 StreamPhase=19 / RetryTelemetry=12 /
  BilledRequest=9 / Start / Stop，标「无 parent_tool_use_id（旧轨迹）」。
- **未做**：新二进制真机跑子代理后的 jq 关联截图（卡 E1 验收 3），随 beta 补。
