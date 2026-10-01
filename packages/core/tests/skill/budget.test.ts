/**
 * Skill 摘要预算控制测试（Task 2：两层索引发现机制）
 */

import { describe, test, expect } from "bun:test";
import {
  formatCommandsWithinBudget,
  generateSkillListing,
  computeCharBudget,
  estimateSkillListingTokens,
  DEFAULT_CHAR_BUDGET,
  type SkillListingEntry,
} from "@sid-code/core/skill/budget.ts";

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
    const out = formatCommandsWithinBudget([entry("a", "描述A"), entry("b", "描述B")]);
    expect(out).toBe("- a: 描述A\n- b: 描述B");
  });

  test("whenToUse 优先于 description", () => {
    const out = formatCommandsWithinBudget([
      { name: "a", description: "desc", whenToUse: "when-to-use-text" },
    ]);
    expect(out).toContain("when-to-use-text");
    expect(out).not.toContain("desc");
  });

  test("预算极紧时 bundled 完整（封顶内）、非 bundled 只显示名称", () => {
    const longDesc = "x".repeat(500);
    const entries = [
      entry("bundled-skill", longDesc, true),
      ...Array.from({ length: 10 }, (_, i) => entry(`user-skill-${i}`, longDesc, false)),
    ];
    // 窗口 15000 token → 预算 600 字符：bundled 整行 268 ≤ 封顶 300 保留完整；
    // 剩余 332 扣掉 10 条前缀后均分 < 30 → 普通条目只剩名字。
    // （P1-1 之前这里用 25 token 窗口 = 1 字符预算，锁的正是「bundled 无封顶、超预算照样全量输出」的缺陷。）
    const out = formatCommandsWithinBudget(entries, 15_000);
    const lines = out.split("\n");
    const bundledLine = lines.find((l) => l.startsWith("- bundled-skill"));
    expect(bundledLine).toContain(":");
    expect(lines.find((l) => l.startsWith("- user-skill-1"))).toBe("- user-skill-1");
    expect(out.length).toBeLessThanOrEqual(600);
  });

  test("bundled 享有特权不被截断（封顶内），普通条目被截断", () => {
    const longDesc = "需要保留的完整描述内容".repeat(20);
    const entries = [
      entry("core", longDesc, true),
      ...Array.from({ length: 10 }, (_, i) => entry(`other-${i}`, longDesc, false)),
    ];
    // 窗口 20000 token → 预算 800 字符：core 整行 229 在封顶 400 内，享有特权
    const out = formatCommandsWithinBudget(entries, 20_000);
    const lines = out.split("\n");
    expect(lines.find((l) => l.startsWith("- core"))).toBe(`- core: ${longDesc}`);
    const other = lines.find((l) => l.startsWith("- other-0"))!;
    expect(other.length).toBeLessThan(`- other-0: ${longDesc}`.length);
    expect(out.length).toBeLessThanOrEqual(800);
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

describe("estimateSkillListingTokens", () => {
  test("按注入行 `- name: desc` 字符数 ÷ 4 估算", () => {
    // "- ab: cd" = 8 字符 → ceil(8/4) = 2
    expect(estimateSkillListingTokens({ name: "ab", description: "cd" })).toBe(2);
  });

  test("whenToUse 优先于 description", () => {
    const withWhen = estimateSkillListingTokens({
      name: "x",
      description: "短",
      whenToUse: "这是一个更长的何时使用说明文本",
    });
    const descOnly = estimateSkillListingTokens({ name: "x", description: "短" });
    expect(withWhen).toBeGreaterThan(descOnly);
  });

  test("空描述也不为 0（含 name + 前缀开销）", () => {
    // "- n: " = 5 字符 → ceil(5/4) = 2
    expect(estimateSkillListingTokens({ name: "n", description: "" })).toBe(2);
  });
});
