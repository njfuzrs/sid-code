/**
 * PR7 回归：`AbortSignal.timeout` 会掐断一条**一直有进展**的流
 *
 * ## 这条用例存在的理由
 *
 * 它是"`fetchAbsoluteTimeoutMs` 必须默认关闭"这一判断的**唯一实证**。原本它只以
 * 一段 `bun -e` 脚本的形式存在于方案文档 §7② 里 —— 而"绝对硬顶会杀健康流"是个
 * 关于 runtime 语义的事实断言，写在文档里没人会去复算，改回默认开启也不会红。
 *
 * 上一轮排查正是因为这个事实没被钉住，一路判到"修好 fallback 那层就好了"，
 * 方向被带偏整轮：三个闸门里只有 fallback 那层写事件，于是
 * `Counter({'fallback_stream_timeout': 24})` 看起来像铁证。
 *
 * ## 断言的是 runtime 语义，不是我们的代码
 *
 * 所以它**不 import 任何本仓模块**：一旦哪天 Bun 改了 `AbortSignal.timeout` 的
 * 语义（比如改成"仅约束响应头阶段"），这条用例会红 —— 那时该重新评估
 * `fetchAbsoluteTimeoutMs` 的定位，而不是改断言。
 *
 * fix_type: case_design
 */

import { describe, test, expect } from "bun:test";

describe("PR7 — fetch 绝对硬顶会掐断持续有进展的流", () => {
  test("响应头已到 + body 每 200ms 稳定产出 → 仍在硬顶到点时被 abort", async () => {
    const CHUNK_INTERVAL_MS = 20;
    const ABSOLUTE_TIMEOUT_MS = 300; // 等比缩小的 fetchAbsoluteTimeoutMs
    const server = Bun.serve({
      port: 0,
      async fetch() {
        const stream = new ReadableStream({
          async start(c) {
            // 100 个 chunk × 20ms = 2000ms 总时长，远超 300ms 的硬顶。
            // 关键点：每个 chunk 之间只隔 20ms —— 任何**感知进展**的判据都不会开枪。
            for (let i = 0; i < 100; i++) {
              c.enqueue(new TextEncoder().encode(`data: chunk${i}\n\n`));
              await new Promise((r) => setTimeout(r, CHUNK_INTERVAL_MS));
            }
            c.close();
          },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      },
    });

    try {
      const res = await fetch(`http://localhost:${server.port}/`, {
        signal: AbortSignal.timeout(ABSOLUTE_TIMEOUT_MS),
      });
      // 前提条件：响应头确实已经到了。若这里就失败，说明测的不是"流中途被杀"
      // 而是"连不上"，断言无意义。
      expect(res.status).toBe(200);

      const reader = res.body!.getReader();
      let chunks = 0;
      let caught: unknown = null;
      const t0 = Date.now();
      try {
        while (true) {
          const { done } = await reader.read();
          if (done) break;
          chunks++;
        }
      } catch (e) {
        caught = e;
      }
      const elapsed = Date.now() - t0;

      // ① 流没能正常读完 —— 被掐断了。
      expect(caught).not.toBeNull();
      // ② 而且是在硬顶量级上断的，不是流自己结束的（总时长 2000ms >> 300ms）。
      expect(elapsed).toBeLessThan(1500);
      // ③ 断掉之前它**一直在产出** —— 这就是"健康流被误杀"的判据：
      //    抓到过 chunk，说明不是半开连接、不是零字节，任何 idle 判据都不该开枪。
      expect(chunks).toBeGreaterThan(0);
      // ④ 归因形态：runtime 抛的是 name="TimeoutError"，**不带**任何可归因 reason。
      //    这正是它落进 fallback fail-fast 零重试分支的成因（见 llm/errors.ts 的
      //    isRuntimeTimeoutError 注释），也是判据必须用 name 而非消息文本的理由。
      expect((caught as { name?: string }).name).toBe("TimeoutError");
    } finally {
      server.stop(true);
    }
  });
});
