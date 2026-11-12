/**
 * M1：monitor 工具（`packages/core/src/tool/monitor.ts`）——PR 3 验收
 *
 * 覆盖方案 §9.2 中**工具层可独立验证**的部分：参数校验与钳制、并发上限、
 * 立即返回的收尾指令、等待登记表接入、子代理不可见（T-M1-1/2/3/18）。
 *
 * 真实子进程的事件行为在 `tests/task/monitor-task.test.ts` 里测（那一层更贴近
 * 进程模型），这里不与它重复——两层各测各的边界，失败时能直接定位到是哪一层。
 *
 * 落盘隔离：execute → spawnMonitorTask → initTaskOutput 会写 `~/.sid-code/tasks/`，
 * 按 CONTRIBUTING「测试约定」把 SID_CONFIG_DIR 指向 tmpdir（存/恢复原值）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { MonitorTool } from "../../src/tool/monitor.ts";
import {
  MAX_CONCURRENT_MONITORS,
  MAX_MONITOR_TIMEOUT_MS,
  __clearActiveMonitorsForTest,
} from "../../src/task/monitor-task.ts";
import { clearAllTasks, registerTask } from "../../src/task/registry.ts";
import { dequeuePendingNotifications } from "../../src/task/notification.ts";
import {
  __resetWaitRegistryForTest,
  listWaits,
  setWakeupRegistrationEnabled,
} from "../../src/task/wait-registry.ts";
import { filterToolsForAgent } from "../../src/agent/tool-filter.ts";
import { toLegacyTool } from "../../src/tool/bridge.ts";
import type { LocalMonitorTaskState } from "../../src/task/types.ts";

let originalConfigDir: string | undefined;
let tmpHome = "";
const tool = new MonitorTool();

beforeEach(() => {
  originalConfigDir = process.env.SID_CONFIG_DIR;
  tmpHome = mkdtempSync(join(tmpdir(), "sid-monitor-tool-"));
  process.env.SID_CONFIG_DIR = tmpHome;
  __resetWaitRegistryForTest();
  dequeuePendingNotifications();
});

afterEach(() => {
  __clearActiveMonitorsForTest();
  clearAllTasks();
  dequeuePendingNotifications();
  __resetWaitRegistryForTest();
  if (originalConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = originalConfigDir;
  rmSync(tmpHome, { recursive: true, force: true });
});

/** 造一个已在 registry 里的 monitor 任务（不 spawn 真实进程，用于并发上限） */
function fakeMonitor(id: string): LocalMonitorTaskState {
  const task: LocalMonitorTaskState = {
    id,
    type: "local_monitor",
    status: "running",
    description: `监控 ${id}`,
    startTime: Date.now(),
    outputFile: "",
    outputOffset: 0,
    notified: false,
    command: "true",
    deadlineAt: Date.now() + 60_000,
    eventCount: 0,
    outputLines: 0,
    isBackgrounded: true,
  };
  registerTask(task);
  return task;
}

describe("MonitorTool 参数校验（T-M1-2）", () => {
  test("缺 description / 超长 / 缺 command 都被拒", async () => {
    expect((await tool.call({ command: "true" })).isError).toBe(true);
    expect((await tool.call({ description: "x".repeat(81), command: "true" })).isError).toBe(true);
    expect((await tool.call({ description: "ok" })).isError).toBe(true);
    expect((await tool.call({ description: "ok", command: "  " })).isError).toBe(true);
  });

  test("timeout_ms 为 0 / 负数 / 非数字被拒（不 spawn）", async () => {
    for (const bad of [0, -1, Number.NaN, "5000" as unknown as number]) {
      const r = await tool.call({ description: "x", command: "true", timeout_ms: bad });
      expect(r.isError).toBe(true);
    }
    expect(clearAllTasks).toBeDefined();
  });

  test("timeout_ms 超过上限被钳制，并在结果里写明（T-M1-2）", async () => {
    const r = await tool.call({
      description: "超长期限",
      command: "sleep 5",
      timeout_ms: MAX_MONITOR_TIMEOUT_MS * 2,
    });
    expect(r.isError).toBeFalsy();
    expect(r.data).toContain("钳制到上限");
    expect(r.data).toContain(`${MAX_MONITOR_TIMEOUT_MS}ms`);
  });
});

