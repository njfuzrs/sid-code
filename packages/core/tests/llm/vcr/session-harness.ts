/**
 * 会话级 VCR 回放夹具 —— 评测接入 CI/CD 方案 P1（L0 确定性门禁补强）
 *
 * § 与单次调用 VCR（vcr.ts）的区别
 * vcr.ts 的夹具是「一次 HTTP 交互」粒度，能锁住流解析，但锁不住**跨轮**的东西：
 * 第 k 轮请求的稳定段是否与第 k−1 轮字节相同、子代理的钱有没有记进主会话。
 * 缓存命中率被打塌的常见成因（动态内容漏进边界前、工具顺序抖动、时间戳进了 system）
 * 恰好只在多轮下才显形，所以这里跑的是**真实 queryLoop + 真实 provider**，
 * 只在最底层 `fetch` 上替换成夹具回放。
 *
 * § 为什么在 fetch 边界捕获请求，而不是读 raw.jsonl
 * raw.jsonl 只有 index=1 那行带完整 messages/system/tools，后续行是增量
 * （见 replay-provider.ts 文件头）。要断言「第 k 轮发出去的字节」，唯一干净的取数点
 * 是 provider 序列化之后、进网络之前的那份 body —— cache_control 断点、OpenAI 族把
 * 动态区搬到消息末尾，这些都发生在 provider 内部，在 SendParams 层看不到。
 *
 * § 主循环 vs 子代理 vs 辅助调用
 * 回放轮次按**路由**分队列：主循环与子代理用不同 baseURL，fetch shim 按 host 取各自
 * 的下一轮。辅助调用（loop-detection 的 LLM 自检等）走主循环 host 但 system 不同，
 * 会被归为 `side` 且不消耗夹具轮次 —— 消耗了就会让后续主轮整体错位，断言全部失真。
 *
 * § 夹具格式（tests/fixtures/vcr/sessions/*.json）
 * 刻意贴近 raw.jsonl 的 pair 形状（response.content + usage），录制脚本
 * `scripts/vcr-session-record.ts` 可把真实会话的 raw.jsonl 直接转成这个格式（含脱敏）。
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { VcrChunk } from "./vcr.ts";
import { buildReplayStream } from "./vcr.ts";

export type SessionFamily = "anthropic-messages" | "openai-chat";

export interface SessionUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export type SessionBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

export interface SessionTurn {
  /** 由谁发起：main = 主循环，sub = 子代理 */
  agent: "main" | "sub";
  response: { content: SessionBlock[]; stop_reason: "end_turn" | "tool_use" };
  usage: SessionUsage;
}

export interface SessionFixture {
  description: string;
  family: SessionFamily;
  model: string;
  /** 用户输入（第 1 轮的 user 消息） */
  prompt: string;
  turns: SessionTurn[];
}

export const SESSION_FIXTURE_DIR = join(import.meta.dir, "..", "..", "fixtures", "vcr", "sessions");

