/**
 * P14：`getWindowSize` 的兜底路径只算一次，且打开的 `/dev/tty` fd 必须收回来。
 *
 * 缺陷形态（2026-11-10 实测）：`stdout.columns`/`rows` 为 0 时（PTY 0×0、stdout 被接管）
 * 每次调用都走 `terminal-size` 的兜底 —— macOS 上它 `openSync('/dev/tty')` 之后不关闭，
 * 200 次调用把 tty fd 从 3 涨到 205；没有控制终端时每次起两个 `tput` 子进程（2.4–3.5 ms/次）。
 * 渲染路径每帧会调这个函数多次，于是泄漏与子进程都是按帧累积的。
 *
 * 三条门禁各盯一个失效模式：打开 `/dev/tty` 的次数 ≤ 1（抓「没缓存」）、重复调用耗时回到
 * 属性读量级（抓「每次起 tput」）、调用前后 tty fd 数不变（抓「打开了不关」）。
 */
import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { getWindowSize, resetWindowSizeFallbackForTests } from "../src/utils.ts";

/** 模拟 PTY 0×0 / stdout 被接管：两个尺寸都是 0。 */
const zeroStdout = (): NodeJS.WriteStream =>
  ({ columns: 0, rows: 0 }) as unknown as NodeJS.WriteStream;

/** 数 `/dev/tty` 的打开次数：这是「每次调用都去开一次 tty」的直接证据。 */
const spyOnDevTtyOpen = () => {
  const original = fs.openSync;
  let count = 0;

  (fs as unknown as { openSync: (...args: unknown[]) => number }).openSync = (
    path: unknown,
    ...rest: unknown[]
  ) => {
    if (path === "/dev/tty") {
      count++;
    }

    return (original as unknown as (...args: unknown[]) => number)(path, ...rest);
  };

  return {
    get count() {
      return count;
    },
    restore: () => {
      (fs as unknown as { openSync: typeof original }).openSync = original;
    },
  };
};

/**
 * 进程当前打开的 tty fd 数。
 *
 * 用 `lsof` 而不是 `/proc/self/fd`：后者只有 Linux 有，而缺陷正是在 macOS 上实测的。
 * 拿不到 `lsof` 时返回 undefined，调用方跳过这条断言（另两条门禁仍然有效）。
 */
const countTtyFds = (): number | undefined => {
  try {
    const output = execFileSync("lsof", ["-p", String(process.pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    });

    return output.split("\n").filter((line) => /\/dev\/tty\b|ttys\d*/.test(line)).length;
  } catch {
    return undefined;
  }
};

test("兜底只算一次：后续调用不再打开 /dev/tty", () => {
  resetWindowSizeFallbackForTests();
  const spy = spyOnDevTtyOpen();

  try {
    const stdout = zeroStdout();
    const first = getWindowSize(stdout);

    expect(first.columns).toBeGreaterThan(0);
    expect(first.rows).toBeGreaterThan(0);
    // 第一次允许打开一次（机器上没有控制终端时是 0 次）
    expect(spy.count).toBeLessThanOrEqual(1);

    const opensAfterFirst = spy.count;
    for (let index = 0; index < 500; index++) {
      getWindowSize(stdout);
    }

    expect(spy.count).toBe(opensAfterFirst);
  } finally {
    spy.restore();
  }
});

test("兜底只算一次：重复调用不再每次起 tput 子进程", () => {
  resetWindowSizeFallbackForTests();
  const stdout = zeroStdout();

  // 第一次允许慢：开 /dev/tty 或起两条 tput
  getWindowSize(stdout);

  const startedAt = performance.now();
  for (let index = 0; index < 500; index++) {
    getWindowSize(stdout);
  }

  const elapsed = performance.now() - startedAt;

  // 缺陷形态是 2.4–3.5 ms/次（500 次 > 1.2 s）；缓存命中后只剩属性读与对象构造
  expect(elapsed).toBeLessThan(200);
});

test("兜底只算一次：打开的 /dev/tty fd 会被关回去", async () => {
  resetWindowSizeFallbackForTests();

  const before = countTtyFds();
  if (before === undefined) {
    return; // 没有 lsof：跳过（另两条门禁仍然覆盖缓存与子进程）
  }

  getWindowSize(zeroStdout());
  // WriteStream.destroy() 的关闭是异步的，给它一个 tick
  await new Promise((resolve) => setTimeout(resolve, 100));

  expect(countTtyFds()).toBe(before);

  for (let index = 0; index < 200; index++) {
    getWindowSize(zeroStdout());
  }

  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(countTtyFds()).toBe(before);
});
