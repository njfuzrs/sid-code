/**
 * 前缀断裂定位埋点测试（P1-2）
 *
 * 这个埋点存在的理由本身来自一次实测否证：方案原定"从 raw.jsonl 逐轮 diff
 * request.system 与 messages"，但 collector 只在 index==1 存完整请求、后续只存
 * 尾部增量，且 computeNewMessages 是纯 slice —— 原地改写与中部插入不留痕迹。
 * 所以历史数据无从归因，必须在请求发出的那一刻在线算。
 *
 * 测试重点是三个容易搞反的语义：
 *   1. 纯尾部追加**不算断裂**（这是健康形态，缓存能完整命中）
 *   2. 断裂位置要能区分"system 静态区 / 动态区 / tools / 第 k 条消息"
 *   3. wastedRatio 要反映"断得多早"，因为断在第 2 条比断在第 200 条贵得多
 */

import { describe, test, expect } from "bun:test";
import {
  fingerprintPrefix,
  diagnosePrefixBreak,
  PrefixBreakTracker,
} from "../../src/trace/prefix-break-probe.ts";
import { aggregatePrefixBreakStats } from "../../src/trace/digest.ts";

/** 简化的 system 拆分：以 "---DYN---" 为界（真实用 DYNAMIC_BOUNDARY） */
const split = (s: string) => {
  const i = s.indexOf("---DYN---");
  if (i === -1) return { staticContent: s };
  return { staticContent: s.slice(0, i), dynamicContent: s.slice(i + 9) };
};

const TOOLS = JSON.stringify([{ name: "read" }, { name: "bash" }]);

function fp(system: string | undefined, tools: string, msgs: unknown[]) {
  return fingerprintPrefix(system, tools, msgs, split);
}

describe("P1-2 纯尾部追加不算断裂（健康形态）", () => {
  test("只在末尾加消息 → broken=false", () => {
    const a = fp("SYS", TOOLS, [{ r: "u", t: "1" }, { r: "a", t: "2" }]);
    const b = fp("SYS", TOOLS, [{ r: "u", t: "1" }, { r: "a", t: "2" }, { r: "u", t: "3" }]);
    const d = diagnosePrefixBreak(a, b);
    expect(d.broken).toBe(false);
    // 段数增长是正常的，不该被当成异常
    expect(d.currSegmentCount).toBeGreaterThan(d.prevSegmentCount);
  });

  test("完全不变 → broken=false", () => {
    const a = fp("SYS", TOOLS, [{ r: "u", t: "1" }]);
    const b = fp("SYS", TOOLS, [{ r: "u", t: "1" }]);
    expect(diagnosePrefixBreak(a, b).broken).toBe(false);
  });
});

describe("P1-2 断裂位置定位到段（P1-3 要靠它决定改哪里）", () => {
  test("system 静态区变化 → system_static（本该稳定的地方在变，最该修）", () => {
    const a = fp("STATIC-A---DYN---time=1", TOOLS, [{ r: "u", t: "1" }]);
    const b = fp("STATIC-B---DYN---time=1", TOOLS, [{ r: "u", t: "1" }]);
    const d = diagnosePrefixBreak(a, b);
    expect(d.broken).toBe(true);
    expect(d.firstChangedKind).toBe("system_static");
  });

  test("只有动态区变化 → system_dynamic（预期行为，但量级可衡量）", () => {
    const a = fp("STATIC---DYN---time=1", TOOLS, [{ r: "u", t: "1" }]);
    const b = fp("STATIC---DYN---time=2", TOOLS, [{ r: "u", t: "1" }]);
    const d = diagnosePrefixBreak(a, b);
    expect(d.broken).toBe(true);
    expect(d.firstChangedKind).toBe("system_dynamic");
  });

  test("工具顺序变化 → tools（内容相同顺序不同也会断缓存）", () => {
    const a = fp("SYS", JSON.stringify([{ name: "read" }, { name: "bash" }]), []);
    const b = fp("SYS", JSON.stringify([{ name: "bash" }, { name: "read" }]), []);
    const d = diagnosePrefixBreak(a, b);
    expect(d.broken).toBe(true);
    expect(d.firstChangedKind).toBe("tools");
  });

  test("历史中部被原地改写 → 定位到具体第几条消息", () => {
    const base = [{ r: "u", t: "1" }, { r: "a", t: "2" }, { r: "u", t: "3" }, { r: "a", t: "4" }];
    const mutated = [...base];
    mutated[1] = { r: "a", t: "2-REWRITTEN" };
    const d = diagnosePrefixBreak(fp("SYS", TOOLS, base), fp("SYS", TOOLS, mutated));
    expect(d.broken).toBe(true);
    expect(d.firstChangedKind).toBe("message");
    // 这正是离线 diff 抓不到的情形（new_messages 只有尾部增量）
    expect(d.firstChangedMessageIndex).toBe(1);
  });

  test("历史被截短（compact/删消息）→ 记为断裂", () => {
    const long = fp("SYS", TOOLS, [{ t: 1 }, { t: 2 }, { t: 3 }, { t: 4 }]);
    const short = fp("SYS", TOOLS, [{ t: 1 }, { t: 2 }]);
    expect(diagnosePrefixBreak(long, short).broken).toBe(true);
  });
});

