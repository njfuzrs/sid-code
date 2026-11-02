import type { CommandContext, LocalCommandModule, LocalCommandResult } from "../../types.ts";

/** /plan 命令 — 进入/退出计划模式 */
export class PlanCommand implements LocalCommandModule {
  async call(args: string, ctx: CommandContext): Promise<LocalCommandResult> {
    // 从 App 获取 planManager（通过 sendToLLM 间接触发）
    // /plan 命令的实现方式：注入提示词让 LLM 调用 enter_plan_mode 工具
    const trimmed = args.trim();

    if (trimmed === "exit" || trimmed === "quit") {
      return {
        type: "submit_prompt",
        prompt:
          "请退出计划模式。如果你有未完成的计划，先保存到计划文件，然后调用 exit_plan_mode 工具提交审批。",
      };
    }

    if (trimmed === "status") {
      const mode = ctx.config.permissionMode;
      if (mode === "plan") {
        return { type: "text", value: "当前处于计划模式" };
      }
      return { type: "text", value: "当前不在计划模式" };
    }

    // 默认：进入计划模式
    const taskDesc = trimmed ? `\n\n用户的任务描述: ${trimmed}` : "";
    return {
      type: "submit_prompt",
      prompt: `请调用 enter_plan_mode 工具进入计划模式，然后开始分析代码库并制定实现方案。${taskDesc}`,
    };
  }
}
