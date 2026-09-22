/**
 * P1-13 / P1-14：压缩后收尾绑在「压缩真的发生了」事件上，不再绑在 autoCompact 函数上
 *
 * 来源：`docs-research/sid-code/bugfixes/todo/20260920-上下文工程-顺着sc-02-context核出的缺陷.md`
 *
 *   P1-13 `reactiveCompact`（prompt-too-long 恢复）完全绕过 runPostCompact——
 *         文件重注入 / microcompact 状态机重置 / PostCompact hook 全部缺失。
 *         PTL 恰恰是「窗口已经爆了」的恢复路径，压完模型最需要最近文件，
 *         偏偏这条路不重注入，用户体感是「报了个超长、压完断片」。
 *   P1-14 `contextCollapse` 成功则跳过 autoCompact，同样不走收尾。
 *
 * 判据与 settleCompaction 一致：**实测消息数下降**才算压缩发生（不能由代码路径宣告）。
 * 所以这里同时守「压动了要调」和「没压动不许调」两个方向——
 * 后者是防线自身的正确性：往一个没腾出空间的上下文里再塞 50K 文件是负收益。
 */

import { describe, test, expect } from "bun:test";
import { queryLoop, type QueryLoopConfig } from "@sid-code/core/query/loop.ts";
import type { QueryDeps } from "@sid-code/core/query/types.ts";
import { Manager as ContextManager } from "@sid-code/core/context/manager.ts";
import { Registry as ToolRegistry } from "@sid-code/core/tool/registry.ts";
import { ModelFallback } from "@sid-code/core/llm/fallback.ts";
import { SessionState } from "@sid-code/core/session/state.ts";
import type { Config } from "@sid-code/core/config/config.ts";
import type { AccumulatedResponse, Message } from "@sid-code/core/llm/types.ts";

function makeConfig(): Config {
  return { model: "test-model", provider: "anthropic", maxTurns: 4 } as unknown as Config;
}

function endTurnResponse(): AccumulatedResponse {
  return {
    role: "assistant",
    content: [{ type: "text", text: "好的" }],
    stopReason: "end_turn",
    usage: { inputTokens: 5, outputTokens: 2 },
  } as AccumulatedResponse;
}

/** 足够长的历史，让 reactiveCompact 的 snip 真能压动（其自身有 <=4 条守卫） */
function buildHistory(rounds: number, pad = 4000): Message[] {
  const msgs: Message[] = [{ role: "user", content: [{ type: "text", text: "请帮我重构模块" }] }];
  for (let i = 0; i < rounds; i++) {
    msgs.push({
      role: "assistant",
      content: [{ type: "tool_use", id: `t${i}`, name: "read", input: { path: `f${i}.ts` } }],
    });
    msgs.push({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: `t${i}`, content: "x".repeat(pad) }],
    });
  }
  return msgs;
}

/**
 * 纯文本历史（无 tool_result）。
 *
 * collapse 用例**不能**用 buildHistory：管线第一步 `toolResultBudget` 专截 tool_result，
 * 一步就把占用压到目标以下 → `needsAutoCompact=false` → collapse 与 autoCompact 整段跳过，
 * 测试会以「收尾没被调」的形式假绿。纯文本让管线只剩 snip/microcompact，压不到目标，
 * 从而真的走到 collapse 分支。
 */
function buildTextHistory(rounds: number, pad: number): Message[] {
  const msgs: Message[] = [];
  for (let i = 0; i < rounds; i++) {
    msgs.push({ role: "user", content: [{ type: "text", text: `问题${i} ` + "x".repeat(pad) }] });
    msgs.push({
      role: "assistant",
      content: [{ type: "text", text: `回答${i} ` + "y".repeat(pad) }],
    });
  }
  return msgs;
}

type TailCall = { trigger: string; messagesBefore: number; tokensBefore: number };

/** PTL harness：首个请求抛 prompt-too-long，之后正常返回 */
function makePtlHarness(preload: Message[]): {
  loopConfig: QueryLoopConfig;
  ctxMgr: ContextManager;
  tailCalls: TailCall[];
} {
  const ctxMgr = new ContextManager({ maxTokens: 1_000_000 });
  ctxMgr.setSystemPrompt("test");
  ctxMgr.setMessages(preload);

  const tailCalls: TailCall[] = [];
  let sends = 0;
  const deps = {
    sendWithRetry: () => {
      sends++;
      if (sends === 1) throw new Error("prompt is too long: 1200000 tokens > 1000000 maximum");
      return (async function* () {})();
    },
    processStream: async () => endTurnResponse(),
    executeTools: async () => ({ results: [] }),
    autoCompact: async () => {},
    handleContextOverflow: () => null,
    getAbortSignal: () => undefined,
    abortCurrentRequest: () => {},
    uuid: () => "u",
    traceAppendEvent: () => {},
    postCompactTail: async (info: TailCall) => {
      tailCalls.push(info);
    },
  } as unknown as QueryDeps;

  return {
    loopConfig: {
      config: makeConfig(),
      ctxMgr,
      toolRegistry: new ToolRegistry(),
      sessionState: new SessionState("s"),
      fallback: new ModelFallback(),
      deps,
    },
    ctxMgr,
    tailCalls,
  };
}

