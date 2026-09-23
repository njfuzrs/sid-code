/**
 * Agentic Loop P3 一组：死接线 / 口径漂移 / 可观测配对。
 *
 * 缺陷文档《20260920-AgenticLoop主循环审查-对照博客核出的缺陷》十一、P3 一组：
 *   P3-1 `ContinueReason.goal_budget_warning` 类型在、生产零 `setTransition`
 *   P3-2 `StopHookOrchestrator` / `getMaxStopHookRetries` 死接线（与 live 语义相反）
 *   P3-4 `types.ts` 注释写「每轮 beginTurn」，实现只在入口调一次
 *   P3-5 stream-processor 心跳与 watchdog 同值 720s（谓词不同的伪阶梯）
 *
 * （P3-3 子代理总结轮剥离、P3-6 TimeoutFired 身份在
 *  `agentic-loop-p3-subagent-summary.test.ts`。）
 *
 * 这一组多为"类型在/接线不在"与"注释与实现相反"，所以断言形态与 P1/P2 不同：
 * 除了跑循环看事件，还有几条**源码形态断言**与**闭集同步断言** —— 那是这类缺陷
 * 唯一拦得住的方式（一个零调用的类不会让任何测试变红，正是它能活下来的原因）。
 *
 * fix_type: case_design
 */
import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { queryLoop } from "@sid-code/core/query/loop.ts";
import type { QueryLoopConfig } from "@sid-code/core/query/loop.ts";
import type { QueryDeps } from "@sid-code/core/query/types.ts";
import { Manager as ContextManager } from "@sid-code/core/context/manager.ts";
import { Registry as ToolRegistry } from "@sid-code/core/tool/registry.ts";
import { ModelFallback } from "@sid-code/core/llm/fallback.ts";
import { SessionState } from "@sid-code/core/session/state.ts";
import { createGoal } from "@sid-code/core/goal/state.ts";
import { handleGoalGate } from "@sid-code/core/query/goal-gate.ts";
import { DEFAULTS, PROVIDER_STREAM_DEFAULTS } from "@sid-code/core/config/network-profile.ts";
import { BlockedDetector } from "@sid-code/core/goal/blocked-detector.ts";
import type { Config } from "@sid-code/core/config/config.ts";
import type { AccumulatedResponse, StreamEvent } from "@sid-code/core/llm/types.ts";

const SRC = join(import.meta.dir, "../../src");

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

interface CapturedEvent {
  event: string;
  data: Record<string, unknown>;
}

function setup(opts: {
  responses: AccumulatedResponse[];
  depsOverrides?: Partial<QueryDeps>;
  configOverrides?: Partial<Config>;
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
    executeTools: async () => ({ results: [] }),
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
    toolRegistry: new ToolRegistry(),
    sessionState: new SessionState("test-p3"),
    fallback: new ModelFallback(),
    deps,
  };
  return { loopConfig, events, ctxMgr };
}

async function drain(loopConfig: QueryLoopConfig) {
  const kinds: string[] = [];
  for await (const ev of queryLoop(loopConfig)) kinds.push(ev.kind);
  return { kinds };
}

/** 取 LoopTransition 的 type 序列 */
function transitions(events: CapturedEvent[]): string[] {
  return events.filter((e) => e.event === "LoopTransition").map((e) => String(e.data.type));
}

