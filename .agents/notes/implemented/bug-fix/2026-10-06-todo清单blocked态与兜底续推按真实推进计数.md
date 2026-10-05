---
Status: implemented
Date: 2026-10-06
---
# todo 清单新增 blocked 态，end_turn 兜底按真实推进计数，SessionEnd 只派发一次

## 决定了什么

缺陷现场：会话 `20261005-233851-9b91e1b7`（glm-5.2）。清单 5 项，前 2 项完成，后 3 项需要 sudo 密码（bash 工具没有 tty）。模型如实停下来等用户执行命令，end_turn 兜底却拦了 7 次（`LoopTransition:todo_gate_retry` 共 7 条），模型把「需要 sudo，请执行命令」同义重复了 7 遍，最后还弹出红字「⚠️ 仍有 3 项任务未完成」。

- **todo_write 新增 `blocked` 状态**（`tool/todo-write.ts`）。它表示「卡在 agent 无法自行完成的外部条件上」，下一步动作的主语是用户。工具描述教模型三件事：何时用 blocked；把「部分能做、部分要用户做」的事拆成两项；标了 completed 又要返工时，先改回 in_progress。
- **兜底不再拦 blocked**（`query/todo-reminder.ts` `countUnfinished`）。只剩 blocked 时直接放行，给用户一条中性说明「N 项在等你操作」，同一批 blocked 项只说一次。周期回注、work-log、子代理兜底共用同一判据，也都不再催 blocked。
- **续命预算按完成数复位，挂到 SessionState**（`TODO_GATE_BUDGET_KEY`）。旧实现有两个漏洞：
  - writeVersion 一变就清零。现场第 4 次写入只给剩余项加了「需 sudo」备注（完成数仍是 2/5），预算被清零，同一条消息里拦了 4 次，上限本是 3。
  - 预算挂在 LoopState 上，每条用户消息都会重建。用户追问一句，又拦满 3 次。

  现在只有完成数或总项数变化才复位；续命耗尽的提示在同一清单状态下只呈现一次。
- **「标完成后又返工」检测**（新增 `query/todo-rework.ts`）。现场第 2 项在 16:07 标了 completed，16:17 又改了同一个脚本，这 10 分钟清单一直把没改好的代码显示成「已完成」。实现方式：每次 todo_write 时，把这段时间落盘的文件归到本次新完成的项上；之后同一文件被再次成功编辑，就注入一次提醒，并落 `TodoReworkDetected` 事件。只提醒不拦截，同一 (项, 文件) 只提醒一次。
- **展示与度量**：TodoPanel、`/todos`、progress 落盘都单列 blocked（字形 `◌` + warning 色），标题追加「N 项等你操作」，这样 2/5 不会被读成「agent 还剩 3 项没做」。`TodoProgressAdvanced` 增加 `blocked` 字段；digest 的 todo 节增加 blocked 终态和返工次数。
- **SessionEnd 防重入**（`hook/event-handler.ts`）。同时排查的第二个会话 `20261005-234012-b45f9ea6` 不是原任务被拆出来的，而是另一个独立进程（只收到一句「你好」，请求 Connection error）。它关窗口时出了问题：SIGHUP 派发 SessionEnd(abort)，22ms 后卸载 TUI 写死终端，触发 EIO → uncaughtException，emergencySessionEnd 又派发了一次 SessionEnd(error)，把 exit_status 覆盖成了 error。现在按 sessionId 去重，先到者为准；/clear 换新会话后不受影响。

## 放弃了什么（以及为什么不选）

- **把 blocked 项自动视为完成，或让模型把它们标成 completed**：那是谎报。现场 16:22 的只读检查证明，hosts 仍然钉在坏 IP，问题没修好。
- **兜底整体放宽（例如有 200 字以上产出就放行）**：现场等用户时的回复只有几十个字，放宽阈值治不了这个问题，还会放过真没做完的情况。根因是状态表达力不够，所以加状态而不是调阈值。
- **只把预算挂 SessionState、复位口径仍用 writeVersion**：只改措辞的写入照样会把预算清零，第 4 次那种越过上限的情况还会复现。
- **返工时硬拦截或自动把项改回 in_progress**：harness 判断不了这次编辑是在返工那一项，还是下一项顺手碰了同一个文件，所以只给条件式提醒，由模型判断。
- **为两个轨迹做「合并」**：它们本来就是两个进程、两个任务，合并反而错。真正的缺陷只是终态被覆盖。

## 拿什么证明它生效了

- 新增用例共 18 个，全部通过：
  - `bun test packages/core/tests/query/todo-gate-blocked-handoff.test.ts`：6 pass。复刻现场清单：全 blocked 时只调用 1 次 LLM、无续推、无红字；跨用户消息不重复说明；只改措辞不复位；新消息不重新拦满；完成数增长才复位。
  - `bun test packages/core/tests/query/todo-rework.test.ts`：5 pass。
  - `bun test packages/core/tests/tool/todo-write-blocked.test.ts`：5 pass。
  - `bun test packages/core/tests/hook/session-end-once.test.ts`：2 pass。
- 变异自证，均为改坏后变红、恢复后转绿：
  - 把 `unfinishedTodos` 改回包含 blocked → blocked-handoff 用例 4 pass / 2 fail；
  - 去掉 SessionEnd 防重入 → 1 pass / 1 fail；
  - 让预算每次都复位 → 2 pass / 4 fail。
- 回归测试：core 的 agent/hook/query/tool/trace 3192 pass / 0 fail；cli 1689 pass / 0 fail。
- `tsc --noEmit -p .`：错误数 73，与 main 相同，没有新增。
