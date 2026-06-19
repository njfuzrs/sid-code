/**
 * TodoPanel 后台任务面板测试
 *
 * 锁定本次修复的三个关键行为，防回归：
 * 1. 实时计时：运行中任务耗时由 startTime 与当前墙钟实算，不再冻结在 durationMs 快照。
 * 2. 统计文案：真实工具次数 / token 带单位清晰展示（替代晦涩的 "0t·0"）。
 * 3. 当前活动行 + 三种终态字形可区分（completed/failed/killed 字形各异，非仅靠颜色）。
 */

import { test, expect, describe } from "bun:test";
import React from "react";
import { render } from "../../ink/_vendor/testing.tsx";
import { TodoPanel } from "./TodoPanel.tsx";
import type { TaskDisplayInfo } from "../App.tsx";

const TERM_WIDTH = 100;

function runningTask(over: Partial<TaskDisplayInfo> = {}): TaskDisplayInfo {
  return {
    id: "t1",
    type: "local_agent",
    status: "running",
    description: "验证缺口1 FileReadTracker隔离",
    agentType: "explore",
    startTime: Date.now() - 45_000, // 45 秒前启动
    durationMs: 1_000, // 故意给一个「冻结的旧快照」，证明渲染不依赖它
    ...over,
  };
}

describe("TodoPanel — 后台任务实时计时", () => {
  test("运行中耗时由 startTime 实算，不取冻结的 durationMs 快照", () => {
    // startTime = now-45s，durationMs 旧快照=1s。若用快照会显示 1s；实算应显示 ~45s。
    const { lastFrame } = render(
      <TodoPanel todos={[]} tasks={[runningTask()]} termWidth={TERM_WIDTH} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("45s");
    expect(frame).not.toMatch(/\b1s\b/); // 不应显示冻结快照值
  });

  test("统计显示真实工具次数与 token（带单位，非 0t·0）", () => {
    const { lastFrame } = render(
      <TodoPanel
        todos={[]}
        tasks={[runningTask({ progress: { toolUseCount: 3, tokenCount: 12_400 } })]}
        termWidth={TERM_WIDTH}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("3 工具");
    expect(frame).toContain("12.4k token");
    expect(frame).not.toContain("0t·0"); // 旧晦涩格式已废弃
  });

  test("当前活动行展示 lastActivity", () => {
    const { lastFrame } = render(
      <TodoPanel
        todos={[]}
        tasks={[runningTask({ lastActivity: "读取 src/foo.ts" })]}
        termWidth={TERM_WIDTH}
      />,
    );
    expect(lastFrame() ?? "").toContain("读取 src/foo.ts");
  });

  test("运行中计数显示「N 运行中」", () => {
    const { lastFrame } = render(
      <TodoPanel todos={[]} tasks={[runningTask(), runningTask({ id: "t2" })]} termWidth={TERM_WIDTH} />,
    );
    expect(lastFrame() ?? "").toContain("2 运行中");
  });
});

describe("TodoPanel — 终态字形区分（双通道，非仅靠颜色）", () => {
  function terminalTask(status: string, id: string): TaskDisplayInfo {
    return {
      id,
      type: "local_agent",
      status,
      description: `任务 ${status}`,
      agentType: "explore",
      startTime: Date.now() - 30_000,
      endTime: Date.now(),
      durationMs: 30_000,
    };
  }

  test("completed / failed / killed 字形互不相同", () => {
    const completed = render(
      <TodoPanel todos={[]} tasks={[terminalTask("completed", "c")]} termWidth={TERM_WIDTH} />,
    ).lastFrame() ?? "";
    const failed = render(
      <TodoPanel todos={[]} tasks={[terminalTask("failed", "f")]} termWidth={TERM_WIDTH} />,
    ).lastFrame() ?? "";
    const killed = render(
      <TodoPanel todos={[]} tasks={[terminalTask("killed", "k")]} termWidth={TERM_WIDTH} />,
    ).lastFrame() ?? "";

    expect(completed).toContain("●"); // 完成 = 实心圆
    expect(failed).toContain("✘"); // 失败 = 叉
    expect(killed).toContain("⊘"); // 终止 = 圆加斜杠（与 ● 形状不同）
    expect(killed).not.toContain("✘");
  });

  test("终态耗时定格到 durationMs 快照", () => {
    const { lastFrame } = render(
      <TodoPanel todos={[]} tasks={[terminalTask("completed", "c")]} termWidth={TERM_WIDTH} />,
    );
    expect(lastFrame() ?? "").toContain("30s");
  });
});

describe("TodoPanel — 空态", () => {
  test("无 todo 无任务时不渲染", () => {
    const { lastFrame } = render(
      <TodoPanel todos={[]} tasks={[]} termWidth={TERM_WIDTH} />,
    );
    expect((lastFrame() ?? "").trim()).toBe("");
  });
});
