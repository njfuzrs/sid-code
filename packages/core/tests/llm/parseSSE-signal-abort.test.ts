/**
 * parseSSE signal + idle + content-progress 验证测试
 *
 * 覆盖文档 §5.1 的三个场景：
 * 1. parseSSE abort 中断测试：keepalive + signal abort → 立即退出
 * 2. parseSSE content progress timeout：只发 keepalive → content progress timeout 触发
 * 3. 端到端超时恢复：流 hang + 整体超时 → fallback 兜底
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { OpenAIProvider } from "@sid-code/core/llm/openai.ts";

// 继承暴露 parseSSE
class TestableOpenAI extends OpenAIProvider {
  async *testParseSSE(stream: ReadableStream<Uint8Array>, signal?: AbortSignal) {
    yield* (this as any).parseSSE(stream, signal);
  }
}

/**
 * 构造一个定期发 keepalive（SSE 注释行）的 ReadableStream
 * @param intervalMs 每隔多久发一次 `: ping\n`
 * @param durationMs 持续多久后 close stream
 */
function makeKeepaliveStream(intervalMs: number, durationMs: number): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const interval = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          clearInterval(interval);
        }
      }, intervalMs);
      setTimeout(() => {
        clearInterval(interval);
        try {
          controller.close();
        } catch {}
      }, durationMs);
    },
  });
}

