/**
 * ToolExecutor — 工具执行共享组件
 *
 * 从 sub-agent.ts 提取，统一处理子代理的工具执行：
 * - 工具分类（只读/写入）
 * - 只读工具并行执行
 * - 写入工具串行执行
 * - _agentId 注入（防嵌套）
 * - 输出截断
 */

import type { ContentBlock } from "../llm/types.ts";
import type { LegacyTool as Tool } from "../tool/types.ts";
import type { Registry as ToolRegistry } from "../tool/registry.ts";
import { Manager as ContextManager } from "../context/manager.ts";
import { getLogger } from "../debug/logger.ts";

/**
 * 执行工具调用（子代理版本，无权限检查，支持并行执行）
 */
export async function executeTools(
  content: ContentBlock[],
  tools: ToolRegistry,
  signal?: AbortSignal,
): Promise<ContentBlock[]> {
  const log = getLogger();

  // 提取所有 tool_use 块，保留原始顺序索引
  const toolBlocks = content
    .map((block, idx) => ({ block, idx }))
    .filter((item): item is { block: ContentBlock & { type: "tool_use" }; idx: number } =>
      item.block.type === "tool_use"
    );

  if (toolBlocks.length === 0) return [];

  // 分离只读和写入工具
  const readOnlyBlocks: typeof toolBlocks = [];
  const writingBlocks: typeof toolBlocks = [];
  const notFoundBlocks: typeof toolBlocks = [];

  for (const item of toolBlocks) {
    const tool = tools.get(item.block.name);
    if (!tool) {
      notFoundBlocks.push(item);
      continue;
    }
    if (tool.readOnly?.() === true) {
      readOnlyBlocks.push(item);
    } else {
      writingBlocks.push(item);
    }
  }

  log.debug("SUBAGENT:TOOL", `工具分类: 只读 ${readOnlyBlocks.length} 个并行, 写入 ${writingBlocks.length} 个串行`);

  // 结果收集（按原始顺序索引存储）
  const resultMap = new Map<number, ContentBlock>();

  // 未找到的工具直接返回错误
  for (const { block, idx } of notFoundBlocks) {
    resultMap.set(idx, {
      type: "tool_result",
      tool_use_id: block.id,
      content: `工具 "${block.name}" 未找到`,
      is_error: true,
    });
  }

  // 只读工具并行执行
  if (readOnlyBlocks.length > 0) {
    const readResults = await Promise.all(
      readOnlyBlocks.map(({ block, idx }) =>
        executeSingleTool(block, tools, signal).then(r => ({ idx, result: r }))
      )
    );
    for (const { idx, result } of readResults) {
      resultMap.set(idx, result);
    }
  }

  // 写入工具串行执行
  for (const { block, idx } of writingBlocks) {
    const result = await executeSingleTool(block, tools, signal);
    resultMap.set(idx, result);
  }

  // 按原始顺序组装结果
  const results: ContentBlock[] = [];
  for (const { idx } of toolBlocks) {
    const result = resultMap.get(idx);
    if (result) results.push(result);
  }

  return results;
}

/** 执行单个工具 */
async function executeSingleTool(
  block: ContentBlock & { type: "tool_use" },
  tools: ToolRegistry,
  signal?: AbortSignal,
): Promise<ContentBlock> {
  const log = getLogger();
  const tool = tools.get(block.name);

  if (!tool) {
    return {
      type: "tool_result",
      tool_use_id: block.id,
      content: `工具 "${block.name}" 未找到`,
      is_error: true,
    };
  }

  try {
    // 注入 _agentId 标记，防止子代理调用 enter_plan_mode / sub_agent 形成套娃
    const result = await tool.execute({ ...block.input, _agentId: "sub-agent" }, signal);
    // 截断超大输出
    const truncated = ContextManager.truncateToolOutput(result.output);
    return {
      type: "tool_result",
      tool_use_id: block.id,
      content: truncated,
      is_error: result.isError,
    };
  } catch (err: any) {
    log.error("SUBAGENT:TOOL", `工具执行异常: ${block.name}`, { error: err.message });
    return {
      type: "tool_result",
      tool_use_id: block.id,
      content: `工具执行异常: ${err.message}`,
      is_error: true,
    };
  }
}
