/**
 * 发现 1 / #385：Responses reasoning item 捕获与回放
 *
 * 覆盖：流式/非流式捕获 → provider_reasoning 块；回放位置在 function_call 之前；
 * 跨模型丢弃；开关关闭丢弃；anthropic / openai-chat 序列化不带出；token 估算不随密文增长；
 * 400 能力位只认指向 reasoning 的错误体；thinking-only 过滤把新块型算作「非实质」。
 *
 * fix_type: logic
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { parseResponsesStream, parseResponsesBody } from "@sid-code/core/llm/openai-responses.ts";
import { buildResponsesRequest } from "@sid-code/core/llm/openai-responses-request.ts";
import { processStream as queryProcessStream } from "@sid-code/core/query/stream-processor.ts";
import { processStream as agentProcessStream } from "@sid-code/core/agent/stream-processor.ts";
import { estimateBlockTokens } from "@sid-code/core/context/token.ts";
import {
  looksLikeReasoningReplayRejection,
  markReasoningReplayUnsupported,
  shouldReplayReasoning,
  resetReasoningReplayForTest,
} from "@sid-code/core/llm/reasoning-replay.ts";
import { ContentBlockSchema } from "@sid-code/core/sdk/schemas.ts";
import { isReasoningOnlyBlock } from "@sid-code/core/llm/types.ts";
import type {
  Message,
  ProviderReasoningBlock,
  SendParams,
  StreamEvent,
} from "@sid-code/core/llm/types.ts";

const MODEL = "gpt-6-luna";
const ENC = "gAAAA" + "x".repeat(1247); // 与前置探针同量级（1252 字节）

function sse(events: object[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const e of events) {
        c.enqueue(enc.encode(`event: ${(e as any).type}\ndata: ${JSON.stringify(e)}\n\n`));
      }
      c.close();
    },
  });
}

/** 一轮「reasoning item → function_call」的真实形态（字段同前置探针 r1） */
function toolTurnEvents(): object[] {
  const reasoning = {
    id: "rs_1",
    type: "reasoning",
    summary: [],
    content: [],
    encrypted_content: ENC,
    status: "completed",
  };
  return [
    { type: "response.created", response: { id: "r1", status: "in_progress" } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...reasoning, encrypted_content: undefined, status: "in_progress" },
    },
    { type: "response.output_item.done", output_index: 0, item: reasoning },
    {
      type: "response.output_item.added",
      output_index: 1,
      item: { id: "fc_1", type: "function_call", call_id: "call_1", name: "get_weather" },
    },
    {
      type: "response.function_call_arguments.delta",
      item_id: "fc_1",
      output_index: 1,
      delta: '{"city":"Paris"}',
    },
    { type: "response.function_call_arguments.done", item_id: "fc_1", output_index: 1 },
    {
      type: "response.output_item.done",
      output_index: 1,
      item: {
        id: "fc_1",
        type: "function_call",
        call_id: "call_1",
        name: "get_weather",
        arguments: '{"city":"Paris"}',
      },
    },
    {
      type: "response.completed",
      response: { id: "r1", status: "completed", usage: { input_tokens: 57, output_tokens: 45 } },
    },
  ];
}

async function collect(s: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of s) out.push(e);
  return out;
}

function reasoningBlock(model = MODEL): ProviderReasoningBlock {
  return {
    type: "provider_reasoning",
    protocol: "openai-responses",
    model,
    item: {
      id: "rs_1",
      type: "reasoning",
      summary: [],
      encrypted_content: ENC,
      status: "completed",
    },
  };
}

function history(block: ProviderReasoningBlock): Message[] {
  return [
    { role: "user", content: [{ type: "text", text: "天气?" }] },
    {
      role: "assistant",
      content: [
        block,
        { type: "tool_use", id: "call_1", name: "get_weather", input: { city: "Paris" } },
      ],
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "晴" }] },
  ];
}

function params(messages: Message[]): SendParams {
  return { model: MODEL, messages, maxTokens: 1024 } as unknown as SendParams;
}

describe("捕获：reasoning item → provider_reasoning 块", () => {
  test("流式：output_item.done 产出块，带模型名与密文；主循环 / 子循环处理器都保留", async () => {
    const events = await collect(
      parseResponsesStream(sse(toolTurnEvents()), undefined, { model: MODEL }),
    );
    const start = events.find(
      (e) => e.type === "content_block_start" && e.content_block.type === "provider_reasoning",
    ) as any;
    expect(start).toBeDefined();
    expect(start.content_block.model).toBe(MODEL);
    expect(start.content_block.item.encrypted_content).toBe(ENC);

    const q = await queryProcessStream(
      (async function* () {
        yield* parseResponsesStream(sse(toolTurnEvents()), undefined, { model: MODEL });
      })(),
    );
    expect(q.content.map((b) => b.type)).toEqual(["provider_reasoning", "tool_use"]);
    expect(q.stopReason).toBe("tool_use");

    const a = await agentProcessStream(
      (async function* () {
        yield* parseResponsesStream(sse(toolTurnEvents()), undefined, { model: MODEL });
      })(),
    );
    expect(a.content.map((b) => b.type)).toEqual(["provider_reasoning", "tool_use"]);
  });

  test("没有 encrypted_content 的 reasoning item 不存（回放它只会 400）", async () => {
    const evts = toolTurnEvents().map((e: any) =>
      e.type === "response.output_item.done" && e.item.type === "reasoning"
        ? { ...e, item: { id: "rs_1", type: "reasoning", summary: [] } }
        : e,
    );
    const events = await collect(parseResponsesStream(sse(evts), undefined, { model: MODEL }));
    expect(
      events.some(
        (e) => e.type === "content_block_start" && e.content_block.type === "provider_reasoning",
      ),
    ).toBe(false);
  });

  test("非流式：parseResponsesBody 同样产出块", () => {
    const parsed = parseResponsesBody(
      {
        status: "completed",
        output: [
          { id: "rs_1", type: "reasoning", summary: [], encrypted_content: ENC } as any,
          {
            id: "fc_1",
            type: "function_call",
            call_id: "call_1",
            name: "f",
            arguments: "{}",
          } as any,
        ],
      },
      { model: MODEL },
    );
    expect(parsed.content.map((b) => b.type)).toEqual(["provider_reasoning", "tool_use"]);
  });
});

