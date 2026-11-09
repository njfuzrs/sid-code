---
Status: implemented
Date: 2026-11-09
---

# task_stop 能真正终止 monitor，未识别的任务类型不再假装成功

## 决定了什么

修 review 文档《20261109-等待态四PR合入后review缺陷-修复与验收方案》的 D1（P0，来源 PR #683）。

- `packages/core/src/tool/task-stop.ts` 的分派补齐第四个类型：`else if (isMonitorTask(task)) killMonitorTask(task.id)`。
  此前 monitor 落空后直接走到写死的 `status: "killed"`，工具回「已终止」而进程继续跑、继续发事件，
  而 monitor 的工具结果本身写着「提前停止：task_stop m…」（`tool/monitor.ts`），模型正是照这句话操作。
- **兜底分支改为报错**：剩余类型返回 `isError: true` +「不支持终止该类型任务（type=…）」，
  不再无条件回成功。这条防的是下一个新增任务类型重演 D1 的「假成功」。
- 返回体的 `status` 从 `getTask(id)` **实读**，不再写死 `"killed"`：各 kill 路径的最终状态可能不同
  （并发下可能已被别的出口写终态），写死会让返回值与事实脱节。
- `description()` 补上 Monitor，并按仓库约定重跑 `bun run docs:gen-reference`（`website/ref/tools.md`）。
- 新增 `packages/core/tests/tool/task-stop.test.ts`，三条断言全部从真实入口 `new TaskStopTool().execute()` 进：
  1. monitor 用例：状态 `killed`、进程组 `kill(-pid, 0)` 抛 `ESRCH`、终态通知恰好一条且文案含 `task_stop`；
  2. 类型穷举：`Record<TaskType, …>` 标注 + `ALL_TASK_TYPES` 逐类用真实构造路径
     （`spawnShellTask` / `createAgentTask` / `createWorkflowTask` / `spawnMonitorTask`）起 running 任务，
     逐个 `execute` 断言进终态、返回值 status 与 registry 一致；
  3. 兜底用例：构造一个分派表不认识的类型，断言 `isError: true` 且任务状态**没有**被改成 killed。

## 放弃了什么（以及为什么不选）

- **只补 monitor 分支、兜底保持回 `killed`**：下一个新任务类型会原样重演 D1——工具说停了、
  实际没停，而且这种错误只在生产路径上显形（旧测试直调 `killMonitorTask` 就一直是绿的）。
  兜底报错是这条缺陷唯一的结构性防线。
- **在 `TaskStopTool` 里调 `killAllRunningTasks()`**：那是「终止全部后台任务」的语义
  （Ctrl+F / 会话退出用），`task_stop` 只该停指定的那一个，套用会连用户正在等的子代理一起杀。
- **给 `TaskState` 联合加 `never` 穷举编译期检查**：`execute` 的参数是 `unknown`、任务实例来自 registry，
  编译期拿不到窄化后的联合；运行时穷举用例才是这条守卫的落点。
- **只写 monitor 一条用例、不写类型穷举**：D1 与 D17 是同一类「按类型分派漏写」，
  一条用例只能锁住 monitor 这一格；穷举用例让下一个新增类型漏分派时当场红。
- **顺手修 D2 / D3 / D15（monitor 终态丢事件、暂存行无定时冲刷、孙进程占 stdout）**：
  方案文档把它们与 D1 同归 FIX-2，但那是 `monitor-task.ts` 的大改，与本次
  「task_stop 分派」不是同一处代码、也不是同一个验证面。本次只交付 D1，
  分支与 PR 单独一个，回滚互不牵连。

## 拿什么证明它生效了

- `bun test ./packages/core/tests/tool/task-stop.test.ts` → **3 pass / 0 fail / 30 expect**。
- 变异自证（两次都把修复改坏、确认对应断言红，再恢复）：
  - 删掉 monitor 分派 → monitor 用例失败于 `status` 仍为 `running`，穷举用例失败于
    `isError: true`（`type: "local_monitor"`）；兜底用例仍绿；
  - 兜底改回无条件成功 → 兜底用例失败于 `expect(result.isError).toBe(true)` 收到 `undefined`。
- 门禁：`bun run format`、`bun run lint`、`bun run format:check`、`bun run lint:boundary`、
  `bun run lint:legacy-tool`、`bun run lint:command-system`、`bun run typecheck:gate`
  （无新增类型错误）、`bun run docs:gen-reference`、`bun run affected-tests:run`
  （1586 pass / 1 skip / 0 fail）全部通过；`make build` 成功且产物自检通过。
- 线上观测量（方案 §5.3 D1 行）：`task_stop` 的 tool_input 指向 monitor id 后，后续不再出现该 id 的事件。
  本次只交付代码与回归门禁，线上抽样留待 E2E-5（方案 §7.2）按方案统一做。
