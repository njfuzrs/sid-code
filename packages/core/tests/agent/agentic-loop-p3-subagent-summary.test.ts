/**
 * Agentic Loop P3：子代理强制总结轮的协议完整性 + 超时事件的观测身份。
 *
 * 缺陷文档《20260920-AgenticLoop主循环审查-对照博客核出的缺陷》十一、P3 一组：
 *   P3-3 子代理强制总结轮不剥离 `tool_use`（主循环 loop.ts 已剥）
 *   P3-6 子代理 `TimeoutFired` 用 `index: -1`，对不上任何快照
 *
 * P3-3 有两个半边，缺一不可：
 *   ① **发送前**：未知 stopReason 带着未执行 tool_use `break` 出循环时，历史已破配对。
 *      总结轮跑在 while **之外**，吃不到循环内那道 `finalizeMessagesForSend`。
 *   ② **响应后**：总结轮没下发 tools，但响应仍可能含 tool_use；直接入历史就是
 *      **新造**一个孤儿，400 延后到下一次发送（子代理 messages 被父级复用时）。
 * 只修一边都会留下 400，所以两边各有断言。
 *
 * fix_type: case_design
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { runAgentLoop } from "@sid-code/core/agent/agentic-loop.ts";
import { Manager as ContextManager } from "@sid-code/core/context/manager.ts";
import { Registry as ToolRegistry } from "@sid-code/core/tool/registry.ts";
import { LoopDetector } from "@sid-code/core/agent/loop-detection.ts";
import { checkMessageHistoryIntegrity } from "@sid-code/core/agent/message-invariants.ts";
import type { Provider } from "@sid-code/core/llm/provider.ts";
import type { StreamEvent } from "@sid-code/core/llm/types.ts";
import type { LegacyTool, LegacyToolResult } from "@sid-code/core/tool/types.ts";

function makeCtxMgr(): ContextManager {
  const ctxMgr = new ContextManager({ maxTokens: 100_000 });
  ctxMgr.setSystemPrompt("test");
  ctxMgr.addMessage({ role: "user", content: [{ type: "text", text: "任务" }] });
  return ctxMgr;
}

class MockReadTool implements LegacyTool {
  executed: Array<Record<string, unknown>> = [];
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
    this.executed.push(input);
    return { output: `file ${String(input.file_path)}` };
  }
}

function yieldToolUse(
  id: string,
  name: string,
  input: Record<string, unknown>,
  stopReason: string,
): StreamEvent[] {
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
      delta: { stop_reason: stopReason },
      usage: { outputTokens: 5 },
    } as StreamEvent,
  ];
}

/** text + tool_use 同帧，带指定 stopReason（构造"未知 stop 仍带工具"的形态） */
function yieldTextAndToolUse(
  text: string,
  id: string,
  name: string,
  input: Record<string, unknown>,
  stopReason: string,
): StreamEvent[] {
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
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id, name },
    } as StreamEvent,
    {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(input) },
    } as StreamEvent,
    { type: "content_block_stop", index: 1 } as StreamEvent,
    {
      type: "message_delta",
      delta: { stop_reason: stopReason },
      usage: { outputTokens: 5 },
    } as StreamEvent,
  ];
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

function makeScriptedProvider(script: StreamEvent[][]): Provider {
  let call = 0;
  return {
    name: () => "mock",
    defaultModel: () => "mock-model",
    async *sendMessageStream(): AsyncIterable<StreamEvent> {
      const events = script[Math.min(call, script.length - 1)] ?? yieldText("完成");
      call++;
      for (const e of events) yield e;
    },
  } as unknown as Provider;
}

function allowAll() {
  return { check: async () => ({ allowed: true }) } as any;
}

const AGENTIC_LOOP_SRC = readFileSync(
  new URL("../../src/agent/agentic-loop.ts", import.meta.url).pathname,
  "utf-8",
);
const AGENT_STREAM_PROCESSOR_SRC = readFileSync(
  new URL("../../src/agent/stream-processor.ts", import.meta.url).pathname,
  "utf-8",
);

