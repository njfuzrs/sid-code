/**
 * D16：记忆 fork 首请求前缀对齐主循环（tools / thinking / messages 三处）。
 *
 * 背景：deepseek 族 fork 首请求命中率 p50 只有 6%。DeepSeek 的缓存键含 thinking 开关与 effort，
 * fork 写死关思考 → 整条前缀 0 命中；fork 发全量工具而主循环发 tool search 后的子集 → tools 段分叉；
 * fork 发原始消息而主循环发清理后的视图 → 长会话在第一个被清理的块处分叉。
 *
 * 断言都是「fork 实际发给 provider 的请求体 == 主循环最后一次实际发出的」，
 * 主循环侧走真实 queryLoop（不是手造快照），否则「loop 没接上」这类死接线测不出来。
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runForkedAgent, type ForkedAgentContext } from "@sid-code/core/agent/forked-agent.ts";
import { getMainRequestShape, resolveForkRequestShape } from "@sid-code/core/agent/fork-prefix.ts";
import { queryLoop, type QueryLoopConfig } from "@sid-code/core/query/loop.ts";
import type { QueryDeps } from "@sid-code/core/query/types.ts";
import { Manager as ContextManager } from "@sid-code/core/context/manager.ts";
import { Registry as ToolRegistry } from "@sid-code/core/tool/registry.ts";
import { ModelFallback } from "@sid-code/core/llm/fallback.ts";
import { SessionState } from "@sid-code/core/session/state.ts";
import type { Config } from "@sid-code/core/config/config.ts";
import type {
  AccumulatedResponse,
  Message,
  SendParams,
  StreamEvent,
} from "@sid-code/core/llm/types.ts";
import { getDialectWire } from "@sid-code/core/llm/dialect/catalog.ts";
import { observeRequestShape } from "@sid-code/core/llm/request-shape-observation.ts";

let tmpRoot = "";
const savedTmp = process.env.SID_CODE_TMPDIR;
beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "sid-fork-prefix-"));
  process.env.SID_CODE_TMPDIR = tmpRoot;
});
afterAll(() => {
  if (savedTmp === undefined) delete process.env.SID_CODE_TMPDIR;
  else process.env.SID_CODE_TMPDIR = savedTmp;
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** 最小工具：name 可配，shouldDefer 可配（模拟 tool search 延迟名单） */
function tool(name: string, shouldDefer = false) {
  return {
    name: () => name,
    description: () => `${name} 工具`,
    inputSchema: () => ({ type: "object", properties: {} }),
    execute: async () => ({ output: "ok" }),
    readOnly: () => true,
    ...(shouldDefer && { shouldDefer: true }),
  };
}

/** 主循环开着 tool search：read/edit/save_memory/write 首轮可见，bg_task_get/cron_create 延迟 */
function registryWithDeferred(): ToolRegistry {
  const r = new ToolRegistry();
  for (const t of [
    tool("read"),
    tool("edit"),
    tool("write"),
    tool("save_memory"),
    tool("bg_task_get", true),
    tool("cron_create", true),
  ]) {
    r.register(t as any);
  }
  return r;
}

/** 跑一轮真实 queryLoop，返回主循环实际交给 sendWithRetry 的 SendParams */
async function runMainLoop(opts: {
  ctxMgr: ContextManager;
  toolRegistry: ToolRegistry;
  model: string;
  provider: string;
  /** 注入一条 transient reminder（只进主循环发送副本，不进历史） */
  transientReminder?: string;
}): Promise<SendParams> {
  const sent: SendParams[] = [];
  async function* empty(): AsyncIterable<StreamEvent> {}
  const deps: QueryDeps = {
    sendWithRetry: (p: SendParams) => {
      sent.push(p);
      return empty();
    },
    processStream: async () =>
      ({
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1 },
      }) as AccumulatedResponse,
    executeTools: async () => ({ results: [] }),
    autoCompact: async () => ({ kind: "skipped" as const }),
    getAbortSignal: () => undefined,
    uuid: () => "uuid-test",
    // 走能力感知映射层（与生产 App 一致），deepseek 上解析出 thinking enabled + effort
    getEffortSetting: () => "max",
    getThinkingSetting: () => "on",
    ...(opts.transientReminder && {
      getPlanModeReminder: async () => opts.transientReminder!,
    }),
  };
  const loopConfig: QueryLoopConfig = {
    config: {
      model: opts.model,
      provider: opts.provider,
      maxTurns: 1,
      toolSearch: true,
    } as unknown as Config,
    ctxMgr: opts.ctxMgr,
    toolRegistry: opts.toolRegistry,
    sessionState: new SessionState("fork-prefix-test"),
    fallback: new ModelFallback(),
    deps,
  };
  for await (const _ev of queryLoop(loopConfig)) {
    /* drain */
  }
  expect(sent.length).toBeGreaterThan(0);
  return sent[sent.length - 1];
}

