/**
 * PR5：explore 默认轮次上限 + sub_agent 调用级 max_turns + 剩余轮次可见（D1）
 *
 * 三件事各自都有「看起来改对了但实际没接线」的失败形态，所以每条都断言到**接线**上：
 *   ① explore 默认上限 —— 只改 `BUILTIN_AGENTS.explore.maxTurns` 而不被
 *      `resolveSubAgentMaxTurns` 消费，等于写了个没人读的常量；
 *   ② 调用级 max_turns —— 只改 schema 而 execute 不透传，模型传了也不生效，
 *      而且 schema 会接受这个参数、整个过程静默无报错（最难发现的一种）；
 *   ③ 剩余轮次提示 —— 只在源码里写了文案而没有真正进发送副本，模型看不到。
 *
 * 定值依据（E1 预登记规则，跑前写死）：修复后组 explore 轮次最大值 M=145、
 * 长跑（>66 轮）子代理的重复读率 r=42.9% > 35% → 第三档「暂定 100，不调大」。
 * 所以 `explore.maxTurns === 100` 是**结论级断言**，不是随手挑的数字。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { SubAgentTool } from "@sid-code/core/agent/tool.ts";
import { SubAgent } from "@sid-code/core/agent/sub-agent.ts";
import { BUILTIN_AGENTS, clearDynamicAgents } from "@sid-code/core/agent/agent-definition.ts";
import { resolveSubAgentMaxTurns } from "@sid-code/core/agent/sub-agent.ts";
import { runAgentLoop, turnBudgetNoticeThreshold } from "@sid-code/core/agent/agentic-loop.ts";
import { Manager as ContextManager } from "@sid-code/core/context/manager.ts";
import { Registry as ToolRegistry } from "@sid-code/core/tool/registry.ts";
import { LoopDetector } from "@sid-code/core/agent/loop-detection.ts";
import { ProviderRegistry } from "@sid-code/core/llm/registry.ts";
import type { Provider } from "@sid-code/core/llm/provider.ts";
import type { SendParams, StreamEvent } from "@sid-code/core/llm/types.ts";
import type { LegacyTool, LegacyToolResult } from "@sid-code/core/tool/types.ts";

/** 提示文案里可被识别的片段（断言注入与否只看这一处，避免把整段文案写两遍） */
const TURN_BUDGET_MARK = "轮次预算提示";

// ─────────────────────────────────────────────────────────────
// ① explore 默认上限（定值 + 解析链）
// ─────────────────────────────────────────────────────────────

describe("PR5①：explore 默认轮次上限 = 100（E1 预登记规则定值）", () => {
  test("BUILTIN_AGENTS.explore.maxTurns 是 100，且只给 explore 加", () => {
    // 定值本身：E1 第三档结论，改这个数字必须同时更新方案文档的判读记录
    expect(BUILTIN_AGENTS.explore!.maxTurns).toBe(100);
    // 只给 explore —— verify / task / general-purpose 的长尾没有证据表明异常，
    // 顺手全加上会让「改一个已知异常」变成「改所有子代理的行为」
    expect(BUILTIN_AGENTS.verify!.maxTurns).toBeUndefined();
    expect(BUILTIN_AGENTS.task!.maxTurns).toBeUndefined();
    expect(BUILTIN_AGENTS["general-purpose"]!.maxTurns).toBeUndefined();
  });

  test("定义默认值真的被 resolveSubAgentMaxTurns 消费（接线断言）", () => {
    // 只声明不消费 = 常量没人读。这条断言的就是 agentic-loop 取到的那个值。
    expect(resolveSubAgentMaxTurns({}, BUILTIN_AGENTS.explore!.maxTurns)).toBe(100);
    // 未声明上限的类型仍是无上限（Infinity，不是 undefined —— 见该函数注释）
    expect(resolveSubAgentMaxTurns({}, BUILTIN_AGENTS.verify!.maxTurns)).toBe(Infinity);
  });

  test("调用级优先于定义默认值，非法调用级值不改变语义", () => {
    // 事后重派路径：explore 打满后用更大的值重派
    expect(resolveSubAgentMaxTurns({ maxTurns: 300 }, 100)).toBe(300);
    // 更小的值也尊重（调用方可能只想快速探一下）
    expect(resolveSubAgentMaxTurns({ maxTurns: 5 }, 100)).toBe(5);
    // 0 / 负数 / 非数是「未提供」而不是「一轮都不跑」（既有语义，防回归）
    expect(resolveSubAgentMaxTurns({ maxTurns: 0 }, 100)).toBe(100);
    expect(resolveSubAgentMaxTurns({ maxTurns: -1 }, 100)).toBe(100);
  });
});

