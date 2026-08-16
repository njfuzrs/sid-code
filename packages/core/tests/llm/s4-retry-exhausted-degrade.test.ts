/**
 * S4 非流式降级 —— **重试耗尽**路径的覆盖（2026-08-17）。
 *
 * ── 这个空白是怎么被发现的 ──
 *
 * 追查「11 类遥测事件零触发」时，我怀疑 `non_streaming_degrade` 恒零是因为 S4 的
 * transportish 白名单认 `timeout`，而重开成因里出现的是 `fallback_stream_timeout`
 * ——两者对不上，降级永不触发。
 *
 * **写探针验证后这个假设被推翻了**：两条路径上 S4 都正常降级。判据侧读的是
 * `ctx.lastRetryReason`（来自 `RetryableError.reason`），`fallback.ts` 把超时 abort
 * 明确构造成 `new RetryableError(..., "timeout")`；而 `fallback_stream_timeout` 只出现在
 * `reopenReason`（上报字段，取自 stream-observer 快照）。**两个字段从不交汇**，
 * 我把上报值当成了判据值。
 *
 * 真实成因是「最近没出那么严重的故障」：生产上界 `maxTimeoutRetries=10` /
 * `maxRetriesPerCall=12`，而实测 10 次 retry 里 9 次是 `attempt=1`、1 次 `attempt=2`
 * —— 重试从未接近耗尽，所以循环出口后的那个 S4 调用点一次都没到达过。
 *
 * ── 但探针暴露了一个真空白，这才是本文件存在的理由 ──
 *
 * `tryNonStreamingDegrade` 有**两个**调用点，语义不同：
 *
 * | 调用点 | 触发条件 | 既有覆盖 |
 * | --- | --- | --- |
 * | `fallback.ts:1213` fail-fast 分支 | 错误无法分类为可重试（空响应等），**一次都不重试** | ✅ `resilience-b6-gates.test.ts` 6 个用例 |
 * | `fallback.ts:1497` 循环出口 | 可重试错误**重试到耗尽** | ❌ **零覆盖** |
 *
 * 既有 6 个 S4 用例全部走前者（空响应 / 429 / 529 / TypeError / 开关关），
 * 没有一个让重试真正跑到耗尽。而后者恰恰是注释里写着「调用时机：流式阶段重试预算耗尽、
 * 即将转 tryFallback 之前」的那个主路径 —— 它的正确性此前只靠读代码保证。
 *
 * 这正是 `resilience-b6-gates.test.ts` 开头那条纪律要防的形态（**能力已实现 ≠ 能力已生效**），
 * 而它自己在这个调用点上留了一个口子：S4 首版就是因为「只接在重试耗尽之后」而实测零调用，
 * 修复时补上了 fail-fast 分支并为它写了断言，**却没有为原来那个调用点补断言**。
 * 于是两个调用点里，先坏过的那个有网，另一个没有。
 *
 * ── 按 B5 成对纪律写 ──
 *
 * 每条正向断言（降级真的发生）都配一条负向（不该降级时别降级）。只钉前者的话，
 * 「把门槛全放开」也能让测试变绿 —— 而白烧一次配额的代价是真实的。
 *
 * fix_type: regression_guard
 */

import { describe, test, expect } from "bun:test";
import { ModelFallback } from "@sid-code/core/llm/fallback.ts";
import { ModelAvailabilityService } from "@sid-code/core/llm/availability.ts";
import type { RetryTelemetryEvent } from "@sid-code/core/llm/retry-telemetry.ts";
import type { SendParams, StreamEvent } from "@sid-code/core/llm/types.ts";

const PARAMS = { model: "m1", messages: [], maxTokens: 500 } as unknown as SendParams;

const NON_STREAM_OK = {
  content: [{ type: "text", text: "来自非流式" }],
  usage: { inputTokens: 1, outputTokens: 2 },
  stopReason: "end_turn",
};

