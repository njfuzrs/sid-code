/**
 * PR7：子代理接预算闸（D3，只对配了预算的用户生效）—— G1 层。
 *
 * 方案《20261116-只读子代理空转与过期清理重读循环-修复与验收方案》§PR7 的验收点：
 *   ① 配了预算且已超限：**下一轮请求前**停下，一次正常轮都不多跑
 *   ② 命中后跑一轮**不带 tools** 的总结，`stop_action=budget_exceeded`，结论是总结文本
 *   ③ 未注入预算检查时行为与改造前完全一致（这是本 PR 敢标「只对配了预算的用户生效」的依据）
 *   ④ 检查函数自己抛错时 fail-open，不误杀任务
 *   ⑤ 接线不断：SubAgent / SubAgentTool 都把回调透传到循环配置（防死接线）
 *
 * 判据都是开关型（不跑模型、不起进程就能判对错），所以落在 G1。真模型下
 * 「预算停止后的总结好不好用」属于 G3/G5，不在本文件。
 */

import { describe, test, expect } from "bun:test";
import {
  runAgentLoop,
  BUDGET_EXCEEDED_FINALIZE_PROMPT,
} from "@sid-code/core/agent/agentic-loop.ts";
import type { PreRequestBudgetStop } from "@sid-code/core/agent/agentic-loop.ts";
import type { InFlightBudgetSnapshot } from "@sid-code/core/agent/agentic-loop.ts";
import { Manager as ContextManager } from "@sid-code/core/context/manager.ts";
import { Registry as ToolRegistry } from "@sid-code/core/tool/registry.ts";
import { LoopDetector } from "@sid-code/core/agent/loop-detection.ts";
import { SubAgent } from "@sid-code/core/agent/sub-agent.ts";
import { describeStopNotice } from "@sid-code/core/agent/stop-notice.ts";
import { SessionState } from "@sid-code/core/session/state.ts";
import type { Provider } from "@sid-code/core/llm/provider.ts";
import type { StreamEvent } from "@sid-code/core/llm/types.ts";
import type { LegacyTool, LegacyToolResult } from "@sid-code/core/tool/types.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function makeCtxMgr(): ContextManager {
  const ctxMgr = new ContextManager({ maxTokens: 100_000 });
  ctxMgr.setSystemPrompt("test");
  ctxMgr.addMessage({ role: "user", content: [{ type: "text", text: "任务" }] });
  return ctxMgr;
}

function yieldText(text: string, stopReason = "end_turn"): StreamEvent[] {
  return [
    {
      type: "message_start",
      message: { usage: { inputTokens: 10, outputTokens: 0 } },
    } as StreamEvent,
    { type: "content_block_start", index: 0, content_block: { type: "text" } } as StreamEvent,
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    } as StreamEvent,
    { type: "content_block_stop", index: 0 } as StreamEvent,
    {
      type: "message_delta",
      delta: { stop_reason: stopReason },
      usage: { outputTokens: 5 },
    } as StreamEvent,
  ];
}

function yieldToolUse(id: string, name: string, input: Record<string, unknown>): StreamEvent[] {
  return [
    {
      type: "message_start",
      message: { usage: { inputTokens: 10, outputTokens: 0 } },
    } as StreamEvent,
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id, name },
    } as StreamEvent,
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(input) },
    } as StreamEvent,
    { type: "content_block_stop", index: 0 } as StreamEvent,
    {
      type: "message_delta",
      delta: { stop_reason: "tool_use" },
      usage: { outputTokens: 5 },
    } as StreamEvent,
  ];
}

/** 取出本次请求最后一条消息的文本 —— 用来断言收尾轮用的是哪个出口的提示词。 */
function lastMessageText(params: unknown): string {
  const messages = (params as { messages?: Array<{ content?: unknown }> })?.messages ?? [];
  const last = messages[messages.length - 1];
  if (!last) return "";
  const content = last.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (typeof b === "string" ? b : ((b as { text?: string })?.text ?? "")))
    .join("\n");
}