// ─────────────────────────────────────────────────────────────
// ② sub_agent 的 max_turns 参数真的到得了子代理
// ─────────────────────────────────────────────────────────────

describe("PR5②：sub_agent 的 max_turns 透传到 SubAgentTask", () => {
  let configRoot: string;
  let prevConfigDir: string | undefined;
  let prevCwd: string;

  beforeEach(() => {
    // 落盘隔离：子代理 / logger 会写 getSidHome()，不重定向会灌进用户真实的 ~/.sid-code
    configRoot = mkdtempSync(join(tmpdir(), "sid-pr5-cfg-"));
    prevConfigDir = process.env.SID_CONFIG_DIR;
    process.env.SID_CONFIG_DIR = configRoot;
    prevCwd = process.cwd();
    clearDynamicAgents();
  });

  afterEach(() => {
    if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
    else process.env.SID_CONFIG_DIR = prevConfigDir;
    process.chdir(prevCwd);
    clearDynamicAgents();
  });

  /**
   * 拦在 SubAgent.execute 之前：只验证工具层把参数放进了任务对象，
   * 不真的跑子代理循环（那要模型、要网络，且断言不到「参数有没有被接线」）。
   *
   * 返回的 `original` 由调用方在 finally 里恢复 —— 直接覆盖原型方法而不恢复，
   * 会让同批其他测试文件里的子代理全部静默返回假结果。
   *
   * `wrapper.called` 是给**后台路径**用的：`runAsync` 是 fire-and-forget
   * （`void this.executeInBackground(...)`），`tool.execute()` 返回时子代理
   * 很可能还没被调用，必须等这个 Promise 而不是立刻断言。
   */
  function captureTask(): {
    wrapper: { value: any; called: Promise<void> };
    original: typeof SubAgent.prototype.execute;
  } {
    let resolveCalled: () => void = () => {};
    const called = new Promise<void>((r) => (resolveCalled = r));
    const wrapper: { value: any; called: Promise<void> } = { value: undefined, called };
    const original = SubAgent.prototype.execute;
    SubAgent.prototype.execute = async function (task: any) {
      wrapper.value = task;
      resolveCalled();
      return {
        success: true,
        output: "ok",
        usage: { inputTokens: 0, outputTokens: 0 },
        turns: 1,
        toolUseCount: 0,
      } as any;
    };
    return { wrapper, original };
  }

  function makeTool(): SubAgentTool {
    // 必须给一个**可解析**的 provider：构造 SubAgent 会走 getProviderFor()，
    // 配置为空会抛「未知的 Provider」，于是 execute 提前返回错误、SubAgent.execute
    // 根本轮不到被调用 —— 那样测出来的是「配置不全」，不是「参数没透传」。
    // 真正的模型调用由下面的 mock execute 拦住，不会发网络请求。
    const providerRegistry = new ProviderRegistry(
      { provider: "anthropic", model: "mock-model" } as never,
      {},
    );
    return new SubAgentTool(providerRegistry, new ToolRegistry() as never);
  }

  test("传了 max_turns → 任务对象上带着同一个值", async () => {
    const { wrapper, original } = captureTask();
    try {
      const tool = makeTool();
      await tool.execute({
        type: "explore",
        description: "d",
        prompt: "p",
        max_turns: 7,
      });
      expect(wrapper.value?.maxTurns).toBe(7);
    } finally {
      SubAgent.prototype.execute = original;
    }
  });

  test("不传 max_turns → 任务对象不带值（由 Agent 定义默认值兜底）", async () => {
    const { wrapper, original } = captureTask();
    try {
      const tool = makeTool();
      await tool.execute({ type: "explore", description: "d", prompt: "p" });
      // 必须是 undefined 而不是某个猜出来的数字：调用级「未提供」的语义要留到
      // resolveSubAgentMaxTurns 那一层和 Agent 默认值合并，工具层不能替它决定。
      expect(wrapper.value?.maxTurns).toBeUndefined();
    } finally {
      SubAgent.prototype.execute = original;
    }
  });

  test("后台路径（run_in_background）同样透传 —— 两条执行路径不能只改一条", async () => {
    const { wrapper, original } = captureTask();
    try {
      const tool = makeTool();
      await tool.execute({
        type: "explore",
        description: "d",
        prompt: "p",
        run_in_background: true,
        max_turns: 9,
      });
      // runAsync 是 fire-and-forget：execute() 返回 task_id 时子代理可能还没起跑，
      // 必须等它真的调 SubAgent.execute 之后再断言（否则测的是时序而不是透传）。
      await wrapper.called;
      expect(wrapper.value?.maxTurns).toBe(9);
    } finally {
      SubAgent.prototype.execute = original;
    }
  });

  test("schema 接受 max_turns（否则模型传了会在校验层被拒）", () => {
    const tool = makeTool();
    const schema = JSON.stringify(tool.inputSchema());
    expect(schema).toContain("max_turns");
  });
});