interface Probe {
  provider: any;
  counts: { stream: number; nonStream: number };
}

/**
 * 每次建流都抛 `ECONNRESET` —— 归类为 `RetryableError("network_error")`，
 * 于是走**重试**路径直到耗尽（不是 fail-fast）。
 */
function alwaysConnReset(withNonStream = true): Probe {
  const counts = { stream: 0, nonStream: 0 };
  const provider: any = {
    name: () => "openai",
    sendMessageStream: async function* (): AsyncGenerator<StreamEvent> {
      counts.stream++;
      const e: any = new Error("socket hang up");
      e.code = "ECONNRESET";
      throw e;
    },
  };
  if (withNonStream) {
    provider.sendMessageNonStreaming = async () => {
      counts.nonStream++;
      return NON_STREAM_OK;
    };
  }
  return { provider, counts };
}

/**
 * 永久静默流：出了响应头但一个事件都不来，只能被 abort 打断。
 * 这是 fallback 自己的 `streamTimeoutMs` 看门狗要治的形态（真实轨迹里
 * `fallback_stream_timeout` 触发过 7 次的那一类），归类为 `RetryableError("timeout")`。
 */
function silentStream(): Probe {
  const counts = { stream: 0, nonStream: 0 };
  const provider: any = {
    name: () => "openai",
    sendMessageStream: function (_p: unknown, signal?: AbortSignal): AsyncGenerator<StreamEvent> {
      counts.stream++;
      return (async function* () {
        await new Promise<void>((_resolve, reject) => {
          if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
          // 永不自行 resolve：只能被看门狗 abort 打断，模拟"连接活着但没数据"
          signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        });
        yield { type: "message_stop" } as unknown as StreamEvent;
      })();
    },
    sendMessageNonStreaming: async () => {
      counts.nonStream++;
      return NON_STREAM_OK;
    },
  };
  return { provider, counts };
}

/** 限流流：429 → `RetryableError("rate_limit")`，同样走重试到耗尽，但**不该**降级。 */
function alwaysRateLimited(): Probe {
  const counts = { stream: 0, nonStream: 0 };
  const provider: any = {
    name: () => "openai",
    sendMessageStream: function (): AsyncGenerator<StreamEvent> {
      counts.stream++;
      return (async function* () {
        yield {
          type: "error",
          error: {
            message: "rate limit exceeded",
            type: "rate_limit_error",
            statusCode: 429,
            streamLevel: true,
          },
        } as unknown as StreamEvent;
      })();
    },
    sendMessageNonStreaming: async () => {
      counts.nonStream++;
      return NON_STREAM_OK;
    },
  };
  return { provider, counts };
}

function makeFallback(extra: Record<string, unknown> = {}) {
  const events: RetryTelemetryEvent[] = [];
  const fb = new ModelFallback({
    availability: new ModelAvailabilityService(),
    retryBackoffBaseMs: 1,
    retryBackoffMaxMs: 3,
    // 1 = 首次 + 1 次重试后耗尽。刻意取小值：本文件测的是"耗尽之后发生什么"，
    // 把上界调到生产的 10 只会让每个用例多睡几轮退避，不改变被测语义。
    maxRetries: 1,
    streamTimeoutMs: 30_000,
    onTelemetry: (e) => events.push(e),
    ...extra,
  });
  return { fb, events };
}

async function drain(fb: ModelFallback, provider: any): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  try {
    for await (const e of fb.executeWithFallback(provider, PARAMS, undefined, {
      querySource: "agent:builtin",
      switchMode: "auto",
    } as any)) {
      out.push(e);
    }
  } catch {
    /* 断言只看副作用，不看抛不抛 */
  }
  return out;
}

const textOf = (evts: StreamEvent[]) =>
  evts
    .filter((e) => e.type === "content_block_delta")
    .map((e) => (e as any).delta.text)
    .join("");

