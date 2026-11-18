/**
 * /context 的取数层（PR3）：`ContextManager + 会话快照 → ContextReport`。
 *
 * ─── 与排版层的分工 ───
 *
 * 所有百分比、差额、剩余量都在这里算完；`cli/command/commands/context/context-render.ts`
 * 只负责排版，**不许再出现第二份算术**。理由与 `/cost` 完全一致（见 cost-render.ts 头注释）：
 * 排版层重算指标正是 D9（`/stats` 用 stock÷flow 算出 4% 命中率）的根因。
 *
 * ─── 每个字段都必须能指到源字段 ───
 *
 * 北极星铁律第 2 条：说不出取数源的数字就是自我感觉。本文件里每个量都来自
 * `getTokenBreakdown` / `getContextUsageForDisplay` / `getCompactionThresholds` /
 * `computeFixedOverheadSources` / `SessionState.getStockPromptTokens` 之一，
 * 逐项对应关系写在 {@link ContextReport} 各字段的注释里。
 *
 * ─── 这一层解决的旧问题 ───
 *
 * B4 看不到档位、B5 看不到距触发还有多远、B6 释放量只给一个合计数、B7 只显示一档阈值、
 * B8 没有「末次请求的真实输入」可对账、A4 固定开销细目加总小于母项。
 */

import type { CompactionLevel, Manager as ContextManager } from "./manager.ts";
import { computeFixedOverheadSources, type FixedOverheadReport } from "./fixed-overhead.ts";
import type { ImportedFileRecord } from "../config/import-processor.ts";

/**
 * 分类所属的分组。
 *
 * - `resident`：换个话题也省不掉（系统提示词、工具定义、记忆、子代理定义）
 * - `conversation`：`/compact` 能省掉（消息、思考链、工具调用与结果）
 *
 * 分组的意义是让用户知道「该从哪省」：常驻组只能改配置，会话组可以压缩。
 */
export type ContextCategoryGroup = "resident" | "conversation";

export interface ContextReportCategory {
  key: string;
  label: string;
  tokens: number;
  group: ContextCategoryGroup;
  /** 占「已用」的百分比（report 层算好，渲染层不许重算） */
  percentOfUsed: number;
}

/** 四档压缩阈值中的一档。 */
export interface ContextReportThreshold {
  key: "masking" | "compression" | "emergency" | "blocking";
  /** 人话名称（遮罩工具输出 / LLM 摘要 / 紧急截断 / 强制截断） */
  label: string;
  /** 档位标识；`blocking` 不在 `CompactionLevel` 闭集里（它走主循环另一条判定） */
  level: "soft" | "hard" | "emergency" | "blocking";
  /** 触发点（已用 token 数） */
  at: number;
  /** 距触发还剩多少 token（≥ 0，已达则 0） */
  remaining: number;
}

export interface ContextReportFreedStrategy {
  strategy: string;
  /** 人话名称（过期清理 / 遮罩工具输出 / …） */
  label: string;
  tokens: number;
  /** 记账条数（「过期清理 24 项」的 24） */
  count: number;
}

/** 结论行里「最大的可变成分」一项。 */
export interface ContextReportLargest {
  label: string;
  percentOfUsed: number;
  tokens: number;
}

export interface ContextReport {
  /**
   * 模型名（标题行用）。取 `CommandContext.config.model`，report 层只搬运。
   * 空串时渲染层省略「· 模型名」一段。
   */
  model: string;

  // ─── 总量与进度（A2 / B5） ───
  /** 已用 token 数 = `getTokenBreakdown().total` ≡ `getContextUsageForDisplay().used` */
  used: number;
  /** 窗口上限 */
  maxTokens: number;
  /** 占满窗口百分比（进度条右侧第一个数） */
  percentOfWindow: number;
  /** 压缩触发点对应的满窗口百分比（进度条右侧的 `/82%`） */
  triggerPercentOfWindow: number;
  /** 占触发点百分比（距被压缩的真实进度） */
  percentOfTrigger: number;
  /** 当前档位（B4） */
  level: CompactionLevel;
  /** 距 hard 触发点还剩多少 token（B5，≥ 0） */
  toTrigger: number;

  // ─── 构成（A1 / B3 / B6） ───
  categories: ContextReportCategory[];
  /** 常驻组小计 */
  residentSubtotal: number;
  /** 会话组小计 */
  conversationSubtotal: number;
  /** 小计 = `getTokenBreakdown().grossTokens`（校准后、扣减前） */
  subtotal: number;
  /** 小计占已用百分比（可能 ≠ 100%，差额由实测校正与本地释放解释） */
  subtotalPercentOfUsed: number;
  /** 实测校正（锚点抬升）量，≥ 0 */
  anchorLiftTokens: number;

