/**
 * T2（D1）+ D11：未知键提示与 harness 附言都必须拼在 `<external-content>` **外面**。
 *
 * 这个文件守的是**落点**，不是文案（文案在 input-validator-unknown-keys.test.ts）：
 *
 * 1. T2 的提示如果被包进 `<external-content untrusted="true">`，模型会把它当成不可信的
 *    外部数据忽略——提示等于没发。用 `web_search`（会被包裹的工具）来测，是因为只有
 *    它能让「在包裹内/外」这个区别显形。
 * 2. D11：hook 产生的三种附言原先都并进 `finalOutput`，而包裹在函数末尾才执行，于是
 *    hook 写的话也进了 untrusted 标签。修法是把「工具产出」与「harness 附言」分成两个
 *    变量，用同一个用例一起钉住——它们改的是同一个拼接位置。
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import type { ToolUseBlock } from "@sid-code/core/llm/types.ts";
import { DefaultHookOutput, PreToolUseHookOutput } from "@sid-code/core/hook/types.ts";
import { executeSingleTool, type ToolExecutorDeps } from "@sid-code/core/query/tool-executor.ts";
import { runToolUse } from "@sid-code/core/query/run-tool-use.ts";

// ─── 脚手架 ──────────────────────────────────────────────

type Exec = (input: any) => Promise<{ output: string; isError?: boolean }>;

/** mock 工具：带 zodSchema，才能走 T2 的未知键检测 */
function makeTool(name: string, schema: z.ZodTypeAny, exec: Exec) {
  return {
    name: () => name,
    description: () => `mock ${name}`,
    inputSchema: () => ({ type: "object", properties: {} }),
    zodSchema: schema,
    readOnly: () => true,
    isConcurrencySafe: () => true,
    execute: exec,
  };
}

const use = (id: string, name: string, input: Record<string, unknown> = {}): ToolUseBlock => ({
  type: "tool_use",
  id,
  name,
  input,
});

/**
 * 主循环执行器的最小 deps。checkpoint 关闭（不落盘），analytics 不挂 sink
 * （事件走默认 no-op），permissionChecker 恒放行。
 */
function makeMainDeps(
  tool: any,
  opts: { preOutput?: () => any; postOutput?: () => any } = {},
): ToolExecutorDeps {
  return {
    config: {
      checkpoint: { enabled: false },
      model: "test-model",
      permissionMode: "default",
    } as any,
    toolRegistry: {
      get: (n: string) => (n === tool.name() ? tool : null),
      isDeferred: () => false,
      isActivated: () => true,
      isToolSearchEnabled: () => false,
    } as any,
    sessionState: {
      sessionId: "unknown-keys-test",
      addToolDuration: () => {},
      recordToolResult: () => {},
    } as any,
    hookSystem: {
      firePreToolUseEvent: async () => ({
        finalOutput: opts.preOutput?.(),
        success: true,
        allOutputs: [],
        errors: [],
        totalDuration: 0,
      }),
      firePostToolUseEvent: async () => ({
        finalOutput: opts.postOutput?.(),
        success: true,
        allOutputs: [],
        errors: [],
        totalDuration: 0,
      }),
      firePostToolUseFailureEvent: async () => ({ finalOutput: undefined }),
      firePermissionDeniedEvent: async () => ({ finalOutput: undefined }),
    } as any,
    permissionChecker: {
      check: async () => ({ allowed: true }),
      recordUserDenial: () => {},
    } as any,
    preToolUseCache: new Map(),
    getAbortSignal: () => undefined,
    requestUserConfirmation: async () => false,
  } as ToolExecutorDeps;
}

const contentOf = (block: unknown): string => String((block as { content?: unknown }).content);

/** 断言 needles 在 content 里按给定顺序出现 */
function expectOrdered(content: string, needles: string[]) {
  let cursor = -1;
  for (const needle of needles) {
    const at = content.indexOf(needle, cursor + 1);
    expect(at, `「${needle}」应在 content 里且顺序正确：\n${content}`).toBeGreaterThan(cursor);
    cursor = at;
  }
}