const typesOf = (evts: RetryTelemetryEvent[]) => evts.map((e) => e.type);

describe("S4 · 重试耗尽路径（fallback.ts:1497）—— 此前零覆盖", () => {
  test("network_error 重试到耗尽 → 降级到非流式并产出内容", async () => {
    const { fb, events } = makeFallback();
    const { provider, counts } = alwaysConnReset();

    const out = await drain(fb, provider);

    // 三条一起才叫"生效"：真的重试过、非流式真的被调用、内容真的流出来了。
    // 只断言最后一条的话，fail-fast 分支（既有用例覆盖的那个）也能让它变绿。
    expect(counts.stream).toBeGreaterThan(1);
    expect(counts.nonStream).toBe(1);
    expect(textOf(out)).toBe("来自非流式");
    // 遥测必须落地：能力生效但不可观测，等于回到"11 类零触发"那个分诊要解决的状态。
    expect(typesOf(events)).toContain("retry");
    expect(typesOf(events)).toContain("non_streaming_degrade");
  });

  test("流超时（看门狗开火）重试到耗尽 → 同样降级", async () => {
    // 与上一个用例的区别：这条走的是 fallback 自己的 streamTimeoutMs 看门狗，
    // classified 是 RetryableError("timeout") 而非 "network_error"。
    // 两者都在 transportish 白名单里，但来源不同 —— 分开钉，否则改错一个不会红。
    const { fb, events } = makeFallback({ streamTimeoutMs: 80 });
    const { provider, counts } = silentStream();

    const out = await drain(fb, provider);

    expect(counts.stream).toBeGreaterThan(1);
    expect(counts.nonStream).toBe(1);
    expect(textOf(out)).toBe("来自非流式");
    expect(typesOf(events)).toContain("non_streaming_degrade");
  });

  test("判据取 lastRetryReason（RetryableError.reason），不是上报用的 reopenReason", async () => {
    // 这条钉住我追查时踩的那个混淆：`reopenReason` 可能是 `fallback_stream_timeout`
    // （取自 stream-observer 快照，是**上报**字段），而 S4 判的是 `ctx.lastRetryReason`
    // （取自 `RetryableError.reason`，白名单里是 `timeout`）。若将来有人"统一"这两个字段、
    // 把 reopenReason 的值喂给 S4 判据，`fallback_stream_timeout` 不在白名单 → 降级静默失效。
    const { fb, events } = makeFallback({ streamTimeoutMs: 80 });
    const { provider } = silentStream();

    await drain(fb, provider);

    const retries = events.filter((e) => e.type === "retry") as any[];
    expect(retries.length).toBeGreaterThan(0);
    // 上报侧是超时层名或 classified.reason —— 无论哪个，降级都得发生（见上一条断言）。
    expect(retries[0].reopenReason).toBeTruthy();
    // 而降级确实发生了：证明判据没有被上报字段带偏。
    expect(typesOf(events)).toContain("non_streaming_degrade");
  });

  test("负向：429 重试到耗尽**不**降级（换传输方式一样被限，白烧一次配额）", async () => {
    // 与既有用例的区别：既有那条 429 用例走 fail-fast 分支（不重试），
    // 这条走**重试到耗尽**。同一个门槛在两个调用点上都必须成立。
    const { fb, events } = makeFallback();
    const { provider, counts } = alwaysRateLimited();

    await drain(fb, provider);

    expect(counts.stream).toBeGreaterThan(1); // 确认真的走了重试路径
    expect(counts.nonStream).toBe(0);
    expect(typesOf(events)).not.toContain("non_streaming_degrade");
  });

  test("负向：provider 无非流式能力 → 不崩，且抛出的必须是真 Error", async () => {
    // 直接 `throw transportError` 在某些路径上会抛 undefined —— 上游一切按
    // err.message 取值的代码全拿到 undefined，比不降级更难排查。
    const { fb } = makeFallback();
    const { provider, counts } = alwaysConnReset(false); // 不给 sendMessageNonStreaming

    let caught: unknown;
    try {
      for await (const _ of fb.executeWithFallback(provider, PARAMS, undefined, {
        querySource: "agent:builtin",
        switchMode: "auto",
      } as any)) {
        /* drain */
      }
    } catch (e) {
      caught = e;
    }

    expect(counts.nonStream).toBe(0);
    if (caught !== undefined) {
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toBeTruthy();
    }
  });

  test("负向：开关可关 —— allowNonStreamingFallback=false 时耗尽也不降级", async () => {
    const { fb, events } = makeFallback({ allowNonStreamingFallback: false });
    const { provider, counts } = alwaysConnReset();

    await drain(fb, provider);

    expect(counts.stream).toBeGreaterThan(1);
    expect(counts.nonStream).toBe(0);
    expect(typesOf(events)).not.toContain("non_streaming_degrade");
  });
});

