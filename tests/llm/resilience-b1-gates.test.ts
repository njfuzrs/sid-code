/**
 * B1 韧性层搬迁 —— 硬门槛断言
 *
 * 对应 `docs/bugfixes/todo/20260801-韧性层架构对齐CC-子代理韧性能力根治方案.md` 的 B1 批次。
 * 本文件只钉「改造是否真的生效」，不重复既有 fallback.test.ts 的行为覆盖。
 *
 * 三条门槛（缺一条则改造可被静默回退成"标志位置了但没人读"的原样）：
 *   ① 401 在**流式阶段**触发 retry-once 闸门，而非首个 401 就 terminal 拉黑；
 *   ② ECONNRESET/EPIPE 后 `keepalive: false` **进入实际 fetch 选项**
 *      （断言消费方读到，不是断言标志被置位——后者正是修复前的空转状态）；
 *   ③ 连接阶段重试 for 循环**已不存在**（防日后被"修活"成第二份平行重试实现）。
 *
 * 另附 B1-a per-call 状态隔离的并发正确性断言。
 *
 * fix_type: regression_guard
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ModelFallback } from "@sid-code/core/llm/fallback.ts";
import { ModelAvailabilityService } from "@sid-code/core/llm/availability.ts";
import {
  disableKeepAlive,
  isKeepAliveDisabled,
  getKeepAliveFetchOptions,
  wrapFetchWithKeepAlive,
  _resetKeepAliveForTesting,
} from "@sid-code/core/llm/keepalive.ts";
import type { Provider } from "@sid-code/core/llm/provider.ts";
import type { SendParams, StreamEvent } from "@sid-code/core/llm/types.ts";

const BASE_PARAMS: SendParams = {
  model: "primary-model",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  maxTokens: 100,
};

const OK_EVENTS: StreamEvent[] = [
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { inputTokens: 1, outputTokens: 1 } },
  { type: "message_stop" },
];

async function collect(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

/** 快速退避配置：避免真实等待拖到 bun 默认 5s 超时。 */
function fastConfig(extra: Record<string, unknown> = {}) {
  return {
    availability: new ModelAvailabilityService(),
    retryBackoffBaseMs: 1,
    retryBackoffMaxMs: 5,
    streamTimeoutMs: 5000,
    ...extra,
  };
}

describe("B1 门槛①：401 retry-once 闸门在流式阶段生效", () => {
  test("首个 401 从流内抛出 → 重试一次并成功（不首刀 terminal 拉黑）", async () => {
    let calls = 0;
    // 关键：错误从 **generator 函数体内** 抛出，模拟真实 provider 行为
    // （惰性求值：错误发生在首次 next()，而非调用 sendMessageStream 时）。
    const provider: Provider = {
      name: () => "mock",
      async *sendMessageStream(): AsyncIterable<StreamEvent> {
        calls++;
        if (calls === 1) {
          const err = new Error("401 Unauthorized") as Error & { status?: number };
          err.status = 401;
          throw err;
        }
        for (const e of OK_EVENTS) yield e;
      },
    };

    const availability = new ModelAvailabilityService();
    const fallback = new ModelFallback(fastConfig({ availability }));

    const events = await collect(fallback.executeWithFallback(provider, BASE_PARAMS));

    // 重试了一次并成功
    expect(calls).toBe(2);
    expect(events.some((e) => e.type === "message_stop")).toBe(true);
    // 没有降级（闸门在主模型上自愈，无需 fallback）
    expect(fallback.checkFallbackOccurred()).toBe(false);
    // 主模型没被 terminal 拉黑 —— 这是「401 闸门必须置于 classifyError 之前」的判据：
    // 若顺序颠倒，401 会先被判成 TerminalError → markTerminal，闸门永不生效。
    expect(availability.isAvailable("primary-model").available).toBe(true);
  });

  test("第二个 401 不再重试（闸门只放一次）→ 落 terminal + 降级", async () => {
    let calls = 0;
    const provider: Provider = {
      name: () => "mock",
      async *sendMessageStream(): AsyncIterable<StreamEvent> {
        calls++;
        const err = new Error("401 Unauthorized") as Error & { status?: number };
        err.status = 401;
        throw err;
      },
    };
    const backup: Provider = {
      name: () => "backup",
      async *sendMessageStream(): AsyncIterable<StreamEvent> {
        for (const e of OK_EVENTS) yield e;
      },
    };

    const fallback = new ModelFallback(
      fastConfig({
        fallbackProvider: backup,
        fallbackModel: "backup-model",
        fallbackSwitchMode: "auto",
      }),
    );

    const events = await collect(fallback.executeWithFallback(provider, BASE_PARAMS));

    // 闸门只放一次：第 1 次 401 触发重试，第 2 次 401 落 terminal → 降级。
    // 不应无限重试（若闸门失效会一直 continue）。
    expect(calls).toBe(2);
    expect(fallback.checkFallbackOccurred()).toBe(true);
    expect(events.some((e) => e.type === "message_stop")).toBe(true);
  });
});

