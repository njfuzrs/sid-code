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
  MAX_BURST_FLUSH_LINES,
  MAX_EVENT_LINE_CHARS,
  MAX_FINAL_FLUSH_LINES,
  MonitorRateGate,
  NOTIFY_WINDOW_MS,
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
import { TaskStopTool } from "../../src/tool/task-stop.ts";

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
    // D18：暂存行已全部在正文里，提示必须说「以上含…因限流延迟」而不是「另有」——
    // 后者会让模型以为还有 N 条没收到，于是继续等 / 再查一遍。
    expect(decided.event).toContain("以上含 2 行因限流延迟，非实时");
    expect(decided.event).not.toContain("另有");
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
  test("退出码 0 且无输出 → completed「共投递 0 条通知，输出共 0 行」（T-M1-5 / D18）", async () => {
    const task = spawn({ command: "true" });
    const notif = await waitFor(() => takeNotifications().find((n) => n.status === "completed"));
    // D18：两个数字各带单位——「条」是通知数（叫醒主循环几次），「行」是脚本输出行数
    expect(notif.summary).toContain("共投递 0 条通知，输出共 0 行");
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

  test("期限到 → killed，summary 含投递摘要与「过滤条件」（T-M1-6 / D18）", async () => {
    spawn({ command: "while true; do sleep 0.2; done", timeoutMs: 400 });
    const notif = await waitFor(() => takeNotifications().find((n) => n.status === "killed"));
    expect(notif.summary).toContain("监控到期");
    // D18：0 条是「通知」数，不是「行」数——措辞必须点明单位
    expect(notif.summary).toContain("共投递 0 条通知，输出共 0 行");
    expect(notif.summary).toContain("未投递任何通知");
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

/**
 * D15：父进程退出即终态。
 *
 * `close` 要等**所有** stdio 流关闭；孙进程继承了 stdout 写端时它永远不来，于是
 * 父进程早已退出的 monitor 仍显示 running（R8 实测 1.5s 后仍是 running），
 * 期间占着并发名额、继续算等待源。修复是给 `exit` 一个与 bash 同值的有界排空宽限。
 */
describe("D15：父进程退出即终态（孙进程占着 stdout 也不等）", () => {
  test("R8 迁入：`sleep 4 & echo started; exit 0` → 1.5s 内终态，事件含 started", async () => {
    const task = spawn({ command: "sleep 4 & echo started; exit 0", timeoutMs: 20_000 });
    const status = await waitFor(() => {
      const s = getTask(task.id)?.status;
      return s && s !== "running" ? s : undefined;
    }, 1_500);
    expect(status).toBe("completed");

    const notifs = takeNotifications();
    expect(
      notifs
        .filter((n) => n.event !== undefined)
        .map((n) => n.event!)
        .join("\n"),
    ).toContain("started");
    // 终态只发一条：exit 宽限与随后到达的 close 靠 finalized 互斥
    expect(notifs.filter((n) => n.status !== "running")).toHaveLength(1);
  }, 10_000);

  test("孙进程被清理：`sleep 60 & echo child=$!; exit 0` → 终态后孙进程已不存在", async () => {
    const task = spawn({ command: 'sleep 60 & echo "child=$!"; exit 0', timeoutMs: 20_000 });
    await waitFor(() => {
      const s = getTask(task.id)?.status;
      return s && s !== "running" ? s : undefined;
    }, 3_000);

    const text = takeNotifications()
      .filter((n) => n.event !== undefined)
      .map((n) => n.event!)
      .join("\n");
    const childPid = Number(/child=(\d+)/.exec(text)?.[1]);
    expect(Number.isInteger(childPid)).toBe(true);

    // SIGKILL 之后由 init 接管回收，给一点余量轮询 ESRCH
    const gone = await waitFor(() => {
      try {
        process.kill(childPid, 0);
        return undefined;
      } catch {
        return true;
      }
    }, 3_000);
    expect(gone).toBe(true);
  }, 15_000);

  test("T-M1-7 还原方案原文场景：`sleep 60 & exit 0` 不等孙进程", async () => {
    // 原用例（父进程自己也睡 60s、靠 killMonitorTask 收尾）保留在上面，测的是
    // 「kill 能清孙进程」；这条测的是方案原文要求：「父进程退出即终态」。
    const task = spawn({ command: "sleep 60 & exit 0", timeoutMs: 20_000 });
    const status = await waitFor(() => {
      const s = getTask(task.id)?.status;
      return s && s !== "running" ? s : undefined;
    }, 1_500);
    expect(status).toBe("completed");
  }, 10_000);
});

/**
 * D18：文案的事实与单位。
 *
 * 「…另有 N 条」让人以为还有 N 条没收到（其实全在正文里）；「共 N 条事件」的 N
 * 是通知数，不是脚本输出行数。三处文案收在 `monitor-text.ts`，这里锁住两个方向：
 * 措辞不再出现「另有」，单位分别写成「条通知」与「行」。
 */
describe("D18：限流文案与终态单位", () => {
  test("限流合并提示在末行，不污染事件首行摘要", () => {
    const gate = new MonitorRateGate({ perMinuteNotifyLimit: 1 });
    const t0 = 1_000_000;
    expect(gate.admit(["first"], t0).action).toBe("emit");
    expect(gate.admit(["b"], t0 + 1).action).toBe("defer");
    expect(gate.admit(["c"], t0 + 2).action).toBe("defer");
    const decided = gate.admit(["d"], t0 + NOTIFY_WINDOW_MS);
    expect(decided.action).toBe("emit");
    const lines = decided.event!.split("\n");
    // TUI 摘要只取事件首行，提示放末尾才不污染摘要
    expect(lines[0]).toBe("b");
    expect(lines[lines.length - 1]).toBe("（以上含 2 行因限流延迟，非实时）");
  });

  test("终态摘要单位：「共投递 N 条通知，输出共 M 行」，M 等于脚本实际行数", async () => {
    const task = spawn({ command: "echo a; echo b; echo c", timeoutMs: 10_000 });
    await waitFor(() => {
      const s = getTask(task.id)?.status;
      return s && s !== "running" ? s : undefined;
    }, 5_000);

    const terminal = takeNotifications().find((n) => n.status !== "running");
    expect(terminal?.summary).toContain("共投递 1 条通知");
    expect(terminal?.summary).toContain("输出共 3 行");
  }, 15_000);

  test("task_stop 终态同样带两个单位（D18）", async () => {
    const task = spawn({ command: "echo one; sleep 30", timeoutMs: 60_000 });
    await waitFor(() => takeNotifications().find((n) => n.event !== undefined), 5_000);
    await new TaskStopTool().execute({ task_id: task.id });
    const terminal = takeNotifications().find((n) => n.status === "killed");
    expect(terminal?.summary).toContain("共投递");
    expect(terminal?.summary).toContain("条通知");
    expect(terminal?.summary).toContain("输出共");
  }, 15_000);
});

/**
 * D3：暂存行没有定时冲刷；到期、限流停止、`task_stop` 都会丢掉缓冲与暂存行。
 *
 * 三个修复点各自被独立的断言锁住，互不覆盖：
 * 1. 窗口定时器 —— 暂存行不必等下一行到达；
 * 2. `finalizeAndDrain` 四出口共用 —— 终态前一定先冲刷（到期 / task_stop 各一条）；
 * 3. 突发阀截断 —— 触发那一批的行也收进冲刷，且只带最后 N 行。
 */
describe("D3：暂存行冲刷与终态出口收敛", () => {
  test("flushDeferred：窗口重置时把暂存行合成一条送出，并开始新窗口", () => {
    const gate = new MonitorRateGate({ perMinuteNotifyLimit: 1 });
    const t0 = 1_000_000;
    expect(gate.admit(["a"], t0).action).toBe("emit");
    expect(gate.admit(["b"], t0 + 1).action).toBe("defer");
    expect(gate.admit(["c"], t0 + 2).action).toBe("defer");
    expect(gate.deferredCount).toBe(2);

    // 窗口还没到：返回 null，调用方应重挂而不是丢弃
    expect(gate.flushDeferred(t0 + 30_000)).toBeNull();
    expect(gate.deferredCount).toBe(2);

    // 窗口已重置：暂存行作为一条新事件送出
    const decided = gate.flushDeferred(t0 + NOTIFY_WINDOW_MS)!;
    expect(decided.action).toBe("emit");
    expect(decided.event).toBe("b\nc");
    expect(gate.deferredCount).toBe(0);

    // 新窗口已记账：紧接着的一批会被继续暂存（证明窗口真的重置了）
    expect(gate.admit(["d"], t0 + NOTIFY_WINDOW_MS + 1).action).toBe("defer");
  });

  test("flushDeferred：没有暂存行时返回 null（无定时器可挂）", () => {
    const gate = new MonitorRateGate();
    expect(gate.flushDeferred(1_000_000)).toBeNull();
  });

  test("msUntilWindowReset：无暂存返回 null；有暂存返回窗口剩余时间", () => {
    const gate = new MonitorRateGate({ perMinuteNotifyLimit: 1 });
    const t0 = 1_000_000;
    expect(gate.msUntilWindowReset(t0)).toBeNull();
    expect(gate.admit(["a"], t0).action).toBe("emit");
    expect(gate.admit(["b"], t0 + 1).action).toBe("defer");
    expect(gate.msUntilWindowReset(t0 + 20_000)).toBe(NOTIFY_WINDOW_MS - 20_000);
  });

  test(`drainAll 指定 maxLines：突发阀只带最后 ${MAX_BURST_FLUSH_LINES} 行`, () => {
    const gate = new MonitorRateGate();
    const lines = Array.from({ length: 100 }, (_, i) => `l${i + 1}`);
    const event = gate.drainAll(lines, MAX_BURST_FLUSH_LINES)!;
    const parts = event.split("\n");
    expect(parts[0]).toContain(`前 ${100 - MAX_BURST_FLUSH_LINES} 行已省略`);
    expect(parts[0]).toContain(".output");
    expect(parts).toHaveLength(MAX_BURST_FLUSH_LINES + 1);
    expect(parts).toContain("l100"); // 保尾：汇总行在最后
    expect(parts).not.toContain(`l${100 - MAX_BURST_FLUSH_LINES}`); // 前段被省略
  });

  test("到期时暂存行在终态通知之前以事件送达（D3 / R3）", async () => {
    // 7 行 × 0.3s 用满每分钟 6 条通知的持续阀，err7 被暂存；之后脚本沉默到期限。
    // 修复前：err7 随 ctl 一起丢掉（R3 实测）。修复后：到期冲刷先送出 err7，再写终态。
    const task = spawn({
      command: `for i in 1 2 3 4 5 6 7; do echo "err$i"; sleep 0.3; done; sleep 5; exit 0`,
      timeoutMs: 3_500,
    });
    await waitFor(() => {
      const status = getTask(task.id)?.status;
      return status && status !== "running" ? status : undefined;
    }, 15_000);

    const notifs = takeNotifications();
    const eventIdx = notifs.findIndex((n) => n.event?.includes("err7") === true);
    const terminalIdx = notifs.findIndex((n) => n.status !== "running");
    expect(
      notifs
        .filter((n) => n.event !== undefined)
        .map((n) => n.event!)
        .join("\n"),
    ).toContain("err7");
    expect(eventIdx).toBeGreaterThan(-1);
    expect(terminalIdx).toBeGreaterThan(-1);
    // 事件先于终态：先给现场（哪个分片失败），再说结束
    expect(eventIdx).toBeLessThan(terminalIdx);
  }, 20_000);

  test("暂存行在窗口重置时自动冲刷，不等下一行也不等退出（D3 修复 1）", async () => {
    // perMinuteLimit=1、窗口 300ms：err1 投递后 err2 被暂存，此后脚本沉默 5s。
    // 没有窗口定时器时 err2 只能等进程退出（5s 后）才被送出，那时任务已是终态。
    const task = spawn({
      command: `echo err1; sleep 0.25; echo err2; sleep 5`,
      timeoutMs: 10_000,
      gateLimits: { perMinuteNotifyLimit: 1, notifyWindowMs: 300 },
    });
    const collected: string[] = [];
    await waitFor(() => {
      for (const n of takeNotifications()) if (n.event !== undefined) collected.push(n.event);
      return collected.join("\n").includes("err2") ? true : undefined;
    }, 6_000);

    expect(collected.join("\n")).toContain("err2");
    // 关键：任务仍在运行——err2 是窗口冲刷送出的，不是退出 / 到期冲刷
    expect(getTask(task.id)?.status).toBe("running");
  }, 15_000);

  test("task_stop 把暂存行一起冲刷出去，且事件先于终态通知（D3 修复 2）", async () => {
    const task = spawn({
      command: `for i in 1 2 3 4 5 6 7; do echo "err$i"; sleep 0.3; done; sleep 30`,
      timeoutMs: 60_000,
    });
    // 等持续阀用满（6 条事件到达），再留 350ms 让 err7 进入批处理缓冲并被 defer
    const seen: string[] = [];
    await waitFor(() => {
      for (const n of takeNotifications()) if (n.event !== undefined) seen.push(n.event);
      return seen.length >= PER_MINUTE_NOTIFY_LIMIT ? true : undefined;
    }, 8_000);
    await new Promise((r) => setTimeout(r, 350));

    const result = await new TaskStopTool().execute({ task_id: task.id });
    expect((result as { isError?: boolean }).isError).toBeFalsy();
    expect(getTask(task.id)?.status).toBe("killed");

    const notifs = takeNotifications();
    const eventIdx = notifs.findIndex((n) => n.event?.includes("err7") === true);
    const terminalIdx = notifs.findIndex((n) => n.status === "killed");
    expect(
      notifs
        .filter((n) => n.event !== undefined)
        .map((n) => n.event!)
        .join("\n"),
    ).toContain("err7");
    expect(eventIdx).toBeGreaterThan(-1);
    expect(terminalIdx).toBeGreaterThan(-1);
    expect(eventIdx).toBeLessThan(terminalIdx);
  }, 20_000);

  test("突发阀停止：触发那一批的行也进冲刷，只带最后 N 行并注明省略（D3 修复 3）", async () => {
    // printf 一次写出 100 行（远小于 PIPE_BUF，一次 write 原子到达）：
    // 修复前 recordLine 在 `pendingLines.push(...lines)` 之前 return，整批行凭空消失；
    // 修复后本批行全部进缓冲，再由 drainAll(…, MAX_BURST_FLUSH_LINES) 保尾截断。
    const task = spawn({
      command: `printf '%s\\n' $(seq 1 100); sleep 5`,
      timeoutMs: 20_000,
    });
    await waitFor(() => {
      const status = getTask(task.id)?.status;
      return status && status !== "running" ? status : undefined;
    }, 10_000);

    const notifs = takeNotifications();
    expect(notifs.find((n) => n.status === "killed")?.summary).toContain("事件过密");
    const event = notifs
      .filter((n) => n.event !== undefined)
      .map((n) => n.event!)
      .join("\n");
    const lines = event.split("\n");
    expect(lines[0]).toContain(`前 ${100 - MAX_BURST_FLUSH_LINES} 行已省略`);
    expect(lines[0]).toContain(".output");
    expect(lines).toContain("100");
    expect(lines).toContain(String(100 - MAX_BURST_FLUSH_LINES + 1));
    expect(lines).not.toContain(String(100 - MAX_BURST_FLUSH_LINES));
  }, 20_000);

  test("终态出口收敛守卫：ctl.finalized = true 只允许在 finalizeAndDrain 一处（D3）", () => {
    // D2 / D3 的根因就是四个出口各写各的 finalized = true，「终态前把剩下的行送出去」
    // 只有 close 一处写了。这条守卫防第五个出口又漏掉冲刷——断言读源码文本，不读注释。
    const src = readFileSync(new URL("../../src/task/monitor-task.ts", import.meta.url), "utf8");
    const stripped = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

    /** 向上找最近的函数声明名（够用即可：本文件没有嵌套函数声明） */
    const enclosingFunction = (index: number): string | null => {
      const before = stripped.slice(0, index);
      const matches = [...before.matchAll(/(?:export\s+)?function\s+([A-Za-z0-9_]+)\s*\(/g)];
      return matches.length > 0 ? matches[matches.length - 1]![1]! : null;
    };
    const sites = [...stripped.matchAll(/ctl\.finalized\s*=\s*true/g)].map((m) =>
      enclosingFunction(m.index!),
    );

    // 唯一允许的例外是测试辅助 `__clearActiveMonitorsForTest`（它置位是为了阻止
    // 孤儿进程的 close 回调在下一个测试文件里入队通知）
    expect(
      sites.filter((n) => n !== "finalizeAndDrain" && n !== "__clearActiveMonitorsForTest"),
    ).toEqual([]);
    expect(sites.filter((n) => n === "finalizeAndDrain")).toHaveLength(1);
  });
});
