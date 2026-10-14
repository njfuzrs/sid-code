/**
 * 防休眠服务单测（事故 20260801-175042-699f69f8 的第一层纵深）
 *
 * 覆盖：refCount 语义（嵌套/并发、不减成负）、force 无条件收尾、非 macOS 平台 no-op。
 * 不覆盖"caffeinate 真的挡住了休眠"——那需要真实休眠环境，属人工验证项。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  startPreventSleep,
  stopPreventSleep,
  forceStopPreventSleep,
  getPreventSleepRefCount,
  isPreventSleepActive,
  __resetPreventSleepForTest,
  __setCaffeinateSpawnerForTest,
  buildCaffeinateArgv,
  RESPAWN_MAX_IN_WINDOW,
} from "@sid-code/core/task/prevent-sleep.ts";

const isMac = process.platform === "darwin";

beforeEach(() => {
  __resetPreventSleepForTest();
});

afterEach(() => {
  __resetPreventSleepForTest();
});

describe("refCount 语义", () => {
  test("start/stop 配对后归零", () => {
    startPreventSleep();
    expect(getPreventSleepRefCount()).toBe(1);
    stopPreventSleep();
    expect(getPreventSleepRefCount()).toBe(0);
  });

  test("嵌套 start 只累计计数，最后一个 stop 才归零", () => {
    // 这是并发场景的关键不变量：主循环 + 后台任务同时干活时，
    // 任一方结束不得把对方的保活也关掉。
    startPreventSleep();
    startPreventSleep();
    startPreventSleep();
    expect(getPreventSleepRefCount()).toBe(3);

    stopPreventSleep();
    expect(getPreventSleepRefCount()).toBe(2);
    if (isMac) expect(isPreventSleepActive()).toBe(true); // 仍有人在干活

    stopPreventSleep();
    stopPreventSleep();
    expect(getPreventSleepRefCount()).toBe(0);
  });

  test("多余的 stop 不把计数减成负数", () => {
    // 若能减成负，后续 start 就需要多调几次才生效——保活会静默失效。
    stopPreventSleep();
    stopPreventSleep();
    expect(getPreventSleepRefCount()).toBe(0);

    startPreventSleep();
    expect(getPreventSleepRefCount()).toBe(1);
    if (isMac) expect(isPreventSleepActive()).toBe(true);
  });
});

describe("forceStop：退出清理专用", () => {
  test("无条件归零，不管当前计数多少", () => {
    startPreventSleep();
    startPreventSleep();
    expect(getPreventSleepRefCount()).toBe(2);

    forceStopPreventSleep();
    expect(getPreventSleepRefCount()).toBe(0);
    expect(isPreventSleepActive()).toBe(false);
  });

  test("空状态下调用是安全的空操作", () => {
    expect(() => forceStopPreventSleep()).not.toThrow();
    expect(getPreventSleepRefCount()).toBe(0);
  });
});

describe("平台行为", () => {
  test(isMac ? "macOS：start 后确实持有 caffeinate" : "非 macOS：no-op 但计数仍可用", () => {
    startPreventSleep();
    if (isMac) {
      expect(isPreventSleepActive()).toBe(true);
    } else {
      // 其他平台不起进程，但计数语义保持一致（调用方无需分平台写代码）
      expect(isPreventSleepActive()).toBe(false);
      expect(getPreventSleepRefCount()).toBe(1);
    }
    stopPreventSleep();
    expect(isPreventSleepActive()).toBe(false);
  });
});

describe("反复 start/stop 不泄漏", () => {
  test("10 轮循环后计数归零、无残留进程", () => {
    for (let i = 0; i < 10; i++) {
      startPreventSleep();
      stopPreventSleep();
    }
    expect(getPreventSleepRefCount()).toBe(0);
    expect(isPreventSleepActive()).toBe(false);
  });

  test("真实 OS 层面无孤儿 caffeinate（内部状态归零不等于进程真被回收）", async () => {
    // 为什么要查真实进程表：caffeinate 是**外部进程**，模块内部把句柄置 null 很容易，
    // 但那只代表"我们不再持有引用"，不代表 OS 里那个进程真的死了。漏杀会把用户的
    // Mac 一直钉醒——这类资源必须按"OS 里还剩几个"验收，而不是按内部标志位验收。
    if (!isMac) return; // 其他平台不起进程，无可验

    const countCaffeinate = (): number => {
      const r = Bun.spawnSync(["bash", "-c", 'pgrep -f "caffeinate -i -w" | wc -l']);
      return parseInt(r.stdout.toString().trim(), 10) || 0;
    };

    const before = countCaffeinate();
    for (let i = 0; i < 5; i++) {
      startPreventSleep();
      stopPreventSleep();
    }
    forceStopPreventSleep();
    // kill 是异步生效的，给 OS 一点回收时间再断言
    await new Promise((r) => setTimeout(r, 300));

    expect(countCaffeinate()).toBeLessThanOrEqual(before);
  });
});

// ── 2026-10-14：-w 单进程，消灭零 assertion 窗口 ──────────────────────────
describe("caffeinate -w：不重启、意外退出重拉", () => {
  type FakeProc = {
    argv: string[];
    killed: number;
    kill: () => void;
    exited: Promise<unknown>;
    die: () => void;
  };
  let spawned: FakeProc[] = [];

  beforeEach(() => {
    spawned = [];
    __setCaffeinateSpawnerForTest((argv) => {
      let resolve!: () => void;
      const exited = new Promise<void>((r) => (resolve = r));
      const p: FakeProc = {
        argv,
        killed: 0,
        kill: () => {
          p.killed += 1;
          resolve();
        },
        exited,
        die: () => resolve(),
      };
      spawned.push(p);
      return p;
    });
  });

  test("argv 恰为 caffeinate -i -w <pid>，不带 -t", () => {
    expect(buildCaffeinateArgv(123)).toEqual(["caffeinate", "-i", "-w", "123"]);
    startPreventSleep();
    expect(spawned[0]!.argv).toEqual(["caffeinate", "-i", "-w", String(process.pid)]);
  });

  test("refCount 1→2→1 期间 spawn 一次、kill 零次", () => {
    startPreventSleep();
    startPreventSleep();
    stopPreventSleep();
    expect(spawned.length).toBe(1);
    expect(spawned[0]!.killed).toBe(0);
    stopPreventSleep();
    expect(spawned[0]!.killed).toBe(1);
  });

  test("长时间持有不会被定时重启（重启 = 零 assertion 窗口）", async () => {
    // 旧实现每 4 分钟 kill+spawn；这里用源码断言兜底：模块里不得再出现 setInterval。
    const src = await Bun.file(
      new URL("../../../core/src/task/prevent-sleep.ts", import.meta.url),
    ).text();
    const code = src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toContain("setInterval");
    expect(code).not.toMatch(/"-t"/);
  });

  test("意外退出后立即重拉，且受窗口次数上限约束", async () => {
    startPreventSleep();
    for (let i = 0; i < RESPAWN_MAX_IN_WINDOW + 2; i++) {
      spawned[spawned.length - 1]!.die();
      await new Promise((r) => setTimeout(r, 0));
    }
    // 1 次初始 + RESPAWN_MAX_IN_WINDOW 次重拉，之后放弃
    expect(spawned.length).toBe(1 + RESPAWN_MAX_IN_WINDOW);
    expect(isPreventSleepActive()).toBe(false);
  });

  test("refCount=0 时进程退出不重拉", async () => {
    startPreventSleep();
    stopPreventSleep();
    await new Promise((r) => setTimeout(r, 0));
    expect(spawned.length).toBe(1);
  });
});
