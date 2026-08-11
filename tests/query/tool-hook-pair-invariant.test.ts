/**
 * 不变量：PreToolUse 一旦 fire，必须有一个 Post*（PostToolUse 或 PostToolUseFailure）配对收尾
 *
 * ## 事故（会话 20260803-135816-8c8619e7）
 *
 * `ask_user_question` 参数校验失败那次调用（`toolu_01QcH2merrmxvKAWoLzMruwJ`），
 * 在 events.jsonl 里**只有 PreToolUse（05:59:43.051），没有任何 Post 事件**。
 *
 * 根因：`executeSingleTool` 在 PreToolUse 之后有多条早退分支（hook 阻止 / 权限拒绝 /
 * 参数校验失败）直接 `return` error tool_result，从不 fire Post*。后果有两层：
 *
 *   1. **用户 hook 悬空**：依赖 Pre/Post 配对做计时、审计、配额记账的 hook，拿到"开始"
 *      永远等不到"结束"，只能靠超时自清或干脆漏记。
 *   2. **可观测性隐身**：`execute_tool` span 是在 `hook-probe.handlePostToolUse` 里创建的，
 *      因此这些失败在 trace 树上根本不存在、失败率统计也不计入。排查时表现为
 *      "模型明明报错了，但轨迹里查不到这次工具调用"。
 *
 * 而"模型漏 required 字段"恰恰是最高频的真实失败——最该被看见的那一类，偏偏全盲。
 *
 * ## 为什么写成"遍历所有失败路径"的不变量测试
 *
 * 逐个路径写断言挡不住下一条新增的早退分支（这类分支会随权限/hook 特性持续增加，
 * 每加一条就可能再漏一次 fire）。所以这里把它固化成一条**结构性不变量**：
 *
 *   对每种失败路径：Pre 触发次数 > 0 ⟹ Post* 触发次数 == Pre 触发次数
 *
 * 任何人新增早退分支而忘了收尾，这个测试就会红。
 */

import { describe, test, expect } from "bun:test";
import { z } from "zod/v4";
import type { ToolUseBlock } from "@sid-code/core/llm/types.ts";
import { executeTools, type ToolExecutorDeps } from "@sid-code/core/query/tool-executor.ts";

/** 记录 hook 触发序列，用于配对断言 */
interface HookLog {
  pre: string[];
  post: string[];
  postFailure: Array<{ id: string; error: string; durationMs?: number }>;
}

function makeTool(opts: {
  name: string;
  behavior?: "ok" | "throw";
  zodSchema?: unknown;
}) {
  return {
    name: () => opts.name,
    description: () => `mock ${opts.name}`,
    inputSchema: () => ({ type: "object", properties: {} }),
    readOnly: () => true,
    isConcurrencySafe: () => true,
    ...(opts.zodSchema ? { zodSchema: opts.zodSchema } : {}),
    async execute() {
      if (opts.behavior === "throw") throw new Error(`${opts.name} 内部抛错`);
      return { output: `${opts.name} ok` };
    },
  };
}

