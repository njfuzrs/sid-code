/**
 * PR3（C1）：子代理关闭过期清理通道
 *
 * 背景：`stale-tool-output.ts` 的 K=8 轮 / N=20k token 两个门槛是在**主会话**负载上定的，
 * 从没进过子代理的校准集。子代理是纯只读负载——`collectActiveFiles` 只认 edit/write，
 * 它一个文件都豁免不了——所以在子代理侧开着这条通道，会形成
 * 「正在研读的核心文件被清成占位 → 模型重读 → 再被清」的循环（2026-11-16 实测 16 个子代理
 * 71.8% 的 read 是重复读，报告里自述「证据已过期清理」）。
 *
 * 本文件守两件事，缺一不可（只测选项本身不够，仓库有过「白名单绿测零调用」的教训）：
 *  1. 选项语义：`staleToolOutputClear: false` 真的不清理；**默认构造照常清理**（主循环不变）。
 *  2. 接线：三处子代理构造点都传了 `false`；主循环构造点不传。
 *     其中两处（进程内 `executeInner` / `executeCustomInner`）用真实子代理执行路径断言
 *     模型收到的消息里不出现清理占位；第三处（spawn 子进程）与主循环用源码扫描断言——
 *     spawn 路径要起独立进程，进程内测试覆盖不到它，静态扫描才能三处一起守。
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearDynamicAgents,
  registerDynamicAgents,
} from "@sid-code/core/agent/agent-definition.ts";
import { SubAgent } from "@sid-code/core/agent/sub-agent.ts";
import { Manager } from "@sid-code/core/context/manager.ts";
import type { Provider } from "@sid-code/core/llm/provider.ts";
import type { Message, SendParams, StreamEvent } from "@sid-code/core/llm/types.ts";
import { Registry } from "@sid-code/core/tool/registry.ts";
import type { LegacyTool, LegacyToolResult } from "@sid-code/core/tool/types.ts";

// ── 落盘隔离：Manager.addMessage 会对超阈值结果调 persistLargeOutput，子代理还会写 sidechain。
// 不隔离就会往真实的 ~/.sid-code/ 里灌假数据（门禁见 telemetry/no-real-path-writes.test.ts）。
let tmpRoot = "";
const savedConfigDir = process.env.SID_CONFIG_DIR;
const savedTmpDir = process.env.SID_CODE_TMPDIR;
/**
 * 运行时接线测试必须让**仓库真实的 read 工具**读到**真实存在的大文件**。
 *
 * 踩过的坑（值得留着）：`read` 在 `STATEFUL_TOOL_NAMES` 里，子代理执行时会用
 * `createStatefulTools` **重建真实 read**，把测试注册的 mock 同名工具替换掉。
 * 于是 mock 的 8,000 字符输出从未出现，真实 read 读不存在的路径只返回 284 字符错误，
 * 远低于 500 字符候选门槛 —— 无论开关有没有生效都不清理，断言**恒绿**。
 * 这个坑是变异自证时发现的：删掉传参后静态断言红了、运行时仍绿，才查到根因。
 */
const BIG_FILE_CHARS = 8_000;
let bigFiles: string[] = [];
beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "sid-stale-off-"));
  process.env.SID_CONFIG_DIR = tmpRoot;
  process.env.SID_CODE_TMPDIR = tmpRoot;
  // 100 行 × 80 字符：避免单行过长被 read 工具截断
  const lines = Array.from({ length: 100 }, () =>
    Array.from({ length: 80 }, (_, j) => String.fromCharCode(97 + (j % 26))).join(""),
  ).join("\n");
  for (let i = 0; i < ROUNDS; i++) {
    const p = join(tmpRoot, `big-${i}.ts`);
    writeFileSync(p, `${lines}\n// file ${i}\n`);
    bigFiles.push(p);
  }
});
afterAll(() => {
  // 必须存/恢复原值：同批多文件跑在同一进程里，无条件 delete 会把 preload 的兜底一起抹掉。
  if (savedConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = savedConfigDir;
  if (savedTmpDir === undefined) delete process.env.SID_CODE_TMPDIR;
  else process.env.SID_CODE_TMPDIR = savedTmpDir;
  rmSync(tmpRoot, { recursive: true, force: true });
});
afterEach(() => {
  clearDynamicAgents();
});

type Call = { name: string; input: Record<string, unknown>; chars?: number };

/**
 * 判据参数（2026-11-17 用 `planStaleToolOutputClear` 实测标定，不是猜的）：
 *
 * - **工具名必须是 `read`**：`buildReplacement` 只对 `DISCARDABLE_TOOLS` 白名单
 *   （read / grep / glob / ls / …）生成占位，自定义名字（如 `probe_read`）一律返回 null
 *   → 永不清理。用错名字会让「不清理」的断言恒绿，无论开关有没有生效。
 * - **24 轮 × 8,000 字符才过 N=20k token**：`roundsAfter >= K=8` 只覆盖前 `轮数-8` 条，
 *   释放量还要累计 ≥20k token。实测 10 轮×8k、18 轮×8k 都**不触发**，20 轮×12k、
 *   24 轮×8k、16 轮×25k 才触发；取 24×8k 留足余量。
 */
const ROUNDS = 24;
const CHARS = 8_000;

/** 每个 call 一轮：assistant(tool_use) + user(tool_result) */
function history(calls: Call[]): Message[] {
  const msgs: Message[] = [{ role: "user", content: [{ type: "text", text: "开始" }] }];
  calls.forEach((c, i) => {
    msgs.push({
      role: "assistant",
      content: [{ type: "tool_use", id: `t${i}`, name: c.name, input: c.input }],
    });
    msgs.push({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: `t${i}`,
          // 随机感文本：重复字符会被估算器判成异常低的 token 数，压不到 N 门槛
          content: Array.from({ length: c.chars ?? CHARS }, (_, j) =>
            String.fromCharCode(97 + ((i * 7 + j * 13) % 26)),
          ).join(""),
        },
      ],
    });
  });
  return msgs;
}

