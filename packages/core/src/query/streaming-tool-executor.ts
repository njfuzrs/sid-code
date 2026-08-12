/**
 * GAP-01：流式工具执行器（StreamingToolExecutor）
 *
 * 对标 claude-code：模型还在流式输出时，就开始执行已完整到达的工具调用，
 * 使"工具执行"与"模型继续输出后续内容"在时间上重叠，把多工具场景的总延迟
 * 从 `模型输出 + 工具执行`（串行叠加）降到接近 `max(模型输出, 工具执行)`。
 *
 * 4 状态状态机（每个工具一份）：
 *   queued     — 已加入队列，尚未开始（等待并发安全条件满足）
 *   executing  — 正在执行（Promise 未 settle）
 *   completed  — 执行完成（结果已就绪，未被收集）
 *   yielded    — 结果已被主循环收集
 *
 * canExecuteTool() 判定（对齐 CC）：
 *   一个排队工具可以**立即启动**，当且仅当：
 *     - 当前没有任何正在执行的工具（executing 为空）；或
 *     - 它自身并发安全 **且** 所有正在执行的工具都并发安全。
 *   即："非并发安全工具"必须独占执行窗口（前后都不能有别的工具在跑），
 *   与批量模式"并发安全批次并行、非安全批次串行"的语义一致——只是这里按到达顺序
 *   增量调度，而非等全部到齐再分区。
 *
 * 安全设计：
 *   - 本执行器只负责"何时启动哪个工具"的调度；单工具的权限/hook/校验/执行仍复用
 *     传入的 executeOne 回调（即 tool-executor.executeSingleTool 的包装），不重复实现管线。
 *   - 保序：结果按工具的原始 index 收集，主循环据此按模型输出顺序组装 tool_result。
 *   - 默认关闭（由调用方 feature flag 控制），批量模式为 fallback。
 */

import type { ToolUseBlock } from "../llm/types.ts";
import type { LegacyTool as Tool } from "../tool/types.ts";
import { getLogger } from "../debug/index.ts";

/** 工具执行状态 */
export type ToolExecState = "queued" | "executing" | "completed" | "yielded";

/** 单个工具的执行记录 */
interface ToolEntry {
  block: ToolUseBlock;
  tool: Tool;
  idx: number;
  isConcurrencySafe: boolean;
  state: ToolExecState;
  /** executing 态的执行 Promise（completed/yielded 时仍保留结果） */
  promise?: Promise<void>;
  /** 执行结果（completed 后就绪） */
  result?: unknown;
  /** 执行是否抛错（abort 等） */
  error?: unknown;
}

/** 单工具执行回调：复用 tool-executor 的完整管线（权限/hook/校验/执行/序列化） */
export type ExecuteOne = (block: ToolUseBlock, tool: Tool, idx: number) => Promise<unknown>;

/** 并发安全判定：优先 isConcurrencySafe(input)，回退 readOnly() */
function judgeConcurrencySafe(tool: Tool, block: ToolUseBlock): boolean {
  try {
    return tool.isConcurrencySafe
      ? tool.isConcurrencySafe(block.input)
      : (tool.readOnly?.() ?? false);
  } catch {
    return false; // 判定异常保守视为非并发安全
  }
}

export class StreamingToolExecutor {
  private entries: ToolEntry[] = [];
  private executeOne: ExecuteOne;
  private maxConcurrency: number;
  private log = getLogger();

  constructor(executeOne: ExecuteOne, maxConcurrency: number) {
    this.executeOne = executeOne;
    this.maxConcurrency = Math.max(1, maxConcurrency);
  }

  /** 当前正在执行的工具数 */
  private executingCount(): number {
    return this.entries.filter((e) => e.state === "executing").length;
  }

  /** 是否存在正在执行的非并发安全工具 */
  private hasUnsafeExecuting(): boolean {
    return this.entries.some((e) => e.state === "executing" && !e.isConcurrencySafe);
  }

