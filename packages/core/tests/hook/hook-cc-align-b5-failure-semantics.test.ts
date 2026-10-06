/**
 * Hook 对齐 CC · 批 5（Q7）：PostToolUseFailure 触发语义切到 CC（HC23）
 *
 * 用户 hook 看到的：
 *   - 工具执行了但失败（isError / 抛异常）→ 只有 PostToolUseFailure，没有 PostToolUse
 *   - 权限拒绝 → 只有 PermissionDenied
 *   - 校验失败 / PreToolUse 阻止 → 两者都没有（runtime 消费者仍收到 Failure 给 span 收尾）
 * 内部 runtime 消费者口径不变：session-metrics 的失败数仍按「工具执行了但失败」计。
 */

import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod/v4";
import { HookSystem } from "@sid-code/core/hook/system.ts";
import { HookEventName, ConfigSource } from "@sid-code/core/hook/types.ts";
import { executeTools, type ToolExecutorDeps } from "@sid-code/core/query/tool-executor.ts";
import { SessionMetricsCollector } from "@sid-code/core/debug/session-metrics.ts";

const dir = mkdtempSync(join(tmpdir(), "sid-b5-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const WATCHED = [
  HookEventName.PostToolUse,
  HookEventName.PostToolUseFailure,
  HookEventName.PermissionDenied,
] as const;

/** 用户 command hook 把事件名追加到文件；runtime hook 记到内存 */
function makeSystem(tag: string) {
  const sys = new HookSystem();
  const userLog = join(dir, `${tag}-user.log`);
  const runtimeLog: string[] = [];
  const hooks: Record<string, unknown[]> = {};
  for (const ev of WATCHED) {
    hooks[ev] = [{ hooks: [{ type: "command", command: `echo ${ev} >> '${userLog}'` }] }];
  }
  sys.initializeFromSources([{ hooks, source: ConfigSource.User }]);
  for (const ev of WATCHED) {
    sys.registerHook(
      { type: "runtime", name: `probe-${ev}`, action: async () => void runtimeLog.push(ev) },
      ev,
      { source: "runtime" as any },
    );
  }
  const userEvents = () =>
    existsSync(userLog) ? readFileSync(userLog, "utf8").trim().split("\n").filter(Boolean) : [];
  return { sys, userEvents, runtimeLog };
}

function makeTool(opts: {
  name: string;
  behavior?: "ok" | "error" | "throw";
  zodSchema?: unknown;
}) {
  return {
    name: () => opts.name,
    description: () => opts.name,
    inputSchema: () => ({ type: "object", properties: {} }),
    readOnly: () => true,
    isConcurrencySafe: () => true,
    ...(opts.zodSchema ? { zodSchema: opts.zodSchema } : {}),
    async execute() {
      if (opts.behavior === "throw") throw new Error("boom");
      if (opts.behavior === "error") return { output: "ENOENT: nope.txt", isError: true };
      return { output: "ok" };
    },
  };
}

function deps(
  sys: HookSystem,
  tools: ReturnType<typeof makeTool>[],
  denyTool?: string,
): ToolExecutorDeps {
  const byName = new Map(tools.map((t) => [t.name(), t]));
  return {
    config: { checkpoint: { enabled: false } } as any,
    toolRegistry: {
      get: (n: string) => byName.get(n) ?? null,
      isDeferred: () => false,
      isActivated: () => true,
      isToolSearchEnabled: () => false,
    } as any,
    sessionState: {
      sessionId: "b5",
      addToolDuration: () => {},
      recordToolResult: () => {},
    } as any,
    hookSystem: sys,
    permissionChecker: denyTool
      ? ({
          check: async (req: any) =>
            (req?.toolName ?? req) === denyTool
              ? { allowed: false, reason: "不允许" }
              : { allowed: true },
          recordUserDenial: () => {},
        } as any)
      : null,
    preToolUseCache: new Map(),
    getAbortSignal: () => undefined,
    requestUserConfirmation: async () => false,
  } as ToolExecutorDeps;
}

const use = (id: string, name: string, input: Record<string, unknown> = {}) =>
  ({ type: "tool_use", id, name, input }) as any;

/** 拒绝 / 校验分支是 fire-and-forget，等 command hook 跑完 */
const settle = () => new Promise((r) => setTimeout(r, 300));

describe("用户 hook 看到的触发语义（CC）", () => {
  test("工具返回 isError → 只有 PostToolUseFailure", async () => {
    const { sys, userEvents } = makeSystem("iserror");
    await executeTools(
      [use("a", "read")],
      deps(sys, [makeTool({ name: "read", behavior: "error" })]),
    );
    await settle();
    expect(userEvents()).toEqual(["PostToolUseFailure"]);
  });

  test("工具抛异常 → 只有 PostToolUseFailure", async () => {
    const { sys, userEvents } = makeSystem("throw");
    await executeTools(
      [use("b", "read")],
      deps(sys, [makeTool({ name: "read", behavior: "throw" })]),
    );
    await settle();
    expect(userEvents()).toEqual(["PostToolUseFailure"]);
  });

  test("成功 → 只有 PostToolUse", async () => {
    const { sys, userEvents } = makeSystem("ok");
    await executeTools([use("c", "read")], deps(sys, [makeTool({ name: "read" })]));
    await settle();
    expect(userEvents()).toEqual(["PostToolUse"]);
  });

  test("权限拒绝 → 只有 PermissionDenied；runtime 也只收到它", async () => {
    const { sys, userEvents, runtimeLog } = makeSystem("deny");
    await executeTools(
      [use("d", "bash", { command: "rm -rf /" })],
      deps(sys, [makeTool({ name: "bash" })], "bash"),
    );
    await settle();
    expect(userEvents()).toEqual(["PermissionDenied"]);
    expect(runtimeLog).toEqual([HookEventName.PermissionDenied]);
  });

  test("校验失败 → 用户 hook 收不到；runtime 仍收到 Failure（span 收尾）", async () => {
    const { sys, userEvents, runtimeLog } = makeSystem("validation");
    await executeTools(
      [use("e", "ask_user_question", {})],
      deps(sys, [makeTool({ name: "ask_user_question", zodSchema: z.object({ q: z.string() }) })]),
    );
    await settle();
    expect(userEvents()).toEqual([]);
    expect(runtimeLog).toEqual([HookEventName.PostToolUseFailure]);
  });
});

describe("内部口径不变（session-metrics）", () => {
  test("isError / 异常计失败；校验失败 / 权限拒绝不计（与切换前一致）", async () => {
    const sys = new HookSystem();
    const m = new SessionMetricsCollector();
    m.registerHooks(sys);
    const tools = [
      makeTool({ name: "read" }),
      makeTool({ name: "grep", behavior: "error" }),
      makeTool({ name: "glob", behavior: "throw" }),
      makeTool({ name: "ask_user_question", zodSchema: z.object({ q: z.string() }) }),
      makeTool({ name: "bash" }),
    ];
    await executeTools(
      [
        use("1", "read"),
        use("2", "grep"),
        use("3", "glob"),
        use("4", "ask_user_question", {}),
        use("5", "bash", { command: "x" }),
      ],
      deps(sys, tools, "bash"),
    );
    await settle();
    const t = m.getMetrics().tools;
    expect(t.totalSuccess).toBe(1);
    expect(t.totalFail).toBe(2);
    expect(t.totalCalls).toBe(3);
  });
});
