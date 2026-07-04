/**
 * VCR（录制/回放）框架 — tests/llm/vcr/vcr.ts（T8.13）
 *
 * § 定位
 * 对标 Ruby VCR / Python vcrpy / Nock：把 provider 与真实 API 之间的 HTTP 交互序列化为
 * JSON fixture，回放时从 fixture 还原 response stream（含 timing 模拟），让流解析逻辑的
 * 任何退化都能被离线、确定性地检测——无需真实网络、无需 API key、无成本。
 *
 * § 为什么需要
 * 最近 4 次 provider 生产事故都是"生产中发现而非测试提前捕获"。单测覆盖了协议转换，
 * 但缺少"从真实字节流还原 → 验证解析结果"这一层（L3）。VCR 填补此空白：
 * 录制一次真实/构造的 SSE 字节序列，之后永久回放。
 *
 * § fixture 格式（tests/fixtures/vcr/{provider}-{scenario}.json）
 * {
 *   "provider": "openai" | "anthropic",
 *   "scenario": "normal-stream",
 *   "request": { "model": "...", "url": "..." },       // 录制时的请求快照（诊断用）
 *   "response": {
 *     "status": 200,
 *     "headers": { "content-type": "text/event-stream" },
 *     "chunks": [                                        // 按到达顺序的 SSE 字节块
 *       { "data": "data: {...}\n\n", "delayMs": 0 },     // data = 原始 SSE 文本；delayMs = 相对上一块的间隔
 *       ...
 *     ]
 *   }
 * }
 *
 * § 两种消费方式
 * - `installFetchFromFixture(fixture)`：替换 globalThis.fetch，返回一个 body 为 ReadableStream
 *   的 Response，按 chunks 的 delayMs 逐块 enqueue（回放 openai/fetch 路径）。
 * - `loadFixture(provider, scenario)`：从磁盘读取 fixture JSON。
 * - `buildSseBytes(chunks)`：把 chunk 列表拼成完整字节流（供不走 fetch 的场景直接喂）。
 *
 * § timing
 * delayMs 支持"确定性快放"：设 `timeScale: 0` 可零延迟回放（单测默认，避免慢），
 * 设 `timeScale: 1` 按录制的真实间隔回放（timing 敏感的 stall/idle 测试用）。
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/** VCR fixture 中单个 SSE 字节块 */
export interface VcrChunk {
  /** 原始 SSE 文本（含 `data: ` 前缀与结尾的 `\n\n`） */
  data: string;
  /** 相对上一块的到达间隔（毫秒）。第一块通常为 0。 */
  delayMs?: number;
}

/** VCR fixture 完整结构 */
export interface VcrFixture {
  provider: string;
  scenario: string;
  request?: {
    model?: string;
    url?: string;
    [k: string]: unknown;
  };
  response: {
    status: number;
    headers?: Record<string, string>;
    /** SSE 字节块序列（流式）。与 body 二选一。 */
    chunks?: VcrChunk[];
    /** 非流式 body（JSON 字符串）。与 chunks 二选一。 */
    body?: string;
  };
}

/** fixture 根目录（本文件在 tests/llm/vcr/，fixture 在 tests/fixtures/vcr/） */
const FIXTURE_DIR = join(import.meta.dir, "..", "..", "fixtures", "vcr");

/** fixture 文件路径 */
export function fixturePath(provider: string, scenario: string): string {
  return join(FIXTURE_DIR, `${provider}-${scenario}.json`);
}

/** 从磁盘加载 fixture（不存在则抛错，提示先录制） */
export function loadFixture(provider: string, scenario: string): VcrFixture {
  const p = fixturePath(provider, scenario);
  if (!existsSync(p)) {
    throw new Error(`VCR fixture 不存在: ${p}（请先用 record-vcr.ts 录制，或手工构造）`);
  }
  return JSON.parse(readFileSync(p, "utf-8")) as VcrFixture;
}

/** 保存 fixture 到磁盘（录制模式用） */
export function saveFixture(fixture: VcrFixture): string {
  const p = fixturePath(fixture.provider, fixture.scenario);
  writeFileSync(p, JSON.stringify(fixture, null, 2) + "\n", "utf-8");
  return p;
}

/**
 * 把 chunk 列表拼成一个 ReadableStream<Uint8Array>，按 delayMs 逐块 enqueue。
 * @param timeScale 时间缩放：0 = 零延迟快放（默认），1 = 按录制间隔真实回放
 */
export function buildReplayStream(
  chunks: VcrChunk[],
  timeScale = 0,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let idx = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (idx >= chunks.length) {
        controller.close();
        return;
      }
      const chunk = chunks[idx++]!;
      const delay = (chunk.delayMs ?? 0) * timeScale;
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      controller.enqueue(encoder.encode(chunk.data));
      if (idx >= chunks.length) controller.close();
    },
  });
}

/** 把 chunk 列表拼成完整字节串（供直接喂给 parseSSE 的场景） */
export function buildSseBytes(chunks: VcrChunk[]): Uint8Array {
  const encoder = new TextEncoder();
  return encoder.encode(chunks.map((c) => c.data).join(""));
}

/**
 * 用 fixture 替换 globalThis.fetch，返回一个还原函数。
 * fetch 被调用时返回 body 为回放流的 Response（回放 openai/fetch 路径）。
 *
 * ```ts
 * const restore = installFetchFromFixture(loadFixture("openai", "normal-stream"));
 * try { ...consume provider... } finally { restore(); }
 * ```
 */
export function installFetchFromFixture(
  fixture: VcrFixture,
  opts: { timeScale?: number } = {},
): () => void {
  const realFetch = globalThis.fetch;
  const { status, headers = {}, chunks, body } = fixture.response;

  globalThis.fetch = (async () => {
    if (chunks) {
      const stream = buildReplayStream(chunks, opts.timeScale ?? 0);
      return new Response(stream, {
        status,
        headers: { "content-type": "text/event-stream", ...headers },
      });
    }
    return new Response(body ?? "", {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
  }) as unknown as typeof globalThis.fetch;

  return () => {
    globalThis.fetch = realFetch;
  };
}

/**
 * 便捷构造器：把一组 OpenAI SSE JSON 事件对象转为 VcrChunk[]（每个对象一块 + 结尾 [DONE]）。
 * 用于手工构造 fixture（无需真实 API 录制）。
 */
export function openaiChunksFromEvents(
  events: Record<string, unknown>[],
  perChunkDelayMs = 0,
): VcrChunk[] {
  const chunks: VcrChunk[] = events.map((e, i) => ({
    data: `data: ${JSON.stringify(e)}\n\n`,
    delayMs: i === 0 ? 0 : perChunkDelayMs,
  }));
  chunks.push({ data: "data: [DONE]\n\n", delayMs: perChunkDelayMs });
  return chunks;
}
