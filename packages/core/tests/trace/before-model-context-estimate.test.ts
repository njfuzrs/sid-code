/**
 * PR0（2026-11-18）：BeforeModel 轨迹事件必须带上「请求前上下文估算」四件套。
 *
 * ## 为什么这条值得一个常驻测试
 *
 * 「估算 vs 真实 input 的误差」是「更准」方向的唯一主口径（方案 M1）。它的分子是
 * `ctx_estimated_tokens − ctx_freed_tokens`，分母是同 index 的 AfterModel 里归一化后的
 * `promptTotal`。**分子缺一个字段，整套误差统计就静默变成 0 样本或错数**，而轨迹文件
 * 不会报错——这正是本仓反复踩过的「仪器空洞被当成事实」（见 before-model-thinking-fields）。
 *
 * 所以这里守三件事：
 * 1. 四个字段真的落进了 events.jsonl 的 `BeforeModel.data`，且类型正确；
 * 2. raw.jsonl 的两条记录（request_sent 预写行 + 完整 pair 行）**同源同值**都带，
 *    不能一边有一边没有；
 * 3. 调用方不带这些字段时（老调用方 / 回放 / 直接调 hook），三处都不写，
 *    保持旧轨迹形状不变——0 与 `undefined` 都不许冒充观测值。
 */

import { describe, test, expect } from "bun:test";
import { TraceCollector } from "@sid-code/core/trace/collector.ts";
import { HookSystem } from "@sid-code/core/hook/system.ts";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** 一套自洽的夹具：估算高于锚点（未触发锚点抬升）、freed 小于估算 */
const CTX_FIELDS = {
  ctx_estimated_tokens: 123_456,
  ctx_freed_tokens: 7_890,
  ctx_anchor_tokens: 120_000,
  ctx_calibrated: true,
} as const;

const SESSION_ID = "sess-ctx-estimate";

