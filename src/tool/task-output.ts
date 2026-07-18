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
  EVICT_GRACE_MS,
} from "../task/index.ts";
import { z } from "zod/v4";
import { lazySchema } from "../sdk/lazy-schema.ts";

/** 单次增量读取的字节上限（对齐旧展示体量，约 30KB 文本）。*/
const MAX_OUTPUT_BYTES = 30000;
/** 字符兜底上限（防多字节 UTF-8 解码后膨胀撑爆返回）。*/
const MAX_OUTPUT_CHARS = 30000;

const taskOutputSchema = lazySchema(() =>
  z.object({
    task_id: z.string().describe("任务 ID"),
    block: z.boolean().optional().describe("是否阻塞等待任务完成（默认 true）"),
    timeout: z.number().optional().describe("最大等待时间（毫秒），默认 30000"),
  }),
);

export class TaskOutputTool implements Tool {
  readonly zodSchema = taskOutputSchema();
  /** 长尾工具：仅在有后台任务时使用，延迟加载，由 tool_search 按需调出 */
  readonly shouldDefer = true;
  readonly searchHint = "background task output result 后台 任务 输出 结果";
  /** P2-3：任务管理类工具，连续查询不同 task 的输出是正当推进而非循环，豁免循环检测 */
  readonly exemptFromLoopDetection = true;

  name(): string {
    return "task_output";
  }

  description(): string {
    return `读取后台任务的输出内容。支持阻塞等待任务完成。
- block=true（默认）：等待任务完成后返回输出
- block=false：立即返回当前已有的输出
- timeout：最大等待时间（毫秒），默认 30000`;
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
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    const currentTask = getTask(params.task_id);
    if (!currentTask) {
      return { output: `任务 "${params.task_id}" 已被驱逐`, isError: true };
    }

    // 访问续期（LRU "touch" 语义）：刚被 task_output 读取的终态任务，把驱逐窗口顺延，
    // 避免活跃查询的任务在固定 60s 窗口边界被误驱逐（T0+59s 读取→T0+60s 驱逐→
    // T0+61s 再读取失败 的竞态）。只对终态任务续期：running 任务本就不会被 evictTerminalTasks
    // 驱逐（要求 isTerminalStatus），无需续期。直接刷新现有 evictAfter、不新增字段，
    // 续期幂等（多次读取只是不断把 evictAfter 往后推），主代理停止查询后最后一次续期的
    // 60s 后必被驱逐、无内存泄漏。
    // 说明：这是消除罕见边界竞态的廉价保险（3 行、无副作用），非业界通用做法——
    // claude-code 靠 UI holding / 用户 retain 决定生命周期，并不做「读一次续期」。
    if (isTerminalStatus(currentTask.status)) {
      updateTask(currentTask.id, (t) => ({ ...t, evictAfter: Date.now() + EVICT_GRACE_MS }));
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

    const info: Record<string, unknown> = {
      task_id: currentTask.id,
      status: currentTask.status,
      type: currentTask.type,
    };

    if (isShellTask(currentTask)) {
      info.command = currentTask.command;
      if (currentTask.exitCode !== undefined) info.exit_code = currentTask.exitCode;
    }
    if (isAgentTask(currentTask)) {
      info.agent_type = currentTask.agentType;
      if (currentTask.result) {
        info.result = currentTask.result.output.slice(0, 4000);
        info.total_tool_uses = currentTask.result.totalToolUseCount;
        info.total_tokens = currentTask.result.totalTokens;
        info.usage = currentTask.result.usage;
      }
    }

    // delta 已按 MAX_OUTPUT_BYTES 字节封顶，此处无需再 slice（旧代码的 .slice(0,30000)
    // 是从头读的产物，会与增量语义冲突）。字符兜底仅防多字节膨胀的极端情况。
    return {
      output: JSON.stringify(info) + "\n\n--- 输出 ---\n" + output.slice(0, MAX_OUTPUT_CHARS),
    };
  }
}
