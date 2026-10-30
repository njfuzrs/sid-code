/**
 * 压缩结局三态 + loop 层熔断归一（2026-10-29）。
 *
 * 缺陷（AgenticLoop 状态机与压缩熔断分层修复方案 L1-1 / L1-2 / L1-3）：
 *   - 失败计数只手写在流内 4 条恢复路径上，阈值三档 0 处计数 → hard 档压不动时每轮重跑
 *     contextCollapse / autoCompact（都调 LLM），loop 层不可见；
 *   - settleCompaction 返回 banner|null，「没事可做」与「压不动」同形，直接接熔断会误伤。
 *
 * 两层测法：
 *   1. judgeCompaction 纯函数：判定顺序与 NOOP_ALLOWED 逐条锁；
 *   2. 走真实 queryLoop：把 ctxMgr 钉在 hard 档、让管线「做了但没省」，由 autoCompact 桩决定结局。
 */

import { describe, test, expect } from "bun:test";
import { judgeCompaction } from "@sid-code/core/query/compact/outcome.ts";
import { queryLoop } from "@sid-code/core/query/loop.ts";
import type { QueryLoopConfig } from "@sid-code/core/query/loop.ts";
import type { QueryDeps } from "@sid-code/core/query/types.ts";
import { Manager as ContextManager } from "@sid-code/core/context/manager.ts";
import { Registry as ToolRegistry } from "@sid-code/core/tool/registry.ts";
import { ModelFallback } from "@sid-code/core/llm/fallback.ts";
import { SessionState } from "@sid-code/core/session/state.ts";
import type { Config } from "@sid-code/core/config/config.ts";
import type { AccumulatedResponse, ContentBlock } from "@sid-code/core/llm/types.ts";

describe("judgeCompaction — 判定顺序", () => {
  test("消息数下降 → applied / message_count（即使同时带 noopReason）", () => {
    expect(
      judgeCompaction({
        trigger: "threshold_hard",
        messageCountBefore: 10,
        messageCountAfter: 6,
        savedTokens: 500,
        noopReason: "lock_held",
      }),
    ).toEqual({ outcome: "applied", judgedBy: "message_count" });
  });

  test("消息数不变、savedTokens>0 → applied / saved_tokens", () => {
    expect(
      judgeCompaction({
        trigger: "threshold_hard",
        messageCountBefore: 10,
        messageCountAfter: 10,
        savedTokens: 1,
      }),
    ).toEqual({ outcome: "applied", judgedBy: "saved_tokens" });
  });

  test("主动压缩类 trigger + noopReason → noop", () => {
    for (const trigger of [
      "threshold_blocking",
      "threshold_emergency",
      "threshold_hard",
      "empty_param_retry",
    ] as const) {
      expect(
        judgeCompaction({
          trigger,
          messageCountBefore: 4,
          messageCountAfter: 4,
          savedTokens: 0,
          noopReason: "too_few_messages",
        }),
      ).toEqual({ outcome: "noop", judgedBy: "none", noopReason: "too_few_messages" });
    }
  });

  test("R1：API 已拒收的恢复路径带 noopReason 仍判 failed", () => {
    for (const trigger of [
      "prompt_too_long",
      "prompt_too_long_stream",
      "context_overflow",
      "ctx_window_exceeded",
    ] as const) {
      expect(
        judgeCompaction({
          trigger,
          messageCountBefore: 4,
          messageCountAfter: 4,
          noopReason: "no_split_point",
        }).outcome,
      ).toBe("failed");
    }
  });

  test("没压动且无 noopReason → failed", () => {
    expect(
      judgeCompaction({
        trigger: "threshold_hard",
        messageCountBefore: 10,
        messageCountAfter: 10,
        savedTokens: 0,
      }),
    ).toEqual({ outcome: "failed", judgedBy: "none" });
  });
});

// ─── queryLoop 端到端 ───

const WINDOW = 200_000;

type AutoKind = "summarized" | "truncated" | "failed" | "skipped";
type AutoResult = { kind: AutoKind; reason?: "too_few_messages" | "lock_held" | "hook_blocked" };

