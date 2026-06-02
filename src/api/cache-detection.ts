/**
 * Prompt Cache 失效检测与归因
 *
 * 职责（对标 Claude Code 的 promptCacheBreakDetection.ts）：
 * - 两阶段检测：请求前快照状态 + 响应后比较 cache_read_tokens 变化
 * - 当缓存命中骤降时，归因到具体原因：模型变化 / system prompt 变化 /
 *   工具增删改 / TTL 过期
 *
 * 实现为可实例化的 CacheBreakDetector（便于单测隔离），
 * 同时导出一个默认单例 + 模块级便捷函数（生产用）。
 */

import { createHash } from "node:crypto";

/** 请求前的状态快照 */
interface PromptState {
  systemPromptHash: string;
  toolSchemasHash: string;
  /** 逐工具 hash，精确定位变化 */
  perToolHashes: Map<string, string>;
  model: string;
  timestamp: number;
}

/** cache break 归因报告 */
export interface CacheBreakReport {
  /** 命中下降的 token 数 */
  dropTokens: number;
  /** 下降百分比（整数，0-100） */
  dropPercent: number;
  /** 归因列表（人类可读） */
  changes: string[];
  /** 上次的 cache_read tokens */
  previousCacheReadTokens: number;
  /** 本次的 cache_read tokens */
  currentCacheReadTokens: number;
}

/** 输入参数 */
export interface CacheCheckParams {
  cacheReadTokens: number;
  systemPrompt: string;
  toolSchemas: { name: string; [key: string]: unknown }[];
  model: string;
}

/** 检测阈值 */
const DROP_PERCENT_THRESHOLD = 0.05; // 下降 > 5%
const DROP_TOKENS_THRESHOLD = 2000; // 且绝对值 > 2000 tokens
const TTL_WARN_MS = 300_000; // 5 分钟

function hashString(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

export class CacheBreakDetector {
  private previousState: PromptState | null = null;
  private previousCacheReadTokens = 0;
  /** 时间源，可注入便于测试 */
  private now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** 重置状态（新会话 / clear 时调用） */
  reset(): void {
    this.previousState = null;
    this.previousCacheReadTokens = 0;
  }

  private snapshot(params: CacheCheckParams): PromptState {
    return {
      systemPromptHash: hashString(params.systemPrompt),
      toolSchemasHash: hashString(JSON.stringify(params.toolSchemas)),
      perToolHashes: new Map(
        params.toolSchemas.map((t) => [t.name, hashString(JSON.stringify(t))]),
      ),
      model: params.model,
      timestamp: this.now(),
    };
  }

  /**
   * Phase 1: 请求前 — 快照当前状态（不比较）。
   * 通常由 checkResponse 内部自动调用，但暴露出来供显式快照场景使用。
   */
  recordPromptState(params: CacheCheckParams): void {
    this.previousState = this.snapshot(params);
  }

  /**
   * Phase 2: 响应后 — 检测 cache 失效并归因。
   * 返回 null 表示无显著失效（首次请求 / 命中正常 / 下降未达阈值）。
   */
  checkResponse(params: CacheCheckParams): CacheBreakReport | null {
    // 首次请求或上次无缓存：记录并返回
    if (!this.previousState || this.previousCacheReadTokens === 0) {
      this.previousCacheReadTokens = params.cacheReadTokens;
      this.recordPromptState(params);
      return null;
    }

    const prevTokens = this.previousCacheReadTokens;
    const dropTokens = prevTokens - params.cacheReadTokens;
    const dropPercent = dropTokens / prevTokens;

    // 双重阈值：下降 > 5% 且绝对值 > 2000 tokens
    if (dropPercent < DROP_PERCENT_THRESHOLD || dropTokens < DROP_TOKENS_THRESHOLD) {
      this.previousCacheReadTokens = params.cacheReadTokens;
      this.recordPromptState(params);
      return null;
    }

    // ── 检测到 cache break，归因 ──
    const prev = this.previousState;
    const curr = this.snapshot(params);
    const changes: string[] = [];

    if (curr.model !== prev.model) {
      changes.push(`模型变化: ${prev.model} → ${curr.model}`);
    }
    if (curr.systemPromptHash !== prev.systemPromptHash) {
      changes.push("System prompt 变化");
    }
    if (curr.toolSchemasHash !== prev.toolSchemasHash) {
      const prevTools = new Set(prev.perToolHashes.keys());
      const currTools = new Set(curr.perToolHashes.keys());
      const added = [...currTools].filter((t) => !prevTools.has(t));
      const removed = [...prevTools].filter((t) => !currTools.has(t));
      const changed = [...currTools].filter(
        (t) => prevTools.has(t) && curr.perToolHashes.get(t) !== prev.perToolHashes.get(t),
      );
      const parts: string[] = [];
      if (added.length) parts.push(`新增: ${added.join(", ")}`);
      if (removed.length) parts.push(`移除: ${removed.join(", ")}`);
      if (changed.length) parts.push(`修改: ${changed.join(", ")}`);
      changes.push(`工具变化 (${parts.join("; ")})`);
    }

    const gapMs = curr.timestamp - prev.timestamp;
    if (gapMs > TTL_WARN_MS) {
      changes.push(`TTL 可能已过期 (间隔 ${Math.round(gapMs / 60000)} 分钟)`);
    }

    if (changes.length === 0) {
      changes.push("未知原因（命中下降但状态无变化，可能服务端缓存波动）");
    }

    const report: CacheBreakReport = {
      dropTokens,
      dropPercent: Math.round(dropPercent * 100),
      changes,
      previousCacheReadTokens: prevTokens,
      currentCacheReadTokens: params.cacheReadTokens,
    };

    // 更新状态
    this.previousCacheReadTokens = params.cacheReadTokens;
    this.previousState = curr;

    return report;
  }
}

// ─── 默认单例 + 模块级便捷 API（生产使用） ───

const defaultDetector = new CacheBreakDetector();

export function recordPromptState(params: CacheCheckParams): void {
  defaultDetector.recordPromptState(params);
}

export function checkResponseForCacheBreak(params: CacheCheckParams): CacheBreakReport | null {
  return defaultDetector.checkResponse(params);
}

export function resetCacheDetection(): void {
  defaultDetector.reset();
}

/** 将报告格式化为单行日志 */
export function formatCacheBreakReport(report: CacheBreakReport): string {
  return `缓存命中下降 ${report.dropPercent}% (${report.dropTokens} tokens): ${report.changes.join("; ")}`;
}
