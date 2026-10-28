/**
 * N1：子代理批次循环必须响应 abort
 *
 * 修复前 `agent/tool-executor.ts` 的批次循环、串行内层循环、并发信号量都不判断
 * `signal.aborted`：用户 ESC 之后剩余工具照样走 PreToolUse → 权限 → execute。
 * write/edit 自身不看 signal，于是会在用户明确要求停下之后真的落盘。
 *
 * 断言的是「execute 被调用次数」与「PreToolUse 触发集合」，不只看结果文案：
 * 占位结果对了但工具仍被执行，正是这条缺陷的形态。
 */

import { describe, test, expect, afterEach } from "bun:test";
import type { ContentBlock } from "@sid-code/core/llm/types.ts";
import { executeTools, SUBAGENT_ABORTED_TOOL_RESULT } from "@sid-code/core/agent/tool-executor.ts";

interface Log {
  executed: string[];
  pre: string[];
  post: string[];
}

function makeTool(name: string, concurrencySafe: boolean, log: Log, onExecute?: () => void) {
  return {
    name: () => name,
    description: () => `mock ${name}`,
    inputSchema: () => ({ type: "object", properties: {} }),
    readOnly: () => concurrencySafe,
    isConcurrencySafe: () => concurrencySafe,
    async execute() {
      log.executed.push(name);
      onExecute?.();
      // 让出一拍，给并发批次里的其它 worker 抢启动的机会
      await new Promise((r) => setTimeout(r, 0));
      return { output: `${name} ok` };
    },
  };
}

function makeRegistry(tools: ReturnType<typeof makeTool>[]) {
  const byName = new Map(tools.map((t) => [t.name(), t]));
  return { get: (name: string) => byName.get(name) ?? null } as any;
}

function makeHookSystem(log: Log) {
  const noop = async () => ({ finalOutput: undefined });
  return {
    firePreToolUseEvent: async (toolName: string) => {
      log.pre.push(toolName);
      return { finalOutput: undefined };
    },
    firePostToolUseEvent: async (toolName: string) => {
      log.post.push(toolName);
      return { finalOutput: undefined };
    },
    firePermissionDeniedEvent: noop,
    firePostToolUseFailureEvent: noop,
  } as any;
}

const allowAll = { check: async () => ({ allowed: true }) } as any;

function toolUse(name: string): ContentBlock {
  return { type: "tool_use", id: `id_${name}`, name, input: {} } as ContentBlock;
}

function newLog(): Log {
  return { executed: [], pre: [], post: [] };
}

function resultOf(results: ContentBlock[], name: string): any {
  return results.find((r: any) => r.tool_use_id === `id_${name}`);
}

function expectPlaceholder(results: ContentBlock[], name: string) {
  const r = resultOf(results, name);
  expect(r, `${name} 缺结果（N 进必须 N 出）`).toBeDefined();
  expect(r.is_error).toBe(true);
  expect(r.content).toBe(SUBAGENT_ABORTED_TOOL_RESULT);
}

const savedConcurrency = process.env.SID_TOOL_MAX_CONCURRENT;
afterEach(() => {
  if (savedConcurrency === undefined) delete process.env.SID_TOOL_MAX_CONCURRENT;
  else process.env.SID_TOOL_MAX_CONCURRENT = savedConcurrency;
});

describe("N1：子代理批次循环响应 abort", () => {
  test("A 串行：s1 执行中 abort，s2/s3 不执行、不触发 PreToolUse", async () => {
    const log = newLog();
    const ac = new AbortController();
    const tools = makeRegistry([
      makeTool("s1", false, log, () => ac.abort()),
      makeTool("s2", false, log),
      makeTool("s3", false, log),
    ]);
    const results = await executeTools(
      ["s1", "s2", "s3"].map(toolUse),
      tools,
      ac.signal,
      makeHookSystem(log),
      allowAll,
    );
    expect(log.executed, "中断后串行工具仍被 execute").toEqual(["s1"]);
    expect(log.pre, "中断后串行工具仍触发 PreToolUse").toEqual(["s1"]);
    expect(results).toHaveLength(3);
    expect(resultOf(results, "s1").content).toBe("s1 ok");
    expectPlaceholder(results, "s2");
    expectPlaceholder(results, "s3");
  });

  test("B 跨批次：s1 执行中 abort，后续并发批次 r1/r2 不执行", async () => {
    const log = newLog();
    const ac = new AbortController();
    const tools = makeRegistry([
      makeTool("s1", false, log, () => ac.abort()),
      makeTool("r1", true, log),
      makeTool("r2", true, log),
    ]);
    const results = await executeTools(
      ["s1", "r1", "r2"].map(toolUse),
      tools,
      ac.signal,
      makeHookSystem(log),
      allowAll,
    );
    expect(log.executed, "中断后下一批次仍被 execute").toEqual(["s1"]);
    expect(log.pre).toEqual(["s1"]);
    expect(results).toHaveLength(3);
    expectPlaceholder(results, "r1");
    expectPlaceholder(results, "r2");
  });

  test("C 并发批次内：上限 1，r1 执行中 abort，r2 不启动", async () => {
    process.env.SID_TOOL_MAX_CONCURRENT = "1";
    const log = newLog();
    const ac = new AbortController();
    const tools = makeRegistry([
      makeTool("r1", true, log, () => ac.abort()),
      makeTool("r2", true, log),
    ]);
    const results = await executeTools(
      ["r1", "r2"].map(toolUse),
      tools,
      ac.signal,
      makeHookSystem(log),
      allowAll,
    );
    expect(log.executed, "中断后并发批次内排队任务仍被启动").toEqual(["r1"]);
    expect(log.pre).toEqual(["r1"]);
    expect(results).toHaveLength(2);
    expect(resultOf(results, "r1").content).toBe("r1 ok");
    expectPlaceholder(results, "r2");
  });

  test("D 不误伤：不 abort 时 5 个工具全部执行，结果按原序", async () => {
    const log = newLog();
    const ac = new AbortController();
    const names = ["s1", "s2", "s3", "r1", "r2"];
    const tools = makeRegistry([
      makeTool("s1", false, log),
      makeTool("s2", false, log),
      makeTool("s3", false, log),
      makeTool("r1", true, log),
      makeTool("r2", true, log),
    ]);
    const results = await executeTools(
      names.map(toolUse),
      tools,
      ac.signal,
      makeHookSystem(log),
      allowAll,
    );
    expect([...log.executed].sort()).toEqual([...names].sort());
    expect(results.map((r: any) => r.tool_use_id)).toEqual(names.map((n) => `id_${n}`));
    for (const n of names) expect(resultOf(results, n).content).toBe(`${n} ok`);
  });

  test("调用前已 abort：一个工具都不执行，全部占位", async () => {
    const log = newLog();
    const ac = new AbortController();
    ac.abort();
    const tools = makeRegistry([makeTool("s1", false, log), makeTool("r1", true, log)]);
    const results = await executeTools(
      ["s1", "r1"].map(toolUse),
      tools,
      ac.signal,
      makeHookSystem(log),
      allowAll,
    );
    expect(log.executed).toEqual([]);
    expect(log.pre).toEqual([]);
    expectPlaceholder(results, "s1");
    expectPlaceholder(results, "r1");
  });
});
