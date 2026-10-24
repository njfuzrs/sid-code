/**
 * 停滞升级阶梯 —— queryLoop 消费端集成测试（评估会话 ce7ea52e 发现 2d/2e，§5 决策 1）
 *
 * 纯函数判据在 stall-escalation.test.ts 锁；这里锁**接线**——判据对了、接线没接上
 * 是本仓踩过很多次的「死接线全零报错」形态：
 *   1. L1 收敛提示真的进了下一轮发给模型的消息（走 reminder 通道，不落历史）；
 *   2. 影子模式（缺省）L2 只落 StallEscalation 事件，循环不停；
 *   3. 开 hardStop 后 L2 走 P1-1 强制总结出口，done 带 incompleteReason=stalled；
 *   4. headless 缺省整套不开；SID_CODE_STALL_ESCALATION=0 一键全关；
 *   5. 2e：todo 闸门在清单振荡超阈值时不再劝「继续」；
 *   6. L2 真停时 /goal 置 blocked，不再续跑。
 *
 * 场景构造：模型每 3 轮换一个 URL 调 web_fetch，返回值恒定 ⇒ 每个 URL 触发一次
 * UnchangedObservationRun（确证信号），全程无文件改动 ⇒ 停滞窗口只会越攒越满。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { queryLoop } from "@sid-code/core/query/loop.ts";
import type { QueryLoopConfig } from "@sid-code/core/query/loop.ts";
import type { QueryDeps } from "@sid-code/core/query/types.ts";
import { MAX_TODO_GATE_RETRIES, TODO_GATE_BUDGET_KEY } from "@sid-code/core/query/todo-reminder.ts";
import {
  STALL_GATE_OSCILLATION_THRESHOLD,
  STALL_WINDOW_TURNS,
} from "@sid-code/core/query/stall-escalation.ts";
import { Manager as ContextManager } from "@sid-code/core/context/manager.ts";
import { Registry as ToolRegistry } from "@sid-code/core/tool/registry.ts";
import { ModelFallback } from "@sid-code/core/llm/fallback.ts";
import { SessionState } from "@sid-code/core/session/state.ts";
import type { Config } from "@sid-code/core/config/config.ts";
import type { StreamEvent, AccumulatedResponse } from "@sid-code/core/llm/types.ts";
import type { TodoItem } from "@sid-code/core/tool/todo-write.ts";
import { createGoal, type GoalState } from "@sid-code/core/goal/state.ts";

const SUMMARY_MARKER = "现状：A；卡点：B；可选方案：C";
/** 兜底：任何场景最多这么多次 API 调用就收尾，防止判据坏了变成死循环把测试挂住 */
const SAFETY_CALLS = 70;

const ENV_KEYS = [
  "SID_CODE_STALL_ESCALATION",
  "SID_CODE_STALL_HARD_STOP",
  "SID_CODE_STALL_ESCALATION_HEADLESS",
] as const;
let savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

async function* emptyStream(): AsyncIterable<StreamEvent> {}

function fetchResp(turn: number, editFile?: string): AccumulatedResponse {
  // 每 3 轮换一个 URL：同指纹连续 3 次 + 同返回值 ⇒ 该指纹上报一次空转
  const url = `https://example.test/p${Math.floor(turn / 3)}`;
  const content: any[] = [{ type: "tool_use", id: `t${turn}`, name: "web_fetch", input: { url } }];
  // 可选：同一轮再带一个 edit（每轮改一个**新文件**——成功时每轮都是新工作区状态）
  if (editFile) {
    content.push({
      type: "tool_use",
      id: `e${turn}`,
      name: "edit",
      input: { file_path: editFile, old_string: "a", new_string: "b" },
    });
  }
  return {
    role: "assistant",
    content,
    stopReason: "tool_use",
    usage: { inputTokens: 100, outputTokens: 20 },
  } as AccumulatedResponse;
}

const textResp = (text: string): AccumulatedResponse =>
  ({
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "end_turn",
    usage: { inputTokens: 100, outputTokens: 20 },
  }) as AccumulatedResponse;

interface RunResult {
  events: any[];
  traceEvents: any[];
  /** 每次发给模型的消息里出现过的 system-reminder 文本（按调用序） */
  remindersPerCall: string[][];
  llmCalls: number;
  ctxMgr: ContextManager;
  goal?: GoalState;
}

