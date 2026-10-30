/**
 * 停止判据单一事实源（classifyStopReason）+ 主循环 terminal 出口不变量（2026-10-29）
 *
 * 锁住：
 *   1. 分类器规则表（白名单 fail-closed，未知值绝不进 execute_tools / finalize）
 *   2. terminal 出口（refusal / pause_turn / 未识别 / 空流）就地结算孤儿 tool_use，
 *      占位文案带该分支的停止原因
 *   3. `stop_reason=tool_use` 但无 tool_use 块 → 如实收尾，不空转一轮
 *   4. 非正常收尾的 incompleteReason 同时出现在 `yield done` 与 `TurnComplete.incomplete_reason`
 *      （同源 state.incompleteReason）；正常 end_turn 两处都不落字段
 *   5. F1 截断参数（半截 JSON 解出非空对象）判退化，不执行；耗尽带 empty_param_exhausted；
 *      每次命中落 EmptyParamRetry
 *
 * fix_type: regression_guard
 */
import { describe, test, expect } from "bun:test";
import { classifyStopReason } from "@sid-code/core/query/stop-reason-policy.ts";
import { queryLoop } from "@sid-code/core/query/loop.ts";
import type { QueryLoopConfig } from "@sid-code/core/query/loop.ts";
import type { QueryDeps } from "@sid-code/core/query/types.ts";
import {
  MAX_EMPTY_PARAM_RETRIES,
  detectEmptyParamToolUses,
  summarizeToolUseParams,
} from "@sid-code/core/query/empty-param.ts";
import { checkMessageHistoryIntegrity } from "@sid-code/core/agent/message-invariants.ts";
import { Manager as ContextManager } from "@sid-code/core/context/manager.ts";
import { Registry as ToolRegistry } from "@sid-code/core/tool/registry.ts";
import { ModelFallback } from "@sid-code/core/llm/fallback.ts";
import { SessionState } from "@sid-code/core/session/state.ts";
import type { Config } from "@sid-code/core/config/config.ts";
import type { AccumulatedResponse, ContentBlock, StreamEvent } from "@sid-code/core/llm/types.ts";

// ─── 1. 规则表 ──────────────────────────────────────────────────────────

describe("classifyStopReason 规则表", () => {
  const cases: Array<[string | null | undefined, boolean, boolean, unknown]> = [
    ["tool_use", true, true, { kind: "execute_tools", why: "tool_use" }],
    ["tool_use", false, true, { kind: "unknown", hasContent: true }],
    ["tool_use", false, false, { kind: "unknown", hasContent: false }],
    ["end_turn", true, true, { kind: "execute_tools", why: "f2_end_turn" }],
    ["stop", true, true, { kind: "execute_tools", why: "f2_end_turn" }],
    ["stop_sequence", true, true, { kind: "execute_tools", why: "f2_end_turn" }],
    ["end_turn", false, true, { kind: "finalize" }],
    ["stop", false, true, { kind: "finalize" }],
    ["stop_sequence", false, false, { kind: "finalize" }],
    ["max_tokens", true, true, { kind: "execute_tools", why: "f2_truncated" }],
    ["length", true, true, { kind: "execute_tools", why: "f2_truncated" }],
    ["max_tokens", false, true, { kind: "recover", how: "max_tokens" }],
    ["length", false, false, { kind: "recover", how: "max_tokens" }],
    ["model_context_window_exceeded", true, true, { kind: "recover", how: "ctx_window" }],
    ["model_context_window_exceeded", false, false, { kind: "recover", how: "ctx_window" }],
    ["refusal", true, true, { kind: "terminal", reason: "refusal" }],
    ["refusal", false, false, { kind: "terminal", reason: "refusal" }],
    ["pause_turn", true, true, { kind: "terminal", reason: "pause_turn" }],
    [null, false, false, { kind: "terminal", reason: "empty_stream" }],
    [undefined, false, false, { kind: "terminal", reason: "empty_stream" }],
    ["", false, false, { kind: "terminal", reason: "empty_stream" }],
    [null, false, true, { kind: "unknown", hasContent: true }],
    // 白名单 fail-closed：未知值即使带 tool_use 也不执行
    ["content_filter", true, true, { kind: "unknown", hasContent: true }],
    ["error", true, true, { kind: "unknown", hasContent: true }],
    ["END_TURN", false, true, { kind: "unknown", hasContent: true }],
  ];
  for (const [stopReason, hasToolUse, hasAnyContent, expected] of cases) {
    test(`${String(stopReason)} / toolUse=${hasToolUse} / content=${hasAnyContent}`, () => {
      expect(classifyStopReason({ stopReason, hasToolUse, hasAnyContent })).toEqual(
        expected as never,
      );
    });
  }

  test("未知值永不落 execute_tools / finalize（fail-closed）", () => {
    for (const sr of ["content_filter", "error", "weird", "Stop", null, ""]) {
      for (const t of [true, false]) {
        const a = classifyStopReason({ stopReason: sr, hasToolUse: t, hasAnyContent: true });
        expect(a.kind === "execute_tools" || a.kind === "finalize").toBe(false);
      }
    }
  });
});

