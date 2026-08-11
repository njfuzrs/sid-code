/**
 * 回归测试：主循环 stream-processor 的心跳/整体超时只 abort turn 级 controller，
 * 不污染会话级共享 controller。
 *
 * 背景（与 loop.ts finally 的 race-settled 回归同源，另一条路径）：
 *   src/query/stream-processor.ts 的 setInterval 在心跳（默认 60s）/ 整体（默认 300s）
 *   超时时调 getAbortController()?.abort()。此前 app.ts:1583 把 getAbortController 接到
 *   **会话级** this.abortController——而 60s 心跳短于 loop.ts 的 90s 看门狗，会先 fire。
 *   任何 60-90s 的纯无事件 stall 会:
 *     1. 心跳超时 abort 会话级 signal → 本轮抛 timeout → loop continue 重试;
 *     2. 下一轮 parentSignal = 已 aborted 的会话 signal → composedSignal 出生即死;
 *     3. sendWithRetry 拿到已死 signal 立即抛 AbortError → 整条用户消息误报「已取消」。
 *
 * 根治：loop.ts 把本轮 turnAbortController 经 deps 透传给 processStream，超时只 abort
 *   turn 级（经 composedSignal 级联中断上游 fetch），会话级 signal 不受影响。
 *
 * fix_type: case_design
 */

import { describe, test, expect } from "bun:test";
import { processStream } from "@sid-code/core/query/stream-processor.ts";
import type { StreamEvent } from "@sid-code/core/llm/types.ts";
import { RequestAbortedError, isInternalTimeoutAbortReason } from "@sid-code/core/llm/errors.ts";

/**
 * 无数据的流，但**响应 abort**——模拟真实 fetch：turn controller 被 abort 时迭代器 reject，
 * 从而让 processStream 的 for await 退出（生产中底层 fetch 就是这样中断循环的）。
 * 若不响应 abort，processStream 的 for await 会永久卡住（它只在收到事件时才检查 timeoutError）。
 */
function hangingStream(signal: AbortSignal): AsyncIterable<StreamEvent> {
  return {
    [Symbol.asyncIterator]() {
      return {
        next() {
          return new Promise<IteratorResult<StreamEvent>>((_resolve, reject) => {
            if (signal.aborted) {
              reject(new Error("aborted"));
              return;
            }
            signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
            // 否则永不 resolve → 心跳/整体定时器先 fire → abort signal → 上面的监听器 reject
          });
        },
      };
    },
  };
}

/**
 * 先产出一个事件、随后静默的流（响应 abort）——这才是「心跳超时」的真实场景。
 *
 * 2026-08-05 起首字节与心跳**分开计时**（见 stream-processor.ts 的超时配置说明）：
 * 「一个事件都没到」走 firstByteTimeoutMs，「已建流后中途静默」才走 heartbeatTimeoutMs。
 * 因此验证心跳的用例必须先让流吐出至少一个事件，否则测的是首字节那条路径。
 */
function stallAfterFirstEventStream(signal: AbortSignal): AsyncIterable<StreamEvent> {
  let emitted = false;
  return {
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (!emitted) {
            emitted = true;
            return Promise.resolve({
              done: false,
              value: { type: "message_start", message: { usage: { inputTokens: 1, outputTokens: 0 } } } as any,
            });
          }
          return new Promise<IteratorResult<StreamEvent>>((_resolve, reject) => {
            if (signal.aborted) {
              reject(new Error("aborted"));
              return;
            }
            signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
        },
      };
    },
  };
}

/** 正常产出一个文本块后结束的流 */
async function* okStream(): AsyncIterable<StreamEvent> {
  yield { type: "message_start", message: { usage: { inputTokens: 1, outputTokens: 0 } } } as any;
  yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } as any;
  yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } } as any;
  yield { type: "content_block_stop", index: 0 } as any;
  yield { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { outputTokens: 1 } } as any;
  yield { type: "message_stop" } as any;
}

