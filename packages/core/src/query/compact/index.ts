/**
 * 渐进式压缩管道入口
 *
 * 按成本从低到高依次尝试：
 * ① applyToolResultBudget — 超大工具结果替换为占位符
 * ② snipCompact — 裁剪最早的消息
 * ③ microcompactMessages — 清理旧工具结果内容
 * ④ autoCompact — 调用模型生成摘要（最后手段）
 */

import type { Message } from "../../llm/types.ts";
import type { Manager as ContextManager } from "../../context/manager.ts";
import { applyToolResultBudget } from "./tool-result-budget.ts";
import { snipCompact } from "./snip-compact.ts";
import { microcompactMessages } from "./microcompact.ts";
import { getLogger } from "../../debug/index.ts";
import { estimateConversationTokens } from "../../context/token.ts";

/** 压缩管道结果 */
export interface CompactPipelineResult {
  /** 压缩后的消息 */
  messages: Message[];
  /** 执行了哪些压缩步骤 */
  steps: string[];
  /** 总共节省的字符数 */
  totalSavedChars: number;
  /** 是否需要继续执行 autoCompact（LLM 摘要） */
  needsAutoCompact: boolean;
  /**
   * 仅「进来时就已达标、一步没做」时为 already_below_target（压缩结局三态的 noop 来源）。
   * 「三步都无动作但仍超标」不填：那时 hard 档还会接着跑 collapse / autoCompact，不是最终结局。
   */
  noopReason?: "already_below_target";
}

/** 压缩管道配置 */
export interface CompactPipelineOptions {
  /**
   * 目标 token 使用率（低于此值则停止压缩）。
   * P1-7：调用方应从 getCompactionThresholds().compactionTriggerUsed / maxTokens 派生，
   * 不要写死 0.7——hard 档在 1M 窗口约 82% 才进场，管线再压到 70% 会多丢一截历史。
   */
  targetUsageRatio?: number;
  /** 当前 token 使用率 */
  currentUsageRatio: number;
  /** 上下文窗口最大 token 数 */
  maxTokens: number;
  /** 工具数量（用于 token 估算） */
  toolCount: number;
  /**
   * P1-6：与 getCompactionLevel 同源的估算器。传入后管线逐步替换消息时走校准尺子，
   * 不再用 chars/4。未传则退化为 estimateConversationTokens（仍含 thinking / CJK）。
   */
  estimateTokens?: (messages: Message[]) => number;
}

/**
 * 执行渐进式压缩管道
 * 按成本从低到高依次尝试，直到 token 使用率降到目标以下
 */
export function runCompactPipeline(
  messages: Message[],
  options: CompactPipelineOptions,
): CompactPipelineResult {
  const log = getLogger();
  const targetRatio = options.targetUsageRatio ?? 0.7;
  const steps: string[] = [];
  let totalSavedChars = 0;
  let currentMessages = messages;
  let currentRatio = options.currentUsageRatio;
  const estimate = (msgs: Message[]): number =>
    options.estimateTokens
      ? options.estimateTokens(msgs)
      : estimateConversationTokens(msgs, { toolCount: options.toolCount });
  const ratioOf = (msgs: Message[]): number =>
    options.maxTokens > 0 ? estimate(msgs) / options.maxTokens : currentRatio;

  log.info(
    "COMPACT_PIPELINE",
    `开始渐进式压缩，当前使用率 ${(currentRatio * 100).toFixed(0)}%，目标 ${(targetRatio * 100).toFixed(0)}%`,
  );

  // 如果已经低于目标，不需要压缩
  if (currentRatio <= targetRatio) {
    return {
      messages: currentMessages,
      steps,
      totalSavedChars,
      needsAutoCompact: false,
      noopReason: "already_below_target",
    };
  }

  // ① applyToolResultBudget — 超大工具结果替换为占位符
  const budgetResult = applyToolResultBudget(currentMessages);
  if (budgetResult.truncatedCount > 0) {
    currentMessages = budgetResult.messages;
    totalSavedChars += budgetResult.savedChars;
    steps.push(
      `toolResultBudget: 截断 ${budgetResult.truncatedCount} 个，节省 ${budgetResult.savedChars} 字符`,
    );
    currentRatio = ratioOf(currentMessages);
    if (currentRatio <= targetRatio) {
      log.info(
        "COMPACT_PIPELINE",
        `toolResultBudget 后使用率 ${(currentRatio * 100).toFixed(0)}%，已达目标`,
      );
      return { messages: currentMessages, steps, totalSavedChars, needsAutoCompact: false };
    }
  }

  // ② snipCompact — 裁剪最早的消息
  const snipResult = snipCompact(currentMessages);
  if (snipResult.success) {
    currentMessages = snipResult.messages;
    steps.push(`snipCompact: 裁剪 ${snipResult.snippedCount} 条消息`);
    currentRatio = ratioOf(currentMessages);
    if (currentRatio <= targetRatio) {
      log.info(
        "COMPACT_PIPELINE",
        `snipCompact 后使用率 ${(currentRatio * 100).toFixed(0)}%，已达目标`,
      );
      return { messages: currentMessages, steps, totalSavedChars, needsAutoCompact: false };
    }
  }

  // ③ microcompactMessages — 清理旧工具结果内容
  const microResult = microcompactMessages(currentMessages);
  if (microResult.compactedCount > 0) {
    currentMessages = microResult.messages;
    totalSavedChars += microResult.savedChars;
    steps.push(
      `microcompact: 压缩 ${microResult.compactedCount} 个，节省 ${microResult.savedChars} 字符`,
    );
    currentRatio = ratioOf(currentMessages);
    if (currentRatio <= targetRatio) {
      log.info(
        "COMPACT_PIPELINE",
        `microcompact 后使用率 ${(currentRatio * 100).toFixed(0)}%，已达目标`,
      );
      return { messages: currentMessages, steps, totalSavedChars, needsAutoCompact: false };
    }
  }

  // ④ 仍然超标 → 需要 autoCompact（LLM 摘要）
  log.info(
    "COMPACT_PIPELINE",
    `轻量压缩后使用率仍为 ${(currentRatio * 100).toFixed(0)}%，需要 autoCompact`,
  );
  return { messages: currentMessages, steps, totalSavedChars, needsAutoCompact: true };
}