async function run(opts: {
  print?: boolean;
  goal?: boolean;
  maxTurns?: number;
  /** 每轮额外对一个新文件发 edit：ok = 成功落盘，fail = 工具返回 is_error */
  edit?: "ok" | "fail";
  editDir?: string;
}): Promise<RunResult> {
  const ctxMgr = new ContextManager({ maxTokens: 200000 });
  ctxMgr.setSystemPrompt("test");
  ctxMgr.addMessage({ role: "user", content: [{ type: "text", text: "把这个问题彻底搞定" }] });

  const traceEvents: any[] = [];
  const remindersPerCall: string[][] = [];
  let lastSentHasStallPrompt = false;
  let llmCalls = 0;
  // 用真工厂造 goal：手写字段漏了 tokensUsed 会让 buildGoalReminder 抛 TypeError（测试脚手架自己错）
  let goal: GoalState | undefined = opts.goal ? createGoal("把问题彻底搞定") : undefined;

  const deps: QueryDeps = {
    sendWithRetry: (params: any) => {
      const found: string[] = [];
      lastSentHasStallPrompt = false;
      for (const m of params?.messages ?? []) {
        if (m.role !== "user" || !Array.isArray(m.content)) continue;
        for (const b of m.content) {
          if (b.type !== "text" || typeof b.text !== "string") continue;
          if (b.text.includes("<system-reminder>")) found.push(b.text);
          if (b.text.includes("harness 检测到本条任务已停滞")) lastSentHasStallPrompt = true;
        }
      }
      remindersPerCall.push(found);
      return emptyStream();
    },
    processStream: async () => {
      const turn = llmCalls++;
      if (lastSentHasStallPrompt) return textResp(SUMMARY_MARKER);
      if (turn >= SAFETY_CALLS) return textResp("兜底收尾");
      let editFile: string | undefined;
      if (opts.edit && opts.editDir) {
        editFile = join(opts.editDir, `f${turn}.ts`);
        writeFileSync(editFile, `content-${turn}`); // 文件真实存在、内容各不相同
      }
      return fetchResp(turn, editFile);
    },
    executeTools: async (content: any[]) => ({
      results: content
        .filter((b) => b.type === "tool_use")
        .map((b) => ({
          type: "tool_result" as const,
          tool_use_id: b.id,
          content: b.name === "edit" ? "edit 结果" : "同一份页面内容",
          ...(b.name === "edit" && opts.edit === "fail" ? { is_error: true } : {}),
        })),
    }),
    autoCompact: async () => {},
    getAbortSignal: () => undefined,
    uuid: () => "uuid-test",
    traceAppendEvent: (e: any) => {
      traceEvents.push(e);
    },
    ...(opts.goal
      ? {
          getGoalState: () => goal ?? null,
          updateGoalState: (fn: (g: GoalState) => void) => {
            if (goal) fn(goal);
          },
        }
      : {}),
  };

  const loopConfig: QueryLoopConfig = {
    config: {
      model: "gpt-6-luna",
      provider: "openai",
      maxTurns: opts.maxTurns ?? 200,
      ...(opts.print ? { print: true } : {}),
    } as unknown as Config,
    ctxMgr,
    toolRegistry: new ToolRegistry(),
    sessionState: new SessionState("test-stall-loop"),
    fallback: new ModelFallback(),
    deps,
  };

  const events: any[] = [];
  for await (const ev of queryLoop(loopConfig)) events.push(ev);
  return { events, traceEvents, remindersPerCall, llmCalls, ctxMgr, goal };
}

const stallEvents = (r: RunResult) =>
  r.traceEvents.filter((e) => e.event === "StallEscalation").map((e) => e.data);

describe("停滞升级阶梯：影子模式（缺省）", () => {
  test("L1 真的进了发给模型的消息；L2 只落事件、循环不停", async () => {
    const r = await run({});
    const ev = stallEvents(r);

    // L1：发生过一次，且只有一次
    const l1 = ev.filter((e) => e.level === 1);
    expect(l1).toHaveLength(1);
    expect(l1[0].acted).toBe(true);
    expect(l1[0].turnsSinceNewState).toBeGreaterThanOrEqual(STALL_WINDOW_TURNS);

    // L1 文案出现在某次发给模型的 reminder 里（接线到位，不是只落了事件）
    const callsWithL1 = r.remindersPerCall.filter((rs) => rs.some((t) => t.includes("收敛提示")));
    expect(callsWithL1.length).toBeGreaterThan(0);
    // reminder 通道不落历史：ctxMgr 里不该永久留着它（否则每轮重复 + 长任务膨胀）
    const inHistory = r.ctxMgr
      .getMessages()
      .some((m) => JSON.stringify(m.content).includes("收敛提示"));
    expect(inHistory).toBe(false);

    // L2 影子：命中但 acted=false，循环没被叫停
    const l2 = ev.filter((e) => e.level === 2);
    expect(l2.length).toBeGreaterThanOrEqual(1);
    expect(l2.every((e) => e.acted === false)).toBe(true);
    const done = r.events.find((e) => e.kind === "done");
    expect(done.incompleteReason).toBeUndefined();
    // 没被叫停 ⇒ 一直跑到兜底收尾
    expect(r.llmCalls).toBeGreaterThan(SAFETY_CALLS);
  });

  test("事件携带可对账的字段（按 (model, 会话长度) 观测触发率的分母）", async () => {
    const r = await run({});
    const e = stallEvents(r).find((x) => x.level === 2)!;
    for (const k of [
      "level",
      "acted",
      "toolTurns",
      "turnsSinceNewState",
      "unchangedReports",
      "l2Count",
    ]) {
      expect(e).toHaveProperty(k);
    }
    expect(e.l2Count).toBe(1);
  });
});

