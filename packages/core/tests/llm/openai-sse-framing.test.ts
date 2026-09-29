/**
 * openai.ts parseSSE 线格式：D1 / D2 / D3 / D8 回归门禁
 *
 * 四条缺陷的共同根源是「把上游会怎么分帧当成已知常量」：
 *
 * | 缺陷 | 被当成常量的假设 | 旧行为（零报错） |
 * | --- | --- | --- |
 * | D1 | `data:` 后一定有一个空格 | 整流零事件 |
 * | D2 | 行尾一定是 `\n` | `[DONE]\r` 恒不命中 → 丢 message_delta / message_stop |
 * | D3 | 流一定以 `[DONE]` 结束 | EOF 收尾 → usage / stop_reason / completed 全丢 |
 * | D8 | tool_call 的 id/name 一定在首片给全 | 截断成 `""` / `"Re"` / `"call_"` |
 *
 * 夹具**按协议铺**（WHATWG SSE + OpenAI tool_calls delta 语义），不按我们的实现铺 ——
 * 旧测试网全绿正是因为夹具与实现犯了同一个假设（全是 `data: ` + `\n\n` + `[DONE]`）。
 *
 * 每条断言都做过变异自证：把对应修复改回旧写法，**那一条**会红（见各 describe 注释）。
 */

import { describe, test, expect, afterEach } from "bun:test";
import { OpenAIProvider, mergeToolCallIdentityFragment } from "@sid-code/core/llm/openai.ts";
import { processStream } from "@sid-code/core/query/stream-processor.ts";
import type { SendParams, StreamEvent } from "@sid-code/core/llm/types.ts";
import { splitSSELines, parseSSEField, isDoneSentinel } from "@sid-code/core/llm/sse-line.ts";
import { installFetchFromFixture, type VcrChunk } from "./vcr/vcr.ts";

const BASE_PARAMS: SendParams = {
  model: "gpt-4o-mini",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  maxTokens: 100,
};

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

function install(chunks: VcrChunk[]): void {
  restore = installFetchFromFixture({
    provider: "openai",
    scenario: "sse-framing",
    response: { status: 200, headers: { "content-type": "text/event-stream" }, chunks },
  });
}

async function collect(): Promise<StreamEvent[]> {
  const provider = new OpenAIProvider("test-key", "gpt-4o-mini");
  const events: StreamEvent[] = [];
  for await (const ev of provider.sendMessageStream(BASE_PARAMS)) events.push(ev);
  return events;
}

const textOf = (events: StreamEvent[]) =>
  events
    .map((e) =>
      e.type === "content_block_delta" && e.delta.type === "text_delta" ? e.delta.text : "",
    )
    .join("");

