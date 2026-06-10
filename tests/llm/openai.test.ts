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
  const provider = new TestableOpenAIProvider("test-key");

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

    expect(result).toEqual([
      {
        role: "tool",
        tool_call_id: "call_123",
        content: "文件内容...",
      },
    ]);
  });

  test("user 消息中混合 tool_result 和文本", () => {
    const result = provider.testConvertMessages([
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

    // tool_result 先转为 role:tool，文本后面作为 user 消息
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ role: "tool", tool_call_id: "call_1", content: "结果1" });
    expect(result[1]).toEqual({ role: "tool", tool_call_id: "call_2", content: "结果2" });
    expect(result[2]).toEqual({ role: "user", content: "请继续" });
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
  const provider = new TestableOpenAIProvider("test-key");

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
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "c1", content: "" }],
      },
    ]);
    expect(result[0]).toEqual({ role: "tool", tool_call_id: "c1", content: "(empty)" });
  });
});
