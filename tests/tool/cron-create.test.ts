/**
 * 缺口 C1 §5.3：cron_create 任务级 allowed_tools 预授权入口单测
 * 覆盖 allowed_tools 透传、去重去空、缺省只读、非法 cron 拒绝。
 */

import { describe, it, expect, afterEach } from "bun:test";
import { CronCreateTool } from "@sid-code/core/tool/cron-create.ts";
import { getScheduler, resetScheduler } from "@sid-code/core/cron/scheduler.ts";

describe("CronCreateTool — allowed_tools 预授权", () => {
  afterEach(() => {
    resetScheduler();
  });

  it("声明的 allowed_tools 透传到任务对象", async () => {
    const tool = new CronCreateTool();
    const res = await tool.execute({
      cron: "*/5 * * * *",
      prompt: "巡检",
      allowed_tools: ["Bash", "Read"],
    });
    expect(res.isError).toBeFalsy();
    expect(res.output).toContain("预授权工具: Bash, Read");

    const t = getScheduler().listTasks()[0];
    expect(t.allowedTools).toEqual(["Bash", "Read"]);
  });

  it("allowed_tools 去重去空白", async () => {
    const tool = new CronCreateTool();
    await tool.execute({
      cron: "*/5 * * * *",
      prompt: "x",
      allowed_tools: ["Bash", " Bash ", "", "Read", "  "],
    });
    const t = getScheduler().listTasks()[0];
    expect(t.allowedTools).toEqual(["Bash", "Read"]);
  });

  it("未声明 allowed_tools 时字段缺省（默认只读）", async () => {
    const tool = new CronCreateTool();
    const res = await tool.execute({ cron: "*/5 * * * *", prompt: "x" });
    const t = getScheduler().listTasks()[0];
    expect(t.allowedTools).toBeUndefined();
    // 会话级任务不提示预授权（只有 durable 才与守护进程相关）
    expect(res.output).not.toContain("预授权工具");
  });

  it("空 allowed_tools 数组视为未声明", async () => {
    const tool = new CronCreateTool();
    await tool.execute({ cron: "*/5 * * * *", prompt: "x", allowed_tools: [] });
    const t = getScheduler().listTasks()[0];
    expect(t.allowedTools).toBeUndefined();
  });

  it("inputSchema 暴露 allowed_tools 字段（供 LLM 发现）", () => {
    const tool = new CronCreateTool();
    const schema = tool.inputSchema() as any;
    expect(schema.properties?.allowed_tools).toBeDefined();
    expect(schema.properties.allowed_tools.type).toBe("array");
  });

  it("非法 cron 表达式被拒绝", async () => {
    const tool = new CronCreateTool();
    const res = await tool.execute({ cron: "不合法", prompt: "x" });
    expect(res.isError).toBe(true);
    expect(res.output).toContain("无效的 cron");
  });
});
