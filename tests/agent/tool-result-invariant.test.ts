/**
 * tool_result 协议不变量测试 — ADR-039
 *
 * 不变量：executeTools 返回的 results 中，tool_result 数量必须等于输入 content 里的
 * tool_use 数量（每个 tool_use_id 都有对应 tool_result）。
 *
 * 背景：OpenAI tool_calls 协议要求 assistant.tool_calls 后紧跟对每个 tool_call_id 的
 * tool 消息，缺一即 400（"An assistant message with 'tool_calls' must be followed by
 * tool messages responding to each 'tool_call_id'"）。该 bug 由 T0099 paired 重跑暴露
 * （2026-06-02，sid 跑到 30 步后 400 中断）。
 *
 * 修复点：src/query/tool-executor.ts
 *   1. 并发分支把非 abort 的 rejected 转成 error tool_result（不再静默丢弃）
 *   2. 结果组装处对仍缺失的 idx 补 error 占位（协议不变量最后防线）
 */

import { describe, test, expect } from "bun:test";
import type { ContentBlock, ToolUseBlock } from "../../src/llm/types.ts";
import { executeTools, type ToolExecutorDeps } from "../../src/query/tool-executor.ts";

/** 按真实 Tool 接口构造 mock：execute() + readOnly()/isConcurrencySafe() */
function makeTool(opts: {
  name: string;
  concurrencySafe: boolean;
  behavior: "ok" | "throw" | "abort";
}) {
  return {
    name: () => opts.name,
    description: () => `mock ${opts.name}`,
    inputSchema: () => ({ type: "object", properties: {} }),
    readOnly: () => opts.concurrencySafe,
    isConcurrencySafe: () => opts.concurrencySafe,
    async execute() {
      if (opts.behavior === "throw") throw new Error(`${opts.name} 内部抛错`);
      if (opts.behavior === "abort") {
        const e = new Error("aborted");
        e.name = "AbortError";
        throw e;
      }
      return { output: `${opts.name} ok` };
    },
  };
}

/**
 * 构造最小 deps。tools 数组按 name 注册。
 * hookSystem 默认放行；preHookThrows 用于模拟「pre hook 抛异常导致 Promise rejected」
 * （executeSingleTool catch 之外的异常路径）。
 */
function makeDeps(
  tools: ReturnType<typeof makeTool>[],
  opts: { preHookThrowsFor?: string } = {},
): ToolExecutorDeps {
  const byName = new Map(tools.map((t) => [t.name(), t]));
  return {
    config: { checkpoint: { enabled: false } } as any,
    toolRegistry: { get: (name: string) => byName.get(name) ?? null } as any,
    sessionState: {
      sessionId: "test-session",
      addToolDuration: () => {},
      recordToolResult: () => {},
    } as any,
    hookSystem: {
      firePreToolUseEvent: async (toolName: string) => {
        if (opts.preHookThrowsFor === toolName) {
          throw new Error(`pre hook 对 ${toolName} 抛异常`);
        }
        return { finalOutput: undefined };
      },
      firePostToolUseEvent: async () => ({ finalOutput: undefined }),
      firePostToolUseFailureEvent: async () => {},
    } as any,
    permissionChecker: null,
    getAbortSignal: () => undefined,
    requestUserConfirmation: async () => true,
  };
}

function toolUse(id: string, name: string): ToolUseBlock {
  return { type: "tool_use", id, name, input: {} };
}

/** 数不变量：tool_result 数 === tool_use 数，且 id 集合完全一致 */
function assertInvariant(results: ContentBlock[], toolUses: ToolUseBlock[]) {
  const resultIds = results
    .filter((r) => r.type === "tool_result")
    .map((r) => (r as { tool_use_id: string }).tool_use_id)
    .sort();
  const useIds = toolUses.map((b) => b.id).sort();
  expect(resultIds).toEqual(useIds);
}

describe("ADR-038 — tool_result 协议不变量", () => {
  test("基线：全部成功时 N 个 tool_use → N 个 tool_result", async () => {
    const tools = [
      makeTool({ name: "read", concurrencySafe: true, behavior: "ok" }),
      makeTool({ name: "grep", concurrencySafe: true, behavior: "ok" }),
      makeTool({ name: "write", concurrencySafe: false, behavior: "ok" }),
    ];
    const content = [toolUse("c1", "read"), toolUse("c2", "grep"), toolUse("c3", "write")];
    const ret = await executeTools(content, makeDeps(tools));

    expect(ret.results).toHaveLength(3);
    assertInvariant(ret.results, content as ToolUseBlock[]);
    // 全部非 error
    expect(ret.results.every((r) => r.type === "tool_result" && !(r as any).is_error)).toBe(true);
  });

  test("并发工具内部抛错：仍产出对应 error tool_result（不孤儿）", async () => {
    const tools = [
      makeTool({ name: "read", concurrencySafe: true, behavior: "ok" }),
      makeTool({ name: "boom", concurrencySafe: true, behavior: "throw" }),
      makeTool({ name: "grep", concurrencySafe: true, behavior: "ok" }),
    ];
    const content = [toolUse("c1", "read"), toolUse("c2", "boom"), toolUse("c3", "grep")];
    const ret = await executeTools(content, makeDeps(tools));

    // execute() 内部抛错由 executeSingleTool 的 catch 转成 error tool_result
    assertInvariant(ret.results, content as ToolUseBlock[]);
    const boom = ret.results.find(
      (r) => r.type === "tool_result" && (r as any).tool_use_id === "c2",
    ) as any;
    expect(boom).toBeDefined();
    expect(boom.is_error).toBe(true);
  });

  test("并发工具 pre-hook 抛异常(Promise rejected)：转成 error tool_result 而非孤儿", async () => {
    // 这是 T0099 400 的真实根因路径：异常发生在 executeSingleTool 的 catch 之外
    // (pre_tool_use hook)，Promise 直接 rejected，旧代码会静默丢弃该 tool_result。
    const tools = [
      makeTool({ name: "read", concurrencySafe: true, behavior: "ok" }),
      makeTool({ name: "blocked", concurrencySafe: true, behavior: "ok" }),
    ];
    const content = [toolUse("c1", "read"), toolUse("c2", "blocked")];
    const ret = await executeTools(
      content,
      makeDeps(tools, { preHookThrowsFor: "blocked" }),
    );

    // 关键断言：即使 blocked 的 Promise rejected，c2 仍有 tool_result
    assertInvariant(ret.results, content as ToolUseBlock[]);
    const blocked = ret.results.find(
      (r) => r.type === "tool_result" && (r as any).tool_use_id === "c2",
    ) as any;
    expect(blocked).toBeDefined();
    expect(blocked.is_error).toBe(true);
  });

  test("abort 异常仍向上抛(由 loop.ts catch 兜底)，不被静默吞", async () => {
    const tools = [
      makeTool({ name: "read", concurrencySafe: true, behavior: "ok" }),
      makeTool({ name: "cancelled", concurrencySafe: true, behavior: "abort" }),
    ];
    const content = [toolUse("c1", "read"), toolUse("c2", "cancelled")];

    // abort 必须 throw，让上层 loop 的兜底统一补齐（保持与现有行为一致）
    let thrown: Error | null = null;
    try {
      await executeTools(content, makeDeps(tools));
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown).not.toBeNull();
    expect(thrown?.name).toBe("AbortError");
  });
});
