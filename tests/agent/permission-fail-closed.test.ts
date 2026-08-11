/**
 * B0：权限层安全缺口回归测试
 *
 * 背景（docs/bugfixes/todo/20260801-韧性层架构对齐CC-子代理韧性能力根治方案.md §B0）：
 * 自定义子代理路径（`executeCustomInner`）此前漏传 `permissionChecker`，权限层被整体
 * 绕过——走 `agents/*.md` 自定义子代理执行 edit/bash 不经任何检查。同时 `tool-executor.ts`
 * 缺省是纯 opt-in（`if (permissionChecker)`），未传检查器时"不做权限检查"，不是安全默认值。
 *
 * 本文件钉住两件事：
 * 1. 两条 runAgentLoop 路径（内置子代理 / 自定义子代理）在不传 permissionChecker 时，
 *    都对写类工具 fail-closed、对只读工具放行——不是"只测了一条、另一条继续裸奔"。
 * 2. config key 一致性：两条路径传给 runAgentLoop 的公共字段来自同一个
 *    buildBaseLoopConfig() 工厂，不会再因为"两份手写清单"而漏传。
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { runAgentLoop } from "@sid-code/core/agent/agentic-loop.ts";
import { Manager as ContextManager } from "@sid-code/core/context/manager.ts";
import { Registry as ToolRegistry } from "@sid-code/core/tool/registry.ts";
import { LoopDetector } from "@sid-code/core/agent/loop-detection.ts";
import type { Provider } from "@sid-code/core/llm/provider.ts";
import type { StreamEvent } from "@sid-code/core/llm/types.ts";
import type { LegacyTool, LegacyToolResult } from "@sid-code/core/tool/types.ts";

/** 一次工具调用后立即结束的 mock 流：先吐 tool_use，第二轮吐 end_turn */
function makeToolCallProvider(toolName: string, input: Record<string, unknown>): Provider {
  let call = 0;
  return {
    name: () => "mock",
    defaultModel: () => "mock-model",
    async *sendMessageStream(): AsyncIterable<StreamEvent> {
      const idx = call++;
      if (idx === 0) {
        yield { type: "message_start", message: { usage: { inputTokens: 10, outputTokens: 0 } } } as any;
        yield { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: toolName } } as any;
        yield { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } } as any;
        yield { type: "content_block_stop", index: 0 } as any;
        yield { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { outputTokens: 5 } } as any;
      } else {
        yield { type: "message_start", message: { usage: { inputTokens: 10, outputTokens: 0 } } } as any;
        yield { type: "content_block_start", index: 0, content_block: { type: "text" } } as any;
        yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "完成" } } as any;
        yield { type: "content_block_stop", index: 0 } as any;
        yield { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { outputTokens: 5 } } as any;
      }
    },
  } as unknown as Provider;
}

/** Mock 工具：edit（写类）与 read（只读） */
class MockEditTool implements LegacyTool {
  name() { return "edit"; }
  description() { return "编辑文件"; }
  inputSchema() { return { type: "object", properties: { file_path: { type: "string" } } }; }
  readOnly() { return false; }
  async execute(): Promise<LegacyToolResult> { return { output: "edited" }; }
}
class MockBashTool implements LegacyTool {
  name() { return "bash"; }
  description() { return "执行命令"; }
  inputSchema() { return { type: "object", properties: { command: { type: "string" } } }; }
  readOnly() { return false; }
  async execute(): Promise<LegacyToolResult> { return { output: "executed" }; }
}
class MockReadTool implements LegacyTool {
  name() { return "read"; }
  description() { return "读取文件"; }
  inputSchema() { return { type: "object", properties: { file_path: { type: "string" } } }; }
  readOnly() { return true; }
  async execute(): Promise<LegacyToolResult> { return { output: "file content" }; }
}

function makeToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(new MockEditTool() as any);
  registry.register(new MockBashTool() as any);
  registry.register(new MockReadTool() as any);
  return registry;
}

function makeCtxMgr(): ContextManager {
  const ctxMgr = new ContextManager({ maxTokens: 100_000 });
  ctxMgr.setSystemPrompt("test");
  ctxMgr.addMessage({ role: "user", content: [{ type: "text", text: "任务" }] });
  return ctxMgr;
}

