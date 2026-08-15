/**
 * P1-4：`TurnComplete` 端到端耗时锚点 —— 集成 + 单元测试
 *
 * 「更快」方向的主口径是端到端耗时（用户回车 → 最终答复），此前没有任何埋点直接记它：
 * TTFT + 生成耗时相加**也不等于**端到端（中间还有工具往返、JIT 注入、权限确认、重试）。
 * 从事件派生也做不到 —— `LoopTransition` 只在"继续循环"时发，而轮次结束是退出循环，
 * 实测它的 `type` 只有 4 个取值、**没有 end_turn**，于是最重要的时刻反而没有锚点。
 *
 * 本文件的每条测试都对应方案 §三.4 的一条验收，其中三条是**防具体回归**的，不可删：
 *
 * 1. **ESC 中断的轮次也必须发事件**（`stop_reason === "abort"`）。
 *    不发会造成"只有成功轮次进统计"的选择偏差 —— 而被中断的往往正是最慢的轮次，
 *    漏掉它们会让 p95 系统性偏低，看起来"变快了"其实是把慢样本筛掉了。
 * 2. **第二轮的耗时不含第一轮**。TTFT 已经栽过一次完全同形态的坑：基准设在重试循环
 *    之外、不重设，让 thinking 模型的首字节虚高数十秒（实测合成 53.7s vs 真实 4.9s）。
 *    结构上"应该没问题"拦不住回归，必须有断言锁住。
 * 3. **一轮多次工具调用只发一个事件**，且 `tool_calls_in_turn` 计的是**实际派发数**。
 *    queryLoop 有 20+ 个 `yield done; return` 出口，幂等位一旦失效就会重复计数，
 *    而端到端样本本就比 TTFT 少一个数量级，重复一次就能明显偏移分位数。
 */

import { describe, test, expect } from "bun:test";
import { queryLoop } from "@sid-code/core/query/loop.ts";
import type { QueryLoopConfig } from "@sid-code/core/query/loop.ts";
import type { QueryDeps } from "@sid-code/core/query/types.ts";
import { createInitialLoopState } from "@sid-code/core/query/types.ts";
import {
  beginTurn,
  emitTurnComplete,
  normalizeTurnStopReason,
  recordHitlPrompt,
  readHitlPromptCount,
  HITL_PROMPT_COUNT_KEY,
} from "@sid-code/core/query/turn-complete.ts";
import { Manager as ContextManager } from "@sid-code/core/context/manager.ts";
import { Registry as ToolRegistry } from "@sid-code/core/tool/registry.ts";
import { ModelFallback } from "@sid-code/core/llm/fallback.ts";
import { SessionState } from "@sid-code/core/session/state.ts";
import { toAbortError } from "@sid-code/core/llm/errors.ts";
import { aggregateSessionMetrics } from "@sid-code/core/trace/digest.ts";
import type { Config } from "@sid-code/core/config/config.ts";
import type { AccumulatedResponse, ContentBlock, StreamEvent } from "@sid-code/core/llm/types.ts";

// ─── helpers ───

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    model: "claude-opus-4-8",
    provider: "anthropic",
    maxTurns: 10,
    maxTokens: 128000,
    ...overrides,
  } as unknown as Config;
}

async function* emptyStream(): AsyncIterable<StreamEvent> {
  /* processStream 被 mock，此处不产事件 */
}

function endTurnResp(text = "做完了"): AccumulatedResponse {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "end_turn",
    usage: { inputTokens: 100, outputTokens: 20 },
  } as AccumulatedResponse;
}

/** 一次响应里带 n 个 tool_use（用于验 tool_calls_in_turn） */
function toolUseResp(n: number): AccumulatedResponse {
  const blocks: ContentBlock[] = [{ type: "text", text: "我来执行工具" }];
  for (let i = 0; i < n; i++) {
    blocks.push({ type: "tool_use", id: `call-${i}`, name: "bash", input: { command: "ls" } });
  }
  return {
    role: "assistant",
    content: blocks,
    stopReason: "tool_use",
    usage: { inputTokens: 100, outputTokens: 20 },
  } as AccumulatedResponse;
}

