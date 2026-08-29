/**
 * 轮数预算被网络故障偷走 —— 缺陷 1 的门禁（Harbor A11 第五棒实测，2026-08-29）
 *
 * ## 拦的是什么
 *
 * `queryLoop` 的 `while (turnCount < maxTurns)` 一进来就 `turnCount++`，是在**发请求
 * 之前**；而 SDK 侧的 `num_turns` 只在 `assistant_message` 上 `++`。于是一个被
 * watchdog / 硬超时杀掉、零内容产出的轮次：**占掉一格 maxTurns 预算，却在
 * `num_turns` 里完全隐身**。
 *
 * 真实 benchmark 上 7 个 `error_max_turns` 样本全部满足
 * `num_turns + WatchdogKill 次数 = 41`（7/7），其中两题 40 格只换来 **34** 次模型交互。
 * 后果有两个，第二个更贵：
 *   1. 本该解出的题因预算被偷而解不出；
 *   2. **「打满上限」与「上限够不够用」之间插了一层网络故障** —— 看到
 *      `error_max_turns` 的人会去调 `--max-turns`，而真凶是上游掉流。
 *
 * ## 为什么断言「预算照扣 + 如实记账」，而不是「被杀的轮次不占预算」
 *
 * 后者会让上游持续故障时循环永不收敛（每次都退回同一格），把「预算被偷」换成
 * 「无限重试」—— 而后者在无头评测里会一路烧到 1 小时硬顶。所以修复的形态刻意是
 * **保留收敛性、把被偷的格数如实透出**。本文件第 2 个 test 正是钉这条设计决策，
 * 防止后人「优化」成不占预算。
 *
 * ## 变异自证（CLAUDE.md：新增门禁必做）
 *
 * 第 4 个 test 把计数器人为记在错误的位置（`isTimeoutError` 外层而非
 * 「重试真的会发生」那一支），断言计数会系统性高一 —— 说明本门禁真的在测那个位置，
 * 而不是「恒返回 0 也能过」。
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
import type { Config } from "@sid-code/core/config/config.ts";
import type { StreamEvent, AccumulatedResponse } from "@sid-code/core/llm/types.ts";

async function* emptyStream(): AsyncIterable<StreamEvent> {
  /* processStream 被 mock，此处不产事件 */
}

/** 每轮 input 不同，避免触发 ToolCallLoopDetector（阈值 3 次相同调用） */
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
 * 模拟「被 watchdog 杀在零产出上」：抛一个带 timeout 字样的错误。
 *
 * 走的是 `isTimeoutError` 的判据 2（消息文本回退），与真实 watchdog 走判据 1
 * （abort reason 白名单）殊途同归 —— 两者都汇聚到同一个 timeout 重试分支，
 * 而本门禁测的正是那个分支里的计数。用文本形态是因为它不需要伪造
 * AbortController 的 reason 锁定时序，脆弱性更低。
 */
function timeoutError(): Error {
  return new Error("流式超时：stream timeout (simulated watchdog kill)");
}

/**
 * @param timeoutTurns 哪几次 processStream 调用要模拟成超时（0-based）
 */
