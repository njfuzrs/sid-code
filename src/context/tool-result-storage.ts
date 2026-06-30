/**
 * 工具输出磁盘持久化
 *
 * 核心能力：
 * - persistLargeOutput(): 超过阈值的内容写入磁盘，返回 ~200 字节轻量引用
 * - ContentReplacementState: 跨 turn 稳定替换，确保 prompt cache 前缀稳定
 * - enforceToolResultBudget(): per-message 聚合预算控制
 *
 * 设计原则：
 * - 引用文本存储在 block.content 中（仍是字符串），保持类型兼容
 * - 落盘路径：~/.sid-code/trajectories/sessions/{sessionId}/tool-outputs/
 * - 阈值通过环境变量 SID_OUTPUT_THRESHOLD 可配（默认 30000）
 */

import { writeFileSync, mkdirSync, existsSync, readdirSync, statSync, unlinkSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { getLogger } from "../debug/index.ts";
import { sidPaths } from "../config/paths.ts";
import type { Message } from "../llm/types.ts";

// ─── 配置 ───

/** 默认输出阈值（字符数，可通过 SID_OUTPUT_THRESHOLD 环境变量覆盖） */
const DEFAULT_OUTPUT_THRESHOLD = parseInt(
  process.env.SID_OUTPUT_THRESHOLD ?? "30000",
  10,
);

// ─── 持久化输出引用格式 ───

/** 持久化输出的引用前缀（用于下游检测） */
export const PERSISTED_OUTPUT_PREFIX = "[持久化输出]";

/**
 * 生成持久化输出的轻量引用文本（约 200 字节）
 * 替代完整的工具输出内容在 V8 heap 中存储
 */
function buildPersistedReference(
  toolUseId: string,
  toolName: string,
  originalLength: number,
  savedPath: string,
): string {
  return [
    PERSISTED_OUTPUT_PREFIX,
    `tool_use_id=${toolUseId}`,
    `tool=${toolName}`,
    `字符数=${originalLength}`,
    `文件=${savedPath}`,
  ].join(" | ");
}

/**
 * 检查内容是否为持久化输出引用
 */
export function isPersistedReference(content: string): boolean {
  return content.startsWith(PERSISTED_OUTPUT_PREFIX);
}

// ─── 持久化输出 ───

interface PersistResult {
  /** 轻量引用文本（约 200 字节） */
  reference: string;
  /** 完整输出保存的文件路径 */
  savedPath: string;
  /** 原始内容长度 */
  originalLength: number;
}

/**
 * 将大工具输出持久化到磁盘，返回轻量引用
 *
 * 超过阈值的完整内容写入磁盘文件，
 * 仅 ~200 字节的引用文本保留在 V8 heap 中。
 *
 * @param content 原始工具输出内容
 * @param toolUseId 工具调用的唯一 ID
 * @param toolName 工具名称
 * @param sessionId 会话 ID（用于目录组织）
 * @param maxChars 阈值（字符数），默认从环境变量读取
 * @returns 持久化结果（含引用文本和文件路径）
 */
export function persistLargeOutput(
  content: string,
  toolUseId: string,
  toolName: string,
  sessionId: string,
  maxChars: number = DEFAULT_OUTPUT_THRESHOLD,
): PersistResult {
  if (content.length <= maxChars) {
    // 不需要持久化，返回原内容
    return {
      reference: content,
      savedPath: "",
      originalLength: content.length,
    };
  }

  const log = getLogger();

  // 构建输出目录
  const outputDir = join(
    sidPaths.trajectories(),
    "sessions",
    sessionId,
    "tool-outputs",
  );

  // 生成唯一文件名（避免碰撞）
  const timestamp = Date.now();
  const safeName = toolName.replace(/[^a-zA-Z0-9_-]/g, "_");
  const filename = `${safeName}-${timestamp}-${toolUseId.slice(0, 8)}.txt`;
  const savedPath = join(outputDir, filename);

  try {
    // 确保目录存在
    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }

    // 同步写入磁盘（防 V8 OOM 时丢失）
    writeFileSync(savedPath, content, "utf-8");

    log.debug("TOOL_STORAGE", `输出持久化: ${content.length} → ${savedPath}`);
  } catch (err: any) {
    log.warn("TOOL_STORAGE", `输出持久化失败: ${err.message}`);

    // 降级：仍返回引用但标记失败
    return {
      reference: buildPersistedReference(toolUseId, toolName, content.length, "[保存失败]"),
      savedPath: "",
      originalLength: content.length,
    };
  }

  return {
    reference: buildPersistedReference(toolUseId, toolName, content.length, savedPath),
    savedPath,
    originalLength: content.length,
  };
}

// ─── 跨 turn 稳定替换状态 ───

/**
 * 跨 turn 稳定替换状态
 *
 * 同一 tool_use_id 在多个 turn 中始终返回相同的替换文本，
 * 确保 prompt cache 前缀稳定（不会因同一个工具输出的引用变化而 cache miss）。
 */
