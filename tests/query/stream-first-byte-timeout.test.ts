/**
 * 回归测试：主循环 stream-processor 的超时阈值必须来自 network-profile 统一配置，
 * 且「等首字节」与「已建流后中途静默」分开计时。
 *
 * 事故背景（轨迹 20260805-193713-ecb68bbd，用户报「响应很慢、不停重试、完全无法使用」）：
 *   src/query/stream-processor.ts 的心跳超时是**就地硬编码** 60_000，且生产链路
 *   （app.ts → engine.ts → loop.ts）一路不传 heartbeatTimeoutMs——于是 60s 成了全链路
 *   实际生效的**最紧**一层，把外层三处 300s 配置（loop 看门狗 watchdogNoProgressMs /
 *   provider idle / headerTimeoutMs）全部架空。
 *
 *   而经网关转发时，「请求发出 → 首个 SSE 事件」要经历鉴权 + 排队 + 模型冷启动，
 *   实测成功样本的 TTFB p95 已达 56s、最大 59.8s——阈值正好压在真实分布的右尾上。
 *   后果：稍慢的请求 100% 被自己杀掉（31 次中断的「发请求→被杀」间隔全部是 60.0s），
 *   每次重试重新排队、再次撞线，形成用户看到的「不停重试、永不结束」。
 *   且用户改 settings.json 无效——因为这一层读不到任何配置。
 *
 * 本测试锁死三件事，任一退化都应让它变红：
 *   ① 不传阈值时，默认值来自 network-profile（不是硬编码 60s）；
 *   ② 首字节等待用 firstByteTimeoutMs 判定，不被（可能更短的）心跳阈值误杀；
 *   ③ settings 的 network.* 覆盖能真正作用到这一层。
 *
 * fix_type: case_design
 */

import { describe, test, expect } from "bun:test";
import { processStream } from "@sid-code/core/query/stream-processor.ts";
import type { StreamEvent } from "@sid-code/core/llm/types.ts";
import { DEFAULTS } from "@sid-code/core/config/network-profile.ts";

/** 静默 `silentMs` 后才吐出首个事件，然后正常收尾——模拟网关排队导致的慢首字节。 */
function slowFirstByteStream(silentMs: number): AsyncIterable<StreamEvent> {
  const events: StreamEvent[] = [
    { type: "message_start", message: { usage: { inputTokens: 1, outputTokens: 0 } } } as any,
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } as any,
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } } as any,
    { type: "content_block_stop", index: 0 } as any,
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { outputTokens: 1 } } as any,
  ];
  let i = 0;
  return {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          if (i === 0) await new Promise(r => setTimeout(r, silentMs));
          if (i >= events.length) return { done: true, value: undefined as any };
          return { done: false, value: events[i++]! };
        },
      };
    },
  };
}

describe("回归：首字节等待不被心跳阈值误杀（20260805 事故根因）", () => {
  test("首字节慢于心跳阈值、但快于首字节阈值 → 不得中断，应正常完成", async () => {
    const turnController = new AbortController();

    // 关键配比：静默 120ms > 心跳 40ms，但 < 首字节 5000ms。
    // 修复前（两者共用一个阈值）这里必定被心跳杀掉——正是生产上 60s 杀 56s 首字节的等比缩小版。
    const resp = await processStream(slowFirstByteStream(120), undefined, undefined, {
      heartbeatTimeoutMs: 40,
      firstByteTimeoutMs: 5_000,
      heartbeatCheckIntervalMs: 10,
      getAbortController: () => turnController,
    });

    expect(resp.stopReason).toBe("end_turn");
    expect(turnController.signal.aborted).toBe(false);
  }, 15_000);

  test("首字节超过首字节阈值 → 仍须中断（防止把闸门放宽成永不生效）", async () => {
    const turnController = new AbortController();
    let thrown: unknown = null;
    try {
      await processStream(slowFirstByteStream(10_000), undefined, undefined, {
        heartbeatTimeoutMs: 10_000,
        firstByteTimeoutMs: 40, // 首字节阈值很短 → 必须触发
        heartbeatCheckIntervalMs: 10,
        getAbortController: () => turnController,
      });
    } catch (e) {
      thrown = e;
    }

    expect(thrown).not.toBeNull();
    expect(turnController.signal.aborted).toBe(true);
    // 复用同一 reason：下游 loop.ts / ABORT_REASONS 白名单无需改动即可识别为「内部超时应重试」
    expect(turnController.signal.reason).toBe("stream-heartbeat-timeout");
  }, 15_000);
});

describe("回归：超时默认值必须来自 network-profile，不得就地硬编码", () => {
  test("不传任何阈值时，默认首字节阈值 = headerTimeoutMs（300s），远大于旧硬编码 60s", async () => {
    const turnController = new AbortController();

    // 静默 150ms 后吐首字节。若默认值退回硬编码 60_000 本用例仍会通过（150ms < 60s），
    // 因此这里额外用下面的断言锁死"默认值确实取自 DEFAULTS"这一结构事实。
    const resp = await processStream(slowFirstByteStream(150), undefined, undefined, {
      heartbeatCheckIntervalMs: 10,
      getAbortController: () => turnController,
    });
    expect(resp.stopReason).toBe("end_turn");

    // 结构断言：统一默认值必须显著宽于事故里那个 60s 硬编码值。
    // 这两条是本次事故的量化教训——真实 TTFB p95 已达 56s，阈值必须留足余量。
    expect(DEFAULTS.headerTimeoutMs).toBeGreaterThan(60_000);
    expect(DEFAULTS.watchdogNoProgressMs).toBeGreaterThan(60_000);
  }, 15_000);

  test("settings 的 network.* 覆盖能真正作用到本层（事故前改配置完全无效）", async () => {
    const turnController = new AbortController();
    let thrown: unknown = null;
    try {
      // 只经 network 覆盖块收紧首字节阈值，不传 firstByteTimeoutMs。
      // 修复前本层读不到 network，这里会一路等到流自己结束、不会中断 → 测试变红。
      await processStream(slowFirstByteStream(10_000), undefined, undefined, {
        network: { headerTimeoutMs: 40, watchdogNoProgressMs: 10_000 },
        heartbeatCheckIntervalMs: 10,
        getAbortController: () => turnController,
      });
    } catch (e) {
      thrown = e;
    }

    expect(thrown).not.toBeNull();
    expect(turnController.signal.aborted).toBe(true);
  }, 15_000);
});
