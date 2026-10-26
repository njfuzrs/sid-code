/**
 * fidelity 口径回归（2026-10-26）：分母白名单、被拒调用、动作词、缩进续行。
 *
 * 来源：一次无头 plan 实跑的 5 次调用全部被判为偏离（`matchedRatio=0`），
 * 其中 `edit math.js` 正是计划第 1 步本身。逐条重放核对后确认是四件事叠加：
 *   ① 动作词表太窄（`edit` 只有「改/修改/edit」，计划写的是「新增并导出」）；
 *   ② 计划文件自身的 edit 被执行动作（扩词后会误锚定成 step2）；
 *   ③ `todo_write` 等记账工具被算成偏离；
 *   ④ 被权限拒绝的调用也被算成偏离。
 *
 * 断言重点在**边界**，不在「能匹配上」——P2-3 的底线是宁可漏记也不虚报，
 * 所以每条放宽都配一条反例。
 */
import { describe, test, expect } from "bun:test";
import {
  FIDELITY_INDICATOR_VERSION,
  PLAN_STEP_PARSER_VERSION,
  PlanModeManager,
} from "../../src/plan/state.ts";

/** 证据会话里的真实计划形态（3 步，step_sections 口径） */
const EVIDENCE_PLAN = `## 实施步骤

1. **新增 sub 函数**：在 \`math.js\` 中按 \`add\` 的现有风格新增并导出
2. **编写验证脚本**：新增一个临时 Node 脚本（如 \`verify-sub.mjs\`，验证通过后删除），
3. **运行验证并清理**：执行 \`node verify-sub.mjs\`，确认全部断言通过、\`add\` 原有用例未被破坏，
`;

describe("fidelity 分母口径：只有会产生计划步骤的工具进 actualToolCalls", () => {
  test("记账/检索类工具不记录（返回 null，不进分母也不进偏离）", () => {
    const m = new PlanModeManager();
    m.parsePlanFromMarkdown(EVIDENCE_PLAN);
    for (const [name, input] of [
      ["todo_write", { todos: [] }],
      ["task_create", { subject: "s", description: "d" }],
      ["task_update", { id: "1", status: "completed" }],
      ["save_memory", { key: "k", value: "v" }],
      ["tool_search", { query: "mcp" }],
    ] as const) {
      expect(m.recordActualToolCall(name, input)).toBeNull();
    }
    const r = m.getFidelityReport();
    // 记账工具一次都没进分母：否则 5 次记账会变成 5 次「计划外」
    expect(r.actualToolCallCount).toBe(0);
    expect(r.offPlanCount).toBe(0);
    expect(r.deniedCount).toBe(0);
  });

  test("执行类工具仍正常记录（白名单没有把该记的一起漏掉）", () => {
    const m = new PlanModeManager();
    m.parsePlanFromMarkdown(EVIDENCE_PLAN);
    expect(m.recordActualToolCall("edit", { file_path: "math.js" })).not.toBeNull();
    expect(m.recordActualToolCall("bash", { command: "node verify-sub.mjs" })).not.toBeNull();
    expect(m.getFidelityReport().actualToolCallCount).toBe(2);
  });

  test("反例：探索性 ls 不记录（列举类不进分母，见 FIDELITY_TRACKED_TOOLS 注释）", () => {
    const m = new PlanModeManager();
    m.parsePlanFromMarkdown(EVIDENCE_PLAN);
    // 从前 ls 在白名单里、却没有任何动作词 → 每次探索性列举都被记成一次偏离，
    // 与同文件「探索性 ls 不进分母」的声明相反。
    expect(m.recordActualToolCall("ls", { dir_path: "/tmp" })).toBeNull();
    const r = m.getFidelityReport();
    expect(r.actualToolCallCount).toBe(0);
    expect(r.offPlanCount).toBe(0);
  });
});

