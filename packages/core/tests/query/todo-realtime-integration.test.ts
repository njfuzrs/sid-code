/**
 * todo 实时化 —— queryLoop 集成验证
 *
 * 方案：docs/bugfixes/todo/20260801-todolist非实时更新-对标CC架构根治方案.md
 *
 * 单测（todo-reminder-scan.test.ts / todo-write.test.ts）验的是各函数算得对；
 * 本文件验的是**接线真的通了**——纯函数正确但没接进主循环，是这个缺陷的原始形态之一
 * （`TURNS_SINCE_WRITE` 定义了却从未被引用，整场会话只注入 1 次）。
 *
 * 三条性质：
 *   1. 长任务停滞时 todo 清单被**反复**回注（不再是一次性）；
 *   2. 回注产物**不落历史**（`reminder-inject.ts` 不变量 3，与修复 1 同时成立）；
 *   3. 全部完成的**终态**能落进度快照（修复 5 + 发现 4a 连锁）。
 */

import { describe, test, expect } from "bun:test";
import { queryLoop } from "@sid-code/core/query/loop.ts";
import type { QueryLoopConfig } from "@sid-code/core/query/loop.ts";
import type { QueryDeps } from "@sid-code/core/query/types.ts";
import { Manager as ContextManager } from "@sid-code/core/context/manager.ts";
import { Registry as ToolRegistry } from "@sid-code/core/tool/registry.ts";
import { ModelFallback } from "@sid-code/core/llm/fallback.ts";
import { SessionState } from "@sid-code/core/session/state.ts";
import type { Config } from "@sid-code/core/config/config.ts";
import type { StreamEvent, AccumulatedResponse } from "@sid-code/core/llm/types.ts";
import type { TodoItem } from "@sid-code/core/tool/todo-write.ts";

async function* emptyStream(): AsyncIterable<StreamEvent> {}

function toolUseResp(id: string, name = "read"): AccumulatedResponse {
  return {
    role: "assistant",
    content: [{ type: "tool_use", id, name, input: { file_path: "/tmp/x" } }],
    stopReason: "tool_use",
    usage: { inputTokens: 100, outputTokens: 5 },
  } as AccumulatedResponse;
}

function finalResp(text = "已完成"): AccumulatedResponse {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "end_turn",
    usage: { inputTokens: 100, outputTokens: 5 },
  } as AccumulatedResponse;
}

function todo(content: string, status: TodoItem["status"]): TodoItem {
  return { content, activeForm: `正在${content}`, status };
}

/**
 * 造一个"模型长期不碰清单"的会话：前 N 轮都是工具调用，最后一轮 end_turn。
 * todoState 恒定不变（writeVersion 不动）= 完全停滞，正是缺陷现场的形态。
 */
function makeHarness(opts: {
  turns: number;
  todos: TodoItem[];
  /** 终态 dep：不传则不提供（验证向后兼容回退） */
  terminalTodos?: TodoItem[];
  writeVersion?: number;
}) {
  const ctxMgr = new ContextManager({ maxTokens: 200000 });
  ctxMgr.setSystemPrompt("test system prompt");
  ctxMgr.addMessage({ role: "user", content: [{ type: "text", text: "干个长活" }] });

  /** 每轮发送副本里最后一条 user 消息的全部 text block 拼接 */
  const sentWire: string[] = [];
  const progressWrites: Array<{ completed: number; total: number }> = [];
  const traceEvents: Array<{ event: string; data: any }> = [];

  const responses: AccumulatedResponse[] = [
    ...Array.from({ length: opts.turns }, (_, i) => toolUseResp(`t${i}`)),
    finalResp(),
  ];
  let call = 0;

  const deps: QueryDeps = {
    sendWithRetry: (params: any) => {
      const msgs = params?.messages ?? [];
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (m.role !== "user" || !Array.isArray(m.content)) continue;
        sentWire.push(
          m.content
            .filter((b: any) => b.type === "text")
            .map((b: any) => b.text)
            .join("\n"),
        );
        break;
      }
      return emptyStream();
    },
    processStream: async () => responses[call++] ?? finalResp(),
    executeTools: async (content: any[]) => ({
      results: content
        .filter((b: any) => b.type === "tool_use")
        .map((b: any) => ({ type: "tool_result" as const, tool_use_id: b.id, content: "ok" })),
    }),
    autoCompact: async () => {},
    handleContextOverflow: () => null,
    getAbortSignal: () => undefined,
    uuid: () => "uuid-test",
    getTodoState: () => ({
      todos: opts.todos,
      writeVersion: opts.writeVersion ?? 1,
    }),
    ...(opts.terminalTodos
      ? {
          getTodoTerminalState: () => ({
            todos: opts.terminalTodos!,
            writeVersion: opts.writeVersion ?? 1,
          }),
        }
      : {}),
    traceAppendEvent: (e: any) => {
      traceEvents.push({ event: e.event, data: e.data });
    },
  };

  const loopConfig: QueryLoopConfig = {
    config: {
      model: "deepseek-v4-pro",
      provider: "openai",
      maxTurns: opts.turns + 5,
      toolSearch: false,
    } as unknown as Config,
    ctxMgr,
    toolRegistry: new ToolRegistry(),
    sessionState: new SessionState("test-session-todo"),
    fallback: new ModelFallback(),
    deps,
  };
  return { loopConfig, ctxMgr, sentWire, progressWrites, traceEvents };
}

