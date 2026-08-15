/**
 * P1-6：手动 `/compact` 的 analytics 埋点接线回归
 *
 * 背景（分诊结论，别把这个文件当"顺手加的测试"）：
 * `logContextCompact` 原有 4 个调用点全在 `core/query/auto-compact.ts`，且**全部硬编码
 * `trigger: "auto"`**。手动 `/compact` 走的是完全不相交的另一条链路
 * （本命令 → `partialCompact`），它真的压缩了上下文，却一条埋点都不发 ——
 * 门面里声明的 `trigger: "manual"` 这一档在生产侧零 producer。
 * 同理 `logContextCompactSkipped` 的三个早退分支（消息太少 / 锁被占 / hook 阻止）
 * 在手动路径上也全部静默。
 *
 * 这类缺陷**单测全绿也发现不了**（没有调用点不是断言能失败的形态），所以这里锁的是
 * 「调用发生了 + 值有区分度」两件事，而不只是「函数存在」：
 *   - `trigger` 必须真的是 "manual"（若有人把两条路径合并回 auto，这里会红）；
 *   - `outcome` 必须区分 summarized / failed（不能全记成一个值）；
 *   - `tokens_before/after` 必须是数字且 after 反映收尾后的真实占用。
 * 这一条对应记忆里「埋点三问核验：字段在但值是废的」——`_ctx_version` 恒 "dev"
 * 那次就是过了「有调用点」「有字段」两问、挂在「值有区分度」上。
 *
 * 落盘隔离：本文件**不碰真实 `~/.sid-code/`**。埋点在 `analytics/index.ts` 的
 * `logEvent` 处被一个内存 sink 截获（`attachAnalyticsSink`），根本走不到
 * LocalEventBackend 的文件追加，因此无需重定向 SID_CONFIG_DIR。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import compactMod from "@sid-code/cli/command/commands/compact/compact.ts";
import type { Message } from "@sid-code/core/llm/types.ts";
import {
  attachAnalyticsSink,
  __resetAnalyticsForTest,
  type EventMetadata,
} from "@sid-code/core/analytics/index.ts";

interface Captured {
  name: string;
  meta: EventMetadata;
}

/** 装一个内存 sink，把本次测试期间的全部埋点收进数组 */
function captureEvents(): Captured[] {
  const events: Captured[] = [];
  __resetAnalyticsForTest();
  attachAnalyticsSink({ logEvent: (name, meta) => events.push({ name, meta }) });
  return events;
}

/** 构造 round 边界干净的消息历史（user/assistant 交替，无工具往返） */
function buildMessages(rounds: number): Message[] {
  const msgs: Message[] = [];
  for (let i = 0; i < rounds; i++) {
    msgs.push({ role: "user", content: [{ type: "text", text: `问题${i}` }] });
    msgs.push({ role: "assistant", content: [{ type: "text", text: `回答${i}` }] });
  }
  return msgs;
}

/** mock provider：返回一份固定摘要 */
function makeMockProvider() {
  return {
    async *sendMessageStream() {
      yield {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "<summary>摘要内容</summary>" },
      };
      yield { type: "message_stop", usage: { inputTokens: 10, outputTokens: 5 } };
    },
  };
}

/** mock ctxMgr：token 估算随消息条数变化，使 tokens_before > tokens_after 可被观测 */
function makeCtx(messages: Message[], provider: any, opts: { lockFree?: boolean } = {}) {
  let msgs = messages;
  const ctxMgr = {
    messageCount: () => msgs.length,
    estimateTokens: () => msgs.length * 10,
    acquireCompactLock: () => opts.lockFree !== false,
    releaseCompactLock: () => {},
    getMessages: () => msgs,
    setMessages: (m: Message[]) => {
      msgs = m;
    },
    compactWithSummary: (summary: string) => {
      msgs = [
        { role: "user", content: [{ type: "text", text: summary }] },
        { role: "assistant", content: [{ type: "text", text: "ok" }] },
      ];
    },
    getTranscriptPath: () => undefined,
    appendReattachMessages: (m: Message[]) => {
      msgs = [...msgs, ...m];
    },
  };
  return {
    ctxMgr,
    provider,
    config: { model: "test-model" },
    providerRegistry: undefined,
    hookSystem: undefined,
  } as any;
}

/** 取出某个事件名的全部记录 */
function only(events: Captured[], name: string): Captured[] {
  return events.filter((e) => e.name === name);
}

