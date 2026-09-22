/**
 * P2-8 回归：流式抢跑与 executeTools 之间的双执行窗口。
 *
 * 缺陷文档《20260920-AgenticLoop主循环审查》十、P2-8。抢跑（StreamingToolExecutor /
 * `onToolUseComplete`）是 fire-and-forget，它的去重集合只活在 app.ts 的闭包里，
 * `executeTools` 看不见。于是存在一个真实窗口：
 *
 *   流已结束（processStream 返回）→ 抢跑仍在跑 → executeTools 同步读缓存 miss
 *   → 又执行一遍同一个 tool_use。
 *
 * 后果是同一个工具跑两次、PreToolUse 也 fire 两次。抢跑只挑"并发安全"工具，但
 * **并发安全 ≠ 无副作用**，所以这是正确性问题而非仅仅浪费。默认
 * `SID_ENABLE_STREAMING_TOOL_EXEC` 未开，属 opt-in 路径的洞。
 *
 * 修法是给 executeTools 一个 `awaitPrecomputedResult`，让它在预检阶段等抢跑落地
 * 再读缓存。本测试直接驱动 executeTools，不经 TUI。
 */
import { describe, test, expect } from "bun:test";
import { executeTools } from "@sid-code/core/query/tool-executor.ts";
import type { ToolExecutorDeps, SingleToolOutcome } from "@sid-code/core/query/tool-executor.ts";
import { Registry as ToolRegistry } from "@sid-code/core/tool/registry.ts";
import { SessionState } from "@sid-code/core/session/state.ts";
import type { ContentBlock, ToolUseBlock } from "@sid-code/core/llm/types.ts";
import type { LegacyTool } from "@sid-code/core/tool/types.ts";

/** 记录真实执行次数的 mock 工具（并发安全 = 会被抢跑挑中的那一类） */
function countingTool(name: string, counter: { n: number }): LegacyTool {
  return {
    name: () => name,
    description: () => name,
    inputSchema: () => ({ type: "object", properties: { q: { type: "string" } } }),
    readOnly: () => true,
    isConcurrencySafe: () => true,
    execute: async () => {
      counter.n += 1;
      return { output: `ran#${counter.n}` };
    },
  } as unknown as LegacyTool;
}

function block(id: string, name: string): ToolUseBlock {
  return { type: "tool_use", id, name, input: { q: "x" } };
}

function makeDeps(
  registry: ToolRegistry,
  overrides: Partial<ToolExecutorDeps> = {},
): ToolExecutorDeps {
  return {
    config: { model: "m", provider: "anthropic" } as never,
    toolRegistry: registry,
    sessionState: new SessionState("test-p2-8"),
    // hookSystem：任何 fire* 都返回空聚合结果（不 block、不改写）
    hookSystem: new Proxy(
      {},
      { get: () => async () => ({ success: true, allOutputs: [], errors: [] }) },
    ) as never,
    permissionChecker: null,
    getAbortSignal: () => undefined,
    requestUserConfirmation: async () => true,
    ...overrides,
  } as unknown as ToolExecutorDeps;
}

