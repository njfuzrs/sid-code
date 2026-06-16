/**
 * MockProvider 单测 — ADR-021 §2.1 单测要求 ≥ 12 测
 *
 * 覆盖矩阵:
 *   4 种 failPattern (ok / 503 / rate_limit / timeout)
 *   × 3 种调用次序 (failAfterRequests=0 立即失败 / =3 前 3 次成功 / =N 永不到达)
 *
 * 加边界:
 *   - 配置校验 (name 必填, failPattern 校验)
 *   - reset 计数器
 *   - capabilities / defaultModel / name 接口契约
 *   - signal.aborted 时抛 AbortError 而非 RetryableError
 */

import { describe, test, expect } from "bun:test";
import {
  MockProvider,
  createMockProvider,
  type MockFailPattern,
} from "../../src/llm/mocks/mock-provider.ts";
import type { SendParams } from "../../src/llm/types.ts";
import { RetryableError } from "../../src/llm/errors.ts";

const PARAMS: SendParams = {
  model: "mock-model",
  messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  maxTokens: 100,
};

async function drain<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}

async function expectThrowsRetryable(
  fn: () => AsyncIterable<unknown>,
  reason: "overloaded" | "rate_limit" | "timeout",
): Promise<RetryableError> {
  try {
    await drain(fn());
    throw new Error("did not throw");
  } catch (err) {
    expect(err).toBeInstanceOf(RetryableError);
    const re = err as RetryableError;
    expect(re.reason).toBe(reason);
    return re;
  }
}

describe("MockProvider — 配置校验", () => {
  test("name 必填", () => {
    expect(() => new MockProvider({ name: "", failPattern: "ok" })).toThrow(/name 必填/);
  });

  test("未知 failPattern 抛错", () => {
    expect(() =>
      new MockProvider({ name: "x", failPattern: "weird" as MockFailPattern }),
    ).toThrow(/failPattern/);
  });

  test("createMockProvider 工厂等价于 new", () => {
    const p = createMockProvider({ name: "mock-ok", failPattern: "ok" });
    expect(p.name()).toBe("mock-ok");
  });

  test("capabilities() 返回流式 + tools 默认 true", () => {
    const p = new MockProvider({ name: "x", failPattern: "ok" });
    const caps = p.capabilities();
    expect(caps.streaming).toBe(true);
    expect(caps.tools).toBe(true);
  });
});

describe("MockProvider — failPattern: ok (永不失败)", () => {
  test("第 1 次调用成功", async () => {
    const p = new MockProvider({
      name: "mock-ok",
      failPattern: "ok",
      responseTemplate: "hello world",
    });
    const events = await drain(p.sendMessageStream(PARAMS));
    const text = events
      .filter((e) => e.type === "content_block_delta")
      .map((e: any) => e.delta.text)
      .join("");
    expect(text).toBe("hello world");
    expect(p.getRequestCount()).toBe(1);
    const stop = events.find((e) => e.type === "message_delta") as any;
    expect(stop.delta.stop_reason).toBe("end_turn");
  });

  test("连续多次调用都成功", async () => {
    const p = new MockProvider({ name: "mock-ok", failPattern: "ok" });
    for (let i = 0; i < 5; i++) {
      await drain(p.sendMessageStream(PARAMS));
    }
    expect(p.getRequestCount()).toBe(5);
  });
});

describe("MockProvider — failPattern: 503", () => {
  test("failAfterRequests=0: 第 1 次直接 503", async () => {
    const p = new MockProvider({ name: "mock-503", failPattern: "503" });
    await expectThrowsRetryable(() => p.sendMessageStream(PARAMS), "overloaded");
    expect(p.getRequestCount()).toBe(1);
  });

  test("failAfterRequests=3: 前 3 次成功, 第 4 次 503", async () => {
    const p = new MockProvider({
      name: "mock-503-after-3",
      failPattern: "503",
      failAfterRequests: 3,
    });
    for (let i = 0; i < 3; i++) {
      const evs = await drain(p.sendMessageStream(PARAMS));
      expect(evs.find((e) => e.type === "message_stop")).toBeDefined();
    }
    expect(p.getRequestCount()).toBe(3);
    await expectThrowsRetryable(() => p.sendMessageStream(PARAMS), "overloaded");
    expect(p.getRequestCount()).toBe(4);
  });

  test("failAfterRequests=999: 短回合内不进失败分支", async () => {
    const p = new MockProvider({
      name: "mock-503-far",
      failPattern: "503",
      failAfterRequests: 999,
    });
    for (let i = 0; i < 5; i++) {
      await drain(p.sendMessageStream(PARAMS));
    }
    expect(p.getRequestCount()).toBe(5);
  });
});

