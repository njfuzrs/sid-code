/**
 * 缺口 A：schedule_wakeup 工具单测
 * 覆盖延迟钳制 [60,3600]、非法输入、一次性任务落入 Scheduler。
 */

import { describe, it, expect, afterEach } from "bun:test";
import { ScheduleWakeupTool } from "../../src/tool/schedule-wakeup.ts";
import { getScheduler, resetScheduler } from "../../src/cron/scheduler.ts";

describe("ScheduleWakeupTool", () => {
  afterEach(() => {
    resetScheduler();
  });

  it("正常延迟创建一次性 fireAt 任务", async () => {
    const tool = new ScheduleWakeupTool();
    const before = Date.now();
    const res = await tool.execute({ delaySeconds: 120, prompt: "检查 CI" });
    expect(res.isError).toBeFalsy();
    expect(res.output).toContain("120s");

    const tasks = getScheduler().listTasks();
    expect(tasks.length).toBe(1);
    const t = tasks[0];
    expect(t.recurring).toBe(false);
    expect(t.durable).toBe(false);
    expect(t.fireAt).toBeDefined();
    // fireAt ≈ now + 120s
    expect(t.fireAt! - before).toBeGreaterThanOrEqual(120 * 1000);
    expect(t.fireAt! - before).toBeLessThan(125 * 1000);
  });

  it("延迟下钳到 60s", async () => {
    const tool = new ScheduleWakeupTool();
    const res = await tool.execute({ delaySeconds: 5, prompt: "x" });
    expect(res.output).toContain("60s");
    expect(res.output).toContain("钳制");
    const t = getScheduler().listTasks()[0];
    const delta = t.fireAt! - t.createdAt;
    expect(Math.round(delta / 1000)).toBe(60);
  });

  it("延迟上钳到 3600s", async () => {
    const tool = new ScheduleWakeupTool();
    const res = await tool.execute({ delaySeconds: 99999, prompt: "x" });
    expect(res.output).toContain("3600s");
    const t = getScheduler().listTasks()[0];
    const delta = t.fireAt! - t.createdAt;
    expect(Math.round(delta / 1000)).toBe(3600);
  });

  it("缺参数报错", async () => {
    const tool = new ScheduleWakeupTool();
    const r1 = await tool.execute({ prompt: "x" });
    expect(r1.isError).toBe(true);
    const r2 = await tool.execute({ delaySeconds: 100 });
    expect(r2.isError).toBe(true);
  });

  it("拒绝非有限数字", async () => {
    const tool = new ScheduleWakeupTool();
    const r = await tool.execute({ delaySeconds: Infinity, prompt: "x" });
    expect(r.isError).toBe(true);
  });

  it("reason 写入输出", async () => {
    const tool = new ScheduleWakeupTool();
    const res = await tool.execute({
      delaySeconds: 200,
      prompt: "x",
      reason: "等构建约 3 分钟",
    });
    expect(res.output).toContain("等构建约 3 分钟");
  });
});
