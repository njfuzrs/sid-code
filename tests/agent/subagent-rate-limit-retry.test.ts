/**
 * R1：子代理 LLM 限流重试 + 指数退避 — 回归测试
 *
 * 真实事故 session 20260730-183103-5e334145：
 *   主代理并行派 6 个 explore 子代理做代码审计 → 网关返回 429 limit_burst_rate →
 *   2 个子代理**立即**失败。轨迹时间线（events.jsonl:543-546）：
 *     10:35:24.586  [LLM:OPENAI] API 错误: 429 limit_burst_rate
 *     10:35:24.587  [AGENT_LOOP] LLM 错误: ... 429
 *     10:35:24.588  SubagentStop status="error"
 *   429 到子代理终止间隔 **1ms**，零重试——而主循环遇同样 429 会重试到成功。
 *
 * 根因：agentic-loop.ts 走 provider.sendMessageStream() 直连，完全绕过 ModelFallback，
 * 而重试/退避逻辑当时只存在于 fallback 内部（grep retry|backoff|attempt 在
 * agentic-loop.ts 零命中）。
 *
 * 关键细节：429 **不是抛异常**，而是以流内 error 事件回来（stream-processor 转成
 * stopReason="error"）。因此只给 catch 分支补重试会完全漏掉真实限流场景——
 * 本测试的场景 1 就是专门钉住这条路径的。
 *
 * fix_type: core_code（L3，测试）
 */

import { describe, test, expect } from "bun:test";
import { runAgentLoop } from "../../src/agent/agentic-loop.ts";
import { Manager as ContextManager } from "../../src/context/manager.ts";
import { Registry as ToolRegistry } from "../../src/tool/registry.ts";
import { LoopDetector } from "../../src/agent/loop-detection.ts";
import type { Provider } from "../../src/llm/provider.ts";
import type { StreamEvent, SendParams } from "../../src/llm/types.ts";

/** 事故现场的真实 429 报文（取自 warn.log:61） */
const REAL_429_BODY =
  'OpenAI API 错误: 429 {"error":{"message":"Request rate increased too quickly. ' +
  'To ensure system stability, please adjust your client logic to scale requests ' +
  'more smoothly over time.","type":"limit_burst_rate","param":"","code":"limit_burst_rate"}}';

/** 流内 error 事件形式的 429（复刻真实路径：provider 不抛异常，而是 yield error 事件） */
async function* rateLimitErrorStream(): AsyncIterable<StreamEvent> {
  yield { type: "message_start", message: { usage: { inputTokens: 10, outputTokens: 0 } } } as any;
  yield { type: "error", error: { message: REAL_429_BODY, type: "limit_burst_rate", statusCode: 429 } } as any;
}

/** 正常完成的流（end_turn + 有文本内容，让子代理循环正常收尾） */
async function* successStream(text: string): AsyncIterable<StreamEvent> {
  yield { type: "message_start", message: { usage: { inputTokens: 10, outputTokens: 0 } } } as any;
  yield { type: "content_block_start", index: 0, content_block: { type: "text" } } as any;
  yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } as any;
  yield { type: "content_block_stop", index: 0 } as any;
  yield { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { outputTokens: 5 } } as any;
}

/** 抛异常形式的 429（另一条失败路径：provider 直接 throw） */
function throwing429(): AsyncIterable<StreamEvent> {
  return (async function* () {
    throw new Error(REAL_429_BODY);
  })();
}

/**
 * 可编程 mock provider：按 scripted 数组逐次返回不同的流，并记录调用次数。
 * 调用次数就是「重试有没有真的发生」的直接证据。
 */
function makeProvider(scripted: Array<() => AsyncIterable<StreamEvent>>) {
  const calls: SendParams[] = [];
  const provider = {
    name: () => "openai",
    sendMessageStream: (params: SendParams) => {
      const idx = calls.length;
      calls.push(params);
      const factory = scripted[Math.min(idx, scripted.length - 1)];
      return factory();
    },
  } as unknown as Provider;
  return { provider, calls };
}

function makeCtxMgr() {
  const ctxMgr = new ContextManager({ maxTokens: 100_000 });
  ctxMgr.setSystemPrompt("你是代码审计核查员");
  ctxMgr.addMessage({
    role: "user",
    content: [{ type: "text", text: "核查以下缺陷在当前代码中是否已落地修复" }],
  });
  return ctxMgr;
}

function baseConfig(provider: Provider, overrides: Record<string, unknown> = {}) {
  return {
    provider,
    model: "ali-deepseek-v4-flash",
    ctxMgr: makeCtxMgr(),
    tools: new ToolRegistry(),
    maxTurns: 5,
    signal: new AbortController().signal,
    loopDetector: new LoopDetector(),
    // 退避基数压到 1ms，让测试跑得快（生产默认 5s 走 network-profile）
    retryBackoffBaseMs: 1,
    ...overrides,
  } as any;
}

