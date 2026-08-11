/**
 * 假压缩误报 — queryLoop 侧防回归守卫（§八 #3 #4 #5 #13）
 *
 * 背景（2026-07-29 事故链路的起点）：模型吐了个坏 JSON（空参数 tool_use）→ 空参数重试路径
 * **无条件**调 reactiveCompact（完全不看上下文占用率）→ 压缩静默 no-op 但谎报成功 →
 * `yield { kind: "compact" }` 画出「对话已压缩」横幅 + 给模型注入「系统已为你精简对话上下文」。
 * 整个会话峰值占用只有 17.6%（1M 窗口），本就不该有任何压缩。
 *
 * 本文件锁住 loop 层的三条不变式：
 *   #3 低占用（level==="none"）下空参数重试**不触发**压缩；
 *   #4 未压缩时注入给模型的 reminder **不含**「已精简上下文」字样；
 *   #5 `yield { kind: "compact" }` ⟹ 消息数确实下降（横幅必携实据）；
 *   #13 压缩尝试必落一条结构化事件（CompactionAttempt），成败都落。
 *
 * fix_type: case_design
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
import type { AccumulatedResponse, Message } from "@sid-code/core/llm/types.ts";

function makeConfig(): Config {
  return { model: "test-model", provider: "anthropic", maxTurns: 6 } as unknown as Config;
}

interface Harness {
  loopConfig: QueryLoopConfig;
  ctxMgr: ContextManager;
  /** 捕获的 trace 事件（供 #13 断言 CompactionAttempt 落盘） */
  events: Array<{ event: string; data: Record<string, unknown> }>;
}

/**
 * @param maxTokens 上下文窗口。1M（默认）用于复现事故：低占用 → level==="none"
 * @param preload   预先灌入的历史消息（用于制造"消息很多但占用率很低"的事故形态）
 */
function makeHarness(
  responses: AccumulatedResponse[],
  opts?: { maxTokens?: number; preload?: Message[] },
): Harness {
  const ctxMgr = new ContextManager({ maxTokens: opts?.maxTokens ?? 1_000_000 });
  ctxMgr.setSystemPrompt("test");
  if (opts?.preload?.length) {
    ctxMgr.setMessages(opts.preload);
  } else {
    ctxMgr.addMessage({ role: "user", content: [{ type: "text", text: "改一下文件" }] });
  }

  const events: Harness["events"] = [];
  let turn = 0;
  const deps: QueryDeps = {
    sendWithRetry: () => (async function* () {})(),
    processStream: async () => {
      const r = responses[Math.min(turn, responses.length - 1)];
      turn++;
      return r;
    },
    executeTools: async () => ({ results: [] }),
    autoCompact: async () => {},
    handleContextOverflow: () => null,
    getAbortSignal: () => undefined,
    abortCurrentRequest: () => {},
    uuid: () => "uuid-test",
    traceAppendEvent: (e: { event: string; data?: Record<string, unknown> }) => {
      events.push({ event: e.event, data: e.data ?? {} });
    },
  } as unknown as QueryDeps;

  const loopConfig: QueryLoopConfig = {
    config: makeConfig(),
    ctxMgr,
    toolRegistry: new ToolRegistry(),
    sessionState: new SessionState("test-session"),
    fallback: new ModelFallback(),
    deps,
  };
  return { loopConfig, ctxMgr, events };
}

/** 空参数 tool_use 响应（write 有必填参数，input={} 必被判为退化） */
function emptyParamResponse(): AccumulatedResponse {
  return {
    role: "assistant",
    content: [{ type: "tool_use", id: "w1", name: "write", input: {} }],
    stopReason: "end_turn",
    usage: { inputTokens: 5, outputTokens: 2 },
  } as AccumulatedResponse;
}

function endTurnResponse(): AccumulatedResponse {
  return {
    role: "assistant",
    content: [{ type: "text", text: "好的" }],
    stopReason: "end_turn",
    usage: { inputTokens: 5, outputTokens: 2 },
  } as AccumulatedResponse;
}

