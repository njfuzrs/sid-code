/**
 * RetryStatus 渲染测试 — CM3（倒计时）+ CM4（限流升级建议）
 */

import { test, expect, describe } from "bun:test";
import React from "react";
import { render } from "@sid-code/tui-renderer/_vendor/testing.tsx";
import { RetryStatus, remainingSeconds } from "@sid-code/cli/ui/components/RetryStatus.tsx";
import type { RetryStatusInfo } from "@sid-code/cli/ui/App.tsx";

const base: RetryStatusInfo = {
  kind: "retry",
  attempt: 1,
  delayMs: 5000,
  retryAtMs: 10_000,
  model: "test-model",
};

describe("CM3 — remainingSeconds", () => {
  test("向上取整剩余秒数", () => {
    expect(remainingSeconds(10_000, 7_500)).toBe(3); // 2.5s → 3
    expect(remainingSeconds(10_000, 9_200)).toBe(1);
    expect(remainingSeconds(10_000, 10_000)).toBe(0);
  });

  test("过期返回 0（不为负）", () => {
    expect(remainingSeconds(10_000, 12_000)).toBe(0);
  });
});

describe("CM3 — RetryStatus 渲染", () => {
  test("status=null 时不渲染", () => {
    const { lastFrame } = render(<RetryStatus status={null} />);
    expect((lastFrame() ?? "").trim()).toBe("");
  });

  test("通用重试显示倒计时秒数", () => {
    const { lastFrame } = render(
      <RetryStatus status={base} nowMs={5_000} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("重试");
    expect(frame).toContain("5"); // 10000-5000 = 5s
  });

  test("过载提示", () => {
    const { lastFrame } = render(
      <RetryStatus
        status={{ ...base, kind: "overloaded" }}
        nowMs={5_000}
      />,
    );
    expect(lastFrame() ?? "").toContain("过载");
  });

  test("降级提示包含目标模型", () => {
    const { lastFrame } = render(
      <RetryStatus
        status={{ ...base, kind: "fallback", fallbackModel: "backup-x" }}
        nowMs={10_000}
      />,
    );
    expect(lastFrame() ?? "").toContain("backup-x");
  });
});

describe("CM4 — 限流升级建议", () => {
  test("rate_limit 附升级建议", () => {
    const { lastFrame } = render(
      <RetryStatus
        status={{ ...base, kind: "rate_limit" }}
        nowMs={5_000}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("限流");
    expect(frame).toContain("/model"); // 升级建议含切换模型
  });

  test("非 rate_limit 不显示升级建议", () => {
    const { lastFrame } = render(
      <RetryStatus status={base} nowMs={5_000} />,
    );
    expect(lastFrame() ?? "").not.toContain("/model");
  });
});
