/**
 * ExitPlanMode 工具
 * AI 完成计划编写后调用，提交计划等待用户审批
 */

import type { LegacyTool as Tool, LegacyToolResult as ToolResult } from "./types.ts";
import type { PlanModeManager } from "../plan/state.ts";
import { existsSync, readFileSync } from "fs";
import { z } from "zod/v4";
import { lazySchema } from "../sdk/lazy-schema.ts";

const exitPlanModeSchema = lazySchema(() =>
  z.object({
    summary: z.string().optional().describe("计划的简短摘要（1-2 句话）"),
    allowedPrompts: z
      .array(
        z.object({
          tool: z.enum(["bash"]).optional(),
          prompt: z.string().describe("语义化的操作描述，如 '运行测试'、'安装依赖'"),
        }),
      )
      .optional()
      .describe(
        "执行计划所需的权限声明。用户审批计划时一并审批这些权限，减少执行阶段的弹窗。" +
          '如 [{ "tool": "bash", "prompt": "运行测试" }, { "tool": "bash", "prompt": "安装依赖" }]',
      ),
  }),
);

export class ExitPlanModeTool implements Tool {
  readonly zodSchema = exitPlanModeSchema();

  constructor(private planManager: PlanModeManager) {}

  name(): string { return "exit_plan_mode"; }

  description(): string {
    return `在计划模式下完成计划编写后使用此工具，请求用户审批。
此工具会读取计划文件内容并展示给用户。
只有在计划模式下且已将计划写入计划文件后才能使用。

重要：
- 不要用此工具问"计划可以吗？"——这个工具本身就是请求审批
- 确保计划完整且无歧义后再调用
- 纯研究任务不要使用此工具`;
  }

  inputSchema(): Record<string, unknown> {
    return z.toJSONSchema(exitPlanModeSchema()) as Record<string, unknown>;
  }

  readOnly(): boolean { return true; }

  async execute(input: unknown, _signal?: AbortSignal): Promise<ToolResult> {
    if (!this.planManager.isPlanning()) {
      // 根因 3 修复（P0-1）：非 planning 状态下的 exit_plan_mode 改为**幂等成功**，
      // 从源头切断"报错 → 重试 → 再报错"的空转循环（实测 46.9% 失败率，127 次"不在计划模式"）。
      //
      // 两种非 planning 情形都返回成功提示（isError:false），引导模型进入/继续执行阶段，
      // 而不是反复重复调用本工具：
      //   - awaiting_approval：计划已提交、正等待用户审批 → 告诉模型"已提交，无需重复提交"
      //   - inactive：计划已审批通过（或从未进入计划模式）→ 告诉模型"进入执行阶段，逐条执行，勿再调用"
      if (this.planManager.isAwaitingApproval()) {
        return {
          output:
            "计划已提交，正在等待用户审批，无需重复调用 exit_plan_mode。请耐心等待审批结果。",
        };
      }
      return {
        output:
          "计划已进入执行阶段（已审批通过或当前不在计划模式）。请直接开始执行计划的第一步任务，" +
          "不要再调用 exit_plan_mode——它只用于提交新计划等待审批。" +
          "如计划包含多个步骤，建议先用 todo_write 将计划逐条拆解为任务清单，再依次执行。",
      };
    }

    const planPath = this.planManager.getPlanFilePath();
    if (!planPath || !existsSync(planPath)) {
      return {
        output: `计划文件不存在: ${planPath}\n请先使用 write 工具将计划写入计划文件`,
        isError: true,
      };
    }

    // 读取计划文件内容
    const planContent = readFileSync(planPath, "utf-8");
    if (!planContent.trim()) {
      return { output: "计划文件为空，请先写入计划内容", isError: true };
    }

    const params = (input ?? {}) as {
      summary?: string;
      allowedPrompts?: Array<{ tool?: string; prompt: string }>;
    };

    // 记录执行阶段所需权限（用户审批计划时一并审批）
    const allowedPrompts = Array.isArray(params.allowedPrompts)
      ? params.allowedPrompts.filter((p) => p && typeof p.prompt === "string")
      : [];
    this.planManager.setAllowedPrompts(allowedPrompts);

    // 提交审批
    this.planManager.submitForApproval();

    const summary = params.summary || "";
    const summaryLine = summary ? `\n摘要: ${summary}` : "";
    const permLine =
      allowedPrompts.length > 0
        ? `\n执行阶段需要的权限:\n${allowedPrompts
            .map((p) => `  - [${p.tool || "bash"}] ${p.prompt}`)
            .join("\n")}`
        : "";

    return {
      output: `计划已提交，等待用户审批。${summaryLine}${permLine}\n\n---\n${planContent}\n---`,
    };
    // 实际的用户审批交互由 App 层的 executeTools 拦截处理
  }
}
