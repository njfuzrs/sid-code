/**
 * sub_agent 类型字段别名回归测试（2026-11-03 会话 20261103-114056-3b4f9ca7）
 *
 * 事故形态：模型按 Claude Code 命名传 `subagent_type: "explore"`，schema 字段却是 `type`。
 * 1) isConcurrencySafe 读不到 type → 同一轮 3 个 explore 被分进串行批次（4 分钟 × 3 首尾相接）；
 * 2) execute 兜底成 general-purpose → 只读边界失效；
 * 3) 权限层 subagent_type 优先、执行层只读 type，两字段不一致时判与跑的不是同一个类型。
 *
 * 每条断言都对应一处取值点，摘掉 resolveSubAgentTypeParam 改回 `input.type` 即变红。
 */

import { describe, test, expect } from "bun:test";
import { SubAgentTool } from "@sid-code/core/agent/tool.ts";
import { resolveSubAgentTypeParam } from "@sid-code/core/agent/sub-agent-input.ts";
import { partitionToolCalls } from "@sid-code/core/query/tool-orchestration.ts";
import { extractMatchValue } from "@sid-code/core/permission/rules.ts";
import { Registry } from "@sid-code/core/tool/registry.ts";
import { validateToolInput } from "@sid-code/core/tool/input-validator.ts";
import type { Provider } from "@sid-code/core/llm/provider.ts";
import type { ProviderRegistry } from "@sid-code/core/llm/registry.ts";
import type { SendParams, StreamEvent } from "@sid-code/core/llm/types.ts";

class TextProvider implements Provider {
  name() {
    return "mock";
  }
  defaultModel() {
    return "mock-model";
  }
  async *sendMessageStream(_p: SendParams): AsyncIterable<StreamEvent> {
    yield {
      type: "message_start",
      message: { id: "m", role: "assistant", usage: { inputTokens: 1, outputTokens: 0 } },
    } as StreamEvent;
    yield {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    } as StreamEvent;
    yield {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "ok" },
    } as StreamEvent;
    yield { type: "content_block_stop", index: 0 } as StreamEvent;
    yield {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { outputTokens: 1 },
    } as StreamEvent;
  }
}

function registry(provider: Provider): ProviderRegistry {
  return {
    getProvider: () => provider,
    getProviderFor: () => provider,
    getCurrentModel: () => "test-model",
    getModelForSubAgent: () => "test-model",
    getLanguage: () => "zh" as const,
    getProviderForSubAgent: () => provider,
    getProviderForModelName: () => provider,
    clearCache: () => {},
  } as unknown as ProviderRegistry;
}

describe("resolveSubAgentTypeParam", () => {
  test("type 优先，其次 subagent_type，再次 agentType", () => {
    expect(resolveSubAgentTypeParam({ type: "plan", subagent_type: "explore" })).toBe("plan");
    expect(resolveSubAgentTypeParam({ subagent_type: "explore" })).toBe("explore");
    expect(resolveSubAgentTypeParam({ agentType: "verify" })).toBe("verify");
  });
  test("空串/非字符串/非对象视为未提供", () => {
    expect(resolveSubAgentTypeParam({ type: "", subagent_type: "explore" })).toBe("explore");
    expect(resolveSubAgentTypeParam({ type: 1 })).toBeUndefined();
    expect(resolveSubAgentTypeParam(null)).toBeUndefined();
    expect(resolveSubAgentTypeParam("explore")).toBeUndefined();
  });
});

