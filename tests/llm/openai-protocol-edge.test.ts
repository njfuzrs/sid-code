/**
 * OpenAI Provider 协议边界测试 — 对应《OpenAI-Provider-协议处理分析报告》P0+P1 修复
 *
 * 锁死以下不变量（修复前会漏/会 400，修复后必须成立）：
 *   §2.1 tool message content 空串 → 兜底为 "(empty)"
 *   §2.2 tool_use.input 为 undefined / 非对象 → arguments 始终是合法 JSON 字符串
 *   §2.3 空 tool_use.id / 空 tool_result.tool_use_id → fail-fast 抛错
 *   §3.1 o-series 用 developer role；非 o-series 用 system；且不重复注入
 *   §3.2 o-series 用 max_completion_tokens；非 o-series 用 max_tokens
 *   §4.4 finish_reason 五值映射（含 content_filter 不再误并入 end_turn）
 */

import { describe, test, expect } from "bun:test";
import { OpenAIProvider, extractOpenAICacheHit } from "../../src/llm/openai.ts";
import { DYNAMIC_BOUNDARY } from "../../src/api/cache-strategy.ts";

class TestableOpenAIProvider extends OpenAIProvider {
  testConvertMessages(messages: any[]) {
    return (this as any).convertMessages(messages);
  }
  testIsReasoningModel(model: string): boolean {
    return (this as any).isReasoningModel(model);
  }
  testPrependSystem(messages: any[], system: string, model: string) {
    (this as any).prependSystemMessage(messages, system, model);
    return messages;
  }
  testApplyMaxTokens(model: string, maxTokens: number) {
    const body: any = {};
    (this as any).applyMaxTokens(body, maxTokens, model);
    return body;
  }
  static testMapFinishReason(fr: string | null | undefined): string {
    return (OpenAIProvider as any).mapFinishReason(fr);
  }
  static testToToolChoice(tc: any) {
    return (OpenAIProvider as any).toToolChoice(tc);
  }
}

const provider = new TestableOpenAIProvider("test-key");

describe("§2.2 tool_use.input 兜底为合法 JSON", () => {
  test("input 为 undefined → arguments = '{}'", () => {
    const result = provider.testConvertMessages([
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "c1", name: "noop", input: undefined }],
      },
    ]);
    expect(result[0].tool_calls[0].function.arguments).toBe("{}");
    // 必须是可解析的 JSON 字符串，不能是 JS undefined
    expect(() => JSON.parse(result[0].tool_calls[0].function.arguments)).not.toThrow();
  });

  test("input 为正常对象 → arguments 为对应 JSON", () => {
    const result = provider.testConvertMessages([
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "c1", name: "read", input: { path: "/a" } }],
      },
    ]);
    expect(JSON.parse(result[0].tool_calls[0].function.arguments)).toEqual({ path: "/a" });
  });
});

describe("thinking-only assistant 消息兜底（reasoning 模型整轮走 reasoning_content）", () => {
  test("仅 thinking 块 → content 用思考文本兜底，非 null", () => {
    const result = provider.testConvertMessages([
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "我先想一下这个问题" }],
      },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("assistant");
    // 关键：content 非空、非 null —— 否则 DeepSeek/OpenAI 报 "content or tool_calls must be set" 400
    expect(result[0].content).toBe("我先想一下这个问题");
    expect(result[0].tool_calls).toBeUndefined();
  });

  test("有 text 时 thinking 不参与兜底（text 优先）", () => {
    const result = provider.testConvertMessages([
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "思考内容" },
          { type: "text", text: "正式回答" },
        ],
      },
    ]);
    expect(result[0].content).toBe("正式回答");
  });

  test("thinking + tool_use → content 为 null，走 tool_calls（不触发兜底）", () => {
    const result = provider.testConvertMessages([
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "决定调用工具" },
          { type: "tool_use", id: "c1", name: "read", input: { path: "/a" } },
        ],
      },
    ]);
    expect(result[0].content).toBeNull();
    expect(result[0].tool_calls).toHaveLength(1);
  });
});

describe("§2.3 空 id fail-fast", () => {
  test("tool_use 缺 id → 抛错", () => {
    expect(() =>
      provider.testConvertMessages([
        { role: "assistant", content: [{ type: "tool_use", id: "", name: "x", input: {} }] },
      ]),
    ).toThrow(/缺少 id/);
  });

  test("tool_result 缺 tool_use_id → 抛错", () => {
    expect(() =>
      provider.testConvertMessages([
        { role: "user", content: [{ type: "tool_result", tool_use_id: "", content: "ok" }] },
      ]),
    ).toThrow(/缺少 tool_use_id/);
  });
});

