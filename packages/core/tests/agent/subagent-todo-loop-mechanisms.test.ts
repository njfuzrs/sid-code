/**
 * P1-3：子代理循环里的 todo 回注与 end_turn 完成度门禁
 *
 * 缺陷记录：docs-research/.../20260926-任务规划-顺着sc-05-plan核出的缺陷.md §四
 *
 * 缺陷形态是三层同时缺失，本文件只测**第二层（循环层）**，也是唯一真正改变运行时
 * 行为的一层（第一层工具过滤由 subagent-todo-write-isolation.test.ts 守，
 * 第三层提示词无从断言）：
 *
 *   子代理走 `runAgentLoop`，不走主循环 `query/loop.ts`。对 agentic-loop.ts 搜
 *   `todo` 曾是**零命中**——主循环有两道机制，子循环一道都没有：
 *     ① 周期性回注清单（主循环 loop.ts 的 P0-2 / buildTodoReminder）
 *     ② end_turn 完成度门禁（主循环 loop.ts 的 P0-3，3 次软续命）
 *   而 `sub-agent.ts` 还特意给每个子代理配了独立 TodoWriteTool 做内存隔离。
 *   隔离做了，消费它的两条机制没接：子代理建完清单之后没有任何东西把清单贴回它的
 *   上下文，也没有任何东西在它提前 end_turn 时拦住它。
 *
 * 为什么这层必须有测试：只补工具不补门禁，等于把主循环 2026-08 修过的
 * 「做了一半就收尾」原样放进子循环——那次修复有真实转录背书。
 *
 * 本文件驱动真实 `runAgentLoop`（不绕入口），用一个真的 TodoWriteTool 实例
 * 模拟 buildIsolatedToolRegistry 的效果。
 *
 * fix_type: regression_guard
 */

import { describe, test, expect } from "bun:test";
import { runAgentLoop } from "@sid-code/core/agent/agentic-loop.ts";
import { Manager as ContextManager } from "@sid-code/core/context/manager.ts";
import { Registry as ToolRegistry } from "@sid-code/core/tool/registry.ts";
import { LoopDetector } from "@sid-code/core/agent/loop-detection.ts";
import { TodoWriteTool } from "@sid-code/core/tool/todo-write.ts";
import { MAX_TODO_GATE_RETRIES, TODO_REMINDER_CONFIG } from "@sid-code/core/query/todo-reminder.ts";
import type { Provider } from "@sid-code/core/llm/provider.ts";
import type { ContentBlock, SendParams, StreamEvent } from "@sid-code/core/llm/types.ts";

// ─── 流夹具 ───────────────────────────────────────────────────────────────

async function* textEndStream(text: string): AsyncIterable<StreamEvent> {
  yield { type: "message_start", message: { usage: { inputTokens: 10, outputTokens: 0 } } } as any;
  yield { type: "content_block_start", index: 0, content_block: { type: "text" } } as any;
  yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } as any;
  yield { type: "content_block_stop", index: 0 } as any;
  yield {
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
    usage: { outputTokens: 5 },
  } as any;
}

/** 一条 tool_use。入参必须走 input_json_delta，塞在 content_block_start.input 里会落成 input={}。 */
async function* toolUseStream(opts: {
  id: string;
  name: string;
  input: Record<string, unknown>;
}): AsyncIterable<StreamEvent> {
  yield { type: "message_start", message: { usage: { inputTokens: 10, outputTokens: 0 } } } as any;
  yield {
    type: "content_block_start",
    index: 0,
    content_block: { type: "tool_use", id: opts.id, name: opts.name },
  } as any;
  yield {
    type: "content_block_delta",
    index: 0,
    delta: { type: "input_json_delta", partial_json: JSON.stringify(opts.input) },
  } as any;
  yield { type: "content_block_stop", index: 0 } as any;
  yield {
    type: "message_delta",
    delta: { stop_reason: "tool_use" },
    usage: { outputTokens: 5 },
  } as any;
}

/** 脚本化 provider：第 i 次调用返回 scripted[i]，越界后一直用最后一条。 */
function makeProvider(scripted: Array<() => AsyncIterable<StreamEvent>>) {
  const calls: SendParams[] = [];
  const provider = {
    name: () => "mock",
    defaultModel: () => "mock-model",
    sendMessageStream: (params: SendParams) => {
      const idx = calls.length;
      calls.push(params);
      return scripted[Math.min(idx, scripted.length - 1)]();
    },
  } as unknown as Provider;
  return { provider, calls };
}