describe("并发分区认 subagent_type", () => {
  const tool = new SubAgentTool({} as any, {} as any);

  test("subagent_type=explore 判为并发安全", () => {
    expect(
      tool.isConcurrencySafe({ subagent_type: "explore", description: "d", prompt: "p" }),
    ).toBe(true);
  });

  test("同一轮 3 个 subagent_type=explore 合成一个并行批次（事故原样复现）", () => {
    const items = [0, 1, 2].map((idx) => ({
      idx,
      tool: tool as any,
      block: {
        type: "tool_use",
        id: `c${idx}`,
        name: "sub_agent",
        input: { description: `d${idx}`, subagent_type: "explore", prompt: "p" },
      } as any,
    }));
    const batches = partitionToolCalls(items);
    expect(batches.length).toBe(1);
    expect(batches[0].isConcurrencySafe).toBe(true);
    expect(batches[0].items.length).toBe(3);
  });

  test("写类类型仍串行：subagent_type=general-purpose 不并发", () => {
    expect(tool.isConcurrencySafe({ subagent_type: "general-purpose" })).toBe(false);
  });
});

describe("execute 按 subagent_type 实际运行", () => {
  test("subagent_type=explore 以 explore 身份运行，而不是兜底 general-purpose", async () => {
    SubAgentTool.running = 0;
    const tool = new SubAgentTool(registry(new TextProvider()), new Registry());
    const input: Record<string, unknown> = {
      subagent_type: "explore",
      description: "别名测试",
      prompt: "测试",
    };
    const result = await tool.execute(input);
    expect(result.isError).toBe(false);
    expect(input.type).toBe("explore");
    // 归一化后别名字段被删掉，下游只看到 type 一个名字
    expect("subagent_type" in input).toBe(false);
    SubAgentTool.running = 0;
  });

  test("subagent_type 写了无效类型时报错，而不是静默兜底", async () => {
    SubAgentTool.running = 0;
    const tool = new SubAgentTool(registry(new TextProvider()), new Registry());
    const result = await tool.execute({ subagent_type: "nope", description: "d", prompt: "p" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("无效的子代理类型");
    SubAgentTool.running = 0;
  });
});

describe("权限层与执行层取同一个类型", () => {
  test("两字段冲突时权限按 type 判（即实际会运行的类型）", () => {
    const v = extractMatchValue({
      toolName: "sub_agent",
      input: { type: "general-purpose", subagent_type: "explore" },
    } as any);
    expect(v).toBe("general-purpose");
  });
  test("只给 subagent_type 时权限照样认得", () => {
    expect(
      extractMatchValue({ toolName: "sub_agent", input: { subagent_type: "explore" } } as any),
    ).toBe("explore");
  });
});

// 真实入口：执行器在 execute 之前先过 validateToolInput（zod safeParse）。
// 首版修复只在 execute 里认别名，单测直接调 execute 全绿；但端到端里 zod 先把未声明的
// subagent_type 剥掉，execute 拿到的入参已经没有它 → 仍兜底 general-purpose，
// 而分区读原始入参判成可并发——写类子代理被并行执行（2026-11-03 sc 端到端实测）。
describe("真实入口：zod 校验不剥离 subagent_type", () => {
  const tool = new SubAgentTool({} as any, {} as any);

  test("subagent_type 经校验后变成 type，类型不丢", () => {
    const v = validateToolInput(tool as any, {
      subagent_type: "explore",
      description: "d",
      prompt: "p",
    });
    expect(v.ok).toBe(true);
    const data = (v as { ok: true; data: Record<string, unknown> }).data;
    expect(data.type).toBe("explore");
    expect("subagent_type" in data).toBe(false);
  });

  test("分区判定与执行入参一致：校验后的入参仍判为并发安全", () => {
    const v = validateToolInput(tool as any, {
      subagent_type: "explore",
      description: "d",
      prompt: "p",
    });
    expect(tool.isConcurrencySafe((v as { ok: true; data: unknown }).data)).toBe(true);
  });

  test("两字段同时出现时保留正式字段 type", () => {
    const v = validateToolInput(tool as any, {
      type: "general-purpose",
      subagent_type: "explore",
      description: "d",
      prompt: "p",
    });
    expect((v as { ok: true; data: Record<string, unknown> }).data.type).toBe("general-purpose");
  });
});
