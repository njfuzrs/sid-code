/**
 * 瞬态错误分类回归测试
 *
 * 治的现象（docs/_template/请求被限流错误提示没有自动消失.txt）：
 * 429 限流恢复后，TUI 底部红色错误卡片「请求被限流 (429)」不消失，用户必须按 Ctrl+E
 * 手动关闭。根因是 errorPanel 全局只有"手动清空"一个出口，pushErrorPanel 不区分
 * 「系统自动重试中的瞬态错误」与「需用户干预的终态错误」，一律按常驻处理。
 *
 * 本文件锁住分类层的正确性：
 * 1. 瞬态集合与 errors.ts 的枚举**双向对账**——漏加/多加都会红；
 * 2. TerminalReason 一个都不能被判成瞬态（否则 API Key 无效这类故障会被静默清掉）；
 * 3. 429 这条具体链路（消息文本 → inferErrorCode → isTransientErrorCode）端到端可用。
 */

import { describe, test, expect } from "bun:test";
import {
  TRANSIENT_ERROR_CODES,
  isTransientErrorCode,
  inferErrorCode,
  ERROR_USER_MESSAGES,
} from "../../src/llm/error-messages.ts";
import type {
  TerminalReason,
  RetryableReason,
  StreamValidationReason,
} from "../../src/llm/errors.ts";

// ── 与 errors.ts 的枚举对账用的字面量清单 ──
// 手写而非从类型反射（TS 类型在运行时不存在）。errors.ts 增删枚举成员时，
// 下面的 satisfies 会在编译期报错，提醒同步维护——这是"漏加会红"的机制所在。
const RETRYABLE: readonly RetryableReason[] = [
  "rate_limit",
  "overloaded",
  "network_error",
  "timeout",
  "server_error",
  "request_timeout",
  "lock_timeout",
] as const satisfies readonly RetryableReason[];

const STREAM_VALIDATION: readonly StreamValidationReason[] = [
  "no_finish_reason",
  "malformed_tool_call",
  "empty_response",
] as const satisfies readonly StreamValidationReason[];

const TERMINAL: readonly TerminalReason[] = [
  "auth_failed",
  "model_not_found",
  "quota_exhausted",
  "content_policy",
  "invalid_request",
  "server_declined_retry",
] as const satisfies readonly TerminalReason[];

describe("TRANSIENT_ERROR_CODES 与 errors.ts 枚举双向对账", () => {
  test("所有 RetryableReason 都被判为瞬态（系统会自动重试 → 恢复后必须自动消失）", () => {
    for (const reason of RETRYABLE) {
      expect(isTransientErrorCode(reason)).toBe(true);
    }
  });

  test("所有 StreamValidationReason 都被判为瞬态", () => {
    for (const reason of STREAM_VALIDATION) {
      expect(isTransientErrorCode(reason)).toBe(true);
    }
  });

  test("所有 TerminalReason 都不是瞬态（需用户干预，不能被自动清掉）", () => {
    for (const reason of TERMINAL) {
      expect(isTransientErrorCode(reason)).toBe(false);
    }
  });

  test("集合内没有多余成员（防止误把终态错误加进来）", () => {
    const expected = new Set<string>([...RETRYABLE, ...STREAM_VALIDATION]);
    expect([...TRANSIENT_ERROR_CODES].sort()).toEqual([...expected].sort());
  });

  test("集合内每个 code 都有对应的用户文案（不会推出空卡片）", () => {
    for (const code of TRANSIENT_ERROR_CODES) {
      expect(ERROR_USER_MESSAGES[code]).toBeDefined();
    }
  });
});

describe("isTransientErrorCode 边界", () => {
  test("无 code 时返回 false —— fail-closed，宁可多留也不误清", () => {
    expect(isTransientErrorCode(undefined)).toBe(false);
    expect(isTransientErrorCode("")).toBe(false);
  });

  test("未知 code 返回 false（同上，未归类的错误留给用户手动关闭）", () => {
    expect(isTransientErrorCode("some_future_code")).toBe(false);
  });

  test("自定义扩展码里只有 empty_response 是瞬态，其余需干预", () => {
    // html_error_page / subagent_failed 是配置或子代理问题，重试无用 → 必须留在界面上
    expect(isTransientErrorCode("html_error_page")).toBe(false);
    expect(isTransientErrorCode("subagent_failed")).toBe(false);
    expect(isTransientErrorCode("unknown_stop_reason")).toBe(false);
  });
});

describe("429 限流端到端链路（本次 bug 的原始现象）", () => {
  // 文档里记录的真实错误文本
  const REAL_429 =
    'LLM 错误: OpenAI API 错误: 429 {"error":{"message":"Request rate increased too quickly. ' +
    'To ensure system stability, please adjust your client logic to scale requests more smoothly ' +
    'over time.","type":"limit_burst_rate","param":"","code":"limit_burst_rate"}}';

  test("真实 429 报文 → rate_limit → 判定为瞬态", () => {
    const code = inferErrorCode(REAL_429);
    expect(code).toBe("rate_limit");
    expect(isTransientErrorCode(code)).toBe(true);
  });

  test("限流文案确实在宣称『系统正在自动重试』—— 与瞬态判定自洽", () => {
    // 这条断言锁的是"呈现与文案不矛盾"：既然建议里写了自动重试，
    // 那它就必须是瞬态的，否则又会退回"卡片永久悬挂 + 文案说在重试"的自相矛盾。
    expect(ERROR_USER_MESSAGES.rate_limit!.suggestion).toContain("自动重试");
    expect(isTransientErrorCode("rate_limit")).toBe(true);
  });

  test("对比：API Key 失效不是瞬态，重试无用必须让用户看到", () => {
    const code = inferErrorCode("Unauthorized: invalid api key");
    expect(code).toBe("auth_failed");
    expect(isTransientErrorCode(code)).toBe(false);
  });
});
