/**
 * 不变量（子代理侧）：PreToolUse 一旦 fire，必须有一个 Post* 配对收尾
 *
 * 与 `tests/query/tool-hook-pair-invariant.test.ts` 同源缺陷的子代理镜像。
 * `agent/tool-executor.ts` 的 `executeSingleTool` 同样在 fire 过 PreToolUse 之后
 * 有多条早退分支（hook 阻止 / 权限拒绝 / fail-closed 拒绝 / 参数校验失败）
 * 直接 return，从不 fire Post*，导致 Pre/Post 不成对。
 *
 * 子代理侧尤其不能漏：子代理失败本就更难排查（无 UI、结论经父代理转述）。
 * 若 trace 里连"这次工具调用失败了"都查不到，只能靠读子代理原始 transcript 考古。
 */

import { describe, test, expect } from "bun:test";
import { z } from "zod/v4";
import type { ContentBlock } from "@sid-code/core/llm/types.ts";
import { executeTools } from "@sid-code/core/agent/tool-executor.ts";

interface HookLog {
  pre: string[];
  post: string[];
  postFailure: Array<{ id: string; error: string; durationMs?: number }>;
}

function emptyLog(): HookLog {
  return { pre: [], post: [], postFailure: [] };
}

function makeTool(opts: {
  name: string;
  concurrencySafe?: boolean;
  behavior?: "ok" | "throw";
  zodSchema?: unknown;
}) {
  return {
    name: () => opts.name,
    description: () => `mock ${opts.name}`,
    inputSchema: () => ({ type: "object", properties: {} }),
    readOnly: () => opts.concurrencySafe ?? true,
    isConcurrencySafe: () => opts.concurrencySafe ?? true,
    ...(opts.zodSchema ? { zodSchema: opts.zodSchema } : {}),
    async execute() {
      if (opts.behavior === "throw") throw new Error(`${opts.name} 内部抛错`);
      return { output: `${opts.name} ok` };
    },
  };
}

function makeRegistry(tools: ReturnType<typeof makeTool>[]) {
  const byName = new Map(tools.map((t) => [t.name(), t]));
  return { get: (name: string) => byName.get(name) ?? null } as any;
}

function makeHookSystem(hookLog: HookLog, opts: { blockHookFor?: string } = {}) {
  return {
    firePreToolUseEvent: async (toolName: string, _input: unknown, toolUseId?: string) => {
      hookLog.pre.push(toolUseId ?? toolName);
      if (opts.blockHookFor === toolName) {
        // 形态对齐 interpretPreToolUse 的真实读法（isBlockingDecision/getEffectiveReason）
        return {
          finalOutput: {
            isBlockingDecision: () => true,
            getEffectiveReason: () => `hook 拒绝 ${toolName}`,
          },
        };
      }
      return { finalOutput: undefined };
    },
    firePostToolUseEvent: async (
      toolName: string,
      _i: unknown,
      _r: unknown,
      _e?: boolean,
      toolUseId?: string,
    ) => {
      hookLog.post.push(toolUseId ?? toolName);
      return { finalOutput: undefined };
    },
    firePostToolUseFailureEvent: async (
      toolName: string,
      _i: unknown,
      error: string,
      toolUseId?: string,
      options?: { duration_ms?: number },
    ) => {
      hookLog.postFailure.push({
        id: toolUseId ?? toolName,
        error,
        durationMs: options?.duration_ms,
      });
      return { finalOutput: undefined };
    },
  } as any;
}

function toolUse(id: string, name: string, input: Record<string, unknown> = {}): ContentBlock {
  return { type: "tool_use", id, name, input } as ContentBlock;
}