// ─── 主循环夹具 ─────────────────────────────────────────────────────────

async function* emptyStream(): AsyncIterable<StreamEvent> {
  /* processStream 被 mock */
}

function makeConfig(): Config {
  return { model: "test-model", provider: "anthropic", maxTurns: 10 } as unknown as Config;
}

function toolUse(id: string, input: Record<string, unknown>, extra: object = {}): ContentBlock {
  return { type: "tool_use", id, name: "write", input, ...extra } as ContentBlock;
}

function resp(stopReason: string | null, content: ContentBlock[]): AccumulatedResponse {
  return {
    role: "assistant",
    content,
    stopReason,
    usage: { inputTokens: 10, outputTokens: 5 },
  } as AccumulatedResponse;
}

const WRITE_SCHEMA = {
  type: "object",
  properties: { file_path: { type: "string" }, content: { type: "string" } },
  required: ["file_path", "content"],
};

function setup(responses: AccumulatedResponse[]) {
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const executed: string[] = [];
  const ctxMgr = new ContextManager({ maxTokens: 200000 });
  ctxMgr.setSystemPrompt("test");
  ctxMgr.addMessage({ role: "user", content: [{ type: "text", text: "写文件" }] });
  const toolRegistry = new ToolRegistry();
  toolRegistry.register({
    name: () => "write",
    description: () => "write",
    inputSchema: () => WRITE_SCHEMA,
    readOnly: () => false,
    execute: async () => ({ output: "ok" }),
  } as never);
  let call = 0;
  const deps: QueryDeps = {
    sendWithRetry: () => emptyStream(),
    processStream: async () => {
      const r = responses[call] ?? resp("end_turn", [{ type: "text", text: "完成" }]);
      call++;
      return r;
    },
    executeTools: async (content: ContentBlock[]) => {
      const results: ContentBlock[] = [];
      for (const b of content) {
        if (b.type !== "tool_use") continue;
        executed.push(b.id);
        results.push({ type: "tool_result", tool_use_id: b.id, content: "ok" } as ContentBlock);
      }
      return { results };
    },
    autoCompact: async () => {},
    getAbortSignal: () => undefined,
    uuid: () => `uuid-${call}`,
    traceAppendEvent: (ev: { event: string; data?: Record<string, unknown> }) => {
      events.push({ event: ev.event, data: (ev.data ?? {}) as Record<string, unknown> });
    },
  } as unknown as QueryDeps;
  const loopConfig: QueryLoopConfig = {
    config: makeConfig(),
    ctxMgr,
    toolRegistry,
    sessionState: new SessionState("test-stop-policy"),
    fallback: new ModelFallback(),
    deps,
  };
  return { loopConfig, events, ctxMgr, executed, calls: () => call };
}

async function drain(loopConfig: QueryLoopConfig) {
  const yields: Array<Record<string, unknown>> = [];
  for await (const ev of queryLoop(loopConfig)) yields.push(ev as Record<string, unknown>);
  return yields;
}
const doneOf = (ys: Array<Record<string, unknown>>) => ys.find((y) => y.kind === "done");
const turnCompleteOf = (es: Array<{ event: string; data: Record<string, unknown> }>) =>
  es.find((e) => e.event === "TurnComplete");

// ─── 2/3/4. terminal 出口 ──────────────────────────────────────────────