function makeDeps(
  tools: ReturnType<typeof makeTool>[],
  hookLog: HookLog,
  opts: { denyTool?: string; blockHookFor?: string; withPreCache?: boolean } = {},
): ToolExecutorDeps {
  const byName = new Map(tools.map((t) => [t.name(), t]));
  return {
    config: { checkpoint: { enabled: false } } as any,
    toolRegistry: {
      get: (name: string) => byName.get(name) ?? null,
      isDeferred: () => false,
      isActivated: () => true,
      isToolSearchEnabled: () => false,
    } as any,
    sessionState: {
      sessionId: "test-session",
      addToolDuration: () => {},
      recordToolResult: () => {},
    } as any,
    hookSystem: {
      firePreToolUseEvent: async (toolName: string, _input: unknown, toolUseId?: string) => {
        hookLog.pre.push(toolUseId ?? toolName);
        if (opts.blockHookFor === toolName) {
          // 形态必须对齐 interpretPreToolUse 的真实读法：它调 isBlockingDecision()
          // 与 getEffectiveReason()（见 query/tool-executor.ts:215）。
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
        _input: unknown,
        _resp: unknown,
        _isErr?: boolean,
        toolUseId?: string,
      ) => {
        hookLog.post.push(toolUseId ?? toolName);
        return { finalOutput: undefined };
      },
      firePostToolUseFailureEvent: async (
        toolName: string,
        _input: unknown,
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
    } as any,
    permissionChecker: opts.denyTool
      ? ({
          check: async (req: any) =>
            (req?.toolName ?? req) === opts.denyTool
              ? { allowed: false, reason: `不允许 ${opts.denyTool}` }
              : { allowed: true },
          recordUserDenial: () => {},
        } as any)
      : null,
    // G3 fire-once 缓存：生产路径（app.ts buildToolExecutorDeps）**总是**注入这份 Map，
    // resolveToolPermission 先 fire 并缓存、executeSingleTool 复用不再二次 fire。
    // 测试不注入会让 Pre 每个工具 fire 两次（那是仅供子代理/旧测试的兼容回退路径），
    // 与线上不同形 → 配对断言会算错。默认按生产形态注入。
    ...(opts.withPreCache === false ? {} : { preToolUseCache: new Map() }),
    getAbortSignal: () => undefined,
    requestUserConfirmation: async () => false,
  } as ToolExecutorDeps;
}

function toolUse(id: string, name: string, input: Record<string, unknown> = {}): ToolUseBlock {
  return { type: "tool_use", id, name, input };
}

/** 等待 fire-and-forget 的 hook 落地（实现刻意不 await，避免 hook 耗时进关键路径） */
async function flushAsyncHooks(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

function emptyLog(): HookLog {
  return { pre: [], post: [], postFailure: [] };
}

/** 断言核心不变量：每个 fire 过 Pre 的工具，都要有恰好一个 Post* 收尾 */
function expectPaired(hookLog: HookLog, label: string) {
  const postTotal = hookLog.post.length + hookLog.postFailure.length;
  expect(
    postTotal,
    `${label}：Pre 触发 ${hookLog.pre.length} 次但 Post* 只有 ${postTotal} 次 —— `
      + `依赖配对的用户 hook 会永久悬空，且该失败在 execute_tool span 里完全不存在`,
  ).toBe(hookLog.pre.length);

  // 每条失败都必须带 duration_ms：span 本身创建即结束（durationMs ≈ 0），
  // 真实耗时只能靠该属性承载。缺它则"成功有耗时、失败没耗时"，
  // 而权限拒绝（等用户确认可达数十秒）与慢工具超时恰恰最需要看耗时。
  for (const f of hookLog.postFailure) {
    expect(
      typeof f.durationMs,
      `${label}：${f.id} 的 PostToolUseFailure 未带 duration_ms —— span 无耗时属性`,
    ).toBe("number");
  }
}

describe("Pre/Post hook 配对不变量", () => {
  test("参数校验失败（事故现场：模型漏 required 字段）必须 fire Post*", async () => {
    // 还原事故：schema 要求 question 必填，模型只给了 header —— 与 ask_user_question
    // 那次漏字段同形。
    const schema = z.object({
      question: z.string(),
      header: z.string().optional(),
    });
    const tools = [makeTool({ name: "ask_user_question", zodSchema: schema })];
    const hookLog = emptyLog();

    const { results } = await executeTools(
      [toolUse("t1", "ask_user_question", { header: "确认提交" })],
      makeDeps(tools, hookLog),
    );
    await flushAsyncHooks();

    // 前提：确实走到了校验失败分支（否则这个测试是空转）
    const r = results.find((b) => b.type === "tool_result") as any;
    expect(r?.is_error, "应命中参数校验失败分支").toBe(true);
    expect(String(r?.content)).toContain("参数校验失败");

    expectPaired(hookLog, "参数校验失败");
    // 语义正确性：算失败而不是成功（否则污染"工具执行成功率"口径）
    expect(hookLog.postFailure).toHaveLength(1);
    expect(hookLog.postFailure[0].id).toBe("t1");
    expect(hookLog.postFailure[0].error).toContain("question");
  });

  test("权限拒绝必须 fire Post*", async () => {
    const tools = [makeTool({ name: "bash" })];
    const hookLog = emptyLog();

    const { results } = await executeTools(
      [toolUse("t2", "bash", { command: "rm -rf /" })],
      makeDeps(tools, hookLog, { denyTool: "bash" }),
    );
    await flushAsyncHooks();

    const r = results.find((b) => b.type === "tool_result") as any;
    expect(r?.is_error, "应命中权限拒绝分支").toBe(true);

    expectPaired(hookLog, "权限拒绝");
    expect(hookLog.postFailure).toHaveLength(1);
  });

  test("PreToolUse hook 阻止必须 fire Post*", async () => {
    const tools = [makeTool({ name: "edit" })];
    const hookLog = emptyLog();

    const { results } = await executeTools(
      [toolUse("t3", "edit", { file_path: "/tmp/x" })],
      makeDeps(tools, hookLog, { blockHookFor: "edit" }),
    );
    await flushAsyncHooks();

    const r = results.find((b) => b.type === "tool_result") as any;
    expect(r?.is_error, "应命中 hook 阻止分支").toBe(true);
    expect(String(r?.content)).toContain("Hook 阻止执行");

    expectPaired(hookLog, "hook 阻止");
    expect(hookLog.postFailure).toHaveLength(1);
  });

  test("工具执行抛异常必须 fire Post*（既有行为，防回退）", async () => {
    const tools = [makeTool({ name: "boom", behavior: "throw" })];
    const hookLog = emptyLog();

    await executeTools([toolUse("t4", "boom")], makeDeps(tools, hookLog));
    await flushAsyncHooks();

    expectPaired(hookLog, "执行抛异常");
    expect(hookLog.postFailure).toHaveLength(1);
  });

  test("正常成功路径仍走 PostToolUse（不被误报成失败）", async () => {
    const tools = [makeTool({ name: "grep" })];
    const hookLog = emptyLog();

    await executeTools([toolUse("t5", "grep")], makeDeps(tools, hookLog));
    await flushAsyncHooks();

    expectPaired(hookLog, "正常成功");
    expect(hookLog.post, "成功路径必须走 PostToolUse").toHaveLength(1);
    expect(hookLog.postFailure, "成功路径不得上报 Failure").toHaveLength(0);
  });

  test("混合批次：成功 + 三类失败，Pre 与 Post* 总数仍严格相等", async () => {
    // 这条是真正的回归网：任何新增早退分支只要漏 fire，这里的总数就对不上。
    const schema = z.object({ question: z.string() });
    const tools = [
      makeTool({ name: "grep" }),
      makeTool({ name: "ask_user_question", zodSchema: schema }),
      makeTool({ name: "bash" }),
      makeTool({ name: "boom", behavior: "throw" }),
    ];
    const hookLog = emptyLog();

    await executeTools(
      [
        toolUse("m1", "grep"),
        toolUse("m2", "ask_user_question", { header: "缺 question" }),
        toolUse("m3", "bash", { command: "ls" }),
        toolUse("m4", "boom"),
      ],
      makeDeps(tools, hookLog, { denyTool: "bash" }),
    );
    await flushAsyncHooks();

    expect(hookLog.pre.length, "4 个工具都应 fire 过 Pre").toBe(4);
    expectPaired(hookLog, "混合批次");
    // 1 成功 + 3 失败
    expect(hookLog.post).toHaveLength(1);
    expect(hookLog.postFailure).toHaveLength(3);
  });
});
