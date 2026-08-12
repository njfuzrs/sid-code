/**
 * P1-G3：per-message usage 落盘与归因交叉校验
 *
 * 缺口原文：「只有整会话聚合，无法按单条回复归因 token/成本」。修复后 assistant_message
 * 记录内嵌该次 API 调用的 usage 四字段 + model/stopReason/msgId，与整会话聚合
 * usage_stats 快照**并存**（前者做归因，后者做快速恢复总量）。
 *
 * 本文件的核心是**交叉校验**：逐条 usage 累加起来必须等于聚合快照的总量。这条不变量
 * 是"更省"能测准的前提——两套口径若对不上，按单条归因出来的成本就是错的。
 *
 * 另覆盖：四字段（含两个 cache 维度）无损 round-trip、可选字段缺失时的容错、
 * usage 挂在 _meta 而不进 content（不污染发给 LLM 的请求体）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { SessionStore } from "@sid-code/core/session/store.ts";
import { SessionState } from "@sid-code/core/session/state.ts";
import type { Message, Usage } from "@sid-code/core/llm/types.ts";
import { join } from "path";
import { mkdirSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";

describe("P1-G3 per-message usage 落盘 + 归因", () => {
  let testDir: string;
  let origConfigDir: string | undefined;

  beforeEach(() => {
    testDir = join(tmpdir(), `sid-permsg-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(testDir, ".sid-code", "sessions"), { recursive: true });
    origConfigDir = process.env.SID_CONFIG_DIR;
    process.env.SID_CONFIG_DIR = join(testDir, ".sid-code");
  });

  afterEach(() => {
    if (origConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
    else process.env.SID_CONFIG_DIR = origConfigDir;
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  const assistant = (text: string): Message => ({
    role: "assistant",
    content: [{ type: "text", text }],
  });

  test("四字段无损 round-trip（含两个 cache 维度）", async () => {
    const store = new SessionStore();
    store.startSession("permsg-001", "claude-opus-4-8", "anthropic", "/cwd");
    store.appendMessage(assistant("回复"), {
      usage: {
        inputTokens: 40120,
        outputTokens: 3600,
        cacheReadInputTokens: 20000,
        cacheCreationInputTokens: 5000,
      },
      model: "claude-opus-4-8",
      stopReason: "end_turn",
      msgId: "msg_abc123",
    });
    SessionStore.flushPendingWrites();

    const loaded = await store.load("permsg-001");
    const meta = loaded!.messages[0]._meta as any;
    expect(meta.usage).toEqual({
      inputTokens: 40120,
      outputTokens: 3600,
      cacheReadInputTokens: 20000,
      cacheCreationInputTokens: 5000,
    });
    expect(meta.model).toBe("claude-opus-4-8");
    expect(meta.stopReason).toBe("end_turn");
    expect(meta.msgId).toBe("msg_abc123");
  });

  test("交叉校验：逐条 usage 累加 == 聚合 usage_stats 总量", async () => {
    // 三次 API 调用，各维度都不同（避免巧合相等掩盖错误）
    const calls: Usage[] = [
      {
        inputTokens: 1000,
        outputTokens: 200,
        cacheReadInputTokens: 800,
        cacheCreationInputTokens: 100,
      },
      {
        inputTokens: 2500,
        outputTokens: 430,
        cacheReadInputTokens: 2000,
        cacheCreationInputTokens: 0,
      },
      { inputTokens: 700, outputTokens: 90, cacheReadInputTokens: 0, cacheCreationInputTokens: 50 },
    ];

    // 聚合侧：SessionState 逐次累计（与真实主循环一致）
    const state = new SessionState("permsg-002");
    // 归因侧：同样三次调用逐条落盘
    const store = new SessionStore();
    store.startSession("permsg-002", "claude-opus-4-8", "anthropic", "/cwd");
    for (const u of calls) {
      state.updateUsage("claude-opus-4-8", u, 500, "anthropic");
      store.appendMessage(assistant("r"), {
        usage: {
          inputTokens: u.inputTokens,
          outputTokens: u.outputTokens,
          cacheReadInputTokens: u.cacheReadInputTokens,
          cacheCreationInputTokens: u.cacheCreationInputTokens,
        },
        model: "claude-opus-4-8",
      });
    }
    store.appendMetadata("usage_stats", state.serializeUsageSnapshot());
    SessionStore.flushPendingWrites();

    const loaded = await store.load("permsg-002");

    // 从落盘的逐条记录重新累加（这就是"按单条回复归因"的实际读法）
    const summed = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    };
    for (const m of loaded!.messages) {
      const u = (m._meta as any)?.usage;
      if (!u) continue;
      summed.inputTokens += u.inputTokens ?? 0;
      summed.outputTokens += u.outputTokens ?? 0;
      summed.cacheReadInputTokens += u.cacheReadInputTokens ?? 0;
      summed.cacheCreationInputTokens += u.cacheCreationInputTokens ?? 0;
    }

    // 聚合侧口径：回灌快照后读总量
    const resumed = new SessionState("permsg-002-resumed");
    resumed.hydrateUsage(loaded!.metadata!["usage_stats"] as any);
    const agg = resumed.getTotalUsage();

    // 关键不变量：两套口径必须一致
    expect(summed.inputTokens).toBe(agg.inputTokens);
    expect(summed.outputTokens).toBe(agg.outputTokens);
    expect(summed.cacheReadInputTokens).toBe(agg.cacheReadInputTokens ?? 0);
    expect(summed.cacheCreationInputTokens).toBe(agg.cacheCreationInputTokens ?? 0);

    // 冗余核对：手算总量也对得上（防两侧同时算错的假阳性）
    expect(summed.inputTokens).toBe(1000 + 2500 + 700);
    expect(summed.outputTokens).toBe(200 + 430 + 90);
    expect(summed.cacheReadInputTokens).toBe(800 + 2000);
    expect(summed.cacheCreationInputTokens).toBe(100 + 50);
  });

  test("归因粒度：每条回复的 usage 各自独立，不是被总量覆盖", async () => {
    const store = new SessionStore();
    store.startSession("permsg-003", "m", "anthropic", "/cwd");
    store.appendMessage(assistant("第一条"), { usage: { inputTokens: 100, outputTokens: 10 } });
    store.appendMessage(assistant("第二条"), { usage: { inputTokens: 900, outputTokens: 90 } });
    SessionStore.flushPendingWrites();

    const loaded = await store.load("permsg-003");
    const usages = loaded!.messages.map((m) => (m._meta as any)?.usage);
    expect(usages[0].inputTokens).toBe(100);
    expect(usages[1].inputTokens).toBe(900);
  });

  test("usage 只挂 _meta，不进 content（不污染发给 LLM 的请求体）", async () => {
    const store = new SessionStore();
    store.startSession("permsg-004", "m", "anthropic", "/cwd");
    store.appendMessage(assistant("正文"), {
      usage: { inputTokens: 1, outputTokens: 2 },
      model: "m",
      stopReason: "end_turn",
    });
    SessionStore.flushPendingWrites();

    const loaded = await store.load("permsg-004");
    const msg = loaded!.messages[0];
    expect(msg.content).toEqual([{ type: "text", text: "正文" }]);
    expect(JSON.stringify(msg.content)).not.toContain("inputTokens");
  });

  test("无 usage 的 assistant 消息（如降级/中间态）不产生 _meta.usage，也不报错", async () => {
    const store = new SessionStore();
    store.startSession("permsg-005", "m", "anthropic", "/cwd");
    store.appendMessage(assistant("无用量记录的回复"));
    SessionStore.flushPendingWrites();

    const loaded = await store.load("permsg-005");
    expect(loaded!.messages.length).toBe(1);
    expect((loaded!.messages[0]._meta as any)?.usage).toBeUndefined();
  });

  test("部分字段缺失（无 cache 维度的 provider）按 0 归因，不产生 NaN", async () => {
    const store = new SessionStore();
    store.startSession("permsg-006", "gpt-4", "openai", "/cwd");
    // OpenAI 族无 cacheCreation 维度：只落两字段
    store.appendMessage(assistant("r"), { usage: { inputTokens: 500, outputTokens: 60 } });
    SessionStore.flushPendingWrites();

    const loaded = await store.load("permsg-006");
    const u = (loaded!.messages[0]._meta as any).usage;
    expect(u.inputTokens).toBe(500);
    expect(u.cacheReadInputTokens).toBeUndefined();
    // 归因累加时按 0 处理，不出 NaN
    const readTokens = u.cacheReadInputTokens ?? 0;
    expect(Number.isNaN(readTokens)).toBe(false);
    expect(readTokens).toBe(0);
  });
});
