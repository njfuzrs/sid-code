/**
 * PR11 §4.7：StreamStall 分档 —— 每流每档位各一次，而不是每流只有一次
 *
 * ## 原形态的缺陷
 *
 * 实测 `StreamStall=1` 而 `WatchdogKill=23`：23 次长时间无进展，`events.jsonl` 里
 * 只有 1 条 stall 记录（一个 `stallEmitted` 布尔，首次越线后永不再发）。
 * 想回答"每次卡了多久"只能从 WatchdogKill 侧拼，而那份数据当时又因快照 bug 是假的。
 *
 * ## 为什么不是"每 tick 都发"
 *
 * "避免 events.jsonl 膨胀"这个取向是对的：一条卡死 10 分钟的流会产出 20 条重复事件。
 * 分档后上界固定（最多档位数条），且每条对应一个**量级不同**的事实
 * （"卡过 30s"与"卡过 5 分钟"是两回事），同档内的重复被吃掉。
 *
 * ## 用真实 provider 路径
 *
 * 分档逻辑在 `openai.ts` 的 `stallLogger` interval 里，与 `STALL_TIERS` 常量、
 * 休眠扣减、`markContentProgress` 三者耦合。单独测一个纯函数证不了接线。
 * 阈值靠 env 压不动（`STALL_LOG_MS` 是硬编码 30s），所以这里断言的是
 * **源码形态 + 汇总条的行为**，并明确标注哪一部分没有被端到端覆盖。
 *
 * fix_type: case_design
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  initStreamObserver,
  resetStreamObserver,
  emitStreamPhase,
  emitStreamStall,
} from "@sid-code/core/trace/stream-observer.ts";

const OPENAI_SRC = readFileSync(join(import.meta.dir, "../../src/llm/openai.ts"), "utf8");

let captured: Array<{ event: string; data: Record<string, unknown> }>;

beforeEach(() => {
  captured = [];
  initStreamObserver("stall-tier-session", "/tmp/stall-tier-session", (ev) => {
    captured.push({ event: ev.event, data: ev.data });
  });
});

afterEach(() => resetStreamObserver());

describe("PR11 §4.7 — stall 分档形态", () => {
  test("旧的「每流只发一次」布尔已被移除", () => {
    // 这条是**行为回归**的锚：只要 `stallEmitted` 那个布尔还在，
    // 分档就没真正落地（哪怕 STALL_TIERS 常量已经加了）。
    expect(OPENAI_SRC).not.toContain("let stallEmitted");
    expect(OPENAI_SRC).toContain("let stallTierEmitted = -1");
  });

  test("档位严格递增，且首档保持 30s（老轨迹可比）", () => {
    const m = OPENAI_SRC.match(/const STALL_TIERS = \[([^\]]*)\]/);
    expect(m, "没找到 STALL_TIERS —— 取数源变了，先修哨兵").toBeTruthy();
    const tiers = [...m![1]!.matchAll(/([\d_]+)/g)].map((x) => Number(x[1]!.replace(/_/g, "")));
    expect(tiers.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < tiers.length; i++) {
      expect(tiers[i]!, "档位必须严格递增，否则去重游标的语义就错了").toBeGreaterThan(
        tiers[i - 1]!,
      );
    }
    // 30s 是既有告警线：改掉它会让新旧轨迹的 stall 计数不可比。
    expect(tiers[0]).toBe(30_000);
    // 最高档应覆盖本文档主问题的量级（旧 300s 硬顶）。
    expect(tiers.at(-1)).toBeGreaterThanOrEqual(300_000);
  });

  test("游标只前进不复位（同档重复 tick 必须被吃掉）", () => {
    // 断言实现形态：`tier > stallTierEmitted` 才发，且发后即推进。
    // 若写成 `>=` 或每次都发，膨胀问题就回来了。
    expect(OPENAI_SRC).toContain("if (tier > stallTierEmitted)");
    expect(OPENAI_SRC).toContain("stallTierEmitted = tier");
  });

  test("流结束时补发汇总，且只在真 stall 过时发", () => {
    // 汇总给的是**连续量**：一条卡了 119s 的流只会落一条"越过 30s 档"，
    // 读者无从知道它其实差 1 秒就到 120s 档。两者互补。
    expect(OPENAI_SRC).toContain("if (maxStallGapMs >= STALL_TIERS[0])");
    expect(OPENAI_SRC).toContain("summary: true");
  });

  test("tier_ms 与 summary 互斥，聚合时可据此排除汇总条", () => {
    emitStreamPhase(1, "sse_consuming", { model: "m" });
    emitStreamStall(1, {
      no_content_progress_ms: 35_000,
      total_chunks: 3,
      empty_chunks: 0,
      tier_ms: 30_000,
    });
    emitStreamStall(1, {
      no_content_progress_ms: 41_000,
      total_chunks: 5,
      empty_chunks: 0,
      summary: true,
    });
    const stalls = captured.filter((e) => e.event === "StreamStall");
    expect(stalls.length).toBe(2);
    // 不排除汇总条 → 同一次 stall 被数两次。这是聚合脚本最容易踩的坑，
    // 所以两个字段必须互斥且都落盘。
    const tiered = stalls.filter((s) => s.data.tier_ms !== undefined);
    const summary = stalls.filter((s) => s.data.summary === true);
    expect(tiered.length).toBe(1);
    expect(summary.length).toBe(1);
    expect(tiered[0]!.data.summary).toBeUndefined();
    expect(summary[0]!.data.tier_ms).toBeUndefined();
  });
});
