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
import { queryLoop } from "../../src/query/loop.ts";
import type { QueryLoopConfig } from "../../src/query/loop.ts";
import type { QueryDeps } from "../../src/query/types.ts";
import { Manager as ContextManager } from "../../src/context/manager.ts";
import { Registry as ToolRegistry } from "../../src/tool/registry.ts";
import { ModelFallback } from "../../src/llm/fallback.ts";
import { SessionState } from "../../src/session/state.ts";
import type { Config } from "../../src/config/config.ts";
import type { StreamEvent, AccumulatedResponse } from "../../src/llm/types.ts";

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
    content: [{ type: "tool_use", id: `t${turn}`, name: "bash", input: { command: `echo ${turn}` } }],
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

function setup({ maxTurns, summary = summaryResp() as AccumulatedResponse | null }: { maxTurns: number; summary?: AccumulatedResponse | null }) {
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
  };

  const loopConfig: QueryLoopConfig = {
    config: makeConfig({ maxTurns }),
    ctxMgr,
    toolRegistry: new ToolRegistry(),
    sessionState: new SessionState("test-max-turns-summary"),
    fallback: new ModelFallback(),
    deps,
  };

  return { loopConfig, ctxMgr };
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
      e.message.content.some((b: any) => b.type === "text" && typeof b.text === "string" && b.text.includes(SUMMARY_MARKER)),
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
        m.content.some((b: any) => b.type === "text" && typeof b.text === "string" && b.text.includes("总结")),
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
});
