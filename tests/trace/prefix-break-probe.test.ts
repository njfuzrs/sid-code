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

/**
 * P1-3 解锁条件：字符级判据。
 *
 * ## 为什么必须有这一层
 *
 * 上面那套段判据是 **message 级**的，而**服务端按 token 前缀匹配，不按 message 对象匹配**。
 * 判据与目标不在同一层，这道缝隙让 P1-3 的第一次尝试整体翻车（2026-08-09）：
 * 候选方案 A 把 ambient reminder 改走独立尾部消息，探针报 `msg[0]` 断裂 4→0、
 * 26 个测试全绿、机理讲得通 —— 真实命中率却降了最多 11.2pp，已整体回滚。
 * 根因是 OpenAI 族把多 text block `join("\n")` 成单 string，"独立 block"与
 * "独立 message"在 wire 上塌缩成同一串字节，理论收益为零；`msg[0]→0` 只是
 * 所有下标平移一位造成的**度量假象**。
 *
 * 所以这组用例的职责不是"覆盖新字段"，而是**锚死两层判据的分歧方向**：
 * 哪些形态下 message 级会高估、哪些会低估。下面两个 ★ 就是实测出的那两处。
 */
describe("P1-3 字符级判据（贴近计费口径）", () => {
  const SYS = "S".repeat(1000);

  test("分母是上一轮长度：纯尾部追加作废 0%（第一版把分母写成本轮，健康形态误报 2.91%）", () => {
    // 用本轮长度做分母会把新增内容算成"浪费"，而新增内容从未被缓存过。
    // 后果是每一轮正常请求都被标成"判据矛盾"，噪声淹没真信号。
    const d = diagnosePrefixBreak(
      fp(SYS, TOOLS, [{ r: "u", t: "AAAA" }]),
      fp(SYS, TOOLS, [{ r: "u", t: "AAAA" }, { r: "a", t: "BBBB" }]),
    );
    expect(d.broken).toBe(false);
    expect(d.charWastedRatio).toBe(0);
    expect(d.judgeDisagreement).toBe(false);
    // 共同前缀 == 上一轮全长，即"上轮建立的前缀全部仍可用"
    expect(d.commonPrefixChars).toBe(d.prevTotalChars);
  });

  test("完全不变 → 共同前缀 = 全长，作废 0%", () => {
    const msgs = [{ r: "u", t: "1" }];
    const d = diagnosePrefixBreak(fp(SYS, TOOLS, msgs), fp(SYS, TOOLS, msgs));
    expect(d.commonPrefixChars).toBe(d.prevTotalChars);
    expect(d.charWastedRatio).toBe(0);
  });

  test("首条改写 → 字符级与 message 级都报接近一半作废（两层一致）", () => {
    const d = diagnosePrefixBreak(
      fp(SYS, TOOLS, [{ r: "u", t: "AAAA" }, { r: "u", t: "B".repeat(900) }]),
      fp(SYS, TOOLS, [{ r: "u", t: "ZZZZ" }, { r: "u", t: "B".repeat(900) }]),
    );
    expect(d.broken).toBe(true);
    expect(d.charWastedRatio).toBeGreaterThan(0.4);
    // 两层判据方向一致 → 不算矛盾。这类形态下 message 级数字是可信的
    expect(d.judgeDisagreement).toBe(false);
  });

  test("★ reminder 滚动迁移：message 级高估约 4 倍（T4 那份分布就建在被高估的数上）", () => {
    // T4 实测的真实病灶：reminder 挂在"最后一条 user 消息"，而 tool_result 也是
    // role:"user"，于是锚点每轮后移 —— 上一轮加的 reminder 这一轮没了。
    // message 级把整条 msg[0] 之后全算作废；字符级只算真正变了的那几十字节。
    const d = diagnosePrefixBreak(
      fp(SYS, TOOLS, [
        { role: "user", content: [{ type: "text", text: "指令" }, { type: "text", text: "<reminder>" }] },
      ]),
      fp(SYS, TOOLS, [
        { role: "user", content: [{ type: "text", text: "指令" }] },
        { role: "assistant", content: "答" },
        { role: "user", content: [{ type: "text", text: "tr" }, { type: "text", text: "<reminder>" }] },
      ]),
    );
    expect(d.broken).toBe(true);
    // 两个数都不为 0，但差着数倍 —— 这就是"该修哪里"与"改了省多少"的口径差
    expect(d.wastedRatio!).toBeGreaterThan(d.charWastedRatio * 2);
    // 断言具体量级，防止将来某次改动悄悄把这个差距抹平却没人注意
    expect(d.charWastedRatio).toBeLessThan(0.1);
    expect(d.wastedRatio!).toBeGreaterThan(0.1);
  });

  test("★ compact 截短：message 级严重低估（2.9% vs 60.2%），字符级才反映真实作废", () => {
    // 历史被压缩成一条摘要。段级只看到"段数变少了"，wastedRatio 恒落 0 附近；
    // 而实际上整条前缀几乎全废 —— 这是段判据的盲区，且方向与上一条相反。
    // 两个方向都得有用例，只防上次踩过的那一个不够。
    const d = diagnosePrefixBreak(
      fp(SYS, TOOLS, [
        { r: "u", t: "A".repeat(500) },
        { r: "a", t: "B".repeat(500) },
        { r: "u", t: "C".repeat(500) },
      ]),
      fp(SYS, TOOLS, [{ r: "u", t: "摘要" }]),
    );
    expect(d.broken).toBe(true);
    expect(d.charWastedRatio).toBeGreaterThan(0.5);
    // message 级在这个形态下几乎无信息量（截短分支 wastedRatio 恒为 0）
    expect(d.wastedRatio!).toBeLessThan(0.1);
  });

  /**
   * ★★ 这是整组用例里最重要的一条：**离线复现 2026-08-09 回滚的那次假收益**，
   * 并断言字符级判据能把它标出来。
   *
   * 方案 A 做的事：把 ambient reminder 从"msg[0] 的第二个 text block"改成
   * "一条独立的尾部 message"。OpenAI 族把多 block `join("\n")` 成单 string，
   * 所以这两种形态在 wire 上**是同一串字节**，真实收益为零 —— 实测命中率反降 11.2pp。
   *
   * 但 message 级判据看到的是"content 数组从 2 元素变 1 元素、多出一个 message"，
   * 于是报出一个巨大的"改善"。这条用例锚死：**字符级必须看穿这个结构变化。**
   *
   * ⚠️ 也正因如此，`flattenTextForWire` 绝不能用 `JSON.stringify` ——
   * 那样字符级就只是把段判据的假象换个单位重演，这一层白加。
   */
  test("★★ 复现 P1-3 假收益：block 拆成独立 message → 字节没变，判据矛盾=true", () => {
    const long = "A".repeat(2000);
    // 修复前：reminder 是 msg[0] 的第二个 block
    const asBlocks = [
      { role: "user", content: [{ type: "text", text: long }, { type: "text", text: "<reminder>R</reminder>" }] },
    ];
    // 方案 A（已回滚）：reminder 改走独立尾部消息
    const asMsgs = [
      { role: "user", content: [{ type: "text", text: long }] },
      { role: "user", content: [{ type: "text", text: "<reminder>R</reminder>" }] },
    ];
    const d = diagnosePrefixBreak(fp(SYS, TOOLS, asBlocks), fp(SYS, TOOLS, asMsgs));

    // 段级：报大幅断裂（这就是当初被当成"改善"的那个数）
    expect(d.broken).toBe(true);
    expect(d.wastedRatio!).toBeGreaterThan(0.5);
    // 字符级：wire 字节几乎没动 —— 真实收益接近零
    expect(d.charWastedRatio).toBeLessThan(0.01);
    // 两层判据矛盾 → 该轮 message 级数字不可用于评估优化收益
    expect(d.judgeDisagreement).toBe(true);
    // 差距至少 50 倍：断言量级而非仅方向，防止将来某次改动把这个差距悄悄抹平
    expect(d.wastedRatio!).toBeGreaterThan(d.charWastedRatio * 50);
  });

  test("对照组：真实的中部插入（有实际字节）不该被标成矛盾", () => {
    // 与上一条形成对照 —— 判据矛盾必须是"结构变而字节未变"的专属信号，
    // 不能变成"只要段级报断裂就标矛盾"的噪声。
    const long = "A".repeat(2000);
    const d = diagnosePrefixBreak(
      fp(SYS, TOOLS, [{ role: "u", content: "x" }, { role: "u", content: long }]),
      fp(SYS, TOOLS, [
        { role: "u", content: "x" },
        { role: "y", content: "B".repeat(1000) },
        { role: "u", content: long },
      ]),
    );
    expect(d.broken).toBe(true);
    expect(d.charWastedRatio).toBeGreaterThan(0.01);
    expect(d.judgeDisagreement).toBe(false);
  });

  test("flattenTextForWire：block 拆分与不拆分产出同一串（复刻 OpenAI join 行为）", () => {
    // 直接锚死塌缩语义本身，而不只是通过 diagnose 间接验证。
    // 这条挂了说明 flattenTextForWire 被改回结构序列化了。
    const a = fp(SYS, TOOLS, [
      { role: "user", content: [{ type: "text", text: "前半" }, { type: "text", text: "后半" }] },
    ]);
    const b = fp(SYS, TOOLS, [
      { role: "user", content: [{ type: "text", text: "前半\n后半" }] },
    ]);
    // 段判据能区分（结构不同），字符级判据看不出差别（wire 相同）—— 这正是设计意图
    expect(diagnosePrefixBreak(a, b).broken).toBe(true);
    expect(diagnosePrefixBreak(a, b).charWastedRatio).toBe(0);
  });

  test("tool_result 形状（content 为字符串的块）也计入 wire 文本", () => {
    // 漏掉这类块会让共同前缀被高估 —— tool_result 在真实会话里占大头
    const a = fp(SYS, TOOLS, [{ role: "user", content: [{ type: "tool_result", content: "结果A".repeat(200) }] }]);
    const b = fp(SYS, TOOLS, [{ role: "user", content: [{ type: "tool_result", content: "结果B".repeat(200) }] }]);
    const d = diagnosePrefixBreak(a, b);
    // 内容真的变了 → 字符级必须察觉（若 tool_result 被跳过，这里会是 0）
    expect(d.charWastedRatio).toBeGreaterThan(0.1);
  });

  test("非常规形状退回结构序列化，不静默返回空串", () => {
    // 返回空串会让这条消息在字符级判据里"消失"，共同前缀凭空变长 → 假的零作废
    const a = fp(SYS, TOOLS, [{ role: "user" } as unknown]);
    const b = fp(SYS, TOOLS, [{ role: "assistant" } as unknown]);
    const d = diagnosePrefixBreak(a, b);
    expect(d.commonPrefixChars).toBeLessThan(d.prevTotalChars);
  });

  test("空前缀不产生除零 NaN", () => {
    const d = diagnosePrefixBreak(fp(undefined, "", []), fp(undefined, "", []));
    expect(Number.isNaN(d.charWastedRatio)).toBe(false);
    expect(d.charWastedRatio).toBe(0);
  });

  test("flat 不落盘契约：diagnosis 里没有任何原文字段", () => {
    // flat 含用户代码与对话内容。它只在内存里活到比较完，落盘的只能是长度数字。
    // 这条测试站在这里是因为"顺手把 flat 也 emit 出去"是极容易犯的错。
    const d = diagnosePrefixBreak(
      fp(SYS, TOOLS, [{ r: "u", t: "秘密内容" }]),
      fp(SYS, TOOLS, [{ r: "u", t: "秘密内容2" }]),
    );
    const serialized = JSON.stringify(d);
    expect(serialized).not.toContain("秘密内容");
    expect(Object.keys(d)).not.toContain("flat");
  });
});