/** 捕获 fork 发出的 SendParams 的 provider */
function capturingProvider(captured: SendParams[]) {
  return {
    name: () => "mock",
    defaultModel: () => "mock-model",
    async *sendMessageStream(params: SendParams) {
      captured.push(params);
      yield {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { outputTokens: 1 },
      };
    },
  };
}

async function runFork(ctx: ForkedAgentContext, requiredTools?: string[]): Promise<SendParams> {
  const captured: SendParams[] = [];
  await runForkedAgent(
    { ...ctx, provider: capturingProvider(captured) as any },
    {
      promptMessages: [{ role: "user", content: [{ type: "text", text: "提取" }] }],
      canUseTool: () => ({ behavior: "deny", message: "x" }),
      maxTurns: 1,
      querySource: "memory-extract",
      ...(requiredTools && { requiredTools }),
      timeoutMs: 3000,
    },
  );
  expect(captured.length).toBe(1);
  return captured[0];
}

function forkContextFrom(
  ctxMgr: ContextManager,
  toolRegistry: ToolRegistry,
  model: string,
): ForkedAgentContext {
  return {
    systemPrompt: ctxMgr.getSystemPrompt(),
    messages: ctxMgr.getMessages(),
    sendMessages: ctxMgr.getForkPrefixMessages(),
    mainRequestShape: getMainRequestShape(ctxMgr),
    provider: undefined as any,
    toolRegistry,
    model,
  };
}

function freshCtx(): ContextManager {
  const ctxMgr = new ContextManager({ maxTokens: 200000 });
  ctxMgr.setSystemPrompt("system");
  ctxMgr.addMessage({ role: "user", content: [{ type: "text", text: "hi" }] });
  return ctxMgr;
}

describe("D16 · tools：fork 复用主循环最后一次实际发出的工具列表", () => {
  test("主循环开 tool search 发了子集 → fork 的 tools 与之逐项相同（不是 registry.definitions()）", async () => {
    const ctxMgr = freshCtx();
    const reg = registryWithDeferred();
    const main = await runMainLoop({
      ctxMgr,
      toolRegistry: reg,
      model: "deepseek-flash",
      provider: "openai",
    });
    // 前提：主循环确实发的是子集，否则本用例测不出东西
    expect(main.tools!.length).toBeLessThan(reg.definitions().length);

    const fork = await runFork(forkContextFrom(ctxMgr, reg, "deepseek-flash"));
    expect(JSON.stringify(fork.tools)).toBe(JSON.stringify(main.tools));
    expect(fork.forkPrefixSource).toBe("snapshot");
    // 观测字段两边同 hash：以后看两行 BilledRequest 就能判断是否对齐
    expect(observeRequestShape(fork).toolsHash).toBe(observeRequestShape(main).toolsHash);
  });

  test("快照缺 fork 必须用的工具 → 退回全量，prefix_source=fallback（不能让 fork 静默看不到工具）", async () => {
    const ctxMgr = freshCtx();
    const reg = registryWithDeferred();
    await runMainLoop({ ctxMgr, toolRegistry: reg, model: "deepseek-flash", provider: "openai" });

    const fork = await runFork(forkContextFrom(ctxMgr, reg, "deepseek-flash"), ["cron_create"]);
    expect(JSON.stringify(fork.tools)).toBe(JSON.stringify(reg.definitions()));
    expect(fork.forkPrefixSource).toBe("fallback");
    // 工具段已分叉，开思考只剩成本 → 维持关思考
    expect(fork.thinking).toEqual({ enabled: false, budgetTokens: 0 });
  });

  test("required 工具压根没注册 → 不算缺（退回全量也拿不到，退回只会白白放弃缓存）", () => {
    const shape = {
      model: "m",
      tools: [{ name: "read", description: "", input_schema: {} }],
    } as any;
    const r = resolveForkRequestShape(shape, "m", () => shape.tools, ["save_memory"]);
    expect(r.prefixSource).toBe("snapshot");
  });

  test("主循环还没发过请求 / 模型已切换 → 退回全量（改造前行为）", () => {
    const full = () => [{ name: "a" }, { name: "b" }] as any;
    expect(resolveForkRequestShape(undefined, "m", full).prefixSource).toBe("fallback");
    const shape = { model: "old", tools: [{ name: "a" }] } as any;
    const r = resolveForkRequestShape(shape, "new", full);
    expect(r.fallbackReason).toBe("model_changed");
    expect(r.tools.length).toBe(2);
  });
});

