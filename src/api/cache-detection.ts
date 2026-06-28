/**
 * Prompt Cache 失效检测与归因
 *
 * 职责（对标 Claude Code 的 promptCacheBreakDetection.ts）：
 * - 两阶段检测：请求前快照状态 + 响应后比较 cache_read_tokens 变化
 * - 当缓存命中骤降时，归因到具体原因：模型变化 / system prompt 变化 /
 *   工具增删改 / 工具顺序变化 / 缓存策略变化 / Beta headers 变化 /
 *   消息数量骤减（compact） / TTL 过期
 * - 假阳性抑制（G1）：compact / cache_edits 删除后下一次 cache_read 下降是预期的，
 *   通过 notifyCompaction / notifyCacheDeletion 通知检测器跳过紧接的一次检测。
 * - 子代理隔离（G10）：每个 agentId 维护独立基线，子代理的 break 不污染主循环。
 *
 * 实现为可实例化的 CacheBreakDetector（便于单测隔离），
 * 同时导出一个默认单例 + 模块级便捷函数（生产用）。
 */

import { createHash } from "node:crypto";
import { getLogger } from "../debug/logger.ts";

/**
 * 快速哈希（10.1 性能优化）。
 *
 * 优先用 Bun.hash（xxhash64，远快于 sha256），不可用时回退 node:crypto sha256。
 * 用途仅是"内容是否变化"的指纹比对，无加密需求，碰撞概率对该场景可忽略。
 */