describe("P3-3 · 子代理强制总结轮：发送前必须补齐孤儿", () => {
  test("未知 stopReason 带未执行 tool_use → break 到总结轮，历史仍无孤儿", async () => {
    // 形态：模型回一个**未识别**的 stopReason（这里用 "weird_new_reason"）且响应里带
    // tool_use。agentic-loop 把 assistant 原样入史后 `break`，那些 tool_use 永远等不到
    // tool_result。修复前发给总结轮的历史是 assistant(tool_use) → user("请总结")，
    // 协议已破配对 → 400，而总结轮是把前面所有产出落地成结论的唯一机会。
    const tools = new ToolRegistry();
    tools.register(new MockReadTool() as any);

    const result = await runAgentLoop({
      provider: makeScriptedProvider([
        yieldTextAndToolUse(
          "我再看一个文件",
          "c-unknown",
          "read",
          { file_path: "/a.ts" },
          "weird_new_reason",
        ),
        // 第二次调用 = 强制总结轮（本轮不带 tools）
        yieldText("## 结论\n- 看了 a.ts"),
      ]),
      model: "mock-model",
      ctxMgr: makeCtxMgr(),
      tools,
      maxTurns: 5,
      signal: new AbortController().signal,
      loopDetector: new LoopDetector(),
      permissionChecker: allowAll(),
    } as any);

    const integrity = checkMessageHistoryIntegrity(result.messages as any);
    expect(
      integrity.orphans,
      "未知 stop 带 tool_use break 到总结轮时，发送前必须补占位 tool_result",
    ).toHaveLength(0);
    // 占位确实是给那个 tool_use 补的（而不是靠"整条消息被丢掉"蒙过去）。
    const hasPlaceholder = result.messages.some((m) =>
      m.content.some((b: any) => b.type === "tool_result" && b.tool_use_id === "c-unknown"),
    );
    expect(hasPlaceholder, "必须为 c-unknown 补一条占位 tool_result").toBe(true);
    // 未知 stop 仍要把警告带回父级（P0-3 既有语义，顺手锁住别被这次改动弄丢）。
    expect(result.errorMessage).toContain("未识别的停止原因");
  });
});

describe("P3-3 · 子代理强制总结轮：响应里的 tool_use 必须剥离", () => {
  test("总结轮响应含 tool_use（未下发 tools）时不得入历史，否则新造孤儿", async () => {
    // maxTurns=1：第一轮 tool_use 执行完即达上限 → 走强制总结轮。
    // 总结轮 mock 刻意无视"没传 tools"回一个 tool_use（真实成因：mock 忽略 tools 参数、
    // 模型异常、网关回放旧内容）。它在本轮无法执行、也已过了发送前兜底那一关，
    // 入历史就是一个**新造**的孤儿，400 延后到下一次发送。
    const read = new MockReadTool();
    const tools = new ToolRegistry();
    tools.register(read as any);

    const result = await runAgentLoop({
      provider: makeScriptedProvider([
        yieldToolUse("c1", "read", { file_path: "/a.ts" }, "tool_use"),
        // 总结轮：文本 + 一个不该出现的 tool_use
        yieldTextAndToolUse(
          "## 结论",
          "c-summary-ghost",
          "read",
          { file_path: "/b.ts" },
          "tool_use",
        ),
      ]),
      model: "mock-model",
      ctxMgr: makeCtxMgr(),
      tools,
      maxTurns: 1,
      signal: new AbortController().signal,
      loopDetector: new LoopDetector(),
      permissionChecker: allowAll(),
    } as any);

    const integrity = checkMessageHistoryIntegrity(result.messages as any);
    expect(integrity.orphans, "总结轮响应的 tool_use 必须剥离，不得留成孤儿").toHaveLength(0);
    // 那个鬼 tool_use 不该出现在历史里的任何位置。
    const ghostPresent = result.messages.some((m) =>
      m.content.some((b: any) => b.type === "tool_use" && b.id === "c-summary-ghost"),
    );
    expect(ghostPresent, "c-summary-ghost 必须被剥掉（本轮没下发 tools，无法执行）").toBe(false);
    // 剥离不得连正文一起丢：总结文本仍要落地（它是这一轮的全部价值）。
    expect(result.lastTextOutput).toContain("结论");
    const summaryText = result.messages.some((m) =>
      m.content.some((b: any) => b.type === "text" && String(b.text).includes("结论")),
    );
    expect(summaryText, "总结正文必须入历史（只剥 tool_use）").toBe(true);
    // 总结轮不该真去跑工具（下发 tools 本身就没传）。
    expect(read.executed.length, "总结轮不得执行工具").toBe(1);
  });

  test("源码形态：总结轮两道防线都在（发送前补齐 + 响应后剥离）", () => {
    // 这两处很容易在重构中掉一个，而掉了之后要等"未知 stop + 撞上限"这种罕见组合
    // 才会 400 —— 集成用例覆盖不到的角落用形态断言兜住。
    const summaryIdx = AGENTIC_LOOP_SRC.indexOf("达到最大轮次 ${maxTurns}，请求强制总结");
    expect(summaryIdx).toBeGreaterThan(-1);
    const summaryBlock = AGENTIC_LOOP_SRC.slice(summaryIdx - 2500, summaryIdx + 6000);
    expect(summaryBlock, "总结轮发送前必须调 finalizeMessagesForSend").toContain(
      "finalizeMessagesForSend(ctxMgr.getMessages())",
    );
    expect(summaryBlock, "总结轮响应必须过滤 tool_use").toContain(
      'filter((b) => b.type !== "tool_use")',
    );
    // 不得再出现"原样入历史"那一行。
    expect(summaryBlock).not.toContain(
      'ctxMgr.addMessage({ role: "assistant", content: summaryResponse.content })',
    );
  });
});

