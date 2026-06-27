/**
 * 压缩策略自适应（§4.2）
 *
 * 把每次压缩的关键特征（压缩前后 token、节省比例、是否走了 LLM 摘要、覆盖率）记录到
 * ~/.sid-code/compact-stats.json，并据历史动态推荐"摘要输入保留范围"等参数：
 *   - 若历史摘要覆盖率长期偏低 → 建议增大保留范围（少压一点，多留原文）
 *   - 若历史压缩节省比例长期很低（压了等于没压）→ 建议更激进保留近期、更早触发
 *
 * 自适应只调"软参数"（保留条数、目标比例），不改阈值硬开关——避免反馈环失稳。
 * 全部 best-effort：读写失败回退到静态默认值。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { getLogger } from "../../debug/index.ts";

/** 单次压缩特征 */
export interface CompactFeature {
  tokensBefore: number;
  tokensAfter: number;
  savedRatio: number;
  usedLLM: boolean;
  coverage: number;
}

/** 持久化的统计文件结构 */
interface CompactStats {
  /** 最近 N 次压缩特征（环形，最多 50 条） */
  recent: CompactFeature[];
}

/** 自适应推荐的软参数 */
export interface AdaptiveParams {
  /** 摘要输入时保留最近多少条不进摘要（对应 autoCompact 的 PRESERVE_RECENT） */
  preserveRecent: number;
  /** 渐进压缩目标使用率 */
  targetUsageRatio: number;
}

const DEFAULT_PARAMS: AdaptiveParams = { preserveRecent: 4, targetUsageRatio: 0.7 };
const MAX_RECENT = 50;
const LOW_COVERAGE = 0.5;
const LOW_SAVED = 0.15;

function statsPath(): string {
  const dir = join(homedir(), ".sid-code");
  return join(dir, "compact-stats.json");
}

function loadStats(): CompactStats {
  try {
    const raw = readFileSync(statsPath(), "utf-8");
    const parsed = JSON.parse(raw) as CompactStats;
    if (Array.isArray(parsed.recent)) return parsed;
  } catch {
    // 文件不存在 / 解析失败：返回空
  }
  return { recent: [] };
}

function saveStats(stats: CompactStats): void {
  try {
    const dir = join(homedir(), ".sid-code");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(statsPath(), JSON.stringify(stats), "utf-8");
  } catch (err: any) {
    getLogger().debug("COMPACT_ADAPTIVE", `统计写入失败: ${err.message}`);
  }
}

/** 记录一次压缩特征（环形截断到 MAX_RECENT）。best-effort。 */
export function recordCompactFeature(feature: CompactFeature): void {
  const stats = loadStats();
  stats.recent.push(feature);
  if (stats.recent.length > MAX_RECENT) {
    stats.recent = stats.recent.slice(-MAX_RECENT);
  }
  saveStats(stats);
}

/**
 * 基于历史推荐软参数。样本不足（<5）时返回静态默认。
 *
 * 规则：
 *   - 平均覆盖率 < 0.5 → preserveRecent 增大到 8（少压、多留原文）
 *   - 平均节省比例 < 0.15 → targetUsageRatio 降到 0.6（更早、更激进触发，避免压了等于没压）
 */
export function recommendParams(): AdaptiveParams {
  const stats = loadStats();
  if (stats.recent.length < 5) return { ...DEFAULT_PARAMS };

  const n = stats.recent.length;
  const avgCoverage = stats.recent.reduce((s, f) => s + (f.coverage ?? 1), 0) / n;
  const avgSaved = stats.recent.reduce((s, f) => s + (f.savedRatio ?? 0), 0) / n;

  const params = { ...DEFAULT_PARAMS };
  if (avgCoverage < LOW_COVERAGE) {
    params.preserveRecent = 8;
  }
  if (avgSaved < LOW_SAVED) {
    params.targetUsageRatio = 0.6;
  }
  return params;
}