describe("§2.1 tool message content 空串兜底", () => {
  // 前置 assistant.tool_use 持有 c1，使 tool_result 合法配对（否则被方案 C 兜底丢弃）。
  // result[0] 是 assistant(tool_calls)，result[1] 才是拆出的 role:tool。
  const asstC1 = {
    role: "assistant" as const,
    content: [{ type: "tool_use" as const, id: "c1", name: "bash", input: {} }],
  };

  test("空串 content → (empty)", () => {
    const result = provider.testConvertMessages([
      asstC1,
      { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "" }] },
    ]);
    expect(result[1]).toEqual({ role: "tool", tool_call_id: "c1", content: "(empty)" });
  });

  test("非空 content → 原样", () => {
    const result = provider.testConvertMessages([
      asstC1,
      { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "结果" }] },
    ]);
    expect(result[1].content).toBe("结果");
  });
});

describe("§3.1 / §3.2 o-series 协议差异", () => {
  test("isReasoningModel 识别 o1/o3/o4，不误伤 gpt-4o/deepseek", () => {
    expect(provider.testIsReasoningModel("o1")).toBe(true);
    expect(provider.testIsReasoningModel("o3-mini")).toBe(true);
    expect(provider.testIsReasoningModel("o4-preview")).toBe(true);
    expect(provider.testIsReasoningModel("gpt-4o")).toBe(false); // 4o 不是 o-series
    expect(provider.testIsReasoningModel("deepseek-v4-pro")).toBe(false);
  });

  test("o-series → developer role；非 o-series → system", () => {
    expect(provider.testPrependSystem([], "sys", "o1")[0]).toEqual({ role: "developer", content: "sys" });
    expect(provider.testPrependSystem([], "sys", "gpt-4o")[0]).toEqual({ role: "system", content: "sys" });
  });

  test("首条已是 system/developer → 不重复注入（§4.1）", () => {
    const existing = [{ role: "system", content: "old" }];
    const out = provider.testPrependSystem(existing, "new", "gpt-4o");
    expect(out).toHaveLength(1);
    expect(out[0].content).toBe("old");
  });

  test("o-series → max_completion_tokens；非 o-series → max_tokens", () => {
    expect(provider.testApplyMaxTokens("o1", 1000)).toEqual({ max_completion_tokens: 1000 });
    expect(provider.testApplyMaxTokens("gpt-4o", 1000)).toEqual({ max_tokens: 1000 });
  });
});

describe("缓存命中率修复：prependSystemMessage 按 DYNAMIC_BOUNDARY 拆分静态/动态区", () => {
  test("含 DYNAMIC_BOUNDARY → messages[0] 只含静态内容，不含边界标记字面量", () => {
    const system = `STATIC${DYNAMIC_BOUNDARY}DYNAMIC`;
    const out = provider.testPrependSystem([], system, "gpt-4o");
    expect(out[0]).toEqual({ role: "system", content: "STATIC" });
    expect(out[0].content).not.toContain("DYNAMIC_BOUNDARY");
  });

  test("动态区被追加为末尾新增的 role:user 消息，用 <system-reminder> 包裹", () => {
    const system = `STATIC${DYNAMIC_BOUNDARY}Today's date is 2026-07-03`;
    const out = provider.testPrependSystem(
      [{ role: "user", content: "hello" }],
      system,
      "gpt-4o",
    );
    // [system(static), user(hello), user(reminder)]
    expect(out).toHaveLength(3);
    expect(out[2]).toEqual({
      role: "user",
      content: "<system-reminder>\nToday's date is 2026-07-03\n</system-reminder>",
    });
  });

  test("不含 DYNAMIC_BOUNDARY → 向后兼容，整段进 messages[0]，不追加任何消息", () => {
    const out = provider.testPrependSystem([{ role: "user", content: "hi" }], "plain sys", "gpt-4o");
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ role: "system", content: "plain sys" });
  });

  test("原 messages 为空数组 → 动态区仍正确追加在最后", () => {
    const system = `STATIC${DYNAMIC_BOUNDARY}DYNAMIC`;
    const out = provider.testPrependSystem([], system, "gpt-4o");
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ role: "system", content: "STATIC" });
    expect(out[1]).toEqual({
      role: "user",
      content: "<system-reminder>\nDYNAMIC\n</system-reminder>",
    });
  });

  test("原 messages 以 role:tool 结尾（并行工具结果轮）→ 动态区仍新增而非改写", () => {
    const assistantMsg = { role: "assistant", content: null, tool_calls: [{ id: "c1" }] };
    const toolMsg = { role: "tool", tool_call_id: "c1", content: "ok" };
    const system = `STATIC${DYNAMIC_BOUNDARY}DYNAMIC`;
    const out = provider.testPrependSystem([assistantMsg, toolMsg], system, "gpt-4o");
    expect(out).toHaveLength(4);
    expect(out[1]).toEqual({ role: "assistant", content: null, tool_calls: [{ id: "c1" }] });
    expect(out[2]).toEqual({ role: "tool", tool_call_id: "c1", content: "ok" });
    expect(out[3]).toEqual({
      role: "user",
      content: "<system-reminder>\nDYNAMIC\n</system-reminder>",
    });
  });

  test("o-series（developer role）静态区同样正确拆分，动态区仍以 role:user 追加", () => {
    const system = `STATIC${DYNAMIC_BOUNDARY}DYNAMIC`;
    const out = provider.testPrependSystem([], system, "o1");
    expect(out[0]).toEqual({ role: "developer", content: "STATIC" });
    expect(out[1].role).toBe("user");
  });
});

