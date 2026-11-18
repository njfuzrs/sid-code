/**
 * M1：进度里的 token 必须是「当前上下文」，不是「累计消耗」
 *
 * 缺陷（M1）：子代理进度只报一个 `tokens`，取的是 `totalUsage.inputTokens + outputTokens`
 * 的**累计值**——它随轮次单调增长，242 轮的会话能到 1300 万；而同一时刻真实上下文
 * 峰值只有 94k。父代理把这个数当成"上下文快满了"，于是提前几十倍动手杀子代理。
 *
 * 修复：拆成两个具名口径——
 *   - `contextTokens`：最后一次请求的 `promptTotal`（含 cache 命中/写入的全量输入），
 *     与上下文估算器的校准点同源（`agentic-loop.ts` 的 `recordActualTokens(norm.promptTotal, …)`）；
 *   - `tokenCount`：累计 input + output（语义不变，只是不再冒充上下文）。
 * 渲染层相应改成 `<progress context_tokens="…" cumulative_io_tokens="…">`，
 * 不再留含义模糊的 `tokens`。
 *
 * 本文件锁两件事：
 *   1. 驱动真实 `runAgentLoop`：`onTurnEnd.contextTokens` 是**最后一轮**的 promptTotal，
 *      不是累计值；`tokenCount` 仍是累计值。两者数值必须不同（否则等于没拆）。
 *   2. 渲染：`<progress>` 输出两个具名属性，且不再出现裸 `tokens="`。
 *
 * fix_type: regression_guard
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { runAgentLoop, type TurnEndInfo } from "@sid-code/core/agent/agentic-loop.ts";
import { Manager as ContextManager } from "@sid-code/core/context/manager.ts";
import { Registry as ToolRegistry } from "@sid-code/core/tool/registry.ts";
import { LoopDetector } from "@sid-code/core/agent/loop-detection.ts";
import type { Provider } from "@sid-code/core/llm/provider.ts";
import type { StreamEvent } from "@sid-code/core/llm/types.ts";
import type { LegacyTool, LegacyToolResult } from "@sid-code/core/tool/types.ts";
import {
  registerTask,
  clearAllTasks,
  createAgentTask,
  generateTaskStatusAttachment,
} from "@sid-code/core/task/index.ts";
import type { LocalAgentTaskState } from "@sid-code/core/task/types.ts";

/** 每轮带不同的 inputTokens，才能区分「最后一轮」与「累计」 */
async function* textStream(inputTokens: number, text: string): AsyncIterable<StreamEvent> {
  yield { type: "message_start", message: { usage: { inputTokens, outputTokens: 0 } } } as any;
  yield { type: "content_block_start", index: 0, content_block: { type: "text" } } as any;
  yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } as any;
  yield { type: "content_block_stop", index: 0 } as any;
  yield {
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
    usage: { outputTokens: 5 },
  } as any;
}