function reads(n: number, chars?: number): Call[] {
  return Array.from({ length: n }, (_, i) => ({
    name: "read",
    input: { file_path: `src/f${i}.ts` },
    chars,
  }));
}

function resultOf(sent: Message[], id: string): string | undefined {
  for (const m of sent) {
    for (const b of m.content) {
      if (b.type === "tool_result" && b.tool_use_id === id) return b.content;
    }
  }
  return undefined;
}

/** 标定过的数据：24 轮 × 8,000 字符的 read，实测必然触发过期清理（见上方注释） */
const LONG_HISTORY = () => history(reads(ROUNDS));

describe("选项本身：staleToolOutputClear 语义", () => {
  test("传 false：超过 K 轮、超过 N token 之后也不清理，不发 stale_clear", () => {
    const mgr = new Manager({ maxTokens: 1_000_000, staleToolOutputClear: false });
    mgr.setMessages(LONG_HISTORY());
    mgr.consumeSendMutationCauses();
    const sent = mgr.getCleanedMessages();
    // 占位文案一字不出现，原文完整保留
    for (const [i] of reads(ROUNDS).entries()) {
      expect(resultOf(sent, `t${i}`)).not.toContain("已过期清理");
    }
    expect(resultOf(sent, "t0")?.length).toBe(CHARS);
    expect(mgr.consumeSendMutationCauses()).not.toContain("stale_clear");
  });

  test("默认构造（主循环路径）：照常清理，守住 11-12 的决定不被误伤", () => {
    const mgr = new Manager({ maxTokens: 1_000_000 });
    mgr.setMessages(LONG_HISTORY());
    const sent = mgr.getCleanedMessages();
    expect(resultOf(sent, "t0")).toContain("已过期清理");
    // 原始历史不被改写
    expect(resultOf(mgr.getMessages(), "t0")?.length).toBe(CHARS);
  });

  test("显式传 true 等同于默认（不是「传了就不清」的畸形语义）", () => {
    const mgr = new Manager({ maxTokens: 1_000_000, staleToolOutputClear: true });
    mgr.setMessages(LONG_HISTORY());
    expect(resultOf(mgr.getCleanedMessages(), "t0")).toContain("已过期清理");
  });
});

// ───────────────────────── 接线：真实子代理执行路径 ─────────────────────────

function toolUseEvents(turn: number, toolName: string): StreamEvent[] {
  return [
    {
      type: "message_start",
      message: { usage: { inputTokens: 10, outputTokens: 0 } },
    } as StreamEvent,
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: `${toolName}-${turn}`, name: toolName },
    } as StreamEvent,
    {
      type: "content_block_delta",
      index: 0,
      // input 必须指向**真实存在的大文件**：子代理会用 createStatefulTools 重建真实 read，
      // 读不存在的路径只会返回 284 字符错误，永远进不了清理候选（实测踩过，导致断言恒绿）。
      delta: {
        type: "input_json_delta",
        partial_json: JSON.stringify({ file_path: bigFiles[turn - 1] }),
      },
    } as StreamEvent,
    { type: "content_block_stop", index: 0 } as StreamEvent,
    {
      type: "message_delta",
      delta: { stop_reason: "tool_use" },
      usage: { outputTokens: 5 },
    } as StreamEvent,
  ];
}

