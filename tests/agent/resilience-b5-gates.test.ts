/**
 * B5 归因与门槛修正（子代理侧）—— 硬门槛断言
 *
 * 对应 `docs/bugfixes/todo/20260801-韧性层架构对齐CC-子代理韧性能力根治方案.md` 的 B5 批次。
 * 漏斗侧三项（B5-2/3/7）在 `tests/llm/resilience-b5-gates.test.ts`；本文件钉需要
 * 子代理循环夹具的三项：
 *
 *   B5-1 model_context_window_exceeded 补分支  → §5 新发现 2
 *   B5-4 retryAttempts / lastRetryReason 透出  → §5 缺口 D
 *   B5-5 frontmatter timeout 钳制              → §5 缺口 C
 *
 * fix_type: regression_guard
 */

import { describe, test, expect } from "bun:test";
import { runAgentLoop } from "../../src/agent/agentic-loop.ts";
import { Manager as ContextManager } from "../../src/context/manager.ts";
import { Registry as ToolRegistry } from "../../src/tool/registry.ts";
import { LoopDetector } from "../../src/agent/loop-detection.ts";
import {
  parseAgentTimeout,
  CUSTOM_AGENT_TIMEOUT_MIN_MS,
  CUSTOM_AGENT_TIMEOUT_MAX_MS,
} from "../../src/agent/custom.ts";
import type { Provider } from "../../src/llm/provider.ts";
import type { StreamEvent, SendParams } from "../../src/llm/types.ts";

/** 正常完成的流（end_turn + 文本内容）。 */
async function* successStream(text: string): AsyncIterable<StreamEvent> {
  yield { type: "message_start", message: { usage: { inputTokens: 10, outputTokens: 0 } } } as any;
  yield { type: "content_block_start", index: 0, content_block: { type: "text" } } as any;
  yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } as any;
  yield { type: "content_block_stop", index: 0 } as any;
  yield { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { outputTokens: 5 } } as any;
}

/**
 * 撞 context window 上限的流：有文本产出但 stop_reason 为
 * `model_context_window_exceeded`（Claude 4.5+ 新增，见 anthropic-api.md:553,559）。
 */
async function* ctxWindowExceededStream(text = "部分产出"): AsyncIterable<StreamEvent> {
  yield { type: "message_start", message: { usage: { inputTokens: 900, outputTokens: 0 } } } as any;
  yield { type: "content_block_start", index: 0, content_block: { type: "text" } } as any;
  yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } as any;
  yield { type: "content_block_stop", index: 0 } as any;
  yield {
    type: "message_delta",
    delta: { stop_reason: "model_context_window_exceeded" },
    usage: { outputTokens: 5 },
  } as any;
}

/** 连文本都没产出就撞上限（输入本身已顶满）—— 空响应守卫必须豁免这条。 */
async function* ctxWindowExceededEmptyStream(): AsyncIterable<StreamEvent> {
  yield { type: "message_start", message: { usage: { inputTokens: 900, outputTokens: 0 } } } as any;
  yield {
    type: "message_delta",
    delta: { stop_reason: "model_context_window_exceeded" },
    usage: { outputTokens: 0 },
  } as any;
}

/** 限流（流内 error 事件形式，复刻事故真实路径：provider 不抛异常）。 */
async function* rateLimitErrorStream(): AsyncIterable<StreamEvent> {
  yield { type: "message_start", message: { usage: { inputTokens: 10, outputTokens: 0 } } } as any;
  yield {
    type: "error",
    error: { message: "429 limit_burst_rate", type: "limit_burst_rate", statusCode: 429 },
  } as any;
}

function makeProvider(scripted: Array<() => AsyncIterable<StreamEvent>>) {
  const calls: SendParams[] = [];
  const provider = {
    name: () => "openai",
    sendMessageStream: (params: SendParams) => {
      const idx = calls.length;
      calls.push(params);
      return scripted[Math.min(idx, scripted.length - 1)]();
    },
  } as unknown as Provider;
  return { provider, calls };
}

/**
 * 造一个消息数足够多的 ctxMgr —— `reactiveCompact` 对 ≤4 条消息直接判"无法压缩"，
 * 用默认夹具（2 条）会让"压缩成功"分支永远走不到，测试就会假绿。
 */
function makeCtxMgr(messagePairs = 0) {
  const ctxMgr = new ContextManager({ maxTokens: 100_000 });
  ctxMgr.setSystemPrompt("你是子代理");
  ctxMgr.addMessage({ role: "user", content: [{ type: "text", text: "开始任务" }] });
  for (let i = 0; i < messagePairs; i++) {
    ctxMgr.addMessage({ role: "assistant", content: [{ type: "text", text: `第 ${i} 轮回复`.repeat(20) }] });
    ctxMgr.addMessage({ role: "user", content: [{ type: "text", text: `第 ${i} 轮追问`.repeat(20) }] });
  }
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
    retryBackoffBaseMs: 1,
    // B0：permissionChecker 从 AgentLoopConfig 的必填字段，显式声明本测试场景
    // 不需要权限检查（工具集为空 ToolRegistry，无写类工具可测）。
    permissionChecker: undefined,
    ...overrides,
  } as any;
}

