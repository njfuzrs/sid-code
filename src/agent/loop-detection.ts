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
  /** 工具 shape 探测循环阈值（同 toolName + 同 key-set 但 value 不同的连续次数） */
  toolShapeThreshold: number;
  /** 工具 shape 滑动窗口大小（最近 N 次内统计 shape 出现次数） */
  toolShapeWindow: number;
}

/** 默认配置 */
export const DEFAULT_LOOP_CONFIG: LoopDetectionConfig = {
  toolCallThreshold: 3,      // 连续 3 次相同工具调用即触发（之前 5 次过于宽松，模型容易绕开）
  contentThreshold: 10,      // 相同内容块出现 10 次
  contentChunkSize: 50,      // 50 字符一块
  maxRecoveryAttempts: 3,    // 最多恢复 3 次（方案 C-1: 2→3，避免正当任务被一次误判掐死）
  toolShapeThreshold: 5,     // ADR-020 §2.2: 同 shape 在窗口内出现 5 次即判循环（hrn_006 grep 不同 pattern 探测）
  toolShapeWindow: 8,        // 最近 8 次工具调用窗口
};

/** 循环恢复提示词
 *  注：给出**具体**的下一步建议，而不只是"换一种方法"，避免模型反复尝试相同变体。 */
export const LOOP_RECOVERY_PROMPT = `系统检测到你陷入了非生产性循环——连续多次以等价参数调用同一工具但未取得进展。

请立刻停止当前思路，并按这个顺序处理：
1. **退后一步**：用一句话总结你想达成的目标，以及为什么当前路径无效。
2. **换工具/换粒度**：如果一直在 grep 找不到，换 glob 列文件、或用 read 读 README/index 等总览文件；如果一直在 read 同一文件，尝试 grep 缩小定位范围。
3. **放宽匹配**：grep 没结果时，去掉 path 限定、用更短的 pattern、或加 case_insensitive；read 失败时检查文件是否真的存在（先用 glob/ls）。
4. **诚实兜底**：如果反复确认目标文件/函数不存在，直接告诉用户"未找到"，不要继续无效搜索。

如果你其实在对**同一个文件的不同部分**做合法的分段读取、多点编辑或迭代验证（这是正常的开发行为），请明确说明你的当前进展，然后继续完成剩余工作。只有在反复尝试完全相同的参数却无任何进展时才需要换思路。`;

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

    // 方案 C-2: 恢复后给 grace 缓冲，而非立即零容忍
    const grace = this.recoveryGrace.get(key);
    if (grace !== undefined) {
      if (grace > 1) {
        this.recoveryGrace.set(key, grace - 1);
        return false; // 仍在 grace 缓冲期，放过
      }
      // grace 耗尽，删除记录，继续正常检测
      this.recoveryGrace.delete(key);
      // 不 return，继续走下面的正常重复检测逻辑
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
    this.recoveryGrace.clear();
  }

  /** 清除检测状态但保留计数（恢复后继续监控）
   *  方案 C-2: 恢复后给 N 次 grace 缓冲，而非之前记录的 key 被零容忍立即触发。
   *  grace 次数 = toolCallThreshold（默认 3），同 key 在 grace 缓冲内重复不会被立即杀。 */
  clearState(): void {
    if (this.lastToolCallKey) {
      this.recoveryGrace.set(this.lastToolCallKey, this.config.toolCallThreshold);
    }
    this.lastToolCallKey = null;
    // 保留 repetitionCount，用于判断是否需要再次恢复
  }

  /** 方案 C-2: 恢复后 grace 缓冲 map（key → 剩余 grace 次数），替代原来的零容忍 Set */
  private recoveryGrace: Map<string, number> = new Map();
}

/** 工具 shape 探测循环检测器（ADR-020 §2.2 落地）
 *  case 来源：hrn_006 — agent 反复 grep 同一 path 但变换 pattern / case_insensitive 等参数
 *  尝试找一个不存在的字符串。
 *  现象：每次参数 value 都不同 → ToolCallLoopDetector 不触发；
 *  但其实是同 shape（toolName + 主结构 key-set + 关键 path/cwd）在反复探测。
 *
 *  策略：
 *  - 对每次工具调用提取一个稳定的 shape key（例如 grep:cwd=/x:keys=case_insensitive,pattern,path）
 *  - 在最近 N 次工具调用滑动窗口内统计同 shape 出现次数
 *  - 出现 ≥ threshold 次即判循环（默认窗口 8 / 阈值 5）
 *
 *  与 ToolCallLoopDetector 的关系：互补。ToolCallLoopDetector 看完全相同；
 *  ToolShapeLoopDetector 看"同形状的反复探测"，对参数变体不敏感的探测循环兜底。 */
