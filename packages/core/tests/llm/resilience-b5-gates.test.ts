/**
 * B5 归因与门槛修正 —— 硬门槛断言
 *
 * 对应 `docs/bugfixes/todo/20260801-韧性层架构对齐CC-子代理韧性能力根治方案.md` 的 B5 批次。
 * 本文件只钉「修正是否真的生效」，不重复 errors.test.ts / fallback.test.ts 的既有行为覆盖。
 *
 * B5 的七项都在消除"排查时被误导"，所以每条断言都成对写：**既钉修好的方向，
 * 也钉没被顺手放宽的方向**。只钉前者的话，"把门槛全放开"也能让测试变绿——
 * 而那正是本方案 §5 缺口 6 明确否决的修法（会把主路径的缺陷扩散过去）。
 *
 * 七项与门槛：
 *   B5-1 model_context_window_exceeded 补分支  → 见 tests/agent/（需 loop 夹具，在那侧钉）
 *   B5-2 截断类错误归 network_error           → 附录 A1 四条 + 负向（代码 bug 归 local_fault）
 *   B5-3 x-should-retry: false 可区分         → 三态 + 不越权覆盖更精确的错误族归因
 *
 * 2026-10-08 起 `classifyError` / `TerminalError` 已删除，B5-2/B5-3 改用
 * `normalizeThrown` + `classifyFamily` + `decideRecovery` 表达同一组能力。
 *   B5-4 retryAttempts 透出                   → 见 tests/agent/
 *   B5-5 frontmatter timeout 钳制             → 见 tests/agent/
 *   B5-6 maxTokens 定性                       → 常量存在且 ≤ 注册表最小上限
 *   B5-7 401 真刷新钩子                       → 刷新成功/失败/未注入三条路径
 *
 * fix_type: regression_guard
 */

import { describe, test, expect } from "bun:test";
import { parseXShouldRetry } from "@sid-code/core/llm/errors.ts";
import { classifyFamily, normalizeThrown } from "@sid-code/core/llm/error-normalize.ts";
import { decideRecovery, type RecoveryAction } from "@sid-code/core/llm/recovery-policy.ts";
import { ModelFallback } from "@sid-code/core/llm/fallback.ts";
import { ModelAvailabilityService } from "@sid-code/core/llm/availability.ts";
import { ERROR_USER_MESSAGES } from "@sid-code/core/llm/error-messages.ts";
import { SUBAGENT_DEFAULT_MAX_TOKENS } from "@sid-code/core/agent/agentic-loop.ts";
import type { RetryTelemetryEvent } from "@sid-code/core/llm/retry-telemetry.ts";
import type { Provider } from "@sid-code/core/llm/provider.ts";
import type { SendParams, StreamEvent } from "@sid-code/core/llm/types.ts";

const BASE_PARAMS: SendParams = {
  model: "primary-model",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  maxTokens: 100,
};

const OK_EVENTS: StreamEvent[] = [
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } },
  {
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
    usage: { inputTokens: 1, outputTokens: 1 },
  },
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
    retryBackoffBaseMs: 0,
    retryBackoffMaxMs: 0,
    streamTimeoutMs: 5000,
    ...extra,
  };
}

/** 首次失败时的决策（空历史、充足预算、零退避）。只用来看「放不放弃、为什么」。 */
function firstDecision(err: unknown): RecoveryAction {
  return decideRecovery(
    normalizeThrown(err),
    {
      attempts: [],
      totalRetries: 0,
      consecutive529: 0,
      degradeTried: false,
      startedAt: Date.now(),
    },
    {
      callerMaxRetries: 5,
      maxRetriesPerCall: 10,
      persistent: false,
      retry529: true,
      backoffBaseMs: 0,
      backoff: () => 0,
    },
  );
}

/** 构造带 status / headers 的错误（模拟 SDK 抛出的形状）。 */
function httpError(status: number, headers?: Record<string, string>, message?: string): Error {
  const e = new Error(message ?? `${status} boom`) as Error & {
    status?: number;
    headers?: Record<string, string>;
  };
  e.status = status;
  if (headers) e.headers = headers;
  return e;
}

// ══════════════════════════════════════════════════════════════════════
// B5-2：截断类错误归 network_error
// ══════════════════════════════════════════════════════════════════════

