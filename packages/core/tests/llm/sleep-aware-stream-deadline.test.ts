/**
 * PR9 回归：休眠扣减下沉到流式路径，不再误杀健康流
 *
 * ## 缺陷形态（改造前）
 *
 * 休眠扣减只存在于 `query/loop.ts`：只有它的周期 tick 在比对挂钟、把跳跃记进账本。
 * 流式各层（fallback 流超时 / lifecycle 三层 / parseSSE 字节级）用的都是**一次性
 * setTimeout**，既不观测休眠、也不查账本 —— `sleepPause` 在这三个文件里 grep 命中为 0。
 *
 * 后果是同一时刻两套判据结论相反：一次 `sleep_ms ≈ 281s` 的休眠让 fallback 杀掉了
 * 一条**真实无进展仅 3.4 秒**的健康流，而同一时刻 loop 的 watchdog（扣了休眠）判定正常。
 *
 * ## 为什么不能靠"抬阈值"解决
 *
 * 历史记录里单次休眠达 939~946s，任何固定阈值都会被足够长的休眠击穿。
 *
 * ## 为什么各层不能自己用比率判据自测休眠
 *
 * 一次性定时器的 expected 就是它自己的阈值（如 300s），
 * `isSleepGap(actual, 300_000)` 要求迟到超过 3000s 才命中 —— 对 281s 的休眠恒为 false。
 * 判据必须来自一个 tick 间隔足够短的独立观测者，这正是 `startSleepObserver` 的职责。
 *
 * fix_type: case_design
 */

import { describe, test, expect, afterEach } from "bun:test";
import {
  createSleepAwareDeadline,
  getSleepLedger,
  isSleepGap,
  isSleepObserverRunning,
  startSleepObserver,
  __resetSleepLedgerForTest,
  SLEEP_DETECT_FLOOR_MS,
} from "@sid-code/shared/utils/sleep-detect.ts";

afterEach(() => {
  __resetSleepLedgerForTest();
});

describe("PR9 — createSleepAwareDeadline 把休眠从判据里剔除", () => {
  test("无休眠时行为等价于纯挂钟：立刻问剩余 ≈ 全窗口", () => {
    const dl = createSleepAwareDeadline(10_000);
    expect(dl.remainingMs()).toBeGreaterThan(9_000);
    expect(dl.sleepMs()).toBe(0);
  });

  test("窗口内记到休眠 → 剩余量按休眠时长回补（这就是「不开枪」的判据）", () => {
    const dl = createSleepAwareDeadline(300_000);
    // 模拟 loop 的观测器记下一次 281s 的休眠（预期 tick 5s，实际迟到 286s）。
    const slept = getSleepLedger().record(286_000, 5_000);
    expect(slept).toBeGreaterThan(280_000);
    // 定时器此刻若 fire，remainingMs 必须 > 0 —— 也就是"这一枪是休眠补发的，重排"。
    expect(dl.remainingMs()).toBeGreaterThan(0);
    expect(dl.sleepMs()).toBeGreaterThan(280_000);
  });

  test("负向对照：真正的无进展仍然到点开枪（别把超时判据关死）", () => {
    // 窗口 0ms = 已到点；账本无休眠 → remaining 必须是 0（该开枪）。
    const dl = createSleepAwareDeadline(0);
    expect(dl.remainingMs()).toBe(0);
  });

  test("restart 同时重置窗口起点与账本读数（否则历史休眠被反复减 → 漏杀）", () => {
    getSleepLedger().record(286_000, 5_000); // 一段"历史"休眠
    const dl = createSleepAwareDeadline(1_000);
    // 未 restart 时：这段历史休眠发生在 deadline 创建**之前**，
    // 所以 sleepMs 应为 0（只算窗口内的），窗口本身很快到点。
    expect(dl.sleepMs()).toBe(0);
    dl.restart();
    expect(dl.sleepMs()).toBe(0);
    // 关键：restart 后账本读数被重新取样，历史休眠不会被再减一次。
    // 若实现只重置了 armedAt 而不重置 ledgerAtArm，这里的 sleepMs 会等于历史值。
  });

  test("休眠判据的阈值形态：不足下限的抖动不算休眠", () => {
    // 阈值必须超过系统里最长的正常等待，否则正常等待就是误判源。
    expect(isSleepGap(SLEEP_DETECT_FLOOR_MS - 1, 5_000)).toBe(false);
    expect(isSleepGap(286_000, 5_000)).toBe(true);
  });
});

describe("PR9 — 休眠观测器（判据的来源）", () => {
  test("引用计数：多次 start 只有一个 interval，全部 release 后停止", () => {
    const r1 = startSleepObserver();
    expect(isSleepObserverRunning()).toBe(true);
    const r2 = startSleepObserver();
    r1();
    // 还有一个持有者 → 不能停（否则另一层的判据静默失去数据源）。
    expect(isSleepObserverRunning()).toBe(true);
    r2();
    expect(isSleepObserverRunning()).toBe(false);
  });

  test("release 幂等：重复调用不会把计数减成负数", () => {
    const r = startSleepObserver();
    r();
    r();
    r();
    expect(isSleepObserverRunning()).toBe(false);
    // 计数被减成负数时，下一次 start 之后的第一次 release 会提前停掉观测器 ——
    // 这条断言拦的就是那个形态。
    const r2 = startSleepObserver();
    expect(isSleepObserverRunning()).toBe(true);
    r2();
    expect(isSleepObserverRunning()).toBe(false);
  });
});

describe("PR9 — 三条流式路径都接了休眠扣减（形态断言）", () => {
  const read = (p: string) =>
    require("fs").readFileSync(require("path").join(import.meta.dir, "../../src/llm", p), "utf8");

  test("fallback 流超时：回调里二次核对 + 重排", () => {
    const src = read("fallback.ts");
    expect(src).toContain("createSleepAwareDeadline");
    expect(src).toContain("streamDeadline.remainingMs()");
    // 重排而非开枪：必须能看到"remaining > 0 → 重新 arm"的分支。
    expect(src).toContain("startStreamTimeout(remaining)");
  });

  test("lifecycle content-progress / overall：各自持 deadline", () => {
    const src = read("stream-lifecycle.ts");
    expect(src).toContain("contentDeadline");
    expect(src).toContain("overallDeadline");
    expect(src).toContain("armContent(remaining)");
    expect(src).toContain("armOverall(remaining)");
  });

  test("parseSSE 字节级：idle 定时器与 contentElapsed 都扣休眠", () => {
    const src = read("openai.ts");
    expect(src).toContain("readDeadline.remainingMs()");
    // contentElapsed 是同步核对（不是定时器回调），扣减形态是减账本增量。
    expect(src).toContain("sleepAtLastProgress");
    expect(src).toContain("markContentProgress");
  });
});