  // ─── 本地释放（B6） ───
  freed: {
    tokens: number;
    byStrategy: ContextReportFreedStrategy[];
  };

  // ─── 实测对账（B8 / A7） ───
  /** 末次请求的真实输入（`SessionState.getStockPromptTokens()`，与 footer `↑` 同源） */
  lastActualPromptTokens: number;
  /** 差额 = `used − lastActualPromptTokens`（下一轮预测减末次真实输入） */
  delta: number;

  // ─── 压缩阈值（B7） ───
  thresholds: ContextReportThreshold[];
  /** 完成预留总量 */
  completionBuffer: number;
  /** 完成预留里的输出分量 */
  outputReserve: number;
  /** 完成预留里的摘要分量 */
  summaryReserve: number;

  // ─── 固定开销来源（A4） ───
  fixedOverhead: FixedOverheadReport;

  // ─── 校准说明（B1） ───
  calibrated: boolean;
  calibrationFactor: number;

  // ─── 结论与提示 ───
  /** 会话组里最大的三个可变成分（结论行第二句） */
  largestVariable: ContextReportLargest[];
  /** 最多 3 条可行动提示，每条都能指到一个字段与一个阈值 */
  hints: string[];
}

/** 分类 → 分组的固定映射（闭集，与 BREAKDOWN_CATEGORIES 一一对应）。 */
const GROUP_BY_KEY: Record<string, ContextCategoryGroup> = {
  systemPrompt: "resident",
  toolSchemas: "resident",
  mcpToolSchemas: "resident",
  agentDefs: "resident",
  memoryFiles: "resident",
  userText: "conversation",
  assistantText: "conversation",
  thinking: "conversation",
  toolUse: "conversation",
  toolResult: "conversation",
  // 结构开销随消息条数增长 → 归会话组（压缩掉消息它自然变小）
  overhead: "conversation",
};

/** 释放策略 → 人话。未知策略原样展示，不吞掉（否则用户看到总数却不知道是谁释放的）。 */
const FREED_STRATEGY_LABELS: Record<string, string> = {
  masking: "遮罩工具输出",
  staleToolOutput: "过期清理",
  coldCacheClear: "冷缓存清理",
  cleanedMessages: "消息清理",
  persistedRefCollapse: "引用折叠",
};

/** 结论行最多列几项「最大的可变成分」。 */
const LARGEST_VARIABLE_LIMIT = 3;
/** 提示上限（面板上最多 3 条，多了就没人读）。 */
const HINT_LIMIT = 3;
/** 「即将触发压缩」的阈值：距触发 < 窗口的 5%。 */
const NEAR_TRIGGER_RATIO = 0.05;

function pct(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 100) : 0;
}

export interface BuildContextReportOptions {
  /** 当前模型名（标题行展示）；空串则省略 */
  model: string;
  /** 工具数量（`toolRegistry.size()`，估算工具定义占用的分母） */
  toolCount?: number;
  /** 末次请求的真实输入（`SessionState.getStockPromptTokens()`） */
  stockPromptTokens?: number;
  /** 当前生效规则的 `@` 导入清单（`ProjectRules.importedFiles`） */
  importedFiles?: readonly ImportedFileRecord[];
  /** 项目根（固定开销里把路径显示成相对路径） */
  projectRoot?: string;
}

/**
 * 组装 `/context` 面板所需的全部数据。
 *
 * 只读：不写任何状态、不改 ctxMgr。异常不外抛——固定开销来源计算失败时只丢细目，
 * 主体的构成与阈值照常返回（面板没有理由因为一节细目崩掉）。
 */