describe("P3-1 · goal_budget_warning 必须有生产接线（此前全仓零 setTransition）", () => {
  /**
   * 预算 warning 档 = 已用 ≥85% 且 <100%。tokenBudget=100000、tokensUsed 起点 86000，
   * 于是 accumulate 后仍在 [0.85, 1.0) 区间内 → warning。
   * `goal.minTurnsBeforeEval` 拉到 99，让每轮都走「跳过评估直接 continue」那条分支 ——
   * 不拉高的话第 3 轮起会去调真实评估器（走网络，实测 5s 超时）。
   *
   * ⚠️ 写这组用例时踩到的坑，留给后人：**不要**用「`getProviderForModel` 抛错」来
   * 断言评估器没被调用。`loop.ts` 在 `handleGoalGate` **之前**就无条件解析 provider，
   * 而整个 Goal Gate 块套在 `try/catch`（"Goal Gate 不得阻断主循环"）里 —— 抛错会被
   * 静默吞掉，于是 transition **一条都不发**，测试红得像"修复没生效"，
   * 真因却是测试自己把闸门打死了。P1 那组用例能这么写，是因为它们断言的正是
   * "forceStop 必须在解析 provider 之前就 return"。
   */
  test("预算进入 warning 档且 continue 时，transition 记 goal_budget_warning", async () => {
    const goal = createGoal("审计这个仓库", { maxTurns: 150, tokenBudget: 100000 });
    goal.tokensUsed = 86000; // 86% → warning 档

    const { loopConfig, events } = setup({
      // 输出很小，保证累加后不越过 100%（越过就变 exceeded，走的是另一条 return）
      responses: Array.from({ length: 6 }, () => endTurnResp("阶段性结论", 5)),
      // minTurnsBeforeEval 拉高：让每一轮都走「前 N 轮跳过评估」那条 continue。
      // 目的是把本用例**只**压在"续跑时记哪个 reason"这一件事上 —— 不拉高的话
      // 第 3 轮起会去调真实评估器（走网络，实测直接 5s 超时）。
      configOverrides: { maxTurns: 6, goal: { minTurnsBeforeEval: 99 } } as Partial<Config>,
      depsOverrides: {
        getGoalState: () => goal,
        updateGoalState: (fn) => fn(goal),
      },
    });

    await drain(loopConfig);

    const ts = transitions(events);
    // 核心断言：这个变体必须真的出现过。改回 `{ type: "goal_gate_retry" }` 即红。
    expect(ts).toContain("goal_budget_warning");
    // 且必须**替换**而非追加：同一次 continue 不得两条都记，否则"按 type 数续跑次数"
    // 的分母凭空多一份（分母口径一变，曲线整体平移）。
    expect(ts.filter((t) => t === "goal_gate_retry").length).toBe(0);
  });

  test("未设预算时仍记 goal_gate_retry（不误把普通续跑标成告警）", async () => {
    const goal = createGoal("审计这个仓库", { maxTurns: 150 }); // 无 tokenBudget

    const { loopConfig, events } = setup({
      responses: Array.from({ length: 4 }, () => endTurnResp("阶段性结论", 5)),
      // 同上：压在「跳过评估直接 continue」那条路径上，不触发真实评估器。
      configOverrides: { maxTurns: 4, goal: { minTurnsBeforeEval: 99 } } as Partial<Config>,
      depsOverrides: {
        getGoalState: () => goal,
        updateGoalState: (fn) => fn(goal),
      },
    });

    await drain(loopConfig);

    const ts = transitions(events);
    expect(ts).toContain("goal_gate_retry");
    // 反向锁：无预算时 checkGoalBudget 恒返回 "ok"，不该出现告警变体。
    expect(ts).not.toContain("goal_budget_warning");
  });

  test("handleGoalGate 把 budgetWarning 带出到 shouldContinue=true 的返回", async () => {
    // 单元层直接验字段：loop 侧靠它换 reason，漏带一条就是那条路径上的告警丢失。
    const goal = createGoal("目标", { maxTurns: 150, tokenBudget: 100000 });
    goal.tokensUsed = 86000;
    const out = await handleGoalGate({
      goal,
      messages: [],
      turnUsage: { inputTokens: 10, outputTokens: 5, cacheCreationTokens: 0 },
      // minTurnsBeforeEval=2 > goal.turnsUsed=0 → 走「前 N 轮跳过评估」那条 continue
      evalConfig: { minTurnsBeforeEval: 2 } as never,
      blockedDetector: new BlockedDetector(),
    });
    expect(out.result.shouldContinue).toBe(true);
    expect(out.result.budgetWarning).toBe(true);
    // 告警文案本来就在注入（这部分从来没坏），一并锁住避免"修接线时把文案弄丢"。
    expect(out.injectMessages.length).toBeGreaterThan(0);
    expect(out.systemMessages.some((m) => m.text.includes("预算预警"))).toBe(true);
  });

  test("ContinueReason 闭集里每个变体都有生产引用（反漂移）", () => {
    // 这条是 P3-1 的**通用形态**锁：再出现一个"类型在、接线不在"的变体就会红。
    // 取数方式刻意用源码扫描而不是跑循环 —— 死变体的定义就是"任何运行时都走不到"。
    const typesSrc = readFileSync(join(SRC, "query/types.ts"), "utf8");
    const block = typesSrc.slice(
      typesSrc.indexOf("export type ContinueReason"),
      typesSrc.indexOf("// ─── 循环状态 ───"),
    );
    const variants = [...block.matchAll(/\{ type: "([a-z_]+)" \}/g)].map((m) => m[1]);
    expect(variants.length).toBeGreaterThanOrEqual(15);

    const loopSrc = readFileSync(join(SRC, "query/loop.ts"), "utf8");
    const unwired = variants.filter((v) => !loopSrc.includes(`"${v}"`));
    expect(
      unwired,
      `这些 ContinueReason 变体在 types.ts 有定义但 loop.ts 零引用（死类型）：${unwired.join(", ")}`,
    ).toEqual([]);
  });
});

