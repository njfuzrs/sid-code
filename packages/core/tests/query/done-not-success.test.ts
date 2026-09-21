/**
 * 16 号 C2 门禁：`kind:"done"` 不得无条件映射成 `subtype=success`
 *
 * ## 拦的是什么
 *
 * `feal-differential-cryptanalysis`：13 轮里 10 轮被超时偷走，session.traj 只有
 * read + ls，verifier 给 0 分，而 metadata 记的是
 * `sid_subtype=success` / `sid_stop_reason=end_turn` / `sid_errors=None`。
 * 同形还有 `feal-linear-cryptanalysis`、`filter-js-from-html`（均 stolen=10、0 分）。
 *
 * 根因不在 loop：`queryLoop` 在超时重试耗尽时 yield `kind:"done"`，注释写明那是
 * 「优雅退出让 TUI 回到等待输入」—— 对 TUI 完全正确。错的是 `message-converter.ts`
 * 把 `done` **无条件**读成 success，于是 headless 评测把一次中断读成解出。
 *
 * ## 为什么不用 `turnsConsumedWithoutAssistant > 0` 当判据
 *
 * `break-filter-js-from-html` stolen=3 却真正写完了脚本、reward=1.0。
 * 拿 stolen>0 当失败会把它误判成失败 —— 16 §2.5 的「放弃」那一条。
 * 所以判据是 loop **显式声明**的 `incompleteReason`，不是从计数反推。
 *
 * ## 为什么门禁要跑真 loop，而不只喂 converter 一个手搓事件
 *
 * converter 改对了、但 loop 那条路径没打上标记，是这类修复最常见的半成品形态
 * （改完单测全绿，线上一模一样）。所以第 2 组用例走 `queryLoop`，让超时重试真的耗尽。
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
import { convertToSDKMessage } from "@sid-code/core/sdk/message-converter.ts";
import { SDKResultErrorSchema } from "@sid-code/core/sdk/schemas.ts";
import type { Config } from "@sid-code/core/config/config.ts";
import type { StreamEvent, AccumulatedResponse } from "@sid-code/core/llm/types.ts";

const CTX = {
  sessionId: "s1",
  totalUsage: { inputTokens: 0, outputTokens: 0 },
  startTime: 0,
  turnCount: 13,
  totalCostUsd: 0,
  now: () => 1000,
  uuid: () => "u1",
};

// ─────────────────────────────────────────────────────────────────
// 第 1 层：converter 的映射（fixture，16 §2.5 点名的验收形态）
// ─────────────────────────────────────────────────────────────────

describe("C2 门禁①：带 incompleteReason 的 done 一律非 success", () => {
  test("timeout_retry_exhausted → error_during_execution（feal-diff 的形态）", () => {
    const out = convertToSDKMessage(
      {
        kind: "done",
        turns: 13,
        turnsConsumedWithoutAssistant: 10,
        incompleteReason: "timeout_retry_exhausted",
      },
      CTX,
    ) as any;

    // 这一行就是整条 C2 的判据：修复前它是 "success"。
    expect(out.subtype).toBe("error_during_execution");
    expect(out.subtype).not.toBe("success");
    // 错误原文要说得出「超时」—— 否则这条样本在轨迹里与「模型没话说」同形，
    // 而两者的修法完全相反（一个查网关，一个是真能力失败）。
    expect(out.errors.join("\n")).toMatch(/超时/);
    // 被偷的格数照旧透出（§20.5 的字段不能因为换了 subtype 就丢）。
    expect(out.num_turns_without_model_interaction).toBe(10);
    expect(out.num_turns).toBe(13);
  });

  test("aborted → error_during_execution（用户中断也不是解出）", () => {
    const out = convertToSDKMessage(
      { kind: "done", turns: 5, incompleteReason: "aborted" },
      CTX,
    ) as any;
    expect(out.subtype).toBe("error_during_execution");
    expect(out.errors.join("\n")).toMatch(/中断/);
  });

  test("产出物过 SDKResultErrorSchema（不过 schema 就会被静默剥掉）", () => {
    // 「死接线」的一种形态：字段发了、类型也过了，但 schema 不认 → 解析后消失，
    // 全链路零报错。turn-budget-stolen 那个文件里有同形的一条。
    const out = convertToSDKMessage(
      { kind: "done", turns: 13, incompleteReason: "timeout_retry_exhausted" },
      CTX,
    ) as any;
    const parsed = SDKResultErrorSchema().parse(out);
    expect(parsed.subtype).toBe("error_during_execution");
    expect(parsed.errors.length).toBeGreaterThan(0);
  });
});

describe("C2 门禁②：正常收尾仍必须是 success（负例，防误杀）", () => {
  test("无 incompleteReason → success 逐字节不变", () => {
    const out = convertToSDKMessage({ kind: "done", turns: 3 }, CTX) as any;
    expect(out.subtype).toBe("success");
    expect(out.is_error).toBe(false);
    expect(out.stop_reason).toBe("end_turn");
  });

  test("stolen>0 但正常说完 → 仍 success（break-filter-js-from-html：stolen=3、reward=1.0）", () => {
    // ⛔ 这条是 16 §2.5 明确「放弃」的那个错误修法的门禁：
    // 若有人把判据改成 `turnsConsumedWithoutAssistant > 0`，这条立刻红。
    const out = convertToSDKMessage(
      { kind: "done", turns: 37, turnsConsumedWithoutAssistant: 3 },
      CTX,
    ) as any;
    expect(out.subtype).toBe("success");
    expect(out.num_turns_without_model_interaction).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────
// 第 2 层：真 loop —— 证明那条路径**真的**打了标记
// ─────────────────────────────────────────────────────────────────

async function* emptyStream(): AsyncIterable<StreamEvent> {
  /* processStream 被 mock，此处不产事件 */
}

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