describe("P2-8 · 抢跑仍在跑时 executeTools 不得重复执行", () => {
  test("抢跑未 settle 就进 executeTools → 仍只执行一次（旧实现会跑两次）", async () => {
    const counter = { n: 0 };
    const registry = new ToolRegistry();
    registry.register(countingTool("web_search", counter) as never);

    const b = block("call-1", "web_search");
    const content: ContentBlock[] = [b];

    // 模拟 app.ts 的抢跑：一个**还没 settle** 的 promise，落地后才写 cache。
    //
    // 落地刻意挂在**定时器**（宏任务）上，而不是一个测试自己 resolve 的 promise：
    // 后者只隔几个微任务，而 executeTools 在预检之后还有若干 await（权限/hook），
    // 微任务churn 足以让抢跑在批次那次同步读之前就落地——于是即使把修复去掉，
    // 测试照样绿（第一版就是这么写的，它什么都没证明）。用定时器拉开到宏任务，
    // 只有真的 await 过 inflight 才可能读到结果。
    const cache = new Map<string, SingleToolOutcome>();
    const inflight = new Map<string, Promise<void>>();
    const prefetch = new Promise<void>((resolve) => {
      setTimeout(() => {
        counter.n += 1; // 抢跑自己执行了一次
        cache.set(b.id, {
          block: { type: "tool_result", tool_use_id: b.id, content: "prefetched" },
        } as SingleToolOutcome);
        resolve();
      }, 30);
    });
    inflight.set(b.id, prefetch);

    const deps = makeDeps(registry, {
      getPrecomputedResult: (id) => cache.get(id),
      awaitPrecomputedResult: async (id) => {
        const p = inflight.get(id);
        if (p) await p;
        return cache.get(id);
      },
    });

    // executeTools 起跑时 cache 还是空的（旧实现的 miss 窗口就在这里）。
    const result = await executeTools(content, deps);
    await prefetch; // 确保抢跑那一次已计入，断言口径稳定

    // ★核心：总执行次数 1（只有抢跑那次）。旧实现是 2（抢跑 + executeTools 各一次）。
    expect(counter.n).toBe(1);
    // 结果复用的是抢跑产物
    expect(result.results.length).toBe(1);
    expect((result.results[0] as { content: string }).content).toBe("prefetched");
  });

  test("抢跑已落地 → 照旧命中缓存复用，不重复执行", async () => {
    const counter = { n: 0 };
    const registry = new ToolRegistry();
    registry.register(countingTool("web_search", counter) as never);

    const b = block("call-2", "web_search");
    const cache = new Map<string, SingleToolOutcome>([
      [
        b.id,
        {
          block: { type: "tool_result", tool_use_id: b.id, content: "prefetched" },
        } as SingleToolOutcome,
      ],
    ]);
    const inflight = new Map<string, Promise<void>>([[b.id, Promise.resolve()]]);

    const deps = makeDeps(registry, {
      getPrecomputedResult: (id) => cache.get(id),
      awaitPrecomputedResult: async (id) => {
        const p = inflight.get(id);
        if (p) await p;
        return cache.get(id);
      },
    });

    const result = await executeTools([b], deps);
    expect(counter.n).toBe(0);
    expect((result.results[0] as { content: string }).content).toBe("prefetched");
  });

  test("抢跑失败（未写缓存）→ executeTools 正常执行一次，不吞掉工具", async () => {
    // 抢跑异常是被刻意吞掉的，兜底路径必须仍然跑工具，否则这个工具就永远没有结果。
    const counter = { n: 0 };
    const registry = new ToolRegistry();
    registry.register(countingTool("web_search", counter) as never);

    const b = block("call-3", "web_search");
    const cache = new Map<string, SingleToolOutcome>();
    const inflight = new Map<string, Promise<void>>([
      [b.id, Promise.resolve()], // 抢跑跑完了，但（失败）没写缓存
    ]);

    const deps = makeDeps(registry, {
      getPrecomputedResult: (id) => cache.get(id),
      awaitPrecomputedResult: async (id) => {
        const p = inflight.get(id);
        if (p) await p;
        return cache.get(id);
      },
    });

    const result = await executeTools([b], deps);
    expect(counter.n).toBe(1);
    expect(result.results.length).toBe(1);
  });

  test("未注入 awaitPrecomputedResult（抢跑未开启）→ 行为与此前完全一致", async () => {
    // 向后兼容保险：默认路径不注入这个 dep，必须退化成原来的同步读。
    const counter = { n: 0 };
    const registry = new ToolRegistry();
    registry.register(countingTool("web_search", counter) as never);

    const b = block("call-4", "web_search");
    const deps = makeDeps(registry); // 两个 precomputed dep 都不注入
    const result = await executeTools([b], deps);

    expect(counter.n).toBe(1);
    expect(result.results.length).toBe(1);
  });
});
