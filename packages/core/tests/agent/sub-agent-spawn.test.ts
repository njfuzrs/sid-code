/**
 * 子代理 Spawn 模式测试
 *
 * Wave 2：验证 spawn 模式的关键逻辑点，不依赖真实 Bun.spawn 调用。
 * 集成测试（真实 spawn）另行手动执行。
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SubAgent } from "@sid-code/core/agent/sub-agent.ts";
import { Registry } from "@sid-code/core/tool/registry.ts";
// 同 tests/tool/registry.test.ts：Registry 接受的是 LegacyTool 形态。
import type {
  LegacyTool as Tool,
  LegacyToolResult as ToolResult,
} from "@sid-code/core/tool/types.ts";
import type { Provider } from "@sid-code/core/llm/provider.ts";
import type { SendParams, StreamEvent } from "@sid-code/core/llm/types.ts";
import {
  type ParentInitMessage,
  type ChildMessage,
  type ChildToolUseMessage,
  type ChildResultMessage,
  type ChildCrashMessage,
  writeChildMsg,
} from "@sid-code/core/agent/sub-agent-protocol.ts";

// ============================================================
// Mock 工具
// ============================================================

class EchoTool implements Tool {
  constructor(private toolName: string = "echo") {}
  name() {
    return this.toolName;
  }
  description() {
    return "Echo tool";
  }
  inputSchema() {
    return { type: "object", properties: { text: { type: "string" } } };
  }
  readOnly() {
    return true;
  }
  async execute(input: unknown): Promise<ToolResult> {
    const text = (input as { text?: string })?.text ?? "no input";
    return { output: `echo: ${text}` };
  }
}

class ErrorTool implements Tool {
  name() {
    return "error_tool";
  }
  description() {
    return "Always errors";
  }
  inputSchema() {
    return { type: "object", properties: {} };
  }
  // 只读：本组用例不注入权限检查器，写类工具会被 B0 fail-closed 拦在执行之前
  readOnly() {
    return true;
  }
  async execute(): Promise<ToolResult> {
    throw new Error("模拟工具异常");
  }
}

// ============================================================
// Mock Provider
// ============================================================

class SimpleMockProvider implements Provider {
  constructor(private responseCount: number = 1) {}
  name() {
    return "mock";
  }
  defaultModel() {
    return "mock-model";
  }

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
      context_window: 50000,
      max_output_tokens: 8192,
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
      toolUseCount: 2,
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
    const result = await (sub as any).executeToolForChild("echo", { text: "hello" }, tools);
    expect(result.content).toBe("echo: hello");
    expect(result.is_error).toBe(false);
  });

  test("工具不存在时返回错误", async () => {
    const sub = new SubAgent(provider, "test-model", tools);
    const result = await (sub as any).executeToolForChild("nonexistent", {}, tools);
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("未找到");
  });

  test("工具执行异常时返回错误", async () => {
    const sub = new SubAgent(provider, "test-model", tools);
    const result = await (sub as any).executeToolForChild("error_tool", {}, tools);
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("工具执行异常");
  });

  test("工具输出截断（大输出）", async () => {
    // 注册一个输出大文本的工具
    class BigOutputTool implements Tool {
      name() {
        return "big_output";
      }
      description() {
        return "大输出";
      }
      inputSchema() {
        return { type: "object", properties: {} };
      }
      readOnly() {
        return true;
      }
      async execute(): Promise<ToolResult> {
        return { output: "x".repeat(50000) };
      }
    }
    const bigTools = new Registry();
    bigTools.register(new BigOutputTool());
    const sub = new SubAgent(provider, "test-model", bigTools);
    const result = await (sub as any).executeToolForChild("big_output", {}, bigTools);
    // 先断言真的执行了：被 fail-closed 拦下时拒绝文案同样短于 50000，只看长度是假绿
    expect(result.is_error).toBe(false);
    expect(result.content).toContain("x".repeat(100));
    expect(result.content.length).toBeLessThan(50000);
  });
});

// ============================================================
// PR12 补齐：spawn 路径的只读 bash 门禁
//
// 修复前的形态：进程内路径在 `buildIsolatedToolRegistry` 里给 bash 套
// `wrapBashWithReadOnlyGuard`，而 spawn 路径把**父的原始注册表**直接交给
// `executeToolForChild` 执行子进程回传的 tool_use —— 只读 agent 在这条路径上
// 拿到的是未包装实例，写命令照样执行。源码态 `HEADLESS_AVAILABLE=true` 时可达。
//
// 为什么断言「内层 execute 一次都不跑」而不只看 is_error：permission 层也会给出
// is_error，光看错误标志分不清是门禁拦的还是权限拦的。
// ============================================================

describe("executeToolForChild · 只读门禁（spawn 路径）", () => {
  // 自备 provider：上一个 describe 的 `provider` 是其块级作用域，这里拿不到。
  const guardProvider = new SimpleMockProvider();

  /** 记录真实执行次数：门禁拒绝时内层必须一次都不跑 */
  class SpyBashTool implements Tool {
    calls: string[] = [];
    name() {
      return "bash";
    }
    description() {
      return "spy bash";
    }
    inputSchema() {
      return { type: "object", properties: { command: { type: "string" } } };
    }
    // 声明只读：本组用例不注入 permissionChecker，写类工具会被 B0 fail-closed 拦在
    // 执行之前，那样就分不清是门禁生效还是权限层生效了。
    readOnly() {
      return true;
    }
    async execute(input: unknown): Promise<ToolResult> {
      const command = (input as { command?: string })?.command ?? "";
      this.calls.push(command);
      return { output: `ran: ${command}` };
    }
  }

  function makeBashRegistry() {
    const bash = new SpyBashTool();
    const reg = new Registry();
    reg.register(bash);
    return { bash, reg };
  }

  test("readOnlyAgent=true：写命令被门禁拒，且内层 execute 一次都不跑", async () => {
    const { bash, reg } = makeBashRegistry();
    const sub = new SubAgent(guardProvider, "test-model", reg);
    const result = await (sub as any).executeToolForChild(
      "bash",
      { command: "rm -rf packages/core/src/a.ts" },
      reg,
      undefined,
      undefined,
      undefined,
      true, // readOnlyAgent
    );
    expect(result.is_error).toBe(true);
    expect(bash.calls).toEqual([]);
  });

  test("readOnlyAgent=true：只读命令放行，内层真的执行", async () => {
    const { bash, reg } = makeBashRegistry();
    const sub = new SubAgent(guardProvider, "test-model", reg);
    const result = await (sub as any).executeToolForChild(
      "bash",
      { command: "git status" },
      reg,
      undefined,
      undefined,
      undefined,
      true,
    );
    expect(result.is_error).toBe(false);
    expect(bash.calls).toEqual(["git status"]);
  });

  test("readOnlyAgent=false（默认）：写命令照常执行，不误伤 task 类子代理", async () => {
    const { bash, reg } = makeBashRegistry();
    const sub = new SubAgent(guardProvider, "test-model", reg);
    const result = await (sub as any).executeToolForChild(
      "bash",
      { command: "rm -rf packages/core/src/a.ts" },
      reg,
    );
    expect(result.is_error).toBe(false);
    expect(bash.calls).toEqual(["rm -rf packages/core/src/a.ts"]);
  });

  test("源码哨兵：两处 spawn 入口都把 agentDefinition 的 readOnly 传下去（防只改一处）", () => {
    const src = readFileSync(join(import.meta.dir, "../../src/agent/sub-agent.ts"), "utf-8");
    // 内置路径（executeSpawned）+ 自定义路径（executeSpawnedCustom）各一处。
    // 只改一处会让另一条入口继续静默失效——这与 `spawnMaxTurns` 那次是同一个坑。
    // 按函数体切片断言而不是数全文出现次数：进程内自定义路径也有一处同形表达式，
    // 数次数会把「本来就对的」算进分子，改坏 spawn 时仍然绿。
    const spawnedStart = src.indexOf("private async executeSpawned(");
    const customStart = src.indexOf("private async executeSpawnedCustom(");
    const internalStart = src.indexOf("private async executeSpawnedInternal(");
    expect(spawnedStart).toBeGreaterThan(-1);
    expect(customStart).toBeGreaterThan(spawnedStart);
    expect(internalStart).toBeGreaterThan(customStart);
    expect(src.slice(spawnedStart, customStart), "内置 spawn 入口没传 readOnly").toContain(
      "agentDefinition?.readOnly === true",
    );
    expect(src.slice(customStart, internalStart), "自定义 spawn 入口没传 readOnly").toContain(
      "agentDefinition?.readOnly === true",
    );
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
    const mod = await import("@sid-code/cli/entrypoints/headless.ts");
    expect(mod).toBeDefined();
  });
});

