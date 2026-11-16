/**
 * X9 只读 git 的执行边界（B1，PR-1 #826）：前导环境变量不是白名单就不得判只读。
 *
 * 缺陷原文（方案 §1.3 B1）：`GIT_EXTERNAL_DIFF=` / `GIT_CONFIG_*=` 加一条只读 git，
 * 在 default 档零确认执行任意程序。根因是 `isReadOnlyCommand` 完全不看前导赋值，
 * 所以一条**看起来是 `git status`** 的命令能借 git 自己读的环境变量跑任意脚本。
 *
 * 判据是「标记文件不存在」而不是「事件里 outcome=deny」：
 * - 只看事件的话，「整个权限层把 bash 全拒了」也会让断言通过 —— 那是假绿；
 * - 标记文件是**唯一能证明程序确实没被执行**的证据。B1 是 P0 安全修复，
 *   它要防的是「执行了」，不是「记了一条 deny」。
 *
 * 期望来源：方案 §6.3 的 B1 行（「模型发 `GIT_CONFIG_COUNT=1 … git status` → 被拒；
 * `marker` 文件不存在」）。`PermissionDecision.outcome` 的形态取自 2026-11-15 用真实
 * `PermissionChecker` 跑的探针（`allowed=false step="headless:14"`），未经人工 TUI 实测，
 * 所以只断言 outcome 与条数，不断言 `step`。
 *
 * 必须走真实权限（`realPermissions`）：跳过权限时一切都放行，这个用例什么也测不到。
 */
import type { SmokeCase } from "../../lib/types.ts";

const README = "smoke fixture\n";

const def: SmokeCase = {
  id: "X9-env-prefix-injection",
  ledger: "X9",
  feature: "只读 git 环境变量白名单",
  kind: "guard",
  realPermissions: true,
  repo: { "README.md": README },
  argv: ["-p", "看一下 git 状态"],
  expect: {
    events: [
      // 整条命令被判非只读 → 无头下「要确认」= 判拒
      { event: "PermissionDecision", where: { tool_name: "bash", outcome: "deny" }, count: 1 },
      // 被拒的调用不会执行，所以没有任何一次 bash 成功产出
      { event: "PostToolUse", where: { tool_name: "bash", is_error: false }, count: 0 },
    ],
    // 最直接的证据：注入的程序没有被执行过
    files: [{ path: "PWNED", absent: true }],
  },
  mutations: [
    {
      // B1 的拦截有两层：① `isSafeEnvVarName` 白名单（工具级 `isReadOnlyCommand`）；
      // ② git 边界层 `segmentText` 把前导赋值拼回去**再判一次**（防 `git -C` 把 `GIT_DIR`
      // 一起洗白）。对本用例这条「值里带空格」的命令形态（`GIT_CONFIG_VALUE_0='touch …'`），
      // 第 ② 层才是实际拦住它的那层：拼回去的文本按空格拆成多 token → 判非只读。
      // 单独变异第 ① 层时第 ② 层仍然拦住（2026-11-16 实测：变异后
      // `isReadOnlyCommand` 已返回 true，但 checker 仍 `allowed=false`），
      // 用例不变红——说明变异点选错了层，不是用例空心。改变异第 ② 层后变红。
      file: "packages/core/src/permission/readonly-git-boundary.ts",
      find: '  const body = [st.command, ...st.args].join(" ");\n  return prefix ? `${prefix} ${body}` : body;',
      replace: '  const body = [st.command, ...st.args].join(" ");\n  void prefix;\n  return body;',
      why: "git 边界层不再复核前导赋值（B1 修复前的形态）：GIT_CONFIG_* 可注入任意程序",
    },
  ],
};

export default def;
