/**
 * 触发计数聚合（`digest.trigger`）的口径测试
 *
 * 这一节是**消费侧**：单个事件的字段语义已由各自的 telemetry 测试锁住
 * （`hook/hook-executed-telemetry` / `session/rewind-telemetry` /
 * `cron/scheduled-fire-telemetry` / build 侧的 bridge 组），这里锁的是「聚合口径」——
 * 改一个 if 就能让「hook 很快」「定时没延迟」这类结论反向，而生产侧测试一条都不会红。
 *
 * 另外锁一条集成形态：PR #599（远程接管）与 #600（本地触发）曾各自渲染一节同名的
 * 「触发计数」，一个既有 remote 又有本地操作的会话会输出两段同名小节、各只有部分字段。
 * 现在合并成一个结构与一个渲染点（渲染点唯一性由 `trace/trigger-events-wiring` 断言）。
 */
import { describe, it, expect } from "bun:test";
import { aggregateTriggerStats } from "@sid-code/core/trace/digest.ts";
import { HOOK_EXECUTED_EVENT_NAME } from "@sid-code/core/hook/hook-telemetry.ts";
import { REWIND_EVENT_NAME } from "@sid-code/core/session/rewind-telemetry.ts";
import {
  SCHEDULED_FIRE_EVENT_NAME,
  SCHEDULED_INJECT_EVENT_NAME,
} from "@sid-code/core/cron/cron-telemetry.ts";
import {
  BRIDGE_INBOUND_EVENT_NAME,
  BRIDGE_SESSION_EVENT_NAME,
} from "@sid-code/core/bridge/bridge-telemetry.ts";

type Ev = { event?: string; data?: Record<string, unknown> };

const hook = (data: Record<string, unknown>): Ev => ({ event: HOOK_EXECUTED_EVENT_NAME, data });
const rewind = (data: Record<string, unknown>): Ev => ({ event: REWIND_EVENT_NAME, data });
const fire = (data: Record<string, unknown>): Ev => ({ event: SCHEDULED_FIRE_EVENT_NAME, data });
const inject = (data: Record<string, unknown>): Ev => ({
  event: SCHEDULED_INJECT_EVENT_NAME,
  data,
});

describe("aggregateTriggerStats · 整节省略", () => {
  it("没有任何相关事件 → undefined（老会话不出现全 0 节）", () => {
    expect(aggregateTriggerStats([])).toBeUndefined();
    // 无关事件同样不出节：那会把「没被触发过」与「这套埋点没接线」混成同一个数
    expect(
      aggregateTriggerStats([{ event: "PostToolUse", data: { tool_name: "bash" } }]),
    ).toBeUndefined();
  });
});

describe("aggregateTriggerStats · hook", () => {
  it("执行条数与拦截数分开计数（error/timeout 不算拦截）", () => {
    const s = aggregateTriggerStats([
      hook({ outcome: "success", duration_ms: 10 }),
      hook({ outcome: "blocking", duration_ms: 20 }),
      hook({ outcome: "error", duration_ms: 30 }),
    ])!;
    expect(s.hookRuns).toBe(3);
    expect(s.hookBlocks).toBe(1);
  });

  it("p95 样本少于 5 时不给（4 条 → undefined）", () => {
    const evs = Array.from({ length: 4 }, (_, i) =>
      hook({ outcome: "success", duration_ms: i + 1 }),
    );
    expect(aggregateTriggerStats(evs)!.hookP95Ms).toBeUndefined();
  });

  it("p95 在 5 条样本时给出（取排序后 95 分位）", () => {
    const evs = [10, 20, 30, 40, 50].map((ms) => hook({ outcome: "success", duration_ms: ms }));
    expect(aggregateTriggerStats(evs)!.hookP95Ms).toBe(50);
  });

  it("async_started 的 duration 不进 p95（它只是启动耗时）", () => {
    // 4 条 async(1ms) + 1 条同步 900ms：若把 async 混进样本就有 5 条，
    // p95 会被拉到 1ms 附近；正确口径下同步样本只有 1 条 → 不出 p95。
    const evs = [
      ...Array.from({ length: 4 }, () => hook({ outcome: "async_started", duration_ms: 1 })),
      hook({ outcome: "success", duration_ms: 900 }),
    ];
    const s = aggregateTriggerStats(evs)!;
    expect(s.hookRuns).toBe(5); // 执行次数照数，只是不拿它的 duration 算分位
    expect(s.hookP95Ms).toBeUndefined();
  });

  it("同步与 async 共存时，p95 只由同步样本决定", () => {
    const sync = [100, 200, 300, 400, 500].map((ms) =>
      hook({ outcome: "success", duration_ms: ms }),
    );
    const asyncEvs = Array.from({ length: 5 }, () =>
      hook({ outcome: "async_started", duration_ms: 1 }),
    );
    const s = aggregateTriggerStats([...sync, ...asyncEvs])!;
    expect(s.hookRuns).toBe(10);
    expect(s.hookP95Ms).toBe(500);
  });
});

