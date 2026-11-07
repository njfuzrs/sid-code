/**
 * T6：增量游标不能在「请求发出时」推进（2026-11-07，检测器精度治理的根因修复）
 *
 * ## 缺陷形态
 *
 * `computeNewMessages` 在 `handleBeforeModel`（请求**发出前**）调用，旧实现一被调用就把
 * `prevMessageCount` 推进到本轮 messages 长度。于是失败重试时：
 *
 *   第一次请求 → 游标推到 81 → 请求失败，重试
 *   第二次请求（messages 仍是 81 条）→ `slice(81)` = [] → new_messages 空
 *   而落盘的恰恰是第二次的 pair → **整轮 tool_result 不进轨迹**
 *
 * 后果是 digest 把一个记录器缺陷报成「tool_use 没有结果、疑似中途崩溃 / 协议违规」，
 * 把排查引向不存在的问题。样本 `20261019-002707-0d3ddd0e` 的 index 41：
 * raw.jsonl 里两条 request_sent 记录 + 一条 `new_messages=0` 的完整 pair。
 *
 * ## 为什么不是「压缩后条数相同」那条假设
 *
 * 方案文档原来的诊断是压缩导致 `length < prev` 判据不触发。回源码核实：
 * `handlePreCompact` 已经把游标重置为 0，自动压缩同样触发 PreCompact hook
 * （`query/auto-compact.ts` 的 `firePreCompactEvent("auto")`）。所以压缩路径本来是对的，
 * 真正丢增量的是重试路径。
 *
 * 落盘隔离：全程 outputDir 指向 tmpdir。
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { TraceCollector } from "@sid-code/core/trace/collector.ts";
import { HookSystem } from "@sid-code/core/hook/system.ts";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let testDir: string;
let hookSystem: HookSystem;
let collector: TraceCollector;

beforeEach(() => {
  testDir = join(tmpdir(), `trace-increment-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
  hookSystem = new HookSystem();
  hookSystem.setSessionId("sess-t6");
  hookSystem.setCwd("/tmp/test");
  collector = new TraceCollector({ outputDir: testDir });
  collector.registerHooks(hookSystem);
});
afterEach(() => rmSync(testDir, { recursive: true, force: true }));

/** 只发 BeforeModel（模拟请求发出但还没拿到响应） */
async function fireRequest(messages: unknown[]) {
  await hookSystem.fireBeforeModelEvent({
    model: "claude-test",
    messages: messages.map((m: any) => ({
      role: m.role,
      content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    })),
    raw_messages: messages,
  });
}

/** 发 AfterModel（落盘这一轮） */
async function fireResponse(messages: unknown[]) {
  await hookSystem.fireAfterModelEvent(
    { model: "claude-test", messages: [], raw_messages: messages },
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
}

const u1 = { role: "user", content: "第一问" };
const u2 = { role: "user", content: "第二问" };

describe("T6 增量游标在 pair 落盘后才推进", () => {
  it("重试：两次相同 messages 的请求都拿到完整增量，不会被切成空", async () => {
    await hookSystem.fireSessionStartEvent("startup", { model: "claude-test" });

    // 第一次请求：全量
    expect(collector.computeNewMessages([u1])).toEqual([u1]);
    // 请求失败、没有 AfterModel。重试同一个请求 —— 旧实现这里返回 []（游标已被第一次推进）
    expect(collector.computeNewMessages([u1])).toEqual([u1]);
  });

  it("正常一轮落盘后，下一轮只取新增的部分", async () => {
    await hookSystem.fireSessionStartEvent("startup", { model: "claude-test" });

    await fireRequest([u1]);
    await fireResponse([u1]);
    // 本轮已落盘 → 游标推进到 1
    expect(collector.getPrevMessageCount()).toBe(1);

    // 下一轮多了一条：只该返回新增的那条
    expect(collector.computeNewMessages([u1, u2])).toEqual([u2]);
  });

  it("落盘的那一轮用完整 messages，增量与轨迹里能对上的 tool_result 数一致", async () => {
    await hookSystem.fireSessionStartEvent("startup", { model: "claude-test" });

    // 第一次请求带 2 条，失败；重试带 2 条并成功
    await fireRequest([u1]);
    await fireRequest([u1]);
    await fireResponse([u1]);

    // 落盘轮的增量应为全量（2 条之前的基线是空），而不是空数组
    const prev = collector.getPrevMessageCount();
    expect(prev).toBe(1);
  });
});
