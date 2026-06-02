import { describe, expect, test } from "bun:test";
import {
  resolveSemanticColor,
  type SemanticColorName,
} from "../../src/ui/design-system/colors.ts";
import { statusSymbol } from "../../src/ui/design-system/StatusIcon.tsx";
import { dividerLine } from "../../src/ui/design-system/Divider.tsx";
import {
  darkSemanticColors,
  lightSemanticColors,
} from "../../src/ui/themes/semantic-tokens.ts";

describe("resolveSemanticColor", () => {
  const names: SemanticColorName[] = [
    "text",
    "subtle",
    "inactive",
    "link",
    "success",
    "error",
    "warning",
    "accent",
    "border",
  ];

  test("所有语义名都能解析为非空颜色(dark)", () => {
    for (const name of names) {
      const c = resolveSemanticColor(name, darkSemanticColors);
      expect(typeof c).toBe("string");
      expect(c.length).toBeGreaterThan(0);
    }
  });

  test("映射到正确的 token", () => {
    expect(resolveSemanticColor("text", darkSemanticColors)).toBe(
      darkSemanticColors.text.primary,
    );
    expect(resolveSemanticColor("subtle", darkSemanticColors)).toBe(
      darkSemanticColors.text.secondary,
    );
    expect(resolveSemanticColor("success", darkSemanticColors)).toBe(
      darkSemanticColors.status.success,
    );
    expect(resolveSemanticColor("error", darkSemanticColors)).toBe(
      darkSemanticColors.status.error,
    );
    expect(resolveSemanticColor("warning", darkSemanticColors)).toBe(
      darkSemanticColors.status.warning,
    );
    expect(resolveSemanticColor("accent", darkSemanticColors)).toBe(
      darkSemanticColors.text.accent,
    );
    expect(resolveSemanticColor("border", darkSemanticColors)).toBe(
      darkSemanticColors.border.default,
    );
    expect(resolveSemanticColor("link", darkSemanticColors)).toBe(
      darkSemanticColors.text.link,
    );
    expect(resolveSemanticColor("inactive", darkSemanticColors)).toBe(
      darkSemanticColors.ui.comment,
    );
  });

  test("主题切换时同一语义名解析到不同主题的色值", () => {
    const darkErr = resolveSemanticColor("error", darkSemanticColors);
    const lightErr = resolveSemanticColor("error", lightSemanticColors);
    expect(darkErr).toBe(darkSemanticColors.status.error);
    expect(lightErr).toBe(lightSemanticColors.status.error);
    expect(darkErr).not.toBe(lightErr);
  });
});

describe("statusSymbol", () => {
  test("各状态映射稳定的符号与语义色", () => {
    expect(statusSymbol("success")).toEqual({ symbol: "✔", color: "success" });
    expect(statusSymbol("error")).toEqual({ symbol: "✘", color: "error" });
    expect(statusSymbol("warning")).toEqual({ symbol: "⚠", color: "warning" });
    expect(statusSymbol("pending")).toEqual({ symbol: "●", color: "accent" });
    expect(statusSymbol("info")).toEqual({ symbol: "ℹ", color: "link" });
  });

  test("符号均非空", () => {
    for (const k of ["success", "error", "warning", "pending", "info"] as const) {
      expect(statusSymbol(k).symbol.length).toBeGreaterThan(0);
    }
  });
});

describe("dividerLine", () => {
  test("生成定长分隔线", () => {
    expect(dividerLine(5)).toBe("─────");
    expect(dividerLine(0)).toBe("");
    expect(dividerLine(-3)).toBe("");
  });

  test("自定义字符并精确截断到目标宽度", () => {
    expect(dividerLine(4, "=")).toBe("====");
    // 多字符 char:重复后截断到精确宽度
    expect(dividerLine(5, "-=")).toHaveLength(5);
  });
});
