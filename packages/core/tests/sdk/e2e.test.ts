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

function makeDriver(events: QueryEngineEvent[], finalMessages: Message[]): SDKQueryEngineDriver {
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

  test("done 带 budgetExceeded → result(error_max_budget_usd)，不是 success", async () => {
    // B2：预算硬停此前走普通 done，被无条件映射成 success，CI 看到退出码 0。
    const events: QueryEngineEvent[] = [
      { kind: "user_message_added" },
      { kind: "done", turns: 2, budgetExceeded: { source: "quota" } },
    ];
    const engine = new SDKQueryEngine(config, makeDriver(events, []));
    const out: any[] = [];
    for await (const m of engine.submitMessage("x")) out.push(m);
    const last = out[out.length - 1];
    expect(last).toMatchObject({ type: "result", subtype: "error_max_budget_usd" });
    expect(last.subtype).not.toBe("success");
    expect(last.errors[0]).toContain("会话花费上限");
  });

  test("includeStreamEvents 时回调增量转成 stream_event，且先于终止结果", async () => {
    // G4：生产路径的 token 增量走 setStreamTextCallback，不走事件流。
    // 引擎必须在 driver 还没吐出下一个事件时就把增量送出去。
    let onText: ((text: string) => void) | null = null;
    let release: (() => void) | null = null;
    const driver: SDKQueryEngineDriver = {
      async *submitMessage() {
        yield { kind: "user_message_added" };
        // 模拟 processStream：整轮结束前只通过回调吐文本。
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        yield { kind: "done", turns: 1 };
      },
      getUsage: () => ({ inputTokens: 1, outputTokens: 2 }),
      getCostUsd: () => 0,
      getMessages: () => [],
      setStreamTextCallback(cb) {
        onText = cb;
      },
    };
    const engine = new SDKQueryEngine({ ...config, includeStreamEvents: true }, driver);

    const seen: string[] = [];
    const consuming = (async () => {
      for await (const m of engine.submitMessage("x")) {
        seen.push(m.type === "stream_event" ? "delta" : m.type);
      }
    })();

    // 等引擎挂上回调（submitMessage 的第一段是同步的，一个 tick 足够）。
    for (let i = 0; i < 10 && !onText; i++) await new Promise((r) => setTimeout(r, 5));
    onText?.("你");
    onText?.("好");
    // 增量必须在 done 之前就可见，否则只是「结束后补发」，不是实时。
    for (let i = 0; i < 10 && !seen.includes("delta"); i++)
      await new Promise((r) => setTimeout(r, 5));
    expect(seen).toContain("delta");
    expect(seen).not.toContain("result");

    release?.();
    await consuming;
    expect(seen.indexOf("delta")).toBeLessThan(seen.lastIndexOf("result"));
  });

  test("增量与终止事件同一刻到达时，增量仍先于 result", async () => {
    // 生产路径里 processStream 的最后一批 onText 与它 resolve 是同一个同步段：
    // 回调写进队列的同时，driver 的 next() 也就绪了。如果引擎先排空队列再等事件，
    // Promise.race 会选中已经就绪的 done，而回调刚写入的增量再没人排——
    // 终止消息一发就 return，这几个字就丢了。
    let onText: ((text: string) => void) | null = null;
    const driver: SDKQueryEngineDriver = {
      async *submitMessage() {
        yield { kind: "user_message_added" };
        onText?.("最后");
        onText?.("几个字");
        yield { kind: "done", turns: 1 };
      },
      getUsage: () => ({ inputTokens: 1, outputTokens: 2 }),
      getCostUsd: () => 0,
      getMessages: () => [],
      setStreamTextCallback(cb) {
        onText = cb;
      },
    };
    const engine = new SDKQueryEngine({ ...config, includeStreamEvents: true }, driver);

    const seen: string[] = [];
    for await (const m of engine.submitMessage("x")) {
      if (m.type === "stream_event")
        seen.push((m as { event?: { text?: string } }).event?.text ?? "");
      else seen.push(m.type);
    }
    // init 与 user 在增量之前合成，不属于这次要锁的竞态。
    const deltas = seen.filter((s) => s !== "system" && s !== "user" && s !== "result");
    expect(deltas).toEqual(["最后", "几个字"]);
    expect(seen[seen.length - 1]).toBe("result");
    expect(seen.indexOf("最后")).toBeLessThan(seen.indexOf("result"));
  });

  test("driver 提供拒绝清单时，result 带 permission_denials；不提供则字段不出现", async () => {
    // D1：stream-json 的消费者只读 result 消息。清单为空时不能写空数组——
    // 那会让「没有拒绝」和「这版还没有这个字段」在老消费者眼里变成两种形状。
    const events: QueryEngineEvent[] = [{ kind: "done", turns: 1 }];
    const denial = { tool_name: "Bash", resource: "rm -rf /", count: 1, reason: "非交互自动拒绝" };

    const withDenials = new SDKQueryEngine(config, {
      ...makeDriver(events, []),
      getPermissionDenials: () => [denial],
    });
    const outA: any[] = [];
    for await (const m of withDenials.submitMessage("x")) outA.push(m);
    expect(outA[outA.length - 1].permission_denials).toEqual([denial]);

    const without = new SDKQueryEngine(config, makeDriver(events, []));
    const outB: any[] = [];
    for await (const m of without.submitMessage("x")) outB.push(m);
    expect(outB[outB.length - 1]).not.toHaveProperty("permission_denials");
  });
});
