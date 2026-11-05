/**
 * PR5（会话 f5beebde 复盘 §6 T1–T7）：trace-digest 读数缺陷的回归门禁
 *
 * ## 这些用例防的是什么
 *
 * 那次会话的评估**差点下错结论**：`TimeoutFired` 有 10 次、`warn.log` 里 4084 行 stall，
 * 两个数都"看起来像防线在工作 / 像流很慢"，实际是一次都没生效、定时器全在空转。
 * 所以这里断言的不是"函数能跑"，而是**"能不能把幽灵触发和真超时、泄漏和慢流分开"** ——
 * 这正是旧口径读不出来的东西。
 *
 * 每条用例都对应方案里的一条判据；反例（不该命中的形态）和正例同等重要 ——
 * 一个只会命中的检测器会把正常会话刷成一片红，然后没人看它。
 */

import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  detectGhostTimeouts,
  detectLeakyStreams,
  groupProviderHealth,
  buildSubAgentSummary,
  describePathology,
  aggregateSessionMetrics,
} from "../../src/trace/digest.ts";
import type { ProcessPathologyStats } from "../../src/trace/digest.ts";

/** 造一条 events.jsonl 事件（时间戳与落盘格式一致，用 ISO 字符串） */
function ev(event: string, timestamp: string, data: Record<string, unknown> = {}) {
  return { event, timestamp, data };
}

/** 时间基准：2026-11-03T13:40:00.000Z（与实证会话同一天，便于对照） */
const T0 = Date.parse("2026-11-03T13:40:00.000Z");
/** 相对 T0 的毫秒偏移 → ISO 时间戳 */
const at = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

/** 造一条 stream_completed（带 turnIndex，与 TimeoutFired.index 同空间） */
const completed = (offsetMs: number, turnIndex: number, agentId?: string) =>
  ev("RetryTelemetry", at(offsetMs), {
    type: "stream_completed",
    turnIndex,
    ...(agentId ? { agentId } : {}),
  });

/** 造一条 stream_stall */
const stall = (
  offsetMs: number,
  turnIndex: number,
  opts: { gapMs?: number; totalEvents?: number; agentId?: string } = {},
) =>
  ev("RetryTelemetry", at(offsetMs), {
    type: "stream_stall",
    turnIndex,
    gapMs: opts.gapMs ?? 44_000,
    totalEvents: opts.totalEvents ?? 2,
    ...(opts.agentId ? { agentId: opts.agentId } : {}),
  });

/** 造一条 TimeoutFired */
const timeoutFired = (offsetMs: number, index: number, thresholdMs = 240_000) =>
  ev("TimeoutFired", at(offsetMs), {
    index,
    layer: "idle_timeout",
    threshold_ms: thresholdMs,
  });

describe("T1：删掉「TimeoutFired 存在 = 超时正常生效」这句结论性提示", () => {
  test("digest 源码里不再有那句会把幽灵触发读成防线生效的提示", () => {
    // 为什么用源码字面量断言而不是行为断言：那句话是**给读者看的结论**，不是被断言的逻辑。
    // 谁把它加回去，digest 输出的结论就会与实际相反 —— 而输出的其它部分完全正常，
    // 行为测试抓不到。这是本仓既有的做法（跨域源码字面量断言），见 CLAUDE.md。
    const src = readFileSync(join(import.meta.dir, "../../src/trace/digest.ts"), "utf8");
    expect(src).not.toContain("说明超时正常生效（触发即中断）");
    // 正例：新提示存在（指向检测器，而不是替读者下结论）
    expect(src).toContain("timeout_fired_after_attempt_end");
  });
});

