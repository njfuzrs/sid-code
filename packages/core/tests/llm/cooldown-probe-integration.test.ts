/**
 * S5 冷却探针 —— 接线门禁（不是"函数返回值看着对"，是"副作用真的发生了"）。
 *
 * 为什么必须单独有这一层：`cooldown-probe.test.ts` 那 43 条全绿也只证明了
 * **三个纯函数与状态层**是对的。S2 自己就在这件事上栽过一次——第一版"只写不读"，
 * 单测全绿而 `shared_cooldown_wait` 实测 0 次（见 b6 那条断言的注释）。
 * 本仓的铁律是新增防线的验收判据为「真实会话里被触发过」，能在测试里做到的
 * 最接近形态就是：**断言 provider 真被调用了几次、遥测真出了几条**。
 *
 * 全部断言都成对写：钉"探针真的放行了"，也钉"它没被顺手放开成人人可探"。
 *
 * fix_type: regression_guard
 */

import { describe, test, expect } from "bun:test";
import { ModelFallback } from "@sid-code/core/llm/fallback.ts";
import { ModelAvailabilityService } from "@sid-code/core/llm/availability.ts";
import type { RetryTelemetryEvent } from "@sid-code/core/llm/retry-telemetry.ts";
import type { SendParams, StreamEvent } from "@sid-code/core/llm/types.ts";

const PARAMS = { model: "m1", messages: [], maxTokens: 500 } as unknown as SendParams;

async function* okStream(): AsyncGenerator<StreamEvent> {
  yield {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  } as unknown as StreamEvent;
  yield {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "ok" },
  } as unknown as StreamEvent;
  yield { type: "content_block_stop", index: 0 } as unknown as StreamEvent;
  yield { type: "message_stop" } as unknown as StreamEvent;
}

function errStream(message: string, type: string, statusCode: number, retryAfterMs?: number) {
  return async function* (): AsyncGenerator<StreamEvent> {
    yield {
      type: "error",
      error: {
        message,
        type,
        statusCode,
        streamLevel: true,
        ...(retryAfterMs ? { retryAfterMs } : {}),
      },
    } as unknown as StreamEvent;
  };
}

function makeProvider(streamImpl: () => AsyncGenerator<StreamEvent>) {
  const counts = { stream: 0 };
  const provider: any = {
    name: () => "openai",
    sendMessageStream: function () {
      counts.stream++;
      return streamImpl();
    },
  };
  return { provider, counts };
}

async function drain(
  fb: ModelFallback,
  provider: any,
  perCall: Record<string, unknown> = {},
): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  try {
    for await (const e of fb.executeWithFallback(provider, PARAMS, undefined, {
      querySource: "agent:builtin",
      switchMode: "auto",
      ...perCall,
    } as any))
      out.push(e);
  } catch {
    /* 断言只看副作用 */
  }
  return out;
}

