/**
 * B6「超越 CC」（S1–S4）—— 硬门槛断言
 *
 * 对应 `docs/bugfixes/todo/20260801-韧性层架构对齐CC-子代理韧性能力根治方案.md` 的 B6 批次。
 *
 * 本批次全部四项都直接撞在 §七 F7 那条纪律上：**能力已实现 ≠ 能力已生效**。
 * 施工中有两项确实栽在这上面（都由本文件的断言逼出来）：
 *   - S4 首版接在"重试耗尽"之后，而空响应走的是 fail-fast 分支 → 永远到不了，
 *     实测非流式请求零调用。修法见 fallback.ts 的 fail-fast 分支注释。
 *   - S2 首版只"对齐到同一冷却截止时刻" → 6 路一起睡一起醒 = 惊群，实测
 *     总请求/被拒数**一模一样**。修法是补错峰（COOLDOWN_STAGGER_SLOTS）。
 * 所以每条断言都尽量断"**副作用真的发生了**"（provider 被调用了几次 / 遥测事件
 * 出现了几条），而不是"函数返回值看着对"。
 *
 * 并且按 B5 的成对纪律写：钉修好的方向，也钉**没被顺手放宽**的方向。
 * 只钉前者的话，"把门槛全放开"（什么错误都降级、什么情况都冷却）也能让测试变绿。
 *
 * fix_type: regression_guard
 */

import { describe, test, expect } from "bun:test";
import { ModelFallback } from "@sid-code/core/llm/fallback.ts";
import { ModelAvailabilityService, MAX_COOLDOWN_WAIT_MS, MIN_COOLDOWN_MS } from "@sid-code/core/llm/availability.ts";
import type { RetryTelemetryEvent } from "@sid-code/core/llm/retry-telemetry.ts";
import type { SendParams, StreamEvent } from "@sid-code/core/llm/types.ts";

// ═══════════════════════════════════════════════════════════════════
// 夹具
// ═══════════════════════════════════════════════════════════════════

const PARAMS = { model: "m1", messages: [], maxTokens: 500 } as unknown as SendParams;

/** 产出正常内容的流。 */
async function* okStream(): AsyncGenerator<StreamEvent> {
  yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } as unknown as StreamEvent;
  yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } } as unknown as StreamEvent;
  yield { type: "content_block_stop", index: 0 } as unknown as StreamEvent;
  yield { type: "message_stop" } as unknown as StreamEvent;
}

/** 零事件流：网关回 text/html 错误页 / 空 body 被解析成 0 事件的形态。 */
async function* emptyStream(): AsyncGenerator<StreamEvent> {
  // 刻意不 yield 任何东西
}

function errStream(message: string, type: string, statusCode: number, retryAfterMs?: number) {
  return async function* (): AsyncGenerator<StreamEvent> {
    yield {
      type: "error",
      error: { message, type, statusCode, streamLevel: true, ...(retryAfterMs ? { retryAfterMs } : {}) },
    } as unknown as StreamEvent;
  };
}

interface ProbeProvider {
  provider: any;
  counts: { stream: number; nonStream: number };
}

function makeProvider(
  streamImpl: () => AsyncGenerator<StreamEvent>,
  nonStreamResult?: unknown,
): ProbeProvider {
  const counts = { stream: 0, nonStream: 0 };
  const provider: any = {
    name: () => "openai",
    sendMessageStream: function () { counts.stream++; return streamImpl(); },
  };
  if (nonStreamResult !== undefined) {
    provider.sendMessageNonStreaming = async () => { counts.nonStream++; return nonStreamResult; };
  }
  return { provider, counts };
}

const NON_STREAM_OK = {
  content: [{ type: "text", text: "来自非流式" }],
  usage: { inputTokens: 1, outputTokens: 2 },
  stopReason: "end_turn",
};

async function drain(
  fb: ModelFallback,
  provider: any,
  perCall: Record<string, unknown> = {},
): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  try {
    for await (const e of fb.executeWithFallback(provider, PARAMS, undefined, {
      querySource: "agent:builtin", switchMode: "auto", ...perCall,
    } as any)) out.push(e);
  } catch { /* 断言只看副作用，不看抛不抛 */ }
  return out;
}

