/**
 * Skill 摘要列表接通 system prompt 单测（缺口 E）
 *
 * 覆盖：
 * - buildSystemPrompt 在传入 skillEntries 时注入 skill 摘要（此前死代码）
 * - 摘要排在 CLAUDE.md 之前（SKILL_LISTING priority < CLAUDE_MD）
 * - 空/未传 skillEntries 时不注入
 */

import { describe, test, expect } from "bun:test";
import { buildSystemPrompt, clearPromptCache } from "@sid-code/core/config/system-prompt.ts";
import type { SkillListingEntry } from "@sid-code/core/skill/budget.ts";

const SKILLS: SkillListingEntry[] = [
  { name: "code-review", description: "审查代码改动", whenToUse: "提交前审查 diff", isBundled: true },
  { name: "ci-self-heal", description: "自动修复 CI 失败", whenToUse: "CI 红了时" },
];

describe("buildSystemPrompt — skill 摘要注入（缺口 E）", () => {
  test("传入 skillEntries 时注入 skill 摘要列表", () => {
    clearPromptCache();
    const prompt = buildSystemPrompt({
      tools: [],
      skillEntries: SKILLS,
      model: "claude-sonnet-4-6",
    });
    expect(prompt).toContain("code-review");
    expect(prompt).toContain("ci-self-heal");
    // 摘要通过 skill 工具调用的说明
    expect(prompt).toContain("skill");
  });

  test("未传 skillEntries 时不注入 skill 摘要", () => {
    clearPromptCache();
    const prompt = buildSystemPrompt({
      tools: [],
      model: "claude-sonnet-4-6",
    });
    expect(prompt).not.toContain("可通过 skill 工具调用");
  });

  test("空 skillEntries 不注入", () => {
    clearPromptCache();
    const prompt = buildSystemPrompt({
      tools: [],
      skillEntries: [],
      model: "claude-sonnet-4-6",
    });
    expect(prompt).not.toContain("可通过 skill 工具调用");
  });

  test("skill 摘要排在 CLAUDE.md 项目规则之前", () => {
    clearPromptCache();
    const prompt = buildSystemPrompt({
      tools: [],
      skillEntries: SKILLS,
      projectRules: "测试项目规则内容ABC",
      projectRulesPath: "/tmp/CLAUDE.md",
      model: "claude-sonnet-4-6",
    });
    const skillIdx = prompt.indexOf("code-review");
    const claudeMdIdx = prompt.indexOf("测试项目规则内容ABC");
    expect(skillIdx).toBeGreaterThanOrEqual(0);
    expect(claudeMdIdx).toBeGreaterThanOrEqual(0);
    expect(skillIdx).toBeLessThan(claudeMdIdx);
  });
});