interface Captured {
  event: string;
  data: Record<string, any>;
}

function toolUseResp(i: number): AccumulatedResponse {
  return {
    role: "assistant",
    content: [{ type: "tool_use", id: `call-${i}`, name: "bash", input: { command: "ls" } }],
    stopReason: "tool_use",
    usage: { inputTokens: 100, outputTokens: 20 },
  } as AccumulatedResponse;
}

/**
 * 把 ctxMgr 钉在 hard 档：占用恒 90%，管线 snip 能算出步骤但 setMessages 不落地
 * （= 「做了但没省」），于是本次尝试的结局完全由 autoCompact 桩决定。
 * autoCompact 桩可通过 `shrink()` 让同源 token 下降，模拟真压动。
 */
function harness(opts: {
  turns: number;
  autoCompact: (call: number, shrink: () => void) => AutoResult;
  contextCollapse?: boolean;
  sendWithRetry?: (turn: number) => void;
}) {
  const ctxMgr = new ContextManager({ maxTokens: WINDOW });
  ctxMgr.setSystemPrompt("test");
  for (let i = 0; i < 6; i++) {
    ctxMgr.addMessage({ role: "user", content: [{ type: "text", text: `问题 ${i}` }] });
    ctxMgr.addMessage({ role: "assistant", content: [{ type: "text", text: `回答 ${i}` }] });
  }
  ctxMgr.addMessage({ role: "user", content: [{ type: "text", text: "继续" }] });
  let sameSource = WINDOW * 0.9;
  const m = ctxMgr as any;
  m.getCompactionLevel = () => "hard";
  m.estimateTokens = () => WINDOW * 0.9;
  m.estimateTokensFor = () => sameSource;
  m.setMessages = () => {};

  const events: Captured[] = [];
  let autoCalls = 0;
  let collapseCalls = 0;
  let pipelineSteps = 0;
  let sendCalls = 0;
  let turn = 0;
  const deps = {
    sendWithRetry: () => {
      sendCalls++;
      opts.sendWithRetry?.(sendCalls);
      return (async function* () {})();
    },
    processStream: async () => toolUseResp(turn++),
    executeTools: async (content: ContentBlock[]) => ({
      results: content
        .filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use")
        .map((b) => ({ type: "tool_result" as const, tool_use_id: b.id, content: "ok" })),
    }),
    autoCompact: async () => {
      autoCalls++;
      return opts.autoCompact(autoCalls, () => {
        sameSource -= 10_000;
      });
    },
    ...(opts.contextCollapse
      ? {
          contextCollapse: async () => {
            collapseCalls++;
            return false;
          },
        }
      : {}),
    getAbortSignal: () => undefined,
    abortCurrentRequest: () => {},
    uuid: () => "u",
    traceAppendEvent: (e: { event: string; data?: Record<string, unknown> }) => {
      events.push({ event: e.event, data: (e.data ?? {}) as Record<string, any> });
      if (e.event === "CompactionAttempt" && e.data?.strategy) pipelineSteps++;
    },
  } as unknown as QueryDeps;

  const loopConfig: QueryLoopConfig = {
    config: {
      model: "test-model",
      provider: "anthropic",
      maxTurns: opts.turns,
    } as unknown as Config,
    ctxMgr,
    toolRegistry: new ToolRegistry(),
    sessionState: new SessionState("test-compact-circuit"),
    fallback: new ModelFallback(),
    deps,
  };

  return {
    loopConfig,
    events,
    ctxMgr,
    get autoCalls() {
      return autoCalls;
    },
    get collapseCalls() {
      return collapseCalls;
    },
    get pipelineSteps() {
      return pipelineSteps;
    },
  };
}

async function drain(loopConfig: QueryLoopConfig) {
  const out: Array<{ kind: string; text?: string; level?: string; terminal?: boolean }> = [];
  for await (const ev of queryLoop(loopConfig)) out.push(ev as any);
  return out;
}

const attempts = (evs: Captured[]) =>
  evs.filter((e) => e.event === "CompactionAttempt" && e.data.trigger === "threshold_hard");

