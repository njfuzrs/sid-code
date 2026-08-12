/**
 * 循环检测豁免白名单对账审计（P2-3，差距分析「豁免白名单维护机制」方案③落地）
 *
 * 背景：src/agent/loop-detection.ts 的 `EXEMPT_TOOLS` 曾是一份手写死名单——新增工具时
 * 容易忘记评估是否该豁免，且没有任何机制把"名单"与"真实工具"对账，长期有漂移风险。
 *
 * 本审计把"豁免"的**双向一致性**codify 成可执行测试（遵守项目"禁止创建文档"约束，
 * 用测试代替维护清单），事实源有两个、必须互相印证：
 *   A) 运行时事实源：loop-detection.ts 的 `EXEMPT_TOOLS`（loop detector 实际读它做豁免）
 *   B) 声明事实源：每个工具在自身定义处自报的 `exemptFromLoopDetection === true` 字段
 *
 * 三条断言织成一张防漂移网：
 *   1. 【实例双向对账】把 8 个豁免工具真实实例化，断言每个都自报 exemptFromLoopDetection=true，
 *      且它们的 name() 集合与 EXEMPT_TOOLS 完全相等（多一个少一个都失败）。
 *   2. 【全量源码扫描·无遗漏】扫描 src/ 下所有工具源码，凡自报 exemptFromLoopDetection=true
 *      的工具名都必须在 EXEMPT_TOOLS 里——防"加了字段却忘了进名单"。
 *   3. 【全量源码扫描·无多余】EXEMPT_TOOLS 里的每个名字都必须有对应工具自报该字段——
 *      防"进了名单却没有工具声明（拼错 / 工具已删）"。
 */

import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { EXEMPT_TOOLS } from "@sid-code/core/agent/loop-detection.ts";

// 豁免工具的真实实例（构造参数按各自签名给最小可用值——exemptFromLoopDetection 是类字段
// 初始化子，不依赖构造参数的具体内容，仅需能 new 出实例即可读到该字段）。
import { SubAgentTool } from "@sid-code/core/agent/tool.ts";
import { TaskOutputTool } from "@sid-code/core/tool/task-output.ts";
import { TaskStopTool } from "@sid-code/core/tool/task-stop.ts";
import { TaskListTool } from "@sid-code/core/tool/task-list.ts";
import { TaskGetTool } from "@sid-code/core/tool/task-get.ts";
import { TaskCreateTool } from "@sid-code/core/tool/structured-task-create.ts";
import { TaskUpdateTool } from "@sid-code/core/tool/structured-task-update.ts";
import { StructuredTaskGetTool } from "@sid-code/core/tool/structured-task-get.ts";
import { StructuredTaskListTool } from "@sid-code/core/tool/structured-task-list.ts";
import { SendMessageTool } from "@sid-code/core/tool/send-message.ts";
import { TeamMessageTool } from "@sid-code/core/tool/team-message.ts";
import { TodoWriteTool } from "@sid-code/core/tool/todo-write.ts";
import { EnterPlanModeTool } from "@sid-code/core/tool/enter-plan-mode.ts";
import { ExitPlanModeTool } from "@sid-code/core/tool/exit-plan-mode.ts";
import { PlanModeManager } from "@sid-code/core/plan/state.ts";
import { ProviderRegistry } from "@sid-code/core/llm/registry.ts";
import { Registry as ToolRegistry } from "@sid-code/core/tool/registry.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");
const TOOL_SRC_DIRS = [
  join(REPO_ROOT, "packages", "core", "src", "tool"),
  join(REPO_ROOT, "packages", "core", "src", "agent"),
];

/** 构造最小依赖，供需要构造参数的工具实例化。 */
function makeExemptToolInstances(): { name: string; exempt: boolean }[] {
  const planManager = new PlanModeManager();
  // ProviderRegistry 只需一个占位 config（本测试不触发任何 provider 调用）。
  const providerRegistry = new ProviderRegistry({ provider: "anthropic", model: "test" } as any);
  const toolRegistry = new ToolRegistry();

  const instances = [
    new SubAgentTool(providerRegistry, toolRegistry),
    new TaskOutputTool(),
    new TaskStopTool(),
    new TaskListTool(),
    new TaskGetTool(),
    new TaskCreateTool(),
    new TaskUpdateTool(),
    new StructuredTaskGetTool(),
    new StructuredTaskListTool(),
    new SendMessageTool(providerRegistry, toolRegistry),
    new TeamMessageTool(),
    new TodoWriteTool(),
    new EnterPlanModeTool(planManager),
    new ExitPlanModeTool(planManager),
  ];

  return instances.map((t) => ({
    name: t.name(),
    exempt: t.exemptFromLoopDetection === true,
  }));
}

