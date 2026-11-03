/**
 * Responses 并行工具调用的参数不得丢失 / 串块（2026-11-03 事故回归）。
 *
 * 事故：会话 20261103-153824-062a9640（gpt-6.1-sol @ code.ppchat.vip）每一轮并行工具调用
 * 的参数都落成 `{}`，被 F1 空参数检测作废重试；单调用轮全部正常。根因在解析器：
 *   ① 不读 `function_call_arguments.done.arguments` / `output_item.done.item.arguments`，
 *      而该网关并行时**只发 done、不发 delta**（夹具 responses-parallel-tools-done-only 是原样抓包）；
 *   ② 所有块共用一个全局递增 index，增量交错到达时多段 JSON 被拼进同一个块。
 *
 * 断言一律走「解析器 → 真实消费方 processStream」端到端，看最终 tool_use.input，
 * 不看中间事件形状 —— 事件形状对、落到消费方仍错的情形正是这次的形态。
 */

import { describe, test, expect } from "bun:test";
import { parseResponsesStream } from "@sid-code/core/llm/openai-responses.ts";
import { processStream as processStreamQuery } from "@sid-code/core/query/stream-processor.ts";
import { processStream as processStreamAgent } from "@sid-code/core/agent/stream-processor.ts";
import type { ContentBlock, StreamEvent } from "@sid-code/core/llm/types.ts";

// ─── 辅助 ───

function sseStream(events: object[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const e of events) {
        c.enqueue(
          enc.encode(`event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`),
        );
      }
      c.close();
    },
  });
}

function fixtureStream(name: string): ReadableStream<Uint8Array> {
  const path = `${import.meta.dir}/../fixtures/vcr/${name}.json`;
  const fx = JSON.parse(require("fs").readFileSync(path, "utf-8"));
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const ch of fx.response.chunks) c.enqueue(enc.encode(ch.data));
      c.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of parseResponsesStream(stream)) out.push(e);
  return out;
}

async function* replay(events: StreamEvent[]): AsyncIterable<StreamEvent> {
  for (const e of events) yield e;
}

type Tool = { id: string; name: string; input: unknown };
const tools = (content: ContentBlock[]): Tool[] =>
  content
    .filter((b) => b.type === "tool_use")
    .map((b) => {
      const t = b as unknown as Tool;
      return { id: t.id, name: t.name, input: t.input };
    });

/** 同一份事件序列喂给主循环与子代理两个消费方，两边必须得到同一组工具调用 */
async function toolsViaConsumers(events: StreamEvent[]): Promise<Tool[]> {
  const q = await processStreamQuery(replay(events));
  const a = await processStreamAgent(replay(events));
  expect(tools(a.content)).toEqual(tools(q.content));
  expect(q.stopReason).toBe("tool_use");
  return tools(q.content);
}

const added = (id: string, oi: number, name: string) => ({
  type: "response.output_item.added",
  output_index: oi,
  item: {
    type: "function_call",
    id,
    call_id: `call_${id}`,
    name,
    arguments: "",
    status: "in_progress",
  },
});
const delta = (id: string, oi: number, d: string) => ({
  type: "response.function_call_arguments.delta",
  item_id: id,
  output_index: oi,
  delta: d,
});
const argsDone = (id: string, oi: number, args: string) => ({
  type: "response.function_call_arguments.done",
  item_id: id,
  output_index: oi,
  arguments: args,
});
const itemDone = (id: string, oi: number, name: string, args?: string) => ({
  type: "response.output_item.done",
  output_index: oi,
  item: {
    type: "function_call",
    id,
    call_id: `call_${id}`,
    name,
    ...(args !== undefined ? { arguments: args } : {}),
    status: "completed",
  },
});
const completed = {
  type: "response.completed",
  response: { id: "r", status: "completed", usage: { input_tokens: 10, output_tokens: 5 } },
};