describe("B0 — runAgentLoop 分级 fail-closed（无 permissionChecker 时）", () => {
  test("写类工具（edit）无检查器时被拒绝", async () => {
    const provider = makeToolCallProvider("edit", { file_path: "a.ts" });
    const result = await runAgentLoop({
      provider,
      model: "mock-model",
      ctxMgr: makeCtxMgr(),
      tools: makeToolRegistry(),
      maxTurns: 5,
      signal: new AbortController().signal,
      loopDetector: new LoopDetector(),
      permissionChecker: undefined,
    } as any);
    // 工具结果应包含权限拒绝文案，循环仍能跑完（不是抛异常中断）
    const messages = result.messages;
    const toolResultMsg = messages.find(m =>
      m.content.some(b => b.type === "tool_result"),
    );
    const toolResult = toolResultMsg?.content.find(b => b.type === "tool_result") as any;
    expect(toolResult?.content).toContain("fail-closed");
    expect(toolResult?.is_error).toBe(true);
  });

  test("只读工具（read）无检查器时放行", async () => {
    const provider = makeToolCallProvider("read", { file_path: "a.ts" });
    const result = await runAgentLoop({
      provider,
      model: "mock-model",
      ctxMgr: makeCtxMgr(),
      tools: makeToolRegistry(),
      maxTurns: 5,
      signal: new AbortController().signal,
      loopDetector: new LoopDetector(),
      permissionChecker: undefined,
    } as any);
    const messages = result.messages;
    const toolResultMsg = messages.find(m =>
      m.content.some(b => b.type === "tool_result"),
    );
    const toolResult = toolResultMsg?.content.find(b => b.type === "tool_result") as any;
    expect(toolResult?.content).toBe("file content");
    expect(toolResult?.is_error).toBeFalsy();
  });

  test("写类工具（bash）无检查器时同样被拒绝", async () => {
    const provider = makeToolCallProvider("bash", { command: "rm -rf /" });
    const result = await runAgentLoop({
      provider,
      model: "mock-model",
      ctxMgr: makeCtxMgr(),
      tools: makeToolRegistry(),
      maxTurns: 5,
      signal: new AbortController().signal,
      loopDetector: new LoopDetector(),
      permissionChecker: undefined,
    } as any);
    const messages = result.messages;
    const toolResultMsg = messages.find(m =>
      m.content.some(b => b.type === "tool_result"),
    );
    const toolResult = toolResultMsg?.content.find(b => b.type === "tool_result") as any;
    expect(toolResult?.content).toContain("fail-closed");
    expect(toolResult?.is_error).toBe(true);
  });
});

describe("B0 — config key 一致性哨兵（两条 runAgentLoop 路径共用 buildBaseLoopConfig）", () => {
  const src = readFileSync(
    new URL("../../packages/core/src/agent/sub-agent.ts", import.meta.url),
    "utf-8",
  );

  test("内置子代理路径（executeInner）与自定义子代理路径（executeCustomInner）都调用了 buildBaseLoopConfig", () => {
    // 防漂移：此前两条路径各自手写完整 config 字面量，靠人工同步 availability/
    // permissionChecker/deadlineAt/discoverJitContext 等公共字段——自定义路径正是这样
    // 漏掉了 permissionChecker（本次修复的 P0 缺口）。现在两处都必须走同一个工厂，
    // 若未来有人在其中一处手写字面量绕开工厂，这条断言应当失败。
    const calls = [...src.matchAll(/\.\.\.this\.buildBaseLoopConfig\(ctxMgr,/g)];
    expect(calls.length).toBe(2);
  });

  test("buildBaseLoopConfig 工厂本身收敛了 permissionChecker / availability / deadlineAt / discoverJitContext 四个公共字段", () => {
    const factoryMatch = src.match(
      /private buildBaseLoopConfig\([\s\S]*?\n  \}/,
    );
    expect(factoryMatch).toBeTruthy();
    const factoryBody = factoryMatch![0];
    for (const field of ["permissionChecker", "availability", "deadlineAt", "discoverJitContext"]) {
      expect(factoryBody).toContain(field);
    }
  });
});