describe("MonitorTool 启动返回（T-M1-1）", () => {
  test("立即返回 id / 期限 / 两句收尾指令，且登记为等待源", async () => {
    const r = await tool.call({
      description: "PR #662 CI",
      command: "echo ready",
      timeout_ms: 60_000,
    });
    expect(r.isError).toBeFalsy();
    // id：m 前缀 + 8 位
    const id = /已启动监控 (m[a-z0-9]{8})/.exec(r.data)?.[1];
    expect(id).toBeTruthy();
    // 期限（30 分钟 → 60s 的用例里显示「1 分钟期限」）
    expect(r.data).toContain("分钟期限");
    // 两句收尾指令（9e3a681d 的 thinking 证明模型需要被告知「会有通知」）
    expect(r.data).toContain("不需要查询状态");
    expect(r.data).toContain("结束本轮");
    // 登记表含该源（kind=monitor + deadline 承诺）
    const wait = listWaits().find((w) => w.id === id);
    expect(wait?.kind).toBe("monitor");
    expect(wait?.promise.kind).toBe("deadline");
  });

  // 契约变更（R2）：改动前第二个同对象 monitor 照常启动、只在回执里加一行提示，
  // 于是「为了保险再挂一个」的两路事件都分别叫醒主循环。现在同一个对象只允许一个
  // 有效等待——第二个不 spawn，回执给出停旧任务的出口。
  test("同 subject 第二个 monitor 不再启动，回执点明已有等待（T-M1-15 / R2）", async () => {
    const first = await tool.call({
      description: "首个",
      command: "gh pr checks 662",
      timeout_ms: 60_000,
    });
    expect(first.isError).toBeFalsy();
    const firstId = /已启动监控 (m[a-z0-9]{8})/.exec(first.data)?.[1];
    expect(firstId).toBeTruthy();

    const second = await tool.call({
      description: "第二个",
      command: "gh pr checks 662",
      timeout_ms: 60_000,
    });
    expect(second.isError).toBeFalsy();
    expect(second.data).toContain("本次未重复启动");
    expect(second.data).toContain(firstId!);
    expect(second.data).toContain(`task_stop ${firstId}`);
    // 只有一个 monitor 在跑：没有第二个进程，也没有第二条通知源
    expect(listWaits().filter((w) => w.kind === "monitor")).toHaveLength(1);
  });
});

describe("MonitorTool 并发上限（T-M1-3）", () => {
  test(`第 ${MAX_CONCURRENT_MONITORS + 1} 个返回错误并列出现有监控`, async () => {
    const ids = Array.from({ length: MAX_CONCURRENT_MONITORS }, (_, i) => `m0000000${i}`);
    for (const id of ids) fakeMonitor(id);
    const r = await tool.call({ description: "第五个", command: "true" });
    expect(r.isError).toBe(true);
    expect(r.data).toContain(`上限 ${MAX_CONCURRENT_MONITORS} 个`);
    // 列出现有 4 个，模型才知道该 task_stop 谁
    for (const id of ids) expect(r.data).toContain(id);
  });
});

describe("子代理工具过滤（T-M1-18）", () => {
  test("任何内置子代理类型都拿不到 monitor", () => {
    const all = [toLegacyTool(tool)] as unknown as Parameters<typeof filterToolsForAgent>[0];
    for (const builtInType of ["explore", "task", "plan", "verify", "general-purpose"]) {
      const kept = filterToolsForAgent(all, { isBuiltIn: true, builtInType });
      expect(kept.map((t) => t.name())).not.toContain("monitor");
    }
  });
});

describe("D19：无头形态提示「监控结束前不会退出」", () => {
  // 判据复用唤醒登记的同一个事实：有没有 prompt 注入通道。`-p` 单轮没有通道，
  // 进程只能等到 monitor 结束再退出（方案 §10.3）；交互式 / stream-json 有通道，
  // 事件能在回合边界叫醒主循环，不需要这句话。
  test("没有注入通道 → 结果含该句；有注入通道 → 不含", async () => {
    setWakeupRegistrationEnabled(false);
    const headless = await tool.call({
      description: "无头形态",
      command: "echo ready",
      timeout_ms: 60_000,
    });
    expect(headless.isError).toBeFalsy();
    expect(headless.data).toContain("当前宿主在监控结束前不会退出");

    setWakeupRegistrationEnabled(true);
    const interactive = await tool.call({
      description: "交互形态",
      command: "echo ready",
      timeout_ms: 60_000,
    });
    expect(interactive.isError).toBeFalsy();
    expect(interactive.data).not.toContain("当前宿主在监控结束前不会退出");
  });
});
