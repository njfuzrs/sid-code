/**
 * 缺口 A：schedule_wakeup 工具单测
 * 覆盖延迟钳制 [60,3600]、非法输入、一次性任务落入 Scheduler。
 */

import { describe, it, expect, afterEach } from "bun:test";
import { ScheduleWakeupTool } from "@sid-code/core/tool/schedule-wakeup.ts";
import { getScheduler, resetScheduler } from "@sid-code/core/cron/scheduler.ts";

describe("ScheduleWakeupTool", () => {
  afterEach(() => {
    resetScheduler();
  });

  // G3：origin 只在这一个创建入口写。漏了的话轨迹里所有 schedule_wakeup 触发的
  // ScheduledFire 都会记 unknown，与 /loop、cron_create 分不开。
  it("创建入口写入 origin=schedule_wakeup", async () => {
    const tool = new ScheduleWakeupTool();
    await tool.execute({ delay_seconds: 120, prompt: "x" });
    expect(getScheduler().listTasks()[0].origin).toBe("schedule_wakeup");
  });

  it("正常延迟创建一次性 fireAt 任务", async () => {
    const tool = new ScheduleWakeupTool();
    const before = Date.now();
    const res = await tool.execute({ delay_seconds: 120, prompt: "检查 CI" });
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
    const res = await tool.execute({ delay_seconds: 5, prompt: "x" });
    expect(res.output).toContain("60s");
    expect(res.output).toContain("钳制");
    const t = getScheduler().listTasks()[0];
    const delta = t.fireAt! - t.createdAt;
    expect(Math.round(delta / 1000)).toBe(60);
  });

  it("延迟上钳到 3600s", async () => {
    const tool = new ScheduleWakeupTool();
    const res = await tool.execute({ delay_seconds: 99999, prompt: "x" });
    expect(res.output).toContain("3600s");
    const t = getScheduler().listTasks()[0];
    const delta = t.fireAt! - t.createdAt;
    expect(Math.round(delta / 1000)).toBe(3600);
  });

  it("缺参数报错", async () => {
    const tool = new ScheduleWakeupTool();
    const r1 = await tool.execute({ prompt: "x" });
    expect(r1.isError).toBe(true);
    const r2 = await tool.execute({ delay_seconds: 100 });
    expect(r2.isError).toBe(true);
  });

  it("拒绝非有限数字", async () => {
    const tool = new ScheduleWakeupTool();
    const r = await tool.execute({ delay_seconds: Infinity, prompt: "x" });
    expect(r.isError).toBe(true);
  });

  it("reason 写入输出", async () => {
    const tool = new ScheduleWakeupTool();
    const res = await tool.execute({
      delay_seconds: 200,
      prompt: "x",
      reason: "等构建约 3 分钟",
    });
    expect(res.output).toContain("等构建约 3 分钟");
  });

  // D19：等外部状态的首选是 monitor，本工具只负责「到某个时间点再做一件事」。
  // 旧描述拿「跑到 CI 过为止」当典型用法，正是方案 §5.4 要收口的那条次优路径——
  // 模型照着它会把前台轮询换成 N 次唤醒，等待语义没有变好。
  describe("D19 工具描述指向 monitor", () => {
    it("描述里出现 monitor（引导到正确工具）", () => {
      expect(new ScheduleWakeupTool().description()).toContain("monitor");
    });

    it("描述不再出现「跑到 CI 过为止」的旧典型用法", () => {
      expect(new ScheduleWakeupTool().description()).not.toContain("跑到 CI 过为止");
    });

    it("保留三段既有取舍说明（钳制 / 单链替换 / 缓存 TTL）", () => {
      const desc = new ScheduleWakeupTool().description();
      expect(desc).toContain("[60, 3600]");
      expect(desc).toContain("替换前一个");
      expect(desc).toContain("缓存 TTL");
    });
  });
});
