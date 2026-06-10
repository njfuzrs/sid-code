/**
 * 工具执行器
 * 从 app.ts 提取，处理工具调用的权限检查、并行/串行执行、快照创建
 */

import type { ContentBlock, ToolUseBlock } from "../llm/types.ts";
import type { LegacyTool as Tool } from "../tool/types.ts";
import type { Checker, PermissionRequest } from "../permission/types.ts";
import type { HookSystem } from "../hook/system.ts";
import type { SessionState } from "../session/state.ts";
import type { Config } from "../config/config.ts";
import { Registry as ToolRegistry } from "../tool/registry.ts";
import { getLogger } from "../debug/index.ts";
import { isAbortError } from "../llm/errors.ts";
import { processToolResult } from "../tool/result-storage.ts";
import { yieldMissingToolResults, collectToolResultIdsFromBlocks } from "../agent/tool-result-guard.ts";

/**
 * P2-1（占位消息治理）：为成功但输出为空的工具生成有语义的"无输出"描述。
 * 让模型能区分"命令成功但无输出"与"出错/未执行"，并避免空 tool_result 在协议层
 * 被兜底成无信息的 "(empty)" 进而触发占位污染。
 */
function describeEmptyOutput(toolName: string): string {
  switch (toolName) {
    case "bash":
      return "(命令执行成功，无标准输出)";
    case "grep":
      return "(未匹配到任何结果)";
    case "glob":
      return "(未找到匹配的文件)";
    case "edit":
    case "write":
      return "(文件写入成功)";
    default:
      return `(工具 ${toolName} 执行成功，无输出内容)`;
  }
}

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
  /**
   * Plan Mode 状态转换处理。
   *
   * 返回 followup：若本次处理需要在 tool_results 之后再 enqueue 一条 user 消息
   * （例如 plan 批准反馈），通过 followup 返回；上层 loop 在 addMessage(toolResults)
   * 之后再 addMessage(followup)。
   *
   * 不能在此函数内部直接 ctxMgr.addMessage——会让 user(text) 排在 user(tool_result) 之前，
   * 违反 OpenAI tool_calls 协议（必须 assistant.tool_calls → 紧接 tool 消息）。详见 ADR-019。
   */
  handlePlanModeTransitions?: (
    toolBlocks: Array<{ block: ToolUseBlock; idx: number }>,
    resultMap: Map<number, ContentBlock>,
  ) => Promise<{ followup?: ContentBlock[] } | void>;
  /** Plan Mode 系统提醒 */
  getPlanModeReminder?: () => Promise<string | null>;
  /** JIT 上下文发现 */
  discoverJitContext?: (toolBlocks: ToolUseBlock[]) => Promise<void>;
}

/**
 * executeTools 返回结构。
 *
 * - results：常规 tool_result blocks，必须立即 addMessage(user, results)
 * - followup（可选）：需要在 results 之后再 addMessage(user, followup) 的消息块。
 *   ADR-019：plan-approved 反馈走这条通道，避免插在 tool_result 之前导致 OpenAI 400。
 */
export interface ExecuteToolsResult {
  results: ContentBlock[];
  followup?: ContentBlock[];
}

/**
 * 执行工具调用（含权限检查，只读工具并行、写入工具串行）
 */