/**
 * 走 `isTimeoutError` 的消息文本判据 —— 与真实 watchdog（abort reason 白名单）
 * 殊途同归，都汇聚到同一个 timeout 重试分支。用文本形态是因为它不需要伪造
 * AbortController 的 reason 锁定时序，脆弱性更低（沿用 turn-budget-stolen 的做法）。
 */
function timeoutError(): Error {
  return new Error("流式超时：stream timeout (simulated watchdog kill)");
}

function setup({
  maxTurns,
  maxTimeoutRetries,
  timeoutTurns = [],
}: {
  maxTurns: number;
  maxTimeoutRetries: number;
  timeoutTurns?: number[];
}) {
  const ctxMgr = new ContextManager({ maxTokens: 200000 });
  ctxMgr.setSystemPrompt("test");
  ctxMgr.addMessage({ role: "user", content: [{ type: "text", text: "请完成一个复杂任务" }] });

  const kill = new Set(timeoutTurns);
  let call = 0;
  const deps: QueryDeps = {
    sendWithRetry: () => emptyStream(),
    processStream: async () => {
      const n = call++;
      if (kill.has(n)) throw timeoutError();
      return toolUseResp(n);
    },
    executeTools: async () => ({ results: [] }),
    autoCompact: async () => {},
    handleContextOverflow: () => null,
    getAbortSignal: () => undefined,
    uuid: () => `uuid-${call}`,
  } as unknown as QueryDeps;

  const loopConfig: QueryLoopConfig = {
    config: {
      model: "claude-opus-4-8",
      provider: "anthropic",
      maxTurns,
      maxTokens: 8000,
      network: { maxTimeoutRetries, retryBackoffBaseMs: 1, retryBackoffMaxMs: 2 },
    } as unknown as Config,
    ctxMgr,
    toolRegistry: new ToolRegistry(),
    sessionState: new SessionState("test-done-not-success"),
    fallback: new ModelFallback(),
    deps,
  };
  return { loopConfig };
}

async function drain(loopConfig: QueryLoopConfig) {
  const events: any[] = [];
  for await (const ev of queryLoop(loopConfig)) events.push(ev);
  return events;
}

describe("C2 门禁③：loop 的超时耗尽路径真的打了标记（端到端）", () => {
  test("重试耗尽收尾的 done 带 incompleteReason，且 SDK 读出来非 success", async () => {
    // maxTimeoutRetries=1：第 2 次超时即耗尽重试，走收尾 return（非 max_turns）。
    const { loopConfig } = setup({
      maxTurns: 5,
      maxTimeoutRetries: 1,
      timeoutTurns: [0, 1, 2, 3, 4],
    });
    const events = await drain(loopConfig);

    const done = events.find((e) => e.kind === "done");
    expect(done).toBeDefined();
    // 确认走的是重试耗尽那条路，不是撞上限
    expect(events.some((e) => e.kind === "max_turns")).toBe(false);
    expect(events.filter((e) => e.kind === "assistant_message").length).toBe(0);

    // 核心断言：loop 侧必须显式声明「这不是正常说完」。
    // 少这一步，converter 改得再对也白改 —— 生产路径上永远是 undefined → success。
    expect(done.incompleteReason).toBe("timeout_retry_exhausted");

    // 端到端：Harbor 读的就是这个 subtype（metadata.sid_subtype）。
    const sdk = convertToSDKMessage(done, CTX) as any;
    expect(sdk.subtype).toBe("error_during_execution");
  });

  test("负例：同一 harness 下正常 end_turn 收尾的 done 不带标记 → 仍 success", async () => {
    // 前两轮被"watchdog"杀掉（stolen=2），第 3 轮正常说完 —— 即
    // break-filter-js-from-html 那种「被偷了格但真做完了」的形态。
    const { loopConfig } = setup({ maxTurns: 10, maxTimeoutRetries: 5, timeoutTurns: [] });
    const deps = loopConfig.deps as any;
    let call = 0;
    deps.processStream = async () => {
      const n = call++;
      if (n < 2) throw timeoutError();
      return {
        role: "assistant",
        content: [{ type: "text", text: "做完了" }],
        stopReason: "end_turn",
        usage: { inputTokens: 100, outputTokens: 20 },
      } as AccumulatedResponse;
    };

    const events = await drain(loopConfig);
    const done = events.find((e) => e.kind === "done");
    expect(done).toBeDefined();
    expect(done.incompleteReason).toBeUndefined();
    // 被偷的格数照旧可见（§20.5），但它**不**参与成败判定。
    expect(done.turnsConsumedWithoutAssistant).toBe(2);

    const sdk = convertToSDKMessage(done, CTX) as any;
    expect(sdk.subtype).toBe("success");
  });
});

// ─────────────────────────────────────────────────────────────────
// 第 3 层：变异自证（CLAUDE.md 要求）
// ─────────────────────────────────────────────────────────────────

describe("C2 变异自证：门禁不是「恒非 success」也能过", () => {
  test("两个方向都钉住：有标记必非 success，无标记必 success", () => {
    // 一个恒返回 error_during_execution 的 converter 会让门禁①全绿而门禁②全红。
    // 把两个方向写在同一个 test 里，是为了让「只改一半」无处藏身。
    const incomplete = convertToSDKMessage(
      { kind: "done", turns: 13, incompleteReason: "timeout_retry_exhausted" },
      CTX,
    ) as any;
    const normal = convertToSDKMessage({ kind: "done", turns: 13 }, CTX) as any;
    expect(incomplete.subtype).not.toBe(normal.subtype);
    expect([incomplete.subtype, normal.subtype]).toEqual(["error_during_execution", "success"]);
  });
});