/**
 * buildTodoReminder 的标志性措辞（与 src/query/todo-reminder.ts:111 保持同步）。
 * 单独提成常量：文案若改动，这里一处改完全文件生效，不会留下"半数断言静默失效"的假绿灯。
 */
const TODO_REMINDER_MARKER = "这是你当前的任务清单";

/** 发送副本里出现 todo 回注的轮次下标 */
function injectionTurns(sentWire: string[]): number[] {
  const out: number[] = [];
  sentWire.forEach((wire, i) => {
    if (wire.includes(TODO_REMINDER_MARKER)) out.push(i);
  });
  return out;
}

describe("修复 1 接线：长任务停滞时 todo 被反复回注", () => {
  test("40 轮停滞会话里，回注次数 ≥ 3（旧实现全程只 1 次）", async () => {
    const { loopConfig, sentWire } = makeHarness({
      turns: 40,
      todos: [todo("甲", "in_progress"), todo("乙", "pending"), todo("丙", "pending")],
    });
    for await (const _ of queryLoop(loopConfig)) {
      /* drain */
    }

    const turns = injectionTurns(sentWire);
    // 阈值 8 轮一次 → 40 轮理论上约 4-5 次。断言 ≥3 留边界余量，
    // 但足以钉死"退回一次性注入"（旧实现在这个场景下恒为 1）。
    expect(turns.length).toBeGreaterThanOrEqual(3);
    // 且必须延续到会话后段，不是前几轮挤完就哑火
    expect(turns[turns.length - 1]).toBeGreaterThan(20);
  });

  test("回注携带完整清单内容（模型能看到每一项，而非只看到一句催促）", async () => {
    const { loopConfig, sentWire } = makeHarness({
      turns: 20,
      todos: [todo("独特任务甲", "in_progress"), todo("独特任务乙", "pending")],
    });
    for await (const _ of queryLoop(loopConfig)) {
      /* drain */
    }

    const injected = sentWire.filter((w) => w.includes(TODO_REMINDER_MARKER));
    expect(injected.length).toBeGreaterThan(0);
    expect(injected[0]).toContain("独特任务甲");
    expect(injected[0]).toContain("独特任务乙");
  });

  test("每次回注都带 <system-reminder> 围栏（不变量 1，防「幻影用户消息」）", async () => {
    const { loopConfig, sentWire } = makeHarness({
      turns: 20,
      todos: [todo("甲", "in_progress"), todo("乙", "pending")],
    });
    for await (const _ of queryLoop(loopConfig)) {
      /* drain */
    }

    for (const wire of sentWire.filter((w) => w.includes(TODO_REMINDER_MARKER))) {
      const idx = wire.indexOf(TODO_REMINDER_MARKER);
      const before = wire.slice(0, idx);
      // 清单前必须有围栏开标签（弱模型靠它区分"系统提醒"与"用户又发了半句话"）
      expect(before).toContain("<system-reminder>");
    }
  });
});

describe("不变量 3 仍成立：回注产物不落 ctxMgr 历史", () => {
  test("跑完 20 轮，历史里没有任何 todo 回注文本", async () => {
    const { loopConfig, ctxMgr } = makeHarness({
      turns: 20,
      todos: [todo("甲", "in_progress"), todo("乙", "pending")],
    });
    for await (const _ of queryLoop(loopConfig)) {
      /* drain */
    }

    const historyUserText = ctxMgr
      .getMessages()
      .filter((m) => m.role === "user" && Array.isArray(m.content))
      .flatMap((m) => (m.content as any[]).filter((b) => b.type === "text").map((b) => b.text))
      .join("\n");

    // 回注只进发送副本。落历史会同时引发 TUI 泄漏 / 压缩误取 / 逐轮累积三处故障。
    expect(historyUserText).not.toContain(TODO_REMINDER_MARKER);
    // 用户原始指令完好
    expect(historyUserText).toContain("干个长活");
  });
});

