/**
 * 响应式压缩（Reactive Compact）
 * 当 prompt-too-long 错误发生时，紧急压缩消息历史后重试
 * 与 autoCompact 不同：这是错误恢复路径，不是预防性压缩
 */

import { Manager as ContextManager } from "../context/manager.ts";
import { getLogger } from "../debug/index.ts";
// 上下文超限判定的唯一事实源（见 isPromptTooLongError 的委托注释）
import { isPromptTooLong } from "../api/errors.ts";
// 前缀取单一事实源，不在本文件硬编码字面量（isInternalTextBlock 的剥离判定必须与注入端逐字节一致）
import {
  REATTACH_FILE_PREFIX,
  REATTACH_PLAN_PREFIX,
  REATTACH_DECISIONS_PREFIX,
  REATTACH_ORIGINAL_TASK_PREFIX,
} from "./compact/reattach-markers.ts";

/** 响应式压缩结果 */
export interface ReactiveCompactResult {
  /**
   * 是否成功压缩。
   *
   * P0-1（2026-07-29 假压缩误报事故）：此前策略 1 分支**硬编码** `true`，而它调用的
   * `compactWithSummary` 在无安全分割点时静默 no-op ——于是「消息一条没少」却上报成功，
   * 上层照此画出「对话已压缩」横幅、并给模型注入「系统已为你精简对话上下文」这句假话
   * （模型随后 30 条回复持续自我否定）。现在本字段一律由 `messageCountAfter <
   * messageCountBefore` 实测决定，任何路径都不得再自行宣告成功。
   */
  success: boolean;
  /** 压缩前消息数 */
  messageCountBefore: number;
  /** 压缩后消息数 */
  messageCountAfter: number;
  /** 压缩前估算 token（供上层日志/事件展示实据） */
  tokensBefore?: number;
  /** 压缩后估算 token */
  tokensAfter?: number;
  /** 实际生效的策略（失败时为 "none"） */
  strategy?: "snip" | "emergency" | "none";
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
    return {
      success: false,
      messageCountBefore,
      messageCountAfter: messageCountBefore,
      strategy: "none",
    };
  }

  // 策略 1：snipCompact — 裁剪最早的消息对（保留最近 60%）
  const keepCount = Math.max(4, Math.ceil(messageCountBefore * 0.6));
  const snipCount = messageCountBefore - keepCount;

  if (snipCount > 0) {
    // 从即将被裁剪的消息中提取任务语义，避免压缩后模型丢失工作方向
    const taskContext = extractTaskContext(ctxMgr.getMessages(), snipCount);
    const summary = buildReactiveCompactSummary(snipCount, taskContext);
    // P0-1：success 取自 compactWithSummary 的实测结果，不再硬编码 true。
    const outcome = ctxMgr.compactWithSummary(summary);
    if (outcome.success) {
      log.info(
        "REACTIVE_COMPACT",
        `snipCompact: ${outcome.messageCountBefore} → ${outcome.messageCountAfter} 条消息` +
          `（${outcome.tokensBefore} → ${outcome.tokensAfter} tokens）`,
      );
      return {
        success: true,
        messageCountBefore: outcome.messageCountBefore,
        messageCountAfter: outcome.messageCountAfter,
        tokensBefore: outcome.tokensBefore,
        tokensAfter: outcome.tokensAfter,
        strategy: "snip",
      };
    }
    // P0-1 + P0-5 配套：策略 1 没压动**必须降级到策略 2**，而不是原地宣告成功。
    // 旧代码在这里 return success:true，导致策略 2（emergencyTruncate）永远走不到——
    // 两个策略在 agent 会话里一起失效，且失效被"成功"二字完全掩盖。
    log.warn(
      "REACTIVE_COMPACT",
      `snipCompact 未生效（reason=${outcome.reason}，${outcome.messageCountBefore} 条消息未变），降级尝试 emergencyTruncate`,
    );
  }

  // 策略 2：emergencyTruncate（策略 1 未生效或本就无需 snip 时的兜底）
  const emergency = ctxMgr.emergencyTruncate();
  if (emergency.success) {
    log.info(
      "REACTIVE_COMPACT",
      `emergencyTruncate: ${emergency.messageCountBefore} → ${emergency.messageCountAfter} 条消息`,
    );
  } else {
    log.warn(
      "REACTIVE_COMPACT",
      `响应式压缩彻底未生效（reason=${emergency.reason}），${messageCountBefore} 条消息保持不变`,
    );
  }
  return {
    success: emergency.success,
    messageCountBefore,
    messageCountAfter: emergency.messageCountAfter,
    tokensBefore: emergency.tokensBefore,
    tokensAfter: emergency.tokensAfter,
    strategy: emergency.success ? "emergency" : "none",
  };
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
  //
  // 逐 block 判定，而非 join 后 startsWith：原实现把整条消息的 text block join 成一个
  // 字符串再判前缀，只要**第一个** block 是真实文本，后面夹带的内部注入块就会被整段
  // 收进"原始任务"；反过来若内部块排在前面，整条消息（含真实指令）又被整段跳过。
  // 二者都会让摘要里的"用户最初的请求"失真——正是 2026-07-29"模型分不清谁在说话"
  // 的同类故障（轨迹 20260729-180624-b8ae8e78）。
  //
  // 注：注入产物本不该落历史（见 query/reminder-inject.ts 不变量 3 与哨兵测试），
  // 这里是防御性第二道闸：历史里仍有几类合法直插的内部 user 消息（止损阀终态
  // notice、上次压缩的 reattach 锚点、hook 反馈），必须逐块滤掉。
  let originalTask = "";
  for (const msg of snipped) {
    if (msg.role !== "user") continue;
    const text = extractRealUserText(msg.content);
    if (!text) continue; // 整条都是内部注入 → 跳过，继续找下一条
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
 * 一个 text block 是否是 harness 内部注入（而非用户输入）。
 *
 * 前缀取自 compact/reattach-markers.ts 单一事实源，不要在这里硬编码字面量——
 * 那个文件的注释明写"剥离判定必须与注入端的前缀逐字节一致"，抄一份就会漂移。
 */
function isInternalTextBlock(text: string): boolean {
  const t = text.trimStart();
  if (t.startsWith("<system-reminder>") || t.startsWith("<available-deferred-tools>")) return true;
  if (t.startsWith("[对话摘要]") || t.startsWith("[响应式压缩]")) return true;
  return [
    REATTACH_FILE_PREFIX,
    REATTACH_PLAN_PREFIX,
    REATTACH_DECISIONS_PREFIX,
    REATTACH_ORIGINAL_TASK_PREFIX,
  ].some((p) => t.startsWith(p));
}

/**
 * 逐 block 提取**真实用户文本**，滤掉 harness 内部注入块。
 * 整条消息都是内部注入时返回空串（调用方据此跳过整条，继续找下一条）。
 */
function extractRealUserText(content: any[]): string {
  if (!Array.isArray(content)) return "";
  const texts: string[] = [];
  for (const block of content) {
    if (block.type !== "text" || !block.text) continue;
    if (isInternalTextBlock(block.text)) continue;
    texts.push(block.text);
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
 * 检测错误是否为 prompt-too-long（驱动 reactiveCompact 的活判据）。
 *
 * ⚠ 委托到 `api/errors.ts::isPromptTooLong` —— 那里是全仓唯一事实源，**不要在这里
 * 重新维护一份 pattern 列表**。此前这里是独立实现，比 SSOT 少 4 种真实措辞
 * （`context_length_exceeded` / `exceeds the context window` / `too many tokens` /
 * `reduce the length`），导致这些服务端措辞下**该压缩却不压缩**：本函数是
 * query/loop.ts 触发 reactiveCompact 的唯一闸门，漏判即等于把一个本可自动恢复的
 * 失败直接抛给用户。详见 SSOT 处的事故注释。
 */
export function isPromptTooLongError(err: any): boolean {
  return isPromptTooLong(err);
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
  /**
   * 最大续写次数（默认）。
   *
   * 2026-07-07 约束型误伤修复（Top 3）：从 3 放宽到 8。此前 3 次上限与"分段小步写大文件"
   * 的续写提示词自相矛盾——续写提示恰恰引导模型"单次调用别超上限、分多段写"，而 3 次
   * 上限又把"连续几段小步"判为递减收益掐断，正常分段写大文件高概率被误终止。放宽到 8
   * 给分段写入留足空间；真正的失控由 maxTurns/costLimit 兜底，不靠这个次数。
   */
  static readonly MAX_RECOVERY_COUNT = 8;
  /**
   * 递减收益阈值，token 数（默认）。
   *
   * 2026-07-07 约束型误伤修复（Top 3）：从 500 收紧到 150。分段写入时每段本就不大
   * （几百 token 很正常），500 阈值下"连续两段各 <500"极易命中，把正常分段误判为
   * "重复/填充"。降到 150 只在模型真的在吐极少量内容（几乎没进展）时才判递减收益。
   */
  static readonly DIMINISHING_THRESHOLD = 150;

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
