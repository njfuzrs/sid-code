---
Status: implemented
Date: 2026-11-16
Source: goal 模式等待期空转与轮次上限失效 — 修复与验收方案（2026-11-16）
---
# Goal 提示词补上「等待也是推进」，让挂等待后收尾不再被读成偷懒

## 决定了什么

`/goal` 的提示词过去只有一种口径：**继续推进**。模型按 `monitor` / `bash --wait_until_seconds` /
`schedule_wakeup` 挂上等待后，下一轮读到的 goal reminder 仍是「继续推进目标」，
于是把「等 CI」理解成「没在推进」，回前台反复 `gh pr checks` 空转（轨迹里 54 轮 goal 空转的成因之一）。
等待原语的回执明明写着「结果会以通知送达」，两边口径矛盾，模型只能猜。

改动分四处，全部是**文案与判据**，不碰 gate 决策逻辑：

1. `packages/core/src/goal/reminder.ts`
   - `buildFirstTurnPrompt` 把「在满足上述条件之前，系统不会让你停止」换成两条分开的边界说明：
     目标未达成时结束本轮会被评估并推回；但挂着等待源收尾不会被打回。并点名三类原语。
   - `buildGoalReminder(goal, { waitingSources })` 新增等待版文案：有**显式声明**的等待源时，
     不催「继续推进」，改为逐条列出「在等什么、最晚何时回报」，并禁止前台反复查询。
   - `buildResumeTurnPrompt` 补一句「先挂上显式等待再收尾」。
2. `packages/core/src/query/goal-gate.ts` 三段评估反馈模板（未满足 / 疑似不可能 / 疑似卡住）
   各加一条出口：等外部状态不是「无法达成」也不是「卡住」，挂上等待后收尾即可。
3. `packages/core/src/query/loop.ts` 注入点传 `listWaits().filter(isDeclaredExternalWait)`。
4. `describeWaitLine` 从 `query/todo-reminder.ts` 的私有实现提到 `task/wait-registry.ts` 导出，
   todo 与 goal 两侧共用同一措辞；`formatClock`（HH:MM）同步提到 `task/monitor-text.ts`，
   `formatClockWithSeconds` 复用它，避免第三份时钟格式化。

判据刻意用 `isDeclaredExternalWait` 而不是 `hasPromisedWait`：后者把派生子代理 / 普通后台 shell
也算「在等」，但那些承诺的是「自己结束时回报」，不构成「目标在等外部状态」的证据——
拿它当判据，起一个无关的 `bun test` 就能让 goal 以为自己在等。

## 放弃了什么（以及为什么不选）

- **只改提示词、不接等待判据**（无条件写「等待也是推进」）：这样「等到什么程度」「现在在等谁」
  全是空话，模型仍然不知道自己是否已经挂上等待。所以必须把当前等待源清单注入进去。
- **在 `reminder.ts` 内部直接读等待注册表**：`goal/reminder.ts` 保持纯函数（只依赖入参），
  副作用（读全局 registry）留在 `loop.ts`，与 `query/wait-only-state.ts` 同一分层，便于单测。
- **给等待版 reminder 加额外节流**：注入本身已受 `reminderInterval`（默认 4 轮）约束，
  不是每轮重发，再加一层节流是多余的（这也是与 todo reminder 的差别：后者每 8 轮 + 旁路）。
- **不做 G2（goal-gate 的等待放行）**：本文档的 G2 由另一条并行任务实现，本 PR 只交付 G5 文案层。
  两处在同一 PR 合入才完整，所以文案里「挂等待后结束本轮不会被打回」这句话在 G2 合入前**不成立**——
  这是已知的临时不一致，PR 描述里写明了。
- **改 `buildGoalReminder` 的调用签名而不给默认值**：`opts` 可选，其他调用方（测试）不受影响。

## 拿什么证明它生效了

```bash
# 相关单测（含变异自证）
bun test ./packages/core/tests/goal/ ./packages/core/tests/query/todo-gate-wait-sources.test.ts \
         ./packages/core/tests/query/wait-only-state.test.ts
# → 116 pass / 0 fail

# 变异自证 1：把 reminder.ts 的 `if (waiting.length > 0)` 改成 `if (false && ...)`
# → G5 两条断言变红（「不催继续推进」「等待版随等待源变化」），恢复后复绿
# 变异自证 2：把 goal-gate.ts blocked 模板里的「**等待也是推进**」删掉
# → blocked 软提醒用例变红，恢复后复绿

bun run affected-tests:run   # 1908 pass / 0 fail（修正 guidance-events.test.ts 的源码字面量锚点后）
bun run lint                 # 0 warnings 0 errors
bun run format:check         # All matched files use the correct format
bun run lint:boundary        # 包边界干净
bun run lint:command-system  # 四道门禁通过
bun run lint:legacy-tool     # 57 / 基线 57
bun run typecheck:gate       # 无新增类型错误（62 / 基线 62）
make build                   # 构建成功，产物自检通过
bun run verify:agent-note    # 881 份 Agent Note 形态合规
```

一处附带修正：`packages/core/tests/query/guidance-events.test.ts` 用
`loop.indexOf("reminderParts.push(buildGoalReminder(goal));")` 断言接线位置，
调用签名扩展成多行后该字面量不再命中。锚点改为 `buildGoalReminder(goal,`——
这条测试验的是「push 之后紧跟事件」的接线关系，不该被参数个数变化打红。
