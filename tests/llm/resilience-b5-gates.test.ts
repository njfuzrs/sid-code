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
 *   B5-2 classifyError 收纳截断类错误         → 附录 A1 四条 + 负向（代码 bug 仍不重试）
 *   B5-3 x-should-retry: false 可区分         → 三态 + 不越权覆盖更精确的 terminal 归因
 *   B5-4 retryAttempts 透出                   → 见 tests/agent/
 *   B5-5 frontmatter timeout 钳制             → 见 tests/agent/
 *   B5-6 maxTokens 定性                       → 常量存在且 ≤ 注册表最小上限
 *   B5-7 401 真刷新钩子                       → 刷新成功/失败/未注入三条路径
 *
 * fix_type: regression_guard
 */

import { describe, test, expect } from "bun:test";
import { classifyError, parseXShouldRetry, TerminalError, RetryableError } from "@sid-code/core/llm/errors.ts";
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
// B5-2：classifyError 收纳截断类错误
// ══════════════════════════════════════════════════════════════════════

describe("B5-2 门槛：截断类错误归到 network_error（附录 A1）", () => {
  // 附录 A1 的四条原始输入。改造前前两条落"裸 Error → 不重试"，
  // 于是流被中途截断时子代理直接放弃，而这恰恰是最该重试的一类故障。
  test.each([
    "unexpected end of JSON input",
    "Unexpected end of JSON input", // 大小写变体：真实文案首字母大写
    "Premature close",
    "socket hang up",
    "terminated",
    "incomplete chunked encoding",
  ])("%s → RetryableError/network_error", (message) => {
    const r = classifyError(new Error(message));
    expect(r).toBeInstanceOf(RetryableError);
    expect((r as RetryableError).reason).toBe("network_error");
  });

  // ── 负向门槛：**没有**顺手放宽成"裸 Error 也重试" ──
  //
  // 这条比正向更重要。旧方案的方向是"把子代理门槛放宽到与主路径一致"，
  // 而主路径对裸 Error 也重试 —— 意味着一个 TypeError（我们自己的代码 bug）
  // 会被重试满次、每次退避最长 120s。B5-2 刻意只收纳**明确是截断**的文案，
  // 若哪天有人把这里改成"分类不出来就当网络错误"，本组断言会红。
  test.each([
    ["TypeError", new TypeError("x is not a function")],
    ["ReferenceError", new ReferenceError("y is not defined")],
    ["无关 Error", new Error("something entirely unrelated")],
  ])("%s 仍不可重试（门槛未被放宽）", (_label, err) => {
    const r = classifyError(err);
    expect(r).not.toBeInstanceOf(RetryableError);
    expect(r).not.toBeInstanceOf(TerminalError);
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
    // 判成 false 会让一个拼错的 header 值把可重试错误变成 terminal 拉黑，
    // 比忽略它更糟 —— 故意钉住"畸形值不表态"。
    expect(parseXShouldRetry(httpError(500, { "x-should-retry": "maybe" }))).toBeUndefined();
  });

  test.each([
    [500, "server_error"],
    [529, "overloaded"],
    [429, "rate_limit"],
  ])("%i + false → TerminalError（改造前是 RetryableError/%s，会打满退避）", (status) => {
    const r = classifyError(httpError(status, { "x-should-retry": "false" }));
    expect(r).toBeInstanceOf(TerminalError);
    expect((r as TerminalError).reason).toBe("server_declined_retry");
  });

  test.each([500, 529, 429])("%i 无 header → 仍可重试（没有误伤正常重试路径）", (status) => {
    expect(classifyError(httpError(status))).toBeInstanceOf(RetryableError);
  });

  // ── 放置门槛：false 不得越权盖掉更精确的 terminal 归因 ──
  //
  // 401/404/400 给出的 auth_failed / model_not_found / invalid_request 是用户能照着
  // 动手修的信息；若把 `=== false` 提到终端分支之前，它们会被统一糊成
  // server_declined_retry —— 结论（不重试）没变，但归因精度掉了。本组钉住位置。
  test.each([
    [401, "auth_failed"],
    [404, "model_not_found"],
    [400, "invalid_request"],
  ] as const)("%i + false → 保留更精确的 reason=%s", (status, expectedReason) => {
    const r = classifyError(httpError(status, { "x-should-retry": "false" }));
    expect(r).toBeInstanceOf(TerminalError);
    expect((r as TerminalError).reason).toBe(expectedReason);
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
    // 拉黑是错误归因（模型是好的、凭据过期了），且 terminal 是进程内永久态。
    expect(availability.isAvailable("primary-model").available).toBe(true);
  });

  test("刷新失败 → 退化为旧凭据重试一次（行为与未接线时一致）", async () => {
    const { state, provider } = make401ThenOk();
    const fallback = new ModelFallback(fastConfig({ onAuthRefresh: async () => false }));

    await collect(fallback.executeWithFallback(provider, BASE_PARAMS));

    // 关键：返回 false 不等于"放弃"，仍走原有的 retry-once 语义。
    // 若实现写成"刷新失败就直接 terminal"，401 会比改造前更容易拉黑模型。
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

  test("闸门保留：第二个 401 不再刷新（防无限刷新循环）", async () => {
    // needsAuthRefresh 闸门必须保留 —— 删了会让 401 反复刷新。
    // 注意断言的是"刷新只发生一次"，而非"重试只发生一次"。
    let refreshCalls = 0;
    const provider: Provider = {
      name: () => "mock-provider",
      async *sendMessageStream(): AsyncIterable<StreamEvent> {
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
  });
});
