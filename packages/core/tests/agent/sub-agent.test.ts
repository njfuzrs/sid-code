/**
 * 子代理系统测试
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Registry } from "@sid-code/core/tool/registry.ts";
import { SubAgent, resolveSubAgentMaxTurns } from "@sid-code/core/agent/sub-agent.ts";
import { SubAgentTool } from "@sid-code/core/agent/tool.ts";
// 同 tests/tool/registry.test.ts：Registry 接受的是 LegacyTool 形态。
import type {
  LegacyTool as Tool,
  LegacyToolResult as ToolResult,
} from "@sid-code/core/tool/types.ts";
import type { Provider } from "@sid-code/core/llm/provider.ts";
import type { ProviderRegistry } from "@sid-code/core/llm/registry.ts";
import type { SendParams, StreamEvent } from "@sid-code/core/llm/types.ts";

/** Mock 工具 */
class MockTool implements Tool {
  constructor(
    private _name: string,
    private _readOnly: boolean = false,
  ) {}
  name() {
    return this._name;
  }
  description() {
    return `Mock tool: ${this._name}`;
  }
  inputSchema() {
    return { type: "object", properties: {} };
  }
  readOnly() {
    return this._readOnly;
  }
  async execute(): Promise<ToolResult> {
    return { output: "ok" };
  }
}

/** Mock Provider：返回简单文本响应 */
class MockProvider implements Provider {
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
  name() {
    return "hanging";
  }
  defaultModel() {
    return "hanging-model";
  }

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
    getLanguage: () => "zh" as const,
    getProviderForSubAgent: () => provider,
    // 子代理现按「最终模型」解析 provider（不再按类型），mock 须提供该入口
    getProviderForModelName: () => provider,
    clearCache: () => {},
  } as unknown as ProviderRegistry;
}

