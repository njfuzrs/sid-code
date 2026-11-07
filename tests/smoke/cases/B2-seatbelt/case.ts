/**
 * B2 Seatbelt 沙箱：`enableSandbox: true` 下 bash 经 sandbox-exec 执行，敏感目录读被拒、
 * 工作区内写放行。仅 macOS（Seatbelt 是 macOS 机制），其他平台 skip。
 *
 * 期望来源：核心功能触发清单 B2 的人工五步实测（2026-11-05，会话 20261105-203209-465586d3）：
 * `sandbox_init{enabled=true,probe_ok=true,network=localhost}`；bash 每条 `PostToolUse.sandboxed=true`；
 * `cat ~/.ssh/known_hosts` → `Operation not permitted`；`echo x > ./ok.txt` 成功。命令原样取自那次实测（去掉了 `| head -1`，否则退出码被 head 吃掉）。
 *
 * 与人工实测的差别：
 * - `enableSandbox` 写在隔离配置目录的用户级 settings（项目级会被 PROJECT_BEHAVIOR_FIELDS 静默忽略，实测已注明）；
 * - `~/.ssh/known_hosts` 是假 HOME 里预置的，不碰真实家目录。profile 按 `homedir()` 展开敏感目录，
 *   子进程 HOME 指向假 HOME，2026-11-07 探针确认 deny 规则落在假 HOME 上；
 * - **不测「工作区外写被拒」**（人工五步的第 3 步）：假 HOME 在 `tmpdir()` 即 `/private/var/folders` 下，
 *   而它本身就在写白名单里（`collectWritePaths`），写 `~/x` 必然成功——2026-11-07 第一版用例就这样红了。
 *   要测只能写真实 `$HOME`，G2 不碰真实家目录；这条由 G1 `sandbox-exec-real.test.ts` A4 覆盖
 *   （它为同一原因把 fakeHome 放在真实 `$HOME` 下并自行清理）。
 * - 不测网络档（curl 1.1.1.1）：CI runner 的出网策略不受控，「连不上」可能是网络本身而非沙箱。
 * - `write_paths_count` 不断言：它取决于本机装了哪些包管理器缓存目录，平台间不可比。
 * - 断言 `tool_result` 文本用 events 里的 `PostToolUseFailure.error_head`，那是回灌给模型的同一份文本。
 */
import { SANDBOX_INIT_EVENT_NAME } from "@sid-code/core/permission/sandbox.ts";
import { HookEventName } from "@sid-code/core/hook/types.ts";
import type { SmokeCase } from "../../lib/types.ts";

const def: SmokeCase = {
  id: "B2-seatbelt",
  ledger: "B2",
  feature: "Seatbelt 沙箱",
  kind: "guard",
  platforms: ["darwin"],
  repo: {},
  home: { ".ssh/known_hosts": "smoke-secret-host ssh-ed25519 AAAA\n" },
  settings: ({ defaults }) => ({ ...defaults, enableSandbox: true }),
  argv: ["-p", "跑几条命令看看沙箱"],
  expect: {
    events: [
      {
        event: SANDBOX_INIT_EVENT_NAME,
        where: { enabled: true, platform: "darwin", probe_ok: true, network: "localhost" },
        count: 1,
      },
      // 分母对齐：3 条 bash 全部 sandboxed，含被拒的失败路径
      { event: HookEventName.PostToolUse, where: { tool_name: "bash", sandboxed: true }, count: 3 },
      { event: HookEventName.PostToolUse, where: { tool_name: "bash" }, count: 3 },
      {
        event: HookEventName.PostToolUse,
        where: { tool_use_id: "toolu_smoke_1", is_error: false },
        count: 1,
      },
      {
        event: HookEventName.PostToolUse,
        where: { tool_use_id: "toolu_smoke_2", is_error: true },
        count: 1,
      },
      {
        event: HookEventName.PostToolUse,
        where: { tool_use_id: "toolu_smoke_3", is_error: false },
        count: 1,
      },
    ],
    files: [{ path: "ok.txt", equals: "x\n" }],
    output: ({ requests }) => {
      // known_hosts 内容不能出现在回灌给模型的任何请求里
      const wire = JSON.stringify(requests);
      if (wire.includes("smoke-secret-host"))
        return "~/.ssh/known_hosts 的内容进了模型请求（敏感目录 deny 没生效）";
      if (!/Operation not permitted/i.test(wire))
        return "模型请求里没有 Operation not permitted（被拒的形态变了）";
      return null;
    },
  },
  mutations: [
    {
      file: "packages/core/src/tool/bash.ts",
      find: "      ? this.sandboxManager.wrapCommand(rawCommand, shell)\n      : rawCommand;",
      replace: "      ? rawCommand\n      : rawCommand;",
      why: "前台 bash 不再经 sandbox-exec 包裹，但 sandboxed 埋点照报 true（「标着沙箱、实际裸跑」）",
    },
    {
      file: "packages/core/src/permission/sandbox.ts",
      find: '    for (const rel of SENSITIVE_HOME_DIRS) {\n      const real = this.realpathForProfile(`${home}/${rel}`, "敏感目录");\n      if (real) lines.push(',
      replace:
        '    for (const rel of [] as string[]) {\n      const real = this.realpathForProfile(`${home}/${rel}`, "敏感目录");\n      if (real) lines.push(',
      why: "profile 丢了敏感目录 deny，~/.ssh 在沙箱里可读",
    },
  ],
};

export default def;