describe("P3-2 · Stop 语义只许有一份实现", () => {
  test("死编排器文件已删除（它的耗尽语义与 live 相反）", () => {
    // 编排器耗尽 → preventContinuation: true（强制停）；
    // live（stop-hooks.ts）耗尽 → forceStop: false（放行并如实呈现）。
    // 谁把它接进 loop，Stop 耗尽就会从「放行」翻成「强制停」，且不会有任何东西报错。
    expect(existsSync(join(SRC, "hook/stop-hook-orchestrator.ts"))).toBe(false);
  });

  test("hook/index.ts 不再再导出编排器（再导出是它唯一的对外面）", () => {
    const src = readFileSync(join(SRC, "hook/index.ts"), "utf8");
    expect(src).not.toContain("StopHookOrchestrator");
    expect(src).not.toContain("createStopHookErrorMessage");
    expect(src).not.toContain("stop-hook-orchestrator");
  });

  test("全仓不再有第二处 MAX_STOP_HOOK_RETRIES 定义", () => {
    // 两份常量各自为政是"两套语义"的物理前提。live 那份留在 stop-hooks.ts。
    const stopHooks = readFileSync(join(SRC, "query/stop-hooks.ts"), "utf8");
    expect(stopHooks).toContain("const MAX_STOP_HOOK_RETRIES = 3");
    // 零引用的 getter 也一并删掉：常量就在同文件内，要读直接读。
    expect(stopHooks).not.toContain("export function getMaxStopHookRetries");
  });

  test("live 的耗尽语义仍是「放行」，不是「强制停」（这才是被保住的那条取舍）", () => {
    const src = readFileSync(join(SRC, "query/stop-hooks.ts"), "utf8");
    const idx = src.indexOf("if (budgetExhausted) {");
    expect(idx).toBeGreaterThan(-1);
    const body = src.slice(idx, idx + 700);
    // 耗尽分支必须 forceStop: false —— 改成 true 就是把编排器的语义搬了进来。
    expect(body).toContain("forceStop: false");
  });
});

