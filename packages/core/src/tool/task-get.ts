/**
 * BgTaskGetTool（工具名 bg_task_get）— 获取单个后台任务详情
 * 后台任务运行态查询，对应 CC 的 TaskOutput 族；结构化清单单条查询见 structured-task-get.ts
 */

import type { LegacyTool as Tool, LegacyToolResult as ToolResult } from "./types.ts";
// P1-3：isTerminalStatus 供阻塞等待判定"任务是否已进终态"。
import { getTask, isAgentTask, isShellTask, isTerminalStatus } from "../task/index.ts";
import { z } from "zod/v4";
import { lazySchema } from "../sdk/lazy-schema.ts";

/**
 * P1-3：阻塞等待的上下限（对齐 CC TaskOutputTool.tsx:30-33 的 `.min(0).max(600000).default(30000)`）。
 */
const BLOCK_TIMEOUT_DEFAULT_MS = 30_000;
const BLOCK_TIMEOUT_MAX_MS = 600_000;
/** 轮询间隔。CC 用 100ms（TaskOutputTool.tsx 的 `sleep(100)`），这里对齐。 */
const POLL_INTERVAL_MS = 100;

const taskGetSchema = lazySchema(() =>
  z.object({
    task_id: z.string().describe("要查询的任务 ID"),
    /**
     * P1-3 根因 A 的修复：**没有阻塞等待原语，轮询就不是模型的坏习惯而是 harness 逼的。**
     *
     * 实测（2026-08-11 会话）：`bg_task_list` 被调用 49 次、占全部工具调用 18.8%，
     * 间隔约 5.7s、入参**全部是 `{}`**，连续多次返回除 duration 秒数外逐字节相同。
     * 模型想等一个后台任务完成，当时唯一可用手段就是反复查询。
     *
     * 对比 CC：`TaskOutputTool` 的 `block` **默认 true**、单次最多阻塞 600s，模型问一次
     * 就拿到结果，**没有轮询的动机**——这也解释了 CC 轨迹里 Task* 工具只出现 6 次、零轮询。
     */
    block: z
      .boolean()
      .optional()
      .describe("是否阻塞等待任务进入终态（默认 true）。true 时问一次即可拿到结果，无需轮询"),
    timeout: z
      .number()
      .optional()
      .describe(
        `最大等待时间（毫秒），默认 ${BLOCK_TIMEOUT_DEFAULT_MS}，上限 ${BLOCK_TIMEOUT_MAX_MS}`,
      ),
  }),
);

export class TaskGetTool implements Tool {
  readonly zodSchema = taskGetSchema();
  /** 长尾工具：仅在有后台任务时使用，延迟加载，由 tool_search 按需调出 */
  readonly shouldDefer = true;
  readonly searchHint = "background task get detail 后台 任务 详情 查询 bg_task_get";
  /**
   * 任务管理类工具，连续查询**不同**后台任务状态是正当轮询而非循环，豁免循环检测。
   *
   * P1-3 收窄：豁免现在是**有条件**的（见 `loop-detection.ts` 的
   * `CONDITIONALLY_EXEMPT_TOOLS`）——注意上面那句"不同"正是原本声称的语义，
   * 而改造前的实现是无条件的，入参完全相同的连续查询同样被放过。
   * **豁免应当只覆盖它声称的那个语义。**
   */
  readonly exemptFromLoopDetection = true;

  name(): string {
    return "bg_task_get";
  }

  description(): string {
    return `获取单个后台任务（Shell/Agent/Workflow）的详细信息，包含状态、进度、输出等。

**要等一个后台任务完成，用 block=true（默认）问一次即可，不要反复轮询状态。**
- block=true（默认）：阻塞直到任务进入终态或 timeout，返回 retrieval_status=success/timeout
- block=false：立即返回当前快照，未完成时 retrieval_status=not_ready
- timeout：最大等待毫秒数，默认 ${BLOCK_TIMEOUT_DEFAULT_MS}，上限 ${BLOCK_TIMEOUT_MAX_MS}

注意：这是运行态后台任务查询，不是结构化任务清单（后者用 task_get）。`;
  }

  inputSchema(): Record<string, unknown> {
    return z.toJSONSchema(taskGetSchema()) as Record<string, unknown>;
  }

  readOnly(): boolean {
    return true;
  }

