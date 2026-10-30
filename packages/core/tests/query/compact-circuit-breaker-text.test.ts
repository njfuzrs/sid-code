/**
 * 回归：压缩失败熔断文案要区分「常驻上下文自己超窗」与「历史压不动」。
 *
 * 事故：系统提示词 ~89 万 token（窗口约 100 万），用户一句「你好」就熔断，却被告知
 * 「连续 3 次自动压缩都未能减少历史，建议 /compact」——压缩只动消息历史，照做必然再失败。
 */

import { describe, test, expect } from "bun:test";
import { buildCompactCircuitBreakerText } from "@sid-code/core/query/loop.ts";
import { inferErrorCode, lookupErrorMessage } from "@sid-code/core/llm/error-messages.ts";
import { Manager } from "@sid-code/core/context/manager.ts";

describe("buildCompactCircuitBreakerText", () => {
  test("常驻开销逼近窗口：明说压缩救不了，不建议 /compact，指向 CLAUDE.md", () => {
    const text = buildCompactCircuitBreakerText(3, {
      // 事故现场数值：常驻 ~89 万，窗口 ~98 万（91%），历史只有一句「你好」
      fixedTokens: 894_748,
      totalTokens: 894_800,
      memoryTokens: 887_400,
      maxTokens: 983_000,
    });
    expect(text).toContain("压缩无法解决");
    expect(text).toContain("CLAUDE.md");
    expect(text).not.toContain("建议手动执行 /compact");
    // 错误面板走专用码，建议里不再出现 /compact 引导
    const code = inferErrorCode(text);
    expect(code).toBe("context_fixed_overflow");
    expect(lookupErrorMessage(text, code).suggestion).toContain("/compact 和开新会话都无法解决");
  });

  test("常驻开销以工具定义为主时，不误指 CLAUDE.md", () => {
    const text = buildCompactCircuitBreakerText(3, {
      fixedTokens: 950_000,
      totalTokens: 960_000,
      memoryTokens: 1_000,
      maxTokens: 1_000_000,
    });
    expect(text).toContain("压缩无法解决");
    expect(text).not.toContain("其中 CLAUDE.md");
  });

  test("常驻开销正常：保留原「历史压不动 → /compact」文案与通用上下文溢出码", () => {
    const text = buildCompactCircuitBreakerText(3, {
      fixedTokens: 30_000,
      totalTokens: 210_000,
      memoryTokens: 5_000,
      maxTokens: 200_000,
    });
    expect(text).toContain("连续 3 次自动压缩都未能减少历史");
    expect(inferErrorCode(text)).toBe("context_overflow");
  });

  test("判据看「常驻占总量」而非「占窗口」：常驻只占窗口 60% 但历史为空也判救不了", () => {
    // 估算偏低时（未校准），常驻占窗口比例可能远低于真实值，但 API 已实锤超窗
    const text = buildCompactCircuitBreakerText(3, {
      fixedTokens: 600_000,
      totalTokens: 600_100,
      memoryTokens: 590_000,
      maxTokens: 1_000_000,
    });
    expect(text).toContain("压缩无法解决");
  });

  test("第三态：本轮输入自己就超窗——不建议 /compact，指向缩小输入，走专用码", () => {
    const text = buildCompactCircuitBreakerText(3, {
      // 事故现场：@ 误命中 78MB 二进制，单条 user 消息估算 4500 万 token
      fixedTokens: 30_000,
      totalTokens: 45_455_094,
      memoryTokens: 5_000,
      maxTokens: 1_000_000,
      latestUserInputTokens: 45_425_094,
    });
    expect(text).toContain("本轮输入本身约 45425K tokens");
    expect(text).toContain("压缩无法缩短本轮输入");
    expect(text).not.toContain("建议手动执行 /compact");
    const code = inferErrorCode(text);
    expect(code).toBe("context_input_overflow");
    expect(lookupErrorMessage(text, code).suggestion).toContain("/compact 压不掉它");
  });

  test("长历史 + 中等输入：仍判「历史压不动」，不误判成输入问题", () => {
    const text = buildCompactCircuitBreakerText(3, {
      fixedTokens: 30_000,
      totalTokens: 1_100_000,
      memoryTokens: 5_000,
      maxTokens: 1_000_000,
      latestUserInputTokens: 200_000,
    });
    expect(text).toContain("连续 3 次自动压缩都未能减少历史");
    expect(inferErrorCode(text)).toBe("context_overflow");
  });

  test("短会话：输入占总量大半但远小于窗口，不能说「本轮输入本身超窗」", () => {
    // 历史只有一条时最新输入天然占总量大半；此前只看比例会报「本轮输入本身约 0K tokens」
    const text = buildCompactCircuitBreakerText(3, {
      fixedTokens: 100,
      totalTokens: 600,
      memoryTokens: 0,
      maxTokens: 1_000_000,
      latestUserInputTokens: 500,
    });
    expect(inferErrorCode(text)).toBe("context_overflow");
  });

  test("常驻超窗优先于输入判定：两者都大时指向常驻内容", () => {
    const text = buildCompactCircuitBreakerText(3, {
      fixedTokens: 900_000,
      totalTokens: 1_000_000,
      memoryTokens: 800_000,
      maxTokens: 1_000_000,
      latestUserInputTokens: 600_000,
    });
    expect(inferErrorCode(text)).toBe("context_fixed_overflow");
  });
});

describe("Manager.estimateLatestUserInputTokens", () => {
  test("只计最新一条真实用户输入，排除常驻开销与 tool_result", () => {
    const mgr = new Manager({ maxTokens: 100_000 });
    mgr.setSystemPrompt("系统提示词".repeat(1000));
    mgr.addMessage({ role: "user", content: [{ type: "text", text: "早先的输入" }] });
    mgr.addMessage({ role: "assistant", content: [{ type: "text", text: "好" }] });
    const huge = "x".repeat(400_000);
    mgr.addMessage({ role: "user", content: [{ type: "text", text: huge }] });
    const n = mgr.estimateLatestUserInputTokens(0);
    // 常驻（系统提示词）被扣除：结果约等于单条大消息自身，而不是总量
    expect(n).toBeGreaterThan(50_000);
    expect(n).toBeLessThan(mgr.estimateTokens(0));
    expect(mgr.estimateTokens(0) - n).toBeGreaterThanOrEqual(
      mgr.estimateFixedOverheadTokens(0) - 1,
    );
  });

  test("末尾是纯 tool_result 的 user 消息时跳过它，取上一条真实输入", () => {
    const mgr = new Manager({ maxTokens: 100_000 });
    mgr.addMessage({ role: "user", content: [{ type: "text", text: "y".repeat(40_000) }] });
    mgr.addMessage({
      role: "assistant",
      content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }],
    });
    mgr.addMessage({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: "z".repeat(400_000) }],
    });
    const n = mgr.estimateLatestUserInputTokens(0);
    expect(n).toBeGreaterThan(5_000);
    expect(n).toBeLessThan(20_000);
  });

  test("没有用户消息时返回 0", () => {
    expect(new Manager({ maxTokens: 100_000 }).estimateLatestUserInputTokens(0)).toBe(0);
  });
});
