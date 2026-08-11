/**
 * Phase 2 集成测试：SDKQueryEngine 端到端（mock driver）
 *
 * 用 mock driver 模拟内核事件流，验证 SDKQueryEngine 产出的完整 SDKMessage 序列：
 * init → user → assistant/tool_progress → result(success)，且每条可被 Schema 校验。
 */

import { describe, test, expect } from "bun:test";
import {
  SDKQueryEngine,
  type SDKQueryEngineDriver,
  type SDKQueryEngineConfig,
} from "@sid-code/core/sdk/query-engine.ts";
import type { QueryEngineEvent } from "@sid-code/core/query/types.ts";
import type { Message, Usage } from "@sid-code/core/llm/types.ts";
import { SDKMessageSchema } from "@sid-code/core/sdk/schemas.ts";

function makeDriver(
  events: QueryEngineEvent[],
  finalMessages: Message[],
): SDKQueryEngineDriver {
  const usage: Usage = { inputTokens: 100, outputTokens: 200 };
  return {
    async *submitMessage() {
      for (const e of events) yield e;
    },
    getUsage: () => usage,
    getCostUsd: () => 0.12,
    getMessages: () => finalMessages,
    listTools: () => [{ name: "Bash", description: "run shell" }],
    getApiDurationMs: () => 500,
  };
}

const config: SDKQueryEngineConfig = {
  cwd: "/tmp",
  sessionId: "sess-1",
  model: "claude-test",
  now: () => 5000,
  uuid: () => "uuid-fixed",
};

describe("SDKQueryEngine.submitMessage", () => {
  test("完整生命周期：init → user → assistant → tool → result", async () => {
    const events: QueryEngineEvent[] = [
      { kind: "user_message_added" },
      {
        kind: "assistant_message",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }],
        },
      },
      { kind: "tool_start", toolName: "Bash", toolInput: { command: "ls" } },
      { kind: "tool_end", toolName: "Bash", result: { isError: false, elapsedMs: 10 } },
      {
        kind: "assistant_message",
        message: { role: "assistant", content: [{ type: "text", text: "结果如下" }] },
      },
      { kind: "done", turns: 2 },
    ];
    const finalMessages: Message[] = [
      { role: "user", content: [{ type: "text", text: "列出文件" }] },
      { role: "assistant", content: [{ type: "text", text: "结果如下" }] },
    ];

    const engine = new SDKQueryEngine(config, makeDriver(events, finalMessages));
    const out: any[] = [];
    for await (const msg of engine.submitMessage("列出文件")) {
      out.push(msg);
    }

    // 序列结构
    expect(out[0]).toMatchObject({ type: "system", subtype: "init", session_id: "sess-1" });
    expect(out[0].tools).toEqual([{ name: "Bash", description: "run shell" }]);
    expect(out[1]).toMatchObject({ type: "user", session_id: "sess-1" });

    const types = out.map((m) => `${m.type}${m.subtype ? "/" + m.subtype : ""}`);
    expect(types).toContain("assistant");
    expect(types).toContain("tool_progress");

    // 终止信号
    const last = out[out.length - 1];
    expect(last).toMatchObject({
      type: "result",
      subtype: "success",
      num_turns: 2,
      session_id: "sess-1",
    });
    // result 文本由最后一条助手消息补齐
    expect(last.result).toBe("结果如下");
    // usage / cost 由 driver 补齐
    expect(last.usage).toEqual({ inputTokens: 100, outputTokens: 200 });
    expect(last.total_cost_usd).toBe(0.12);
    expect(last.duration_api_ms).toBe(500);
  });

  test("每条消息可被 SDKMessageSchema 校验", async () => {
    const events: QueryEngineEvent[] = [
      { kind: "user_message_added" },
      {
        kind: "assistant_message",
        message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
      },
      { kind: "done", turns: 1 },
    ];
    const engine = new SDKQueryEngine(
      config,
      makeDriver(events, [{ role: "assistant", content: [{ type: "text", text: "hi" }] }]),
    );
    for await (const msg of engine.submitMessage("hello")) {
      const parsed = SDKMessageSchema().safeParse(msg);
      if (!parsed.success) {
        throw new Error(`校验失败 ${JSON.stringify(msg)}: ${parsed.error.message}`);
      }
      expect(parsed.success).toBe(true);
    }
  });

  test("stream_event 默认不转发", async () => {
    const events: QueryEngineEvent[] = [
      { kind: "stream_text", text: "delta" },
      { kind: "done", turns: 1 },
    ];
    const engine = new SDKQueryEngine(config, makeDriver(events, []));
    const out: any[] = [];
    for await (const m of engine.submitMessage("x")) out.push(m);
    expect(out.some((m) => m.type === "stream_event")).toBe(false);
  });

  test("includeStreamEvents 时转发 stream_event", async () => {
    const events: QueryEngineEvent[] = [
      { kind: "stream_text", text: "delta" },
      { kind: "done", turns: 1 },
    ];
    const engine = new SDKQueryEngine(
      { ...config, includeStreamEvents: true },
      makeDriver(events, []),
    );
    const out: any[] = [];
    for await (const m of engine.submitMessage("x")) out.push(m);
    expect(out.some((m) => m.type === "stream_event")).toBe(true);
  });

  test("内核异常 → result(error_during_execution)", async () => {
    const driver: SDKQueryEngineDriver = {
      async *submitMessage() {
        yield { kind: "user_message_added" };
        throw new Error("kernel boom");
      },
      getUsage: () => ({ inputTokens: 1, outputTokens: 2 }),
      getCostUsd: () => 0,
      getMessages: () => [],
    };
    const engine = new SDKQueryEngine(config, driver);
    const out: any[] = [];
    for await (const m of engine.submitMessage("x")) out.push(m);
    const last = out[out.length - 1];
    expect(last).toMatchObject({ type: "result", subtype: "error_during_execution" });
    expect(last.errors[0]).toContain("kernel boom");
  });

  test("max_turns → result(error_max_turns)", async () => {
    const events: QueryEngineEvent[] = [
      { kind: "user_message_added" },
      { kind: "max_turns", maxTurns: 30 },
    ];
    const engine = new SDKQueryEngine(config, makeDriver(events, []));
    const out: any[] = [];
    for await (const m of engine.submitMessage("x")) out.push(m);
    const last = out[out.length - 1];
    expect(last).toMatchObject({ type: "result", subtype: "error_max_turns" });
  });

  test("无终止事件时合成 success", async () => {
    const events: QueryEngineEvent[] = [{ kind: "hook_blocked", reason: "blocked" }];
    const engine = new SDKQueryEngine(config, makeDriver(events, []));
    const out: any[] = [];
    for await (const m of engine.submitMessage("x")) out.push(m);
    const last = out[out.length - 1];
    expect(last).toMatchObject({ type: "result", subtype: "success" });
  });
});
