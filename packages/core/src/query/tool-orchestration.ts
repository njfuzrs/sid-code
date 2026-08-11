/**
 * GAP-10：工具编排层（分区调度算法）
 *
 * 对标 claude-code toolOrchestration.ts：将分区/调度策略从执行管线中分离，
 * 使其可独立测试和替换（如后续 GAP-01 流式执行可替换调度策略而不动执行层）。
 *
 * 当前提取范围：
 * - partitionToolCalls()：贪心连续合并分区算法（GAP-03 实现，此处导出为独立函数）
 * - getMaxToolConcurrency()：并发上限配置读取
 *
 * 执行层（executeSingleTool）保留在 tool-executor.ts，因其紧耦合 deps/hooks/abort-controller。
 * 完整的 executeToolBatches() 提取待 GAP-01 流式执行落地时一并完成——届时调度器需区分
 * "批量模式"与"流式模式"两种策略，提取会有实际收益。
 */

import type { LegacyTool as Tool } from "../tool/types.ts";
import type { ToolUseBlock } from "../llm/types.ts";

/** 分区批次 */
export interface ToolBatch {
  /** 批次内工具是否可并发执行 */
  isConcurrencySafe: boolean;
  /** 批次内的工具项 */
  items: Array<{ block: ToolUseBlock; tool: Tool; idx: number }>;
}

/**
 * GAP-03 贪心连续合并分区算法。
 *
 * 规则：
 *   - 连续的并发安全工具合并为一个并行批次
 *   - 非并发安全工具各自成为独立的串行批次（或连续非安全工具合成同一串行批次）
 *   - 保留模型的隐式顺序语义（"先 Read → Edit → 再 Read"不被打乱）
 *
 * 并发安全判定：优先 `isConcurrencySafe(input)` 输入感知，回退 `readOnly()`。
 *
 * @returns 有序批次数组。调用方按序执行：并行批次并行跑（信号量限流），串行批次逐个跑。
 */
export function partitionToolCalls(
  checkedTools: Array<{ block: ToolUseBlock; tool: Tool; idx: number }>,
): ToolBatch[] {
  const batches: ToolBatch[] = [];
  for (const item of checkedTools) {
    const { tool, block } = item;
    const isSafe = tool.isConcurrencySafe
      ? tool.isConcurrencySafe(block.input)
      : (tool.readOnly?.() ?? false);
    // 连续的并发安全工具合并为一个批次
    if (batches.length > 0 && batches[batches.length - 1].isConcurrencySafe === isSafe && isSafe) {
      batches[batches.length - 1].items.push(item);
    } else {
      batches.push({ isConcurrencySafe: isSafe, items: [item] });
    }
  }
  return batches;
}

/**
 * 获取工具并发上限（对标 claude-code getMaxToolUseConcurrency()）。
 * 环境变量 SID_TOOL_MAX_CONCURRENT 覆盖默认值 10。
 */
export function getMaxToolConcurrency(): number {
  const raw = process.env.SID_TOOL_MAX_CONCURRENT;
  if (raw === undefined || raw === "") return 10;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 10;
}
