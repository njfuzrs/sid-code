/**
 * 回归：压缩失败熔断文案要区分「常驻上下文自己超窗」与「历史压不动」。
 *
 * 事故：系统提示词 ~89 万 token（窗口约 100 万），用户一句「你好」就熔断，却被告知
 * 「连续 3 次自动压缩都未能减少历史，建议 /compact」——压缩只动消息历史，照做必然再失败。
 */

import { describe, test, expect } from "bun:test";
import { buildCompactCircuitBreakerText } from "@sid-code/core/query/loop.ts";
import { inferErrorCode, lookupErrorMessage } from "@sid-code/core/llm/error-messages.ts";

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
});
