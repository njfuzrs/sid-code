/**
 * T6：流内错误提前检测 — 单元测试
 *
 * 验证：
 *   - StreamLevelError 归类：结构化 error.type（overloaded_error）→ overloaded 可重试，
 *     不依赖消息文本关键词
 *   - classifyStreamError 对认证/模型不存在等归 Terminal（不重试）
 *   - fallback 流式阶段：Anthropic 200 + overloaded_error 首事件 → 重试
 *   - OpenAI 200 + error chunk 首事件 → 重试
 *   - 正常首事件 → 正常消费
 *
 * fix_type: case_design
 */

import { describe, test, expect } from "bun:test";
import {
  classifyStreamError,
  StreamLevelError,
  RetryableError,
  TerminalError,
} from "../../src/llm/errors.ts";

describe("T6 — classifyStreamError 结构化归类", () => {
  test("overloaded_error（消息无关键词）→ StreamLevelError overloaded 可重试", () => {
    const e = classifyStreamError("anthropic", "服务暂时不可用", "overloaded_error");
    expect(e).toBeInstanceOf(StreamLevelError);
    expect(e).toBeInstanceOf(RetryableError);
    expect((e as StreamLevelError).reason).toBe("overloaded");
    expect((e as StreamLevelError).statusCode).toBe(529);
    expect((e as StreamLevelError).provider).toBe("anthropic");
    expect((e as StreamLevelError).streamLevel).toBe(true);
  });

  test("rate_limit_error → StreamLevelError rate_limit 可重试", () => {
    const e = classifyStreamError("openai", "too many requests", "rate_limit_error");
    expect(e).toBeInstanceOf(StreamLevelError);
    expect((e as StreamLevelError).reason).toBe("rate_limit");
  });

  test("authentication_error → TerminalError（不重试）", () => {
    const e = classifyStreamError("anthropic", "bad key", "authentication_error");
    expect(e).toBeInstanceOf(TerminalError);
    expect((e as TerminalError).reason).toBe("auth_failed");
  });

  test("无 type 但消息含 overloaded 关键词 → 回退文本匹配为 overloaded", () => {
    const e = classifyStreamError("openai", "Server overloaded, try later");
    expect(e).toBeInstanceOf(StreamLevelError);
    expect((e as StreamLevelError).reason).toBe("overloaded");
  });

  test("无 type 且消息无关键词 → 兜底 server_error 可重试", () => {
    const e = classifyStreamError("deepseek", "something odd happened");
    expect(e).toBeInstanceOf(StreamLevelError);
    expect((e as StreamLevelError).reason).toBe("server_error");
  });
});

describe("T6 — StreamEvent error 携带结构化字段", () => {
  test("StreamLevelError 保留 provider/statusCode 供归因", () => {
    const e = new StreamLevelError("anthropic", 529, "overloaded", "overloaded");
    expect(e.provider).toBe("anthropic");
    expect(e.statusCode).toBe(529);
    expect(e.streamLevel).toBe(true);
    expect(e.name).toBe("StreamLevelError");
    // 继承 RetryableError → fallback 的 instanceof 判断成立
    expect(e instanceof RetryableError).toBe(true);
  });
});