function hashString(s: string): string {
  const bun = (globalThis as { Bun?: { hash?: (input: string) => bigint | number } }).Bun;
  if (bun?.hash) {
    try {
      return bun.hash(s).toString(16);
    } catch {
      /* 回退 sha256 */
    }
  }
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

/** 请求前的状态快照（G3：15+ 维度归因，对齐 CC） */
interface PromptState {
  systemPromptHash: string;
  toolSchemasHash: string;
  /** 逐工具 hash，精确定位变化 */
  perToolHashes: Map<string, string>;
  model: string;
  timestamp: number;

  // ── G3 新增维度 ──
  /** cache_control 策略本身的 hash（scope/TTL 变化独立于内容变化） */
  cacheControlHash: string;
  /** beta headers 的 hash（变化也会废缓存） */
  betaHeadersHash: string;
  /** 消息数量（compact 后减少时区分"正常减少"和"异常丢失"） */
  messageCount: number;
  /** 工具名称的有序列表 hash（顺序变化也会破坏缓存前缀） */
  toolOrderHash: string;
  /** agentId（子代理 vs 主循环隔离追踪） */
  agentId: string;
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

  // ── G3 新增（可选，向后兼容） ──
  /** 当前请求的 cache_control 配置（scope、TTL 等） */
  cacheControlConfig?: Record<string, unknown>;
  /** 当前请求携带的 beta headers */
  betaHeaders?: string[];
  /** 当前消息数量 */
  messageCount?: number;
  /** 当前 agentId（子代理隔离用；不传视为主循环 "main"） */
  agentId?: string;
}

/** 检测阈值 */
const DROP_PERCENT_THRESHOLD = 0.05; // 下降 > 5%
const DROP_TOKENS_THRESHOLD = 2000; // 且绝对值 > 2000 tokens
const TTL_WARN_MS = 300_000; // 5 分钟

export class CacheBreakDetector {
  private previousState: PromptState | null = null;
  private previousCacheReadTokens = 0;
  /** 时间源，可注入便于测试 */
  private now: () => number;
  /** G1 抑制标志：下次 checkResponse 跳过检测（重置基线而非告警） */
  private suppressNext: { active: boolean; reason: string } = { active: false, reason: "" };

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** 重置状态（新会话 / clear 时调用） */
  reset(): void {
    this.previousState = null;
    this.previousCacheReadTokens = 0;
    this.suppressNext = { active: false, reason: "" };
  }

  /**
   * G1：通知检测器即将执行上下文压缩，下次 cache_read 下降是预期的。
   * 必须在 compact 执行后、下次 API 调用前调用。
   */
  notifyCompaction(): void {
    this.suppressNext = { active: true, reason: "compaction" };
  }

  /**
   * G1：通知检测器已通过 cache_edits 删除了缓存内容。
   * cache_read 可能下降（服务端删除了部分 KV），不应报警。
   */
  notifyCacheDeletion(deletedCount: number): void {
    this.suppressNext = { active: true, reason: `cache_edits deleted ${deletedCount} items` };
  }

  private snapshot(params: CacheCheckParams): PromptState {
    const toolOrder = params.toolSchemas.map((t) => t.name).join(",");
    return {
      systemPromptHash: hashString(params.systemPrompt),
      toolSchemasHash: hashString(JSON.stringify(params.toolSchemas)),
      perToolHashes: new Map(
        params.toolSchemas.map((t) => [t.name, hashString(JSON.stringify(t))]),
      ),
      model: params.model,
      timestamp: this.now(),
      cacheControlHash: hashString(JSON.stringify(params.cacheControlConfig ?? {})),
      betaHeadersHash: hashString((params.betaHeaders ?? []).join(",")),
      messageCount: params.messageCount ?? 0,
      toolOrderHash: hashString(toolOrder),
      agentId: params.agentId ?? "main",
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
   * 返回 null 表示无显著失效（首次请求 / 命中正常 / 下降未达阈值 / 被抑制）。
   */
  checkResponse(params: CacheCheckParams): CacheBreakReport | null {
    // G1：抑制本次检测（compact / cache_edits 删除后的预期下降），重置基线而非告警
    if (this.suppressNext.active) {
      getLogger().debug("CACHE_DETECT", `抑制本次检测: ${this.suppressNext.reason}`);
      this.suppressNext = { active: false, reason: "" };
      this.previousCacheReadTokens = params.cacheReadTokens;
      this.recordPromptState(params);
      return null;
    }

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
    } else if (curr.toolOrderHash !== prev.toolOrderHash) {
      // 内容不变但顺序改变（G3）：工具 schema 哈希一致，但顺序破坏了缓存前缀
      changes.push("工具顺序变化（内容不变但顺序改变）");
    }
    if (curr.cacheControlHash !== prev.cacheControlHash) {
      changes.push("缓存策略变化（scope/TTL 配置变更）");
    }
    if (curr.betaHeadersHash !== prev.betaHeadersHash) {
      changes.push("Beta headers 变化");
    }
    // 消息数量骤减（compact 未走 notifyCompaction 时的兜底归因，G3）
    if (curr.messageCount > 0 && curr.messageCount < prev.messageCount - 1) {
      changes.push(`消息数量骤减 (${prev.messageCount} → ${curr.messageCount})，可能是 compact`);
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

// ─── G10：多源缓存检测器（按 agentId 隔离基线，子代理 break 不污染主循环） ───

/**
 * 按 agentId 隔离的检测器集合。每个 agentId（"main" / 子代理 id）维护独立的
 * CacheBreakDetector，基线互不干扰——子代理用独立上下文请求时的 cache_read 骤降
 * 不会被误算成主循环的 break，反之亦然。
 *
 * LRU 上限防止子代理 id 无限增长（默认 10，超出淘汰最久未用的非 main 源）。
 */
export class MultiSourceCacheDetector {
  private detectors = new Map<string, CacheBreakDetector>();
  private now: () => number;
  private maxSources: number;

  constructor(now: () => number = Date.now, maxSources = 10) {
    this.now = now;
    this.maxSources = maxSources;
  }

  private get(agentId: string): CacheBreakDetector {
    let d = this.detectors.get(agentId);
    if (!d) {
      d = new CacheBreakDetector(this.now);
      this.detectors.set(agentId, d);
      this.evictIfNeeded();
    } else {
      // LRU：访问即提到末尾
      this.detectors.delete(agentId);
      this.detectors.set(agentId, d);
    }
    return d;
  }

  /** 淘汰最久未用的非 main 源（main 永不淘汰，它是主循环基线） */
  private evictIfNeeded(): void {
    while (this.detectors.size > this.maxSources) {
      let victim: string | undefined;
      for (const key of this.detectors.keys()) {
        if (key !== "main") {
          victim = key;
          break;
        }
      }
      if (!victim) break; // 只剩 main
      this.detectors.delete(victim);
    }
  }

  recordPromptState(params: CacheCheckParams): void {
    this.get(params.agentId ?? "main").recordPromptState(params);
  }

  checkResponse(params: CacheCheckParams): CacheBreakReport | null {
    return this.get(params.agentId ?? "main").checkResponse(params);
  }

  notifyCompaction(agentId = "main"): void {
    this.get(agentId).notifyCompaction();
  }

  notifyCacheDeletion(deletedCount: number, agentId = "main"): void {
    this.get(agentId).notifyCacheDeletion(deletedCount);
  }

  reset(): void {
    this.detectors.clear();
  }

  /** 当前追踪的源数量（含 main） */
  sourceCount(): number {
    return this.detectors.size;
  }
}

// ─── 默认单例 + 模块级便捷 API（生产使用） ───

const defaultDetector = new MultiSourceCacheDetector();

export function recordPromptState(params: CacheCheckParams): void {
  defaultDetector.recordPromptState(params);
}

export function checkResponseForCacheBreak(params: CacheCheckParams): CacheBreakReport | null {
  return defaultDetector.checkResponse(params);
}

/** G1：通知检测器即将 compact，抑制紧接的一次检测（默认主循环源） */
export function notifyCompaction(agentId = "main"): void {
  defaultDetector.notifyCompaction(agentId);
}

/** G1：通知检测器 cache_edits 已删除内容，抑制紧接的一次检测 */
export function notifyCacheDeletion(deletedCount: number, agentId = "main"): void {
  defaultDetector.notifyCacheDeletion(deletedCount, agentId);
}

export function resetCacheDetection(): void {
  defaultDetector.reset();
}

/** 将报告格式化为单行日志 */
export function formatCacheBreakReport(report: CacheBreakReport): string {
  return `缓存命中下降 ${report.dropPercent}% (${report.dropTokens} tokens): ${report.changes.join("; ")}`;
}

// ─── D1/D3：最近中断记录环形缓冲 + 健康度建议（供 /cache --breaks 查询） ───

/** 单条带时间戳的中断记录 */
export interface CacheBreakRecord extends CacheBreakReport {
  /** 记录时间戳（秒，Unix epoch） */
  ts: number;
  model: string;
}

const MAX_BREAK_RECORDS = 50;
const recentBreaks: CacheBreakRecord[] = [];

/** 记录一条中断（环形缓冲，最多 MAX_BREAK_RECORDS 条） */
export function recordCacheBreak(record: CacheBreakRecord): void {
  recentBreaks.push(record);
  if (recentBreaks.length > MAX_BREAK_RECORDS) {
    recentBreaks.splice(0, recentBreaks.length - MAX_BREAK_RECORDS);
  }
  // G13：同步落盘遥测（best-effort，失败不影响内存环形缓冲）
  try {
    emitCacheBreakTelemetryFireAndForget(record);
  } catch {
    /* 遥测失败绝不影响主流程 */
  }
}

/** 获取最近 N 条中断记录（默认全部，最新在后） */
export function getRecentCacheBreaks(limit?: number): CacheBreakRecord[] {
  if (limit !== undefined && recentBreaks.length > limit) {
    return recentBreaks.slice(recentBreaks.length - limit);
  }
  return [...recentBreaks];
}

/** 清空中断记录（新会话 / clear / 测试） */
export function clearCacheBreaks(): void {
  recentBreaks.length = 0;
}

/**
 * G13：把中断记录异步落盘到遥测 JSONL（懒加载 cache-telemetry，避免循环依赖 + 启动开销）。
 * 内部 fire-and-forget，不 await。
 */
function emitCacheBreakTelemetryFireAndForget(record: CacheBreakRecord): void {
  import("../telemetry/cache-telemetry.ts")
    .then((m) => m.emitCacheBreakTelemetry(record))
    .catch(() => {
      /* 遥测模块不可用时静默忽略 */
    });
}

/**
 * D3 健康度告警：基于最近中断记录，给出可执行的修复建议。
 * 例如"system 提示词频繁变化"→ 建议把易变内容移到 messages 尾部。
 */
export function getCacheHealthAdvice(): string[] {
  const advice: string[] = [];
  if (recentBreaks.length === 0) return advice;

  const systemBreaks = recentBreaks.filter((b) =>
    b.changes.some((c) => c.includes("System prompt"))
  ).length;
  const toolBreaks = recentBreaks.filter((b) =>
    b.changes.some((c) => c.includes("工具变化") || c.includes("工具顺序"))
  ).length;
  const modelBreaks = recentBreaks.filter((b) =>
    b.changes.some((c) => c.includes("模型变化"))
  ).length;

  // 阈值：同类中断占比 ≥ 50% 且 ≥ 2 次 → 给出针对性建议
  const n = recentBreaks.length;
  if (systemBreaks >= 2 && systemBreaks / n >= 0.5) {
    advice.push(
      `检测到 system 提示词频繁变化（${systemBreaks}/${n} 次中断）——` +
        `建议将时间戳/git-status/动态提醒等易变内容移至 messages 尾部，让 system 段逐字节稳定，成为永久可命中前缀。`,
    );
  }
  if (toolBreaks >= 2 && toolBreaks / n >= 0.5) {
    advice.push(
      `检测到工具列表频繁变化（${toolBreaks}/${n} 次中断）——` +
        `建议工具注册/序列化按固定字典序，杜绝顺序抖动废掉工具 schema 缓存。`,
    );
  }
  if (modelBreaks >= 2 && modelBreaks / n >= 0.5) {
    advice.push(
      `检测到模型频繁切换（${modelBreaks}/${n} 次中断）——` +
        `建议分类/总结等廉价子查询用独立上下文，不污染主循环前缀。`,
    );
  }
  return advice;
}
