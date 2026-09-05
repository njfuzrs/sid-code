/**
 * SerialBatchUploader 可靠性回归（D9 关停挂起 / D10 无丢弃上限）
 *
 * D9 是缺陷清单里**唯一一条写了探针实测出来的**。这里把那支一次性探针
 * 固化成常驻用例 —— 否则下次有人"简化"掉 flush 的时限，症状会重新变成
 * 「Ctrl+C 后卡一下然后退出」，而那个表象会被 app.ts 的 1.5s 强杀兜底掩盖成
 * 「看起来正常」，退出码 130 还让它像是用户中断。
 */

import { describe, test, expect } from "bun:test";
import { SerialBatchUploader } from "@sid-code/core/bridge/serial-batch-uploader.ts";

/** 竞速：谁先返回。用于断言"有没有在时限内返回"这件事本身。 */
async function race<T>(p: Promise<T>, ms: number, timeoutValue: T): Promise<T> {
  return Promise.race([p, new Promise<T>((r) => setTimeout(() => r(timeoutValue), ms))]);
}

describe("D9 · flush 必须有时限", () => {
  test("断连（postFn 恒抛）时 flush 在时限内返回 false，而不是挂住", async () => {
    const up = new SerialBatchUploader<{ n: number }>({
      postFn: async () => {
        throw new Error("WebSocket 未连接");
      },
      baseDelayMs: 10,
      maxDelayMs: 20,
      // 上限设高，确保这条用例测的是 flush 的时限、不是 D10 的丢弃
      maxConsecutiveFailures: 10_000,
    });

    await up.enqueue([{ n: 1 }]);
    await new Promise((r) => setTimeout(r, 60)); // 让 drain 进入重试循环

    const t0 = Date.now();
    const result = await race(up.flush(300), 2000, "挂住了" as never);
    const elapsed = Date.now() - t0;

    // 修复前这里会拿到 "挂住了"（原实现无条件 while 等到队列空）
    expect(result).toBe(false);
    expect(elapsed).toBeLessThan(1500);
  });

  test("正常情形下 flush 返回 true 且不白等", async () => {
    const up = new SerialBatchUploader<{ n: number }>({ postFn: async () => {} });
    await up.enqueue([{ n: 1 }, { n: 2 }]);
    expect(await up.flush(1000)).toBe(true);
    expect(up.pendingCount).toBe(0);
  });

  test("stop() 后 flush 立即返回 true（队列已被清空，等待无意义）", async () => {
    const up = new SerialBatchUploader<{ n: number }>({
      postFn: async () => {
        throw new Error("断了");
      },
      baseDelayMs: 10,
      maxConsecutiveFailures: 10_000,
    });
    await up.enqueue([{ n: 1 }]);
    await new Promise((r) => setTimeout(r, 40));

    up.stop();
    expect(await race(up.flush(500), 1500, "挂住了" as never)).toBe(true);
  });
});

describe("D10 · 批次丢弃上限与计数", () => {
  test("连续失败超限后丢弃该批，且不再无限重试同一批", async () => {
    let attempts = 0;
    const up = new SerialBatchUploader<{ n: number }>({
      postFn: async () => {
        attempts++;
        throw new Error("下游挂了");
      },
      baseDelayMs: 1,
      maxDelayMs: 2,
      maxConsecutiveFailures: 4,
    });

    await up.enqueue([{ n: 1 }]);
    // 等到足够久 —— 修复前这里 attempts 会一直涨（每 maxDelay 一次，永远）
    await new Promise((r) => setTimeout(r, 200));

    expect(up.droppedBatchCount).toBe(1);
    expect(up.droppedItemCount).toBe(1);
    // 关键：丢弃后停手，不再累加
    const settled = attempts;
    await new Promise((r) => setTimeout(r, 100));
    expect(attempts).toBe(settled);
  });

  test("丢弃一批后继续处理后面的批次（有损但不卡死）", async () => {
    let failNext = true;
    const delivered: number[] = [];
    const up = new SerialBatchUploader<{ n: number }>({
      postFn: async (batch) => {
        if (failNext) throw new Error("第一批坏了");
        delivered.push(...batch.map((b) => b.n));
      },
      baseDelayMs: 1,
      maxDelayMs: 2,
      maxBatchSize: 1,
      maxConsecutiveFailures: 3,
    });

    await up.enqueue([{ n: 1 }]);
    await new Promise((r) => setTimeout(r, 80)); // 第一批被丢
    expect(up.droppedBatchCount).toBe(1);

    failNext = false;
    await up.enqueue([{ n: 2 }]);
    expect(await up.flush(1000)).toBe(true);

    // 后面的消息确实发出去了 —— 修复前它们会永远排在坏批后面
    expect(delivered).toEqual([2]);
  });

  test("stop() 时放弃的消息也计入丢弃（否则「关停丢了多少」答不出来）", async () => {
    const up = new SerialBatchUploader<{ n: number }>({
      postFn: async () => {
        throw new Error("断了");
      },
      baseDelayMs: 50,
      maxConsecutiveFailures: 10_000,
    });
    await up.enqueue([{ n: 1 }, { n: 2 }, { n: 3 }]);
    await new Promise((r) => setTimeout(r, 20));

    up.stop();
    // 计数必须 > 0：没有计数的丢弃是完全不可观测的行为
    expect(up.droppedItemCount).toBeGreaterThan(0);
    expect(up.droppedBatchCount).toBeGreaterThan(0);
  });

  test("成功投递不产生任何丢弃计数（避免计数虚高误导排查）", async () => {
    const up = new SerialBatchUploader<{ n: number }>({ postFn: async () => {} });
    await up.enqueue([{ n: 1 }, { n: 2 }]);
    await up.flush(1000);
    expect(up.droppedBatchCount).toBe(0);
    expect(up.droppedItemCount).toBe(0);
  });

  test("单次失败后成功：失败计数复位，不累积到后续批次", async () => {
    let calls = 0;
    const up = new SerialBatchUploader<{ n: number }>({
      postFn: async () => {
        calls++;
        if (calls === 1) throw new Error("瞬时抖动");
      },
      baseDelayMs: 1,
      maxConsecutiveFailures: 3,
    });
    await up.enqueue([{ n: 1 }]);
    expect(await up.flush(1000)).toBe(true);
    expect(up.droppedBatchCount).toBe(0);
  });
});
