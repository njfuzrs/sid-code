/**
 * T11.4：OpenAI Responses API 解析器 — VCR 回放测试
 *
 * 从 fixture 还原 Responses API SSE 字节流，验证解析器输出的 StreamEvent 结构正确。
 *
 * 覆盖场景：
 *   - responses-normal-text：文本累积 + usage + stop_reason
 *   - responses-tool-call：function_call 块 + 参数 JSON 拼接
 *   - responses-error：response.failed 事件映射
 *
 * fix_type: case_design
 */

import { describe, test, expect } from "bun:test";
import { parseResponsesStream, isResponsesContentProgress } from "../../src/llm/openai-responses.ts";
import type { StreamEvent } from "../../src/llm/types.ts";

// ─── 辅助：从 VCR fixture 构建 ReadableStream ───

interface VcrChunk {
  data: string;
  delayMs: number;
}

interface VcrFixture {
  description: string;
  response: {
    status: number;
    headers: Record<string, string>;
    chunks: VcrChunk[];
  };
}

function loadFixture(name: string): VcrFixture {
  const path = `${import.meta.dir}/../fixtures/vcr/${name}.json`;
  return JSON.parse(require("fs").readFileSync(path, "utf-8"));
}

function buildStream(chunks: VcrChunk[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      for (const chunk of chunks) {
        if (chunk.delayMs > 0) {
          await new Promise((r) => setTimeout(r, chunk.delayMs));
        }
        controller.enqueue(encoder.encode(chunk.data));
      }
      controller.close();
    },
  });
}

/** 收集所有 StreamEvent */
async function collectEvents(stream: ReadableStream<Uint8Array>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of parseResponsesStream(stream)) {
    events.push(event);
  }
  return events;
}

// ─── 测试 ───

