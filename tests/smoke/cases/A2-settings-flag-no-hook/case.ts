/**
 * A2 反例 [锁缺陷]：`--settings <file>` 注入的 hook 不生效。
 *
 * 期望来源：核心功能触发清单 A2 「讲的时候留余地 (a)」的人工实测（2026-11-05）：
 * `hooks list --settings /tmp/a2-hook-settings.json` 列不出条目、`-p` 跑完日志空、轨迹零 `HookExecuted`。
 * 根因（2026-11-07 回源码核实）：`collectHookLayers`（packages/core/src/config/hook-layers.ts）只收
 * managed + user/project/local 三个磁盘源，`--settings` 走的是 flagSettings 内存源（cli.ts `setFlagSettings`），不在其中。
 *
 * 这条锁的是**当前行为**，不是期望行为。修成「--settings 的 hook 生效」时：改这里的断言、
 * 把 kind 改成 guard，**不要删**——删了就没人知道这条路径曾经是断的。
 *
 * 与 A2-post-tool-use 共用同一份夹具和同一条 hook，唯一差别是配置的来源，所以两条对照着读：
 * 那边 1 条 `HookExecuted`，这边 0 条。`--trust-workspace` 照带，排除「被信任门摘掉」这个混淆项。
 */
import { HOOK_EXECUTED_EVENT_NAME } from "@sid-code/core/hook/hook-telemetry.ts";
import { HookEventName } from "@sid-code/core/hook/types.ts";
import type { SmokeCase } from "../../lib/types.ts";

const def: SmokeCase = {
  id: "A2-settings-flag-no-hook",
  ledger: "A2",
  feature: "Hook 追加动作",
  kind: "lock-defect",
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
      // [锁缺陷] 当前行为：零 HookExecuted
      { event: HOOK_EXECUTED_EVENT_NAME, count: 0 },
    ],
    files: [
      { path: "hello.txt", equals: "hello sid-code\n" },
      { path: "hook.log", absent: true },
    ],
  },
  mutations: [
    {
      file: "packages/core/src/config/hook-layers.ts",
      find: "  return layers;\n}",
      replace:
        '  const flag = require("./settings/settings.ts").getSettingsForSource("flagSettings").settings;\n  if (flag?.hooks) layers.push({ source: "user", file: "<--settings>", hooks: flag.hooks, untrusted: false });\n  return layers;\n}',
      why: "模拟缺陷被（未经评审地）修掉：--settings 的 hook 开始生效，锁缺陷用例必须变红提醒改断言",
    },
  ],
};

export default def;