// ══════════════════════════════════════════════════════════════════════
// B5-1：model_context_window_exceeded 补分支
// ══════════════════════════════════════════════════════════════════════

describe("B5-1 门槛：model_context_window_exceeded 归因正确（§5 新发现 2）", () => {
  test("撞上限且可压缩 → 压缩后续写，不误报模型不可用", async () => {
    // 改造前：这条 stopReason 无分支 → 穿透到"其他未知停止原因" → 报
    // 「疑似模型不可用或网关返回非流式错误页」。模型是好的，是上下文顶满了。
    const { provider, calls } = makeProvider([
      () => ctxWindowExceededStream(),
      () => successStream("压缩后完成"),
    ]);

    const result = await runAgentLoop(
      baseConfig(provider, { ctxMgr: makeCtxMgr(6) }),
    );

    // 直接证据：又发起了一次请求 = 确实压缩后续写，而不是当场失败
    expect(calls.length).toBe(2);
    expect(result.success).toBe(true);
    expect(result.lastTextOutput).toContain("压缩后完成");
  });

  test("撞上限且压不动 → 如实报上下文超限，不空转", async () => {
    // 消息太少 → reactiveCompact 判"无法压缩"。此时必须立刻如实失败：
    // 压不动意味着再来一轮必然撞同一个上限，继续续写纯烧 token。
    const { provider, calls } = makeProvider([() => ctxWindowExceededStream()]);

    const result = await runAgentLoop(baseConfig(provider, { ctxMgr: makeCtxMgr(0) }));

    expect(result.success).toBe(false);
    // 归因必须指向"上下文撞上限"，而不是"模型不可用"
    expect(result.errorMessage).toContain("context window");
    expect(result.errorMessage).not.toContain("模型不可用");
    // 没有空转：压不动就不再发请求
    expect(calls.length).toBe(1);
  });

  test("零 content block 撞上限 → 归因仍不精确（已知边界，非本项覆盖范围）", async () => {
    // ── 诚实边界，勿当已修 ──
    //
    // 一个 content block 都没产出就撞上限时，**漏斗层**的 `hasYieldedContent` 校验
    // （fallback.ts:732）会先把它判成 `StreamValidationError("响应为空")` 并重试→降级，
    // 请求根本走不到本循环的 stopReason 分支。所以子代理侧那条豁免（空响应守卫放行
    // model_context_window_exceeded）对这条路径**实际不生效**。
    //
    // 为什么不在 B5 一并修：那要改漏斗的空响应语义（`hasYieldedContent` 判据本身带着
    // 一整段"无参数工具调用被误判为空响应"的既有推理），属漏斗内部能力，不是本项的
    // 归因修正。留此断言把现状钉住 —— 哪天有人修好了漏斗侧，这条会红，届时连同
    // 上面三条一起改成正向断言即可。
    const { provider } = makeProvider([() => ctxWindowExceededEmptyStream()]);

    const result = await runAgentLoop(baseConfig(provider, { ctxMgr: makeCtxMgr(0) }));

    expect(result.success).toBe(false);
    // 现状：被漏斗当成空响应处理，归因里没有"上下文超限"
    expect(result.errorMessage).toContain("响应为空");
  });

  test("反复撞上限 → 有上界，不会跑到 maxTurns 耗尽", async () => {
    // 每次都压得动一点、但每次都再撞上限 —— 若无次数上界，会一路空转到 maxTurns。
    const { provider, calls } = makeProvider([() => ctxWindowExceededStream()]);

    const result = await runAgentLoop(
      baseConfig(provider, { ctxMgr: makeCtxMgr(12), maxTurns: 20 }),
    );

    expect(result.success).toBe(false);
    // 上界是 2 次续写 → 最多 3 次请求，远小于 maxTurns=20
    expect(calls.length).toBeLessThanOrEqual(3);
    expect(result.errorMessage).toContain("context window");
  });
});

// ══════════════════════════════════════════════════════════════════════
// B5-4：retryAttempts / lastRetryReason 透出
// ══════════════════════════════════════════════════════════════════════