describe("P3-6 · 子代理 TimeoutFired 必须带真实观测身份（此前硬编码 -1）", () => {
  test("不再有 emitTimeoutFired(-1, ...) 的硬编码调用", () => {
    // `-1` 拼出的快照 key 对不上任何一份快照：既 push 不进 snapshot.timeoutsFired
    //（fallback 的 reopenReason 读它），也无法按轮次聚合 → 子代理超时在 digest 里
    // 像"没发生过"（铁律 1 的弱形式）。
    expect(AGENT_STREAM_PROCESSOR_SRC).not.toContain(
      'emitTimeoutFired(-1, "agent_overall_timeout"',
    );
    expect(AGENT_STREAM_PROCESSOR_SRC).not.toContain(
      'emitTimeoutFired(-1, "agent_heartbeat_timeout"',
    );
    // 两处都改走可注入的号段 + agentId。
    expect(AGENT_STREAM_PROCESSOR_SRC).toContain("OBSERVER_INDEX");
    expect(AGENT_STREAM_PROCESSOR_SRC).toContain("options.observerAgentId");
  });

  test("生产调用方把号段/agentId 传了下去，且与 emitStreamPhase 同源", () => {
    // 关键不是"有这个参数"，而是**与同一条流的 emitStreamPhase 用同一把 key** ——
    // 传了但传错号段，等于把超时记到别人那一格上（B4 在 emitStreamPhase 侧踩过）。
    // 主流：10000 + turns（agentStreamIndex）；总结轮：20000 + turns（summaryStreamIndex）。
    //
    // ⚠️ 必须按 `processStream(` 定位，不能直接 indexOf("observerIndex: agentStreamIndex")：
    // `observerIndex: agentStreamIndex` 在本文件出现**两次** —— 一次给
    // `streamWithResilience`（漏斗，刻意不带 agentId，它在 onRetry 里另行传），
    // 一次给 `processStream`。按裸字符串找会命中漏斗那次，断言就在问错的调用点。
    const callSites = [...AGENTIC_LOOP_SRC.matchAll(/await processStream\(/g)].map((m) => m.index!);
    expect(callSites.length, "子代理应有两处 processStream 调用（主流 + 总结轮）").toBe(2);

    const blocks = callSites.map((i) => AGENTIC_LOOP_SRC.slice(i, i + 900));
    // 主流那一处
    expect(blocks[0]).toContain("observerIndex: agentStreamIndex");
    expect(blocks[0], "主流超时事件必须带 agentId").toContain("observerAgentId");
    // 总结轮那一处（20000 号段，避开主流那一格）
    expect(blocks[1]).toContain("observerIndex: summaryStreamIndex");
    expect(blocks[1], "总结轮超时事件必须带 agentId").toContain("observerAgentId");
  });

  test("超时事件真的落在传入的号段上（而不是 -1）", async () => {
    // 端到端验一次：注入极短心跳超时 + 一个永不产出的流，看 TimeoutFired 的 index。
    const { processStream } = await import("@sid-code/core/agent/stream-processor.ts");
    const observer = await import("@sid-code/core/trace/stream-observer.ts");

    const captured: Array<{ event: string; data: Record<string, unknown> }> = [];
    observer.initStreamObserver("test-p3-6", "/tmp", ((ev: any) => {
      captured.push({ event: ev.event, data: (ev.data ?? {}) as Record<string, unknown> });
    }) as never);

    // 永不产出任何事件、也不结束的流 → 触发首字节/心跳超时。
    async function* stalled(): AsyncIterable<StreamEvent> {
      await new Promise((r) => setTimeout(r, 3_000));
      yield { type: "message_delta", delta: { stop_reason: "end_turn" } } as StreamEvent;
    }

    const res = await processStream(stalled(), {
      firstByteTimeoutMs: 30,
      heartbeatTimeoutMs: 30,
      overallTimeoutMs: 60,
      heartbeatCheckIntervalMs: 10,
      observerIndex: 10007,
      observerAgentId: "agent-p3-6",
    });
    expect(res.stopReason).toBe("error");

    const fired = captured.filter((e) => e.event === "TimeoutFired");
    expect(fired.length, "超时必须发 TimeoutFired").toBeGreaterThan(0);
    // 核心断言：index 是传入的号段，不是 -1。
    for (const f of fired) {
      expect(f.data.index, "TimeoutFired.index 不得是 -1（对不上任何快照）").toBe(10007);
      expect(f.data.agent_id ?? f.data.agentId).toBe("agent-p3-6");
    }
  });
});