describe("T11 Responses API 解析器", () => {
  describe("正常文本流", () => {
    test("完整事件序列：message_start → text deltas → content_block_stop → message_stop", async () => {
      const fixture = loadFixture("responses-normal-text");
      const stream = buildStream(fixture.response.chunks);
      const events = await collectEvents(stream);

      // 应有 message_start
      const starts = events.filter((e) => e.type === "message_start");
      expect(starts.length).toBe(1);

      // 应有 content_block_start (text)
      const blockStarts = events.filter((e) => e.type === "content_block_start");
      expect(blockStarts.length).toBe(1);
      expect((blockStarts[0] as any).content_block.type).toBe("text");

      // 文本增量拼接
      const textDeltas = events
        .filter((e) => e.type === "content_block_delta" && (e as any).delta?.type === "text_delta")
        .map((e) => (e as any).delta.text);
      expect(textDeltas.join("")).toBe("Hello there!");

      // content_block_stop
      const blockStops = events.filter((e) => e.type === "content_block_stop");
      expect(blockStops.length).toBe(1);

      // message_delta (stop_reason)
      const msgDelta = events.find((e) => e.type === "message_delta") as any;
      expect(msgDelta).toBeDefined();
      expect(msgDelta.delta.stop_reason).toBe("end_turn");

      // usage
      expect(msgDelta.usage.inputTokens).toBe(8);
      expect(msgDelta.usage.outputTokens).toBe(4);

      // message_stop
      expect(events.some((e) => e.type === "message_stop")).toBe(true);
    });

    test("isResponsesContentProgress 对 text delta 返回 true", async () => {
      const fixture = loadFixture("responses-normal-text");
      const stream = buildStream(fixture.response.chunks);
      const events = await collectEvents(stream);

      const textDelta = events.find(
        (e) => e.type === "content_block_delta" && (e as any).delta?.type === "text_delta",
      )!;
      expect(isResponsesContentProgress(textDelta)).toBe(true);

      // message_start 不是 content progress
      const msgStart = events.find((e) => e.type === "message_start")!;
      expect(isResponsesContentProgress(msgStart)).toBe(false);
    });
  });

  describe("工具调用流", () => {
    test("function_call：tool_use block + 参数 JSON 拼接", async () => {
      const fixture = loadFixture("responses-tool-call");
      const stream = buildStream(fixture.response.chunks);
      const events = await collectEvents(stream);

      // content_block_start 应有 tool_use 类型
      const blockStarts = events.filter((e) => e.type === "content_block_start");
      expect(blockStarts.length).toBe(1);
      const toolBlock = blockStarts[0] as any;
      expect(toolBlock.content_block.type).toBe("tool_use");
      expect(toolBlock.content_block.name).toBe("get_weather");
      expect(toolBlock.content_block.id).toBe("call_abc123");

      // input_json_delta 拼接
      const jsonDeltas = events
        .filter((e) => e.type === "content_block_delta" && (e as any).delta?.type === "input_json_delta")
        .map((e) => (e as any).delta.partial_json);
      const fullArgs = jsonDeltas.join("");
      expect(fullArgs).toBe("{\"location\":\"Tokyo\"}");

      // usage
      const msgDelta = events.find((e) => e.type === "message_delta") as any;
      expect(msgDelta.usage.inputTokens).toBe(25);
      expect(msgDelta.usage.outputTokens).toBe(12);

      // message_stop
      expect(events.some((e) => e.type === "message_stop")).toBe(true);
    });
  });

  describe("错误处理", () => {
    test("response.failed → error event", async () => {
      const errorChunks: VcrChunk[] = [
        { data: "event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_err\",\"status\":\"in_progress\"},\"sequence_number\":0}\n\n", delayMs: 0 },
        { data: "event: response.failed\ndata: {\"type\":\"response.failed\",\"response\":{\"id\":\"resp_err\",\"status\":\"failed\"},\"error\":{\"message\":\"Rate limit exceeded\",\"code\":\"rate_limit\"},\"sequence_number\":1}\n\n", delayMs: 50 },
      ];

      const stream = buildStream(errorChunks);
      const events = await collectEvents(stream);

      const errorEvent = events.find((e) => e.type === "error") as any;
      expect(errorEvent).toBeDefined();
      expect(errorEvent.error.message).toBe("Rate limit exceeded");
    });

    test("response.incomplete → stop_reason max_tokens", async () => {
      const incompleteChunks: VcrChunk[] = [
        { data: "event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_inc\",\"status\":\"in_progress\"},\"sequence_number\":0}\n\n", delayMs: 0 },
        { data: "event: response.output_item.added\ndata: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"id\":\"item_inc\",\"type\":\"message\",\"role\":\"assistant\"},\"sequence_number\":1}\n\n", delayMs: 10 },
        { data: "event: response.content_part.added\ndata: {\"type\":\"response.content_part.added\",\"item_id\":\"item_inc\",\"output_index\":0,\"content_index\":0,\"part\":{\"type\":\"output_text\",\"text\":\"\"},\"sequence_number\":2}\n\n", delayMs: 10 },
        { data: "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"item_id\":\"item_inc\",\"output_index\":0,\"content_index\":0,\"delta\":\"Partial\",\"sequence_number\":3}\n\n", delayMs: 30 },
        { data: "event: response.incomplete\ndata: {\"type\":\"response.incomplete\",\"response\":{\"id\":\"resp_inc\",\"status\":\"incomplete\"},\"sequence_number\":4}\n\n", delayMs: 10 },
      ];

      const stream = buildStream(incompleteChunks);
      const events = await collectEvents(stream);

      // 应有 text delta
      const textDeltas = events.filter(
        (e) => e.type === "content_block_delta" && (e as any).delta?.type === "text_delta",
      );
      expect(textDeltas.length).toBe(1);
      expect((textDeltas[0] as any).delta.text).toBe("Partial");

      // stop_reason = max_tokens
      const msgDelta = events.find((e) => e.type === "message_delta") as any;
      expect(msgDelta).toBeDefined();
      expect(msgDelta.delta.stop_reason).toBe("max_tokens");

      // message_stop
      expect(events.some((e) => e.type === "message_stop")).toBe(true);
    });
  });

  describe("abort 处理", () => {
    test("signal abort → 流消费提前终止", async () => {
      const abortCtl = new AbortController();

      // 构造一个慢流
      const slowChunks: VcrChunk[] = [
        { data: "event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_slow\",\"status\":\"in_progress\"},\"sequence_number\":0}\n\n", delayMs: 0 },
        { data: "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"A\",\"sequence_number\":1}\n\n", delayMs: 200 },
        { data: "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"B\",\"sequence_number\":2}\n\n", delayMs: 200 },
        { data: "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_slow\",\"status\":\"completed\",\"usage\":{\"input_tokens\":5,\"output_tokens\":2,\"total_tokens\":7}},\"sequence_number\":3}\n\n", delayMs: 100 },
      ];

      const stream = buildStream(slowChunks);

      // 50ms 后 abort
      setTimeout(() => abortCtl.abort(), 50);

      const events: StreamEvent[] = [];
      for await (const event of parseResponsesStream(stream, abortCtl.signal)) {
        events.push(event);
      }

      // 不应收到所有事件（abort 在第一个 delta 之前或期间生效）
      expect(events.length).toBeLessThan(5);
    });
  });

  describe("SSE 边界条件", () => {
    test("空 data 和注释行被正确忽略", async () => {
      const edgeCaseChunks: VcrChunk[] = [
        { data: ": keep-alive\n\n", delayMs: 0 },
        { data: "event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_edge\",\"status\":\"in_progress\"},\"sequence_number\":0}\n\n", delayMs: 10 },
        { data: ": another keep-alive\n\n", delayMs: 10 },
        { data: "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"OK\",\"sequence_number\":1}\n\n", delayMs: 10 },
        { data: "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_edge\",\"status\":\"completed\",\"usage\":{\"input_tokens\":3,\"output_tokens\":1,\"total_tokens\":4}},\"sequence_number\":2}\n\n", delayMs: 5 },
      ];

      const stream = buildStream(edgeCaseChunks);
      const events = await collectEvents(stream);

      // 注释行不产生事件
      const textDeltas = events.filter(
        (e) => e.type === "content_block_delta" && (e as any).delta?.type === "text_delta",
      );
      expect(textDeltas.length).toBe(1);
      expect((textDeltas[0] as any).delta.text).toBe("OK");

      // 最终正确完成
      expect(events.some((e) => e.type === "message_stop")).toBe(true);
    });

    test("[DONE] sentinel 被正确处理", async () => {
      const doneChunks: VcrChunk[] = [
        { data: "event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_done\",\"status\":\"in_progress\"},\"sequence_number\":0}\n\n", delayMs: 0 },
        { data: "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_done\",\"status\":\"completed\",\"usage\":{\"input_tokens\":2,\"output_tokens\":1,\"total_tokens\":3}},\"sequence_number\":1}\n\n", delayMs: 10 },
        { data: "data: [DONE]\n\n", delayMs: 5 },
      ];

      const stream = buildStream(doneChunks);
      const events = await collectEvents(stream);

      // [DONE] 不产生事件，不报错
      expect(events.some((e) => e.type === "message_stop")).toBe(true);
      expect(events.every((e) => e.type !== "error")).toBe(true);
    });
  });

  /**
   * P0-1 回归：Responses API 的缓存命中与 reasoning token 必须被提取。
   *
   * 历史缺陷（2026-08-08 修复）：`ResponseObject.usage` 只声明了
   * input/output/total 三个字段，映射处也只读这三个 —— 整个 openai-responses 族
   * 11 个模型的 `input_tokens_details.cached_tokens` 与
   * `output_tokens_details.reasoning_tokens` 全部漏采。luna 账本记 2.2%，
   * 而同一渠道实测真实命中 95.2%（17152/18017），差距全部来自采集缺陷。
   *
   * 断言用**真实实测形状**（自建网关 POST /responses 的原始 usage），
   * 不手抄一个理想化的 mock。
   */
  describe("P0-1 usage 提取：缓存命中 + reasoning（Responses 形状）", () => {
    /** 构造一个只含 created + completed 的最小流，usage 由调用方给全 */
    function usageOnlyStream(usage: Record<string, unknown>): ReadableStream<Uint8Array> {
      return buildStream([
        { data: `event: response.created\ndata: {"type":"response.created","response":{"id":"resp_u","status":"in_progress"},"sequence_number":0}\n\n`, delayMs: 0 },
        { data: `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "resp_u", status: "completed", usage }, sequence_number: 1 })}\n\n`, delayMs: 1 },
      ]);
    }

    async function finalUsage(usage: Record<string, unknown>): Promise<any> {
      const events = await collectEvents(usageOnlyStream(usage));
      const delta = events.find((e) => e.type === "message_delta") as any;
      expect(delta).toBeDefined();
      return delta.usage;
    }

    test("input_tokens_details.cached_tokens → cacheReadInputTokens（luna 实测形状）", async () => {
      const u = await finalUsage({
        input_tokens: 18017,
        input_tokens_details: { cached_tokens: 17152 },
        output_tokens: 64,
        total_tokens: 18081,
      });
      expect(u.inputTokens).toBe(18017);
      expect(u.outputTokens).toBe(64);
      expect(u.cacheReadInputTokens).toBe(17152);
    });

    test("output_tokens_details.reasoning_tokens → reasoningTokens", async () => {
      const u = await finalUsage({
        input_tokens: 100,
        output_tokens: 500,
        output_tokens_details: { reasoning_tokens: 448 },
      });
      expect(u.reasoningTokens).toBe(448);
      // reasoning 是 output 的子集，不得叠加进 outputTokens
      expect(u.outputTokens).toBe(500);
    });

    test("两个维度同时出现时都被提取", async () => {
      const u = await finalUsage({
        input_tokens: 18017,
        input_tokens_details: { cached_tokens: 17152 },
        output_tokens: 500,
        output_tokens_details: { reasoning_tokens: 448 },
      });
      expect(u.cacheReadInputTokens).toBe(17152);
      expect(u.reasoningTokens).toBe(448);
    });

    test("cached=0（r1 冷启动）不落误导值，字段保持 undefined", async () => {
      const u = await finalUsage({
        input_tokens: 18017,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 64,
      });
      // 0 与"网关未透传"无法区分，故不落 0；命中率计算侧按 undefined→0 处理
      expect(u.cacheReadInputTokens).toBeUndefined();
      expect(u.inputTokens).toBe(18017);
    });

    test("缺 details 字段（老网关/非思考模型）不抛错", async () => {
      const u = await finalUsage({ input_tokens: 8, output_tokens: 4, total_tokens: 12 });
      expect(u.inputTokens).toBe(8);
      expect(u.cacheReadInputTokens).toBeUndefined();
      expect(u.reasoningTokens).toBeUndefined();
    });
  });
});
