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
import { render } from "@sid-code/cli/ui/render-port/testing.ts";
import stripAnsi from "strip-ansi";
import { TodoPanel } from "@sid-code/cli/ui/components/TodoPanel.tsx";
import { TREE_BRANCH } from "@sid-code/cli/ui/constants/figures.ts";
import type { TaskDisplayInfo } from "@sid-code/cli/ui/App.tsx";

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
      <TodoPanel
        todos={[]}
        tasks={[runningTask(), runningTask({ id: "t2" })]}
        termWidth={TERM_WIDTH}
      />,
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
    const completed =
      render(
        <TodoPanel todos={[]} tasks={[terminalTask("completed", "c")]} termWidth={TERM_WIDTH} />,
      ).lastFrame() ?? "";
    const failed =
      render(
        <TodoPanel todos={[]} tasks={[terminalTask("failed", "f")]} termWidth={TERM_WIDTH} />,
      ).lastFrame() ?? "";
    const killed =
      render(
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

describe("TodoPanel — compactMode 单行摘要（附4：窄终端不整区隐藏）", () => {
  // 2026-11-08（PR 2 / §5.7.6 T-T1-8）**契约变更**：摘要从「逐个列 agentType」改成
  // 「按类型计数」（`后台：2 agent · 1 唤醒`），与 CC 的 `getPillLabel` 同构。
  // 理由：任务一多，逐个列名会把单行撑爆，而后半截正好是用户最想看的类型；计数为 0
  // 的类型省略。此前的「逐个列名」不是需求，只是实现顺手写成的样子。
  const NARROW_WIDTH = 59; // < 60 触发 compactMode；maxContentLen = max(20, 59-16) = 43

  test("窄终端不再整区消失：至少能看到是什么任务在跑", () => {
    const { lastFrame } = render(
      <TodoPanel todos={[]} tasks={[runningTask()]} termWidth={NARROW_WIDTH} />,
    );
    const frame = lastFrame() ?? "";
    // 标题行计数此前就有，摘要是新增的
    expect(frame).toContain("1 运行中");
    expect(frame).toContain("后台：1 agent"); // 此前 compactMode 下这里应为空
  });

  test("多任务并行时按类型计数，而非逐个列名（防单行撑爆）", () => {
    const { lastFrame } = render(
      <TodoPanel
        todos={[]}
        tasks={[
          runningTask({ id: "t1", agentType: "explore" }),
          runningTask({ id: "t2", agentType: "verify" }),
        ]}
        termWidth={NARROW_WIDTH}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("后台：2 agent");
    // 具体名字不再进摘要——窄屏下列名会把单行撑爆，用户要看名字可以放宽终端
    expect(frame).not.toContain("verify");
  });

  test("摘要不带完整描述（保持单行、不拖出长文本）", () => {
    const { lastFrame } = render(
      <TodoPanel todos={[]} tasks={[runningTask()]} termWidth={NARROW_WIDTH} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("后台：1 agent");
    expect(frame).not.toContain("验证缺口1 FileReadTracker隔离"); // 完整 description 不应出现
  });

  test("摘要按全量统计：被视口截断的任务仍计入（D16 契约变更）", () => {
    // 6 个全部 running：视口只渲染前 5 个，但摘要说的是「一共有多少」，必须是 6。
    // 2026-11-09（D16）：此前断言「后台：5 agent」——用屏幕放得下的那部分统计，
    // 被 slice 挤出去的任务从摘要里消失，恰好违背摘要「屏幕放不下时仍告诉用户有什么」的语义。
    const many = Array.from({ length: 6 }, (_, i) =>
      runningTask({ id: `t${i}`, agentType: `a${i}` }),
    );
    const { lastFrame } = render(<TodoPanel todos={[]} tasks={many} termWidth={NARROW_WIDTH} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("后台：6 agent"); // 全量，不是视口内的 5 个
    expect(frame).toContain("…+1"); // 视口截断提示不变
  });

  test("D16：被挤出视口的唤醒仍进摘要，终态任务不计入", () => {
    // 排序是 running → wakeup → terminal.slice(-3)，视口只有 5 行：
    // visible = 2 shell + 3 monitor，唤醒是第 6 条被挤出——旧实现里摘要就没有「1 唤醒」。
    // 3 个终态任务同时验证「摘要是「还在后台的」」：它们占了 tasks 但不应出现在摘要里。
    const shells: TaskDisplayInfo[] = [0, 1].map((i) => ({
      id: `s${i}`,
      type: "local_shell",
      status: "running",
      description: `跑测试 ${i}`,
      command: "bun test",
      startTime: Date.now() - 5_000,
      durationMs: 1_000,
    }));
    const monitors: TaskDisplayInfo[] = [0, 1, 2].map((i) => ({
      id: `m${i}`,
      type: "local_monitor",
      kind: "monitor",
      status: "running",
      description: `监控 CI ${i}`,
      command: "gh pr checks",
      startTime: Date.now() - 5_000,
      durationMs: 1_000,
      eventCount: 1,
      deadlineAt: Date.now() + 60_000,
    }));
    const wakeup: TaskDisplayInfo = {
      id: "w1",
      type: "wakeup",
      kind: "wakeup",
      status: "waiting",
      description: "再查一次 CI",
      startTime: Date.now() - 1_000,
      durationMs: 0,
      dueAt: Date.now() + 600_000,
    };
    const done: TaskDisplayInfo[] = ["completed", "failed", "killed"].map((status, i) => ({
      id: `d${i}`,
      type: "local_agent",
      status,
      description: `已结束 ${i}`,
      agentType: "explore",
      startTime: Date.now() - 30_000,
      endTime: Date.now(),
      durationMs: 30_000,
    }));
    const frame =
      render(
        <TodoPanel
          todos={[]}
          tasks={[...shells, ...monitors, ...done, wakeup]}
          termWidth={NARROW_WIDTH}
        />,
      ).lastFrame() ?? "";
    // 精确断言整行文本（T-T1-8）：只断言「含」会漏掉少一个计数的情况——
    // 旧实现里正是「1 唤醒」整段消失，仍然含「后台：」前缀。
    const summaryLine = stripAnsi(frame)
      .split("\n")
      .find((l) => l.includes("后台："));
    // 用 TREE_BRANCH 常量而不是字面量 `⎿`：字形随平台变（见 constants/figures.ts），
    // 写死会在 CI（ubuntu）上红。
    expect(summaryLine?.trim()).toBe(`${TREE_BRANCH} 后台：2 shell · 3 监控 · 1 唤醒`);
  });

  test("shell / workflow 任务类型的摘要标签", () => {
    const shellTask: TaskDisplayInfo = {
      id: "s1",
      type: "local_shell",
      status: "running",
      description: "运行中的 shell 命令",
      command: "grep -rn foo src/",
      startTime: Date.now() - 5_000,
      durationMs: 1_000,
    };
    const { lastFrame } = render(
      <TodoPanel todos={[]} tasks={[shellTask]} termWidth={NARROW_WIDTH} />,
    );
    expect(lastFrame() ?? "").toContain("shell");
  });

  test("宽终端不受影响：仍逐行渲染 TaskRow 完整描述（回归）", () => {
    const { lastFrame } = render(
      <TodoPanel todos={[]} tasks={[runningTask()]} termWidth={TERM_WIDTH} />,
    );
    expect(lastFrame() ?? "").toContain("验证缺口1 FileReadTracker隔离");
  });
});

describe("TodoPanel — 空态", () => {
  test("无 todo 无任务时不渲染", () => {
    const { lastFrame } = render(<TodoPanel todos={[]} tasks={[]} termWidth={TERM_WIDTH} />);
    expect((lastFrame() ?? "").trim()).toBe("");
  });
});