function makeHarness(): { testDir: string; hookSystem: HookSystem; collector: TraceCollector } {
  const testDir = join(
    tmpdir(),
    `trace-ctx-estimate-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(testDir, { recursive: true });
  const hookSystem = new HookSystem();
  const collector = new TraceCollector({ outputDir: testDir });
  collector.registerHooks(hookSystem);
  return { testDir, hookSystem, collector };
}

/** BeforeModel 需要 SessionStart 先建 metadata，与生产顺序一致 */
async function sessionStart(hookSystem: HookSystem): Promise<void> {
  // ⚠️ session id 必须在 fire 之前设：writer 的会话目录名取的是 SessionStart 那一刻的
  // input.session_id（collector.handleSessionStart 的 traceSessionId）。设在 fire 之后，
  // 目录会落到一个自动生成的值上，测试读文件直接 ENOENT。
  hookSystem.setSessionId(SESSION_ID);
  hookSystem.setCwd("/tmp/test");
  await hookSystem.fireSessionStartEvent("startup", { model: "claude-test" });
  hookSystem.setSessionId(SESSION_ID);
  hookSystem.setCwd("/tmp/test");
}

function readJsonl(path: string): any[] {
  return readFileSync(path, "utf-8")
    .trim()
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

function eventsPath(testDir: string): string {
  return join(testDir, "sessions", SESSION_ID, "events.jsonl");
}

function rawPath(testDir: string): string {
  return join(testDir, "sessions", SESSION_ID, "raw.jsonl");
}

describe("PR0 BeforeModel 上下文估算四件套", () => {
  test("四字段落进 events.jsonl 的 BeforeModel.data，且能与同 index 的 AfterModel 配对", async () => {
    const { testDir, hookSystem } = makeHarness();
    await sessionStart(hookSystem);

    await hookSystem.fireBeforeModelEvent({
      model: "claude-test",
      messages: [{ role: "user", content: "hello" }],
      raw_messages: [{ role: "user", content: "hello" }],
      ...CTX_FIELDS,
    });
    await hookSystem.fireAfterModelEvent(
      {
        model: "claude-test",
        messages: [],
        raw_messages: [{ role: "user", content: "hello" }],
      },
      {
        content_blocks: [{ type: "text", text: "回答" }],
        stop_reason: "end_turn",
        usage: {
          inputTokens: 130_000,
          outputTokens: 50,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      },
    );

    const before = readJsonl(eventsPath(testDir)).find((e) => e.event === "BeforeModel");
    const after = readJsonl(eventsPath(testDir)).find((e) => e.event === "AfterModel");

    // ① 四个字段都在，类型正确（类型错了下游脚本会静默算出 NaN 或 0）
    expect(before.data.ctx_estimated_tokens).toBe(CTX_FIELDS.ctx_estimated_tokens);
    expect(before.data.ctx_freed_tokens).toBe(CTX_FIELDS.ctx_freed_tokens);
    expect(before.data.ctx_anchor_tokens).toBe(CTX_FIELDS.ctx_anchor_tokens);
    expect(before.data.ctx_calibrated).toBe(true);
    expect(typeof before.data.ctx_estimated_tokens).toBe("number");
    expect(typeof before.data.ctx_freed_tokens).toBe("number");
    expect(typeof before.data.ctx_anchor_tokens).toBe("number");
    expect(typeof before.data.ctx_calibrated).toBe("boolean");

    // ② 对账口径要求「同一个 index」——配不上就等于没有分母
    expect(after).toBeDefined();
    expect(after.data.index).toBe(before.data.index);
  });

  test("raw.jsonl 的 request_sent 预写行与完整 pair 行同源同值都带四字段", async () => {
    const { testDir, hookSystem } = makeHarness();
    await sessionStart(hookSystem);

    await hookSystem.fireBeforeModelEvent({
      model: "claude-test",
      messages: [{ role: "user", content: "hello" }],
      raw_messages: [{ role: "user", content: "hello" }],
      ...CTX_FIELDS,
    });
    await hookSystem.fireAfterModelEvent(
      {
        model: "claude-test",
        messages: [],
        raw_messages: [{ role: "user", content: "hello" }],
      },
      {
        content_blocks: [{ type: "text", text: "回答" }],
        stop_reason: "end_turn",
        usage: {
          inputTokens: 130_000,
          outputTokens: 50,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      },
    );

    const rows = readJsonl(rawPath(testDir));
    const sentLine = rows.find((r) => r.type === "request_sent")!;
    const pairLine = rows.find((r) => r.type !== "request_sent")!;

    // 预写行（请求 hang / 进程被 kill 时唯一的请求侧证据）
    expect(sentLine.ctx_estimated_tokens).toBe(CTX_FIELDS.ctx_estimated_tokens);
    expect(sentLine.ctx_freed_tokens).toBe(CTX_FIELDS.ctx_freed_tokens);
    expect(sentLine.ctx_anchor_tokens).toBe(CTX_FIELDS.ctx_anchor_tokens);
    expect(sentLine.ctx_calibrated).toBe(true);

    // 完整 pair 行的 request 侧：与 events.jsonl 同源，不是另一套口径
    expect(pairLine.request.ctx_estimated_tokens).toBe(CTX_FIELDS.ctx_estimated_tokens);
    expect(pairLine.request.ctx_freed_tokens).toBe(CTX_FIELDS.ctx_freed_tokens);
    expect(pairLine.request.ctx_anchor_tokens).toBe(CTX_FIELDS.ctx_anchor_tokens);
    expect(pairLine.request.ctx_calibrated).toBe(true);
  });

  test("调用方不带四字段时三处都不写（老载荷形状不变）", async () => {
    const { testDir, hookSystem } = makeHarness();
    await sessionStart(hookSystem);

    // 老调用方 / 回放 / 直接调 hook 的形态：只有最基本的请求信息
    await hookSystem.fireBeforeModelEvent({
      model: "claude-test",
      messages: [{ role: "user", content: "hello" }],
      raw_messages: [{ role: "user", content: "hello" }],
    });
    await hookSystem.fireAfterModelEvent(
      {
        model: "claude-test",
        messages: [],
        raw_messages: [{ role: "user", content: "hello" }],
      },
      {
        content_blocks: [{ type: "text", text: "回答" }],
        stop_reason: "end_turn",
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      },
    );

    const before = readJsonl(eventsPath(testDir)).find((e) => e.event === "BeforeModel")!;
    // 关键：key 不存在，而不是存在但为 undefined/0 —— 后者会被脚本当成观测值
    for (const key of [
      "ctx_estimated_tokens",
      "ctx_freed_tokens",
      "ctx_anchor_tokens",
      "ctx_calibrated",
    ]) {
      expect(key in before.data).toBe(false);
    }

    const rows = readJsonl(rawPath(testDir));
    const sentLine = rows.find((r) => r.type === "request_sent")!;
    const pairLine = rows.find((r) => r.type !== "request_sent")!;
    for (const key of [
      "ctx_estimated_tokens",
      "ctx_freed_tokens",
      "ctx_anchor_tokens",
      "ctx_calibrated",
    ]) {
      expect(key in sentLine).toBe(false);
      expect(key in pairLine.request).toBe(false);
    }
  });

  test("loop 写入的 ctx_estimated_tokens 必须是全量历史口径（getHistoryTokens）", () => {
    // 契约：预测发送量 = ctx_estimated_tokens − ctx_freed_tokens（方案 §8.3、
    // hook/types.ts 字段注释）。若这里取的是 getSendTokens()（已扣 freed 的发送量），
    // 再减一次 freed 就是**双重扣减**，M1 会被系统性放大。
    //
    // 为什么这条值得一个源码字面量断言（而不是行为测试）：PR2 把 27 处调用点统一迁到
    // 「发送量 / 全量历史」两个具名 API 时，把这一处也一起换掉了——它属于「度量」语义，
    // 该用 getHistoryTokens。这类批量迁移的误伤在 freed 恒为 0 的会话上**完全看不出来**
    //（减法恒等），直到 2026-11-18 的 E1 端到端验收在有释放量的会话上算出 S1 31.1% /
    // S2 117.7% 的 M1 才暴露。行为测试要造出「有 freed 且已校准」的完整 loop 轨迹才能
    // 捕获它，成本远高于直接钉住这一行取值。
    const src = readFileSync(new URL("../../src/query/loop.ts", import.meta.url), "utf8");
    const m = src.match(/ctx_estimated_tokens:\s*([^,\n]+)/);
    expect(m, "loop.ts 里应当有 ctx_estimated_tokens 的载荷写入").not.toBeNull();
    expect(m![1]!.trim()).toBe("ctxMgr.getHistoryTokens(toolCount)");
  });
});
