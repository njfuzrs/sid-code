/**
 * max-duration-budget — T10b：墙钟总预算（`--max-duration-ms`）
 *
 * ## 这条预算挡的是什么（先读这段，否则会把断言读成"重复测 maxTurns"）
 *
 * `--max-turns` 数的是「迭代了几次」，`--max-budget-usd` 数的是「花了多少美元」，
 * 这条数的是「墙上过了多久」。**三者正交，互补关系不是重复关系。**
 *
 * 2026-11-05 从 agent-traj-bench 归档 run 包解出 T0010 / T0051 / T0059 三条样本的
 * 原始 `session.traj` 后定论：主循环轮次 **110 / 108 / 100**（均 < `max_turns=120`）、
 * 成本 $0.877–$1.174（均 < `--max-budget-usd 1.8`）—— **两个预算都没触及**，
 * 三条都是被 Harbor 的 agent 硬顶（8100s / 5400s）从外部 SIGKILL 的。
 * 那种形态下 `result` 事件发不出来、`subtype=None`，下游只能记成 `AgentTimeoutError`，
 * 与「能力不足」在数据上不可区分（`evals/CLAUDE.md` §3.10「两层超时互相掩蔽」）。
 *
 * ## 断言的分工
 *
 * | 断言 | 防的是 |
 * | --- | --- |
 * | 到点后 `done.incompleteReason === "max_duration"` | 到点没被识别，仍然被外部杀 |
 * | 到点后**不再有** `max_turns` | 归错档（两个预算混成一个） |
 * | `turnCount` 不自增 | 白占一格预算，让 `num_turns` 与事实不符 |
 * | 到点后仍跑强制总结 | 用户/下游拿不到任何总结文本 |
 * | subtype 映射 `error_max_duration` | 落成 `error_during_execution` = 归因回到「能力不足」 |
 *
 * 「到点仍跑强制总结」这一条与 `max-turns-summary.test.ts` 同源：两者共用同一个出口，
 * 这里只验证新判据能进去，不重复验证出口本身的时序。
 */

import { describe, test, expect } from "bun:test";
import { queryLoop } from "@sid-code/core/query/loop.ts";
import type { QueryLoopConfig } from "@sid-code/core/query/loop.ts";
import type { QueryDeps } from "@sid-code/core/query/types.ts";
import { Manager as ContextManager } from "@sid-code/core/context/manager.ts";
import { Registry as ToolRegistry } from "@sid-code/core/tool/registry.ts";
import { ModelFallback } from "@sid-code/core/llm/fallback.ts";
import { SessionState } from "@sid-code/core/session/state.ts";
import type { Config } from "@sid-code/core/config/config.ts";
import type { StreamEvent, AccumulatedResponse } from "@sid-code/core/llm/types.ts";
import { convertToSDKMessage } from "@sid-code/core/sdk/message-converter.ts";
import type { ConvertContext } from "@sid-code/core/sdk/message-converter.ts";

const SUMMARY_MARKER = "时间预算已用尽，这是总结";

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    model: "claude-opus-4-8",
    provider: "anthropic",
    maxTurns: 100,
    maxTokens: 8000,
    ...overrides,
  } as unknown as Config;
}

async function* emptyStream(): AsyncIterable<StreamEvent> {
  /* processStream 被 mock，此处不产事件 */
}

/** 每轮工具调用的 input 都不同，避免触发 ToolCallLoopDetector（阈值 3 次相同调用） */
function toolUseResp(turn: number): AccumulatedResponse {
  return {
    role: "assistant",
    content: [
      { type: "tool_use", id: `t${turn}`, name: "bash", input: { command: `echo ${turn}` } },
    ],
    stopReason: "tool_use",
    usage: { inputTokens: 100, outputTokens: 20 },
  } as AccumulatedResponse;
}

function summaryResp(): AccumulatedResponse {
  return {
    role: "assistant",
    content: [{ type: "text", text: SUMMARY_MARKER }],
    stopReason: "end_turn",
    usage: { inputTokens: 200, outputTokens: 50 },
  } as AccumulatedResponse;
}

/**
 * 时间预算的三种表示：换算出的 `maxDurationMs`、同一个 deadline 的墙钟时刻、以及调用方给的余量。
 *
 * 三者必须一起带着走：`maxDurationMs` 是**从进程启动算**的绝对值（测试进程启动了几百毫秒，
 * 所以它远大于余量），只用它报错会把人引去算错数。
 */
