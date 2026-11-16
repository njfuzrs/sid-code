/**
 * A14 Shift+Tab 进/出计划模式（G4）：真 TUI 里按两次 Shift+Tab 进 plan、发一轮消息、
 * 再按一次退出，屏幕与轨迹都要对得上。
 *
 * 为什么需要 G4 这一层：`permission/mode.ts` 是纯函数，只能证明「循环落点含 plan」；
 * `packages/cli/tests/app/shift-tab-plan.test.ts` 能证明状态机进了 planning，
 * 但证明不了**人在终端里按下去之后屏幕上真的亮起 plan**——按键字节
 * （`\x1b[Z`）、`KeypressContext` 的识别、`tuiStateUpdater` 的状态同步、
 * Footer 的 `[PLAN]` 渲染，这三段接线任何一段断了单测都看不见。
 *
 * 期望来源：2026-11-16 `sc-dev` 构建产物在 PTY 里的实测（`bun run smoke:tui` 本用例首跑），
 * 屏幕文本与 `PlanTransition` 字段都是从那次的轨迹里抄的，不是从实现反推。
 *
 * 两次按键就到 plan（不是三次）：TUI 启动时 `permissionMode` 是 default，
 * 第一按 → acceptEdits，第二按 → plan。方案 §6.6 写的「三次」是把起点也算进去，
 * 照那个数按会越过 plan 落到 auto——所以这里按实际观察写。
 *
 * 「离开」为什么用「屏幕不含 [PLAN]」而不是等某段新文本：退出后落到 `auto`，
 * 而 Composer 的 `● plan Ctrl+Shift+A 切换` 与 Footer 的 `[PLAN]` 都是**消失**型证据，
 * `wait` 只能等出现。`screenHas` 对正则按原文匹配，所以用负向断言
 * `^(?![\s\S]*\[PLAN\])` 表达「整屏都不含 [PLAN]」——它在前一步 `[PLAN]` 出现之后
 * 才轮到，不会因为「一开始就没有」而假通过。
 */
import type { SmokeCase } from "../../lib/types.ts";

const def: SmokeCase = {
  id: "A14-shift-tab-plan",
  ledger: "A14",
  feature: "Shift+Tab 进/出计划模式",
  kind: "guard",
  repo: { "README.md": "a14\n" },
  argv: [],
  tui: [
    { kind: "wait", screen: "输入消息或 /help 查看命令", label: "TUI 就绪" },
    // smoke 的 TUI 会话开了 skip-permissions（`config.skipPermissions=true` →
    // 启动模式是 `dangerously-skip-permissions`，见 config.ts 的 startMode 归一），
    // 所以到 plan 要按**三次**：D-S-P → default → acceptEdits → plan。
    // 普通用户从 default 起步两次就到——方案 §6.6 写的「三次」正是这个环境的实测值。
    { kind: "key", key: "shift-tab" }, // D-S-P → default
    // ⚠️ 每次按键之间都要等一次屏幕变化，不能连发：`\x1b[Z\x1b[Z` 一次写进去会被
    // TUI 当成**一个** input chunk，`input === shiftTab` 不成立，多余的按键静默丢掉。
    // 用 wait 不用 pause：状态栏的模式名（`⏸ Manual` = default，`acceptEdits`）就是
    // 这条同步的可观测判据，没有理由靠固定时长（对照 A1-dialog 的双击 Esc：
    // 那两次之间没有任何屏幕变化，只能 pause）。
    { kind: "wait", screen: "Manual", label: "第一按生效：状态栏 default（⏸ Manual）" },
    { kind: "key", key: "shift-tab" }, // default → acceptEdits
    { kind: "wait", screen: "dev · acceptEdits", label: "第二按生效：状态栏 acceptEdits" },
    { kind: "key", key: "shift-tab" }, // acceptEdits → plan
    { kind: "wait", screen: "[PLAN]", label: "状态栏亮起计划模式" },
    { kind: "type", text: "把 README 的标题改成 todo" },
    { kind: "key", key: "enter" },
    {
      kind: "wait",
      screen: "计划已写入计划文件",
      label: "计划模式下跑完一轮（plan 约束已注入）",
    },
    { kind: "key", key: "shift-tab" }, // 放弃规划 → auto
    {
      kind: "wait",
      screen: /^(?![\s\S]*\[PLAN\])/,
      label: "状态栏的 [PLAN] 消失（已离开计划模式）",
      timeoutMs: 5000,
    },
  ],
  expect: {
    events: [
      // 进去：走状态机（不是只改 config 字符串），来源记成 keyboard。
      // ⚠️ 落盘字段名是 `decision_source` 而不是 `meta.source`：`PlanTransition` 的 meta
      // 在 wirePlanLifecycleTelemetry 里被展平成 snake_case（app.ts 的
      // `...(e.meta?.source ? { decision_source: e.meta.source } : {})`），
      // 事件 data 里根本没有嵌套的 meta 对象。首跑断言 `meta.source` 就是这样红的。
      {
        event: "PlanTransition",
        where: { from: "inactive", to: "planning", reason: "enter" },
        count: 1,
      },
      { event: "PlanTransition", where: { decision_source: "keyboard" }, count: 1 },
      // 出来：与审批框「取消」同一条出路
      {
        event: "PlanTransition",
        where: { from: "planning", to: "inactive", reason: "cancel" },
        count: 1,
      },
      // 模式切换本身留痕：进是 plan_enter，出是 plan_exit（override 到 auto）
      {
        event: "PermissionModeChanged",
        where: { from: "default", to: "acceptEdits", source: "keyboard" },
        count: 1,
      },
      {
        event: "PermissionModeChanged",
        where: { from: "plan", to: "auto", source: "plan_exit" },
        count: 1,
      },
    ],
    // 计划模式下不许写仓库里的文件：这一轮只渲染回放文本，README 必须原样
    files: [{ path: "README.md", equals: "a14\n" }],
  },
  mutations: [
    {
      file: "packages/cli/src/app.ts",
      find: '    } else if (next === "plan") {',
      replace: "    } else if (false) {",
      why: "键盘进 plan 只改 config.permissionMode、不进状态机（M6 修复前的假 plan 态）：状态栏亮起 plan，但没有计划文件、模型收不到 plan 约束",
    },
    {
      file: "packages/cli/src/app.ts",
      find: "    const abandoningPlan = planManager?.isPlanning() === true;",
      replace: "    const abandoningPlan = false;",
      why: "规划态按 Shift+Tab 不再退出计划模式（PR-5 之前的行为）：人按了没反应，卡在 plan 里出不来",
    },
  ],
};

export default def;