/** 记录「每次请求下发了几个 tools」与「最后一条消息文本」。 */
function makeRecordingProvider(script: StreamEvent[][]): {
  provider: Provider;
  toolCounts: number[];
  lastMessageTexts: string[];
} {
  let call = 0;
  const toolCounts: number[] = [];
  const lastMessageTexts: string[] = [];
  const provider = {
    name: () => "mock",
    defaultModel: () => "mock-model",
    async *sendMessageStream(params: any): AsyncIterable<StreamEvent> {
      toolCounts.push(params?.tools?.length ?? 0);
      lastMessageTexts.push(lastMessageText(params));
      const events = script[Math.min(call, script.length - 1)] ?? yieldText("完成");
      call++;
      for (const e of events) yield e;
    },
  } as unknown as Provider;
  return { provider, toolCounts, lastMessageTexts };
}

function allowAll() {
  return { check: async () => ({ allowed: true }) } as any;
}

/** 只读工具：记录执行次数（用来断言「命中后不再执行任何工具」）。 */
class CountingReadTool implements LegacyTool {
  executed = 0;
  name() {
    return "read";
  }
  description() {
    return "读取文件";
  }
  inputSchema() {
    return {
      type: "object",
      properties: { file_path: { type: "string" } },
      required: ["file_path"],
    };
  }
  readOnly() {
    return true;
  }
  async execute(input: Record<string, unknown>): Promise<LegacyToolResult> {
    this.executed++;
    return { output: `file ${String(input.file_path)}` };
  }
}

const quotaStop: PreRequestBudgetStop = {
  source: "quota",
  text: "配额已超限（$1.20 / $1.00），仍拦截",
};