describe("B5-4 门槛：重试次数透出到 AgentLoopResult（§5 缺口 D）", () => {
  test("发生重试 → retryAttempts 计数，lastRetryReason 带分类原因", async () => {
    const { provider, calls } = makeProvider([
      () => rateLimitErrorStream(),
      () => successStream("重试后成功"),
    ]);

    const result = await runAgentLoop(baseConfig(provider, { maxStreamRetries: 3 }));

    expect(calls.length).toBe(2);
    expect(result.success).toBe(true);
    // 这两个字段是缺口 D 的修复载体：超时路径会丢弃 errorMessage，
    // 只有结构化字段能把"其实是限流重试过"带出去。
    expect(result.retryAttempts).toBe(1);
    expect(result.lastRetryReason).toBeDefined();
  });

  test("多次重试累计计数", async () => {
    const { provider } = makeProvider([
      () => rateLimitErrorStream(),
      () => rateLimitErrorStream(),
      () => successStream("终于成功"),
    ]);

    const result = await runAgentLoop(baseConfig(provider, { maxStreamRetries: 5 }));

    expect(result.success).toBe(true);
    expect(result.retryAttempts).toBe(2);
  });

  test("无重试 → 字段不写（保持原结果形状）", async () => {
    // 顺利跑完却报"重试 0 次"是噪音；也让下游能用存在性区分"没重试"与"未接线"。
    const { provider } = makeProvider([() => successStream("一次就成")]);

    const result = await runAgentLoop(baseConfig(provider));

    expect(result.success).toBe(true);
    expect(result.retryAttempts).toBeUndefined();
  });

  test("不传 onTelemetry 时事件仍落到全局观察者（计数 tap 不得掐断生产通道）", async () => {
    // 这条钉的是 B5-4 实施时真实踩到的坑：漏斗 emitTelemetry 是"有 per-instance 回调
    // 就只走它并 return，没有才走全局观察者"。计数 tap 若无条件传给漏斗，漏斗就永远
    // 走"有回调"分支 → 全局观察者收不到事件 → 生产路径（子代理不传 onTelemetry）的
    // 重试遥测彻底消失，且无任何报错。属 §七 F7 型"能力实现了但没生效"。
    const { setRetryTelemetryObserver } = await import("../../src/llm/retry-telemetry.ts");
    const seen: string[] = [];
    setRetryTelemetryObserver((ev) => seen.push(ev.type));
    try {
      const { provider } = makeProvider([
        () => rateLimitErrorStream(),
        () => successStream("ok"),
      ]);
      // 刻意不传 onTelemetry —— 与 sub-agent.ts 生产调用形态一致
      const result = await runAgentLoop(baseConfig(provider, { maxStreamRetries: 3 }));

      expect(result.success).toBe(true);
      expect(seen.filter((t) => t === "retry").length).toBe(1);
      // 计数与派发两件事都要成立（不是"二选一"）
      expect(result.retryAttempts).toBe(1);
    } finally {
      setRetryTelemetryObserver(null);
    }
  });

  test("onTelemetry 仍原样转发给调用方（tap 不吞事件）", async () => {
    // 计数是搭在 onTelemetry 上的旁路。若 tap 写错成"消费掉事件"，
    // 上层的重试遥测会整条消失 —— 那是比没有计数更大的损失。
    const seen: string[] = [];
    const { provider } = makeProvider([
      () => rateLimitErrorStream(),
      () => successStream("ok"),
    ]);

    await runAgentLoop(
      baseConfig(provider, {
        maxStreamRetries: 3,
        onTelemetry: (e: { type: string }) => seen.push(e.type),
      }),
    );

    expect(seen).toContain("retry");
  });
});

// ══════════════════════════════════════════════════════════════════════
// B5-5：frontmatter timeout 钳制
// ══════════════════════════════════════════════════════════════════════

describe("B5-5 门槛：frontmatter timeout 有上限（§5 缺口 C）", () => {
  test("超大值被钳到上限（改造前无上限，可写成 11 天）", () => {
    // "有界"这个安全性质是外层超时提供的；timeout 无上限 = 把它放开。
    expect(parseAgentTimeout(999_999_999, "evil")).toBe(CUSTOM_AGENT_TIMEOUT_MAX_MS);
  });

  test("过小值被钳到下限", () => {
    // 比一次退避（cap 120s）还短的 timeout 会让子代理在第一次限流退避中途就被 abort，
    // 永远等不到重试结果 —— 几乎总是笔误。
    expect(parseAgentTimeout(500, "typo")).toBe(CUSTOM_AGENT_TIMEOUT_MIN_MS);
  });

  test("区间内的值原样保留", () => {
    expect(parseAgentTimeout(300_000, "normal")).toBe(300_000);
    expect(parseAgentTimeout(CUSTOM_AGENT_TIMEOUT_MIN_MS, "edge")).toBe(CUSTOM_AGENT_TIMEOUT_MIN_MS);
    expect(parseAgentTimeout(CUSTOM_AGENT_TIMEOUT_MAX_MS, "edge")).toBe(CUSTOM_AGENT_TIMEOUT_MAX_MS);
  });

  test.each([
    ["未声明", undefined],
    ["字符串", "600000"],
    ["零", 0],
    ["负数", -1],
    ["NaN", NaN],
    ["Infinity", Infinity],
  ])("%s → undefined（由调用方回落默认 300s）", (_label, raw) => {
    expect(parseAgentTimeout(raw, "bad")).toBeUndefined();
  });

  test("上限不低于内置 agent 的最长超时（否则自定义 agent 反而更受限）", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/agent/agent-definition.ts", "utf-8");
    const timeouts = [...src.matchAll(/timeout:\s*([0-9_]+)/g)]
      .map((m) => parseInt(m[1].replace(/_/g, ""), 10))
      .filter((n) => n > 0);
    expect(timeouts.length).toBeGreaterThan(0);
    expect(CUSTOM_AGENT_TIMEOUT_MAX_MS).toBeGreaterThanOrEqual(Math.max(...timeouts));
  });
});