describe("aggregateTriggerStats · 回滚", () => {
  it("按 via 分桶；缺 via 记 unknown（消费侧分桶不会炸）", () => {
    const s = aggregateTriggerStats([
      rewind({ via: "dialog", outcome: "ok" }),
      rewind({ via: "undo", outcome: "ok" }),
      rewind({ via: "undo", outcome: "nothing" }),
      rewind({ outcome: "nothing" }),
    ])!;
    expect(s.rewinds).toEqual({ dialog: 1, undo: 2, unknown: 1 });
  });
});

describe("aggregateTriggerStats · 定时", () => {
  it("fired 与 skipped 分开；skipped 含未授权/认领失败/注入抛错", () => {
    const s = aggregateTriggerStats([
      fire({ outcome: "fired", lag_ms: 10 }),
      fire({ outcome: "fired", lag_ms: 20 }),
      fire({ outcome: "skipped_ungranted", lag_ms: 100 }),
      fire({ outcome: "claim_failed", lag_ms: 200 }),
      fire({ outcome: "fire_error", lag_ms: 300 }),
    ])!;
    expect(s.scheduledFires).toBe(2);
    expect(s.scheduledSkipped).toBe(3);
  });

  it("lag p95 只由 fired 决定（skipped 的 lag 再大也不进样本）", () => {
    const evs = [
      ...Array.from({ length: 5 }, () => fire({ outcome: "fired", lag_ms: 100 })),
      fire({ outcome: "claim_failed", lag_ms: 999_999 }),
    ];
    expect(aggregateTriggerStats(evs)!.scheduledLagP95Ms).toBe(100);
  });

  it("fired 样本少于 5 时不给 lag p95", () => {
    const evs = Array.from({ length: 2 }, () => fire({ outcome: "fired", lag_ms: 5000 }));
    expect(aggregateTriggerStats(evs)!.scheduledLagP95Ms).toBeUndefined();
  });

  it("注入次数照数；排队 p95 只统计 queued=true（未排队的不稀释分位）", () => {
    const evs = [
      ...Array.from({ length: 5 }, () => inject({ queued: true, queue_wait_ms: 60_000 })),
      ...Array.from({ length: 5 }, () => inject({ queued: false, queue_wait_ms: 0 })),
    ];
    const s = aggregateTriggerStats(evs)!;
    expect(s.scheduledInjects).toBe(10);
    expect(s.scheduledQueueWaitP95Ms).toBe(60_000);
  });

  it("queued=true 样本不足 5 时不给排队 p95", () => {
    const evs = [
      inject({ queued: true, queue_wait_ms: 60_000 }),
      inject({ queued: false, queue_wait_ms: 0 }),
    ];
    expect(aggregateTriggerStats(evs)!.scheduledQueueWaitP95Ms).toBeUndefined();
  });
});

describe("aggregateTriggerStats · 远程接管", () => {
  it("连上但没收到消息：仍然出节，bridgeInbound=0（被遥控过的证据）", () => {
    const s = aggregateTriggerStats([{ event: BRIDGE_SESSION_EVENT_NAME, data: {} }])!;
    expect(s).toBeDefined();
    expect(s.bridgeInbound).toBe(0);
  });

  it("只数 kind=user_message（abort / ping 不算入站消息）", () => {
    const evs = [
      { event: BRIDGE_INBOUND_EVENT_NAME, data: { kind: "user_message" } },
      { event: BRIDGE_INBOUND_EVENT_NAME, data: { kind: "user_message" } },
      { event: BRIDGE_INBOUND_EVENT_NAME, data: { kind: "control:abort" } },
      { event: BRIDGE_INBOUND_EVENT_NAME, data: { kind: "control:ping" } },
    ];
    expect(aggregateTriggerStats(evs)!.bridgeInbound).toBe(2);
  });
});
