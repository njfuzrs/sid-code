/**
 * 三层防线 metric（P1 · 防线状态可持续观测）
 *
 * ⚠️ **本文件断言的是"仪表工作"，不是"防线有效"。** 两者别混：
 * `bun scripts/defense-trigger-rate.ts` 实测 50 会话触发率 0.0%，
 * 加了 metric 之后大概率仍是全零。这里能证明的是
 * 「真的触发时，counter 有增量」——即那个零是**被确认的零**，不是仪表坏了的零。
 * 这正是 CLAUDE.md 对"新增防线类改动"的验收要求：不是 build 过 + 单测过，
 * 而是构造一次真实触发、看见增量。
 *
 * 落盘隔离：只 `initTelemetry({ enabled: true })` 且不注册导出器，
 * 断言走内存 `getCompletedMetrics()`，不写 `~/.sid-code/`。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  initTelemetry,
  getTelemetryBus,
  shutdownTelemetry,
} from "@sid-code/core/telemetry/index.ts";
import {
  DEFENSE_TRIGGER_METRIC,
  DEFENSE_TOKENS_METRIC,
  DEFENSE_DURATION_METRIC,
  recordDefenseDuration,
} from "@sid-code/core/telemetry/metrics/defense-metrics.ts";
import { AutoCompactCircuitBreaker } from "@sid-code/core/query/circuit-breaker.ts";
import {
  setPolicyLimits,
  isPolicyAllowed,
  resetPolicyLimits,
} from "@sid-code/core/config/policy-limits.ts";
import { autoCompact, resetCircuitBreaker } from "@sid-code/core/query/auto-compact.ts";
import { Manager as ContextManager } from "@sid-code/core/context/manager.ts";
import type { MetricPoint } from "@sid-code/core/telemetry/types.ts";
import type { Message, StreamEvent } from "@sid-code/core/llm/types.ts";

/**
 * 摘要必失败的 provider —— 让 autoCompact 走 recordFailure 把熔断器打开。
 * 形态照 `tests/query/auto-compact-outcome.test.ts`，不引它的私有桩以免耦合。
 */
const throwingProvider: any = {
  name: () => "mock",
  async *sendMessageStream(): AsyncIterable<StreamEvent> {
    throw new Error("摘要请求失败（模拟）");
  },
};

function buildCtxForCompact(msgCount: number): ContextManager {
  const ctx = new ContextManager({ maxTokens: 100_000 });
  for (let i = 0; i < msgCount; i++) {
    ctx.addMessage({
      role: i % 2 === 0 ? "user" : "assistant",
      content: [{ type: "text", text: `消息 ${i}` }],
    } as Message);
  }
  return ctx;
}

function buildCompactDeps(ctx: ContextManager): any {
  return {
    provider: throwingProvider,
    config: { model: "mock-model", provider: "mock" },
    ctxMgr: ctx,
    hookSystem: {
      firePreCompactEvent: async () => ({ finalOutput: null }),
      firePostCompactEvent: async () => ({ finalOutput: null }),
    },
    getAbortSignal: () => undefined,
    // 必须是 true（默认）：子代理失败刻意不计入全局熔断器，
    // 传 false 就永远打不开熔断，这条测试会静默测不到东西。
    isMainAgent: true,
  };
}

beforeEach(() => {
  initTelemetry({ enabled: true, exporters: [] });
  resetPolicyLimits();
});

afterEach(async () => {
  await shutdownTelemetry();
  resetPolicyLimits();
});

const metricsOf = (name: string): MetricPoint[] =>
  getTelemetryBus()
    .getCompletedMetrics()
    .filter((m) => m.name === name);

const triggers = (layer: string): MetricPoint[] =>
  metricsOf(DEFENSE_TRIGGER_METRIC).filter((m) => m.attributes["sidcode.defense.layer"] === layer);