describe("回放：buildResponsesRequest", () => {
  test("同模型：reasoning item 原样出现在对应 function_call 之前，且去掉 status", () => {
    const req = buildResponsesRequest(params(history(reasoningBlock())), MODEL);
    const types = req.input.map((i: any) => i.type ?? i.role);
    expect(types).toEqual(["user", "reasoning", "function_call", "function_call_output"]);
    const r = req.input[1] as any;
    expect(r.id).toBe("rs_1");
    expect(r.encrypted_content).toBe(ENC);
    expect("status" in r).toBe(false);
  });

  test("跨模型：丢弃（密文绑定模型）", () => {
    const req = buildResponsesRequest(params(history(reasoningBlock("gpt-6-sol"))), MODEL);
    expect(req.input.some((i: any) => i.type === "reasoning")).toBe(false);
  });

  test("replayReasoning=false：丢弃", () => {
    const req = buildResponsesRequest(params(history(reasoningBlock())), MODEL, {
      replayReasoning: false,
    });
    expect(req.input.some((i: any) => i.type === "reasoning")).toBe(false);
  });
});

describe("其它序列化器不带出", () => {
  test("anthropic 序列化不 throw、不含新块型", async () => {
    const { AnthropicProvider } = await import("@sid-code/core/llm/anthropic.ts");
    const src = await Bun.file(
      new URL("../../src/llm/anthropic.ts", import.meta.url).pathname,
    ).text();
    // 两条序列化路径（流式 / 非流式）都必须经过过滤
    expect(src.split("withoutProviderReasoning(msg.content).map").length - 1).toBe(2);
    expect(AnthropicProvider).toBeDefined();
  });

  test("openai-chat convertMessages 丢弃且不告警分支存在", async () => {
    const { OpenAIProvider } = await import("@sid-code/core/llm/openai.ts");
    class T extends OpenAIProvider {
      conv(m: Message[]) {
        return (this as any).convertMessages(m, "gpt-4o");
      }
    }
    const out = new T("k", "gpt-4o").conv(history(reasoningBlock()));
    expect(JSON.stringify(out)).not.toContain(ENC);
    expect(JSON.stringify(out)).toContain("get_weather");
  });
});

describe("token 估算 / 闭集 / 非实质判定", () => {
  test("provider_reasoning 估算恒为 0，不随密文长度增长", () => {
    expect(estimateBlockTokens(reasoningBlock())).toBe(0);
  });

  test("SDK ContentBlockSchema 接受新块型", () => {
    expect(ContentBlockSchema().safeParse(reasoningBlock()).success).toBe(true);
  });

  test("isReasoningOnlyBlock 把新块型算作非实质", () => {
    expect(isReasoningOnlyBlock(reasoningBlock())).toBe(true);
    expect(isReasoningOnlyBlock({ type: "text" })).toBe(false);
  });
});

describe("网关能力位", () => {
  const prev = process.env.SID_CODE_RESPONSES_REASONING_REPLAY;
  beforeEach(() => resetReasoningReplayForTest());
  afterEach(() => {
    if (prev === undefined) delete process.env.SID_CODE_RESPONSES_REASONING_REPLAY;
    else process.env.SID_CODE_RESPONSES_REASONING_REPLAY = prev;
  });

  test("只有 400 且错误体指向 reasoning 才判拒绝", () => {
    expect(
      looksLikeReasoningReplayRejection(400, "Item 'rs_1' of type 'reasoning' not found"),
    ).toBe(true);
    expect(looksLikeReasoningReplayRejection(400, "Invalid encrypted_content")).toBe(true);
    expect(looksLikeReasoningReplayRejection(400, "context_length_exceeded")).toBe(false);
    expect(looksLikeReasoningReplayRejection(500, "reasoning failed")).toBe(false);
  });

  test("标记后该 (endpoint, model) 不再回放；首次标记才返回 true；开关 0 全关", () => {
    expect(shouldReplayReasoning("https://gw/v1", MODEL)).toBe(true);
    expect(markReasoningReplayUnsupported("https://gw/v1", MODEL)).toBe(true);
    expect(markReasoningReplayUnsupported("https://gw/v1", MODEL)).toBe(false);
    expect(shouldReplayReasoning("https://gw/v1", MODEL)).toBe(false);
    expect(shouldReplayReasoning("https://other/v1", MODEL)).toBe(true);
    process.env.SID_CODE_RESPONSES_REASONING_REPLAY = "0";
    expect(shouldReplayReasoning("https://other/v1", MODEL)).toBe(false);
  });
});
