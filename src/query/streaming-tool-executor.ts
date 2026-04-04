/**
 * StreamingToolExecutor — 流式工具执行器
 *
 * 在模型流式输出过程中，检测到 tool_use block 完成就立即开始执行。
 * 支持并发控制（只读工具并行、写入工具串行）和有序结果产出。
 *
 * 时序对比：
 *   当前（分阶段）：模型输出 ████████ → 工具执行 ████ → 总延迟 12s
 *   优化后（流式）：模型输出 ████████ → 总延迟 8s（工具与模型输出重叠）
 *                   工具执行     ████
 */

import type { ContentBlock, ToolUseBlock } from "../llm/types.ts";
import type { Tool } from "../tool/types.ts";
import { Registry as ToolRegistry } from "../tool/registry.ts";
import { getLogger } from "../debug/index.ts";

/** 工具追踪状态 */
type ToolStatus = "queued" | "executing" | "completed" | "failed" | "cancelled";

/** 追踪的工具 */
interface TrackedTool {
  block: ToolUseBlock;
  tool: Tool;
  status: ToolStatus;
  isConcurrencySafe: boolean;
  result?: ContentBlock;
  error?: Error;
  /** 添加顺序（用于有序产出） */
  order: number;
  /** 执行 Promise（用于等待完成） */
  promise?: Promise<void>;
}

/** 工具执行回调 */
export interface ToolExecutionCallbacks {
  /** 执行单个工具（含权限检查、hook） */
  executeSingleTool: (block: ToolUseBlock) => Promise<ContentBlock>;
  /** 工具开始 */
  onToolStart?: (toolName: string, toolInput?: unknown) => void;
  /** 工具结束 */
  onToolEnd?: (toolName: string, result?: { isError?: boolean; elapsedMs?: number }) => void;
}

export class StreamingToolExecutor {
  private tools: TrackedTool[] = [];
  private toolRegistry: ToolRegistry;
  private callbacks: ToolExecutionCallbacks;
  private siblingAbortController: AbortController;
  private nextOrder = 0;
  /** 下一个待产出的结果索引 */
  private nextYieldIndex = 0;

  constructor(toolRegistry: ToolRegistry, callbacks: ToolExecutionCallbacks) {
    this.toolRegistry = toolRegistry;
    this.callbacks = callbacks;
    this.siblingAbortController = new AbortController();
  }

  /**
   * 模型流式输出中检测到 tool_use block 完成时调用
   * 立即将工具加入队列并尝试执行
   */
  addTool(block: ToolUseBlock): void {
    const log = getLogger();
    const tool = this.toolRegistry.get(block.name);
    if (!tool) {
      log.error("STREAMING_TOOL", `工具未找到: ${block.name}`);
      this.tools.push({
        block,
        tool: null as any,
        status: "failed",
        isConcurrencySafe: false,
        order: this.nextOrder++,
        result: {
          type: "tool_result",
          tool_use_id: block.id,
          content: `工具 "${block.name}" 未找到`,
          is_error: true,
        },
      });
      return;
    }

    const isSafe = this.checkConcurrencySafe(tool, block.input);
    const tracked: TrackedTool = {
      block,
      tool,
      status: "queued",
      isConcurrencySafe: isSafe,
      order: this.nextOrder++,
    };
    this.tools.push(tracked);

    log.debug("STREAMING_TOOL", `添加工具 ${block.name} (并发安全=${isSafe})，队列长度 ${this.tools.length}`);

    // 尝试立即执行
    void this.processQueue();
  }

  /** 检查工具是否并发安全 */
  private checkConcurrencySafe(tool: Tool, input: unknown): boolean {
    // 优先使用 isConcurrencySafe（基于输入的动态判断）
    if (tool.isConcurrencySafe) {
      return tool.isConcurrencySafe(input);
    }
    // 回退到 readOnly（静态判断）
    return tool.readOnly?.() === true;
  }

  /** 能否执行这个工具？ */
  private canExecute(isConcurrencySafe: boolean): boolean {
    const executing = this.tools.filter(t => t.status === "executing");
    if (executing.length === 0) return true;
    // 只有当前工具和所有正在执行的工具都是并发安全的，才能并行
    return isConcurrencySafe && executing.every(t => t.isConcurrencySafe);
  }

