---
Status: implemented
Date: 2026-11-07
---
# schedule_wakeup 改为单链语义、注入前判过期、定时 prompt 打来源标记

## 决定了什么

会话 `20261107-095213-ff96d1f2` 里，模型一轮内调了 5 次 `schedule_wakeup`，产生 5 个并存任务；
目标在 02:38 达成后仍有 4 次触发，每次都跑一整轮带 ~300 条消息的主循环。三块改动一起修：

**F1 单链语义** —— `Scheduler.replaceSessionTasksByOrigin(task)`：新建时删掉本会话里
同 origin 的会话级一次性任务，被删的 id 记进 `supersededIds`。`schedule_wakeup` 改用它
（不再走 `addSessionTask`），工具描述与返回文案同步写明「本会话同时只保留一个待触发的唤醒」，
并把被替换的 id 回给模型（免得它去 `cron_delete` 一个不存在的 id）。上限判定排除即将被替换的任务，
否则 50 个积压时连「替换」都做不了。

**F2 注入前判过期** —— `App.injectScheduledPrompt` 在调用注入器前问一句
`getScheduler().isSuperseded(taskId)`，命中就发 `ScheduledInject{outcome:"dropped_superseded"}`
并丢弃。覆盖 F1 到不了的窗口：旧唤醒已经 fire、进了宿主队列，之后才被新唤醒替换——
那时它已不在 `sessionTasks` 里。判据来自调度器的事实，不是宿主推断「排在后面的更新」
（两条唤醒可能因 lag 不同而乱序进队）。只对 `origin=schedule_wakeup` 生效。
`digest` 把 dropped 单独计成 `scheduledDropped`，**不进** `scheduledInjects`——
后者与 `scheduledFires` 对账，混进去对账永远差几条且无从归因。

**F3 来源标记** —— 三处同时生效，单一事实源在 `packages/core/src/query/scheduled-prompt.ts`：
- user 消息打 `_meta.origin = "scheduled-prompt"`（+ 任务 id + 来源），`history-adapter` 分流成
  新 `HistoryItem{type:"scheduled"}`，由 `ScheduledPromptMessage` 渲染成
  `› 定时唤醒 · a825f8ab · <prompt 首行>`（`›` vs `>`，次级色 vs 正文色，双通道区分）；
- 喂给模型的文本首行加一行来源头（模型不必再猜「这条哪来的」——本例 thinking 里猜了 4 次，
  每次都重跑了完整检查）；
- `UserPromptSubmit` hook 载荷带 `source: "scheduled"` + 任务 id/来源（增量字段，老 hook 不受影响），
  但 `prompt` 仍是**原始文本**（来源头在 hook 之后才拼）。

`INTERNAL_RENDER_ORIGINS` 登记 `"scheduled-prompt"`，**刻意不进** `INTERNAL_ORIGINS`：
整条隐藏会让用户看不到「刚才那轮是唤醒触发的」，那比多显示一行更吓人。

系统提示词（中英）与工具描述同步写明单链语义 + 达成后用 `cron_delete` 撤掉剩下的那个。

## 放弃了什么（以及为什么不选）

**按「链 key」允许多条并行唤醒**（给 `schedule_wakeup` 加可选 `chain` 参数，同 key 替换、
不同 key 并存）。目前没有任何轨迹出现过「一个会话同时跑两条自适应轮询」；让模型自己管 key
只会把「忘了撤销」变成「忘了用同一个 key」，失败形态完全一样。真有并行需求时 `cron_create`
（有显式 id、可 list/delete）是更合适的工具。**代价**：两条 `/loop`（动态模式）同时跑时，
后一个会替换前一个的唤醒；这一条写进了 PR 正文。

**只改提示词让模型「别重复调用」**。本例模型的 thinking 里多次自我提醒「不要再查 CI」，
照样调了 5 次。声明式约束模型不可靠，机制必须在工具层强制，提示词只作辅助。

**目标达成后自动撤销剩下的唤醒**。harness 判断不了「目标达成」，任何启发式（回复里有「已完成」、
没有工具调用……）都会误杀需要继续轮询的场景，误杀后果（轮询静默中断、用户以为还在等）
比多一轮空跑更严重。本期靠 F1 压到「最多 1 个」+ 返回文案给 `cron_delete` 提示，
用两周后的数据决定要不要机制化。

**唤醒忙时到期就丢弃（不延后）**。会话忙时到期的正确语义就是「空闲后尽快执行」，
积压的问题出在**数量**不在**延后本身**。F1 解决数量后，延后是正确行为。

