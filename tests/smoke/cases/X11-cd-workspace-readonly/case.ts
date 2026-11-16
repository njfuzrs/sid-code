/**
 * X11 工作区内 `cd` + 只读主体免确认（B3，PR-2 #834）。
 *
 * 缺陷原文（方案 §1.3 B3）：`cd <会话 cwd> && ls` 这类完全安全的命令每次都弹确认 ——
 * `BashTool.checkPermissions` 用的是不带上下文的 `isReadOnlyCommand`，它把 `cd` 一律判非只读。
 * 这是对的（纯函数不知道会话 cwd），代价是工作区内换目录再看一眼也要问。
 *
 * 本用例锁住三件事：
 * 1. `cd <工作区> && ls`（非 git 只读主体）→ `step=5.6` 放行；
 * 2. `cd <工作区> && git status --short`（git 只读主体）→ `step=5.5` 放行
 *    —— 这条走的是 PR-1 的 git 边界路径，**不是** 5.6。方案 §6.3 把 B3 的判据写成
 *    「`cd <cwd> && git log -1 --oneline` → step=5.6」，实测该命令落在 5.5；
 *    5.6 只对非 git 只读主体命中。这里按实测分开断言，避免把两层的归属混在一起；
 * 3. 两条命令都真的执行完（`PostToolUse` 各 1 条）—— 只看决策不看执行，
 *    「整个权限层把 bash 全拒了」也会让「没有 deny」成立。
 *
 * 期望来源：2026-11-15 用真实 `PermissionChecker` 跑的探针
 * （`cd <ws> && ls` → `allowed=true step="5.6"`；`cd <ws> && git status --short`
 * → `allowed=true step="5.5"`）。未经人工 TUI 实测，台账已注明。
 *
 * 必须走真实权限（`realPermissions`）：跳过权限时一切都放行，这个用例什么也测不到。
 */
import type { SmokeCase } from "../../lib/types.ts";

const def: SmokeCase = {
  id: "X11-cd-workspace-readonly",
  ledger: "X11",
  feature: "工作区内 cd 复合只读",
  kind: "guard",
  realPermissions: true,
  repo: { "README.md": "smoke fixture\n" },
  // `${CASE_ROOT}` 由夹具替换成用例仓根；两条都在工作区内换目录后跑只读主体。
  argv: ["-p", "看一眼工作区"],
  expect: {
    events: [
      // B3 的放行路径：非 git 只读主体
      {
        event: "PermissionDecision",
        where: { tool_name: "bash", step: "5.6", outcome: "allow" },
        count: 1,
      },
      // git 只读主体走 PR-1 的边界判定（step 5.5），不是 B3 的 5.6
      {
        event: "PermissionDecision",
        where: { tool_name: "bash", step: "5.5", outcome: "allow" },
        count: 1,
      },
      // 两条都真的执行了
      { event: "PostToolUse", where: { tool_name: "bash", is_error: false }, count: 2 },
      // 没有任何一条落到确认
      { event: "PermissionDecision", where: { tool_name: "bash", outcome: "deny" }, count: 0 },
    ],
  },
  mutations: [
    {
      file: "packages/core/src/permission/readonly-compound.ts",
      find: "  return { applicable: true, readOnly: true, stages };",
      replace: "  return { applicable: true, readOnly: false, stages };",
      why: "复合判定回到「一律判不准」（B3 修复前）：工作区内 cd + 只读每次都落确认",
    },
  ],
};

export default def;