describe("状态位置：writeVersion 基线必须跨用户消息持久（2026-08-02 修复）", () => {
  /**
   * 这条测的是**度量本身的准确性**，不是功能。
   *
   * 基线原先挂在 `LoopState` 上，而它由 `createInitialLoopState()` 在每条用户消息重建 →
   * 基线归零成 undefined → `lastSeen !== writeVersion` 在清单**根本没动**时也判 true。
   * 实测（writeVersion 恒定 3、零真实推进）：第一条消息后埋点 1 次，第二条后 2 次。
   *
   * 为什么必须有这条哨兵：`TodoProgressAdvanced` 是方案 §8.3 里唯一能直接量 todo 实时性的
   * 指标。它虚高会让「改动到底有没有效」建在偏差尺子上——比功能 bug 更难发现，因为
   * 它伪装成"数据变好了"。既有那条「同一 writeVersion 不重复埋点」只跑单次 queryLoop，
   * 天然覆盖不到跨消息路径，所以漏了。
   */
  test("同一 writeVersion 跨两条用户消息只埋点一次（progress 不重复落盘）", async () => {
    const ctxMgr = new ContextManager({ maxTokens: 200000 });
    ctxMgr.setSystemPrompt("sys");
    const traceEvents: Array<{ event: string; data: any }> = [];
    const stalled = [todo("甲", "in_progress"), todo("乙", "pending")];
    const deps: QueryDeps = {
      sendWithRetry: () => emptyStream(),
      processStream: async () => finalResp(),
      executeTools: async () => ({ results: [] }),
      autoCompact: async () => {},
      handleContextOverflow: () => null,
      getAbortSignal: () => undefined,
      uuid: () => "u",
      // writeVersion 恒定 = 模型全程没碰过清单 = 真实推进次数 0
      getTodoState: () => ({ todos: stalled, writeVersion: 3 }),
      getTodoTerminalState: () => ({ todos: stalled, writeVersion: 3 }),
      traceAppendEvent: (e: any) => traceEvents.push({ event: e.event, data: e.data }),
    } as unknown as QueryDeps;

    // ★ 关键：同一个 SessionState 跨两次 queryLoop 复用（真实 engine 就是这么做的）
    const sessionState = new SessionState("test-session-todo-locality");
    const mk = (): QueryLoopConfig => ({
      config: {
        model: "deepseek-v4-pro",
        provider: "openai",
        maxTurns: 5,
        toolSearch: false,
      } as unknown as Config,
      ctxMgr,
      toolRegistry: new ToolRegistry(),
      sessionState,
      fallback: new ModelFallback(),
      deps,
    });

    ctxMgr.addMessage({ role: "user", content: [{ type: "text", text: "第一条" }] });
    for await (const _ of queryLoop(mk())) {
      /* drain */
    }
    const afterFirst = traceEvents.filter((e) => e.event === "TodoProgressAdvanced").length;

    ctxMgr.addMessage({ role: "user", content: [{ type: "text", text: "第二条" }] });
    for await (const _ of queryLoop(mk())) {
      /* drain */
    }
    const afterSecond = traceEvents.filter((e) => e.event === "TodoProgressAdvanced").length;

    // 首次观察到 writeVersion=3 时埋一次是对的（基线从无到有）
    expect(afterFirst).toBe(1);
    // 第二条用户消息不该再埋：writeVersion 没变，清单零推进。修复前这里是 2。
    expect(afterSecond).toBe(1);
  });

  test("跨用户消息后 writeVersion 真变化仍能埋点（不是把基线焊死）", async () => {
    const ctxMgr = new ContextManager({ maxTokens: 200000 });
    ctxMgr.setSystemPrompt("sys");
    const traceEvents: Array<{ event: string; data: any }> = [];
    const stalled = [todo("甲", "in_progress"), todo("乙", "pending")];
    let version = 3;
    const deps: QueryDeps = {
      sendWithRetry: () => emptyStream(),
      processStream: async () => finalResp(),
      executeTools: async () => ({ results: [] }),
      autoCompact: async () => {},
      handleContextOverflow: () => null,
      getAbortSignal: () => undefined,
      uuid: () => "u",
      getTodoState: () => ({ todos: stalled, writeVersion: version }),
      getTodoTerminalState: () => ({ todos: stalled, writeVersion: version }),
      traceAppendEvent: (e: any) => traceEvents.push({ event: e.event, data: e.data }),
    } as unknown as QueryDeps;

    const sessionState = new SessionState("test-session-todo-locality-2");
    const mk = (): QueryLoopConfig => ({
      config: {
        model: "deepseek-v4-pro",
        provider: "openai",
        maxTurns: 5,
        toolSearch: false,
      } as unknown as Config,
      ctxMgr,
      toolRegistry: new ToolRegistry(),
      sessionState,
      fallback: new ModelFallback(),
      deps,
    });

    ctxMgr.addMessage({ role: "user", content: [{ type: "text", text: "第一条" }] });
    for await (const _ of queryLoop(mk())) {
      /* drain */
    }
    // 模型在第二条消息期间真的更新了清单
    version = 4;
    ctxMgr.addMessage({ role: "user", content: [{ type: "text", text: "第二条" }] });
    for await (const _ of queryLoop(mk())) {
      /* drain */
    }

    const advanced = traceEvents.filter((e) => e.event === "TodoProgressAdvanced");
    expect(advanced.length).toBe(2);
    expect(advanced.map((e) => e.data.writeVersion)).toEqual([3, 4]);
  });
});

