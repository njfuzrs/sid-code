/**
 * D8：子代理延迟加载门闩
 *
 * 子代理若无条件 definitions() 全量，会把主循环故意藏起来的 MCP 一次性塞进上下文。
 * 反过来，只发 activeDefinitions 却不给 tool_search，模型盲调会撞「schema 未发送」。
 * 门闩是「这个隔离 registry 里真有 tool_search」——有才延迟，没有就发全量。
 *
 * 进程内隔离 registry 必须换一份绑本池的 ToolSearchTool：父实例 activate 写的是
 * 父会话，子代理下一轮仍看不到被调出的工具。
 */
import { describe, test, expect } from "bun:test";
import { runAgentLoop } from "@sid-code/core/agent/agentic-loop.ts";
import { Manager as ContextManager } from "@sid-code/core/context/manager.ts";
import { Registry as ToolRegistry } from "@sid-code/core/tool/registry.ts";
import { LoopDetector } from "@sid-code/core/agent/loop-detection.ts";
import { ToolSearchTool } from "@sid-code/core/tool/tool-search.ts";
import { SubAgent } from "@sid-code/core/agent/sub-agent.ts";
import type { Provider } from "@sid-code/core/llm/provider.ts";
import type { SendParams, StreamEvent, ToolDefinition } from "@sid-code/core/llm/types.ts";
import type { LegacyTool, LegacyToolResult } from "@sid-code/core/tool/types.ts";

async function* textEndStream(text: string): AsyncIterable<StreamEvent> {
  yield { type: "message_start", message: { usage: { inputTokens: 10, outputTokens: 0 } } } as any;
  yield { type: "content_block_start", index: 0, content_block: { type: "text" } } as any;
  yield {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text },
  } as any;
  yield { type: "content_block_stop", index: 0 } as any;
  yield {
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
    usage: { outputTokens: 5 },
  } as any;
}

function makeProvider() {
  const calls: SendParams[] = [];
  const provider = {
    name: () => "mock",
    defaultModel: () => "mock-model",
    sendMessageStream: (params: SendParams) => {
      calls.push(params);
      return textEndStream("完成");
    },
  } as unknown as Provider;
  return { provider, calls };
}

function mkTool(name: string, extra: Partial<LegacyTool> = {}): LegacyTool {
  return {
    name: () => name,
    description: () => name,
    inputSchema: () => ({ type: "object", properties: {} }),
    readOnly: () => true,
    isConcurrencySafe: () => true,
    async execute(): Promise<LegacyToolResult> {
      return { output: `${name} ok` };
    },
    ...extra,
  };
}

function makeCtxMgr(): ContextManager {
  const ctxMgr = new ContextManager({ maxTokens: 100_000 });
  ctxMgr.setSystemPrompt("test");
  ctxMgr.addMessage({ role: "user", content: [{ type: "text", text: "任务" }] });
  return ctxMgr;
}

function namesOf(defs: ToolDefinition[] | undefined): string[] {
  return (defs ?? []).map((d) => d.name);
}

describe("D8 — 子代理延迟加载门闩", () => {
  test("池里没有 tool_search → 发全量 definitions（含 shouldDefer / mcp__）", async () => {
    const registry = new ToolRegistry();
    registry.register(mkTool("read"));
    registry.register(mkTool("notebook_edit", { shouldDefer: true }));
    registry.register(mkTool("mcp__tavily__tavily_search"));
    const { provider, calls } = makeProvider();
    await runAgentLoop({
      provider,
      model: "mock-model",
      ctxMgr: makeCtxMgr(),
      tools: registry,
      maxTurns: 1,
      signal: new AbortController().signal,
      loopDetector: new LoopDetector(),
      permissionChecker: undefined,
    } as any);
    const names = namesOf(calls[0]?.tools);
    expect(names).toContain("read");
    expect(names).toContain("notebook_edit");
    expect(names).toContain("mcp__tavily__tavily_search");
  });

  test("池里有 tool_search → 发 activeDefinitions，延迟工具不进首轮 schema", async () => {
    const registry = new ToolRegistry();
    registry.register(mkTool("read"));
    registry.register(mkTool("notebook_edit", { shouldDefer: true }));
    registry.register(mkTool("mcp__tavily__tavily_search"));
    registry.register(new ToolSearchTool(registry));
    const { provider, calls } = makeProvider();
    await runAgentLoop({
      provider,
      model: "mock-model",
      ctxMgr: makeCtxMgr(),
      tools: registry,
      maxTurns: 1,
      signal: new AbortController().signal,
      loopDetector: new LoopDetector(),
      permissionChecker: undefined,
    } as any);
    const names = namesOf(calls[0]?.tools);
    expect(names).toContain("read");
    expect(names).toContain("tool_search");
    expect(names).not.toContain("notebook_edit");
    expect(names).not.toContain("mcp__tavily__tavily_search");
    const joined = JSON.stringify(calls[0]?.messages);
    expect(joined).toContain("mcp__tavily__tavily_search");
    expect(joined).toContain("available-deferred-tools");
  });

  test("隔离 registry 换绑本池的 ToolSearchTool：activate 不写父会话", async () => {
    const parent = new ToolRegistry();
    parent.register(mkTool("read"));
    parent.register(mkTool("mcp__tavily__tavily_search"));
    parent.register(new ToolSearchTool(parent));
    parent.setToolSearchEnabled(true);

    const { provider } = makeProvider();
    const agent = new SubAgent(provider, "mock-model", parent);
    const isolated: ToolRegistry = (agent as any).buildIsolatedToolRegistry(parent.all(), "task");

    expect(isolated.get("tool_search")).toBeDefined();
    expect(isolated.get("tool_search")).not.toBe(parent.get("tool_search"));
    expect(isolated.get("mcp__tavily__tavily_search")).toBeDefined();

    const childSearch = isolated.get("tool_search")!;
    const result = await childSearch.execute({ query: "select:mcp__tavily__tavily_search" });
    expect(result.isError).toBeFalsy();

    expect(isolated.isActivated("mcp__tavily__tavily_search")).toBe(true);
    expect(parent.isActivated("mcp__tavily__tavily_search")).toBe(false);
    expect(isolated.activeDefinitions().map((d) => d.name)).toContain("mcp__tavily__tavily_search");
    expect(parent.activeDefinitions().map((d) => d.name)).not.toContain(
      "mcp__tavily__tavily_search",
    );
  });
});