export function listSessionFixtures(): string[] {
  return readdirSync(SESSION_FIXTURE_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();
}

export function loadSessionFixture(file: string): SessionFixture {
  return JSON.parse(readFileSync(join(SESSION_FIXTURE_DIR, file), "utf-8")) as SessionFixture;
}

// ─── 轮次 → SSE 字节 ──────────────────────────────────────────────

function sse(event: Record<string, unknown> & { type: string }, withEventLine: boolean): VcrChunk {
  return {
    data: withEventLine
      ? `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
      : `data: ${JSON.stringify(event)}\n\n`,
  };
}

export function anthropicTurnChunks(turn: SessionTurn, model: string): VcrChunk[] {
  const u = turn.usage;
  const out: VcrChunk[] = [
    sse(
      {
        type: "message_start",
        message: {
          id: "msg_session",
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: u.input_tokens,
            output_tokens: 0,
            cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
            cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
          },
        },
      },
      true,
    ),
  ];
  turn.response.content.forEach((b, index) => {
    if (b.type === "text") {
      out.push(
        sse(
          { type: "content_block_start", index, content_block: { type: "text", text: "" } },
          true,
        ),
      );
      out.push(
        sse(
          { type: "content_block_delta", index, delta: { type: "text_delta", text: b.text } },
          true,
        ),
      );
    } else {
      out.push(
        sse(
          {
            type: "content_block_start",
            index,
            content_block: { type: "tool_use", id: b.id, name: b.name, input: {} },
          },
          true,
        ),
      );
      out.push(
        sse(
          {
            type: "content_block_delta",
            index,
            delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) },
          },
          true,
        ),
      );
    }
    out.push(sse({ type: "content_block_stop", index }, true));
  });
  out.push(
    sse(
      {
        type: "message_delta",
        delta: { stop_reason: turn.response.stop_reason, stop_sequence: null },
        usage: { output_tokens: u.output_tokens },
      },
      true,
    ),
  );
  out.push(sse({ type: "message_stop" }, true));
  return out;
}

export function openaiTurnChunks(turn: SessionTurn): VcrChunk[] {
  const u = turn.usage;
  const id = "chatcmpl-session";
  const out: VcrChunk[] = [
    sse(
      { type: "chunk", id, choices: [{ index: 0, delta: { role: "assistant", content: null } }] },
      false,
    ),
  ];
  let toolIdx = 0;
  for (const b of turn.response.content) {
    if (b.type === "text") {
      out.push(
        sse({ type: "chunk", id, choices: [{ index: 0, delta: { content: b.text } }] }, false),
      );
    } else {
      out.push(
        sse(
          {
            type: "chunk",
            id,
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: toolIdx++,
                      id: b.id,
                      type: "function",
                      function: { name: b.name, arguments: JSON.stringify(b.input) },
                    },
                  ],
                },
              },
            ],
          },
          false,
        ),
      );
    }
  }
  out.push(
    sse(
      {
        type: "chunk",
        id,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: turn.response.stop_reason === "tool_use" ? "tool_calls" : "stop",
          },
        ],
      },
      false,
    ),
  );
  out.push(
    sse(
      {
        type: "chunk",
        id,
        choices: [],
        usage: {
          prompt_tokens: u.input_tokens,
          completion_tokens: u.output_tokens,
          total_tokens: u.input_tokens + u.output_tokens,
          prompt_tokens_details: { cached_tokens: u.cache_read_input_tokens ?? 0 },
        },
      },
      false,
    ),
  );
  out.push({ data: "data: [DONE]\n\n" });
  return out;
}

// ─── fetch shim：按路由出轮次 + 捕获 wire body ─────────────────────────

export interface CapturedRequest {
  route: "main" | "sub" | "side";
  url: string;
  body: Record<string, any>;
}

export interface SessionFetch {
  captured: CapturedRequest[];
  /** 每条路由已消耗的夹具轮次数 */
  consumed: { main: number; sub: number };
  restore: () => void;
}

/**
 * 安装 fetch shim。
 *
 * @param isSide 判定一条主路由请求是否是辅助调用（不消耗夹具轮次，回一个空 end_turn）
 */
export function installSessionFetch(
  fx: SessionFixture,
  hosts: { main: string; sub: string },
  isSide: (body: Record<string, any>) => boolean,
): SessionFetch {
  const realFetch = globalThis.fetch;
  const queues = {
    main: fx.turns.filter((t) => t.agent === "main"),
    sub: fx.turns.filter((t) => t.agent === "sub"),
  };
  const state: SessionFetch = {
    captured: [],
    consumed: { main: 0, sub: 0 },
    restore: () => {
      globalThis.fetch = realFetch;
    },
  };
  const toChunks = (t: SessionTurn) =>
    fx.family === "anthropic-messages" ? anthropicTurnChunks(t, fx.model) : openaiTurnChunks(t);

  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    let rawBody: unknown = init?.body;
    if (rawBody === undefined && input instanceof Request) rawBody = await input.text();
    const body = JSON.parse(
      typeof rawBody === "string" ? rawBody : new TextDecoder().decode(rawBody as any),
    );
    const host = new URL(url).host;
    let route: CapturedRequest["route"];
    if (host === hosts.sub) route = "sub";
    else if (host === hosts.main) route = isSide(body) ? "side" : "main";
    else throw new Error(`session-harness: 未知请求目标 ${url}`);
    state.captured.push({ route, url, body });

    let turn: SessionTurn | undefined;
    if (route === "side") {
      turn = {
        agent: "main",
        response: { content: [{ type: "text", text: "{}" }], stop_reason: "end_turn" },
        usage: { input_tokens: 0, output_tokens: 0 },
      };
    } else {
      turn = queues[route][state.consumed[route]++];
      if (!turn) {
        throw new Error(
          `session-harness: ${route} 路由夹具已耗尽（共 ${queues[route].length} 轮）——会话轮数与录制不符`,
        );
      }
    }
    return new Response(buildReplayStream(toChunks(turn), 0), {
      status: 200,
      headers: { "content-type": "text/event-stream", "request-id": "req_session" },
    });
  }) as unknown as typeof globalThis.fetch;

  return state;
}
