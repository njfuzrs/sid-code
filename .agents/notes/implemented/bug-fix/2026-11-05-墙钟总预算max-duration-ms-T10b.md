---
Status: implemented
Date: 2026-11-05
---
# 给主循环加墙钟总预算：`--max-duration-ms` → `error_max_duration`

## 决定了什么

新增 `-max-duration-ms`（`Config.maxDurationMs`）：进程级墙钟预算，到点前走**既有的**强制总结出口，
产出 `done.incompleteReason = "max_duration"` → SDK `subtype = "error_max_duration"`。

改动落点（每条都是「不接就是静默失效」的位置）：

| 文件 | 改了什么 |
| --- | --- |
| `packages/core/src/config/config.ts` | `maxDurationMs?: number`（0/undefined = 不限） |
| `packages/cli/src/cli.ts` | flag 定义 + 正整数校验 + 映射 |
| `packages/core/src/query/types.ts` | `LoopState.deadlineAt`；`DoneIncompleteReason += "max_duration"` |
| `packages/core/src/query/loop.ts` | 入口算 `deadlineAt`（基准是**进程启动**）、while 顶部检查、`willRunForcedSummary` / `emitTurnCompleteHere` / 收尾段三处判据 |
| `packages/core/src/query/turn-complete.ts` | `TurnStopReason += "max_duration"` |
| `packages/core/src/sdk/message-converter.ts` | `max_duration → error_max_duration` + 文案 |
| `packages/core/src/sdk/schemas.ts` | enum 加 `error_max_duration` |
| `packages/core/src/query/defense-registry.ts` | `INCOMPLETE_ANCHORS` 加条目（tsc 的 `Record` 会拦漏接） |
| `packages/core/src/trace/collector.ts` | `hitMaxDuration` + `recordMaxDuration()` + `exit_status` 派生 |
| `packages/core/src/query/engine.ts` | 把 `done.incompleteReason === "max_duration"` 上报给 collector |
| `packages/cli/src/headless-exit.ts` | 与 `max_turns` 同口径：不算未完成、退出码 0 |
| `evals/external-benchmarks/harbor/sid_code_agent.py` | `CliFlag("max_duration_ms")`，值由**调用方**传（适配器拿不到 Harbor 的 timeout） |

### 为什么是这条预算，而不是调 `--max-turns`

从 agent-traj-bench 归档 run 包（`2026-09-13__19-35-38.tar.zst`）解出 T0010 / T0051 / T0059
三条的**原始** `session.traj` 后定论：

| task | 主循环轮次（`last_known_state.turn`） | API 调用数 | 旧读法 `total_steps` | 实际墙钟 | 硬顶（timeout×3） | 成本 |
| --- | --- | --- | --- | --- | --- | --- |
| T0010 | **110** | 109 | 370 | 8007s | 8100s | $1.174 |
| T0051 | **108** | 107 | 342 | 8020s | 8100s | $1.057 |
| T0059 | **100** | 99 | 436 | 5355s | 5400s | $0.877 |

三条都满足 `turn = api_calls + 1`，即自增后那次请求还没发出就被 kill。
**轮次从未触及 120、成本从未触及 $1.8** —— 两个预算都挡不住这一类，真凶是墙钟。
所以这不是「把 max_turns 调大/调小」，而是补一个**正交**的预算。

## 放弃了什么（以及为什么不选）

1. **降 `max_turns` 到 100 凑判据**（让三条刚好撞上限）。
   否决：那是调参凑判据，且会同时改变整个题集基线；更根本的是它把「时间不够」
   伪装成「轮数不够」，归因方向错一步（`evals/CLAUDE.md` §3.10）。
2. **只修仪器口径，不改终止行为**。
   否决：三条仍以 `AgentTimeoutError` 结束，与「能力不足」在数据上仍不可区分 ——
   而那正是 T10b 要消灭的形态。
3. **让适配器自己算 timeout**（按「一分钟猜一个」）。
   否决：Harbor 的 `_compute_agent_timeout_sec()` 在 `trial/trial.py` 里，agent 实例拿不到；
   自己算等于造第二个事实源。改由跑批脚本传 `--ak max_duration_ms=<硬顶×0.9>`，
   留 10% 给强制总结轮 + SessionEnd 落盘。
4. **新增第二条收尾路径**。
   否决：与 `maxTurns` / `stalled` 共用同一个强制总结出口（§5 决策 1 第 1 条：不新造机制）。
   这条预算是**加判据**，不是加流程。
5. **把 `error_max_duration` 合进 `error_max_turns`**。
   否决：两者修法相反（一个调轮数、一个查外层硬顶给得够不够）。混成一个值，
   看到它的人会去调一个与真凶无关的参数。

## 拿什么证明它生效了

- **单测**：`packages/core/tests/query/max-duration-budget.test.ts`，6 pass / 0 fail。
  覆盖：到点后 `incompleteReason === "max_duration"` 且**不产出** `max_turns`；
  `turns` 不自增（不白占一格预算）；到点后仍跑强制总结且提示措辞是「时间预算」；
  不设预算时行为与改动前逐字一致；subtype 映射三值互不串台。
  ⚠️ 第一版写下时 3 条断言全红——原因是「直接传 `maxDurationMs: 1`」：
  它的基准是**进程启动时刻**，而测试进程已跑了几秒，于是第 1 轮都进不去。
  改成 `budgetExpiringIn(ms)` 后转绿。这条记在这里，免得下一个人重踩。
- **变异自证**（三类，恢复后 6/6 全绿）：
  ① 把 `deadlineAt` 检查改成恒假 → 3 条红；
  ② 删掉 converter 的 `max_duration` 分支 → 2 条红；
  ③ 把 subtype 分支抠成恒返 `error_max_duration` → 「同类项」那条红。
- **`.py` 改动的 TS 侧门禁**（`evals/CLAUDE.md` §4.1）：
  `tests/eval/harbor-agent-contract.test.ts` 新增断言（cli 名 / type=str / env_fallback / 无 default）
  + 三条变异自证（改 cli 名 / 删 fallback / 删整块）。该文件 52 pass / 0 fail。
- **门禁**：`bun run lint` 0 error；`bun run format:check` 通过；`bun run typecheck:gate` 无新增。
- **待真跑验证**：三题小跑（T0010/T0051/T0059）的结论见下方「真跑记录」——
  在拿到 `subtype=error_max_duration` 的产物前，上面只证明「接线通了」，
  **不证明「那三条真的干净终止了」**（`evals/CLAUDE.md` §6 第 1 问）。

## 真跑记录

（本节在小跑完成后回填：实际命令、指纹、逐题 subtype、成本。）