interface Budget {
  maxDurationMs: number;
  /** 只给测试内部等待用（`slowEachTurn`），不参与产品逻辑 */
  deadlineWall: number;
  /** 调用方给的余量，只用于报错文本 */
  marginMs: number;
}

/** 「不限」：`maxDurationMs` 为 0 时 loop 里判 `> 0`，与 undefined 同义。 */
const UNLIMITED_BUDGET: Budget = { maxDurationMs: 0, deadlineWall: 0, marginMs: 0 };

/**
 * 设了时间预算的用例应有的模型调用次数：第 1 轮（tool_use）+ 强制总结轮。
 * 少于它就是「第 1 轮没跑」，见 `setup()` 里 `drain()` 的注释。
 *
 * ⚠️ 这个 2 **不随 `toolTurns` 变**，别按「`toolTurns + 1`」去理解：`slowEachTurn` 让
 * **每一轮**都越过 deadline，所以无论 `toolTurns` 设多大，第 2 轮开始前的检查点必然命中，
 * 调用次数恒为「1 轮 + 总结轮」。反过来，如果将来有人写 `toolTurns: 0`（首轮直接总结、
 * 不进工具轮）的预算用例，本断言会把它当成「余量不够」报红 —— 那种用例不该复用 `drain()`。
 */
const CALLS_WITH_BUDGET = 2;

/** 时间预算的余量（ms）。必须远大于 `O`（第 1 轮开始前的冷启动开销），见 `budgetExpiringIn`。 */
const BUDGET_MARGIN_MS = 500;

/**
 * 把「未来 ms 毫秒后过期」换算成 `maxDurationMs`，并记下同一 deadline 的墙钟时刻。
 *
 * ⚠️ **不能直接传一个极小的 `maxDurationMs`**（比如 1）：它的基准是**进程启动时刻**
 * （见 `config.ts` 该字段注释），而 bun test 进程此刻已经跑了几百毫秒到几秒，
 * 于是 `processStartMs + 1` 在过去 —— 第 1 轮都进不去，测到的是「一进来就退出」
 * 而不是「跑完第 1 轮后到点」。这正是本文件第一版写下时的错（3 条断言全红）。
 *
 * ⚠️ **余量 `ms` 必须大于 `O`**：`O` = 本函数求值完成 → 第 1 轮开始前的 deadline
 * 检查点（`loop.ts` 的 `Date.now() >= state.deadlineAt`）执行之间耗掉的时间，
 * 主要由**进程内第一次跑 `queryLoop` 的冷启动**决定（2026-11-16 本机实测约 28ms；
 * 整文件跑时它落在排第一的用例上，用 `-t` 单跑则每条都会吃一次）。
 * 原先这里取 15ms，小于冷启动开销，于是 2026-11-16 的 macOS CI 上 `:162` 收到
 * `turns = 0`（缺陷记录见 docs-research 私有库同名文档）。现在取 500ms，
 * 约 16 倍余量：`slowEachTurn` 负责构造不等式另一侧（每轮跨过 deadline），
 * `setup().drain()` 的前提断言负责在 `O` 再变大时报出「余量不够」而不是死在别处。
 */
function budgetExpiringIn(ms: number): Budget {
  return {
    maxDurationMs: Math.round(process.uptime() * 1000) + ms,
    deadlineWall: Date.now() + ms,
    marginMs: ms,
  };
}

/**
 * mock 主循环的第 n 次模型调用。
 *
 * `toolTurns` = 前几轮返回 tool_use（逼迫循环继续），之后（含强制总结轮）返回 summary。
 * 必须按**调用序号**而不是"内容判断"来分派：强制总结轮的 messages 里确实有总结提示，
 * 但正常轮次经过压缩/提醒注入后也可能含「总结」字样，按内容判会误分派。
 */
