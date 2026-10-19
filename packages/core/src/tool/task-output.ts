/**
 * TaskOutputTool — 读取后台任务输出
 * 支持阻塞等待和超时
 */

import type { LegacyTool as Tool, LegacyToolResult as ToolResult } from "./types.ts";
import {
  getTask,
  updateTask,
  isTerminalStatus,
  getTaskOutputDelta,
  isShellTask,
  isAgentTask,
  graceDeadlineFor,
  claimResultDelivery,
  withdrawTaskNotification,
  getCompletedMainTurns,
  NOTIFICATION_OUTPUT_MAX_CHARS,
  truncateForNotification,
} from "../task/index.ts";
import { getLogger } from "../debug/logger.ts";
import { z } from "zod/v4";
import { lazySchema } from "../sdk/lazy-schema.ts";

/** 单次增量读取的字节上限（对齐旧展示体量，约 30KB 文本）。*/
const MAX_OUTPUT_BYTES = 30000;
/** 字符兜底上限（防多字节 UTF-8 解码后膨胀撑爆返回）。*/
const MAX_OUTPUT_CHARS = 30000;

const taskOutputSchema = lazySchema(() =>
  z.object({
    task_id: z.string().describe("任务 ID"),
    block: z
      .boolean()
      .optional()
      .describe(
        "是否阻塞到任务结束（默认 true）。查看进度请传 false；等完成不需要它，完成时会自动通知",
      ),
    timeout: z.number().optional().describe("最大等待时间（毫秒），默认 30000"),
  }),
);

export class TaskOutputTool implements Tool {
  readonly zodSchema = taskOutputSchema();
  /** 长尾工具：仅在有后台任务时使用，延迟加载，由 tool_search 按需调出 */
  readonly shouldDefer = true;
  readonly searchHint = "background task output result 后台 任务 输出 结果";
  /**
   * P2-3：任务管理类工具，连续查询**不同** task 的输出是正当推进而非循环，豁免循环检测。
   *
   * P1-3 收窄：豁免现在是**有条件**的（见 `loop-detection.ts` 的
   * `CONDITIONALLY_EXEMPT_TOOLS`）——入参不同才放过，同参连续查询交给正常循环检测。
   * 本工具已有 block 参数（阻塞等待），所以"同参反复查"在这里更没有正当理由。
   */
  readonly exemptFromLoopDetection = true;

  name(): string {
    return "task_output";
  }

  description(): string {
    // F3：对齐 cc「do NOT poll」。旧描述第一条就是「block=true 等待完成」，等于教模型阻塞——
    // 20261019 轨迹里每次都传 timeout=600000（上限），4 个调用把整轮占住 3–5 分钟。
    return `查看后台任务的当前进度，或回看已完成任务的结果。
后台任务（子代理 / 后台命令）完成时会自动以 <task-notification> 通知你——等待完成**不需要**本工具，不要用它轮询或阻塞等待；先做不重叠的工作，或简短告诉用户启动了什么并结束本轮。
- block=false：立即返回当前已有的输出（查看进度用这个）
- block=true（默认）：阻塞到任务结束或超时
- timeout：block=true 时的最大等待时间（毫秒），默认 30000`;
  }

  inputSchema(): Record<string, unknown> {
    return z.toJSONSchema(taskOutputSchema()) as Record<string, unknown>;
  }

  readOnly(): boolean {
    return true;
  }