function makeCtxMgr(): ContextManager {
  const ctxMgr = new ContextManager({ maxTokens: 100_000 });
  ctxMgr.setSystemPrompt("test");
  ctxMgr.addMessage({ role: "user", content: [{ type: "text", text: "做一件多步的活" }] });
  return ctxMgr;
}

function baseConfig(
  provider: Provider,
  tools: ToolRegistry,
  overrides: Record<string, unknown> = {},
) {
  return {
    provider,
    model: "mock-model",
    ctxMgr: makeCtxMgr(),
    tools,
    maxTurns: 40,
    signal: new AbortController().signal,
    loopDetector: new LoopDetector(),
    permissionChecker: undefined,
    ...overrides,
  } as any;
}

function flattenText(messages: Array<{ role: string; content: ContentBlock[] }>): string {
  return messages
    .flatMap((m) => m.content ?? [])
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b?.type === "text")
    .map((b) => b.text)
    .join("\n");
}

/** 计数某段文字在历史里出现了几次（回注/拦截各注入一条，按次数断言更精确）。 */
function countOccurrences(haystack: string, needle: string): number {
  let n = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return n;
    n++;
    from = at + needle.length;
  }
}

/** 带一份未完成清单的隔离 TodoWriteTool（模拟子代理已建清单的状态）。 */
async function makeRegistryWithTodos(
  todos: Array<{ content: string; active_form: string; status: string }>,
): Promise<{ registry: ToolRegistry; todo: TodoWriteTool }> {
  const todo = new TodoWriteTool();
  await todo.execute({ todos } as any);
  const registry = new ToolRegistry();
  registry.register(todo as any);
  return { registry, todo };
}

const TWO_UNFINISHED = [
  { content: "改 A 文件", active_form: "正在改 A", status: "in_progress" },
  { content: "改 B 文件", active_form: "正在改 B", status: "pending" },
];

// ─── ① end_turn 完成度门禁 ────────────────────────────────────────────────

describe("P1-3 — 子代理 end_turn 完成度门禁", () => {
  test("清单仍有未完成项时，第一次 end_turn 被拦下并软续命（不直接 success）", async () => {
    const { registry } = await makeRegistryWithTodos(TWO_UNFINISHED);
    // 第 1 次就想收尾；被拦下后第 2 次仍想收尾……直到续命耗尽才放行
    const { provider, calls } = makeProvider([
      () => textEndStream("## 结果\n干完了（其实没干完）"),
    ]);

    const result = await runAgentLoop(baseConfig(provider, registry));

    // 被拦下 MAX_TODO_GATE_RETRIES 次 → 一共发起 1 + MAX 次请求
    expect(calls.length).toBe(1 + MAX_TODO_GATE_RETRIES);
    // 续命耗尽后放行（不把父代理卡死）
    expect(result.success).toBe(true);

    const history = flattenText(result.messages as any);
    expect(history).toContain("检测到你试图结束本轮对话");
    // 拦截消息注入的次数应等于软续命次数
    expect(countOccurrences(history, "检测到你试图结束本轮对话")).toBe(MAX_TODO_GATE_RETRIES);
    // 未完成项要被逐条列出，模型才知道差哪几件
    expect(history).toContain("改 A 文件");
    expect(history).toContain("改 B 文件");
  });

  test("清单全部完成时 end_turn 不被拦（门禁不误伤正常收尾）", async () => {
    const { registry } = await makeRegistryWithTodos([
      { content: "改 A 文件", active_form: "正在改 A", status: "completed" },
      { content: "改 B 文件", active_form: "正在改 B", status: "completed" },
    ]);
    const { provider, calls } = makeProvider([() => textEndStream("## 结果\n两项都做完了")]);

    const result = await runAgentLoop(baseConfig(provider, registry));

    expect(result.success).toBe(true);
    expect(calls.length).toBe(1);
    expect(flattenText(result.messages as any)).not.toContain("检测到你试图结束本轮对话");
  });

  test("池里没有 todo_write（只读子代理）时门禁整体静默", async () => {
    // 只读类型按 P1-3 口径拿不到 todo_write，此时不该有任何 todo 相关注入
    const registry = new ToolRegistry();
    const { provider, calls } = makeProvider([() => textEndStream("## 发现\n报告正文")]);

    const result = await runAgentLoop(baseConfig(provider, registry));

    expect(result.success).toBe(true);
    expect(calls.length).toBe(1);
    const history = flattenText(result.messages as any);
    expect(history).not.toContain("检测到你试图结束本轮对话");
    expect(history).not.toContain("这是你当前的任务清单");
  });

  test("子代理补完清单后即可正常收尾（拦截是可解的，不是死循环）", async () => {
    const { registry, todo } = await makeRegistryWithTodos(TWO_UNFINISHED);
    let turn = 0;
    const { provider } = makeProvider([
      () => {
        turn++;
        if (turn === 1) {
          // 第一轮就想收尾 → 会被拦
          return textEndStream("## 结果\n干完了");
        }
        // 被拦之后：真的把清单标完（模拟模型响应拦截消息），再收尾
        return (async function* () {
          await todo.execute({
            todos: [
              { content: "改 A 文件", active_form: "正在改 A", status: "completed" },
              { content: "改 B 文件", active_form: "正在改 B", status: "completed" },
            ],
          } as any);
          yield* textEndStream("## 结果\n已全部完成");
        })();
      },
    ]);

    const result = await runAgentLoop(baseConfig(provider, registry));

    expect(result.success).toBe(true);
    // 只被拦了一次：第 2 轮清单已全完成，门禁放行
    expect(turn).toBe(2);
  });
});