// ============================================================
// Spawn init 契约字段（PR-6 / F7 第 2 条）
// ============================================================

describe("spawn init 契约字段", () => {
  const provider = new SimpleMockProvider();
  const tools = new Registry();
  tools.register(new EchoTool());

  test("context_window 走 registry 窗口，不再写死 50,000", () => {
    const sub = new SubAgent(provider, "test-model", tools);
    (sub as any).registry = { getContextWindow: () => 1_000_000 };
    expect((sub as any).resolveSubAgentWindow({})).toBe(1_000_000);
  });

  test("task.maxTokens 显式值优先于 registry 窗口", () => {
    const sub = new SubAgent(provider, "test-model", tools);
    (sub as any).registry = { getContextWindow: () => 1_000_000 };
    expect((sub as any).resolveSubAgentWindow({ maxTokens: 120_000 })).toBe(120_000);
  });

  test("registry 未实现 getContextWindow → 回退 50,000（兜底仍在，只是不再是唯一来源）", () => {
    const sub = new SubAgent(provider, "test-model", tools);
    (sub as any).registry = {};
    expect((sub as any).resolveSubAgentWindow({})).toBe(50_000);
  });

  test("max_output_tokens 按**实际模型**取物理上限（不是主模型）", () => {
    const sub = new SubAgent(provider, "test-model", tools);
    const asked: string[] = [];
    (sub as any).registry = {
      getMaxOutputTokens: (m: string) => {
        asked.push(m);
        return 8_192;
      },
    };
    expect((sub as any).resolveSubAgentMaxOutputTokens("sub-model")).toBe(8_192);
    // 传错模型会让「子代理配了小输出模型」的配置被主模型上限高估 → 必然 400
    expect(asked).toEqual(["sub-model"]);
  });

  test("物理上限未知 / 抛错 / 非法值 → undefined，绝不编一个数字", () => {
    const sub = new SubAgent(provider, "test-model", tools);

    (sub as any).registry = { getMaxOutputTokens: () => undefined };
    expect((sub as any).resolveSubAgentMaxOutputTokens("m")).toBeUndefined();

    (sub as any).registry = { getMaxOutputTokens: () => 0 };
    expect((sub as any).resolveSubAgentMaxOutputTokens("m")).toBeUndefined();

    (sub as any).registry = {
      getMaxOutputTokens: () => {
        throw new Error("registry 派生失败");
      },
    };
    expect((sub as any).resolveSubAgentMaxOutputTokens("m")).toBeUndefined();
  });

  test("源码哨兵：两处 spawn 传参都改名且不再写死 50,000（防只改一处）", () => {
    const src = readFileSync(join(import.meta.dir, "../../src/agent/sub-agent.ts"), "utf8");
    // 旧写法必须彻底消失 —— 只改 spawn 路径、漏掉自定义 agent 路径是本次最容易犯的错
    expect(src).not.toContain("max_tokens: task.maxTokens ?? 50000");
    expect(src.match(/context_window: this\.resolveSubAgentWindow\(task\)/g)).toHaveLength(2);
    expect(
      src.match(/max_output_tokens: this\.resolveSubAgentMaxOutputTokens\(model\)/g),
    ).toHaveLength(2);
  });

  test("源码哨兵：窗口不足的诊断值必须从 result 消息透传到 SubAgentResult（F7）", () => {
    const src = readFileSync(join(import.meta.dir, "../../src/agent/sub-agent.ts"), "utf8");
    // 少了这一句，子进程结构化传上来的四个值会在父进程被丢掉，
    // 调用方又退回「读 output 文案」。字段名与协议侧一致。
    expect(src).toContain("...(msg.diagnostics ? { budgetDiagnostics: msg.diagnostics } : {})");
    // 透传之外还要落一条日志：失败原因不该只藏在 output 字符串里
    expect(src).toMatch(/子代理因窗口不足失败：窗口/);
  });
});