function setup({ budget, toolTurns }: { budget: Budget; toolTurns: number }) {
  const ctxMgr = new ContextManager({ maxTokens: 200000 });
  ctxMgr.setSystemPrompt("test");
  ctxMgr.addMessage({ role: "user", content: [{ type: "text", text: "请完成一个复杂任务" }] });

  let call = 0;
  const deps: QueryDeps = {
    sendWithRetry: () => emptyStream(),
    processStream: async () => {
      const n = call++;
      return n < toolTurns ? toolUseResp(n + 1) : summaryResp();
    },
    executeTools: async () => ({ results: [] }),
    autoCompact: async () => ({ kind: "skipped" as const }),
    getAbortSignal: () => undefined,
    uuid: () => `uuid-${call}`,
  };

  const sessionState = new SessionState("test-max-duration-budget");
  const loopConfig: QueryLoopConfig = {
    config: makeConfig({ maxDurationMs: budget.maxDurationMs }),
    ctxMgr,
    toolRegistry: new ToolRegistry(),
    sessionState,
    fallback: new ModelFallback(),
    deps,
  };

  return {
    loopConfig,
    ctxMgr,
    budget,
    /** 模型被调用的次数 = 真正跑过的轮数 + 是否跑了强制总结轮 */
    modelCalls: () => call,
    /**
     * 跑完整个循环，并校验设了时间预算时的**时序前提**。
     *
     * 本文件三条带 `maxDurationMs` 的用例都要求「第 1 轮真的跑过，第 2 轮开始前到点」。
     * 前提不成立（余量 `M` 小于冷启动开销 `O`，见 `budgetExpiringIn` 的注释）时，
     * 三条用例的失败形态各不相同、且**都不指向真因**：
     * - 「不白占一格」那条会收到 `turns = 0`，看起来像产品多算了一轮；
     * - 「强制总结」那条报「总结轮不存在」（`setup` 的 mock 按调用序号分派，
     *   第 1 轮没跑时强制总结轮拿到的是 tool_use），看起来像出口坏了；
     * - 只断言 `max_duration` 的那条**静默**走过「第 1 轮前就到点」，什么都没测到。
     * 所以在出口处统一断言模型恰好被调 2 次，让前提失败直接说人话。
     */
    async drain() {
      const events: any[] = [];
      for await (const ev of queryLoop(loopConfig)) events.push(ev);
      if (budget.maxDurationMs > 0) {
        expect(
          call,
          `前提不成立：模型被调了 ${call} 次，期望 ${CALLS_WITH_BUDGET} 次（第 1 轮 + 强制总结轮）。` +
            `第 1 轮开始前就命中了 deadline 检查点 —— 冷启动开销 O 吃掉了余量 M=${budget.marginMs}ms，` +
            `调大 budgetExpiringIn 的余量，不要改断言。`,
        ).toBe(CALLS_WITH_BUDGET);
      }
      return events;
    },
  };
}

/**
 * 让每轮真实耗时越过 deadline —— 不用假时钟，避免「测的是 mock 不是时钟」。
 *
 * 早先是固定 `sleep(25)` 配合 15ms 余量，靠「25 > 15」保证第 2 轮开始前必然到点。
 * 那把「本轮要够长」和「本轮之前不能到点」压成两个常数之间的配比：余量一抖就破
 * （2026-11-16 的 macOS flake 就是这么来的）。现在直接等过 deadline，
 * 不等式 `O + S > M` 由构造保证（`S` 不再是常数），只剩 `O < M` 需要余量。
 */
function slowEachTurn(loopConfig: QueryLoopConfig, deadlineWall: number) {
  const original = loopConfig.deps.processStream;
  loopConfig.deps.processStream = async (...args: any[]) => {
    const r = await (original as any)(...args);
    // +2ms：`loop.ts` 用 `Date.now() - round(uptime()*1000)` 反推进程启动时刻，
    // 与 `budgetExpiringIn` 里那次 `uptime()` 之间有不到 1ms 的取整误差。
    while (Date.now() <= deadlineWall + 2) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return r;
  };
}