  /**
   * 判断某个排队工具能否立即启动（对齐 CC canExecuteTool）。
   * @param entry 待判定的排队工具
   */
  private canExecuteTool(entry: ToolEntry): boolean {
    const executing = this.executingCount();
    // 无任何工具在执行 → 任何工具都可启动（含非并发安全工具，独占窗口）
    if (executing === 0) return true;
    // 有工具在执行时：仅当自身并发安全 且 在执行的全部并发安全，才可加入并发
    if (!entry.isConcurrencySafe) return false;
    if (this.hasUnsafeExecuting()) return false;
    // 并发上限
    if (executing >= this.maxConcurrency) return false;
    return true;
  }

  /**
   * 添加一个完整到达的工具调用，并尝试立即调度可执行的排队工具。
   * 在 processStream 检测到一个 tool_use block 完整后调用。
   */
  addTool(block: ToolUseBlock, tool: Tool, idx: number): void {
    this.entries.push({
      block,
      tool,
      idx,
      isConcurrencySafe: judgeConcurrencySafe(tool, block),
      state: "queued",
    });
    this.pump();
  }

  /** 尝试启动所有当前满足条件的排队工具（顺序扫描，保持到达顺序优先） */
  private pump(): void {
    for (const entry of this.entries) {
      if (entry.state !== "queued") continue;
      if (!this.canExecuteTool(entry)) {
        // 队头无法启动（如非并发安全工具需独占）→ 停止扫描，避免越序启动后续工具
        // 破坏"非安全工具独占窗口"不变式。
        break;
      }
      this.startExecuting(entry);
    }
  }

  /** 启动单个工具执行 */
  private startExecuting(entry: ToolEntry): void {
    entry.state = "executing";
    this.log.debug(
      "STREAM_TOOL",
      `启动执行 ${entry.block.name}(idx=${entry.idx}) safe=${entry.isConcurrencySafe}`,
    );
    entry.promise = this.executeOne(entry.block, entry.tool, entry.idx)
      .then((result) => {
        entry.result = result;
        entry.state = "completed";
      })
      .catch((err) => {
        entry.error = err;
        entry.state = "completed";
      })
      .finally(() => {
        // 一个工具完成 → 可能解锁后续排队工具（尤其非并发安全工具的独占窗口释放）
        this.pump();
      });
  }

  /**
   * 等待所有工具执行完毕并按原始 index 返回结果。
   * 主循环在流结束后调用，收集全部结果。
   *
   * @returns 按 idx 升序排列的 { idx, result, error } 数组
   */
  async getRemainingResults(): Promise<Array<{ idx: number; result?: unknown; error?: unknown }>> {
    // 确保所有排队工具最终都被调度（防御：某些工具可能因独占条件一直排队，
    // 此时靠已在执行工具 settle 后的 pump 推进；这里再兜底 pump 一次）
    this.pump();
    // 等待所有 executing 的 promise
    let pending = this.entries.filter((e) => e.state === "executing").map((e) => e.promise!);
    while (pending.length > 0) {
      await Promise.all(pending);
      this.pump(); // settle 后可能解锁新的排队工具
      pending = this.entries.filter((e) => e.state === "executing").map((e) => e.promise!);
    }
    // 标记 yielded 并按 idx 排序返回
    const out = this.entries
      .map((e) => {
        e.state = "yielded";
        return { idx: e.idx, result: e.result, error: e.error };
      })
      .sort((a, b) => a.idx - b.idx);
    return out;
  }

  /** 当前是否还有未收集完成的工具 */
  hasPending(): boolean {
    return this.entries.some((e) => e.state === "queued" || e.state === "executing");
  }

  /** 工具总数 */
  size(): number {
    return this.entries.length;
  }
}

/** GAP-01：流式工具执行是否启用（默认关闭，feature flag 可逆）。 */
export function isStreamingToolExecEnabled(): boolean {
  return process.env.SID_ENABLE_STREAMING_TOOL_EXEC === "1";
}
