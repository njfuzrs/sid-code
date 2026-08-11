/**
 * Plan fidelity 追踪单测 (ADR-028 §3.1)
 *
 * 覆盖:
 *   - parsePlanFromMarkdown: 0/1/N 步, 嵌套, 编号缺失, 多种编号风格 (1./1)/-/*)
 *   - recordActualToolCall: 完全对应 / 全 off-plan / 部分对应
 *   - getFidelityReport: stepRatio / matchedRatio / offPlanCount
 *   - resetFidelity / forceExit 联动
 */

import { describe, test, expect } from "bun:test";
import { PlanModeManager } from "@sid-code/core/plan/state.ts";

describe("PlanModeManager — parsePlanFromMarkdown (ADR-028 §3.1)", () => {
  test("空字符串解析为 0 步", () => {
    const m = new PlanModeManager();
    const steps = m.parsePlanFromMarkdown("");
    expect(steps).toEqual([]);
    expect(m.getFidelityReport().planStepCount).toBe(0);
  });

  test("非字符串输入安全降级到 0 步", () => {
    const m = new PlanModeManager();
    // @ts-expect-error 故意传非字符串测健壮性
    const steps = m.parsePlanFromMarkdown(null);
    expect(steps).toEqual([]);
  });

  test("有序列表 1. 2. 3. 提取 3 步", () => {
    const m = new PlanModeManager();
    const md = `# Plan
1. 读 package.json
2. 改 cli.ts
3. 写测试`;
    const steps = m.parsePlanFromMarkdown(md);
    expect(steps.length).toBe(3);
    expect(steps[0].description).toBe("读 package.json");
    expect(steps[1].description).toBe("改 cli.ts");
    expect(steps[2].index).toBe(3);
  });

  test("混合编号 (1)/2./- 提取顶层 step", () => {
    const m = new PlanModeManager();
    const md = `1) 读 src/cli.ts
2. 改 version 字段
- 跑 bun test`;
    const steps = m.parsePlanFromMarkdown(md);
    expect(steps.length).toBe(3);
    expect(steps[2].description).toBe("跑 bun test");
  });

  test("嵌套子项 (有 leading 空格) 不计 step", () => {
    const m = new PlanModeManager();
    const md = `1. 读 package.json
   - 找 version 字段
2. 改 cli.ts
    - 替换硬编码`;
    const steps = m.parsePlanFromMarkdown(md);
    expect(steps.length).toBe(2);
  });

  test("多次解析以最后一次为准", () => {
    const m = new PlanModeManager();
    m.parsePlanFromMarkdown("1. a\n2. b\n3. c");
    expect(m.getFidelityReport().planStepCount).toBe(3);
    m.parsePlanFromMarkdown("1. x");
    expect(m.getFidelityReport().planStepCount).toBe(1);
  });
});

describe("PlanModeManager — recordActualToolCall + matching", () => {
  test("planSteps=0 时所有 actual 都 off-plan", () => {
    const m = new PlanModeManager();
    m.recordActualToolCall("read", { file_path: "/tmp/a" });
    m.recordActualToolCall("edit", { file_path: "/tmp/b" });
    const r = m.getFidelityReport();
    expect(r.actualToolCallCount).toBe(2);
    expect(r.offPlanCount).toBe(2);
    expect(Number.isNaN(r.stepRatio)).toBe(true);
  });

  test("tool name 字面命中 description → matched", () => {
    const m = new PlanModeManager();
    m.parsePlanFromMarkdown("1. read package.json\n2. write cli.ts");
    const c1 = m.recordActualToolCall("read", { file_path: "package.json" });
    expect(c1.matchedPlanStepIndex).toBe(1);
  });

  test("中文动作词 '读' + args 路径锚定 → matched", () => {
    const m = new PlanModeManager();
    m.parsePlanFromMarkdown("1. 读 package.json\n2. 改 cli.ts");
    const c1 = m.recordActualToolCall("read", { file_path: "/repo/package.json" });
    expect(c1.matchedPlanStepIndex).toBe(1);
    const c2 = m.recordActualToolCall("edit", { file_path: "/repo/src/cli.ts" });
    expect(c2.matchedPlanStepIndex).toBe(2);
  });

  test("完全 off-plan: tool 与所有 step 都对不上", () => {
    const m = new PlanModeManager();
    m.parsePlanFromMarkdown("1. 读 package.json\n2. 改 cli.ts");
    const c = m.recordActualToolCall("bash", { command: "git status" });
    expect(c.matchedPlanStepIndex).toBeNull();
  });

  test("一个 step 可被多次 actual 命中 (matchedActualIndices 累加)", () => {
    const m = new PlanModeManager();
    const steps = m.parsePlanFromMarkdown("1. 读 package.json\n2. 改 cli.ts");
    m.recordActualToolCall("read", { file_path: "package.json" });
    m.recordActualToolCall("read", { file_path: "package.json" }); // 同 step 重复读
    expect(steps[0].matchedActualIndices.length).toBe(2);
  });

  test("argsHash 稳定可复现 (同输入同 hash)", () => {
    const m = new PlanModeManager();
    m.parsePlanFromMarkdown("1. 读 a");
    const a = m.recordActualToolCall("read", { file_path: "/x" });
    const b = m.recordActualToolCall("read", { file_path: "/x" });
    expect(a.argsHash).toBe(b.argsHash);
  });
});

