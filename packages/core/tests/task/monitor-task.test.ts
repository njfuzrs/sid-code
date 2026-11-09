/**
 * M1：monitor 任务（按行事件 + 硬期限 + 限流）——PR 3 验收
 *
 * 覆盖方案 §9.2 的 T-M1-* 中**可在任务层直接验证**的部分。用真实子进程
 * （printf / sleep / exit），不 mock spawn——切行、批处理、残行这些行为
 * mock 掉就没有被验证的余地了。
 *
 * 落盘隔离：spawnMonitorTask 会 initTaskOutput 写 `~/.sid-code/tasks/`，
 * 按 CONTRIBUTING「测试约定」把 SID_CONFIG_DIR 指向 tmpdir（存/恢复原值，
 * 不要无条件 delete——会抹掉 bunfig preload 的兜底）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  BURST_LINE_LIMIT,
  LineSplitter,
  MAX_EVENT_LINE_CHARS,
  MAX_FINAL_FLUSH_LINES,
  MonitorRateGate,
  PER_MINUTE_NOTIFY_LIMIT,
  TOTAL_NOTIFY_LIMIT,
  __clearActiveMonitorsForTest,
  killMonitorTask,
  spawnMonitorTask,
  truncateEventLine,
} from "../../src/task/monitor-task.ts";
import type { MonitorGateLimits } from "../../src/task/monitor-task.ts";
import { clearAllTasks, getTask } from "../../src/task/registry.ts";
import { dequeuePendingNotifications } from "../../src/task/notification.ts";
import type { LocalMonitorTaskState } from "../../src/task/types.ts";

let originalConfigDir: string | undefined;
let tmpHome = "";

beforeEach(() => {
  originalConfigDir = process.env.SID_CONFIG_DIR;
  tmpHome = mkdtempSync(join(tmpdir(), "sid-monitor-task-"));
  process.env.SID_CONFIG_DIR = tmpHome;
  dequeuePendingNotifications(); // 清掉前面用例的残留通知
});

afterEach(() => {
  __clearActiveMonitorsForTest();
  clearAllTasks();
  dequeuePendingNotifications();
  if (originalConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = originalConfigDir;
  rmSync(tmpHome, { recursive: true, force: true });
});

/** 轮询等待条件成立（bun 默认 5s 单测超时，这里留足余量但不等满） */
async function waitFor<T>(fn: () => T | undefined, timeoutMs = 3_000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = fn();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`waitFor 超时（${timeoutMs}ms）`);
}

/** 取走当前所有通知的结构化快照 */
function takeNotifications() {
  return dequeuePendingNotifications().map((n) => n.structured!);
}

function spawn(opts: {
  command: string;
  timeoutMs?: number;
  description?: string;
  gateLimits?: MonitorGateLimits;
}): LocalMonitorTaskState {
  return spawnMonitorTask({
    description: opts.description ?? "测试监控",
    command: opts.command,
    timeoutMs: opts.timeoutMs ?? 10_000,
    cwd: tmpHome,
    __gateLimitsForTest: opts.gateLimits,
  });
}

describe("LineSplitter / truncateEventLine（纯逻辑）", () => {
  test("跨 chunk 的行被正确拼接（不把一行劈成两条）", () => {
    const s = new LineSplitter();
    expect(s.push("hel")).toEqual([]);
    expect(s.push("lo\nwor")).toEqual(["hello"]);
    expect(s.push("ld\n")).toEqual(["world"]);
    expect(s.pendingLength).toBe(0);
  });

  test("残行在 flush 时作为最后一个事件冲出（T-M1-9 的纯逻辑面）", () => {
    const s = new LineSplitter();
    expect(s.push("abc")).toEqual([]);
    expect(s.flush()).toBe("abc");
    expect(s.flush()).toBeNull();
  });

  test("CRLF 去掉 \\r；超长行截断到上限 + …[截断]（T-M1-8）", () => {
    expect(truncateEventLine("ok\r")).toBe("ok");
    const long = "字".repeat(MAX_EVENT_LINE_CHARS + 10);
    const out = truncateEventLine(long);
    expect(out.endsWith("…[截断]")).toBe(true);
    expect(Array.from(out.replace("…[截断]", "")).length).toBe(MAX_EVENT_LINE_CHARS);
  });
});

