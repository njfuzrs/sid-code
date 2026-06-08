/**
 * 子代理 Spawn 模式测试
 *
 * Wave 2：验证 spawn 模式的关键逻辑点，不依赖真实 Bun.spawn 调用。
 * 集成测试（真实 spawn）另行手动执行。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { SubAgent } from "../../src/agent/sub-agent.ts";
import type { SubAgentType } from "../../src/agent/sub-agent.ts";
import { Registry } from "../../src/tool/registry.ts";
import { SubAgentTool } from "../../src/agent/tool.ts";
import type { Tool, ToolResult } from "../../src/tool/types.ts";
import type { Provider } from "../../src/llm/provider.ts";
import type { ProviderRegistry } from "../../src/llm/registry.ts";
import type { SendParams, StreamEvent } from "../../src/llm/types.ts";
import {
  type ParentInitMessage,
  type ChildMessage,
  type ChildToolUseMessage,
  type ChildResultMessage,
  type ChildCrashMessage,
  writeChildMsg,
} from "../../src/agent/sub-agent-protocol.ts";

// ============================================================
// Mock 工具
// ============================================================

class EchoTool implements Tool {
  constructor(private toolName: string = "echo") {}
  name() { return this.toolName; }
  description() { return "Echo tool"; }
  inputSchema() { return { type: "object", properties: { text: { type: "string" } } }; }
  readOnly() { return true; }
  async execute(input: unknown): Promise<ToolResult> {
    const text = (input as { text?: string })?.text ?? "no input";
    return { output: `echo: ${text}` };
  }
}

class ErrorTool implements Tool {
  name() { return "error_tool"; }
  description() { return "Always errors"; }
  inputSchema() { return { type: "object", properties: {} }; }
  async execute(): Promise<ToolResult> {
    throw new Error("模拟工具异常");
  }
}

// ============================================================
// Mock Provider
// ============================================================

class SimpleMockProvider implements Provider {
  constructor(private responseCount: number = 1) {}
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
      delta: { type: "text_delta", text: "spawn 测试响应" },
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

// ============================================================
// 协议测试
// ============================================================

describe("子代理通信协议", () => {
  test("ParentInitMessage 序列化/反序列化", () => {
    const msg: ParentInitMessage = {
      type: "init",
      session_id: "test-session",
      task_type: "explore",
      system_prompt: "你是一个探索代理",
      user_prompt: "搜索 foo.ts",
      allowed_tools: ["grep", "read"],
      tool_defs: [
        { name: "grep", description: "搜索", inputSchema: {} },
        { name: "read", description: "读取", inputSchema: {} },
      ],
      model: "test-model",
      max_turns: 5,
      max_tokens: 50000,
      timeout: 30000,
      workdir: "/tmp",
      provider_name: "anthropic",
      api_key: "test-key-redacted",
    };

    const json = JSON.stringify(msg);
    const parsed: ParentInitMessage = JSON.parse(json);

    expect(parsed.type).toBe("init");
    expect(parsed.task_type).toBe("explore");
    expect(parsed.provider_name).toBe("anthropic");
    expect(parsed.api_key).toBe("test-key-redacted");
    expect(parsed.tool_defs).toHaveLength(2);
  });

  test("ChildMessage 序列化/反序列化", () => {
    const toolUseMsg: ChildToolUseMessage = {
      type: "tool_use",
      id: "tool_001",
      name: "grep",
      input: { pattern: "foo" },
    };
    const json1 = JSON.stringify(toolUseMsg);
    const parsed1 = JSON.parse(json1) as ChildMessage;
    expect(parsed1.type).toBe("tool_use");
    expect((parsed1 as ChildToolUseMessage).name).toBe("grep");

    const resultMsg: ChildResultMessage = {
      type: "result",
      success: true,
      output: "完成",
      usage: { inputTokens: 100, outputTokens: 50 },
      turns: 3,
    };
    const json2 = JSON.stringify(resultMsg);
    const parsed2 = JSON.parse(json2) as ChildMessage;
    expect(parsed2.type).toBe("result");
    expect((parsed2 as ChildResultMessage).turns).toBe(3);

    const crashMsg: ChildCrashMessage = {
      type: "crash",
      error: "OOM",
      stack: "at foo:10",
    };
    const json3 = JSON.stringify(crashMsg);
    const parsed3 = JSON.parse(json3) as ChildMessage;
    expect(parsed3.type).toBe("crash");
  });

  test("writeChildMsg 输出 NDJSON 格式", () => {
    // 捕获 stdout
    const originalWrite = process.stdout.write.bind(process.stdout);
    let captured = "";
    try {
      (process.stdout as any).write = (data: string) => {
        captured += data;
        return data.length;
      };
      writeChildMsg({ type: "ready" });
      expect(captured).toContain('"type":"ready"');
      expect(captured).toEndWith("\n");
    } finally {
      (process.stdout as any).write = originalWrite;
    }
  });
});

// ============================================================
// Spawn 选择逻辑测试
// ============================================================

describe("shouldUseSpawn 决策", () => {
  const provider = new SimpleMockProvider();
  const tools = new Registry();
  tools.register(new EchoTool());

  test("没有 spawnConfig 时不使用 spawn", () => {
    const sub = new SubAgent(provider, "test-model", tools);
    // 通过私有方法判断（使用 any 绕过）
    const result = (sub as any).shouldUseSpawn();
    expect(result).toBe(false);
  });

  test("设置 SIDCODE_NO_SPAWN=1 时禁用 spawn", () => {
    const original = process.env.SIDCODE_NO_SPAWN;
    process.env.SIDCODE_NO_SPAWN = "1";
    try {
      // 即使有 Bun.spawn，也应该返回 false
      const sub = new SubAgent(provider, "test-model", tools);
      // 模拟有 spawnConfig
      (sub as any).spawnConfig = { providerName: "anthropic", apiKey: "key" };
      const result = (sub as any).shouldUseSpawn();
      expect(result).toBe(false);
    } finally {
      if (original !== undefined) {
        process.env.SIDCODE_NO_SPAWN = original;
      } else {
        delete process.env.SIDCODE_NO_SPAWN;
      }
    }
  });

  test("有 spawnConfig 且 Bun.spawn 可用时应使用 spawn", () => {
    const sub = new SubAgent(provider, "test-model", tools);
    (sub as any).spawnConfig = { providerName: "anthropic", apiKey: "key" };
    // Bun.spawn 在 Bun 环境下可用
    const result = (sub as any).shouldUseSpawn();
    expect(result).toBe(true);
  });
});

// ============================================================
// executeToolForChild 测试
// ============================================================

describe("executeToolForChild", () => {
  const provider = new SimpleMockProvider();
  const tools = new Registry();
  tools.register(new EchoTool("echo"));
  tools.register(new ErrorTool());

  test("正常执行工具", async () => {
    const sub = new SubAgent(provider, "test-model", tools);
    const result = await (sub as any).executeToolForChild(
      "echo",
      { text: "hello" },
      tools,
    );
    expect(result.content).toBe("echo: hello");
    expect(result.is_error).toBe(false);
  });

  test("工具不存在时返回错误", async () => {
    const sub = new SubAgent(provider, "test-model", tools);
    const result = await (sub as any).executeToolForChild(
      "nonexistent",
      {},
      tools,
    );
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("未找到");
  });

  test("工具执行异常时返回错误", async () => {
    const sub = new SubAgent(provider, "test-model", tools);
    const result = await (sub as any).executeToolForChild(
      "error_tool",
      {},
      tools,
    );
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("工具执行异常");
  });

  test("工具输出截断（大输出）", async () => {
    // 注册一个输出大文本的工具
    class BigOutputTool implements Tool {
      name() { return "big_output"; }
      description() { return "大输出"; }
      inputSchema() { return { type: "object", properties: {} }; }
      async execute(): Promise<ToolResult> {
        return { output: "x".repeat(50000) };
      }
    }
    const bigTools = new Registry();
    bigTools.register(new BigOutputTool());
    const sub = new SubAgent(provider, "test-model", bigTools);
    const result = await (sub as any).executeToolForChild(
      "big_output",
      {},
      bigTools,
    );
    expect(result.content.length).toBeLessThan(50000);
  });
});

// ============================================================
// getToolDefs 测试
// ============================================================

describe("getToolDefs", () => {
  const provider = new SimpleMockProvider();
  const tools = new Registry();
  tools.register(new EchoTool("grep"));
  tools.register(new EchoTool("read"));
  tools.register(new EchoTool("bash"));

  test("explore 类型获取工具定义", () => {
    const sub = new SubAgent(provider, "test-model", tools);
    const defs = (sub as any).getToolDefs({
      type: "explore",
      description: "测试",
      prompt: "测试",
    });
    // explore 类型通过 filterToolsForAgent 过滤后应有工具
    expect(defs.length).toBeGreaterThan(0);
    // 所有工具定义都有 name, description, inputSchema
    for (const d of defs) {
      expect(d.name).toBeTruthy();
      expect(d.description).toBeTruthy();
      expect(d.inputSchema).toBeDefined();
    }
  });

  test("summarize 类型无工具", () => {
    const sub = new SubAgent(provider, "test-model", tools);
    const defs = (sub as any).getToolDefs({
      type: "summarize",
      description: "测试",
      prompt: "测试",
    });
    expect(defs.length).toBe(0);
  });
});

// ============================================================
// Spawn 模式 fallback 测试
// ============================================================

describe("Spawn 模式 fallback 到进程内", () => {
  const provider = new SimpleMockProvider();
  const tools = new Registry();
  tools.register(new EchoTool("grep"));

  test("spawn 失败时回退到 executeInner", async () => {
    const sub = new SubAgent(provider, "test-model", tools);
    // 设置 spawnConfig 但使 spawn 抛出异常
    (sub as any).spawnConfig = { providerName: "anthropic", apiKey: "key" };

    // Mock executeSpawned 抛出异常
    const origSpawned = (sub as any).executeSpawned.bind(sub);
    (sub as any).executeSpawned = async () => {
      throw new Error("模拟 spawn 失败");
    };

    try {
      const result = await sub.execute({
        type: "explore",
        description: "测试 fallback",
        prompt: "搜索代码",
        maxTurns: 1,
      });

      // 应该回退到进程内模式成功
      expect(result.success).toBe(true);
      expect(result.output).toContain("spawn 测试响应");
    } finally {
      (sub as any).executeSpawned = origSpawned;
    }
  });
});

// ============================================================
// Headless 入口模块加载测试（验证 headless.ts 可导入）
// ============================================================

describe("Headless 入口", () => {
  test("headless.ts 模块可以动态导入", async () => {
    // 不实际执行 main()，只验证模块可以加载
    const mod = await import("../../src/entrypoints/headless.ts");
    expect(mod).toBeDefined();
  });
});
