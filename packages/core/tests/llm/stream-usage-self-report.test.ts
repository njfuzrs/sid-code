/**
 * 缺陷 CP-1 回归：7 条「自报成本」的辅助调用链必须能从**真实事件序列**取到 usage。
 *
 * ## 这个文件为什么必须存在
 *
 * 修之前的 7 处写的是 `else if (event.type === "message_stop" && (event as any).usage)`。
 * `message_stop` 在 `StreamEvent` 里没有 usage 字段，所有 provider 都只把 usage 放在
 * `message_start` / `message_delta` 上 —— 于是这 7 条链的成功路径 usage 恒为 null、
 * `recordSideCall` 恒不触发；而它们在 `BILLING_SELF_REPORTED_LABELS` 里被豁免了
 * 发生侧计费，**两头都不记**，钱静默漏了 199 次（轨迹实测）。
 *
 * ## 为什么 mock 事件形态是这里的关键
 *
 * 旧的单元/mock 测试里写着 `yield { type: "message_stop", usage }` ——
 * **生产 provider 从不这么发**。mock 与生产不一致，是这个 bug 能活两个月没被
 * 任何测试拦住的直接原因。所以下面每一条都喂真实序列：
 *
 *     message_start{message:{usage}} → content_block_delta… → message_delta{usage} → message_stop{}
 *
 * 断言到「与喂入值逐位相等」而不是「非 0」：非 0 断言对"少数几十个 token 偏差"是瞎的。
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { getSideStats, resetSideCallStats } from "@sid-code/core/trace/side-call-sink.ts";
import { makeSideQuery } from "@sid-code/core/memory/recall.ts";
import { BashClassifier } from "@sid-code/core/permission/bash-classifier.ts";
import { contextCollapse } from "@sid-code/core/query/compact/context-collapse.ts";
import { partialCompact } from "@sid-code/core/query/compact/partial-compact.ts";
import { autoCompact } from "@sid-code/core/query/auto-compact.ts";
import { HookRunner } from "@sid-code/core/hook/runner.ts";
import { evaluateGoal } from "@sid-code/core/goal/evaluator.ts";
import { createGoal } from "@sid-code/core/goal/state.ts";
import { Manager as ContextManager } from "@sid-code/core/context/manager.ts";
import type { Message, StreamEvent } from "@sid-code/core/llm/types.ts";
import type { Provider } from "@sid-code/core/llm/provider.ts";

// ─── 真实事件序列 ───

const INPUT_TOKENS = 37;
const OUTPUT_TOKENS = 11;
const CACHE_READ_TOKENS = 5;
const CACHE_CREATION_TOKENS = 3;

/**
 * 构造一个「按 provider 真实形态」吐事件序列的 mock。
 *
 * 输入侧用量放 `message_start`（Anthropic 族的真实位置），输出侧放 `message_delta`；
 * 末尾的 `message_stop` **不带 usage** —— 它与生产一致，也正是修前的坏形态指望不上的地方。
 */
function realProvider(text = '{"ok":true,"safe":true,"risk":"low","reason":"只读命令"}'): Provider {
  const upstream = {
    name: () => "mock",
    async *sendMessageStream(): AsyncIterable<StreamEvent> {
      yield {
        type: "message_start",
        message: {
          usage: {
            inputTokens: INPUT_TOKENS,
            outputTokens: 0,
            cacheReadInputTokens: CACHE_READ_TOKENS,
            cacheCreationInputTokens: CACHE_CREATION_TOKENS,
          },
        },
      } as StreamEvent;
      yield {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text },
      } as StreamEvent;
      yield {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { inputTokens: 0, outputTokens: OUTPUT_TOKENS },
      } as StreamEvent;
      yield { type: "message_stop" } as StreamEvent;
    },
  };
  return upstream as unknown as Provider;
}

/** 取某条链的唯一一条自报记录（多于/少于 1 条都说明记账出了问题） */
function onlySideCall(label: string) {
  const hits = getSideStats().details.filter((d) => d.label === label);
  expect(hits.length).toBe(1);
  return hits[0]!;
}

function buildMessages(count: number): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      role: i % 2 === 0 ? "user" : "assistant",
      content: [{ type: "text", text: `第 ${i} 条消息，用于把上下文撑到可压缩规模。` }],
    } as Message);
  }
  return out;
}

beforeEach(() => {
  resetSideCallStats();
});

// ─── 7 处调用点各一条 ───