function setup({ maxTurns, timeoutTurns = [] }: { maxTurns: number; timeoutTurns?: number[] }) {
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
      // 永不 end_turn，逼迫循环耗尽 maxTurns
      return toolUseResp(n);
    },
    executeTools: async () => ({ results: [] }),
    autoCompact: async () => {},
    handleContextOverflow: () => null,
    getAbortSignal: () => undefined,
    uuid: () => `uuid-${call}`,
    // ⚠️ 退避配置**只能放 config.network**（`loop.ts` 走
    // `resolveLoopTimeouts({ network: config.network })`）。这里曾经也写过一份
    // `deps.network` —— `QueryDeps` 上没有这个字段，没人读，而它看起来像在生效：
    // 正是本仓「伪配置」那一类。删掉，只留 config 上那一份唯一事实源。
  } as unknown as QueryDeps;

  const loopConfig: QueryLoopConfig = {
    config: {
      model: "claude-opus-4-8",
      provider: "anthropic",
      maxTurns,
      maxTokens: 8000,
      network: { retryBackoffBaseMs: 1, retryBackoffMaxMs: 2 },
    } as unknown as Config,
    ctxMgr,
    toolRegistry: new ToolRegistry(),
    sessionState: new SessionState("test-stolen-turn-budget"),
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

describe("缺陷 1：轮数预算被超时偷走时必须如实记账", () => {
  test("零超时：max_turns 事件报 turnsConsumedWithoutAssistant === 0", async () => {
    // 这一条是「真的是上限不够用」那种样本的形态。它必须与「预算被偷」在数据上可区分，
    // 否则修复本身没意义 —— 一个恒返回非零的计数器和没有计数器一样没用。
    const { loopConfig } = setup({ maxTurns: 3 });
    const events = await drain(loopConfig);

    const maxTurns = events.find((e) => e.kind === "max_turns");
    expect(maxTurns).toBeDefined();
    expect(maxTurns.turnsConsumedWithoutAssistant).toBe(0);

    // 交互次数 = 预算，一格没被偷
    const assistants = events.filter((e) => e.kind === "assistant_message").length;
    expect(assistants).toBe(3);
  });

  test("有超时：被杀的轮次照扣预算（保留收敛性），且计数如实等于被杀次数", async () => {
    // 第 0、2 次调用被"watchdog"杀掉 → 这两格预算花掉了但换不来 assistant_message。
    const { loopConfig } = setup({ maxTurns: 5, timeoutTurns: [0, 2] });
    const events = await drain(loopConfig);

    const maxTurns = events.find((e) => e.kind === "max_turns");
    expect(maxTurns).toBeDefined();
    expect(maxTurns.turnsConsumedWithoutAssistant).toBe(2);

    // ⛔ 这一条钉的是设计决策，不是实现细节：预算**必须**照扣。
    // 改成"被杀的轮次不 turnCount++"会让上游持续故障时循环永不收敛。
    // 实测不变式：assistant 次数 + 被偷格数 = maxTurns。
    const assistants = events.filter((e) => e.kind === "assistant_message").length;
    expect(assistants + maxTurns.turnsConsumedWithoutAssistant).toBe(maxTurns.maxTurns);
    expect(assistants).toBe(3); // 5 格预算只换来 3 次模型交互
  });

  test("SDK 的 error_max_turns 带得出这个数（Harbor 就是从这里读的）", async () => {
    // 缺陷的实际暴露面在这里：外部消费者看到 `num_turns: 3` + `error_max_turns`，
    // 两个数字自相矛盾，而修复前**没有任何字段能解释那 2 格去哪了**。
    const sdkMsg = convertToSDKMessage(
      { kind: "max_turns", maxTurns: 5, turnsConsumedWithoutAssistant: 2 },
      {
        sessionId: "s1",
        totalUsage: { inputTokens: 0, outputTokens: 0 },
        startTime: 0,
        turnCount: 3,
        totalCostUsd: 0,
        now: () => 1000,
        uuid: () => "u1",
      },
    );

    expect(sdkMsg).not.toBeNull();
    expect(sdkMsg!.type).toBe("result");
    const r = sdkMsg as any;
    expect(r.subtype).toBe("error_max_turns");
    expect(r.num_turns).toBe(3);
    expect(r.num_turns_without_model_interaction).toBe(2);
    // 实测不变式（7/7 个真实样本成立）：num_turns + 被偷格数 = maxTurns
    expect(r.num_turns + r.num_turns_without_model_interaction).toBe(5);
  });

  test("变异自证：计数记在「重试是否真的会发生」之外会系统性高一", async () => {
    // 把 maxTimeoutRetries 压到 1，让第 2 次超时**耗尽重试**并走收尾 return。
    // 那一格不是被"偷"的 —— 它是本轮的正常终点。若计数记在 isTimeoutError 的外层
    // （而不是 `timeoutRetryCount < maxRetries` 那一支内），它会把这一次也算进去。
    //
    // 断言形态：会话在重试耗尽处收尾，**不会**走到 max_turns，
    // 于是"多记的那一格"无处藏身 —— 它只会体现为 assistant 次数与预算的关系错乱。
    const { loopConfig } = setup({ maxTurns: 5, timeoutTurns: [0, 1, 2, 3, 4] });
    (loopConfig.config as any).network = {
      maxTimeoutRetries: 1,
      retryBackoffBaseMs: 1,
      retryBackoffMaxMs: 2,
    };
    const events = await drain(loopConfig);

    // 全程零产出 → 一次 assistant_message 都没有，且在重试耗尽处收尾（非 max_turns）
    expect(events.filter((e) => e.kind === "assistant_message").length).toBe(0);
    expect(events.some((e) => e.kind === "max_turns")).toBe(false);
    expect(events.some((e) => e.kind === "done")).toBe(true);
    // 收尾文案要说得出「超时」，否则这条样本在轨迹里与「模型没话说」同形
    const sys = events.filter((e) => e.kind === "system").map((e) => e.text ?? "");
    expect(sys.join("\n")).toMatch(/超时/);
  });
});
