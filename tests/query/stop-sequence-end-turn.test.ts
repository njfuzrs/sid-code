/**
 * 缺口 2：stop_sequence 未进 end_turn 白名单 —— queryLoop 消费端集成测试
 *
 * 背景（对齐 CC）：stop_sequence（模型撞到配置的 stop 序列）属"正常终止"，
 * 应与 end_turn/stop 一样走完整收尾链（AfterAgent hook / Stop hooks / todo gate /
 * goal gate / session memory 提取），而不是落到"未识别停止原因"分支弹 terminal 警告
 * 并跳过全部收尾。CC 全源码对 stop_sequence 零特殊处理 = 直接 fall-through 当正常结束。
 *
 * 本测试验证 loop 消费端两条验收标准：
 *   1. stop_reason="stop_sequence" + 有 content → 走 end_turn 收尾链（AfterAgent hook 触发），
 *      不产生"未识别停止原因"警告；
 *   2. stop_reason="stop_sequence" + 含 tool_use → 仍走 F2 fall-through 执行工具（不被误吞）。
 *
 * fix_type: case_design
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

function makeConfig(): Config {
  return { model: "deepseek-v4-pro", provider: "openai", maxTurns: 20 } as unknown as Config;
}

async function* emptyStream(): AsyncIterable<StreamEvent> {
  /* processStream 被 mock，此处不产事件 */
}

/** stop_sequence 正常结束（有 content，无 tool_use） */
function stopSequenceResp(text: string): AccumulatedResponse {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop_sequence",
    usage: { inputTokens: 100, outputTokens: 20 },
  } as AccumulatedResponse;
}

/** stop_sequence 但含 tool_use（应走 F2 fall-through 执行工具） */
function stopSequenceWithToolResp(): AccumulatedResponse {
  return {
    role: "assistant",
    content: [
      { type: "text", text: "调用工具" },
      { type: "tool_use", id: "tu-1", name: "read_file", input: { path: "/tmp/x" } },
    ],
    stopReason: "stop_sequence",
    usage: { inputTokens: 100, outputTokens: 20 },
  } as AccumulatedResponse;
}

/** 普通 end_turn 正常收尾（用于终结 fall-through 后的续循环） */
function normalResp(text: string): AccumulatedResponse {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "end_turn",
    usage: { inputTokens: 100, outputTokens: 20 },
  } as AccumulatedResponse;
}

function makeLoopConfig(
  responses: AccumulatedResponse[],
  overrides: Partial<QueryDeps> = {},
): { loopConfig: QueryLoopConfig; ctxMgr: ContextManager; toolCalls: string[] } {
  const ctxMgr = new ContextManager({ maxTokens: 200000 });
  ctxMgr.setSystemPrompt("test");
  ctxMgr.addMessage({ role: "user", content: [{ type: "text", text: "请处理" }] });

  const toolCalls: string[] = [];
  let call = 0;
  const deps: QueryDeps = {
    sendWithRetry: () => emptyStream(),
    processStream: async () => {
      const r = responses[call] ?? normalResp("已完成");
      call++;
      return r;
    },
    executeTools: async (content: any[]) => {
      const toolUses = content.filter((b: any) => b.type === "tool_use");
      for (const tu of toolUses) toolCalls.push(tu.name);
      return {
        results: toolUses.map((tu: any) => ({
          type: "tool_result" as const,
          tool_use_id: tu.id,
          content: "ok",
        })),
      };
    },
    autoCompact: async () => {},
    handleContextOverflow: () => null,
    getAbortSignal: () => undefined,
    uuid: () => "uuid-test",
    ...overrides,
  };

  const loopConfig: QueryLoopConfig = {
    config: makeConfig(),
    ctxMgr,
    toolRegistry: new ToolRegistry(),
    sessionState: new SessionState("test-session"),
    fallback: new ModelFallback(),
    deps,
  };
  return { loopConfig, ctxMgr, toolCalls };
}

describe("缺口 2 — stop_sequence 走正常收尾链（queryLoop 集成）", () => {
  test("stop_sequence + 有 content → 正常收尾，不弹'未识别停止原因'警告", async () => {
    const { loopConfig } = makeLoopConfig([stopSequenceResp("这是模型撞到 stop 序列后的正常回答")]);

    const systemTexts: string[] = [];
    const kinds: string[] = [];
    for await (const ev of queryLoop(loopConfig)) {
      kinds.push(ev.kind);
      if (ev.kind === "system" && "text" in ev) systemTexts.push(ev.text);
    }

    // 关键断言 1：不产生"未识别停止原因"警告
    expect(systemTexts.some((t) => t.includes("未识别的停止原因"))).toBe(false);
    // 关键断言 2：正常呈现 assistant 消息 + 正常收尾 done
    expect(kinds).toContain("assistant_message");
    expect(kinds).toContain("done");
  });

  test("stop_sequence + 有 content → 触发 AfterAgent hook（收尾链跑到了）", async () => {
    let afterAgentFired = false;
    // 只 mock queryLoop 实际调用的三个 fire 方法；BeforeModel/AfterModel 返回无阻塞决策。
    const noBlock = { finalOutput: undefined };
    const hookSystem = {
      fireBeforeModelEvent: async () => noBlock,
      fireAfterModelEvent: async () => noBlock,
      fireAfterAgentEvent: async () => {
        afterAgentFired = true;
        return { finalOutput: { shouldClearContext: () => false } };
      },
    } as any;

    const { loopConfig } = makeLoopConfig([stopSequenceResp("正常回答")], {});
    (loopConfig as any).hookSystem = hookSystem;

    for await (const _ev of queryLoop(loopConfig)) {
      /* drain */
    }

    // stop_sequence 必须触发 AfterAgent hook（证明走了 end_turn 收尾链而非警告分支）
    expect(afterAgentFired).toBe(true);
  });

  test("stop_sequence + 含 tool_use → 走 F2 fall-through 执行工具（不被误吞）", async () => {
    // 第 1 轮 stop_sequence 含 tool_use → 应执行工具续循环；第 2 轮正常 end_turn 收尾
    const { loopConfig, toolCalls } = makeLoopConfig([
      stopSequenceWithToolResp(),
      normalResp("工具结果已处理完成"),
    ]);

    const kinds: string[] = [];
    for await (const ev of queryLoop(loopConfig)) {
      kinds.push(ev.kind);
    }

    // 工具被实际执行（fall-through 生效，未被新分支误吞）
    expect(toolCalls).toContain("read_file");
    // 正常收尾
    expect(kinds).toContain("done");
  });
});