describe("D16 · thinking：只在缓存键含思考参数的族上照搬", () => {
  test("方言声明：只有 deepseek-openai 为 true（实测过），没测过的族保持 false", () => {
    expect(getDialectWire("deepseek-openai").cacheKeyIncludesThinking).toBe(true);
    for (const k of [
      "anthropic-native",
      "deepseek-anthropic",
      "glm-openai",
      "grok-openai",
      "o-series",
      "openai-responses",
      "unknown",
    ] as const) {
      expect(getDialectWire(k).cacheKeyIncludesThinking).toBe(false);
    }
  });

  test("DeepSeek 族：fork 的 thinking / reasoningEffort = 主循环最后一次实发值", async () => {
    const ctxMgr = freshCtx();
    const reg = registryWithDeferred();
    const main = await runMainLoop({
      ctxMgr,
      toolRegistry: reg,
      model: "deepseek-flash",
      provider: "openai",
    });
    // 前提：主循环确实开了思考，否则「照搬」与「写死关闭」不可区分
    expect(main.thinking?.enabled).toBe(true);
    expect(main.reasoningEffort).toBeDefined();

    const fork = await runFork(forkContextFrom(ctxMgr, reg, "deepseek-flash"));
    expect(fork.thinking).toEqual(main.thinking);
    expect(fork.reasoningEffort).toBe(main.reasoningEffort);
    // DeepSeek 的 max_tokens 含思维链：照搬思考时上限不得低于主循环
    expect(fork.maxTokens).toBeGreaterThanOrEqual(main.maxTokens ?? 0);
  });

  test("Anthropic 族：缓存键不含 thinking → fork 仍发 SIDE_CALL_NO_THINK，但工具照样对齐", async () => {
    const ctxMgr = freshCtx();
    const reg = registryWithDeferred();
    const main = await runMainLoop({
      ctxMgr,
      toolRegistry: reg,
      model: "claude-opus-5-5",
      provider: "anthropic",
    });
    const fork = await runFork(forkContextFrom(ctxMgr, reg, "claude-opus-5-5"));
    expect(fork.thinking).toEqual({ enabled: false, budgetTokens: 0 });
    expect(fork.reasoningEffort).toBeUndefined();
    expect(fork.outputConfig).toBeUndefined();
    expect(JSON.stringify(fork.tools)).toBe(JSON.stringify(main.tools));
  });
});

