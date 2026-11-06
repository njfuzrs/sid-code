/**
 * A2 Hook 追加动作：项目级 PostToolUse hook + `matcher: "Edit|Write"`。
 *
 * 期望来源：核心功能触发清单 A2 的人工实测（2026-11-05，会话 20261105-195227-1a379522）：
 * 一次 edit 恰好产生 1 条 `HookExecuted{event_name=PostToolUse, tool_name=edit, outcome=success, source=project}`，
 * 同会话的两次 read 不触发；hook 写出的日志只有一行 `[hook] edit`。
 *
 * 注意两点（都来自那次实测）：
 * - 配置必须写在**项目级** `.sid-code/settings.json`，`--settings <file>` 注入的 hook 不生效；
 * - 项目级 hook 在 `-p` 下要 `--trust-workspace` 才加载。
 */
import { HOOK_EXECUTED_EVENT_NAME } from "@sid-code/core/hook/hook-telemetry.ts";
import { HookEventName } from "@sid-code/core/hook/types.ts";
import type { SmokeCase } from "../../lib/types.ts";

const def: SmokeCase = {
  id: "A2-post-tool-use",
  ledger: "A2",
  feature: "Hook 追加动作",
  kind: "guard",
  repo: {
    "hello.txt": "hello world\n",
    ".sid-code/settings.json": JSON.stringify(
      {
        hooks: {
          PostToolUse: [
            {
              matcher: "Edit|Write",
              hooks: [
                { type: "command", command: 'echo "[hook] $SID_CODE_TOOL_NAME" >> hook.log' },
              ],
            },
          ],
        },
      },
      null,
      2,
    ),
  },
  argv: ["--trust-workspace", "-p", "把 hello.txt 的 hello world 改成 hello sid-code"],
  expect: {
    events: [
      {
        event: HOOK_EXECUTED_EVENT_NAME,
        where: {
          event_name: HookEventName.PostToolUse,
          tool_name: "edit",
          outcome: "success",
          source: "project",
        },
        count: 1,
      },
      // matcher 生效的反证：两次 read 都有 PostToolUse，但不触发 hook
      { event: HookEventName.PostToolUse, where: { tool_name: "read" }, count: 2 },
      { event: HOOK_EXECUTED_EVENT_NAME, count: 1 },
    ],
    files: [
      { path: "hello.txt", equals: "hello sid-code\n" },
      { path: "hook.log", equals: "[hook] edit\n" },
    ],
  },
  mutations: [
    {
      file: "packages/core/src/hook/runner.ts",
      find: "this.emitExecutedTelemetry(",
      replace: "void (",
      why: "hook 照常执行，但 HookExecuted 埋点断了（轨迹里看不到 hook 发生过）",
    },
    {
      file: "packages/core/src/hook/planner.ts",
      find: "if (!entry.matcher || !context) return true;",
      replace: "return true;",
      why: "matcher 失效，read 也会触发 hook",
    },
  ],
};

export default def;