describe("MonitorRateGate（限流纯逻辑）", () => {
  test("突发阀按原始行计：10 秒内超过 40 行触发（T-M1-11 的判据）", () => {
    const gate = new MonitorRateGate();
    const now = 1_000_000;
    for (let i = 0; i < BURST_LINE_LIMIT; i++) expect(gate.recordLine(now)).toBe(false);
    expect(gate.recordLine(now)).toBe(true);
    // 窗口外的行不再计入
    expect(gate.recordLine(now + 11_000)).toBe(false);
  });

  test("持续阀：每分钟超过 6 条通知后合并进下一条，行不丢（T-M1-21）", () => {
    const gate = new MonitorRateGate();
    const t0 = 1_000_000;
    for (let i = 0; i < PER_MINUTE_NOTIFY_LIMIT; i++) {
      expect(gate.admit([`e${i}`], t0 + i).action).toBe("emit");
    }
    // 第 7 批被暂存
    expect(gate.admit(["e6"], t0 + 10).action).toBe("defer");
    expect(gate.admit(["e7"], t0 + 11).action).toBe("defer");
    // 下一个窗口：暂存行合并进第一条通知
    const decided = gate.admit(["e8"], t0 + 61_000);
    expect(decided.action).toBe("emit");
    expect(decided.event).toContain("e6");
    expect(decided.event).toContain("e7");
    expect(decided.event).toContain("e8");
    expect(decided.event).toContain("…另有 2 条");
  });

  test("总量阀：累计超过上限后返回 stop（T-M1 总量）", () => {
    const gate = new MonitorRateGate();
    let now = 1_000_000;
    for (let i = 0; i < TOTAL_NOTIFY_LIMIT; i++) {
      if (i > 0 && i % PER_MINUTE_NOTIFY_LIMIT === 0) now += 61_000; // 跨窗口
      expect(gate.admit([`e${i}`], now).action).toBe("emit");
    }
    const decided = gate.admit(["overflow"], now + 61_000);
    expect(decided.action).toBe("stop");
    expect(decided.reason).toBe("rate_total");
  });

  test("drainAll：暂存行与本批行合成一条，不受持续阀限制（D2）", () => {
    const gate = new MonitorRateGate({ perMinuteNotifyLimit: 1 });
    const t0 = 1_000_000;
    expect(gate.admit(["a"], t0).action).toBe("emit");
    expect(gate.admit(["b"], t0 + 1).action).toBe("defer");
    // 退出冲刷不走 admit：deferred 与本批按输出顺序拼成一条事件
    expect(gate.drainAll(["c"])).toBe("b\nc");
    expect(gate.drainAll([])).toBeNull();
  });

  test("drainAll：总量阀已满时仍送出剩余行（D2）", () => {
    const gate = new MonitorRateGate({ totalNotifyLimit: 1 });
    const t0 = 1_000_000;
    expect(gate.admit(["a"], t0).action).toBe("emit");
    expect(gate.admit(["b"], t0 + 1).action).toBe("stop");
    expect(gate.drainAll(["b"])).toBe("b");
  });

  test(`drainAll：超过 ${MAX_FINAL_FLUSH_LINES} 行时保尾不保头并注明省略行数`, () => {
    const gate = new MonitorRateGate();
    const lines = Array.from({ length: MAX_FINAL_FLUSH_LINES + 5 }, (_, i) => `l${i}`);
    const event = gate.drainAll(lines)!;
    const parts = event.split("\n");
    expect(parts[0]).toContain("前 5 行已省略");
    expect(parts[0]).toContain(".output");
    expect(parts).toHaveLength(MAX_FINAL_FLUSH_LINES + 1);
    expect(parts).toContain(`l${MAX_FINAL_FLUSH_LINES + 4}`); // 汇总行（最后一行）在
    expect(parts).not.toContain("l0");
  });
});