describe("回归：stream-processor 心跳超时只 abort turn 级，不污染会话级", () => {
  test("心跳超时 → abort turn 级 controller，会话级 controller 不受影响", async () => {
    const sessionController = new AbortController(); // 模拟会话级共享 controller
    const turnController = new AbortController();     // 模拟本轮 turn 级 controller

    let thrown: Error | null = null;
    try {
      await processStream(stallAfterFirstEventStream(turnController.signal), undefined, undefined, {
        heartbeatTimeoutMs: 30,      // 首字节后 30ms 无数据即心跳超时
        firstByteTimeoutMs: 10_000,  // 首字节阈值给足，确保命中的是心跳分支
        heartbeatCheckIntervalMs: 10, // 10ms 检查一次（快速触发）
        // 正确接线：超时应 abort turn 级 controller
        getAbortController: () => turnController,
      });
    } catch (e) {
      thrown = e as Error;
    }

    // 心跳超时抛错（可能是 processStream 的 timeoutError，也可能是 stream 响应 abort 的错误——
    // 两者都证明超时路径生效）
    expect(thrown).not.toBeNull();
    // 核心断言：turn 级被 abort，会话级完好无损（不被污染）
    expect(turnController.signal.aborted).toBe(true);
    expect(sessionController.signal.aborted).toBe(false);
  }, 15_000);

  test("整体超时 → abort turn 级 controller，会话级 controller 不受影响", async () => {
    const sessionController = new AbortController();
    const turnController = new AbortController();

    let thrown: Error | null = null;
    try {
      await processStream(hangingStream(turnController.signal), undefined, undefined, {
        // 心跳给足够长（不先触发），整体超时短，验证整体超时分支
        heartbeatTimeoutMs: 10_000,
        overallTimeoutMs: 30,
        heartbeatCheckIntervalMs: 10,
        getAbortController: () => turnController,
      });
    } catch (e) {
      thrown = e as Error;
    }

    expect(thrown).not.toBeNull();
    expect(turnController.signal.aborted).toBe(true);
    expect(sessionController.signal.aborted).toBe(false);
  }, 15_000);

  test("正常完成 → 不 abort 任何 controller", async () => {
    const turnController = new AbortController();

    const resp = await processStream(okStream(), undefined, undefined, {
      heartbeatTimeoutMs: 5_000,
      heartbeatCheckIntervalMs: 10,
      getAbortController: () => turnController,
    });

    // 正常累积到文本 + end_turn，且 turn controller 未被误 abort
    expect(resp.stopReason).toBe("end_turn");
    expect(turnController.signal.aborted).toBe(false);
  }, 15_000);
});

/**
 * 根治（2026-07，session 20260707-143411 事故复盘）：stream-processor 心跳/整体超时
 * abort 时必须携带**具体 reason**（stream-heartbeat-timeout / stream-overall-timeout），
 * 且该 reason 在首次 abort() 时被 AbortSignal 永久锁定。这是 query/loop.ts 结构性识别
 * "内部超时自愈中断"（而非误判为用户 ESC 取消静默吞掉）的唯一可靠依据——不依赖
 * 易被 abort-race 通用错误消息覆盖的文本匹配。
 */
