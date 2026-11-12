import { describe, it, expect } from "bun:test";
import {
  stripTrailingInternalAck,
  queryLoop,
  type QueryLoopConfig,
} from "@sid-code/core/query/loop.ts";
import { Manager as ContextManager } from "@sid-code/core/context/manager.ts";
import { Registry as ToolRegistry } from "@sid-code/core/tool/registry.ts";
import { ModelFallback } from "@sid-code/core/llm/fallback.ts";
import { SessionState } from "@sid-code/core/session/state.ts";
import type { QueryDeps } from "@sid-code/core/query/types.ts";
import type { AccumulatedResponse, Message } from "@sid-code/core/llm/types.ts";
import type { Config } from "@sid-code/core/config/config.ts";

const u: Message = { role: "user", content: [{ type: "text", text: "q" }] };

describe("S5 发请求前剥离末尾内部 ack（避免 Anthropic 族当预填发出）", () => {
  it("末尾是带内部 origin 的 assistant → 剥掉", () => {
    const ack: Message = {
      role: "assistant",
      content: [{ type: "text", text: "好的" }],
      _meta: { origin: "compact-reattach" },
    };
    expect(stripTrailingInternalAck([u, ack])).toEqual([u]);
  });
  it("末尾是真实 assistant / user → 原样", () => {
    const a: Message = { role: "assistant", content: [{ type: "text", text: "答" }] };
    expect(stripTrailingInternalAck([u, a])).toHaveLength(2);
    expect(stripTrailingInternalAck([u])).toHaveLength(1);
  });
});

// 接线回归（原在 learned-window-followups.test.ts 的 T3）：纯函数单测覆盖不到
// 「queryLoop 真的在发请求前调了它」这一层，2026-11 撤销 S6 窗口学习时把它迁到这里。
describe("S5 接线：queryLoop 发请求前确实剥掉末尾内部 ack", () => {
  it("历史以 compact ack 收尾：发出的请求不以那条 assistant 结尾", async () => {
    const sent: Message[][] = [];
    const ctxMgr = new ContextManager({ maxTokens: 1_000_000 });
    ctxMgr.setSystemPrompt("test");
    ctxMgr.setMessages([
      {
        role: "user",
        content: [{ type: "text", text: "[对话摘要] 之前做了 X" }],
        _meta: { origin: "compact-summary" },
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "好的，我已了解之前的上下文。" }],
        _meta: { origin: "compact-summary" },
      },
    ]);
    const deps = {
      sendWithRetry: (params: { messages: Message[] }) => {
        sent.push(params.messages);
        return (async function* () {})();
      },
      processStream: async () =>
        ({
          role: "assistant",
          content: [{ type: "text", text: "好的" }],
          stopReason: "end_turn",
          usage: { inputTokens: 5, outputTokens: 2 },
        }) as AccumulatedResponse,
      executeTools: async () => ({ results: [] }),
      autoCompact: async () => {},
      getAbortSignal: () => undefined,
      abortCurrentRequest: () => {},
      uuid: () => "u",
      traceAppendEvent: () => {},
    } as unknown as QueryDeps;
    const cfg = {
      config: {
        model: "origin-test-model-s5-ack",
        provider: "anthropic",
        baseURL: "https://gw-a.example.com/v1",
        maxTurns: 4,
        availableModels: [],
      } as unknown as Config,
      ctxMgr,
      toolRegistry: new ToolRegistry(),
      sessionState: new SessionState("s"),
      fallback: new ModelFallback(),
      deps,
    } as QueryLoopConfig;

    for await (const _ev of queryLoop(cfg)) {
      /* drain */
    }
    expect(sent.length).toBeGreaterThan(0);
    const last = sent[0]![sent[0]!.length - 1]!;
    expect(last.role).toBe("user");
  });
});