describe("T2：幽灵超时 —— 超时开在已结束的尝试上", () => {
  test("流已结束、之后再无新一代尝试 → 命中，且带「间隔 ≈ 阈值」这条强证据", () => {
    const events = [completed(0, 10_001), timeoutFired(240_000, 10_001)];
    const hits = detectGhostTimeouts(events);

    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      index: 10_001,
      layer: "idle_timeout",
      endEvent: "stream_completed",
      gapMs: 240_000,
      thresholdMs: 240_000,
    });
  });

  test("流还活着时开枪 → 不算幽灵（正常超时不得被误报）", () => {
    const events = [
      timeoutFired(120_000, 7),
      // 终点在 fire 之后：这次枪打在活的流上
      completed(240_000, 7),
    ];
    expect(detectGhostTimeouts(events)).toHaveLength(0);
  });

  test("终点之后又开了新一代尝试 → 不判幽灵（这一枪打在新尝试上）", () => {
    const events = [
      ev("AfterModel", at(0), { index: 10 }),
      ev("StreamRestart", at(60_000), { index: 10, reason: "unrecognized" }),
      timeoutFired(180_000, 10),
    ];
    expect(detectGhostTimeouts(events)).toHaveLength(0);
  });

  test("AfterModel 作终点同样成立（主循环路径的终点形态）", () => {
    const events = [ev("AfterModel", at(0), { index: 11 }), timeoutFired(240_000, 11)];
    const hits = detectGhostTimeouts(events);
    expect(hits).toHaveLength(1);
    expect(hits[0].endEvent).toBe("AfterModel");
  });

  test("复现本会话形态：同一批 TimeoutFired 全部开在已结束的尝试上", () => {
    // 三路子代理（10001/10004/10005）+ 主循环 index=10，间隔都≈240s 阈值
    const events = [
      completed(0, 10_001, "s-sub-a"),
      completed(72_000, 10_004, "s-sub-b"),
      completed(76_000, 10_005, "s-sub-c"),
      ev("AfterModel", at(162_000), { index: 10 }),
      timeoutFired(239_998, 10_001),
      timeoutFired(312_001, 10_004),
      timeoutFired(316_001, 10_005),
      timeoutFired(402_000, 10),
    ];
    const hits = detectGhostTimeouts(events);
    expect(hits).toHaveLength(4);
    // 全部命中「间歇≈阈值」，且都晚于终点
    for (const h of hits) expect(h.gapMs).toBeGreaterThan(0);
    expect(hits.map((h) => h.index).sort((a, b) => a - b)).toEqual([10, 10_001, 10_004, 10_005]);
  });
});

describe("T3：泄漏流 —— 流已结束 / 放弃，stall 定时器还在报", () => {
  test("流结束后仍在报 stall → completed_after 命中", () => {
    const events = [
      completed(0, 10_001, "s-sub-a"),
      stall(15_000, 10_001, { agentId: "s-sub-a", gapMs: 59_937 }),
      stall(5_400_000, 10_001, { agentId: "s-sub-a", gapMs: 5_400_000 }),
    ];
    const hits = detectLeakyStreams(events);

    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      agentId: "s-sub-a",
      turnIndex: 10_001,
      stallCount: 2,
      criterion: "completed_after",
    });
  });

  test("没有「完成之后」的 stall，但进度冻结且跨度超阈值 → frozen_span 命中", () => {
    // 复现主循环 index=11 那条：被放弃后一直报到用户重试（2.85h），
    // 而重试成功落的 stream_completed 在最后一条 stall **之后**，
    // 所以「stall 晚于 completed」对它不成立 —— 只能靠进度冻结这条判据。
    const events = [
      stall(0, 11, { gapMs: 85_595, totalEvents: 2 }),
      stall(30_000, 11, { gapMs: 115_595, totalEvents: 2 }),
      stall(10_200_000, 11, { gapMs: 42_777_635, totalEvents: 2 }),
      completed(10_260_000, 11),
    ];
    const hits = detectLeakyStreams(events);

    expect(hits).toHaveLength(1);
    expect(hits[0].criterion).toBe("frozen_span");
    expect(hits[0].frozenTotalEvents).toBe(2);
  });

  test("正常流（stall 都在 completed 之前、跨度小）→ 不命中", () => {
    const events = [
      stall(0, 5, { gapMs: 44_000, totalEvents: 3 }),
      stall(30_000, 5, { gapMs: 74_000, totalEvents: 5 }),
      completed(60_000, 5),
    ];
    expect(detectLeakyStreams(events)).toHaveLength(0);
  });

  test("同一 turnIndex 的两个并行子代理必须分开计数", () => {
    // 三路并行子代理的 turnIndex 都是 10001。只按 turnIndex 分组会把它们合成一条，
    // 泄漏数量直接少两个 —— 分组键必须含 agentId。
    const events = [
      completed(0, 10_001, "s-a"),
      completed(1_000, 10_001, "s-b"),
      stall(15_000, 10_001, { agentId: "s-a" }),
      stall(15_500, 10_001, { agentId: "s-b" }),
    ];
    const hits = detectLeakyStreams(events);
    expect(hits).toHaveLength(2);
    expect(hits.map((h) => h.agentId).sort()).toEqual(["s-a", "s-b"]);
  });
});

