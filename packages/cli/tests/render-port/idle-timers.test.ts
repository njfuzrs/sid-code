/**
 * 契约 P1（B9 / T8.1b）：idle 时没有空转定时器。已知例外：ResizeObserver 有观察目标时 16ms 轮询。
 *
 * 判据是「静置 1s 内定时器回调触发次数」，不是 CPU 百分比：CPU 采样在 CI 上噪声大，而空转定时器
 * 不管周期多长都会在计数里现形。
 * 真实 PTY 下的 CPU 实测（两套底座 10s 静置 0.01–0.02s CPU，有观察者时 0.05s）记在 Agent Note T8.1b。
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const FIXTURE = join(import.meta.dir, "fixtures", "idle-timers-app.tsx");

async function idle(env: Record<string, string>): Promise<Record<string, number>> {
  const p = Bun.spawn(["bun", FIXTURE], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(p.stdout).text();
  await p.exited;
  const m = /IDLE (\{.*\})/.exec(out);
  // 子进程没打印结果算失败，不当「零触发」放过
  expect(m).not.toBeNull();
  return JSON.parse(m![1]!) as Record<string, number>;
}

describe("P1 idle 无空转定时器", () => {
  test("P1: 主屏静置 1s，定时器回调一次都不触发", async () => {
    expect(await idle({})).toEqual({});
  }, 20000);

  test("P1: alt-screen 静置 1s，定时器回调一次都不触发", async () => {
    expect(await idle({ IDLE_ALT: "1" })).toEqual({});
  }, 20000);

  test("P1: 已知例外——有 ResizeObserver 观察目标时只有它的轮询在触发（约 16ms 一次）", async () => {
    const got = await idle({ IDLE_RO: "1" });
    const keys = Object.keys(got);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^interval resize-observer\.ts$/);
    // 1s / 16ms ≈ 62；给满载 runner 留余量，只钉量级
    expect(got[keys[0]!]).toBeGreaterThan(20);
    expect(got[keys[0]!]).toBeLessThan(80);
  }, 20000);
});
