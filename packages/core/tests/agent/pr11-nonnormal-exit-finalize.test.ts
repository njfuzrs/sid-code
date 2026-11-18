/**
 * PR11：非正常出口统一收尾 + 对父代理可见（G1 层）。
 *
 * 方案《20261116-只读子代理空转与过期清理重读循环-修复与验收方案》§PR11 的验收点：
 *   ① `task_stop` 默认：在途请求被中止 → 随后发出一轮**不带 tools** 的总结请求 →
 *      任务以 `stop_action=stopped_by_parent` 结束，结果是总结文本
 *   ② 每种非 `finalize` 的 `stop_action` 在回程头部有对应说明，`finalize` 时没有
 *   ③ salvage 的确定性清单（读过的文件 + 最后几次调用）真的被收集
 *
 * 这里只覆盖**判据是开关型**的部分（不跑模型、不起进程就能判对错）。`force: true` /
 * 60 秒超时退化硬杀属于 `agent-task` 的定时器行为，另有 task 层单测覆盖。
 */

import { describe, test, expect } from "bun:test";
import { runAgentLoop } from "@sid-code/core/agent/agentic-loop.ts";
import { Manager as ContextManager } from "@sid-code/core/context/manager.ts";
import { Registry as ToolRegistry } from "@sid-code/core/tool/registry.ts";
import { LoopDetector } from "@sid-code/core/agent/loop-detection.ts";
import { SalvageCollector } from "@sid-code/core/agent/salvage.ts";
import { describeStopNotice } from "@sid-code/core/agent/stop-notice.ts";
import type { Provider } from "@sid-code/core/llm/provider.ts";
import type { StreamEvent } from "@sid-code/core/llm/types.ts";
import type { LegacyTool, LegacyToolResult } from "@sid-code/core/tool/types.ts";

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

/** 记录每次调用是否下发了 tools —— 收尾轮的关键判据就是「不带 tools」。 */
function makeRecordingProvider(script: StreamEvent[][]): {
  provider: Provider;
  toolCounts: number[];
} {
  let call = 0;
  const toolCounts: number[] = [];
  const provider = {
    name: () => "mock",
    defaultModel: () => "mock-model",
    async *sendMessageStream(params: { tools?: unknown[] }): AsyncIterable<StreamEvent> {
      toolCounts.push(params?.tools?.length ?? 0);
      const events = script[Math.min(call, script.length - 1)] ?? yieldText("完成");
      call++;
      for (const e of events) yield e;
    },
  } as unknown as Provider;
  return { provider, toolCounts };
}

function allowAll() {
  return { check: async () => ({ allowed: true }) } as any;
}

/** 读工具：执行完就触发「父代理请求停止」，模拟 task_stop 打在工具轮之间的时序。 */
class AbortOnReadTool implements LegacyTool {
  executed = 0;
  constructor(private readonly onExecuted: () => void) {}
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
    this.onExecuted();
    return { output: `file ${String(input.file_path)}` };
  }
}

describe("PR11 · 父代理请求停止 → 收尾轮（X1）", () => {
  test("停止信号触发后：不再开新轮、跑一轮不带 tools 的总结、归因 stopped_by_parent", async () => {
    const stopCtrl = new AbortController();
    const read = new AbortOnReadTool(() => stopCtrl.abort());
    const tools = new ToolRegistry();
    tools.register(read as any);

    const { provider, toolCounts } = makeRecordingProvider([
      // 第 1 轮：正常工具调用（执行时触发停止）
      yieldToolUse("c1", "read", { file_path: "/a.ts" }),
      // 第 2 次调用 = 收尾轮，必须不带 tools
      yieldText("## 已完成\n- 看了 a.ts，发现 X"),
    ]);

    const result = await runAgentLoop({
      provider,
      model: "mock-model",
      ctxMgr: makeCtxMgr(),
      tools,
      maxTurns: 10,
      signal: new AbortController().signal,
      stopRequestSignal: stopCtrl.signal,
      loopDetector: new LoopDetector(),
      permissionChecker: allowAll(),
    } as any);

    // ① 收尾轮真的发出了，且**不带 tools**（带 tools 它就会继续调度而不是收尾）。
    expect(toolCounts.length, "应当恰好两轮：工具轮 + 收尾轮").toBe(2);
    expect(toolCounts[1], "收尾轮不得下发 tools").toBe(0);

    // ② 结果是收尾轮的总结文本，不是被丢弃。
    expect(result.lastTextOutput).toContain("已完成");
    expect(result.success).toBe(true);

    // ③ 归因是 stopped_by_parent —— 父代理据此区分「被我叫停」与「打满轮次」。
    expect(result.stopAction).toBe("stopped_by_parent");

    // ④ 第 2 轮没执行任何工具（收尾轮不调工具）。
    expect(read.executed, "工具只该在第 1 轮执行一次").toBe(1);
  });

  test("停止信号一开始就置位：不跑任何正常轮，直接收尾（不浪费一轮预算）", async () => {
    const stopCtrl = new AbortController();
    stopCtrl.abort();
    const tools = new ToolRegistry();
    const { provider, toolCounts } = makeRecordingProvider([yieldText("## 结论\n- 已有产出")]);

    const result = await runAgentLoop({
      provider,
      model: "mock-model",
      ctxMgr: makeCtxMgr(),
      tools,
      maxTurns: 10,
      signal: new AbortController().signal,
      stopRequestSignal: stopCtrl.signal,
      loopDetector: new LoopDetector(),
      permissionChecker: allowAll(),
    } as any);

    expect(toolCounts.length, "只有一次调用：收尾轮").toBe(1);
    expect(toolCounts[0]).toBe(0);
    expect(result.stopAction).toBe("stopped_by_parent");
    expect(result.turns, "没跑任何正常轮，turns 不该被计成 1").toBe(0);
  });

  test("对照组：没有停止信号时行为不变（打满轮次归因 max_turns）", async () => {
    const tools = new ToolRegistry();
    const { provider } = makeRecordingProvider([yieldText("## 结论\n- 正常收工")]);

    const result = await runAgentLoop({
      provider,
      model: "mock-model",
      ctxMgr: makeCtxMgr(),
      tools,
      maxTurns: 1,
      signal: new AbortController().signal,
      loopDetector: new LoopDetector(),
      permissionChecker: allowAll(),
    } as any);

    // 第 1 轮就是 end_turn：正常收工，走 finalize（不是 max_turns）。
    expect(result.success).toBe(true);
    expect(result.stopAction).toBe("finalize");
  });
});

