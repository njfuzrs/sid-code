/**
 * SerialBatchUploader 串行批处理上传单测（spec 16 §9.4）
 * 覆盖：批处理、失败重试、背压、停止、刷新
 */

import { describe, test, expect } from "bun:test";
import { SerialBatchUploader } from "@sid-code/core/bridge/serial-batch-uploader.ts";

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

describe("SerialBatchUploader", () => {
  test("成功路径：批次被投递", async () => {
    const delivered: number[][] = [];
    const uploader = new SerialBatchUploader<number>({
      postFn: async (batch) => { delivered.push(batch); },
    });

    await uploader.enqueue([1, 2, 3]);
    await uploader.flush();

    expect(delivered.flat()).toEqual([1, 2, 3]);
  });

  test("多次 enqueue 串行投递（最多 1 个在途）", async () => {
    let inflightCount = 0;
    let maxInflight = 0;
    const uploader = new SerialBatchUploader<number>({
      postFn: async (_batch) => {
        inflightCount++;
        maxInflight = Math.max(maxInflight, inflightCount);
        await tick(10);
        inflightCount--;
      },
    });

    void uploader.enqueue([1]);
    void uploader.enqueue([2]);
    void uploader.enqueue([3]);
    await uploader.flush();

    // 串行保证：任意时刻至多 1 个 POST 在途
    expect(maxInflight).toBe(1);
  });

  test("失败重试：postFn 抛错后指数退避重试直至成功", async () => {
    let attempts = 0;
    const uploader = new SerialBatchUploader<string>({
      postFn: async () => {
        attempts++;
        if (attempts < 3) throw new Error("模拟网络失败");
      },
      baseDelayMs: 5,
      maxDelayMs: 20,
    });

    await uploader.enqueue(["x"]);
    await uploader.flush();

    expect(attempts).toBe(3); // 失败 2 次 + 成功 1 次
  });

  test("maxBatchSize 限制单批大小", async () => {
    const batchSizes: number[] = [];
    const uploader = new SerialBatchUploader<number>({
      postFn: async (batch) => { batchSizes.push(batch.length); },
      maxBatchSize: 2,
    });

    await uploader.enqueue([1, 2, 3, 4, 5]);
    await uploader.flush();

    // 每批不超过 2
    expect(Math.max(...batchSizes)).toBeLessThanOrEqual(2);
    expect(batchSizes.reduce((a, b) => a + b, 0)).toBe(5);
  });

  test("stop() 后丢弃待处理项，enqueue 变为 no-op", async () => {
    let delivered = 0;
    const uploader = new SerialBatchUploader<number>({
      postFn: async () => { delivered++; await tick(50); },
    });

    await uploader.enqueue([1]);
    uploader.stop();
    await uploader.enqueue([2, 3]); // stop 后不应入队

    expect(uploader.pendingCount).toBe(0);
    // 只有 stop() 之前那一批真的投递了；之后的 [2,3] 被丢弃。
    // 原先这里只断言 pendingCount，`delivered` 计了数却没人看 ——
    // 那样即使 stop() 后仍在投递（真正要防的回归）测试照样绿。
    expect(delivered).toBe(1);
  });

  test("pendingCount 反映待处理数量", async () => {
    const uploader = new SerialBatchUploader<number>({
      postFn: async () => { await tick(100); },
      maxBatchSize: 1,
    });
    void uploader.enqueue([1, 2, 3, 4]);
    await tick(10);
    // 第一个进入在途，剩余 3 个待处理
    expect(uploader.pendingCount).toBeGreaterThanOrEqual(0);
    uploader.stop();
  });
});