// ─── T2：提示在包裹之外 ─────────────────────────────────

describe("T2 提示的落点（主循环）", () => {
  test("★ web_search 带未知键：提示在 <external-content> 之外，且在最前面", async () => {
    const tool = makeTool("web_search", z.object({ query: z.string() }), async () => ({
      output: "搜索结果正文",
    }));
    const { block } = await executeSingleTool(
      use("u1", "web_search", { query: "x", bogus: 1 }),
      tool as any,
      makeMainDeps(tool),
    );
    const content = contentOf(block);
    expect(content).toContain("`bogus`");
    expect(content).toContain("不是 web_search 的参数");
    // 提示必须在包裹开始之前、也在正文之前（模型先看到「参数没生效」，再读结果）
    expectOrdered(content, [
      "不是 web_search 的参数",
      '<external-content source="web_search"',
      "搜索结果正文",
    ]);
    // 反向断言：提示不能落在标签内部
    const inside = content.slice(
      content.indexOf(">") + 1,
      content.lastIndexOf("</external-content>"),
    );
    expect(inside).not.toContain("不是 web_search 的参数");
  });

  test("没有未知键时不加提示（成功路径形状不变）", async () => {
    const tool = makeTool("web_search", z.object({ query: z.string() }), async () => ({
      output: "搜索结果正文",
    }));
    const { block } = await executeSingleTool(
      use("u2", "web_search", { query: "x" }),
      tool as any,
      makeMainDeps(tool),
    );
    const content = contentOf(block);
    expect(content).not.toContain("不是 web_search 的参数");
    expect(content.startsWith('<external-content source="web_search"')).toBe(true);
  });

  test("grep 的 -n 进「已知无影响键」名单：不提示，但结果照常", async () => {
    const tool = makeTool("grep", z.object({ pattern: z.string() }), async () => ({
      output: "a.ts:1:foo",
    }));
    const { block } = await executeSingleTool(
      use("u3", "grep", { pattern: "foo", "-n": true }),
      tool as any,
      makeMainDeps(tool),
    );
    const content = contentOf(block);
    expect(content).not.toContain("不是 grep 的参数");
    expect(content).toBe("a.ts:1:foo");
  });

  test("hook 注入的未知键不提示模型（模型根本没传过它）", async () => {
    const tool = makeTool("read", z.object({ file_path: z.string() }), async () => ({
      output: "file content",
    }));
    const { block } = await executeSingleTool(
      use("u4", "read", { file_path: "/a" }),
      tool as any,
      makeMainDeps(tool, {
        preOutput: () =>
          new PreToolUseHookOutput({
            hookSpecificOutput: { updatedInput: { file_path: "/a", hook_injected: true } },
          }),
      }),
    );
    const content = contentOf(block);
    expect(content).not.toContain("hook_injected");
    expect(content).toContain("file content");
  });
});

// ─── D11：hook 附言在包裹之外 ───────────────────────────

