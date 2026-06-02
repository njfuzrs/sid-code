/**
 * Skill 摘要预算控制测试（Task 2：两层索引发现机制）
 */

import { describe, test, expect } from "bun:test";
import {
  formatCommandsWithinBudget,
  generateSkillListing,
  computeCharBudget,
  DEFAULT_CHAR_BUDGET,
  type SkillListingEntry,
} from "../../src/skill/budget.ts";

function entry(name: string, description: string, isBundled = false): SkillListingEntry {
  return { name, description, isBundled };
}

describe("computeCharBudget", () => {
  test("无 token 数时用默认预算", () => {
    expect(computeCharBudget()).toBe(DEFAULT_CHAR_BUDGET);
    expect(computeCharBudget(0)).toBe(DEFAULT_CHAR_BUDGET);
  });

  test("200k 窗口 → 8000 字符", () => {
    expect(computeCharBudget(200_000)).toBe(8_000);
  });
});

describe("formatCommandsWithinBudget", () => {
  test("空列表返回空字符串", () => {
    expect(formatCommandsWithinBudget([])).toBe("");
  });

  test("预算充足时全部完整描述", () => {
    const out = formatCommandsWithinBudget([
      entry("a", "描述A"),
      entry("b", "描述B"),
    ]);
    expect(out).toBe("- a: 描述A\n- b: 描述B");
  });

  test("whenToUse 优先于 description", () => {
    const out = formatCommandsWithinBudget([
      { name: "a", description: "desc", whenToUse: "when-to-use-text" },
    ]);
    expect(out).toContain("when-to-use-text");
    expect(out).not.toContain("desc");
  });

  test("预算极紧时 bundled 完整、非 bundled 只显示名称", () => {
    const longDesc = "x".repeat(500);
    const entries = [
      entry("bundled-skill", longDesc, true),
      entry("user-skill-1", longDesc, false),
      entry("user-skill-2", longDesc, false),
    ];
    // 给一个极小的预算（25 token ≈ 100 字符）
    const out = formatCommandsWithinBudget(entries, 25);
    const lines = out.split("\n");
    // bundled 保留完整描述（带冒号）
    const bundledLine = lines.find((l) => l.startsWith("- bundled-skill"));
    expect(bundledLine).toContain(":");
    // 非 bundled 只剩名称（无冒号描述）
    const userLine = lines.find((l) => l.startsWith("- user-skill-1"));
    expect(userLine).toBe("- user-skill-1");
  });

  test("bundled 享有特权不被截断", () => {
    const longDesc = "需要保留的完整描述内容".repeat(20);
    const entries = [
      entry("core", longDesc, true),
      entry("other", longDesc, false),
    ];
    const out = formatCommandsWithinBudget(entries, 30);
    const coreLine = out.split("\n").find((l) => l.startsWith("- core"));
    expect(coreLine).toContain(longDesc);
  });
});

describe("generateSkillListing", () => {
  test("无 Skill 返回 null", () => {
    expect(generateSkillListing([])).toBeNull();
  });

  test("生成 system-reminder 包裹的列表", () => {
    const out = generateSkillListing([entry("a", "描述A")]);
    expect(out).toContain("<system-reminder>");
    expect(out).toContain("skill 工具");
    expect(out).toContain("- a: 描述A");
    expect(out).toContain("</system-reminder>");
  });
});