// ═══════════════════════════════════════════════════════════════════
// 流内 error 事件路径 —— 上面那组用例反过来逼出来的真缺陷
// ═══════════════════════════════════════════════════════════════════
//
// 怎么发现的：给上面那组做变异自证时，把 S4 的 transportish 门槛整个放开
// （`if (false && !transportish) return`），预期负向 429 用例会转红 —— **它没红**。
// 顺着查下去发现 429 根本没走到 S4：流内 `error` 事件分支重试耗尽后**直接**
// `tryFallback`，完整绕过非流式降级（`fallback.ts` 的 `if (attempt < streamMaxRetries)`
// 之后那个出口）。
//
// 于是同一个错误，**形态不同则命运不同**：
//
// | 到达形态 | 走的路径 | 修复前是否降级 |
// | --- | --- | --- |
// | `throw new Error("premature close")` | catch → 循环出口 → S4 | ✅ 降级 |
// | `yield {type:"error", error:{...}}` 同一文案 | error 事件分支 → 直接换模型 | ❌ **绕过** |
//
// 而 S4 存在的理由那类故障（网关回 text/html 错误页）在 `openai.ts` 里恰恰是
// yield 成 `type:"server_error", streamLevel:true` 的**事件** —— 也就是说 S4 最该
// 生效的形态走的正是被绕过的那条路。
//
// 同形的病本文件所在模块已经犯过一次：401 以「HTTP 200 + 流内 error 事件」到达，
// 导致 S5 配额发还在最常见的认证故障上失效。**同一条路径第二次咬人。**
describe("S4 · 流内 error 事件路径（此前完整绕过 S4）", () => {
  /** 流内 error 事件，文案命中 `isStreamingTransportError`。 */
  function streamErrorEvent(msg: string, type = "server_error"): Probe {
    const counts = { stream: 0, nonStream: 0 };
    const provider: any = {
      name: () => "openai",
      sendMessageStream: function (): AsyncGenerator<StreamEvent> {
        counts.stream++;
        return (async function* () {
          yield {
            type: "error",
            error: { message: msg, type, streamLevel: true },
          } as unknown as StreamEvent;
        })();
      },
      sendMessageNonStreaming: async () => {
        counts.nonStream++;
        return NON_STREAM_OK;
      },
    };
    return { provider, counts };
  }

  /** 对照组：同一个错误以 throw 形式抛出（走 catch 路径）。 */
  function thrownError(msg: string): Probe {
    const counts = { stream: 0, nonStream: 0 };
    const provider: any = {
      name: () => "openai",
      sendMessageStream: async function* (): AsyncGenerator<StreamEvent> {
        counts.stream++;
        throw new Error(msg);
      },
      sendMessageNonStreaming: async () => {
        counts.nonStream++;
        return NON_STREAM_OK;
      },
    };
    return { provider, counts };
  }

  test("传输层错误以 error 事件到达 → 现在能降级（本次修复的正向）", async () => {
    // `premature close` 命中 `isStreamingTransportError` 的文案判据 → 在白名单内。
    // 修复前它走 error 事件分支 → 直接换模型，S4 一次都不被咨询。
    const { fb, events } = makeFallback();
    const { provider, counts } = streamErrorEvent("premature close");

    const out = await drain(fb, provider);

    expect(counts.stream).toBeGreaterThan(1);
    expect(counts.nonStream).toBe(1);
    expect(textOf(out)).toBe("来自非流式");
    expect(typesOf(events)).toContain("non_streaming_degrade");
  });

  test("已知边界：网关错误页（server_error）**不**在白名单 —— 记录现状，不是本次修复的目标", async () => {
    // `openai.ts` 的「伪装成功的错误页」分支 yield 的是 `type:"server_error"`，
    // 归类为 `RetryableError("server_error")` —— 而 S4 白名单只有
    // empty_response / network_error / timeout（加文案判据）。所以它到得了 S4，但被门槛挡住。
    //
    // ⚠ 这与 S4 docstring 自称的「兜住网关回 text/html 错误页」**存在口径差**：
    // 到达形态已经修好（本次），但白名单是否该纳入 server_error 是**另一个决定** ——
    // 放进去等于所有 500/502 都会先白烧一次非流式请求，而那类恰恰是「重试/换模型」
    // 该管的。故本次刻意不动，先把现状钉住：将来若有人要放宽，这条会红，
    // 迫使他显式论证「为什么 500 该换传输方式」，而不是顺手改一行白名单。
    const { fb, events } = makeFallback();
    const { provider, counts } = streamErrorEvent(
      "网关返回非流式响应（Content-Type: text/html，HTTP 200），疑似模型/渠道不可用的错误页",
    );

    await drain(fb, provider);

    expect(counts.stream).toBeGreaterThan(1); // 确认真的走到了重试耗尽
    expect(counts.nonStream).toBe(0);
    expect(typesOf(events)).not.toContain("non_streaming_degrade");
  });

  test("形态无关性：同一个错误，throw 与 error 事件的降级行为必须一致", async () => {
    // 这条是本缺陷的**判据本身**，也是最值得长期留着的一条：
    // 它不关心「降级了几次」这个绝对值，只钉住两条路径**不许分叉**。
    // 将来任何一侧新增门槛/提前 return，这条就会红。
    const viaEvent = streamErrorEvent("premature close");
    const viaThrow = thrownError("premature close");

    await drain(makeFallback().fb, viaEvent.provider);
    await drain(makeFallback().fb, viaThrow.provider);

    expect(viaEvent.counts.nonStream).toBe(viaThrow.counts.nonStream);
    // 且两者都真的降级了（若同为 0 也"一致"，那是把门槛焊死的假绿）。
    expect(viaEvent.counts.nonStream).toBe(1);
  });

  test("负向：流内 429 事件耗尽**仍不**降级（补上这条门槛才真的生效）", async () => {
    // 修复前这条恒绿——因为 429 根本到不了 S4，门槛放开也不会降级。
    // 现在它到得了 S4，这条断言才真正在测「白名单挡住了限流」。
    const { fb, events } = makeFallback();
    const { provider, counts } = alwaysRateLimited();

    await drain(fb, provider);

    expect(counts.stream).toBeGreaterThan(1);
    expect(counts.nonStream).toBe(0);
    expect(typesOf(events)).not.toContain("non_streaming_degrade");
  });

  test("负向：流内非传输类错误（内容过滤）不降级 —— 换传输方式治不了", async () => {
    const { fb, events } = makeFallback();
    const { provider, counts } = streamErrorEvent(
      "content filtered by policy",
      "invalid_request_error",
    );

    await drain(fb, provider);

    expect(counts.nonStream).toBe(0);
    expect(typesOf(events)).not.toContain("non_streaming_degrade");
  });
});
