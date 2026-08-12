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
import { render } from "@sid-code/tui-renderer/_vendor/testing.tsx";
import { TodoPanel } from "@sid-code/cli/ui/components/TodoPanel.tsx";
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
  const NARROW_WIDTH = 59; // < 60 触发 compactMode；maxContentLen = max(20, 59-16) = 43

  test("窄终端不再整区消失：至少能看到是什么任务在跑", () => {
    const { lastFrame } = render(
      <TodoPanel todos={[]} tasks={[runningTask()]} termWidth={NARROW_WIDTH} />,
    );
    const frame = lastFrame() ?? "";
    // 标题行计数此前就有，摘要是新增的
    expect(frame).toContain("1 运行中");
    expect(frame).toContain("explore"); // 此前 compactMode 下这里应为空
  });

  test("多任务并行时摘要逐个列出，而非只给一个数字", () => {
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
    expect(frame).toContain("explore");
    expect(frame).toContain("verify");
  });

  test("摘要只用极简标签，不带完整描述（保持单行、不拖出长文本）", () => {
    const { lastFrame } = render(
      <TodoPanel todos={[]} tasks={[runningTask()]} termWidth={NARROW_WIDTH} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("explore");
    expect(frame).not.toContain("验证缺口1 FileReadTracker隔离"); // 完整 description 不应出现
  });

  test("摘要与 …+N 截断提示视口一致：只反映 visibleTasks，被截断的不出现在摘要里", () => {
    // 6 个全部 running：windowed = running.slice 无效（无 terminal），visibleTasks = 前 5 个
    const many = Array.from({ length: 6 }, (_, i) =>
      runningTask({ id: `t${i}`, agentType: `a${i}` }),
    );
    const { lastFrame } = render(<TodoPanel todos={[]} tasks={many} termWidth={NARROW_WIDTH} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("a0");
    expect(frame).toContain("a4");
    expect(frame).not.toContain("a5"); // 第 6 个被视口截断，不应出现在摘要里
    expect(frame).toContain("…+1"); // 附1 的截断提示不受本次改动影响
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
