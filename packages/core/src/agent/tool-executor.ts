/**
 * ToolExecutor — 进程内子代理的工具**调度**
 *
 * 只负责调度，单次执行在 `query/run-tool-use.ts` 的 runToolUse（与 spawn 路径共用唯一实现）：
 * - 分区调度走主循环 `partitionToolCalls`（连续安全才合并，保留 Read→Edit→Read 顺序）
 * - 并行批次受 `getMaxToolConcurrency()` 信号量限制（默认 10）
 * - 中断后剩余工具不再启动，补占位结果
 * - 出口 N 进 N 出：缺 idx 走 `yieldMissingToolResults`，不再静默跳过
 *
 * hook 收尾函数（firePermissionDenied 等）原先在这里导出给 spawn 路径共用，现统一在
 * `query/tool-hook-lifecycle.ts`，主循环也用同一份。
 */

import type { ContentBlock } from "../llm/types.ts";
import type { Registry as ToolRegistry } from "../tool/registry.ts";
import { errorMessageOf } from "../llm/errors.ts";
import { getLogger } from "../debug/logger.ts";
import type { HookSystem } from "../hook/system.ts";
import type { Checker } from "../permission/types.ts";
import type { ToolProgressData } from "../tool/types.ts";
import { partitionToolCalls, getMaxToolConcurrency } from "../query/tool-orchestration.ts";
import { yieldMissingToolResults, collectToolResultIdsFromBlocks } from "./tool-result-guard.ts";
import { runToolUse, SUBAGENT_ABORTED_TOOL_RESULT } from "../query/run-tool-use.ts";
import { MAIN_DIAGNOSTIC_OWNER } from "../lsp/diagnostic-registry.ts";

// 既有调用方从这里取占位文案（测试、agentic-loop 侧）：唯一定义在 run-tool-use.ts
export { SUBAGENT_ABORTED_TOOL_RESULT };

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
 * @param sessionId 超阈值结果落盘目录用。与 ContextManager masking 共用派生 id；缺省 "default"。
 */