describe("T4：Provider 健康表按协议路径归并", () => {
  const statsOf = (
    provider: string,
    requests: number,
  ): Parameters<typeof groupProviderHealth>[0][number] => ({
    provider,
    requests,
    failed: 0,
    timedOut: 0,
    retried: 0,
    avgLatencyMs: 1000,
  });

  test("openai 与 openai-responses 归到同一组，请求数为 0 的成员不输出", () => {
    // 实测形态：openai 请求 30、openai-responses 请求 0。旧渲染出两行，
    // 读的人会以为「responses 这条路根本没被用过」——而本会话每条请求都走它。
    const groups = groupProviderHealth([statsOf("openai", 30), statsOf("openai-responses", 0)]);

    expect(groups).toHaveLength(1);
    expect(groups[0].primaryLabel).toBe("openai");
    expect(groups[0].primary.requests).toBe(30);
    expect(groups[0].subs).toHaveLength(0);
  });

  test("组内只有协议成员有请求数时，主行标签写成 openai / responses", () => {
    const groups = groupProviderHealth([statsOf("openai", 0), statsOf("openai-responses", 5)]);

    expect(groups).toHaveLength(1);
    // 不能只写 base（那会让 5 次请求看起来是走 openai 主路径的）
    expect(groups[0].primaryLabel).toBe("openai / responses");
    expect(groups[0].primary.requests).toBe(5);
  });

  test("两个协议都有请求数时拆成主行 + 子行（数值不合并）", () => {
    const groups = groupProviderHealth([statsOf("openai", 30), statsOf("openai-responses", 5)]);

    expect(groups).toHaveLength(1);
    expect(groups[0].primaryLabel).toBe("openai");
    expect(groups[0].primary.requests).toBe(30);
    expect(groups[0].subs).toEqual([{ label: "responses", stats: statsOf("openai-responses", 5) }]);
  });

  test("整组请求数都为 0 → 整组不输出（不留空标题）", () => {
    expect(groupProviderHealth([statsOf("openai-responses", 0)])).toHaveLength(0);
  });
});

describe("T5：子代理失败给原因 + sidechain 路径", () => {
  const start = (agentId: string, offsetMs = 0) =>
    ev("SubagentStart", at(offsetMs), { agent_id: agentId, agent_type: "general-purpose" });
  const stop = (agentId: string, offsetMs: number, extra: Record<string, unknown> = {}) =>
    ev("SubagentStop", at(offsetMs), { agent_id: agentId, status: "error", ...extra });
  const giveUp = (agentId: string, offsetMs: number, family: string, reason: string) =>
    ev("RetryTelemetry", at(offsetMs), {
      type: "recovery_give_up",
      agentId,
      family,
      giveUpReason: reason,
    });

  test("失败族按 agentId 从 recovery_give_up 关联；sidechain 路径来自 SubagentStop", () => {
    const events = [
      start("s-a"),
      stop("s-a", 10_000, { agent_transcript_path: "/home/u/.sid-code/sessions/p/s-a.jsonl" }),
      giveUp("s-a", 9_000, "auth_suspect", "same_fingerprint"),
    ];
    const summary = buildSubAgentSummary(events)!;

    expect(summary.failed).toBe(1);
    expect(summary.spans[0]).toMatchObject({
      agentId: "s-a",
      status: "error",
      failureFamily: "auth_suspect",
      failureReason: "same_fingerprint",
      transcriptPath: "/home/u/.sid-code/sessions/p/s-a.jsonl",
    });
  });

  test("主循环的 recovery_give_up 不得挂到子代理头上", () => {
    // `recovery_give_up` 的 agentId 是 "main" 时属于主循环。若不过滤，
    // 子代理会被安上一个别人的失败族 —— 那比没有原因更糟（会指错处置方向）。
    const events = [
      start("s-a"),
      stop("s-a", 10_000),
      giveUp("main", 9_000, "auth_suspect", "same_fingerprint"),
    ];
    expect(buildSubAgentSummary(events)!.spans[0].failureFamily).toBeUndefined();
  });

  test("多个子代理各挂各的族（不能用「最近一条放弃」串味）", () => {
    const events = [
      start("s-a"),
      start("s-b", 10),
      giveUp("s-a", 5_000, "transient", "same_fingerprint"),
      giveUp("s-b", 6_000, "auth_suspect", "same_fingerprint"),
      stop("s-a", 10_000),
      stop("s-b", 11_000),
    ];
    const byId = new Map(buildSubAgentSummary(events)!.spans.map((s) => [s.agentId, s]));

    expect(byId.get("s-a")?.failureFamily).toBe("transient");
    expect(byId.get("s-b")?.failureFamily).toBe("auth_suspect");
  });
});

