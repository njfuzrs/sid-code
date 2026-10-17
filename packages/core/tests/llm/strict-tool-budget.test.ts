/**
 * D11：Anthropic strict 工具单请求容量（数量 20 + 语法体积）。
 *
 * 分三层断言：纯函数（识别 / 降级 / 学习）→ provider 流式与非流式两条路径真的按上限发、
 * 遇容量 400 真的降级重发 → 工具元数据里的优先级真的从定义一路传到 provider。
 * 只测纯函数会漏掉「provider 没接上」这一类死接线（本仓已发生过四次）。
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { AnthropicProvider } from "@sid-code/core/llm/anthropic.ts";
import type { SendParams, ToolDefinition } from "@sid-code/core/llm/types.ts";
import {
  applyStrictToolBudget,
  countStrictTools,
  DEFAULT_STRICT_TOOL_LIMIT,
  getStrictToolLimit,
  learnStrictToolLimit,
  nextStrictToolLimit,
  parseStrictCapacityError,
  resetStrictToolLimitsForTest,
} from "@sid-code/core/llm/strict-tool-budget.ts";

const COUNT_MSG = "Too many strict tools (24). The maximum number of strict tools supported is 20.";
const GRAMMAR_MSG =
  "The compiled grammar is too large, which would cause performance issues. Simplify your tool schemas";

/** 构造 SDK APIError 形状：message 是拼好的整串，error 是解析后的 body。 */
function apiError(message: string, status = 400) {
  const e: any = new Error(`${status} ${JSON.stringify({ error: { message } })}`);
  e.status = status;
  e.error = { type: "error", error: { type: "invalid_request_error", message } };
  return e;
}

