/**
 * X12 模式切换落轨迹（B11，PR-0 #831）。
 *
 * 缺陷原文（方案 §1.3 B11）：权限模式切换不进轨迹 —— `PermissionModeChanged` 事件
 * 只在 `setPermissionMode` 里发过一次，而 `setPermissionMode` 在 B11 修复前有 5 个
 * 调用点各自直接写 `config.permissionMode`，绕过了这个唯一出口。后果是「模式切换后
 * 行为变了」在轨迹里查不到，只能从模型事后叙述里猜。
 *
 * 本用例锁住端到端形态：模型调 `enter_plan_mode` → `planManager.enter()` →
 * `activatePlanMode()` → `setPermissionMode("plan", "plan_enter")` → 事件落盘。
 *
 * 判据是 `PermissionModeChanged{from: "default", to: "plan", source: "plan_enter"}`
 * 恰好 1 条，而不是「工具执行成功」：工具成功只证明 `enter_plan_mode` 跑了，
 * 证明不了模式真的切了、更证明不了这次切换留了痕。
 *
 * 期望来源：2026-11-15 用真实构建产物跑的探针（手工 TUI 实测未做，台账已注明）。
 * `source` 的取值来自 `permission/mode.ts` 的闭集（`plan_enter` / `plan_exit` /
 * `keyboard` / `policy` / …），改名会由 `PermissionModeChangeSource` 类型检查拦住。
 */
import type { SmokeCase } from "../../lib/types.ts";

const def: SmokeCase = {
  id: "X12-plan-mode-event",
  ledger: "X12",
  feature: "权限模式切换落轨迹",
  kind: "guard",
  // enter_plan_mode 声明 requiresPermission=false，跳过权限也能跑；
  // 但只有走真实权限链路才能证明「切换经过 setPermissionMode 这个唯一出口」。
  realPermissions: true,
  repo: {},
  argv: ["-p", "先规划一下再动手"],
  expect: {
    events: [
      {
        event: "PermissionModeChanged",
        where: { from: "default", to: "plan", source: "plan_enter" },
        count: 1,
      },
      // 工具本身放行（B14 声明了免权限）；被拒时下面的模式事件也不会出现，
      // 这条是给失败时留下可归因的第一步
      { event: "PostToolUse", where: { tool_name: "enter_plan_mode", is_error: false }, count: 1 },
    ],
  },
  mutations: [
    {
      file: "packages/cli/src/app.ts",
      find: "    this.recordTraceEventWhenReady(PERMISSION_MODE_CHANGED_EVENT_NAME, {\n      from,\n      to: next,\n      source,\n    });",
      replace: "    void from;",
      why: "模式切换不再落事件（B11 修复前）：切了模式但轨迹里查不到",
    },
  ],
};

export default def;