function fastFallback(extra: Record<string, unknown> = {}) {
  const events: RetryTelemetryEvent[] = [];
  const availability =
    (extra.availability as ModelAvailabilityService) ?? new ModelAvailabilityService();
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
  evts
    .filter((e) => e.type === "content_block_delta")
    .map((e) => (e as any).delta.text)
    .join("");

// ═══════════════════════════════════════════════════════════════════
// 写侧接线：cause 必须真的落进冷却记录
// ═══════════════════════════════════════════════════════════════════
//
// 这是整条链上最容易静默断掉的一环：markRateLimited 的第四个参数是可选的，
// 漏传不会有任何报错——冷却照样写、S2 照样工作，只是 cause 恒为 undefined
// → 探针判定 fail-closed 恒拒 → S5 静默失效**且所有测试全绿**。
// 正是"仪器少记一个字段"那类故障的形态，所以必须有一条断言钉住它。

describe("S5 写侧：撞 429 时结构化 cause 真的被写进冷却记录", () => {
  test("🔴 markRateLimited 收到第四个参数 cause='rate_limit'", async () => {
    const availability = new ModelAvailabilityService();
    // 必须在**写入那一刻**拦截，不能事后查状态：本路径写完冷却后自己就睡了，
    // 醒来冷却已到期、表已空（这个坑 b6 的 S2 断言注释里记过）。
    const marked: Array<{ cause?: string }> = [];
    const orig = availability.markRateLimited.bind(availability);
    availability.markRateLimited = (model, ms, reason, cause) => {
      marked.push({ cause });
      return orig(model, ms, reason, cause);
    };

    const { fb } = fastFallback({ availability });
    const { provider } = makeProvider(
      errStream("rate limit exceeded", "rate_limit_error", 429, 600),
    );
    await drain(fb, provider);

    expect(marked.length).toBeGreaterThan(0);
    // 若这里是 undefined，S5 全链路静默失效（判定①对 undefined 返回 false）。
    expect(marked[0].cause).toBe("rate_limit");
  });
});

// ═══════════════════════════════════════════════════════════════════
// 读侧接线：探针真的跳过了等待
// ═══════════════════════════════════════════════════════════════════

describe("S5 读侧：探针放行后不等冷却、直接发起", () => {
  test("🔴 预置 10s 冷却 + 探针 → 立刻拿到内容（等冷却的话这条会超时）", async () => {
    const availability = new ModelAvailabilityService();
    // 10s 冷却远大于本测试的耐心：只有"探针真的跳过了等待"才可能在几十毫秒内返回。
    availability.markRateLimited("m1", 10_000, "429", "rate_limit");
    const { fb, events } = fastFallback({ availability });
    const { provider, counts } = makeProvider(okStream);

    const started = Date.now();
    const out = await drain(fb, provider);
    const elapsed = Date.now() - started;

    expect(textOf(out)).toBe("ok");
    expect(counts.stream).toBe(1);
    // 断时间是这条断言的全部意义：探针的定义就是"这一路不等"。
    expect(elapsed).toBeLessThan(2_000);
    // 且必须有遥测——没有事件就等于"能力生效了但看不见"，与没生效无法区分。
    expect(events.filter((e) => e.type === "cooldown_probe").length).toBe(1);
    expect(events.find((e) => e.type === "cooldown_probe")?.probeDecision).toBe("granted");
    // 成对：探针路径**不该**同时记 shared_cooldown_wait（它没等）。
    expect(events.filter((e) => e.type === "shared_cooldown_wait").length).toBe(0);
  }, 15_000);

  test("🔴 探针成功 → clearCooldown 一次性解放所有路径（S5 的收益出口）", async () => {
    const availability = new ModelAvailabilityService();
    availability.markRateLimited("m1", 10_000, "429", "rate_limit");
    const { fb } = fastFallback({ availability });
    const { provider } = makeProvider(okStream);

    await drain(fb, provider);

    // 这是 S5 存在的理由：冷却原本只有"自然到期"和"成功产出"两条出口，
    // 而全都在等时没人去产出。探针把第二条出口重新变成可达的。
    expect(availability.getCooldownRemaining("m1")).toBe(0);
  }, 15_000);

  test("配额被占的第二路 → 记 cooldown_probe_denied(slot_taken) 并照旧等", async () => {
    const availability = new ModelAvailabilityService();
    availability.markRateLimited("m1", 800, "429", "rate_limit");
    // 第一路先把配额拿走（直接调状态层，避免依赖两次真实调用的时序）。
    expect(availability.tryAcquireCooldownProbe("m1").granted).toBe(true);

    const { fb, events } = fastFallback({ availability });
    const { provider } = makeProvider(okStream);
    await drain(fb, provider);

    const denied = events.filter((e) => e.type === "cooldown_probe_denied");
    expect(denied.length).toBe(1);
    expect(denied[0].probeDecision).toBe("slot_taken");
    // 被拒 → 走原来的等待路径（行为与 S5 上线前逐字节相同）。
    expect(events.filter((e) => e.type === "shared_cooldown_wait").length).toBe(1);
  }, 15_000);

  test("6 路并发只有 1 路探针放行，其余全部照旧等（不构成放大）", async () => {
    const availability = new ModelAvailabilityService();
    availability.markRateLimited("m1", 700, "429", "rate_limit");
    const seen: RetryTelemetryEvent[] = [];

    await Promise.all(
      Array.from({ length: 6 }, (_, i) => {
        const fb = new ModelFallback({
          availability,
          retryBackoffBaseMs: 1,
          retryBackoffMaxMs: 3,
          maxRetries: 0,
          streamTimeoutMs: 30_000,
          onTelemetry: (e) => seen.push(e),
        });
        const { provider } = makeProvider(okStream);
        return drain(fb, provider, { agentId: `agent-${i}` });
      }),
    );

    // 恰好 1：0 说明没接线，6 说明配额判定漏了（那就是 S2 要消灭的放大）。
    expect(seen.filter((e) => e.type === "cooldown_probe").length).toBe(1);
  }, 20_000);
});

// ═══════════════════════════════════════════════════════════════════
// 配额发还：探针死于"敲错门"时不该吃掉整个窗口
// ═══════════════════════════════════════════════════════════════════

describe("S5 释放侧：探针失败后的配额归属", () => {
  test("🔴 探针死于 401（与配额窗口无关）→ 配额被发还，下一路还能探", async () => {
    const availability = new ModelAvailabilityService();
    availability.markRateLimited("m1", 10_000, "429", "rate_limit");
    const { fb } = fastFallback({ availability });
    // 401 是 Terminal(auth_failed)：它对"限流窗口过了没有"一个字都没回答。
    const { provider } = makeProvider(
      errStream("401 invalid api key", "authentication_error", 401),
    );

    await drain(fb, provider);

    // 若这里是 true，一次无关的认证故障就把整个冷却窗口唯一的探针机会白吃掉了。
    // 注意 401 会 markTerminal，但冷却记录与 states 是两张正交的表（availability.ts
    // 的 S2 段注释），冷却仍在 → 配额语义仍然有意义。
    expect(availability.isCooldownProbeConsumed("m1")).toBe(false);
  }, 15_000);

  test("🔴 成对：探针又撞 429（确实还没恢复）→ 配额留在消耗态", async () => {
    const availability = new ModelAvailabilityService();
    availability.markRateLimited("m1", 10_000, "429", "rate_limit");
    const { fb } = fastFallback({ availability, maxRetries: 0 });
    const { provider } = makeProvider(
      errStream("rate limit exceeded", "rate_limit_error", 429, 600),
    );

    await drain(fb, provider);

    // 这条是上一条的反向门禁：只钉"会发还"的话，把 release 写成无条件调用
    // 也能让上面那条绿——而那等于每路都能探一发，配额形同虚设。
    expect(availability.isCooldownProbeConsumed("m1")).toBe(true);
  }, 15_000);
});

// ═══════════════════════════════════════════════════════════════════
// 负向：开关、零开销、不越权
// ═══════════════════════════════════════════════════════════════════

describe("S5 负向门禁", () => {
  test("allowCooldownProbe=false → 退回纯 S2 语义（老实等冷却，无探针事件）", async () => {
    const availability = new ModelAvailabilityService();
    availability.markRateLimited("m1", 600, "429", "rate_limit");
    const { fb, events } = fastFallback({ availability, allowCooldownProbe: false });
    const { provider } = makeProvider(okStream);

    await drain(fb, provider);

    expect(events.filter((e) => e.type === "cooldown_probe").length).toBe(0);
    // 关掉探针不该顺手把 S2 也关了——它只是慢，不是不工作。
    expect(events.filter((e) => e.type === "shared_cooldown_wait").length).toBe(1);
  }, 15_000);

  test("respectSharedCooldown=false → 整段冷却逻辑不执行，探针无从发生", async () => {
    const availability = new ModelAvailabilityService();
    availability.markRateLimited("m1", 600, "429", "rate_limit");
    const { fb, events } = fastFallback({ availability, respectSharedCooldown: false });
    const { provider } = makeProvider(okStream);

    await drain(fb, provider);

    expect(events.filter((e) => e.type === "cooldown_probe").length).toBe(0);
    expect(events.filter((e) => e.type === "cooldown_probe_denied").length).toBe(0);
  }, 15_000);

  test("🔴 无限流时零开销：不查配额、不记任何探针事件、行为逐字节不变", async () => {
    const { fb, events, availability } = fastFallback();
    const { provider, counts } = makeProvider(okStream);

    const out = await drain(fb, provider);

    expect(textOf(out)).toBe("ok");
    expect(counts.stream).toBe(1);
    // 这条钉的是"S5 不给正常路径添任何东西"——正常路径是 99.9% 的流量，
    // 在它上面加开销换一个限流边缘场景的收益是净负。
    expect(events.filter((e) => e.type.startsWith("cooldown_probe")).length).toBe(0);
    expect(availability.isCooldownProbeConsumed("m1")).toBe(false);
  }, 15_000);

  test("不该探的成因（lock_timeout 冷却）→ denied(cause_not_probeable) 且照旧等", async () => {
    const availability = new ModelAvailabilityService();
    availability.markRateLimited("m1", 600, "409 锁竞争", "lock_timeout");
    const { fb, events } = fastFallback({ availability });
    const { provider } = makeProvider(okStream);

    await drain(fb, provider);

    const denied = events.filter((e) => e.type === "cooldown_probe_denied");
    expect(denied.length).toBe(1);
    expect(denied[0].probeDecision).toBe("cause_not_probeable");
    expect(events.filter((e) => e.type === "shared_cooldown_wait").length).toBe(1);
  }, 15_000);

  test("🔴 cause 缺省的冷却（老调用点）→ 一律不探（fail-closed，端到端）", async () => {
    const availability = new ModelAvailabilityService();
    availability.markRateLimited("m1", 600, "429"); // 不传 cause
    const { fb, events } = fastFallback({ availability });
    const { provider } = makeProvider(okStream);

    await drain(fb, provider);

    expect(events.filter((e) => e.type === "cooldown_probe").length).toBe(0);
    expect(events.filter((e) => e.type === "shared_cooldown_wait").length).toBe(1);
  }, 15_000);
});
