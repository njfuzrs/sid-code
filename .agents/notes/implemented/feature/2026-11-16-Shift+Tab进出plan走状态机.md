---
Status: implemented
Date: 2026-11-16
Source: 权限模式对齐 claude-code：缺陷修复与验收方案（2026-11-12）
---
# Shift+Tab 循环纳入 plan，键盘入口改走 plan 状态机

## 决定了什么

**plan 回到 Shift+Tab 循环里**，且键盘进 plan 走与 `enter_plan_mode` 工具同一条状态机路径。

改动落在三处：

1. `packages/core/src/permission/mode.ts` 的 `getNextKeyboardPermissionMode` 不再无条件跳过 plan，
   只剩「跳过企业策略禁用的档」。循环变为 `default → acceptEdits → plan → auto →(always-allow)→ default`。
2. `packages/cli/src/app.ts` 的 `cyclePermissionMode` 改成 async，按 plan 状态机三态分流：
   - `isPlanning()`：视为**放弃规划**，与审批框「取消」同一出路
     （`forceExit("cancel", {source:"command"})` + `deactivatePlanMode(next)`），再落到 plan 的下一档；
   - `isAwaitingApproval()`：**不响应**，提示「计划已提交审批，请在审批框里选择」；
   - 目标是 plan 时：`planManager.enter(当前模式, undefined, "keyboard")` + `activatePlanMode()`，
     而不是只改 `config.permissionMode`。
3. `packages/core/src/plan/state.ts` 的 `PlanEntrySource` / `PlanTransitionMeta.source` 加 `"keyboard"`，
   让「用户按了两下 Tab」和「模型自己调工具」在轨迹里可分辨；
   同时 `resetPlanStateForClear`（`/clear`）把 keyboard 与 tool 一视同仁地恢复权限模式
   —— 两者都是用户主动进入、都记了 `prePlanMode`。

配套：官网 `website/use/permissions.md` 的循环顺序与 plan 态按键语义重写；
smoke 框架给 TUI 剧本加 `shift-tab` 键（`\x1b[Z`，与 `packages/tui` 里 `shiftTab` 同字节）。

## 放弃了什么（以及为什么不选）

- **继续把 plan 排除在循环外**（PR-5 之前的状态）。否决理由：排除它是因为「键盘只改字符串会造出
  假 plan 态」——那是**实现缺陷**，正确修法是让键盘入口也走状态机，而不是把一整档从循环里摘掉。
  摘掉后用户少一档，且与 claude-code 的 Shift+Tab 语义不一致；`website/use/permissions.md`
  还照着手抄的测试把「plan 不在循环里」写成文档事实。
- **键盘进 plan 只 `setPermissionMode("plan")` + `tuiStateUpdater({isPlanMode:true})`**。
  否决理由：这是更彻底的假象——状态栏亮起 `[PLAN]`、屏幕断言也会绿，但 `planManager` 仍是 inactive：
  没有计划文件、plan reminder 不注入、`exit_plan_mode` 走错分支。测试必须断言
  `planManager.isPlanning()` 而不是 `config.permissionMode`，后者在 bug 版本里同样成立。
- **放弃规划后「先 deactivate 恢复 prePlanMode，再按恢复后的模式循环」**。否决理由：
  `acceptEdits` 的下一档是 `plan`，用户按一下等于原地转圈。落点必须从 `"plan"` 出发算。
  也不用「先 deactivate 再切档」两步走：那会多一条 `PermissionModeChanged`、状态栏闪一下，
  轨迹里看起来像连按了两次。
- **审批中允许切模式**。否决理由：批准后该恢复成哪个模式已经记在 `prePlanMode` 里，
  此时改模式等于替用户改主意；审批框才是决策现场。
- **G4 剧本用 `pause` 同步三次按键**。否决理由：状态栏的模式名（`⏸ Manual` / `acceptEdits` / `[PLAN]`）
  就是每次按键的可观测中间态，按仓库规范同步一律用 `wait`。`pause` 只留给「两次操作之间
  没有任何屏幕变化」的场景（对照 A1-dialog 的双击 Esc）。

## 拿什么证明它生效了

- **G1**（`packages/cli/tests/app/shift-tab-plan.test.ts` + `packages/core/tests/permission/mode.test.ts`）：
  `bun test ./packages/cli/tests/app/shift-tab-plan.test.ts ./packages/core/tests/permission/mode.test.ts`
  → `20 pass / 0 fail`。断言停在 `planManager.isPlanning()` / `getPrePlanMode()` / `getEntrySource()`，
  不是「config 变成了 plan」。
- **变异自证**（按仓库要求，先改坏再恢复）：
  - `} else if (next === "plan") {` → `} else if (false) {`（模拟「只改字符串」）→ 2 fail；
    恢复后 5 pass。同一变异下 `mode.test.ts` 仍全绿 —— 正好说明纯函数层守不住这个缺陷，
    App 层用例不是重复劳动。
  - `const abandoningPlan = planManager?.isPlanning() === true;` → `const abandoningPlan = false;`
    → 「planning 态按 → 放弃规划」fail；恢复后 5 pass。
- **G4**（`tests/smoke/cases/A14-shift-tab-plan`）：
  `bun run scripts/smoke/run.ts A14-shift-tab-plan` → `[PASS] (1.1s)`。
  屏幕断言 `[PLAN]` 出现 → 「离开计划模式」用负向正则 `^(?![\s\S]*\[PLAN\])`（`wait` 只能等出现，
  这是它表达「消失」的唯一写法）；轨迹断言 `PlanTransition{decision_source:"keyboard"}` 与
  `PlanTransition{reason:"cancel"}` 各 1 条，`PermissionModeChanged{from:"plan",to:"auto",source:"plan_exit"}` 1 条。
  首跑暴露了两个真实情况并已按实测修正：① smoke 的 TUI 会话开 skip-permissions，
  起点是 `dangerously-skip-permissions`，到 plan 要按**三次**（方案 §6.6 的「三次」即此）；
  ② 按键连发会被当成一个 input chunk 丢掉多余的，必须逐次 `wait` 同步。
- **门禁**：`lint` 0 错、`format:check` 通过、`lint:boundary` / `lint:command-system` / `lint:legacy-tool` 通过。
  `typecheck:gate` 在 worktree 里报 6 条 `packages/core/tests/skill/*` 的重复模块身份错误，
  已按仓库要求举证：这些文件不在本次 diff 内，父仓 main 上 `typecheck:gate` 为 `62 处 / 基线 62 处，无新增`，
  成因是 worktree 的 `node_modules` 软链导致 tsc 把同一类型解析成主仓与 worktree 两份。