/**
 * 扫描工具源码，抽取自报 `exemptFromLoopDetection = true` 的工具，并解析其 name()。
 *
 * 纯静态正则扫描（不实例化），用于全量覆盖——避免"新工具加了字段但本测试忘了 import
 * 进上面的实例列表"这种二次漂移。对每个含 `exemptFromLoopDetection = true` 的文件，
 * 提取其 `name(): string { return "xxx"; }` 或 `name() { return "xxx" }` 里的工具名。
 */
function scanSourceForExemptToolNames(): Set<string> {
  const found = new Set<string>();
  for (const dir of TOOL_SRC_DIRS) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const file of entries) {
      if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
      const src = readFileSync(join(dir, file), "utf8");
      // 只看真正声明为 true 的（排除接口定义 types.ts 里的 `exemptFromLoopDetection?: boolean`）
      if (!/exemptFromLoopDetection\s*=\s*true/.test(src)) continue;
      // 提取该文件所有 name() 返回的字符串字面量（一个文件通常一个工具类）
      const nameRegex = /name\s*\(\s*\)\s*:?\s*(?:string\s*)?\{\s*return\s*["'`]([^"'`]+)["'`]/g;
      let m: RegExpExecArray | null;
      while ((m = nameRegex.exec(src)) !== null) {
        found.add(m[1]);
      }
    }
  }
  return found;
}

describe("循环检测豁免白名单对账审计（P2-3）", () => {
  test("EXEMPT_TOOLS 非空且为预期的豁免工具集合", () => {
    // 锚定当前豁免集合，任何增删都会让此断言失败并强制 review（是否真该豁免）。
    expect([...EXEMPT_TOOLS].sort()).toEqual(
      [
        "enter_plan_mode",
        "exit_plan_mode",
        "send_message",
        "sub_agent",
        // 后台任务运行态查询/管理
        "bg_task_list",
        "bg_task_get",
        "task_output",
        "task_stop",
        // 结构化任务清单维护
        "task_create",
        "task_update",
        "task_list",
        "task_get",
        "todo_write",
        // P1-3 团队成员通信（连续发给不同成员是正当协作编排）
        "team_message",
      ].sort(),
    );
  });

  test("【实例对账】豁免工具都自报 exemptFromLoopDetection=true", () => {
    const instances = makeExemptToolInstances();
    for (const { name, exempt } of instances) {
      expect(exempt, `工具 ${name} 应自报 exemptFromLoopDetection=true`).toBe(true);
    }
  });

  test("【实例对账】自报豁免的工具名集合 === EXEMPT_TOOLS（双向相等）", () => {
    const instances = makeExemptToolInstances();
    const declaredExemptNames = instances
      .filter((t) => t.exempt)
      .map((t) => t.name)
      .sort();
    expect(declaredExemptNames).toEqual([...EXEMPT_TOOLS].sort());
  });

  test("【源码扫描·无遗漏】所有自报 exemptFromLoopDetection=true 的工具都在 EXEMPT_TOOLS 里", () => {
    const scanned = scanSourceForExemptToolNames();
    // 扫描应至少覆盖到全部 8 个（防正则漂移导致扫空后假绿）
    expect(scanned.size).toBeGreaterThanOrEqual(EXEMPT_TOOLS.size);
    const missing = [...scanned].filter((name) => !EXEMPT_TOOLS.has(name));
    expect(
      missing,
      `以下工具在源码里自报豁免、但没进 loop-detection.ts 的 EXEMPT_TOOLS：${missing.join(", ")}`,
    ).toEqual([]);
  });

  test("【源码扫描·无多余】EXEMPT_TOOLS 里的每个名字都有工具自报该字段", () => {
    const scanned = scanSourceForExemptToolNames();
    const orphan = [...EXEMPT_TOOLS].filter((name) => !scanned.has(name));
    expect(
      orphan,
      `以下名字在 EXEMPT_TOOLS 里、但没有任何工具源码自报 exemptFromLoopDetection=true（拼错/工具已删？）：${orphan.join(", ")}`,
    ).toEqual([]);
  });
});
