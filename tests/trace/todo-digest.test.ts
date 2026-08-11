/**
 * todo 实时性度量闭环单测（2026-08-02，方案 §8.3）
 *
 * 背景与 jit-digest 同构：三个 todo 事件（`TodoProgressAdvanced` /
 * `NoProgressNagInjected` / `LoopTransition:todo_gate_retry`）此前**只写不读** ——
 * events.jsonl 里有数据，digest 里没有出口，于是「todo 到底实时了没有」量不出来。
 * 那次排查只能靠 `progress/<id>.md` 被写过几次来间接反推，而那个文件本身当时还有
 * 「全完成不落盘」的缺口，两个不确定性叠一起，结论差点建在流沙上。
 *
 * 断言重点不是"函数能跑"，而是**五个口径不能算错**：
 *  1. 三类事件全无 → 返回 null（区分"没数据"与"零推进"）
 *  2. 只有 gate_retry / 只有回注也要出节（那是最坏信号，不能因缺 advance 就藏起来）
 *  3. total=0 时 advanceRatio 是 undefined 而非 0（"没建清单"≠"建了没推进"）
 *  4. 推进间隔按 absoluteTurn 算，缺该字段的老事件跳过（turn 会跨消息回绕出负数）
 *  5. 停滞深度要排除埋点里代表 Infinity 的 -1（否则最大值算成 -1）
 */
import { describe, it, expect } from "bun:test";
import { aggregateTodoStats } from "@sid-code/core/trace/digest.ts";

type Ev = { event?: string; data?: Record<string, unknown> };

/** 造一条 TodoProgressAdvanced */
function advance(opts: {
  writeVersion: number;
  total: number;
  completed: number;
  absoluteTurn?: number;
}): Ev {
  return {
    event: "TodoProgressAdvanced",
    data: {
      writeVersion: opts.writeVersion,
      total: opts.total,
      completed: opts.completed,
      unfinished: opts.total - opts.completed,
      ...(opts.absoluteTurn != null ? { absoluteTurn: opts.absoluteTurn } : {}),
    },
  };
}

/** 造一条 todo 通道的回注事件 */
function nag(opts: { turnsSinceLastTodoWrite: number; afterCompact?: boolean }): Ev {
  return {
    event: "NoProgressNagInjected",
    data: {
      kind: "todo",
      turnsSinceLastTodoWrite: opts.turnsSinceLastTodoWrite,
      turnsSinceLastReminder: 8,
      afterCompact: opts.afterCompact ?? false,
    },
  };
}

/** 造一条 end_turn todo gate 续命 */
function gateRetry(): Ev {
  return { event: "LoopTransition", data: { type: "todo_gate_retry", turn: 12 } };
}

describe("口径 1：无数据与有数据可区分", () => {
  it("三类事件全无 → null（老会话 / 整场没建过清单）", () => {
    expect(aggregateTodoStats([])).toBeNull();
    expect(
      aggregateTodoStats([
        { event: "BeforeModel", data: {} },
        { event: "jit_context", data: { hit: true } },
      ]),
    ).toBeNull();
  });

  it("其它通道的 NoProgressNagInjected 不算 todo（work-log 不该混进来）", () => {
    // work-log 通道走同一个事件名、靠 kind 区分。混算会让 todo 通道看起来比实际活跃。
    expect(
      aggregateTodoStats([
        { event: "NoProgressNagInjected", data: { kind: "work-log", nagCount: 1, cap: 2 } },
      ]),
    ).toBeNull();
  });

  it("LoopTransition 的其它 type 不算 gate 续命", () => {
    expect(
      aggregateTodoStats([{ event: "LoopTransition", data: { type: "tool_use", turn: 3 } }]),
    ).toBeNull();
  });
});

describe("口径 2：只有坏信号时仍要出节", () => {
  it("只有 gate_retry、零推进 → 出节且 advances=0（最坏信号不能藏）", () => {
    const s = aggregateTodoStats([gateRetry(), gateRetry()]);
    expect(s).not.toBeNull();
    expect(s!.advances).toBe(0);
    expect(s!.gateRetries).toBe(2);
    // 没有 advance 事件 → 拿不到清单规模，比值不可计算
    expect(s!.advanceRatio).toBeUndefined();
  });

  it("只有回注、零推进 → 出节（正是缺陷现场的形态：建完清单再不碰）", () => {
    const s = aggregateTodoStats([nag({ turnsSinceLastTodoWrite: 30 })]);
    expect(s!.advances).toBe(0);
    expect(s!.reminders).toBe(1);
    expect(s!.maxTurnsSinceWrite).toBe(30);
  });
});

describe("口径 3：advanceRatio 的分母与 undefined 语义", () => {
  it("推进 5 次 / 10 项 → 0.5（刚好压线）", () => {
    const evs = Array.from({ length: 5 }, (_, i) =>
      advance({ writeVersion: i + 1, total: 10, completed: i + 1, absoluteTurn: i * 3 }),
    );
    const s = aggregateTodoStats(evs)!;
    expect(s.advances).toBe(5);
    expect(s.total).toBe(10);
    expect(s.advanceRatio).toBe(0.5);
  });

  it("total=0 → advanceRatio 是 undefined，不是 0", () => {
    // "没建清单"无所谓实时性；"建了却没推进"才是缺陷。渲染层据此走灰色而非红色。
    const s = aggregateTodoStats([advance({ writeVersion: 1, total: 0, completed: 0 })])!;
    expect(s.total).toBe(0);
    expect(s.advanceRatio).toBeUndefined();
  });

  it("终态取最后一条 advance（不是首条，也不是最大值）", () => {
    // 清单可增删项，末条才是"会话结束时清单长什么样"
    const s = aggregateTodoStats([
      advance({ writeVersion: 1, total: 18, completed: 0 }),
      advance({ writeVersion: 2, total: 20, completed: 19 }),
      advance({ writeVersion: 3, total: 12, completed: 11 }),
    ])!;
    expect(s.total).toBe(12);
    expect(s.completed).toBe(11);
    expect(s.unfinished).toBe(1);
  });
});

