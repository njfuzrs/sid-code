/**
 * auto-fallback-note 文案测试（PR2 / C2 展示部分）
 *
 * 四种回退成因的文案各自回答一个不同的问题，不能串味：
 * - `unsafe`：分类器判了「不安全」→ 要把它的理由给出来；
 * - `unavailable` / `error`：分类器没给出结论 → 措辞必须让用户知道「是它坏了」，
 *   而不是「你的操作被拒了」；
 * - `safety-guard`：结构检查禁止分类器参与 → 要指出命中的是哪一项；
 * - `ask-rule`：用户自己的配置生效 → 说明这不是模型判断。
 *
 * 未命中已知枚举 / 无 note 时返回 undefined（不显示这一行）——静默优于一句看不懂的话。
 */

import { describe, test, expect } from "bun:test";
import { describeAutoFallback } from "@sid-code/cli/ui/auto-fallback-note.ts";

describe("describeAutoFallback", () => {
  test("无 note（非 auto 回退）不显示", () => {
    expect(describeAutoFallback(undefined)).toBeUndefined();
  });

  test("unsafe：带上分类器的一句话理由", () => {
    expect(describeAutoFallback({ kind: "unsafe", reason: "推送到默认分支" })).toBe(
      "auto 未放行：推送到默认分支",
    );
  });

  test("unsafe 缺理由时给出兜底措辞（不留空）", () => {
    expect(describeAutoFallback({ kind: "unsafe" })).toBe("auto 未放行：分类器判定超出用户授权");
  });

  test("unavailable / error：明确是「分类器不可用」，不是「被拒」", () => {
    expect(describeAutoFallback({ kind: "unavailable", reason: "分类器未启用" })).toBe(
      "auto 分类器不可用（分类器未启用），需要你确认",
    );
    expect(describeAutoFallback({ kind: "error", reason: "分类器超时 (8000ms)" })).toBe(
      "auto 分类器不可用（分类器超时 (8000ms)），需要你确认",
    );
  });

  test("safety-guard：指出命中的结构检查项", () => {
    expect(describeAutoFallback({ kind: "safety-guard", guard: "git-push-default-branch" })).toBe(
      "auto 无权放行：命中结构检查 git-push-default-branch，这类确认只能由人决定",
    );
  });

  test("safety-guard 没有 guard 时仍说明「只能由人决定」", () => {
    expect(describeAutoFallback({ kind: "safety-guard" })).toBe(
      "auto 无权放行：命中结构检查，这类确认只能由人决定",
    );
  });

  test("ask-rule：说明是用户自己的配置生效", () => {
    expect(describeAutoFallback({ kind: "ask-rule" })).toBe("auto 无权放行：命中你配置的 ask 规则");
  });

  test("未知枚举不显示（静默优于看不懂的话）", () => {
    expect(describeAutoFallback({ kind: "some-future-value" })).toBeUndefined();
  });
});
