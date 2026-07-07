/**
 * 单测：无头模式事件格式化（静默-2/-3/-7 修复回归）
 *
 * 验证 headless（text/json 输出）路径不再静默丢弃 system/error、system/info
 * 及 tombstone/hook_blocked/max_turns/loop_detected/loop_recovery/context_warning，
 * 且重试进度文案不污染最终答案。
 */

import { describe, test, expect } from "bun:test";
import {
  classifyHeadlessStreamText,
  formatHeadlessEvent,
  RETRY_TEXT_PREFIX,
} from "../../src/sdk/headless-event-format.ts";
import type { QueryEngineEvent } from "../../src/query/types.ts";

describe("classifyHeadlessStreamText", () => {
  test("重试进度文案 → isRetryProgress，剥离前缀走 stderr", () => {
    const r = classifyHeadlessStreamText(`${RETRY_TEXT_PREFIX}正在重试 (2/4)…`);
    expect(r.isRetryProgress).toBe(true);
    if (r.isRetryProgress) {
      expect(r.stderr).toContain("正在重试 (2/4)");
      expect(r.stderr).not.toContain(RETRY_TEXT_PREFIX);
    }
  });

  test("普通文本 → 非重试进度（拼入正文）", () => {
    const r = classifyHeadlessStreamText("这是模型的正常输出");
    expect(r.isRetryProgress).toBe(false);
  });

  test("以重试文案为子串但不在开头 → 不误判", () => {
    const r = classifyHeadlessStreamText("答案里提到 [重试中] 这个词");
    expect(r.isRetryProgress).toBe(false);
  });
});

describe("formatHeadlessEvent", () => {
  test("system/error → stderr + 拼入正文兜底（静默-2 核心）", () => {
    const ev: QueryEngineEvent = { kind: "system", level: "error", text: "超时重试耗尽" };
    const out = formatHeadlessEvent(ev);
    expect(out).not.toBeNull();
    expect(out!.stderr).toContain("超时重试耗尽");
    // error 必须拼入正文，保证 JSON/纯文本消费者能看到"为什么停了"
    expect(out!.appendToBuffer).toContain("超时重试耗尽");
    expect(out!.appendToBuffer).toContain("[error]");
  });

  test("system/info → stderr（不进正文，静默-2）", () => {
    const ev: QueryEngineEvent = { kind: "system", level: "info", text: "预算耗尽，自动停止" };
    const out = formatHeadlessEvent(ev);
    expect(out!.stderr).toContain("预算耗尽");
    expect(out!.appendToBuffer).toBeUndefined();
  });

  test("system/warning → stderr", () => {
    const ev: QueryEngineEvent = { kind: "system", level: "warning", text: "空参数重试" };
    const out = formatHeadlessEvent(ev);
    expect(out!.stderr).toContain("空参数重试");
    expect(out!.appendToBuffer).toBeUndefined();
  });

  test("tombstone → 模型降级提示", () => {
    const ev: QueryEngineEvent = {
      kind: "tombstone",
      message: { role: "assistant", content: [] },
      reason: "downgrade",
    };
    const out = formatHeadlessEvent(ev);
    expect(out!.stderr).toContain("模型降级");
  });

  test("hook_blocked → 拦截提示（否则表现为什么都没发生）", () => {
    const ev: QueryEngineEvent = { kind: "hook_blocked", reason: "denied by policy" };
    const out = formatHeadlessEvent(ev);
    expect(out!.stderr).toContain("Hook 阻止执行");
    expect(out!.stderr).toContain("denied by policy");
  });

  test("max_turns → 轮次上限提示", () => {
    const out = formatHeadlessEvent({ kind: "max_turns", maxTurns: 30 });
    expect(out!.stderr).toContain("30");
  });

  test("loop_detected → 循环检测提示", () => {
    const out = formatHeadlessEvent({ kind: "loop_detected", detail: "repeat" });
    expect(out!.stderr).toContain("循环");
  });

  test("loop_recovery → 恢复尝试提示", () => {
    const out = formatHeadlessEvent({ kind: "loop_recovery", attempt: 1, maxAttempts: 3 });
    expect(out!.stderr).toContain("1/3");
  });

  test("context_warning → 上下文剩余提示", () => {
    const out = formatHeadlessEvent({ kind: "context_warning", remaining: 15 });
    expect(out!.stderr).toContain("15");
  });

  test("assistant_message / stream_text / done → null（由 streamBuffer 或主循环处理）", () => {
    expect(
      formatHeadlessEvent({
        kind: "assistant_message",
        message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
      }),
    ).toBeNull();
    expect(formatHeadlessEvent({ kind: "stream_text", text: "x" })).toBeNull();
    expect(formatHeadlessEvent({ kind: "done", turns: 1 })).toBeNull();
  });
});
