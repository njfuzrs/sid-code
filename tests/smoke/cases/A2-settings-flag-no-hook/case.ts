/**
 * A2 正例 [守门]：`--settings <file>` 注入的 hook 生效。
 *
 * 历史（为什么 id 还叫 no-hook）：这条曾是 `[锁缺陷]` 用例 —— 2026-11-05 人工实测
 * `hooks list --settings /tmp/a2-hook-settings.json` 列不出条目、`-p` 跑完轨迹零
 * `HookExecuted`。根因是 `collectHookLayers` 只收磁盘三源，`--settings` 走的是
 * flagSettings 内存源（2026-11-07 回源码核实）。
 *
 * 2026-11-17 把缺陷修掉后，按原注释的约定「改断言、把 kind 改成 guard，不要删」。
 * **id 特意保留旧名**：改名会让 `expect-guard` 把它当成「新增用例」从而绕过
 * 人工 expect-reviewed 评审，那是用改名掩盖一次期望变更。
 *
 * 与 A2-post-tool-use 共用同一份夹具和同一条 hook，唯一差别是配置的来源：
 * 那边走磁盘 settings.json，这边走 `--settings`，两条对照着读。`--trust-workspace`
 * 照带，排除「被信任门摘掉」这个混淆项。
 */
import { HOOK_EXECUTED_EVENT_NAME } from "@sid-code/core/hook/hook-telemetry.ts";
import { HookEventName } from "@sid-code/core/hook/types.ts";
import type { SmokeCase } from "../../lib/types.ts";

const def: SmokeCase = {
  id: "A2-settings-flag-no-hook",
  ledger: "A2",
  feature: "Hook 追加动作",
  kind: "guard",
  repo: {
    "hello.txt": "hello world\n",
    "a2-hook-settings.json": JSON.stringify(
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
  argv: [
    "--trust-workspace",
    "--settings",
    "a2-hook-settings.json",
    "-p",
    "把 hello.txt 的 hello world 改成 hello sid-code",
  ],
  expect: {
    events: [
      // hook 有机会触发：edit 确实执行了
      { event: HookEventName.PostToolUse, where: { tool_name: "edit", is_error: false }, count: 1 },
      // 新契约：--settings 里的 hook 必须真的执行（修前这条是 count: 0）
      { event: HOOK_EXECUTED_EVENT_NAME, count: 1 },
    ],
    files: [
      { path: "hello.txt", equals: "hello sid-code\n" },
      // 期望来源：hook 命令 `echo "[hook] $SID_CODE_TOOL_NAME"`，工具名为 edit
      { path: "hook.log", equals: "[hook] edit\n" },
    ],
  },
  mutations: [
    {
      file: "packages/core/src/config/hook-layers.ts",
      find: `  const flagSettings = getSettingsForSource("flagSettings").settings as {
    hooks?: unknown;
  } | null;
  const flagHooks = normalizeRawHooks(flagSettings?.hooks);
  if (flagHooks) {
    layers.push({ source: "flag", file: "<--settings>", hooks: flagHooks, untrusted: false });
  }
  return layers;`,
      replace: "  return layers;",
      why: "模拟回退：删掉 flag 层后 --settings 的 hook 不再注册，守门用例必须变红",
    },
  ],
};

export default def;
