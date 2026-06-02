/**
 * retry-engine.ts 测试
 * AsyncGenerator 重试引擎：进度 yield / 前台后台差异化 / 529 降级 /
 * max_tokens 溢出恢复 / prompt-too-long 扣留 / 401 / ECONNRESET / 退避
 */

import { describe, test, expect } from "bun:test";
import {
  withRetry,
  FallbackTriggeredError,
  CannotRetryError,
  shouldRetry529,
  getRetryDelay,
  computeSafeMaxTokens,
  MAX_529_RETRIES,
  type SystemAPIErrorMessage,
  type RetryContext,
} from "../../src/api/retry-engine.ts";
import { RequestAbortedError } from "../../src/llm/errors.ts";

/** 驱动一个 withRetry generator 到结束，收集 yield 的进度消息和最终结果/错误 */
async function drive<T>(
  gen: AsyncGenerator<SystemAPIErrorMessage, T>,
): Promise<{ messages: SystemAPIErrorMessage[]; result?: T; error?: unknown }> {
  const messages: SystemAPIErrorMessage[] = [];
  try {
    let next = await gen.next();
    while (!next.done) {
      messages.push(next.value);
      next = await gen.next();
    }
    return { messages, result: next.value };
  } catch (error) {
    return { messages, error };
  }
}

describe("withRetry 基础", () => {
  test("首次成功不重试", async () => {
    let calls = 0;
    const gen = withRetry(async () => {
      calls++;
      return "ok";
    }, { model: "m" });
    const { messages, result } = await drive(gen);
    expect(result).toBe("ok");
    expect(calls).toBe(1);
    expect(messages.length).toBe(0);
  });

  test("瞬态错误后成功，yield 一条进度消息", async () => {
    let calls = 0;
    const gen = withRetry(async () => {
      calls++;
      if (calls === 1) throw new Error("overloaded");
      return "ok";
    }, { model: "m", querySource: "main_thread" });
    const { messages, result } = await drive(gen);
    expect(result).toBe("ok");
    expect(calls).toBe(2);
    expect(messages.length).toBe(1);
    expect(messages[0].type).toBe("system_api_error");
    expect(messages[0].attempt).toBe(1);
    expect(messages[0].maxRetries).toBe(10);
  });
});

describe("529 前台/后台差异化", () => {
  test("后台查询遇 529 立即放弃（不重试）", async () => {
    let calls = 0;
    const gen = withRetry(async () => {
      calls++;
      throw new Error("overloaded_error");
    }, { model: "m", querySource: "summary" });
    const { error } = await drive(gen);
    expect(error).toBeInstanceOf(CannotRetryError);
    expect(calls).toBe(1);
  });

  test("前台查询遇 529 会重试", async () => {
    let calls = 0;
    const gen = withRetry(async () => {
      calls++;
      if (calls < 2) throw new Error("overloaded");
      return "ok";
    }, { model: "m", querySource: "main_thread" });
    const { result } = await drive(gen);
    expect(result).toBe("ok");
    expect(calls).toBe(2);
  });

  test("shouldRetry529: 前台 true / 后台 false / undefined true", () => {
    expect(shouldRetry529("main_thread")).toBe(true);
    expect(shouldRetry529("agent")).toBe(true);
    expect(shouldRetry529("compact")).toBe(true);
    expect(shouldRetry529("summary")).toBe(false);
    expect(shouldRetry529("title")).toBe(false);
    expect(shouldRetry529("classifier")).toBe(false);
    expect(shouldRetry529(undefined)).toBe(true);
  });
});

describe("529 连续达上限触发降级", () => {
  test("连续 MAX_529_RETRIES 次 529 + 有 fallback → FallbackTriggeredError", async () => {
    let calls = 0;
    const gen = withRetry(async () => {
      calls++;
      throw new Error("overloaded");
    }, { model: "main", fallbackModel: "fb", querySource: "main_thread" });
    const { error } = await drive(gen);
    expect(error).toBeInstanceOf(FallbackTriggeredError);
    expect((error as FallbackTriggeredError).originalModel).toBe("main");
    expect((error as FallbackTriggeredError).fallbackModel).toBe("fb");
    expect(calls).toBe(MAX_529_RETRIES);
  });

  test("连续 529 无 fallback → CannotRetryError", async () => {
    const gen = withRetry(async () => {
      throw new Error("overloaded");
    }, { model: "main", querySource: "main_thread" });
    const { error } = await drive(gen);
    expect(error).toBeInstanceOf(CannotRetryError);
  });
});