describe("B5-2 门槛：截断类错误归到 network_error（附录 A1）", () => {
  // 附录 A1 的原始输入。改造前前两条落"裸 Error → 不重试"，
  // 于是流被中途截断时子代理直接放弃，而这恰恰是最该重试的一类故障。
  test.each([
    "unexpected end of JSON input",
    "Unexpected end of JSON input", // 大小写变体：真实文案首字母大写
    "Premature close",
    "socket hang up",
    "terminated",
    "incomplete chunked encoding",
  ])("%s → transient/network_error（已识别）", (message) => {
    const v = classifyFamily(normalizeThrown(new Error(message)));
    expect(v.family).toBe("transient");
    expect(v.reason).toBe("network_error");
    expect(v.recognized).toBe(true);
  });

  // ── 负向门槛：代码 bug 不得被当成网络错误打满退避 ──
  //
  // 2026-10-08 有意语义变更：旧断言是「TypeError / 无关 Error 不可重试」（零重试）。
  // 现在没有零重试族：TypeError/ReferenceError 归 local_fault（不退避、2 次即放弃，快速暴露），
  // 认不出的裸 Error 进 transient 未识别子集（同指纹 3 次封顶）。守的能力不变：
  // 代码 bug 不会被识别成 network_error、不会按网络错误的退避节奏重试满次。
  test.each([
    ["TypeError", new TypeError("x is not a function")],
    ["ReferenceError", new ReferenceError("y is not defined")],
  ])("%s → local_fault（不是 network_error）", (_label, err) => {
    const v = classifyFamily(normalizeThrown(err));
    expect(v.family).toBe("local_fault");
    expect(v.reason).not.toBe("network_error");
  });

  test("无关 Error → transient 未识别子集（受同指纹封顶，不冒充已识别的网络错误）", () => {
    const v = classifyFamily(normalizeThrown(new Error("something entirely unrelated")));
    expect(v.family).toBe("transient");
    expect(v.recognized).toBe(false);
    expect(v.reason).not.toBe("network_error");
  });
});

// ══════════════════════════════════════════════════════════════════════
// B5-3：x-should-retry 三态可区分
// ══════════════════════════════════════════════════════════════════════

describe("B5-3 门槛：x-should-retry 三态可区分（§五之二 漏斗-3）", () => {
  test("header 不存在 → undefined（不是 false）", () => {
    // 这是整条修正的核心：改造前"服务端说别重试"和"服务端没表态"压成同一个
    // false，二者不可区分，于是只有"该重试"那一半被消费。
    expect(parseXShouldRetry(httpError(500))).toBeUndefined();
    expect(parseXShouldRetry(new Error("no headers at all"))).toBeUndefined();
  });

  test("显式 true / false 各自可辨", () => {
    expect(parseXShouldRetry(httpError(500, { "x-should-retry": "true" }))).toBe(true);
    expect(parseXShouldRetry(httpError(500, { "x-should-retry": "false" }))).toBe(false);
    // 常见等价写法也要认，否则网关用 "0" 表达拒绝时我们照旧打满退避。
    expect(parseXShouldRetry(httpError(500, { "x-should-retry": "1" }))).toBe(true);
    expect(parseXShouldRetry(httpError(500, { "x-should-retry": "0" }))).toBe(false);
  });

  test("值畸形 → undefined（不臆测成拒绝）", () => {
    // 判成 false 会让一个拼错的 header 值把可重试错误变成单次放弃，
    // 比忽略它更糟 —— 故意钉住"畸形值不表态"。
    expect(parseXShouldRetry(httpError(500, { "x-should-retry": "maybe" }))).toBeUndefined();
  });

  test.each([500, 529, 429])("%i + false → 首次即放弃（server_declined，I1-例外）", (status) => {
    // 2026-10-08：TerminalError("server_declined_retry") 改为 decideRecovery 的 give_up/server_declined。
    // 能力不变：服务端结构化拒绝重试时不打满退避。
    const a = firstDecision(httpError(status, { "x-should-retry": "false" }));
    expect(a.kind).toBe("give_up");
    if (a.kind === "give_up") expect(a.evidence.reason).toBe("server_declined");
  });

  test.each([500, 529, 429])("%i 无 header → 仍重试（没有误伤正常重试路径）", (status) => {
    expect(firstDecision(httpError(status)).kind).toBe("retry");
  });

  // ── 放置门槛：false 不得越权盖掉更精确的归因 ──
  //
  // 401/404/400 给出的 auth_failed / model_not_found / invalid_request 是用户能照着
  // 动手修的信息。false 只决定「放弃」，不得把错误族与细分原因糊成别的东西。
  test.each([
    [401, "auth_suspect", "auth_failed"],
    [404, "request_suspect", "model_not_found"],
    [400, "request_suspect", "invalid_request"],
  ] as const)("%i + false → 保留 family=%s reason=%s", (status, family, reason) => {
    const a = firstDecision(httpError(status, { "x-should-retry": "false" }));
    expect(a.kind).toBe("give_up");
    if (a.kind === "give_up") {
      expect(a.evidence.reason).toBe("server_declined");
      expect(a.evidence.family).toBe(family);
      expect(a.verdict.reason).toBe(reason);
    }
  });

  test("新 reason 有配套用户文案（不落到未知错误码的兜底）", () => {
    const msg = ERROR_USER_MESSAGES["server_declined_retry"];
    expect(msg).toBeDefined();
    expect(msg.title.length).toBeGreaterThan(0);
    expect(msg.suggestion.length).toBeGreaterThan(0);
  });
});

