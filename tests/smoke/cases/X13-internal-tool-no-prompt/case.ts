/**
 * X13 内部工具按「需要权限」声明放行（B14，PR-6 #840）。
 *
 * 缺陷原文（方案 §1.3 B14）：`think` / `todo_write` / `task_get` 这类**进程内记账 / 只读**
 * 工具在无头 default 档被判拒 —— 旧实现只有一张「无头模式专用名单」盯着这件事，
 * 交互模式下这些工具照样弹确认，且名单必然漂移（新增记账工具的人不知道有这张表）。
 * 修复后改为工具在**自己的定义处**声明 `requiresPermission() { return false }`，
 * checker 在 Step 13.6 统一放行，两条路径（交互 / 无头）同一套判据。
 *
 * 为什么用 `think` + `todo_write` 而不是方案 §6.3 写的 `sub_agent`：
 * `sub_agent` 的回放要吃掉额外的游标（见 X3 的三段式），而本用例要证明的是
 * 「**声明式免权限**在无头 default 下生效」，两个纯记账工具就能证明，且失败时归因更直接
 * （`sub_agent` 被拒与「子代理内部还有一层权限」两种原因会混在一起）。
 * X3 已经覆盖了 `sub_agent` 的端到端回传，两层互补。
 *
 * 判据是「两个工具都拿到 allow 且都真的执行完」：
 * - 只看 `PostToolUse`：「整个权限层放行一切」也会通过；
 * - 只看 `PermissionDecision.allow`：「工具被调用但执行失败」也会通过。
 * 两条一起才是「免确认 + 真跑了」。
 *
 * 期望来源：2026-11-15 用真实 `PermissionChecker` + 构建产物跑的探针。
 * 未经人工 TUI 实测，台账已注明。
 */
import type { SmokeCase } from "../../lib/types.ts";

const def: SmokeCase = {
  id: "X13-internal-tool-no-prompt",
  ledger: "X13",
  feature: "内部工具免确认声明",
  kind: "guard",
  // 必须走真实权限：跳过权限时所有工具都放行，这个用例什么也测不到。
  realPermissions: true,
  repo: {},
  argv: ["-p", "先记一笔再干活"],
  expect: {
    events: [
      // 两个工具都被放行（Step 13.6 的声明式免权限）
      { event: "PermissionDecision", where: { tool_name: "think", outcome: "allow" }, count: 1 },
      {
        event: "PermissionDecision",
        where: { tool_name: "todo_write", outcome: "allow" },
        count: 1,
      },
      // 且都真的执行完了（不是「放行但执行失败」）
      { event: "PostToolUse", where: { tool_name: "think", is_error: false }, count: 1 },
      { event: "PostToolUse", where: { tool_name: "todo_write", is_error: false }, count: 1 },
      // 一个都没落到确认（B14 修复前这两个都是 deny）
      { event: "PermissionDecision", where: { outcome: "deny" }, count: 0 },
    ],
  },
  mutations: [
    {
      file: "packages/core/src/permission/checker.ts",
      find: "    return declared.call(tool, input) === false;",
      replace: "    return false;",
      why: "声明式免权限失效（B14 修复前的形态）：纯记账工具在无头 default 下落到确认",
    },
  ],
};

export default def;
