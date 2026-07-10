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
import { validateToolInput } from "../tool/input-validator.ts";
import { yieldMissingToolResults, collectToolResultIdsFromBlocks } from "../agent/tool-result-guard.ts";

/**
 * G1 修复：主循环工具并发 cap。
 * 对标 claude-code toolOrchestration.ts:8 getMaxToolUseConcurrency() 默认 10。
 * 主循环普通工具并发此前无限制（Promise.allSettled 一次性全发），模型一次派 10+ 个
 * grep/read 时全部同时打，可能耗尽文件句柄或触发 rate-limit。
 * 信号量限流：超上限的调用排队等待，有 slot 释放时按 FIFO 唤醒。
 */
const MAX_TOOL_CONCURRENCY = (() => {
  const raw = process.env.SID_TOOL_MAX_CONCURRENT;
  if (raw === undefined || raw === "") return 10;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 10;
})();

/** withConcurrencyLimit 可选行为钩子 */
interface ConcurrencyLimitOptions {
  /** 某个任务 reject 时回调（在结果写入 results 之后触发） */
  onReject?: (reason: unknown, idx: number) => void;
  /**
   * 某任务 reject 后是否停止启动"尚未开始"的队列任务。
   * 用于 G20 sibling-abort：一旦检测到中断，不再消费剩余队列（已在跑的由共享信号取消）。
   */
  stopOnReject?: (reason: unknown) => boolean;
}

/** 信号量：限流并发工具执行 */
async function withConcurrencyLimit<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
  opts?: ConcurrencyLimitOptions,
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(tasks.length);
  let nextIdx = 0;
  let stopped = false;

  async function runNext(): Promise<void> {
    while (nextIdx < tasks.length) {
      const idx = nextIdx++;
      // G20：已触发 sibling-abort 时，跳过尚未启动的队列任务（占位为 rejected，
      // 由上层协议兜底补齐 tool_result；若停止原因是 abort，上层会先向上抛不会用到占位）。
      if (stopped) {
        results[idx] = {
          status: "rejected",
          reason: new Error("sibling-abort: 兄弟工具已中断，跳过未启动的并发任务"),
        };
        continue;
      }
      try {
        const value = await tasks[idx]();
        results[idx] = { status: "fulfilled", value };
      } catch (reason: any) {
        results[idx] = { status: "rejected", reason };
        opts?.onReject?.(reason, idx);
        if (opts?.stopOnReject?.(reason)) stopped = true;
      }
    }
  }

  // 启动 min(limit, tasks.length) 个 worker 并行消费任务队列
  const workers = Array.from(
    { length: Math.min(limit, tasks.length) },
    () => runNext(),
  );
  await Promise.all(workers);
  return results;
}

/**
 * 创建一个"子 AbortController"，链接到父信号：
 * - 父信号已 abort → 子立即 abort（透传 reason）
 * - 父信号后续 abort → 子跟随 abort
 * 子控制器可被 sibling-abort 独立触发（不影响父信号）。
 * 返回 dispose 用于解绑监听，避免长生命周期父信号累积监听器泄漏。
 */
function createLinkedAbortController(
  parent: AbortSignal | undefined,
): { controller: AbortController; dispose: () => void } {
  const controller = new AbortController();
  if (!parent) return { controller, dispose: () => {} };
  if (parent.aborted) {
    controller.abort((parent as any).reason);
    return { controller, dispose: () => {} };
  }
  const onParentAbort = () => controller.abort((parent as any).reason);
  parent.addEventListener("abort", onParentAbort, { once: true });
  return {
    controller,
    dispose: () => parent.removeEventListener("abort", onParentAbort),
  };
}

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

/**
 * 可见性缺口修复（半盲级）：PreToolUse hook 改写了模型发出的工具参数后，
 * 模型收到的 tool_result 默认不含任何说明，会按自己原始（已被改掉）的参数去
 * 理解结果，造成误判。这里生成一条前置告知，提示模型"实际执行用的是 hook
 * 修改后的参数，请以执行结果为准"。
 *
 * 只给"被改过"这一事实，不渲染具体 diff——hook 可能注入敏感值（凭证/路径），
 * 回灌进 LLM 上下文有泄漏风险；模型只需知道"别按原参数理解结果"即可。
 * 主循环与子代理两条执行路径共用此函数（统一文案）。
 */
