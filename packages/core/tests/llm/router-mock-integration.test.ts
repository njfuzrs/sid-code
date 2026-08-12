/**
 * Router mock-provider 集成测试 (S6-T06)
 *
 * 对应 case yaml: evals/capability/router/mock-provider/case_rtr_009~013
 *
 * 真测目标: 验证 ADR-021 §4.4 mock provider 通过 ProviderRegistry 接入后,
 *          各失败模式 (503 / rate_limit / timeout) 行为符合上层 fallback / quota 期望.
 *
 * 注: 不调真 LLM, 不 spawn 子进程. 5 条 case 各对应一个 describe 块.
 */

import { describe, test, expect } from "bun:test";
import { ProviderRegistry } from "@sid-code/core/llm/registry.ts";
import { defaultConfig, type Config } from "@sid-code/core/config/config.ts";
import { RetryableError } from "@sid-code/core/llm/errors.ts";
import type { SendParams, StreamEvent } from "@sid-code/core/llm/types.ts";

const PARAMS: SendParams = {
  model: "mock-model",
  messages: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
  maxTokens: 32,
};

function mkConfig(provider: string): Config {
  return {
    ...defaultConfig(),
    provider,
    model: "mock-model",
    openaiKey: "sk-test",
    baseURL: "https://localhost",
  };
}

async function drain(it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}

describe("rtr_009 — mock-503 触发 RetryableError", () => {
  test("第 1 次调用即抛 RetryableError(overloaded), requestCount=1", async () => {
    const registry = new ProviderRegistry(mkConfig("mock-503"));
    const provider = registry.getProvider() as any;
    expect(provider.name()).toBe("mock-503");

    let caught: unknown = null;
    try {
      await drain(provider.sendMessageStream(PARAMS));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RetryableError);
    expect((caught as RetryableError).reason).toBe("overloaded");
    expect(provider.getRequestCount()).toBe(1);
  });
});

describe("rtr_010 — mock-rate-limit 携带 retryAfterMs", () => {
  test("RetryableError.reason=rate_limit + retryAfterMs 默认 1000", async () => {
    const registry = new ProviderRegistry(mkConfig("mock-rate-limit"));
    const provider = registry.getProvider();
    let caught: RetryableError | null = null;
    try {
      await drain(provider.sendMessageStream(PARAMS));
    } catch (err) {
      caught = err as RetryableError;
    }
    expect(caught).toBeInstanceOf(RetryableError);
    expect(caught!.reason).toBe("rate_limit");
    // ProviderRegistry 默认走 1000 (case yaml 的 retry_after_ms=3000 通过定制 config 触发, 默认值即可证 quota 提示能拿到 retryAfterMs 字段)
    expect(typeof caught!.retryAfterMs).toBe("number");
    expect(caught!.retryAfterMs).toBeGreaterThan(0);
  });
});

describe("rtr_011 — mock-503-after-2 半路故障", () => {
  test("前 2 次成功 message_stop, 第 3 次抛 overloaded, requestCount 单调", async () => {
    const registry = new ProviderRegistry(mkConfig("mock-503-after-2"));
    const provider = registry.getProvider() as any;

    for (let i = 0; i < 2; i++) {
      const events = await drain(provider.sendMessageStream(PARAMS));
      expect(events.find((e) => e.type === "message_stop")).toBeDefined();
    }
    expect(provider.getRequestCount()).toBe(2);

    let threw = false;
    try {
      await drain(provider.sendMessageStream(PARAMS));
    } catch (err) {
      threw = true;
      expect(err).toBeInstanceOf(RetryableError);
      expect((err as RetryableError).reason).toBe("overloaded");
    }
    expect(threw).toBe(true);
    expect(provider.getRequestCount()).toBe(3);
  });

  test("ProviderRegistry 缓存同 provider 名为同一实例 (跨 getProvider() 计数累加)", async () => {
    const registry = new ProviderRegistry(mkConfig("mock-503-after-1"));
    const a = registry.getProvider() as any;
    const b = registry.getProvider() as any;
    expect(a).toBe(b);

    await drain(a.sendMessageStream(PARAMS)); // 第 1 次成功
    expect(b.getRequestCount()).toBe(1);
    let threw = false;
    try {
      await drain(b.sendMessageStream(PARAMS)); // 第 2 次失败
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(a.getRequestCount()).toBe(2);
  });
});

describe("rtr_012 — mock-503 失败前不发任何 stream event", () => {
  test("503 抛错前 events_before_throw_length === 0 (流式协议干净)", async () => {
    const registry = new ProviderRegistry(mkConfig("mock-503"));
    const provider = registry.getProvider();

    const collected: StreamEvent[] = [];
    let threw = false;
    try {
      for await (const ev of provider.sendMessageStream(PARAMS)) {
        collected.push(ev);
      }
    } catch (err) {
      threw = true;
      expect(err).toBeInstanceOf(RetryableError);
    }
    expect(threw).toBe(true);
    expect(collected.length).toBe(0);
  });

  test("rate_limit / timeout 同样不污染流", async () => {
    for (const name of ["mock-rate-limit", "mock-timeout"]) {
      const registry = new ProviderRegistry(mkConfig(name));
      const provider = registry.getProvider();
      const collected: StreamEvent[] = [];
      try {
        for await (const ev of provider.sendMessageStream(PARAMS)) collected.push(ev);
      } catch {}
      expect(collected.length).toBe(0);
    }
  });
});

describe("rtr_013 — 未知 provider 抛错", () => {
  test('Config.provider="weird_provider_xyz" 时 getProvider() 同步抛"未知的 Provider"', () => {
    const registry = new ProviderRegistry(mkConfig("weird_provider_xyz"));
    expect(() => registry.getProvider()).toThrow(/未知的 Provider/);
  });

  test("空字符串 provider 也抛错", () => {
    const registry = new ProviderRegistry(mkConfig(""));
    expect(() => registry.getProvider()).toThrow(/未知的 Provider/);
  });

  test("mock-* 前缀但奇怪后缀不抛错 (走 ok 默认), 因为 mock-* 路由优先于 anthropic/openai/ollama 严格枚举", () => {
    // 设计取舍: mock-anything 一律走 MockProvider, 失败模式落到 ok (永不失败).
    // 这是为了让 case yaml 可以自由命名 mock-xxx 不至于被 fail-fast 拒掉.
    const registry = new ProviderRegistry(mkConfig("mock-something-weird"));
    const provider = registry.getProvider();
    expect(provider.name()).toBe("mock-something-weird");
  });
});