  async execute(input: unknown, signal?: AbortSignal): Promise<ToolResult> {
    const params = input as { task_id: string; block?: boolean; timeout?: number };

    if (!params.task_id) {
      return { output: "错误: 缺少 task_id 参数", isError: true };
    }

    const initial = getTask(params.task_id);
    if (!initial) {
      return { output: `任务 "${params.task_id}" 不存在`, isError: true };
    }

    // P1-3：block 默认 true（对齐 CC）。`!== false` 而非 `?? true`——模型有时传
    // 字符串 "false"，那种情况按 true 处理反而更安全（顶多多等一会儿，不会丢结果）。
    const shouldBlock = params.block !== false;
    const timeout = Math.min(
      Math.max(params.timeout ?? BLOCK_TIMEOUT_DEFAULT_MS, 0),
      BLOCK_TIMEOUT_MAX_MS,
    );

    /**
     * 检索状态（对齐 CC `TaskOutputToolOutput.retrieval_status`）。
     *
     * 三档必须可分辨——这是 §3.5 第 1 条「让模型知道『还没完』和『失败了』的差别」的落点：
     *   - success：任务已进终态（completed / failed / killed 都算 success，
     *     即"取到了最终结果"，不是"任务成功了"。任务本身成功与否看 <status>）；
     *   - timeout：等到 timeout 仍未进终态，**不是错误**，任务还在跑；
     *   - not_ready：block=false 且任务未完成。
     *
     * 为什么 timeout 不返 isError：它会让 TUI 显示红色终态、并进统一错误面板，
     * 而"等了 30s 还没完"是完全正常的状态。返错会把正常流程报成故障。
     */
    let retrievalStatus: "success" | "timeout" | "not_ready";

    if (!isTerminalStatus(initial.status) && shouldBlock) {
      // 阻塞等待循环（对齐 CC waitForTaskCompletion，TaskOutputTool.tsx:120-135）。
      const startedAt = Date.now();
      let settled = false;
      while (Date.now() - startedAt < timeout) {
        // 用户 ESC / 父级取消：立刻让出，不把 signal 吞掉
        if (signal?.aborted) break;
        const cur = getTask(params.task_id);
        // 任务被驱逐（!cur）也要跳出——继续等一个不存在的任务是纯浪费
        if (!cur || isTerminalStatus(cur.status)) {
          settled = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }
      const after = getTask(params.task_id);
      retrievalStatus =
        settled || (after && isTerminalStatus(after.status)) ? "success" : "timeout";
    } else {
      retrievalStatus = isTerminalStatus(initial.status) ? "success" : "not_ready";
    }

    // 阻塞期间任务可能被驱逐，重新取一次（不能沿用等待前的快照）
    const task = getTask(params.task_id);
    if (!task) {
      return { output: `任务 "${params.task_id}" 已被驱逐`, isError: true };
    }

    const duration = task.endTime
      ? `${((task.endTime - task.startTime) / 1000).toFixed(1)}s`
      : `${((Date.now() - task.startTime) / 1000).toFixed(1)}s (运行中)`;

    const lines = [
      `<retrieval_status>${retrievalStatus}</retrieval_status>`,
      `<task id="${task.id}" type="${task.type}" status="${task.status}">`,
      `  <description>${task.description}</description>`,
      `  <duration>${duration}</duration>`,
    ];

    if (isAgentTask(task)) {
      lines.push(`  <agent_type>${task.agentType}</agent_type>`);
      if (task.progress) {
        const p = task.progress;
        lines.push(`  <progress tools="${p.toolUseCount}" tokens="${p.tokenCount}">`);
        if (p.lastActivity) {
          lines.push(
            `    <last_activity>${p.lastActivity.toolName}: ${p.lastActivity.activityDescription || ""}</last_activity>`,
          );
        }
        lines.push(`  </progress>`);
      }
      if (task.result) {
        lines.push(`  <result>${task.result.output.slice(0, 4000)}</result>`);
        lines.push(
          `  <usage total_tokens="${task.result.totalTokens}" tool_uses="${task.result.totalToolUseCount}"/>`,
        );
      }
      if (task.error) {
        lines.push(`  <error>${task.error.slice(0, 2000)}</error>`);
      }
      if (task.progressSummary) {
        lines.push(`  <progress_summary>${task.progressSummary}</progress_summary>`);
      }
    }

    if (isShellTask(task)) {
      lines.push(`  <command>${task.command.slice(0, 500)}</command>`);
      if (task.exitCode !== undefined) {
        lines.push(`  <exit_code>${task.exitCode}</exit_code>`);
      }
      if (task.interrupted) {
        lines.push(`  <interrupted>true</interrupted>`);
      }
    }

    lines.push("</task>");

    // P1-3：timeout / not_ready 时给出**具体下一步**，而不是让模型自己猜。
    // 不给出路就等于把它推回轮询——那正是本项修复的病灶（49 次同参 bg_task_list）。
    if (retrievalStatus === "timeout") {
      lines.push(
        `<hint>等待 ${Math.round(timeout / 1000)}s 后任务仍在运行（这不是错误）。` +
          `可以再次调用本工具继续等（可加大 timeout，上限 ${BLOCK_TIMEOUT_MAX_MS}），` +
          `或先去做不依赖该任务的部分——任务完成时你会收到 task-notification。</hint>`,
      );
    } else if (retrievalStatus === "not_ready") {
      lines.push(
        `<hint>任务尚未完成。要等它完成请用 block=true（默认），不要以相同入参反复查询状态。</hint>`,
      );
    }

    return { output: lines.join("\n") };
  }
}