export async function executeTools(
  content: ContentBlock[],
  deps: ToolExecutorDeps,
): Promise<ExecuteToolsResult> {
  const log = getLogger();

  // 提取所有 tool_use 块，保留原始顺序索引
  const toolBlocks = content
    .map((block, idx) => ({ block, idx }))
    .filter((item): item is { block: ToolUseBlock; idx: number } => item.block.type === "tool_use");

  if (toolBlocks.length === 0) return { results: [] };

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
      const decision = await deps.permissionChecker.check(permReq, tool);

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

  // 分区并发策略：基于 isConcurrencySafe(input) 输入感知分区
  // 并发安全的工具全部并行，非并发安全的工具串行执行
  const concurrent: typeof checkedTools = [];
  const sequential: typeof checkedTools = [];

  for (const item of checkedTools) {
    const { tool, block } = item;
    // 优先使用细粒度的 isConcurrencySafe(input)，回退到 readOnly()
    const isSafe = tool.isConcurrencySafe
      ? tool.isConcurrencySafe(block.input)
      : (tool.readOnly?.() ?? false);
    if (isSafe) {
      concurrent.push(item);
    } else {
      sequential.push(item);
    }
  }

  log.debug("TOOL", `分区并发: 并行 ${concurrent.length} 个, 串行 ${sequential.length} 个`);

  // 结果收集（按原始顺序索引存储）
  const resultMap: Map<number, ContentBlock> = new Map(rejectedResults);

  // 并发安全的工具：并行执行
  if (concurrent.length > 0) {
    const readResults = await Promise.allSettled(
      concurrent.map(({ block, tool, idx }) =>
        executeSingleTool(block, tool, deps).then(r => ({ idx, result: r }))
      ),
    );
    // abort 优先：任一工具被取消，立即向上抛（由 loop.ts catch 兜底补齐）
    for (const r of readResults) {
      if (r.status === "rejected" && isAbortError(r.reason)) {
        throw r.reason;
      }
    }
    for (let i = 0; i < readResults.length; i++) {
      const r = readResults[i];
      if (r.status === "fulfilled") {
        resultMap.set(r.value.idx, r.value.result);
      } else {
        // 非 abort 的 rejected（如 hook 异常）：executeSingleTool 的 catch 理论上会
        // 返回 error tool_result，走不到这里；但若异常发生在 catch 之外（pre hook 等），
        // Promise 会 rejected。此处把它转成 error tool_result，避免孤儿 tool_use。
        const { block, idx } = concurrent[i];
        log.error("TOOL", `并行工具 ${block.name} 异常未被内部捕获: ${r.reason?.message ?? r.reason}`);
        resultMap.set(idx, {
          type: "tool_result",
          tool_use_id: block.id,
          content: `工具执行异常: ${r.reason?.message ?? String(r.reason)}`,
          is_error: true,
        });
      }
    }
  }

  // 非并发安全的工具：串行执行（等待并行工具完成后才开始）
  for (const { block, tool, idx } of sequential) {
    const result = await executeSingleTool(block, tool, deps);
    resultMap.set(idx, result);
  }

  // 按原始顺序组装结果
  //
  // 协议级不变量：N 个 tool_use 必须产出 N 个 tool_result（OpenAI tool_calls 要求
  // assistant.tool_calls 后紧跟对每个 tool_call_id 的 tool 消息，缺一即 400）。
  // 正常路径下 resultMap 应已含每个 idx，但为防御以下情况仍做兜底：
  //   - 并发分支 Promise.allSettled 中非 abort 的 rejected（其 tool_result 不会进 resultMap）
  //   - 未来新增的提前 return / continue 路径遗漏某个 idx
  // 这些情况 executeTools 会正常 return（不 throw），故 loop.ts 的 catch 兜底不会触发，
  // 必须在此处补齐。参见 ADR-039。
  const results: ContentBlock[] = [];
  const missingBlocks: ToolUseBlock[] = [];
  for (const { block, idx } of toolBlocks) {
    const result = resultMap.get(idx);
    if (result) {
      results.push(result);
    } else {
      missingBlocks.push(block);
    }
  }
  if (missingBlocks.length > 0) {
    log.error(
      "TOOL",
      `检测到 ${missingBlocks.length} 个 tool_use 缺少 tool_result，补齐错误占位以维持协议不变量: ${missingBlocks.map(b => b.name).join(", ")}`,
    );
    for (const missing of yieldMissingToolResults(
      [{ role: "assistant", content: toolBlocks.map(t => t.block) }],
      collectToolResultIdsFromBlocks(results),
      "工具执行异常：未产生结果（已由协议兜底补齐）",
    )) {
      results.push(missing);
    }
  }

  // Plan Mode 状态转换处理
  // ADR-019：followup 由上层 loop 在 addMessage(toolResults) 之后再 enqueue，
  // 不能在此函数内部直接 addMessage。
  let followup: ContentBlock[] | undefined;
  if (deps.handlePlanModeTransitions) {
    const transitionRet = await deps.handlePlanModeTransitions(toolBlocks, resultMap);
    if (transitionRet && transitionRet.followup && transitionRet.followup.length > 0) {
      followup = transitionRet.followup;
    }
  }

  // JIT 上下文发现
  if (deps.discoverJitContext) {
    await deps.discoverJitContext(toolBlocks.map(t => t.block));
  }

  return { results, followup };
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

    const truncatedOutput = processToolResult(block.name, block.id, result.output);

    log.toolEnd(block.name, result.output, !!result.isError, elapsed);

    // P2-1（占位消息治理，根因 5.1）：工具成功但输出为空时，给出**有语义的"无输出"描述**，
    // 而不是把空串交给协议层兜底成无信息的 "(empty)"。这样模型能区分"命令成功但无输出"
    // 与"命令未执行/出错"，也避免空 tool_result 触发后续占位插入污染上下文。
    const normalizedOutput =
      !result.isError && (!truncatedOutput || truncatedOutput.trim().length === 0)
        ? describeEmptyOutput(block.name)
        : truncatedOutput;

    // post_tool_use hook
    const postResult = await deps.hookSystem.firePostToolUseEvent(
      block.name,
      block.input as Record<string, unknown>,
      { output: normalizedOutput, isError: result.isError },
      result.isError,
      block.id,
      { duration_ms: elapsed },
    );

    let finalOutput = normalizedOutput;
    const additionalCtx = postResult.finalOutput?.getAdditionalContext();
    if (additionalCtx) {
      log.info("HOOK", `PostToolUse hook 追加上下文到 ${block.name} 结果`);
      finalOutput = truncatedOutput + "\n\n[Hook 附加上下文]\n" + additionalCtx;
    }

    // LSP 文件变更通知（write/edit 工具后异步投递，不阻塞工具返回）
    if (!result.isError && (block.name === "write" || block.name === "edit")) {
      void notifyLSPFileChange(block.input as Record<string, unknown>);
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

/**
 * 通知 LSP 文件已变更（write/edit 后调用）。
 * 从磁盘读取最新内容投递给 LSP；LSP 未就绪或读取失败时静默跳过。
 */
async function notifyLSPFileChange(input: Record<string, unknown>): Promise<void> {
  const filePath = (input?.file_path ?? input?.path) as string | undefined;
  if (!filePath) return;
  try {
    const { getLSPManager } = await import("../lsp/manager.ts");
    if (!getLSPManager()) return; // LSP 未启用，避免无谓读盘
    const { readFile } = await import("fs/promises");
    const content = await readFile(filePath, "utf-8");
    const { notifyFileChanged } = await import("../lsp/manager.ts");
    await notifyFileChanged(filePath, content);
  } catch {
    // 静默忽略：LSP 是可选增强
  }
}
