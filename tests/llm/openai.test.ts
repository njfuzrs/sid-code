/**
 * OpenAI 消息格式转换测试
 */

import { describe, test, expect } from "bun:test";
import { OpenAIProvider } from "@sid-code/core/llm/openai.ts";

// 通过继承暴露 private 方法用于测试
class TestableOpenAIProvider extends OpenAIProvider {
  testConvertMessages(messages: any[]) {
    return (this as any).convertMessages(messages);
  }
}

describe("OpenAI convertMessages", () => {
  const provider = new TestableOpenAIProvider("test-key", "gpt-4o-mini");

  test("纯文本 user 消息转为字符串 content", () => {
    const result = provider.testConvertMessages([
      {
        role: "user",
        content: [{ type: "text", text: "你好" }],
      },
    ]);

    expect(result).toEqual([
      { role: "user", content: "你好" },
    ]);
  });

  test("纯文本 assistant 消息转为字符串 content", () => {
    const result = provider.testConvertMessages([
      {
        role: "assistant",
        content: [{ type: "text", text: "你好！" }],
      },
    ]);

    expect(result).toEqual([
      { role: "assistant", content: "你好！", },
    ]);
  });

  test("assistant 消息中的 tool_use 提取到顶层 tool_calls", () => {
    const result = provider.testConvertMessages([
      {
        role: "assistant",
        content: [
          { type: "text", text: "让我读取文件" },
          {
            type: "tool_use",
            id: "call_123",
            name: "read",
            input: { file_path: "/tmp/test.ts" },
          },
        ],
      },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("assistant");
    expect(result[0].content).toBe("让我读取文件");
    expect(result[0].tool_calls).toEqual([
      {
        id: "call_123",
        type: "function",
        function: {
          name: "read",
          arguments: JSON.stringify({ file_path: "/tmp/test.ts" }),
        },
      },
    ]);
  });

  test("assistant 消息中多个 tool_use 都提取到 tool_calls", () => {
    const result = provider.testConvertMessages([
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call_1",
            name: "read",
            input: { file_path: "/a.ts" },
          },
          {
            type: "tool_use",
            id: "call_2",
            name: "read",
            input: { file_path: "/b.ts" },
          },
        ],
      },
    ]);

    expect(result[0].tool_calls).toHaveLength(2);
    expect(result[0].content).toBeNull(); // 无文本时 content 为 null
  });

  test("user 消息中的 tool_result 拆分为独立 role:tool 消息", () => {
    const result = provider.testConvertMessages([
      // 前置 assistant.tool_use 持有 call_123，使 tool_result 合法配对（否则被方案 C 兜底丢弃）
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call_123", name: "read", input: {} }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_123",
            content: "文件内容...",
          },
        ],
      },
    ]);

    // result[0] 是 assistant(tool_calls)，result[1] 才是拆出的 role:tool
    expect(result[1]).toEqual({
      role: "tool",
      tool_call_id: "call_123",
      content: "文件内容...",
    });
  });

  test("user 消息中混合 tool_result 和文本", () => {
    const result = provider.testConvertMessages([
      // 前置 assistant.tool_use 持有 call_1 / call_2，使两个 tool_result 合法配对
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "call_1", name: "read", input: {} },
          { type: "tool_use", id: "call_2", name: "read", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_1",
            content: "结果1",
          },
          {
            type: "tool_result",
            tool_use_id: "call_2",
            content: "结果2",
          },
          { type: "text", text: "请继续" },
        ],
      },
    ]);

    // result[0] 是 assistant(tool_calls)，其后是 2×role:tool + 1×user(文本)
    expect(result).toHaveLength(4);
    expect(result[1]).toEqual({ role: "tool", tool_call_id: "call_1", content: "结果1" });
    expect(result[2]).toEqual({ role: "tool", tool_call_id: "call_2", content: "结果2" });
    expect(result[3]).toEqual({ role: "user", content: "请继续" });
  });

  test("完整对话流程转换", () => {
    const result = provider.testConvertMessages([
      // 用户提问
      { role: "user", content: [{ type: "text", text: "读取 a.ts" }] },
      // 助手调用工具
      {
        role: "assistant",
        content: [
          { type: "text", text: "好的" },
          { type: "tool_use", id: "c1", name: "read", input: { file_path: "/a.ts" } },
        ],
      },
      // 工具结果
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "c1", content: "const x = 1;" },
        ],
      },
      // 助手回复
      { role: "assistant", content: [{ type: "text", text: "文件内容是..." }] },
    ]);

    expect(result).toHaveLength(4);
    expect(result[0]).toEqual({ role: "user", content: "读取 a.ts" });
    expect(result[1].role).toBe("assistant");
    expect(result[1].tool_calls).toHaveLength(1);
    expect(result[2]).toEqual({ role: "tool", tool_call_id: "c1", content: "const x = 1;" });
    expect(result[3]).toEqual({ role: "assistant", content: "文件内容是..." });
  });
});

