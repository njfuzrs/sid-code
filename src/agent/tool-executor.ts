/**
 * ToolExecutor — 工具执行共享组件
 *
 * 从 sub-agent.ts 提取，统一处理子代理的工具执行：
 * - 工具分类（只读/写入）
 * - 只读工具并行执行
 * - 写入工具串行执行
 * - _agentId 注入（防嵌套）
 * - 输出截断
 * - Pre/PostToolUse hook 触发（接通可观测性：execute_tool span 与主循环对齐）
 *
 * hook 缺口修复：此前子代理工具执行完全不触发 hook，导致 TelemetryHookProbe
 * 无法为子代理工具创建 execute_tool span（主循环有、子代理没有，可观测性断层）。
 * 现把 hookSystem 透传进来，在工具前后 firePreToolUseEvent / firePostToolUseEvent，
 * 与 query/tool-executor.ts 主循环口径一致（含 duration_ms、blocking 决策、输入修改）。
 */

import type { ContentBlock } from "../llm/types.ts";
import type { Registry as ToolRegistry } from "../tool/registry.ts";
import { Manager as ContextManager } from "../context/manager.ts";
import { getLogger } from "../debug/logger.ts";
import { validateToolInput } from "../tool/input-validator.ts";
import type { HookSystem } from "../hook/system.ts";
import type { Checker, PermissionRequest } from "../permission/types.ts";
import type { ToolProgressData } from "../tool/types.ts";
import { buildHookModifiedNotice } from "../query/tool-executor.ts";
import { stripInternalFields } from "../tool/internal-fields.ts";

/**
 * GAP-07（子代理侧补齐）：子代理工具进度回调。
 * 长跑工具在执行期间吐出的中间进度经此上报（如汇总到父循环状态栏）。
 * 未注入时安全跳过。
 */
export type SubAgentToolProgress = (
  toolName: string,
  toolUseId: string,
  event: ToolProgressData,
) => void;

/**
 * 执行工具调用（子代理版本，支持权限检查与并行执行）
 *
 * @param hookSystem 透传的 hook 系统；存在时在每个工具前后触发 Pre/PostToolUse hook
 *                   （驱动 execute_tool span / 可观测性）。缺省时退化为纯执行（兼容旧测试）。
 * @param permissionChecker 权限检查器（子代理用 dontAsk 语义）。缺省时不做权限检查。
 */
