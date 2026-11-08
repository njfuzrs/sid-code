/**
 * 定时唤醒进后台任务面板 —— 数据源合并（§5.7.3 / §9.2.1 T-T1-1/3/4）。
 *
 * 唤醒**不在** task registry：它是调度器里的一条 `CronTask`（没有进程、没有 outputFile）。
 * 所以面板数据源必须自己合并两路：`getPanelVisibleTasks()` + `listSessionWakeups()`。
 *
 * 这里锁四件事：
 * 1. `schedule_wakeup` 的会话任务 → 面板出一行 `kind: "wakeup"`；
 * 2. `/loop` / `cron_create` 的任务**不进**面板（它们有各自的出口）；
 * 3. 唤醒被替换：旧行消失、新行出现，同一时刻只有一行；
 * 4. 唤醒被删 / 到点注入：行即刻消失——**不走 30s 驱逐**（它压根不在 registry 里，
 *    没有终态行这回事）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getScheduler, resetScheduler } from "@sid-code/core/cron/scheduler.ts";
import type { CronTask } from "@sid-code/core/cron/types.ts";
import { StateBridge } from "@sid-code/cli/ui/state-bridge.ts";

let dir: string;
const prevConfigDir = process.env.SID_CONFIG_DIR;

function mkWakeup(over: Partial<CronTask> = {}): CronTask {
  return {
    id: "w1",
    cron: "",
    prompt: "检查 PR #662 的 CI 状态\n第二行不该进面板",
    createdAt: Date.now(),
    recurring: false,
    durable: false,
    fireAt: Date.now() + 8 * 60_000,
    origin: "schedule_wakeup",
    ...over,
  };
}

function mkBridge(): StateBridge {
  return new StateBridge({
    messages: [],
    displayItems: [],
    historyItems: [],
    tasks: [],
  } as any);
}

beforeEach(() => {
  // 调度器会碰 durable 路径（workspaceDir / 日志），隔离到 tmpdir。
  // 存/恢复原值而不 delete——同批多文件跑在同一进程里，delete 会把 preload 的兜底一起抹掉。
  dir = mkdtempSync(join(tmpdir(), "sid-wakeup-panel-"));
  process.env.SID_CONFIG_DIR = dir;
  resetScheduler();
  getScheduler({
    onFire: () => {},
    isLoading: () => false,
    sessionId: "test-session",
    workspaceDir: dir,
  });
});

afterEach(() => {
  resetScheduler();
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  rmSync(dir, { recursive: true, force: true });
});

describe("state-bridge — 唤醒进面板（T-T1-1）", () => {
  test("schedule_wakeup 的会话任务合成一行 WK，描述取 prompt 首行", () => {
    getScheduler().addSessionTask(mkWakeup());
    const bridge = mkBridge();
    bridge.updateTasks();

    const rows = bridge.current.tasks;
    expect(rows.length).toBe(1);
    expect(rows[0]!.kind).toBe("wakeup");
    expect(rows[0]!.status).toBe("waiting"); // 不是 running：它在等，没在跑
    expect(rows[0]!.description).toBe("检查 PR #662 的 CI 状态");
    expect(typeof rows[0]!.dueAt).toBe("number");
    bridge.detach();
  });

  test("/loop 与 cron_create 的任务不进面板（只有 schedule_wakeup 进）", () => {
    const scheduler = getScheduler();
    scheduler.addSessionTask(mkWakeup({ id: "loop1", origin: "loop", recurring: true }));
    scheduler.addSessionTask(mkWakeup({ id: "cron1", origin: "cron_create" }));
    scheduler.addSessionTask(mkWakeup());

    const bridge = mkBridge();
    bridge.updateTasks();
    const ids = bridge.current.tasks.map((t) => t.id);
    expect(ids).toEqual(["w1"]);
    bridge.detach();
  });

  test("没有唤醒时不产生任何行（不引入空壳行）", () => {
    const bridge = mkBridge();
    bridge.updateTasks();
    expect(bridge.current.tasks).toEqual([]);
    bridge.detach();
  });

  test("调度器未初始化时也不炸（peekScheduler 不创建兜底实例）", () => {
    resetScheduler();
    const bridge = mkBridge();
    bridge.updateTasks();
    expect(bridge.current.tasks).toEqual([]);
    // 关键：peekScheduler 不该留下一个兜底实例（getScheduler 无参调用会造）
    expect(getScheduler()).not.toBeNull();
    bridge.detach();
  });
});

describe("state-bridge — 唤醒行的生命周期（T-T1-3 / T-T1-4）", () => {
  test("T-T1-3 替换：旧行消失、新行出现，同一时刻只有一行 WK", () => {
    const scheduler = getScheduler();
    const bridge = mkBridge();

    scheduler.addSessionTask(mkWakeup({ id: "old", prompt: "旧唤醒" }));
    bridge.updateTasks();
    expect(bridge.current.tasks.map((t) => t.id)).toEqual(["old"]);

    // 生产路径是 replaceSessionTasksByOrigin（单链语义，见 #642 F1）
    scheduler.replaceSessionTasksByOrigin(mkWakeup({ id: "new", prompt: "新唤醒" }));
    bridge.updateTasks();
    const rows = bridge.current.tasks;
    expect(rows.map((t) => t.id)).toEqual(["new"]);
    expect(rows[0]!.description).toBe("新唤醒");
    bridge.detach();
  });

  test("T-T1-4 cron_delete / W3 作废：WK 行即刻消失（不等 30s 驱逐）", () => {
    const scheduler = getScheduler();
    const bridge = mkBridge();

    scheduler.addSessionTask(mkWakeup({ id: "w1" }));
    bridge.updateTasks();
    expect(bridge.current.tasks.length).toBe(1);

    // removeTask 是 cron_delete 与 invalidateWakeups 的共同出口。
    // **不手动 updateTasks**：面板刷新必须由调度器自己播报（MUT-14 的变异点就在这——
    // 删掉 removeTask 里那行 notifyTaskChanged，此处会红）。
    scheduler.removeTask("w1");
    expect(bridge.current.tasks).toEqual([]);
    bridge.detach();
  });

  test("T-T1-4 到点注入：行即刻消失，不留终态行", () => {
    const scheduler = getScheduler();
    const bridge = mkBridge();

    // fireAt 在过去 → check() 会立刻触发并在一轮后从 sessionTasks 删掉（keep=false）
    scheduler.addSessionTask(mkWakeup({ id: "due", fireAt: Date.now() - 1_000 }));
    bridge.updateTasks();
    expect(bridge.current.tasks.length).toBe(1);

    // 同上：不手动 updateTasks，靠 fireOnce 里的 notifyTaskChanged。
    // 唤醒来的是「注入即移除」，不留 30s 终态行——消息流那一刻已出「定时唤醒 · …」。
    (scheduler as any).check();
    expect(bridge.current.tasks).toEqual([]);
    bridge.detach();
  });
});

describe("state-bridge — 调度器变更主动播报（不靠轮询）", () => {
  test("addSessionTask 后无需手动 updateTasks，面板已刷新", () => {
    const bridge = mkBridge();
    bridge.updateTasks();
    expect(bridge.current.tasks).toEqual([]);

    // 不调 bridge.updateTasks：靠 scheduler → notifyTaskChanged → onTaskChanged 这条链
    getScheduler().addSessionTask(mkWakeup({ id: "pushed" }));
    expect(bridge.current.tasks.map((t) => t.id)).toEqual(["pushed"]);
    bridge.detach();
  });

  test("removeTask 后同样自动刷新（作废系统行之外，面板行也得走）", () => {
    const scheduler = getScheduler();
    scheduler.addSessionTask(mkWakeup({ id: "pushed" }));
    const bridge = mkBridge();
    bridge.updateTasks();
    expect(bridge.current.tasks.length).toBe(1);

    scheduler.removeTask("pushed");
    expect(bridge.current.tasks).toEqual([]);
    bridge.detach();
  });
});