// ─── 方案⓪：reasoning_content 回传按模型协议能力分叉（真因修复） ───
// deepseek-reasoning-leak-as-text-任务中断.md 方案⓪：
//   - DeepSeek V4 thinking 系：tool-call 轮**必须**回传 reasoning_content（否则 400 + 思维链断裂）。
//   - 旧 deepseek-reasoner / 其它模型：tool-call 轮回传会触发旧协议 400 → 剥离。
// 判据取自 model-registry 的 requiresReasoningContentForToolCalls 能力标志。
describe("OpenAI convertMessages — reasoning_content 回传分叉 (方案⓪)", () => {
  const withToolCalls = {
    role: "assistant" as const,
    content: [
      { type: "text" as const, text: "让我调用工具" },
      { type: "tool_use" as const, id: "c1", name: "read", input: { file_path: "/a.ts" } },
    ],
    _meta: { reasoning_content: "我应该先读文件再分析" },
  };

  test("DeepSeek V4：含 tool_calls 仍回传 reasoning_content（真因修复核心）", () => {
    const provider = new TestableOpenAIProvider("test-key", "deepseek-v4-pro");
    const result = provider.testConvertMessages([withToolCalls]);
    expect(result[0].tool_calls).toHaveLength(1);
    expect(result[0].reasoning_content).toBe("我应该先读文件再分析");
  });

  test("旧 deepseek-reasoner：含 tool_calls 剥离 reasoning_content（旧协议 400 规避）", () => {
    const provider = new TestableOpenAIProvider("test-key", "deepseek-reasoner");
    const result = provider.testConvertMessages([withToolCalls]);
    expect(result[0].tool_calls).toHaveLength(1);
    expect(result[0].reasoning_content).toBeUndefined();
  });

  test("非 DeepSeek 模型（gpt-4o-mini）：含 tool_calls 剥离（保守默认）", () => {
    const provider = new TestableOpenAIProvider("test-key", "gpt-4o-mini");
    const result = provider.testConvertMessages([withToolCalls]);
    expect(result[0].tool_calls).toHaveLength(1);
    expect(result[0].reasoning_content).toBeUndefined();
  });

  test("无 tool_calls：所有模型都保留 reasoning_content", () => {
    const noTool = {
      role: "assistant" as const,
      content: [{ type: "text" as const, text: "结论是 X" }],
      _meta: { reasoning_content: "推理过程……" },
    };
    for (const model of ["deepseek-v4-pro", "deepseek-reasoner", "gpt-4o-mini"]) {
      const provider = new TestableOpenAIProvider("test-key", model);
      const result = provider.testConvertMessages([noTool]);
      expect(result[0].reasoning_content).toBe("推理过程……");
      expect(result[0].tool_calls).toBeUndefined();
    }
  });
});

describe("OpenAI convertMessages — 其它兜底", () => {
  const provider = new TestableOpenAIProvider("test-key", "gpt-4o-mini");

  test("空 tool_result 兜底为有语义占位而非空串", () => {
    const result = provider.testConvertMessages([
      // 前置 assistant.tool_use 持有 c1，使 tool_result 合法配对
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "c1", name: "bash", input: {} }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "c1", content: "" }],
      },
    ]);
    // result[0] 是 assistant(tool_calls)，result[1] 是空内容兜底为 "(empty)" 的 role:tool
    expect(result[1]).toEqual({ role: "tool", tool_call_id: "c1", content: "(empty)" });
  });
});