describe("§4.4 finish_reason 五值映射", () => {
  test("tool_calls / function_call → tool_use", () => {
    expect(TestableOpenAIProvider.testMapFinishReason("tool_calls")).toBe("tool_use");
    expect(TestableOpenAIProvider.testMapFinishReason("function_call")).toBe("tool_use");
  });
  test("length → max_tokens", () => {
    expect(TestableOpenAIProvider.testMapFinishReason("length")).toBe("max_tokens");
  });
  test("content_filter → content_filter（不再误并入 end_turn）", () => {
    expect(TestableOpenAIProvider.testMapFinishReason("content_filter")).toBe("content_filter");
  });
  test("stop / null / 未知 → end_turn", () => {
    expect(TestableOpenAIProvider.testMapFinishReason("stop")).toBe("end_turn");
    expect(TestableOpenAIProvider.testMapFinishReason(null)).toBe("end_turn");
    expect(TestableOpenAIProvider.testMapFinishReason("weird")).toBe("end_turn");
  });
});

describe("§4.2 tool_choice 映射", () => {
  test("不传 → undefined（不下发，沿用服务端默认）", () => {
    expect(TestableOpenAIProvider.testToToolChoice(undefined)).toBeUndefined();
    expect(TestableOpenAIProvider.testToToolChoice(null)).toBeUndefined();
  });
  test("字符串策略 → 原样", () => {
    expect(TestableOpenAIProvider.testToToolChoice("auto")).toBe("auto");
    expect(TestableOpenAIProvider.testToToolChoice("none")).toBe("none");
    expect(TestableOpenAIProvider.testToToolChoice("required")).toBe("required");
  });
  test("具名工具 → { type: function, function: { name } }", () => {
    expect(TestableOpenAIProvider.testToToolChoice({ name: "read" })).toEqual({
      type: "function",
      function: { name: "read" },
    });
  });
});

describe("§3.4 vision 能力如实声明", () => {
  test("capabilities.vision = false（无图片输入管线时不虚标）", () => {
    expect(provider.capabilities().vision).toBe(false);
  });
});

describe("extractOpenAICacheHit：各家缓存命中字段兜底链（依据 api-reference 各家文档）", () => {
  test("① DeepSeek 官方直连：顶层 prompt_cache_hit_tokens 优先", () => {
    expect(extractOpenAICacheHit({
      prompt_tokens: 100,
      prompt_cache_hit_tokens: 64,
      prompt_cache_miss_tokens: 36,
    })).toBe(64);
  });

  test("② OpenAI 标准 / 公司网关归一化：prompt_tokens_details.cached_tokens", () => {
    // gpt/glm/gemini/qwen隐式/grok 及公司网关统一归一化后的 deepseek/kimi 均走此形状
    expect(extractOpenAICacheHit({
      prompt_tokens: 2000,
      prompt_tokens_details: { cached_tokens: 1024 },
    })).toBe(1024);
  });

  test("③ Kimi 官方直连：顶层 cached_tokens 兜底命中", () => {
    // 修复点：旧兜底链只查 ①② → kimi 官方顶层 cached_tokens 会漏采恒 0
    expect(extractOpenAICacheHit({
      prompt_tokens: 19,
      completion_tokens: 21,
      cached_tokens: 10,
    })).toBe(10);
  });

  test("优先级：prompt_cache_hit_tokens > prompt_tokens_details.cached_tokens > cached_tokens", () => {
    expect(extractOpenAICacheHit({
      prompt_cache_hit_tokens: 1,
      prompt_tokens_details: { cached_tokens: 2 },
      cached_tokens: 3,
    })).toBe(1);
    expect(extractOpenAICacheHit({
      prompt_tokens_details: { cached_tokens: 2 },
      cached_tokens: 3,
    })).toBe(2);
  });

  test("无任何缓存字段 → 0（无缓存模型 / ollama 不误报）", () => {
    expect(extractOpenAICacheHit({ prompt_tokens: 100, completion_tokens: 20 })).toBe(0);
    expect(extractOpenAICacheHit(undefined)).toBe(0);
    expect(extractOpenAICacheHit({})).toBe(0);
  });

  test("命中为 0 显式返回 0（不因 ?? 短路误判 falsy）", () => {
    // 0 是合法命中值(冷启动)，?? 只在 null/undefined 时下探，不会把 0 当缺失
    expect(extractOpenAICacheHit({ prompt_tokens_details: { cached_tokens: 0 } })).toBe(0);
    expect(extractOpenAICacheHit({ prompt_cache_hit_tokens: 0 })).toBe(0);
  });
});