// ─── ② 周期性回注清单 ────────────────────────────────────────────────────

describe("P1-3 — 子代理 todo 清单周期性回注", () => {
  test("跑够间隔轮次后把完整清单回注上下文（清单不再写完即沉没）", async () => {
    const { registry, todo } = await makeRegistryWithTodos(TWO_UNFINISHED);
    // 让子代理反复调 todo_write（不改状态），撑过 TURNS_BETWEEN_REMINDERS 轮，
    // 最后一轮标完收尾。用工具轮而不是空文本轮，避免撞上「未答复」类防御。
    const totalToolTurns = TODO_REMINDER_CONFIG.TURNS_BETWEEN_REMINDERS + 1;
    let turn = 0;
    const { provider } = makeProvider([
      () => {
        turn++;
        if (turn <= totalToolTurns) {
          return toolUseStream({
            id: `t-${turn}`,
            name: "todo_write",
            // 每轮写回同一份未完成清单（模拟模型在推进但还没做完）
            input: { todos: TWO_UNFINISHED },
          });
        }
        return (async function* () {
          await todo.execute({
            todos: [
              { content: "改 A 文件", active_form: "正在改 A", status: "completed" },
              { content: "改 B 文件", active_form: "正在改 B", status: "completed" },
            ],
          } as any);
          yield* textEndStream("## 结果\n完成");
        })();
      },
    ]);

    const result = await runAgentLoop(baseConfig(provider, registry));

    expect(result.success).toBe(true);
    const history = flattenText(result.messages as any);
    // 回注文案来自主循环共用的 buildTodoReminder
    expect(history).toContain("这是你当前的任务清单");
    expect(history).toContain("改 A 文件");
  });

  test("回注受节流约束：前几轮不注入（不每轮刷屏烧 token）", async () => {
    const { registry } = await makeRegistryWithTodos(TWO_UNFINISHED);
    // 只跑 2 轮工具就收尾，远小于 TURNS_BETWEEN_REMINDERS(8) → 不该回注
    let turn = 0;
    const { provider } = makeProvider([
      () => {
        turn++;
        if (turn <= 2) {
          return toolUseStream({
            id: `t-${turn}`,
            name: "todo_write",
            input: { todos: TWO_UNFINISHED },
          });
        }
        return textEndStream("## 结果\n先交付");
      },
    ]);

    const result = await runAgentLoop(baseConfig(provider, registry));

    const history = flattenText(result.messages as any);
    // 节流期内不回注；但 end_turn 门禁照样拦（两道机制互不替代）
    expect(history).not.toContain("这是你当前的任务清单");
    expect(history).toContain("检测到你试图结束本轮对话");
  });
});
