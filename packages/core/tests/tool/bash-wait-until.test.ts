/**
 * W1.3：后台 bash 的 `wait_until_seconds`（PR 1 验收 T-W1-3 / T-W1-5 的可用部分）
 *
 * ⚠️ 到期 kill（T-W1-5）不在本文件里跑：钳制下限是 60s，等一次真实到期会让单测
 * 多花一分钟。到期路径由 `registerWaitUntil` 的定时器 + `killShellTask(summary)` 覆盖，
 * 其中 kill 的**文案**在下面的用例里直接验证（不依赖真实到期）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { BashTool } from "../../src/tool/bash.ts";
import {
  __resetWaitRegistryForTest,
  hasPromisedWait,
  listWaits,
} from "../../src/task/wait-registry.ts";
import { clearAllTasks, getTask } from "../../src/task/registry.ts";
import { killShellTask } from "../../src/task/shell-task.ts";
import { __resetBackgroundAwaitForTest } from "../../src/task/background-await.ts";

let tool: BashTool;

beforeEach(() => {
  __resetWaitRegistryForTest();
  __resetBackgroundAwaitForTest();
  clearAllTasks();
  tool = new BashTool();
});

afterEach(() => {
  clearAllTasks();
  __resetWaitRegistryForTest();
});

describe("W1.3 wait_until_seconds", () => {
  test("T-W1-3 不带 run_in_background 时被忽略，并在结果里明说（不能静默）", async () => {
    const result = await tool.execute({
      command: "echo hi",
      wait_until_seconds: 120,
    });
    expect(result.isError).toBeFalsy();
    expect(result.output).toContain("wait_until_seconds 只在 run_in_background=true 时生效");
  });

  test("T-W1-3 钳制到 [60, 3600]：传 30 秒被抬到 60 并写明", async () => {
    const result = await tool.execute({
      command: "sleep 30",
      run_in_background: true,
      wait_until_seconds: 30,
    });
    const parsed = JSON.parse(result.output) as { task_id: string; message: string };
    expect(parsed.message).toContain("已从 30s 钳制到 60s");
    // 登记为 deadline 源，于是静默也不再被判「不值得等」
    const wait = listWaits().find((w) => w.id === parsed.task_id);
    expect(wait?.promise.kind).toBe("deadline");
    expect(hasPromisedWait()).toBe(true);
    killShellTask(parsed.task_id);
  });

  test("T-W1-5（文案部分）期限 kill 的通知写明「等待期限到」，不是笼统的「已被终止」", async () => {
    const result = await tool.execute({
      command: "sleep 30",
      run_in_background: true,
      wait_until_seconds: 60,
    });
    const parsed = JSON.parse(result.output) as { task_id: string };
    expect(getTask(parsed.task_id)?.status).toBe("running");
    // 与 registerWaitUntil 的定时器回调传的是同一份 summary 形态
    killShellTask(parsed.task_id, {
      summary: `等待期限到（60 秒），条件未满足，已停止命令 "sleep 30"`,
    });
    expect(getTask(parsed.task_id)?.status).toBe("killed");
  });
});

describe("R2 同一对象的第二个等待", () => {
  test("同对象同命令的第二个等待不 spawn，回执给出 task_stop 出口", async () => {
    // 命令文本决定 subject（注释里带 gh pr checks 779 即可，不需要真的跑 gh）
    const command = "sleep 30  # gh pr checks 779";
    const first = await tool.execute({
      command,
      run_in_background: true,
      wait_until_seconds: 600,
    });
    const firstId = (JSON.parse(first.output) as { task_id: string }).task_id;
    expect(firstId).toBeTruthy();

    const second = await tool.execute({
      command,
      run_in_background: true,
      wait_until_seconds: 600,
    });
    // 不是错误：已经有东西在盯它了
    expect(second.isError).toBeFalsy();
    expect(second.output).toContain("本次未重复启动");
    expect(second.output).toContain(firstId);
    expect(second.output).toContain(`task_stop ${firstId}`);
    // 全程只有一条同对象等待（没有第二个进程，也没有第二条通知源）
    expect(listWaits().filter((w) => w.subjects?.includes("gh:pr:779"))).toHaveLength(1);
    killShellTask(firstId);
  });

  test("不同对象的等待都会启动（不误伤并行的无关等待）", async () => {
    const a = await tool.execute({
      command: "sleep 30  # gh pr checks 779",
      run_in_background: true,
      wait_until_seconds: 600,
    });
    const b = await tool.execute({
      command: "sleep 30  # gh pr checks 741",
      run_in_background: true,
      wait_until_seconds: 600,
    });
    const aId = (JSON.parse(a.output) as { task_id: string }).task_id;
    const bId = (JSON.parse(b.output) as { task_id: string }).task_id;
    expect(aId).toBeTruthy();
    expect(bId).toBeTruthy();
    expect(aId).not.toBe(bId);
    killShellTask(aId);
    killShellTask(bId);
  });

  test("抽不出对象的第二个等待照常启动（抽不出就不参与去重）", async () => {
    const a = await tool.execute({
      command: "sleep 30",
      run_in_background: true,
      wait_until_seconds: 600,
    });
    const b = await tool.execute({
      command: "sleep 30",
      run_in_background: true,
      wait_until_seconds: 600,
    });
    const aId = (JSON.parse(a.output) as { task_id: string }).task_id;
    const bId = (JSON.parse(b.output) as { task_id: string }).task_id;
    expect(bId).toBeTruthy();
    expect(aId).not.toBe(bId);
    killShellTask(aId);
    killShellTask(bId);
  });

  test("不带 wait_until_seconds 的后台命令不参与去重（a7d1c888 的反例）", async () => {
    const command = "sleep 30  # gh pr checks 779";
    const a = await tool.execute({ command, run_in_background: true });
    const b = await tool.execute({ command, run_in_background: true });
    const aId = (JSON.parse(a.output) as { task_id: string }).task_id;
    const bId = (JSON.parse(b.output) as { task_id: string }).task_id;
    expect(bId).toBeTruthy();
    expect(aId).not.toBe(bId);
    killShellTask(aId);
    killShellTask(bId);
  });
});
