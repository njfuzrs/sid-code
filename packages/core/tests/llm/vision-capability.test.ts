/**
 * 图片能力按模型判定（不再按 provider 一刀切）。
 *
 * 复现会话 20261009-135641-0083c051：模型 `origin-deepseek-v4-1-flash`（V4.1-Flash，官方支持图片，
 * deepseek-api.md:1831）走 OpenAI 兼容 provider，三次 Read 读图全部被降级成
 * 「当前 provider 的工具消息不支持图片/文档回传，你看不到这些内容」。真因是
 * `OpenAIProvider.capabilities().vision` 写死 false + 序列化层不看模型能力，不是模型不支持。
 */

import { describe, test, expect, afterEach } from "bun:test";
import { OpenAIProvider } from "@sid-code/core/llm/openai.ts";
import { AnthropicProvider } from "@sid-code/core/llm/anthropic.ts";
import { buildResponsesRequest } from "@sid-code/core/llm/openai-responses-request.ts";
import { resolveVisionSupport } from "@sid-code/core/llm/vision-capability.ts";
import { setModelCompat } from "@sid-code/core/llm/model-compat.ts";
import type { Message, SendParams } from "@sid-code/core/llm/types.ts";

class TestableProvider extends OpenAIProvider {
  convert(messages: Message[], model: string, alias?: string): any[] {
    return (this as any).convertMessages(messages, model, alias);
  }
}

const IMG = { kind: "image" as const, mediaType: "image/jpeg", data: "QUJD" };

/** 一次读图的工具往返（assistant 先声明 tool_use，否则会被游离 tool_result 兜底丢弃） */
function readImageRoundtrip(extraUserText?: string): Message[] {
  const user: Message = {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "r1", content: "图片 1024x788", mediaBlocks: [IMG] },
      ...(extraUserText ? [{ type: "text" as const, text: extraUserText }] : []),
    ],
  };
  return [
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "r1", name: "read", input: { file_path: "/a.jpg" } }],
    },
    user,
  ];
}

afterEach(() => setModelCompat(undefined));

describe("resolveVisionSupport：按模型三态判定", () => {
  test("会话里的真实模型名（网关 origin- 前缀）→ 支持", () => {
    expect(resolveVisionSupport("origin-deepseek-v4-1-flash")).toBe(true);
    expect(resolveVisionSupport("deepseek-flash")).toBe(true);
  });

  test("deepseek-v4-pro 官方明确不支持 → false（不是 undefined）", () => {
    expect(resolveVisionSupport("deepseek-v4-pro")).toBe(false);
  });

  test("注册表无此模型 → undefined（调用方按协议族缺省）", () => {
    expect(resolveVisionSupport("totally-unknown-model-xyz")).toBeUndefined();
  });

  test("用户 compat 声明按别名覆盖注册表（两个方向）", () => {
    setModelCompat([
      { name: "my-gw-vl", compat: { supportsVision: true } },
      { name: "my-flash-textonly", compat: { supportsVision: false } },
    ]);
    expect(resolveVisionSupport("gw-private-model", "my-gw-vl")).toBe(true);
    expect(resolveVisionSupport("deepseek-flash", "my-flash-textonly")).toBe(false);
  });

  test("snake_case 写法 supports_vision 同样生效", () => {
    setModelCompat([{ name: "a", compat: { supports_vision: true } as any }]);
    expect(resolveVisionSupport("unknown-x", "a")).toBe(true);
  });
});

