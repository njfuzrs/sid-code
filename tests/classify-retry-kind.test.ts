/**
 * classifyRetryKind 单测 — CM3/CM4 重试种类推断
 */

import { test, expect, describe } from "bun:test";
import { classifyRetryKind } from "@sid-code/cli/app.ts";

describe("classifyRetryKind", () => {
  test("限流类错误 → rate_limit", () => {
    expect(classifyRetryKind("HTTP 429 Too Many Requests")).toBe("rate_limit");
    expect(classifyRetryKind("rate limit exceeded")).toBe("rate_limit");
    expect(classifyRetryKind("quota exceeded")).toBe("rate_limit");
  });

  test("过载类错误 → overloaded", () => {
    expect(classifyRetryKind("HTTP 529 overloaded")).toBe("overloaded");
    expect(classifyRetryKind("503 Service Unavailable")).toBe("overloaded");
    expect(classifyRetryKind("server at capacity")).toBe("overloaded");
  });

  test("其它错误 → retry", () => {
    expect(classifyRetryKind("ECONNRESET")).toBe("retry");
    expect(classifyRetryKind("timeout")).toBe("retry");
    expect(classifyRetryKind("")).toBe("retry");
  });
});