**只在 TUI 层改显示、不动喂给模型的文本**。本例模型的来源推测每次都花了 thinking，
且仍重跑完整检查。只改显示修好的是用户那一半，模型那一半仍是 bug。

**把方案文档写的「stale_fires=4」当验收硬指标**。按方案 §2.3 自己写的判据
（两次 fire 之间无 create）以及「fire 对应最近一次 create」的配对口径，实测**都是 3**
（见下段）。第 4 次是 `dcd5`——它是最后一次 create 建的任务，两套可机械判定的口径都放它过关，
而「目标达成时刻」在事件里没有字段可判。脚本两套判据都打印，不硬凑数字。

## 拿什么证明它生效了

**单测**（全部通过）：

- `packages/core/tests/cron/schedule-wakeup-single-chain.test.ts` —— T-F1-1..8：8 pass
- `packages/cli/tests/app/scheduled-inject.test.ts` —— 原 3 例 + T-F2-1..3 / T-F3-1：8 pass
- `packages/cli/tests/ui/scheduled-prompt-render.test.tsx` —— T-F3-4/6/7/8 + 来源头：14 pass
- `packages/core/tests/trace/trigger-digest.test.ts` —— T-F2-4：15 pass
- `packages/core/tests/query/scheduled-prompt-wiring.test.ts` —— 引擎接线契约：8 pass

**变异自证 M1–M7**（每项先改坏、跑、记录红了什么、再恢复）：

| 变异 | 结果 |
|---|---|
| M1 `schedule-wakeup` 改回 `addSessionTask` | 红 7 例（T-F1-1..7） |
| M2 替换的 filter 去掉 `t.origin === origin` | 红 2 例（T-F1-4、T-F1-5） |
| M3 删掉 superseded 判断 | 红 1 例（T-F2-1） |
| M4 engine 不打 `_meta` | 红 1 例（接线契约「走 buildScheduledMessageMeta」） |
| M5 `scheduled-prompt` 挪进 `INTERNAL_ORIGINS` | 红 4 例（T-F3-4 ×3、T-F3-8） |
| M6 兄弟块无条件丢（`filter(() => false)`） | **首次跑全绿 → 断言不够强**，改成断言「status=success 且 resultDisplay 带结果正文」后重跑红 1 例（T-F3-6） |
| M7 digest 把 dropped 也计入 `scheduledInjects` | 红 1 例（T-F2-4） |

M6 那一轮是本轮最值钱的发现：原来的 `expect(status).not.toBe("pending")` 兜不住，
因为末尾的 `pendingToolCalls` 兜底本身也会产出一个 `tool_group`（状态是 `executing`）——
「兄弟块被吞」被伪装成了通过。

**轨迹回放**（`scripts/wakeup-audit.ts`，只读）：

```
20261107-095213-ff96d1f2: create=5 fire=5 stale=3(literal 3) replaced=0 dropped=0 max_pending=4 deleted=0
20261106-191129-1b995491: create=1 fire=1 stale=0(literal 0) max_pending=1
20261106-214809-a9dd062e: create=1 fire=1 stale=0(literal 0) max_pending=1
20261107-094412-067218f8: create=1 fire=1 stale=0(literal 0) max_pending=1
```

与方案 §2 的手工结论一致（create/fire/max_pending），唯一差异是 `stale` 3 vs 文档的 4（原因见上段）。

**门禁**（全部本地跑过）：

- `bun run typecheck:gate`：62 处 / 基线 64 处，无新增
- `bun run lint` / `format:check` / `lint:boundary` / `lint:command-system` / `lint:legacy-tool`：全绿
- `bun run affected-tests:run`：9946 pass / 2 fail。两个失败均为 `tests/build/rules-paths-scope-nonempty.test.ts`
  在 worktree 下的假失败，三条举证齐全：① 该测试只 import `core/config/rules.ts`，不 import 本次改动的模块；
  ② 主仓同 HEAD 单跑 3 pass；③ 成因已定位——`ruleOwnerDir` 在 worktree 里解析到**主仓根**
  （`.git` 是 gitdir 指针文件），`relative(REPO, ownerAbs)` = `../../..` → `candidates` 恒为空。
- `make build`：成功，且 grep 无 `will always be undefined` 告警
- `bun run smoke`：7 例全过（改了 hook 载荷与工具执行链，按 CLAUDE.md 必跑）

**没做到的**：两周后的真实指标（`wakeup_stale_fires / 有 schedule_wakeup 的会话数` 目标 0、
`max_pending_wakeups` p99 ≤ 1）还没数据；上表只证明「旧轨迹能复现、新逻辑单测与接线成立」，
不证明线上的空跑真的归零。
