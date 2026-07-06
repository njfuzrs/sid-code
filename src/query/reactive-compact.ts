/**
 * 响应式压缩（Reactive Compact）
 * 当 prompt-too-long 错误发生时，紧急压缩消息历史后重试
 * 与 autoCompact 不同：这是错误恢复路径，不是预防性压缩
 */

import { Manager as ContextManager } from "../context/manager.ts";
import { getLogger } from "../debug/index.ts";

/** 响应式压缩结果 */
export interface ReactiveCompactResult {
  /** 是否成功压缩 */
  success: boolean;
  /** 压缩前消息数 */
  messageCountBefore: number;
  /** 压缩后消息数 */
  messageCountAfter: number;
}

/**
 * 响应式压缩：prompt-too-long 错误触发
 * 策略：
 * 1. 先尝试 snipCompact（裁剪最早的消息）
 * 2. 如果不够，尝试 emergencyTruncate
 * 3. 保留最近 4 条消息（2 轮对话）
 *
 * 关键改进：从被裁剪的消息中提取原始任务语义，保留到摘要中，
 * 避免模型压缩后"完全不记得在干什么"而目标跑偏。
 */
export function reactiveCompact(ctxMgr: ContextManager): ReactiveCompactResult {
  const log = getLogger();
  const messageCountBefore = ctxMgr.messageCount();

  if (messageCountBefore <= 4) {
    log.warn("REACTIVE_COMPACT", "消息太少，无法压缩");
    return { success: false, messageCountBefore, messageCountAfter: messageCountBefore };
  }

  // 策略 1：snipCompact — 裁剪最早的消息对（保留最近 60%）
  const keepCount = Math.max(4, Math.ceil(messageCountBefore * 0.6));
  const snipCount = messageCountBefore - keepCount;

  if (snipCount > 0) {
    // 从即将被裁剪的消息中提取任务语义，避免压缩后模型丢失工作方向
    const taskContext = extractTaskContext(ctxMgr.getMessages(), snipCount);
    const summary = buildReactiveCompactSummary(snipCount, taskContext);
    ctxMgr.compactWithSummary(summary);
    const messageCountAfter = ctxMgr.messageCount();
    log.info("REACTIVE_COMPACT", `snipCompact: ${messageCountBefore} → ${messageCountAfter} 条消息`);
    return { success: true, messageCountBefore, messageCountAfter };
  }

  // 策略 2：emergencyTruncate
  ctxMgr.emergencyTruncate();
  const messageCountAfter = ctxMgr.messageCount();
  log.info("REACTIVE_COMPACT", `emergencyTruncate: ${messageCountBefore} → ${messageCountAfter} 条消息`);
  return { success: messageCountAfter < messageCountBefore, messageCountBefore, messageCountAfter };
}

/**
 * 从被裁剪的消息中提取任务语义上下文。
 *
 * 提取逻辑（无 LLM 参与，纯文本提取，适合错误恢复路径的同步场景）：
 * 1. 第一条 user 消息 = 原始任务指令（最关键）
 * 2. 最后一条 assistant 消息中的文本 = 当前工作进度
 *
 * 各段有长度上限防止摘要本身过大。
 */
function extractTaskContext(
  messages: { role: string; content: any[] }[],
  snipCount: number,
): { originalTask: string; lastProgress: string } {
  const snipped = messages.slice(0, snipCount);

  // 1. 找第一条 user 消息文本（原始任务）
  let originalTask = "";
  for (const msg of snipped) {
    if (msg.role !== "user") continue;
    const text = extractTextFromContent(msg.content);
    // 跳过系统注入的内部消息（compact-summary / system-reminder 等）
    if (text.startsWith("[对话摘要]") || text.startsWith("<system-reminder>")) continue;
    originalTask = text;
    break;
  }

  // 2. 找被裁剪部分中最后一条 assistant 的文本（当前进度）
  let lastProgress = "";
  for (let i = snipped.length - 1; i >= 0; i--) {
    if (snipped[i].role !== "assistant") continue;
    lastProgress = extractTextFromContent(snipped[i].content);
    break;
  }

  // 截断保护：任务指令最多 500 字符，进度最多 300 字符
  const MAX_TASK_LEN = 500;
  const MAX_PROGRESS_LEN = 300;
  if (originalTask.length > MAX_TASK_LEN) {
    originalTask = originalTask.slice(0, MAX_TASK_LEN) + "…";
  }
  if (lastProgress.length > MAX_PROGRESS_LEN) {
    lastProgress = lastProgress.slice(0, MAX_PROGRESS_LEN) + "…";
  }

  return { originalTask, lastProgress };
}