// ── 响应头超时回归测试（fdb47f30 §3.1 P0：index 23 hang 纵深防御）──
// 验证：当服务器接受连接、发送请求体后迟迟不返回响应头时，provider 自身的
// 响应头超时能主动中断 fetch，并把 hang 转成带"超时"字样的可重试错误（而非
// 永久 hang，也不是被误判为用户 abort）。这是 fdb47f30 卡死的根因防线。
describe("OpenAI 响应头超时（§3.1 hang 纵深防御）", () => {
  test("fetch 迟迟不返回响应头 → 抛出含'超时'的可重试错误", async () => {
    const origFetch = globalThis.fetch;
    const origEnv = process.env.SID_CODE_RESPONSE_HEADER_TIMEOUT_MS;
    // 把响应头超时压到 80ms，避免测试真等 60s
    process.env.SID_CODE_RESPONSE_HEADER_TIMEOUT_MS = "80";

    // mock fetch：永不返回响应头，但尊重传入的 signal（abort 时 reject AbortError）
    let fetchSignalSeen: AbortSignal | undefined;
    globalThis.fetch = ((_url: any, init?: any) => {
      fetchSignalSeen = init?.signal;
      return new Promise((_resolve, reject) => {
        if (init?.signal) {
          init.signal.addEventListener("abort", () => {
            const e = new Error("The operation was aborted");
            (e as any).name = "AbortError";
            reject(e);
          });
        }
      });
    }) as typeof fetch;

    try {
      const provider = new OpenAIProvider("test-key", "gpt-4o-mini");
      let caught: unknown = null;
      try {
        for await (const _ev of provider.sendMessageStream({
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: "hi" }],
          maxTokens: 16,
        } as any)) {
          // sendMessageStream 的外层 catch 会把超时错误 yield 成 error event
          if (_ev.type === "error") {
            caught = new Error(_ev.error.message);
            break;
          }
        }
      } catch (e) {
        caught = e;
      }

      expect(caught).toBeInstanceOf(Error);
      // 关键断言：错误信息含"超时"，使 classifyError 归类为 RetryableError("timeout")
      expect((caught as Error).message).toContain("超时");
      // fetch 确实收到了组合 signal（外层 signal 缺省时即响应头超时 controller 的 signal）
      expect(fetchSignalSeen).toBeInstanceOf(AbortSignal);
    } finally {
      globalThis.fetch = origFetch;
      if (origEnv === undefined) delete process.env.SID_CODE_RESPONSE_HEADER_TIMEOUT_MS;
      else process.env.SID_CODE_RESPONSE_HEADER_TIMEOUT_MS = origEnv;
    }
  });

  test("用户主动 abort（非超时）→ 不被误标为超时", async () => {
    const origFetch = globalThis.fetch;
    const origEnv = process.env.SID_CODE_RESPONSE_HEADER_TIMEOUT_MS;
    // 超时设很长，确保本次中断来自用户 abort 而非响应头超时
    process.env.SID_CODE_RESPONSE_HEADER_TIMEOUT_MS = "60000";

    globalThis.fetch = ((_url: any, init?: any) => {
      return new Promise((_resolve, reject) => {
        if (init?.signal) {
          init.signal.addEventListener("abort", () => {
            const e = new Error("The operation was aborted");
            (e as any).name = "AbortError";
            reject(e);
          });
        }
      });
    }) as typeof fetch;

    try {
      const provider = new OpenAIProvider("test-key", "gpt-4o-mini");
      const userCtl = new AbortController();
      // 50ms 后用户主动中断
      setTimeout(() => userCtl.abort(), 50);

      let caught: unknown = null;
      try {
        for await (const _ev of provider.sendMessageStream(
          {
            model: "gpt-4o-mini",
            messages: [{ role: "user", content: "hi" }],
            maxTokens: 16,
          } as any,
          userCtl.signal,
        )) {
          if (_ev.type === "error") {
            caught = new Error(_ev.error.message);
            break;
          }
        }
      } catch (e) {
        caught = e;
      }

      // 用户 abort 不应被误标为"超时"——原样作为 abort 错误向上传播
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).not.toContain("响应头超时");
    } finally {
      globalThis.fetch = origFetch;
      if (origEnv === undefined) delete process.env.SID_CODE_RESPONSE_HEADER_TIMEOUT_MS;
      else process.env.SID_CODE_RESPONSE_HEADER_TIMEOUT_MS = origEnv;
    }
  });
});

