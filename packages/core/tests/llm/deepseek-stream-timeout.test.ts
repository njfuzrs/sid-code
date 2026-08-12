/**
 * 5.4 回归：DeepSeek 长思考场景两道流超时确实挂载并在 600s 看门狗之前生效
 * （deepseek-reasoning-leak 修复 5.4）
 *
 * 背景：例② 第35轮 / 例③ idx=7 触发 600s ModelCallUnpaired 真 hang。文档质疑
 * IDLE_TIMEOUT_MS（DeepSeek 180s）与 CONTENT_PROGRESS_TIMEOUT_MS（DeepSeek 300s）
 * 两道主动防线是否真的生效——若生效，流应在 180/300s（远早于 600s 看门狗）被中断自愈。
 *
 * 本测试用环境变量把两道超时压到毫秒级 + mock fetch 造两种 hang，证明：
 *   (1) IDLE：response.body 出了头但一个 chunk 都不来 → SID_CODE_IDLE_TIMEOUT_MS 触发；
 *   (2) CONTENT_PROGRESS：持续吐"空进展"chunk（TCP keep-alive 但无有效内容）
 *       → SID_CODE_CONTENT_PROGRESS_TIMEOUT_MS 触发。
 * 两者都应抛"超时"错误（被 fallback isTimeoutError 归类 → 重试/降级），而非永久挂死。
 *
 * fix_type: case_design
 */

import { describe, test, expect, afterEach } from "bun:test";
import { OpenAIProvider } from "@sid-code/core/llm/openai.ts";
import type { SendParams } from "@sid-code/core/llm/types.ts";

const realFetch = globalThis.fetch;
const ENV_KEYS = ["SID_CODE_IDLE_TIMEOUT_MS", "SID_CODE_CONTENT_PROGRESS_TIMEOUT_MS"] as const;
const savedEnv: Record<string, string | undefined> = {};

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
    delete savedEnv[k];
  }
});

function setEnv(k: string, v: string) {
  savedEnv[k] = process.env[k];
  process.env[k] = v;
}

const params: SendParams = {
  model: "deepseek-v4-pro",
  messages: [{ role: "user", content: [{ type: "text", text: "排查这个 bug" }] }],
  maxTokens: 1024,
};

/** 收集 sendMessageStream 抛出的错误（或 error 事件） */
async function drainForError(provider: OpenAIProvider): Promise<string | null> {
  try {
    for await (const ev of provider.sendMessageStream(params)) {
      if ((ev as any).type === "error") {
        return (ev as any).error?.message ?? "error event";
      }
    }
    return null;
  } catch (e: any) {
    return e?.message ?? String(e);
  }
}

describe("5.4 — DeepSeek 流超时防线在 600s 看门狗前生效", () => {
  test("(1) IDLE：response.body 出头但无任何 chunk → 空闲超时中断（不挂死）", async () => {
    setEnv("SID_CODE_IDLE_TIMEOUT_MS", "150"); // 150ms 快速触发

    // body 永不产出任何 chunk，也不 close（模拟半开 TCP：头到了、数据不来）
    const hangingBody = new ReadableStream<Uint8Array>({
      start() {
        /* 既不 enqueue 也不 close：reader.read() 永不 settle */
      },
    });
    globalThis.fetch = (async () =>
      new Response(hangingBody, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })) as any;

    const provider = new OpenAIProvider("test-key", "deepseek-v4-pro");
    const start = Date.now();
    const errMsg = await drainForError(provider);
    const elapsed = Date.now() - start;

    expect(errMsg).not.toBeNull();
    expect(/空闲超时|超时|timeout/i.test(errMsg!)).toBe(true);
    // 远早于 600s 看门狗（给足 CI 抖动余量，仍 << 600_000）
    expect(elapsed).toBeLessThan(5_000);
  });

  test("(2) CONTENT_PROGRESS：持续吐空进展 chunk（keep-alive）→ 内容进展超时中断", async () => {
    setEnv("SID_CODE_CONTENT_PROGRESS_TIMEOUT_MS", "200"); // 200ms 快速触发
    setEnv("SID_CODE_IDLE_TIMEOUT_MS", "5000"); // idle 放大，确保命中的是 content-progress 而非 idle

    const enc = new TextEncoder();
    // 每 20ms 吐一个 SSE 注释行（": ping"）——TCP 层持续 settle，但无任何有效内容进展。
    // 这正是 content progress timeout 要区分的"假活"场景。
    let closed = false;
    const keepAliveBody = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (closed) return;
        await new Promise((r) => setTimeout(r, 20));
        controller.enqueue(enc.encode(": ping\n\n"));
      },
      cancel() {
        closed = true;
      },
    });
    globalThis.fetch = (async () =>
      new Response(keepAliveBody, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })) as any;

    const provider = new OpenAIProvider("test-key", "deepseek-v4-pro");
    const start = Date.now();
    const errMsg = await drainForError(provider);
    const elapsed = Date.now() - start;

    expect(errMsg).not.toBeNull();
    expect(/内容进展超时|超时|timeout/i.test(errMsg!)).toBe(true);
    expect(elapsed).toBeLessThan(5_000);
  });
});