interface CapturedEvent {
  event: string;
  session_id: string;
  data: Record<string, unknown>;
}

function setup(opts: {
  responses: AccumulatedResponse[];
  depsOverrides?: Partial<QueryDeps>;
  configOverrides?: Partial<Config>;
  sessionState?: SessionState;
}) {
  const events: CapturedEvent[] = [];
  const ctxMgr = new ContextManager({ maxTokens: 200000 });
  ctxMgr.setSystemPrompt("test");
  ctxMgr.addMessage({ role: "user", content: [{ type: "text", text: "请完成任务" }] });

  let call = 0;
  const deps: QueryDeps = {
    sendWithRetry: () => emptyStream(),
    processStream: async () => {
      const r = opts.responses[call] ?? endTurnResp();
      call++;
      return r;
    },
    // 每个 tool_use 都回一个 tool_result，保持协议配对
    executeTools: async (content) => ({
      results: content
        .filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use")
        .map((b) => ({ type: "tool_result" as const, tool_use_id: b.id, content: "ok" })),
    }),
    autoCompact: async () => {},
    handleContextOverflow: () => null,
    getAbortSignal: () => undefined,
    uuid: () => `uuid-${call}`,
    traceAppendEvent: (ev) => {
      events.push({
        event: ev.event,
        session_id: ev.session_id,
        data: (ev.data ?? {}) as Record<string, unknown>,
      });
    },
    ...opts.depsOverrides,
  };

  const loopConfig: QueryLoopConfig = {
    config: makeConfig(opts.configOverrides),
    ctxMgr,
    toolRegistry: new ToolRegistry(),
    sessionState: opts.sessionState ?? new SessionState("test-turn-complete"),
    fallback: new ModelFallback(),
    deps,
  };
  return { loopConfig, events, ctxMgr, sessionState: loopConfig.sessionState };
}

async function drain(loopConfig: QueryLoopConfig): Promise<string[]> {
  const kinds: string[] = [];
  for await (const ev of queryLoop(loopConfig)) kinds.push(ev.kind);
  return kinds;
}

function turnCompletes(events: CapturedEvent[]): Array<Record<string, unknown>> {
  return events.filter((e) => e.event === "TurnComplete").map((e) => e.data);
}

// ─── 集成：事件发射与字段 ───

