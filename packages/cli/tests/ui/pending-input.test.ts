/**
 * A4：中断输入暂存模块 — 单元测试
 *
 * 锁定回填状态机的行为契约：
 *   - stash 后未 arm → 不回填
 *   - stash + markForRestore → 回填一次,消费后清空
 *   - clearPendingInput → 丢弃,不回填
 *   - 无 stash 时 markForRestore → no-op
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  stashPendingInput,
  markForRestore,
  consumePendingRestore,
  clearPendingInput,
  canRestoreCanceledInput,
  isTurnUnanswered,
  onRestoreArmed,
  markRetractable,
  hasRetractableFailedTurn,
  setFailedTurnRetractor,
  retractFailedTurn,
} from "@sid-code/cli/ui/pending-input.ts";

describe("A4 — pending-input 状态机", () => {
  beforeEach(() => {
    // 每个用例前清空模块级状态（模块单例,需隔离）
    clearPendingInput();
  });

  test("仅 stash、未 markForRestore → consume 返回 null（正常完成不回填）", () => {
    stashPendingInput("写个 hello", false);
    expect(consumePendingRestore()).toBeNull();
  });

  test("stash + markForRestore → consume 返回原文,且只返回一次", () => {
    stashPendingInput("写个 hello", false);
    markForRestore();
    const r = consumePendingRestore();
    expect(r).not.toBeNull();
    expect(r!.text).toBe("写个 hello");
    expect(r!.shellMode).toBe(false);
    // 第二次消费应为 null（已清空）
    expect(consumePendingRestore()).toBeNull();
  });

  test("shellMode 标志透传", () => {
    stashPendingInput("ls -la", true);
    markForRestore();
    const r = consumePendingRestore();
    expect(r!.shellMode).toBe(true);
  });

  test("clearPendingInput 后即使之前 arm 过也不回填", () => {
    stashPendingInput("x", false);
    markForRestore();
    clearPendingInput();
    expect(consumePendingRestore()).toBeNull();
  });

  test("无 stash 时 markForRestore 安全 no-op", () => {
    markForRestore(); // 没有 pending,不应抛错也不应 arm
    expect(consumePendingRestore()).toBeNull();
  });

  test("新一轮 stash 会重置上一轮的 arm 状态（避免误回填旧输入）", () => {
    stashPendingInput("第一轮", false);
    markForRestore();
    // 用户又提交了新一轮（未取消）
    stashPendingInput("第二轮", false);
    // 此时未对第二轮 markForRestore → 不应回填
    expect(consumePendingRestore()).toBeNull();
  });
});

describe("A4 — canRestoreCanceledInput 回填守卫（对标 cc messagesAfterAreOnlySynthetic）", () => {
  test("末尾 user 消息之后无任何消息 → 可回填（请求刚发出即被取消）", () => {
    const msgs = [{ role: "user", content: [{ type: "text", text: "做点事" }] }];
    expect(canRestoreCanceledInput(msgs)).toBe(true);
  });

  test("user 之后有 tool_use/tool_result → 模型已收到消息并调了工具，不回填", () => {
    const msgs = [
      { role: "user", content: [{ type: "text", text: "跑个命令" }] },
      { role: "assistant", content: [{ type: "tool_use", text: undefined }] },
      { role: "user", content: [{ type: "tool_result", text: undefined }] },
    ];
    expect(canRestoreCanceledInput(msgs)).toBe(false);
  });

  test("user 之后有非空 assistant text → 已有实质响应,不回填", () => {
    const msgs = [
      { role: "user", content: [{ type: "text", text: "解释下闭包" }] },
      { role: "assistant", content: [{ type: "text", text: "闭包是指..." }] },
    ];
    expect(canRestoreCanceledInput(msgs)).toBe(false);
  });

  test("assistant 仅含空白 text → 模型已回应过，不回填", () => {
    const msgs = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "   " }] },
    ];
    expect(canRestoreCanceledInput(msgs)).toBe(false);
  });

  test("完全无 user 消息 → 不回填", () => {
    expect(canRestoreCanceledInput([])).toBe(false);
    expect(
      canRestoreCanceledInput([{ role: "assistant", content: [{ type: "text", text: "x" }] }]),
    ).toBe(false);
  });

  test("多轮对话:只看最后一条 user 之后的响应（更早的 assistant 文本不影响）", () => {
    const msgs = [
      { role: "user", content: [{ type: "text", text: "Q1" }] },
      { role: "assistant", content: [{ type: "text", text: "A1" }] },
      { role: "user", content: [{ type: "text", text: "Q2-被取消" }] },
      // Q2 之后无实质响应 → 可回填
    ];
    expect(canRestoreCanceledInput(msgs)).toBe(true);
  });
});

describe("A4 — isTurnUnanswered（本轮快照对比）", () => {
  const u1 = { role: "user", content: [{ type: "text", text: "Q1" }] };
  const a1 = { role: "assistant", content: [{ type: "text", text: "A1" }] };

  test("user 消息还没入 ctxMgr 就被取消（新增为空）→ 未送达", () => {
    // canRestoreCanceledInput 会误看上一轮的 Q1（其后有 A1 → false），快照对比才是对的。
    expect(isTurnUnanswered([u1, a1], [u1, a1])).toBe(true);
    expect(canRestoreCanceledInput([u1, a1])).toBe(false);
  });

  test("本轮只新增了 user 消息 → 未送达", () => {
    const u2 = { role: "user", content: [{ type: "text", text: "Q2" }] };
    expect(isTurnUnanswered([u1, a1], [u1, a1, u2])).toBe(true);
  });

  test("本轮新增了 assistant（哪怕只有 tool_use）→ 已送达", () => {
    const u2 = { role: "user", content: [{ type: "text", text: "Q2" }] };
    const tu = { role: "assistant", content: [{ type: "tool_use" }] };
    expect(isTurnUnanswered([u1, a1], [u1, a1, u2, tu])).toBe(false);
  });

  test("前缀被改写（user 合并进上一条）→ 回落结构性判定", () => {
    const merged = { role: "user", content: [...u1.content, { type: "text", text: "Q2" }] };
    expect(isTurnUnanswered([u1], [merged])).toBe(true);
  });
});

describe("A4 — onRestoreArmed（arm 晚于 loading→idle 边沿时的即时回填）", () => {
  beforeEach(() => clearPendingInput());

  test("markForRestore 同步通知订阅者，订阅者可立即消费原文", () => {
    let got: string | null = null;
    const off = onRestoreArmed(() => {
      got = consumePendingRestore()?.text ?? null;
    });
    stashPendingInput("原文", false);
    markForRestore();
    off();
    expect(got).toBe("原文");
    expect(consumePendingRestore()).toBeNull();
  });

  test("取消订阅后不再收到通知", () => {
    let calls = 0;
    const off = onRestoreArmed(() => calls++);
    off();
    stashPendingInput("x", false);
    markForRestore();
    expect(calls).toBe(0);
  });

  test("无暂存输入时 markForRestore 不通知", () => {
    let calls = 0;
    const off = onRestoreArmed(() => calls++);
    markForRestore();
    off();
    expect(calls).toBe(0);
  });
});

describe("A4 路径 B — 请求失败后空闲 ESC 撤回", () => {
  beforeEach(() => {
    clearPendingInput();
    setFailedTurnRetractor(null);
  });

  test("markRetractable + retractor 成功 → 返回原文并清空状态", () => {
    let retracted = 0;
    setFailedTurnRetractor(() => {
      retracted++;
      return true;
    });
    stashPendingInput("失败的那句", false);
    markRetractable();
    expect(hasRetractableFailedTurn()).toBe(true);
    expect(retractFailedTurn()?.text).toBe("失败的那句");
    expect(retracted).toBe(1);
    expect(hasRetractableFailedTurn()).toBe(false);
  });

  test("retractor 返回 false（现场已变）→ 不回填，状态清空", () => {
    setFailedTurnRetractor(() => false);
    stashPendingInput("x", false);
    markRetractable();
    expect(retractFailedTurn()).toBeNull();
    expect(hasRetractableFailedTurn()).toBe(false);
  });

  test("retractor 抛错 → 不回填、不外抛", () => {
    setFailedTurnRetractor(() => {
      throw new Error("boom");
    });
    stashPendingInput("x", false);
    markRetractable();
    expect(() => retractFailedTurn()).not.toThrow();
  });

  test("未注册 retractor → 不可撤回", () => {
    stashPendingInput("x", false);
    markRetractable();
    expect(hasRetractableFailedTurn()).toBe(false);
  });

  test("新一轮提交作废上一轮的可撤回状态", () => {
    setFailedTurnRetractor(() => true);
    stashPendingInput("旧", false);
    markRetractable();
    stashPendingInput("新", false);
    expect(hasRetractableFailedTurn()).toBe(false);
  });

  test("可撤回状态不会被 consumePendingRestore 误消费（两条路径互斥）", () => {
    setFailedTurnRetractor(() => true);
    stashPendingInput("x", false);
    markRetractable();
    expect(consumePendingRestore()).toBeNull();
    expect(hasRetractableFailedTurn()).toBe(true);
  });
});