const A = '{"command":"git status"}';
const B = '{"pattern":"*.md"}';
const C = '{"pattern":"src/**/*.ts"}';
const EXPECTED = [
  { id: "call_a", name: "bash", input: { command: "git status" } },
  { id: "call_b", name: "glob", input: { pattern: "*.md" } },
  { id: "call_c", name: "glob", input: { pattern: "src/**/*.ts" } },
];

// ─── 测试 ───

describe("Responses 并行工具调用参数", () => {
  test("网关真实抓包（只发 done、无 delta）：两个调用参数都完整", async () => {
    const events = await collect(fixtureStream("responses-parallel-tools-done-only"));
    const got = await toolsViaConsumers(events);
    expect(got.map((t) => [t.name, t.input])).toEqual([
      ["bash", { command: "git status" }],
      ["glob", { pattern: "*.md" }],
    ]);
  });

  test("只发 arguments.done（三个并行，与事故同形）", async () => {
    const events = await collect(
      sseStream([
        added("a", 0, "bash"),
        argsDone("a", 0, A),
        itemDone("a", 0, "bash", A),
        added("b", 1, "glob"),
        argsDone("b", 1, B),
        itemDone("b", 1, "glob", B),
        added("c", 2, "glob"),
        argsDone("c", 2, C),
        itemDone("c", 2, "glob", C),
        completed,
      ]),
    );
    expect(await toolsViaConsumers(events)).toEqual(EXPECTED);
  });

  test("连 arguments.done 都省略、参数只在 output_item.done.item.arguments", async () => {
    const events = await collect(
      sseStream([
        added("a", 0, "bash"),
        itemDone("a", 0, "bash", A),
        added("b", 1, "glob"),
        itemDone("b", 1, "glob", B),
        added("c", 2, "glob"),
        itemDone("c", 2, "glob", C),
        completed,
      ]),
    );
    expect(await toolsViaConsumers(events)).toEqual(EXPECTED);
  });

  test("三个调用先全部 added、增量交错到达：各归各位，不串块", async () => {
    const events = await collect(
      sseStream([
        added("a", 0, "bash"),
        added("b", 1, "glob"),
        added("c", 2, "glob"),
        delta("a", 0, A.slice(0, 5)),
        delta("b", 1, B.slice(0, 4)),
        delta("c", 2, C.slice(0, 7)),
        delta("c", 2, C.slice(7)),
        delta("a", 0, A.slice(5)),
        delta("b", 1, B.slice(4)),
        argsDone("b", 1, B),
        argsDone("a", 0, A),
        argsDone("c", 2, C),
        itemDone("a", 0, "bash", A),
        itemDone("b", 1, "glob", B),
        itemDone("c", 2, "glob", C),
        completed,
      ]),
    );
    expect(await toolsViaConsumers(events)).toEqual(EXPECTED);
    // 每个块恰好一次 start、一次 stop，index 互不相同
    const starts = events
      .filter((e) => e.type === "content_block_start")
      .map((e) => (e as { index: number }).index);
    const stops = events
      .filter((e) => e.type === "content_block_stop")
      .map((e) => (e as { index: number }).index);
    expect(new Set(starts).size).toBe(3);
    expect([...stops].sort()).toEqual([...starts].sort());
  });

  test("增量只发了一半、done 带完整终值：补发剩余后缀", async () => {
    const events = await collect(
      sseStream([
        added("a", 0, "bash"),
        delta("a", 0, A.slice(0, 8)),
        argsDone("a", 0, A),
        itemDone("a", 0, "bash", A),
        added("b", 1, "glob"),
        argsDone("b", 1, B),
        itemDone("b", 1, "glob", B),
        added("c", 2, "glob"),
        delta("c", 2, C),
        argsDone("c", 2, C),
        itemDone("c", 2, "glob", C),
        completed,
      ]),
    );
    expect(await toolsViaConsumers(events)).toEqual(EXPECTED);
  });

  test("增量与 done 终值矛盾：以终值为准（stop.tool_use.input_json 整段替换）", async () => {
    const events = await collect(
      sseStream([
        added("a", 0, "bash"),
        delta("a", 0, '{"command":"rm -rf'),
        argsDone("a", 0, A),
        itemDone("a", 0, "bash", A),
        added("b", 1, "glob"),
        argsDone("b", 1, B),
        itemDone("b", 1, "glob", B),
        added("c", 2, "glob"),
        argsDone("c", 2, C),
        itemDone("c", 2, "glob", C),
        completed,
      ]),
    );
    expect(await toolsViaConsumers(events)).toEqual(EXPECTED);
  });

  test("增量缺 item_id：按 output_index 回落路由", async () => {
    const noId = (oi: number, d: string) => ({
      type: "response.function_call_arguments.delta",
      output_index: oi,
      delta: d,
    });
    const events = await collect(
      sseStream([
        added("a", 0, "bash"),
        added("b", 1, "glob"),
        added("c", 2, "glob"),
        noId(1, B),
        noId(0, A),
        noId(2, C),
        itemDone("a", 0, "bash"),
        itemDone("b", 1, "glob"),
        itemDone("c", 2, "glob"),
        completed,
      ]),
    );
    expect(await toolsViaConsumers(events)).toEqual(EXPECTED);
  });

  test("args.done 与 output_item.done 都到：只收尾一次，参数不重复拼接", async () => {
    const events = await collect(
      sseStream([
        added("a", 0, "bash"),
        delta("a", 0, A),
        argsDone("a", 0, A),
        itemDone("a", 0, "bash", A),
        completed,
      ]),
    );
    expect(events.filter((e) => e.type === "content_block_stop")).toHaveLength(1);
    const got = await toolsViaConsumers(events);
    expect(got).toEqual([EXPECTED[0]]);
  });

  test("思考摘要 + 正文 + 并行工具混排：各块 index 互不相同、内容不串", async () => {
    const events = await collect(
      sseStream([
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { id: "rs", type: "reasoning" },
        },
        { type: "response.reasoning_summary_part.added", item_id: "rs", output_index: 0 },
        {
          type: "response.reasoning_summary_text.delta",
          item_id: "rs",
          output_index: 0,
          delta: "想一下",
        },
        { type: "response.reasoning_summary_text.done", item_id: "rs", output_index: 0 },
        {
          type: "response.output_item.done",
          output_index: 0,
          item: { id: "rs", type: "reasoning", encrypted_content: "enc" },
        },
        {
          type: "response.output_item.added",
          output_index: 1,
          item: { id: "msg", type: "message" },
        },
        {
          type: "response.content_part.added",
          item_id: "msg",
          output_index: 1,
          part: { type: "output_text", text: "" },
        },
        { type: "response.output_text.delta", item_id: "msg", output_index: 1, delta: "我来查" },
        { type: "response.output_text.done", item_id: "msg", output_index: 1 },
        added("a", 2, "bash"),
        added("b", 3, "glob"),
        argsDone("a", 2, A),
        argsDone("b", 3, B),
        itemDone("a", 2, "bash", A),
        itemDone("b", 3, "glob", B),
        completed,
      ]),
    );
    const q = await processStreamQuery(replay(events));
    const kinds = q.content.map((b) => b.type);
    expect(kinds).toEqual(["thinking", "provider_reasoning", "text", "tool_use", "tool_use"]);
    expect((q.content[2] as { text: string }).text).toBe("我来查");
    expect(tools(q.content).map((t) => t.input)).toEqual([
      { command: "git status" },
      { pattern: "*.md" },
    ]);
  });

  test("老形态（逐个调用 delta+done，已有夹具）保持不变", async () => {
    const events = await collect(fixtureStream("responses-parallel-tools"));
    const got = await toolsViaConsumers(events);
    expect(got.map((t) => [t.id, t.name, t.input])).toEqual([
      ["call_a", "get_weather", { city: "Paris" }],
      ["call_b", "get_time", { tz: "UTC" }],
    ]);
  });
});
