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
import { validateToolInput, buildSchemaNotSentHint } from "../tool/input-validator.ts";
import { yieldMissingToolResults, collectToolResultIdsFromBlocks } from "../agent/tool-result-guard.ts";
import { stripInternalFields } from "../tool/internal-fields.ts";
import type { ToolUseContext } from "../tool/types.ts";
import { partitionToolCalls, getMaxToolConcurrency } from "./tool-orchestration.ts";
import { recordEditOutcome } from "./edit-failure-tracker.ts";

/**
 * GAP-06：executeSingleTool 内部返回载体——在标准 tool_result ContentBlock 之外，
 * 旁路携带工具的 contextModifier，供 executeTools 在结果收集后按原始顺序应用。
 * contextModifier 不属于 ContentBlock 协议字段（不能进 tool_result 发给 LLM），
 * 故用一个内部包装类型透传，executeTools 提取后剥离，只把纯 ContentBlock 入历史。
 */
interface SingleToolOutcome {
  block: ContentBlock;
  contextModifier?: (context: ToolUseContext) => ToolUseContext;
}
export type { SingleToolOutcome };

/**
 * G1 修复：主循环工具并发 cap。
 * 对标 claude-code toolOrchestration.ts:8 getMaxToolUseConcurrency() 默认 10。
 * 主循环普通工具并发此前无限制（Promise.allSettled 一次性全发），模型一次派 10+ 个
 * grep/read 时全部同时打，可能耗尽文件句柄或触发 rate-limit。
 * 信号量限流：超上限的调用排队等待，有 slot 释放时按 FIFO 唤醒。
 *
 * GAP-10：并发上限的读取逻辑已提取到 tool-orchestration.ts 的 getMaxToolConcurrency()，
 * 此处引用以保持单一事实源（编排层负责调度策略配置）。
 */
const MAX_TOOL_CONCURRENCY = getMaxToolConcurrency();

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

/**
 * 判断 hook 回传的 tool_input 是否**真的改变了**原始参数。
 *
 * 背景（归因脱节 bug）：PreToolUseHookOutput.getModifiedToolInput() 只要 hook 在
 * hookSpecificOutput 里回带了 `tool_input` 字段就返回它——**不比较是否与原 input 不同**。
 * 而 applyHookOutputToInput 对 PreToolUse 做的是 `{...old, ...new}` 浅合并，
 * 合并后可能与原值逐字节相同（hook 原样透传 / 只回带了默认值）。此时旧逻辑仍会注入
 * "参数被 hook 修改"提示，误导模型怀疑自己提交的参数、甚至重发——与 plan-recovery
 * 按工具名误判 file_not_found 同类：用"是否回带 tool_input"代理"参数是否真的变了"。
 *
 * 用结构化深比较（顺序无关的 JSON 等价）判定，相等则视为"未修改"，不注入提示。
 */
export function hookActuallyModifiedInput(original: unknown, modified: unknown): boolean {
  return !stableDeepEqual(original, modified);
}