async function flushAsyncHooks(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

function expectPaired(hookLog: HookLog, label: string) {
  const postTotal = hookLog.post.length + hookLog.postFailure.length;
  expect(
    postTotal,
    `${label}：Pre 触发 ${hookLog.pre.length} 次但 Post* 只有 ${postTotal} 次 —— `
      + `子代理失败在 trace 里隐身，只能靠读原始 transcript 考古`,
  ).toBe(hookLog.pre.length);

  // 同主循环：每条失败都必须带 duration_ms，否则失败工具的 span 无耗时属性。
  for (const f of hookLog.postFailure) {
    expect(
      typeof f.durationMs,
      `${label}：${f.id} 的 PostToolUseFailure 未带 duration_ms —— span 无耗时属性`,
    ).toBe("number");
  }
}

/** 放行一切的权限检查器（隔离出被测分支，避免 fail-closed 干扰） */
const allowAll = { check: async () => ({ allowed: true }) } as any;

describe("子代理 Pre/Post hook 配对不变量", () => {
  test("参数校验失败必须 fire Post*", async () => {
    const schema = z.object({ question: z.string() });
    const tools = makeRegistry([makeTool({ name: "ask_user_question", zodSchema: schema })]);
    const hookLog = emptyLog();

    const results = await executeTools(
      [toolUse("s1", "ask_user_question", { header: "缺 question" })],
      tools,
      undefined,
      makeHookSystem(hookLog),
      allowAll,
    );
    await flushAsyncHooks();

    const r = results[0] as any;
    expect(r?.is_error, "应命中参数校验失败分支").toBe(true);
    expect(String(r?.content)).toContain("参数校验失败");

    expectPaired(hookLog, "参数校验失败");
    expect(hookLog.postFailure).toHaveLength(1);
    expect(hookLog.postFailure[0].id).toBe("s1");
  });

  test("PreToolUse hook 阻止必须 fire Post*", async () => {
    const tools = makeRegistry([makeTool({ name: "edit", concurrencySafe: false })]);
    const hookLog = emptyLog();

    const results = await executeTools(
      [toolUse("s2", "edit", { file_path: "/tmp/x" })],
      tools,
      undefined,
      makeHookSystem(hookLog, { blockHookFor: "edit" }),
      allowAll,
    );
    await flushAsyncHooks();

    expect(String((results[0] as any)?.content)).toContain("Hook 阻止执行");
    expectPaired(hookLog, "hook 阻止");
    expect(hookLog.postFailure).toHaveLength(1);
  });

  test("权限拒绝必须 fire Post*", async () => {
    const tools = makeRegistry([makeTool({ name: "bash", concurrencySafe: false })]);
    const hookLog = emptyLog();

    const results = await executeTools(
      [toolUse("s3", "bash", { command: "rm -rf /" })],
      tools,
      undefined,
      makeHookSystem(hookLog),
      { check: async () => ({ allowed: false, reason: "子代理不允许 bash" }) } as any,
    );
    await flushAsyncHooks();

    expect(String((results[0] as any)?.content)).toContain("权限拒绝");
    expectPaired(hookLog, "权限拒绝");
    expect(hookLog.postFailure).toHaveLength(1);
  });

  test("fail-closed 拒绝（未配置权限检查器 + 写类工具）必须 fire Post*", async () => {
    // B0 分级 fail-closed：无 permissionChecker 时写类工具直接拒绝。
    const tools = makeRegistry([makeTool({ name: "write", concurrencySafe: false })]);
    const hookLog = emptyLog();

    const results = await executeTools(
      [toolUse("s4", "write", { file_path: "/tmp/x", content: "y" })],
      tools,
      undefined,
      makeHookSystem(hookLog),
      undefined, // 刻意不给 checker
    );
    await flushAsyncHooks();

    expect(String((results[0] as any)?.content)).toContain("fail-closed");
    expectPaired(hookLog, "fail-closed 拒绝");
    expect(hookLog.postFailure).toHaveLength(1);
  });

  test("正常成功路径仍走 PostToolUse（不被误报成失败）", async () => {
    const tools = makeRegistry([makeTool({ name: "grep" })]);
    const hookLog = emptyLog();

    await executeTools(
      [toolUse("s5", "grep")],
      tools,
      undefined,
      makeHookSystem(hookLog),
      allowAll,
    );
    await flushAsyncHooks();

    expectPaired(hookLog, "正常成功");
    expect(hookLog.post).toHaveLength(1);
    expect(hookLog.postFailure).toHaveLength(0);
  });

  test("混合批次：Pre 与 Post* 总数严格相等", async () => {
    const schema = z.object({ question: z.string() });
    const tools = makeRegistry([
      makeTool({ name: "grep" }),
      makeTool({ name: "ask_user_question", zodSchema: schema }),
      makeTool({ name: "boom", behavior: "throw" }),
    ]);
    const hookLog = emptyLog();

    await executeTools(
      [
        toolUse("x1", "grep"),
        toolUse("x2", "ask_user_question", { header: "缺 question" }),
        toolUse("x3", "boom"),
      ],
      tools,
      undefined,
      makeHookSystem(hookLog),
      allowAll,
    );
    await flushAsyncHooks();

    expect(hookLog.pre.length, "3 个工具都应 fire 过 Pre").toBe(3);
    expectPaired(hookLog, "混合批次");
  });
});
