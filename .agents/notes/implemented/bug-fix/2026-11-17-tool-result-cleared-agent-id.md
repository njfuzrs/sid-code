---
Status: implemented
Date: 2026-11-17
Source: 只读子代理空转与过期清理重读循环-修复与验收方案（2026-11-16）§6 PR1 / §3.5 缺陷 O1
---
# `ToolResultCleared` 带上 `agent_id`，让子代理侧的清理在轨迹上可归因

## 决定了什么

`packages/core/src/query/guidance-events.ts` 的 `emitToolResultCleared` 在**子代理作用域内**
给事件补一个 `agent_id`，取值走 `currentHookAgentScope()?.agent.agent_id`——与
`PreToolUse.agent_id`、`ReadHint.agent_id` 同一个 ALS 口径。**主循环（作用域外）不带该字段**，
事件形态与改动前逐字节一致。

三个 stage（`tool_result_budget` / `microcompact` / `stale_clear`）共用这一个函数，
所以改一处就全覆盖；没有为任何一个 stage 单独加参数。

为什么把它排在批 1 最前：后续每个 PR 的端到端验收都要回答「子代理侧的清理降下来没有」。
改动前四个会话的 `stale_clear` 事件分别是 30 / 22 / 20 / 13 条，**全部不带 `agent_id`**，
在轨迹上与主会话干的没有区别，只能靠时间对齐推断。这是纯可观测前置：不改清理行为本身。

## 放弃了什么（以及为什么不选）

1. **放弃在 `emit()` 里统一加身份判断。** `emit` 是六个引导事件共用的纯转发层，在这里加会
   一次改掉 `OmissionRejected` / `CredentialInContext` / `WebFetchModelUrl` / `MemoryGuard` /
   `ForegroundSleepGuided` 的字段形态。这五个事件没有「需按子代理归因」的已验证需求，
   却都有下游对账（analytics 的 `memory_guard` 字段镜像、`aftereffect-report.test.ts`
   按现有形态取数），多改一处契约就多一处要跟着改。方案只要求这一个事件，就只动它。

2. **放弃从三个调用方层层传参**（`context/manager.ts:899`、`query/compact/tool-result-budget.ts:106`、
   `query/compact/microcompact.ts:268`）。它们都跑在同一条异步链上，ALS 已经取得到；
   传参要改三个签名 + 全部测试调用点，漏一处就是「一半事件带 id、一半不带」且零报错——
   这正是 `hook-agent-context.ts` 头注释里记录的教训（子代理工具执行有三个入口，
   漏一处就是静默的一半路径）。

3. **放弃为 `stale_clear` 单独造一个 ContextManager 级的测试。** 三个 stage 走同一个 emit，
   身份取值是这一层的逻辑、与 stage 无关；已用 `tool_result_budget` + `microcompact` 两条
   覆盖「作用域内有 / 作用域外没有 / 跨 stage 一致」。`stale_clear` 的真实归因要等方案的
   E1（§8.4 S-A/S-B/S-C 三场景），那不在本 PR 内，也不伪造。

## 拿什么证明它生效了

**一、G1 三条断言 + 变异自证**（先把代码改坏、看到对应断言红、再恢复）：

- `bun test ./packages/core/tests/query/guidance-events.test.ts` → **17 pass / 0 fail**
  （其中新增 3 条：作用域内带 `sub-abc`、作用域外 `"agent_id" in data === false`、
  `microcompact` 在作用域内也带 `sub-mc`）
- 变异：把 `const agentId = currentHookAgentScope()?.agent.agent_id;` 换成 `undefined`
  → **15 pass / 2 fail**，红的正好是「作用域内带 `agent_id`」与「microcompact 也带」两条，
  另 15 条（含「作用域外不带」）仍绿。恢复后回到 17 pass / 0 fail。

**二、门禁**（worktree `feat/pr1-tool-result-cleared-agent-id`）：

- `bun run affected-tests:run`：**1293 pass / 0 fail**（选中 `packages/core/tests/query/`）
- `make build`：通过，5 项产物自检全绿
- `bun run smoke`：**42 例 42 通过 / 0 失败 / 0 跳过**
- `bun run lint` 0 warnings 0 errors；`bun run format:check` 通过
- `bun run lint:boundary` 越界依赖 0 处；`bun run lint:command-system` 四道门禁通过；
  `bun run lint:legacy-tool` 57 / 基线 57
- `bun run typecheck:gate`：当前 62 处 / 基线 62 处，无新增
- 全量 `bun test`：**未纳入本地验收**。按 CLAUDE.md「选测与 PR 化必须成对」的约定，
  本 PR 的本地覆盖用 `affected-tests:run`（1293 pass / 0 fail），全量由 CI 在合并前跑。

**三、一条诚实的边界**：G1 证明的是「子代理作用域内调用 emit 会带上 `agent_id`」，
**不等于**真实会话的 `events.jsonl` 里已经出现了带 id 的 `stale_clear`。后者要跑方案
§8.4 的 E1（主/子两侧同时清理，看能否靠 `agent_id` 分开），本 PR 没做、也没写成已做。