describe("PR7 · 请求前预算硬停（D3）", () => {
  test("一开始就超限：正常轮一次都不跑，直接收尾，归因 budget_exceeded", async () => {
    const tools = new ToolRegistry();
    const { provider, toolCounts, lastMessageTexts } = makeRecordingProvider([
      yieldText("## 结论\n- 已确认 A，未查完 B"),
    ]);
    let probes = 0;

    const result = await runAgentLoop({
      provider,
      model: "mock-model",
      ctxMgr: makeCtxMgr(),
      tools,
      maxTurns: 10,
      signal: new AbortController().signal,
      loopDetector: new LoopDetector(),
      permissionChecker: allowAll(),
      preRequestBudgetStop: () => {
        probes++;
        return quotaStop;
      },
    } as any);

    // ① 只查一次、只发一次请求，且那一次就是收尾轮（不带 tools）。
    expect(probes, "预算检查应当在第 1 轮请求前查一次").toBe(1);
    expect(toolCounts.length, "只有收尾轮，没有任何正常轮").toBe(1);
    expect(toolCounts[0], "收尾轮不得下发 tools").toBe(0);

    // ② 收尾轮用的是**预算出口**的提示词，不是「打满轮次」那句。
    expect(lastMessageTexts[0]).toContain(BUDGET_EXCEEDED_FINALIZE_PROMPT);
    expect(lastMessageTexts[0]).toContain("预算额度已用尽");

    // ③ 归因与结果：预算停止，但结论可用（不是 salvage 兜底）。
    expect(result.stopAction).toBe("budget_exceeded");
    expect(result.turns, "没跑任何正常轮，turns 不该被计成 1").toBe(0);
    expect(result.success).toBe(true);
    expect(result.lastTextOutput).toContain("已确认 A");
  });

  test("跑到一半才超限：下一轮请求前停下，已跑的工具不再重复执行", async () => {
    const read = new CountingReadTool();
    const tools = new ToolRegistry();
    tools.register(read as any);

    const { provider, toolCounts, lastMessageTexts } = makeRecordingProvider([
      // 第 1 轮：正常工具调用
      yieldToolUse("c1", "read", { file_path: "/a.ts" }),
      // 第 2 次调用 = 收尾轮
      yieldText("## 结论\n- 看了 a.ts，发现 X"),
    ]);
    let probes = 0;

    const result = await runAgentLoop({
      provider,
      model: "mock-model",
      ctxMgr: makeCtxMgr(),
      tools,
      maxTurns: 10,
      signal: new AbortController().signal,
      loopDetector: new LoopDetector(),
      permissionChecker: allowAll(),
      preRequestBudgetStop: () => {
        probes++;
        // 第 1 次（第 1 轮请求前）放行，第 2 次（第 2 轮请求前）命中。
        return probes >= 2 ? quotaStop : null;
      },
    } as any);

    expect(probes, "第 1 轮放行 + 第 2 轮命中，共查 2 次").toBe(2);
    expect(toolCounts.length, "工具轮 + 收尾轮").toBe(2);
    expect(toolCounts[0], "第 1 轮正常下发 tools").toBeGreaterThan(0);
    expect(toolCounts[1], "收尾轮不得下发 tools").toBe(0);
    expect(read.executed, "工具只该在第 1 轮执行一次").toBe(1);
    expect(lastMessageTexts[1]).toContain("预算额度已用尽");
    expect(result.turns).toBe(1);
    expect(result.stopAction).toBe("budget_exceeded");
    expect(result.lastTextOutput).toContain("发现 X");
  });

  test("对照组：未注入预算检查时行为不变（正常收工归因 finalize）", async () => {
    const tools = new ToolRegistry();
    const { provider, toolCounts } = makeRecordingProvider([yieldText("## 结论\n- 正常收工")]);

    const result = await runAgentLoop({
      provider,
      model: "mock-model",
      ctxMgr: makeCtxMgr(),
      tools,
      maxTurns: 10,
      signal: new AbortController().signal,
      loopDetector: new LoopDetector(),
      permissionChecker: allowAll(),
    } as any);

    expect(toolCounts.length).toBe(1);
    expect(result.stopAction).toBe("finalize");
    expect(result.success).toBe(true);
  });

  test("回调返回 null 时等价于「没超限」：循环照常跑（只对配了预算且真超限的用户生效）", async () => {
    const tools = new ToolRegistry();
    const { provider, toolCounts } = makeRecordingProvider([yieldText("## 结论\n- 预算内跑完")]);

    const result = await runAgentLoop({
      provider,
      model: "mock-model",
      ctxMgr: makeCtxMgr(),
      tools,
      maxTurns: 10,
      signal: new AbortController().signal,
      loopDetector: new LoopDetector(),
      permissionChecker: allowAll(),
      preRequestBudgetStop: () => null,
    } as any);

    expect(toolCounts.length).toBe(1);
    expect(result.stopAction).toBe("finalize");
  });

  test("预算检查自身抛错时 fail-open：不因检查故障误杀任务", async () => {
    const tools = new ToolRegistry();
    const { provider, toolCounts } = makeRecordingProvider([yieldText("## 结论\n- 照常完成")]);

    const result = await runAgentLoop({
      provider,
      model: "mock-model",
      ctxMgr: makeCtxMgr(),
      tools,
      maxTurns: 10,
      signal: new AbortController().signal,
      loopDetector: new LoopDetector(),
      permissionChecker: allowAll(),
      preRequestBudgetStop: () => {
        throw new Error("SessionState 未初始化");
      },
    } as any);

    expect(toolCounts.length, "异常不该阻断循环").toBe(1);
    expect(result.success).toBe(true);
    expect(result.stopAction).toBe("finalize");
  });
});

describe("PR7 · 停止原因对父代理可见", () => {
  test("budget_exceeded 有专属说明：说清是「预算」而不是笼统的异常结束", () => {
    const notice = describeStopNotice("budget_exceeded");
    expect(notice).toBeDefined();
    expect(notice).toContain("预算");
    expect(notice).toContain("总结");
  });
});

