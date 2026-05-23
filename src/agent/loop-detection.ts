/**
 * 循环检测器
 * 检测 agent 陷入无效循环，避免浪费 token
 * 参考 gemini-cli 的两层检测机制
 */

import { createHash } from "node:crypto";
import { getLogger } from "../debug/logger.ts";
import type { Message } from "../llm/types.ts";

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
  toolCallThreshold: 3,      // 连续 3 次相同工具调用即触发（之前 5 次过于宽松，模型容易绕开）
  contentThreshold: 10,      // 相同内容块出现 10 次
  contentChunkSize: 50,      // 50 字符一块
  maxRecoveryAttempts: 2,    // 最多恢复 2 次
};

/** 循环恢复提示词
 *  注：给出**具体**的下一步建议，而不只是"换一种方法"，避免模型反复尝试相同变体。 */
export const LOOP_RECOVERY_PROMPT = `系统检测到你陷入了非生产性循环——连续多次以等价参数调用同一工具但未取得进展。

请立刻停止当前思路，并按这个顺序处理：
1. **退后一步**：用一句话总结你想达成的目标，以及为什么当前路径无效。
2. **换工具/换粒度**：如果一直在 grep 找不到，换 glob 列文件、或用 read 读 README/index 等总览文件；如果一直在 read 同一文件，尝试 grep 缩小定位范围。
3. **放宽匹配**：grep 没结果时，去掉 path 限定、用更短的 pattern、或加 case_insensitive；read 失败时检查文件是否真的存在（先用 glob/ls）。
4. **诚实兜底**：如果反复确认目标文件/函数不存在，直接告诉用户"未找到"，不要继续无效搜索。

不要再用相同或仅参数顺序不同的工具调用。`;

/** 把工具输入规范化为稳定字符串，用于循环检测。
 *  目的：让 {"a":1,"b":2} 和 {"b":2,"a":1} 哈希一致——LLM 输出工具参数顺序经常变化，
 *  原本朴素 JSON.stringify 会把语义相同的调用算成不同 key，导致循环检测被绕过。 */
function canonicalizeToolInput(input: unknown): string {
  return canonicalStringify(input);
}

function canonicalStringify(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return `[${v.map(canonicalStringify).join(",")}]`;
  if (typeof v === "object") {
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalStringify(obj[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

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

    // 生成工具调用的唯一标识（工具名 + 规范化参数 hash）
    // canonicalizeToolInput 排序对象 key，避免 LLM 调换参数顺序绕过检测
    const inputStr = canonicalizeToolInput(toolInput);
    const hash = createHash("sha256").update(inputStr).digest("hex").slice(0, 16);
    const key = `${toolName}:${hash}`;

    // 恢复后再次命中之前已触发循环的 key —— 立刻判定为循环，不给二次机会
    if (this.recoveryHistory.has(key)) {
      log.warn("LOOP_DETECT", `恢复后再次撞到已记录的循环调用: ${toolName}，立即触发`);
      return true;
    }

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
    this.recoveryHistory.clear();
  }

  /** 清除检测状态但保留计数（恢复后继续监控）
   *  注：把上一次循环命中的 key 记入 recoveryHistory，下次再撞同一个 key 直接判循环——
   *  不给模型"恢复一次就重置 5 次窗口"的漏洞。 */
  clearState(): void {
    if (this.lastToolCallKey) {
      this.recoveryHistory.add(this.lastToolCallKey);
    }
    this.lastToolCallKey = null;
    // 保留 repetitionCount，用于判断是否需要再次恢复
  }

  /** 之前已触发循环恢复的 key 集合：恢复后再次撞同一个 key 直接判循环 */
  private recoveryHistory: Set<string> = new Set();
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

/** LLM 认知检测配置 */
const LLM_CHECK_AFTER_TURNS = 30;
const LLM_CHECK_INTERVAL = 10;
const LLM_CONFIDENCE_THRESHOLD = 0.9;

/** LLM 认知检测提示词 */
export const LOOP_DETECTION_PROMPT = `你是一个对话模式分析器。判断 AI 助手是否陷入了非生产性循环。

区分：
- 生产性重复：跨文件批量操作（不同文件路径）、增量编辑 → 不是循环
- 非生产性循环：语义等价的重复调用、反复尝试相同方案 → 是循环

返回 JSON：{ "is_loop": boolean, "confidence": number, "reason": string }`;

/** LLM 认知检测结果 */
export interface LLMLoopCheckResult {
  is_loop: boolean;
  confidence: number;
  reason: string;
}

/** 循环检测器（组合工具调用和内容检测） */
export class LoopDetector {
  private config: LoopDetectionConfig;
  private toolCallDetector: ToolCallLoopDetector;
  private contentDetector: ContentLoopDetector;
  private recoveryAttempts = 0;
  private turnCount = 0;
  private lastLLMCheckTurn = 0;

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

  /** 记录一轮对话 */
  recordTurn(): void {
    this.turnCount++;
  }

  /** 是否应该运行 LLM 认知检测 */
  shouldRunLLMCheck(): boolean {
    if (this.turnCount < LLM_CHECK_AFTER_TURNS) return false;
    if (this.turnCount - this.lastLLMCheckTurn < LLM_CHECK_INTERVAL) return false;
    this.lastLLMCheckTurn = this.turnCount;
    return true;
  }

  /** 构建 LLM 认知检测提示词 */
  buildLLMCheckPrompt(recentMessages: Message[]): string {
    const toolCalls: string[] = [];
    for (const msg of recentMessages) {
      for (const block of msg.content) {
        if (block.type === "tool_use") {
          toolCalls.push(`${block.name}(${JSON.stringify(block.input).slice(0, 200)})`);
        }
      }
    }
    return `${LOOP_DETECTION_PROMPT}\n\n最近的工具调用序列：\n${toolCalls.join("\n")}`;
  }

  /** 处理 LLM 认知检测结果 */
  processLLMResult(result: LLMLoopCheckResult): boolean {
    const log = getLogger();
    if (result.is_loop && result.confidence >= LLM_CONFIDENCE_THRESHOLD) {
      log.warn("LOOP_DETECT", `LLM 认知检测: ${result.reason} (置信度: ${result.confidence})`);
      return true;
    }
    return false;
  }

  /** 重置所有检测状态（新的用户输入时） */
  reset(): void {
    this.toolCallDetector.reset();
    this.contentDetector.reset();
    this.recoveryAttempts = 0;
    this.turnCount = 0;
    this.lastLLMCheckTurn = 0;
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

  /** 获取当前轮次数 */
  getTurnCount(): number {
    return this.turnCount;
  }
}