describe("P3-4 · 端到端基准的口径：beginTurn 只在 queryLoop 入口调一次", () => {
  test("单次 queryLoop 内只发一个 TurnComplete，且 elapsed 覆盖整条消息", async () => {
    // 「一轮」= 一条用户消息（用户回车 → 最终答复），不是一次 API 往返。
    // 若有人按（已修正的）旧注释把 beginTurn 挪进 while 顶部，基准会变成
    // "最后一次 fetch 的起点"，工具往返/等待全被剔除 → p95 系统性虚低。
    // 这里用「多轮 tool_use 后收尾」构造多次 API 往返，锁住只有一个锚点。
    const toolResp = {
      role: "assistant",
      content: [{ type: "tool_use", id: "c1", name: "read", input: { file_path: "/tmp/a" } }],
      stopReason: "tool_use",
      usage: { inputTokens: 100, outputTokens: 10 },
    } as AccumulatedResponse;

    const { loopConfig, events } = setup({
      responses: [toolResp, toolResp, endTurnResp()],
      configOverrides: { maxTurns: 10 },
      depsOverrides: {
        executeTools: async (content) => ({
          results: content
            .filter((b): b is Extract<typeof b, { type: "tool_use" }> => b.type === "tool_use")
            .map((b) => ({ type: "tool_result" as const, tool_use_id: b.id, content: "ok" })),
        }),
      },
    });

    await drain(loopConfig);

    const tcs = events.filter((e) => e.event === "TurnComplete");
    // 三次 API 往返 → 仍然只有一个 TurnComplete。
    expect(tcs.length).toBe(1);
    // turn 是消息内的 API 迭代数，应当 > 1（证明确实跑了多轮而不是一轮就收尾，
    // 否则这条用例退化成"单轮场景"，锁不住 while-顶部重设那种改法）。
    expect(Number(tcs[0].data.turn)).toBeGreaterThan(1);
    expect(tcs[0].data.stop_reason).toBe("end_turn");
  });

  test("types.ts 的注释与实现一致（不得再写「while 循环顶部每轮重设」）", () => {
    // P3-4 本身不是控制流 bug，是**注释与实现相反** —— 危害在于后人照注释去"修"。
    // 所以锁的就是那句话本身。
    const typesSrc = readFileSync(join(SRC, "query/types.ts"), "utf8");
    const idx = typesSrc.indexOf("turnStartedAtMs");
    expect(idx).toBeGreaterThan(-1);
    const doc = typesSrc.slice(Math.max(0, idx - 2000), idx);
    expect(
      doc.includes("在 while 循环顶部每轮**重设**"),
      "types.ts 又写回了「while 循环顶部每轮重设」—— 与 loop.ts 只在入口调一次相反",
    ).toBe(false);

    // 实现侧同源锁：loop.ts 只有一处 beginTurn 调用。
    const loopSrc = readFileSync(join(SRC, "query/loop.ts"), "utf8");
    const calls = loopSrc.match(/^\s*beginTurn\(/gm) ?? [];
    expect(calls.length, "loop.ts 的 beginTurn 调用点应当只有 1 处（queryLoop 入口）").toBe(1);
  });
});

describe("P3-5 · stream-processor 心跳不得与 watchdog 同值（谓词不同的伪阶梯）", () => {
  test("心跳阈值与 watchdog 无进展阈值是两个独立字段且不同值", () => {
    // 同值时的实际形态：本层任意 SSE 事件（含 ping/keep-alive）都续命，watchdog 只认
    // 业务内容进展。于是「网关只回 keep-alive」这个最常见形态里本层**永不开枪**，
    // 两层防线实际只有一层；而「连 ping 都断了」时两层同时到点，先到的背全部锅。
    expect(DEFAULTS.streamHeartbeatTimeoutMs).not.toBe(DEFAULTS.watchdogNoProgressMs);
    // 方向也要钉住：谓词更宽松（ping 也算进展）的一层必须**更早**到点，
    // 否则它永远被 watchdog 抢先、等于死的那一层。
    expect(DEFAULTS.streamHeartbeatTimeoutMs).toBeLessThan(DEFAULTS.watchdogNoProgressMs);
    // 也不该比 provider 档② 更激进（信息更少的外层不抢在内层之前开枪）。
    expect(DEFAULTS.streamHeartbeatTimeoutMs).toBeGreaterThan(
      PROVIDER_STREAM_DEFAULTS.contentProgressTimeoutMs,
    );
  });

  test("stream-processor 的心跳默认值指向独立字段，不回落 watchdog", () => {
    // 回落会让"用户只调了 watchdog"变成"两层一起动"，同值的老形态悄悄回来且无报错
    // （PR14 拆 fallback 那层时记下的同一条教训）。
    const src = readFileSync(join(SRC, "query/stream-processor.ts"), "utf8");
    expect(src).toContain("netTimeouts.streamHeartbeatTimeoutMs");
    expect(src).not.toContain("heartbeatTimeoutMs ?? netTimeouts.watchdogNoProgressMs");
  });

  test("新字段可被 settings / env 独立调，且不带动 watchdog", async () => {
    const { resolveLoopTimeouts } = await import("@sid-code/core/config/network-profile.ts");
    const t = resolveLoopTimeouts({ network: { streamHeartbeatTimeoutMs: 321_000 } });
    expect(t.streamHeartbeatTimeoutMs).toBe(321_000);
    expect(t.watchdogNoProgressMs, "只调心跳时 watchdog 不该跟着变").toBe(
      DEFAULTS.watchdogNoProgressMs,
    );
    // 反向：只调 watchdog 时心跳保持默认（否则就是回落形态）。
    const t2 = resolveLoopTimeouts({ network: { watchdogNoProgressMs: 999_000 } });
    expect(t2.watchdogNoProgressMs).toBe(999_000);
    expect(t2.streamHeartbeatTimeoutMs, "只调 watchdog 时心跳那层不该跟着变").toBe(
      DEFAULTS.streamHeartbeatTimeoutMs,
    );
  });

  test("两层谓词确实不同（数值哨兵拦不住的那类退化）", () => {
    // 心跳：switch 之前无条件刷新 lastActivityTime（任意事件，含 ping）。
    const spSrc = readFileSync(join(SRC, "query/stream-processor.ts"), "utf8");
    expect(spSrc).toContain("lastActivityTime = Date.now()");
    // watchdog：读快照的 lastContentProgressAt（只有业务内容才刷新）。
    const loopSrc = readFileSync(join(SRC, "query/loop.ts"), "utf8");
    expect(loopSrc).toContain("snapshot?.lastContentProgressAt");
  });
});