describe("停滞升级阶梯：hardStop 打开", () => {
  test("L2 走强制总结出口：产出总结 + done.incompleteReason=stalled，远早于兜底", async () => {
    process.env.SID_CODE_STALL_HARD_STOP = "1";
    const r = await run({});

    const l2 = stallEvents(r).filter((e) => e.level === 2);
    expect(l2).toHaveLength(1);
    expect(l2[0].acted).toBe(true);

    // 总结轮确实发生，且总结文本进了事件流
    const summary = r.events.find(
      (e) =>
        e.kind === "assistant_message" &&
        e.message.content.some((b: any) => b.type === "text" && b.text.includes(SUMMARY_MARKER)),
    );
    expect(summary).toBeDefined();

    // 收尾口径：stalled 不是 max_turns，也不是正常说完
    const kinds = r.events.map((e) => e.kind);
    expect(kinds).not.toContain("max_turns");
    const done = r.events.find((e) => e.kind === "done");
    expect(done.incompleteReason).toBe("stalled");

    // 端到端耗时锚点的结束原因要说实话：stalled，不是 max_turns / error / other
    const completes = r.traceEvents.filter((e) => e.event === "TurnComplete").map((e) => e.data);
    expect(completes).toHaveLength(1);
    expect(completes[0].stop_reason).toBe("stalled");

    // 提示用户发生了什么（不能静默停）
    const sys = r.events.filter((e) => e.kind === "system").map((e) => e.text);
    expect(sys.some((t) => t.includes("任务停滞"))).toBe(true);

    // 真的停了：总调用数远小于影子模式跑满兜底
    expect(r.llmCalls).toBeLessThan(SAFETY_CALLS / 2);
  });

  test("L2 不会跳过 L1：事件序里 L1 先于 L2", async () => {
    process.env.SID_CODE_STALL_HARD_STOP = "1";
    const r = await run({});
    const levels = stallEvents(r).map((e) => e.level);
    expect(levels.indexOf(1)).toBeGreaterThanOrEqual(0);
    expect(levels.indexOf(2)).toBeGreaterThan(levels.indexOf(1));
  });

  test("/goal 会话：L2 真停时目标置 blocked，不再自动续跑", async () => {
    process.env.SID_CODE_STALL_HARD_STOP = "1";
    const r = await run({ goal: true });
    expect(r.goal?.status).toBe("blocked");
    // 总结提示带上 goal 目标，用户能看到当前目标状态
    const prompt = JSON.stringify(r.ctxMgr.getMessages());
    expect(prompt).toContain("把问题彻底搞定");
  });
});

describe("停滞升级阶梯：开关", () => {
  test("headless（print）缺省整套不开：没有事件、不注入、不停", async () => {
    process.env.SID_CODE_STALL_HARD_STOP = "1"; // 即使 hardStop 已开
    const r = await run({ print: true });
    expect(stallEvents(r)).toHaveLength(0);
    expect(r.remindersPerCall.flat().some((t) => t.includes("收敛提示"))).toBe(false);
    expect(r.events.find((e) => e.kind === "done").incompleteReason).toBeUndefined();
    expect(r.llmCalls).toBeGreaterThan(SAFETY_CALLS);
  });

  test("headless 显式 opt-in ⇒ 启用，L2 真停后 done 带 stalled", async () => {
    process.env.SID_CODE_STALL_HARD_STOP = "1";
    process.env.SID_CODE_STALL_ESCALATION_HEADLESS = "1";
    const r = await run({ print: true });
    expect(r.events.find((e) => e.kind === "done").incompleteReason).toBe("stalled");
  });

  test("SID_CODE_STALL_ESCALATION=0 一键全关", async () => {
    process.env.SID_CODE_STALL_ESCALATION = "0";
    process.env.SID_CODE_STALL_HARD_STOP = "1";
    const r = await run({});
    expect(stallEvents(r)).toHaveLength(0);
    expect(r.llmCalls).toBeGreaterThan(SAFETY_CALLS);
  });
});

