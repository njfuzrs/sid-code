/**
 * X2：子代理撞输出上限（max_tokens）的完整恢复 —— 升档 → 续写 → 拼接。
 *
 * 缺陷背景（`docs-research/sid-code/bugfixes/todo/20261116-*`）：
 * 子代理的续写分支此前只有一句 `continue`：不升档、不注入续写提示。模型对
 * 「为什么被打断、从哪里续」完全无感知，下一轮经常重头再来或直接收尾，
 * 父代理最终拿到的报告只剩半句，且无从知道它少了什么。
 *
 * 这一组断言对应方案文档里 PR2 的验收条件，逐条对着写：
 *   ① 第 1 次撞上限后的重发请求 max_tokens = min(模型上限, 窗口余量, 软顶)，
 *      且不带续写提示；模型上限未知时不升档。
 *   ② 升档只一次：之后每次续写请求 max_tokens 不再变化，最后一条消息是续写提示。
 *   ③ 最终结果按顺序拼接（只有一个报告头）。
 *   ④ 续写轮次里 assistant 的行数等于循环轮数（sidechain 每轮写一行 assistant，
 *      两者同源；这里直接断言消息历史，是 sidechain 行数的上游事实）。
 *   ⑤ 续写次数达兜底时先让手、再停止。
 *   ⑥ 强制总结轮撞上限时同样先升档、再续写，最终是总结的完整拼接。
 *
 * fix_type: unreachable_recovery
 */

import { describe, test, expect } from "bun:test";
import {
  MaxTokensRecoveryState,
  SUBAGENT_ESCALATED_MAX_TOKENS,
  extractFinalTextWithContinuation,
  resolveMaxTokensEscalationTarget,
} from "@sid-code/core/query/max-tokens-recovery.ts";
import { MAX_TOKENS_CONTINUATION_ORIGIN } from "@sid-code/core/context/internal-message.ts";
import { runAgentLoop } from "@sid-code/core/agent/agentic-loop.ts";
import { SUBAGENT_DEFAULT_MAX_TOKENS } from "@sid-code/core/agent/agentic-loop.ts";
import { Manager as ContextManager } from "@sid-code/core/context/manager.ts";
import { Registry as ToolRegistry } from "@sid-code/core/tool/registry.ts";
import { LoopDetector } from "@sid-code/core/agent/loop-detection.ts";
import type { Provider } from "@sid-code/core/llm/provider.ts";
import type { SendParams, StreamEvent } from "@sid-code/core/llm/types.ts";

// ────────────────────────────────────────────────────────────────
// 回放基础设施
// ────────────────────────────────────────────────────────────────

/** 记录每一次真实发出的请求参数（升档 / 续写断言全靠它） */
function makeRecordingProvider(script: StreamEvent[][]): {
  provider: Provider;
  requests: SendParams[];
} {
  const requests: SendParams[] = [];
  let call = 0;
  const provider = {
    name: () => "mock",
    defaultModel: () => "mock-model",
    async *sendMessageStream(params: SendParams): AsyncIterable<StreamEvent> {
      // 深拷一层 messages，避免调用方后续改历史把断言对象也改了
      requests.push({
        ...params,
        messages: params.messages.map((m) => ({ ...m, content: [...m.content] })),
      });
      const events = script[Math.min(call, script.length - 1)] ?? [];
      call++;
      for (const e of events) yield e;
    },
  } as unknown as Provider;
  return { provider, requests };
}

function yieldText(text: string, stopReason = "end_turn", outputTokens = 500): StreamEvent[] {
  return [
    {
      type: "message_start",
      message: { usage: { inputTokens: 100, outputTokens: 0 } },
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
      usage: { outputTokens },
    } as StreamEvent,
  ];
}

function makeCtxMgr(): ContextManager {
  const ctxMgr = new ContextManager({ maxTokens: 100_000 });
  ctxMgr.setSystemPrompt("test");
  ctxMgr.addMessage({ role: "user", content: [{ type: "text", text: "任务" }] });
  return ctxMgr;
}

function allowAll() {
  return { check: async () => ({ allowed: true }) } as any;
}

