/**
 * max-turns-summary — 验证 P1-1「主循环达到 maxTurns 时追加一轮强制总结」
 *
 * 对齐 src/agent/agentic-loop.ts:344-393 子代理版的同一做法，迁移到主循环 queryLoop。
 * mock 模式沿用 tests/query/loop-transitions.test.ts 的 setup 套路。
 *
 * 注意：主循环每一轮（包括 tool_use 轮）本身就会 yield assistant_message，
 * 所以断言时不能只看"是否出现过 assistant_message"，要看"是否出现了带总结文本的那一条"。
 *
 * "abort 时跳过强制总结轮"这个防御性分支未在此单独做端到端时序测试——主循环内部
 * 本身在多处会读取 getAbortSignal()，用共享计数器精确模拟"跑完所有常规轮次之后、
 * 尝试总结之前"这个时间点会与既有的 abort 检查点产生耦合，测试会变得脆弱且难以
 * 维护。该分支是一个简单的布尔守卫（!deps.getAbortSignal?.()?.aborted），已通过
 * 类型检查与代码审查覆盖。
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

const SUMMARY_MARKER = "已完成的工作：xxx；未完成：yyy";

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    model: "claude-opus-4-8",
    provider: "anthropic",
    maxTurns: 4,
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

function setup({
  maxTurns,
  summary = summaryResp() as AccumulatedResponse | null,
  hookSystem,
  onRecordError,
}: {
  maxTurns: number;
  summary?: AccumulatedResponse | null;
  hookSystem?: unknown;
  onRecordError?: (input: any) => void;
}) {
  const ctxMgr = new ContextManager({ maxTokens: 200000 });
  ctxMgr.setSystemPrompt("test");
  ctxMgr.addMessage({ role: "user", content: [{ type: "text", text: "请完成一个复杂任务" }] });

  let call = 0;
  const deps: QueryDeps = {
    sendWithRetry: () => emptyStream(),
    processStream: async () => {
      // 前 maxTurns 次都返回 tool_use（永不 end_turn，逼迫循环耗尽 maxTurns）；
      // 第 maxTurns+1 次（强制总结轮）返回 summary。
      const isSummaryCall = call === maxTurns;
      call++;
      if (isSummaryCall) {
        if (summary === null) throw new Error("模拟总结轮调用失败");
        return summary;
      }
      return toolUseResp(call);
    },
    executeTools: async () => ({ results: [] }),
    autoCompact: async () => {},
    handleContextOverflow: () => null,
    getAbortSignal: () => undefined,
    uuid: () => `uuid-${call}`,
    ...(onRecordError ? { recordError: onRecordError } : {}),
  };

  const sessionState = new SessionState("test-max-turns-summary");
  const loopConfig: QueryLoopConfig = {
    config: makeConfig({ maxTurns }),
    ctxMgr,
    toolRegistry: new ToolRegistry(),
    sessionState,
    fallback: new ModelFallback(),
    deps,
    ...(hookSystem ? { hookSystem: hookSystem as QueryLoopConfig["hookSystem"] } : {}),
  };

  return { loopConfig, ctxMgr, sessionState };
}

/**
 * 只实现 loop.ts 会调到的两个发射点，其余成员按需补空实现。
 * 返回值形状对齐 HookResult（loop 只读 `finalOutput?.isBlockingDecision()` 等可选方法）。
 */
function makeRecordingHookSystem() {
  const before: any[] = [];
  const after: any[] = [];
  const system = new Proxy(
    {
      fireBeforeModelEvent: async (req: any, opts: any) => {
        before.push({ req, opts });
        return {};
      },
      fireAfterModelEvent: async (req: any, resp: any) => {
        after.push({ req, resp });
        return {};
      },
    } as Record<string, unknown>,
    {
      // 其余 fire*/get* 一律降级为无副作用空实现 —— 本测试只关心上面两个。
      get: (target, prop: string) => (prop in target ? target[prop] : async () => ({}) as unknown),
    },
  );
  return { system, before, after };
}

async function drainLoop(loopConfig: QueryLoopConfig) {
  const events: any[] = [];
  for await (const ev of queryLoop(loopConfig)) events.push(ev);
  return events;
}

/** 从事件流里找到"带总结文本"的那一条 assistant_message（区别于常规 tool_use 轮次的 assistant_message） */
function findSummaryEvent(events: any[]) {
  return events.find(
    (e) =>
      e.kind === "assistant_message" &&
      e.message.content.some(
        (b: any) =>
          b.type === "text" && typeof b.text === "string" && b.text.includes(SUMMARY_MARKER),
      ),
  );
}

