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
    m.parsePlanFromMarkdown("1. 读 package.json\n2. 改 cli.ts\n3. 写 cli.test.ts\n4. 跑 bun test");
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

// ============================================================
// P1-2：非步骤章节（决策记录 / 风险 …）下的列表项不算步骤
//
// 为什么这组断言必须存在：countPlanSteps 的结果喂给 buildPlanApprovedMessage，
// 而「todo 清单必须覆盖全部 N 步」这条强制令**只在 planStepCount >= 3 时下达**。
// 口径虚高不只是数字难看，它会改变是否下达这条指令——一份只有 1 个真步骤的计划，
// 只要按 buildPlanModePrompt 的要求写了两条决策记录，就会被下达「逐条覆盖」。
// 更矛盾的是同一条批准消息里另有一句「不要推翻决策记录里的决定」：
// 一条说这 N 项都要做，一条说其中 2 项不许做。
//
// 口径定成「排除非步骤章节」而不是「只数 ## 步骤 章节」，是为了向后兼容——
// 大量既有计划不写「## 步骤」标题，反向口径会让它们步骤数恒为 0。
// 下面第一组用例就是锁这个向后兼容的。
// ============================================================
describe("PlanModeManager — 步骤计数的章节口径 (P1-2)", () => {
  test("向后兼容：不写任何标题的朴素计划，顶层项全部算步骤", () => {
    const m = new PlanModeManager();
    expect(m.parsePlanFromMarkdown("1. 读文件\n2. 改代码\n3. 跑测试\n").length).toBe(3);
    expect(m.parsePlanFromMarkdown("- 步骤一\n- 步骤二\n").length).toBe(2);
  });

  test("向后兼容：只有普通标题（非关键词）时照常计数", () => {
    const m = new PlanModeManager();
    const steps = m.parsePlanFromMarkdown("# 我的计划\n\n## 实施步骤\n1. A\n2. B\n");
    expect(steps.length).toBe(2);
  });

  test("决策记录小节下的列表项不算步骤（prompt 自己教模型写的那节）", () => {
    const m = new PlanModeManager();
    const md = [
      "## 步骤",
      "1. 读 package.json",
      "2. 改 src/cli.ts",
      "3. 跑 bun test",
      "",
      "## 决策记录",
      "- 推迟 X：依赖未就绪",
      "- 替代方案：用 Y",
      "",
      "## 风险",
      "- 可能破坏缓存",
      "* 另一个顶层星号项",
      "",
    ].join("\n");

    const steps = m.parsePlanFromMarkdown(md);
    // 修复前这里是 7：决策记录 2 条 + 风险 2 条都被算进去了
    expect(steps.length).toBe(3);
    expect(steps.map((s) => s.description)).toEqual([
      "读 package.json",
      "改 src/cli.ts",
      "跑 bun test",
    ]);
  });

  test("标题带编号/后缀也能识别（实际计划里标题很少是光秃秃的关键词）", () => {
    const m = new PlanModeManager();
    expect(
      m.parsePlanFromMarkdown("## 步骤\n- A\n\n## 三、风险与回滚\n- 风险1\n- 风险2\n").length,
    ).toBe(1);
    expect(m.parsePlanFromMarkdown("- A\n\n## 决策记录（防漂移）\n- 推迟 X\n").length).toBe(1);
  });

  test("英文标题同口径（Risks / Background / Decisions）", () => {
    const m = new PlanModeManager();
    const md = "## Steps\n1. A\n2. B\n\n## Risks\n- r1\n\n## Background\n- b1\n";
    expect(m.parsePlanFromMarkdown(md).length).toBe(2);
  });

  test("非步骤章节之后回到步骤章节要恢复计数（状态不能粘住）", () => {
    const m = new PlanModeManager();
    const md = "## 决策记录\n- 推迟 X\n\n## 实施步骤\n1. A\n2. B\n";
    expect(m.parsePlanFromMarkdown(md).length).toBe(2);
  });

  test("整份计划只有决策记录时步骤数为 0（不再虚构步骤）", () => {
    const m = new PlanModeManager();
    expect(m.parsePlanFromMarkdown("## 决策记录\n- 推迟 X\n- 推迟 Y\n").length).toBe(0);
  });

  test("缩进子项仍然不计（原有口径不变）", () => {
    const m = new PlanModeManager();
    expect(m.parsePlanFromMarkdown("1. A\n   - 子项\n2. B\n").length).toBe(2);
  });

  test("阈值效应：1 个真步骤 + 2 条决策记录不应跨过 >= 3 的强制令门槛", () => {
    const m = new PlanModeManager();
    const md = "## 步骤\n1. 改一个文件\n\n## 决策记录\n- 推迟 A\n- 推迟 B\n";
    // 修复前是 3，恰好触发「必须逐条覆盖全部 3 步」；修复后是 1，不触发
    expect(m.parsePlanFromMarkdown(md).length).toBe(1);
  });
});