describe("R1 — 子代理限流重试（事故 20260730-183103-5e334145）", () => {
  test("场景1：429 以流内 error 事件回来 → 重试而非立即失败（回归核心）", async () => {
    // 复刻事故：第 1 次 429，第 2 次成功。修复前 provider 只会被调用 1 次即失败。
    const { provider, calls } = makeProvider([
      () => rateLimitErrorStream(),
      () => successStream("核查完成：P1-5 已落地"),
    ]);

    const result = await runAgentLoop(baseConfig(provider, { maxStreamRetries: 3 }));

    // 直接证据：provider 被调用 2 次 = 限流后确实重试了
    expect(calls.length).toBe(2);
    expect(result.success).toBe(true);
    expect(result.lastTextOutput).toContain("核查完成");
    expect(result.errorMessage).toBeUndefined();
  });

  test("场景2：429 以抛异常回来 → 同样重试", async () => {
    const { provider, calls } = makeProvider([
      () => throwing429(),
      () => successStream("ok"),
    ]);

    const result = await runAgentLoop(baseConfig(provider, { maxStreamRetries: 3 }));

    expect(calls.length).toBe(2);
    expect(result.success).toBe(true);
  });

  test("场景3：连续 429 直到耗尽重试次数 → 才返回失败，且退避次数符合上限", async () => {
    // 永远 429。maxStreamRetries=2 → 首次 + 2 次重试 = 共 3 次调用
    const { provider, calls } = makeProvider([() => rateLimitErrorStream()]);

    const result = await runAgentLoop(baseConfig(provider, { maxStreamRetries: 2 }));

    expect(calls.length).toBe(3);
    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain("429");
  });

  test("场景4：maxStreamRetries=0 显式关闭重试 → 保持旧的立即失败语义", async () => {
    const { provider, calls } = makeProvider([() => rateLimitErrorStream()]);

    const result = await runAgentLoop(baseConfig(provider, { maxStreamRetries: 0 }));

    expect(calls.length).toBe(1);
    expect(result.success).toBe(false);
  });

  test("场景5：terminal 错误（认证失败）不重试 —— 重试无意义且会放大故障", async () => {
    const authFail = () => (async function* (): AsyncIterable<StreamEvent> {
      yield { type: "message_start", message: { usage: { inputTokens: 1, outputTokens: 0 } } } as any;
      yield {
        type: "error",
        error: { message: "401 Unauthorized: invalid api key", statusCode: 401 },
      } as any;
    })();
    const { provider, calls } = makeProvider([authFail]);

    const result = await runAgentLoop(baseConfig(provider, { maxStreamRetries: 5 }));

    // 只调用 1 次：TerminalError 不进重试分支
    expect(calls.length).toBe(1);
    expect(result.success).toBe(false);
  });

  test("场景6：用户取消（父 signal abort）→ 不重试，立即返回", async () => {
    const ac = new AbortController();
    const { provider, calls } = makeProvider([
      () => {
        // 在返回 429 的同时模拟用户按下 ESC
        ac.abort("user-cancel");
        return rateLimitErrorStream();
      },
    ]);

    const result = await runAgentLoop(
      baseConfig(provider, { maxStreamRetries: 5, signal: ac.signal }),
    );

    expect(calls.length).toBe(1);
    expect(result.success).toBe(false);
  });

  test("场景7：重试使用全新 AbortController —— 复用已 abort 的会让重试流秒断", async () => {
    // 第 1 次超时自愈会 abort turnAbort；若重试复用同一个 controller，
    // 第 2 次流一建立就被掐断。这里断言第 2 次拿到的 signal 未被 abort。
    const seenSignals: AbortSignal[] = [];
    const provider = {
      name: () => "openai",
      sendMessageStream: (_params: SendParams, signal?: AbortSignal) => {
        seenSignals.push(signal!);
        return seenSignals.length === 1
          ? rateLimitErrorStream()
          : successStream("done");
      },
    } as unknown as Provider;

    const result = await runAgentLoop(baseConfig(provider, { maxStreamRetries: 3 }));

    expect(seenSignals.length).toBe(2);
    // 重试那次的 signal 必须是干净的（未 abort），否则重试形同虚设
    expect(seenSignals[1].aborted).toBe(false);
    expect(result.success).toBe(true);
  });

  test("场景9：message 无关键词、判定全靠 error.type 的流内限流 → 必须仍重试", async () => {
    // R1 初版的真实缺口：把流内 error 拍平成 new Error(message) 后用 classifyError 按
    // **文本**猜，而 OpenAI 族流内 error 的 message 常常没有任何关键词，判定完全依赖
    // error.type/code（openai.ts:1644-1646 明确注释了这点）。
    // 下面这条 message 里既没有 "429" 也没有 "rate_limit"：
    //   - classifyStreamError(type=rate_limit_error) → RetryableError/rate_limit（该重试）
    //   - classifyError(new Error(msg))              → 普通 Error（不重试）
    // 初版会在这里直接失败——而场景 1 之所以能过，纯粹因为 OpenAI 的报文文本里恰好带 "429"。
    const typeOnlyRateLimit = () => (async function* (): AsyncIterable<StreamEvent> {
      yield { type: "message_start", message: { usage: { inputTokens: 5, outputTokens: 0 } } } as any;
      yield {
        type: "error",
        error: {
          message: "OpenAI 流内错误: Service is busy right now",
          type: "rate_limit_error",
          streamLevel: true,
        },
      } as any;
    })();

    const { provider, calls } = makeProvider([
      typeOnlyRateLimit,
      () => successStream("恢复成功"),
    ]);

    const result = await runAgentLoop(baseConfig(provider, { maxStreamRetries: 3 }));

    expect(calls.length).toBe(2);
    expect(result.success).toBe(true);
    expect(result.lastTextOutput).toContain("恢复成功");
  });

  test("场景10：结构化 invalid_request（400）判 terminal → 不重试且不误当限流", async () => {
    // 反向保护：别为了「多重试」把本该立刻放弃的也重试。
    // message 同样无关键词，只有 type=invalid_request_error + 400。
    const invalidReq = () => (async function* (): AsyncIterable<StreamEvent> {
      yield { type: "message_start", message: { usage: { inputTokens: 5, outputTokens: 0 } } } as any;
      yield {
        type: "error",
        error: {
          message: "OpenAI 流内错误: bad payload",
          type: "invalid_request_error",
          statusCode: 400,
          streamLevel: true,
        },
      } as any;
    })();
    const { provider, calls } = makeProvider([invalidReq]);

    const result = await runAgentLoop(baseConfig(provider, { maxStreamRetries: 5 }));

    // terminal → 只调用 1 次
    expect(calls.length).toBe(1);
    expect(result.success).toBe(false);
  });

  test("场景11：失败 attempt 已产出的 token 必须计入 totalUsage（否则账单对不上）", async () => {
    // 服务端对已产出 token 照常计费：message_start 已带 inputTokens，
    // 中断前的 message_delta 已带 outputTokens。只累加成功那次 → 少计 N-1 份。
    const partialThenFail = () => (async function* (): AsyncIterable<StreamEvent> {
      yield { type: "message_start", message: { usage: { inputTokens: 5000, outputTokens: 0 } } } as any;
      yield { type: "content_block_start", index: 0, content_block: { type: "text" } } as any;
      yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "已经吐了一段" } } as any;
      yield { type: "message_delta", delta: { stop_reason: null }, usage: { outputTokens: 200 } } as any;
      yield { type: "error", error: { message: REAL_429_BODY, type: "limit_burst_rate", statusCode: 429 } } as any;
    })();

    const { provider, calls } = makeProvider([
      partialThenFail,
      partialThenFail,
      () => successStream("终于成功"),
    ]);

    const result = await runAgentLoop(baseConfig(provider, { maxStreamRetries: 3 }));

    expect(calls.length).toBe(3);
    expect(result.success).toBe(true);
    // 两次失败各 5000 input / 200 output，加上成功那次 10000 input / 5 output
    // （successStream 的 message_start=10 input… 用 >= 断言避免耦合具体数值）
    expect(result.totalUsage.inputTokens).toBeGreaterThanOrEqual(10_000);
    expect(result.totalUsage.outputTokens).toBeGreaterThanOrEqual(400);
  });

  test("场景8：重试不污染消息历史 —— 失败轮次不留半截 assistant 消息", async () => {
    const ctxMgr = makeCtxMgr();
    const { provider } = makeProvider([
      () => rateLimitErrorStream(),
      () => rateLimitErrorStream(),
      () => successStream("最终答案"),
    ]);

    const result = await runAgentLoop(
      baseConfig(provider, { maxStreamRetries: 3, ctxMgr }),
    );

    expect(result.success).toBe(true);
    // 两次失败的 429 不应各自留下一条 assistant 消息：
    // 历史里 assistant 消息只应有成功那一条。
    const assistantMsgs = ctxMgr.getMessages().filter(m => m.role === "assistant");
    expect(assistantMsgs.length).toBe(1);
    // 且相邻消息角色必须交替（不能出现连续 assistant）
    const msgs = ctxMgr.getMessages();
    for (let i = 1; i < msgs.length; i++) {
      expect(msgs[i].role).not.toBe(msgs[i - 1].role);
    }
  });
});