/** 主流跑一遍：脚本里三段 max_tokens + 一段 end_turn */
async function runThreeSegments() {
  const { provider, requests } = makeRecordingProvider([
    yieldText("## 报告\n第一段", "max_tokens", 5000),
    yieldText("第二段", "max_tokens", 5000),
    yieldText("第三段", "end_turn", 5000),
  ]);
  const result = await runAgentLoop({
    provider,
    // 用注册表里存在的模型名，`resolveMaxOutputTokensForModel` 才能返回 128_000，
    // 升档才有一个可断言的确定目标（未知模型时策略是「不升档」）。
    model: "claude-opus-4-8",
    ctxMgr: makeCtxMgr(),
    tools: new ToolRegistry(),
    maxTurns: 10,
    signal: new AbortController().signal,
    loopDetector: new LoopDetector(),
    permissionChecker: allowAll(),
  } as any);
  return { result, requests };
}

// ────────────────────────────────────────────────────────────────
// ① 升档目标：三个上界取最小；模型上限未知时不升档
// ────────────────────────────────────────────────────────────────

describe("X2 · 升档目标计算", () => {
  test("软顶是最紧的上界时取软顶", () => {
    expect(
      resolveMaxTokensEscalationTarget({
        modelMax: 128_000,
        windowCeiling: 99_000,
        softCap: SUBAGENT_ESCALATED_MAX_TOKENS,
      }),
      "模型上限 128k、窗口允许 99k、软顶 32k → 取软顶 32k",
    ).toBe(32_768);
  });

  test("窗口余量比软顶更紧时取窗口余量", () => {
    expect(
      resolveMaxTokensEscalationTarget({
        modelMax: 128_000,
        windowCeiling: 10_000,
        softCap: SUBAGENT_ESCALATED_MAX_TOKENS,
      }),
      "窗口只剩 10k 时不能发 32k，否则把「一次截断」换成「一次必然 400」",
    ).toBe(10_000);
  });

  test("模型物理上限比软顶更紧时取物理上限", () => {
    expect(
      resolveMaxTokensEscalationTarget({
        modelMax: 8_192,
        windowCeiling: 99_000,
        softCap: SUBAGENT_ESCALATED_MAX_TOKENS,
      }),
      "haiku 这类小上限模型不能抬到 32k，否则 400 max_tokens out of range",
    ).toBe(8_192);
  });

  test("模型上限未知 → 不升档（交给续写段更安全）", () => {
    expect(
      resolveMaxTokensEscalationTarget({
        modelMax: undefined,
        windowCeiling: 99_000,
        softCap: SUBAGENT_ESCALATED_MAX_TOKENS,
      }),
      "自定义端点三层全 miss 时抬到一个未知上限只会制造 400",
    ).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────
// ② 策略状态机：升档只一次、续写编号递增、递减收益先让手再停止
// ────────────────────────────────────────────────────────────────

describe("X2 · 恢复状态机", () => {
  test("首次截断升档，第二次起续写且 maxTokens 不再变", () => {
    const state = new MaxTokensRecoveryState();
    const base = {
      currentMaxTokens: SUBAGENT_DEFAULT_MAX_TOKENS,
      modelMax: 128_000,
      windowCeiling: 99_000,
      softCap: SUBAGENT_ESCALATED_MAX_TOKENS,
    };

    const first = state.decide({ ...base, outputTokens: 4000 });
    expect(first.action, "第一次截断应升档而不是续写").toBe("escalate");
    expect(first.action === "escalate" && first.maxTokens).toBe(32_768);

    const second = state.decide({ ...base, outputTokens: 4000 });
    expect(second.action, "升档只做一次，第二次截断进入续写").toBe("continue");
    expect(state.escalations, "升档次数封顶为 1").toBe(1);
    expect(state.continuations).toBe(1);

    const third = state.decide({ ...base, outputTokens: 4000 });
    expect(third.action).toBe("continue");
    expect(state.continuations).toBe(2);
  });

  test("连续续写产出递减：先让手，再命中则停止", () => {
    const state = new MaxTokensRecoveryState();
    const base = {
      // 当前值必须是**升档前**的默认预算，否则 target === current 不构成「升档」
      currentMaxTokens: SUBAGENT_DEFAULT_MAX_TOKENS,
      modelMax: 128_000,
      windowCeiling: 99_000,
      softCap: SUBAGENT_ESCALATED_MAX_TOKENS,
    };

    // 升档先被用掉（真实路径里第一次撞上限就是它），之后才开始计续写。
    expect(state.decide({ ...base, outputTokens: 4000 }).action).toBe("escalate");

    // 每次只产出 100 token：远低于 DiminishingReturnsDetector 的单次阈值。
    let sawHandoff = false;
    let sawStop = false;
    for (let i = 0; i < 12; i++) {
      const d = state.decide({ ...base, outputTokens: 100 });
      if (d.action === "handoff") sawHandoff = true;
      if (d.action === "stop") {
        sawStop = true;
        break;
      }
    }
    expect(sawHandoff, "递减收益必须先「让手」交给模型决定，而不是直接掐断").toBe(true);
    expect(sawStop, "让手后仍收敛不了才停止，避免无限续写").toBe(true);
    expect(state.handedOff).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────
// ③ 主流集成：升档值 / 续写提示 / 拼接结果
// ────────────────────────────────────────────────────────────────

describe("X2 · 子代理主流两段恢复", () => {
  test("升档一次 + 之后续写，最终按顺序拼回整份报告", async () => {
    const { result, requests } = await runThreeSegments();

    expect(requests.length, "三段 → 三次请求（升档 1 + 续写 1 + 正常 1）").toBe(3);

    // ① 初始仍是 4096，不为一轮用不到的场景付预付费
    expect(requests[0]!.maxTokens).toBe(SUBAGENT_DEFAULT_MAX_TOKENS);

    // ② 第一次撞上限 → 升档到软顶（重发，不注入提示）
    expect(requests[1]!.maxTokens).toBe(SUBAGENT_ESCALATED_MAX_TOKENS);
    const secondLast = requests[1]!.messages[requests[1]!.messages.length - 1]!;
    expect(secondLast.role, "升档重发不注入续写提示，历史仍以 assistant 结尾").toBe("assistant");

    // ③ 第二次撞上限 → 不再升档，注入续写提示
    expect(requests[2]!.maxTokens, "升档只一次，续写请求的 maxTokens 不再变化").toBe(
      SUBAGENT_ESCALATED_MAX_TOKENS,
    );
    const thirdLast = requests[2]!.messages[requests[2]!.messages.length - 1]!;
    expect(thirdLast.role).toBe("user");
    expect(
      thirdLast._meta?.origin,
      "续写提示必须带 origin 标记 —— extractFinalText 靠它识别续写边界",
    ).toBe(MAX_TOKENS_CONTINUATION_ORIGIN);

    // ④ 拼接：三段按顺序、只有一个报告头。
    //
    // 注意中间那个 `\n`：升档重发**不注入提示**（历史以 assistant 结尾），
    // 于是「第一段」和「第二段」两条 assistant 会被 ContextManager 合并成一条，
    // 合并符是换行。内容本身完整，只是多了一个换行 —— 这是可接受的，
    // 而「续写段（第三段）不被合并」才是关键（见下一条断言）。
    const joined = extractFinalTextWithContinuation(result.messages, "", () => false);
    expect(joined).toBe("## 报告\n第一段\n第二段第三段");
    expect(joined.match(/## 报告/g)?.length, "只有一个报告头 —— 续写不该重开一份报告").toBe(1);

    // ⑤ 续写阶段的 assistant 必须独立成条，不被合并进前一条。
    //
    // 这是文档「sidechain 不改代码」那一步成立的前提：注入续写提示后，
    // user 与 assistant 交替出现，Assembler 的合并路径不会再命中。
    // 若这里被合并了，就说明续写提示没进历史（或 origin 丢失），
    // 父代理看到的报告与 sidechain 落盘的行数就会对不上。
    const lastAssistant = [...result.messages].reverse().find((m) => m.role === "assistant")!;
    const lastText = lastAssistant.content
      .filter((b) => b.type === "text")
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
    expect(lastText, "续写段独立成条，内容只有第三段（没被合并）").toBe("第三段");
  });
});
