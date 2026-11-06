/**
 * 无头放行门禁（方案 T3+T4）：A 档命令的「声明 → 行为」一致性。
 *
 * ## 这份门禁防什么
 *
 * `headless-dispatch.ts` 的 `headlessRefusal` 是放行判定的唯一实现，它只看
 * `CommandBase.headless` 这个**声明**。声明与实现不符时，无头下会发生两件事：
 *
 * 1. 命令返回 `dialog` / `confirm` / `clear` → 分发层明确报错（安全，但放行就是错的）；
 * 2. 命令返回 `quit` → 打印一句话后退 **0**（`headless-dispatch.ts` 的 `quit` → `output`），
 *    CI 拿到的是「成功」；这就是「假成功」，比拒绝更糟（方案 D9）。
 *
 * 另一类假成功来自**未注入的 ctx 字段**：命令写 `ctx.setEffort?.(...)`，无头 cmdCtx 里
 * 该字段不存在，可选链静默跳过，命令却照旧返回「推理强度已切换为 high」（方案 D6）。
 * 静态扫源码抓不到这类问题（字段可能经 shared/ 辅助模块间接访问），所以这里用
 * `Proxy` 在**运行时**记录对注入表外字段的读取。
 *
 * ## 注入表为什么不会腐化
 *
 * 注入表 = `buildHeadlessCommandContext()` 返回对象的键集合，与 `app.ts` 生产路径共用
 * 同一个函数（不是手抄一份）。cmdCtx 增删字段只改那个函数，本门禁自动跟随。
 *
 * ## 白名单的边界
 *
 * 只有**明确的诚实降级**（命令里先 `if (!ctx.xxx)` 再返回「当前环境不支持…」）才可进
 * `DEGRADATION_ALLOWLIST`。断言是双向相等：新增未注入字段访问会红，白名单过期也会红。
 */

import { describe, test, expect } from "bun:test";
import { CommandExecutor } from "@sid-code/cli/command/executor.ts";
import { loadBuiltinCommands } from "@sid-code/cli/command/loaders.ts";
import { buildHeadlessCommandContext } from "@sid-code/cli/command/headless-command-context.ts";
import { resolveHeadlessSlash } from "@sid-code/cli/command/headless-dispatch.ts";
import type { CommandExecutionResult } from "@sid-code/cli/command/types.ts";
import { Manager } from "@sid-code/core/context/manager.ts";
import { defaultConfig } from "@sid-code/core/config/config.ts";
import { SessionState } from "@sid-code/core/session/state.ts";
import { Registry } from "@sid-code/core/tool/registry.ts";

/**
 * A 档 22 个命令 + 门禁用的**典型参数**。
 *
 * 混合型 5 个（permissions / config / help / stats / commands）无参会返回 `dialog`，
 * 这是方案 §八.3 拍板接受的形态，所以这里一律给带参形态；无参安全性由下面另一组用例锁。
 *
 * 加命令时必须同步加这里——`清单 = 真实命令表` 的断言会红，这是刻意的：
 * 放宽一个命令的可见面，必须同时在行为门禁里覆盖它。
 */
const A_TIER_PROBES: Array<{ name: string; args: string }> = [
  { name: "cache", args: "" },
  { name: "conflict", args: "" },
  { name: "diff", args: "" },
  { name: "doctor", args: "" },
  { name: "ps", args: "" },
  { name: "telemetry", args: "" },
  { name: "whoami", args: "" },
  { name: "workflows", args: "" },
  { name: "cost", args: "" },
  { name: "todos", args: "" },
  { name: "status", args: "" },
  { name: "checkpoints", args: "" },
  { name: "insights", args: "" },
  { name: "perf", args: "" },
  { name: "trace", args: "--list" },
  { name: "batch", args: "给命令补一个单测" },
  { name: "plan", args: "" },
  { name: "permissions", args: "list" },
  { name: "config", args: "show" },
  { name: "help", args: "cost" },
  { name: "stats", args: "text" },
  { name: "commands", args: "list" },
];

/**
 * 无参返回 `dialog` 的混合型命令（方案 A 档「混合型」分组）。
 *
 * 无参 dialog 是设计好的 fail-closed：`headless-dispatch` 把它翻成非 0 的明确报错。
 * 这里只锁「它必须是 dialog」——若哪天变成 `quit`，无头下就退 0 假装成功了（D9）。
 */
