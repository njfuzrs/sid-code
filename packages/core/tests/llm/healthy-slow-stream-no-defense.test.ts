/**
 * 常驻回归：**健康的慢请求不触发任何一层防线**
 *
 * ## 为什么这条比"卡死能被回收"更重要
 *
 * 已有的超时用例全在证"卡死时防线会开枪"（deepseek-stream-timeout /
 * stream-guard-content-progress / fallback-content-progress-timeout 等），
 * **没有一条**在证"不该开枪时它不开枪"。而这批修复咬人的方式恰恰是后者：
 * 一条持续吐 reasoning 的健康长思考流被 300s 绝对硬顶掐断，已累积内容全部作废。
 *
 * 没有这条对照，下一次有人为了"更快回收僵死连接"把阈值调紧、或把某层的谓词
 * 从"感知进展"改回"绝对计时"，测试全绿 —— 缺陷会以同一形态复发。
 *
 * ## 用真实 provider 路径而不是直接测判据函数
 *
 * 阈值压到毫秒级（env 注入）+ 一条**持续有进展**的 SSE 流，跑完整的
 * `OpenAIProvider.sendMessageStream`。要证的是"端到端不开枪"，
 * 单独测某个判据函数证不了各层接线是否正确。
 *
 * fix_type: case_design
 */

import { describe, test, expect, afterEach } from "bun:test";
import { OpenAIProvider } from "@sid-code/core/llm/openai.ts";
import type { SendParams } from "@sid-code/core/llm/types.ts";

const realFetch = globalThis.fetch;
const ENV_KEYS = [
  "SID_CODE_IDLE_TIMEOUT_MS",
  "SID_CODE_CONTENT_PROGRESS_TIMEOUT_MS",
  "SID_CODE_OPENAI_OVERALL_TIMEOUT_MS",
  "SID_CODE_FETCH_ABSOLUTE_TIMEOUT_MS",
] as const;
const saved: Record<string, string | undefined> = {};

function setEnv(k: string, v: string) {
  saved[k] = process.env[k];
  process.env[k] = v;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
    delete saved[k];
  }
});

const params: SendParams = {
  model: "glm-5.3",
  messages: [{ role: "user", content: [{ type: "text", text: "想一个长一点的问题" }] }],
  maxTokens: 1024,
};

/**
 * 造一条"只吐 reasoning_content、持续有进展、总时长远超单层阈值"的 SSE 流。
 * 这正是 GLM-5.3 长思考的形态：`content` 一直是空的，进展信号全在 reasoning 字段里。
 */
function mockReasoningStream(chunkCount: number, gapMs: number) {
  globalThis.fetch = (async () => {
    const stream = new ReadableStream<Uint8Array>({
      async start(c) {
        const enc = new TextEncoder();
        for (let i = 0; i < chunkCount; i++) {
          c.enqueue(
            enc.encode(
              `data: ${JSON.stringify({
                choices: [{ delta: { reasoning_content: `思考片段${i}` }, index: 0 }],
              })}\n\n`,
            ),
          );
          await new Promise((r) => setTimeout(r, gapMs));
        }
        // 收尾：一个真 content + finish + [DONE]
        c.enqueue(
          enc.encode(
            `data: ${JSON.stringify({
              choices: [{ delta: { content: "结论" }, finish_reason: "stop", index: 0 }],
            })}\n\n`,
          ),
        );
        c.enqueue(enc.encode("data: [DONE]\n\n"));
        c.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as unknown as typeof fetch;
}

describe("常驻回归 — 健康的慢流不被任何一层杀掉", () => {
  test("持续吐 reasoning_content 的长流：总时长远超单层阈值，仍完整读完", async () => {
    // 关键设置：每个 chunk 间隔 10ms（远小于 idle 60ms），但**总时长 300ms
    // 远超 content-progress 的 80ms** —— 若某层退回"绝对计时"，它必然开枪。
    const CHUNKS = 30;
    const GAP_MS = 10;
    setEnv("SID_CODE_IDLE_TIMEOUT_MS", "60");
    setEnv("SID_CODE_CONTENT_PROGRESS_TIMEOUT_MS", "80");
    setEnv("SID_CODE_OPENAI_OVERALL_TIMEOUT_MS", "5000");
    mockReasoningStream(CHUNKS, GAP_MS);

    const provider = new OpenAIProvider("k", "https://example.invalid/v1", "glm-5.3");
    let reasoningDeltas = 0;
    let sawStop = false;
    let errorEvent: string | null = null;
    const t0 = Date.now();
    for await (const ev of provider.sendMessageStream(params)) {
      if ((ev as any).type === "error") errorEvent = (ev as any).error?.message ?? "error";
      if ((ev as any).type === "content_block_delta") reasoningDeltas++;
      if ((ev as any).type === "message_stop") sawStop = true;
    }
    const elapsed = Date.now() - t0;

    // ① 一次都没开枪
    expect(errorEvent).toBeNull();
    // ② 流被完整读完（走到 message_stop），不是中途被截断
    expect(sawStop).toBe(true);
    // ③ 前提确认：这条流确实"慢"—— 总时长超过了 content-progress 阈值。
    //    若这条不成立，用例退化成"测了一条快流"，证不了任何事。
    expect(elapsed).toBeGreaterThan(80);
    // ④ 进展确实是靠 reasoning 维持的（deltas 数量 ≈ chunk 数）
    expect(reasoningDeltas).toBeGreaterThan(CHUNKS / 2);
  });

  test("负向对照：真僵死（零字节到达）仍被 idle 闸门回收", async () => {
    // 这条与上面成对存在：证明"不误杀"不是靠把防线关掉换来的。
    setEnv("SID_CODE_IDLE_TIMEOUT_MS", "80");
    globalThis.fetch = (async () => {
      const stream = new ReadableStream<Uint8Array>({
        start() {
          /* 响应头已到，但一个字节都不来 —— 半开 TCP 的形态 */
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as unknown as typeof fetch;

    const provider = new OpenAIProvider("k", "https://example.invalid/v1", "glm-5.3");
    let err: string | null = null;
    try {
      for await (const ev of provider.sendMessageStream(params)) {
        if ((ev as any).type === "error") err = (ev as any).error?.message ?? "error";
      }
    } catch (e: any) {
      err = e?.message ?? String(e);
    }
    expect(err).not.toBeNull();
    // 归因必须是 idle（说得出是哪一层），不是无 reason 的 TimeoutError。
    expect(err).toContain("空闲超时");
  });
});
