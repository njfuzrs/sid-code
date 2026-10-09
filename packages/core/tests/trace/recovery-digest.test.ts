/**
 * 2026-10-08「一次判死」根治 §4.5：digest 恢复口径。
 *
 * 断言重点是口径不能算错：
 *  1. 无重试 / 放弃事件 → null（区分「没数据」与「零放弃」）
 *  2. one_shot_kill 只数 attempts==1 且原因不在 I1-例外闭集的放弃（deadline 单独报）
 *  3. 救回率分母 = 救回 + 该族放弃，按 (model, agentId) 配对，不跨子代理串
 */
import { describe, it, expect } from "bun:test";
import { aggregateRecoveryStats } from "@sid-code/core/trace/digest.ts";

const rt = (data: Record<string, unknown>) => ({ event: "RetryTelemetry", data });

describe("aggregateRecoveryStats", () => {
  it("无相关事件 → null", () => {
    expect(aggregateRecoveryStats([rt({ type: "stream_completed", model: "m" })])).toBeNull();
  });

  it("one_shot_kill 只数非闭集的 attempts==1；deadline 单独计数", () => {
    const r = aggregateRecoveryStats([
      rt({
        type: "recovery_give_up",
        model: "m",
        attempts: 1,
        giveUpReason: "same_fingerprint",
        family: "auth_suspect",
      }),
      rt({
        type: "recovery_give_up",
        model: "m",
        attempts: 1,
        giveUpReason: "server_declined",
        family: "transient",
      }),
      rt({
        type: "recovery_give_up",
        model: "m",
        attempts: 1,
        giveUpReason: "deadline",
        family: "transient",
      }),
      rt({
        type: "recovery_give_up",
        model: "m",
        attempts: 3,
        giveUpReason: "same_fingerprint",
        family: "auth_suspect",
      }),
    ])!;
    expect(r.giveUps).toBe(4);
    expect(r.oneShotKillCount).toBe(1);
    expect(r.deadlineGiveUpCount).toBe(1);
    expect(r.giveUpReasons).toEqual({ same_fingerprint: 2, server_declined: 1, deadline: 1 });
  });

  it("救回率：retry 后的首个 stream_completed 计救回；按 agentId 隔离", () => {
    const r = aggregateRecoveryStats([
      rt({ type: "retry", model: "m", family: "auth_suspect", agentId: "a1" }),
      rt({ type: "retry", model: "m", family: "transient", agentId: "a2" }),
      rt({ type: "stream_completed", model: "m", agentId: "a1" }),
      rt({
        type: "recovery_give_up",
        model: "m",
        attempts: 3,
        giveUpReason: "budget",
        family: "transient",
        agentId: "a2",
      }),
      rt({ type: "stream_completed", model: "m", agentId: "a1" }), // 没有前置 retry，不计
      rt({ type: "unrecognized_error", model: "m" }),
    ])!;
    expect(r.recoveryByFamily.auth_suspect).toEqual({ entered: 1, recovered: 1, rate: 1 });
    expect(r.recoveryByFamily.transient).toEqual({ entered: 1, recovered: 0, rate: 0 });
    expect(r.unrecognized).toBe(1);
    expect(r.oneShotKillCount).toBe(0);
  });
});