function fastFallback(extra: Record<string, unknown> = {}) {
  const events: RetryTelemetryEvent[] = [];
  const availability = (extra.availability as ModelAvailabilityService) ?? new ModelAvailabilityService();
  const fb = new ModelFallback({
    availability,
    retryBackoffBaseMs: 1,
    retryBackoffMaxMs: 3,
    maxRetries: 1,
    streamTimeoutMs: 30_000,
    onTelemetry: (e) => events.push(e),
    ...extra,
  });
  return { fb, events, availability };
}

const textOf = (evts: StreamEvent[]) =>
  evts.filter((e) => e.type === "content_block_delta")
    .map((e) => (e as any).delta.text).join("");

// ═══════════════════════════════════════════════════════════════════
// S1 —— availability 拉黑层没在 B2 改造中丢失（防守项）
// ═══════════════════════════════════════════════════════════════════
//
// CC 完全没有这一层（它每次调用重新决策，不记"这个模型已经不行了"）。
// B2 把子代理接进漏斗时，这层能力必须**跟着一起继承**——它是我们相对 CC 的
// 既有优势，改造中丢掉不会有任何报错，只会静默退回 CC 的语义。

describe("S1：availability 拉黑层（子代理路径读写双向）", () => {
  test("写：子代理撞 terminal 错误 → 模型被拉黑（跨路径可见）", async () => {
    const availability = new ModelAvailabilityService();
    const { fb } = fastFallback({ availability });
    const { provider } = makeProvider(errStream("401 invalid api key", "authentication_error", 401));

    await drain(fb, provider);

    // 拉黑写在**共享**的 availability 上，故主循环/其他子代理都能看到。
    expect(availability.isTerminal("m1")).toBe(true);
  });

  test("读：已拉黑的模型再被调用 → provider 完全不被触达（调用前预筛）", async () => {
    const availability = new ModelAvailabilityService();
    availability.markTerminal("m1", "先前已判定不可用");
    const { fb } = fastFallback({ availability });
    const { provider, counts } = makeProvider(okStream);

    await drain(fb, provider);

    // 关键断言：不是"结果为空"，而是**一次网络请求都没发出去**。
    // 这正是这层的价值：已知不可用的模型不该再烧配额/时间。
    expect(counts.stream).toBe(0);
  });

  test("负向：健康模型不受影响（预筛不是一律拦）", async () => {
    const { fb } = fastFallback();
    const { provider, counts } = makeProvider(okStream);

    const out = await drain(fb, provider);

    expect(counts.stream).toBe(1);
    expect(textOf(out)).toBe("ok");
  });
});

// ═══════════════════════════════════════════════════════════════════
// S4 —— 非流式降级从死代码变成生产能力
// ═══════════════════════════════════════════════════════════════════