export function buildHookModifiedNotice(toolName: string): string {
  return (
    `<system-reminder>工具 ${toolName} 的调用参数在执行前被 hook 修改，` +
    `实际执行使用的是修改后的参数（与你提交的可能不同）。请以下方执行结果为准，` +
    `不要假设结果对应你最初提交的参数。</system-reminder>`
  );
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
  /**
   * 工具进度回调（G5 接线）。长跑工具在执行期间吐出的中间进度经此上报 UI（如状态栏）。
   * 未注入（无头模式）时安全跳过——执行器传给 tool.execute 的 onProgress 变为 no-op。
   */
  onToolProgress?: (toolName: string, toolUseId: string, event: import("../tool/types.ts").ToolProgressData) => void;
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
          log.info("PERMISSION", `请求权限决策(三路竞争): ${desc}`);

          // 三路竞争：hook / classifier / 用户交互
          const { resolvePermission } = await import("../permission/async-decision.ts");
          const result = await resolvePermission(
            { toolName: block.name, input: block.input as Record<string, unknown>, description: desc },
            {
              isInteractive: true,
              isSubAgent: false,
              hookDecision: deps.hookSystem
                ? async () => {
                    try {
                      const hookResult = await deps.hookSystem.firePermissionRequestEvent?.(
                        block.name, block.input as Record<string, unknown>, deps.config.permissionMode,
                      );
                      if (!hookResult?.finalOutput) return null;
                      if (hookResult.finalOutput.isBlockingDecision()) {
                        return { allowed: false, reason: hookResult.finalOutput.getEffectiveReason() };
                      }
                      // hook 未阻止 → 不干预，留给其他路径决策
                      return null;
                    } catch (e) {
                      // 静默-6：权限 hook 抛异常时返回 null = 降级到交互确认（非放行），行为安全。
                      // 但原空吞无任何痕迹——hook 因 bug 持续抛错时，用户只觉"权限 hook 从未生效"却无从排查。
                      // 补 warn 记录异常（不改变降级语义）。
                      log.warn("PERMISSION", `权限 hook 执行异常，降级到交互确认: ${(e as Error)?.message}`);
                    }
                    return null;
                  }
                : undefined,
              userDecision: (req, resolve) => {
                void deps.requestUserConfirmation(desc, permReq, block.name, block.input).then((confirmed) => {
                  if (!resolve.isResolved()) {
                    resolve.resolve({ allowed: confirmed, reason: confirmed ? "用户批准" : "用户拒绝" }, /* alwaysAllow handled by tuiConfirmCallback */);
                  }
                });
              },
              gracePeriodMs: 200,
            },
          );

          if (!result.decision.allowed) {
            log.info("PERMISSION", `权限拒绝(${result.source}): ${block.name}`);
            rejectedResults.set(idx, {
              type: "tool_result",
              tool_use_id: block.id,
              content: `${result.source === "user" ? "用户" : result.source === "timeout" ? "超时" : result.source}拒绝执行工具 "${block.name}"`,
              is_error: true,
            });
            continue;
          }
          log.info("PERMISSION", `权限批准(${result.source}): ${block.name}`);
        } else {
          // G15：用 explainDecision 产出结构化中文解释（命中哪条规则/哪个模式/哪个来源），
          // 让模型收到的拒绝反馈更明确，减少反复撞同一堵墙。无 decisionReason 时回退到 reason 文本。
          const { explainDecision } = await import("../permission/explainer.ts");
          const explanation = explainDecision(decision);
          log.warn("PERMISSION", `权限拒绝: ${block.name} - ${explanation}`);
          rejectedResults.set(idx, {
            type: "tool_result",
            tool_use_id: block.id,
            content: `权限拒绝: ${explanation}`,
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

  // 并发安全的工具：并行执行（G1：信号量限流，默认 cap=10，对齐 claude-code）
  if (concurrent.length > 0) {
    if (concurrent.length > MAX_TOOL_CONCURRENCY) {
      log.debug("TOOL", `并行工具 ${concurrent.length} 个超过并发上限 ${MAX_TOOL_CONCURRENCY}，超出部分排队`);
    }
    // G20 sibling-abort：为这一批并发工具建一个链接到父信号的子 AbortController。
    // 任一兄弟工具被取消（用户 ESC / 上游 abort）时，主动 abort 子信号，
    // 让其余仍在跑的兄弟工具立即收到取消而非白跑到底（浪费时间/产生多余副作用）。
    // 子信号独立于父信号：sibling-abort 触发时不反向 abort 父信号。
    const { controller: siblingController, dispose: disposeSibling } =
      createLinkedAbortController(deps.getAbortSignal());
    try {
      const readResults = await withConcurrencyLimit(
        concurrent.map(({ block, tool, idx }) =>
          () => executeSingleTool(block, tool, deps, siblingController.signal).then(r => ({ idx, result: r }))
        ),
        MAX_TOOL_CONCURRENCY,
        {
          // 某个兄弟工具因 abort 结束 → 立即取消其余在跑的兄弟 + 停止启动未开始的队列任务。
          stopOnReject: (reason) => {
            if (isAbortError(reason) && !siblingController.signal.aborted) {
              log.info("TOOL", "并发工具中断：联动取消其余兄弟工具（sibling-abort）");
              siblingController.abort((reason as any)?.reason ?? reason);
              return true;
            }
            return false;
          },
        },
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
    } finally {
      // 解绑父信号监听，避免长生命周期父信号累积监听器泄漏
      disposeSibling();
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

/** 执行单个工具
 *
 * signalOverride：G20 sibling-abort 场景下，并发工具使用链接到父信号的子信号，
 * 以便某个兄弟工具被取消时联动取消其余在跑的兄弟。未传则回退 deps.getAbortSignal()。
 */
export async function executeSingleTool(
  block: ToolUseBlock,
  tool: Tool,
  deps: ToolExecutorDeps,
  signalOverride?: AbortSignal,
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
  // 可见性缺口修复（半盲级）：hook 改写了模型发出的参数后，模型收到的 tool_result
  // 默认不含任何说明，模型会按自己原始的（已被改掉的）参数去理解结果 → 误判。
  // 这里记录"被改过"，在最终 tool_result 前置一条告知，让模型据实对齐执行参数。
  let hookModifiedNotice = "";
  if (preToolResult.finalOutput && "getModifiedToolInput" in preToolResult.finalOutput) {
    const modified = (preToolResult.finalOutput as any).getModifiedToolInput?.();
    if (modified) {
      log.info("HOOK", `工具 ${block.name} 输入被 hook 修改`);
      effectiveInput = modified;
      hookModifiedNotice = buildHookModifiedNotice(block.name);
    }
  }

  // zod 运行时校验（在工具边界拦截畸形参数）
  // 工具提供 zodSchema 时，safeParse 失败直接返回结构化错误，不带病执行；
  // 成功则用校验后的 data 替换 input（zod 规整/剥离后的安全值）。
  // 工具未提供 zodSchema 时原样放行（回退到工具内部手工检查）。
  const validation = validateToolInput(tool, effectiveInput);
  if (!validation.ok) {
    log.info("TOOL", `工具 ${block.name} 参数校验失败: ${validation.message}`);
    return {
      type: "tool_result",
      tool_use_id: block.id,
      content: validation.message,
      is_error: true,
    };
  }
  effectiveInput = validation.data;

  const startTime = Date.now();

  try {
    // G5 修复：把 onProgress 桥接给 tool.execute，让长跑工具能在执行中报告进度。
    // deps.onToolProgress 由 App 注入（路由到状态栏/TUI），无头模式下为 undefined → 无副作用。
    const progressCallback = deps.onToolProgress
      ? (event: import("../tool/types.ts").ToolProgressData) => deps.onToolProgress!(block.name, block.id, event)
      : undefined;
    const result = await tool.execute(effectiveInput, signalOverride ?? deps.getAbortSignal(), progressCallback);
    const elapsed = Date.now() - startTime;

    deps.sessionState.addToolDuration(elapsed);

    const truncatedOutput = processToolResult(
      block.name,
      block.id,
      result.output,
      deps.sessionState.sessionId,
      // 工具实例若声明 maxResultSizeChars，优先于 result-storage 的 TOOL_MAX_RESULT_SIZE 表。
      // 让"结果落盘阈值"成为工具自身可控的接口字段（此前是死字段，storage 只认常量表）。
      tool.maxResultSizeChars,
    );

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
    // hook 改参告知前置到结果最前（模型先看到"参数被改过"，再读结果，避免按旧参数误判）
    if (hookModifiedNotice) {
      finalOutput = hookModifiedNotice + "\n\n" + finalOutput;
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
      // 结构化 diff 透传(仅 edit/write 填充)。其它工具为 undefined → 字段不出现,零破坏。
      // provider 序列化逐字段读取,不会泄漏给 LLM;随 Message 持久化可重放回 UI。
      ...(result.structuredPatch?.length ? { structuredPatch: result.structuredPatch } : {}),
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
    const { getLSPManager, clearDiagnosticsForFile, notifyFileChanged } = await import("../lsp/manager.ts");
    if (!getLSPManager()) return; // LSP 未启用，避免无谓读盘
    const { readFile } = await import("fs/promises");
    const content = await readFile(filePath, "utf-8");
    // G3：先清除该文件的旧诊断记录，再投递变更。
    // 否则跨轮次去重缓存会过滤掉服务器基于新内容重新推送的同位置诊断，
    // 导致"修复后诊断不消失"或"过时错误持续驻留"。
    clearDiagnosticsForFile(filePath);
    await notifyFileChanged(filePath, content);
    // G6：变更同步后额外发 didSave 通知——部分 LSP 服务器（如 pylsp、gopls 的某些配置）
    // 依赖 didSave 而非 didChange 触发完整诊断刷新。didChange 已让服务器看到最新内容，
    // didSave 再补一次"已保存"语义，最大化兼容不同服务器的诊断触发策略。
    const manager = getLSPManager();
    manager?.saveFile(filePath);
  } catch (e) {
    // 静默-8：LSP 同步是 best-effort（失败不阻断工具执行），但补 debug 日志便于排查
    // "LSP 诊断不更新"这类问题（此前无任何痕迹）。
    getLogger().debug("LSP", `文件变更同步失败（不影响工具执行）: ${(e as Error)?.message}`);
  }
}