function textEvents(text: string): StreamEvent[] {
  return [
    {
      type: "message_start",
      message: { usage: { inputTokens: 10, outputTokens: 0 } },
    } as StreamEvent,
    { type: "content_block_start", index: 0, content_block: { type: "text" } } as StreamEvent,
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } as StreamEvent,
    { type: "content_block_stop", index: 0 } as StreamEvent,
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { outputTokens: 5 },
    } as StreamEvent,
  ];
}

/**
 * 记录**模型实际收到的消息**。这是整个接线断言的关键观测点：
 * 过期清理只改写「发送投影」，不改原始历史，所以只有看 provider 收到的 messages
 * 才能区分「通道开着」和「通道关着」。
 */
class RecordingProvider implements Provider {
  calls = 0;
  received: Message[][] = [];

  constructor(
    private readonly toolTurns: number,
    private readonly toolName: string,
  ) {}

  name(): string {
    return "mock";
  }

  defaultModel(): string {
    return "mock-model";
  }

  async *sendMessageStream(params: SendParams): AsyncIterable<StreamEvent> {
    this.calls++;
    this.received.push(structuredClone(params.messages));
    if (this.calls <= this.toolTurns) {
      yield* toolUseEvents(this.calls, this.toolName);
      return;
    }
    yield* textEvents("检查完成");
  }
}

/**
 * **只作占位**：名字必须叫 `read`（`filterToolsForAgent` 按名字匹配，且白名单外永不清理）。
 * 它自己不会被真正执行 —— 子代理的 `buildIsolatedToolRegistry` 会用 `createStatefulTools`
 * 重建真实 read 替换它。真实 read 读的是 `bigFiles` 里的大文件，输出才有 8,000 字符量级。
 */
class BigOutputTool implements LegacyTool {
  calls = 0;

  constructor(private readonly toolName: string) {}

  name(): string {
    return this.toolName;
  }

  description(): string {
    return "返回一大段用于触发过期清理的读取结果";
  }

  inputSchema(): Record<string, unknown> {
    return { type: "object", properties: {} };
  }

  readOnly(): boolean {
    return true;
  }

  async execute(): Promise<LegacyToolResult> {
    this.calls++;
    return {
      output: Array.from({ length: CHARS }, (_, j) =>
        String.fromCharCode(97 + ((this.calls * 7 + j * 13) % 26)),
      ).join(""),
    };
  }
}

/** 所有轮次里模型收到的消息串起来——只要有一轮出现占位，就说明通道开着 */
function allReceivedText(provider: RecordingProvider): string {
  return provider.received
    .flatMap((msgs) => msgs.flatMap((m) => m.content))
    .map((b) => (b.type === "tool_result" ? b.content : b.type === "text" ? b.text : ""))
    .join("\n");
}

/**
 * 假绿守卫：先证明「工具结果真的够大、真的读到了文件」，再断言「没被清理」。
 *
 * 缺了这一步，工具名写错 / 路径不存在 / 工具被替换 任一种情况都会让结果只有几百字符，
 * 于是「不清理」永远成立而测试永远绿 —— 本测试第一版就是这么假绿的。
 */
function assertRealBigResults(provider: RecordingProvider): void {
  const blocks = provider.received
    .flatMap((msgs) => msgs.flatMap((m) => m.content))
    .filter((b) => b.type === "tool_result");
  const maxLen = Math.max(0, ...blocks.map((b) => String(b.content).length));
  expect(maxLen).toBeGreaterThan(BIG_FILE_CHARS * 0.5);
  expect(allReceivedText(provider)).not.toContain("文件不存在");
}

/** 1M 窗口：遮罩与压缩都不会插手，唯一可能改写工具结果的就是过期清理 */
const BIG_WINDOW = 1_000_000;
const TOOL_TURNS = ROUNDS;