// ══════════════════════════════════════════════════════════════════════
// B5-6：maxTokens 魔数定性
// ══════════════════════════════════════════════════════════════════════

describe("B5-6 门槛：子代理 maxTokens 已具名且有依据", () => {
  test("常量已导出（不再是两处裸 4096）", () => {
    expect(SUBAGENT_DEFAULT_MAX_TOKENS).toBe(4096);
  });

  test("不超过内置注册表任何模型的输出上限", async () => {
    // 这是"4096 安全"这句论断的可执行版本：注册表非零 maxOutputTokens 的最小值
    // 恰好是 4096。若日后接入一个上限更低的模型，本断言会红 —— 那时就该改成
    // 按模型解析，而不是继续用固定值撞 400 max_tokens out of range。
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("packages/core/src/llm/model-registry.ts", "utf-8");
    const ceilings = [...src.matchAll(/maxOutputTokens:\s*([0-9_]+)/g)]
      .map((m) => parseInt(m[1].replace(/_/g, ""), 10))
      .filter((n) => n > 0);
    expect(ceilings.length).toBeGreaterThan(0);
    expect(Math.min(...ceilings)).toBeGreaterThanOrEqual(SUBAGENT_DEFAULT_MAX_TOKENS);
  });
});

// ══════════════════════════════════════════════════════════════════════
// B5-7：401 真刷新凭据钩子
// ══════════════════════════════════════════════════════════════════════

