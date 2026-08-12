/**
 * 增量呈现（先完成先出）回归测试
 *
 * 治的现象（docs/_template/批量执行等到批量结束才输出.txt）：并行批次里
 * `[grep 快, grep 快, read_many 快, glob 撞 20s 超时]`，用户在 20 秒里屏幕上
 * 一个结果都看不到，然后 4 张卡片同一帧一起翻。
 *
 * 根因不是"调度在互等"——partitionToolCalls 确实把这 4 个只读工具合成一个并行批次并发跑了。
 * 卡的是**结果出口**：withConcurrencyLimit 末尾 `await Promise.all(workers)` 必须等最慢的那个，
 * 主循环再把 N 个 tool_result 打包成一条 user 消息，而 UI 的卡片翻转恰恰依赖那条消息。
 *
 * 修复：executeTools 增加 onToolSettled 增量回调，每个工具**自己** settle 的那一刻上报一次。
 * 本文件锁住三件事：
 *   1. 上报时机 —— 快工具的回调必须在慢工具还没结束前就已经发生（真正的"先完成先出"）；
 *   2. 覆盖完整性 —— 7 条结果路径（含权限拒绝/hook 阻止/级联取消/异常兜底）都要上报，
 *      漏一条 = 那个工具的卡片永远停在 Executing，比不做更糟；
 *   3. 协议不变量不回退 —— 增量呈现是旁路，results 仍旧齐、仍旧一次性返回。
 */

import { describe, test, expect } from "bun:test";
import type { ContentBlock, ToolUseBlock } from "@sid-code/core/llm/types.ts";
import { executeTools, type ToolExecutorDeps } from "@sid-code/core/query/tool-executor.ts";

/** 可控完成时机的 mock 工具：delayMs 控制快慢，behavior 控制结果形态 */
function makeTool(opts: {
  name: string;
  concurrencySafe: boolean;
  delayMs?: number;
  behavior?: "ok" | "error" | "throw";
}) {
  return {
    name: () => opts.name,
    description: () => `mock ${opts.name}`,
    inputSchema: () => ({ type: "object", properties: {} }),
    readOnly: () => opts.concurrencySafe,
    isConcurrencySafe: () => opts.concurrencySafe,
    async execute() {
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      if (opts.behavior === "throw") throw new Error(`${opts.name} 内部抛错`);
      if (opts.behavior === "error") return { output: `${opts.name} 失败`, isError: true };
      return { output: `${opts.name} ok` };
    },
  };
}

function makeDeps(
  tools: ReturnType<typeof makeTool>[],
  opts: {
    onToolSettled?: ToolExecutorDeps["onToolSettled"];
    denyTool?: string;
    blockHookFor?: string;
  } = {},
): ToolExecutorDeps {
  const byName = new Map(tools.map((t) => [t.name(), t]));
  return {
    config: { checkpoint: { enabled: false } } as any,
    toolRegistry: {
      get: (name: string) => byName.get(name) ?? null,
      isDeferred: () => false,
      isActivated: () => true,
    } as any,
    sessionState: {
      sessionId: "test-session",
      addToolDuration: () => {},
      recordToolResult: () => {},
    } as any,
    hookSystem: {
      firePreToolUseEvent: async (toolName: string) => {
        if (opts.blockHookFor === toolName) {
          return {
            finalOutput: {
              isBlocking: () => true,
              getEffectiveReason: () => `hook 拒绝 ${toolName}`,
            },
          };
        }
        return { finalOutput: undefined };
      },
      firePostToolUseEvent: async () => ({ finalOutput: undefined }),
      firePostToolUseFailureEvent: async () => {},
    } as any,
    // 权限层：denyTool 命中则拒绝（走 resolveToolPermission 的 reject 分支）
    permissionChecker: opts.denyTool
      ? ({
          check: async (toolName: string) =>
            toolName === opts.denyTool
              ? { allowed: false, reason: `不允许 ${toolName}` }
              : { allowed: true },
        } as any)
      : null,
    getAbortSignal: () => undefined,
    requestUserConfirmation: async () => false,
    onToolSettled: opts.onToolSettled,
  };
}

