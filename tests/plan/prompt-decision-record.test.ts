/**
 * 单元测试 — 跨会话"决策链"防漂移指令（方案 3 / 根因 6、7）
 *
 * 见 docs/bugfixes/todo/长任务遗漏根因分析-弱Harness弱模型提升完成率方案.md 方案 3
 *
 * 背景：每个新会话只能看到 plan 的静态文本，看不到当初"为什么推迟某条目"的推理过程，
 * 导致下一轮在不理解原委的情况下推翻决定 → 方案漂移、反复返工。
 *
 * 覆盖：
 * - buildPlanModePrompt 在阶段 4 含"决策记录"小节指令（原因 / 替代方案 / 重新评估条件）
 * - buildPlanApprovedMessage 含"尊重既有决策"防漂移指令
 */

import { describe, test, expect } from "bun:test";
import { buildPlanModePrompt, buildPlanApprovedMessage } from "../../src/plan/prompt.ts";

describe("buildPlanModePrompt — 决策记录指令（方案 3 / 根因 6）", () => {
  test("含'决策记录'小节 + 原因 / 替代方案 / 重新评估条件三要素", () => {
    const prompt = buildPlanModePrompt("/tmp/plan-test.md", false);
    expect(prompt).toContain("决策记录");
    expect(prompt).toContain("原因");
    expect(prompt).toContain("替代方案");
    expect(prompt).toContain("重新评估");
  });

  test("点明动机：后续会话看不到推理过程 → 防方案漂移", () => {
    const prompt = buildPlanModePrompt("/tmp/plan-test.md", true);
    expect(prompt).toContain("漂移");
  });
});

describe("buildPlanApprovedMessage — 尊重既有决策（方案 3 / 根因 6、7）", () => {
  test("含'尊重既有决策' + 不要推翻 + 重新评估条件", () => {
    const msg = buildPlanApprovedMessage("/tmp/plan-test.md", 5);
    expect(msg).toContain("尊重既有决策");
    expect(msg).toContain("不要推翻");
    expect(msg).toContain("重新评估");
  });

  test("无步骤数（退化路径）也保留防漂移指令", () => {
    const msg = buildPlanApprovedMessage("/tmp/plan-test.md", 0);
    expect(msg).toContain("决策记录");
    expect(msg).toContain("本次不实施");
  });
});
