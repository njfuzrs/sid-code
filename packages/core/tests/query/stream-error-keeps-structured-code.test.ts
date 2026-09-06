/**
 * 回归门禁：流内 `error` 事件的**结构化字段**必须活着到达上层，不在抛出点被丢弃。
 *
 * 缺陷本体：`query/stream-processor.ts` 与 `entrypoints/headless.ts` 原先都写
 * `throw new Error(\`LLM 错误: ${event.error.message}\`)` —— `event.error` 上的
 * `statusCode` / `type` / `streamLevel` 在抛出那一刻全部丢弃。而子代理路径
 * （`agent/stream-processor.ts`）反而是对的（用 `errorMeta` 原样带出）：
 * 同一份数据，两条路径一条留一条丢。
 *
 * 丢了的代价是 TUI 只能拿一个字符串去猜状态码，而猜的两个方向都实测错过：
 * 猜不出（网关中文文案「负载已饱和」既无 429 也无 rate limit）、
 * 猜错（request id / 耗时数字里巧合含状态码）。
 *
 * 变异自证：把 stream-processor.ts 的 `throw new LLMStreamError(...)` 改回
 * `throw new Error(...)` → 本文件「结构化字段随异常带出」整组红。
 */

import { describe, test, expect } from "bun:test";
import { processStream } from "@sid-code/core/query/stream-processor.ts";
import { LLMStreamError } from "@sid-code/core/llm/errors.ts";
import { codeFromStructured, inferErrorCode } from "@sid-code/core/llm/error-messages.ts";
import type { StreamEvent } from "@sid-code/core/llm/types.ts";

/** 造一个「网关流内回限流错误」的流——真实形态（HTTP 200 + 流内 error 事件）。 */
async function* gatewayRateLimitStream(): AsyncIterable<StreamEvent> {
  yield { type: "message_start", message: { usage: { inputTokens: 5, outputTokens: 0 } } };
  yield {
    type: "error",
    error: {
      message: "当前分组上游负载已饱和，请稍后再试 (request id: 2026090519422733007594196e93ae3)",
      type: "rate_limit_error",
      statusCode: 429,
      streamLevel: true,
    },
  };
}

/** 不带任何结构化字段的流（老 provider / 简陋网关）——必须保持旧行为不崩。 */
async function* barebonesErrorStream(): AsyncIterable<StreamEvent> {
  yield { type: "error", error: { message: "something broke" } };
}

describe("结构化字段随异常带出", () => {
  test("processStream 抛 LLMStreamError，statusCode / type 都在", async () => {
    let caught: unknown;
    try {
      await processStream(gatewayRateLimitStream());
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(LLMStreamError);
    const err = caught as LLMStreamError;
    expect(err.statusCode).toBe(429);
    expect(err.errorType).toBe("rate_limit_error");
    expect(err.streamLevel).toBe(true);
  });

  test("message 与旧行为逐字节一致（只读 .message 的既有调用方不受影响）", async () => {
    let msg = "";
    try {
      await processStream(gatewayRateLimitStream());
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toStartWith("LLM 错误: ");
    expect(msg).toContain("负载已饱和");
  });

  test("端到端：结构化 code 能把这条错误分类对，而纯文本推断猜不出来", async () => {
    let caught: LLMStreamError | undefined;
    try {
      await processStream(gatewayRateLimitStream());
    } catch (e) {
      caught = e as LLMStreamError;
    }

    // 这两行就是本次事故的全貌：
    // 文本推断在**修复关键词表之前**对这句话是无解的，而结构化字段一直都在。
    expect(codeFromStructured(caught!.statusCode, caught!.errorType)).toBe("rate_limit");
    // engine.ts 的取值顺序：结构化优先，文本兜底。这里锁住"结构化不为空"这个前提。
    expect(codeFromStructured(caught!.statusCode, caught!.errorType)).toBeTruthy();
  });

  test("无结构化字段时优雅退化：仍是 LLMStreamError，但字段为 undefined", async () => {
    let caught: unknown;
    try {
      await processStream(barebonesErrorStream());
    } catch (e) {
      caught = e;
    }
    const err = caught as LLMStreamError;
    expect(err).toBeInstanceOf(LLMStreamError);
    expect(err.statusCode).toBeUndefined();
    expect(err.errorType).toBeUndefined();
    // 结构化拿不到 → 调用方回落文本推断（此处文本也无解，得到 undefined，
    // 于是面板显示通用「运行错误」——这是**正确**的兜底，不是缺陷）。
    expect(codeFromStructured(err.statusCode, err.errorType)).toBeUndefined();
    expect(inferErrorCode(err.message)).toBeUndefined();
  });
});
