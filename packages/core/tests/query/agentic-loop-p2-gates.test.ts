/**
 * Agentic Loop P2 闸门/计数器集成回归。
 *
 * 缺陷文档《20260920-AgenticLoop主循环审查-对照博客核出的缺陷》十、P2 一组：
 *   P2-2 AfterAgent `clearContext` 在闸门链**中途**清历史（清单还在、历史没了）
 *   P2-3 `stopHookRetryCount` / `hypothesisGateRetryCount` 只增不清
 *   P2-4 Token Budget 递减阈值写回 500（默认已收紧到 150）
 *   P2-5 `pause_turn` 伪装成 `tool_use` continue（既不执行也没保留 server tool 块）
 *   P2-7 F1 重试耗尽落到 `TurnComplete.stop_reason=error`
 *
 * mock 套路沿用 agentic-loop-p1-gates / unanswered-end-turn-loop。
 */
import { describe, test, expect } from "bun:test";
import { queryLoop } from "@sid-code/core/query/loop.ts";
import type { QueryLoopConfig } from "@sid-code/core/query/loop.ts";
import type { QueryDeps } from "@sid-code/core/query/types.ts";
import { Manager as ContextManager } from "@sid-code/core/context/manager.ts";
import { Registry as ToolRegistry } from "@sid-code/core/tool/registry.ts";
import { ModelFallback } from "@sid-code/core/llm/fallback.ts";
import { SessionState } from "@sid-code/core/session/state.ts";
import { HypothesisLedger } from "@sid-code/core/query/hypothesis-ledger.ts";
import { DiminishingReturnsDetector } from "@sid-code/core/query/reactive-compact.ts";
import type { Config } from "@sid-code/core/config/config.ts";
import type { AccumulatedResponse, ContentBlock, StreamEvent } from "@sid-code/core/llm/types.ts";

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    model: "claude-opus-4-8",
    provider: "anthropic",
    maxTurns: 20,
    maxTokens: 128000,
    ...overrides,
  } as unknown as Config;
}

async function* emptyStream(): AsyncIterable<StreamEvent> {
  /* processStream 被 mock */
}

function endTurnResp(text = "做完了", outputTokens = 20): AccumulatedResponse {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "end_turn",
    usage: { inputTokens: 100, outputTokens },
  } as AccumulatedResponse;
}

/** 空参数 tool_use（F1 检测的「模型退化」形态）——read 的 file_path 必填却给了 {} */
function emptyParamResp(): AccumulatedResponse {
  return {
    role: "assistant",
    content: [{ type: "tool_use", id: `call-${Math.random()}`, name: "read", input: {} }],
    stopReason: "end_turn",
    usage: { inputTokens: 100, outputTokens: 5 },
  } as AccumulatedResponse;
}

interface CapturedEvent {
  event: string;
  data: Record<string, unknown>;
}

