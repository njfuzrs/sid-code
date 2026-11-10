/**
 * 子代理注入产物不得写回 ctxMgr（P1，2026-11-10）
 *
 * 锁的是 `query/reminder-inject.ts` 的**不变量 3**：「注入产物只进发送副本，永不写回
 * ctxMgr」。子代理侧此前有两处绕开它——LSP 诊断与 todo 回注都走
 * `ctxMgr.addMessage({role:"user"})`，而主循环的同内容走 reminderParts。
 *
 * 为什么这条值得一个专门的哨兵：既有的 `query/reminder-inject-invariant.test.ts`
 * 只驱动 `queryLoop`，完全覆盖不到 `agenticLoop`；而 `lsp/lsp-injection-and-gating.test.ts`
 * 的 D4 只做**源码字面量扫描**，锁的是「围栏写对了吗」，不关心「块落在哪个通道」。
 * 于是通道错了也全绿——这正是它长期没被发现的原因。
 *
 * 破坏后的表现不是报错，是**历史只增不减**：诊断 / todo 回注永久留在子代理历史里，
 * 之后每轮随 getCleanedMessages() 重发给模型，直到被压缩裁掉。
 *
 * fix_type: regression_guard
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { runAgentLoop } from "@sid-code/core/agent/agentic-loop.ts";
import { Manager as ContextManager } from "@sid-code/core/context/manager.ts";
import { Registry as ToolRegistry } from "@sid-code/core/tool/registry.ts";
import { LoopDetector } from "@sid-code/core/agent/loop-detection.ts";
import type { Provider } from "@sid-code/core/llm/provider.ts";
import type { SendParams, StreamEvent } from "@sid-code/core/llm/types.ts";
import type { LegacyTool, LegacyToolResult } from "@sid-code/core/tool/types.ts";
import type { TodoItem } from "@sid-code/core/tool/todo-write.ts";

/** buildTodoReminder 的首行文案，用于在发送副本里认出回注块 */
const TODO_REMINDER_MARK = "这是你当前的任务清单";

/** 造一条 tool_use 流：子代理每轮都调 read，跑到 maxTurns 自然退出 */
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

/**
 * 带未完成项的 todo_write。
 *
 * 只需鸭子类型对上 `getTodos()`——`readSubAgentTodos` 就是这么探测的（见 agentic-loop.ts
 * 该函数注释：为了不把一个具体工具类型拖进循环层）。
 */
class TodoTool implements LegacyTool {
  name() {
    return "todo_write";
  }
  description() {
    return "todo_write";
  }
  inputSchema() {
    return { type: "object", properties: {} };
  }
  async execute(): Promise<LegacyToolResult> {
    return { output: "ok" };
  }
  getTodos(): TodoItem[] {
    return [{ content: "写哨兵测试", activeForm: "正在写哨兵测试", status: "in_progress" }];
  }
}

/** 驱动真实 runAgentLoop，并把**每一次**实际发出的 messages 记下来 */
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
  tools.register(new TodoTool() as any);

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
    agentId: "agent-transient-1",
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

describe("子代理 todo 回注走 transient 通道，不写回 ctxMgr", () => {
  /**
   * maxTurns=8 是 TURNS_BETWEEN_REMINDERS 的边界：`lastTodoReminderTurn` 初值 0、
   * turns 从 1 起，第 8 轮 `turns - 0 >= 8` 才触发首次回注。
   */
  test("回注出现在发送副本里（前提：这条路径真的跑到了）", async () => {
    const { promise, sent } = run(8);
    await promise;
    const injected = sent.filter((p) => textOf(p.messages).includes(TODO_REMINDER_MARK));
    expect(injected.length).toBeGreaterThan(0);
  });

  test("回注不出现在 ctxMgr 历史里（守不变量 3）", async () => {
    const { promise, ctxMgr } = run(8);
    await promise;
    expect(textOf(ctxMgr.getMessages())).not.toContain(TODO_REMINDER_MARK);
  });

  test("回注块带 transient: true（下一轮自动消失）", async () => {
    const { promise, sent } = run(8);
    await promise;
    const pooled = sent.flatMap((p) =>
      p.messages.flatMap((m) => (m.content ?? []) as unknown as Array<Record<string, unknown>>),
    );
    const hits = pooled.filter(
      (b) => b.type === "text" && typeof b.text === "string" && b.text.includes(TODO_REMINDER_MARK),
    );
    expect(hits.length).toBeGreaterThan(0);
    for (const b of hits) expect(b.transient).toBe(true);
  });
});

/**
 * 源码哨兵：注入段不得再出现 `ctxMgr.addMessage`。
 *
 * 为什么还要这一层——LSP 诊断的产生依赖真实 language server 推 `publishDiagnostics`，
 * 在单测里造不出稳定输入；而 todo 回注的行为测试只覆盖了同一条通道的一个成员。
 * 这一条直接锁住「这两段都不许直接写历史」这个形态本身，改名 / 重构后仍有效。
 */
describe("源码哨兵：子代理注入段不得写回 ctxMgr", () => {
  const SRC = readFileSync(join(import.meta.dir, "../../src/agent/agentic-loop.ts"), "utf-8");

  /** 剥掉注释行：注释里会提到 `ctxMgr.addMessage({role:"user"})`（讲清为什么不再这么写） */
  const CODE_ONLY = SRC.split("\n")
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");

  function section(startMark: string, endMark: string): string {
    const start = CODE_ONLY.indexOf(startMark);
    expect(start).toBeGreaterThan(0); // 前提：注入点还在（改名 / 删除时这里先红）
    const end = CODE_ONLY.indexOf(endMark, start);
    expect(end).toBeGreaterThan(start);
    return CODE_ONLY.slice(start, end);
  }

  test("LSP 诊断段：收集成 reminderParts，不再 addMessage", () => {
    const code = section("collectDiagnosticText(diagnosticOwner)", "注入 LSP 诊断反馈（子代理）");
    expect(code).not.toContain("ctxMgr.addMessage");
    expect(code).toContain("reminderParts.push");
  });

  test("todo 回注段：收集成 reminderParts，不再 addMessage", () => {
    // 锚点取代码行而不是注释行：CODE_ONLY 已剥掉注释，用注解开头会把起点判成 -1
    const code = section("const todosForReminder = readSubAgentTodos(tools)", "const toolDefs =");
    expect(code).not.toContain("ctxMgr.addMessage");
    expect(code).toContain("reminderParts.push");
  });

  test("reminderParts 只经一次 injectReminders 注入（不许拆成两次调用）", () => {
    // 全仓约定：injectReminders 一次调用内按 critical→用户块→ambient 排序，
    // 调两次会让第二组整体压在第一组之前（query/loop.ts 有同名注释）。
    const calls = CODE_ONLY.split("injectReminders(").length - 1;
    expect(calls).toBe(1);
    expect(CODE_ONLY).toContain("injectReminders(messagesForSend, { ambient: reminderParts })");
  });
});
