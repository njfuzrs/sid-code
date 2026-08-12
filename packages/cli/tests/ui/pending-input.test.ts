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

  test("user 之后只有 tool_use/tool_result（无 assistant 实质文本）→ 可回填", () => {
    const msgs = [
      { role: "user", content: [{ type: "text", text: "跑个命令" }] },
      { role: "assistant", content: [{ type: "tool_use", text: undefined }] },
      { role: "user", content: [{ type: "tool_result", text: undefined }] },
    ];
    expect(canRestoreCanceledInput(msgs)).toBe(true);
  });

  test("user 之后有非空 assistant text → 已有实质响应,不回填", () => {
    const msgs = [
      { role: "user", content: [{ type: "text", text: "解释下闭包" }] },
      { role: "assistant", content: [{ type: "text", text: "闭包是指..." }] },
    ];
    expect(canRestoreCanceledInput(msgs)).toBe(false);
  });

  test("assistant 仅含空白 text → 视为无实质响应,可回填", () => {
    const msgs = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "   " }] },
    ];
    expect(canRestoreCanceledInput(msgs)).toBe(true);
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