export class ToolShapeLoopDetector {
  private config: LoopDetectionConfig;
  private window: string[] = [];

  constructor(config: LoopDetectionConfig = DEFAULT_LOOP_CONFIG) {
    this.config = config;
  }

  /** 提取工具调用的 shape key —— 反映"在同一目标上重复探测"的语义不变量。
   *  - toolName 进 key
   *  - 顶层对象的 key 集合排序后进 key（结构稳定）
   *  - "锚点字段" path / cwd / file 的 value 进 key（同一目标）
   *  - "分页字段" offset / limit / start_line / end_line / line 的 value 进 key（方案 A：区分翻页与原地探测）
   *  - edit 工具按 old_string hash 区分（方案 B：多点编辑不算循环）
   *  - 其他字段 value 不进 key（让 grep pattern 变化等被算成同 shape） */
  private shapeKey(toolName: string, toolInput: unknown): string {
    if (!toolInput || typeof toolInput !== "object" || Array.isArray(toolInput)) {
      return `${toolName}:scalar`;
    }
    const obj = toolInput as Record<string, unknown>;
    const keys = Object.keys(obj).sort();

    // 方案 B: edit 工具按 old_string 内容区分 shape —— 改不同地方各算各的
    if (toolName === "edit" && typeof obj.old_string === "string") {
      const editHash = createHash("sha256").update(obj.old_string).digest("hex").slice(0, 8);
      return `${toolName}::file=${obj.file_path ?? "?"}::edit=${editHash}`;
    }

    const anchorFields = ["path", "cwd", "file", "file_path", "dir", "directory"];
    // 方案 A: 分页字段也进 key —— 不同区间是"推进"不是"探测"
    const paginationFields = ["offset", "limit", "start_line", "end_line", "line"];

    const anchors = anchorFields
      .filter(f => f in obj)
      .map(f => `${f}=${typeof obj[f] === "string" ? obj[f] : JSON.stringify(obj[f])}`)
      .join("|");
    const pages = paginationFields
      .filter(f => f in obj)
      .map(f => `${f}=${typeof obj[f] === "string" ? obj[f] : JSON.stringify(obj[f])}`)
      .join("|");

    return `${toolName}::keys=[${keys.join(",")}]::anchors=${anchors || "(none)"}${pages ? `::pages=${pages}` : ""}`;
  }

  /** 记录一次工具调用，返回是否检测到 shape 循环 */
  record(toolName: string, toolInput: unknown): boolean {
    const log = getLogger();
    const shape = this.shapeKey(toolName, toolInput);

    // 方案 C-2: 恢复后 grace 缓冲，而非立即零容忍
    const graceRemaining = this.recoveryShapeGrace.get(shape);
    if (graceRemaining !== undefined) {
      if (graceRemaining > 1) {
        this.recoveryShapeGrace.set(shape, graceRemaining - 1);
        return false; // 仍在 grace 缓冲期
      }
      this.recoveryShapeGrace.delete(shape);
      // 不 return，继续走正常的滑动窗口检测
    }

    this.window.push(shape);
    if (this.window.length > this.config.toolShapeWindow) {
      this.window.shift();
    }

    let count = 0;
    for (const s of this.window) {
      if (s === shape) count++;
    }

    if (count >= this.config.toolShapeThreshold) {
      log.warn("LOOP_DETECT", `检测到工具 shape 探测循环: ${shape} 在 ${this.window.length} 次内出现 ${count} 次`);
      return true;
    }
    return false;
  }

  reset(): void {
    this.window = [];
    this.recoveryShapeGrace.clear();
  }

  /** 方案 C-2: 清除窗口但给最后触发的 shape N 次 grace 缓冲，替代原来的零容忍 */
  clearState(): void {
    if (this.window.length > 0) {
      const last = this.window[this.window.length - 1];
      if (last) this.recoveryShapeGrace.set(last, 3); // 3 次 grace
    }
    this.window = [];
  }

  /** 方案 C-2: 恢复后 grace 缓冲 map（shape → 剩余 grace 次数），替代原来的零容忍 Set */
  private recoveryShapeGrace: Map<string, number> = new Map();
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

/** 豁免工具集合：这些工具的连续调用是合法的并发/分派行为，不应被判定为循环
 *  - sub_agent: 每次 description/prompt 不同，hash 必然不同，但 shape detector 可能误判
 *  - task_output/task_stop/send_message: 任务管理工具，操作不同 task
 *  - todo_write: 状态更新工具，内容自然变化
 *  - enter_plan_mode/exit_plan_mode: 模式切换工具 */
const EXEMPT_TOOLS = new Set([
  "sub_agent", "task_output", "task_stop",
  "send_message", "todo_write", "enter_plan_mode",
  "exit_plan_mode", "task_list",
]);

/** 循环检测器（组合工具调用和内容检测） */
export class LoopDetector {
  private config: LoopDetectionConfig;
  private toolCallDetector!: ToolCallLoopDetector;
  private toolShapeDetector!: ToolShapeLoopDetector;
  private contentDetector!: ContentLoopDetector;
  private recoveryAttempts = 0;
  private turnCount = 0;
  private lastLLMCheckTurn = 0;
  /** 循环检测是否已禁用（对齐 claude-code，默认禁用，opt-in 开启） */
  private _disabled = false;