describe("spawnMonitorTask（真实子进程）", () => {
  test("退出码 0 且无输出 → completed「共 0 条事件」（T-M1-5）", async () => {
    const task = spawn({ command: "true" });
    const notif = await waitFor(() => takeNotifications().find((n) => n.status === "completed"));
    expect(notif.summary).toContain("共 0 条事件");
    expect(notif.summary).toContain("退出码 0");
    expect(getTask(task.id)?.status).toBe("completed");
  });

  test("退出码 3 + stderr → failed 含退出码与 stderr 末尾（T-M1-4）", async () => {
    const task = spawn({ command: 'echo "boom: gh 未登录" >&2; exit 3' });
    const notif = await waitFor(() => takeNotifications().find((n) => n.status === "failed"));
    expect(notif.summary).toContain("退出码 3");
    expect(notif.summary).toContain("gh 未登录");
    expect(getTask(task.id)?.status).toBe("failed");
  });

  test("无换行残行在退出时成为最后一个事件（T-M1-9）", async () => {
    spawn({ command: "printf abc" });
    const event = await waitFor(() => takeNotifications().find((n) => n.event !== undefined));
    expect(event.event).toBe("abc");
  });

  test("200ms 窗口内的 3 行合成 1 条通知（T-M1-20）", async () => {
    spawn({ command: "echo a; echo b; echo c; sleep 0.3" });
    const first = await waitFor(() => takeNotifications().find((n) => n.event !== undefined));
    expect(first.event!.split("\n").sort()).toEqual(["a", "b", "c"]);
    expect(first.summary).toBe("监控事件：测试监控");
    expect(first.description).toBe("测试监控");
  });

  test("退出时持续阀已满：最后一批行（含 ALL_DONE 汇总）仍以事件送达（D2 / R2）", async () => {
    // 7 行 pass 每 0.3s 一条正好用满每分钟 6 条通知的持续阀，check8 / ALL_DONE
    // 在退出前瞬间输出——修复前它们被 admit 判成 defer 后随 ctl 一起丢掉。
    const task = spawn({
      command: `for i in 1 2 3 4 5 6 7; do echo "check$i: pass"; sleep 0.3; done; echo "check8: fail"; echo "ALL_DONE: fail"; exit 1`,
      timeoutMs: 20_000,
    });
    // 轮询任务状态而不是取通知：takeNotifications 会把事件先取走，看不到「终态前的最后一批」
    await waitFor(() => {
      const status = getTask(task.id)?.status;
      return status && status !== "running" ? status : undefined;
    }, 15_000);

    const notifs = takeNotifications();
    const events = notifs.filter((n) => n.event !== undefined).map((n) => n.event!);
    const text = events.join("\n");
    expect(text).toContain("check8: fail");
    expect(text).toContain("ALL_DONE: fail");
    // 6 条正常通知 + 1 条退出冲刷：退出路径不额外叫醒一轮
    expect(events.length).toBeLessThanOrEqual(PER_MINUTE_NOTIFY_LIMIT + 1);
    expect(notifs.find((n) => n.status !== "running")?.status).toBe("failed");
  }, 20_000);

  test("退出时总量阀已满：剩余行仍以事件送达（D2）", async () => {
    const task = spawn({
      command: `echo a; sleep 1; echo LAST; exit 0`,
      timeoutMs: 20_000,
      gateLimits: { totalNotifyLimit: 1 },
    });
    await waitFor(() => {
      const status = getTask(task.id)?.status;
      return status && status !== "running" ? status : undefined;
    }, 10_000);

    const notifs = takeNotifications();
    const events = notifs.filter((n) => n.event !== undefined).map((n) => n.event!);
    // 修复前 close 回调仍走 admit：累计通知数已达上限 → stop → LAST 被丢
    expect(events.join("\n")).toContain("LAST");
    expect(notifs.find((n) => n.status !== "running")?.status).toBe("completed");
  }, 15_000);

  test(`10 秒内 ${BURST_LINE_LIMIT + 1} 行 → 停止并通知「事件过密」（T-M1-11）`, async () => {
    spawn({
      command: `i=0; while [ $i -lt ${BURST_LINE_LIMIT + 1} ]; do echo x; i=$((i+1)); done; sleep 5`,
    });
    const notif = await waitFor(() => takeNotifications().find((n) => n.status === "killed"));
    expect(notif.summary).toContain("事件过密");
    expect(notif.summary).toContain("收窄过滤条件");
  });

  test("期限到 → killed，summary 含「0 条事件」与「过滤条件」（T-M1-6）", async () => {
    spawn({ command: "while true; do sleep 0.2; done", timeoutMs: 400 });
    const notif = await waitFor(() => takeNotifications().find((n) => n.status === "killed"));
    expect(notif.summary).toContain("监控到期");
    expect(notif.summary).toContain("0 条事件");
    expect(notif.summary).toContain("过滤条件");
  });

  test("killMonitorTask 之后进程退出不再发第二条终态（T-M1-16）", async () => {
    const task = spawn({ command: "sleep 2" });
    killMonitorTask(task.id);
    const first = await waitFor(() => takeNotifications().find((n) => n.status === "killed"));
    expect(first.summary).toContain("task_stop");
    // 等过一个「exit 事件本该到达」的窗口，确认没有第二条终态
    await new Promise((r) => setTimeout(r, 300));
    const terminal = takeNotifications().filter((n) => n.status !== "running");
    expect(terminal).toHaveLength(0);
  });

  test("孙进程随进程组一起被清理（T-M1-7）", async () => {
    // 孙进程 pid 打到 stdout，kill 之后用 ps 确认它不在了
    spawn({ command: 'sleep 60 & echo "child=$!"; sleep 60' });
    const event = await waitFor(() => takeNotifications().find((n) => n.event !== undefined));
    const childPid = Number(/child=(\d+)/.exec(event.event!)?.[1]);
    expect(Number.isInteger(childPid)).toBe(true);

    const taskIds = [...Array(1)].map(() => getTask);
    void taskIds;
    // 从 registry 找到这条 monitor 并 kill
    const monitor = (await import("../../src/task/registry.ts"))
      .getRunningTasks()
      .find((t) => t.type === "local_monitor");
    expect(monitor).toBeDefined();
    killMonitorTask(monitor!.id);

    await new Promise((r) => setTimeout(r, 200));
    const alive = (() => {
      try {
        process.kill(childPid, 0);
        return true;
      } catch {
        return false;
      }
    })();
    expect(alive).toBe(false);
  });

  test("非 UTF-8 字节与超长行：不抛错，事件截断，.output 是完整内容（T-M1-8）", async () => {
    const task = spawn({
      command: `printf '\\xff\\xfe'; printf '%0.sx' $(seq 1 3000); echo; sleep 0.2`,
    });
    const event = await waitFor(() => takeNotifications().find((n) => n.event !== undefined));
    expect(event.event!.endsWith("…[截断]")).toBe(true);
    // .output 落的是解码后的完整原文（3000+ 个 x，未被事件截断影响）
    const out = await waitFor(() => (getTask(task.id) ? "ok" : undefined));
    expect(out).toBe("ok");
    const outputFile = (getTask(task.id) as LocalMonitorTaskState).outputFile;
    // 落盘是异步队列，轮询等它写出来
    const content = await waitFor(() => {
      if (!existsSync(outputFile)) return undefined;
      const text = readFileSync(outputFile, "utf8");
      return text.includes("x".repeat(3000)) ? text : undefined;
    });
    expect(content.length).toBeGreaterThan(3000);
  });
});