describe("白名单成员必须在 TOOL_VERBS 里有动作词（否则必然 off-plan）", () => {
  test("read_many 与 read 同族：计划写「读 X」时能命中", () => {
    const m = new PlanModeManager();
    m.parsePlanFromMarkdown("1. 读 src/auth.ts\n2. 改 cli.ts");
    const c = m.recordActualToolCall("read_many", { patterns: ["src/auth.ts"] });
    expect(c?.matchedPlanStepIndex).toBe(1);
  });

  test("notebook_edit 与 edit 同族：计划写「改 X」时能命中", () => {
    const m = new PlanModeManager();
    m.parsePlanFromMarkdown("1. 读 a.ipynb\n2. 改 b.ipynb");
    const c = m.recordActualToolCall("notebook_edit", { notebook_path: "b.ipynb" });
    expect(c?.matchedPlanStepIndex).toBe(2);
  });

  test("sub_agent：计划写「派子代理…」时能命中", () => {
    const m = new PlanModeManager();
    m.parsePlanFromMarkdown("1. 派子代理调研 auth.ts 的登录逻辑\n2. 改 cli.ts");
    const c = m.recordActualToolCall("sub_agent", {
      description: "调研 auth.ts",
      prompt: "看 auth.ts 的登录逻辑",
    });
    expect(c?.matchedPlanStepIndex).toBe(1);
  });

  test("反例：sub_agent 仍受锚定硬门槛约束（计划里没写子代理就不算命中）", () => {
    const m = new PlanModeManager();
    m.parsePlanFromMarkdown(EVIDENCE_PLAN);
    const c = m.recordActualToolCall("sub_agent", {
      description: "调研 unrelated.ts",
      prompt: "看 unrelated.ts 的实现",
    });
    expect(c?.matchedPlanStepIndex).toBeNull();
    expect(m.getFidelityReport().offPlanCount).toBe(1);
  });
});

describe("fidelity 被拒口径：权限拒绝不算模型偏离", () => {
  test("denied 调用计入 actualToolCallCount 与 deniedCount，不计入 offPlanCount", () => {
    const m = new PlanModeManager();
    m.parsePlanFromMarkdown("1. 读 package.json\n2. 改 cli.ts");
    // 计划外 + 被权限拒绝：不该算成偏离
    m.recordActualToolCall("bash", { command: "git status" }, { denied: true });
    const r = m.getFidelityReport();
    expect(r.actualToolCallCount).toBe(1);
    expect(r.deniedCount).toBe(1);
    expect(r.offPlanCount).toBe(0);
  });

  test("未命中且未被拒的调用仍算偏离（口径没有放宽到「什么都算命中」）", () => {
    const m = new PlanModeManager();
    m.parsePlanFromMarkdown("1. 读 package.json\n2. 改 cli.ts");
    m.recordActualToolCall("bash", { command: "git status" });
    const r = m.getFidelityReport();
    expect(r.offPlanCount).toBe(1);
    expect(r.deniedCount).toBe(0);
  });

  test("命中计划又被拒：仍计入 denied，也不算偏离", () => {
    const m = new PlanModeManager();
    m.parsePlanFromMarkdown("1. 改 cli.ts");
    const call = m.recordActualToolCall("edit", { file_path: "cli.ts" }, { denied: true });
    expect(call?.matchedPlanStepIndex).toBe(1);
    const r = m.getFidelityReport();
    expect(r.deniedCount).toBe(1);
    expect(r.offPlanCount).toBe(0);
    // 命中就是命中：deniedCount 是横切标签，不能再从 matched 的分子里扣一次。
    // 从前分子写成 `actual - denied - offPlan`，plan=1 时这里是 0。
    expect(r.matchedRatio).toBe(1);
  });

  test("证据会话重放：命中 1 + 被拒 1 + 偏离 1 时 matchedRatio 是 1/3 而不是 0", () => {
    const m = new PlanModeManager();
    m.parsePlanFromMarkdown(EVIDENCE_PLAN);
    // 真实会话里的两条：edit math.js 命中 step1 且被权限拒绝；read math.js 未命中
    m.recordActualToolCall("edit", { file_path: "math.js" }, { denied: true });
    m.recordActualToolCall("read", { file_path: "/tmp/plan-e2e/math.js" });
    const r = m.getFidelityReport();
    expect(r.planStepCount).toBe(3);
    expect(r.actualToolCallCount).toBe(2);
    expect(r.deniedCount).toBe(1);
    expect(r.offPlanCount).toBe(1);
    // 这是「主口径能否区分修复前后」的回归：从前 matchedActualCount = 2-1-1 = 0。
    expect(r.matchedRatio).toBeCloseTo(1 / 3, 5);
  });
});