function toolUse(id: string, name: string): ToolUseBlock {
  return { type: "tool_use", id, name, input: {} };
}

function resultIds(results: ContentBlock[]): string[] {
  return results
    .filter((r) => r.type === "tool_result")
    .map((r) => (r as { tool_use_id: string }).tool_use_id)
    .sort();
}

describe("增量呈现 — 先完成先出（不等最慢的兄弟）", () => {
  test("文档场景复现：3 个快工具在慢工具结束前就已上报", async () => {
    // 还原 transcript：3 个快只读工具 + 1 个慢工具（模拟 glob 撞 ripgrep 20s 超时）。
    const tools = [
      makeTool({ name: "grep", concurrencySafe: true, delayMs: 5 }),
      makeTool({ name: "grep2", concurrencySafe: true, delayMs: 5 }),
      makeTool({ name: "read_many", concurrencySafe: true, delayMs: 5 }),
      makeTool({ name: "glob", concurrencySafe: true, delayMs: 220 }),
    ];
    const content = [
      toolUse("c1", "grep"),
      toolUse("c2", "grep2"),
      toolUse("c3", "read_many"),
      toolUse("c4", "glob"),
    ];

    // 必须断言**时间**而非顺序：批次结束后的收集循环是按 idx 顺序遍历的，
    // 所以"c1/c2/c3 先于 c4 上报"在旧实现下也天然成立——只测顺序等于没测。
    // 真正的区别是**墙钟**：修复后快工具在 ~5ms 就上报，旧实现要等慢工具的 220ms。
    const t0 = Date.now();
    const settledAt = new Map<string, number>();

    const ret = await executeTools(
      content,
      makeDeps(tools, {
        onToolSettled: (id) => settledAt.set(id, Date.now() - t0),
      }),
    );
    const totalMs = Date.now() - t0;

    // 1) 3 个快工具的上报时刻必须远早于批次总耗时（旧实现下三者都 ≈ totalMs）
    for (const id of ["c1", "c2", "c3"]) {
      expect(settledAt.get(id)).toBeLessThan(totalMs / 2);
    }
    // 2) 慢工具的上报时刻贴着批次结束
    expect(settledAt.get("c4")).toBeGreaterThan(totalMs / 2);
    // 3) 协议不变量不回退：results 仍旧齐
    expect(resultIds(ret.results)).toEqual(["c1", "c2", "c3", "c4"]);
  });

  test("每个 tool_use_id 至多上报一次（幂等，防卡片重复翻转）", async () => {
    const tools = [
      makeTool({ name: "read", concurrencySafe: true }),
      makeTool({ name: "write", concurrencySafe: false }),
    ];
    const content = [toolUse("c1", "read"), toolUse("c2", "write")];

    const counts = new Map<string, number>();
    await executeTools(
      content,
      makeDeps(tools, {
        onToolSettled: (id) => counts.set(id, (counts.get(id) ?? 0) + 1),
      }),
    );

    expect([...counts.values()].every((n) => n === 1)).toBe(true);
    expect([...counts.keys()].sort()).toEqual(["c1", "c2"]);
  });

  test("覆盖完整性：权限拒绝 / hook 阻止 / 异常兜底 也要上报（否则卡片永远卡在 Executing）", async () => {
    // 三条非"正常完成"的结果路径，各自都必须产出一次上报。
    const denied = await (async () => {
      const seen: string[] = [];
      const tools = [makeTool({ name: "bash", concurrencySafe: false })];
      await executeTools(
        [toolUse("c1", "bash")],
        makeDeps(tools, {
          denyTool: "bash",
          onToolSettled: (id) => seen.push(id),
        }),
      );
      return seen;
    })();
    expect(denied).toEqual(["c1"]);

    const hookBlocked = await (async () => {
      const seen: string[] = [];
      const tools = [makeTool({ name: "read", concurrencySafe: true })];
      await executeTools(
        [toolUse("c1", "read")],
        makeDeps(tools, {
          blockHookFor: "read",
          onToolSettled: (id) => seen.push(id),
        }),
      );
      return seen;
    })();
    expect(hookBlocked).toEqual(["c1"]);

    const threw = await (async () => {
      const seen: string[] = [];
      const tools = [makeTool({ name: "read", concurrencySafe: true, behavior: "throw" })];
      await executeTools(
        [toolUse("c1", "read")],
        makeDeps(tools, {
          onToolSettled: (id) => seen.push(id),
        }),
      );
      return seen;
    })();
    expect(threw).toEqual(["c1"]);

    // 工具不存在（registry 拿不到实例）也要上报
    const missing = await (async () => {
      const seen: string[] = [];
      await executeTools(
        [toolUse("c1", "nope")],
        makeDeps([], {
          onToolSettled: (id) => seen.push(id),
        }),
      );
      return seen;
    })();
    expect(missing).toEqual(["c1"]);
  });

  test("上报的 block 就是最终进 results 的那一个（增量卡与最终卡不会跳变）", async () => {
    const tools = [
      makeTool({ name: "read", concurrencySafe: true }),
      makeTool({ name: "grep", concurrencySafe: true, behavior: "error" }),
    ];
    const content = [toolUse("c1", "read"), toolUse("c2", "grep")];

    const reported = new Map<string, ContentBlock>();
    const ret = await executeTools(
      content,
      makeDeps(tools, { onToolSettled: (id, s) => reported.set(id, s.block) }),
    );

    for (const r of ret.results) {
      if (r.type !== "tool_result") continue;
      const id = (r as any).tool_use_id as string;
      // 同一个对象/同样的内容——UI 用它提前翻卡，批次末重建出的卡必须一致
      expect(reported.get(id)).toBeDefined();
      expect((reported.get(id) as any).content).toEqual((r as any).content);
      expect((reported.get(id) as any).is_error ?? false).toEqual((r as any).is_error ?? false);
    }
    // is_error 也如实传递（错误卡要翻成 Error 而非 Success）
    expect((reported.get("c2") as any).is_error).toBe(true);
  });

  test("未注入 onToolSettled（无头/子代理）时行为不变，results 照常齐", async () => {
    const tools = [
      makeTool({ name: "read", concurrencySafe: true }),
      makeTool({ name: "write", concurrencySafe: false }),
    ];
    const content = [toolUse("c1", "read"), toolUse("c2", "write")];
    const ret = await executeTools(content, makeDeps(tools));
    expect(resultIds(ret.results)).toEqual(["c1", "c2"]);
  });
});