describe("B1 门槛②：keepalive:false 真正进入 fetch 选项", () => {
  beforeEach(() => {
    _resetKeepAliveForTesting();
  });

  test("未禁用时不下发 keepalive 字段（规范路径逐字段不变）", () => {
    expect(isKeepAliveDisabled()).toBe(false);
    expect(getKeepAliveFetchOptions()).toEqual({});
    expect("keepalive" in getKeepAliveFetchOptions()).toBe(false);
  });

  test("ECONNRESET 流式失败 → 消费方（fetch 选项）读到 keepalive:false", async () => {
    let calls = 0;
    const provider: Provider = {
      name: () => "mock",
      async *sendMessageStream(): AsyncIterable<StreamEvent> {
        calls++;
        if (calls === 1) {
          const err = new Error("read ECONNRESET") as Error & { code?: string };
          err.code = "ECONNRESET";
          throw err;
        }
        for (const e of OK_EVENTS) yield e;
      },
    };

    const fallback = new ModelFallback(fastConfig());
    await collect(fallback.executeWithFallback(provider, BASE_PARAMS));

    expect(calls).toBe(2);
    // 核心断言：**消费方**取到的 fetch 选项确实含 keepalive:false。
    // 修复前 fallback 只置 ctx/config 上的标志位，全仓无人读取 → 纯空转；
    // 断言"标志被置位"会让那个 bug 继续通过，故这里断言 fetch 选项本身。
    expect(getKeepAliveFetchOptions()).toEqual({ keepalive: false });
  });

  test("wrapFetchWithKeepAlive 把 keepalive:false 注入 init（anthropic SDK 路径）", async () => {
    const seen: Array<RequestInit | undefined> = [];
    const wrapped = wrapFetchWithKeepAlive(async (_input, init) => {
      seen.push(init);
      return new Response("{}", { status: 200 });
    });

    await wrapped("https://example.invalid/v1/messages", { method: "POST" });
    expect(seen[0]).toBeDefined();
    expect((seen[0] as any).keepalive).toBeUndefined();

    // 置位后**同一个**包装实例（构造早于置位）也必须生效 —— 证明是动态读取而非
    // 构造期快照。provider 的 client 在启动时构造，disableKeepAlive() 在故障时才调，
    // 若为快照语义则永远不生效。
    disableKeepAlive();
    await wrapped("https://example.invalid/v1/messages", { method: "POST" });
    expect((seen[1] as any).keepalive).toBe(false);
    // 原有 init 字段不被吞掉
    expect((seen[1] as any).method).toBe("POST");
  });

  test("provider 源码确有 keepalive 消费点（防接线被回退成空转）", () => {
    const root = join(import.meta.dir, "..", "..", "packages", "core", "src", "llm");
    const openai = readFileSync(join(root, "openai.ts"), "utf-8");
    const anthropic = readFileSync(join(root, "anthropic.ts"), "utf-8");

    // openai：4 处 fetch 均展开 keep-alive 选项
    const spreadCount = (openai.match(/\.\.\.getKeepAliveFetchOptions\(\)/g) ?? []).length;
    expect(spreadCount).toBeGreaterThanOrEqual(3);
    // anthropic：SDK 的 init 拿不到，只能在自定义 fetch 边界注入
    expect(anthropic).toContain("wrapFetchWithKeepAlive");
  });
});

