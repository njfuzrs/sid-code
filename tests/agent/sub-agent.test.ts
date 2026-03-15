/**
 * 子代理系统测试
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Registry } from "../../src/tool/registry.ts";
import { SubAgent } from "../../src/agent/sub-agent.ts";
import { SubAgentTool } from "../../src/agent/tool.ts";
import type { Tool, ToolResult } from "../../src/tool/types.ts";
import type { Provider } from "../../src/llm/provider.ts";
import type { ProviderRegistry } from "../../src/llm/registry.ts";
import type { SendParams, StreamEvent } from "../../src/llm/types.ts";

/** Mock 工具 */
class MockTool implements Tool {
  constructor(private _name: string, private _readOnly: boolean = false) {}
  name() { return this._name; }
  description() { return `Mock tool: ${this._name}`; }
  inputSchema() { return { type: "object", properties: {} }; }
  readOnly() { return this._readOnly; }
  async execute(): Promise<ToolResult> { return { output: "ok" }; }
}

/** Mock Provider：返回简单文本响应 */
class MockProvider implements Provider {
  name() { return "mock"; }
  defaultModel() { return "mock-model"; }

  async *sendMessageStream(_params: SendParams, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    yield {
      type: "message_start",
      message: { id: "msg_1", role: "assistant", usage: { inputTokens: 10, outputTokens: 0 } },
    } as StreamEvent;

    yield {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    } as StreamEvent;

    yield {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "测试响应" },
    } as StreamEvent;

    yield {
      type: "content_block_stop",
      index: 0,
    } as StreamEvent;

    yield {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { outputTokens: 5 },
    } as StreamEvent;
  }
}

/** 会阻塞直到 signal abort 的 Provider */
class HangingProvider implements Provider {
  name() { return "hanging"; }
  defaultModel() { return "hanging-model"; }

  async *sendMessageStream(_params: SendParams, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    // 等待很长时间，只有 abort 能打断
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 60_000);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new DOMException("The operation was aborted", "AbortError"));
      });
    });
    // 不会执行到这里
    yield {} as StreamEvent;
  }
}

/** 创建 MockProviderRegistry */
function mockProviderRegistry(provider: Provider, model: string = "test-model"): ProviderRegistry {
  return {
    getProvider: () => provider,
    getProviderFor: () => provider,
    getCurrentModel: () => model,
    getModelForSubAgent: () => model,
    getProviderForSubAgent: () => provider,
    clearCache: () => {},
  } as unknown as ProviderRegistry;
}

// 每个测试后重置静态计数器
afterEach(() => {
  SubAgent.depth = 0;
  SubAgentTool.running = 0;
});

// ─── Registry.filter() ───

describe("Registry.filter()", () => {
  test("过滤后只包含指定工具", () => {
    const reg = new Registry();
    reg.register(new MockTool("read", true));
    reg.register(new MockTool("write"));
    reg.register(new MockTool("grep", true));
    reg.register(new MockTool("bash"));

    const filtered = reg.filter(["read", "grep"]);
    expect(filtered.size()).toBe(2);
    expect(filtered.get("read")).toBeDefined();
    expect(filtered.get("grep")).toBeDefined();
    expect(filtered.get("write")).toBeUndefined();
    expect(filtered.get("bash")).toBeUndefined();
  });

  test("过滤不存在的工具名时忽略", () => {
    const reg = new Registry();
    reg.register(new MockTool("read"));

    const filtered = reg.filter(["read", "nonexistent"]);
    expect(filtered.size()).toBe(1);
    expect(filtered.get("read")).toBeDefined();
  });

  test("空白名单返回空 Registry", () => {
    const reg = new Registry();
    reg.register(new MockTool("read"));

    const filtered = reg.filter([]);
    expect(filtered.size()).toBe(0);
  });

  test("filter 返回新实例，不影响原 Registry", () => {
    const reg = new Registry();
    reg.register(new MockTool("read"));
    reg.register(new MockTool("write"));

    const filtered = reg.filter(["read"]);
    expect(reg.size()).toBe(2);
    expect(filtered.size()).toBe(1);
  });
});

// ─── 工具白名单 ───

describe("SubAgent 工具白名单", () => {
  let provider: Provider;
  let toolRegistry: Registry;

  beforeEach(() => {
    provider = new MockProvider();
    toolRegistry = new Registry();
    toolRegistry.register(new MockTool("read", true));
    toolRegistry.register(new MockTool("write"));
    toolRegistry.register(new MockTool("edit"));
    toolRegistry.register(new MockTool("bash"));
    toolRegistry.register(new MockTool("grep", true));
    toolRegistry.register(new MockTool("glob", true));
  });

  test("explore 类型正常执行", async () => {
    const agent = new SubAgent(provider, "test-model", toolRegistry);
    const result = await agent.execute({
      type: "explore",
      description: "测试探索",
      prompt: "搜索代码",
    });
    expect(result.success).toBe(true);
    expect(result.turns).toBeGreaterThan(0);
  });

  test("task 类型正常执行", async () => {
    const agent = new SubAgent(provider, "test-model", toolRegistry);
    const result = await agent.execute({
      type: "task",
      description: "测试任务",
      prompt: "执行任务",
    });
    expect(result.success).toBe(true);
  });

  test("plan 类型正常执行", async () => {
    const agent = new SubAgent(provider, "test-model", toolRegistry);
    const result = await agent.execute({
      type: "plan",
      description: "测试规划",
      prompt: "分析代码",
    });
    expect(result.success).toBe(true);
  });

  test("summarize 类型正常执行（无工具）", async () => {
    const agent = new SubAgent(provider, "test-model", toolRegistry);
    const result = await agent.execute({
      type: "summarize",
      description: "测试总结",
      prompt: "总结内容",
    });
    expect(result.success).toBe(true);
  });
});