  /** 处理队列：尝试执行排队中的工具 */
  private async processQueue(): Promise<void> {
    const log = getLogger();

    for (const tracked of this.tools) {
      if (tracked.status !== "queued") continue;
      if (!this.canExecute(tracked.isConcurrencySafe)) break; // 不能并行，等待

      tracked.status = "executing";
      this.callbacks.onToolStart?.(tracked.block.name, tracked.block.input);

      const startTime = Date.now();
      tracked.promise = (async () => {
        try {
          tracked.result = await this.callbacks.executeSingleTool(tracked.block);
          tracked.status = "completed";
          const elapsed = Date.now() - startTime;
          const isError = tracked.result.type === "tool_result" && !!tracked.result.is_error;
          this.callbacks.onToolEnd?.(tracked.block.name, { isError, elapsedMs: elapsed });

          // Bash 错误级联取消
          if (isError && tracked.block.name === "bash") {
            log.info("STREAMING_TOOL", `Bash 命令失败，取消并行兄弟工具`);
            this.siblingAbortController.abort();
          }
        } catch (err: any) {
          tracked.status = "failed";
          tracked.error = err;
          const elapsed = Date.now() - startTime;
          tracked.result = {
            type: "tool_result",
            tool_use_id: tracked.block.id,
            content: `工具执行异常: ${err.message}`,
            is_error: true,
          };
          this.callbacks.onToolEnd?.(tracked.block.name, { isError: true, elapsedMs: elapsed });
        }

        // 工具完成后，尝试执行队列中的下一个
        void this.processQueue();
      })();
    }
  }

  /**
   * 按添加顺序产出已完成的结果（有序并发）
   * 只产出连续完成的结果，遇到未完成的就停止
   */
  *getCompletedResults(): Generator<ContentBlock> {
    while (this.nextYieldIndex < this.tools.length) {
      const tracked = this.tools[this.nextYieldIndex];
      if (tracked.status !== "completed" && tracked.status !== "failed") break;
      if (tracked.result) {
        yield tracked.result;
      }
      this.nextYieldIndex++;
    }
  }

  /**
   * 流式结束后，等待所有剩余工具完成并产出结果
   */
  async *getRemainingResults(): AsyncGenerator<ContentBlock> {
    // 等待所有正在执行的工具完成
    const executing = this.tools.filter(t => t.promise && (t.status === "executing" || t.status === "queued"));
    if (executing.length > 0) {
      await Promise.allSettled(executing.map(t => t.promise!));
    }

    // 产出所有剩余结果
    while (this.nextYieldIndex < this.tools.length) {
      const tracked = this.tools[this.nextYieldIndex];
      if (tracked.result) {
        yield tracked.result;
      }
      this.nextYieldIndex++;
    }
  }

  /** 丢弃所有未完成的工具（降级时使用） */
  discard(): void {
    this.siblingAbortController.abort();
    for (const tracked of this.tools) {
      if (tracked.status === "queued") {
        tracked.status = "cancelled";
        tracked.result = {
          type: "tool_result",
          tool_use_id: tracked.block.id,
          content: "工具执行被取消（模型降级）",
          is_error: true,
        };
      }
    }
  }

  /** 获取所有工具的结果（按添加顺序） */
  getAllResults(): ContentBlock[] {
    return this.tools
      .filter(t => t.result)
      .map(t => t.result!);
  }

  /** 是否有工具在执行中 */
  hasExecuting(): boolean {
    return this.tools.some(t => t.status === "executing");
  }

  /** 是否所有工具都已完成 */
  allCompleted(): boolean {
    return this.tools.every(t => t.status === "completed" || t.status === "failed" || t.status === "cancelled");
  }

  /** 获取工具数量 */
  get size(): number {
    return this.tools.length;
  }
}

/**
 * 工具分区算法：将工具调用分为并发批次和串行批次
 *
 * 输入: [Read, Read, Read, Bash(rm), Edit, Read, Read]
 * 分区: [Read, Read, Read]  → 并发批次
 *       [Bash(rm)]          → 串行批次
 *       [Edit]              → 串行批次
 *       [Read, Read]        → 并发批次
 */
export interface ToolBatch {
  tools: ToolUseBlock[];
  concurrent: boolean;
}

export function partitionToolCalls(
  blocks: ToolUseBlock[],
  toolRegistry: ToolRegistry,
): ToolBatch[] {
  if (blocks.length === 0) return [];

  const batches: ToolBatch[] = [];
  let currentBatch: ToolUseBlock[] = [];
  let currentConcurrent = false;

  for (const block of blocks) {
    const tool = toolRegistry.get(block.name);
    const isSafe = tool
      ? (tool.isConcurrencySafe?.(block.input) ?? tool.readOnly?.() === true)
      : false;

    if (currentBatch.length === 0) {
      // 第一个工具
      currentBatch.push(block);
      currentConcurrent = isSafe;
    } else if (isSafe && currentConcurrent) {
      // 当前批次是并发的，新工具也是并发安全的 → 加入当前批次
      currentBatch.push(block);
    } else {
      // 不兼容 → 结束当前批次，开始新批次
      batches.push({ tools: currentBatch, concurrent: currentConcurrent && currentBatch.length > 1 });
      currentBatch = [block];
      currentConcurrent = isSafe;
    }
  }

  // 最后一个批次
  if (currentBatch.length > 0) {
    batches.push({ tools: currentBatch, concurrent: currentConcurrent && currentBatch.length > 1 });
  }

  return batches;
}
