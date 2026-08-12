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
import { buildHookModifiedNotice, interpretPreToolUse } from "../query/tool-executor.ts";
import { stripInternalFields } from "../tool/internal-fields.ts";
import { resolveResultDisplayMode } from "../tool/result-display-mode.ts";

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
 * @param permissionChecker 权限检查器（子代理用 dontAsk 语义）。B0：缺省时改为**分级
 *                          fail-closed**——只读工具放行，写类工具（非 isConcurrencySafe/
 *                          readOnly）直接拒绝，不再是"缺省即不检查"的静默放过。
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
    .filter(
      (item): item is { block: ContentBlock & { type: "tool_use" }; idx: number } =>
        item.block.type === "tool_use",
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

  log.debug(
    "SUBAGENT:TOOL",
    `工具分类: 并发安全 ${readOnlyBlocks.length} 个并行, 其余 ${writingBlocks.length} 个串行`,
  );

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
        executeSingleTool(block, tools, signal, hookSystem, permissionChecker, onProgress).then(
          (r) => ({ idx, result: r }),
        ),
      ),
    );
    for (const { idx, result } of readResults) {
      resultMap.set(idx, result);
    }
  }

  // 非并发安全工具串行执行
  for (const { block, idx } of writingBlocks) {
    const result = await executeSingleTool(
      block,
      tools,
      signal,
      hookSystem,
      permissionChecker,
      onProgress,
    );
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

/**
 * 「工具未执行成功」的收尾统一出口：补 fire PostToolUseFailure（子代理侧）。
 *
 * 与主循环 `query/tool-executor.ts` 的同名 helper 同源同语义：PreToolUse 已 fire 之后
 * 的所有早退分支（hook 阻止 / 权限拒绝 / 参数校验失败）都必须补一次 Failure 收尾，
 * 否则 Pre/Post 不成对——依赖配对的用户 hook 永久悬空，且 `execute_tool` span 是在
 * PostToolUse* 事件里创建的，这些失败在可观测性里完全不存在。
 *
 * 子代理侧尤其不能漏：子代理的失败本来就更难排查（无 UI、结论经父代理转述），
 * 若 trace 里连"这次工具调用失败了"都查不到，只能靠读子代理原始 transcript 考古。
 *
 * fire-and-forget + 全程 catch：这一层是可观测性补齐，绝不能成为新的失败源。
 */
function firePostToolUseFailure(
  hookSystem: HookSystem | undefined,
  block: ContentBlock & { type: "tool_use" },
  reason: string,
  toolInput?: Record<string, unknown>,
  /** 调度器视角墙钟耗时；缺它则失败工具的 span 无耗时属性（见主循环同名 helper 注释） */
  durationMs?: number,
): void {
  if (!hookSystem) return;
  const log = getLogger();
  try {
    void hookSystem
      .firePostToolUseFailureEvent?.(
        block.name,
        (toolInput ?? block.input) as Record<string, unknown>,
        reason,
        block.id,
        durationMs !== undefined ? { duration_ms: durationMs } : undefined,
      )
      ?.catch?.((e: any) =>
        log.error("SUBAGENT:HOOK", `post_tool_use_failure hook 失败: ${e?.message ?? e}`),
      );
  } catch (e: any) {
    log.error("SUBAGENT:HOOK", `post_tool_use_failure 触发异常（忽略）: ${e?.message ?? e}`);
  }
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

  // 计时锚点：供各早退分支给 PostToolUseFailure 带上 duration_ms。
  // 下方 startTime 只在 tool.execute 前设，覆盖不到 hook/权限/校验这些早退分支，
  // 故这里另立一个调度器视角的墙钟锚点（与主循环 toolStartedAt 同口径）。
  const toolStartedAt = Date.now();

  // pre_tool_use hook（子代理工具执行接入 hook 链）。
  // 与主循环一致：尊重 blocking 决策与输入修改。hook 失败不阻断执行（catch 兜底）。
  let effectiveInput: Record<string, unknown> = block.input as Record<string, unknown>;
  // 与主循环口径一致：hook 改写参数后给模型一条前置告知，避免按原参数误判结果。
  let hookModifiedNotice = "";
  // G3：PreToolUse permissionDecision（allow/ask），注入下方权限检查。
  let hookPermissionDecision: "allow" | "ask" | undefined;
  if (hookSystem) {
    try {
      const preToolResult = await hookSystem.firePreToolUseEvent(
        block.name,
        block.input as Record<string, unknown>,
        block.id,
      );
      // G3：与主循环共享同一 PreToolUse 解读（block/permissionDecision/updatedInput）
      const interp = interpretPreToolUse(preToolResult, block.input);
      if (interp.blocked) {
        log.info("SUBAGENT:HOOK", `工具 ${block.name} 被 hook 阻止: ${interp.blockReason}`);
        // Pre/Post 配对：本分支上方刚 fire 过 PreToolUse，必须补 Failure 收尾。
        firePostToolUseFailure(
          hookSystem,
          block,
          `Hook 阻止执行: ${interp.blockReason ?? "无原因"}`,
          effectiveInput,
          Date.now() - toolStartedAt,
        );
        return {
          type: "tool_result",
          tool_use_id: block.id,
          content: `Hook 阻止执行: ${interp.blockReason ?? "无原因"}`,
          is_error: true,
        };
      }
      hookPermissionDecision = interp.permissionDecision;
      if (interp.modifiedInput !== undefined) {
        effectiveInput = interp.modifiedInput;
        // 仅当参数真的变了才注入提示（避免 hook 原样透传 tool_input 时误报）。
        if (interp.inputChanged) {
          log.info("SUBAGENT:HOOK", `工具 ${block.name} 输入被 hook 修改`);
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
    // G3：PreToolUse permissionDecision 注入（子代理无 UI，ask 在下方 needsConfirmation→deny）
    const decision = await permissionChecker.check(permReq, tool, undefined, {
      hookPermissionDecision,
    });
    if (!decision.allowed) {
      // 子代理无 UI 通道，needsConfirmation 也直接 deny（dontAsk 语义）
      const reason = decision.reason || "子代理不允许此操作";
      log.info("SUBAGENT:PERM", `权限拒绝 ${block.name}: ${reason}`);
      // Pre/Post 配对：权限拒绝也要补 Failure 收尾。
      firePostToolUseFailure(
        hookSystem,
        block,
        `权限拒绝: ${reason}`,
        effectiveInput,
        Date.now() - toolStartedAt,
      );
      return {
        type: "tool_result",
        tool_use_id: block.id,
        content: `权限拒绝: ${reason}`,
        is_error: true,
      };
    }
  } else {
    // B0（分级 fail-closed）：未配置权限检查器时，只读工具放行，写类工具直接拒绝。
    //
    // 为什么不是"未传检查器就全部拒绝"：大量合法场景本就不需要权限检查器
    // （纯只读子代理如 explore/summarize、旧测试），完全 fail-closed 会误伤这些场景。
    // 真正的安全缺口是"没配置检查器却放过了写操作"——自定义子代理路径此前正是
    // 这样漏传 permissionChecker，导致走 agents/*.md 自定义子代理执行 edit/bash 时
    // 权限层被整体绕过（本次修复的 P0 缺口）。分级方案精确命中这一点：
    // 能改代码/执行命令的操作必须有人把关，纯读取操作不受影响。
    //
    // 判定复用与上方"只读/写入分类"同一套逻辑（isConcurrencySafe 优先，回退 readOnly()）。
    const isSafe = tool.isConcurrencySafe
      ? tool.isConcurrencySafe(effectiveInput)
      : (tool.readOnly?.() ?? false);
    if (!isSafe) {
      log.info(
        "SUBAGENT:PERM",
        `权限拒绝 ${block.name}: 未配置权限检查器，写类操作默认拒绝（fail-closed）`,
      );
      // Pre/Post 配对：fail-closed 拒绝同样要补 Failure 收尾。
      firePostToolUseFailure(
        hookSystem,
        block,
        "权限拒绝: 未配置权限检查器，写类操作默认拒绝（fail-closed）",
        effectiveInput,
        Date.now() - toolStartedAt,
      );
      return {
        type: "tool_result",
        tool_use_id: block.id,
        content: "权限拒绝: 未配置权限检查器，写类操作默认拒绝（fail-closed）",
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
    // Pre/Post 配对：与主循环同源——模型漏 required 字段是最高频的真实失败，
    // 不补这一次 fire，它在 trace 与失败率统计里就完全不存在。
    firePostToolUseFailure(
      hookSystem,
      block,
      validation.message,
      effectiveInput,
      Date.now() - toolStartedAt,
    );
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
          .catch(() => {
            /* best-effort，失败不影响子代理执行 */
          });
      }
    }

    // 截断超大输出
    const truncated = ContextManager.truncateToolOutput(result.output);

    // TUI 呈现档位（见下方 return 处的注释）。解析一次存起来，不在 return 里调两遍
    // ——函数形态的实现（skill）会查 SkillManager，重复调用是白花的开销。
    const displayMode = resolveResultDisplayMode(tool, effectiveInput);

    // post_tool_use hook（驱动 execute_tool span，带真实 duration_ms）
    if (hookSystem) {
      hookSystem
        .firePostToolUseEvent(
          block.name,
          effectiveInput,
          { output: truncated, isError: result.isError },
          result.isError,
          block.id,
          { duration_ms: elapsed },
        )
        .catch((e: any) => log.error("SUBAGENT:HOOK", `post_tool_use hook 失败: ${e.message}`));
    }

    return {
      type: "tool_result",
      tool_use_id: block.id,
      content: hookModifiedNotice ? hookModifiedNotice + "\n\n" + truncated : truncated,
      is_error: result.isError,
      // 结构化 diff 透传(edit/write):与主路径一致,供子代理结果在 UI 渲染高亮
      ...(result.structuredPatch?.length ? { structuredPatch: result.structuredPatch } : {}),
      // TUI 呈现档位：与主路径同解析单点（tool/result-display-mode.ts）。
      // 子代理也必须接——否则会出现「主循环隐藏了、子代理没隐藏」的路径不一致。
      // 错误结果不带此字段：错误照常显示（见 tool/types.ts 的硬约束 ②）。
      ...(!result.isError && displayMode ? { resultDisplayMode: displayMode } : {}),
    };
  } catch (err: any) {
    log.error("SUBAGENT:TOOL", `工具执行异常: ${block.name}`, { error: err.message });
    // post_tool_use_failure hook（异常路径也接入 hook，与主循环对齐）
    if (hookSystem) {
      hookSystem
        .firePostToolUseFailureEvent(
          block.name,
          effectiveInput,
          err.message,
          block.id,
          // 抛异常路径用纯执行耗时（与成功路径 duration_ms 同口径）：
          // 慢工具卡很久才抛，正是要看的那个数。
          { duration_ms: Date.now() - startTime },
        )
        .catch((e: any) =>
          log.error("SUBAGENT:HOOK", `post_tool_use_failure hook 失败: ${e.message}`),
        );
    }
    return {
      type: "tool_result",
      tool_use_id: block.id,
      content: `工具执行异常: ${err.message}`,
      is_error: true,
    };
  }
}
