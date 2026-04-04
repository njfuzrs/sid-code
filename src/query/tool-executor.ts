/**
 * 工具执行器
 * 从 app.ts 提取，处理工具调用的权限检查、并行/串行执行、快照创建
 */

import type { ContentBlock, ToolUseBlock } from "../llm/types.ts";
import type { Tool } from "../tool/types.ts";
import type { Checker, PermissionRequest } from "../permission/types.ts";
import type { HookSystem } from "../hook/system.ts";
import type { SessionState } from "../session/state.ts";
import type { Config } from "../config/config.ts";
import { Registry as ToolRegistry } from "../tool/registry.ts";
import { Manager as ContextManager } from "../context/manager.ts";
import { getLogger } from "../debug/index.ts";
import { isAbortError } from "../llm/errors.ts";

/** 工具执行器依赖 */
export interface ToolExecutorDeps {
  config: Config;
  toolRegistry: ToolRegistry;
  sessionState: SessionState;
  hookSystem: HookSystem;
  permissionChecker: Checker | null;
  /** 获取 AbortSignal */
  getAbortSignal: () => AbortSignal | undefined;
  /** 请求用户确认（TUI 回调或 headless 自动决策） */
  requestUserConfirmation: (desc: string, permReq: PermissionRequest, toolName: string, toolInput: unknown) => Promise<boolean>;
  /** Plan Mode 状态转换处理 */
  handlePlanModeTransitions?: (toolBlocks: Array<{ block: ToolUseBlock; idx: number }>, resultMap: Map<number, ContentBlock>) => Promise<void>;
  /** Plan Mode 系统提醒 */
  getPlanModeReminder?: () => Promise<string | null>;
  /** JIT 上下文发现 */
  discoverJitContext?: (toolBlocks: ToolUseBlock[]) => Promise<void>;
}

/**
 * 执行工具调用（含权限检查，只读工具并行、写入工具串行）
 */
export async function executeTools(
  content: ContentBlock[],
  deps: ToolExecutorDeps,
): Promise<ContentBlock[]> {
  const log = getLogger();

  // 提取所有 tool_use 块，保留原始顺序索引
  const toolBlocks = content
    .map((block, idx) => ({ block, idx }))
    .filter((item): item is { block: ToolUseBlock; idx: number } => item.block.type === "tool_use");

  if (toolBlocks.length === 0) return [];

  // 收集本次工具调用会修改的文件路径（用于创建快照）
  const affectedFiles = getAffectedFiles(toolBlocks.map(t => t.block));

  // 在工具执行前统一创建快照
  if (affectedFiles.length > 0) {
    try {
      const { getCheckpointManager } = await import("../checkpoint/manager.ts");
      const cpMgr = await getCheckpointManager(
        deps.sessionState.sessionId,
        deps.config.checkpoint,
      );
      const toolNames = toolBlocks.map(t => t.block.name).join(", ");
      const toolSummary = affectedFiles.join(", ");
      await cpMgr.createSnapshot(affectedFiles, toolNames, toolSummary);
    } catch (err: any) {
      log.warn("CHECKPOINT", `创建快照失败: ${err.message}`);
    }
  }

  // 权限预检：先对所有工具做权限检查，收集通过/拒绝结果
  const checkedTools: { block: ToolUseBlock; tool: Tool; idx: number }[] = [];
  const rejectedResults: Map<number, ContentBlock> = new Map();

  for (const { block, idx } of toolBlocks) {
    const tool = deps.toolRegistry.get(block.name);
    if (!tool) {
      log.error("TOOL", `工具未找到: ${block.name}`);
      rejectedResults.set(idx, {
        type: "tool_result",
        tool_use_id: block.id,
        content: `工具 "${block.name}" 未找到`,
        is_error: true,
      });
      continue;
    }

    // 权限检查
    if (deps.permissionChecker) {
      const permReq: PermissionRequest = {
        toolName: block.name,
        input: block.input,
        description: (block.input as any)?.description
          ? `${block.name}: ${(block.input as any).description}`
          : `${block.name}: ${JSON.stringify(block.input).slice(0, 120)}`,
      };
      const decision = await deps.permissionChecker.check(permReq);

      if (!decision.allowed) {
        if (decision.needsConfirmation) {
          const desc = decision.reason || `工具 "${block.name}" 需要用户确认`;
          log.info("PERMISSION", `请求用户确认: ${desc}`);
          const confirmed = await deps.requestUserConfirmation(desc, permReq, block.name, block.input);
          if (!confirmed) {
            log.info("PERMISSION", `用户拒绝: ${block.name}`);
            rejectedResults.set(idx, {
              type: "tool_result",
              tool_use_id: block.id,
              content: `用户拒绝执行工具 "${block.name}"`,
              is_error: true,
            });
            continue;
          }
          log.info("PERMISSION", `用户批准: ${block.name}`);
        } else {
          log.warn("PERMISSION", `权限拒绝: ${block.name} - ${decision.reason}`);
          rejectedResults.set(idx, {
            type: "tool_result",
            tool_use_id: block.id,
            content: `权限拒绝: ${decision.reason}`,
            is_error: true,
          });
          continue;
        }
      }
    }

    checkedTools.push({ block, tool, idx });
  }

  // 分离只读和写入工具
  const readOnlyTools = checkedTools.filter(({ tool }) => tool.readOnly?.() === true);
  const writingTools = checkedTools.filter(({ tool }) => tool.readOnly?.() !== true);

  log.debug("TOOL", `工具分类: 只读 ${readOnlyTools.length} 个并行执行, 写入 ${writingTools.length} 个串行执行`);

  // 结果收集（按原始顺序索引存储）
  const resultMap: Map<number, ContentBlock> = new Map(rejectedResults);

  // 只读工具并行执行
  if (readOnlyTools.length > 0) {
    const readResults = await Promise.allSettled(
      readOnlyTools.map(({ block, tool, idx }) =>
        executeSingleTool(block, tool, deps).then(r => ({ idx, result: r }))
      ),
    );
    for (const r of readResults) {
      if (r.status === "rejected" && isAbortError(r.reason)) {
        throw r.reason;
      }
    }
    for (const r of readResults) {
      if (r.status === "fulfilled") {
        resultMap.set(r.value.idx, r.value.result);
      }
    }
  }

  // 写入工具串行执行
  for (const { block, tool, idx } of writingTools) {
    const result = await executeSingleTool(block, tool, deps);
    resultMap.set(idx, result);
  }

  // 按原始顺序组装结果
  const results: ContentBlock[] = [];
  for (const { idx } of toolBlocks) {
    const result = resultMap.get(idx);
    if (result) results.push(result);
  }

  // Plan Mode 状态转换处理
  if (deps.handlePlanModeTransitions) {
    await deps.handlePlanModeTransitions(toolBlocks, resultMap);
  }

  // Plan Mode 系统提醒
  if (deps.getPlanModeReminder && results.length > 0) {
    const reminder = await deps.getPlanModeReminder();
    if (reminder) {
      const lastResult = results[results.length - 1];
      if (lastResult.type === "tool_result" && typeof lastResult.content === "string") {
        (lastResult as any).content = lastResult.content + "\n\n" + reminder;
      }
    }
  }

  // JIT 上下文发现
  if (deps.discoverJitContext) {
    await deps.discoverJitContext(toolBlocks.map(t => t.block));
  }

  return results;
}