describe("MockProvider — failPattern: rate_limit", () => {
  test("第 1 次直接 RateLimit + retryAfterMs 默认 1000", async () => {
    const p = new MockProvider({ name: "mock-rl", failPattern: "rate_limit" });
    const re = await expectThrowsRetryable(
      () => p.sendMessageStream(PARAMS),
      "rate_limit",
    );
    expect(re.retryAfterMs).toBe(1000);
  });

  test("自定义 retryAfterMs 透传", async () => {
    const p = new MockProvider({
      name: "mock-rl",
      failPattern: "rate_limit",
      retryAfterMs: 5000,
    });
    const re = await expectThrowsRetryable(
      () => p.sendMessageStream(PARAMS),
      "rate_limit",
    );
    expect(re.retryAfterMs).toBe(5000);
  });

  test("failAfterRequests=2: 前 2 次成功后才限流", async () => {
    const p = new MockProvider({
      name: "mock-rl-2",
      failPattern: "rate_limit",
      failAfterRequests: 2,
    });
    await drain(p.sendMessageStream(PARAMS));
    await drain(p.sendMessageStream(PARAMS));
    await expectThrowsRetryable(() => p.sendMessageStream(PARAMS), "rate_limit");
  });
});

describe("MockProvider — failPattern: timeout", () => {
  test("第 1 次直接 timeout", async () => {
    const p = new MockProvider({ name: "mock-timeout", failPattern: "timeout" });
    await expectThrowsRetryable(() => p.sendMessageStream(PARAMS), "timeout");
  });

  test("failAfterRequests=1: 前 1 次成功后才 timeout", async () => {
    const p = new MockProvider({
      name: "mock-timeout-1",
      failPattern: "timeout",
      failAfterRequests: 1,
    });
    await drain(p.sendMessageStream(PARAMS));
    await expectThrowsRetryable(() => p.sendMessageStream(PARAMS), "timeout");
  });
});

describe("MockProvider — abort signal 优先级", () => {
  test("已 aborted 的 signal 抛 AbortError 而非 RetryableError", async () => {
    const p = new MockProvider({ name: "mock-503", failPattern: "503" });
    const ac = new AbortController();
    ac.abort(new Error("user cancel"));
    let caught: unknown = null;
    try {
      for await (const _ of p.sendMessageStream(PARAMS, ac.signal)) {
        // 不应迭代到任何 event
      }
    } catch (err) {
      caught = err;
    }
    // 此场景应优先抛 abort reason, 而不是 RetryableError(overloaded)
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(RetryableError);
    expect(String((caught as Error).message)).toContain("user cancel");
  });

  test("ok 模式 + 已 aborted signal: 仍然成功流式 (不主动 abort 是 caller 责任)", async () => {
    // 设计取舍: ok 路径不消耗 signal — 若 caller 想中断, 由其自身在 for-await 中检测.
    const p = new MockProvider({ name: "mock-ok", failPattern: "ok" });
    const ac = new AbortController();
    ac.abort();
    const events = await drain(p.sendMessageStream(PARAMS, ac.signal));
    expect(events.find((e) => e.type === "message_stop")).toBeDefined();
  });
});

describe("MockProvider — reset / 复用契约", () => {
  test("reset 后 failAfterRequests 重新生效", async () => {
    const p = new MockProvider({
      name: "mock-503-after-1",
      failPattern: "503",
      failAfterRequests: 1,
    });
    // 首次成功
    await drain(p.sendMessageStream(PARAMS));
    // 第二次失败
    await expectThrowsRetryable(() => p.sendMessageStream(PARAMS), "overloaded");
    // reset 后再调一次应该再次成功
    p.reset();
    await drain(p.sendMessageStream(PARAMS));
    expect(p.getRequestCount()).toBe(1);
  });
});

describe("MockProvider — 4 × 3 调用次序矩阵 (ADR-021 §2.1 单测要求)", () => {
  // ADR-021 显式要求: 4 种 failPattern × 3 种调用次序
  const patterns: MockFailPattern[] = ["ok", "503", "rate_limit", "timeout"];
  const orderings = [0, 2, 999]; // 立即失败 / 第 3 次失败 / 短跑内不失败

  for (const fp of patterns) {
    for (const after of orderings) {
      test(`pattern=${fp} failAfterRequests=${after} 行为符合预期`, async () => {
        const p = new MockProvider({
          name: `m-${fp}-${after}`,
          failPattern: fp,
          failAfterRequests: after,
        });
        // ok 模式永远成功
        if (fp === "ok") {
          for (let i = 0; i < 4; i++) await drain(p.sendMessageStream(PARAMS));
          expect(p.getRequestCount()).toBe(4);
          return;
        }
        if (after >= 100) {
          // 短跑(5 次)远小于 after, 不会触发失败
          for (let i = 0; i < 5; i++) await drain(p.sendMessageStream(PARAMS));
          expect(p.getRequestCount()).toBe(5);
          return;
        }
        // 非 ok 且 after < 100: 前 `after` 次成功, 第 after+1 次失败
        for (let i = 0; i < after; i++) {
          await drain(p.sendMessageStream(PARAMS));
        }
        let threw = false;
        try {
          await drain(p.sendMessageStream(PARAMS));
        } catch (err) {
          threw = true;
          expect(err).toBeInstanceOf(RetryableError);
        }
        expect(threw).toBe(true);
      });
    }
  }
});
