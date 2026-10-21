/**
 * stall-escalation 纯函数单测（评估会话 ce7ea52e 发现 2a/2c/2d）
 *
 * 锁的是「判据边界」，不是行为描述：每条断言对应一个误伤面或一条设计铁律
 * （L2 只能从 L1 升、回退单独不升级、hash 回退/绿点回归只喂 L1、headless 默认关）。
 */

import { describe, test, expect } from "bun:test";
import {
  resolveStallSwitches,
  createStallState,
  observeStallTurn,
  parseTestVerdict,
  hashContent,
  workspaceStateHash,
  buildStallL1Message,
  STALL_WINDOW_TURNS,
  STALL_L2_AFTER_L1_TURNS,
  type StallState,
  type StallTurnObservation,
} from "@sid-code/core/query/stall-escalation.ts";

/** 默认一个「什么都没发生」的工具轮；按需覆盖字段。 */
function turn(over: Partial<StallTurnObservation> = {}): StallTurnObservation {
  return {
    mutatedFiles: [],
    rehashedFiles: [],
    bashOutputs: [],
    unchangedReports: 0,
    oscillations: 0,
    ...over,
  };
}

/** 空转 n 轮（无改动），可附带每轮的覆盖。返回最后一轮的决策。 */
function idle(s: StallState, n: number, over: Partial<StallTurnObservation> = {}, hard = false) {
  let last: ReturnType<typeof observeStallTurn> = { level: 0 };
  for (let i = 0; i < n; i++) last = observeStallTurn(s, turn(over), hard);
  return last;
}

/**
 * 先把 /a 的 A、B 两个状态登记进 seenStates（这两轮是新状态，会复位停滞窗口），
 * 之后在 A↔B 间来回改就全是「回退」——这才是「没有新状态但一直在改」的真实形态。
 * 不先登记的话，窗口会被前两轮的新状态复位，导致后面的断言因为别的原因变绿（空转的绿）。
 */
function seedAB(s: StallState) {
  observeStallTurn(s, turn({ mutatedFiles: [{ path: "/a", content: "A" }] }), false);
  observeStallTurn(s, turn({ mutatedFiles: [{ path: "/a", content: "B" }] }), false);
}

describe("resolveStallSwitches：开关优先级", () => {
  test("交互模式缺省：启用 + 影子（不真停）", () => {
    expect(resolveStallSwitches(false, undefined, {})).toEqual({ enabled: true, hardStop: false });
  });

  test("headless 缺省整套不开（评测基线可比性依赖行为不变）", () => {
    expect(resolveStallSwitches(true, true, {})).toEqual({ enabled: false, hardStop: false });
  });

  test("headless 显式 opt-in 才启用", () => {
    expect(
      resolveStallSwitches(true, undefined, { SID_CODE_STALL_ESCALATION_HEADLESS: "1" }),
    ).toEqual({
      enabled: true,
      hardStop: false,
    });
  });

  test("SID_CODE_STALL_ESCALATION=0 一键全关，即使 hardStop 已开", () => {
    expect(
      resolveStallSwitches(false, true, {
        SID_CODE_STALL_ESCALATION: "0",
        SID_CODE_STALL_HARD_STOP: "1",
      }),
    ).toEqual({ enabled: false, hardStop: false });
  });

  test("hardStop：env 优先于 settings（两个方向都要）", () => {
    expect(resolveStallSwitches(false, false, { SID_CODE_STALL_HARD_STOP: "1" }).hardStop).toBe(
      true,
    );
    expect(resolveStallSwitches(false, true, { SID_CODE_STALL_HARD_STOP: "0" }).hardStop).toBe(
      false,
    );
    expect(resolveStallSwitches(false, true, {}).hardStop).toBe(true);
  });

  test("env 只认字面 1/0：true / yes 不生效（不被宽松解析误打开强停）", () => {
    expect(
      resolveStallSwitches(false, undefined, { SID_CODE_STALL_HARD_STOP: "true" }).hardStop,
    ).toBe(false);
    expect(
      resolveStallSwitches(true, undefined, { SID_CODE_STALL_ESCALATION_HEADLESS: "yes" }).enabled,
    ).toBe(false);
  });
});