describe("PR11 · 停止原因对父代理可见（D1）", () => {
  test("finalize 不产生附注：正常收尾不该挂噪音", () => {
    expect(describeStopNotice("finalize")).toBeUndefined();
    expect(describeStopNotice(undefined)).toBeUndefined();
    expect(describeStopNotice(null)).toBeUndefined();
  });

  test("各非正常出口都有对应说明，且点名了条件（不是一句笼统的「异常结束」）", () => {
    expect(describeStopNotice("max_turns")).toContain("轮次上限");
    expect(describeStopNotice("stopped_by_parent")).toContain("父代理");
    expect(describeStopNotice("context_window_exhausted")).toContain("窗口");
    expect(describeStopNotice("loop_recovery_exhausted")).toContain("循环");
    // 未知值也要给一句可读的兜底，不能返回 undefined 让父代理失去信号。
    const unknown = describeStopNotice("some_future_action");
    expect(unknown).toBeDefined();
    expect(unknown).toContain("some_future_action");
  });
});

describe("PR11 · salvage 确定性清单（X1 的兜底出口）", () => {
  test("收集读过的文件（去重带行段）与最后几次调用", () => {
    const collector = new SalvageCollector();
    collector.recordTurn({
      turn: 1,
      textOutput: "",
      tokenCount: 10,
      toolUseCount: 3,
      tools: [
        { name: "read", input: { file_path: "/a.ts", offset: 1, limit: 40 } } as any,
        { name: "read", input: { file_path: "/a.ts", offset: 100, limit: 20 } } as any,
        { name: "bash", input: { command: "git status" } } as any,
      ],
    });
    collector.recordTurn({
      turn: 2,
      textOutput: "",
      tokenCount: 10,
      toolUseCount: 1,
      tools: [{ name: "read", input: { file_path: "/b.ts" } } as any],
    });

    const snap = collector.snapshot();

    // 读过的文件去重，行段按读取顺序累积；未给 offset/limit 记成「全文」。
    expect(snap.readFiles).toEqual([
      { path: "/a.ts", ranges: ["1-40", "100-119"] },
      { path: "/b.ts", ranges: ["全文"] },
    ]);

    // 最近调用保留最后 N 条（N=5），带名称与主参数。
    expect(snap.recentCalls.length).toBeLessThanOrEqual(5);
    expect(snap.recentCalls[0]).toBe("read: /a.ts");
    expect(snap.recentCalls.at(-1)).toBe("read: /b.ts");
  });

  test("同一文件「全文」之后不再追加行段（全文已是覆盖度上界）", () => {
    const collector = new SalvageCollector();
    collector.recordTurn({
      turn: 1,
      textOutput: "",
      tokenCount: 1,
      toolUseCount: 1,
      tools: [{ name: "read", input: { file_path: "/a.ts" } } as any],
    });
    collector.recordTurn({
      turn: 2,
      textOutput: "",
      tokenCount: 1,
      toolUseCount: 1,
      tools: [{ name: "read", input: { file_path: "/a.ts", offset: 5, limit: 5 } } as any],
    });

    expect(collector.snapshot().readFiles).toEqual([{ path: "/a.ts", ranges: ["全文"] }]);
  });
});
