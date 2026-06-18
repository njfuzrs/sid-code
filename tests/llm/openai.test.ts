/**
 * OpenAI 消息格式转换测试
 */

import { describe, test, expect } from "bun:test";
import { OpenAIProvider } from "../../src/llm/openai.ts";

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

// ─── P1-2：sub_agent reasoning_content 剥离 ───
// 根因 5.2：含 tool_calls 的 assistant 消息携带 reasoning_content 会触发 DeepSeek 400
// （实测 sub_agent 35.9% 失败、13 次精确命中）。断言：有 tool_calls → 剥离；无 tool_calls → 保留。
describe("OpenAI convertMessages — reasoning_content 剥离 (P1-2)", () => {
  const provider = new TestableOpenAIProvider("test-key", "gpt-4o-mini");

  test("含 tool_calls 的 assistant 消息不携带 reasoning_content", () => {
    const result = provider.testConvertMessages([
      {
        role: "assistant",
        content: [
          { type: "text", text: "让我调用工具" },
          { type: "tool_use", id: "c1", name: "read", input: { file_path: "/a.ts" } },
        ],
        _meta: { reasoning_content: "我应该先读文件再分析" },
      },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].tool_calls).toHaveLength(1);
    expect(result[0].reasoning_content).toBeUndefined();
  });

  test("无 tool_calls 的 assistant 消息保留 reasoning_content", () => {
    const result = provider.testConvertMessages([
      {
        role: "assistant",
        content: [{ type: "text", text: "结论是 X" }],
        _meta: { reasoning_content: "推理过程……" },
      },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].reasoning_content).toBe("推理过程……");
    expect(result[0].tool_calls).toBeUndefined();
  });

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