describe("修复 5 + 发现 4a：终态可观测", () => {
  test("全部完成时仍落 TodoProgressAdvanced 埋点（取终态 dep）", async () => {
    // 展示语义：全完成 → TodoWriteTool 清空 → getTodoState 返空清单
    // 事实语义：getTodoTerminalState 仍给出全 completed 的终态
    const { loopConfig, traceEvents } = makeHarness({
      turns: 3,
      todos: [], // 展示层已清空（模拟 allDone 后的 getTodos()）
      terminalTodos: [todo("甲", "completed"), todo("乙", "completed")],
      writeVersion: 7,
    });
    for await (const _ of queryLoop(loopConfig)) {
      /* drain */
    }

    const advanced = traceEvents.filter((e) => e.event === "TodoProgressAdvanced");
    // 旧实现：countUnfinished > 0 前置 + getTodoState 返 null → 终态永远不落盘/不埋点
    expect(advanced.length).toBeGreaterThan(0);
    expect(advanced[0].data.completed).toBe(2);
    expect(advanced[0].data.unfinished).toBe(0);
    expect(advanced[0].data.writeVersion).toBe(7);
  });

  test("同一 writeVersion 不重复埋点（基线统一推进，防每轮重复落盘）", async () => {
    const { loopConfig, traceEvents } = makeHarness({
      turns: 12,
      todos: [],
      terminalTodos: [todo("甲", "completed")],
      writeVersion: 3,
    });
    for await (const _ of queryLoop(loopConfig)) {
      /* drain */
    }

    // writeVersion 全程不变 → 只应埋点一次。若基线没统一推进，这里会等于轮数。
    const advanced = traceEvents.filter((e) => e.event === "TodoProgressAdvanced");
    expect(advanced.length).toBe(1);
  });

  test("未提供终态 dep 时回退到 getTodoState（向后兼容，不崩）", async () => {
    const { loopConfig, traceEvents } = makeHarness({
      turns: 5,
      todos: [todo("甲", "in_progress"), todo("乙", "pending")],
      writeVersion: 2,
    });
    for await (const _ of queryLoop(loopConfig)) {
      /* drain */
    }

    const advanced = traceEvents.filter((e) => e.event === "TodoProgressAdvanced");
    expect(advanced.length).toBe(1);
    expect(advanced[0].data.unfinished).toBe(2);
  });
});

// P1-4 item 2（2026-08-14）：todo 通道又有了 cap，但是**条件式**的——只在"有真实副作用
// 进展却不更新清单"（催记账）时计数，无进展时永不封顶（催干活=主功能，见
// reminder-throttle.ts decideTodoNagInjection）。本组断言的场景没有任何 edit/write 落盘，
// 即处于"无进展"态，故仍**不得**带封顶字段——本组的判据与理由都没变，继续有效：
// 字段在/不在本身携带信息，无进展态上报 nagCount/cap 会让离线分析误判本通道有封顶行为。
describe("埋点语义：todo 通道在无进展态不上报 nagCount/cap", () => {
  test("NoProgressNagInjected 的 todo 事件带扫描距离，不带封顶字段", async () => {
    const { loopConfig, traceEvents } = makeHarness({
      turns: 20,
      todos: [todo("甲", "in_progress"), todo("乙", "pending")],
    });
    for await (const _ of queryLoop(loopConfig)) {
      /* drain */
    }

    const todoNags = traceEvents.filter(
      (e) => e.event === "NoProgressNagInjected" && e.data?.kind === "todo",
    );
    expect(todoNags.length).toBeGreaterThan(0);
    // 新字段在
    expect(todoNags[0].data).toHaveProperty("turnsSinceLastTodoWrite");
    expect(todoNags[0].data).toHaveProperty("turnsSinceLastReminder");
    // 旧封顶语义已不适用于本通道（留着会让离线分析以为还有封顶行为）
    expect(todoNags[0].data.nagCount).toBeUndefined();
    expect(todoNags[0].data.cap).toBeUndefined();
  });
});
