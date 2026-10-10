/**
 * 命令补全建议引擎
 *
 * Fuse.js 模糊搜索 + 五级优先级排序 + 使用频率追踪。
 * 支持漏字母模糊匹配（/cmpct → compact）、描述搜索（/搜索 → grep）、常用命令优先。
 *
 * 只有 rankCommandInfos 一条真路径（useSlashCompletion 调用）。
 * 旧的 getCommandSuggestions / getCategorizedCommands / clearSuggestionsCache
 * 零生产调用且与 UI 数据结构分叉（TUIState.commands 没有 source 字段），已删除。
 */

import Fuse from "fuse.js";
import { getUsageScore } from "./usage-tracking.ts";

// ============================================================
// 轻量命令信息排序（UI 补全 hook 用）
//
// useSlashCompletion 持有的是 { name, aliases, description } 的轻量结构
// （来自 TUIState.commands），不是完整 UnifiedCommand。这里提供一个基于同样
// Fuse 配置 + 五级优先级 + 使用频率的排序函数，复用核心逻辑而不强制 UI 流转
// 完整 UnifiedCommand。
// ============================================================

export interface RankableCommandInfo {
  name: string;
  aliases: string[];
  description: string;
  /** 无参数就无法工作（如 /btw）——补全列表回车仅回填等待输入，不直接执行 */
  requiresArgs?: boolean;
  /** 参数提示（如 "你的问题"），补全列表在 label 后以 dim 色显示 */
  argumentHint?: string;
}

export interface RankedCommandSuggestion {
  label: string;
  value: string;
  description: string;
  /** 命中的别名（若通过别名匹配），用于在描述中提示 */
  matchedAlias?: string;
  /** 无参数就无法工作——透传给 UI 决定回车是执行还是回填 */
  requiresArgs?: boolean;
  /** 参数提示——「回填等你输入」的另一半：告诉用户该填什么 */
  argumentHint?: string;
}

// 按引用缓存轻量索引
let infoIndexCache: {
  commands: RankableCommandInfo[];
  fuse: Fuse<RankableCommandInfo & { nameParts: string[] }>;
  items: Array<RankableCommandInfo & { nameParts: string[] }>;
} | null = null;

function getInfoIndex(commands: RankableCommandInfo[]) {
  if (infoIndexCache?.commands === commands) {
    return { fuse: infoIndexCache.fuse, items: infoIndexCache.items };
  }
  const items = commands.map((c) => ({
    ...c,
    nameParts: c.name.split(/[-_]/),
  }));
  const fuse = new Fuse(items, {
    includeScore: true,
    threshold: 0.5,
    location: 0,
    distance: 100,
    ignoreLocation: true,
    keys: [
      { name: "name", weight: 3 },
      { name: "nameParts", weight: 2 },
      { name: "aliases", weight: 2 },
      { name: "description", weight: 0.5 },
    ],
  });
  infoIndexCache = { commands, fuse, items };
  return { fuse, items };
}

function infoPriority(item: RankableCommandInfo, query: string): number {
  if (item.name === query) return 1;
  if (item.aliases.includes(query)) return 2;
  if (item.name.startsWith(query)) return 3;
  if (item.aliases.some((a) => a.startsWith(query))) return 4;
  return 5;
}

/**
 * 对轻量命令信息按查询词排序，返回补全建议
 * @param commands 命令信息列表
 * @param query    去掉 "/" 的查询词（可为空）
 * @param limit    最多返回条数
 */
export function rankCommandInfos(
  commands: RankableCommandInfo[],
  query: string,
  limit = 20,
): RankedCommandSuggestion[] {
  const q = query.toLowerCase();
  const { fuse, items } = getInfoIndex(commands);

  const toSug = (item: RankableCommandInfo): RankedCommandSuggestion => {
    const matchedAlias =
      q !== "" && !item.name.startsWith(q)
        ? // 精确别名优先，其次前缀别名
          (item.aliases.find((a) => a.toLowerCase() === q) ??
          item.aliases.find((a) => a.toLowerCase().startsWith(q)))
        : undefined;
    return {
      label: `/${item.name}`,
      value: `/${item.name} `,
      description: matchedAlias ? `(${matchedAlias}) ${item.description}` : item.description,
      matchedAlias,
      requiresArgs: item.requiresArgs,
      argumentHint: item.argumentHint,
    };
  };

  if (q === "") {
    return [...items]
      .sort((a, b) => {
        const usageDiff = getUsageScore(b.name) - getUsageScore(a.name);
        if (Math.abs(usageDiff) > 0.001) return usageDiff;
        return a.name.localeCompare(b.name);
      })
      .slice(0, limit)
      .map(toSug);
  }

  const results = fuse.search(q);
  return results
    .map((r) => ({
      item: r.item,
      score: r.score ?? 1,
      priority: infoPriority(r.item, q),
    }))
    .sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      if (a.priority <= 4) {
        const lenDiff = a.item.name.length - b.item.name.length;
        if (lenDiff !== 0) return lenDiff;
      }
      const scoreDiff = a.score - b.score;
      if (Math.abs(scoreDiff) > 0.1) return scoreDiff;
      return getUsageScore(b.item.name) - getUsageScore(a.item.name);
    })
    .slice(0, limit)
    .map((r) => toSug(r.item));
}