describe("PR7 · 接线不会断（防死接线）", () => {
  test("SubAgent 把注入的回调透传给循环配置；未注入时是 undefined", () => {
    const provider = {
      name: () => "mock",
      defaultModel: () => "mock-model",
    } as unknown as Provider;
    const guard = (): PreRequestBudgetStop => quotaStop;

    const wired = new SubAgent(provider, "mock-model", new ToolRegistry());
    wired.setPreRequestBudgetStop(guard);
    expect((wired as any).buildBaseLoopConfig(makeCtxMgr(), "agent-1").preRequestBudgetStop).toBe(
      guard,
    );

    // 未注入（配了预算之前 / 没有预算的用户）：不产生任何检查调用。
    const plain = new SubAgent(provider, "mock-model", new ToolRegistry());
    expect(
      (plain as any).buildBaseLoopConfig(makeCtxMgr(), "agent-1").preRequestBudgetStop,
    ).toBeUndefined();
  });

  test("SubAgentTool 把回调挂到它创建的子代理上（runSync / runAsync 共用工厂）", () => {
    // 直接读源码断言「工厂里挂了」比构造完整 SubAgentTool 更稳：
    // runSync / runAsync 两条路径都只经 createSubAgentForType，工厂接上即两条都接上。
    const src = readFileSync(join(import.meta.dir, "../../src/agent/tool.ts"), "utf-8");
    const factory = src.slice(src.indexOf("private createSubAgentForType("));
    const factoryBody = factory.slice(
      0,
      factory.indexOf("\n  private static async setupIsolation"),
    );
    expect(factoryBody).toContain("subAgent.setPreRequestBudgetStop(this.preRequestBudgetStop)");
  });

  test("app 接线只在配了预算时注入，且判据与主循环同源", () => {
    const src = readFileSync(join(import.meta.dir, "../../../cli/src/app.ts"), "utf-8");
    expect(src).toContain("private wireSubAgentBudgetStop(): void {");
    // ① 未配预算 → 不注入（这是「只对配了预算的用户生效」的唯一落地方式）。
    expect(src).toContain("if (!this.quotaManager && !this.budgetTracker) return;");
    // ② 判据复用主循环那一条，不另写一份。
    expect(src).toContain("checkPreRequestBudgetStop(");
    // ③ 「已花多少」在调用时现算，不用旧快照；口径是「已入账 + 在途」。
    expect(src).toContain("getBudgetEffectiveCostUSD()");
  });
});

/**
 * PR7 重修（D3-2）：让预算判据看到**在途**成本。
 *
 * 原实现的失败形态（方案 §8.11 / G3 的 C4）：probe 读 `getEffectiveTotalCostUSD()`，
 * 而子代理的花费只在它**结束之后**由 usage-sink 入账一次 —— $0.015 的预算下
 * 子代理跑了 33 轮、烧掉 $0.0441（预算的 3.0 倍）才自然结束，撞闸的反而是父会话。
 *
 * 这里守四件事：
 *   ① 台账语义：覆盖写（不是累加）、清理归零、预算口径 = 已入账 + 在途
 *   ② 端到端：第 1 轮花掉的钱让第 2 轮请求前就停（不上报时不会停 —— 有对照）
 *   ③ 上报失败 fail-open，不清台账的出口不存在（finally 覆盖所有出口）
 *   ④ 接线成对：判据与上报器必须同时装（只装一个是原失败形态）
 */
