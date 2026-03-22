/**
 * 循环检测器
 * 检测 agent 陷入无效循环，避免浪费 token
 * 参考 gemini-cli 的两层检测机制
 */

import { createHash } from "node:crypto";
import { getLogger } from "../debug/logger.ts";

/** 循环检测配置 */
export interface LoopDetectionConfig {
  /** 工具调用重复阈值（连续相同调用次数） */
  toolCallThreshold: number;
  /** 内容重复阈值（相同内容块出现次数） */
  contentThreshold: number;
  /** 内容分块大小（字符数） */
  contentChunkSize: number;
  /** 最大恢复尝试次数 */
  maxRecoveryAttempts: number;
}

/** 默认配置 */
export const DEFAULT_LOOP_CONFIG: LoopDetectionConfig = {
  toolCallThreshold: 5,      // 连续 5 次相同工具调用
  contentThreshold: 10,      // 相同内容块出现 10 次
  contentChunkSize: 50,      // 50 字符一块
  maxRecoveryAttempts: 2,    // 最多恢复 2 次
};

/** 循环恢复提示词 */
export const LOOP_RECOVERY_PROMPT = `系统检测到你可能陷入了重复循环。请：
1. 停下来分析你之前的操作
2. 确认是否在重复相同的动作而没有取得进展
3. 如果是，换一种方法解决问题
4. 如果不是，继续当前方案但避免重复相同的工具调用`;

/** 工具调用重复检测器 */
export class ToolCallLoopDetector {
  private config: LoopDetectionConfig;
  private lastToolCallKey: string | null = null;
  private repetitionCount = 0;

  constructor(config: LoopDetectionConfig = DEFAULT_LOOP_CONFIG) {
    this.config = config;
  }

  /** 记录一次工具调用，返回是否检测到循环 */
  record(toolName: string, toolInput: unknown): boolean {
    const log = getLogger();

    // 生成工具调用的唯一标识（工具名 + 参数 hash）
    const inputStr = JSON.stringify(toolInput);
    const hash = createHash("sha256").update(inputStr).digest("hex").slice(0, 16);
    const key = `${toolName}:${hash}`;

    if (key === this.lastToolCallKey) {
      this.repetitionCount++;
      log.debug("LOOP_DETECT", `工具调用重复: ${toolName}, 计数: ${this.repetitionCount}/${this.config.toolCallThreshold}`);

      if (this.repetitionCount >= this.config.toolCallThreshold) {
        log.warn("LOOP_DETECT", `检测到工具调用循环: ${toolName} 连续重复 ${this.repetitionCount} 次`);
        return true;
      }
    } else {
      this.lastToolCallKey = key;
      this.repetitionCount = 1;
    }

    return false;
  }

  /** 重置检测状态（新的用户输入时） */
  reset(): void {
    this.lastToolCallKey = null;
    this.repetitionCount = 0;
  }

  /** 清除检测状态但保留计数（恢复后继续监控） */
  clearState(): void {
    this.lastToolCallKey = null;
    // 保留 repetitionCount，用于判断是否需要再次恢复
  }
}

/** 内容模式重复检测器 */
export class ContentLoopDetector {
  private config: LoopDetectionConfig;
  private contentHashes: string[] = [];
  private hashCounts = new Map<string, number>();

  constructor(config: LoopDetectionConfig = DEFAULT_LOOP_CONFIG) {
    this.config = config;
  }

  /** 记录一次 LLM 输出，返回是否检测到循环 */
  record(text: string): boolean {
    const log = getLogger();

    // 将文本分块并计算 hash
    const chunks = this.chunkText(text, this.config.contentChunkSize);
    const hashes = chunks.map(chunk =>
      createHash("sha256").update(chunk).digest("hex").slice(0, 16)
    );

    // 更新 hash 计数
    for (const hash of hashes) {
      const count = (this.hashCounts.get(hash) || 0) + 1;
      this.hashCounts.set(hash, count);

      // 检测是否有 hash 出现次数超过阈值
      if (count >= this.config.contentThreshold) {
        log.warn("LOOP_DETECT", `检测到内容循环: 相同内容块出现 ${count} 次`);
        return true;
      }
    }

    // 保存 hash 到滑动窗口（限制窗口大小，避免内存膨胀）
    this.contentHashes.push(...hashes);
    const maxWindowSize = 1000;
    if (this.contentHashes.length > maxWindowSize) {
      const removed = this.contentHashes.splice(0, this.contentHashes.length - maxWindowSize);
      // 清理被移除的 hash 计数
      for (const hash of removed) {
        const count = this.hashCounts.get(hash);
        if (count !== undefined) {
          if (count <= 1) {
            this.hashCounts.delete(hash);
          } else {
            this.hashCounts.set(hash, count - 1);
          }
        }
      }
    }

    return false;
  }

  /** 重置检测状态 */
  reset(): void {
    this.contentHashes = [];
    this.hashCounts.clear();
  }

  /** 清除检测状态但保留计数 */
  clearState(): void {
    // 内容检测器清空窗口，但保留 hashCounts 用于继续监控
    this.contentHashes = [];
  }

  /** 将文本分块 */
  private chunkText(text: string, chunkSize: number): string[] {
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += chunkSize) {
      chunks.push(text.slice(i, i + chunkSize));
    }
    return chunks;
  }
}

/** 循环检测器（组合工具调用和内容检测） */
export class LoopDetector {
  private config: LoopDetectionConfig;
  private toolCallDetector: ToolCallLoopDetector;
  private contentDetector: ContentLoopDetector;
  private recoveryAttempts = 0;

  constructor(config: LoopDetectionConfig = DEFAULT_LOOP_CONFIG) {
    this.config = config;
    this.toolCallDetector = new ToolCallLoopDetector(config);
    this.contentDetector = new ContentLoopDetector(config);
  }

  /** 记录工具调用，返回是否检测到循环 */
  recordToolCall(toolName: string, toolInput: unknown): boolean {
    return this.toolCallDetector.record(toolName, toolInput);
  }

  /** 记录内容输出，返回是否检测到循环 */
  recordContent(text: string): boolean {
    return this.contentDetector.record(text);
  }

  /** 重置所有检测状态（新的用户输入时） */
  reset(): void {
    this.toolCallDetector.reset();
    this.contentDetector.reset();
    this.recoveryAttempts = 0;
  }

  /** 尝试恢复，返回是否可以继续（未超过最大恢复次数） */
  tryRecover(): boolean {
    const log = getLogger();
    this.recoveryAttempts++;

    if (this.recoveryAttempts > this.config.maxRecoveryAttempts) {
      log.warn("LOOP_DETECT", `恢复次数已达上限 (${this.config.maxRecoveryAttempts})，终止循环`);
      return false;
    }

    log.info("LOOP_DETECT", `尝试恢复 (${this.recoveryAttempts}/${this.config.maxRecoveryAttempts})`);

    // 清除检测状态但保留计数
    this.toolCallDetector.clearState();
    this.contentDetector.clearState();

    return true;
  }

  /** 获取当前恢复尝试次数 */
  getRecoveryAttempts(): number {
    return this.recoveryAttempts;
  }

  /** 获取最大恢复次数 */
  getMaxRecoveryAttempts(): number {
    return this.config.maxRecoveryAttempts;
  }
}