export async function executeTools(
  content: ContentBlock[],
  tools: ToolRegistry,
  signal?: AbortSignal,
  hookSystem?: HookSystem,
  permissionChecker?: Checker,
  onProgress?: SubAgentToolProgress,
  /** 会话 ID，超阈值结果落盘到 trajectories/sessions/{id}/tool-outputs/。缺省回退 "default"。 */
  sessionId?: string,
  /**
   * S10：子代理身份（= AgenticLoopConfig.agentId），写进 PermissionDecision.agent_id。
   * 显式传参而非读 ALS：工具执行在流的 next() 之外，RequestContext 此处为空。
   */
  agentId?: string,
  /** LSP 诊断归属者（= runAgentLoop 的 diagnosticOwner）。缺省回退 agentId，再回退主循环。 */
  diagnosticOwner?: string,
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

  // 结果收集（按原始顺序索引存储）
  const resultMap = new Map<number, ContentBlock>();
  const checkedTools: Array<{
    block: ContentBlock & { type: "tool_use" };
    tool: NonNullable<ReturnType<ToolRegistry["get"]>>;
    idx: number;
  }> = [];

  for (const item of toolBlocks) {
    const tool = tools.get(item.block.name);
    if (!tool) {
      resultMap.set(item.idx, {
        type: "tool_result",
        tool_use_id: item.block.id,
        content: `工具 "${item.block.name}" 未找到`,
        is_error: true,
      });
      continue;
    }
    checkedTools.push({ block: item.block, tool, idx: item.idx });
  }

  // P0-2：与主循环共用分区。两桶分类会把 Read(a) Edit(c) Read(d) 变成
  // Read(a)||Read(d) 先于 Edit(c)，验证读到的是改之前的内容。
  const batches = partitionToolCalls(checkedTools);
  const maxConcurrency = getMaxToolConcurrency();
  log.debug(
    "SUBAGENT:TOOL",
    `分区并发(贪心连续合并): ${batches.length} 个批次 [${batches.map((b) => `${b.isConcurrencySafe ? "‖" : "→"}${b.items.length}`).join(", ")}] cap=${maxConcurrency}`,
  );

  // N1：对齐主循环（query/tool-executor.ts 的 shouldStopLaunching）。中断后剩余工具一律不启动，
  // 否则 write/edit 会在用户 ESC 之后照样落盘（它们自身不看 signal），PreToolUse/权限也白走一遍。
  // 不像主循环那样向上抛：agentic-loop 调用方没有接这个异常的收尾，占位结果 + 下一轮 LLM
  // 调用因 signal 已中断自然结束，子代理的结束形态不变。
  const isAborted = () => signal?.aborted === true;
  const setAbortedPlaceholder = (block: { id: string }, idx: number) => {
    resultMap.set(idx, {
      type: "tool_result",
      tool_use_id: block.id,
      content: SUBAGENT_ABORTED_TOOL_RESULT,
      is_error: true,
    });
  };

  // 只在两处「启动工具之前」检查：串行逐个前、并发信号量取任务前。不另设批次级检查——
  // 它被这两处完全覆盖（变异自证删掉它不变红），且这两处不依赖 partitionToolCalls 的分批形态。
  for (const batch of batches) {
    if (batch.isConcurrencySafe) {
      const settled = await runWithConcurrencyLimit(
        batch.items.map(
          ({ block, idx }) =>
            () =>
              executeSingleTool(
                block,
                tools,
                signal,
                hookSystem,
                permissionChecker,
                onProgress,
                sessionId,
                agentId,
                diagnosticOwner,
              )
                .then((result) => ({ idx, result }))
                .catch((err: any) => ({
                  idx,
                  result: {
                    type: "tool_result" as const,
                    tool_use_id: block.id,
                    content: `工具执行异常: ${errorMessageOf(err)}`,
                    is_error: true,
                  },
                })),
        ),
        maxConcurrency,
        isAborted,
      );
      // 未启动的槽位为 undefined，统一补中断占位
      batch.items.forEach(({ block, idx }, i) => {
        const r = settled[i];
        if (r) resultMap.set(r.idx, r.result);
        else setAbortedPlaceholder(block, idx);
      });
    } else {
      for (const { block, idx } of batch.items) {
        if (isAborted()) {
          setAbortedPlaceholder(block, idx);
          continue;
        }
        try {
          const result = await executeSingleTool(
            block,
            tools,
            signal,
            hookSystem,
            permissionChecker,
            onProgress,
            sessionId,
            agentId,
            diagnosticOwner,
          );
          resultMap.set(idx, result);
        } catch (err: any) {
          resultMap.set(idx, {
            type: "tool_result",
            tool_use_id: block.id,
            content: `工具执行异常: ${errorMessageOf(err)}`,
            is_error: true,
          });
        }
      }
    }
  }

  // 按原始顺序组装；缺 idx 补协议占位，不再静默跳过（N 进必须 N 出）。
  const results: ContentBlock[] = [];
  for (const { idx } of toolBlocks) {
    const result = resultMap.get(idx);
    if (result) results.push(result);
  }
  if (results.length < toolBlocks.length) {
    for (const missing of yieldMissingToolResults(
      [{ role: "assistant", content: toolBlocks.map((t) => t.block) }],
      collectToolResultIdsFromBlocks(results),
      "工具执行异常：未产生结果（已由协议兜底补齐）",
    )) {
      results.push(missing);
    }
  }

  return results;
}

/**
 * 信号量：并行批次不超过 getMaxToolConcurrency()，超出排队 FIFO。
 * shouldStopLaunching 为真时不再启动新任务，对应槽位留 undefined 由调用方补占位。
 */
async function runWithConcurrencyLimit<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
  shouldStopLaunching?: () => boolean,
): Promise<Array<T | undefined>> {
  if (tasks.length === 0) return [];
  const results: Array<T | undefined> = new Array(tasks.length);
  let nextIdx = 0;
  async function worker(): Promise<void> {
    while (nextIdx < tasks.length) {
      if (shouldStopLaunching?.()) return;
      const idx = nextIdx++;
      results[idx] = await tasks[idx]();
    }
  }
  const n = Math.max(1, Math.min(limit, tasks.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

/** 执行单个工具：单次执行的唯一实现在 query/run-tool-use.ts，这里只做 registry 查找与参数转接 */
function executeSingleTool(
  block: ContentBlock & { type: "tool_use" },
  tools: ToolRegistry,
  signal?: AbortSignal,
  hookSystem?: HookSystem,
  permissionChecker?: Checker,
  onProgress?: SubAgentToolProgress,
  sessionId?: string,
  /** S10：子代理身份，见 executeTools 同名参数 */
  agentId?: string,
  /** 见 executeTools 同名参数 */
  diagnosticOwner?: string,
): Promise<ContentBlock> {
  return runToolUse(
    block,
    tools.get(block.name),
    { hookSystem, permissionChecker, signal },
    {
      sessionId: sessionId ?? "default",
      agentId,
      diagnosticOwner: diagnosticOwner ?? agentId ?? MAIN_DIAGNOSTIC_OWNER,
      onProgress,
    },
  );
}