/** 顺序无关的结构化深比较（对象 key 排序后逐一比较，数组按序比较）。 */
function stableDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return a === b;
  if (typeof a !== "object" || typeof b !== "object") return a === b;

  const aArr = Array.isArray(a);
  const bArr = Array.isArray(b);
  if (aArr !== bArr) return false;
  if (aArr && bArr) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!stableDeepEqual(a[i], b[i])) return false;
    }
    return true;
  }

  const aKeys = Object.keys(a as Record<string, unknown>);
  const bKeys = Object.keys(b as Record<string, unknown>);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!stableDeepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) {
      return false;
    }
  }
  return true;
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
  /**
   * P1-7：记录本轮工具修改的文件（打通 Checkpoint↔Resume）。
   * 在写入类工具的快照创建后调用，把「文件路径 + 工具名」摘要落盘到会话 JSONL metadata，
   * 使 resume 时模型能知道"之前改过哪些文件"（此前 Checkpoint 独立存储，不参与恢复编排）。
   * 未注入（无头/子代理）时安全跳过。
   */
  recordFileChanges?: (files: string[], toolName: string) => void;
  /**
   * GAP-01：流式预执行结果缓存查询（按 tool_use_id）。
   * 流式工具执行器在模型仍在输出时抢先执行了并发安全工具；executeTools 的批量调度
   * 在执行每个工具前先查此缓存，命中则直接复用结果（跳过重复执行），保持权限/hook/
   * 顺序/checkpoint 等编排不变。未注入（批量模式/子代理）时返回 undefined，走正常执行。
   */
  getPrecomputedResult?: (toolUseId: string) => SingleToolOutcome | undefined;
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
      // P1-7：快照创建后，把文件修改摘要同步落盘到会话 JSONL（打通 Checkpoint↔Resume）。
      // 双写：Checkpoint 存完整内容/diff 用于 undo；JSONL metadata 只存路径+工具名摘要用于
      // resume 时重建"改过哪些文件"的上下文。落盘失败不影响工具执行。
      try {
        deps.recordFileChanges?.(affectedFiles, toolNames);
      } catch (e: any) {
        log.warn("CHECKPOINT", `文件修改摘要落盘失败（不阻断）: ${e?.message}`);
      }
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
      // GAP-12：区分"未激活的 deferred 工具"与"真正不存在的工具"，给出可操作引导。
      // 注意适用边界：本分支仅在 registry.get() 拿不到实例时进入。**已注册**的延迟工具
      // （最常见情形——shouldDefer 内置工具、mcp__ 工具）get() 能拿到实例，不走这里，
      // 而是走到下面的参数校验层，由 buildSchemaNotSentHint 处理「schema 未发送」盲调。
      // 本分支只兜底"名单标记了 deferred 但从未 register"这类极边缘情形。
      const isDeferred = deps.toolRegistry.isDeferred(block.name);
      const errorContent = isDeferred
        ? `工具 "${block.name}" 存在但尚未加载（schema 未发送）。请先调用 tool_search 工具（参数 query: "select:${block.name}"）激活它，然后重试本次调用。`
        : `工具 "${block.name}" 未找到。可用工具请通过 tool_search 查询。`;
      log.error("TOOL", `工具未找到: ${block.name} (deferred=${isDeferred})`);
      rejectedResults.set(idx, {
        type: "tool_result",
        tool_use_id: block.id,
        content: errorContent,
        is_error: true,
      });
      continue;
    }

    // 权限检查（GAP-01：提取为共享函数 resolveToolPermission，批量/流式路径复用同一逻辑）
    const reject = await resolveToolPermission(block, tool, deps);
    if (reject) {
      rejectedResults.set(idx, reject);
      continue;
    }

    checkedTools.push({ block, tool, idx });
  }

  // GAP-03 + GAP-10：贪心连续合并分区（算法提取到 tool-orchestration.partitionToolCalls）。
  // 将连续的并发安全工具合并为一个并行批次，非并发安全工具作为串行批次，交替执行，
  // 保留模型的隐式顺序语义（"先 Read → Edit → 再 Read"不被打乱）。
  const batches = partitionToolCalls(checkedTools);

  log.debug("TOOL", `分区并发(贪心连续合并): ${batches.length} 个批次 [${batches.map(b => `${b.isConcurrencySafe ? "‖" : "→"}${b.items.length}`).join(", ")}]`);

  // 结果收集（按原始顺序索引存储）
  const resultMap: Map<number, ContentBlock> = new Map(rejectedResults);
  // GAP-06：按原始顺序收集 contextModifier，执行后一次性按序应用。
  const contextModifiers: Array<{ idx: number; modifier: (ctx: ToolUseContext) => ToolUseContext }> = [];
  // GAP-02（串行 Bash 级联）：一旦某个 Bash 命令失败，同一轮内后续 Bash 工具跳过执行。
  // 覆盖文档核心场景：[mkdir /tmp/x, cd /tmp/x && make, ls /tmp/x/bin]——写类 bash 属非并发安全，
  // 走串行批次，第一个失败后后两个（依赖它）必然失败，跳过它们消除噪音、减少模型误判。
  // 仅 Bash 触发、仅跳过 Bash（其他工具相互独立，照常执行）。
  let bashCascadeTripped = false;

  // 逐批次执行：并发安全批次并行（信号量限流），非并发安全批次串行
  for (const batch of batches) {
    if (batch.isConcurrencySafe) {
      // 并行批次（G1：信号量限流，默认 cap=10）
      if (batch.items.length > MAX_TOOL_CONCURRENCY) {
        log.debug("TOOL", `并行工具 ${batch.items.length} 个超过并发上限 ${MAX_TOOL_CONCURRENCY}，超出部分排队`);
      }
      // G20 + GAP-02：sibling-abort controller。
      // 触发条件：abort 错误 OR Bash 工具 is_error（级联取消兄弟工具）。
      const { controller: siblingController, dispose: disposeSibling } =
        createLinkedAbortController(deps.getAbortSignal());
      try {
        const batchResults = await withConcurrencyLimit(
          batch.items.map(({ block, tool, idx }) =>
            () => {
              let behavior: "cancel" | "block" = "cancel";
              try { behavior = tool.interruptBehavior?.() ?? "cancel"; } catch { behavior = "cancel"; }
              const sig = behavior === "block" ? deps.getAbortSignal() : siblingController.signal;
              // GAP-01：流式预执行命中则复用结果，跳过重复执行（保持编排不变）。
              const precomputed = deps.getPrecomputedResult?.(block.id);
              const exec = precomputed
                ? Promise.resolve(precomputed)
                : executeSingleTool(block, tool, deps, sig);
              return exec.then(outcome => {
                // GAP-02：Bash 工具执行失败（is_error）时**立即**联动取消兄弟——
                // 在 thunk 内触发（而非批次 settle 后），才能真正取消仍在跑/未启动的兄弟。
                // Bash 有隐式依赖链（mkdir 失败 → 后续 cd 无意义），必然失败的结果是噪音。
                // Read/WebFetch 等工具失败不级联（它们相互独立）。
                if (block.name === "bash" && (outcome.block as any).is_error && !siblingController.signal.aborted) {
                  log.info("TOOL", "Bash 失败级联：联动取消其余兄弟工具（sibling-abort-bash-error）");
                  siblingController.abort("sibling_bash_error");
                }
                return { idx, result: outcome };
              });
            }
          ),
          MAX_TOOL_CONCURRENCY,
          {
            stopOnReject: (reason) => {
              // abort（用户 ESC / 上游）或 bash 级联 abort 均停止启动后续排队任务
              if (isAbortError(reason) && !siblingController.signal.aborted) {
                log.info("TOOL", "并发工具中断：联动取消其余兄弟工具（sibling-abort）");
                siblingController.abort((reason as any)?.reason ?? reason);
                return true;
              }
              // bash 级联已在 thunk 内 abort：一旦子信号被 bash-error abort，也停止启动队列
              return siblingController.signal.aborted;
            },
          },
        );
        // abort 优先：任一工具被**用户/上游** abort 取消，立即向上抛（bash 级联 abort 不向上抛）。
        for (const r of batchResults) {
          if (r.status === "rejected" && isAbortError(r.reason)) {
            const reason = (r.reason as any)?.reason ?? (r.reason as any)?.message;
            if (reason !== "sibling_bash_error") throw r.reason;
          }
        }
        for (let i = 0; i < batchResults.length; i++) {
          const r = batchResults[i];
          if (r.status === "fulfilled") {
            const { idx, result: outcome } = r.value;
            resultMap.set(idx, outcome.block);
            if (outcome.contextModifier) {
              contextModifiers.push({ idx, modifier: outcome.contextModifier });
            }
          } else {
            const { block: failBlock, idx: failIdx } = batch.items[i];
            // GAP-02：被 bash 级联取消的兄弟（sibling_bash_error / withConcurrencyLimit 跳过占位）→
            // 返回明确的"已取消"tool_result，而非泛化异常，让模型理解是级联取消非工具本身出错。
            const rawReason = (r.reason as any)?.reason ?? (r.reason as any)?.message ?? String(r.reason);
            const isBashCascade = isAbortError(r.reason)
              ? rawReason === "sibling_bash_error"
              : String(rawReason).includes("sibling-abort");
            if (isBashCascade) {
              log.info("TOOL", `并行工具 ${failBlock.name} 因兄弟 Bash 失败被级联取消`);
              resultMap.set(failIdx, {
                type: "tool_result",
                tool_use_id: failBlock.id,
                content: `已取消：同批次中先行的 Bash 命令执行失败，为避免依赖链上的无效执行，本工具未运行。`,
                is_error: true,
              });
            } else {
              log.error("TOOL", `并行工具 ${failBlock.name} 异常未被内部捕获: ${r.reason?.message ?? r.reason}`);
              resultMap.set(failIdx, {
                type: "tool_result",
                tool_use_id: failBlock.id,
                content: `工具执行异常: ${r.reason?.message ?? String(r.reason)}`,
                is_error: true,
              });
            }
          }
        }
      } finally {
        disposeSibling();
      }
    } else {
      // 串行批次：逐个执行
      for (const { block, tool, idx } of batch.items) {
        // GAP-02：串行 Bash 级联——前序 Bash 已失败时，跳过后续 Bash（依赖链无意义）。
        if (bashCascadeTripped && block.name === "bash") {
          log.info("TOOL", `串行 Bash 级联：跳过 ${block.name}（同轮先行 Bash 命令已失败）`);
          resultMap.set(idx, {
            type: "tool_result",
            tool_use_id: block.id,
            content: `已取消：同一轮中先行的 Bash 命令执行失败，后续 Bash 命令通常依赖其结果，为避免无效执行已跳过。如需强制执行请单独重试。`,
            is_error: true,
          });
          continue;
        }
        // GAP-01：流式预执行命中则复用（串行批次通常是写工具，一般不会被流式预执行，
        // 但保留一致性检查——若命中则跳过重复执行）。
        const precomputed = deps.getPrecomputedResult?.(block.id);
        const outcome = precomputed ?? await executeSingleTool(block, tool, deps);
        resultMap.set(idx, outcome.block);
        if (outcome.contextModifier) {
          contextModifiers.push({ idx, modifier: outcome.contextModifier });
        }
        // GAP-02：Bash 命令失败 → 触发同轮后续 Bash 级联跳过。
        if (block.name === "bash" && (outcome.block as any).is_error) {
          bashCascadeTripped = true;
          log.info("TOOL", `Bash 命令失败，触发同轮串行 Bash 级联跳过`);
        }
      }
    }
  }

  // GAP-06：按原始顺序应用 contextModifier（并发执行下仍保证确定性顺序）。
  // contextModifier 典型用途：EnterPlanMode 切换权限模式。
  // 当前简化实现：直接修改 deps.config（permissionMode 是 mutable 字段），
  // 完整 ToolUseContext 的其余字段暂不传（待新版 Tool 接口全量迁移后统一补齐）。
  if (contextModifiers.length > 0) {
    contextModifiers.sort((a, b) => a.idx - b.idx);
    for (const { modifier } of contextModifiers) {
      try {
        // 构造最小 ToolUseContext 传给 modifier
        const minimalCtx: ToolUseContext = {
          options: { tools: [], mainLoopModel: deps.config.model, mcpClients: [], isNonInteractive: false },
          abortSignal: deps.getAbortSignal() ?? new AbortController().signal,
          fileStateCache: {} as any,
          messages: [],
          permissionMode: deps.config.permissionMode,
        };
        const modified = modifier(minimalCtx);
        // 回写有效变更
        if (modified.permissionMode && modified.permissionMode !== deps.config.permissionMode) {
          log.info("TOOL", `contextModifier 切换 permissionMode: ${deps.config.permissionMode} → ${modified.permissionMode}`);
          deps.config.permissionMode = modified.permissionMode;
        }
      } catch (e: any) {
        log.error("TOOL", `contextModifier 应用失败: ${e.message}`);
      }
    }
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

/**
 * GAP-01：单工具权限门（从 executeTools 的权限预检循环提取，批量/流式路径共享）。
 *
 * 对已确认存在的工具做权限检查。返回值：
 *   - null：权限通过，可执行；
 *   - ContentBlock：权限被拒/需确认失败，返回 error tool_result（调用方直接收集，不执行）。
 *
 * 逻辑与此前内联版本完全一致：deny 规则 / 危险命令 → 三路竞争（hook / 分类器并行 / 用户确认）。
 */
export async function resolveToolPermission(
  block: ToolUseBlock,
  tool: Tool,
  deps: ToolExecutorDeps,
): Promise<ContentBlock | null> {
  const log = getLogger();
  if (!deps.permissionChecker) return null;

  // G14：观测输入回填——权限/hook 看到展开后的规范化视图（如 ~ → 绝对路径），
  // 工具实际执行仍用原始 input（保持 prompt cache 前缀稳定）。
  let observableInput: unknown = block.input;
  if (typeof tool.backfillObservableInput === "function") {
    try {
      const expanded = tool.backfillObservableInput(block.input);
      if (expanded !== undefined) observableInput = expanded;
    } catch { /* 回填钩子异常静默回退原始 input */ }
  }
  const permReq: PermissionRequest = {
    toolName: block.name,
    input: observableInput,
    description: (observableInput as any)?.description
      ? `${block.name}: ${(observableInput as any).description}`
      : `${block.name}: ${JSON.stringify(observableInput).slice(0, 120)}`,
  };
  const decision = await deps.permissionChecker.check(permReq, tool);

  if (decision.allowed) return null;

  if (decision.needsConfirmation) {
    const desc = decision.reason || `工具 "${block.name}" 需要用户确认`;
    log.info("PERMISSION", `请求权限决策(三路竞争): ${desc}`);

    // 三路竞争：hook / classifier / 用户交互
    const { resolvePermission } = await import("../permission/async-decision.ts");
    const result = await resolvePermission(
      { toolName: block.name, input: observableInput as Record<string, unknown>, description: desc },
      {
        isInteractive: true,
        isSubAgent: false,
        hookDecision: deps.hookSystem
          ? async () => {
              try {
                const hookResult = await deps.hookSystem.firePermissionRequestEvent?.(
                  block.name, observableInput as Record<string, unknown>, deps.config.permissionMode,
                );
                if (!hookResult?.finalOutput) return null;
                if (hookResult.finalOutput.isBlockingDecision()) {
                  return { allowed: false, reason: hookResult.finalOutput.getEffectiveReason() };
                }
                // hook 未阻止 → 不干预，留给其他路径决策
                return null;
              } catch (e) {
                // 静默-6：权限 hook 抛异常时返回 null = 降级到交互确认（非放行），行为安全。
                // 补 warn 记录异常（不改变降级语义）。
                log.warn("PERMISSION", `权限 hook 执行异常，降级到交互确认: ${(e as Error)?.message}`);
              }
              return null;
            }
          : undefined,
        // GAP-04：分类器并行预启动。对 Bash 工具，把 LLM 风险分类器作为独立竞争路径
        // 与 hook / UI 弹窗并行跑，而非在 checker 里同步串行等待。
        //   - 仅在 speculativeClassifier 开启时激活（默认关闭，保守用户行为不变）；
        //   - 只对 bash 生效；只放行不拒绝；
        //   - 安全护栏：checker 因**硬编码危险命令**要求确认时，禁止分类器放行（弹窗兜底不被绕过）；
        //   - 决策已到达（hook/user 先赢）时，分类器结果被 resolve-once 语义自然丢弃。
        classifierDecision: (
          block.name === "bash"
          && (deps.config as any).speculativeClassifier === true
          && !(decision.decisionReason?.type === "dangerousCommand"
               && !String((decision.decisionReason as any).pattern ?? "").startsWith("LLM:"))
        )
          ? async () => {
              try {
                const classifier = deps.permissionChecker?.getBashClassifier?.();
                if (!classifier?.isAvailable()) return null;
                if (deps.config.permissionMode === "plan") return null;
                const cmd = (observableInput as any)?.command;
                if (typeof cmd !== "string" || !cmd) return null;
                const res = await classifier.classify({
                  command: cmd,
                  cwd: process.cwd(),
                  description: desc,
                  signal: deps.getAbortSignal(),
                });
                if (!res.classifierUnavailable && res.safe) {
                  log.info("PERMISSION", `分类器并行放行 bash（${res.reason}），跳过弹窗`);
                  return { allowed: true, reason: `分类器判定安全: ${res.reason}` };
                }
              } catch (e) {
                log.warn("PERMISSION", `分类器并行路径异常（忽略，交回竞争）: ${(e as Error)?.message}`);
              }
              return null;
            }
          : undefined,
        userDecision: (req, resolve) => {
          void deps.requestUserConfirmation(desc, permReq, block.name, block.input).then((confirmed) => {
            if (!resolve.isResolved()) {
              resolve.resolve({ allowed: confirmed, reason: confirmed ? "用户批准" : "用户拒绝" });
            }
          });
        },
        gracePeriodMs: 200,
      },
    );

    if (!result.decision.allowed) {
      log.info("PERMISSION", `权限拒绝(${result.source}): ${block.name}`);
      return {
        type: "tool_result",
        tool_use_id: block.id,
        content: `${result.source === "user" ? "用户" : result.source === "timeout" ? "超时" : result.source}拒绝执行工具 "${block.name}"`,
        is_error: true,
      };
    }
    log.info("PERMISSION", `权限批准(${result.source}): ${block.name}`);
    return null;
  }

  // needsConfirmation=false 的拒绝：结构化解释后返回 error
  const { explainDecision } = await import("../permission/explainer.ts");
  const explanation = explainDecision(decision);
  log.warn("PERMISSION", `权限拒绝: ${block.name} - ${explanation}`);
  return {
    type: "tool_result",
    tool_use_id: block.id,
    content: `权限拒绝: ${explanation}`,
    is_error: true,
  };
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
): Promise<SingleToolOutcome> {
  const log = getLogger();

  log.toolStart(block.name, block.input);

  // GAP-11：MCP 工具的 PostToolUse hook 需拿到**原始未截断**输出（脱敏/审计/格式转换
  // 场景要看原文），内置工具沿用"截断后即最终输出"（hook 看到什么模型看到什么）。
  const isMcpTool = block.name.startsWith("mcp__");

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
      block: {
        type: "tool_result",
        tool_use_id: block.id,
        content: `Hook 阻止执行: ${reason}`,
        is_error: true,
      },
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
      // 用改后参数执行（即使与原值相同也无害），但仅当**真的变了**才注入告知提示——
      // 否则会误导模型以为参数被改（见 hookActuallyModifiedInput 注释）。
      effectiveInput = modified;
      if (hookActuallyModifiedInput(block.input, modified)) {
        log.info("HOOK", `工具 ${block.name} 输入被 hook 修改`);
        hookModifiedNotice = buildHookModifiedNotice(block.name);
      }
    }
  }

  // zod 运行时校验（在工具边界拦截畸形参数）
  // 工具提供 zodSchema 时，safeParse 失败直接返回结构化错误，不带病执行；
  // 成功则用校验后的 data 替换 input（zod 规整/剥离后的安全值）。
  // 工具未提供 zodSchema 时原样放行（回退到工具内部手工检查）。
  const validation = validateToolInput(tool, effectiveInput);
  if (!validation.ok) {
    // 「schema 未发送」补救（对标 claude-code buildSchemaNotSentHint）：模型盲调未激活的
    // 延迟工具、传了畸形参数时，裸 zod 错误会误导它以为是自己参数写错、反复微调猜测。
    // 追加“先 tool_search 激活拿 schema 再重试”引导，把真正根因讲清楚，让它一步自救。
    const schemaHint = buildSchemaNotSentHint(tool, {
      toolSearchEnabled: deps.toolRegistry.isToolSearchEnabled(),
      isDeferred: deps.toolRegistry.isDeferred(block.name),
      isActivated: deps.toolRegistry.isActivated(block.name),
    });
    const content = schemaHint ? validation.message + schemaHint : validation.message;
    log.info("TOOL", `工具 ${block.name} 参数校验失败: ${validation.message}${schemaHint ? "（附 schema 未发送引导）" : ""}`);
    return {
      block: {
        type: "tool_result",
        tool_use_id: block.id,
        content,
        is_error: true,
      },
    };
  }
  // GAP-08：纵深防御——校验通过后、执行前剥离模型可能自行伪造的内部字段
  // （_agentId/_simulatedSedEdit/_hookInjected）。即使 zod strict 理论上已拦，
  // 也不信任 schema 层一定拦得住（部分工具走 passthrough），在执行层再加一道，
  // 防止模型伪造内部字段绕过控制（如伪造 _agentId 冒充子代理）。
  effectiveInput = stripInternalFields(validation.data);

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

    // GAP-15：结构化遥测元数据（在 duration_ms 之外补充 input/output 规模、是否 MCP、
    // 是否 hook 改参）。经 firePostToolUseEvent 的 harness_context 透传给 TelemetryHookProbe，
    // 丰富 execute_tool span，供性能分析定位大 IO / 慢工具。
    const telemetryMeta = {
      tool_input_size: safeInputSize(block.input),
      tool_output_size: result.output?.length ?? 0,
      tool_is_mcp: isMcpTool,
      tool_hook_modified: !!hookModifiedNotice,
    };

    // post_tool_use hook
    // GAP-11：MCP 工具先用**原始输出**跑 hook（脱敏/审计场景需原文），内置工具用截断后输出。
    const hookOutput = isMcpTool ? result.output : normalizedOutput;
    const postResult = await deps.hookSystem.firePostToolUseEvent(
      block.name,
      block.input as Record<string, unknown>,
      { output: hookOutput, isError: result.isError },
      result.isError,
      block.id,
      { duration_ms: elapsed, harness_context: telemetryMeta as any },
    );

    let finalOutput = normalizedOutput;
    const additionalCtx = postResult.finalOutput?.getAdditionalContext();
    if (additionalCtx) {
      log.info("HOOK", `PostToolUse hook 追加上下文到 ${block.name} 结果`);
      finalOutput = normalizedOutput + "\n\n[Hook 附加上下文]\n" + additionalCtx;
    }

    // 连续编辑失败计数提醒（借鉴 edit-guard，用现成的 PostToolUse 回注通道落地）：
    // 弱模型对同一文件反复 edit/write 失败时，追加一条分型的、可执行的下一步建议，
    // 引导它重读/换策略而非原样兜圈。纯追加、不阻断、不回滚——对弱模型是确定性纯增益。
    // read 成功会清零对应文件计数（自愈），故 read/edit/write 都要过一遍。
    try {
      const efPath = (block.input as any)?.file_path;
      const efReminder = recordEditOutcome(
        deps.sessionState,
        block.name,
        typeof efPath === "string" ? efPath : undefined,
        !!result.isError,
        result.isError ? result.output ?? "" : "",
      );
      if (efReminder) {
        finalOutput = finalOutput + "\n\n" + efReminder;
      }
    } catch (e: any) {
      // 提醒是锦上添花，任何异常都不能影响工具结果本身。
      log.warn("TOOL", `连续编辑失败提醒计算异常（忽略）: ${e?.message ?? e}`);
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
      block: {
        type: "tool_result",
        tool_use_id: block.id,
        content: finalOutput,
        is_error: result.isError,
        // 结构化 diff 透传(仅 edit/write 填充)。其它工具为 undefined → 字段不出现,零破坏。
        // provider 序列化逐字段读取,不会泄漏给 LLM;随 Message 持久化可重放回 UI。
        ...(result.structuredPatch?.length ? { structuredPatch: result.structuredPatch } : {}),
        // G6：富媒体块透传(仅 Read 读图片/PDF 填充)。支持 vision 的 provider 据此拼多部件 content。
        ...(result.mediaBlocks?.length ? { mediaBlocks: result.mediaBlocks } : {}),
      },
      // GAP-06：透传工具的 contextModifier，由 executeTools 在结果收集后按原始顺序应用。
      contextModifier: result.contextModifier,
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
      block: {
        type: "tool_result",
        tool_use_id: block.id,
        content: `工具执行异常: ${err.message}`,
        is_error: true,
      },
    };
  }
}

/** GAP-15：安全估算工具输入的字节规模（JSON 序列化长度），失败返回 0，不抛。 */
function safeInputSize(input: unknown): number {
  try {
    return JSON.stringify(input)?.length ?? 0;
  } catch {
    return 0;
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
 * 编排逻辑已提取到 manager.ts 的 syncFileToLSP（主循环与子代理共用），此处仅做入参归一。
 * 从磁盘读取最新内容投递给 LSP；LSP 未就绪或读取失败时静默跳过。
 */
async function notifyLSPFileChange(input: Record<string, unknown>): Promise<void> {
  const filePath = (input?.file_path ?? input?.path) as string | undefined;
  if (!filePath) return;
  const { syncFileToLSP } = await import("../lsp/manager.ts");
  await syncFileToLSP(filePath);
}