// ─────────────────────────────────────────────────────────────
// ③ 剩余轮次可见（D1）：阈值 + 注入一次 + 无上限不注入
// ─────────────────────────────────────────────────────────────

describe("PR5③：剩余轮次提示的阈值计算", () => {
  test("上限 100 → 剩余 10 轮时提示（10%）", () => {
    expect(turnBudgetNoticeThreshold(100)).toBe(10);
  });

  test("小上限走 3 轮下限（10% 会小于 3）", () => {
    expect(turnBudgetNoticeThreshold(10)).toBe(3);
    expect(turnBudgetNoticeThreshold(5)).toBe(3);
    expect(turnBudgetNoticeThreshold(1)).toBe(3);
  });

  test("无上限（Infinity）→ 阈值也是 Infinity，永不触发", () => {
    expect(turnBudgetNoticeThreshold(Infinity)).toBe(Infinity);
  });
});

/** 造一条 tool_use 流：每轮都调 read，跑到 maxTurns 自然退出 */
async function* readStream(id: string): AsyncIterable<StreamEvent> {
  yield { type: "message_start", message: { usage: { inputTokens: 10, outputTokens: 0 } } } as any;
  yield {
    type: "content_block_start",
    index: 0,
    content_block: { type: "tool_use", id, name: "read" },
  } as any;
  yield {
    type: "content_block_delta",
    index: 0,
    delta: { type: "input_json_delta", partial_json: JSON.stringify({ file_path: "a" }) },
  } as any;
  yield { type: "content_block_stop", index: 0 } as any;
  yield {
    type: "message_delta",
    delta: { stop_reason: "tool_use" },
    usage: { outputTokens: 5 },
  } as any;
}

/** 纯文本收尾流：让循环在第 N 轮自然结束（用于「无上限」场景，不能真跑到 Infinity） */
async function* endTurnStream(): AsyncIterable<StreamEvent> {
  yield { type: "message_start", message: { usage: { inputTokens: 10, outputTokens: 0 } } } as any;
  yield {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  } as any;
  yield {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "结论" },
  } as any;
  yield { type: "content_block_stop", index: 0 } as any;
  yield {
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
    usage: { outputTokens: 1 },
  } as any;
}

class ReadTool implements LegacyTool {
  name() {
    return "read";
  }
  description() {
    return "read";
  }
  inputSchema() {
    return { type: "object", properties: { file_path: { type: "string" } } };
  }
  readOnly() {
    return true;
  }
  async execute(): Promise<LegacyToolResult> {
    return { output: "ok" };
  }
}

/** 驱动真实 runAgentLoop，记录**每一次**实际发出的 messages */
function run(maxTurns: number) {
  const sent: SendParams[] = [];
  const provider = {
    name: () => "mock",
    defaultModel: () => "mock-model",
    sendMessageStream: (params: SendParams) => {
      sent.push({ ...params, messages: [...params.messages] });
      return readStream(`t${sent.length}`);
    },
  } as unknown as Provider;

  const tools = new ToolRegistry();
  tools.register(new ReadTool() as any);

  const ctxMgr = new ContextManager({ maxTokens: 100_000 });
  ctxMgr.setSystemPrompt("test");
  ctxMgr.addMessage({ role: "user", content: [{ type: "text", text: "任务" }] });

  const promise = runAgentLoop({
    provider,
    model: "mock-model",
    ctxMgr,
    tools,
    maxTurns,
    signal: new AbortController().signal,
    loopDetector: new LoopDetector(),
    maxStreamRetries: 0,
    agentId: "agent-pr5-1",
  } as any);

  return { promise, sent, ctxMgr };
}