describe("真实耗时 — 逐工具上报，不再按批次平摊", () => {
  test("慢工具的耗时明显大于快工具（平摊会把两者抹成同一个数）", async () => {
    const tools = [
      makeTool({ name: "fast", concurrencySafe: true, delayMs: 5 }),
      makeTool({ name: "slow", concurrencySafe: true, delayMs: 180 }),
    ];
    const content = [toolUse("c1", "fast"), toolUse("c2", "slow")];
    const ret = await executeTools(content, makeDeps(tools));

    const fast = ret.durations?.get("c1");
    const slow = ret.durations?.get("c2");
    expect(fast).toBeGreaterThanOrEqual(0);
    expect(slow).toBeGreaterThanOrEqual(100);
    // 关键：两者必须可区分。平摊口径下它们会相等（都是 总耗时/2）。
    expect(slow!).toBeGreaterThan(fast! + 50);
  });

  test("durations 覆盖每个 tool_use_id（tool_end 才有真值可报）", async () => {
    const tools = [
      makeTool({ name: "read", concurrencySafe: true }),
      makeTool({ name: "write", concurrencySafe: false }),
    ];
    const content = [toolUse("c1", "read"), toolUse("c2", "write")];
    const ret = await executeTools(content, makeDeps(tools));
    expect([...(ret.durations?.keys() ?? [])].sort()).toEqual(["c1", "c2"]);
  });
});
