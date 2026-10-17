---
Status: implemented
Date: 2026-10-17
---
# 子代理去掉墙钟 / 硬 kill / 默认 maxTurns，超时与重试和主循环同构（对齐 CC）

## 决定了什么

- **删墙钟体系**：`timeout-budget.ts`（p95 派生、样本、`HARD_KILL_MULTIPLIER`）与 `sleep-aware-timer.ts` 整个删除；
  `sub-agent.ts` 内置 / 自定义两条路径不再有 detach 定时器与硬 kill；`AgentDefinition.timeout`、
  `SubAgentTask.timeout`、`CustomSubAgentTask.timeout`、spawn 协议 `timeout` 字段删除。
  自定义代理 frontmatter `timeout`、skill `timeoutMins` 改为「解析到就 warn 一次并忽略」。
- **删默认 maxTurns**：`resolveSubAgentMaxTurns` 未声明时返回 `Infinity`（⛔ 不能是 undefined：
  `while (turns < undefined)` 恒 false，一轮都不跑）。fork 的 200、常规的 30、skill 的 `|| 30` / `min(…,50)`、
  命令 fork 的 `?? 30` 全部删除；显式声明仍生效。
- **单一超时源**：子代理调漏斗显式传主循环同一个 `fallbackStreamTimeoutMs`（600s，收到内容即续期），
  不再吃 side-call 的 180s 缺省档。
- **S2b 单轮硬超时兜底**（新 `agent/turn-hard-timeout.ts`）：`processStream` 外包 `Promise.race`，阈值复用主循环
  `maxTurnDurationMs`（90min），扣休眠，触发 → 计入同一重试计数并重试。它只防 abort 链路失效导致的永不 settle，
  不是总时长限制。⚠️ 计时口径已在收尾 PR 改为「连续无流事件」，见
  `implemented/bug-fix/2026-10-17-子代理单轮兜底改无事件计时-PR-B收尾.md`。
- **spawn 路径同口径**：父进程 kill 定时器、子进程 `process.exit` 定时器删除；`maxRetries: 3` 改为 `maxTimeoutRetries`；
  子进程同样有 S2b 兜底；`max_turns` 省略即无上限。
- **会话退出回收**：`agent-task.ts` `abortAllAgentTasks()` 以 `subagent-session-exit` reason abort 全部在跑的子代理，
  注册为 pre-flush shutdown hook；收尾走子代理自己的「被中止」出口（残卷 + SubagentStop）。
- **归因**：`classifySubAgentFailure` 去掉 `detached` / `hardKilled` / `canDetach`，`SalvageReason` 只剩 `aborted` / `error`。

总量控制只剩 ESC / `task_stop` / 父代理取消，与 CC 一致。

## 放弃了什么（以及为什么不选）

| 方案 | 为什么不选 |
| --- | --- |
| 墙钟 300s → 600s / 900s | 只是把同样的浪费翻倍；事故 20261016-222758 的死法是 900s 硬 kill，任何固定值都会被足够慢的上游击穿 |
| 继续用 p95 派生预算 | 冷启动并行时恒不生效（两起事故都是 `来源 definition`）；判据仍是「过了多久」而不是「有没有推进」 |
| 只修 idle 层旧标志，其余不动 | 修得了任务二，修不了任务一（硬 kill）和 a3v2fn6md 的 30 轮截断——#284 的教训：逐层补，下一层还在 |
| CC 的 90s idle 看门狗原样照搬 | 第三方网关慢首字节实测可达 102.8s，90s 会误杀；取主循环已线上验证的档位，保留 CC 的语义（单层、触发即重发） |
| fork 子代理保留 200 轮 | 全库从未有子代理跑到 100 轮；fork 续写主对话而主循环不限轮数；失控防护由 ESC / task_stop 承载 |
| 加「单次请求 600s 硬顶」 | CC 的 `API_TIMEOUT_MS` 语义是等响应头（sid 对应 `headerTimeoutMs`）；整请求硬顶会把正常长流杀掉重来、每次重试都再撞上 |
| 给子代理另起一个单轮兜底阈值 | 那就是又一层 L6；必须复用主循环 `maxTurnDurationMs` |

## 拿什么证明它生效了

- `bun run typecheck:gate`：66 / 基线 66，无新增。
- `bun run test`：全量通过（含新增 `packages/core/tests/agent/subagent-no-limits-pr-b.test.ts`：S2b 永不 settle 时让出并以
  `turn-timeout` abort、正常完成不开枪、被让出 run 的迟到 reject 不成孤儿；S5 会话退出 abort；已删模块不得长回来）。
- `sub-agent.test.ts`：慢 provider 不 abort 时正常完成（墙钟复活即红）；外层 abort 交回残卷且不含「墙钟」。
- `resolveSubAgentMaxTurns({})` 为 `Infinity`，`0 < Infinity` 断言锁住 undefined 陷阱。
- 端到端（并行 explore × 3 + 人为制造上游卡顿，`SubagentStop` 全 completed，失败率回到 < 5%）待 beta 后按方案 §7 补。