describe("P1-1：主循环达到 maxTurns 时追加强制总结轮", () => {
  test("达到 maxTurns 后，在 max_turns/done 之前追加一次带总结文本的 assistant_message", async () => {
    const { loopConfig, ctxMgr } = setup({ maxTurns: 4 });
    const events = await drainLoop(loopConfig);
    const kinds = events.map((e) => e.kind);

    const summaryEvent = findSummaryEvent(events);
    expect(summaryEvent).toBeDefined();

    const summaryIdx = events.indexOf(summaryEvent);
    const maxTurnsIdx = kinds.indexOf("max_turns");
    const doneIdx = kinds.indexOf("done");
    expect(maxTurnsIdx).toBeGreaterThan(summaryIdx);
    expect(doneIdx).toBeGreaterThan(maxTurnsIdx);

    // 总结轮的请求消息也应该写入 ctxMgr（对齐正常轮次的持久化行为）
    const messages = ctxMgr.getMessages();
    const injectedPrompt = messages.find(
      (m) =>
        m.role === "user" &&
        m.content.some(
          (b: any) => b.type === "text" && typeof b.text === "string" && b.text.includes("总结"),
        ),
    );
    expect(injectedPrompt).toBeDefined();
  });

  test("强制总结轮调用失败时不阻断收尾（仍正常 yield max_turns/done）", async () => {
    const { loopConfig } = setup({ maxTurns: 4, summary: null });
    const events = await drainLoop(loopConfig);
    const kinds = events.map((e) => e.kind);

    expect(findSummaryEvent(events)).toBeUndefined();
    expect(kinds).toContain("max_turns");
    expect(kinds).toContain("done");
  });

  // ── §20.4（permswitch-r4 实测）：这一轮此前整轮不进任何仪器 ──
  // 缺陷形态：P1-1 在 while 循环之外，不经过循环内的 BeforeModel/AfterModel 发射点，
  // 于是 token / 成本 / `API N 次` **三处同时漏**同一轮（实测 HttpConnected=41 而
  // BeforeModel=40，且 harbor 侧读数与 40 条 raw 的合计逐字节相等）。
  //
  // ⚠️ 断言刻意分成两条：「hook 发了」与「token 进账了」是**两件事**。
  // 只验前者就是「改了等于没改」—— 交接文档点名的坑。
  describe("§20.4：强制总结轮必须入账", () => {
    test("补发 BeforeModel/AfterModel，且 index 自增而非复用 maxTurns", async () => {
      const { system, before, after } = makeRecordingHookSystem();
      const { loopConfig } = setup({ maxTurns: 4, hookSystem: system });
      await drainLoop(loopConfig);

      // 4 个常规轮 + 1 个总结轮 = 5
      expect(before.length).toBe(5);
      expect(after.length).toBe(5);

      // ⚠️ 关键：turn_index 必须是 maxTurns + 1。复用 maxTurns 正是
      // 「一个 index 出现两次 first_content」的成因，会让按 index 聚合的 TTFT
      // 把两次不同调用叠在一格里 —— 而总结轮那次恰好落在 P95/P99 的尾部。
      expect(before[4].opts?.stream_snapshot_ref?.turn_index).toBe(5);
      expect(before[3].opts?.stream_snapshot_ref?.turn_index).toBe(4);

      // 本轮真的没下发工具，传了 tools 就是让轨迹撒谎。
      expect(before[4].req.tools).toBeUndefined();
    });

    test("总结轮的 usage 真的进了账（不只是 hook 发了）", async () => {
      const { loopConfig, sessionState } = setup({ maxTurns: 4 });
      await drainLoop(loopConfig);

      // 4 个常规轮各 out=20 → 80；总结轮 out=50。判据是**等式**而非 ">0"：
      // 后者在漏计时同样成立（80 > 0），测不出这个缺陷。
      expect(sessionState.getTotalUsage().outputTokens).toBe(4 * 20 + 50);
      // input 同理：4 * 100 + 200（flow 累计口径）
      expect(sessionState.getTotalUsage().inputTokens).toBe(4 * 100 + 200);
    });

    test("总结轮失败落 errors.jsonl（此前只有一行 warn）", async () => {
      const recorded: any[] = [];
      const { loopConfig } = setup({
        maxTurns: 4,
        summary: null,
        onRecordError: (input) => recorded.push(input),
      });
      await drainLoop(loopConfig);

      const summaryErr = recorded.find((e) => e.context?.forcedSummaryRound === true);
      expect(summaryErr).toBeDefined();
      // index 与上面 stream_snapshot_ref 同口径，便于与轨迹对账
      expect(summaryErr.index).toBe(5);
      expect(summaryErr.error).toContain("模拟总结轮调用失败");
    });
  });
});