describe("terminal 出口：就地结算孤儿 + incompleteReason 同源", () => {
  const terminalCases: Array<[string | null, string, string]> = [
    ["refusal", "refusal", "安全策略拒答"],
    ["pause_turn", "pause_turn", "pause_turn"],
    ["content_filter", "unknown_stop_reason", "未识别的停止原因"],
    // 报 tool_use 却无 tool_use 块：此前会 executeTools([]) 后 continue 空转
  ];
  for (const [sr, reason, textFrag] of terminalCases) {
    test(`stop_reason=${sr} + 2 个 tool_use → 不执行、无孤儿、done/TurnComplete 带 ${reason}`, async () => {
      const { loopConfig, ctxMgr, events, executed, calls } = setup([
        resp(sr, [
          { type: "text", text: "前言" },
          toolUse("t1", { file_path: "a", content: "x" }),
          toolUse("t2", { file_path: "b", content: "y" }),
        ]),
      ]);
      const ys = await drain(loopConfig);
      expect(calls()).toBe(1);
      expect(executed).toEqual([]);
      expect(checkMessageHistoryIntegrity(ctxMgr.getMessages()).orphans.length).toBe(0);
      const placeholders = ctxMgr
        .getMessages()
        .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
        .filter((b) => b.type === "tool_result")
        .map((b) => JSON.stringify(b));
      expect(placeholders.length).toBe(2);
      expect(placeholders.every((p) => p.includes(textFrag))).toBe(true);
      expect(doneOf(ys)?.incompleteReason).toBe(reason);
      const tc = turnCompleteOf(events);
      expect(tc?.data.incomplete_reason).toBe(reason);
      expect(tc?.data.stop_reason).toBe("other");
      expect(tc?.data.stop_reason_kind).toBe("normalized");
    });
  }

  test("stop_reason=tool_use 但无 tool_use 块 → 如实收尾，不空转一轮", async () => {
    const { loopConfig, events, calls } = setup([
      resp("tool_use", [{ type: "text", text: "我来调用工具" }]),
    ]);
    const ys = await drain(loopConfig);
    expect(calls()).toBe(1);
    expect(
      events.filter((e) => e.event === "LoopTransition").map((e) => e.data.type),
    ).not.toContain("tool_use");
    expect(doneOf(ys)?.incompleteReason).toBe("unknown_stop_reason");
  });

  test("空流（null + 无内容）→ empty_stream", async () => {
    const { loopConfig, events } = setup([resp(null, [])]);
    const ys = await drain(loopConfig);
    expect(doneOf(ys)?.incompleteReason).toBe("empty_stream");
    expect(turnCompleteOf(events)?.data.incomplete_reason).toBe("empty_stream");
  });

  test("正常 end_turn → done 与 TurnComplete 都不落 incomplete 字段", async () => {
    const { loopConfig, events } = setup([resp("end_turn", [{ type: "text", text: "完成了" }])]);
    const ys = await drain(loopConfig);
    expect("incompleteReason" in (doneOf(ys) ?? {})).toBe(false);
    const tc = turnCompleteOf(events);
    expect(tc?.data.stop_reason).toBe("end_turn");
    expect("incomplete_reason" in (tc?.data ?? {})).toBe(false);
  });
});

// ─── 5. F1 截断参数 ────────────────────────────────────────────────────

describe("F1：截断参数纳入退化判据", () => {
  test("纯函数：_partial（半截解出非空对象）/ _truncated 判退化，完整参数不判", () => {
    const content = [
      toolUse("p", { file_path: "x" }, { _partial: true }),
      toolUse("t", {}, { _truncated: true }),
      toolUse("ok", { file_path: "x", content: "y" }),
    ];
    const hits = detectEmptyParamToolUses(content, () => WRITE_SCHEMA);
    expect(hits.map((h) => [h.id, h.truncated])).toEqual([
      ["p", true],
      ["t", true],
    ]);
    // 截断优先于 schema：无必填参数的工具被截断同样判退化
    expect(
      detectEmptyParamToolUses([toolUse("n", { a: 1 }, { _partial: true })], () => ({
        type: "object",
        properties: {},
      })).length,
    ).toBe(1);
    expect(summarizeToolUseParams(content, () => WRITE_SCHEMA)).toEqual({
      tool_use_total: 3,
      tool_use_empty_params: 1,
      tool_use_truncated: 2,
      tool_use_missing_required: 1,
    });
  });

  test("主循环：截断但非空的 write 不执行，重试后完整参数才执行；落 EmptyParamRetry", async () => {
    const { loopConfig, events, executed } = setup([
      resp("tool_use", [toolUse("half", { file_path: "a.ts" }, { _partial: true })]),
      resp("tool_use", [toolUse("full", { file_path: "a.ts", content: "完整" })]),
      resp("end_turn", [{ type: "text", text: "写完了" }]),
    ]);
    await drain(loopConfig);
    expect(executed).toEqual(["full"]);
    const retry = events.find((e) => e.event === "EmptyParamRetry");
    expect(retry?.data).toMatchObject({
      attempt: 1,
      max_attempts: MAX_EMPTY_PARAM_RETRIES,
      compacted: false,
      compact_level: "none",
      hits: [{ name: "write", truncated: true, has_required_params: true }],
    });
  });

  test("耗尽 → 硬停，done/TurnComplete 带 empty_param_exhausted", async () => {
    const { loopConfig, events, executed } = setup(
      Array.from({ length: MAX_EMPTY_PARAM_RETRIES + 2 }, () =>
        resp("tool_use", [toolUse("e", {})]),
      ),
    );
    const ys = await drain(loopConfig);
    expect(executed).toEqual([]);
    expect(doneOf(ys)?.incompleteReason).toBe("empty_param_exhausted");
    expect(turnCompleteOf(events)?.data.incomplete_reason).toBe("empty_param_exhausted");
    const retries = events.filter((e) => e.event === "EmptyParamRetry");
    expect(retries.length).toBe(MAX_EMPTY_PARAM_RETRIES + 1);
    expect(retries.at(-1)?.data.exhausted).toBe(true);
  });
});
