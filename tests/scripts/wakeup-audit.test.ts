/**
 * `scripts/wakeup-audit.ts` —— schedule_wakeup 轨迹回放判据
 *
 * ## 这个文件在防什么
 *
 * 这个脚本**是方案 20261107 §5.4 的验收工具**：F1（单链替换）+ F2（注入前判过期）到底
 * 有没有消灭多余唤醒，靠它给出的数字判断。它算错了没人会发现，只会有人照着结论说
 * 「修复无效」或「修复有效」。
 *
 * 2026-11-08 复核时实测到过一次这种错：判据建立在**旧实现的假设**上（每个 create 恰好
 * fire 一次），而 F1 让被替换的 create **永不 fire**。于是修复后的会话
 * `20261108-112039-9e3a681d`（真实序列 `create → Replace → create → fire`，无多余唤醒）
 * 被算成 `stale=1`、`max_pending=2` —— 恰好是 §5.4 要求的两条验收线（`stale=0`、
 * `max_pending ≤ 1`）都不达标，把正确行为判成了缺陷。
 *
 * ## 断言分两类
 *
 * A) **口径正确性**：`ScheduledReplace` 必须同时参与「有效 create 序列」与「pending 峰值」
 *    的推演；没有该事件的旧会话数字必须逐字不变（否则历史对比全部失真）。
 * B) **健壮性**：`replaced_count` 缺失 / 负数 / 非数字时按 0 处理，且 clamp 不让计数变负
 *    （负的 createSeq 会让后续 `fireIdx < createSeq - 1` 恒假，静默少报）。
 */

import { describe, test, expect } from "bun:test";
import { auditEvents } from "../../scripts/wakeup-audit.ts";

type Ev = { event?: string; data?: Record<string, unknown> };

/** 一次成功的 schedule_wakeup 创建（对应 PostToolUse 事件） */
function create(): Ev {
  return {
    event: "PostToolUse",
    data: { tool_name: "schedule_wakeup", is_error: false },
  };
}

/** 一次真的到点触发 */
function fire(taskId: string): Ev {
  return {
    event: "ScheduledFire",
    data: { task_id: taskId, origin: "schedule_wakeup", outcome: "fired" },
  };
}

/** 一次替换：新任务 taskId 顶掉了 replaced 里的旧任务 */
function replace(taskId: string, replaced: string[], count = replaced.length): Ev {
  return {
    event: "ScheduledReplace",
    data: { task_id: taskId, origin: "schedule_wakeup", replaced, replaced_count: count },
  };
}

describe("auditEvents · 旧会话口径不变（无 ScheduledReplace）", () => {
  test("单链 create → fire → create → fire：无 stale、峰值 1", () => {
    const a = auditEvents("s", [create(), fire("t1"), create(), fire("t2")]);
    expect(a.wakeup_creates).toBe(2);
    expect(a.wakeup_fires).toBe(2);
    expect(a.wakeup_stale_fires).toBe(0);
    expect(a.wakeup_stale_fires_literal).toBe(0);
    expect(a.max_pending_wakeups).toBe(1);
    expect(a.wakeup_replaced).toBe(0);
  });

  test("积压形态（20261107-095213-ff96d1f2）：5 create / 5 fire → stale=3、峰值=4", () => {
    // 事件形态照抄真实轨迹：一趟 create 后连续 fire，中间只有部分有 create
    const evs: Ev[] = [
      create(), // 1
      fire("a450"),
      create(), // 2
      create(), // 3
      create(), // 4
      create(), // 5
      fire("a825"),
      fire("e3c7"),
      fire("ad42"),
      fire("dcd5"),
    ];
    const a = auditEvents("s", evs);
    expect(a.wakeup_creates).toBe(5);
    expect(a.wakeup_fires).toBe(5);
    // 两套判据都得 3：第 5 个 create 建的任务是「最新那一个」，按判据不算 stale
    expect(a.wakeup_stale_fires).toBe(3);
    expect(a.wakeup_stale_fires_literal).toBe(3);
    expect(a.max_pending_wakeups).toBe(4);
  });
});

