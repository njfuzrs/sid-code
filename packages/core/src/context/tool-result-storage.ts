/**
 * 工具输出磁盘持久化
 *
 * 核心能力：
 * - persistLargeOutput(): 超过阈值的内容写入磁盘，返回 ~200 字节轻量引用
 * - ContentReplacementState: 跨 turn 稳定替换，确保 prompt cache 前缀稳定
 *
 * 设计原则：
 * - 引用文本存储在 block.content 中（仍是字符串），保持类型兼容
 * - 落盘路径：~/.sid-code/trajectories/sessions/{sessionId}/tool-outputs/
 * - 阈值通过环境变量 SID_OUTPUT_THRESHOLD 可配（默认 30000）
 */

import {
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  statSync,
  unlinkSync,
  rmdirSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { getLogger } from "../debug/index.ts";
import { sidPaths } from "../config/paths.ts";

// ─── 配置 ───

/** 默认输出阈值（字符数，可通过 SID_OUTPUT_THRESHOLD 环境变量覆盖） */
const DEFAULT_OUTPUT_THRESHOLD = parseInt(process.env.SID_OUTPUT_THRESHOLD ?? "30000", 10);

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
  const outputDir = join(sidPaths.trajectories(), "sessions", sessionId, "tool-outputs");

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

// ─── 工具输出预算控制（已评估决定不实现，2026-07-11） ───
// 曾有 enforceToolResultBudget()（per-message 聚合 token 总量预算控制）作为设计预留，
// 但从未接入生产。评估后删除：现有三层防线（addMessage 持久化 + 遮罩服务 50K token
// 保护窗口 + KEEP_RECENT_OUTPUTS=6）已覆盖所有真实场景，且该朴素实现与本文件的
// prompt cache 稳定机制（ContentReplacementState）、getCleanedMessages 的活跃文件/
// 当前 turn 豁免语义均不对齐，直接接入会引入回归。
// 若将来确需按 token 总量兜底（KEEP_RECENT_OUTPUTS 调高 / 豁免名单扩大 / 遮罩被绕过 /
// 小窗口模型增多），必须重写而非复用旧实现，重写要求见：
// docs/bugfixes/todo/enforceToolResultBudget-待接入分析.md

// ─── 临时文件清理 ───

/**
 * 清理过期的工具输出临时文件
 *
 * @param sessionId 会话 ID
 * @param maxAgeMs 最大保留时间（毫秒，默认 7 天——与会话恢复周期对齐，避免 -c 续接时引用变死链）
 */
export function cleanupPersistedOutputs(
  sessionId: string,
  maxAgeMs: number = 7 * 24 * 3600_000,
): void {
  const log = getLogger();

  const dir = join(sidPaths.trajectories(), "sessions", sessionId, "tool-outputs");

  if (!existsSync(dir)) return;

  try {
    const files = readdirSync(dir);
    const now = Date.now();
    let cleaned = 0;

    for (const file of files) {
      const filePath = join(dir, file);
      try {
        const stat = statSync(filePath);
        // 两处刻意的写法，都是实测踩出来的：
        // 1. `Math.max(0, ...)`：mtimeMs 是**亚毫秒浮点**（实测 1786731022719.6404），
        //    而 Date.now() 只有毫秒整数，于是刚写完的文件 now - mtimeMs 会是**负数**
        //    （实测 -0.64ms）。
        // 2. `>=` 而非 `>`：配合上面的钳制，maxAgeMs=0 语义才真的是"全删"。
        //    旧写法 `-0.64 > 0` 恒为 false —— 调用方传 0 想清空，结果一个文件都没删，
        //    且因为本函数吞掉所有异常、不返回计数，**调用方完全看不出清理失败**。
        //    实测后果：测试 afterAll 传 0 清理，文件却留在盘上（见本包
        //    tests/context/tool-result-storage.test.ts 的清理断言）。
        //    生产路径（默认 7 天）不受影响：钳制后为 0，`0 >= 7天` 仍为 false，新文件照样保留。
        if (Math.max(0, now - stat.mtimeMs) >= maxAgeMs) {
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

    // 如果目录为空，删除目录。
    // 连父目录 sessions/<id>/ 一起收：persistLargeOutput 用 mkdirSync(recursive:true) 建目录，
    // 会**顺带建出** sessions/<id>/，而此前只删 tool-outputs/ 这一层 —— 于是每个只产生过
    // 大工具输出、没有其它轨迹文件的会话，都在盘上留下一个空的 sessions/<id>/。
    // 这类空壳会灌水"会话数"分母（同一病灶另见 trace/collector.ts 的 pruneStaleBlankSessions），
    // 让覆盖率这类指标算出来偏低。
    // 只在**确认为空**时删，且 rmdirSync 对非空目录本就会抛错 —— 双重保险：
    // 绝不会碰到有真实轨迹数据（events.jsonl / session.traj）的会话目录。
    try {
      if (readdirSync(dir).length === 0) {
        rmdirSync(dir);
        // 父目录若因此变空，一并回收（非空则 rmdirSync 抛错，被 catch 吞掉，正是想要的行为）
        const sessionDir = dirname(dir);
        if (readdirSync(sessionDir).length === 0) {
          rmdirSync(sessionDir);
        }
      }
    } catch {
      // 目录删除失败，忽略
    }
  } catch (err: any) {
    log.warn("TOOL_STORAGE", `清理工具输出文件失败: ${err.message}`);
  }
}
