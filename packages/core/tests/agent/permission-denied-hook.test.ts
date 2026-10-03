/**
 * B33：子代理路径的 PermissionDenied hook 接线。
 *
 * 主循环在 #135 已接；本文件钉住子代理（runAgentLoop → agent/tool-executor.ts）的两条拒绝分支：
 *   1. 权限检查器拒绝（deny 规则命中 → source "rule"；其余 → "auto"）
 *   2. 未配置检查器的 fail-closed 兜底（→ "auto"）
 * 漏接任何一条，「权限被拒通知到 IM」在子代理里就静默失效，而测试照样全绿。
 */

import { describe, test, expect } from "bun:test";
import { runAgentLoop } from "@sid-code/core/agent/agentic-loop.ts";
import { Manager as ContextManager } from "@sid-code/core/context/manager.ts";
import { Registry as ToolRegistry } from "@sid-code/core/tool/registry.ts";
import { LoopDetector } from "@sid-code/core/agent/loop-detection.ts";
import type { Provider } from "@sid-code/core/llm/provider.ts";
import type { StreamEvent } from "@sid-code/core/llm/types.ts";
import type { LegacyTool, LegacyToolResult } from "@sid-code/core/tool/types.ts";

function makeToolCallProvider(toolName: string, input: Record<string, unknown>): Provider {
  let call = 0;
  return {
    name: () => "mock",
    defaultModel: () => "mock-model",
    async *sendMessageStream(): AsyncIterable<StreamEvent> {
      const idx = call++;
      yield {
        type: "message_start",
        message: { usage: { inputTokens: 10, outputTokens: 0 } },
      } as any;
      if (idx === 0) {
        yield {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "t1", name: toolName },
        } as any;
        yield {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(input) },
        } as any;
        yield { type: "content_block_stop", index: 0 } as any;
        yield {
          type: "message_delta",
          delta: { stop_reason: "tool_use" },
          usage: { outputTokens: 5 },
        } as any;
      } else {
        yield { type: "content_block_start", index: 0, content_block: { type: "text" } } as any;
        yield {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "完成" },
        } as any;
        yield { type: "content_block_stop", index: 0 } as any;
        yield {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { outputTokens: 5 },
        } as any;
      }
    },
  } as unknown as Provider;
}

class MockEditTool implements LegacyTool {
  name() {
    return "edit";
  }
  description() {
    return "编辑文件";
  }
  inputSchema() {
    return { type: "object", properties: { file_path: { type: "string" } } };
  }
  readOnly() {
    return false;
  }
  async execute(): Promise<LegacyToolResult> {
    return { output: "edited" };
  }
}

type DeniedCall = { tool: string; input: Record<string, unknown>; reason: string; source: string };

/** 只实现本测试用到的 fire 方法；其余事件方法缺省即可（调用点都是可选链） */
function makeHookSystem(calls: DeniedCall[]) {
  return {
    firePreToolUseEvent: async () => ({}),
    firePostToolUseEvent: async () => ({}),
    firePostToolUseFailureEvent: async () => ({}),
    firePermissionDeniedEvent: async (
      tool: string,
      input: Record<string, unknown>,
      reason: string,
      source: string,
    ) => {
      calls.push({ tool, input, reason, source });
      return {};
    },
  } as any;
}

async function run(permissionChecker: unknown, calls: DeniedCall[]) {
  const registry = new ToolRegistry();
  registry.register(new MockEditTool() as any);
  const ctxMgr = new ContextManager({ maxTokens: 100_000 });
  ctxMgr.setSystemPrompt("test");
  ctxMgr.addMessage({ role: "user", content: [{ type: "text", text: "任务" }] });
  await runAgentLoop({
    provider: makeToolCallProvider("edit", { file_path: "a.ts" }),
    model: "mock-model",
    ctxMgr,
    tools: registry,
    maxTurns: 5,
    signal: new AbortController().signal,
    loopDetector: new LoopDetector(),
    hookSystem: makeHookSystem(calls),
    permissionChecker,
  } as any);
  // fire-and-forget：让微任务跑干再断言
  await new Promise((r) => setTimeout(r, 0));
}

describe("B33 — 子代理路径 fire PermissionDenied", () => {
  test("deny 规则命中 → source=rule，带工具名、入参与拒绝原因", async () => {
    const calls: DeniedCall[] = [];
    await run(
      {
        check: async () => ({
          allowed: false,
          reason: "命中 deny 规则 edit(*)",
          decisionReason: { type: "rule" },
        }),
      },
      calls,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      tool: "edit",
      input: { file_path: "a.ts" },
      reason: "命中 deny 规则 edit(*)",
      source: "rule",
    });
  });

  test("ask 被 dontAsk 降级拒绝 → source=auto（与规则命中处置相反，须能分开）", async () => {
    const calls: DeniedCall[] = [];
    await run(
      {
        check: async () => ({
          allowed: false,
          needsConfirmation: true,
          reason: "需要确认",
          decisionReason: { type: "other" },
        }),
      },
      calls,
    );
    expect(calls.map((c) => c.source)).toEqual(["auto"]);
  });

  test("未配置检查器的 fail-closed 拒绝同样 fire（source=auto）", async () => {
    const calls: DeniedCall[] = [];
    await run(undefined, calls);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.source).toBe("auto");
    expect(calls[0]!.reason).toContain("fail-closed");
  });

  test("权限放行时不 fire", async () => {
    const calls: DeniedCall[] = [];
    await run({ check: async () => ({ allowed: true }) }, calls);
    expect(calls).toHaveLength(0);
  });

  test("hook 自身抛错不影响拒绝结果回传", async () => {
    const registry = new ToolRegistry();
    registry.register(new MockEditTool() as any);
    const ctxMgr = new ContextManager({ maxTokens: 100_000 });
    ctxMgr.setSystemPrompt("test");
    ctxMgr.addMessage({ role: "user", content: [{ type: "text", text: "任务" }] });
    const hookSystem = {
      firePreToolUseEvent: async () => ({}),
      firePermissionDeniedEvent: () => {
        throw new Error("boom");
      },
    } as any;
    const result = await runAgentLoop({
      provider: makeToolCallProvider("edit", { file_path: "a.ts" }),
      model: "mock-model",
      ctxMgr,
      tools: registry,
      maxTurns: 5,
      signal: new AbortController().signal,
      loopDetector: new LoopDetector(),
      hookSystem,
      permissionChecker: undefined,
    } as any);
    const msg = result.messages.find((m) => m.content.some((b) => b.type === "tool_result"));
    const tr = msg?.content.find((b) => b.type === "tool_result") as any;
    expect(tr?.is_error).toBe(true);
    expect(tr?.content).toContain("fail-closed");
  });
});
