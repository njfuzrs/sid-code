/**
 * 两条高危 compaction trigger 的事件基线（L2-E，2026-10-29）
 *
 * 本机 470 会话里 `CompactionAttempt.trigger=empty_param_retry / ctx_window_exceeded` 各 0 条，
 * 而它们恰是本轮改动的两条路径。没有这条测试，「修复前后」就没有对比口径——
 * 无法证明这两条路径压动时事件真的会落。
 *
 * fix_type: regression_guard
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
import type { AccumulatedResponse, ContentBlock, StreamEvent } from "@sid-code/core/llm/types.ts";

async function* emptyStream(): AsyncIterable<StreamEvent> {}

function resp(stopReason: string, content: ContentBlock[]): AccumulatedResponse {
  return {
    role: "assistant",
    content,
    stopReason,
    usage: { inputTokens: 10, outputTokens: 5 },
  } as AccumulatedResponse;
}

/**
 * 20 对长消息：足够 reactiveCompact 裁剪（> 4 条）。占用档位不靠堆 token 凑——
 * 轮首的阈值压缩会先把占用压回去，凑出来的档位随阈值系数漂移。F1 那条用例直接把
 * getCompactionLevel 钉在 soft（门禁放行的最低档），只测「放行后事件落不落」。
 */
function setup(responses: AccumulatedResponse[]) {
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const ctxMgr = new ContextManager({ maxTokens: 100_000 });
  ctxMgr.setSystemPrompt("test");
  for (let i = 0; i < 20; i++) {
    ctxMgr.addMessage({
      role: "user",
      content: [{ type: "text", text: `问题 ${i} `.repeat(400) }],
    });
    ctxMgr.addMessage({
      role: "assistant",
      content: [{ type: "text", text: `回答 ${i} `.repeat(400) }],
    });
  }
  ctxMgr.addMessage({ role: "user", content: [{ type: "text", text: "写文件" }] });
  const toolRegistry = new ToolRegistry();
  toolRegistry.register({
    name: () => "write",
    description: () => "write",
    inputSchema: () => ({
      type: "object",
      properties: { file_path: { type: "string" } },
      required: ["file_path"],
    }),
    readOnly: () => false,
    execute: async () => ({ output: "ok" }),
  } as never);
  let call = 0;
  const deps = {
    sendWithRetry: () => emptyStream(),
    processStream: async () =>
      responses[call++] ?? resp("end_turn", [{ type: "text", text: "完成" }]),
    executeTools: async () => ({ results: [] }),
    autoCompact: async () => {},
    getAbortSignal: () => undefined,
    uuid: () => `uuid-${call}`,
    traceAppendEvent: (ev: { event: string; data?: Record<string, unknown> }) => {
      events.push({ event: ev.event, data: ev.data ?? {} });
    },
  } as unknown as QueryDeps;
  const loopConfig: QueryLoopConfig = {
    config: { model: "test-model", provider: "anthropic", maxTurns: 10 } as unknown as Config,
    ctxMgr,
    toolRegistry,
    sessionState: new SessionState("test-compaction-trigger"),
    fallback: new ModelFallback(),
    deps,
  };
  return { loopConfig, events, ctxMgr };
}

async function drain(c: QueryLoopConfig) {
  for await (const _ of queryLoop(c)) {
    /* 只看事件 */
  }
}
const attemptsOf = (es: Array<{ event: string; data: Record<string, unknown> }>, trigger: string) =>
  es.filter((e) => e.event === "CompactionAttempt" && e.data.trigger === trigger);

describe("高危 compaction trigger 基线", () => {
  test("F1 重试且占用 ≥ soft → 落 CompactionAttempt(trigger=empty_param_retry)，EmptyParamRetry.compacted=true", async () => {
    const { loopConfig, events, ctxMgr } = setup([
      resp("tool_use", [{ type: "tool_use", id: "e", name: "write", input: {} } as ContentBlock]),
    ]);
    ctxMgr.getCompactionLevel = () => "soft";
    await drain(loopConfig);
    const a = attemptsOf(events, "empty_param_retry");
    expect(a.length).toBe(1);
    const retry = events.find((e) => e.event === "EmptyParamRetry");
    expect(retry?.data.compacted).toBe(true);
    expect(retry?.data.compact_level).toBe("soft");
  });

  test("model_context_window_exceeded 压得动 → 落 CompactionAttempt(trigger=ctx_window_exceeded)", async () => {
    const { loopConfig, events } = setup([
      resp("model_context_window_exceeded", [{ type: "text", text: "半截" }]),
    ]);
    await drain(loopConfig);
    const a = attemptsOf(events, "ctx_window_exceeded");
    expect(a.length).toBeGreaterThanOrEqual(1);
    expect(a[0]!.data.success).toBe(true);
  });
});