describe("P1-6 手动 /compact 的 context_compact 埋点", () => {
  let events: Captured[];

  beforeEach(() => {
    events = captureEvents();
  });

  afterEach(() => {
    // 复位 sink 绑定，避免污染同进程内后续测试文件（bun test 同批多文件共享进程）
    __resetAnalyticsForTest();
  });

  test("摘要成功 → 上报 outcome=summarized 且 trigger=manual", async () => {
    const ctx = makeCtx(buildMessages(8), makeMockProvider());

    const result = await compactMod.call("", ctx);
    expect((result as any).value).toContain("对话已压缩");

    const compacts = only(events, "context_compact");
    expect(compacts.length).toBe(1);
    const meta = compacts[0]!.meta as Record<string, unknown>;
    // trigger 是这次修复的核心：原状此档零 producer
    expect(meta.trigger).toBe("manual");
    expect(meta.outcome).toBe("summarized");
    // 值有区分度：不是「字段存在」而已，token 数必须是真实数字且压缩后更小
    expect(typeof meta.tokens_before).toBe("number");
    expect(typeof meta.tokens_after).toBe("number");
    expect(meta.tokens_before as number).toBeGreaterThan(0);
    expect(meta.tokens_after as number).toBeLessThan(meta.tokens_before as number);
    expect(meta.messages_before).toBe(16);
  });

  test("focus 压缩成功 → 同样上报 manual/summarized（三种参数模式共用一条链路）", async () => {
    const ctx = makeCtx(buildMessages(8), makeMockProvider());

    await compactMod.call("focus on auth errors", ctx);

    const compacts = only(events, "context_compact");
    expect(compacts.length).toBe(1);
    expect((compacts[0]!.meta as any).trigger).toBe("manual");
    expect((compacts[0]!.meta as any).outcome).toBe("summarized");
  });

  test("无参模式 LLM 摘要失败降级本地截断 → outcome=failed（不是 truncated）", async () => {
    // outcome 口径与 auto 路径严格一致：truncated 专留给熔断降级，
    // 摘要链路失败的有损降级记 failed。两条路径同语义记两个值 = 聚合时要做换算。
    const failing = {
      async *sendMessageStream() {
        throw new Error("network down");
      },
    };
    const ctx = makeCtx(buildMessages(8), failing);

    const result = await compactMod.call("", ctx);
    expect((result as any).value).toContain("降级为本地截断");

    const compacts = only(events, "context_compact");
    expect(compacts.length).toBe(1);
    expect((compacts[0]!.meta as any).outcome).toBe("failed");
    expect((compacts[0]!.meta as any).trigger).toBe("manual");
  });

  test("手动路径的每一条 context_compact 都必须是 trigger=manual（防某个分支漏改回 auto）", async () => {
    // 变异自证发现的缺口：逐个用例各自断言 trigger 时，只要某个用例忘了断，
    // 把那个调用点改回 `trigger: "auto"` 就无人拦得住（实测确实漏过一次）。
    // 这条把「本文件走的全部是手动路径」升级成不变量：手动路径**不允许**出现 auto。
    const scenarios: Array<{ args: string; provider: any }> = [
      { args: "", provider: makeMockProvider() }, // 无参摘要成功
      { args: "focus on auth", provider: makeMockProvider() }, // focus 成功
      { args: "0.5", provider: makeMockProvider() }, // 数字部分压缩成功
      {
        args: "0.5",
        provider: {
          async *sendMessageStream() {
            throw new Error("network down");
          },
        },
      }, // 数字模式失败（不兜底）
      {
        args: "",
        provider: {
          async *sendMessageStream() {
            throw new Error("network down");
          },
        },
      }, // 无参失败 → 本地截断兜底
    ];

    for (const { args, provider } of scenarios) {
      const fresh = captureEvents();
      await compactMod.call(args, makeCtx(buildMessages(8), provider));
      const compacts = only(fresh, "context_compact");
      // 每个场景都必须恰好发一条，且 trigger 恒为 manual
      expect(compacts.length).toBe(1);
      expect((compacts[0]!.meta as any).trigger).toBe("manual");
    }
  });

  test("数字模式摘要失败且不兜底 → outcome=failed，历史未变", async () => {
    const failing = {
      async *sendMessageStream() {
        throw new Error("network down");
      },
    };
    const ctx = makeCtx(buildMessages(8), failing);

    const result = await compactMod.call("0.5", ctx);
    expect((result as any).value).toContain("压缩未执行");

    const compacts = only(events, "context_compact");
    expect(compacts.length).toBe(1);
    expect((compacts[0]!.meta as any).outcome).toBe("failed");
    // 一个 token 都没省：before === after 是这一档的特征
    const meta = compacts[0]!.meta as any;
    expect(meta.tokens_after).toBe(meta.tokens_before);
  });
});

describe("P1-6 手动 /compact 的 context_compact_skipped 埋点", () => {
  let events: Captured[];

  beforeEach(() => {
    events = captureEvents();
  });

  afterEach(() => {
    __resetAnalyticsForTest();
  });

  test("消息太少 → skipped(too_few_messages)，且不发 context_compact", async () => {
    const ctx = makeCtx(buildMessages(1), makeMockProvider());

    const result = await compactMod.call("", ctx);
    expect((result as any).value).toContain("太短");

    const skipped = only(events, "context_compact_skipped");
    expect(skipped.length).toBe(1);
    expect((skipped[0]!.meta as any).reason).toBe("too_few_messages");
    // skip 与 compact 互斥：同一次动作记进两个计数会污染分母
    expect(only(events, "context_compact").length).toBe(0);
  });

  test("压缩锁被占 → skipped(lock_held)", async () => {
    const ctx = makeCtx(buildMessages(8), makeMockProvider(), { lockFree: false });

    const result = await compactMod.call("", ctx);
    expect((result as any).value).toContain("已有压缩流程在进行中");

    const skipped = only(events, "context_compact_skipped");
    expect(skipped.length).toBe(1);
    expect((skipped[0]!.meta as any).reason).toBe("lock_held");
    expect(only(events, "context_compact").length).toBe(0);
  });

  test("PreCompact hook 阻止 → skipped(hook_blocked)", async () => {
    const ctx = makeCtx(buildMessages(8), makeMockProvider());
    ctx.hookSystem = {
      firePreCompactEvent: async () => ({
        finalOutput: {
          isBlockingDecision: () => true,
          getEffectiveReason: () => "正在处理关键任务",
          getAdditionalContext: () => undefined,
        },
      }),
      firePostCompactEvent: async () => ({}),
    };

    const result = await compactMod.call("", ctx);
    expect((result as any).value).toContain("hook 阻止");

    const skipped = only(events, "context_compact_skipped");
    expect(skipped.length).toBe(1);
    expect((skipped[0]!.meta as any).reason).toBe("hook_blocked");
    expect(only(events, "context_compact").length).toBe(0);
  });
});