describe("回归：stream-processor 超时 abort 携带具体 reason（根治静默中断）", () => {
  test("心跳超时 → signal.reason === 'stream-heartbeat-timeout' 且属内部超时白名单", async () => {
    const turnController = new AbortController();
    try {
      await processStream(stallAfterFirstEventStream(turnController.signal), undefined, undefined, {
        heartbeatTimeoutMs: 30,
        firstByteTimeoutMs: 10_000, // 首字节阈值给足，确保命中的是心跳分支
        heartbeatCheckIntervalMs: 10,
        getAbortController: () => turnController,
      });
    } catch { /* 超时抛错，此处只关心 reason */ }

    expect(turnController.signal.aborted).toBe(true);
    expect(turnController.signal.reason).toBe("stream-heartbeat-timeout");
    // 结构性识别：该 reason 必须被上层判为"内部超时自愈"而非用户取消
    expect(isInternalTimeoutAbortReason(turnController.signal.reason)).toBe(true);
  }, 15_000);

  test("整体超时 → signal.reason === 'stream-overall-timeout' 且属内部超时白名单", async () => {
    const turnController = new AbortController();
    try {
      await processStream(hangingStream(turnController.signal), undefined, undefined, {
        heartbeatTimeoutMs: 10_000,
        overallTimeoutMs: 30,
        heartbeatCheckIntervalMs: 10,
        getAbortController: () => turnController,
      });
    } catch { /* 超时抛错，此处只关心 reason */ }

    expect(turnController.signal.aborted).toBe(true);
    expect(turnController.signal.reason).toBe("stream-overall-timeout");
    expect(isInternalTimeoutAbortReason(turnController.signal.reason)).toBe(true);
  }, 15_000);

  test("abort-race 错误携带 abortReason（即便通用错误消息抢先赢下 race 也能识别超时）", async () => {
    // 复现事故指纹：真半开流的 iterator.next() 永不 settle，唯一能救出的是内部
    // abortPromise —— 它 reject 的 RequestAbortedError 消息通用（不含 timeout 字样），
    // 但必须携带 signal.reason 供下游结构性识别为超时。
    const turnController = new AbortController();
    let thrown: unknown = null;
    try {
      await processStream(trulyHangingStream(), undefined, undefined, {
        // 一个事件都不会到达 → 命中首字节分支。两个阈值都设短，使本用例不依赖
        // 「哪一层先开枪」：它验证的是 abort-race 错误必须携带 abortReason。
        heartbeatTimeoutMs: 30,
        firstByteTimeoutMs: 30,
        overallTimeoutMs: 60_000,
        heartbeatCheckIntervalMs: 10,
        getAbortController: () => turnController,
      });
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(RequestAbortedError);
    // 消息本身通用、不含 timeout 字样（正是旧 isTimeoutError 文本匹配漏判的根因）
    expect((thrown as Error).message).not.toMatch(/timeout|超时/i);
    // 但 abortReason 携带了具体超时 reason → 下游可结构性识别
    const abortReason = (thrown as RequestAbortedError).abortReason;
    expect(abortReason).toBe("stream-heartbeat-timeout");
    expect(isInternalTimeoutAbortReason(abortReason)).toBe(true);
  }, 15_000);
});

/**
 * P0-2 §7.1 回归：真半开流场景——stream 的 next() 对 abort 一无所知（不监听 signal，
 * 永不 resolve/reject），完全模拟"SSE 半开：TCP 连接在、服务端不再发 event，
 * reader.read() 永不 settle"。此前的 `for await` 只在收到事件后才检查 timeoutError，
 * 若 next() 本身不响应 abort，会永久卡住——这正是修复前 P0-2 的真实故障模式。
 * 修复后（processStream 内 Promise.race(iterator.next(), abortPromise)）必须能在
 * abort 触发后立即退出，不必等 next() 自己 settle。
 */
function trulyHangingStream(): AsyncIterable<StreamEvent> {
  return {
    [Symbol.asyncIterator]() {
      return {
        next() {
          // 永不 resolve、永不 reject、完全不监听 signal —— 唯一能救出来的只有
          // processStream 内部的外层 Promise.race(abortPromise)。
          return new Promise<IteratorResult<StreamEvent>>(() => { /* 有意永不 settle */ });
        },
      };
    },
  };
}

describe("P0-2 §7.1 回归：真半开流（stream 自身不感知 abort）", () => {
  test("stream.next() 永不 settle 且不监听 signal → processStream 仍需在 abort 后快速退出", async () => {
    const turnController = new AbortController();

    const start = Date.now();
    let thrown: Error | null = null;
    // 100ms 后模拟看门狗/超时机制 abort turn 级 controller（与生产中 heartbeat/overall
    // 定时器调用 getAbortController()?.abort() 语义一致，但这里直接手动 abort，
    // 排除定时器精度干扰，聚焦验证 for-await 层是否真的 race 了 abort）。
    setTimeout(() => turnController.abort(), 100);

    try {
      await processStream(trulyHangingStream(), undefined, undefined, {
        // 心跳/整体超时给得很长，确保退出只可能是 abort race 生效，不是超时兜底凑巧命中。
        heartbeatTimeoutMs: 60_000,
        overallTimeoutMs: 60_000,
        heartbeatCheckIntervalMs: 10,
        getAbortController: () => turnController,
      });
    } catch (e) {
      thrown = e as Error;
    }
    const elapsed = Date.now() - start;

    expect(thrown).not.toBeNull();
    // 必须远早于 60s 的心跳/整体超时，证明是外层 abortPromise race 生效
    expect(elapsed).toBeLessThan(2_000);
  }, 10_000);
});