describe("parseTestVerdict：绿点只认窄口径，解析不了就不判", () => {
  test("bun test 汇总行：全绿 / 有失败", () => {
    expect(parseTestVerdict(" 40 pass\n 0 fail\n 97 expect() calls\n")).toBe(true);
    expect(parseTestVerdict(" 38 pass\n 2 fail\n")).toBe(false);
  });

  test("缺一行 / 0 pass / 格式不同 ⇒ undefined（宁可少判，不误判）", () => {
    expect(parseTestVerdict(" 40 pass\n")).toBeUndefined();
    expect(parseTestVerdict(" 0 pass\n 0 fail\n")).toBeUndefined();
    expect(parseTestVerdict("Tests: 12 passed, 0 failed")).toBeUndefined();
    expect(parseTestVerdict("")).toBeUndefined();
  });

  test("行内出现 pass/fail 字样不算（行首锚定，防日志里的 'test pass' 误判）", () => {
    expect(parseTestVerdict("the 3 pass of review\nand 0 fail ok")).toBeUndefined();
  });
});

describe("工作区账本（2a）：flow 判据", () => {
  test("hash 对内容敏感、对键序不敏感", () => {
    expect(hashContent("a")).not.toBe(hashContent("b"));
    expect(hashContent(null)).toBeNull();
    const m1 = new Map<string, string | null>([
      ["a", "1"],
      ["b", "2"],
    ]);
    const m2 = new Map<string, string | null>([
      ["b", "2"],
      ["a", "1"],
    ]);
    expect(workspaceStateHash(m1)).toBe(workspaceStateHash(m2));
  });

  test("持续产生新状态 ⇒ 永不停滞（大重构不被误伤）", () => {
    const s = createStallState(0);
    for (let i = 0; i < 60; i++) {
      const d = observeStallTurn(
        s,
        turn({ mutatedFiles: [{ path: "/a.ts", content: `v${i}` }] }),
        true,
      );
      expect(d.level).toBe(0);
    }
    expect(s.rollbacks).toBe(0);
  });

  test("改回历史状态记回退，不算新状态", () => {
    const s = createStallState(0);
    observeStallTurn(s, turn({ mutatedFiles: [{ path: "/a.ts", content: "A" }] }), false); // 新
    observeStallTurn(s, turn({ mutatedFiles: [{ path: "/a.ts", content: "B" }] }), false); // 新
    const newBefore = s.lastNewStateTurn;
    observeStallTurn(s, turn({ mutatedFiles: [{ path: "/a.ts", content: "A" }] }), false); // 回退
    expect(s.rollbacks).toBe(1);
    expect(s.lastNewStateTurn).toBe(newBefore);
  });

  test("bash 改回已登记文件（rehash）也算回退——否则「用 sed 改回去」对 hash 判据是盲的", () => {
    const s = createStallState(0);
    observeStallTurn(s, turn({ mutatedFiles: [{ path: "/a.ts", content: "A" }] }), false);
    observeStallTurn(s, turn({ mutatedFiles: [{ path: "/a.ts", content: "B" }] }), false);
    observeStallTurn(s, turn({ rehashedFiles: [{ path: "/a.ts", content: "A" }] }), false);
    expect(s.rollbacks).toBe(1);
  });

  test("rehash 只更新已登记文件，不凭空登记新文件", () => {
    const s = createStallState(0);
    observeStallTurn(
      s,
      turn({ rehashedFiles: [{ path: "/never-edited.ts", content: "x" }] }),
      false,
    );
    expect(s.fileHashes.has("/never-edited.ts")).toBe(false);
  });

  test("删除文件也是一种状态（content=null）", () => {
    const s = createStallState(0);
    observeStallTurn(s, turn({ mutatedFiles: [{ path: "/a.ts", content: "A" }] }), false);
    const before = s.seenStates.size;
    observeStallTurn(s, turn({ mutatedFiles: [{ path: "/a.ts", content: null }] }), false);
    expect(s.seenStates.size).toBe(before + 1);
  });
});

describe("绿点账本（2c）", () => {
  const GREEN = " 10 pass\n 0 fail\n";
  const RED = " 8 pass\n 2 fail\n";

  test("绿 → 红记一次回归；一直红不重复计；红 → 绿 → 红再计一次", () => {
    const s = createStallState(0);
    observeStallTurn(s, turn({ bashOutputs: [GREEN] }), false);
    expect(s.lastGreen?.turn).toBe(1);
    observeStallTurn(s, turn({ bashOutputs: [RED] }), false);
    expect(s.greenRegressions).toBe(1);
    observeStallTurn(s, turn({ bashOutputs: [RED] }), false);
    expect(s.greenRegressions).toBe(1);
    observeStallTurn(s, turn({ bashOutputs: [GREEN] }), false);
    observeStallTurn(s, turn({ bashOutputs: [RED] }), false);
    expect(s.greenRegressions).toBe(2);
  });

  test("从没见过绿就红 ⇒ 不是回归", () => {
    const s = createStallState(0);
    observeStallTurn(s, turn({ bashOutputs: [RED] }), false);
    expect(s.greenRegressions).toBe(0);
  });

  test("解析不了的输出既不置绿也不打断绿", () => {
    const s = createStallState(0);
    observeStallTurn(s, turn({ bashOutputs: [GREEN] }), false);
    observeStallTurn(s, turn({ bashOutputs: ["make: done"] }), false);
    expect(s.lastTestGreen).toBe(true);
  });
});