/** 从 ContentBlock[] 中提取纯文本 */
function extractTextFromContent(content: any[]): string {
  if (!Array.isArray(content)) return "";
  const texts: string[] = [];
  for (const block of content) {
    if (block.type === "text" && block.text) {
      texts.push(block.text);
    }
  }
  return texts.join("\n").trim();
}

/**
 * 构建带语义的响应式压缩摘要。
 * 结构：操作说明 + 原始任务（让模型知道"在干什么"）+ 最近进度（让模型知道"干到哪了"）
 */
function buildReactiveCompactSummary(
  snipCount: number,
  ctx: { originalTask: string; lastProgress: string },
): string {
  const parts: string[] = [
    `[响应式压缩] 因 prompt-too-long 错误，裁剪了最早的 ${snipCount} 条消息。`,
  ];

  if (ctx.originalTask) {
    parts.push(`\n[原始任务] ${ctx.originalTask}`);
  }

  if (ctx.lastProgress) {
    parts.push(`\n[压缩前进度] ${ctx.lastProgress}`);
  }

  return parts.join("");
}

/**
 * 检测错误是否为 prompt-too-long
 */
export function isPromptTooLongError(err: any): boolean {
  const msg = (err?.message || String(err)).toLowerCase();
  return (
    msg.includes("prompt is too long") ||
    msg.includes("prompt_too_long") ||
    msg.includes("context length exceeded") ||
    msg.includes("maximum context length") ||
    (msg.includes("token") && msg.includes("exceed"))
  );
}

/** DiminishingReturnsDetector 可选构造配置 */
export interface DiminishingReturnsOptions {
  /** 最大续写次数（默认 MAX_RECOVERY_COUNT=3） */
  maxRecoveryCount?: number;
  /** 递减收益阈值，token 数（默认 DIMINISHING_THRESHOLD=500） */
  diminishingThreshold?: number;
}

/**
 * max_tokens 续写的递减收益检测器
 * 连续续写时，如果增量越来越小，说明模型在重复/填充，应该停止
 *
 * P0-3：maxRecoveryCount/diminishingThreshold 现可通过构造函数覆盖，供 Token Budget
 * 续写场景复用同一套"连续两次增量过小即停"判定逻辑，但用更宽松的续写次数上限
 * （该场景的真实上限是预算耗尽，不是续写次数——见 token-budget-continuation.ts）。
 * 不传参数时行为与此前完全一致（两个静态默认值不变，现有 max_tokens 续写调用点无需改动）。
 */
export class DiminishingReturnsDetector {
  /** 每次续写的输出 token 数 */
  private outputTokenHistory: number[] = [];
  /** 最大续写次数（默认） */
  static readonly MAX_RECOVERY_COUNT = 3;
  /** 递减收益阈值，token 数（默认） */
  static readonly DIMINISHING_THRESHOLD = 500;

  private readonly maxRecoveryCount: number;
  private readonly diminishingThreshold: number;

  constructor(options?: DiminishingReturnsOptions) {
    this.maxRecoveryCount = options?.maxRecoveryCount ?? DiminishingReturnsDetector.MAX_RECOVERY_COUNT;
    this.diminishingThreshold = options?.diminishingThreshold ?? DiminishingReturnsDetector.DIMINISHING_THRESHOLD;
  }

  /** 记录一次续写的输出 token 数 */
  record(outputTokens: number): void {
    this.outputTokenHistory.push(outputTokens);
  }

  /**
   * 是否应该停止续写
   * 条件：
   * 1. 已达最大续写次数
   * 2. 连续两次增量 < 阈值（递减收益）
   */
  shouldStop(): boolean {
    const history = this.outputTokenHistory;

    // 条件 1：达到最大次数
    if (history.length >= this.maxRecoveryCount) {
      return true;
    }

    // 条件 2：连续两次增量 < 阈值
    if (history.length >= 2) {
      const last = history[history.length - 1];
      const prev = history[history.length - 2];
      if (last < this.diminishingThreshold &&
          prev < this.diminishingThreshold) {
        return true;
      }
    }

    return false;
  }

  /** 重置 */
  reset(): void {
    this.outputTokenHistory = [];
  }

  /** 获取续写次数 */
  get count(): number {
    return this.outputTokenHistory.length;
  }
}
