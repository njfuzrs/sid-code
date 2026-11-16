/**
 * X14 skip 档仍尊重用户 ask 规则（M8，PR-4）。
 *
 * 缺陷原文（方案 20261112 §4.5 M8）：`--dangerously-skip-permissions` 在 `checkUngated`
 * 最前面早退，只跑一遍 `checkUserDenyUnderSkip`（deny 规则 / disallowedTools / 会话记忆），
 * **不查 ask 规则**。于是 `ask: ["Bash(git push*)"]` 在 skip 档下静默执行，
 * 而 default 档同一份规则会弹确认——同一条配置在不同模式下的含义被悄悄改写了。
 *
 * 为什么这条必须是 G2 而不是只留在 G1：G1 测的是 `PermissionChecker.check()` 的返回值，
 * 而「拒绝真的落到了工具执行链上」只有跑一遍完整 CLI 才看得到——检查器判 deny、
 * 执行器却照跑（或反过来）这类接线断裂，G1 全绿也发现不了。
 *
 * 判据两条一起：
 * - `PermissionDecision{outcome:"deny"}` —— 决策层拦住了；
 * - `PostToolUse` 0 次 —— 工具**真的没执行**。只看第一条时，「判了 deny 但执行器忽略」
 *   的接线错误会漏网；只看第二条时，「模型自己没调工具」也会通过。
 *
 * 无头（`-p`）下 ask 规则命中落 deny 而不是挂起等人——文案由 `checkUserAskUnderSkip`
 * 自己给出（skip 早退排在阶段二 headless 分支之前，走不到那个统一落点）。
 *
 * 期望来源：2026-11-16 在 worktree 里用真实 `PermissionChecker`（`print: true` +
 * `skipPermissions: true` + ask 规则）跑的探针，`step=skip-ask-rule`、
 * `reason` 含 `Bash(git push*)`；随后用构建产物跑本用例复核，并在临时真实 git 仓库
 * （`git init` + bare 远端）里用真实模型端到端跑过一次：模型确实调了
 * `git push -u origin master`，被拒且远端 `log` 为空。未经人工 TUI 实测，台账已注明。
 */
import type { SmokeCase } from "../../lib/types.ts";

const SETTINGS = JSON.stringify(
  {
    permissions: {
      // 项目级 ask 规则：rule-loader 对 deny/ask 一律保留（收紧安全，不构成绕过风险）
      ask: ["Bash(git push*)"],
    },
  },
  null,
  2,
);

const def: SmokeCase = {
  id: "X14-skip-respects-ask-rules",
  ledger: "X14",
  feature: "skip 档仍尊重用户 ask 规则",
  kind: "guard",
  // 必须走真实权限：跳过权限时一切放行，这个用例什么也测不到。
  realPermissions: true,
  repo: {
    "wip.txt": "work in progress\n",
    ".sid-code/settings.json": SETTINGS,
  },
  argv: ["--trust-workspace", "--dangerously-skip-permissions", "-p", "把改动推上去"],
  expect: {
    events: [
      // 核心判据：skip 档下 ask 规则命中 → 拒绝（修复前是 allow step=skip）
      { event: "PermissionDecision", where: { tool_name: "bash", outcome: "deny" }, count: 1 },
      // 行为证据：工具真的没执行（防「判了 deny 但执行器照跑」）
      { event: "PostToolUse", where: { tool_name: "bash" }, count: 0 },
    ],
  },
  mutations: [
    {
      file: "packages/core/src/permission/checker.ts",
      find: "      const userAsk = this.checkUserAskUnderSkip(req);\n      if (userAsk) return userAsk;",
      replace: "",
      why: "skip 档不再检查用户 ask 规则（M8 修复前的形态）：git push 在 skip 下静默执行",
    },
  ],
};

export default def;