describe("D11：harness 附言不再被标成 untrusted", () => {
  test("★ [Hook 附加上下文] 出现在 </external-content> 之后", async () => {
    const tool = makeTool("web_search", z.object({ query: z.string() }), async () => ({
      output: "搜索结果正文",
    }));
    const { block } = await executeSingleTool(
      use("d1", "web_search", { query: "x" }),
      tool as any,
      makeMainDeps(tool, {
        postOutput: () =>
          new DefaultHookOutput({
            hookSpecificOutput: { additionalContext: "hook 追加的上下文" },
          }),
      }),
    );
    const content = contentOf(block);
    expectOrdered(content, [
      '<external-content source="web_search"',
      "搜索结果正文",
      "</external-content>",
      "[Hook 附加上下文]",
      "hook 追加的上下文",
    ]);
  });

  test("[Hook 反馈] 同样在包裹之后", async () => {
    const tool = makeTool("web_search", z.object({ query: z.string() }), async () => ({
      output: "正文",
    }));
    const { block } = await executeSingleTool(
      use("d2", "web_search", { query: "x" }),
      tool as any,
      makeMainDeps(tool, {
        postOutput: () =>
          new DefaultHookOutput({
            decision: "block",
            reason: "lint 没过",
          }),
      }),
    );
    const content = contentOf(block);
    expectOrdered(content, ["</external-content>", "[Hook 反馈]", "lint 没过"]);
  });

  test("hook 改参告知在包裹之前（前置类附言）", async () => {
    const tool = makeTool("web_search", z.object({ query: z.string() }), async () => ({
      output: "正文",
    }));
    const { block } = await executeSingleTool(
      use("d3", "web_search", { query: "x" }),
      tool as any,
      makeMainDeps(tool, {
        preOutput: () =>
          new PreToolUseHookOutput({
            hookSpecificOutput: { updatedInput: { query: "改过的查询" } },
          }),
      }),
    );
    const content = contentOf(block);
    expect(content).toContain("hook 修改");
    expectOrdered(content, ["hook 修改", '<external-content source="web_search"', "正文"]);
  });

  test("T2 提示与 D11 附言同时出现时顺序稳定：提示 → 包裹 → 附言", async () => {
    const tool = makeTool("web_search", z.object({ query: z.string() }), async () => ({
      output: "正文",
    }));
    const { block } = await executeSingleTool(
      use("d4", "web_search", { query: "x", bogus: 1 }),
      tool as any,
      makeMainDeps(tool, {
        postOutput: () =>
          new DefaultHookOutput({
            hookSpecificOutput: { additionalContext: "附加上下文" },
          }),
      }),
    );
    expectOrdered(contentOf(block), [
      "不是 web_search 的参数",
      '<external-content source="web_search"',
      "</external-content>",
      "[Hook 附加上下文]",
      "附加上下文",
    ]);
  });

  test("工具无输出 + hook 追加内容：不把附言包成 untrusted 空壳", async () => {
    const tool = makeTool("web_search", z.object({ query: z.string() }), async () => ({
      output: "",
    }));
    const { block } = await executeSingleTool(
      use("d5", "web_search", { query: "x" }),
      tool as any,
      makeMainDeps(tool, {
        postOutput: () =>
          new DefaultHookOutput({
            hookSpecificOutput: { additionalContext: "只有 hook 的内容" },
          }),
      }),
    );
    const content = contentOf(block);
    // 空输出会被 describeEmptyOutput 换成占位说明（它仍属「没有产出」，但不再是空串）；
    // 关键是附言不会被包进 untrusted 标签。
    expect(content).toContain("[Hook 附加上下文]");
    expect(content).not.toContain("only-hook-inside-external-content");
  });
});

// ─── 子代理出口：T2 提示同位置 ──────────────────────────

describe("T2 提示的落点（子代理出口）", () => {
  function makeSubagentDeps(postOutput?: () => any) {
    return {
      hookSystem: postOutput
        ? ({
            firePreToolUseEvent: async () => ({
              finalOutput: undefined,
              success: true,
              allOutputs: [],
              errors: [],
              totalDuration: 0,
            }),
            firePostToolUseEvent: async () => ({
              finalOutput: postOutput(),
              success: true,
              allOutputs: [],
              errors: [],
              totalDuration: 0,
            }),
            firePostToolUseFailureEvent: async () => ({ finalOutput: undefined }),
            firePermissionDeniedEvent: async () => ({ finalOutput: undefined }),
          } as any)
        : undefined,
      permissionChecker: {
        check: async () => ({ allowed: true }),
        recordUserDenial: () => {},
      } as any,
    };
  }

  const mode = { sessionId: "unknown-keys-test", diagnosticOwner: "main" };

  test("★ 未知键提示在子代理的 external-content 之外", async () => {
    const tool = makeTool("web_search", z.object({ query: z.string() }), async () => ({
      output: "子代理看到的结果",
    }));
    const result = await runToolUse(
      use("s1", "web_search", { query: "x", bogus: 1 }),
      tool as any,
      makeSubagentDeps() as any,
      mode,
    );
    const content = String(result.content);
    expectOrdered(content, [
      "不是 web_search 的参数",
      '<external-content source="web_search"',
      "子代理看到的结果",
    ]);
  });
});