const MIXED_DIALOG_ON_NO_ARGS = ["permissions", "config", "help", "stats", "commands"];

/**
 * 「访问了注入表外的字段，但属于明确诚实降级」的白名单。
 *
 * `/status` 读 `ctx.getEffortState`（`status.ts`），该字段无头未注入，但命令里有
 * `if (effort)` 降级，不会假成功。**只有这种形态才允许登记**；`?.()` + 报成功的一律不放。
 */
const DEGRADATION_ALLOWLIST: Record<string, string[]> = {
  status: ["getEffortState"],
};

/** 无头 cmdCtx 用真实核心类实例构造：薄桩会让命令崩在桩上，把「桩不完整」误报成命令问题。 */
const config = defaultConfig();
config.provider = "gate-test";
config.model = "gate-model";

const CTX = buildHeadlessCommandContext({
  ctxMgr: new Manager({ maxTokens: 200_000 }),
  toolRegistry: new Registry(),
  cwd: process.cwd(),
  config,
  sessionId: "gate-logical-session",
  checkpointSessionId: "gate-logical-session",
  provider: { name: "gate-test" } as never,
  sessionState: new SessionState("gate-process-session", process.cwd()),
  permissionChecker: {
    getRuleLoader: () => ({ getAllRules: () => [] }),
    getDenialTracking: () => ({ totalDenials: 0, consecutiveDenials: 0 }),
  } as never,
});

const COMMANDS = await loadBuiltinCommands();

/** 执行一次探针，同时收集「读到的注入表外字段」。 */
async function runProbe(probe: { name: string; args: string }): Promise<{
  result: CommandExecutionResult;
  missing: string[];
}> {
  const missing = new Set<string>();
  const proxied = new Proxy(CTX, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && !(prop in target)) missing.add(prop);
      return Reflect.get(target, prop, receiver);
    },
  });
  const input = probe.args ? `/${probe.name} ${probe.args}` : `/${probe.name}`;
  const result = await new CommandExecutor(proxied).executeSlashCommand(input, COMMANDS);
  return { result, missing: [...missing].sort() };
}

describe("放行清单 = 真实命令表里声明 headless 的内置命令", () => {
  test("双向一致：多一个少一个都红", () => {
    // T4b 会把 headless 扩成结构体；这里按「非 undefined 且非 false」判，扩完无需改本断言。
    const declared = COMMANDS.filter(
      (c) =>
        (c.source ?? "builtin") === "builtin" && c.headless !== undefined && c.headless !== false,
    )
      .map((c) => c.name)
      .sort();
    // /init 早于本方案放行（init/index.ts），一并纳入，避免出现「声明了但没人覆盖行为」的命令。
    expect(declared).toEqual([...A_TIER_PROBES.map((p) => p.name), "init"].sort());
  });
});

describe("放行真的生效：resolveHeadlessSlash 不再拒绝这 22 个命令", () => {
  for (const probe of A_TIER_PROBES) {
    test(`/${probe.name}`, async () => {
      const input = probe.args ? `/${probe.name} ${probe.args}` : `/${probe.name}`;
      const outcome = await resolveHeadlessSlash(input, {
        commands: COMMANDS,
        executor: new CommandExecutor(CTX),
      });
      expect(outcome.kind).not.toBe("error");
    });
  }
});

describe("放行后在无头 cmdCtx 下的行为：不产出交互请求、不碰未注入字段", () => {
  for (const probe of A_TIER_PROBES) {
    test(`/${probe.name}`, async () => {
      const { result, missing } = await runProbe(probe);
      // ① dialog / confirm / clear 需要人在场；quit 会退 0 假装成功（D9）。四者都不许出现。
      expect(["dialog", "confirm", "clear", "quit"]).not.toContain(result.type);
      // ② 未注入字段 + 可选链 = 静默假成功（D6）。双向相等：白名单过期也红。
      expect(missing).toEqual(DEGRADATION_ALLOWLIST[probe.name] ?? []);
    });
  }
});

describe("混合型命令无参仍是安全失败（dialog，不是 quit/clear）", () => {
  for (const name of MIXED_DIALOG_ON_NO_ARGS) {
    test(`/${name}`, async () => {
      const { result } = await runProbe({ name, args: "" });
      expect(result.type).toBe("dialog");
    });
  }
});