describe("auditEvents · F1 之后 ScheduledReplace 参与推演", () => {
  test("20261108-112039-9e3a681d 真实序列：create → Replace → create → fire → stale=0、峰值=1", () => {
    // 修复后的正确行为：第 2 次调用替换了第 1 次，只有最新那个真的 fire
    const evs: Ev[] = [create(), replace("5e6b9688", ["5b7e7729"]), create(), fire("5e6b9688")];
    const a = auditEvents("s", evs);
    expect(a.wakeup_creates).toBe(2);
    expect(a.wakeup_fires).toBe(1);
    expect(a.wakeup_replaced).toBe(1);
    // 这两条正是 §5.4 的验收线：替换不该让「唯一一次正常 fire」被判成多余
    expect(a.wakeup_stale_fires).toBe(0);
    expect(a.wakeup_stale_fires_literal).toBe(0);
    expect(a.max_pending_wakeups).toBe(1);
  });

  test("连续两次替换（3 次 create、只 fire 最后一个）：峰值仍为 1", () => {
    const evs: Ev[] = [
      create(),
      replace("t2", ["t1"]),
      create(),
      replace("t3", ["t2"]),
      create(),
      fire("t3"),
    ];
    const a = auditEvents("s", evs);
    expect(a.wakeup_creates).toBe(3);
    expect(a.wakeup_fires).toBe(1);
    expect(a.wakeup_replaced).toBe(2);
    expect(a.max_pending_wakeups).toBe(1);
    expect(a.wakeup_stale_fires).toBe(0);
  });

  test("替换掉的那个 create 不再占序号：后面的 fire 不会被误判 stale", () => {
    // 这是缺陷的原形——不处理 Replace 时，fireIdx=0 < createSeq-1=1 → 误报 stale
    const withReplace = auditEvents("s", [
      create(),
      replace("new", ["old"]),
      create(),
      fire("new"),
    ]);
    const withoutReplaceEvent = auditEvents("s", [create(), create(), fire("new")]);
    expect(withReplace.wakeup_stale_fires).toBe(0);
    // 同样的 create 数但没有 Replace 事件（旧实现）确实是积压，判 stale 是对的
    expect(withoutReplaceEvent.wakeup_stale_fires).toBe(1);
    expect(withoutReplaceEvent.max_pending_wakeups).toBe(2);
  });
});

describe("auditEvents · replaced_count 异常值健壮", () => {
  test("replaced_count 缺失 / 非数字 / 负数：按 0 处理，不把计数压成负数", () => {
    const evs: Ev[] = [
      create(),
      { event: "ScheduledReplace", data: { task_id: "t2", replaced: ["t1"] } }, // 缺 count
      { event: "ScheduledReplace", data: { replaced_count: "1" } }, // 非数字
      { event: "ScheduledReplace", data: { replaced_count: -5 } }, // 负数
      create(),
      fire("t2"),
    ];
    const a = auditEvents("s", evs);
    // 三次 Replace 都按 0 减，等价于没减；此时两个 create 一个 fire → 第二个 create
    // 是最新的，fire 早于它，按配对口径 stale=1、峰值=2（与旧实现一致）
    expect(a.wakeup_replaced).toBe(0);
    expect(a.max_pending_wakeups).toBe(2);
    expect(a.wakeup_stale_fires).toBe(1);
  });

  test("replaced_count 大于当前 pending 时 clamp 到 0，不产生负峰值", () => {
    // 坏数据形态：没 create 就来了一条 Replace(3)
    const evs: Ev[] = [replace("t9", ["t1", "t2", "t3"]), create(), fire("t9")];
    const a = auditEvents("s", evs);
    expect(a.max_pending_wakeups).toBe(1);
    expect(a.wakeup_stale_fires).toBe(0);
  });
});