describe("max_tokens 溢出自动恢复", () => {
  test("溢出后设置 maxTokensOverride 并重试成功", async () => {
    const seenOverrides: (number | undefined)[] = [];
    let calls = 0;
    const gen = withRetry(async (_attempt: number, ctx: RetryContext) => {
      calls++;
      seenOverrides.push(ctx.maxTokensOverride);
      if (calls === 1) {
        throw new Error("input length and max_tokens exceed context limit: 188059 + 20000 > 200000");
      }
      return "ok";
    }, { model: "m" });
    const { result, messages } = await drive(gen);
    expect(result).toBe("ok");
    expect(calls).toBe(2);
    // 第二次调用应带 override，且不 yield 退避进度消息
    expect(seenOverrides[0]).toBeUndefined();
    expect(seenOverrides[1]).toBeGreaterThan(0);
    expect(messages.length).toBe(0);
  });

  test("可用空间过小无法恢复 → CannotRetryError", async () => {
    const gen = withRetry(async () => {
      throw new Error("199500 + 20000 > 200000");
    }, { model: "m" });
    const { error } = await drive(gen);
    expect(error).toBeInstanceOf(CannotRetryError);
  });
});

describe("prompt too long 扣留", () => {
  test("prompt_too_long 不重试，抛 CannotRetryError 供上层压缩", async () => {
    let calls = 0;
    const gen = withRetry(async () => {
      calls++;
      throw new Error("prompt is too long: 137500 tokens > 135000 maximum");
    }, { model: "m" });
    const { error } = await drive(gen);
    expect(error).toBeInstanceOf(CannotRetryError);
    expect(calls).toBe(1);
  });
});

describe("401 / ECONNRESET 恢复", () => {
  test("401 触发认证刷新标志并重试", async () => {
    const seenAuth: (boolean | undefined)[] = [];
    let calls = 0;
    const gen = withRetry(async (_a: number, ctx: RetryContext) => {
      calls++;
      seenAuth.push(ctx.needsAuthRefresh);
      if (calls === 1) throw new Error("401 authentication");
      return "ok";
    }, { model: "m" });
    const { result } = await drive(gen);
    expect(result).toBe("ok");
    expect(seenAuth[1]).toBe(true);
  });

  test("ECONNRESET 置位 disableKeepAlive 并重试", async () => {
    const seenKeepAlive: (boolean | undefined)[] = [];
    let calls = 0;
    const gen = withRetry(async (_a: number, ctx: RetryContext) => {
      calls++;
      seenKeepAlive.push(ctx.disableKeepAlive);
      if (calls === 1) throw Object.assign(new Error("socket reset"), { code: "ECONNRESET" });
      return "ok";
    }, { model: "m" });
    const { result } = await drive(gen);
    expect(result).toBe("ok");
    expect(seenKeepAlive[1]).toBe(true);
  });
});

describe("中止与不可重试", () => {
  test("signal 已 abort → RequestAbortedError", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const gen = withRetry(async () => "x", { model: "m", signal: ctrl.signal });
    const { error } = await drive(gen);
    expect(error).toBeInstanceOf(RequestAbortedError);
  });

  test("不可重试错误（未知）→ CannotRetryError", async () => {
    const gen = withRetry(async () => {
      throw new Error("totally unknown error");
    }, { model: "m" });
    const { error } = await drive(gen);
    expect(error).toBeInstanceOf(CannotRetryError);
  });

  test("超过 maxRetries → CannotRetryError", async () => {
    let calls = 0;
    const gen = withRetry(async () => {
      calls++;
      throw new Error("connection timeout");
    }, { model: "m", maxRetries: 2 });
    const { error } = await drive(gen);
    expect(error).toBeInstanceOf(CannotRetryError);
    // attempt 1,2,3 都失败，attempt>maxRetries(2) 在第 3 次抛出
    expect(calls).toBe(3);
  });
});

describe("退避延迟计算", () => {
  test("优先使用 Retry-After", () => {
    expect(getRetryDelay(1, 5000, undefined, () => 0)).toBe(5000);
  });
  test("指数退避 + 抖动（rng=0 时为基值）", () => {
    expect(getRetryDelay(1, undefined, undefined, () => 0)).toBe(500);
    expect(getRetryDelay(2, undefined, undefined, () => 0)).toBe(1000);
    expect(getRetryDelay(3, undefined, undefined, () => 0)).toBe(2000);
  });
  test("抖动上限 25%", () => {
    const d = getRetryDelay(1, undefined, undefined, () => 1);
    expect(d).toBe(625); // 500 * 1.25
  });
  test("封顶 MAX_DELAY", () => {
    const d = getRetryDelay(20, undefined, undefined, () => 0);
    expect(d).toBe(32000);
  });
});

describe("computeSafeMaxTokens", () => {
  test("正常计算（留 1000 安全余量）", () => {
    expect(computeSafeMaxTokens(180000, 200000)).toBe(19000);
  });
  test("空间过小返回 undefined", () => {
    expect(computeSafeMaxTokens(199000, 200000)).toBeUndefined();
  });
});