/** 执行单个工具 */
export async function executeSingleTool(
  block: ToolUseBlock,
  tool: Tool,
  deps: ToolExecutorDeps,
): Promise<ContentBlock> {
  const log = getLogger();

  log.toolStart(block.name, block.input);

  // pre_tool_use hook
  const preToolResult = await deps.hookSystem.firePreToolUseEvent(
    block.name,
    block.input as Record<string, unknown>,
    block.id,
  );
  if (preToolResult.finalOutput?.isBlockingDecision()) {
    const reason = preToolResult.finalOutput.getEffectiveReason();
    log.info("HOOK", `工具 ${block.name} 被 hook 阻止: ${reason}`);
    return {
      type: "tool_result",
      tool_use_id: block.id,
      content: `Hook 阻止执行: ${reason}`,
      is_error: true,
    };
  }

  // 检查 hook 是否修改了工具输入
  let effectiveInput = block.input;
  if (preToolResult.finalOutput && "getModifiedToolInput" in preToolResult.finalOutput) {
    const modified = (preToolResult.finalOutput as any).getModifiedToolInput?.();
    if (modified) {
      log.info("HOOK", `工具 ${block.name} 输入被 hook 修改`);
      effectiveInput = modified;
    }
  }

  const startTime = Date.now();

  try {
    const result = await tool.execute(effectiveInput, deps.getAbortSignal());
    const elapsed = Date.now() - startTime;

    deps.sessionState.addToolDuration(elapsed);

    const truncatedOutput = ContextManager.truncateToolOutput(result.output);

    log.toolEnd(block.name, result.output, !!result.isError, elapsed);

    // post_tool_use hook
    const postResult = await deps.hookSystem.firePostToolUseEvent(
      block.name,
      block.input as Record<string, unknown>,
      { output: truncatedOutput, isError: result.isError },
      result.isError,
      block.id,
      { duration_ms: elapsed },
    );

    let finalOutput = truncatedOutput;
    const additionalCtx = postResult.finalOutput?.getAdditionalContext();
    if (additionalCtx) {
      log.info("HOOK", `PostToolUse hook 追加上下文到 ${block.name} 结果`);
      finalOutput = truncatedOutput + "\n\n[Hook 附加上下文]\n" + additionalCtx;
    }

    return {
      type: "tool_result",
      tool_use_id: block.id,
      content: finalOutput,
      is_error: result.isError,
    };
  } catch (err: any) {
    const elapsed = Date.now() - startTime;
    deps.sessionState.addToolDuration(elapsed);

    if (isAbortError(err)) {
      log.info("TOOL", `工具 ${block.name} 被用户取消 (${elapsed}ms)`);
      throw err;
    }

    log.error("TOOL", `执行异常: ${block.name} (${elapsed}ms)`, {
      error: err.message,
      stack: err.stack,
    });

    deps.hookSystem.firePostToolUseFailureEvent(
      block.name,
      block.input as Record<string, unknown>,
      err.message,
      block.id,
    ).catch((e: any) => log.error("HOOK", `post_tool_use_failure hook 失败: ${e.message}`));

    return {
      type: "tool_result",
      tool_use_id: block.id,
      content: `工具执行异常: ${err.message}`,
      is_error: true,
    };
  }
}

/** 根据工具类型提取受影响的文件路径 */
function getAffectedFiles(toolBlocks: ToolUseBlock[]): string[] {
  const files: string[] = [];
  for (const block of toolBlocks) {
    switch (block.name) {
      case "write":
      case "edit":
        if ((block.input as any)?.file_path) {
          files.push((block.input as any).file_path);
        }
        break;
      default:
        break;
    }
  }
  return files;
}