describe("PlanModeManager — getFidelityReport 指标计算", () => {
  test("plan=4 actual=4 全部 matched: stepRatio=1, matchedRatio=1, offPlan=0", () => {
    const m = new PlanModeManager();
    m.parsePlanFromMarkdown(
      "1. 读 package.json\n2. 改 cli.ts\n3. 写 cli.test.ts\n4. 跑 bun test",
    );
    m.recordActualToolCall("read", { file_path: "package.json" });
    m.recordActualToolCall("edit", { file_path: "src/cli.ts" });
    m.recordActualToolCall("write", { file_path: "tests/cli.test.ts" });
    m.recordActualToolCall("bash", { command: "bun test" });
    const r = m.getFidelityReport();
    expect(r.planStepCount).toBe(4);
    expect(r.actualToolCallCount).toBe(4);
    expect(r.stepRatio).toBe(1);
    expect(r.matchedRatio).toBe(1);
    expect(r.offPlanCount).toBe(0);
  });

  test("plan=4 actual=8: stepRatio=2 (上限内), off-plan ≥ 1", () => {
    const m = new PlanModeManager();
    m.parsePlanFromMarkdown("1. 读 a\n2. 改 b\n3. 写 c\n4. 跑 d");
    // 4 个 matched
    m.recordActualToolCall("read", { file_path: "a" });
    m.recordActualToolCall("edit", { file_path: "b" });
    m.recordActualToolCall("write", { file_path: "c" });
    m.recordActualToolCall("bash", { command: "d" });
    // 4 个 (期望大部分 off-plan, fuzzy match 可能命中部分)
    m.recordActualToolCall("grep", { pattern: "xx" });
    m.recordActualToolCall("glob", { pattern: "**/*.ts" });
    m.recordActualToolCall("bash", { command: "git log" });
    m.recordActualToolCall("bash", { command: "ls -la" });
    const r = m.getFidelityReport();
    expect(r.planStepCount).toBe(4);
    expect(r.actualToolCallCount).toBe(8);
    expect(r.stepRatio).toBe(2);
    // matched + offPlan 必须等于 actualCount
    expect(r.offPlanCount).toBeGreaterThanOrEqual(1);
    expect(r.offPlanCount).toBeLessThan(8);
  });

  test("resetFidelity 后 report 归零", () => {
    const m = new PlanModeManager();
    m.parsePlanFromMarkdown("1. a\n2. b");
    m.recordActualToolCall("read", { file_path: "a" });
    expect(m.getFidelityReport().actualToolCallCount).toBe(1);
    m.resetFidelity();
    const r = m.getFidelityReport();
    expect(r.planStepCount).toBe(0);
    expect(r.actualToolCallCount).toBe(0);
  });

  test("forceExit 顺带清空 fidelity 状态", () => {
    const m = new PlanModeManager();
    m.enter();
    m.parsePlanFromMarkdown("1. a\n2. b");
    m.recordActualToolCall("read", { file_path: "a" });
    m.forceExit();
    const r = m.getFidelityReport();
    expect(r.planStepCount).toBe(0);
    expect(r.actualToolCallCount).toBe(0);
  });
});