const CONTENT = { id: "x", choices: [{ index: 0, delta: { content: "hello" } }] };
const FINISH = { id: "x", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
const USAGE = {
  id: "x",
  choices: [],
  usage: {
    prompt_tokens: 1000,
    completion_tokens: 50,
    prompt_tokens_details: { cached_tokens: 800 },
  },
};

/** 按指定前缀与行终止符拼一条 SSE 流 */
function stream(opts: { prefix: string; eol: string; done: boolean }): VcrChunk[] {
  const sep = opts.eol + opts.eol;
  const chunks = [CONTENT, FINISH, USAGE].map((o) => ({
    data: `${opts.prefix}${JSON.stringify(o)}${sep}`,
    delayMs: 0,
  }));
  if (opts.done) chunks.push({ data: `${opts.prefix}[DONE]${sep}`, delayMs: 0 });
  return chunks;
}

// ─── sse-line.ts 单元 ───

describe("sse-line：按 WHATWG SSE 规范切行与解析字段", () => {
  test("三种行终止符 CRLF / LF / CR 都认，且 CRLF 算一个终止符", () => {
    expect(splitSSELines("a\r\nb\nc\rd")).toEqual({ lines: ["a", "b", "c"], rest: "d" });
    expect(splitSSELines("a\r\n\r\n").lines).toEqual(["a", ""]);
  });

  test("结尾的 \\r 留在 rest（可能是被 TCP 切开的 CRLF），不提前切出一个空行", () => {
    const first = splitSSELines("data: x\r");
    expect(first).toEqual({ lines: [], rest: "data: x\r" });
    const second = splitSSELines(first.rest + "\n\r\n");
    expect(second.lines).toEqual(["data: x", ""]);
  });

  test("冒号后空格可选，且只移除一个（多出的属于 value）", () => {
    expect(parseSSEField('data:{"a":1}')).toEqual({ field: "data", value: '{"a":1}' });
    expect(parseSSEField('data: {"a":1}')).toEqual({ field: "data", value: '{"a":1}' });
    expect(parseSSEField("data:  x")).toEqual({ field: "data", value: " x" });
  });

  test("注释行与空行返回 null；残留 \\r 被剥掉；无冒号 = 字段名 + 空 value", () => {
    expect(parseSSEField(": keep-alive")).toBeNull();
    expect(parseSSEField("")).toBeNull();
    expect(parseSSEField("\r")).toBeNull();
    expect(parseSSEField("data: [DONE]\r")).toEqual({ field: "data", value: "[DONE]" });
    expect(parseSSEField("data")).toEqual({ field: "data", value: "" });
  });

  test("[DONE] 哨兵对周边空白不敏感", () => {
    expect(isDoneSentinel("[DONE]")).toBe(true);
    expect(isDoneSentinel(" [DONE]\r")).toBe(true);
    expect(isDoneSentinel('{"a":"[DONE]"}')).toBe(false);
  });
});

// ─── D1 / D2：同一条流换前缀与行尾，结果必须一致 ───
//
// 变异自证：把 parseSSE 的判据改回 `startsWith("data: ")` → 「无空格」两条红；
// 改回 `split("\n")` 且 `data === "[DONE]"` 严格相等 → CRLF 两条的 message_delta 断言红。

describe("D1/D2：`data:` 后空格可选、CRLF / CR 行尾，解析结果与基线逐事件相同", () => {
  const variants = [
    { name: "基线 data: + LF", prefix: "data: ", eol: "\n" },
    { name: "D1 data:（无空格）+ LF", prefix: "data:", eol: "\n" },
    { name: "D2 data: + CRLF", prefix: "data: ", eol: "\r\n" },
    { name: "D1+D2 data:（无空格）+ CRLF", prefix: "data:", eol: "\r\n" },
    { name: "D2 data: + 裸 CR", prefix: "data: ", eol: "\r" },
  ];

  for (const v of variants) {
    test(v.name, async () => {
      install(stream({ prefix: v.prefix, eol: v.eol, done: true }));
      const events = await collect();
      expect(textOf(events)).toBe("hello");
      expect(events.map((e) => e.type)).toEqual([
        "content_block_start",
        "content_block_delta",
        "content_block_stop",
        "message_delta",
        "message_stop",
      ]);
      const md = events.find((e) => e.type === "message_delta") as Extract<
        StreamEvent,
        { type: "message_delta" }
      >;
      expect(md.delta.stop_reason).toBe("end_turn");
      expect(md.usage.inputTokens).toBe(1000);
      expect(md.usage.cacheReadInputTokens).toBe(800);
    });
  }

  test("CRLF 被 TCP 切在 \\r 与 \\n 之间，仍只算一个终止符", async () => {
    install([
      { data: `data: ${JSON.stringify(CONTENT)}\r`, delayMs: 0 },
      { data: `\n\r\ndata: ${JSON.stringify(FINISH)}\r\n\r`, delayMs: 0 },
      { data: `\ndata: [DONE]\r\n\r\n`, delayMs: 0 },
    ]);
    const events = await collect();
    expect(textOf(events)).toBe("hello");
    expect(events.at(-1)?.type).toBe("message_stop");
    expect(events.some((e) => e.type === "message_delta")).toBe(true);
  });
});

/**
 * 发完给定文本后**不关闭**连接的响应体（模拟「[DONE] 后把 socket 挂起数十秒」的网关）。
 *
 * 为什么 D2 需要这条而不能只看事件序列：D3 修好之后，一个没被认出来的 `[DONE]`
 * 会落到 EOF 统一出口，事件序列与认出来时**完全相同** —— 只看序列的断言对 D2 回归是瞎的
 * （变异自证实测：改回 `split("\n")` + 严格相等，上面那组断言全绿）。
 * D2 剩下的真实损害是 `[DONE]` 早退失效：流要等 socket 关闭才结束，
 * 那段 39s 空转窗口（本文件 `streamDone` 注释的事故）在 CRLF 网关上原样复活。
 */
function installHangingAfter(text: string): void {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(text));
          // 故意不 close
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )) as unknown as typeof globalThis.fetch;
  restore = () => {
    globalThis.fetch = realFetch;
  };
}

describe("D2：CRLF 下 [DONE] 仍触发早退，不等 socket 关闭", () => {
  for (const eol of ["\n", "\r\n", "\r"]) {
    test(`行尾 ${JSON.stringify(eol)}：[DONE] 后连接挂起，流在 1s 内结束`, async () => {
      const sep = eol + eol;
      installHangingAfter(
        [CONTENT, FINISH, USAGE].map((o) => `data: ${JSON.stringify(o)}${sep}`).join("") +
          `data: [DONE]${sep}`,
      );
      const result = await Promise.race([
        collect().then((evs) => evs.at(-1)?.type),
        new Promise<string>((r) => setTimeout(() => r("hung"), 1000)),
      ]);
      expect(result).toBe("message_stop");
    });
  }
});

