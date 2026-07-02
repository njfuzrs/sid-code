/**
 * 决定性回归实验：mock SSE 流端到端 —— 从 HTTP 字节 → parseSSE → sendMessageStream
 * → processStream 的完整链路（方案⓪①，deepseek-reasoning-leak 修复）
 *
 * 与 unanswered-end-turn.test.ts（纯函数 detectUnansweredEndTurn）互补：本测试构造真实
 * 的 DeepSeek SSE 字节流，mock 全局 fetch 注入 response.body，验证整条流水线：
 *   (a) 思考漂移进 content 通道（delta.content 走普通文本 + usage 全 0 + finish_reason=stop）
 *       → sendMessageStream 透传 _rawOutputTokensZero=true + estimator 兜底补非零账面
 *       → processStream 经 detectUnansweredEndTurn 判为未答复、text 块转折叠思考块、置位。
 *   (e) 正常经 reasoning_content 通道的思考 + 正常 content 答复 → 不误判为未答复。
 *
 * 这是文档反复强调「判断是否彻底修复」的端到端实验的自动化版本（无需真实 API）。
 *
 * fix_type: case_design
 */

import { describe, test, expect, afterEach } from "bun:test";
import { OpenAIProvider } from "../../src/llm/openai.ts";
import { processStream } from "../../src/query/stream-processor.ts";
import type { SendParams } from "../../src/llm/types.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** 把若干 SSE data 行拼成一个 ReadableStream<Uint8Array>（模拟 DeepSeek 的 chunked SSE） */
function sseStream(chunks: object[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const lines = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`);
  lines.push("data: [DONE]\n\n");
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const l of lines) controller.enqueue(enc.encode(l));
      controller.close();
    },
  });
}

/** mock 全局 fetch，返回一个带 SSE body 的 200 响应 */
function mockFetchWith(chunks: object[]): void {
  globalThis.fetch = (async () =>
    new Response(sseStream(chunks), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })) as unknown as typeof fetch;
}

const params: SendParams = {
  model: "deepseek-v4-pro",
  messages: [{ role: "user", content: [{ type: "text", text: "排查这个 bug" }] }],
  maxTokens: 1024,
};

async function runPipeline(provider: OpenAIProvider) {
  return processStream(provider.sendMessageStream(params));
}

describe("mock SSE 端到端 — 思考漂移进 content 通道（形态 A）", () => {
  test("(a) content 通道超长思考 + finish=stop + usage 全 0 → 端到端判为未答复并折叠", async () => {
    // 构造一大段思考独白，走普通 content 通道（delta.content，而非 reasoning_content）
    const drift = "Let me analyze the error trace once more. Wait, hmm... ".repeat(80); // 数千字符
    const contentChunks = [];
    // 分片吐（模拟真实流式），每片 ~200 字符
    for (let i = 0; i < drift.length; i += 200) {
      contentChunks.push({
        choices: [{ index: 0, delta: { content: drift.slice(i, i + 200) }, finish_reason: null }],
      });
    }
    // 最终 chunk：finish_reason=stop + usage 全 0（DeepSeek 思考泄漏本 case 的硬信号）
    const chunks = [
      ...contentChunks,
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 0, completion_tokens: 0 } },
    ];
    mockFetchWith(chunks);

    const provider = new OpenAIProvider("test-key", "deepseek-v4-pro");
    const resp = await runPipeline(provider);

    // 端到端命中：判为未答复
    expect(resp._unansweredEndTurn).toBe(true);
    // text 块已原地转折叠思考块（不当正文刷屏）
    expect(resp.content.every((b) => b.type === "thinking")).toBe(true);
    expect(resp.content.find((b) => b.type === "text")).toBeUndefined();
    // stop_reason 归一化为 end_turn
    expect(resp.stopReason).toBe("end_turn");
    // 5.1：原始 usage 为 0，但 estimator 已兜底补出非零账面（避免成本黑洞）
    expect(resp.usage.outputTokens).toBeGreaterThan(0);
  });
});

describe("mock SSE 端到端 — 正常路径不误判", () => {
  test("(e) reasoning_content 思考通道 + 正常 content 答复 → 不判未答复", async () => {
    const chunks = [
      // 思考走专用 reasoning_content 通道 → 会被标记为 thinking 块
      { choices: [{ index: 0, delta: { reasoning_content: "先看看报错栈……" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { reasoning_content: "定位到空指针。" }, finish_reason: null }] },
      // 正式答复走 content 通道
      { choices: [{ index: 0, delta: { content: "问题已定位：空指针，修复方式是加判空。" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      // 正常 usage（output 非 0）
      { choices: [], usage: { prompt_tokens: 50, completion_tokens: 18 } },
    ];
    mockFetchWith(chunks);

    const provider = new OpenAIProvider("test-key", "deepseek-v4-pro");
    const resp = await runPipeline(provider);

    // 正常答复：不判未答复
    expect(resp._unansweredEndTurn).toBeUndefined();
    // 思考块折叠 + 正文答复块并存
    expect(resp.content.some((b) => b.type === "thinking")).toBe(true);
    expect(resp.content.some((b) => b.type === "text")).toBe(true);
    // reasoning_content 已存入 _meta 供下轮回传（方案ⓠ数据前提）
    expect((resp._meta as any)?.reasoning_content).toContain("空指针");
  });

  test("(f) content 通道超长思考但 usage 非 0（真答复）→ 不误判", async () => {
    const longAnswer = "这是一段很长但确实是给用户的正式答复内容。".repeat(100);
    const chunks = [
      { choices: [{ index: 0, delta: { content: longAnswer }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 200, completion_tokens: 500 } }, // output 非 0
    ];
    mockFetchWith(chunks);

    const provider = new OpenAIProvider("test-key", "deepseek-v4-pro");
    const resp = await runPipeline(provider);

    expect(resp._unansweredEndTurn).toBeUndefined();
    // 保持正文，不被折叠
    expect(resp.content.some((b) => b.type === "text")).toBe(true);
  });
});