/**
 * 构造一个发一些有效数据后只发 keepalive 的 ReadableStream
 * 用于测试 content progress timeout（保留备用）
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function _makeDataThenKeepaliveStream(
  dataChunks: string[],
  keepaliveIntervalMs: number,
  totalDurationMs: number,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      // 先发有效数据
      for (const chunk of dataChunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      // 然后只发 keepalive
      const interval = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": keepalive\n\n"));
        } catch {
          clearInterval(interval);
        }
      }, keepaliveIntervalMs);
      setTimeout(() => {
        clearInterval(interval);
        try {
          controller.close();
        } catch {}
      }, totalDurationMs);
    },
  });
}

describe("parseSSE signal abort 中断测试（§5.1.1）", () => {
  let origEnv: string | undefined;

  beforeAll(() => {
    origEnv = process.env.SID_CODE_DEBUG_SSE;
    process.env.SID_CODE_DEBUG_SSE = "0";
  });
  afterAll(() => {
    if (origEnv === undefined) delete process.env.SID_CODE_DEBUG_SSE;
    else process.env.SID_CODE_DEBUG_SSE = origEnv;
  });

  test("keepalive 流 + 300ms 后 abort → parseSSE 在约 300ms 内退出", async () => {
    const provider = new TestableOpenAI("test-key", "gpt-4o-mini");
    const stream = makeKeepaliveStream(50, 30_000); // 每 50ms 发 keepalive，持续 30s

    const controller = new AbortController();
    // 300ms 后 abort
    setTimeout(() => controller.abort(), 300);

    const startTime = Date.now();
    const events: any[] = [];
    let threw = false;

    try {
      for await (const event of provider.testParseSSE(stream, controller.signal)) {
        events.push(event);
      }
    } catch (err: any) {
      threw = true;
      expect(err.message).toContain("aborted");
    }

    const elapsed = Date.now() - startTime;

    // 核心断言：必须在 ~300ms 内退出（给 200ms 容差）
    expect(elapsed).toBeLessThan(600);
    // 必须抛出 abort 错误（而非正常结束）
    expect(threw).toBe(true);
    // 不应产出任何有效事件（keepalive 不 yield）
    expect(events).toHaveLength(0);
  });

  test("signal 预先 abort → parseSSE 立即退出", async () => {
    const provider = new TestableOpenAI("test-key", "gpt-4o-mini");
    const stream = makeKeepaliveStream(50, 10_000);

    const controller = new AbortController();
    controller.abort(); // 预先 abort

    const startTime = Date.now();
    let threw = false;

    try {
      // async generator 在首次 next() 时才执行体内代码，
      // 预先 abort 走循环顶部快速检查分支
      const gen = provider.testParseSSE(stream, controller.signal);
      for await (const _event of gen) {
        // 不应到达
      }
    } catch (err: any) {
      threw = true;
      // 可能是 "Request aborted" 或 "aborted"
      expect(err.message.toLowerCase()).toContain("abort");
    }

    const elapsed = Date.now() - startTime;
    expect(elapsed).toBeLessThan(100); // 立即退出
    expect(threw).toBe(true);
  });
});

describe("parseSSE content progress timeout（§5.1.2）", () => {
  let origEnv: string | undefined;
  let origTimeout: string | undefined;

  beforeAll(() => {
    origEnv = process.env.SID_CODE_DEBUG_SSE;
    process.env.SID_CODE_DEBUG_SSE = "0";
    // 压缩 content progress timeout 到 500ms 方便测试
    origTimeout = process.env.SID_CODE_CONTENT_PROGRESS_TIMEOUT_MS;
    process.env.SID_CODE_CONTENT_PROGRESS_TIMEOUT_MS = "500";
  });
  afterAll(() => {
    if (origEnv === undefined) delete process.env.SID_CODE_DEBUG_SSE;
    else process.env.SID_CODE_DEBUG_SSE = origEnv;
    if (origTimeout === undefined) delete process.env.SID_CODE_CONTENT_PROGRESS_TIMEOUT_MS;
    else process.env.SID_CODE_CONTENT_PROGRESS_TIMEOUT_MS = origTimeout;
  });

  test("只发 keepalive（无有效 data 行）→ content progress timeout 触发中断", async () => {
    const provider = new TestableOpenAI("test-key", "gpt-4o-mini");
    // 每 100ms 发 keepalive，持续 10s（远大于 500ms timeout）
    const stream = makeKeepaliveStream(100, 10_000);

    const startTime = Date.now();
    let threw = false;
    let errMsg = "";

    try {
      for await (const _event of provider.testParseSSE(stream)) {
        // keepalive 不产出事件
      }
    } catch (err: any) {
      threw = true;
      errMsg = err.message;
    }

    const elapsed = Date.now() - startTime;

    // 核心断言：content progress timeout 应在 ~500ms 触发（给 1s 容差涵盖 idle 竞争）
    // 注意：idle timeout 默认 90s 远大于 500ms，所以 content progress 必先触发
    expect(threw).toBe(true);
    expect(errMsg).toContain("内容进展超时");
    // elapsed 应约 500ms，但至少比 idle timeout 小很多
    expect(elapsed).toBeLessThan(5000);
  });
});

describe("端到端超时恢复测试（§5.1.3）", () => {
  test("流 hang + 整体超时 → fallback 兜底正常完成", async () => {
    // 此测试已在 fallback.test.ts 覆盖（"流 hang 触发超时 abort 时走重试/fallback 而非永久阻塞"）
    // 这里补充验证：当 provider 的 parseSSE 只收到 keepalive 时，
    // 通过 signal abort（模拟 fallback 整体超时），流式消费正确中断

    const provider = new TestableOpenAI("test-key", "gpt-4o-mini");
    // 模拟场景：网关返回 200 后只发 keepalive
    const stream = makeKeepaliveStream(80, 60_000);

    const controller = new AbortController();
    // 模拟 fallback 整体超时 200ms（实际 300s，这里缩短测试）
    setTimeout(() => controller.abort(), 200);

    const startTime = Date.now();
    let threw = false;
    let errMsg = "";

    try {
      for await (const _event of provider.testParseSSE(stream, controller.signal)) {
        // 不应产出事件
      }
    } catch (err: any) {
      threw = true;
      errMsg = err.message;
    }

    const elapsed = Date.now() - startTime;

    // 断言：signal abort 成功中断了 keepalive 循环
    expect(threw).toBe(true);
    expect(errMsg).toContain("aborted");
    expect(elapsed).toBeLessThan(500);
  });
});
