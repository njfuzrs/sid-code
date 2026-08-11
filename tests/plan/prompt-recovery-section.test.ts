/**
 * W12.D2 单元测试 — buildPlanModePrompt + buildPlanModeReminder 包含失败更新指令
 *
 * 见 docs/specs/active/W12-plan-recovery-mechanism.md §3
 *
 * 覆盖：
 * - buildPlanModePrompt 含"阶段 5"段 + 关键词（失败 / edit / 更新计划）
 * - buildPlanModeReminder 含"工具失败" + "edit" + "更新计划"提示
 */

import { describe, test, expect } from "bun:test";
import { buildPlanModePrompt, buildPlanModeReminder } from "@sid-code/core/plan/prompt.ts";

describe("buildPlanModePrompt — 阶段 5 失败处理段（W12.D2）", () => {
  test("planExists=false 时含阶段 5 + 失败处理关键词", () => {
    const prompt = buildPlanModePrompt("/tmp/plan-test.md", false);
    expect(prompt).toContain("阶段 5");
    expect(prompt).toContain("失败");
    expect(prompt).toContain("edit");
    expect(prompt).toContain("/tmp/plan-test.md");
  });

  test("planExists=true 时同样含阶段 5", () => {
    const prompt = buildPlanModePrompt("/tmp/plan-test.md", true);
    expect(prompt).toContain("阶段 5");
    expect(prompt).toContain("[FAILED]");
  });

  test("含 fallback / 跳过 / 求澄清 等新策略示例", () => {
    const prompt = buildPlanModePrompt("/tmp/plan-test.md", false);
    expect(prompt).toContain("fallback");
    expect(prompt).toContain("跳过");
  });
});

describe("buildPlanModeReminder — 失败更新提醒（W12.D2）", () => {
  test("reminder 含工具失败 + edit + 更新计划提示", () => {
    const reminder = buildPlanModeReminder();
    expect(reminder).toContain("工具失败");
    expect(reminder).toContain("edit");
    expect(reminder).toContain("更新计划");
  });

  test("reminder 仍保留原有约束（不要编辑 / 不要运行命令）", () => {
    const reminder = buildPlanModeReminder();
    expect(reminder).toContain("不要");
  });
});
