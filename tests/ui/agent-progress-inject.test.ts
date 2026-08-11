/**
 * 子代理进度呈现（治"过程黑盒"）回归测试
 *
 * 治的现象（docs/bugfixes/todo/20260803-TUI子代理呈现四问题 §3，与 cc 差距最大的一条）：
 * 子代理跑 1m35s，主消息流里一个字都没有，末尾一把吐出。根因是 app.ts 的 onToolProgress
 * 有一道 `isShell` 白名单门槛——只有 bash/shell/execute_command 的进度能进工具卡片，
 * 子代理的进度被降级成状态栏 2s 一闪的临时提示。
 *
 * 本文件测三层，每层都调**生产函数**：
 *   1. 数据层 pushRecentActivity —— 滑动窗口（此前 recentActivities 恒传 []，死字段）
 *   2. 决策层 selectAgentProgressTier / formatAgentProgressLine —— 三档降级
 *   3. 注入层 injectAgentProgress —— 快照是否落到正确的卡片、且不误伤别人
 *
 * 铁律（沿用 live-tool-settle-inject.test.ts 的约定）：不许在测试里照抄一遍生产逻辑——
 * 那种测试在生产代码漂移时照样绿，等于没测。
 */

import { describe, test, expect } from "bun:test";
import { messagesToHistoryItems, injectAgentProgress } from "@sid-code/cli/ui/history-adapter.ts";
import { ToolCallStatus, type HistoryItem, type IndividualToolCallDisplay } from "@sid-code/cli/ui/types.ts";
import type { Message } from "@sid-code/core/llm/types.ts";
import {
  pushRecentActivity,
  MAX_RECENT_ACTIVITIES,
  type AgentProgressSnapshot,
} from "@sid-code/core/agent/progress.ts";
import {
  selectAgentProgressTier,
  formatAgentProgressLine,
  ESTIMATED_LINES_PER_ACTIVITY,
  TERMINAL_BUFFER_LINES,
} from "@sid-code/cli/ui/agent-progress-view.ts";

/** 一轮 assistant 消息发出 N 个 tool_use（tool_result 未入 ctxMgr → 全 Executing 态） */
function executingCards(calls: Array<{ id: string; name: string }>): HistoryItem[] {
  const msgs: Message[] = [
    {
      role: "assistant",
      content: calls.map((c) => ({ type: "tool_use" as const, id: c.id, name: c.name, input: {} })),
    },
  ];
  return messagesToHistoryItems(msgs).map((item, i) => ({ ...item, id: i + 1 }) as HistoryItem);
}

function allTools(items: HistoryItem[]): IndividualToolCallDisplay[] {
  return items.flatMap((it) => (it.type === "tool_group" ? it.tools : []));
}

function snapshot(over: Partial<AgentProgressSnapshot> = {}): AgentProgressSnapshot {
  return {
    agentType: "explore",
    toolUseCount: 7,
    tokenCount: 12400,
    elapsedMs: 22_000,
    recentActivities: ["读取 a.ts"],
    ...over,
  };
}

describe("pushRecentActivity — 最近活动滑动窗口", () => {
  test("按序追加，最新在末尾", () => {
    let w: string[] = [];
    w = pushRecentActivity(w, "读取 a.ts");
    w = pushRecentActivity(w, "读取 b.ts");
    expect(w).toEqual(["读取 a.ts", "读取 b.ts"]);
  });

  test("超容量时丢最旧的，保留最近 MAX_RECENT_ACTIVITIES 条", () => {
    let w: string[] = [];
    for (const n of ["1", "2", "3", "4", "5"]) w = pushRecentActivity(w, n);
    expect(w.length).toBe(MAX_RECENT_ACTIVITIES);
    // 保留的是**最近**的，不是最早的（写成 slice(0,max) 就会反过来）
    expect(w).toEqual(["3", "4", "5"]);
  });

  test("连续重复的活动合并而不追加（同一件事仍在继续）", () => {
    let w: string[] = [];
    w = pushRecentActivity(w, "搜索 \"foo\"");
    w = pushRecentActivity(w, "搜索 \"foo\"");
    w = pushRecentActivity(w, "搜索 \"foo\"");
    expect(w).toEqual(["搜索 \"foo\""]);
  });

  test("非相邻的重复照常追加（读 a → 读 b → 又读 a 是三件事）", () => {
    let w: string[] = [];
    w = pushRecentActivity(w, "读取 a");
    w = pushRecentActivity(w, "读取 b");
    w = pushRecentActivity(w, "读取 a");
    expect(w).toEqual(["读取 a", "读取 b", "读取 a"]);
  });

  test("返回新数组，不原地改入参（否则上一帧快照会跟着变，React 失去引用分辨力）", () => {
    const before: string[] = ["读取 a"];
    const after = pushRecentActivity(before, "读取 b");
    expect(before).toEqual(["读取 a"]);
    expect(after).not.toBe(before);
  });

  test("空文案不产生条目", () => {
    expect(pushRecentActivity(["读取 a"], "")).toEqual(["读取 a"]);
  });
});

