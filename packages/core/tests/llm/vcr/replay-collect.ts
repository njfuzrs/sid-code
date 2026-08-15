/**
 * VCR 回放的**共享归一化采集器** — replay-collect.ts（PR-1）
 *
 * § 为什么需要它
 * 三个协议族的 StreamEvent 形状**刻意不同**（这是协议差异，不是 bug）：
 *   - `usage` 的下发时机：Anthropic 在 `message_start` 就给完整 usage，OpenAI 族在流**尾部**给；
 *   - `usage` 的语义：Anthropic 的 `message_delta.usage.output_tokens` 是**累积值**，
 *     provider 内部转成**增量**再 yield（`anthropic.ts:610-621`）；OpenAI 族直接给全量对象；
 *   - `thinking` 的载体：Anthropic 是 `thinking_delta`（被 provider 转成 `text_delta` +
 *     `_raw_block:{type:"thinking"}`），Responses 族是 `reasoning_summary_text.delta`。
 *
 * 所以「跨 provider parity」**不能**按事件序列逐一比对——那只会把协议差异当成缺陷报出来。
 * 正确的比对面是**下游真正消费的那层**：文本、思考文本、工具调用、`stopReason`、
 * 以及**经 `accumulateUsage` 累加后**的 usage。本模块就是那一层的唯一实现。
 *
 * § 为什么不复用 vcr-replay.test.ts 里的 replayAndCollect
 * 那个函数写在 test 文件里、且只认 OpenAI 一族（硬编码 `new OpenAIProvider`）。
 * 抽到这里并支持三族，是为了避免「两条路径各写一份提取逻辑」——
 * `openai-usage.ts` 文件头记的正是那个形态的真实事故（Responses 路径漏采整族 cache 字段）。
 */

import { OpenAIProvider } from "@sid-code/core/llm/openai.ts";
import { AnthropicProvider } from "@sid-code/core/llm/anthropic.ts";
import type { SendParams, StreamEvent, Usage } from "@sid-code/core/llm/types.ts";
import { accumulateUsage } from "@sid-code/core/llm/types.ts";
import { installFetchFromFixture, loadFixtureByName, type VcrFixture } from "./vcr.ts";

/** 归一化后的回放结果——三个协议族在这一层必须可比。 */
export interface ReplayResult {
  /** 正文文本（不含 thinking） */
  text: string;
  /** 思考 / 推理文本（Anthropic thinking_delta 与 Responses reasoning summary 都归到这里） */
  thinking: string;
  /** 工具调用：name + 拼接完整的参数 JSON 字符串 */
  toolCalls: Array<{ name: string; argsJson: string }>;
  /** 归一化 stopReason（`mapFinishReason` / Anthropic 原值 / Responses 映射后的值） */
  stopReason: string | null;
  /** 经 accumulateUsage 累加后的 usage —— 唯一可跨族比对的 usage 口径 */
  usage: Usage;
  /** 流内 error 事件的 message（无则 null） */
  errorMessage: string | null;
  /** 原始事件序列（供协议专属断言用；parity 断言**不该**直接比它） */
  events: StreamEvent[];
}

/** 协议族。决定用哪个 provider + 是否需要 env 强制走 Responses。 */
export type ProtocolFamily = "anthropic-messages" | "openai-chat" | "openai-responses";

const BASE_PARAMS = (model: string): SendParams => ({
  model,
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  maxTokens: 100,
});

/**
 * 消费 provider 的流，聚合成 {@link ReplayResult}。
 *
 * thinking 的识别方式**必须**按 `_raw_block` 而不是 delta 类型：Anthropic provider 把
 * `thinking_delta` 转成了 `text_delta`（`anthropic.ts:555-561`），只看 delta 类型分不出
 * 正文与思考——这正是 `vcr-replay.test.ts:41-43` 已经踩过并注释过的点。
 */
async function collect(stream: AsyncIterable<StreamEvent>): Promise<ReplayResult> {
  const events: StreamEvent[] = [];
  let text = "";
  let thinking = "";
  let stopReason: string | null = null;
  let errorMessage: string | null = null;
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  const thinkingIdx = new Set<number>();
  /** index → { name, argsJson }，用 Map 保序且支持并行工具的交错到达 */
  const tools = new Map<number, { name: string; argsJson: string }>();

  for await (const ev of stream) {
    events.push(ev);
    const e = ev as any;
    switch (ev.type) {
      case "message_start":
        accumulateUsage(usage, e.message?.usage);
        break;
      case "content_block_start": {
        const blk = e.content_block;
        if (e._raw_block?.type === "thinking" || blk?.type === "thinking") {
          thinkingIdx.add(e.index);
        }
        if (blk?.type === "tool_use") {
          tools.set(e.index, { name: blk.name, argsJson: "" });
        }
        break;
      }
      case "content_block_delta": {
        const d = e.delta;
        if (d?.type === "text_delta") {
          if (thinkingIdx.has(e.index)) thinking += d.text;
          else text += d.text;
        } else if (d?.type === "thinking_delta") {
          // 防御：若将来 provider 不再把 thinking_delta 转成 text_delta，这里仍能采到
          thinking += d.thinking ?? "";
        } else if (d?.type === "input_json_delta") {
          const t = tools.get(e.index);
          if (t) t.argsJson += d.partial_json ?? "";
        }
        break;
      }
      case "message_delta":
        if (e.delta?.stop_reason) stopReason = e.delta.stop_reason;
        accumulateUsage(usage, e.usage);
        break;
      case "message_stop":
        accumulateUsage(usage, e.usage);
        break;
      case "error":
        errorMessage = e.error?.message ?? "unknown";
        break;
    }
  }

  return {
    text,
    thinking,
    toolCalls: [...tools.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v),
    stopReason,
    usage,
    errorMessage,
    events,
  };
}

/**
 * 从夹具回放一次完整请求，返回归一化结果。
 *
 * `openai-responses` 族靠 `SID_CODE_OPENAI_PROTOCOL=responses`（`openai.ts:1111` 的
 * 优先级 1）强制走 `/responses` 路径——刻意用这个 env 而不是依赖模型名启发式：
 * 启发式将来会改，env 开关是稳定契约。**用完必须恢复原值**（`bun test` 同批
 * 多文件跑在同一进程里，无条件 delete 会污染别的测试）。
 */
export async function replayFixture(
  fileName: string,
  family: ProtocolFamily,
): Promise<ReplayResult> {
  const fx: VcrFixture = loadFixtureByName(fileName);
  const model = fx.model ?? fx.request?.model ?? "gpt-4o-mini";
  const restoreFetch = installFetchFromFixture(fx);
  const prevProtocol = process.env.SID_CODE_OPENAI_PROTOCOL;

  try {
    if (family === "anthropic-messages") {
      const p = new AnthropicProvider("test-key", model);
      return await collect(p.sendMessageStream(BASE_PARAMS(model)));
    }
    // 两条 OpenAI 路径共用 OpenAIProvider，只是协议分派不同
    process.env.SID_CODE_OPENAI_PROTOCOL = family === "openai-responses" ? "responses" : "chat";
    const p = new OpenAIProvider("test-key", model);
    return await collect(p.sendMessageStream(BASE_PARAMS(model)));
  } finally {
    restoreFetch();
    if (prevProtocol === undefined) delete process.env.SID_CODE_OPENAI_PROTOCOL;
    else process.env.SID_CODE_OPENAI_PROTOCOL = prevProtocol;
  }
}