describe("T10b：墙钟总预算（--max-duration-ms）", () => {
  test("到点后以 incompleteReason=max_duration 收尾，且不再产出 max_turns", async () => {
    // 预算在「进程启动后 500ms」过期；`slowEachTurn` 让第 1 轮跨过它 ——
    // 于是第 2 轮开始前的检查点必然命中。用真实时钟，不塞假位。
    const loop = setup({ budget: budgetExpiringIn(BUDGET_MARGIN_MS), toolTurns: 1 });
    slowEachTurn(loop.loopConfig, loop.budget.deadlineWall);

    const events = await loop.drain();
    const done = events.find((e) => e.kind === "done");

    expect(done).toBeDefined();
    expect(done.incompleteReason).toBe("max_duration");
    // ⛔ 不能同时报 max_turns：那是另一个预算，混报会把人引去调 --max-turns
    expect(events.some((e) => e.kind === "max_turns")).toBe(false);
  });

  test("到点检查发生在轮次自增之前：不白占一格预算", async () => {
    const loop = setup({ budget: budgetExpiringIn(BUDGET_MARGIN_MS), toolTurns: 1 });
    slowEachTurn(loop.loopConfig, loop.budget.deadlineWall);

    const events = await loop.drain();
    const done = events.find((e) => e.kind === "done");

    // 只跑了第 1 轮就因到点退出：turns 应为 1（第 1 轮真的跑过），
    // 而不是 2（那意味着到点后还自增了一次）。
    expect(done.turns).toBe(1);
  });

  test("到点后仍然跑强制总结轮（与 maxTurns 共用出口）", async () => {
    const loop = setup({ budget: budgetExpiringIn(BUDGET_MARGIN_MS), toolTurns: 1 });
    slowEachTurn(loop.loopConfig, loop.budget.deadlineWall);

    const events = await loop.drain();
    const summary = events.find(
      (e) =>
        e.kind === "assistant_message" &&
        e.message.content.some(
          (b: any) =>
            b.type === "text" && typeof b.text === "string" && b.text.includes(SUMMARY_MARKER),
        ),
    );
    expect(summary).toBeDefined();

    // 总结轮的提示写进历史，且措辞是「时间预算」不是「轮次」——
    // 说成轮次会让模型以为还能再跑几轮，总结里写「下一轮继续」。
    const messages = loop.ctxMgr.getMessages();
    const injected = messages.find(
      (m) =>
        m.role === "user" &&
        m.content.some(
          (b: any) =>
            b.type === "text" && typeof b.text === "string" && b.text.includes("时间预算"),
        ),
    );
    expect(injected).toBeDefined();
  });

  test("不限（maxDurationMs 未设或为 0）时行为与改动前一致：一直跑到 maxTurns", async () => {
    // 0 就是「不限」（loop 里判 `> 0`），与 undefined 同义。
    // toolTurns=3 = maxTurns：前三轮 tool_use 逼到上限，第 4 次调用是强制总结轮。
    const loop = setup({ budget: UNLIMITED_BUDGET, toolTurns: 3 });
    loop.loopConfig.config.maxTurns = 3;
    const events = await loop.drain();
    const done = events.find((e) => e.kind === "done");

    expect(done.incompleteReason).toBeUndefined();
    expect(events.some((e) => e.kind === "max_turns")).toBe(true);
  });
});

describe("T10b：subtype 映射（message-converter）", () => {
  const ctx = (): ConvertContext => ({
    sessionId: "s",
    totalUsage: { inputTokens: 0, outputTokens: 0 },
    startTime: 0,
    turnCount: 3,
    totalCostUsd: 0.5,
    now: () => 1000,
  });

  test("incompleteReason=max_duration → subtype=error_max_duration", () => {
    const msg = convertToSDKMessage(
      { kind: "done", turns: 3, incompleteReason: "max_duration" } as any,
      ctx(),
    ) as any;
    expect(msg.type).toBe("result");
    expect(msg.subtype).toBe("error_max_duration");
    // ⛔ 不能落成 error_during_execution：那等于把「时间不够」归因成「出错了」，
    // 下游会去查异常源，而真凶是外层硬顶。
    expect(msg.subtype).not.toBe("error_during_execution");
    // 文案也不能提「轮次」—— 那是 --max-turns 的措辞
    expect(msg.errors[0]).not.toContain("轮次");
  });

  test("下一个同类项：max_duration 与 max_turns / stalled 互不串台", () => {
    // 「加一个下一个同类项」变异：三个取值各走各的分支。
    // 只断言 max_duration 一处的话，分支被改成恒定返回也测不出来。
    const cases: Array<[string, string]> = [
      ["max_duration", "error_max_duration"],
      ["stalled", "error_stalled"],
      ["timeout_retry_exhausted", "error_during_execution"],
    ];
    for (const [reason, expected] of cases) {
      const msg = convertToSDKMessage(
        { kind: "done", turns: 1, incompleteReason: reason } as any,
        ctx(),
      ) as any;
      expect({ reason, subtype: msg.subtype }).toEqual({ reason, subtype: expected });
    }
  });
});