/**
 * 发现 3b：masking 进入线下方再留的滞回带（占窗口比例）。
 * 压完要落进 level=none 区，否则会停在 masking 区边缘，与遮罩翻转叠加振荡。
 */
export const PIPELINE_TARGET_HYSTERESIS = 0.05;

/**
 * P1-7 + 发现 3b：从 Manager 的单一事实源派生管线达标比例。
 *
 * 目标 = min(hard 触发点, masking 进入线 − 5% 窗口)。
 * - 默认 1.05M 窗口：hard ≈ 82%、masking 线 78% ⇒ 目标 73%。旧值就是 hard 触发点本身，
 *   截断第一步刚压到线就退出，下一轮又涨回去（实测两次 hard 后上下文一路回涨）。
 * - 取 min 是为了 `SID_CODE_AUTOCOMPACT_PCT` 把 hard 线设得比 masking 线还低时，
 *   目标不会反而高过触发点（那会让管线一进场就判「已达标」而空跑）。
 * - 小窗口（≤60K）没有 masking 档（maskingRemaining=0），沿用 hard/emergency 触发点。
 * - 下限 0.3 不得高过触发点：`SID_CODE_AUTOCOMPACT_PCT` < 30 时（如 8），旧写法
 *   `Math.max(0.3, ratio)` 把目标抬到 30%，hard 档一触发管线就判「已达标」空跑，
 *   消息数不变、下一轮再触发，压缩永不生效（2026-10-25 harness-bench L1 实测连续 6 次 success=false）。
 */
export function pipelineTargetRatioFrom(ctxMgr: ContextManager): number {
  const maxTokens = ctxMgr.getMaxTokens();
  if (maxTokens <= 0) return 0.7;
  const t = ctxMgr.getCompactionThresholds();
  const triggerRatio = t.compactionTriggerUsed / maxTokens;
  let ratio = triggerRatio;
  if (!t.smallWindow && t.maskingRemaining > 0) {
    const maskLine = (t.effectiveWindow - t.maskingRemaining) / maxTokens;
    ratio = Math.min(ratio, maskLine - PIPELINE_TARGET_HYSTERESIS);
  }
  const floor = Math.min(0.3, triggerRatio);
  return Math.min(0.95, Math.max(floor, ratio));
}

// 导出子模块
export { microcompactMessages } from "./microcompact.ts";
export { snipCompact } from "./snip-compact.ts";
export { applyToolResultBudget, applyToolResultBudgetToContent } from "./tool-result-budget.ts";
// G22：部分压缩（compact-up-to）——新增能力，可显式调用
export {
  partialCompact,
  resolvePartialSplitIndex,
  PARTIAL_COMPACT_PREFIX,
  type PartialCompactOptions,
  type PartialCompactResult,
} from "./partial-compact.ts";