  constructor(config: LoopDetectionConfig = DEFAULT_LOOP_CONFIG) {
    if (!isLoopDetectionEnabled()) {
      this._disabled = true;
      this.config = config;
      return;
    }
    this.config = config;
    this.toolCallDetector = new ToolCallLoopDetector(config);
    this.toolShapeDetector = new ToolShapeLoopDetector(config);
    this.contentDetector = new ContentLoopDetector(config);
  }

  /** 记录工具调用，返回是否检测到循环（任一检测器命中即触发） */
  recordToolCall(toolName: string, toolInput: unknown): boolean {
    if (this._disabled) return false;
    // 豁免工具：合法并发/分派行为不应被判定为循环
    if (EXEMPT_TOOLS.has(toolName)) return false;
    const exact = this.toolCallDetector.record(toolName, toolInput);
    const shape = this.toolShapeDetector.record(toolName, toolInput);
    return exact || shape;
  }

  /** 记录内容输出，返回是否检测到循环 */
  recordContent(text: string): boolean {
    if (this._disabled) return false;
    return this.contentDetector.record(text);
  }

  /** 记录一轮对话 */
  recordTurn(): void {
    if (this._disabled) return;
    this.turnCount++;
  }

  /** 是否应该运行 LLM 认知检测 */
  shouldRunLLMCheck(): boolean {
    if (this._disabled) return false;
    if (this.turnCount < LLM_CHECK_AFTER_TURNS) return false;
    if (this.turnCount - this.lastLLMCheckTurn < LLM_CHECK_INTERVAL) return false;
    this.lastLLMCheckTurn = this.turnCount;
    return true;
  }

  /** 构建 LLM 认知检测提示词 */
  buildLLMCheckPrompt(recentMessages: Message[]): string {
    if (this._disabled) return "";
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
    if (this._disabled) return false;
    const log = getLogger();
    if (result.is_loop && result.confidence >= LLM_CONFIDENCE_THRESHOLD) {
      log.warn("LOOP_DETECT", `LLM 认知检测: ${result.reason} (置信度: ${result.confidence})`);
      return true;
    }
    return false;
  }

  /** 重置所有检测状态（新的用户输入时） */
  reset(): void {
    if (this._disabled) return;
    this.toolCallDetector.reset();
    this.toolShapeDetector.reset();
    this.contentDetector.reset();
    this.recoveryAttempts = 0;
    this.turnCount = 0;
    this.lastLLMCheckTurn = 0;
  }

  /** 尝试恢复，返回是否可以继续（未超过最大恢复次数） */
  tryRecover(): boolean {
    if (this._disabled) return true;
    const log = getLogger();
    this.recoveryAttempts++;

    if (this.recoveryAttempts > this.config.maxRecoveryAttempts) {
      log.warn("LOOP_DETECT", `恢复次数已达上限 (${this.config.maxRecoveryAttempts})，终止循环`);
      return false;
    }

    log.info("LOOP_DETECT", `尝试恢复 (${this.recoveryAttempts}/${this.config.maxRecoveryAttempts})`);

    // 清除检测状态但保留计数
    this.toolCallDetector.clearState();
    this.toolShapeDetector.clearState();
    this.contentDetector.clearState();

    return true;
  }

  /** 获取当前恢复尝试次数 */
  getRecoveryAttempts(): number {
    return this._disabled ? 0 : this.recoveryAttempts;
  }

  /** 获取最大恢复次数 */
  getMaxRecoveryAttempts(): number {
    return this._disabled ? 0 : this.config.maxRecoveryAttempts;
  }

  /** 获取当前轮次数 */
  getTurnCount(): number {
    return this._disabled ? 0 : this.turnCount;
  }
}

/** 检查循环检测是否启用（对齐 claude-code，默认不启用）
 *  通过环境变量 SID_ENABLE_LOOP_DETECTION=1 开启，
 *  供弱模型（DeepSeek/Ollama）场景使用。 */
export function isLoopDetectionEnabled(): boolean {
  return process.env.SID_ENABLE_LOOP_DETECTION === "1";
}
