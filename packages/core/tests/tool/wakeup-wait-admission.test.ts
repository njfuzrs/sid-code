/**
 * R2：`schedule_wakeup` 入口的按对象准入。
 *
 * 为什么单独一个文件：`schedule-wakeup.test.ts` 只覆盖参数钳制与调度器落库，
 * 不碰等待表；而这一条的关键时序是「判定必须在 `replaceSessionTasksByOrigin` **之前**」——
 * 先排上再判「重复」，旧唤醒已经被删了，「保留旧的」就无从谈起（静默丢等待）。
 * 放在同一个文件里会让两件事的失败原因混在一起。
 *
 * 落盘隔离：任务登记走 task registry（会写 tasks 目录），按 CONTRIBUTING 测试约定
 * 把 SID_CONFIG_DIR 指向 tmpdir（存/恢复原值）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { ScheduleWakeupTool } from "../../src/tool/schedule-wakeup.ts";
import { getScheduler, resetScheduler } from "../../src/cron/scheduler.ts";
import { clearAllTasks, registerTask } from "../../src/task/registry.ts";
import { __resetWaitRegistryForTest, registerWait } from "../../src/task/wait-registry.ts";
import type { LocalShellTaskState } from "../../src/task/types.ts";

let originalConfigDir: string | undefined;
let tmpHome = "";

beforeEach(() => {
  originalConfigDir = process.env.SID_CONFIG_DIR;
  tmpHome = mkdtempSync(join(tmpdir(), "sid-wakeup-admission-"));
  process.env.SID_CONFIG_DIR = tmpHome;
  __resetWaitRegistryForTest();
  clearAllTasks();
  resetScheduler();
});

afterEach(() => {
  __resetWaitRegistryForTest();
  clearAllTasks();
  resetScheduler();
  if (originalConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = originalConfigDir;
  rmSync(tmpHome, { recursive: true, force: true });
});

/** 造一条正在跑的后台等待（等价于 bash + wait_until_seconds 成功之后） */
function addShellWait(id: string, command: string, subjects: string[]): void {
  const task: LocalShellTaskState = {
    id,
    type: "local_shell",
    status: "running",
    description: command.slice(0, 60),
    startTime: Date.now(),
    outputFile: `/tmp/${id}.out`,
    outputOffset: 0,
    notified: false,
    command,
    interrupted: false,
    isBackgrounded: true,
  };
  registerTask(task);
  registerWait({
    id,
    kind: "shell",
    promise: { kind: "deadline", deadlineAt: Date.now() + 600_000 },
    description: command.slice(0, 60),
    registeredAt: Date.now(),
    subjects,
    command,
  });
}

describe("R2 唤醒入口：同对象准入", () => {
  test("同对象同 prompt → 不排新唤醒，回执给出 cron_delete 出口", async () => {
    addShellWait("s1", "检查 PR #780 的 CI", ["gh:pr:780"]);

    const tool = new ScheduleWakeupTool();
    const res = await tool.execute({ delay_seconds: 600, prompt: "检查 PR #780 的 CI" });

    expect(res.isError).toBeFalsy();
    expect(res.output).toContain("本次未重复启动");
    expect(res.output).toContain("s1");
    // 唤醒的出口不是 task_stop（它不在 task registry 里）
    expect(res.output).toContain("task_stop s1");
    // 调度器里一条都没排：不是「排上再替换」
    expect(getScheduler().listTasks()).toHaveLength(0);
  });

  test("同对象但换了说法 → 照常排（replace 分支不拦）", async () => {
    addShellWait("s1", "检查 PR #780 的 CI", ["gh:pr:780"]);

    const tool = new ScheduleWakeupTool();
    const res = await tool.execute({
      delay_seconds: 1800,
      prompt: "再看一眼 PR #780 合并了没有（换一种等法）",
    });

    expect(res.isError).toBeFalsy();
    expect(res.output).toContain("已安排");
    expect(getScheduler().listTasks()).toHaveLength(1);
  });

  test("不同对象 → 照常排（不误拦）", async () => {
    addShellWait("s1", "检查 PR #780 的 CI", ["gh:pr:780"]);

    const tool = new ScheduleWakeupTool();
    const res = await tool.execute({ delay_seconds: 600, prompt: "检查 PR #781 的 CI" });

    expect(res.isError).toBeFalsy();
    expect(getScheduler().listTasks()).toHaveLength(1);
  });

  test("prompt 抽不出对象 → 照常排（不参与去重）", async () => {
    addShellWait("s1", "检查 PR #780 的 CI", ["gh:pr:780"]);

    const tool = new ScheduleWakeupTool();
    const res = await tool.execute({ delay_seconds: 600, prompt: "过一会儿再看看情况" });

    expect(res.isError).toBeFalsy();
    expect(getScheduler().listTasks()).toHaveLength(1);
  });
});