describe("阈值档接入失败计数（L1-1）", () => {
  test("连续 3 次 threshold_hard failed → 开闸 + 恰好 1 条 CompactionCircuitBreaker", async () => {
    const h = harness({ turns: 6, autoCompact: () => ({ kind: "failed" }), contextCollapse: true });
    const out = await drain(h.loopConfig);

    const hard = attempts(h.events);
    expect(hard.length).toBeGreaterThanOrEqual(3);
    expect(hard.slice(0, 3).map((e) => e.data.outcome)).toEqual(["failed", "failed", "failed"]);
    expect(hard.slice(0, 3).map((e) => e.data.consecutive_failures)).toEqual([1, 2, 3]);
    expect(hard[2].data.circuit_open).toBe(true);
    expect(hard[0].data.prompt_seq).toBeDefined();
    expect(typeof hard[0].data.turn).toBe("number");

    const breakers = h.events.filter((e) => e.event === "CompactionCircuitBreaker");
    expect(breakers).toHaveLength(1);
    expect(breakers[0].data.failure_count).toBe(3);
    expect(breakers[0].data.last_trigger).toBe("threshold_hard");

    // 熔断后只拦花钱的动作：之后 autoCompact / collapse 零调用
    expect(h.autoCalls).toBe(3);
    expect(h.collapseCalls).toBe(3);
    const skipped = h.events.filter((e) => e.event === "CompactionSkipped");
    // 第 4、5、6 轮各跳过 collapse + autoCompact
    expect(skipped.length).toBe(6);
    expect(new Set(skipped.map((e) => e.data.skipped))).toEqual(
      new Set(["context_collapse", "auto_compact"]),
    );
    expect(skipped.every((e) => e.data.reason === "circuit_open")).toBe(true);

    // 本地管线照做：熔断后的轮次仍有带 strategy 的 CompactionAttempt
    expect(hard.length).toBe(6);
    // 主循环继续，不是终止本轮
    expect(out.filter((e) => e.kind === "system" && e.terminal)).toHaveLength(0);
    // 只提示一次
    const warn = out.filter(
      (e) => e.kind === "system" && e.text?.includes("不再尝试 LLM 摘要压缩"),
    );
    expect(warn).toHaveLength(1);

    // TurnComplete 带熔断态
    const tc = h.events.find((e) => e.event === "TurnComplete");
    expect(tc?.data.compact_circuit_open).toBe(true);
    expect(tc?.data.consecutive_compact_failures).toBeGreaterThanOrEqual(3);
  }, 20_000);

  test("autoCompact skipped(lock_held) 判 noop：10 轮不计数、不熔断", async () => {
    const h = harness({
      turns: 10,
      autoCompact: () => ({ kind: "skipped", reason: "lock_held" }),
    });
    await drain(h.loopConfig);
    const hard = attempts(h.events);
    expect(hard.length).toBe(10);
    expect(hard.every((e) => e.data.outcome === "noop")).toBe(true);
    expect(hard.every((e) => e.data.noop_reason === "lock_held")).toBe(true);
    expect(hard.every((e) => e.data.consecutive_failures === 0)).toBe(true);
    expect(h.events.filter((e) => e.event === "CompactionCircuitBreaker")).toHaveLength(0);
    expect(h.autoCalls).toBe(10);
    const tc = h.events.find((e) => e.event === "TurnComplete");
    expect(tc?.data.compact_circuit_open).toBeUndefined();
    expect(tc?.data.consecutive_compact_failures).toBeUndefined();
  }, 20_000);

  test("实测证据压过 noopReason：autoCompact 真压动 → applied + 横幅", async () => {
    const h = harness({
      turns: 1,
      autoCompact: (_c, shrink) => {
        shrink();
        return { kind: "summarized" };
      },
    });
    const out = await drain(h.loopConfig);
    const hard = attempts(h.events);
    expect(hard[0].data.outcome).toBe("applied");
    expect(hard[0].data.judged_by).toBe("saved_tokens");
    expect(hard[0].data.success).toBe(true);
    expect(out.some((e) => e.kind === "compact")).toBe(true);
  }, 20_000);

  test("计数字段是判定后的值：failed, failed, applied, failed → 1, 2, 0, 1；applied 不关闸", async () => {
    const seq: AutoKind[] = ["failed", "failed", "summarized", "failed"];
    const h = harness({
      turns: 4,
      autoCompact: (c, shrink) => {
        const kind = seq[c - 1];
        if (kind === "summarized") shrink();
        return { kind };
      },
    });
    await drain(h.loopConfig);
    const hard = attempts(h.events);
    expect(hard.map((e) => e.data.consecutive_failures)).toEqual([1, 2, 0, 1]);
    expect(hard.map((e) => e.data.outcome)).toEqual(["failed", "failed", "applied", "failed"]);
    expect(hard.every((e) => e.data.success === (e.data.outcome === "applied"))).toBe(true);
  }, 20_000);

  test("latch：开闸后 applied 只清零计数，熔断不关、事件只 1 条", async () => {
    // 熔断后 autoCompact 不再被调，用 setMessages 恢复落地制造一次「本地管线 applied」
    const h = harness({ turns: 5, autoCompact: () => ({ kind: "failed" }) });
    const m = h.ctxMgr as any;
    let n = 0;
    const realSet = ContextManager.prototype.setMessages;
    h.loopConfig.deps.traceAppendEvent = ((orig) => (e: any) => {
      orig?.(e);
      if (e.event === "CompactionCircuitBreaker") {
        // 开闸之后让管线的 snip 真正落地 → 消息数下降 → applied
        m.setMessages = (msgs: any) => {
          n++;
          realSet.call(h.ctxMgr, msgs);
        };
      }
    })(h.loopConfig.deps.traceAppendEvent);
    await drain(h.loopConfig);
    const hard = attempts(h.events);
    const afterOpen = hard.slice(3);
    expect(n).toBeGreaterThan(0);
    expect(afterOpen.some((e) => e.data.outcome === "applied")).toBe(true);
    const applied = afterOpen.find((e) => e.data.outcome === "applied")!;
    expect(applied.data.consecutive_failures).toBe(0);
    expect(applied.data.circuit_open).toBe(true);
    expect(h.events.filter((e) => e.event === "CompactionCircuitBreaker")).toHaveLength(1);
    expect(h.autoCalls).toBe(3);
  }, 20_000);
});

