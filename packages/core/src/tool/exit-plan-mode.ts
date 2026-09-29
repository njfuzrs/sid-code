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
    // P2-2：这里曾有 allowed_prompts，describe 向模型承诺「用户审批计划时一并审批这些权限，
    // 减少执行阶段的弹窗」。实际没有任何消费方：审批框不展示、不写回 allow 规则，
    // getAllowedPrompts 与团队 preApprove 全仓零调用。模型按这句承诺规划执行阶段，
    // 换来一批它没预期的权限拒绝。删掉承诺，而不是补一个消费方——
    // 声明是「运行测试」这类语义短语，映射不成可安全匹配的 allow 规则。
    // 旧模型若仍传该字段：zod 默认剥离未知键，不会校验失败。
  }),
);

export class ExitPlanModeTool implements Tool {
  readonly zodSchema = exitPlanModeSchema();
  /** P2-3：模式切换类工具，退出计划模式是一次性状态跃迁，豁免循环检测 */
  readonly exemptFromLoopDetection = true;

  /**
   * 保留卡片、丢弃 `⎿` 正文（header 摘要说明"计划已提交待审批"）。
   *
   * 本工具的 `output` 把**整份计划正文**又带一遍（`计划已提交，等待用户审批。…\n---\n${planContent}\n---`），
   * 而计划的权威呈现是 `app.ts:6096` 建的 `plan_review` 历史项 + `PlanReviewMessage` 组件
   * ——同一份计划在屏幕上出现两次，第二份还裹着给模型看的分隔符。
   *
   * 对标 cc 同样在 `ExitPlanModeTool/UI.tsx` 里把 `renderToolUseMessage()` 返 `null`、
   * `renderToolResultMessage()` 只渲染路径与状态摘要，不重复 plan 正文。
   *
   * 不用 hidden 的理由与 enter_plan_mode 一致：提交审批是用户必须知道的状态变化。
   * （计划正文本身有 PlanReviewMessage 承担，符合判据 ②a；但"提交了"这个动作本身
   * 仍需要一行痕迹，故取 summary 而非 hidden。）
   */
  readonly resultDisplayMode = "summary" as const;

  constructor(private planManager: PlanModeManager) {}

  name(): string {
    return "exit_plan_mode";
  }

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

  readOnly(): boolean {
    return true;
  }

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
          output: "计划已提交，正在等待用户审批，无需重复调用 exit_plan_mode。请耐心等待审批结果。",
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

    const params = (input ?? {}) as { summary?: string };

    // 提交审批
    this.planManager.submitForApproval();

    const summary = params.summary || "";
    const summaryLine = summary ? `\n摘要: ${summary}` : "";

    return {
      output: `计划已提交，等待用户审批。${summaryLine}\n\n---\n${planContent}\n---`,
    };
    // 实际的用户审批交互由 App 层的 executeTools 拦截处理
  }
}