describe("selectAgentProgressTier — 三档降级", () => {
  test("单代理 + 屏幕够高 → detail（逐条列活动）", () => {
    expect(selectAgentProgressTier(1, 3, 40)).toBe("detail");
  });

  test("多代理并行 → perAgent，且不受终端高度影响", () => {
    // perAgent 已是"每 agent 一行"的最省形态，再降级只剩"完全不显示"=回到黑盒
    expect(selectAgentProgressTier(4, 3, 40)).toBe("perAgent");
    expect(selectAgentProgressTier(4, 3, 5)).toBe("perAgent");
  });

  test("单代理但屏幕不够 → count（压成一行）", () => {
    // 3 条活动需要 3*2+7=13 行；给 12 行不够
    const needed = 3 * ESTIMATED_LINES_PER_ACTIVITY + TERMINAL_BUFFER_LINES;
    expect(selectAgentProgressTier(1, 3, needed - 1)).toBe("count");
    expect(selectAgentProgressTier(1, 3, needed)).toBe("detail");
  });

  test("高度未知（0/undefined）视为够高，不惩罚正常场景", () => {
    expect(selectAgentProgressTier(1, 3, 0)).toBe("detail");
    expect(selectAgentProgressTier(1, 3, undefined)).toBe("detail");
  });

  test("无活动可展示 → count（没有明细可列，展开档没有意义）", () => {
    expect(selectAgentProgressTier(1, 0, 40)).toBe("count");
  });
});

describe("formatAgentProgressLine — 统计行文案", () => {
  const fmtNum = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  const fmtDur = (ms: number) => `${Math.round(ms / 1000)}s`;

  test("统计齐全时拼成 `type · N 工具 · Nk token · 耗时`", () => {
    const line = formatAgentProgressLine(
      { agentType: "explore", toolUseCount: 7, tokenCount: 12400, elapsedMs: 22_000 },
      fmtNum,
      fmtDur,
    );
    expect(line).toBe("explore · 7 工具 · 12.4k token · 22s");
  });

  test("零值字段不出现（刚起步的子代理不显示「0 工具 · 0 token」噪音）", () => {
    const line = formatAgentProgressLine(
      { agentType: "explore", toolUseCount: 0, tokenCount: 0, elapsedMs: 1200 },
      fmtNum,
      fmtDur,
    );
    expect(line).toBe("explore · 1s");
  });

  test("统计行不含任务描述（header 已有，相邻两行重复同一段文字是 UI 规范明禁的）", () => {
    const line = formatAgentProgressLine(
      { agentType: "explore", toolUseCount: 2, tokenCount: 0 },
      fmtNum,
      fmtDur,
    );
    expect(line).toBe("explore · 2 工具");
    expect(line).not.toContain("(");
  });
});

describe("injectAgentProgress — 注入层", () => {
  test("把快照注入执行中的 sub_agent 卡片", () => {
    const items = executingCards([{ id: "t1", name: "sub_agent" }]);
    const snap = snapshot();
    const n = injectAgentProgress(items, new Map([["t1", snap]]));
    expect(n).toBe(1);
    expect(allTools(items)[0].agentProgress).toBe(snap);
  });

  test("不误伤同批次的其它工具（只注入自己 callId 的那张卡）", () => {
    const items = executingCards([
      { id: "t1", name: "sub_agent" },
      { id: "t2", name: "grep" },
    ]);
    injectAgentProgress(items, new Map([["t1", snapshot()]]));
    const tools = allTools(items);
    expect(tools.find((t) => t.callId === "t1")!.agentProgress).toBeDefined();
    expect(tools.find((t) => t.callId === "t2")!.agentProgress).toBeUndefined();
  });

  test("并行多子代理各自注入各自的快照", () => {
    const items = executingCards([
      { id: "a1", name: "sub_agent" },
      { id: "a2", name: "sub_agent" },
    ]);
    const s1 = snapshot({ agentType: "explore", toolUseCount: 3 });
    const s2 = snapshot({ agentType: "plan", toolUseCount: 9 });
    const n = injectAgentProgress(items, new Map([["a1", s1], ["a2", s2]]));
    expect(n).toBe(2);
    const tools = allTools(items);
    expect(tools.find((t) => t.callId === "a1")!.agentProgress).toBe(s1);
    expect(tools.find((t) => t.callId === "a2")!.agentProgress).toBe(s2);
  });

  test("已完成的卡片不注入——进度该让位给真实结果", () => {
    const items = executingCards([{ id: "t1", name: "sub_agent" }]);
    // 模拟权威路径已把它渲染成完成态
    allTools(items)[0].status = ToolCallStatus.Success;
    const n = injectAgentProgress(items, new Map([["t1", snapshot()]]));
    expect(n).toBe(0);
    expect(allTools(items)[0].agentProgress).toBeUndefined();
  });

  test("空侧信道直接短路，返回 0", () => {
    const items = executingCards([{ id: "t1", name: "sub_agent" }]);
    expect(injectAgentProgress(items, new Map())).toBe(0);
  });

  test("侧信道里没有该 callId 时不注入（该子代理还没报进度）", () => {
    const items = executingCards([{ id: "t1", name: "sub_agent" }]);
    expect(injectAgentProgress(items, new Map([["other", snapshot()]]))).toBe(0);
    expect(allTools(items)[0].agentProgress).toBeUndefined();
  });
});