export function buildContextReport(
  ctxMgr: ContextManager,
  opts: BuildContextReportOptions,
): ContextReport {
  const toolCount = opts.toolCount ?? 0;
  const bd = ctxMgr.getTokenBreakdown(toolCount);
  // 与 bd.total 同源（PR1 保证逐字相等）；这里取它是因为百分比三个口径都已算好。
  const usage = ctxMgr.getContextUsageForDisplay(toolCount);
  const t = ctxMgr.getCompactionThresholds();
  const used = bd.total;

  // ── 构成：分组 + 占已用百分比 ──
  const categories: ContextReportCategory[] = bd.categories.map((c) => ({
    key: c.key,
    label: c.label,
    tokens: c.tokens,
    group: GROUP_BY_KEY[c.key] ?? "conversation",
    percentOfUsed: pct(c.tokens, used),
  }));
  const sumOf = (group: ContextCategoryGroup) =>
    categories.filter((c) => c.group === group).reduce((sum, c) => sum + c.tokens, 0);
  const residentSubtotal = sumOf("resident");
  const conversationSubtotal = sumOf("conversation");

  // ── 本地释放：把策略键翻成人话 ──
  const freedByStrategy: ContextReportFreedStrategy[] = bd.freed.byStrategy.map((s) => ({
    strategy: s.strategy,
    label: FREED_STRATEGY_LABELS[s.strategy] ?? s.strategy,
    tokens: s.tokens,
    count: s.count,
  }));

  // ── 压缩阈值：四档 + 各档剩余 ──
  // 小窗口（≤60K）只有 emergency 一档，soft/hard 的 remaining 恒 0 = 该档未启用，
  // 展示成「触发点 = 窗口上限」会误导用户以为它在生效，所以按 remaining 是否 > 0 过滤。
  const thresholds: ContextReportThreshold[] = [];
  if (t.maskingRemaining > 0) {
    thresholds.push({
      key: "masking",
      label: "遮罩工具输出",
      level: "soft",
      at: bd.thresholds.maskingAt,
      remaining: Math.max(0, bd.thresholds.maskingAt - used),
    });
  }
  if (t.compressionRemaining > 0) {
    thresholds.push({
      key: "compression",
      label: "LLM 摘要",
      level: "hard",
      at: bd.thresholds.compressionAt,
      remaining: Math.max(0, bd.thresholds.compressionAt - used),
    });
  }
  thresholds.push({
    key: "emergency",
    label: "紧急截断",
    level: "emergency",
    at: bd.thresholds.emergencyAt,
    remaining: Math.max(0, bd.thresholds.emergencyAt - used),
  });
  thresholds.push({
    key: "blocking",
    label: "强制截断",
    level: "blocking",
    at: bd.thresholds.blockingAt,
    remaining: Math.max(0, bd.thresholds.blockingAt - used),
  });

  // ── 固定开销来源（A4）：母项从分类里取，细目走同一个校准系数 ──
  const memoryFilesTokens = categories.find((c) => c.key === "memoryFiles")?.tokens ?? 0;
  let fixedOverhead: FixedOverheadReport;
  try {
    fixedOverhead = computeFixedOverheadSources(ctxMgr.getSystemPrompt(), opts.importedFiles, {
      maxTokens: bd.maxTokens,
      calibrationFactor: ctxMgr.getCalibrationFactor(),
      ...(opts.projectRoot !== undefined ? { projectRoot: opts.projectRoot } : {}),
      memoryFilesTokens,
    });
  } catch {
    // 细目算不出来不该让整个面板空掉：主体的构成与阈值仍然有效。
    fixedOverhead = { sources: [], hints: [], residual: memoryFilesTokens };
  }

  // ── 实测对账（B8）──
  const lastActualPromptTokens = Math.max(0, Math.round(opts.stockPromptTokens ?? 0));
  const delta = used - lastActualPromptTokens;

  // ── 结论行第二句：会话组里最大的三个可变成分 ──
  const largestVariable: ContextReportLargest[] = categories
    .filter((c) => c.group === "conversation" && c.tokens > 0)
    .slice()
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, LARGEST_VARIABLE_LIMIT)
    .map((c) => ({ label: c.label, percentOfUsed: c.percentOfUsed, tokens: c.tokens }));

  // ── 提示：最多 3 条，每条都能指到一个字段与一个阈值 ──
  const hints: string[] = [];
  if (bd.level === "soft") {
    hints.push("已在遮罩旧的工具输出，模型看到的是占位符");
  }
  const toTrigger = Math.max(0, bd.thresholds.compressionAt - used);
  if (bd.maxTokens > 0 && toTrigger < bd.maxTokens * NEAR_TRIGGER_RATIO) {
    hints.push("即将触发自动压缩，现在手动 /compact 可以自己选时机");
  }
  for (const h of fixedOverhead.hints) {
    if (hints.length >= HINT_LIMIT) break;
    hints.push(h);
  }

  return {
    model: opts.model,
    used,
    maxTokens: bd.maxTokens,
    percentOfWindow: usage.percentOfWindow,
    triggerPercentOfWindow: usage.triggerPercentOfWindow,
    percentOfTrigger: usage.percentOfTrigger,
    level: bd.level,
    toTrigger,
    categories,
    residentSubtotal,
    conversationSubtotal,
    subtotal: bd.grossTokens,
    subtotalPercentOfUsed: pct(bd.grossTokens, used),
    anchorLiftTokens: bd.anchorLiftTokens,
    freed: { tokens: bd.freed.tokens, byStrategy: freedByStrategy },
    lastActualPromptTokens,
    delta,
    thresholds,
    completionBuffer: t.completionBuffer,
    outputReserve: t.outputReserve,
    summaryReserve: t.summaryReserve,
    fixedOverhead,
    calibrated: bd.calibrated,
    calibrationFactor: ctxMgr.getCalibrationFactor(),
    largestVariable,
    hints: hints.slice(0, HINT_LIMIT),
  };
}
