/**
 * A3 Hook 拦截：项目级 PreToolUse hook + `matcher: "Bash"`，脚本命中 `rm ` 时 `exit 2` 拒绝。
 *
 * 期望来源：核心功能触发清单 A3 的人工实测（2026-11-05，会话 20261105-195723-9bfc240f）。
 * hook 命令、两次 bash 调用的形态（一次不含 `rm `、一次 `rm -f trash.txt && ls -la`）都原样取自那次录制：
 * - 未命中的那次：`HookExecuted{outcome=success, exit_code=0}`，工具照常执行；
 * - 命中的那次：`HookExecuted{outcome=blocking, exit_code=2, decision=deny}`，随后
 *   `PostToolUseFailure{error_kind=permission}`，`error_head` 就是回灌给模型的 tool_result 文本；
 * - `trash.txt` 仍在、内容完好。
 *
 * 人工实测的难点（让模型真的去调 `rm`）在回放里不存在：响应是录好的，这里只守 harness 那一半。
 * 与 A2 一样，配置必须写在项目级 settings，并带 `--trust-workspace`。
 */
import { HOOK_EXECUTED_EVENT_NAME } from "@sid-code/core/hook/hook-telemetry.ts";
import { HookEventName } from "@sid-code/core/hook/types.ts";
import type { SmokeCase } from "../../lib/types.ts";

const HOOK_COMMAND =
  "if echo \"$SID_CODE_TOOL_INPUT\" | grep -q 'rm '; then echo \"[hook] 拦截 bash: $SID_CODE_TOOL_INPUT\" >&2; echo '本仓库禁止用 rm 删除文件，请改用其他方式或告知用户手动删除' >&2; exit 2; fi";

const TRASH = "this file should not be deleted\n";

const def: SmokeCase = {
  id: "A3-pre-tool-use-deny",
  ledger: "A3",
  feature: "Hook 拦截",
  kind: "guard",
  repo: {
    "trash.txt": TRASH,
    ".sid-code/settings.json": JSON.stringify(
      {
        hooks: {
          PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: HOOK_COMMAND }] }],
        },
      },
      null,
      2,
    ),
  },
  argv: ["--trust-workspace", "-p", "请用 bash 工具执行：rm -f trash.txt"],
  expect: {
    events: [
      {
        event: HOOK_EXECUTED_EVENT_NAME,
        where: {
          event_name: HookEventName.PreToolUse,
          tool_name: "bash",
          outcome: "success",
          exit_code: 0,
          source: "project",
        },
        count: 1,
      },
      {
        event: HOOK_EXECUTED_EVENT_NAME,
        where: {
          event_name: HookEventName.PreToolUse,
          tool_name: "bash",
          outcome: "blocking",
          exit_code: 2,
          decision: "deny",
          source: "project",
        },
        count: 1,
      },
      {
        event: HookEventName.PostToolUseFailure,
        where: {
          tool_name: "bash",
          is_error: true,
          error_kind: "permission",
          // 原文取自 20261105-195723-9bfc240f 的同名事件：stderr 两行按序回灌给模型
          error_head:
            'Hook 阻止执行: [hook] 拦截 bash: {"command":"rm -f trash.txt && ls -la","description":"删除测试临时文件 trash.txt 并确认结果"}\n本仓库禁止用 rm 删除文件，请改用其他方式或告知用户手动删除',
        },
        count: 1,
      },
      // 未命中的那次照常执行完
      { event: HookEventName.PostToolUse, where: { tool_name: "bash", is_error: false }, count: 1 },
    ],
    files: [{ path: "trash.txt", equals: TRASH }],
  },
  mutations: [
    {
      file: "packages/core/src/hook/runner.ts",
      find: "if (exitCode === EXIT_BLOCKING) {",
      replace: "if (false) {",
      why: "exit 2 不再阻塞，被当成普通非零告警，rm 照样执行",
    },
    {
      file: "packages/core/src/query/tool-executor.ts",
      find: "if (out.isBlockingDecision()) {\n    return { blocked: true",
      replace: "if (false) {\n    return { blocked: true",
      why: "hook 判了 deny，但执行器不认，工具照样执行",
    },
  ],
};

export default def;