describe("T6：端到端耗时拆 HITL 与非 HITL 两组", () => {
  const turnComplete = (offsetMs: number, elapsedMs: number, extra: Record<string, unknown> = {}) =>
    ev("TurnComplete", at(offsetMs), { elapsed_ms_since_prompt: elapsedMs, ...extra });

  test("had_hitl 的轮不进 no_hitl 组；轮级 hitl_wait_ms 单独合计", () => {
    const events = [
      turnComplete(0, 10_000, { had_hitl: false }),
      turnComplete(1_000, 20_000, { had_hitl: false }),
      // 复现实测形态：唯一一条含 2.85h 人工等待的轮把 P50 拖到 44300.9s
      turnComplete(2_000, 10_250_304, { had_hitl: true, hitl_wait_ms: 10_200_000 }),
    ];
    const m = aggregateSessionMetrics(events, { trajCorrupt: false });

    expect(m.e2e_n).toBe(3);
    expect(m.e2e_hitl_n).toBe(1);
    expect(m.e2e_no_hitl_n).toBe(2);
    // 剔除后的一组不含那个 2.85h 样本 —— 这才是「agent 自身速度」
    expect(m.e2e_no_hitl_p95).toBeLessThanOrEqual(20_000);
    expect(m.turn_hitl_wait_n).toBe(1);
    expect(m.turn_hitl_wait_total_ms).toBe(10_200_000);
  });

  test("没有 HITL 的会话：no_hitl 组等于全部样本，轮级等待为 0", () => {
    const events = [turnComplete(0, 5_000), turnComplete(1_000, 7_000)];
    const m = aggregateSessionMetrics(events, { trajCorrupt: false });

    expect(m.e2e_no_hitl_n).toBe(2);
    expect(m.e2e_hitl_n).toBe(0);
    expect(m.turn_hitl_wait_n).toBe(0);
  });
});

describe("T7：计费缺口与 T2/T3 交叉引用", () => {
  const ref = { id: "s", dir: "/tmp/s", trajPath: "/tmp/s/session.traj", mtimeMs: 0 };
  const baseStats = (over: Partial<ProcessPathologyStats> = {}): ProcessPathologyStats => ({
    pollRatio: 0,
    pollCalls: 0,
    totalCalls: 0,
    pollRatioPathological: false,
    zeroYieldSubagents: 0,
    subagentTotal: 0,
    zeroYieldPathological: false,
    subagentIoPathological: false,
    editLatencyPathological: false,
    maxUnchangedObservationRun: 0,
    observationEntropyPathological: false,
    extraConnections: 0,
    otherChainConnections: 0,
    retryConnections: 0,
    retryWastedPathological: false,
    billableConnections: 3,
    billedRequests: 1,
    billingIdentityBroken: true,
    unbilledConnections: [{ index: 10_001, agentId: "s-a" }],
    ...over,
  });
  const billingOf = (
    over: Partial<ProcessPathologyStats>,
    cross: Parameters<typeof describePathology>[3],
  ) =>
    describePathology(baseStats(over), ref, "/tmp/s/events.jsonl", cross).find(
      (a) => a.kind === "billing_identity_broken",
    )!;

  test("缺口建连与泄漏流同 key → detail 指向 leaky_stream_stall", () => {
    const billing = billingOf(
      {},
      {
        ghostIndexes: new Set(),
        leakyKeys: new Set(["s-a:10001"]),
      },
    );
    expect(billing.detail).toContain("leaky_stream_stall");
  });

  test("缺口建连与幽灵超时同 index → detail 指向 timeout_fired_after_attempt_end", () => {
    // 幽灵超时事件不落 agent_id，所以只能按 index 匹配（如实标注，不声称是同一个 agent）
    const billing = billingOf(
      {},
      {
        ghostIndexes: new Set([10_001]),
        leakyKeys: new Set(),
      },
    );
    expect(billing.detail).toContain("timeout_fired_after_attempt_end");
  });

  test("没有交叉命中时不加任何附注（不制造噪音）", () => {
    const billing = billingOf({}, { ghostIndexes: new Set(), leakyKeys: new Set() });
    expect(billing.detail).not.toContain("leaky_stream_stall");
    expect(billing.detail).not.toContain("timeout_fired_after_attempt_end");
  });
});