describe("接线：真实子代理执行路径不清理", () => {
  test("内置类型路径（executeInner）：模型收到的消息里没有清理占位", async () => {
    // 24 轮工具调用 × 8,000 字符 —— 通道开着时第 9 轮之后必然出现占位（实测标定）。
    // 注册成 dynamic agent 让 resolveAgent 找得到 → 走 executeInner（不是自定义路径）。
    registerDynamicAgents([
      {
        agentType: "stale-probe-builtin",
        description: "过期清理接线探针",
        whenToUse: "仅在测试中使用",
        systemPrompt: "你是测试 Agent。",
        tools: ["read"],
        readOnly: true,
        source: "userSettings",
      } as never,
    ]);
    const provider = new RecordingProvider(TOOL_TURNS, "read");
    const tool = new BigOutputTool("read");
    const tools = new Registry();
    tools.register(tool);

    const result = await new SubAgent(provider, "mock-model", tools).execute({
      type: "stale-probe-builtin",
      description: "连续读取并汇总",
      prompt: "依次读取文件并汇总",
      maxTokens: BIG_WINDOW,
    });

    expect(result.success).toBe(true);
    // 前置条件：真的跑够了轮次、真的读到了大文件（不然「没清理」可能只是没到期/没读到）
    expect(provider.calls).toBeGreaterThan(TOOL_TURNS);
    assertRealBigResults(provider);
    expect(allReceivedText(provider)).not.toContain("已过期清理");
  }, 30_000);

  test("自定义类型路径（executeCustomInner）：同样不清理", async () => {
    const provider = new RecordingProvider(TOOL_TURNS, "read");
    const tool = new BigOutputTool("read");
    const tools = new Registry();
    tools.register(tool);

    // 不注册 agent 定义 → executeCustom 内部 resolveAgent 返回 undefined，
    // 走 executeCustomInner（自定义路径的 ContextManager 构造点）。
    // cwd 不传：ALS 不跨进程，传了会强制进程内，这里本来就要进程内。
    const result = await new SubAgent(provider, "mock-model", tools).executeCustom({
      systemPrompt: "你是测试 Agent。",
      userPrompt: "依次读取文件并汇总",
      allowedTools: ["read"],
      maxTokens: BIG_WINDOW,
      type: "stale-probe-custom",
    });

    expect(result.success).toBe(true);
    expect(provider.calls).toBeGreaterThan(TOOL_TURNS);
    assertRealBigResults(provider);
    expect(allReceivedText(provider)).not.toContain("已过期清理");
  }, 30_000);
});

// ───────────────────── 接线：源码扫描（spawn 路径 + 主循环不变） ─────────────────────

const REPO_ROOT = join(import.meta.dir, "../../../..");
const SUB_AGENT_SRC = join(REPO_ROOT, "packages/core/src/agent/sub-agent.ts");
const HEADLESS_SRC = join(REPO_ROOT, "packages/cli/src/entrypoints/headless.ts");
const MAIN_LOOP_SRC = join(REPO_ROOT, "packages/cli/src/app.ts");

/**
 * 抽出每个 `new ContextManager({ ... })` 的构造块。
 *
 * 按行扫而不是一条正则：这些构造块的参数里可能嵌对象/调用，非贪婪正则会在第一个 `})`
 * 提前截断，漏掉写在后面的选项——那正是本测试要抓的东西（漏传）。
 */
function contextManagerBlocks(source: string): string[] {
  const lines = source.split("\n");
  const blocks: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes("new ContextManager({")) continue;
    const collected: string[] = [];
    let depth = 0;
    for (let j = i; j < lines.length; j++) {
      const line = lines[j]!;
      collected.push(line);
      depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
      if (depth === 0 && j > i) break;
    }
    blocks.push(collected.join("\n"));
  }
  return blocks;
}

describe("接线：三处子代理构造点都传了 false，主循环不传", () => {
  test("sub-agent.ts：两处子代理构造点都关掉通道", () => {
    const blocks = contextManagerBlocks(readFileSync(SUB_AGENT_SRC, "utf-8"));
    // 守卫：新增/删除构造点必须让这条断言被看见，不允许静默漂移
    expect(blocks).toHaveLength(2);
    for (const block of blocks) {
      expect(block).toContain("staleToolOutputClear: false");
    }
  });

  test("headless.ts：spawn 子进程构造点也关掉通道（进程内测试覆盖不到，只能静态守）", () => {
    const blocks = contextManagerBlocks(readFileSync(HEADLESS_SRC, "utf-8"));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain("staleToolOutputClear: false");
  });

  test("app.ts：主循环**不**关通道——11-12 的清理决定对主会话仍然有效", () => {
    const blocks = contextManagerBlocks(readFileSync(MAIN_LOOP_SRC, "utf-8"));
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      expect(block).not.toContain("staleToolOutputClear: false");
    }
  });

  test("三处子代理构造点总数 = 3（新增第四处必须被本文件看见）", () => {
    const total =
      contextManagerBlocks(readFileSync(SUB_AGENT_SRC, "utf-8")).length +
      contextManagerBlocks(readFileSync(HEADLESS_SRC, "utf-8")).length;
    expect(total).toBe(3);
  });
});