describe("P1-13 — reactiveCompact 压动后走压缩后收尾", () => {
  test("prompt-too-long 恢复：压动了 → 收尾被调，trigger=reactive", async () => {
    const { loopConfig, ctxMgr, tailCalls } = makePtlHarness(buildHistory(12));
    const before = ctxMgr.messageCount();

    for await (const _ev of queryLoop(loopConfig)) {
      /* drain */
    }

    // 前提：压缩确实压动了（否则本测试失去意义）
    expect(ctxMgr.messageCount()).toBeLessThan(before);
    // ★核心：此前这条路径零 runPostCompact 调用（文件重注入整条缺失）
    expect(tailCalls.length).toBeGreaterThan(0);
    expect(tailCalls[0].trigger).toBe("reactive");
    expect(tailCalls[0].messagesBefore).toBe(before);
  }, 15_000);

  test("压不动（历史太短，snip 的 <=4 条守卫兜住）→ 不调收尾", async () => {
    // 判据同 settleCompaction：没压动就没「压缩发生」这个事件，
    // 往没腾出空间的上下文里重注入 50K 文件是负收益。
    const { loopConfig, ctxMgr, tailCalls } = makePtlHarness([
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]);
    const before = ctxMgr.messageCount();

    for await (const _ev of queryLoop(loopConfig)) {
      /* drain */
    }

    // 消息数只会因注入回执而增，绝不会减——「减少」才是压缩发生的实据
    expect(ctxMgr.messageCount()).toBeGreaterThanOrEqual(before);
    expect(tailCalls).toHaveLength(0);
  }, 15_000);

  test("未注入 postCompactTail（可选 dep）→ 不抛错，退回仅埋点行为", async () => {
    const { loopConfig } = makePtlHarness(buildHistory(12));
    (loopConfig.deps as any).postCompactTail = undefined;
    await expect(
      (async () => {
        for await (const _ev of queryLoop(loopConfig)) {
          /* drain */
        }
      })(),
    ).resolves.toBeUndefined();
  }, 15_000);
});

describe("P1-14 — contextCollapse 成功后走压缩后收尾", () => {
  /** hard 档 harness：占用打到触发点以上，collapse 由 dep 模拟 */
  function makeCollapseHarness(collapse: (ctxMgr: ContextManager) => boolean): {
    loopConfig: QueryLoopConfig;
    ctxMgr: ContextManager;
    tailCalls: TailCall[];
  } {
    // 200K 窗口的档位边界（getCompactionThresholds）：hard 在已用 140K 起、
    // emergency 在 160K 起。40 轮 × 9K 字符 ≈ 144K，落在 hard 档，且管线走完
    // 仍未达标（needsAutoCompact=true）——这两个条件同时满足才会走到 collapse 分支。
    const ctxMgr = new ContextManager({ maxTokens: 200_000 });
    ctxMgr.setSystemPrompt("test");
    ctxMgr.setMessages(buildTextHistory(40, 9_000));

    const tailCalls: TailCall[] = [];
    const deps = {
      sendWithRetry: () => (async function* () {})(),
      processStream: async () => endTurnResponse(),
      executeTools: async () => ({ results: [] }),
      autoCompact: async () => {},
      contextCollapse: async () => collapse(ctxMgr),
      handleContextOverflow: () => null,
      getAbortSignal: () => undefined,
      abortCurrentRequest: () => {},
      uuid: () => "u",
      traceAppendEvent: () => {},
      postCompactTail: async (info: TailCall) => {
        tailCalls.push(info);
      },
    } as unknown as QueryDeps;

    return {
      loopConfig: {
        config: makeConfig(),
        ctxMgr,
        toolRegistry: new ToolRegistry(),
        sessionState: new SessionState("s"),
        fallback: new ModelFallback(),
        deps,
      },
      ctxMgr,
      tailCalls,
    };
  }

  test("collapse 真压动 → 收尾被调，trigger=collapse", async () => {
    const { loopConfig, ctxMgr, tailCalls } = makeCollapseHarness((mgr) => {
      // 模拟 collapse：把老消息换成一条分段摘要（消息数真的下降）
      const msgs = mgr.getMessages();
      mgr.setMessages([
        { role: "user", content: [{ type: "text", text: "[段落摘要] 早期内容" }] },
        ...msgs.slice(-6),
      ]);
      return true;
    });
    expect(ctxMgr.getCompactionLevel()).toBe("hard");

    for await (const _ev of queryLoop(loopConfig)) {
      /* drain */
    }

    expect(tailCalls.length).toBeGreaterThan(0);
    expect(tailCalls[0].trigger).toBe("collapse");
  }, 15_000);

  test("collapse 自报 success 但消息数未变 → 不调收尾（防假压缩触发重注入）", async () => {
    const { loopConfig, ctxMgr, tailCalls } = makeCollapseHarness(() => true);
    expect(ctxMgr.getCompactionLevel()).toBe("hard");

    for await (const _ev of queryLoop(loopConfig)) {
      /* drain */
    }

    expect(tailCalls.filter((c) => c.trigger === "collapse")).toHaveLength(0);
  }, 15_000);
});