/** 把消息数组里所有 text block 拼起来（只看文本，不关心块结构） */
function textOf(messages: readonly unknown[] | undefined): string {
  if (!messages) return "";
  const out: string[] = [];
  for (const msg of messages as Array<{ content?: Array<{ type?: string; text?: string }> }>) {
    for (const block of msg.content ?? []) {
      if (block?.type === "text" && typeof block.text === "string") out.push(block.text);
    }
  }
  return out.join("\n");
}

describe("PR5③：剩余轮次提示进发送副本、只注入一次、无上限不注入", () => {
  test("maxTurns=5（阈值 3）→ 第 2 轮起注入，且带「还剩」的数字", async () => {
    const { promise, sent } = run(5);
    await promise;

    // 阈值 = max(3, ⌈5×0.1⌉) = 3：剩余 ≤ 3 即 turns ≥ 2 时注入（5-2=3）
    expect(textOf(sent[0]!.messages)).not.toContain(TURN_BUDGET_MARK);
    expect(textOf(sent[1]!.messages)).toContain(TURN_BUDGET_MARK);
    // 数字要准：第 2 轮剩余 3 轮，模型才能据此判断「再深挖一层」还是「现在收」
    expect(textOf(sent[1]!.messages)).toContain("还剩 3 轮");
  });

  test("只注入一次：后续轮次的剩余数字递减，但提示不再出现", async () => {
    const { promise, sent } = run(5);
    await promise;

    // 第 3 轮 remaining=2、第 4 轮 remaining=1 都落在阈值内，但只注入过一次。
    // 断言「0 次」而不是「1 次」：注入是 transient 的，只进当轮发送副本、不写回 ctxMgr，
    // 所以第 2 轮那条在第 3 轮的发送副本里本就不存在（这正是它与 LSP/todo 注入共享的不变量）。
    expect(textOf(sent[2]!.messages)).not.toContain(TURN_BUDGET_MARK);
    expect(textOf(sent[3]!.messages)).not.toContain(TURN_BUDGET_MARK);
  });

  test("不写回 ctxMgr（与 LSP / todo 注入同一条不变量）", async () => {
    const { promise, ctxMgr } = run(5);
    await promise;

    // 注入只进发送副本；历史里一旦留下，之后每轮都会重发给模型直到被压缩裁掉
    const history = ctxMgr.getMessages();
    expect(textOf(history)).not.toContain(TURN_BUDGET_MARK);
  });

  test("maxTurns=50（阈值 5）→ 第 45 轮才注入，早期轮次干净", async () => {
    const { promise, sent } = run(50);
    await promise;

    // 阈值为 max(3, ⌈50×0.1⌉) = 5，第 45 轮 remaining=5
    expect(textOf(sent[43]!.messages)).not.toContain(TURN_BUDGET_MARK);
    expect(textOf(sent[44]!.messages)).toContain(TURN_BUDGET_MARK);
    expect(textOf(sent[44]!.messages)).toContain("还剩 5 轮");
  });

  test("无上限（Infinity）→ 永不注入", async () => {
    const sent: SendParams[] = [];
    const provider = {
      name: () => "mock",
      defaultModel: () => "mock-model",
      // 第 3 轮改走 end_turn，让「无上限」的循环能自然结束
      sendMessageStream: (params: SendParams) => {
        sent.push({ ...params, messages: [...params.messages] });
        return sent.length < 3 ? readStream(`t${sent.length}`) : endTurnStream();
      },
    } as unknown as Provider;

    const tools = new ToolRegistry();
    tools.register(new ReadTool() as any);
    const ctxMgr = new ContextManager({ maxTokens: 100_000 });
    ctxMgr.setSystemPrompt("test");
    ctxMgr.addMessage({ role: "user", content: [{ type: "text", text: "任务" }] });

    await runAgentLoop({
      provider,
      model: "mock-model",
      ctxMgr,
      tools,
      maxTurns: Infinity,
      signal: new AbortController().signal,
      loopDetector: new LoopDetector(),
      maxStreamRetries: 0,
      agentId: "agent-pr5-inf",
    } as any);

    // 无上限的调用永远不该收到「快用完了」——那会凭空制造一个不存在的截止时间
    for (const params of sent) {
      expect(textOf(params.messages)).not.toContain(TURN_BUDGET_MARK);
    }
  });
});
