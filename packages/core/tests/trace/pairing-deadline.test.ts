/**
 * 卡 F1（2026-10-14）：ModelCallUnpaired 配对看门狗扣除重试退避与休眠。
 *
 * 事故会话 113129 03:54:33 / 110202 的 6 次 ModelCallUnpaired：BeforeModel 之后漏斗退避
 * （单次最长 120s）+ 休眠被当成「请求挂住」。验收：
 *   - 一次调用内退避累计 280s + 30s 请求 → 不判；
 *   - 真正挂 300s、无退避 → 仍判（负向对照，防「看门狗本来就不开枪」的空集全绿）。
 */

import { describe, test, expect, beforeEach, afterEach, setSystemTime } from "bun:test";
import { BackoffLedger, createPairingDeadline } from "@sid-code/core/trace/pairing-deadline.ts";
import { getSleepLedger, __resetSleepLedgerForTest } from "@sid-code/shared/utils/sleep-detect.ts";

const T = 300_000;
let now = 0;
const advance = (ms: number) => {
  now += ms;
  setSystemTime(new Date(now));
};

beforeEach(() => {
  __resetSleepLedgerForTest();
  now = Date.parse("2026-10-14T03:50:00Z");
  setSystemTime(new Date(now));
});
afterEach(() => {
  setSystemTime();
  __resetSleepLedgerForTest();
});

describe("F1 createPairingDeadline", () => {
  test("退避累计 280s + 30s 请求：挂钟 310s 不判 unpaired", () => {
    const backoff = new BackoffLedger();
    const dl = createPairingDeadline(T, backoff);
    // 113129 形态：多次退避（5s → … → 120s）累计 280s，中间穿插短请求
    for (const d of [10_000, 30_000, 120_000, 120_000]) {
      advance(2_000); // 请求失败前的短暂尝试
      backoff.record(d);
      expect(dl.remainingMs()).toBeGreaterThan(0); // 退避中恒不判
      advance(d);
    }
    advance(30_000); // 最后一次真实请求 30s
    expect(dl.backoffMs()).toBe(280_000);
    expect(dl.remainingMs()).toBeGreaterThan(0);
  });

  test("负向对照：真挂 300s、无退避 → 判", () => {
    const dl = createPairingDeadline(T, new BackoffLedger());
    advance(299_999);
    expect(dl.remainingMs()).toBe(1);
    advance(1);
    expect(dl.remainingMs()).toBe(0);
  });

  test("休眠 181s 不计入：挂钟 400s、休眠 181s → 有效 219s 不判", () => {
    const dl = createPairingDeadline(T, new BackoffLedger());
    advance(400_000);
    getSleepLedger().record(181_000 + 5_000, 5_000);
    expect(dl.sleepMs()).toBe(181_000);
    expect(dl.remainingMs()).toBe(T - (400_000 - 181_000));
  });

  test("退避进行中即便有效耗时已超也不判（退避结束后才开始计）", () => {
    const backoff = new BackoffLedger();
    const dl = createPairingDeadline(T, backoff);
    advance(299_000);
    backoff.record(120_000);
    advance(60_000); // 退避进行到一半
    expect(dl.remainingMs()).toBeGreaterThan(0);
  });

  test("看门狗挂上之前的退避不计入本窗口", () => {
    const backoff = new BackoffLedger();
    backoff.record(100_000);
    advance(100_000);
    const dl = createPairingDeadline(T, backoff);
    advance(T);
    expect(dl.backoffMs()).toBe(0);
    expect(dl.remainingMs()).toBe(0);
  });
});

describe("F1 回放：会话 113129 index=23（03:49:33 BeforeModel → 03:54:33 误报）", () => {
  // 取自 events.jsonl：BeforeModel 后 6 次 retry 遥测（主循环，无 agentId）的偏移与 delayMs。
  // 旧看门狗在 03:54:33 报 unpaired；实际 03:58:xx 才 AfterModel —— 300s 里 291s 是退避。
  const RETRIES: Array<[offsetMs: number, delayMs: number]> = [
    [1_287, 5_481],
    [8_047, 11_617],
    [21_038, 23_513],
    [45_496, 43_633],
    [90_058, 86_679],
    [179_729, 120_546],
  ];
  test("同序列下挂钟满 300s 不判 unpaired", () => {
    const backoff = new BackoffLedger();
    const dl = createPairingDeadline(T, backoff);
    let at = 0;
    for (const [off, d] of RETRIES) {
      advance(off - at);
      at = off;
      backoff.record(d);
    }
    advance(T - at); // 03:54:33
    expect(dl.backoffMs()).toBeGreaterThan(280_000);
    expect(dl.remainingMs()).toBeGreaterThan(0);
  });
});
