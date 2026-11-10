/**
 * TaskStopTool — 终止后台任务
 */

import type { LegacyTool as Tool, LegacyToolResult as ToolResult } from "./types.ts";
import {
  type TaskState,
  getTask,
  isTerminalStatus,
  isShellTask,
  isAgentTask,
  isWorkflowTask,
  isMonitorTask,
  killShellTask,
  killAgentTask,
  killWorkflowTask,
  killMonitorTask,
} from "../task/index.ts";
import { z } from "zod/v4";
import { lazySchema } from "../sdk/lazy-schema.ts";

const taskStopSchema = lazySchema(() =>
  z.object({
    task_id: z.string().describe("要终止的任务 ID"),
  }),
);

export class TaskStopTool implements Tool {
  readonly zodSchema = taskStopSchema();
  /** 长尾工具：仅在有后台任务时使用，延迟加载，由 tool_search 按需调出 */
  readonly shouldDefer = true;
  readonly guidance = "终止一个正在运行的后台任务（跑偏的命令 / 卡住的子代理 / 挂错的监控）时用。";
  readonly searchHint = "background task stop kill cancel 后台 任务 停止 终止";
  /** P2-3：任务管理类工具，连续停止不同 task 是正当操作而非循环，豁免循环检测 */
  readonly exemptFromLoopDetection = true;

  name(): string {
    return "task_stop";
  }

  description(): string {
    return "终止一个正在运行的后台任务（Shell 命令、Agent、Workflow 或 Monitor）。";
  }

  inputSchema(): Record<string, unknown> {
    return z.toJSONSchema(taskStopSchema()) as Record<string, unknown>;
  }

  async execute(input: unknown): Promise<ToolResult> {
    const params = input as { task_id: string };

    if (!params.task_id) {
      return { output: "错误: 缺少 task_id 参数", isError: true };
    }

    const task = getTask(params.task_id);
    if (!task) {
      return { output: `任务 "${params.task_id}" 不存在`, isError: true };
    }

    if (isTerminalStatus(task.status)) {
      return {
        output: JSON.stringify({
          task_id: task.id,
          status: task.status,
          message: "任务已处于终态，无需终止",
        }),
      };
    }

    if (isShellTask(task)) {
      killShellTask(task.id);
    } else if (isAgentTask(task)) {
      killAgentTask(task.id);
    } else if (isWorkflowTask(task)) {
      killWorkflowTask(task.id);
    } else if (isMonitorTask(task)) {
      // monitor 有自己的终态文案（「监控已停止（task_stop）」），不能套 shell 的 kill：
      // 漏了这一支时 task_stop 会回报「已终止」而进程照跑（D1），模型据此重挂一个，
      // 并发上限 MAX_CONCURRENT_MONITORS 很快被同一件事占满。
      killMonitorTask(task.id);
    } else {
      // 兜底不再回「已终止」：下一个新增的任务类型漏了分派时要当场报错，
      // 而不是重演 D1 的「假成功」。
      return {
        output: `错误: 不支持终止该类型任务（type=${(task as TaskState).type}）`,
        isError: true,
      };
    }

    // 状态从 registry 实读：各 kill 路径的最终状态可能不是 killed（例如并发下已被别的
    // 出口写终态），写死 "killed" 会让返回值与事实脱节。
    return {
      output: JSON.stringify({
        task_id: task.id,
        status: getTask(task.id)?.status ?? task.status,
        message: `任务 "${task.description}" 已终止`,
      }),
    };
  }
}