describe("2e：todo 收尾闸门在清单振荡超阈值时不再劝「继续」", () => {
  const todos: TodoItem[] = [
    { content: "A", activeForm: "A", status: "completed" },
    { content: "B", activeForm: "B", status: "in_progress" },
    { content: "C", activeForm: "C", status: "pending" },
  ];

  async function gateRun(oscillations: number) {
    const sessionState = new SessionState("test-stall-gate");
    // 预置「本份清单已振荡 N 次」：total/completed 与 todos 一致 ⇒ advance 沿用该预算
    sessionState.set(TODO_GATE_BUDGET_KEY, {
      retries: 0,
      productiveNoUpdate: 0,
      completed: 1,
      peakCompleted: 1,
      oscillations,
      total: 3,
      exhaustedNotified: false,
    });
    const ctxMgr = new ContextManager({ maxTokens: 200000 });
    ctxMgr.setSystemPrompt("test");
    ctxMgr.addMessage({ role: "user", content: [{ type: "text", text: "继续" }] });
    let llmCalls = 0;
    const deps: QueryDeps = {
      sendWithRetry: () => emptyStream(),
      processStream: async () => {
        llmCalls++;
        return textResp("先告一段落。");
      },
      executeTools: async () => ({ results: [] }),
      autoCompact: async () => {},
      getAbortSignal: () => undefined,
      uuid: () => "uuid-test",
      getTodoState: () => ({ todos, writeVersion: 1 }),
    };
    const systemTexts: string[] = [];
    for await (const ev of queryLoop({
      config: { model: "gpt-6-luna", provider: "openai", maxTurns: 20 } as unknown as Config,
      ctxMgr,
      toolRegistry: new ToolRegistry(),
      sessionState,
      fallback: new ModelFallback(),
      deps,
    } as QueryLoopConfig)) {
      if (ev.kind === "system" && "text" in ev) systemTexts.push(ev.text);
    }
    return { llmCalls, systemTexts };
  }

  test("振荡 < 阈值：照常劝回（对照组，证明下面的变化来自 2e 而不是闸门本来就放行）", async () => {
    const { llmCalls } = await gateRun(STALL_GATE_OSCILLATION_THRESHOLD - 1);
    expect(llmCalls).toBe(1 + MAX_TODO_GATE_RETRIES);
  });

  test("振荡 ≥ 阈值：一次收尾即放行，并明说「不再自动续跑」", async () => {
    const { llmCalls, systemTexts } = await gateRun(STALL_GATE_OSCILLATION_THRESHOLD);
    expect(llmCalls).toBe(1);
    expect(systemTexts.join("\n")).toContain("不再自动续跑");
  });

  test("总开关关闭 ⇒ 2e 同时失效，回到旧行为", async () => {
    process.env.SID_CODE_STALL_ESCALATION = "0";
    const { llmCalls } = await gateRun(STALL_GATE_OSCILLATION_THRESHOLD + 2);
    expect(llmCalls).toBe(1 + MAX_TODO_GATE_RETRIES);
  });
});

describe("进展判据：只有成功落盘的 edit 才算新工作区状态", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "stall-edit-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("edit 全部失败（is_error）⇒ 不算进展，L1 照常触发", async () => {
    // 每轮对一个**新文件**发失败 edit。若把失败 edit 也登记进账本，每轮都会多出一个
    // 新文件 key ⇒ 每轮都是「新状态」⇒ 停滞窗口永远攒不满 ⇒ 阶梯被失败重试悄悄绕过。
    const r = await run({ edit: "fail", editDir: dir });
    expect(stallEvents(r).some((e) => e.level === 1)).toBe(true);
  });

  test("edit 成功且每轮都改出新状态 ⇒ 是真进展，阶梯不打扰（大重构不被误伤）", async () => {
    const r = await run({ edit: "ok", editDir: dir });
    expect(stallEvents(r)).toHaveLength(0);
    // 没被打扰 ⇒ 一路跑到兜底
    expect(r.llmCalls).toBeGreaterThan(SAFETY_CALLS);
  });
});