// ═══════════════════════════════════════════════════════════
// 层 1：autoCompact 熔断器
// ═══════════════════════════════════════════════════════════
describe("compact_breaker 的 metric", () => {
  test("连续失败达阈值 → 记一条 tripped，带 count/threshold", () => {
    const cb = new AutoCompactCircuitBreaker({ failureThreshold: 3 });
    cb.recordFailure();
    cb.recordFailure();
    // 前两次未达阈值，不该有触发记录
    expect(triggers("compact_breaker").length).toBe(0);

    cb.recordFailure();
    const t = triggers("compact_breaker");
    expect(t.length).toBe(1);
    expect(t[0].attributes["sidcode.defense.outcome"]).toBe("tripped");
    expect(t[0].attributes["sidcode.defense.reason"]).toBe("consecutive_failures");
    // count 与 threshold 必须成对：单看 count=3 不知道是否到线
    expect(t[0].attributes["sidcode.defense.count"]).toBe(3);
    expect(t[0].attributes["sidcode.defense.threshold"]).toBe(3);
  });

  test("★ 一次触发只记一次（两条 open 路径互斥，不得双记）", () => {
    const cb = new AutoCompactCircuitBreaker({ failureThreshold: 2 });
    cb.recordFailure();
    cb.recordFailure(); // → tripped
    expect(triggers("compact_breaker").length).toBe(1);

    // 已 open 后继续失败：状态没有变化，不该再记
    // （否则"触发次数"会退化成"失败次数"，两者是不同的问题）
    cb.recordFailure();
    expect(triggers("compact_breaker").length).toBe(1);
  });

  test("half-open 探针失败与连续失败用不同 reason 区分", async () => {
    const cb = new AutoCompactCircuitBreaker({ failureThreshold: 1, recoveryTimeMs: 1 });
    cb.recordFailure(); // → open (consecutive_failures)
    await new Promise((r) => setTimeout(r, 5));
    expect(cb.canExecute()).toBe(true); // → half-open
    cb.recordFailure(); // → open (half_open_probe_failed)

    const reasons = triggers("compact_breaker").map((m) => m.attributes["sidcode.defense.reason"]);
    // 两种健康状况不同：前者"刚开始坏"，后者"还没恢复"
    expect(reasons).toEqual(["consecutive_failures", "half_open_probe_failed"]);
  });

  test("half-open 探针成功 → recovered；closed→closed 不记（否则退化成总调用量）", () => {
    const cb = new AutoCompactCircuitBreaker({ failureThreshold: 1, recoveryTimeMs: 0 });
    cb.recordSuccess();
    cb.recordSuccess();
    expect(triggers("compact_breaker").length).toBe(0);

    cb.recordFailure();
    cb.canExecute(); // → half-open
    cb.recordSuccess(); // → recovered
    const rec = triggers("compact_breaker").filter(
      (m) => m.attributes["sidcode.defense.outcome"] === "recovered",
    );
    expect(rec.length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════
// 层 3：企业策略功能开关
// ═══════════════════════════════════════════════════════════
describe("policy_limits 的 metric", () => {
  test("功能被禁 → isPolicyAllowed 返回 false 且记一条 blocked", () => {
    setPolicyLimits({ mcp: { allowed: false, reason: "企业安全规定" } });

    expect(isPolicyAllowed("mcp")).toBe(false);
    const t = triggers("policy_limits");
    expect(t.length).toBe(1);
    expect(t[0].attributes["sidcode.defense.outcome"]).toBe("blocked");
    expect(t[0].attributes["sidcode.defense.feature"]).toBe("mcp");
    // reason 能透出来，证明 policy.ts 那个类型缺 reason 的缺陷已修
    expect(t[0].attributes["sidcode.defense.reason"]).toBe("企业安全规定");
  });

  test("功能允许 / 未配置 → 不记（只在真拦下时才是一次防线动作）", () => {
    setPolicyLimits({ mcp: { allowed: true } });
    expect(isPolicyAllowed("mcp")).toBe(true);
    expect(isPolicyAllowed("sub_agent")).toBe(true); // 未配置
    expect(triggers("policy_limits").length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════
// 共用信封
// ═══════════════════════════════════════════════════════════
describe("三层共用的 tag 信封", () => {
  test("layer 与 outcome 是必落项，缺失维度不落占位值", () => {
    const cb = new AutoCompactCircuitBreaker({ failureThreshold: 1 });
    cb.recordFailure();

    const [m] = triggers("compact_breaker");
    expect(m.attributes["sidcode.defense.layer"]).toBe("compact_breaker");
    expect(m.attributes["sidcode.defense.outcome"]).toBe("tripped");
    // circuit-breaker 的 recordFailure() 零入参，没有 tool/feature 维度。
    // 落一个 "unknown" 占位会让"这层没这个维度"与"这次取值恰好未知"长得一样。
    expect("sidcode.defense.tool" in m.attributes).toBe(false);
    expect("sidcode.defense.feature" in m.attributes).toBe(false);
  });

  test("duration/tokens 是 histogram 且带分桶（否则导出器会降级成 gauge）", () => {
    recordDefenseDuration("compact_breaker", "tripped", 1500, { reason: "circuit_open" });
    const [d] = metricsOf(DEFENSE_DURATION_METRIC);
    expect(d.type).toBe("histogram");
    expect(d.buckets?.bounds.length).toBeGreaterThan(0);
    expect(d.attributes["sidcode.defense.reason"]).toBe("circuit_open");
  });

  test("负耗时 / 非正 token 不落（那是取数异常，不是真实观测）", () => {
    recordDefenseDuration("compact_breaker", "blocked", -1);
    expect(metricsOf(DEFENSE_DURATION_METRIC).length).toBe(0);
    expect(metricsOf(DEFENSE_TOKENS_METRIC).length).toBe(0);
  });

  /**
   * ★ 这条是**接线断言**，不是行为断言 —— 走真实入口 `autoCompact()`，
   * 不自己调 `recordDefenseDuration`。
   *
   * 为什么必须这么写：上面那条 histogram 形态断言是直接调函数的，
   * 它在「函数导出了、测试覆盖了、但生产零调用点」时**照样全绿**。
   * 本仓踩过这个坑（防线建好了零触发、[[zero-callers-vs-capability-ungated]]），
   * CLAUDE.md 因此要求防线类改动的验收是"真实会话里被触发过"。
   * duration 三层里只有 compact_breaker 这条降级路径有真实可测耗时，
   * 所以这里就构造那一次真实熔断，看三件套是否都有增量。
   */
  test("★ 走真实 autoCompact：熔断降级路径同时产出 trigger/tokens/duration", async () => {
    resetCircuitBreaker();
    try {
      // 先把全局熔断器打到 open：默认阈值下连续失败即触发（isMainAgent 默认 true）
      const ctx = buildCtxForCompact(20);
      for (let i = 0; i < 6; i++) {
        await autoCompact(buildCompactDeps(ctx));
      }

      const blocked = triggers("compact_breaker").filter(
        (m) => m.attributes["sidcode.defense.outcome"] === "blocked",
      );
      expect(blocked.length).toBeGreaterThan(0);
      expect(blocked[0].attributes["sidcode.defense.reason"]).toBe("circuit_open");

      // tokens：被挡下时的上下文规模。>0 才算真观测（恒 0 会被 record 侧丢弃）
      const tokens = metricsOf(DEFENSE_TOKENS_METRIC);
      expect(tokens.length).toBeGreaterThan(0);
      expect(tokens[0].value).toBeGreaterThan(0);

      // duration：降级路径的墙钟。可能取到 0（纯内存操作极快），
      // 所以断言"这条 metric 存在且 layer 对得上"，不断言它 > 0 ——
      // 后者会变成一条依赖机器速度的 flake。
      const durations = metricsOf(DEFENSE_DURATION_METRIC);
      expect(durations.length).toBeGreaterThan(0);
      expect(durations[0].attributes["sidcode.defense.layer"]).toBe("compact_breaker");
      expect(durations[0].type).toBe("histogram");
    } finally {
      resetCircuitBreaker();
    }
  });

  test("遥测关闭时静默丢弃，不抛（可观测性不影响主流程）", async () => {
    await shutdownTelemetry();
    initTelemetry({ enabled: false, exporters: [] });

    const cb = new AutoCompactCircuitBreaker({ failureThreshold: 1 });
    expect(() => cb.recordFailure()).not.toThrow();
    setPolicyLimits({ mcp: { allowed: false } });
    expect(() => isPolicyAllowed("mcp")).not.toThrow();
    expect(metricsOf(DEFENSE_TRIGGER_METRIC).length).toBe(0);
  });
});