async function* toolStream(inputTokens: number, id: string): AsyncIterable<StreamEvent> {
  yield { type: "message_start", message: { usage: { inputTokens, outputTokens: 0 } } } as any;
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

class ReadTool implements LegacyTool {
  name() {
    return "read";
  }
  description() {
    return "read";
  }
  inputSchema() {
    return {
      type: "object",
      properties: { file_path: { type: "string" } },
      required: ["file_path"],
    };
  }
  readOnly() {
    return true;
  }
  async execute(_input: Record<string, unknown>): Promise<LegacyToolResult> {
    return { output: "ok" };
  }
}

/** 跑一次真实 runAgentLoop，收集每轮 onTurnEnd 的快照 */
async function runTwoTurns(
  scripted: Array<() => AsyncIterable<StreamEvent>>,
): Promise<TurnEndInfo[]> {
  let idx = 0;
  const provider = {
    name: () => "mock",
    defaultModel: () => "mock-model",
    sendMessageStream: () => scripted[Math.min(idx++, scripted.length - 1)](),
  } as unknown as Provider;

  const tools = new ToolRegistry();
  tools.register(new ReadTool() as any);
  const ctxMgr = new ContextManager({ maxTokens: 100_000 });
  ctxMgr.setSystemPrompt("test");
  ctxMgr.addMessage({ role: "user", content: [{ type: "text", text: "任务" }] });

  const turnEnds: TurnEndInfo[] = [];
  await runAgentLoop({
    provider,
    model: "mock-model",
    ctxMgr,
    tools,
    maxTurns: 10,
    signal: new AbortController().signal,
    loopDetector: new LoopDetector(),
    permissionChecker: undefined,
    maxStreamRetries: 0,
    agentId: "agent-m1-test",
    onTurnEnd: (info: TurnEndInfo) => turnEnds.push(info),
  } as any);

  return turnEnds;
}

describe("M1 onTurnEnd 的 contextTokens 是当前上下文，不是累计消耗", () => {
  test("两轮不同 input 的请求：contextTokens 取最后一轮 promptTotal，tokenCount 仍是累计值", async () => {
    // 第一轮 input=100（工具轮），第二轮 input=500（收尾文本轮）。
    // mock provider 走 normalizeCacheUsage 的非 anthropic 分支 → promptTotal = inputTokens。
    const turnEnds = await runTwoTurns([
      () => toolStream(100, "t1"),
      () => textStream(500, "完成"),
    ]);

    expect(turnEnds.length).toBeGreaterThanOrEqual(2);

    const first = turnEnds[0]!;
    // 第一轮：累计 = 100 + 5，上下文 = 100
    expect(first.contextTokens).toBe(100);
    expect(first.tokenCount).toBe(105);

    const last = turnEnds[turnEnds.length - 1]!;
    // 最后一轮：上下文 = 500（本轮的 promptTotal，不是 100+500）
    expect(last.contextTokens).toBe(500);
    // 累计 = (100+5) + (500+5) = 610
    expect(last.tokenCount).toBe(610);

    // 关键不变量：两个口径必须不同，否则等于又把它们并回一个字段了
    expect(last.contextTokens).not.toBe(last.tokenCount);
  });
});

describe("M1 <progress> 渲染两个具名属性", () => {
  beforeEach(() => clearAllTasks());
  afterEach(() => clearAllTasks());

  function agentTask(progress: LocalAgentTaskState["progress"]): LocalAgentTaskState {
    return {
      id: "m1-task",
      type: "local_agent",
      status: "running",
      description: "M1 测试任务",
      startTime: Date.now(),
      outputFile: "/tmp/m1-not-exist.out",
      outputOffset: 0,
      notified: false,
      agentId: "m1-task",
      agentType: "explore",
      prompt: "p",
      isBackgrounded: true,
      progress,
    };
  }

  test("<task-statuses> 用 context_tokens / cumulative_io_tokens，不再有裸 tokens=", async () => {
    registerTask(
      agentTask({
        toolUseCount: 7,
        tokenCount: 13_009_075,
        contextTokens: 94_000,
        recentActivities: [],
      }),
    );

    const attachment = await generateTaskStatusAttachment();
    expect(attachment).not.toBeNull();
    // 两个口径各自出现，数值不串味（M1 的原始症状正是这里只有一个累计值）
    expect(attachment!).toContain('context_tokens="94000"');
    expect(attachment!).toContain('cumulative_io_tokens="13009075"');
    // 含义模糊的单值属性必须消失
    expect(attachment!).not.toMatch(/ tokens="/);
  });

  test("三处渲染都改了：registry / task-output / task-list 无裸 tokens=", () => {
    // 行为断言只覆盖 registry 这一处出口，而父代理还能从 bg_task_output / bg_task_list
    // 两个工具读到同一份进度。漏改任何一处，那条路径就仍然只有累计值——
    // 而单测不会红（各自渲染函数相互独立）。故用源码哨兵锁住三处一起改。
    const files = [
      "packages/core/src/task/registry.ts",
      "packages/core/src/tool/task-output.ts",
      "packages/core/src/tool/task-list.ts",
    ];
    for (const rel of files) {
      const src = readFileSync(join(import.meta.dir, "../../../..", rel), "utf8");
      expect(src).toContain("context_tokens=");
      expect(src).toContain("cumulative_io_tokens=");
      expect(src).not.toMatch(/<progress[^>]* tools="\$\{[^}]+\}" tokens="/);
    }
  });

  test("新建任务的初始进度两个字段都是 0（首轮请求前确实没有上下文）", async () => {
    const { taskState } = createAgentTask({
      description: "初始进度",
      prompt: "p",
      agentType: "explore",
      isBackgrounded: true,
      toolUseId: "tu-1",
    } as any);
    expect(taskState.progress?.contextTokens).toBe(0);
    expect(taskState.progress?.tokenCount).toBe(0);
  });
});