describe("P1-4 · TurnComplete 事件发射", () => {
  test("一轮 3 次工具调用 + 1 次 end_turn → 恰好 1 个事件，tool_calls_in_turn === 3", async () => {
    // 方案 §三.4 第 1 条验收。"一轮"= 一条用户消息（一次 queryLoop 调用），
    // 而不是一次 API 往返 —— 端到端口径的粒度就是"用户回车 → 最终答复"。
    const { loopConfig, events } = setup({
      responses: [toolUseResp(3), endTurnResp()],
    });

    await drain(loopConfig);

    const tcs = turnCompletes(events);
    expect(tcs.length).toBe(1);
    expect(tcs[0].tool_calls_in_turn).toBe(3);
    expect(tcs[0].stop_reason).toBe("end_turn");
  });

  test("事件不复用 LoopTransition —— 两者是独立事件名", async () => {
    // 复用 LoopTransition 会让所有现有消费方的 type 分支需要重新审视
    //（digest.ts 已在按 type === "todo_gate_retry" 过滤），所以刻意另开事件名。
    const { loopConfig, events } = setup({ responses: [toolUseResp(1), endTurnResp()] });

    await drain(loopConfig);

    const names = new Set(events.map((e) => e.event));
    expect(names.has("TurnComplete")).toBe(true);
    // LoopTransition 仍在正常发（tool_use continue），两者并存互不干扰
    expect(names.has("LoopTransition")).toBe(true);
    // 且 LoopTransition 的 type 里绝不该出现"结束"语义的值
    const transitionTypes = events
      .filter((e) => e.event === "LoopTransition")
      .map((e) => e.data.type);
    expect(transitionTypes).not.toContain("end_turn");
  });

  test("elapsed_ms_since_prompt 落在事件里（消费侧不做配对）", async () => {
    const { loopConfig, events } = setup({ responses: [endTurnResp()] });

    await drain(loopConfig);

    const tc = turnCompletes(events)[0];
    // 当场算好的差值，不是留给消费侧配对的两个时间戳
    expect(typeof tc.elapsed_ms_since_prompt).toBe("number");
    expect(tc.elapsed_ms_since_prompt as number).toBeGreaterThanOrEqual(0);
    // 三口径一起落，便于把 turn 回绕还原到具体哪条用户消息
    expect(typeof tc.turn).toBe("number");
    expect(typeof tc.absoluteTurn).toBe("number");
    expect(typeof tc.promptSeq).toBe("number");
  });

  test("【不可省】ESC 中断的轮次也发事件，stop_reason === abort", async () => {
    // 方案 §三.4 第 2 条验收。不发会造成"只有成功轮次进统计"的选择偏差：
    // 被中断的往往正是最慢的轮次，漏掉它们让 p95 系统性偏低。
    const aborter = new AbortController();
    aborter.abort();

    const { loopConfig, events } = setup({
      responses: [toolUseResp(1)],
      depsOverrides: { getAbortSignal: () => aborter.signal },
    });

    await drain(loopConfig);

    const tcs = turnCompletes(events);
    expect(tcs.length).toBe(1);
    expect(tcs[0].stop_reason).toBe("abort");
  });

  test("【不可省】executeTools 抛 AbortError 的轮次也发事件，stop_reason === abort", async () => {
    // abort 有两条路径（流式后检测 / 工具执行期抛），两条都必须发 —— 只覆盖一条
    // 等于让另一条继续制造选择偏差。
    const aborter = new AbortController();
    const { loopConfig, events } = setup({
      responses: [toolUseResp(1)],
      depsOverrides: {
        getAbortSignal: () => aborter.signal,
        executeTools: async () => {
          aborter.abort(); // 工具执行期间用户按下 ESC
          throw toAbortError();
        },
      },
    });

    await drain(loopConfig);

    const tcs = turnCompletes(events);
    expect(tcs.length).toBe(1);
    expect(tcs[0].stop_reason).toBe("abort");
  });

  test("processStream 抛非 abort 异常穿透时也发事件，stop_reason === error", async () => {
    // 异常穿透是真实存在的退出路径。不发事件则"跑挂了的那些轮"全部不进统计，
    // 与 abort 那条是同一种偏差。
    const { loopConfig, events } = setup({
      responses: [],
      depsOverrides: {
        processStream: async () => {
          throw new Error("网关 500");
        },
      },
    });

    await expect(drain(loopConfig)).rejects.toThrow();

    const tcs = turnCompletes(events);
    expect(tcs.length).toBe(1);
    expect(tcs[0].stop_reason).toBe("error");
  });

  test("达到 maxTurns 时发事件，stop_reason === max_turns，且耗时含强制总结轮", async () => {
    // 强制总结轮跑在 try 之外，若在 finally 就发事件会漏掉它整段耗时 ——
    // 而强制总结恰好只发生在最长的那些轮次上，漏掉等于系统性低估最慢样本。
    let summaryStarted = 0;
    const { loopConfig, events } = setup({
      // maxTurns=1 且首轮就 tool_use → 循环退出后进强制总结
      responses: [toolUseResp(1)],
      configOverrides: { maxTurns: 1 },
      depsOverrides: {
        processStream: async () => {
          summaryStarted++;
          if (summaryStarted > 1) {
            // 强制总结轮：故意慢一点，好让"漏算它"能被时间断言抓到
            await new Promise((r) => setTimeout(r, 30));
            return endTurnResp("这是强制总结");
          }
          return toolUseResp(1);
        },
      },
    });

    await drain(loopConfig);

    const tcs = turnCompletes(events);
    expect(tcs.length).toBe(1);
    expect(tcs[0].stop_reason).toBe("max_turns");
    // 强制总结轮确实跑过（否则本条断言测不到它想测的东西）
    expect(summaryStarted).toBeGreaterThan(1);
    // 耗时必须覆盖到总结轮的 30ms —— 若事件在 finally 就发了，这里会明显偏小
    expect(tcs[0].elapsed_ms_since_prompt as number).toBeGreaterThanOrEqual(30);
  });

  test("【不可省】第二轮的 elapsed 不含第一轮耗时（防基准不重设）", async () => {
    // 方案 §三.4 第 3 条验收。TTFT 栽过完全同形态的坑：基准设在重试循环之外、
    // 不重设，让 thinking 模型的首字节虚高数十秒。这里两次 queryLoop 调用之间
    // 隔一段可观测的墙钟，若基准不重设，第二次的耗时会把这段也算进去。
    const shared = new SessionState("test-two-prompts");

    const first = setup({ responses: [endTurnResp()], sessionState: shared });
    await drain(first.loopConfig);
    const firstElapsed = turnCompletes(first.events)[0].elapsed_ms_since_prompt as number;

    // 模拟"用户看完第一轮答复，思考 80ms 后才发第二条消息"
    await new Promise((r) => setTimeout(r, 80));

    const second = setup({ responses: [endTurnResp()], sessionState: shared });
    await drain(second.loopConfig);
    const secondElapsed = turnCompletes(second.events)[0].elapsed_ms_since_prompt as number;

    // 第二轮本身几乎不耗时（mock 立即返回），所以它必须远小于"用户思考的 80ms"。
    // 基准不重设的话，secondElapsed 会 >= 80 + firstElapsed。
    expect(secondElapsed).toBeLessThan(80);
    expect(secondElapsed).toBeLessThan(firstElapsed + 80);
  });
});