describe("B1 门槛③：连接阶段重试循环已删除（防第二份平行实现复活）", () => {
  const source = readFileSync(
    join(import.meta.dir, "..", "..", "packages", "core", "src", "llm", "fallback.ts"),
    "utf-8",
  );

  test("不再存在 connMaxRetries / CONNECTION_RETRY 循环", () => {
    // 这两个符号是连接阶段独立重试实现的指纹。它们回来 = 又出现了两份重试逻辑，
    // 而其中一份（连接阶段）在生产路径不可达 → 改了没效果、排查成本极高。
    expect(source).not.toContain("connMaxRetries");
    expect(source).not.toContain("CONNECTION_RETRY = {");
  });

  test('不再有 phase: "connection" 的重试遥测（重试只发生在流式阶段）', () => {
    expect(source).not.toContain('phase: "connection"');
  });

  test("流式阶段仍是唯一重试点（streamMaxRetries 保留）", () => {
    // 反向断言：确认上面两条不是因为把整段重试逻辑删光而"碰巧"通过。
    expect(source).toContain("streamMaxRetries");
    expect(source).toContain("openStream");
  });
});

describe("B1-a：降级控制态 per-call 隔离（并发正确性）", () => {
  /** 每次都失败的 provider（触发降级）。 */
  function alwaysFailing(name: string): Provider {
    return {
      name: () => name,
      async *sendMessageStream(): AsyncIterable<StreamEvent> {
        const err = new Error("500 Internal Server Error") as Error & { status?: number };
        err.status = 500;
        throw err;
      },
    };
  }

  test("并行调用互不干扰：每个调用都能独立降级一次", async () => {
    let backupCalls = 0;
    const backup: Provider = {
      name: () => "backup",
      async *sendMessageStream(): AsyncIterable<StreamEvent> {
        backupCalls++;
        for (const e of OK_EVENTS) yield e;
      },
    };

    // 单实例（对标 app.ts:709 的全进程单例）+ 三个并行调用。
    const fallback = new ModelFallback(
      fastConfig({
        fallbackProvider: backup,
        fallbackModel: "backup-model",
        fallbackSwitchMode: "auto",
        maxRetries: 0,
      }),
    );

    const results = await Promise.all([
      collect(fallback.executeWithFallback(alwaysFailing("a"), BASE_PARAMS)),
      collect(fallback.executeWithFallback(alwaysFailing("b"), BASE_PARAMS)),
      collect(fallback.executeWithFallback(alwaysFailing("c"), BASE_PARAMS)),
    ]);

    // 修复前：hasFallenBack 是实例字段 → 第一个调用置位后，另外两个进 tryFallback
    // 会被"fallback 已用尽"短路，backupCalls 只会是 1。
    expect(backupCalls).toBe(3);
    for (const events of results) {
      expect(events.some((e) => e.type === "message_stop")).toBe(true);
    }
  });

  test("per-call switchMode 覆盖实例配置（B2 让子代理降级的前提）", async () => {
    let asked = 0;
    let backupCalls = 0;
    const backup: Provider = {
      name: () => "backup",
      async *sendMessageStream(): AsyncIterable<StreamEvent> {
        backupCalls++;
        for (const e of OK_EVENTS) yield e;
      },
    };

    // 实例配置是生产默认的 "ask"（需要 TUI 交互）。
    const fallback = new ModelFallback(
      fastConfig({
        fallbackProvider: backup,
        fallbackModel: "backup-model",
        fallbackSwitchMode: "ask",
        maxRetries: 0,
        onFallbackDecision: async () => {
          asked++;
          return { action: "abort" as const };
        },
      }),
    );

    // per-call 传 auto → 绕开 ask 钩子直接降级。这正是 B2 让无 TUI 的子代理
    // 走同一漏斗所需的能力（旧文档把"子代理不能降级"记为设计差异）。
    const events = await collect(
      fallback.executeWithFallback(alwaysFailing("x"), BASE_PARAMS, undefined, {
        switchMode: "auto",
        querySource: "agent",
      }),
    );

    expect(asked).toBe(0);
    expect(backupCalls).toBe(1);
    expect(events.some((e) => e.type === "message_stop")).toBe(true);
  });

  test("不传 PerCallOptions 时逐字段回落 config（现有调用方零改动）", async () => {
    let asked = 0;
    const fallback = new ModelFallback(
      fastConfig({
        fallbackSwitchMode: "ask",
        maxRetries: 0,
        onFallbackDecision: async () => {
          asked++;
          return { action: "abort" as const };
        },
      }),
    );

    // 三参调用（engine.ts:275 的形态）：应仍走实例的 ask 模式。
    await collect(fallback.executeWithFallback(alwaysFailing("y"), BASE_PARAMS));
    expect(asked).toBe(1);
  });
});