// ── Content-Type 守卫回归测试（事故复盘 session 20260708-102143）──
// 背景：网关对不可用模型/渠道有时回 HTTP 200 + text/html 错误页（而非 4xx/5xx）。
// 此前该响应逐行进 SSE 解析器 → 0 个 data 行 → 读到流尾静默收尾（stopReason=null），
// 上层把它当"空回复 end_turn"，用户界面毫无提示（"任务一闪而过"）。
// 修复：headers_received 后校验 Content-Type，非 SSE 的 text/html 直接 yield 结构化
// error（streamLevel + server_error），让 fallback / 上层能如实呈现失败原因。
describe("OpenAI Content-Type 守卫（伪装成功的错误页 fail-fast）", () => {
  test("HTTP 200 + text/html 错误页 → yield 结构化 error，不静默空流收尾", async () => {
    const origFetch = globalThis.fetch;
    // 模拟网关错误页：200 状态码，但 Content-Type 是 text/html，body 是 HTML/JSON 错误信息
    const htmlErrorBody =
      '{"error":{"code":"model_not_found","message":"No available channel for model claude-sonnet-4-8 under group 个人"}}';
    globalThis.fetch = ((_url: any, _init?: any) => {
      return Promise.resolve(
        new Response(htmlErrorBody, {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
      );
    }) as typeof fetch;

    try {
      const provider = new OpenAIProvider("test-key", "claude-sonnet-4-8");
      const events: any[] = [];
      for await (const ev of provider.sendMessageStream({
        model: "claude-sonnet-4-8",
        messages: [{ role: "user", content: "hi" }],
        maxTokens: 16,
      } as any)) {
        events.push(ev);
      }

      // 关键断言 1：必须产出一个 error 事件（而非 0 事件静默结束）
      const errorEvents = events.filter((e) => e.type === "error");
      expect(errorEvents.length).toBeGreaterThan(0);

      const err = errorEvents[0];
      // 关键断言 2：错误标记为 streamLevel + server_error，让 fallback.ts 走结构化重试/降级
      expect(err.error.streamLevel).toBe(true);
      expect(err.error.type).toBe("server_error");
      // 关键断言 3：错误信息含 Content-Type，便于用户/排查定位为网关错误页
      expect(err.error.message).toContain("text/html");

      // 关键断言 4：绝不能出现"看似正常"的 message_stop（伪装成功）
      const stopEvents = events.filter((e) => e.type === "message_stop");
      expect(stopEvents.length).toBe(0);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("HTTP 200 + text/event-stream 正常流 → 不被守卫误伤", async () => {
    const origFetch = globalThis.fetch;
    // 正常 SSE 流：一个文本增量 + [DONE]
    const sseBody =
      'data: {"choices":[{"delta":{"content":"你好"},"finish_reason":null}]}\n\n' +
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
      "data: [DONE]\n\n";
    globalThis.fetch = ((_url: any, _init?: any) => {
      return Promise.resolve(
        new Response(sseBody, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      );
    }) as typeof fetch;

    try {
      const provider = new OpenAIProvider("test-key", "gpt-4o-mini");
      const events: any[] = [];
      for await (const ev of provider.sendMessageStream({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "hi" }],
        maxTokens: 16,
      } as any)) {
        events.push(ev);
      }

      // 正常流不应产出 error 事件；应有内容增量与正常收尾
      expect(events.filter((e) => e.type === "error").length).toBe(0);
      expect(events.some((e) => e.type === "content_block_delta")).toBe(true);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

// 回归：2026-07 迁移 skill 崩溃复盘。收到 [DONE] 后必须立即跳出、不再 reader.read()。
// 此前用 continue 继续读，网关在 [DONE] 后延迟关 socket（实测 39s）时会卡在空转窗口，
// 期间的 socket 错误还会经 finally 的 reader.cancel() 逃逸成 unhandledRejection 崩溃。
describe("OpenAI [DONE] 后立即收尾（不空转等 socket）", () => {
  test("[DONE] 之后即便 socket 迟迟不关，流也应迅速结束", async () => {
    const origFetch = globalThis.fetch;
    // 构造一个"[DONE] 后不发 EOF、挂起一段时间才关闭"的流，模拟网关延迟关 socket。
    const encoder = new TextEncoder();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}\n\n' +
              'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
              "data: [DONE]\n\n",
          ),
        );
        // 关键：不立刻 close()。若实现收到 [DONE] 仍继续 read()，就会卡在这里等 2s。
        timer = setTimeout(() => {
          try { controller.close(); } catch { /* already closed */ }
        }, 2000);
      },
      cancel() {
        if (timer) clearTimeout(timer);
      },
    });
    globalThis.fetch = ((_url: any, _init?: any) =>
      Promise.resolve(
        new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      )) as typeof fetch;

    try {
      const provider = new OpenAIProvider("test-key", "gpt-4o-mini");
      const events: any[] = [];
      const startedAt = Date.now();
      for await (const ev of provider.sendMessageStream({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "hi" }],
        maxTokens: 16,
      } as any)) {
        events.push(ev);
      }
      const elapsed = Date.now() - startedAt;

      // 收到 [DONE] 后应立即结束（远早于 2s 的挂起窗口），而非空转等 socket。
      expect(elapsed).toBeLessThan(1000);
      expect(events.some((e) => e.type === "message_stop")).toBe(true);
      expect(events.filter((e) => e.type === "error").length).toBe(0);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