describe("P1-2 wastedRatio 反映断得多早（决定优化优先级）", () => {
  test("断在靠前的消息比断在靠后的浪费更多", () => {
    const mk = (mutateAt: number) => {
      const msgs = Array.from({ length: 20 }, (_, i) => ({ r: "u", t: `msg-${i}`.padEnd(50, "x") }));
      const before = fp("SYS", TOOLS, msgs);
      const after = [...msgs];
      after[mutateAt] = { r: "u", t: `CHANGED-${mutateAt}`.padEnd(50, "x") };
      return diagnosePrefixBreak(before, fp("SYS", TOOLS, after));
    };
    const early = mk(1);
    const late = mk(18);
    expect(early.broken).toBe(true);
    expect(late.broken).toBe(true);
    // 优化优先级要看浪费比例而不是断裂次数 —— 断在第 2 条比第 19 条贵得多
    expect(early.wastedRatio!).toBeGreaterThan(late.wastedRatio!);
  });

  test("断在 system 静态区 → 几乎整条前缀作废", () => {
    const msgs = Array.from({ length: 5 }, (_, i) => ({ t: `m${i}` }));
    const d = diagnosePrefixBreak(fp("A".repeat(1000), TOOLS, msgs), fp("B".repeat(1000), TOOLS, msgs));
    expect(d.wastedRatio!).toBeGreaterThan(0.9);
  });
});

describe("P1-2 追踪器：首轮无可比对象，不谎报健康", () => {
  test("首轮返回 null（而非 broken=false）", () => {
    const t = new PrefixBreakTracker();
    // 落一条"未断裂"会让分母虚高，把"首轮"混进"健康轮次"
    expect(t.observe(fp("SYS", TOOLS, [{ t: 1 }]))).toBeNull();
  });

  test("第二轮起给出结论，且只与相邻上一轮比对", () => {
    const t = new PrefixBreakTracker();
    t.observe(fp("SYS", TOOLS, [{ t: 1 }]));
    // 尾部追加 → 健康
    expect(t.observe(fp("SYS", TOOLS, [{ t: 1 }, { t: 2 }]))!.broken).toBe(false);
    // 改写第 0 条 → 断裂
    const d = t.observe(fp("SYS", TOOLS, [{ t: "X" }, { t: 2 }]))!;
    expect(d.broken).toBe(true);
    expect(d.firstChangedMessageIndex).toBe(0);
  });

  test("reset 后不与旧会话前缀比对", () => {
    const t = new PrefixBreakTracker();
    t.observe(fp("SYS-OLD", TOOLS, [{ t: 1 }]));
    t.reset();
    // 新会话首轮若与旧会话比对，会被记成一次巨大断裂
    expect(t.observe(fp("SYS-NEW", TOOLS, [{ t: 9 }]))).toBeNull();
  });
});

/**
 * 聚合侧（digest）：分布要能直接读出"该改哪里"。
 *
 * 关键是**按浪费比例排序而非按次数** —— 断在第 2 条消息与第 200 条都算 1 次，
 * 但作废的前缀量差两个数量级，只看次数会把优化力气用错地方。
 */
describe("P1-2 聚合：断裂分布", () => {
  const ev = (data: Record<string, unknown>) => ({ event: "prefix_break", data });

  test("无事件返回 null（老会话与「全健康」要分得开）", () => {
    expect(aggregatePrefixBreakStats([])).toBeNull();
    expect(aggregatePrefixBreakStats([{ event: "other", data: {} }])).toBeNull();
  });

  test("首轮不计入分母：只统计有可比对象的轮次", () => {
    // 埋点侧首轮就不落事件，所以聚合看到的每条都是"已比较过"的
    const s = aggregatePrefixBreakStats([
      ev({ index: 2, broken: false }),
      ev({ index: 3, broken: false }),
    ])!;
    expect(s.comparedTurns).toBe(2);
    expect(s.brokenTurns).toBe(0);
    expect(s.brokenRate).toBe(0);
  });

  test("按段类型分组，给平均与最差浪费比例", () => {
    const s = aggregatePrefixBreakStats([
      ev({ index: 2, broken: true, first_changed_kind: "message", first_changed_message_index: 5, wasted_ratio: 0.2 }),
      ev({ index: 3, broken: true, first_changed_kind: "message", first_changed_message_index: 2, wasted_ratio: 0.8 }),
      ev({ index: 4, broken: true, first_changed_kind: "system_dynamic", wasted_ratio: 0.05 }),
      ev({ index: 5, broken: false }),
    ])!;
    expect(s.comparedTurns).toBe(4);
    expect(s.brokenTurns).toBe(3);
    expect(s.byKind.message!.count).toBe(2);
    expect(s.byKind.message!.avgWastedRatio).toBeCloseTo(0.5, 6);
    expect(s.byKind.message!.maxWastedRatio).toBeCloseTo(0.8, 6);
    // 最早断点是最贵的那次，要单独点出来
    expect(s.earliestBrokenMessageIndex).toBe(2);
  });

  test("平均浪费只在断裂轮次上取，不被健康轮次稀释", () => {
    const s = aggregatePrefixBreakStats([
      ev({ index: 2, broken: true, first_changed_kind: "tools", wasted_ratio: 0.6 }),
      ev({ index: 3, broken: false }),
      ev({ index: 4, broken: false }),
    ])!;
    // 若把 3 轮当分母会得到 0.2，读起来像"断裂不严重"
    expect(s.avgWastedRatio).toBeCloseTo(0.6, 6);
    expect(s.brokenRate).toBeCloseTo(1 / 3, 6);
  });
});

describe("P1-2 健壮性：埋点绝不因异常数据抛错", () => {
  test("循环引用的消息降级处理，不抛错", () => {
    const cyclic: any = { r: "u" };
    cyclic.self = cyclic;
    expect(() => fp("SYS", TOOLS, [cyclic])).not.toThrow();
  });

  test("system 缺失 / 空消息列表", () => {
    const d = diagnosePrefixBreak(fp(undefined, TOOLS, []), fp(undefined, TOOLS, []));
    expect(d.broken).toBe(false);
  });
});