describe("动作词：计划写「新增并导出」时 edit 能命中", () => {
  test("edit math.js 命中 step1（证据会话的原始失败点）", () => {
    const m = new PlanModeManager();
    m.parsePlanFromMarkdown(EVIDENCE_PLAN);
    const call = m.recordActualToolCall("edit", {
      file_path: "math.js",
      old_string: "export const add = (a, b) => a + b;",
      new_string: "export const add = ...;\nexport const sub = (a, b) => a - b;",
    });
    expect(call?.matchedPlanStepIndex).toBe(1);
  });

  test("write verify-sub.mjs 命中 step2", () => {
    const m = new PlanModeManager();
    m.parsePlanFromMarkdown(EVIDENCE_PLAN);
    const call = m.recordActualToolCall("write", { file_path: "verify-sub.mjs" });
    expect(call?.matchedPlanStepIndex).toBe(2);
  });

  test("bash node verify-sub.mjs 命中 step3", () => {
    const m = new PlanModeManager();
    m.parsePlanFromMarkdown(EVIDENCE_PLAN);
    const call = m.recordActualToolCall("bash", { command: "node verify-sub.mjs" });
    expect(call?.matchedPlanStepIndex).toBe(3);
  });

  test("反例：扩词没有把「计划外」一起放过——锚定仍是硬门槛", () => {
    const m = new PlanModeManager();
    m.parsePlanFromMarkdown(EVIDENCE_PLAN);
    // 语义上 edit 类（改文件），但参数与任何步骤都锚定不上
    const call = m.recordActualToolCall("edit", { file_path: "/tmp/unrelated.txt" });
    expect(call?.matchedPlanStepIndex).toBeNull();
    expect(m.getFidelityReport().offPlanCount).toBe(1);
  });

  test("反例：read /etc/hosts 不能被算成「读 package.json」（P2-3 底线）", () => {
    const m = new PlanModeManager();
    m.parsePlanFromMarkdown("1. 读 package.json\n2. 改 cli.ts");
    const call = m.recordActualToolCall("read", { file_path: "/etc/hosts" });
    expect(call?.matchedPlanStepIndex).toBeNull();
  });
});

describe("步骤解析：缩进续行并入父步骤", () => {
  test("步数不变（分母口径没变）", () => {
    const m = new PlanModeManager();
    const steps = m.parsePlanFromMarkdown(
      "1. 读 package.json\n   - 找 version 字段\n2. 改 cli.ts\n    - 替换硬编码",
    );
    // 与既有契约一致：嵌套子项不算独立步骤
    expect(steps.length).toBe(2);
  });

  test("续行里的路径参与锚定（从前被整行丢弃）", () => {
    const m = new PlanModeManager();
    // 第一行只有泛泛的描述，具体路径写在续行里
    m.parsePlanFromMarkdown("1. 修复登录问题\n   - 改 src/auth.ts\n2. 更新文档");
    const call = m.recordActualToolCall("edit", { file_path: "src/auth.ts" });
    expect(call?.matchedPlanStepIndex).toBe(1);
  });

  test("续行没有把围栏里的内容带进来", () => {
    const m = new PlanModeManager();
    const steps = m.parsePlanFromMarkdown(
      ["1. 跑测试", "   ```bash", "   bun test", "   ```", "2. 改文档"].join("\n"),
    );
    expect(steps.length).toBe(2);
    // 围栏内的 `bun test` 不应成为锚点来源
    expect(steps[0]!.description).not.toContain("bun test");
  });

  test("续行出现在标题之后、首个列表项之前时被忽略（不崩）", () => {
    const m = new PlanModeManager();
    const steps = m.parsePlanFromMarkdown("## 步骤\n\n   孤立缩进\n\n1. 读 a");
    expect(steps.length).toBe(1);
  });
});

describe("口径版本号", () => {
  test("解析器版本 = 3（续行并入改变了锚定 token 集合）", () => {
    expect(PLAN_STEP_PARSER_VERSION).toBe(3);
  });

  test("指标口径版本 = 1（分母规则 + 匹配规则首次落版本号）", () => {
    expect(FIDELITY_INDICATOR_VERSION).toBe(1);
  });
});