// ─── 嵌套防护 ───

describe("SubAgent 嵌套防护", () => {
  test("深度超限时拒绝执行", async () => {
    const provider = new MockProvider();
    const toolRegistry = new Registry();
    const agent = new SubAgent(provider, "test-model", toolRegistry);

    SubAgent.depth = 1; // 模拟已在子代理内

    const result = await agent.execute({
      type: "explore",
      description: "嵌套测试",
      prompt: "测试",
    });

    expect(result.success).toBe(false);
    expect(result.output).toContain("不允许嵌套");
    expect(result.turns).toBe(0);
  });

  test("正常调用后深度计数器归零", async () => {
    const provider = new MockProvider();
    const toolRegistry = new Registry();
    const agent = new SubAgent(provider, "test-model", toolRegistry);

    expect(SubAgent.depth).toBe(0);
    await agent.execute({ type: "explore", description: "测试", prompt: "测试" });
    expect(SubAgent.depth).toBe(0);
  });

  test("异常时深度计数器也能归零", async () => {
    // Provider 抛异常
    class ErrorProvider implements Provider {
      name() { return "error"; }
      defaultModel() { return "error-model"; }
      async *sendMessageStream(): AsyncIterable<StreamEvent> {
        throw new Error("模拟错误");
      }
    }

    const agent = new SubAgent(new ErrorProvider(), "test-model", new Registry());
    expect(SubAgent.depth).toBe(0);

    try {
      await agent.execute({ type: "explore", description: "异常测试", prompt: "测试" });
    } catch {
      // 预期抛异常
    }

    expect(SubAgent.depth).toBe(0);
  });
});

// ─── 超时控制 ───

describe("SubAgent 超时控制", () => {
  test("超时后返回友好提示", async () => {
    const provider = new HangingProvider();
    const toolRegistry = new Registry();
    const agent = new SubAgent(provider, "test-model", toolRegistry);

    const result = await agent.execute({
      type: "explore",
      description: "超时测试",
      prompt: "测试",
      timeout: 50, // 50ms 超时
    });

    expect(result.success).toBe(false);
    expect(result.output).toContain("超时");
  });
});

// ─── 并发控制 ───

describe("SubAgentTool 并发控制", () => {
  test("超过并发上限时拒绝执行", async () => {
    const provider = new MockProvider();
    const toolRegistry = new Registry();
    const tool = new SubAgentTool(mockProviderRegistry(provider), toolRegistry);

    SubAgentTool.running = 3; // 模拟已满

    const result = await tool.execute({
      type: "explore",
      description: "并发测试",
      prompt: "测试",
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain("并发数已达上限");
  });

  test("执行完成后并发计数器正确递减", async () => {
    const provider = new MockProvider();
    const toolRegistry = new Registry();
    const tool = new SubAgentTool(mockProviderRegistry(provider), toolRegistry);

    expect(SubAgentTool.running).toBe(0);
    await tool.execute({ type: "explore", description: "测试", prompt: "测试" });
    expect(SubAgentTool.running).toBe(0);
  });
});

// ─── plan 类型 ───

describe("SubAgent plan 类型", () => {
  test("plan 类型执行成功并返回输出", async () => {
    const provider = new MockProvider();
    const toolRegistry = new Registry();
    const agent = new SubAgent(provider, "test-model", toolRegistry);

    const result = await agent.execute({
      type: "plan",
      description: "规划测试",
      prompt: "分析代码并输出实现方案",
    });

    expect(result.success).toBe(true);
    expect(result.output).toBeDefined();
    expect(result.output.length).toBeGreaterThan(0);
  });

  test("SubAgentTool 接受 plan 类型", async () => {
    const provider = new MockProvider();
    const toolRegistry = new Registry();
    const tool = new SubAgentTool(mockProviderRegistry(provider), toolRegistry);

    const result = await tool.execute({
      type: "plan",
      description: "规划测试",
      prompt: "分析代码",
    });

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain("plan");
  });

  test("SubAgentTool 拒绝无效类型", async () => {
    const provider = new MockProvider();
    const toolRegistry = new Registry();
    const tool = new SubAgentTool(mockProviderRegistry(provider), toolRegistry);

    const result = await tool.execute({
      type: "invalid_type",
      description: "无效测试",
      prompt: "测试",
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain("无效的子代理类型");
  });
});
