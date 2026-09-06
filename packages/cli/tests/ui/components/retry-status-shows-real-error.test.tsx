/**
 * 回归门禁：重试提示条必须显示**真实**报错文本。
 *
 * 缺陷本体（死接线）：`RetryStatusInfo.error` 字段一直有值 —— app.ts 的
 * `onRetry` 回调每次重试都往里写（`error` 字段，见 app.ts fallback 接线处），
 * 但 `RetryStatus.tsx` **从未读取过它**。组件里唯一形似的匹配是 `theme.status.error`
 * （一个颜色常量），所以 grep "status.error" 有命中、实际是零消费。
 *
 * 后果（轨迹 20260905-215535-664d3239）：重试期间用户只看到
 * 「⟳ 请求失败（第 2 次重试），1 秒后重试…」，而网关明明回了
 * 「当前分组上游负载已饱和」——是该等一等还是该换模型，无从判断。
 *
 * 变异自证：删掉 RetryStatus.tsx 里 `{status.error ? … }` 那段 → 本文件第一条断言红。
 */

import { test, expect, describe } from "bun:test";
import React from "react";
import { render } from "@sid-code/tui-renderer/_vendor/testing.tsx";
import {
  RetryStatus,
  summarizeRetryError,
  RETRY_ERROR_MAX_CHARS,
} from "@sid-code/cli/ui/components/RetryStatus.tsx";
import type { RetryStatusInfo } from "@sid-code/cli/ui/App.tsx";

const base: RetryStatusInfo = {
  kind: "retry",
  attempt: 2,
  delayMs: 1000,
  retryAtMs: 10_000,
  model: "claude-opus-5",
};

// 轨迹里的真实网关文案。
const REAL = "当前分组上游负载已饱和，请稍后再试 (request id: 2026090519422733007594196e93ae3)";

describe("重试提示条显示真实报错", () => {
  test("error 字段被渲染出来（此前是死接线，从不读取）", () => {
    const { lastFrame } = render(<RetryStatus status={{ ...base, error: REAL }} nowMs={9_000} />);
    const frame = lastFrame() ?? "";
    // 关键断言：网关原文的可辨识片段必须出现在界面上。
    expect(frame).toContain("负载已饱和");
    // 原有的倒计时提示不能被挤掉（两者共存，不是替换）。
    expect(frame).toContain("重试");
  });

  test("限流场景：真实报错与升级建议同时在场", () => {
    const { lastFrame } = render(
      <RetryStatus status={{ ...base, kind: "rate_limit", error: REAL }} nowMs={9_000} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("负载已饱和");
    expect(frame).toContain("限流");
    expect(frame).toContain("/model");
  });

  test("无 error 字段时不多渲染空行（保持旧行为）", () => {
    const { lastFrame } = render(<RetryStatus status={base} nowMs={9_000} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("重试");
    expect(frame).not.toContain("undefined");
  });
});

describe("summarizeRetryError — 单行截断纯函数", () => {
  test("折叠换行与多余空白（提示条在动态区，必须单行）", () => {
    expect(summarizeRetryError("429  限流\n  请稍后再试")).toBe("429 限流 请稍后再试");
  });

  test("短文本原样返回", () => {
    expect(summarizeRetryError("429 限流")).toBe("429 限流");
  });

  test("超长尾部省略，且结果不超过上限", () => {
    const long = "限" + "长".repeat(300);
    const out = summarizeRetryError(long);
    expect(out.length).toBeLessThanOrEqual(RETRY_ERROR_MAX_CHARS);
    expect(out.endsWith("…")).toBe(true);
    // 头部信息保留（错误类型通常在开头，截断不能把它切掉）。
    expect(out.startsWith("限")).toBe(true);
  });

  test("边界：恰好等于上限时不截断", () => {
    const exact = "x".repeat(RETRY_ERROR_MAX_CHARS);
    expect(summarizeRetryError(exact)).toBe(exact);
    expect(summarizeRetryError(exact).endsWith("…")).toBe(false);
  });

  test("真实网关文案在渲染前已被压成单行", () => {
    const out = summarizeRetryError(REAL);
    expect(out).not.toContain("\n");
    expect(out).toContain("负载已饱和");
  });
});