describe("口径 4：推进间隔按 absoluteTurn，跨消息不算负数", () => {
  it("相邻 absoluteTurn 差就是间隔", () => {
    const s = aggregateTodoStats([
      advance({ writeVersion: 1, total: 3, completed: 0, absoluteTurn: 2 }),
      advance({ writeVersion: 2, total: 3, completed: 1, absoluteTurn: 9 }),
      advance({ writeVersion: 3, total: 3, completed: 2, absoluteTurn: 11 }),
    ])!;
    expect(s.advanceGaps).toEqual([7, 2]);
  });

  it("缺 absoluteTurn 的老事件被跳过，不用 turn 兜底", () => {
    // turn 每条用户消息回绕（turn=20 后可能出现 turn=3），混算会得出负间隔——
    // 那比"不算"更糟：负数会让读者以为时间倒流。
    const s = aggregateTodoStats([
      advance({ writeVersion: 1, total: 3, completed: 0 }), // 无 absoluteTurn
      advance({ writeVersion: 2, total: 3, completed: 1, absoluteTurn: 5 }),
      advance({ writeVersion: 3, total: 3, completed: 2, absoluteTurn: 8 }),
    ])!;
    expect(s.advanceGaps).toEqual([3]);
    expect(s.advanceGaps.every((g) => g >= 0)).toBe(true);
  });

  it("单次推进 → 无间隔可算（空数组，不是 [0]）", () => {
    const s = aggregateTodoStats([
      advance({ writeVersion: 1, total: 4, completed: 1, absoluteTurn: 3 }),
    ])!;
    expect(s.advanceGaps).toEqual([]);
  });
});

describe("口径 5：停滞深度排除 -1 哨兵值", () => {
  it("-1（埋点里代表 Infinity=从未写过清单）不参与最大值", () => {
    // loop.ts 把 Infinity 写成 -1。若不排除，Math.max 会把最大停滞算成 -1，
    // 反而显示得比真实情况"更健康"。
    const s = aggregateTodoStats([
      nag({ turnsSinceLastTodoWrite: -1 }),
      nag({ turnsSinceLastTodoWrite: 14 }),
      nag({ turnsSinceLastTodoWrite: 8 }),
    ])!;
    expect(s.maxTurnsSinceWrite).toBe(14);
  });

  it("全是 -1 → undefined（没有可用的停滞距离）", () => {
    const s = aggregateTodoStats([nag({ turnsSinceLastTodoWrite: -1 })])!;
    expect(s.maxTurnsSinceWrite).toBeUndefined();
  });

  it("压缩旁路回注单独计数（它不受阈值管辖，混算会高估通道活跃度）", () => {
    const s = aggregateTodoStats([
      nag({ turnsSinceLastTodoWrite: 10 }),
      nag({ turnsSinceLastTodoWrite: 2, afterCompact: true }),
      nag({ turnsSinceLastTodoWrite: 9 }),
    ])!;
    expect(s.reminders).toBe(3);
    expect(s.remindersAfterCompact).toBe(1);
  });
});

describe("缺陷现场回归：18 项全 pending、整场只推进 1 次", () => {
  it("复现 20260730-093706 的度量画像（实时性 6%，远低于 0.5 线）", () => {
    // 现场：模型建完 18 项清单后再没碰过，直到收尾被 gate 拦下。
    // 这一节的价值就在于：这种画像现在**一眼能看出来**，不用再去 grep events.jsonl
    // 或靠 progress 文件被写过几次来反推。
    const s = aggregateTodoStats([
      advance({ writeVersion: 1, total: 18, completed: 0, absoluteTurn: 3 }),
      nag({ turnsSinceLastTodoWrite: 11 }),
      nag({ turnsSinceLastTodoWrite: 19 }),
      nag({ turnsSinceLastTodoWrite: 27 }),
      gateRetry(),
      gateRetry(),
    ])!;
    expect(s.advances).toBe(1);
    expect(s.total).toBe(18);
    expect(s.advanceRatio).toBeCloseTo(1 / 18, 5);
    expect(s.advanceRatio!).toBeLessThan(0.5); // 触发渲染层的黄色告警线
    expect(s.unfinished).toBe(18);
    expect(s.reminders).toBe(3);
    expect(s.maxTurnsSinceWrite).toBe(27);
    expect(s.gateRetries).toBe(2);
  });

  it("健康画像对照：推进次数跟得上项数、gate 未触发", () => {
    const evs = Array.from({ length: 6 }, (_, i) =>
      advance({ writeVersion: i + 1, total: 6, completed: i + 1, absoluteTurn: i * 2 }),
    );
    const s = aggregateTodoStats(evs)!;
    expect(s.advanceRatio).toBe(1);
    expect(s.unfinished).toBe(0);
    expect(s.gateRetries).toBe(0);
    // 全部完成的终态也能被度量到（修复 5 的连锁：allDone 时展示清单为空但事实清单在）
    expect(s.completed).toBe(6);
  });
});
