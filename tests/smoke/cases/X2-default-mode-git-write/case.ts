/**
 * X2 权限默认档：git 引用类子命令的写形态不再被判只读自动放行（Harness 厚薄归位专项 B1，#621）。
 *
 * 期望来源：B1 方案 §6.4 的手动验收口径——default 模式下 `git stash` 要确认、
 * `git branch --show-current` 不要确认。无头下「要确认」= 判拒、工具不执行。
 * 事件形态（`PermissionDecision.outcome`）取自 2026-11-08 的构建产物探针，未经人工 TUI 实测，
 * 所以只断言 outcome 与条数，不断言 `step` 这类实现细节。
 *
 * 选这两条写形态的原因：
 * - `git remote add` 在无提交的仓库里也能成功，不依赖提交历史；
 * - `git stash -u` 是 prompt 红线 RL-001 明写禁止、而修复前代码层直接放行的那条。
 * 读形态那条是对照：如果整个权限层都把 bash 判拒，两条写断言也会「通过」，这条防假绿。
 *
 * 必须走真实权限（`realPermissions`）：跳过权限时一切都放行，这个用例什么也测不到。
 */
import type { SmokeCase } from "../../lib/types.ts";

const UNTRACKED = "untracked work in progress\n";

const def: SmokeCase = {
  id: "X2-default-mode-git-write",
  ledger: "X2",
  feature: "权限默认档",
  kind: "guard",
  realPermissions: true,
  repo: { "wip.txt": UNTRACKED },
  argv: ["-p", "整理一下 git 状态"],
  expect: {
    events: [
      { event: "PermissionDecision", where: { tool_name: "bash", outcome: "deny" }, count: 2 },
      { event: "PermissionDecision", where: { tool_name: "bash", outcome: "allow" }, count: 1 },
      // 读形态照常执行完
      { event: "PostToolUse", where: { tool_name: "bash", is_error: false }, count: 1 },
    ],
    // `git stash -u` 一旦执行，未跟踪文件会被收走
    files: [{ path: "wip.txt", equals: UNTRACKED }],
  },
  mutations: [
    {
      file: "packages/core/src/tool/bash/read-only-validation.ts",
      find: 'if (subCmd === "remote") {\n        if (!isReadOnlyGitRemote(gitArgs.slice(1))) return false;',
      replace: 'if (subCmd === "remote") {\n        if (false) return false;',
      why: "git remote 回到按子命令名整体判只读，remote add 在 default 档被 Step 5.5 自动放行",
    },
    {
      file: "packages/core/src/tool/bash/read-only-validation.ts",
      find: 'if (subCmd === "stash") {\n        if (!isReadOnlyGitStash(gitArgs.slice(1))) return false;',
      replace: 'if (subCmd === "stash") {\n        if (false) return false;',
      why: "git stash 回到整体判只读（B1 修复前的形态），stash -u 收走未跟踪文件",
    },
  ],
};

export default def;
