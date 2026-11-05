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
 * 把「未来 ms 毫秒后过期」换算成 `maxDurationMs`。
 *
 * ⚠️ **不能直接传一个极小的 `maxDurationMs`**（比如 1）：它的基准是**进程启动时刻**
 * （见 `config.ts` 该字段注释），而 bun test 进程此刻已经跑了几百毫秒到几秒，
 * 于是 `processStartMs + 1` 在过去 —— 第 1 轮都进不去，测到的是「一进来就退出」
 * 而不是「跑完第 1 轮后到点」。这正是本文件第一版写下时的错（3 条断言全红）。
 */
function budgetExpiringIn(ms: number): number {
  return Math.round(process.uptime() * 1000) + ms;
}

/**
 * mock 主循环的第 n 次模型调用。
 *
 * `toolTurns` = 前几轮返回 tool_use（逼迫循环继续），之后（含强制总结轮）返回 summary。
 * 必须按**调用序号**而不是"内容判断"来分派：强制总结轮的 messages 里确实有总结提示，
 * 但正常轮次经过压缩/提醒注入后也可能含「总结」字样，按内容判会误分派。
 */
function setup({ maxDurationMs, toolTurns }: { maxDurationMs: number; toolTurns: number }) {
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
    config: makeConfig({ maxDurationMs }),
    ctxMgr,
    toolRegistry: new ToolRegistry(),
    sessionState,
    fallback: new ModelFallback(),
    deps,
  };

  return { loopConfig, ctxMgr };
}

/** 让每轮真实耗时越过 deadline —— 不用假时钟，避免「测的是 mock 不是时钟」。 */
function slowEachTurn(loopConfig: QueryLoopConfig, ms = 25) {
  const original = loopConfig.deps.processStream;
  loopConfig.deps.processStream = async (...args: any[]) => {
    const r = await (original as any)(...args);
    await new Promise((resolve) => setTimeout(resolve, ms));
    return r;
  };
}

async function drainLoop(loopConfig: QueryLoopConfig) {
  const events: any[] = [];
  for await (const ev of queryLoop(loopConfig)) events.push(ev);
  return events;
}

describe("T10b：墙钟总预算（--max-duration-ms）", () => {
  test("到点后以 incompleteReason=max_duration 收尾，且不再产出 max_turns", async () => {
    // 预算在「进程启动后 15ms」过期；第 1 轮里 sleep 25ms 越过它 ——
    // 于是第 2 轮开始前的检查点必然命中。用真实时钟，不塞假位。
    const { loopConfig } = setup({ maxDurationMs: budgetExpiringIn(15), toolTurns: 1 });
    slowEachTurn(loopConfig);

    const events = await drainLoop(loopConfig);
    const done = events.find((e) => e.kind === "done");

    expect(done).toBeDefined();
    expect(done.incompleteReason).toBe("max_duration");
    // ⛔ 不能同时报 max_turns：那是另一个预算，混报会把人引去调 --max-turns
    expect(events.some((e) => e.kind === "max_turns")).toBe(false);
  });

  test("到点检查发生在轮次自增之前：不白占一格预算", async () => {
    const { loopConfig } = setup({ maxDurationMs: budgetExpiringIn(15), toolTurns: 1 });
    slowEachTurn(loopConfig);

    const events = await drainLoop(loopConfig);
    const done = events.find((e) => e.kind === "done");

    // 只跑了第 1 轮就因到点退出：turns 应为 1（第 1 轮真的跑过），
    // 而不是 2（那意味着到点后还自增了一次）。
    expect(done.turns).toBe(1);
  });

  test("到点后仍然跑强制总结轮（与 maxTurns 共用出口）", async () => {
    const { loopConfig, ctxMgr } = setup({ maxDurationMs: budgetExpiringIn(15), toolTurns: 1 });
    slowEachTurn(loopConfig);

    const events = await drainLoop(loopConfig);
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
    const messages = ctxMgr.getMessages();
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
    const { loopConfig } = setup({ maxDurationMs: 0, toolTurns: 3 });
    loopConfig.config.maxTurns = 3;
    const events = await drainLoop(loopConfig);
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