describe("熔断后 PTL 兜底语义不变（终止本轮，不再调 autoCompact）", () => {
  test("阈值档开闸后撞 PTL → terminal system + done，autoCompact 不再被调", async () => {
    const PTL = "prompt is too long: 250000 tokens > 200000 maximum";
    const h = harness({
      turns: 10,
      autoCompact: () => ({ kind: "failed" }),
      // 前 3 轮正常（hard 档 3 次 failed 开闸），之后一律 PTL
      sendWithRetry: (n) => {
        if (n > 3) throw new Error(PTL);
      },
    });
    const out = await drain(h.loopConfig);
    expect(h.autoCalls).toBe(3);
    expect(out.some((e) => e.kind === "system" && e.terminal)).toBe(true);
    expect(out[out.length - 1].kind).toBe("done");
  }, 20_000);
});

describe("context_overflow 调用点补同源 token", () => {
  test("PTL 兜底的 CompactionAttempt 带 savedTokens，没压动计为 failed", async () => {
    const PTL = "prompt is too long: 250000 tokens > 200000 maximum";
    const h = harness({
      turns: 10,
      autoCompact: () => ({ kind: "failed" }),
      sendWithRetry: () => {
        throw new Error(PTL);
      },
    });
    await drain(h.loopConfig);
    const overflow = h.events.filter(
      (e) => e.event === "CompactionAttempt" && e.data.trigger === "context_overflow",
    );
    expect(overflow.length).toBeGreaterThan(0);
    expect(overflow.every((e) => typeof e.data.savedTokens === "number")).toBe(true);
    expect(overflow.every((e) => e.data.outcome === "failed")).toBe(true);
  }, 20_000);
});