function setup(opts: {
  responses: AccumulatedResponse[];
  depsOverrides?: Partial<QueryDeps>;
  configOverrides?: Partial<Config>;
  userText?: string;
  hookSystem?: QueryLoopConfig["hookSystem"];
  toolRegistry?: ToolRegistry;
}) {
  const events: CapturedEvent[] = [];
  const ctxMgr = new ContextManager({ maxTokens: 200000 });
  ctxMgr.setSystemPrompt("test");
  ctxMgr.addMessage({
    role: "user",
    content: [{ type: "text", text: opts.userText ?? "请完成任务" }],
  });

  let call = 0;
  const executed: Array<{ id: string; name: string }> = [];
  const deps: QueryDeps = {
    sendWithRetry: () => emptyStream(),
    processStream: async () => {
      const r = opts.responses[call] ?? endTurnResp();
      call++;
      return r;
    },
    executeTools: async (content) => {
      const tools = content.filter(
        (b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use",
      );
      for (const t of tools) executed.push({ id: t.id, name: t.name });
      return {
        results: tools.map((b) => ({
          type: "tool_result" as const,
          tool_use_id: b.id,
          content: "ok",
        })),
      };
    },
    autoCompact: async () => {},
    handleContextOverflow: () => null,
    getAbortSignal: () => undefined,
    uuid: () => `uuid-${call}`,
    traceAppendEvent: (ev) => {
      events.push({ event: ev.event, data: (ev.data ?? {}) as Record<string, unknown> });
    },
    ...opts.depsOverrides,
  };

  const loopConfig: QueryLoopConfig = {
    config: makeConfig(opts.configOverrides),
    ctxMgr,
    toolRegistry: opts.toolRegistry ?? new ToolRegistry(),
    sessionState: new SessionState("test-p2-gates"),
    fallback: new ModelFallback(),
    deps,
    ...(opts.hookSystem ? { hookSystem: opts.hookSystem } : {}),
  };
  return { loopConfig, events, ctxMgr, executed, callCount: () => call };
}

async function drain(loopConfig: QueryLoopConfig) {
  const kinds: string[] = [];
  const systemTexts: string[] = [];
  for await (const ev of queryLoop(loopConfig)) {
    kinds.push(ev.kind);
    if (ev.kind === "system" && "text" in ev) systemTexts.push((ev as { text: string }).text);
  }
  return { kinds, systemTexts };
}

/** 构造一个只实现指定方法、其余一律返回空对象的 hookSystem mock */
function mockHookSystem(impl: Record<string, unknown>): QueryLoopConfig["hookSystem"] {
  return new Proxy(impl, {
    get: (target, prop: string) => (prop in target ? target[prop] : async () => ({}) as unknown),
  }) as unknown as QueryLoopConfig["hookSystem"];
}

/** AfterAgent 请求 clearContext 的 hook 返回值 */
function afterAgentClearContext() {
  return {
    success: true,
    allOutputs: [],
    errors: [],
    finalOutput: {
      shouldClearContext: () => true,
      shouldStopExecution: () => false,
      isBlockingDecision: () => false,
      getEffectiveReason: () => "",
    },
  };
}

describe("P2-2 · AfterAgent clearContext 不得在闸门链中途清历史", () => {
  test("Stop Hook 续修 continue 时，模型面对的历史必须还在（不是空历史）", async () => {
    // 形态：AfterAgent 要求清上下文 + Stop Hook 报 blocking error 要求续修。
    // 旧实现先 clear() 再让 Stop Hook 往空历史上 addMessage → 下一轮模型几乎没有对话。
    let stopCalls = 0;
    // 每轮进入 processStream 时记一次「当前历史条数」，用来观测续命那一轮看到了什么。
    const historySizeAtEachTurn: number[] = [];

    const hookSystem = mockHookSystem({
      fireAfterAgentEvent: async () => afterAgentClearContext(),
      fireStopEvent: async () => {
        stopCalls++;
        // 第一次报 block（触发续修），第二次全通过（正常收尾）
        if (stopCalls === 1) {
          return {
            success: true,
            allOutputs: [{ decision: "block", reason: "lint 失败" }],
            errors: [],
            finalOutput: {
              shouldStopExecution: () => false,
              isBlockingDecision: () => true,
              getEffectiveReason: () => "lint 失败",
            },
          };
        }
        return { success: true, allOutputs: [{ decision: "allow" }], errors: [] };
      },
    });

    const ctxMgrRef: { current?: ContextManager } = {};
    const { loopConfig, ctxMgr } = setup({
      responses: [endTurnResp("第一版"), endTurnResp("修好了")],
      hookSystem,
      depsOverrides: {
        processStream: async () => {
          historySizeAtEachTurn.push(ctxMgrRef.current!.messageCount());
          return endTurnResp(`轮 ${historySizeAtEachTurn.length}`);
        },
      },
    });
    ctxMgrRef.current = ctxMgr;

    await drain(loopConfig);

    // 两轮都跑了（第一轮 block → continue，第二轮 allow → 收尾）
    expect(stopCalls).toBe(2);
    expect(historySizeAtEachTurn.length).toBe(2);
    // 关键断言：续命那一轮（第 2 次进 processStream）历史**没有被清空**，
    // 而是比第一轮更长（多了 assistant 回复 + Stop Hook 注入的修复提示）。
    // 旧实现这里会掉到 1（clear() 之后只剩 Stop Hook 那一条注入）。
    expect(historySizeAtEachTurn[1]).toBeGreaterThan(historySizeAtEachTurn[0]);
    // 收尾之后才执行 clearContext —— 此时历史已清。
    expect(ctxMgr.messageCount()).toBe(0);
  });

  test("没有任何门 continue 时，clearContext 照旧生效（不回归成不清）", async () => {
    const hookSystem = mockHookSystem({
      fireAfterAgentEvent: async () => afterAgentClearContext(),
    });
    const { loopConfig, ctxMgr } = setup({
      responses: [endTurnResp("一次就做完了")],
      hookSystem,
    });
    await drain(loopConfig);
    expect(ctxMgr.messageCount()).toBe(0);
  });

  test("forceStop 出口同样执行被推迟的 clearContext", async () => {
    const hookSystem = mockHookSystem({
      fireAfterAgentEvent: async () => afterAgentClearContext(),
      fireStopEvent: async () => ({
        success: true,
        allOutputs: [{ continue: false, stopReason: "preventContinuation" }],
        errors: [],
        finalOutput: {
          shouldStopExecution: () => true,
          isBlockingDecision: () => false,
          getEffectiveReason: () => "",
        },
      }),
    });
    const { loopConfig, ctxMgr } = setup({
      responses: [endTurnResp("停")],
      hookSystem,
    });
    await drain(loopConfig);
    expect(ctxMgr.messageCount()).toBe(0);
  });
});

describe("P2-3 · Stop Hook 计数器：通过即清零，耗尽仍验证", () => {
  test("失败 3 次后**仍然执行**验证（此前第 4 轮起 fireStopEvent 完全不跑）", async () => {
    // 同一条用户消息里：前 3 轮 block（各续修一次），第 4 轮仍 block。
    // 旧实现第 4 轮直接 return、不 fire → 用户配的 lint/test 从此静音。
    let stopCalls = 0;
    const hookSystem = mockHookSystem({
      fireStopEvent: async () => {
        stopCalls++;
        return {
          success: true,
          allOutputs: [{ decision: "block", reason: `第 ${stopCalls} 次仍失败` }],
          errors: [],
          finalOutput: {
            shouldStopExecution: () => false,
            isBlockingDecision: () => true,
            getEffectiveReason: () => `第 ${stopCalls} 次仍失败`,
          },
        };
      },
    });

    const { loopConfig } = setup({
      responses: Array.from({ length: 8 }, (_, i) => endTurnResp(`第 ${i + 1} 版`)),
      hookSystem,
      configOverrides: { maxTurns: 8 },
    });
    const { kinds, systemTexts } = await drain(loopConfig);

    // 3 次续修 + 第 4 次「只验证不续命」= 4 次真实调用
    expect(stopCalls).toBe(4);
    expect(kinds.filter((k) => k === "done").length).toBe(1);
    // 耗尽那次如实报告结论，而不是静默放行
    expect(systemTexts.some((t) => t.includes("自动修复已达上限") && t.includes("仍未通过"))).toBe(
      true,
    );
  });

  test("耗尽那次不再往历史注入修复提示（注入了却不 continue 是纯污染）", async () => {
    let stopCalls = 0;
    const hookSystem = mockHookSystem({
      fireStopEvent: async () => {
        stopCalls++;
        return {
          success: true,
          allOutputs: [{ decision: "block", reason: "lint 失败" }],
          errors: [],
          finalOutput: {
            shouldStopExecution: () => false,
            isBlockingDecision: () => true,
            getEffectiveReason: () => "lint 失败",
          },
        };
      },
    });
    const { loopConfig, ctxMgr } = setup({
      responses: Array.from({ length: 8 }, () => endTurnResp()),
      hookSystem,
      configOverrides: { maxTurns: 8 },
    });
    await drain(loopConfig);

    const injected = ctxMgr
      .getMessages()
      .filter(
        (m) => m.role === "user" && JSON.stringify(m.content).includes("[Stop Hook 检查失败]"),
      );
    // 只有 3 次续修注入，第 4 次（耗尽）不注入
    expect(injected.length).toBe(3);
    expect(stopCalls).toBe(4);
  });

  test("中途通过 → 计数清零，后面再失败还能重新续修满 3 次", async () => {
    // 形态：block, block, allow（清零）, 然后再 block×3 + 第 4 次仍验证。
    // 旧实现计数只增：allow 之后计数停在 2，再 block 一次就到 3 → 后面永久不再验证。
    const verdicts: Array<"block" | "allow"> = [
      "block",
      "block",
      "allow",
      "block",
      "block",
      "block",
      "block",
    ];
    let stopCalls = 0;
    const hookSystem = mockHookSystem({
      fireStopEvent: async () => {
        const v = verdicts[stopCalls] ?? "block";
        stopCalls++;
        if (v === "allow") {
          return { success: true, allOutputs: [{ decision: "allow" }], errors: [] };
        }
        return {
          success: true,
          allOutputs: [{ decision: "block", reason: "还没好" }],
          errors: [],
          finalOutput: {
            shouldStopExecution: () => false,
            isBlockingDecision: () => true,
            getEffectiveReason: () => "还没好",
          },
        };
      },
    });

    const { loopConfig, ctxMgr } = setup({
      responses: Array.from({ length: 12 }, () => endTurnResp()),
      hookSystem,
      configOverrides: { maxTurns: 12 },
    });
    await drain(loopConfig);

    // allow 那次就收尾了 → 总共 3 次调用（block, block, allow）
    expect(stopCalls).toBe(3);
    const injected = ctxMgr
      .getMessages()
      .filter(
        (m) => m.role === "user" && JSON.stringify(m.content).includes("[Stop Hook 检查失败]"),
      );
    expect(injected.length).toBe(2);
  });
});

describe("P2-3 · Hypothesis Gate 计数器：登记表结清即清零", () => {
  /**
   * 可控 ledger stub：只实现门禁读到的那几个方法。
   *
   * 用 stub 而不是真 HypothesisLedger，是因为要构造的形态是「refuted（终态、cap=1）
   * → 结清 → 又出现未结清」，而真 ledger 刻意不允许 refuted 翻案（见其 ChallengeInput
   * 注释：两个方向风险不对称）。stub 只负责喂门禁三个判据，不改门禁本身的口径。
   */
  function stubLedger(state: { settled: boolean }): HypothesisLedger {
    return {
      hasUnsettled: () => !state.settled,
      hasChallengedConfirmed: () => false,
      // 全 refuted 形态（0 open）→ 门禁 cap = 1，这是"用过一次就永久哑火"最快暴露的档。
      hasOpen: () => false,
      unsettled: () =>
        state.settled ? [] : [{ id: "H1", statement: "是缓存没命中", falsifier: "看 cache_read" }],
      challengedConfirmed: () => [],
      refutedItems: () => [],
    } as unknown as HypothesisLedger;
  }

  test("真 ledger · 全 refuted（cap=1）→ 恰好续命 1 次，不多不少", async () => {
    const ledger = new HypothesisLedger();
    const h1 = ledger.register({
      statement: "是缓存没命中导致的",
      falsifier: "看 trace 里的 cache_read 字段",
    });
    ledger.challenge({
      id: h1.id,
      verdict: "refute",
      evidence: { note: "cache_read 正常", source: "trace.jsonl:1" },
    });

    const { loopConfig, events } = setup({
      responses: Array.from({ length: 10 }, () => endTurnResp()),
      configOverrides: { maxTurns: 10 },
      depsOverrides: { getHypothesisLedger: () => ledger },
    });
    await drain(loopConfig);

    const gateRetries = events
      .filter((e) => e.event === "LoopTransition")
      .filter((e) => e.data.type === "hypothesis_gate_retry");
    expect(gateRetries.length).toBe(1);
  });

  test("清零后能再拦：结清那轮把计数清零 → 后面又出现未结清时门禁第二次响", async () => {
    // 这条是 P2-3 的正面证据，也是旧实现唯一会红的地方。
    //
    // 关键是「让轮2 真的走到 hypothesis gate 的 else 分支，且之后还能再有一轮」。
    // 续命源**必须选在 hypothesis gate 之后**的那一道门——闸门链顺序是
    //   AfterAgent → Stop Hook → unanswered → Todo → Hypothesis → Token Budget → Goal，
    // 用 unanswered 会在到达 hypothesis gate **之前**就 continue 掉（第一版这么写，
    // 于是清零分支根本没被执行，测试反而"证明"了 bug 还在）。这里改用 Token Budget
    // （"+500k"），它在 hypothesis gate 之后，能保证 else 分支先跑到。
    //
    // 时序（stub 在 processStream 里翻转 = 下一轮开头，确保上一轮门禁已读完判据）：
    //   轮1  未结清 → 门禁拦（计数 1 = cap，已满）
    //   轮2  已结清 → 门禁不响、走 else 清零 → Token Budget 续一轮
    //   轮3  又未结清 → 清零后 retries=0 < cap=1 → **必须再拦一次**
    // 旧实现轮3 的 retries 仍是 1，不小于 cap → 直接放行，总数停在 1。
    const ledgerState = { settled: false };
    const ledger = stubLedger(ledgerState);

    let turn = 0;
    const { loopConfig, events } = setup({
      responses: Array.from({ length: 12 }, () => endTurnResp()),
      configOverrides: { maxTurns: 12 },
      userText: "查清这个 bug 的根因 +500k",
      depsOverrides: {
        getHypothesisLedger: () => ledger,
        processStream: async () => {
          turn++;
          if (turn === 2) ledgerState.settled = true; // 轮2：已结清 → 门禁不响 + 清零
          if (turn === 3) ledgerState.settled = false; // 轮3：又未结清 → 应再拦
          // 输出量给足（> 递减阈值 150），避免 Token Budget 判递减提前收尾
          return endTurnResp(`轮 ${turn} 的产出`, 5000);
        },
      },
    });
    await drain(loopConfig);

    const transitions = events.filter((e) => e.event === "LoopTransition").map((e) => e.data.type);
    // 轮2 走到了 Token Budget 续写 → 证明它确实穿过了 hypothesis gate 的 else 分支
    expect(transitions).toContain("token_budget_continuation");
    // 轮1 拦 1 次 + 轮3 拦 1 次 = 2 次
    expect(transitions.filter((t) => t === "hypothesis_gate_retry").length).toBe(2);
  });

  test("一直未结清 → 计数不被清零，仍按 cap 封顶（清零不能把封顶也撤掉）", async () => {
    // 反向保险：`else` 分支只在"门禁不响"时执行。登记表一直脏的话计数必须照常累加，
    // 否则清零就变成了"门禁永远拦不满"——那是把一个哑火 bug 换成一个死循环 bug。
    const ledgerState = { settled: false };
    const ledger = stubLedger(ledgerState);

    const { loopConfig, events } = setup({
      responses: Array.from({ length: 10 }, () => endTurnResp()),
      configOverrides: { maxTurns: 10 },
      depsOverrides: { getHypothesisLedger: () => ledger },
    });
    const { kinds } = await drain(loopConfig);

    const gateRetries = events
      .filter((e) => e.event === "LoopTransition")
      .filter((e) => e.data.type === "hypothesis_gate_retry");
    expect(gateRetries.length).toBe(1); // cap=1，封顶后放行收尾
    expect(kinds.filter((k) => k === "done").length).toBe(1);
  });
});

describe("P2-4 · Token Budget 递减阈值与 max_tokens 续写对齐（150，不是 500）", () => {
  test("连续两轮输出 200 token（>150 <500）→ 不判递减，预算仍在就继续续写", async () => {
    // 旧实现阈值 500：两轮 200 token 各 <500 → 当场判递减，剩余预算全作废。
    const { loopConfig, events } = setup({
      responses: Array.from({ length: 6 }, () => endTurnResp("继续深入", 200)),
      configOverrides: { maxTurns: 6 },
      userText: "帮我重构这个模块 +500k",
    });
    const { systemTexts } = await drain(loopConfig);

    const continuations = events
      .filter((e) => e.event === "LoopTransition")
      .filter((e) => e.data.type === "token_budget_continuation");
    expect(continuations.length).toBeGreaterThanOrEqual(2);
    expect(systemTexts.some((t) => t.includes("预算续写中"))).toBe(true);
    // 没有走"产出递减"提前收尾
    expect(systemTexts.some((t) => t.includes("递减"))).toBe(false);
  });

  test("连续两轮输出 100 token（<150）→ 仍判递减收尾（阈值没被调没）", async () => {
    const { loopConfig } = setup({
      responses: Array.from({ length: 6 }, () => endTurnResp("嗯", 100)),
      configOverrides: { maxTurns: 6 },
      userText: "深入分析 +500k",
    });
    const { systemTexts, kinds } = await drain(loopConfig);
    expect(kinds.filter((k) => k === "done").length).toBe(1);
    // 第 2 轮命中递减（两次 <150）
    expect(systemTexts.some((t) => t.includes("递减") || t.includes("已充分"))).toBe(true);
  });

  test("阈值口径锚点：构造器不传 diminishingThreshold 时就是 150", () => {
    // 锁住「不再显式写回 500」这件事的语义前提。
    expect(DiminishingReturnsDetector.DIMINISHING_THRESHOLD).toBe(150);
    const d = new DiminishingReturnsDetector({ maxRecoveryCount: 1000 });
    d.record(200);
    d.record(200);
    expect(d.shouldStop()).toBe(false); // 200 > 150 → 不算递减
    const d2 = new DiminishingReturnsDetector({ maxRecoveryCount: 1000 });
    d2.record(100);
    d2.record(100);
    expect(d2.shouldStop()).toBe(true); // 100 < 150 → 递减
  });
});

describe("P2-5 · pause_turn 不得伪装成 tool_use continue", () => {
  test("pause_turn → 如实收尾，且不记 LoopTransition(type=tool_use)", async () => {
    const pauseResp = {
      role: "assistant",
      content: [{ type: "text", text: "正在搜索…" }],
      stopReason: "pause_turn",
      usage: { inputTokens: 100, outputTokens: 10 },
    } as AccumulatedResponse;

    const { loopConfig, events, executed } = setup({
      responses: [pauseResp, endTurnResp()],
      configOverrides: { maxTurns: 6 },
    });
    const { kinds, systemTexts } = await drain(loopConfig);

    // 收尾一次，不再靠 continue 空转
    expect(kinds.filter((k) => k === "done").length).toBe(1);
    // 没有工具真的被执行过（旧实现记成 tool_use 却一个工具都没跑）
    expect(executed.length).toBe(0);
    // 关键断言：不再有伪装的 tool_use 转移
    const transitions = events.filter((e) => e.event === "LoopTransition").map((e) => e.data.type);
    expect(transitions).not.toContain("tool_use");
    // 用户能看到本轮为何提前收尾
    expect(
      systemTexts.some((t) => t.includes("未识别的停止原因") || t.includes("pause_turn")),
    ).toBe(true);
  });

  test("pause_turn 只消耗一轮，不会一路 continue 到 maxTurns", async () => {
    const pauseResp = () =>
      ({
        role: "assistant",
        content: [{ type: "text", text: "暂停" }],
        stopReason: "pause_turn",
        usage: { inputTokens: 100, outputTokens: 10 },
      }) as AccumulatedResponse;

    const { loopConfig, callCount } = setup({
      responses: Array.from({ length: 10 }, pauseResp),
      configOverrides: { maxTurns: 10 },
    });
    await drain(loopConfig);
    // 旧实现：每轮 continue → 打满 10 轮。现在第一轮就收尾。
    expect(callCount()).toBe(1);
  });
});

describe("P2-7 · F1 重试耗尽的遥测归因不得落到 error", () => {
  test("空参数重试耗尽 → TurnComplete.stop_reason = other（不是 error）", async () => {
    // toolRegistry 里注册一个 file_path 必填的工具，让 F1 判定「真退化」而非「本就无必填参数」
    const registry = new ToolRegistry();
    registry.register({
      name: () => "read",
      description: () => "读文件",
      inputSchema: () => ({
        type: "object",
        properties: { file_path: { type: "string" } },
        required: ["file_path"],
      }),
      readOnly: () => true,
      execute: async () => ({ output: "ok" }),
    } as never);

    const { loopConfig, events } = setup({
      responses: Array.from({ length: 8 }, () => emptyParamResp()),
      configOverrides: { maxTurns: 8 },
      toolRegistry: registry,
    });
    const { kinds, systemTexts } = await drain(loopConfig);

    expect(kinds.filter((k) => k === "done").length).toBe(1);
    expect(systemTexts.some((t) => t.includes("工具调用参数持续为空"))).toBe(true);

    const tcs = events.filter((e) => e.event === "TurnComplete");
    expect(tcs.length).toBe(1);
    // 旧实现不赋值 → finally 兜底归 "error"，把模型退化混进错误率样本。
    expect(tcs[0].data.stop_reason).toBe("other");
  });
});
