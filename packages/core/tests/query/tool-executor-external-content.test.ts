/**
 * B14 / HB-13a：外部内容不可信包裹的出口测试（G1）。
 *
 * 这层守的是**包裹落点**：结果必须包在所有 finalOutput 改写之后。PostToolUse 的
 * getUpdatedToolOutput 会整段替换模型侧输出 —— 标签若写在工具内部或替换之前，会被冲掉，
 * 而现有 hook 测试只断言替换生效、不会发现标签丢了。
 * 所以本文件最关键的一条是「hook 替换输出后仍然包裹」：它是落点选对没选对的判据。
 *
 * 两侧出口都要覆盖：主循环（query/tool-executor.ts）与子代理（query/run-tool-use.ts）。
 * 后者是子代理两条执行路径（进程内 / spawn）的唯一实现，改一处即两路生效。
 */

import { describe, expect, test } from "bun:test";
import type { ToolUseBlock } from "@sid-code/core/llm/types.ts";
import { DefaultHookOutput } from "@sid-code/core/hook/types.ts";
import { executeSingleTool, type ToolExecutorDeps } from "@sid-code/core/query/tool-executor.ts";
import { runToolUse } from "@sid-code/core/query/run-tool-use.ts";

// ─── 脚手架 ──────────────────────────────────────────────

type Exec = (input: any) => Promise<{ output: string; isError?: boolean }>;

function makeTool(name: string, exec: Exec) {
  return {
    name: () => name,
    description: () => `mock ${name}`,
    inputSchema: () => ({ type: "object", properties: {} }),
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
function makeMainDeps(tool: any, postOutput?: () => any): ToolExecutorDeps {
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
      sessionId: "external-content-test",
      addToolDuration: () => {},
      recordToolResult: () => {},
    } as any,
    hookSystem: {
      firePreToolUseEvent: async () => ({
        finalOutput: undefined,
        success: true,
        allOutputs: [],
        errors: [],
        totalDuration: 0,
      }),
      firePostToolUseEvent: async () => ({
        finalOutput: postOutput?.(),
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

/** 子代理执行器的最小 deps：hook 可省（缺省走无 hook 分支），权限恒放行。 */
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

const mode = { sessionId: "external-content-test", diagnosticOwner: "main" };

/**
 * SingleToolOutcome.block 的类型是 ContentBlock 联合，只有 tool_result 变体带 content。
 * 测试里先取出正文再断言形态，避免在联合类型上直接访问字段。
 */
const contentOf = (block: unknown): string => String((block as { content?: unknown }).content);

// ─── 主循环出口 ──────────────────────────────────────────

describe("主循环出口（tool-executor.executeSingleTool）", () => {
  test('MCP 工具结果带 <external-content source="mcp" untrusted="true">', async () => {
    const tool = makeTool("mcp__github__search", async () => ({ output: "搜索结果正文" }));
    const { block } = await executeSingleTool(
      use("t1", "mcp__github__search", { q: "x" }),
      tool as any,
      makeMainDeps(tool),
    );
    const content = contentOf(block);
    expect(content).toContain('<external-content source="mcp" untrusted="true">');
    expect(content).toContain("搜索结果正文");
    expect(content.trimEnd().endsWith("</external-content>")).toBe(true);
  });

  test('web_search 结果带 source="web_search"', async () => {
    const tool = makeTool("web_search", async () => ({ output: "搜索结果正文" }));
    const { block } = await executeSingleTool(
      use("w1", "web_search"),
      tool as any,
      makeMainDeps(tool),
    );
    expect(contentOf(block)).toContain('<external-content source="web_search" untrusted="true">');
  });

  test("MCP 资源工具（名字不带 mcp__ 前缀）也包裹", async () => {
    for (const name of ["ReadMcpResource", "ListMcpResources"]) {
      const tool = makeTool(name, async () => ({ output: "资源内容" }));
      const { block } = await executeSingleTool(use("r1", name), tool as any, makeMainDeps(tool));
      expect(contentOf(block)).toContain(
        '<external-content source="mcp-resource" untrusted="true">',
      );
    }
  });

  test("★ hook 替换输出后仍然包裹（落点必须在所有改写之后）", async () => {
    // 这是本方案最容易做错的一处：PostToolUse 的 getUpdatedToolOutput 整段替换模型侧输出。
    // 若标签写在工具内部或替换之前，它会被冲掉，而现有 hook 测试只断言替换生效。
    const tool = makeTool("mcp__slack__post", async () => ({ output: "原文" }));
    const { block } = await executeSingleTool(
      use("m1", "mcp__slack__post"),
      tool as any,
      makeMainDeps(
        tool,
        () =>
          new DefaultHookOutput({
            hookSpecificOutput: { updatedMCPToolOutput: "hook 改写后的内容" },
          }),
      ),
    );
    const content = contentOf(block);
    expect(content).toContain("hook 改写后的内容");
    expect(content).toContain('<external-content source="mcp" untrusted="true">');
  });

  test("非外部来源工具（bash）不包裹", async () => {
    const tool = makeTool("bash", async () => ({ output: "build ok" }));
    const { block } = await executeSingleTool(use("b1", "bash"), tool as any, makeMainDeps(tool));
    expect(contentOf(block)).toBe("build ok");
    expect(contentOf(block)).not.toContain("external-content");
  });

  test("空输出（describeEmptyOutput 占位）不包裹", async () => {
    const tool = makeTool("mcp__fs__noop", async () => ({ output: "" }));
    const { block } = await executeSingleTool(
      use("e1", "mcp__fs__noop"),
      tool as any,
      makeMainDeps(tool),
    );
    const content = contentOf(block);
    // 占位说明是「工具没产出内容」，不是外部数据 —— 不能给它一个 untrusted 的来源暗示。
    expect(content).toContain("无输出内容");
    expect(content).not.toContain("external-content");
  });
});

// ─── 子代理出口 ──────────────────────────────────────────

describe("子代理出口（run-tool-use.runToolUse）", () => {
  test("MCP 工具结果带标签", async () => {
    const tool = makeTool("mcp__github__search", async () => ({ output: "子代理看到的结果" }));
    const result = await runToolUse(
      use("s1", "mcp__github__search"),
      tool as any,
      makeSubagentDeps() as any,
      mode,
    );
    expect(String(result.content)).toContain('<external-content source="mcp" untrusted="true">');
    expect(String(result.content)).toContain("子代理看到的结果");
  });

  test("★ hook 替换输出后仍然包裹（与主循环同一条反回归）", async () => {
    const tool = makeTool("mcp__slack__post", async () => ({ output: "原文" }));
    const result = await runToolUse(
      use("s2", "mcp__slack__post"),
      tool as any,
      makeSubagentDeps(
        () => new DefaultHookOutput({ hookSpecificOutput: { updatedMCPToolOutput: "hook 改写" } }),
      ) as any,
      mode,
    );
    expect(String(result.content)).toContain("hook 改写");
    expect(String(result.content)).toContain('<external-content source="mcp" untrusted="true">');
  });

  test("非外部来源工具（bash）不包裹", async () => {
    const tool = makeTool("bash", async () => ({ output: "ok" }));
    const result = await runToolUse(
      use("s3", "bash"),
      tool as any,
      makeSubagentDeps() as any,
      mode,
    );
    expect(String(result.content)).toBe("ok");
  });
});