describe("P1-3 字符级判据在 digest 聚合层", () => {
  test("字符级按全轮平均（含未断裂轮），与 avgWastedRatio 口径不同", () => {
    const stats = aggregatePrefixBreakStats([
      { event: "prefix_break", data: { broken: false, char_wasted_ratio: 0 } },
      { event: "prefix_break", data: { broken: false, char_wasted_ratio: 0 } },
      { event: "prefix_break", data: { broken: true, wasted_ratio: 0.4, first_changed_kind: "message", char_wasted_ratio: 0.2 } },
    ])!;
    // message 级只在 broken 轮平均 → 0.4
    expect(stats.avgWastedRatio).toBeCloseTo(0.4, 6);
    // 字符级在全部 3 轮平均 → 0.2/3
    expect(stats.avgCharWastedRatio).toBeCloseTo(0.2 / 3, 6);
    expect(stats.maxCharWastedRatio).toBeCloseTo(0.2, 6);
  });

  test("矛盾轮次可计数（> 0 时整会话的 message 级数字都不该用来评估收益）", () => {
    const stats = aggregatePrefixBreakStats([
      { event: "prefix_break", data: { broken: true, wasted_ratio: 0.5, first_changed_kind: "message", char_wasted_ratio: 0.001, judge_disagreement: true } },
      { event: "prefix_break", data: { broken: true, wasted_ratio: 0.5, first_changed_kind: "message", char_wasted_ratio: 0.4 } },
    ])!;
    expect(stats.disagreementTurns).toBe(1);
  });

  test("老轨迹（无字符级字段）记入 charJudgeMissingTurns，不拉低平均值", () => {
    // 把无该字段的轮次当分母会把平均值凭空拉低，读成"字节浪费很小"
    const stats = aggregatePrefixBreakStats([
      { event: "prefix_break", data: { broken: true, wasted_ratio: 0.3, first_changed_kind: "message" } },
      { event: "prefix_break", data: { broken: true, wasted_ratio: 0.3, first_changed_kind: "message", char_wasted_ratio: 0.6 } },
    ])!;
    expect(stats.charJudgeMissingTurns).toBe(1);
    // 分母是 1（只有一轮有数据），不是 2
    expect(stats.avgCharWastedRatio).toBeCloseTo(0.6, 6);
  });
});