// ─── D3：EOF 收尾与 `[DONE]` 收尾走同一个出口 ───
//
// 变异自证：删掉 while 之后的 `finishStream()` → 「EOF 收尾」三条全红；
// 删掉 catch 里的 `flushUsageBeforeFailure()` → 「流内 error」那条红。

describe("D3：流不发 [DONE] 直接 EOF，usage / stop_reason 仍到达消费侧", () => {
  test("EOF 收尾：provider 层事件序列与 [DONE] 收尾完全相同", async () => {
    install(stream({ prefix: "data: ", eol: "\n", done: true }));
    const withDone = (await collect()).map((e) => e.type);
    restore?.();
    install(stream({ prefix: "data: ", eol: "\n", done: false }));
    const eof = await collect();
    expect(eof.map((e) => e.type)).toEqual(withDone);
  });

  test("EOF 收尾：消费侧（主循环 processStream）拿到完整 usage 与 stopReason", async () => {
    install(stream({ prefix: "data: ", eol: "\n", done: false }));
    const provider = new OpenAIProvider("test-key", "gpt-4o-mini");
    const res = await processStream(provider.sendMessageStream(BASE_PARAMS));
    expect(res.stopReason).toBe("end_turn");
    expect(res.usage.inputTokens).toBe(1000);
    expect(res.usage.outputTokens).toBe(50);
    expect(res.usage.cacheReadInputTokens).toBe(800);
  });

  test("最后一个 usage chunk 不以换行结尾就 EOF：残行也要解析", async () => {
    install([
      { data: `data: ${JSON.stringify(CONTENT)}\n\n`, delayMs: 0 },
      { data: `data: ${JSON.stringify(FINISH)}\n\n`, delayMs: 0 },
      { data: `data: ${JSON.stringify(USAGE)}`, delayMs: 0 },
    ]);
    const md = (await collect()).find((e) => e.type === "message_delta") as Extract<
      StreamEvent,
      { type: "message_delta" }
    >;
    expect(md?.usage.inputTokens).toBe(1000);
  });

  test("没等到 finish_reason 就 EOF：工具块仍被关闭（input 能解析），message_stop 照发", async () => {
    install([
      {
        data: `data: ${JSON.stringify({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  { index: 0, id: "call_1", function: { name: "Read", arguments: '{"p":1}' } },
                ],
              },
            },
          ],
        })}\n\n`,
        delayMs: 0,
      },
    ]);
    const events = await collect();
    const types = events.map((e) => e.type);
    expect(types).toContain("content_block_stop");
    expect(types.at(-1)).toBe("message_stop");
  });

  test("流内 error chunk：已收到的 usage 先于 error 交出（否则 discardedUsage 旁路拿不到）", async () => {
    install([
      { data: `data: ${JSON.stringify(CONTENT)}\n\n`, delayMs: 0 },
      { data: `data: ${JSON.stringify(USAGE)}\n\n`, delayMs: 0 },
      { data: `data: ${JSON.stringify({ error: { message: "upstream boom" } })}\n\n`, delayMs: 0 },
    ]);
    const provider = new OpenAIProvider("test-key", "gpt-4o-mini");
    const raw: StreamEvent[] = [];
    for await (const ev of provider.sendMessageStream(BASE_PARAMS)) raw.push(ev);
    const mdIdx = raw.findIndex((e) => e.type === "message_delta");
    const errIdx = raw.findIndex((e) => e.type === "error");
    expect(mdIdx).toBeGreaterThanOrEqual(0);
    expect(mdIdx).toBeLessThan(errIdx);
    const md = raw[mdIdx] as Extract<StreamEvent, { type: "message_delta" }>;
    expect(md.delta.stop_reason).toBeNull();
    expect(md.usage.inputTokens).toBe(1000);
  });

  test("[DONE] 与 EOF 各只发一条 message_delta（统一出口不双发）", async () => {
    install(stream({ prefix: "data: ", eol: "\n", done: true }));
    expect((await collect()).filter((e) => e.type === "message_delta")).toHaveLength(1);
  });
});

// ─── D8：tool_call 的 id / name 按片合并，并经 content_block_stop 修订下游 ───
//
// 变异自证：把合并改回 `if (tc.id && !state.id)` 的「首片锁定」→ 切碎 / 迟到两类红；
// 删掉消费侧 `event.tool_use` 覆盖 → 端到端那几条红（provider 对了、下游仍是空串）。