export class ContentReplacementState {
  private replacements = new Map<string, string>();

  /**
   * 获取或创建替换文本
   *
   * @param toolUseId 工具调用的唯一 ID
   * @param generator 生成替换文本的函数（仅在首次调用时执行）
   * @returns 稳定不变的替换文本
   */
  getOrCreate(toolUseId: string, generator: () => string): string {
    const existing = this.replacements.get(toolUseId);
    if (existing !== undefined) {
      return existing;
    }
    const value = generator();
    this.replacements.set(toolUseId, value);
    return value;
  }

  /** 清空所有替换状态 */
  clear(): void {
    this.replacements.clear();
  }

  /** 获取当前替换数量 */
  get size(): number {
    return this.replacements.size;
  }
}

// ─── 工具输出预算控制（设计预留，当前无需接入） ───
// enforceToolResultBudget 提供 per-message 聚合 token 预算控制（按总量而非条数）。
// 当前三层防线（addMessage 持久化 + 遮罩服务 50K token 保护窗口 + KEEP_RECENT_OUTPUTS=6）
// 已覆盖所有真实场景，不存在溢出风险。
// 详细分析见：docs/bugfixes/todo/enforceToolResultBudget-待接入分析.md
// 接入条件：KEEP_RECENT_OUTPUTS 被调高 / 豁免名单扩大 / 遮罩服务被绕过 / 小窗口模型使用增多

/** 预算控制选项 */
export interface ToolResultBudgetOptions {
  /** 最大 token 预算（默认 50000） */
  maxTokens?: number;
  /** 保留最近 N 条消息不受限制（默认 4） */
  preserveRecentCount?: number;
  /** 字符到 token 的粗略换算比例（默认 4） */
  charsPerToken?: number;
}

const DEFAULT_BUDGET_OPTIONS: Required<ToolResultBudgetOptions> = {
  maxTokens: 50_000,
  preserveRecentCount: 4,
  charsPerToken: 4,
};

/** 预算控制结果 */
export interface ToolResultBudgetResult {
  /** 处理后的消息列表 */
  messages: Message[];
  /** 被截断的工具输出数量 */
  truncatedCount: number;
}

/**
 * per-message 聚合预算控制
 *
 * 超出总预算的旧工具输出替换为占位符，
 * 优先保留最近的消息。
 */
export function enforceToolResultBudget(
  messages: Message[],
  options?: ToolResultBudgetOptions,
): ToolResultBudgetResult {
  const opts = { ...DEFAULT_BUDGET_OPTIONS, ...options };
  const maxChars = opts.maxTokens * opts.charsPerToken;
  const cutoff = Math.max(0, messages.length - opts.preserveRecentCount);

  let totalCharsUsed = 0;
  let truncatedCount = 0;

  const result = messages.map((msg, idx) => {
    if (idx >= cutoff) return msg;
    if (msg.role !== "user") return msg;

    const hasToolResult = msg.content.some((b) => b.type === "tool_result");
    if (!hasToolResult) return msg;

    const newContent = msg.content.map((block) => {
      if (block.type !== "tool_result" || typeof block.content !== "string") return block;

      totalCharsUsed += block.content.length;

      if (totalCharsUsed > maxChars) {
        truncatedCount++;
        return {
          ...block,
          content: `[工具输出已超出预算被清理，原始长度 ${block.content.length} 字符]`,
        };
      }

      return block;
    });

    return { ...msg, content: newContent };
  });

  return { messages: result, truncatedCount };
}

// ─── 临时文件清理 ───

/**
 * 清理过期的工具输出临时文件
 *
 * @param sessionId 会话 ID
 * @param maxAgeMs 最大保留时间（毫秒，默认 7 天——与会话恢复周期对齐，避免 -c 续接时引用变死链）
 */
export function cleanupPersistedOutputs(sessionId: string, maxAgeMs: number = 7 * 24 * 3600_000): void {
  const log = getLogger();

  const dir = join(
    sidPaths.trajectories(),
    "sessions",
    sessionId,
    "tool-outputs",
  );

  if (!existsSync(dir)) return;

  try {
    const files = readdirSync(dir);
    const now = Date.now();
    let cleaned = 0;

    for (const file of files) {
      const filePath = join(dir, file);
      try {
        const stat = statSync(filePath);
        if (now - stat.mtimeMs > maxAgeMs) {
          unlinkSync(filePath);
          cleaned++;
        }
      } catch {
        // 单个文件清理失败，继续
      }
    }

    if (cleaned > 0) {
      log.info("TOOL_STORAGE", `清理了 ${cleaned} 个过期的工具输出临时文件`);
    }

    // 如果目录为空，删除目录
    try {
      const remaining = readdirSync(dir);
      if (remaining.length === 0) {
        rmdirSync(dir);
      }
    } catch {
      // 目录删除失败，忽略
    }
  } catch (err: any) {
    log.warn("TOOL_STORAGE", `清理工具输出文件失败: ${err.message}`);
  }
}
