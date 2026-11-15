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
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
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

/**
 * 读**落盘**的 raw.jsonl。
 *
 * 存在的理由：本文件第 3 个用例验的是「轨迹里到底有没有那一轮的 tool_result」，
 * 只看 `getPrevMessageCount()` 是验不到的 —— 游标值对、但落盘内容被切成空的组合
 * 完全可能（改坏 handleAfterModel 的 committedCount 就够）。所以断言必须回到文件。
 *
 * TraceWriter 落点：`<outputDir>/sessions/<sessionId>/raw.jsonl`；这里不猜 sessionId，
 * 直接扫一层目录。
 */
function readRawPairs(): any[] {
  const sessionsDir = join(testDir, "sessions");
  if (!existsSync(sessionsDir)) return [];
  const out: any[] = [];
  for (const sid of readdirSync(sessionsDir)) {
    const file = join(sessionsDir, sid, "raw.jsonl");
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const text = line.trim();
      if (!text) continue;
      try {
        out.push(JSON.parse(text));
      } catch {
        /* 崩溃安全写可能留半截行，跳过 */
      }
    }
  }
  return out;
}

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

    // 一轮完整上下文：提问 → 工具调用 → 工具结果 → 追问（4 条）
    const withTool = [
      u1,
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu-1", name: "Read", input: { file_path: "/tmp/a" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu-1", content: "文件内容" }],
      },
      u2,
    ];

    // 同一轮请求发两次（第二次是重试，第一次没有 AfterModel），落盘的是重试这一轮。
    // 旧实现：第一次 fireBeforeModel 就把游标推到 4，重试那轮 `computeNewMessages` 切出
    // `[]`，而落盘的恰恰是重试这一轮 —— 轨迹里整轮 tool_result 消失。
    await fireRequest(withTool);
    await fireRequest(withTool);
    await fireResponse(withTool);

    const pairs = readRawPairs().filter((r) => r.request && typeof r.request === "object");
    expect(pairs.length).toBe(1); // 只落了一轮：失败那次没有 AfterModel

    const newMessages = pairs[0].request.new_messages as any[];
    // ★核心断言：落盘增量不是空数组（旧实现这里是 []）
    expect(newMessages.length).toBe(withTool.length);
    // 轨迹里能对上的 tool_result 就在增量里，且只有那一个
    const carried = newMessages.filter((m) => JSON.stringify(m.content).includes('"tool_result"'));
    expect(carried.length).toBe(1);
    expect(JSON.stringify(carried[0])).toContain("tu-1");
    // 游标在**落盘后**才推进到本轮长度
    expect(collector.getPrevMessageCount()).toBe(withTool.length);
  });
});