describe("振荡计数增量（2b 会话级计数 → 本消息内）", () => {
  test("只取正增量：换清单清零后重新累积的部分不丢、也不出负数", () => {
    const s = createStallState(5); // 进入本消息时会话级已是 5
    observeStallTurn(s, turn({ oscillations: 5 }), false);
    expect(s.oscillationsInPrompt).toBe(0); // 5 是进入前的，不算本消息
    observeStallTurn(s, turn({ oscillations: 7 }), false);
    expect(s.oscillationsInPrompt).toBe(2);
    observeStallTurn(s, turn({ oscillations: 0 }), false); // 换清单：那边清零
    expect(s.oscillationsInPrompt).toBe(2); // 不出负数
    observeStallTurn(s, turn({ oscillations: 3 }), false); // 清零后重新累积 3 次
    expect(s.oscillationsInPrompt).toBe(5);
  });
});

describe("升级阶梯（2d）：L1 → L2", () => {
  test("窗口不满不升级（信号再多也不行）", () => {
    const s = createStallState(0);
    const d = idle(s, STALL_WINDOW_TURNS - 1, { unchangedReports: 1 });
    expect(d.level).toBe(0);
  });

  test("窗口满 + 信号够 ⇒ L1，且只发一次", () => {
    const s = createStallState(0);
    // 3 个确证信号分摊在窗口里
    idle(s, 3, { unchangedReports: 1 });
    const d = idle(s, STALL_WINDOW_TURNS - 3);
    expect(d.level).toBe(1);
    if (d.level === 1) {
      expect(d.signals.unchangedReports).toBe(3);
      expect(d.message).toContain("收敛提示");
      expect(d.message).toContain("<system-reminder>");
    }
    // L1 发出后紧接着的轮次不再重复 L1
    expect(observeStallTurn(s, turn(), false).level).toBe(0);
  });

  test("回退单独不构成 L1：回退再多，没有非回退信号也不升", () => {
    const s = createStallState(0);
    seedAB(s);
    // 窗口内只有 A↔B 来回（全是回退），没有任何振荡 / 空转 / 绿点回归
    let last: ReturnType<typeof observeStallTurn> = { level: 0 };
    for (let i = 0; i < STALL_WINDOW_TURNS + 5; i++) {
      last = observeStallTurn(
        s,
        turn({ mutatedFiles: [{ path: "/a", content: i % 2 ? "B" : "A" }] }),
        true,
      );
    }
    // 非空转的证据：窗口确实满了、回退确实够多，挡住 L1 的只能是「回退不单独构成理由」
    expect(s.toolTurns - s.lastNewStateTurn).toBeGreaterThanOrEqual(STALL_WINDOW_TURNS);
    expect(s.rollbacks).toBeGreaterThanOrEqual(STALL_WINDOW_TURNS);
    expect(last.level).toBe(0);
    expect(s.l1Turn).toBeUndefined();
  });

  test("L2 不能直接跳：没发过 L1 之前，信号再多也只会先 L1", () => {
    const s = createStallState(0);
    const d = idle(s, STALL_WINDOW_TURNS, { unchangedReports: 1, oscillations: 0 }, true);
    expect(d.level).toBe(1);
    expect(s.l2Count).toBe(0);
  });

  test("L1 后不满 K 轮不升 L2；满 K 轮且无新改动 ⇒ L2（影子 acted=false）", () => {
    const s = createStallState(0);
    idle(s, STALL_WINDOW_TURNS, { unchangedReports: 1 }); // 触发 L1
    expect(s.l1Turn).toBeDefined();
    expect(idle(s, STALL_L2_AFTER_L1_TURNS - 1).level).toBe(0);
    const d = idle(s, 1, {}, false);
    expect(d.level).toBe(2);
    if (d.level === 2) expect(d.acted).toBe(false); // 影子
  });

  test("hardStop 打开 ⇒ L2 acted=true", () => {
    const s = createStallState(0);
    idle(s, STALL_WINDOW_TURNS, { unchangedReports: 1 }, true);
    const d = idle(s, STALL_L2_AFTER_L1_TURNS, {}, true);
    expect(d.level).toBe(2);
    if (d.level === 2) expect(d.acted).toBe(true);
  });

  test("hash 回退 / 绿点回归只喂 L1，不能触发 L2（未经验证的判据不许强停）", () => {
    const s = createStallState(0);
    seedAB(s);
    idle(s, STALL_WINDOW_TURNS, { unchangedReports: 1 }, true); // L1
    expect(s.l1Turn).toBeDefined();
    // L1 之后：文件在 A↔B 间一直改（有 mutation，所以不是「无新改动」）+ 绿↔红回归，
    // 但没有任何新的 2b 振荡 / 空转
    for (let i = 0; i < STALL_L2_AFTER_L1_TURNS * 3; i++) {
      const d = observeStallTurn(
        s,
        turn({
          mutatedFiles: [{ path: "/a", content: i % 2 ? "A" : "B" }],
          bashOutputs: [i % 2 ? " 5 pass\n 0 fail\n" : " 4 pass\n 1 fail\n"],
        }),
        true,
      );
      expect(d.level).not.toBe(2);
    }
    // 非空转的证据：停滞窗口一直是满的，挡住 L2 的只能是「回退/回归不算确证信号」
    expect(s.toolTurns - s.lastNewStateTurn).toBeGreaterThanOrEqual(STALL_WINDOW_TURNS);
    expect(s.rollbacks).toBeGreaterThan(5);
    expect(s.greenRegressions).toBeGreaterThan(5);
    expect(s.l2Count).toBe(0);
  });

  test("L1 后出现新的确证信号（空转/振荡）⇒ 即使仍在改文件也升 L2", () => {
    const s = createStallState(0);
    seedAB(s);
    idle(s, STALL_WINDOW_TURNS, { unchangedReports: 1 }, true); // L1
    expect(s.l1Turn).toBeDefined();
    let d: ReturnType<typeof observeStallTurn> = { level: 0 };
    for (let i = 0; i < STALL_L2_AFTER_L1_TURNS; i++) {
      d = observeStallTurn(
        s,
        turn({
          mutatedFiles: [{ path: "/a", content: i % 2 ? "A" : "B" }],
          oscillations: i === 3 ? 1 : 0,
        }),
        true,
      );
    }
    expect(d.level).toBe(2);
  });

  test("同一条消息内第二次 L2 阈值翻倍", () => {
    const s = createStallState(0);
    idle(s, STALL_WINDOW_TURNS, { unchangedReports: 1 }, true);
    expect(idle(s, STALL_L2_AFTER_L1_TURNS, {}, false).level).toBe(2); // 第一次（影子，不停）
    expect(s.l2Count).toBe(1);
    // 再过 K 轮：翻倍后需要 2K，不该再升
    expect(idle(s, STALL_L2_AFTER_L1_TURNS, {}, false).level).toBe(0);
    expect(idle(s, STALL_L2_AFTER_L1_TURNS, {}, false).level).toBe(2); // 满 2K
    expect(s.l2Count).toBe(2);
  });

  test("新状态出现 ⇒ 停滞计数复位（用户/模型真的在推进就不打扰）", () => {
    const s = createStallState(0);
    idle(s, STALL_WINDOW_TURNS - 1, { unchangedReports: 1 });
    observeStallTurn(s, turn({ mutatedFiles: [{ path: "/x", content: "new" }] }), false);
    expect(idle(s, STALL_WINDOW_TURNS - 2, { unchangedReports: 1 }).level).toBe(0);
  });
});

describe("文案", () => {
  test("L1 文案点出绿点位置；没见过绿则明说", () => {
    const s = createStallState(0);
    const sig = {
      turnsSinceNewState: 15,
      oscillations: 2,
      unchangedReports: 1,
      rollbacks: 4,
      greenRegressions: 1,
      toolTurns: 20,
      l2Count: 0,
    };
    expect(buildStallL1Message(s, sig)).toContain("还没有观察到一次全绿");
    s.lastGreen = { turn: 7, stateHash: "abcdef0123456789" };
    const msg = buildStallL1Message(s, sig);
    expect(msg).toContain("第 7 个工具轮");
    expect(msg).toContain("abcdef01");
  });
});
