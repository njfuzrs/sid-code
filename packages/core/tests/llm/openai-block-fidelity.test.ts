/**
 * 消息保真：OpenAI 兼容路径的块/字段不得静默丢弃（审计第 6 条回归测试）
 *
 * 三个丢弃点：
 *   1. `redacted_thinking` 落进"未识别"→ 整块静默丢弃（分派链无此分支、无 default 兜底）
 *   2. `tool_result.is_error` 丢弃 —— **任何工具报错 + OpenAI 兼容 provider 即必现**：
 *      模型无法区分"工具成功返回这段文本"与"工具失败了，这段是错误信息"
 *   3. `tool_result.mediaBlocks` 丢弃：模型看不到图，却看到 content 说"已附上截图"
 *
 * 对照 `anthropic.ts` 的 `serializeToolResultBlock`（三字段都发），OpenAI 侧此前只取 content。
 * 修复后两条 OpenAI 家族路径（Chat Completions / Responses API）共用
 * `serializeToolResultContentForOpenAI`；`ollama.ts` 继承 OpenAIProvider 自动跟随。
 */

import { describe, test, expect } from "bun:test";
import { OpenAIProvider } from "@sid-code/core/llm/openai.ts";
import { buildResponsesRequest } from "@sid-code/core/llm/openai-responses-request.ts";
import {
  serializeToolResultContentForOpenAI,
  OPENAI_TOOL_ERROR_PREFIX,
} from "@sid-code/core/llm/openai-tool-result-content.ts";
import type { Message } from "@sid-code/core/llm/types.ts";

class TestableProvider extends OpenAIProvider {
  convert(messages: Message[]): any[] {
    return (this as any).convertMessages(messages);
  }
}

const provider = new TestableProvider("test-key", "gpt-5");

/** 一次成功的工具往返，assistant 侧先声明 tool_use（否则会被游离 tool_result 兜底丢弃） */
function toolRoundtrip(id: string, resultBlock: Record<string, unknown>): Message[] {
  return [
    { role: "assistant", content: [{ type: "tool_use", id, name: "bash", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: id, ...resultBlock } as any] },
  ];
}

describe("tool_result.is_error 不再静默丢弃", () => {
  test("is_error=true → content 带 [ERROR] 前缀（Chat Completions）", () => {
    const result = provider.convert(
      toolRoundtrip("c1", { content: "command not found: fooo", is_error: true }),
    );
    const toolMsg = result.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    expect(toolMsg.content.startsWith(OPENAI_TOOL_ERROR_PREFIX)).toBe(true);
    expect(toolMsg.content).toContain("command not found: fooo");
  });

  test("is_error 缺省 → 不加前缀（成功结果不能被误标为错误）", () => {
    const result = provider.convert(toolRoundtrip("c2", { content: "ok" }));
    const toolMsg = result.find((m) => m.role === "tool");
    expect(toolMsg.content).toBe("ok");
  });

  test("is_error=true → Responses API 的 output 同样带前缀", () => {
    const req = buildResponsesRequest(
      {
        model: "gpt-5",
        maxTokens: 100,
        messages: toolRoundtrip("c3", { content: "boom", is_error: true }),
      },
      "gpt-5",
    );
    const out = req.input.find((i: any) => i.type === "function_call_output") as any;
    expect(out).toBeDefined();
    expect(out.output.startsWith(OPENAI_TOOL_ERROR_PREFIX)).toBe(true);
  });
});

describe("tool_result.mediaBlocks 降级为文本说明而非静默丢弃", () => {
  test("含图片附件 → content 追加「看不到这些内容」的如实说明", () => {
    const result = provider.convert(
      toolRoundtrip("c4", {
        content: "已附上截图",
        mediaBlocks: [{ kind: "image", mediaType: "image/png", data: "AAAA" }],
      }),
    );
    const toolMsg = result.find((m) => m.role === "tool");
    expect(toolMsg.content).toContain("已附上截图");
    // 关键：必须如实告知模型有附件但看不到，否则模型会对着"已附上截图"空想
    expect(toolMsg.content).toContain("image/png");
    expect(toolMsg.content).toContain("你看不到这些内容");
  });

  test("无 mediaBlocks → content 不被污染（字节级不变）", () => {
    const result = provider.convert(toolRoundtrip("c5", { content: "纯文本结果" }));
    const toolMsg = result.find((m) => m.role === "tool");
    expect(toolMsg.content).toBe("纯文本结果");
  });
});

describe("redacted_thinking 不再静默消失（可观测）", () => {
  test("仅含 redacted_thinking 的 assistant 消息不崩、且不把密文塞进 content", () => {
    const result = provider.convert([
      {
        role: "assistant",
        content: [{ type: "redacted_thinking", data: "ENCRYPTED_BLOB_XYZ" }],
      },
      { role: "user", content: [{ type: "text", text: "继续" }] },
    ]);
    const assistantMsg = result.find((m) => m.role === "assistant");
    expect(assistantMsg).toBeDefined();
    // 密文不可读，不能当正文喂给模型
    expect(JSON.stringify(assistantMsg)).not.toContain("ENCRYPTED_BLOB_XYZ");
  });

  test("redacted_thinking 与正常文本混排时，文本仍完整保留", () => {
    const result = provider.convert([
      {
        role: "assistant",
        content: [
          { type: "redacted_thinking", data: "BLOB" },
          { type: "text", text: "这是答复正文" },
        ],
      },
    ]);
    const assistantMsg = result.find((m) => m.role === "assistant");
    expect(assistantMsg.content).toBe("这是答复正文");
  });
});

describe("serializeToolResultContentForOpenAI 单元契约", () => {
  test("空 content → 兜底 (empty)，满足协议非空要求", () => {
    expect(serializeToolResultContentForOpenAI({ tool_use_id: "x", content: "" }, "t")).toBe(
      "(empty)",
    );
  });

  test("空 content + is_error → 前缀 + 兜底占位", () => {
    expect(
      serializeToolResultContentForOpenAI({ tool_use_id: "x", content: "", is_error: true }, "t"),
    ).toBe(`${OPENAI_TOOL_ERROR_PREFIX}(empty)`);
  });
});
