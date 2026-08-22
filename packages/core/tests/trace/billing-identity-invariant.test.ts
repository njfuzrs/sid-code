/**
 * 恒等式门禁 —— 方案 §6 判据 1 + §5.4 归因拆分
 *
 * ## 判据 1：`HttpConnected` 数 == 计费事件数
 *
 * 现状（改造前）是 `39 ≠ 17`。这个恒等式的价值在于它**同时**覆盖两类退化：
 *   · 有人新增调用链绕过入账 → 计费事件少了 → 失衡；
 *   · 有人把计费上报搬到某个只覆盖部分出口的位置 → 同样失衡。
 *
 * 它抓不住的是"有人绕过 provider 自己发 fetch" —— 但那会**同时**丢掉 `HttpConnected`，
 * 于是恒等式两边一起少，看起来仍然平衡。这是本门禁的已知盲区，如实记在这里：
 * 真正的兜底是 §5.6 的对账脚本（拿官方账单比），因为它测的是最终结果。
 */

import { test, expect, describe } from "bun:test";
import { computeProcessPathology } from "../../src/trace/digest.ts";

/** 造一条 events.jsonl 事件 */
function ev(event: string, data: Record<string, unknown> = {}) {
  return { event, session_id: "s", timestamp: "2026-08-21T06:00:00.000Z", data };
}

/** 造 n 条 HttpConnected */
function conns(n: number) {
  return Array.from({ length: n }, () => ev("HttpConnected", { status: 200 }));
}

/** 造 n 条已记账轮次（AfterModelRaw，带 usage） */
function accounted(n: number, inputTokens = 100_000) {
  return Array.from({ length: n }, () =>
    ev("AfterModelRaw", { usage: { input_tokens: inputTokens } }),
  );
}

describe("§5.4：白建连接的归因必须拆分成因", () => {
  test("其它调用链的成功流**不得**被算成重试白烧（本次事故的归因错误）", () => {
    // 复现 2026-08-21 那次会话的形态：39 次建连、17 次记账，
    // 差的 22 次全部来自两个 fork 的**成功**流（http 200，无一抛错）。
    const events = [
      ...conns(39),
      ...accounted(17),
      // fork 的流带身份（PR2 起 provider 侧落 agent_id）
      ...Array.from({ length: 22 }, (_, i) =>
        ev("StreamPhase", {
          index: 900_000 + i,
          phase: "fetch_sent",
          agent_id: `fork:${i % 2 === 0 ? "session-memory-update" : "memory-extract"}`,
          attempt: 1,
        }),
      ),
    ];

    const p = computeProcessPathology([] as any, events as any);

    expect(p.extraConnections).toBe(22);
    // 关键断言：22 次全部归到"其它调用链"，重试归因为 0。
    // 改造前这 22 次被报成 retryWastedTokens，把排查引向了 fallback.ts（那里没问题）。
    expect(p.otherChainConnections).toBe(22);
    expect(p.retryConnections).toBe(0);
    // 重试白烧无量可算 → undefined 而非 0（0 会被读成"测过了，没有浪费"）
    expect(p.retryWastedTokens).toBeUndefined();
    expect(p.retryWastedPathological).toBe(false);
  });

  test("真·重试仍然被算成白烧（不能为了修归因把这条也一起关掉）", () => {
    // 无身份的差额 = 主循环自己的重试，行为必须与改造前一致。
    const events = [...conns(30), ...accounted(10, 100_000)];
    const p = computeProcessPathology([] as any, events as any);
    expect(p.extraConnections).toBe(20);
    expect(p.otherChainConnections).toBe(0);
    expect(p.retryConnections).toBe(20);
    expect(p.retryWastedTokens).toBe(20 * 100_000);
    expect(p.retryWastedPathological).toBe(true);
  });

  test("混合场景：两类成因各自归位", () => {
    const events = [
      ...conns(30),
      ...accounted(10, 100_000),
      // 5 条带身份的流 → 归"其它调用链"，剩下 15 归重试
      ...Array.from({ length: 5 }, (_, i) =>
        ev("StreamPhase", {
          index: 900_000 + i,
          phase: "fetch_sent",
          agent_id: "fork:a",
          attempt: 1,
        }),
      ),
    ];
    const p = computeProcessPathology([] as any, events as any);
    expect(p.extraConnections).toBe(20);
    expect(p.otherChainConnections).toBe(5);
    expect(p.retryConnections).toBe(15);
    expect(p.retryWastedTokens).toBe(15 * 100_000);
  });

  test("老轨迹（StreamPhase 无 agent_id）行为与改造前逐字节一致", () => {
    // 向后兼容：不能把历史数据重算成新口径，否则"曲线动了"分不清是修了还是口径变了。
    const events = [
      ...conns(30),
      ...accounted(10, 100_000),
      ...Array.from({ length: 8 }, (_, i) =>
        ev("StreamPhase", { index: i, phase: "fetch_sent", attempt: 1 }),
      ),
    ];
    const p = computeProcessPathology([] as any, events as any);
    expect(p.otherChainConnections).toBe(0);
    expect(p.retryConnections).toBe(20);
  });

  test("身份齐全但记账也齐全时不产生负数（Math.min 兜底）", () => {
    const events = [
      ...conns(10),
      ...accounted(10),
      ...Array.from({ length: 5 }, (_, i) =>
        ev("StreamPhase", {
          index: 900_000 + i,
          phase: "fetch_sent",
          agent_id: "fork:a",
          attempt: 1,
        }),
      ),
    ];
    const p = computeProcessPathology([] as any, events as any);
    expect(p.extraConnections).toBe(0);
    expect(p.otherChainConnections).toBe(0);
    expect(p.retryConnections).toBe(0);
  });

  test("同一条流的多个 phase 只计一次（去重到流粒度）", () => {
    const events = [
      ...conns(12),
      ...accounted(10),
      // 同一条流发了 fetch_sent + headers_received + first_content + completed
      ev("StreamPhase", { index: 900_001, phase: "fetch_sent", agent_id: "fork:a", attempt: 1 }),
      ev("StreamPhase", {
        index: 900_001,
        phase: "headers_received",
        agent_id: "fork:a",
        attempt: 1,
      }),
      ev("StreamPhase", { index: 900_001, phase: "first_content", agent_id: "fork:a", attempt: 1 }),
      ev("StreamPhase", { index: 900_001, phase: "completed", agent_id: "fork:a", attempt: 1 }),
      ev("StreamPhase", { index: 900_002, phase: "fetch_sent", agent_id: "fork:b", attempt: 1 }),
    ];
    const p = computeProcessPathology([] as any, events as any);
    // 2 条流，不是 5 个 phase。first_content/completed 不参与计数（只认开场 phase）。
    expect(p.otherChainConnections).toBe(2);
  });
});