function makeTools(n: number, priorities: Record<string, number> = {}): ToolDefinition[] {
  return Array.from({ length: n }, (_, i) => {
    const name = `tool_${i}`;
    return {
      name,
      description: name,
      input_schema: { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
      strict: true,
      ...(priorities[name] !== undefined && { strictPriority: priorities[name] }),
    };
  });
}

beforeEach(() => resetStrictToolLimitsForTest());

describe("parseStrictCapacityError", () => {
  test("数量错误：带出上游上限", () => {
    expect(parseStrictCapacityError(apiError(COUNT_MSG))).toEqual({ kind: "count", limit: 20 });
  });
  test("语法体积错误", () => {
    expect(parseStrictCapacityError(apiError(GRAMMAR_MSG))).toEqual({ kind: "grammar" });
  });
  test("只有 message 没有解析 body 也认", () => {
    expect(parseStrictCapacityError(new Error(COUNT_MSG))?.kind).toBe("count");
  });
  test("普通 400 / 网络错误不算容量错误（不得被降 strict 重发掩盖）", () => {
    expect(parseStrictCapacityError(apiError("messages: field required"))).toBeNull();
    expect(parseStrictCapacityError(new Error("ECONNRESET"))).toBeNull();
    expect(parseStrictCapacityError(null)).toBeNull();
  });
});

describe("nextStrictToolLimit", () => {
  test("数量错误用上游报的上限", () => {
    expect(nextStrictToolLimit({ kind: "count", limit: 20 }, 24)).toBe(20);
  });
  test("上游报的上限不小于已发数时至少退一格，避免原样重发", () => {
    expect(nextStrictToolLimit({ kind: "count", limit: 20 }, 20)).toBe(19);
  });
  test("数量错误没给上限时退到 min(已发-1, 默认)", () => {
    expect(nextStrictToolLimit({ kind: "count" }, 40)).toBe(DEFAULT_STRICT_TOOL_LIMIT);
    expect(nextStrictToolLimit({ kind: "count" }, 5)).toBe(4);
  });
  test("语法体积错误减半", () => {
    expect(nextStrictToolLimit({ kind: "grammar" }, 20)).toBe(10);
    expect(nextStrictToolLimit({ kind: "grammar" }, 1)).toBe(0);
  });
  test("已经是 0 就不能再降", () => {
    expect(nextStrictToolLimit({ kind: "grammar" }, 0)).toBeNull();
  });
});

describe("learnStrictToolLimit", () => {
  test("按端点隔离，只收紧不放宽", () => {
    learnStrictToolLimit("m@a", 10);
    learnStrictToolLimit("m@a", 15);
    expect(getStrictToolLimit("m@a")).toBe(10);
    expect(getStrictToolLimit("m@b")).toBe(DEFAULT_STRICT_TOOL_LIMIT);
  });
});

describe("applyStrictToolBudget", () => {
  test("未超限原样返回（同一引用，不白造数组）", () => {
    const tools = makeTools(20);
    const r = applyStrictToolBudget(tools, 20);
    expect(r.tools).toBe(tools);
    expect(r.demoted).toEqual([]);
  });

  test("超限按优先级保留，工具顺序不变（不击穿工具区缓存前缀）", () => {
    const tools = makeTools(24, { tool_23: 100, tool_22: 50 });
    const r = applyStrictToolBudget(tools, 20, (n) =>
      n === "tool_23" ? 100 : n === "tool_22" ? 50 : 0,
    );
    expect(countStrictTools(r.tools)).toBe(20);
    expect(r.tools!.map((t) => t.name)).toEqual(tools.map((t) => t.name));
    // 高优先级的两个即使排在末尾也保住了；被降的是同优先级里最靠后的
    expect(r.tools![23]!.strict).toBe(true);
    expect(r.tools![22]!.strict).toBe(true);
    expect(r.demoted).toEqual(["tool_18", "tool_19", "tool_20", "tool_21"]);
    // schema 照发，只去掉 strict
    expect(r.tools![20]!.input_schema).toEqual(tools[20]!.input_schema);
    expect("strict" in r.tools![20]!).toBe(false);
  });
});

// ─── provider 接线 ────────────────────────────────────────────────────────

function emptyStream() {
  const controller = new AbortController();
  const events = [
    { type: "message_start", message: { usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ];
  return {
    controller,
    async *[Symbol.asyncIterator]() {
      for (const ev of events) yield ev;
    },
  };
}

/**
 * 模拟一个执行 strict 上限的上游：strict 数 > limit 回数量 400；
 * grammarAbove 设了时 strict 数 > grammarAbove 回语法体积 400。记录每次请求的 strict 数。
 */
function makeProvider(opts: { limit?: number; grammarAbove?: number; baseURL?: string } = {}) {
  const provider = new AnthropicProvider(
    "k",
    "claude-sonnet-5",
    opts.baseURL ?? "https://gw-a.example.com",
  );
  const sent: number[] = [];
  const check = (body: any) => {
    const n = (body.tools ?? []).filter((t: any) => t.strict).length;
    sent.push(n);
    if (opts.limit !== undefined && n > opts.limit) {
      throw apiError(
        `Too many strict tools (${n}). The maximum number of strict tools supported is ${opts.limit}.`,
      );
    }
    if (opts.grammarAbove !== undefined && n > opts.grammarAbove) throw apiError(GRAMMAR_MSG);
  };
  (provider as any).client.messages.create = (body: any) => {
    if (body.stream) {
      return {
        withResponse: async () => {
          check(body);
          return {
            data: emptyStream(),
            response: { status: 200, headers: new Headers(), body: { cancel: async () => {} } },
          };
        },
      };
    }
    return (async () => {
      check(body);
      return { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: {} };
    })();
  };
  return { provider, sent };
}

function params(tools: ToolDefinition[]): SendParams {
  return {
    model: "claude-sonnet-5",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    maxTokens: 16,
    tools,
  };
}

async function drain(it: AsyncIterable<any>) {
  const out: any[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}

describe("AnthropicProvider 接线（流式）", () => {
  test("发前收口：24 个 strict 工具首发就只带 20 个，零 400", async () => {
    const { provider, sent } = makeProvider({ limit: 20 });
    const out = await drain(provider.sendMessageStream(params(makeTools(24))));
    expect(out.some((e) => e.type === "error")).toBe(false);
    expect(sent).toEqual([20]);
  });

  test("上游上限比默认更小：数量 400 → 按报的上限重发 → 成功，且该端点记住", async () => {
    const { provider, sent } = makeProvider({ limit: 12 });
    const out = await drain(provider.sendMessageStream(params(makeTools(24))));
    expect(out.some((e) => e.type === "error")).toBe(false);
    expect(sent).toEqual([20, 12]);
    // 下一个请求直接按学到的上限发，不再先撞一次 400
    sent.length = 0;
    await drain(provider.sendMessageStream(params(makeTools(24))));
    expect(sent).toEqual([12]);
  });

  test("语法体积 400：逐级减半直到成功", async () => {
    const { provider, sent } = makeProvider({ grammarAbove: 6 });
    const out = await drain(provider.sendMessageStream(params(makeTools(24))));
    expect(out.some((e) => e.type === "error")).toBe(false);
    expect(sent).toEqual([20, 10, 5]);
  });

  test("学到的上限按端点隔离：A 网关学到 12，B 网关仍按 20 发", async () => {
    const a = makeProvider({ limit: 12, baseURL: "https://gw-a.example.com" });
    await drain(a.provider.sendMessageStream(params(makeTools(24))));
    const b = makeProvider({ limit: 20, baseURL: "https://gw-b.example.com" });
    await drain(b.provider.sendMessageStream(params(makeTools(24))));
    expect(b.sent).toEqual([20]);
  });

  test("非容量 400 不重发，原样作为 error 事件交出", async () => {
    const provider = new AnthropicProvider("k", "claude-sonnet-5", "https://gw-c.example.com");
    let calls = 0;
    (provider as any).client.messages.create = () => ({
      withResponse: async () => {
        calls++;
        throw apiError("messages: field required");
      },
    });
    const out = await drain(provider.sendMessageStream(params(makeTools(24))));
    expect(calls).toBe(1);
    expect(out.find((e) => e.type === "error")?.error.message).toContain("field required");
  });
});

describe("AnthropicProvider 接线（非流式）", () => {
  test("发前收口 + 数量 400 降级重发", async () => {
    const { provider, sent } = makeProvider({ limit: 15, baseURL: "https://gw-d.example.com" });
    const r = await provider.sendMessageNonStreaming(params(makeTools(24)));
    expect(r.stopReason).toBe("end_turn");
    expect(sent).toEqual([20, 15]);
  });
});

describe("strictPriority 从工具定义传到 provider", () => {
  test("内置工具注册表：ask_user_question / edit / write / notebook_edit 自报了优先级", async () => {
    // 走真实 Registry.definitions()：断言的是「工具类字段 → toolToDefinition → ToolDefinition」
    // 这条链，只看工具类字段会漏掉 registry 没透传这一种死接线。
    const { Registry } = await import("@sid-code/core/tool/registry.ts");
    const { AskUserQuestionTool } = await import("@sid-code/core/tool/ask-user-question.ts");
    const { EditTool } = await import("@sid-code/core/tool/edit.ts");
    const { WriteTool } = await import("@sid-code/core/tool/write.ts");
    const { NotebookEditTool } = await import("@sid-code/core/tool/notebook-edit.ts");
    const reg = new Registry();
    for (const t of [
      new AskUserQuestionTool(),
      new EditTool(),
      new WriteTool(),
      new NotebookEditTool(),
    ])
      reg.register(t as any);
    const byName = new Map(reg.definitions().map((d: ToolDefinition) => [d.name, d]));
    for (const name of ["ask_user_question", "edit", "write", "notebook_edit"]) {
      expect(byName.get(name)?.strictPriority ?? 0, name).toBeGreaterThan(0);
    }
    expect(byName.get("ask_user_question")!.strictPriority!).toBeGreaterThan(
      byName.get("edit")!.strictPriority!,
    );
  });

  test("超限时高优先级工具保住 strict（provider 读的是定义上的字段）", async () => {
    const { provider } = makeProvider({ baseURL: "https://gw-e.example.com" });
    let body: any;
    const orig = (provider as any).client.messages.create;
    (provider as any).client.messages.create = (b: any) => ((body = b), orig(b));
    const tools = makeTools(24, { tool_23: 100 });
    await drain(provider.sendMessageStream(params(tools)));
    expect(body.tools.find((t: any) => t.name === "tool_23").strict).toBe(true);
    // strictPriority 是内部排序字段，不得上线
    expect(body.tools.some((t: any) => "strictPriority" in t)).toBe(false);
  });
});