// 每个测试后重置静态计数器。
// 只剩 SubAgentTool.running 一个：原 SubAgent.depth 静态计数器已被
// depth-context.ts 的 AsyncLocalStorage 方案取代（见本文件 L205 附近说明），
// 深度随异步上下文自动出栈，无需手工重置。
afterEach(() => {
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
// 注意：原 static depth 计数器已移除（替代方案为消息标记检测，待实现）。
// 以下测试验证当前行为：不再有全局深度计数，并发执行不受限。

describe("SubAgent 嵌套防护（已移除 static depth）", () => {
  test("不再因静态深度拒绝并发执行", async () => {
    const provider = new MockProvider();
    const toolRegistry = new Registry();
    const agent = new SubAgent(provider, "test-model", toolRegistry);

    // 即使有"兄弟"子代理在运行（模拟并发场景），也不应被拒绝
    const result = await agent.execute({
      type: "explore",
      description: "并发测试",
      prompt: "测试",
    });

    // 正常执行成功（不再有全局深度阻断）
    expect(result.success).toBe(true);
    expect(result.turns).toBeGreaterThan(0);
  });

  test("execute() 完成后资源正确清理", async () => {
    const provider = new MockProvider();
    const toolRegistry = new Registry();
    const agent = new SubAgent(provider, "test-model", toolRegistry);

    const result = await agent.execute({ type: "explore", description: "测试", prompt: "测试" });
    expect(result.success).toBe(true);
    // 子代理执行完成后应能正常再次执行（无状态泄漏）
    const result2 = await agent.execute({ type: "explore", description: "测试2", prompt: "测试2" });
    expect(result2.success).toBe(true);
  });

  test("provider 异常时 execute() 正确兜底", async () => {
    class ErrorProvider implements Provider {
      name() {
        return "error";
      }
      defaultModel() {
        return "error-model";
      }
      async *sendMessageStream(): AsyncIterable<StreamEvent> {
        throw new Error("模拟错误");
      }
    }

    // 2026-10-08 有意语义变更：认不出的裸 Error 不再零重试，而是进 transient 未识别子集
    // （同指纹 3 次封顶）。SubAgent 构造器不暴露退避参数，子代理漏斗回落到
    // resolveLoopTimeouts —— 用 env 注入零退避，否则按默认 5s 基数真睡、撞 bun 5s 超时。
    const prevBase = process.env.SID_CODE_RETRY_BACKOFF_BASE_MS;
    const prevMax = process.env.SID_CODE_RETRY_BACKOFF_MAX_MS;
    process.env.SID_CODE_RETRY_BACKOFF_BASE_MS = "0";
    process.env.SID_CODE_RETRY_BACKOFF_MAX_MS = "0";
    let result: Awaited<ReturnType<SubAgent["execute"]>>;
    try {
      const agent = new SubAgent(new ErrorProvider(), "test-model", new Registry());
      result = await agent.execute({
        type: "explore",
        description: "异常测试",
        prompt: "测试",
      });
    } finally {
      // 存/恢复原值，不无条件 delete（CONTRIBUTING 测试约定第 1 条）
      if (prevBase === undefined) delete process.env.SID_CODE_RETRY_BACKOFF_BASE_MS;
      else process.env.SID_CODE_RETRY_BACKOFF_BASE_MS = prevBase;
      if (prevMax === undefined) delete process.env.SID_CODE_RETRY_BACKOFF_MAX_MS;
      else process.env.SID_CODE_RETRY_BACKOFF_MAX_MS = prevMax;
    }

    // execute() 内部 runAgentLoop 消化了异常：success=false、输出含原始错误信息
    expect(result.success).toBe(false);
    expect(result.output).toContain("模拟错误");
  });
});

// ─── 中止控制（PR-B：子代理无墙钟，只有 ESC / task_stop / 父代理取消）───

describe("SubAgent 中止控制", () => {
  /**
   * P0-1 的残卷断言保留，触发源从「墙钟到点」换成「外层 abort」——PR-B 删掉墙钟后，
   * 中止是卡住的子代理唯一的停止出口，残卷四段结构必须照样交回。
   *
   * ⚠️ 后来者注意：如果这条测试红了，正确修法是去看残卷为什么没拼出来，
   * **不是**把 output 改回一句话让它变绿——那等于把整个 P0-1 做反。
   */
  test("外层 abort 后交回结构化残卷（不是只有一句提示）", async () => {
    const provider = new HangingProvider();
    const agent = new SubAgent(provider, "test-model", new Registry());
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 50);

    const result = await agent.execute(
      { type: "explore", description: "中止测试", prompt: "测试" },
      ctrl.signal,
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("<partial-result>");
    expect(result.output).toContain("<interrupted-because>");
    expect(result.output).toContain("被主动中止");
    // 墙钟文案已整体删除，不得再出现（事故 20261016-222758 的错误归因）
    expect(result.output).not.toContain("墙钟");
    expect(result.output).toContain("<changed-files");
    expect(result.output).toContain("<incomplete>");
    expect(result.output).toContain("<next-step>");
  });

  /**
   * T2（PR-B）：无外层 abort 时，子代理**不会被任何计时器掐断**。
   * 构造：provider 先挂起 300ms 再正常完成，期间不 abort。改造前 `timeout: 50` 会 detach；
   * 现在 task 上已没有 timeout 字段，任何墙钟复活都会让它提前返回 → 红。
   */
  test("不 abort 时慢 provider 正常完成（无墙钟）", async () => {
    class SlowProvider implements Provider {
      name() {
        return "slow";
      }
      defaultModel() {
        return "slow-model";
      }
      async *sendMessageStream(): AsyncIterable<StreamEvent> {
        await new Promise((r) => setTimeout(r, 300));
        yield {
          type: "message_start",
          message: { usage: { inputTokens: 1, outputTokens: 0 } },
        } as any;
        yield {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        } as any;
        yield {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "完成" },
        } as any;
        yield { type: "content_block_stop", index: 0 } as any;
        yield {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { outputTokens: 1 },
        } as any;
      }
    }
    const agent = new SubAgent(new SlowProvider(), "slow-model", new Registry());
    const result = await agent.execute({ type: "explore", description: "慢", prompt: "测试" });
    expect(result.success).toBe(true);
    expect(result.output).toContain("完成");
  });
});

// ─── 并发控制 ───

describe("SubAgentTool 并发控制", () => {
  test("#13：resolveMaxConcurrent 缺省 20（对齐 CC），env 可调，非法值回退缺省", () => {
    // 缺省（未设置）：对齐 CC CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS=20
    expect(SubAgentTool.DEFAULT_MAX_CONCURRENT).toBe(20);
    expect(SubAgentTool.resolveMaxConcurrent(undefined)).toBe(20);
    expect(SubAgentTool.resolveMaxConcurrent("")).toBe(20);
    // 显式调整：收紧与放宽都允许
    expect(SubAgentTool.resolveMaxConcurrent("3")).toBe(3);
    expect(SubAgentTool.resolveMaxConcurrent("64")).toBe(64);
    // 非法值静默回退缺省，绝不因配错而收窄成串行
    expect(SubAgentTool.resolveMaxConcurrent("0")).toBe(20);
    expect(SubAgentTool.resolveMaxConcurrent("-2")).toBe(20);
    expect(SubAgentTool.resolveMaxConcurrent("abc")).toBe(20);
  });

  test("MAX_CONCURRENT 每次读 env，启动后写入的 settings env 也能生效", () => {
    // 回归：曾是 static readonly，模块加载时冻结；managed-env 后写 process.env 时静默无效
    const prev = process.env.SID_SUBAGENT_MAX_CONCURRENT;
    try {
      delete process.env.SID_SUBAGENT_MAX_CONCURRENT;
      expect(SubAgentTool.MAX_CONCURRENT).toBe(20);
      process.env.SID_SUBAGENT_MAX_CONCURRENT = "5";
      expect(SubAgentTool.MAX_CONCURRENT).toBe(5);
    } finally {
      if (prev === undefined) delete process.env.SID_SUBAGENT_MAX_CONCURRENT;
      else process.env.SID_SUBAGENT_MAX_CONCURRENT = prev;
    }
  });

  test("超过并发上限时排队等待而非拒绝（G1）", async () => {
    SubAgentTool.running = 0;
    SubAgentTool["waiters"] = [];

    // 占满全部 slot
    for (let i = 0; i < SubAgentTool.MAX_CONCURRENT; i++) {
      await SubAgentTool.acquireSlot();
    }
    expect(SubAgentTool.running).toBe(SubAgentTool.MAX_CONCURRENT);

    // 第 MAX+1 个 acquire 应挂起排队，而不是立即完成/拒绝
    let acquired = false;
    const pending = SubAgentTool.acquireSlot().then(() => {
      acquired = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(acquired).toBe(false); // 仍在排队
    expect(SubAgentTool["waiters"].length).toBe(1);

    // 释放一个 slot → 队首被唤醒，running 不变（slot 转移）
    SubAgentTool.releaseSlot();
    await pending;
    expect(acquired).toBe(true);
    expect(SubAgentTool.running).toBe(SubAgentTool.MAX_CONCURRENT);

    // 清理
    for (let i = 0; i < SubAgentTool.MAX_CONCURRENT; i++) SubAgentTool.releaseSlot();
    expect(SubAgentTool.running).toBe(0);
  });

  test("等待并发 slot 期间被 abort 则抛出且不泄漏 waiter（G1）", async () => {
    SubAgentTool.running = SubAgentTool.MAX_CONCURRENT; // 占满
    SubAgentTool["waiters"] = [];

    const ac = new AbortController();
    const p = SubAgentTool.acquireSlot(ac.signal);
    await new Promise((r) => setTimeout(r, 10));
    expect(SubAgentTool["waiters"].length).toBe(1);

    ac.abort();
    await expect(p).rejects.toBeDefined();
    expect(SubAgentTool["waiters"].length).toBe(0); // waiter 已移除，无泄漏

    SubAgentTool.running = 0; // 复位供后续用例
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

    // 成功时 isError 为 false（非 undefined），因为 runSync 显式设置 isError: !result.success
    expect(result.isError).toBe(false);
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

  // P2-16：type 省略时兜底 general-purpose（schema 已改 optional，兜底不再是死代码）
  test("SubAgentTool 省略 type 时默认 general-purpose（不再误报缺参）", async () => {
    const provider = new MockProvider();
    const toolRegistry = new Registry();
    const tool = new SubAgentTool(mockProviderRegistry(provider), toolRegistry);

    const result = await tool.execute({
      description: "无类型测试",
      prompt: "测试",
    });

    // 不应因缺 type 报"缺少必需参数"，而是兜底 general-purpose 正常执行
    expect(result.output).not.toContain("缺少必需参数");
    expect(result.isError).toBe(false);
  });

  test("SubAgentTool 仍要求 description/prompt", async () => {
    const provider = new MockProvider();
    const toolRegistry = new Registry();
    const tool = new SubAgentTool(mockProviderRegistry(provider), toolRegistry);

    const result = await tool.execute({ type: "explore" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("缺少必需参数");
  });

  // P2-15：schema 透出 model / cwd（此前内部支持但未暴露给 LLM）
  test("SubAgentTool schema 暴露 model 与 cwd 参数", () => {
    const provider = new MockProvider();
    const tool = new SubAgentTool(mockProviderRegistry(provider), new Registry());
    const schema = tool.inputSchema() as { properties?: Record<string, unknown> };
    expect(schema.properties).toBeDefined();
    expect(schema.properties).toHaveProperty("model");
    expect(schema.properties).toHaveProperty("cwd");
  });
});

// ─── extractFinalText / isLikelyThinking 启发式过滤（Bug 2 第三道防线）───
// 背景：子代理达 max_turns 被强制退出时，最后一条 assistant text 可能是规划碎片
// （"现在我来看看…" / "Let me check…"），不是结论。extractFinalText 跳过这类纯
// planning 文本，回退到更早的有结论的 assistant 消息。
// 关键回归：enhanceSubAgentPrompt 强制中文输出 → 规划碎片多为中文，正则必须覆盖中文。
describe("isLikelyThinking 启发式过滤（中英双语）", () => {
  // private 方法，测试经 as any 访问（无侵入，避免为测试改可见性）
  const makeAgent = () => new SubAgent(new MockProvider(), "test-model", new Registry()) as any;

  const thinkingSamples = [
    // 中文规划碎片（本项目主场景）
    "现在我对整体有了清晰的认识。让我再检查一下通知格式。",
    "让我检查一下\n接下来分析一下结果",
    "首先看看这个函数\n然后确认一下调用链",
    "我需要再核对几个文件\n目前为止还没有完整结论",
    // 英文规划碎片
    "Now I have a complete picture. Let me check the notification format.",
    "Let me verify the truncation logic\nLooking at the disk output",
  ];

  const conclusionSamples = [
    // 含结构化标记 → 不是 thinking
    "## 结论\n全部 12 项均已落地",
    "| 项 | 状态 |\n| A | 已落地 |\n| B | 已落地 |",
    "**核查结论**：三层门控完整",
    // 长文本（> 5 行）→ 默认有实质内容
    "第一行结论\n第二行细节\n第三行证据\n第四行佐证\n第五行补充\n第六行总结",
    // 正常陈述句 → 不应误杀
    "数据库连接池配置在 config.ts 第 30 行，最大连接数 20。",
  ];

  test("中英文规划碎片被判定为 thinking", () => {
    const agent = makeAgent();
    for (const s of thinkingSamples) {
      expect(agent.isLikelyThinking(s)).toBe(true);
    }
  });

  test("结论 / 结构化 / 长文本 / 正常陈述不被误判", () => {
    const agent = makeAgent();
    for (const s of conclusionSamples) {
      expect(agent.isLikelyThinking(s)).toBe(false);
    }
  });

  test("extractFinalText 跳过中文规划碎片，回退到更早的结论消息", () => {
    const agent = makeAgent();
    const messages = [
      {
        role: "assistant",
        content: [{ type: "text", text: "## 发现\n- oauth.ts 缺少过期校验\n- 已定位到第 88 行" }],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }] },
      // 最后一条是中文规划碎片（max_turns 截断的典型形态）
      { role: "assistant", content: [{ type: "text", text: "现在让我再确认一下另一个文件。" }] },
    ];
    const result = agent.extractFinalText(messages, "fallback");
    // 应跳过末尾规划碎片，取到含结论的更早消息
    expect(result).toContain("## 发现");
    expect(result).not.toContain("现在让我再确认");
  });

  test("extractFinalText 全为规划碎片时回退到 fallback", () => {
    const agent = makeAgent();
    const messages = [
      { role: "assistant", content: [{ type: "text", text: "让我先看看代码。" }] },
      { role: "assistant", content: [{ type: "text", text: "现在我需要检查配置。" }] },
    ];
    expect(agent.extractFinalText(messages, "兜底结论")).toBe("兜底结论");
  });
});

// ─── PR-B: resolveSubAgentMaxTurns ───

describe("resolveSubAgentMaxTurns（PR-B：未声明即无上限，对齐 CC）", () => {
  test("显式声明的正数照旧生效", () => {
    expect(resolveSubAgentMaxTurns({ maxTurns: 20 })).toBe(20);
    expect(resolveSubAgentMaxTurns({ maxTurns: 1 })).toBe(1);
  });

  test("未声明 → Infinity（⛔ 不能是 undefined：`turns < undefined` 恒 false，一轮都不跑）", () => {
    const n = resolveSubAgentMaxTurns({});
    expect(n).toBe(Infinity);
    // 锁住陷阱本身：循环条件对 0 必须为真
    expect(0 < n).toBe(true);
  });

  test("非正数 / NaN 视为未声明（与主循环 `maxTurns || Infinity` 同口径）", () => {
    expect(resolveSubAgentMaxTurns({ maxTurns: 0 })).toBe(Infinity);
    expect(resolveSubAgentMaxTurns({ maxTurns: -3 })).toBe(Infinity);
    expect(resolveSubAgentMaxTurns({ maxTurns: NaN })).toBe(Infinity);
  });
});