/** 构造 agent 典型历史（user 消息多含 tool_result），消息很多但 token 占用相对低 */
function buildAgentHistory(rounds: number, pad = 20): Message[] {
  const msgs: Message[] = [
    { role: "user", content: [{ type: "text", text: "请帮我重构模块" }] },
  ];
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

function collectUserTexts(ctxMgr: ContextManager): string {
  return ctxMgr
    .getMessages()
    .filter((m) => m.role === "user")
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

describe("§八 #3 #4 — 低占用率下空参数重试不得触发压缩", () => {
  test("1M 窗口 + 大量消息但低占用（level=none）→ 消息数一条不减，且不画压缩横幅", async () => {
    // 复现事故形态：消息不少（79 条）但 token 占用极低（远未到 82% 触发点）
    const preload = buildAgentHistory(39);
    const { loopConfig, ctxMgr, events } = makeHarness(
      [emptyParamResponse(), endTurnResponse()],
      { maxTokens: 1_000_000, preload },
    );
    // 前提校验：确实处于 none 档（否则本测试失去意义）
    expect(ctxMgr.getCompactionLevel()).toBe("none");
    const before = ctxMgr.messageCount();

    const kinds: string[] = [];
    for await (const ev of queryLoop(loopConfig)) kinds.push(ev.kind);

    // ★核心：低占用下压根不该压缩——消息只增（注入回执），绝不减少
    expect(ctxMgr.messageCount()).toBeGreaterThanOrEqual(before);
    // ★核心：不得画「对话已压缩」横幅
    expect(kinds).not.toContain("compact");
    // 不该落任何压缩尝试事件（压缩根本没发生）
    expect(events.filter((e) => e.event === "CompactionAttempt")).toHaveLength(0);
  }, 15_000);

  test("#4 未压缩时注入的 reminder 不含「已精简上下文」（防模型被误导后自我否定）", async () => {
    const preload = buildAgentHistory(39);
    const { loopConfig, ctxMgr } = makeHarness(
      [emptyParamResponse(), endTurnResponse()],
      { maxTokens: 1_000_000, preload },
    );

    for await (const _ev of queryLoop(loopConfig)) { /* drain */ }

    const texts = collectUserTexts(ctxMgr);
    // 回执本身必须有（这是另一条既有不变式，不能被本次修复破坏）
    expect(texts).toContain("未执行");
    // ★核心：那句假话不许出现——它是模型此后 30 条回复自我否定的唯一信息源
    expect(texts).not.toContain("精简对话上下文");
  }, 15_000);
});

describe("§八 #14 — 连续压缩失败达阈值后必须熔断，不再空烧 API", () => {
  test("压缩恒失败 + 持续 prompt-too-long ⟹ 有限轮内终止并给出手动 /compact 指引", async () => {
    // 历史只有 2 条：reactiveCompact 的 `<=4 条` 守卫必然让每次压缩都失败，
    // 从而稳定复现"压缩注定失败"的场景（CC 踩过的坑：单会话空转 3272 次）。
    const ctxMgr = new ContextManager({ maxTokens: 1_000_000 });
    ctxMgr.setSystemPrompt("test");
    ctxMgr.addMessage({ role: "user", content: [{ type: "text", text: "hi" }] });

    let sendAttempts = 0;
    const deps = {
      sendWithRetry: () => {
        sendAttempts++;
        throw new Error("prompt is too long: 1200000 tokens > 1000000 maximum");
      },
      processStream: async () => endTurnResponse(),
      executeTools: async () => ({ results: [] }),
      autoCompact: async () => {}, // 也压不动：不改变消息数
      handleContextOverflow: () => null, // 无法调 maxTokens → 必然走到压缩兜底
      getAbortSignal: () => undefined,
      abortCurrentRequest: () => {},
      uuid: () => "u",
      traceAppendEvent: () => {},
    } as unknown as QueryDeps;

    const loopConfig: QueryLoopConfig = {
      config: makeConfig(),
      ctxMgr,
      toolRegistry: new ToolRegistry(),
      sessionState: new SessionState("test-session"),
      fallback: new ModelFallback(),
      deps,
    };

    const systemTexts: string[] = [];
    let sawDone = false;
    for await (const ev of queryLoop(loopConfig)) {
      if (ev.kind === "system") systemTexts.push(ev.text);
      if (ev.kind === "done") sawDone = true;
    }

    // ★核心：必须收敛（而非无限重试烧调用）
    expect(sawDone).toBe(true);
    // 尝试次数必须被熔断器约束在小常数内（阈值 3 + 首次调用 + 少量兜底重试）
    expect(sendAttempts).toBeLessThanOrEqual(8);
    // 必须如实告知用户，并给出可执行的出路
    const joined = systemTexts.join("\n");
    expect(joined).toContain("/compact");
  }, 20_000);
});

describe("§八 #12 — 每个 yield compact 都必须经 settleCompaction（notifyCompaction 单点）", () => {
  /**
   * 结构性守卫（源码级）。
   *
   * P1-4 要求"凡压缩成功就调 notifyCompaction"以抑制紧接的 cache break 误报——否则压缩
   * 导致的缓存脱落会被误归因成"服务端波动"，污染项目北极星「更省」赖以度量的 cache 数据。
   * 旧代码把 notifyCompaction 散落在各调用点（8 处 yield 里有 2 处漏调）。修复后收敛为
   * 「settleCompaction 内唯一一次调用」，本测试锁住这个结构：
   *   ① 不存在裸 `yield { kind: "compact" }`（绕过 settleCompaction 就绕过了 notifyCompaction）
   *   ② settleCompaction 内确实调用了 notifyCompaction
   */
  test("loop.ts 中不存在绕过 settleCompaction 的裸 yield compact", async () => {
    const src = await Bun.file(
      new URL("../../packages/core/src/query/loop.ts", import.meta.url).pathname,
    ).text();

    // 去掉注释行后再匹配，避免把文档注释里的示例文本当成真实代码
    const code = src
      .split("\n")
      .filter((l) => {
        const t = l.trim();
        return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
      })
      .join("\n");

    // 裸 yield（字面量对象）必须为零——所有横幅都应走 `yield banner`
    const bareYields = code.match(/yield\s*\{\s*kind:\s*["']compact["']/g) ?? [];
    expect(bareYields).toHaveLength(0);

    // settleCompaction 必须存在且在其中调用 notifyCompaction
    const fnStart = code.indexOf("function settleCompaction");
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = code.slice(fnStart, fnStart + 3500);
    expect(fnBody).toContain("notifyCompaction(");
  });
});

describe("§八 #5 #13 — 压缩横幅必携实据 + 压缩尝试必落事件", () => {
  test("凡 yield compact，messageCountAfter 必 < messageCountBefore", async () => {
    // 用小窗口 + 大内容把 loop 逼进阈值压缩路径（pad=6000 → 74K tokens 撞 32K 窗口的
    // emergency 档；pad 太小会停在 none 档，测试会空转而失去意义，故下方有前提断言）
    const preload = buildAgentHistory(60, 6000);
    const { loopConfig, ctxMgr, events } = makeHarness([endTurnResponse()], {
      maxTokens: 32_000,
      preload,
    });
    // 前提校验：确实会走压缩路径，避免本测试因"压根没触发"而空过
    expect(ctxMgr.getCompactionLevel()).toBe("emergency");
    const msgsBefore = ctxMgr.messageCount();

    const compactEvents: Array<{
      messageCountBefore: number;
      messageCountAfter: number;
    }> = [];
    for await (const ev of queryLoop(loopConfig)) {
      if (ev.kind === "compact") {
        compactEvents.push({
          messageCountBefore: ev.messageCountBefore,
          messageCountAfter: ev.messageCountAfter,
        });
      }
    }

    // ★核心不变式：横幅只在真压动时出现，且字段必须自证
    for (const c of compactEvents) {
      expect(c.messageCountBefore).toBeGreaterThan(0);
      expect(c.messageCountAfter).toBeLessThan(c.messageCountBefore);
    }

    // #13：只要发生过压缩尝试，就必须有结构化事件，且字段齐全可统计
    const attempts = events.filter((e) => e.event === "CompactionAttempt");
    for (const a of attempts) {
      expect(a.data).toHaveProperty("trigger");
      expect(a.data).toHaveProperty("success");
      expect(a.data).toHaveProperty("messageCountBefore");
      expect(a.data).toHaveProperty("messageCountAfter");
      // 事件里的 success 与实测差值必须一致（不允许事件自己"宣告"成功）
      expect(a.data.success).toBe(
        (a.data.messageCountAfter as number) < (a.data.messageCountBefore as number),
      );
    }
    // 本场景确实进了 emergency 档 → 必须真的发生过压缩尝试并落盘（守 P2-1 不空转）
    expect(attempts.length).toBeGreaterThan(0);
    // 画了横幅就必然有成功事件（横幅与事件同源于 settleCompaction）
    expect(attempts.filter((a) => a.data.success === true).length).toBeGreaterThanOrEqual(
      compactEvents.length,
    );
    // 压缩确实生效时，历史必然变短（端到端佐证，不只看事件字段自洽）
    if (compactEvents.length > 0) {
      expect(ctxMgr.messageCount()).toBeLessThan(msgsBefore);
    }
  }, 20_000);
});