describe("D16 · messages：fork 发主循环的发送视图（清理后），且不推进清理状态", () => {
  /** 9 轮大输出（> 30K 阈值，超过 KEEP_RECENT=6）→ 最早几条会被清成占位 */
  function bigHistory(): Message[] {
    const msgs: Message[] = [{ role: "user", content: [{ type: "text", text: "开始" }] }];
    for (let i = 0; i < 9; i++) {
      msgs.push({
        role: "assistant",
        content: [{ type: "tool_use", id: `t${i}`, name: "bash", input: { command: `c${i}` } }],
      });
      msgs.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: `t${i}`, content: `${i}`.repeat(31_000) }],
      });
    }
    msgs.push({ role: "assistant", content: [{ type: "text", text: "完成" }] });
    msgs.push({ role: "user", content: [{ type: "text", text: "继续" }] });
    return msgs;
  }

  test("触发大输出清理后，fork 前缀里是 [已清理: …] 占位，与主循环发出的逐字节相同", () => {
    const ctxMgr = new ContextManager({ maxTokens: 10_000_000 });
    ctxMgr.setMessages(bigHistory());
    const sent = ctxMgr.getCleanedMessages();
    const sentT0 = (sent[2].content[0] as any).content as string;
    expect(sentT0.startsWith("[已清理")).toBe(true);

    const view = ctxMgr.getForkPrefixMessages();
    expect(JSON.stringify(view)).toBe(JSON.stringify(sent));
    // 主历史不被改写
    expect((ctxMgr.getMessages()[2].content[0] as any).content).toBe("0".repeat(31_000));
  });

  test("getForkPrefixMessages 只读：调用后主循环下一次发送视图不变、不新增清理原因", () => {
    const ctxMgr = new ContextManager({ maxTokens: 10_000_000 });
    ctxMgr.setMessages(bigHistory());
    const first = JSON.stringify(ctxMgr.getCleanedMessages());
    ctxMgr.consumeSendMutationCauses();
    ctxMgr.getForkPrefixMessages();
    ctxMgr.getForkPrefixMessages();
    expect(ctxMgr.consumeSendMutationCauses()).toEqual([]);
    expect(JSON.stringify(ctxMgr.getCleanedMessages())).toBe(first);
  });

  test("fork 发出的 messages 前缀 = sendMessages，不是原始 messages", async () => {
    const ctxMgr = new ContextManager({ maxTokens: 10_000_000 });
    ctxMgr.setSystemPrompt("system");
    ctxMgr.setMessages(bigHistory());
    ctxMgr.getCleanedMessages();
    const reg = registryWithDeferred();
    const fork = await runFork(forkContextFrom(ctxMgr, reg, "deepseek-flash"));
    // fork.messages 是 fork 的会话数组引用（发完后还会 push 回复），按前缀长度截取
    const expected = ctxMgr.getForkPrefixMessages();
    const prefix = fork.messages.slice(0, expected.length);
    expect(JSON.stringify(prefix)).toBe(JSON.stringify(expected));
    expect((prefix[2].content[0] as any).content.startsWith("[已清理")).toBe(true);
  });

  test("快照不含 transient reminder：主循环本轮注入的提醒不出现在 fork 前缀里", async () => {
    const ctxMgr = freshCtx();
    const reg = registryWithDeferred();
    const marker = "D16_TRANSIENT_MARKER_只在发送副本里";
    const main = await runMainLoop({
      ctxMgr,
      toolRegistry: reg,
      model: "deepseek-flash",
      provider: "openai",
      transientReminder: marker,
    });
    // 前提：主循环发送副本里确实有它、历史里没有，否则下面的断言恒绿
    expect(JSON.stringify(main.messages)).toContain(marker);
    expect(JSON.stringify(ctxMgr.getMessages())).not.toContain(marker);

    const fork = await runFork(forkContextFrom(ctxMgr, reg, "deepseek-flash"));
    expect(JSON.stringify(fork.messages)).not.toContain(marker);
  });
});

describe("D16 · 思维链：fork 开思考后 reasoning 不混进正文", () => {
  test("OpenAI 族 thinking 通道（text + _raw_block.thinking）进 _meta.reasoning_content，不进 content", async () => {
    const provider = {
      name: () => "mock",
      defaultModel: () => "deepseek-flash",
      async *sendMessageStream() {
        yield {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
          _raw_block: { type: "thinking" },
        };
        yield {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "先想想" },
        };
        yield { type: "content_block_stop", index: 0 };
        yield { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } };
        yield {
          type: "content_block_delta",
          index: 1,
          delta: { type: "text_delta", text: "答案" },
        };
        yield { type: "content_block_stop", index: 1 };
        yield {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { outputTokens: 2 },
        };
      },
    };
    const res = await runForkedAgent(
      {
        systemPrompt: "s",
        messages: [{ role: "user", content: [{ type: "text", text: "q" }] }],
        provider: provider as any,
        toolRegistry: new ToolRegistry(),
        model: "deepseek-flash",
      },
      {
        promptMessages: [{ role: "user", content: [{ type: "text", text: "p" }] }],
        canUseTool: () => ({ behavior: "deny", message: "x" }),
        maxTurns: 1,
        querySource: "side-question",
        timeoutMs: 3000,
      },
    );
    const last = res.messages[res.messages.length - 1];
    expect(JSON.stringify(last.content)).not.toContain("先想想");
    expect(last.content).toEqual([{ type: "text", text: "答案" }]);
    expect(last._meta?.reasoning_content).toBe("先想想");
  });
});
