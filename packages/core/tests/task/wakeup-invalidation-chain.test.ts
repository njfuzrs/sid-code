/**
 * D8 / S2：monitor **成功终态的通知送达**时，按被等对象撤销唤醒。
 *
 * 缺陷来源：docs-research/sid-code/bugfixes/todo/20261109-等待态四PR合入后review缺陷-修复与验收方案.md
 * §3.2 D8——`invalidateWakeups("subject_terminal", …)` 在生产代码里零调用方，
 * S2 只有测试直调，真实路径上永不发生：模型用 monitor 盯 PR、又排了唤醒兜底，
 * monitor 正常结束、通知已送达，唤醒照样到点把模型叫醒去查一个早已合入的 PR。
 *
 * 本文件从**真实入口**进（方案 §5.1 的落点纪律）：
 *   - `new MonitorTool().call(...)` 起真实子进程（替身脚本）；
 *   - `new ScheduleWakeupTool().execute(...)` 排真实会话级唤醒；
 *   - `injectPendingNotifications(...)` 是通知真正进模型上下文的唯一汇合点
 *     （与 queryLoop / resumeWithNotifications 共用），S2 的「通知已投递」在这里兑现。
 * 不直调 `invalidateWakeupsForDeliveredTask`——那是内部函数。
 *
 * 落盘隔离：monitor spawn / 调度器可能写 `~/.sid-code/`，按测试约定把 SID_CONFIG_DIR
 * 重定向到 tmpdir（存/恢复原值，不无条件 delete）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { MonitorTool } from "../../src/tool/monitor.ts";
import { TaskStopTool } from "../../src/tool/task-stop.ts";
import { ScheduleWakeupTool } from "../../src/tool/schedule-wakeup.ts";
import { __clearActiveMonitorsForTest } from "../../src/task/monitor-task.ts";
import { clearAllTasks, getTask } from "../../src/task/registry.ts";
import {
  dequeuePendingNotifications,
  hasPendingNotifications,
} from "../../src/task/notification.ts";
import {
  __resetWaitRegistryForTest,
  drainWaitNotices,
  isWaitInvalidated,
  listWaits,
  setWakeupRegistrationEnabled,
} from "../../src/task/wait-registry.ts";
import { getScheduler, resetScheduler } from "../../src/cron/scheduler.ts";
import {
  SCHEDULED_INVALIDATED_EVENT_NAME,
  setScheduledTraceSink,
} from "../../src/cron/cron-telemetry.ts";
import { injectPendingNotifications } from "../../src/query/loop.ts";
import { Manager as ContextManager } from "../../src/context/manager.ts";
import { isTerminalStatus } from "../../src/task/types.ts";

let originalConfigDir: string | undefined;
let tmpHome = "";
let captured: Array<{ event: string; data: Record<string, unknown> }> = [];

beforeEach(() => {
  originalConfigDir = process.env.SID_CONFIG_DIR;
  tmpHome = mkdtempSync(join(tmpdir(), "sid-wakeup-chain-"));
  process.env.SID_CONFIG_DIR = tmpHome;
  __resetWaitRegistryForTest();
  setWakeupRegistrationEnabled(true);
  __clearActiveMonitorsForTest();
  clearAllTasks();
  dequeuePendingNotifications();
  resetScheduler();
  getScheduler({ onFire: () => {}, isLoading: () => false, sessionId: "t", workspaceDir: "/tmp" });
  captured = [];
  setScheduledTraceSink((event, data) => captured.push({ event, data }));
});

afterEach(() => {
  setScheduledTraceSink(null);
  __clearActiveMonitorsForTest();
  clearAllTasks();
  dequeuePendingNotifications();
  __resetWaitRegistryForTest();
  resetScheduler();
  if (originalConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = originalConfigDir;
  rmSync(tmpHome, { recursive: true, force: true });
});

/** 轮询等一个可观测事实（monitor 是真实子进程，退出时刻不确定） */
async function waitFor<T>(fn: () => T | undefined, timeoutMs = 5_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor 超时（${timeoutMs}ms）`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** 起一条真实 monitor，返回任务 id（命令文本决定 subjects） */
async function startMonitor(description: string, command: string): Promise<string> {
  const r = await new MonitorTool().call({ description, command, timeout_ms: 60_000 });
  const id = /已启动监控 (m[a-z0-9]{8})/.exec(r.data)?.[1];
  if (!id) throw new Error(`没拿到 monitor id：${r.data}`);
  return id;
}

/** 排一条真实会话级唤醒，返回任务 id */
async function armWakeup(prompt: string): Promise<string> {
  const r = await new ScheduleWakeupTool().execute({ delay_seconds: 1_500, prompt });
  if (r.isError) throw new Error(`schedule_wakeup 失败：${r.output}`);
  const task = getScheduler()
    .listTasks()
    .find((t) => t.origin === "schedule_wakeup" && t.prompt === prompt);
  if (!task) throw new Error("调度器里找不到刚排的唤醒");
  return task.id;
}

/** 等 monitor 进终态，并确保终态释放已发生（快照在这一步捕获） */
async function waitTerminal(taskId: string): Promise<void> {
  await waitFor(() => {
    const t = getTask(taskId);
    return t && isTerminalStatus(t.status) ? t : undefined;
  });
  // 终态释放（D4）走 onTaskChanged，正常已同步跑过；这里再查一次
  // 兜住「登记发生在终态之后」的极端时序（listWaits 里的终态补释放）。
  listWaits();
}

/** 通知送达模型（真实汇合点） */
function deliver(): number {
  return injectPendingNotifications(new ContextManager({ maxTokens: 200_000 }));
}

const wakeupAlive = (id: string) => getScheduler().getSessionTask(id) !== undefined;
const invalidatedEvents = () =>
  captured.filter((c) => c.event === SCHEDULED_INVALIDATED_EVENT_NAME);

describe("D8 / S2：monitor 成功终态通知送达 → 撤销同 subject 的唤醒", () => {
  test("R6 真实入口：替身脚本 exit 0、通知送达 → 唤醒撤销 + 一条提示 + ScheduledInvalidated", async () => {
    // 替身脚本：命令文本里含 `gh pr checks 662`（subjects 从这里抽），输出与退出码模拟成功终态
    const mon = await startMonitor("盯 PR #662 CI", 'echo "gh pr checks 662: pass"; exit 0');
    const wk = await armWakeup("检查 PR #662 的 CI 是否绿了，绿了就合并");

    await waitTerminal(mon);
    // 「通知已送达」之前不撤销：模型还没看到结果，撤掉兜底唤醒会让它既不知道结果、也不再被叫醒
    expect(wakeupAlive(wk)).toBe(true);
    expect(hasPendingNotifications()).toBe(true);

    expect(deliver()).toBeGreaterThan(0);

    expect(wakeupAlive(wk)).toBe(false);
    expect(isWaitInvalidated(wk)).toBe(true);
    expect(listWaits().some((w) => w.id === wk)).toBe(false);
    const notices = drainWaitNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]!.taskId).toBe(wk);
    expect(notices[0]!.promptPreview).toContain("检查 PR #662");
    expect(notices[0]!.reason).toContain(`监控 ${mon} 已完成`);
    // 轨迹事件也落了（wait-audit 的 zombie_wakeups 口径靠它）
    expect(invalidatedEvents()).toHaveLength(1);
    expect(invalidatedEvents()[0]!.data.task_id).toBe(wk);
  });

  test("反向：monitor 失败终态（exit 1）送达 → 不撤销", async () => {
    const mon = await startMonitor("盯 PR #663 CI", 'echo "gh pr checks 663: fail"; exit 1');
    const wk = await armWakeup("检查 PR #663 的 CI");

    await waitTerminal(mon);
    expect(deliver()).toBeGreaterThan(0);

    // failed 不是「对象已成功终态」
    expect(wakeupAlive(wk)).toBe(true);
    expect(drainWaitNotices()).toEqual([]);
    expect(invalidatedEvents()).toHaveLength(0);
  });

  test("反向：monitor 被 task_stop 停掉（killed）送达 → 不撤销", async () => {
    const mon = await startMonitor("盯 PR #664 CI", 'echo "gh pr checks 664: waiting"; sleep 30');
    const wk = await armWakeup("检查 PR #664 的 CI");

    // task_stop 是真实入口（不是直调 killMonitorTask）
    const stop = await new TaskStopTool().execute({ task_id: mon });
    expect(stop.isError).toBeFalsy();
    await waitTerminal(mon);
    expect(deliver()).toBeGreaterThan(0);

    expect(wakeupAlive(wk)).toBe(true);
    expect(drainWaitNotices()).toEqual([]);
  });

  test("反向：subject 不同（monitor 盯 #661，唤醒等 #662）送达 → 不撤销", async () => {
    const mon = await startMonitor("盯 PR #661 CI", 'echo "gh pr checks 661: pass"; exit 0');
    const wk = await armWakeup("检查 PR #662 的 CI");

    await waitTerminal(mon);
    expect(deliver()).toBeGreaterThan(0);

    expect(wakeupAlive(wk)).toBe(true);
    expect(drainWaitNotices()).toEqual([]);
  });

  test("反向：抽不到 subject 的唤醒（prompt 无已知实体）→ 不撤销", async () => {
    const mon = await startMonitor("盯 PR #665 CI", 'echo "gh pr checks 665: pass"; exit 0');
    const wk = await armWakeup("过一会儿看一眼状态");

    await waitTerminal(mon);
    expect(deliver()).toBeGreaterThan(0);

    // 抽不到 subject 时 S2 不生效、退回 S1（T-W3-10 的口径保留）
    expect(wakeupAlive(wk)).toBe(true);
    expect(drainWaitNotices()).toEqual([]);
  });

  test("反向：通知入队但未送达 → 不撤销", async () => {
    const mon = await startMonitor("盯 PR #666 CI", 'echo "gh pr checks 666: pass"; exit 0');
    const wk = await armWakeup("检查 PR #666 的 CI");

    await waitTerminal(mon);
    // 只入队、不调 injectPendingNotifications
    expect(hasPendingNotifications()).toBe(true);
    expect(wakeupAlive(wk)).toBe(true);
    expect(drainWaitNotices()).toEqual([]);
  });
});