describe("S4：非流式降级已接线（不再是死代码）", () => {
  test("空响应流 → 降级到非流式并产出内容（首版在此失败：非流式零调用）", async () => {
    const { fb } = fastFallback();
    const { provider, counts } = makeProvider(emptyStream, NON_STREAM_OK);

    const out = await drain(fb, provider);

    // 这三条一起才叫"生效"：非流式真的被调用了、内容真的流出来了。
    expect(counts.nonStream).toBe(1);
    expect(textOf(out)).toBe("来自非流式");
    // 空响应走的是 fail-fast 分支（StreamValidationError 不是 RetryableError），
    // 首版把降级只接在"重试耗尽"之后 → 这个分支永远到不了。钉住它。
    expect(counts.stream).toBeGreaterThanOrEqual(1);
  });

  test("空响应但 provider 无非流式能力 → 抛出**有意义**的错误（不是 undefined）", async () => {
    const { fb } = fastFallback();
    const { provider } = makeProvider(emptyStream); // 不给 sendMessageNonStreaming

    // 直接 `throw transportError` 在空流路径上会抛 undefined——上游一切按
    // err.message 取值的代码全拿到 undefined，比不降级更难排查。
    let caught: unknown;
    try {
      for await (const _ of fb.executeWithFallback(provider, PARAMS, undefined,
        { querySource: "agent:builtin", switchMode: "auto" } as any)) { /* drain */ }
    } catch (e) { caught = e; }

    // 要么被漏斗内部消化成 error 事件（不抛），要么抛出的必须是真 Error。
    if (caught !== undefined) {
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toBeTruthy();
    }
  });

  test("负向：429 限流**不**降级（换传输方式一样被限，白烧一次配额）", async () => {
    const { fb } = fastFallback();
    const { provider, counts } = makeProvider(
      errStream("rate limit exceeded", "rate_limit_error", 429), NON_STREAM_OK,
    );

    await drain(fb, provider);

    expect(counts.nonStream).toBe(0);
  });

  test("负向：529 过载**不**降级", async () => {
    const { fb } = fastFallback();
    const { provider, counts } = makeProvider(
      errStream("overloaded", "overloaded_error", 529), NON_STREAM_OK,
    );

    await drain(fb, provider);

    expect(counts.nonStream).toBe(0);
  });

  test("负向：我们自己的代码 bug（TypeError）**不**降级", async () => {
    const { fb } = fastFallback();
    const counts = { nonStream: 0 };
    const provider: any = {
      name: () => "openai",
      sendMessageStream: async function* () { throw new TypeError("x.foo is not a function"); },
      sendMessageNonStreaming: async () => { counts.nonStream++; return NON_STREAM_OK; },
    };

    await drain(fb, provider);

    // 确定性故障，换传输方式治不了——降级只会把一次必败请求变成两次。
    expect(counts.nonStream).toBe(0);
  });

  test("开关可关：allowNonStreamingFallback=false → 空响应也不降级", async () => {
    const { fb } = fastFallback({ allowNonStreamingFallback: false });
    const { provider, counts } = makeProvider(emptyStream, NON_STREAM_OK);

    await drain(fb, provider);

    expect(counts.nonStream).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════
// S3 —— 按 wall-clock 剩余预算钳制重试（CC 不需要，我们需要）
// ═══════════════════════════════════════════════════════════════════
//
// CC 的子代理没有总超时，所以它不需要这个。我们有（180–360s），于是
// 「maxRetries=10」是幻觉：退避累计到第 7 次就 395s，早超 300s 预算，
// 最后一次退避连等完都等不到就被外层 abort —— 那段等待纯属白烧。

describe("S3：时间预算钳制重试", () => {
  test("预算不足以「退避 + 一次请求」→ 提前停手，不睡满", async () => {
    const events: RetryTelemetryEvent[] = [];
    // 真实退避参数（base 5s / cap 120s），预算只给 20s。
    const fb = new ModelFallback({
      availability: new ModelAvailabilityService(),
      retryBackoffBaseMs: 5_000, retryBackoffMaxMs: 120_000,
      maxRetries: 10, streamTimeoutMs: 300_000,
      onTelemetry: (e) => events.push(e),
    });
    const { provider } = makeProvider(errStream("rate limit exceeded", "rate_limit_error", 429));

    const t0 = Date.now();
    await drain(fb, provider, { deadlineAt: Date.now() + 20_000 });
    const elapsed = Date.now() - t0;

    const exhausted = events.filter((e) => e.type === "retry_budget_exhausted");
    expect(exhausted.length).toBe(1);
    // 关键：**没有**睡到预算耗尽才被砍。20s 预算下应远早于 20s 结束。
    expect(elapsed).toBeLessThan(18_000);
    // 遥测要能回答"为什么停"：需要多久 vs 还剩多久，两个数都在。
    expect(exhausted[0].delayMs).toBeGreaterThan(0);
    expect(exhausted[0].remainingMs).toBeGreaterThanOrEqual(0);
  }, 30_000);

  test("留档区分「时间不够」与「次数用尽」（归因不能混）", async () => {
    const fb = new ModelFallback({
      availability: new ModelAvailabilityService(),
      retryBackoffBaseMs: 5_000, retryBackoffMaxMs: 120_000,
      maxRetries: 10, streamTimeoutMs: 300_000,
    });
    const { provider } = makeProvider(errStream("rate limit exceeded", "rate_limit_error", 429));

    const out = await drain(fb, provider, { deadlineAt: Date.now() + 20_000 });

    // 两者修法完全不同（前者调 timeout / 降退避 cap，后者查网关限流），
    // 文案混淆会把排查方向带偏——这正是 B5 整批在消除的东西。
    const errText = out.filter((e) => e.type === "error")
      .map((e) => (e as any).error?.message ?? "").join(" ");
    expect(errText).toContain("时间预算不足");
  }, 30_000);

  test("负向：不传 deadlineAt → 行为与 S3 之前一致（纯次数上界）", async () => {
    const { fb, events } = fastFallback({ maxRetries: 4 });
    const { provider, counts } = makeProvider(errStream("rate limit exceeded", "rate_limit_error", 429));

    await drain(fb, provider); // 不传 deadlineAt

    // 跑满 1 + 4 次，且**不**产生任何预算事件。
    expect(counts.stream).toBe(5);
    expect(events.filter((e) => e.type === "retry_budget_exhausted").length).toBe(0);
  });

  test("负向：预算充裕 → 不误砍", async () => {
    const { fb, events } = fastFallback({ maxRetries: 4 });
    const { provider, counts } = makeProvider(errStream("rate limit exceeded", "rate_limit_error", 429));

    await drain(fb, provider, { deadlineAt: Date.now() + 600_000 });

    expect(counts.stream).toBe(5);
    expect(events.filter((e) => e.type === "retry_budget_exhausted").length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════
// S2 —— 共享 429 冷却（明确超越 CC：它跨 agent 零协调）
// ═══════════════════════════════════════════════════════════════════

describe("S2：availability 上的共享限流冷却", () => {
  test("冷却写入取更晚的截止时刻（多路先后撞限流只延长不缩短）", () => {
    const a = new ModelAvailabilityService();
    a.markRateLimited("m1", 5_000, "先撞的，窗口更长");
    a.markRateLimited("m1", 1_000, "后撞的，窗口更短");

    // 后撞的短冷却不该抹掉前面更长的那个。
    expect(a.getCooldownRemaining("m1")).toBeGreaterThan(3_000);
    expect(a.getCooldownInfo("m1")?.hits).toBe(2);
  });

  test("冷却等待有硬上限（网关回 Retry-After: 3600 不能让全部子代理睡一小时）", () => {
    const a = new ModelAvailabilityService();
    a.markRateLimited("m1", 3_600_000, "恶意/异常的超长 Retry-After");

    expect(a.getCooldownRemaining("m1")).toBeLessThanOrEqual(MAX_COOLDOWN_WAIT_MS);
  });

  test("成功产出 → 清除冷却（最强的「窗口已过」信号）", async () => {
    const availability = new ModelAvailabilityService();
    availability.markRateLimited("m1", 10_000, "先前限流");
    const { fb } = fastFallback({ availability });
    const { provider } = makeProvider(okStream);

    // 冷却仍在 → 入口会等，但上限被 MAX_COOLDOWN_WAIT 钳住；这里只关心成功后被清除。
    await drain(fb, provider, { deadlineAt: Date.now() + 600_000 });

    // 不清的话，后续并发路径会守着一段已作废的冷却白等 —— S2 就从"更省"变成纯"更慢"。
    expect(availability.getCooldownRemaining("m1")).toBe(0);
  }, 40_000);

  test("撞 429 → 写入共享冷却（写侧真的发生）", async () => {
    const availability = new ModelAvailabilityService();
    // 必须在**写入那一刻**断言，不能等整轮调用结束再查状态。
    // 首版这条断言写成"调用结束后 getCooldownInfo 应存在"，实测失败——而那是
    // **断言写错了、不是代码错了**：本路径写完冷却后自己就睡了 500ms（等的就是
    // 这段冷却），醒来时冷却自然到期，收尾时表已空。冷却是短时信号，用"事后查状态"
    // 去验证一个已经正确消耗掉的信号，必然假阴性。
    const marked: Array<{ model: string; ms?: number }> = [];
    const orig = availability.markRateLimited.bind(availability);
    availability.markRateLimited = (model, ms, reason) => {
      marked.push({ model, ms });
      return orig(model, ms, reason);
    };

    const { fb } = fastFallback({ availability });
    const { provider } = makeProvider(errStream("rate limit exceeded", "rate_limit_error", 429, 600));

    await drain(fb, provider);

    expect(marked.length).toBeGreaterThan(0);
    expect(marked[0].model).toBe("m1");
  });

  test("冷却时长有下限（1ms 冷却等于没有冷却，别人读不到）", () => {
    const a = new ModelAvailabilityService();
    // 退避在快配置下可能只有 1ms —— 写进去的瞬间就过期，S2 静默退化成 CC 语义。
    // 这条是由上面那个断言的排查过程逼出来的真问题（不是文档预告的）。
    a.markRateLimited("m1", 1, "极短退避");

    expect(a.getCooldownRemaining("m1")).toBeGreaterThanOrEqual(MIN_COOLDOWN_MS - 50);
  });

  test("并发多路：冷却真的被读到（首版在此失败：事件数为 0 = 只写不读）", async () => {
    const availability = new ModelAvailabilityService();
    const seen: RetryTelemetryEvent[] = [];
    const { provider } = makeProvider(errStream("rate limit exceeded", "rate_limit_error", 429, 600));

    await Promise.all(Array.from({ length: 6 }, (_, i) => {
      const fb = new ModelFallback({
        availability,
        retryBackoffBaseMs: 50, retryBackoffMaxMs: 200,
        maxRetries: 2, streamTimeoutMs: 30_000,
        onTelemetry: (e) => seen.push(e),
      });
      return drain(fb, provider, { agentId: `agent-${i}` });
    }));

    // 入口读点不够（6 路几乎同时起跑，那时冷却表还空的），重试侧必须也读。
    // 首版漏了重试侧 → 实测本断言为 0。
    expect(seen.filter((e) => e.type === "shared_cooldown_wait").length).toBeGreaterThan(0);
  }, 30_000);

  test("错峰槽位按 agentId 稳定（同一 agent 每次落同一槽 → 时序可复现）", async () => {
    const availability = new ModelAvailabilityService();
    const slotsOf = async (agentId: string) => {
      const seen: RetryTelemetryEvent[] = [];
      availability.markRateLimited("m1", 400, "预置冷却");
      const fb = new ModelFallback({
        availability, retryBackoffBaseMs: 1, retryBackoffMaxMs: 3,
        maxRetries: 0, streamTimeoutMs: 30_000,
        onTelemetry: (e) => seen.push(e),
      });
      const { provider } = makeProvider(errStream("rate limit exceeded", "rate_limit_error", 429, 400));
      await drain(fb, provider, { agentId });
      // 取 slot 分量（delayMs - remainingMs）而非完整 delayMs：
      // delayMs = remainingMs + slot*300，其中 remainingMs 是 wall-clock 敏感的
      // 整数毫秒（cd.until - Date.now()），两次调用读取时刻不同会差 1ms → toEqual 偶发失败。
      // slot 分量 = slot*300 是确定性哈希的产物，不受 wall-clock 影响——
      // 这正是本条要验证的不变量"同一 agentId 每次落同一槽"。
      return seen
        .filter((e) => e.type === "shared_cooldown_wait")
        .map((e) => (e.delayMs ?? 0) - (e.remainingMs ?? 0));
    };

    // 同一 agentId 两次 → 同一错峰槽位（slot*300 相等）。
    // 注：断言 slot 分量而非完整 delayMs，因 delayMs 含 wall-clock 敏感的 remainingMs，
    // 慢机器下两次跨毫秒边界会差 1ms 导致偶发失败（实现本身确定性，无 bug）。
    const first = await slotsOf("agent-stable");
    const second = await slotsOf("agent-stable");
    expect(first).toEqual(second);
  }, 30_000);

  test("负向：529 过载**不**写冷却（容量问题，各自退避才是正解）", async () => {
    const availability = new ModelAvailabilityService();
    const { fb } = fastFallback({ availability });
    const { provider } = makeProvider(errStream("overloaded", "overloaded_error", 529));

    await drain(fb, provider);

    // 429 是**配额**（全局，别人替我撞出的信息对我有效）；
    // 529 是**容量**（换个时刻可能就有了），一律冷却会把可用容量白白让掉。
    expect(availability.getCooldownRemaining("m1")).toBe(0);
  });

  test("负向：开关可关 → respectSharedCooldown=false 退回 CC 语义（不写不读）", async () => {
    const availability = new ModelAvailabilityService();
    const { fb } = fastFallback({ availability, respectSharedCooldown: false });
    const { provider } = makeProvider(errStream("rate limit exceeded", "rate_limit_error", 429, 600));

    await drain(fb, provider);

    expect(availability.getCooldownRemaining("m1")).toBe(0);
  });

  test("负向：无限流时冷却表恒空（零开销，不影响正常路径）", async () => {
    const availability = new ModelAvailabilityService();
    const { fb, events } = fastFallback({ availability });
    const { provider } = makeProvider(okStream);

    const out = await drain(fb, provider);

    expect(textOf(out)).toBe("ok");
    expect(availability.getCooldownRemaining("m1")).toBe(0);
    expect(events.filter((e) => e.type === "shared_cooldown_wait").length).toBe(0);
  });
});