describe("PR7 重修（D3-2）· 在途成本并入判据", () => {
  const MODEL = "mock-model";
  /**
   * 每 1M input $10 / 每 1M output $20 → 一轮（10 in + 5 out）恰好 $0.0002。
   * 挑这组数是为了让阈值 $0.00015 落在「一轮之后超、零轮不超」之间：
   * 判据只差这一笔在途成本就会翻面，断言因此能区分「修好了」与「没修」。
   */
  const PRICING = { input: 10, output: 20 };
  const ONE_TURN_USD = 0.0002;
  const THRESHOLD_USD = ONE_TURN_USD * 0.75;

  function makeState(): SessionState {
    const ss = new SessionState("pr7-inflight");
    ss.setAvailableModels([
      { name: MODEL, provider: "openai", baseURL: "https://gw.example/v1", pricing: PRICING },
    ]);
    return ss;
  }

  test("台账：覆盖写不是累加、清理后归零、预算口径 = 已入账 + 在途", () => {
    const ss = makeState();
    const usage = { inputTokens: 10_000, outputTokens: 1_000 };
    ss.setInFlightUsage("sub-a", { model: MODEL, provider: "openai", usage });
    const one = ss.getInFlightCostUSD();
    expect(one, "登记后必须算得出钱（不是 0 —— 算不出就说明计价口径没接上）").toBeGreaterThan(0);

    // 覆盖写：同一 key 用同样的**累计**值再报一次，总额不变（若误做成累加会翻倍）。
    ss.setInFlightUsage("sub-a", { model: MODEL, provider: "openai", usage });
    expect(ss.getInFlightCostUSD()).toBeCloseTo(one, 10);

    // 并发子代理各占一条、判据读全体之和（只算自己那一份 = n 倍超支）。
    ss.setInFlightUsage("sub-b", { model: MODEL, provider: "openai", usage });
    expect(ss.getInFlightCostUSD()).toBeCloseTo(one * 2, 10);

    // 预算口径 = 已入账（此时 0）+ 在途。
    expect(ss.getBudgetEffectiveCostUSD()).toBeCloseTo(one * 2, 10);
    // 展示/对账口径不受影响：仍只读**已结算**的钱（footer、`/cost`、轨迹 total_cost_usd）。
    expect(ss.getEffectiveTotalCostUSD()).toBe(0);

    ss.clearInFlightUsage("sub-a");
    ss.clearInFlightUsage("sub-b");
    expect(ss.getInFlightCostUSD()).toBe(0);
    expect(ss.getBudgetEffectiveCostUSD()).toBe(ss.getEffectiveTotalCostUSD());
  });

  test("resetCounters（/clear）归零台账：旧会话的在途量不会留到新会话", () => {
    const ss = makeState();
    ss.setInFlightUsage("sub-a", {
      model: MODEL,
      provider: "openai",
      usage: { inputTokens: 10_000, outputTokens: 1_000 },
    });
    expect(ss.getInFlightCostUSD()).toBeGreaterThan(0);
    ss.resetCounters();
    expect(ss.getInFlightCostUSD()).toBe(0);
  });

  test("e2e：第 1 轮花掉的钱立刻进判据，第 2 轮请求前就停", async () => {
    const state = makeState();
    const read = new CountingReadTool();
    const tools = new ToolRegistry();
    tools.register(read as any);
    const { provider, toolCounts, lastMessageTexts } = makeRecordingProvider([
      yieldToolUse("c1", "read", { file_path: "/a.ts" }),
      yieldText("## 结论\n- 预算内停下"),
    ]);

    const result = await runAgentLoop({
      provider,
      model: MODEL,
      ctxMgr: makeCtxMgr(),
      tools,
      maxTurns: 10,
      signal: new AbortController().signal,
      loopDetector: new LoopDetector(),
      permissionChecker: allowAll(),
      // 与 app 接线同形：每轮把累计用量登记进会话台账。
      onInFlightUsage: (snapshot: InFlightBudgetSnapshot) =>
        state.setInFlightUsage("sub-1", snapshot),
      // 与 app 接线同形：判据读「已入账 + 在途」。
      preRequestBudgetStop: () =>
        state.getBudgetEffectiveCostUSD() >= THRESHOLD_USD ? quotaStop : null,
    } as any);

    // 第 1 轮前在途 0（放行）→ 第 1 轮花掉 $0.0002 → 第 2 轮前命中。
    expect(toolCounts.length, "工具轮 + 收尾轮").toBe(2);
    expect(toolCounts[0], "第 1 轮正常下发 tools").toBeGreaterThan(0);
    expect(toolCounts[1], "收尾轮不得下发 tools").toBe(0);
    expect(read.executed, "工具只该执行一次").toBe(1);
    expect(result.turns).toBe(1);
    expect(result.stopAction).toBe("budget_exceeded");
    expect(lastMessageTexts[1]).toContain(BUDGET_EXCEEDED_FINALIZE_PROMPT);
    // 台账记的是**累计**（工具轮 + 收尾轮），不是单轮增量。
    expect(state.getInFlightCostUSD()).toBeCloseTo(ONE_TURN_USD * 2, 8);
  });

  test("对照：不上报在途用量时，同样的阈值不会触发（差异确实来自本次上报）", async () => {
    const state = makeState();
    const tools = new ToolRegistry();
    tools.register(new CountingReadTool() as any);
    const { provider, toolCounts } = makeRecordingProvider([
      yieldToolUse("c1", "read", { file_path: "/a.ts" }),
      yieldText("## 结论\n- 正常收工"),
    ]);

    const result = await runAgentLoop({
      provider,
      model: MODEL,
      ctxMgr: makeCtxMgr(),
      tools,
      maxTurns: 10,
      signal: new AbortController().signal,
      loopDetector: new LoopDetector(),
      permissionChecker: allowAll(),
      // 判据与上面同一个（同样读预算口径），只是没有上报器 —— 等价于修复前的形态。
      preRequestBudgetStop: () =>
        state.getBudgetEffectiveCostUSD() >= THRESHOLD_USD ? quotaStop : null,
    } as any);

    expect(toolCounts.length, "没有在途量，判据读不到钱，循环照常跑完").toBe(2);
    expect(result.stopAction).toBe("finalize");
    expect(state.getBudgetEffectiveCostUSD(), "没有上报器时台账恒为 0").toBe(0);
  });

  test("上报器抛错时 fail-open：不因记账故障误杀任务", async () => {
    const tools = new ToolRegistry();
    const { provider } = makeRecordingProvider([yieldText("## 结论\n- 照常完成")]);

    const result = await runAgentLoop({
      provider,
      model: MODEL,
      ctxMgr: makeCtxMgr(),
      tools,
      maxTurns: 10,
      signal: new AbortController().signal,
      loopDetector: new LoopDetector(),
      permissionChecker: allowAll(),
      onInFlightUsage: () => {
        throw new Error("SessionState 未初始化");
      },
    } as any);

    expect(result.success).toBe(true);
    expect(result.stopAction).toBe("finalize");
  });

  test("SubAgent 把上报器透传给循环配置，并把 agentId 闭包进去", () => {
    const provider = {
      name: () => "mock",
      defaultModel: () => "mock-model",
    } as unknown as Provider;
    const seen: Array<{ agentId: string; snapshot: unknown }> = [];
    const agent = new SubAgent(provider, MODEL, new ToolRegistry());
    agent.setInFlightUsageReporter((agentId, snapshot) => seen.push({ agentId, snapshot }));

    const cfg = (agent as any).buildBaseLoopConfig(makeCtxMgr(), "agent-x");
    expect(cfg.onInFlightUsage).toBeDefined();
    cfg.onInFlightUsage({
      model: MODEL,
      provider: "openai",
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].agentId, "台账 key 必须是这个子代理的 id，否则并发时对不上").toBe("agent-x");

    // 未注入（没有预算的用户）：循环里整段上报短路。
    const plain = new SubAgent(provider, MODEL, new ToolRegistry());
    expect((plain as any).buildBaseLoopConfig(makeCtxMgr(), "agent-x").onInFlightUsage).toBe(
      undefined,
    );
  });

  test("清理挂在覆盖所有出口的 finally 上（漏清会让判据永久虚高）", () => {
    const src = readFileSync(join(import.meta.dir, "../../src/agent/sub-agent.ts"), "utf-8");
    // 内置路径与自定义路径各一处：漏一条就是那条路径上的子代理成本永远不清。
    expect(src).toContain("this.inFlightUsageReporter?.(agentId, null);");
    expect(src).toContain("this.inFlightUsageReporter?.(customAgentId, null);");
  });

  test("工厂与 app 接线成对：判据与上报器必须同时装", () => {
    const toolSrc = readFileSync(join(import.meta.dir, "../../src/agent/tool.ts"), "utf-8");
    expect(toolSrc).toContain("subAgent.setInFlightUsageReporter(this.inFlightUsageReporter)");

    const appSrc = readFileSync(join(import.meta.dir, "../../../cli/src/app.ts"), "utf-8");
    expect(appSrc).toContain("this.sessionState.getBudgetEffectiveCostUSD()");
    expect(appSrc).toContain("this.sessionState.setInFlightUsage(agentId, snapshot)");
    expect(appSrc).toContain("this.sessionState.clearInFlightUsage(agentId)");
  });
});
