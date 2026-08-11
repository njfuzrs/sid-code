/**
 * A2：queryLoop abort 优雅收尾 — 集成测试
 *
 * 验证两条 abort 路径都"优雅 done"而非抛异常穿透：
 *   ① 流式响应后检测到 signal.aborted（用户在流式输出期间按 ESC）
 *      → 补 assistant(tool_use) + cancel tool_result，yield done，不抛。
 *   ② executeTools 抛 AbortError（工具执行期间被取消）
 *      → 补 cancel tool_result，yield done，不抛。
 *
 * 对标 claude-code：abort 是"用户主动中断"的正常路径，不应成为 unhandledRejection 的源头。
 *
 * fix_type: case_design
 */

import { describe, test, expect } from "bun:test";
import { queryLoop } from "@sid-code/core/query/loop.ts";
import type { QueryLoopConfig } from "@sid-code/core/query/loop.ts";
import type { QueryDeps } from "@sid-code/core/query/types.ts";
import { Manager as ContextManager } from "@sid-code/core/context/manager.ts";
import { Registry as ToolRegistry } from "@sid-code/core/tool/registry.ts";
import { ModelFallback } from "@sid-code/core/llm/fallback.ts";
import { SessionState } from "@sid-code/core/session/state.ts";
import { toAbortError } from "@sid-code/core/llm/errors.ts";
import type { Config } from "@sid-code/core/config/config.ts";
import type { AccumulatedResponse, ContentBlock, StreamEvent } from "@sid-code/core/llm/types.ts";

function makeConfig(): Config {
  return { model: "test-model", provider: "anthropic", maxTurns: 5 } as unknown as Config;
}

/** 空的流式事件序列（abort 路径下 processStream 的产物由 mock 决定，stream 内容不重要） */
async function* emptyStream(): AsyncIterable<StreamEvent> {
  // 不 yield 任何事件——真实 abort 时 SDK 已被 signal 中断
}

/** 构造一个最小可用的 QueryLoopConfig，deps 按需覆盖 */
function makeLoopConfig(overrides: Partial<QueryDeps>): {
  loopConfig: QueryLoopConfig;
  ctxMgr: ContextManager;
} {
  const ctxMgr = new ContextManager({ maxTokens: 200000 });
  ctxMgr.setSystemPrompt("test");
  ctxMgr.addMessage({ role: "user", content: [{ type: "text", text: "做点事" }] });

  const deps: QueryDeps = {
    sendWithRetry: () => emptyStream(),
    processStream: async () => {
      throw new Error("processStream not mocked");
    },
    executeTools: async () => ({ results: [] }),
    autoCompact: async () => {},
    handleContextOverflow: () => null,
    getAbortSignal: () => undefined,
    uuid: () => "uuid-test",
    ...overrides,
  };

  const loopConfig: QueryLoopConfig = {
    config: makeConfig(),
    ctxMgr,
    toolRegistry: new ToolRegistry(),
    sessionState: new SessionState("test-session"),
    fallback: new ModelFallback(),
    deps,
  };
  return { loopConfig, ctxMgr };
}

const toolUseResponse: AccumulatedResponse = {
  role: "assistant",
  content: [
    { type: "text", text: "我来执行工具" },
    { type: "tool_use", id: "call-1", name: "bash", input: { command: "ls" } },
  ] as ContentBlock[],
  stopReason: "tool_use",
  usage: { inputTokens: 10, outputTokens: 5 },
};

describe("A2 — queryLoop abort 优雅收尾", () => {
  test("路径①：流式响应后 signal 已 abort → 补 cancel result + yield done，不抛", async () => {
    const aborter = new AbortController();
    aborter.abort(); // 模拟流式期间用户已按 ESC

    const { loopConfig, ctxMgr } = makeLoopConfig({
      processStream: async () => toolUseResponse,
      getAbortSignal: () => aborter.signal,
    });

    const kinds: string[] = [];
    // 不应抛异常
    for await (const ev of queryLoop(loopConfig)) {
      kinds.push(ev.kind);
    }

    // 优雅收尾：最终 yield done
    expect(kinds).toContain("done");

    // 历史中 assistant(tool_use) + cancel tool_result 配对完整
    const msgs = ctxMgr.getMessages();
    const assistantMsg = msgs.find(
      (m) => m.role === "assistant" && m.content.some((b) => b.type === "tool_use"),
    );
    expect(assistantMsg).toBeDefined();
    const cancelMsg = msgs.find(
      (m) => m.role === "user" && m.content.some((b) => b.type === "tool_result" && b.is_error),
    );
    expect(cancelMsg).toBeDefined();
    const cancelBlock = cancelMsg!.content.find((b) => b.type === "tool_result") as any;
    expect(cancelBlock.tool_use_id).toBe("call-1");
  });

  test("路径②：executeTools 抛 AbortError → 补 cancel result + yield done，不抛", async () => {
    // signal 未 abort（避免命中路径①），让流程走到 executeTools 再抛 AbortError
    const { loopConfig, ctxMgr } = makeLoopConfig({
      processStream: async () => toolUseResponse,
      getAbortSignal: () => undefined,
      executeTools: async () => {
        throw toAbortError();
      },
    });

    const kinds: string[] = [];
    for await (const ev of queryLoop(loopConfig)) {
      kinds.push(ev.kind);
    }

    expect(kinds).toContain("done");

    // executeTools 抛错路径：assistant 已先入历史（yield assistant_message 时），随后补 cancel result
    const msgs = ctxMgr.getMessages();
    const cancelMsg = msgs.find(
      (m) => m.role === "user" && m.content.some((b) => b.type === "tool_result" && b.is_error),
    );
    expect(cancelMsg).toBeDefined();
    const cancelBlock = cancelMsg!.content.find((b) => b.type === "tool_result") as any;
    expect(cancelBlock.tool_use_id).toBe("call-1");
    expect(cancelBlock.content).toContain("取消");
  });

  test("非 abort 错误仍正常抛出（不被 abort 分支吞掉）", async () => {
    const { loopConfig } = makeLoopConfig({
      processStream: async () => toolUseResponse,
      getAbortSignal: () => undefined,
      executeTools: async () => {
        throw new Error("真实工具错误");
      },
    });

    let thrown: Error | null = null;
    try {
      for await (const _ev of queryLoop(loopConfig)) {
        // drain
      }
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown).not.toBeNull();
    expect(thrown!.message).toContain("真实工具错误");
  });
});
