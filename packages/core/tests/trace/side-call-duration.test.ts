/**
 * 辅助调用耗时汇总（D8，2026-11-10 成本口径核查）。
 *
 * ## 它防的是什么
 *
 * `/cost` 的「API 耗时」只累加**主循环**请求（`SessionState.totalAPIDuration` 只在
 * `query/loop.ts` 的 `updateUsage` 里涨），辅助调用（记忆 fork / 标题生成 / 记忆召回）
 * 花了多少时间**哪里都看不到**。实测一次会话辅助调用花了 23.9s，用户以为 API 只用了
 * 2m52s 就是全部。
 *
 * 修法的数据链是 `BilledRequest.elapsedMs` → `recordSideCall.durationMs` →
 * `getSideStats()`。本文件守最后一段：**汇总只算采集到的，不把「未采集」折成 0**。
 *
 * ## 为什么「未采集」和「0 毫秒」必须分开
 *
 * 修复前 14 个 `recordSideCall` 调用点里有 13 个写死 `durationMs: 0`，只有
 * `side-call-nonstreaming.ts` 真的计时。如果汇总把 0 当真实耗时求和，`/cost` 会显示
 * 「辅助调用耗时 0s」——用户以为后台调用不花时间，实际是计费通道没接计时。
 * 所以字段改成可选：`undefined` = 未采集（显示层写「—」），`0` = 采集到的 0。
 */
import { describe, test, expect, beforeEach } from "bun:test";
import {
  recordSideCall,
  getSideStats,
  resetSideCallStats,
} from "@sid-code/core/trace/side-call-sink.ts";

/** 一次最小的辅助调用记录（只有耗时是变量，其余固定，便于对账）。 */
function sideCall(extra: { durationMs?: number; label?: string } = {}) {
  return {
    label: extra.label ?? "fork:memory-extract",
    model: "test-model",
    inputTokens: 1000,
    outputTokens: 100,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    ...(extra.durationMs !== undefined && { durationMs: extra.durationMs }),
  };
}

describe("getSideStats 的耗时汇总（D8）", () => {
  beforeEach(() => {
    resetSideCallStats();
  });

  test("只累加采集到的耗时；未采集的条目不计入，也不当成 0", () => {
    recordSideCall(sideCall({ durationMs: 1200 }));
    recordSideCall(sideCall({ label: "recall" })); // 不传 = 未采集
    recordSideCall(sideCall({ durationMs: 800 }));

    const stats = getSideStats();
    expect(stats.apiCalls).toBe(3);
    expect(stats.durationMs).toBe(2000);
    // 关键：分母是「采集到的条数」，不是总条数 —— 显示层要能写「2/3 次采集到」
    expect(stats.durationCalls).toBe(2);
  });

  test("durationMs: 0 是采集到的 0 毫秒，不是未采集", () => {
    recordSideCall(sideCall({ durationMs: 0 }));

    const stats = getSideStats();
    expect(stats.durationCalls).toBe(1);
    expect(stats.durationMs).toBe(0);
    expect(stats.details[0]?.durationMs).toBe(0);
  });

  test("全部未采集时 durationCalls 为 0（显示层据此写「—」）", () => {
    recordSideCall(sideCall());
    recordSideCall(sideCall({ label: "recall" }));

    const stats = getSideStats();
    expect(stats.apiCalls).toBe(2);
    expect(stats.durationCalls).toBe(0);
    expect(stats.durationMs).toBe(0);
    // 逐条也不应出现 0 —— 「没有这个字段」和「耗时是 0」在 JSON 里必须可区分
    expect(stats.details.every((d) => !("durationMs" in d))).toBe(true);
  });

  test("details 逐条带出耗时，供按用途拆分（D14 的前置数据）", () => {
    recordSideCall(sideCall({ label: "fork:memory-extract", durationMs: 3000 }));
    recordSideCall(sideCall({ label: "fork:session-memory-update", durationMs: 500 }));

    const stats = getSideStats();
    expect(stats.details).toHaveLength(2);
    expect(stats.details[0]?.durationMs).toBe(3000);
    expect(stats.details[1]?.durationMs).toBe(500);
  });

  test("reset 后清零（跨会话不串账）", () => {
    recordSideCall(sideCall({ durationMs: 1200 }));
    resetSideCallStats();

    const stats = getSideStats();
    expect(stats.apiCalls).toBe(0);
    expect(stats.durationMs).toBe(0);
    expect(stats.durationCalls).toBe(0);
  });
});