// ─── HITL 标记 ───

describe("P1-4 · had_hitl 口径", () => {
  test("无权限确认的轮次 had_hitl === false", async () => {
    const { loopConfig, events } = setup({ responses: [endTurnResp()] });
    await drain(loopConfig);
    expect(turnCompletes(events)[0].had_hitl).toBe(false);
  });

  test("轮内发生过权限弹窗 → had_hitl === true（按前后差值判定，不是累计标志）", async () => {
    // 用布尔标志会让"某轮弹过窗"之后的每一轮都被误标成有 HITL，所以实现走
    // "轮首快照计数 + 轮末比较"。这里在工具执行期间递增计数来模拟弹窗。
    const shared = new SessionState("test-hitl");
    const { loopConfig, events } = setup({
      responses: [toolUseResp(1), endTurnResp()],
      sessionState: shared,
      depsOverrides: {
        executeTools: async (content) => {
          recordHitlPrompt(shared); // 等价于 tool-executor 里 logPermissionPrompt 那一刻
          return {
            results: content
              .filter(
                (b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use",
              )
              .map((b) => ({ type: "tool_result" as const, tool_use_id: b.id, content: "ok" })),
          };
        },
      },
    });

    await drain(loopConfig);

    expect(turnCompletes(events)[0].had_hitl).toBe(true);
  });

  test("上一条消息弹过窗、本条没弹 → 本条 had_hitl === false（差值语义的核心）", async () => {
    const shared = new SessionState("test-hitl-carryover");
    recordHitlPrompt(shared); // 上一条用户消息里弹过一次
    expect(readHitlPromptCount(shared)).toBe(1);

    const { loopConfig, events } = setup({ responses: [endTurnResp()], sessionState: shared });
    await drain(loopConfig);

    // 累计计数仍是 1（没清零），但本轮没有新增 → 不该被标成有 HITL
    expect(readHitlPromptCount(shared)).toBe(1);
    expect(turnCompletes(events)[0].had_hitl).toBe(false);
  });

  test("计数器挂 SessionState 且键名固定（跨用户消息持久）", () => {
    const ss = new SessionState("test-hitl-key");
    recordHitlPrompt(ss);
    recordHitlPrompt(ss);
    // 直接按键名读到，说明它挂在 SessionState 而不是每条消息重建的 LoopState 上
    expect(ss.get(HITL_PROMPT_COUNT_KEY)).toBe(2);
  });
});

// ─── 单元：归一化与幂等 ───

describe("P1-4 · stop_reason 归一化", () => {
  test("end_turn / stop / stop_sequence 三值同归 end_turn", () => {
    expect(normalizeTurnStopReason("end_turn")).toBe("end_turn");
    expect(normalizeTurnStopReason("stop")).toBe("end_turn");
    expect(normalizeTurnStopReason("stop_sequence")).toBe("end_turn");
  });

  test("未识别值一律 other，绝不静默当成正常收尾", () => {
    // 宁可归 other 也不能把未知的新协议值当 end_turn —— 那会让"提前收尾"
    // 混进正常样本，掩盖真实故障（对齐 loop.ts 白名单 fail-closed 的方向）。
    expect(normalizeTurnStopReason("max_tokens")).toBe("other");
    expect(normalizeTurnStopReason("refusal")).toBe("other");
    expect(normalizeTurnStopReason(null)).toBe("other");
    expect(normalizeTurnStopReason(undefined)).toBe("other");
    expect(normalizeTurnStopReason("某个未来才有的值")).toBe("other");
  });
});

describe("P1-4 · emitTurnComplete 幂等与降级", () => {
  test("同一 state 重复调用只发一次（防 20+ 出口重复计数）", () => {
    const events: Array<Record<string, unknown>> = [];
    const state = createInitialLoopState(10);
    const ss = new SessionState("test-idem");
    beginTurn(state, ss);
    const deps = { traceAppendEvent: (ev: any) => events.push(ev) };
    const args = {
      sessionId: "s1",
      absoluteTurn: 1,
      promptSeq: 1,
      stopReason: "end_turn" as const,
      toolCallsInTurn: 0,
    };

    emitTurnComplete(state, ss, deps, args);
    emitTurnComplete(state, ss, deps, args);
    emitTurnComplete(state, ss, deps, args);

    expect(events.length).toBe(1);
  });

  test("beginTurn 清零幂等位，否则每会话只会有 1 个样本", () => {
    // 这条防的是"幂等位忘了清零"这个失效形态：它不会报错，只会让样本数
    // 悄悄退化成每会话 1 个 —— 比没有埋点更难发现。
    const events: Array<Record<string, unknown>> = [];
    const state = createInitialLoopState(10);
    const ss = new SessionState("test-reset");
    const deps = { traceAppendEvent: (ev: any) => events.push(ev) };
    const args = {
      sessionId: "s1",
      absoluteTurn: 1,
      promptSeq: 1,
      stopReason: "end_turn" as const,
      toolCallsInTurn: 0,
    };

    beginTurn(state, ss);
    emitTurnComplete(state, ss, deps, args);
    beginTurn(state, ss); // 新一条用户消息
    emitTurnComplete(state, ss, deps, args);

    expect(events.length).toBe(2);
  });

  test("未接 traceAppendEvent 时静默不抛（采集永不阻塞主循环）", () => {
    const state = createInitialLoopState(10);
    const ss = new SessionState("test-no-sink");
    beginTurn(state, ss);
    expect(() =>
      emitTurnComplete(
        state,
        ss,
        {},
        {
          sessionId: "s1",
          absoluteTurn: 1,
          promptSeq: 1,
          stopReason: "end_turn",
          toolCallsInTurn: 0,
        },
      ),
    ).not.toThrow();
  });

  test("traceAppendEvent 抛错时静默吞掉，不影响主循环", () => {
    const state = createInitialLoopState(10);
    const ss = new SessionState("test-throwing-sink");
    beginTurn(state, ss);
    expect(() =>
      emitTurnComplete(
        state,
        ss,
        {
          traceAppendEvent: () => {
            throw new Error("磁盘满");
          },
        },
        {
          sessionId: "s1",
          absoluteTurn: 1,
          promptSeq: 1,
          stopReason: "end_turn",
          toolCallsInTurn: 0,
        },
      ),
    ).not.toThrow();
  });

  test("基准缺失时不落 elapsed 字段（落 0 会被读成 0 毫秒）", () => {
    const events: Array<any> = [];
    const state = createInitialLoopState(10);
    // 刻意不调 beginTurn → turnStartedAtMs 缺失
    emitTurnComplete(
      state,
      undefined,
      { traceAppendEvent: (ev: any) => events.push(ev) },
      {
        sessionId: "s1",
        absoluteTurn: 1,
        promptSeq: 1,
        stopReason: "other",
        toolCallsInTurn: 0,
      },
    );

    expect(events.length).toBe(1);
    expect("elapsed_ms_since_prompt" in events[0].data).toBe(false);
  });
});

// ─── 消费侧：分位数与口径自洽 ───

describe("P1-4 · digest 端到端分位数", () => {
  test("从 TurnComplete 算出 p50/p95/p99 与 n", () => {
    const events = [
      { event: "TurnComplete", data: { elapsed_ms_since_prompt: 1000, had_hitl: false } },
      { event: "TurnComplete", data: { elapsed_ms_since_prompt: 2000, had_hitl: false } },
      { event: "TurnComplete", data: { elapsed_ms_since_prompt: 3000, had_hitl: false } },
      { event: "TurnComplete", data: { elapsed_ms_since_prompt: 9000, had_hitl: false } },
    ];
    const m = aggregateSessionMetrics(events, { trajCorrupt: false });

    expect(m.e2e_n).toBe(4);
    expect(m.e2e_p50).toBe(2000);
    expect(m.e2e_p95).toBe(9000);
    expect(m.e2e_p99).toBe(9000);
  });

  test("had_hitl 样本单独计数，且分子不超过分母", () => {
    const events = [
      { event: "TurnComplete", data: { elapsed_ms_since_prompt: 1000, had_hitl: true } },
      { event: "TurnComplete", data: { elapsed_ms_since_prompt: 2000, had_hitl: false } },
      // 无有效耗时的事件既不进分母、也不该进分子
      { event: "TurnComplete", data: { elapsed_ms_since_prompt: 0, had_hitl: true } },
    ];
    const m = aggregateSessionMetrics(events, { trajCorrupt: false });

    expect(m.e2e_n).toBe(2);
    expect(m.e2e_hitl_n).toBe(1);
    expect(m.e2e_hitl_n).toBeLessThanOrEqual(m.e2e_n);
  });

  test("无 TurnComplete 时 n=0 且分位数为 undefined（不是 0）", () => {
    // PR-4 之前的历史轨迹就是这个形态。落 0 会被读成"端到端 0 毫秒"。
    const m = aggregateSessionMetrics([{ event: "AfterModelRaw", data: { elapsed_ms: 500 } }], {
      trajCorrupt: false,
    });
    expect(m.e2e_n).toBe(0);
    expect(m.e2e_p50).toBeUndefined();
    expect(m.e2e_p95).toBeUndefined();
    expect(m.e2e_hitl_n).toBe(0);
  });

  test("【口径自证】真实会话里 e2e_p50 >= ttft_p50", async () => {
    // 端到端必然 ≥ 首字节。这个不变量若被违反，说明两个口径的基准点不一致 ——
    // 比数值本身更值得断言（TTFT 曾因基准不重设而虚高）。
    // 这里用真跑一轮 queryLoop 产出的 TurnComplete，配一个必然更小的 TTFT 样本。
    const { loopConfig, events } = setup({
      responses: [toolUseResp(1), endTurnResp()],
      depsOverrides: {
        processStream: async () => {
          await new Promise((r) => setTimeout(r, 20));
          return endTurnResp();
        },
      },
    });
    await drain(loopConfig);

    const tc = turnCompletes(events)[0];
    const merged = [
      { event: "StreamPhase", data: { phase: "first_content", ttft_ms: 5 } },
      { event: "TurnComplete", data: tc },
    ];
    const m = aggregateSessionMetrics(merged, { trajCorrupt: false });

    expect(m.ttft_n).toBe(1);
    expect(m.e2e_n).toBe(1);
    expect(m.e2e_p50!).toBeGreaterThanOrEqual(m.ttft_p50!);
  });
});