describe("OpenAI Chat Completions：支持图片的模型真正发图", () => {
  const provider = new TestableProvider("k", "origin-deepseek-v4-1-flash");

  test("图片作为紧随 tool message 之后的 user 消息发出（image_url data URL）", () => {
    const out = provider.convert(readImageRoundtrip(), "origin-deepseek-v4-1-flash");
    const roles = out.map((m) => m.role);
    // tool 必须紧跟 assistant.tool_calls，图片 user 消息排在其后——插中间会打断配对 → 400
    expect(roles).toEqual(["assistant", "tool", "user"]);
    const tool = out[1];
    expect(typeof tool.content).toBe("string"); // OpenAI 规范：tool message 只允许 text
    expect(tool.content).not.toContain("你看不到这些内容");
    const user = out[2];
    const img = user.content.find((p: any) => p.type === "image_url");
    expect(img.image_url.url).toBe("data:image/jpeg;base64,QUJD");
    expect(user.content[0].type).toBe("text");
    expect(user.content[0].text).toContain("tool_call_id=r1");
  });

  test("同条 user 消息里的用户文本合进同一条 user 消息，不拆成两条", () => {
    const out = provider.convert(readImageRoundtrip("继续"), "origin-deepseek-v4-1-flash");
    expect(out.filter((m) => m.role === "user").length).toBe(1);
    const parts = out[out.length - 1].content;
    expect(parts[parts.length - 1]).toEqual({ type: "text", text: "继续" });
  });

  test("不支持图片的模型 → 仍降级为文字说明，不发 image_url", () => {
    const out = provider.convert(readImageRoundtrip(), "deepseek-v4-pro");
    expect(out.map((m) => m.role)).toEqual(["assistant", "tool"]);
    expect(out[1].content).toContain("当前模型不支持图片/文档输入");
    expect(JSON.stringify(out)).not.toContain("image_url");
  });

  test("未知模型（无任何声明）→ 缺省不发，避免 400", () => {
    const out = provider.convert(readImageRoundtrip(), "totally-unknown-model-xyz");
    expect(JSON.stringify(out)).not.toContain("image_url");
  });

  test("PDF 在 OpenAI 兼容路径无通用形态 → 即便支持图片也降级", () => {
    const msgs = readImageRoundtrip();
    (msgs[1]!.content[0] as any).mediaBlocks = [
      { kind: "document", mediaType: "application/pdf", data: "JVBE" },
    ];
    const out = provider.convert(msgs, "origin-deepseek-v4-1-flash");
    expect(out.map((m) => m.role)).toEqual(["assistant", "tool"]);
    expect(out[1].content).toContain("没有各家通用的文档输入形态");
  });

  test("无图片时消息字节级不变（不影响 prompt cache 前缀）", () => {
    const msgs: Message[] = [
      { role: "assistant", content: [{ type: "tool_use", id: "x", name: "bash", input: {} }] },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "x", content: "ok" },
          { type: "text", text: "hi" },
        ],
      },
    ];
    const out = provider.convert(msgs, "origin-deepseek-v4-1-flash");
    expect(out[1]).toEqual({ role: "tool", tool_call_id: "x", content: "ok" });
    expect(out[2]).toEqual({ role: "user", content: "hi" });
  });
});

describe("OpenAI Responses API：同一判定", () => {
  test("支持图片 → function_call_output 之后追加 input_image 的 user item", () => {
    const req = buildResponsesRequest(
      { model: "gpt-4.1", maxTokens: 10, messages: readImageRoundtrip() },
      "gpt-4.1",
    );
    const idxOut = req.input.findIndex((i: any) => i.type === "function_call_output");
    const after = req.input[idxOut + 1] as any;
    expect(after.role).toBe("user");
    expect(after.content.some((p: any) => p.type === "input_image")).toBe(true);
  });

  test("不支持 → 无 input_image", () => {
    const req = buildResponsesRequest(
      { model: "totally-unknown-model-xyz", maxTokens: 10, messages: readImageRoundtrip() },
      "totally-unknown-model-xyz",
    );
    expect(JSON.stringify(req)).not.toContain("input_image");
  });
});

describe("Anthropic：缺省照旧发图，显式不支持才降级", () => {
  async function captureBody(model: string): Promise<any> {
    const provider = new AnthropicProvider("k", model);
    let body: any;
    (provider as any).client.messages.create = (b: any) => {
      body = b;
      throw new Error("stop");
    };
    const params: SendParams = { model, maxTokens: 10, messages: readImageRoundtrip() };
    try {
      for await (const _ of provider.sendMessageStream(params)) {
        /* drain */
      }
    } catch {
      /* 请求体已捕获 */
    }
    return body;
  }

  test("Claude → tool_result 带 image 块", async () => {
    const body = await captureBody("claude-opus-4-8");
    const tr = body.messages[1].content[0];
    expect(Array.isArray(tr.content)).toBe(true);
    expect(tr.content.some((p: any) => p.type === "image")).toBe(true);
  });

  test("deepseek-v4-pro（经 Anthropic 兼容端点）→ 降级为文字，不发 image", async () => {
    const body = await captureBody("deepseek-v4-pro");
    const tr = body.messages[1].content[0];
    expect(typeof tr.content).toBe("string");
    expect(tr.content).toContain("当前模型不支持图片/文档输入");
  });
});