describe("缺陷 CP-1：7 条自报链在真实事件序列下都取到 usage", () => {
  test("memory/recall — makeSideQuery", async () => {
    const sideQuery = makeSideQuery(realProvider() as any, "mock-model");
    // SideQueryFn 只返回文本（usage 只进 sink，不回传调用方）
    const text = await sideQuery({ system: "s", user: "u", maxTokens: 64 });
    expect(text).toContain("ok");
    const d = onlySideCall("memory-recall");
    expect(d.inputTokens).toBe(INPUT_TOKENS);
    expect(d.outputTokens).toBe(OUTPUT_TOKENS);
  });

  test("permission/bash-classifier — BashClassifier.classify", async () => {
    const classifier = new BashClassifier({ enabled: true, model: "mock-model" } as any);
    classifier.setProvider(realProvider(), "mock-model");
    const r = await classifier.classify({ command: "ls -la", cwd: "/tmp" });
    expect(r.classifierUnavailable).toBeFalsy();
    const d = onlySideCall("bash-classifier");
    expect(d.inputTokens).toBe(INPUT_TOKENS);
    expect(d.outputTokens).toBe(OUTPUT_TOKENS);
  });

  test("query/compact/context-collapse — contextCollapse", async () => {
    // 可压区 = floor(len * 0.3)，需要 ≥ SEGMENT_SIZE(10) 才切得出段 → 40 条足够
    const messages = buildMessages(40);
    await contextCollapse(messages, {
      targetRatio: 0.5,
      maxTokens: 1000,
      provider: realProvider("这是一段足够长的段摘要，用来通过质量下限校验并触发记账逻辑。"),
      model: "mock-model",
      maxSegments: 1,
    });
    const d = onlySideCall("context-collapse");
    expect(d.inputTokens).toBe(INPUT_TOKENS);
    expect(d.outputTokens).toBe(OUTPUT_TOKENS);
  });

  test("query/compact/partial-compact — partialCompact", async () => {
    const messages = buildMessages(20);
    await partialCompact(messages, 10, {
      provider: realProvider("压缩后的摘要内容"),
      model: "mock-model",
    });
    const d = onlySideCall("partial-compact");
    expect(d.inputTokens).toBe(INPUT_TOKENS);
    expect(d.outputTokens).toBe(OUTPUT_TOKENS);
  });

  test("query/auto-compact — autoCompact", async () => {
    const ctx = new ContextManager({ maxTokens: 100_000 });
    for (const m of buildMessages(20)) ctx.addMessage(m);
    await autoCompact({
      provider: realProvider("这是一段自动压缩摘要，覆盖了此前若干条对话的内容。"),
      config: { model: "mock-model", provider: "mock" } as any,
      ctxMgr: ctx,
      hookSystem: {
        firePreCompactEvent: async () => ({ finalOutput: null }),
        firePostCompactEvent: async () => ({ finalOutput: null }),
      } as any,
      getAbortSignal: () => undefined,
      isMainAgent: false, // 不污染全局熔断器
    });
    const d = onlySideCall("auto-compact");
    expect(d.inputTokens).toBe(INPUT_TOKENS);
    expect(d.outputTokens).toBe(OUTPUT_TOKENS);
  });

  test("hook/runner — HookRunner.collectStreamResponse", async () => {
    const runner = new HookRunner();
    const text = await (runner as any).collectStreamResponse(realProvider(), {
      model: "mock-model",
      messages: [{ role: "user", content: [{ type: "text", text: "验证一下" }] }],
      system: "你是 Hook 验证器",
      maxTokens: 64,
    });
    expect(text).toContain("{");
    const d = onlySideCall("hook-runner");
    expect(d.inputTokens).toBe(INPUT_TOKENS);
    expect(d.outputTokens).toBe(OUTPUT_TOKENS);
  });

  test("goal/evaluator — evaluateGoal", async () => {
    const goal = createGoal("让 bun test 通过");
    const r = await evaluateGoal(goal, "当前上下文", {
      model: "mock-model",
      provider: realProvider(),
      minTurnsBeforeEval: 0,
    });
    // P1-3：评估器 token 计入 GoalGateDecision
    expect(r.evalTokensUsed).toBe(INPUT_TOKENS + OUTPUT_TOKENS);
    const d = onlySideCall("goal-evaluator");
    expect(d.inputTokens).toBe(INPUT_TOKENS);
    expect(d.outputTokens).toBe(OUTPUT_TOKENS);
  });
});