  async execute(input: unknown, signal?: AbortSignal): Promise<ToolResult> {
    const params = input as {
      task_id: string;
      block?: boolean;
      timeout?: number;
    };

    if (!params.task_id) {
      return { output: "错误: 缺少 task_id 参数", isError: true };
    }

    const task = getTask(params.task_id);
    if (!task) {
      return { output: `任务 "${params.task_id}" 不存在`, isError: true };
    }

    const shouldBlock = params.block !== false;
    const timeout = Math.min(params.timeout ?? 30000, 600000);

    if (shouldBlock && !isTerminalStatus(task.status)) {
      const startTime = Date.now();
      while (Date.now() - startTime < timeout) {
        if (signal?.aborted) break;
        const current = getTask(params.task_id);
        if (!current || isTerminalStatus(current.status)) break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    const currentTask = getTask(params.task_id);
    if (!currentTask) {
      return { output: `任务 "${params.task_id}" 已被驱逐`, isError: true };
    }

    // 访问续期（LRU "touch" 语义）：刚被 task_output 读取的终态任务，把驱逐下限顺延一个
    // 面板驻留期。S3 之后 evictAfter 只由这里写，是驱逐判据（registry `evictDecision`）里
    // 「已送达且送达回合已过」之外的又一个下限——模型还在轮询就不删。只对终态任务续期：
    // running 任务本就不会被驱逐。续期幂等（多次读取只是不断往后推）。
    //
    // 续期只延长**任务本体**的存活窗口，**不清 dismissed**：用户手动从面板划掉的条目，
    // 不能因为模型顺手读了一次输出就重新冒回面板上（见 types.ts 的 dismissed 说明）。
    if (isTerminalStatus(currentTask.status)) {
      updateTask(currentTask.id, (t) => ({ ...t, evictAfter: graceDeadlineFor(t.status) }));
    }

    // 增量读取：从上次已读的 outputOffset 起读，最多 MAX_OUTPUT_BYTES 字节，
    // 读后把 newOffset 写回任务，保证下次调用只返回**新增**部分（真增量）。
    // 修复前 outputOffset 恒为 0 从不推进，每次都从头读再 slice，长任务永远只见开头。
    // maxBytes 与展示上限一致，避免"推进的 offset 超过已展示内容"导致中间段丢失。
    const delta = await getTaskOutputDelta(
      params.task_id,
      currentTask.outputOffset,
      MAX_OUTPUT_BYTES,
    );
    if (delta) {
      // 写回推进后的偏移量，实现跨调用增量
      updateTask(currentTask.id, (t) => ({ ...t, outputOffset: delta.newOffset }));
    }
    // delta 为 null 表示自上次读取以来无新增输出（增量语义），非"任务无任何输出"
    const output = delta?.content ?? (currentTask.outputOffset > 0 ? "(无新增输出)" : "(无输出)");

    const terminal = isTerminalStatus(currentTask.status);

    // F2：返回体用与 <task-notification> 同源的标签块，不再 JSON.stringify + 拼输出流。
    // 终态 agent 任务只给 result（结论），不拼 `.output` 流：流是逐轮过程，最后一轮正是 result，
    // 旧实现把结论放了两遍且 result 反被截在 4000（R4）。shell / 运行中任务的流就是内容本身。
    const parts = [
      "<task-output>",
      `  <task-id>${currentTask.id}</task-id>`,
      `  <task-type>${currentTask.type}</task-type>`,
      `  <status>${currentTask.status}</status>`,
      `  <description>${currentTask.description}</description>`,
    ];
    if (isShellTask(currentTask)) {
      parts.push(`  <command>${currentTask.command}</command>`);
      if (currentTask.exitCode !== undefined) {
        parts.push(`  <exit-code>${currentTask.exitCode}</exit-code>`);
      }
    }
    const agentResult = isAgentTask(currentTask) ? currentTask.result : undefined;
    if (isAgentTask(currentTask)) {
      parts.push(`  <agent-type>${currentTask.agentType}</agent-type>`);
    }
    if (agentResult && terminal) {
      parts.push(
        `  <output-file>${currentTask.outputFile}</output-file>`,
        `  <result untrusted="true">${truncateForNotification(agentResult.output, NOTIFICATION_OUTPUT_MAX_CHARS, currentTask.outputFile)}</result>`,
        `  <usage>`,
        `    <total_tokens>${agentResult.totalTokens}</total_tokens>`,
        `    <input_tokens>${agentResult.usage.inputTokens}</input_tokens>`,
        `    <output_tokens>${agentResult.usage.outputTokens}</output_tokens>`,
        `    <tool_uses>${agentResult.totalToolUseCount}</tool_uses>`,
        `  </usage>`,
      );
    } else {
      if (isAgentTask(currentTask) && currentTask.error) {
        parts.push(`  <error>${currentTask.error}</error>`);
      }
      // delta 已按 MAX_OUTPUT_BYTES 字节封顶，此处无需再 slice（旧代码的 .slice(0,30000)
      // 是从头读的产物，会与增量语义冲突）。字符兜底仅防多字节膨胀的极端情况。
      parts.push(`  <output>${output.slice(0, MAX_OUTPUT_CHARS)}</output>`);
    }
    parts.push("</task-output>");

    // F1：终态结果经本次 tool_result 送达 → 认领投递所有权，撤回队列里该任务的终态通知。
    // 认领失败（通知已注入过 / 前台 tool_result 已送达）= 模型的显式重读，照常返回，不拦。
    if (terminal && claimResultDelivery(currentTask.id, "tool_result")) {
      const withdrawn = withdrawTaskNotification(currentTask.id);
      getLogger().info(
        "TASK",
        `task_output 认领任务 ${currentTask.id} 结果（turn ${getCompletedMainTurns()}），撤回通知 ${withdrawn} 条`,
      );
    }

    return { output: parts.join("\n") };
  }
}