export async function executeTools(
  content: ContentBlock[],
  tools: ToolRegistry,
  signal?: AbortSignal,
  hookSystem?: HookSystem,
  permissionChecker?: Checker,
  onProgress?: SubAgentToolProgress,
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
    // GAP-05：对齐主循环——优先 isConcurrencySafe(input) 输入感知判定，回退 readOnly()。
    // 此前子代理只用 readOnly() 二分，导致只读 bash（如 ls/cat，主循环经 isReadOnlyCommand
    // 判定可并行）在子代理里被当作非只读串行化，子代理效率低于主循环。
    const isSafe = tool.isConcurrencySafe
      ? tool.isConcurrencySafe(item.block.input)
      : (tool.readOnly?.() ?? false);
    if (isSafe) {
      readOnlyBlocks.push(item);
    } else {
      writingBlocks.push(item);
    }
  }

  log.debug("SUBAGENT:TOOL", `工具分类: 并发安全 ${readOnlyBlocks.length} 个并行, 其余 ${writingBlocks.length} 个串行`);

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

  // 并发安全工具并行执行
  if (readOnlyBlocks.length > 0) {
    const readResults = await Promise.all(
      readOnlyBlocks.map(({ block, idx }) =>
        executeSingleTool(block, tools, signal, hookSystem, permissionChecker, onProgress).then(r => ({ idx, result: r }))
      )
    );
    for (const { idx, result } of readResults) {
      resultMap.set(idx, result);
    }
  }

  // 非并发安全工具串行执行
  for (const { block, idx } of writingBlocks) {
    const result = await executeSingleTool(block, tools, signal, hookSystem, permissionChecker, onProgress);
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
  hookSystem?: HookSystem,
  permissionChecker?: Checker,
  onProgress?: SubAgentToolProgress,
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

  // pre_tool_use hook（子代理工具执行接入 hook 链）。
  // 与主循环一致：尊重 blocking 决策与输入修改。hook 失败不阻断执行（catch 兜底）。
  let effectiveInput: Record<string, unknown> = block.input as Record<string, unknown>;
  // 与主循环口径一致：hook 改写参数后给模型一条前置告知，避免按原参数误判结果。
  let hookModifiedNotice = "";
  if (hookSystem) {
    try {
      const preToolResult = await hookSystem.firePreToolUseEvent(
        block.name,
        block.input as Record<string, unknown>,
        block.id,
      );
      if (preToolResult.finalOutput?.isBlockingDecision()) {
        const reason = preToolResult.finalOutput.getEffectiveReason();
        log.info("SUBAGENT:HOOK", `工具 ${block.name} 被 hook 阻止: ${reason}`);
        return {
          type: "tool_result",
          tool_use_id: block.id,
          content: `Hook 阻止执行: ${reason}`,
          is_error: true,
        };
      }
      if (preToolResult.finalOutput && "getModifiedToolInput" in preToolResult.finalOutput) {
        const modified = (preToolResult.finalOutput as any).getModifiedToolInput?.();
        if (modified) {
          log.info("SUBAGENT:HOOK", `工具 ${block.name} 输入被 hook 修改`);
          effectiveInput = modified as Record<string, unknown>;
          hookModifiedNotice = buildHookModifiedNotice(block.name);
        }
      }
    } catch (err: any) {
      log.error("SUBAGENT:HOOK", `pre_tool_use hook 失败: ${err.message}`);
    }
  }

  // 权限检查（子代理 dontAsk 语义：危险命令/safetyCheck 直接拦截，ask 场景自动 deny）
  if (permissionChecker) {
    const permReq: PermissionRequest = {
      toolName: block.name,
      input: effectiveInput,
      description: `${block.name}: ${JSON.stringify(effectiveInput).slice(0, 120)}`,
    };
    const decision = await permissionChecker.check(permReq, tool);
    if (!decision.allowed) {
      // 子代理无 UI 通道，needsConfirmation 也直接 deny（dontAsk 语义）
      const reason = decision.reason || "子代理不允许此操作";
      log.info("SUBAGENT:PERM", `权限拒绝 ${block.name}: ${reason}`);
      return {
        type: "tool_result",
        tool_use_id: block.id,
        content: `权限拒绝: ${reason}`,
        is_error: true,
      };
    }
  }

  // zod 运行时校验：用原始 block.input（或 hook 修改后的）校验（不含注入的 _agentId 元字段，
  // 避免严格 schema 的 additionalProperties:false 把 _agentId 当非法字段拒绝）。
  // 校验通过后再注入 _agentId 防套娃。
  const validation = validateToolInput(tool, effectiveInput);
  if (!validation.ok) {
    log.info("SUBAGENT:TOOL", `工具 ${block.name} 参数校验失败: ${validation.message}`);
    return {
      type: "tool_result",
      tool_use_id: block.id,
      content: validation.message,
      is_error: true,
    };
  }

  const startTime = Date.now();
  try {
    // GAP-08：纵深防御——先剥离模型可能自行伪造的内部字段（如 _agentId），
    // 再注入受控的 _agentId="sub-agent" 防套娃。顺序不能反：若先注入后剥离会把自己剥掉。
    // 防止模型伪造 _agentId 绕过子代理套娃检测（passthrough schema 下 strict 拦不住）。
    const cleanedInput = stripInternalFields(validation.data) as Record<string, unknown>;
    // GAP-07：把 onProgress 桥接给 tool.execute（长跑工具中间进度上报）。
    const progressCallback = onProgress
      ? (event: ToolProgressData) => onProgress(block.name, block.id, event)
      : undefined;
    const result = await tool.execute(
      { ...cleanedInput, _agentId: "sub-agent" },
      signal,
      progressCallback,
    );
    const elapsed = Date.now() - startTime;

    // LSP 文件变更通知（子代理侧补齐）：edit/write 成功后同步最新内容给 LSP，
    // 复用主循环同一套 syncFileToLSP 编排（clearForFile + didChange + didSave）。
    // 异步 fire-and-forget，不阻塞工具返回；诊断稍后经 agentic-loop 每轮注入。
    // 此前子代理编辑代码后完全不通知 LSP，语言服务器看不到新内容 → 诊断断层。
    if (!result.isError && (block.name === "write" || block.name === "edit")) {
      const editedPath = (effectiveInput?.file_path ?? effectiveInput?.path) as string | undefined;
      if (editedPath) {
        void import("../lsp/manager.ts")
          .then(({ syncFileToLSP }) => syncFileToLSP(editedPath))
          .catch(() => { /* best-effort，失败不影响子代理执行 */ });
      }
    }

    // 截断超大输出
    const truncated = ContextManager.truncateToolOutput(result.output);

    // post_tool_use hook（驱动 execute_tool span，带真实 duration_ms）
    if (hookSystem) {
      hookSystem.firePostToolUseEvent(
        block.name,
        effectiveInput,
        { output: truncated, isError: result.isError },
        result.isError,
        block.id,
        { duration_ms: elapsed },
      ).catch((e: any) => log.error("SUBAGENT:HOOK", `post_tool_use hook 失败: ${e.message}`));
    }

    return {
      type: "tool_result",
      tool_use_id: block.id,
      content: hookModifiedNotice ? hookModifiedNotice + "\n\n" + truncated : truncated,
      is_error: result.isError,
      // 结构化 diff 透传(edit/write):与主路径一致,供子代理结果在 UI 渲染高亮
      ...(result.structuredPatch?.length ? { structuredPatch: result.structuredPatch } : {}),
    };
  } catch (err: any) {
    log.error("SUBAGENT:TOOL", `工具执行异常: ${block.name}`, { error: err.message });
    // post_tool_use_failure hook（异常路径也接入 hook，与主循环对齐）
    if (hookSystem) {
      hookSystem.firePostToolUseFailureEvent(
        block.name,
        effectiveInput,
        err.message,
        block.id,
      ).catch((e: any) => log.error("SUBAGENT:HOOK", `post_tool_use_failure hook 失败: ${e.message}`));
    }
    return {
      type: "tool_result",
      tool_use_id: block.id,
      content: `工具执行异常: ${err.message}`,
      is_error: true,
    };
  }
}