function toolChunk(tc: Record<string, unknown>, finish?: string): VcrChunk {
  return {
    data: `data: ${JSON.stringify({
      choices: [
        { index: 0, delta: { tool_calls: [{ index: 0, ...tc }] }, finish_reason: finish ?? null },
      ],
    })}\n\n`,
    delayMs: 0,
  };
}
const toolTail: VcrChunk[] = [
  {
    data: `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`,
    delayMs: 0,
  },
  { data: "data: [DONE]\n\n", delayMs: 0 },
];

async function toolUseAfterConsume(chunks: VcrChunk[]) {
  install(chunks);
  const provider = new OpenAIProvider("test-key", "gpt-4o-mini");
  const res = await processStream(provider.sendMessageStream(BASE_PARAMS));
  const block = res.content.find((b) => b.type === "tool_use");
  if (block?.type !== "tool_use") throw new Error("no tool_use block");
  return block;
}

describe("D8：tool_call 身份被切碎或迟到，下游拿到的是完整值", () => {
  test("基线：首片即完整", async () => {
    const b = await toolUseAfterConsume([
      toolChunk({ id: "call_abc", type: "function", function: { name: "Read", arguments: "" } }),
      toolChunk({ function: { arguments: '{"file_path":"/a"}' } }),
      ...toolTail,
    ]);
    expect(b).toMatchObject({ id: "call_abc", name: "Read", input: { file_path: "/a" } });
  });

  test("迟到：首片只有 index 与空 arguments，第 2 片才给 id / name", async () => {
    const b = await toolUseAfterConsume([
      toolChunk({ function: { arguments: "" } }),
      toolChunk({ id: "call_abc", function: { name: "Read", arguments: '{"file_path":"/a"}' } }),
      ...toolTail,
    ]);
    expect(b).toMatchObject({ id: "call_abc", name: "Read", input: { file_path: "/a" } });
  });

  test('切碎 name："Re" + "ad"', async () => {
    const b = await toolUseAfterConsume([
      toolChunk({ id: "call_abc", function: { name: "Re", arguments: "" } }),
      toolChunk({ function: { name: "ad", arguments: "{}" } }),
      ...toolTail,
    ]);
    expect(b.name).toBe("Read");
  });

  test('切碎 id："call_" + "abc123"', async () => {
    const b = await toolUseAfterConsume([
      toolChunk({ id: "call_", function: { name: "Read", arguments: "" } }),
      toolChunk({ id: "abc123", function: { arguments: "{}" } }),
      ...toolTail,
    ]);
    expect(b.id).toBe("call_abc123");
  });

  test("每片重复完整 id / name（vLLM 等实现的形态）：不被拼成 call_abccall_abc", async () => {
    const b = await toolUseAfterConsume([
      toolChunk({ id: "call_abc", function: { name: "Read", arguments: '{"file_' } }),
      toolChunk({ id: "call_abc", function: { name: "Read", arguments: 'path":"/a"}' } }),
      ...toolTail,
    ]);
    expect(b).toMatchObject({ id: "call_abc", name: "Read", input: { file_path: "/a" } });
  });

  test("上游始终不给 id：收尾合成一个非空 id（留空则下一轮 tool_call_id 配对必 400）", async () => {
    const b = await toolUseAfterConsume([
      toolChunk({ function: { name: "Read", arguments: "{}" } }),
      ...toolTail,
    ]);
    expect(b.id.length).toBeGreaterThan(0);
    expect(b.name).toBe("Read");
  });

  test("身份未变时 content_block_stop 不带 tool_use 修订（Anthropic 族形态零变化）", async () => {
    install([
      toolChunk({ id: "call_abc", function: { name: "Read", arguments: "{}" } }),
      ...toolTail,
    ]);
    const stops = (await collect()).filter((e) => e.type === "content_block_stop");
    expect(stops.every((e) => !("tool_use" in e) || e.tool_use === undefined)).toBe(true);
  });
});

describe("mergeToolCallIdentityFragment：三条合并规则", () => {
  test("增量追加 / 重复忽略 / 累积式重发整体替换 / 空片忽略", () => {
    expect(mergeToolCallIdentityFragment("Re", "ad")).toBe("Read");
    expect(mergeToolCallIdentityFragment("Read", "Read")).toBe("Read");
    expect(mergeToolCallIdentityFragment("Re", "Read")).toBe("Read");
    expect(mergeToolCallIdentityFragment("", "Read")).toBe("Read");
    expect(mergeToolCallIdentityFragment("Read", "")).toBe("Read");
  });
});