describe("B5-7 门槛：401 凭据刷新钩子（§5 新发现 3）", () => {
  /** 首个 401 后成功的 provider。calls 用于断言"重试了一次"。 */
  function make401ThenOk() {
    const state = { calls: 0 };
    const provider: Provider = {
      name: () => "mock-provider",
      async *sendMessageStream(): AsyncIterable<StreamEvent> {
        state.calls++;
        if (state.calls === 1) throw httpError(401, undefined, "401 Unauthorized");
        for (const e of OK_EVENTS) yield e;
      },
    };
    return { state, provider };
  }

  test("钩子被调用，且拿到 provider 名与原始错误", async () => {
    const { provider } = make401ThenOk();
    const seen: Array<{ provider: string; status: unknown }> = [];
    const fallback = new ModelFallback(
      fastConfig({
        onAuthRefresh: async (p: string, err: unknown) => {
          seen.push({ provider: p, status: (err as { status?: number }).status });
          return true;
        },
      }),
    );

    await collect(fallback.executeWithFallback(provider, BASE_PARAMS));

    expect(seen).toHaveLength(1);
    // provider 名必须真实传入：多 provider 下这是"该刷哪套凭据"的唯一依据。
    expect(seen[0].provider).toBe("mock-provider");
    // 原始错误必须透传：实现方要靠它区分 OAuth revoked / 普通过期等子类型。
    expect(seen[0].status).toBe(401);
  });

  test("刷新成功 → 重试一次并成功，模型未被拉黑", async () => {
    const { state, provider } = make401ThenOk();
    const availability = new ModelAvailabilityService();
    const fallback = new ModelFallback(
      fastConfig({ availability, onAuthRefresh: async () => true }),
    );

    const events = await collect(fallback.executeWithFallback(provider, BASE_PARAMS));

    expect(state.calls).toBe(2);
    expect(events.some((e) => e.type === "message_stop")).toBe(true);
    // 记嫌疑是错误归因（模型是好的、凭据过期了）：自愈的调用不留放弃证据。
    expect(availability.isSuspect("primary-model")).toBe(false);
  });

  test("刷新失败 → 退化为旧凭据重试一次（行为与未接线时一致）", async () => {
    const { state, provider } = make401ThenOk();
    const fallback = new ModelFallback(fastConfig({ onAuthRefresh: async () => false }));

    await collect(fallback.executeWithFallback(provider, BASE_PARAMS));

    // 关键：返回 false 不等于"放弃"，仍用旧凭据立即重试。
    // 若实现写成"刷新失败就直接放弃"，401 会比改造前更容易丢掉整次调用。
    expect(state.calls).toBe(2);
  });

  test("钩子抛异常 → 不上抛、不中断，仍重试一次", async () => {
    const { state, provider } = make401ThenOk();
    const fallback = new ModelFallback(
      fastConfig({
        onAuthRefresh: async () => {
          throw new Error("refresh endpoint unreachable");
        },
      }),
    );

    // 刷新失败是预期内结果（refresh token 也过期了 / 端点不可达），不是 bug。
    const events = await collect(fallback.executeWithFallback(provider, BASE_PARAMS));
    expect(state.calls).toBe(2);
    expect(events.some((e) => e.type === "message_stop")).toBe(true);
  });

  test("未注入钩子 → 行为与改造前逐字节一致（接线安全底线）", async () => {
    const { state, provider } = make401ThenOk();
    const fallback = new ModelFallback(fastConfig());

    const events = await collect(fallback.executeWithFallback(provider, BASE_PARAMS));

    expect(state.calls).toBe(2);
    expect(events.some((e) => e.type === "message_stop")).toBe(true);
  });

  test("遥测区分「真刷新过」与「只是重试一次」", async () => {
    // 缺了 authRefreshed 字段，两种语义在遥测里完全同形，于是"401 之后到底刷新了没有"
    // 无法回答 —— 而这正是 §5 新发现 3 的核心（闸门看着像刷新触发器，实际不是）。
    async function authEventFor(hook?: () => Promise<boolean>) {
      const { provider } = make401ThenOk();
      const events: RetryTelemetryEvent[] = [];
      const fallback = new ModelFallback(
        fastConfig({
          onTelemetry: (e: RetryTelemetryEvent) => events.push(e),
          ...(hook ? { onAuthRefresh: hook } : {}),
        }),
      );
      await collect(fallback.executeWithFallback(provider, BASE_PARAMS));
      return events.find((e) => e.type === "auth_refresh");
    }

    const refreshed = await authEventFor(async () => true);
    expect(refreshed?.authRefreshed).toBe(true);
    expect(refreshed?.provider).toBe("mock-provider");

    const notRefreshed = await authEventFor(async () => false);
    expect(notRefreshed?.authRefreshed).toBe(false);

    const noHook = await authEventFor();
    expect(noHook?.authRefreshed).toBe(false);
  });

  test("同指纹 401 只在首次刷新（防无限刷新循环）", async () => {
    // 2026-10-08：retry-once 闸门已删，401 同指纹最多 3 次；但凭据刷新只在 streak===1 时触发
    // （recovery-policy.ts），后两次走退避而非再刷新。
    // 注意断言的是"刷新只发生一次"，而非"重试只发生一次"。
    let calls = 0;
    let refreshCalls = 0;
    const provider: Provider = {
      name: () => "mock-provider",
      async *sendMessageStream(): AsyncIterable<StreamEvent> {
        calls++;
        throw httpError(401, undefined, "401 Unauthorized");
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
        onAuthRefresh: async () => {
          refreshCalls++;
          return true;
        },
      }),
    );

    await collect(fallback.executeWithFallback(provider, BASE_PARAMS));

    expect(refreshCalls).toBe(1);
    // 2026-10-08 有意语义变更：旧行为第 2 个 401 即 terminal（calls===2），现在同指纹 3 次后放弃。
    expect(calls).toBe(3);
  });
});
