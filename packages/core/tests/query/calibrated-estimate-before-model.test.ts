/**
 * F6（2026-11-12）：queryLoop 把**校准后**输入估算交给 BeforeModel，由采集器写进
 * `raw.jsonl` 的 `request_sent.estimated_input_tokens_calibrated`。
 *
 * 为什么要有这一层：collector 单测里的校准值是测试自己手塞的，**loop 要是永远传 null，
 * 那边照样全绿**——这正是「仪器空洞被当成事实」的老坑。所以这里走真实 queryLoop，
 * 断言两件事：
 * 1. 未校准（首轮）→ `null`，不回落成未校准值；
 * 2. 已校准 → 恰等于 `ContextManager.estimateTokensFor(发送副本)`，不是别的口径
 *    （比如 `estimateTokens` 的全量 + `lastActualInputTokens` 锚点）。
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

async function* emptyStream(): AsyncIterable<StreamEvent> {
  /* processStream 被 mock */
}

/**
 * 跑一轮真实 queryLoop，返回采集器会收到的 BeforeModel 载荷。
 *
 * @param calibrateTo 传入时，先按「真实 usage = 启发式基线 × 该倍数」喂一次
 *   `recordActualTokens`，让 calibrationFactor 学到这个倍数（≠1 才能区分校准值与未校准值）。
 */
async function captureBeforeModel(opts: { calibrateTo?: number } = {}): Promise<{
  payload: any;
  expectedAtHook: number;
}> {
  const ctxMgr = new ContextManager({ maxTokens: 200000 });
  ctxMgr.setSystemPrompt("test");
  ctxMgr.addMessage({ role: "user", content: [{ type: "text", text: "hi" }] });
  if (opts.calibrateTo !== undefined) {
    // 未校准时 estimateTokensFor 返回纯启发式基线，用它当分母构造一次真实 usage
    const raw = ctxMgr.estimateTokensFor(ctxMgr.getMessages(), 0);
    ctxMgr.recordActualTokens(Math.round(raw * opts.calibrateTo), 0);
  }

  const deps: QueryDeps = {
    sendWithRetry: () => emptyStream(),
    processStream: async () =>
      ({
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1 },
      }) as AccumulatedResponse,
    executeTools: async () => ({ results: [] }),
    autoCompact: async () => ({ kind: "skipped" as const }),
    getAbortSignal: () => undefined,
    uuid: () => "uuid-test",
    getThinkingSetting: () => undefined,
  };

  const seen: any[] = [];
  const noBlock = { finalOutput: undefined };
  const hookSystem = {
    fireBeforeModelEvent: async (data: any) => {
      // ⚠️ 必须在这里同步重算：`data.raw_messages` 是 loop 里那个数组的**引用**，
      // 本轮结束后会被追加 assistant/tool_result 消息，事后重算得到的是「变长之后」的
      // 口径（实测 9 vs 7），断言会假红。
      seen.push({ data, expected: ctxMgr.estimateTokensFor(data.raw_messages as any, 0) });
      return noBlock;
    },
    fireAfterModelEvent: async () => noBlock,
    fireAfterAgentEvent: async () => ({ finalOutput: { shouldClearContext: () => false } }),
  } as any;

  const loopConfig: QueryLoopConfig = {
    config: { model: "claude-test", provider: "openai", maxTurns: 5 } as unknown as Config,
    ctxMgr,
    toolRegistry: new ToolRegistry(),
    sessionState: new SessionState("test-session"),
    fallback: new ModelFallback(),
    deps,
  };
  (loopConfig as any).hookSystem = hookSystem;
  for await (const _ev of queryLoop(loopConfig)) {
    /* drain */
  }
  expect(seen.length).toBeGreaterThan(0);
  return { payload: seen[0].data, expectedAtHook: seen[0].expected };
}

describe("F6：BeforeModel 带校准后输入估算", () => {
  test("首轮未校准 → 字段存在且为 null（不回落成未校准值）", async () => {
    const { payload } = await captureBeforeModel();
    // 字段位必须在（undefined = 采集器会写成 null，但那就分不清「没接上」与「首轮」了）
    expect("estimated_input_tokens_calibrated" in payload).toBe(true);
    expect(payload.estimated_input_tokens_calibrated).toBeNull();
  });

  test("已校准 → 恰等于 estimateTokensFor(发送副本)，不是全量+锚点口径", async () => {
    const { payload, expectedAtHook } = await captureBeforeModel({ calibrateTo: 1.5 });
    const calibrated = payload.estimated_input_tokens_calibrated;

    expect(typeof calibrated).toBe("number");
    expect(calibrated).toBeGreaterThan(0);
    // 精确接线断言：口径必须是「对发送副本的校准估算」
    expect(calibrated).toBe(expectedAtHook);
    // 反证：传下来的不是未校准值。factor=1.5，未校准值约为校准值的 2/3，
    // 两者不可能相等——若 loop 误传了 estimateMessagesTokens 那种未校准口径，上面那条就挂了。
    expect(calibrated).not.toBe(Math.round(calibrated / 1.5));
  });
});
