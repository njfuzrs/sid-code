/**
 * 命令补全建议引擎
 *
 * Fuse.js 模糊搜索 + 五级优先级排序 + 使用频率追踪。
 * 替代旧的简单前缀匹配，支持漏字母模糊匹配（/cmpct → compact）、
 * 描述搜索（/搜索 → grep）、常用命令优先。
 */

import Fuse from "fuse.js";
import type { FuseResult } from "fuse.js";
import type { UnifiedCommand } from "./types.ts";
import { getUsageScore } from "./usage-tracking.ts";

export interface CommandSearchItem {
  name: string;
  aliases: string[];
  nameParts: string[]; // commit-push → [commit, push]
  description: string;
  command: UnifiedCommand;
}

export interface CommandSuggestion {
  /** 显示文本，如 "/compact" */
  label: string;
  /** 插入值，如 "/compact " */
  value: string;
  /** 描述 */
  description: string;
  /** 来源命令 */
  command: UnifiedCommand;
}

// 按命令列表引用缓存搜索索引（命令列表变化时重建）
let indexCache: {
  commands: UnifiedCommand[];
  fuse: Fuse<CommandSearchItem>;
  items: CommandSearchItem[];
} | null = null;

function buildSearchItems(commands: UnifiedCommand[]): CommandSearchItem[] {
  return commands
    .filter((c) => !c.isHidden && c.userInvocable !== false)
    .map((c) => ({
      name: c.name,
      aliases: c.aliases ?? [],
      nameParts: c.name.split(/[-_]/),
      description: c.description,
      command: c,
    }));
}

function getSearchIndex(commands: UnifiedCommand[]): {
  fuse: Fuse<CommandSearchItem>;
  items: CommandSearchItem[];
} {
  if (indexCache?.commands === commands) {
    return { fuse: indexCache.fuse, items: indexCache.items };
  }

  const items = buildSearchItems(commands);
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

  indexCache = { commands, fuse, items };
  return { fuse, items };
}

/**
 * 排序优先级（从高到低，数值越小越靠前）：
 * 1. 精确名称匹配    /compact → compact
 * 2. 精确别名匹配    /q → exit (q 是别名)
 * 3. 前缀名称匹配    /com → compact, commit, config
 * 4. 前缀别名匹配    /co → copy (co 是别名)
 * 5. 模糊匹配        /cmpct → compact
 */
function getPriority(item: CommandSearchItem, query: string): number {
  if (item.name === query) return 1;
  if (item.aliases.includes(query)) return 2;
  if (item.name.startsWith(query)) return 3;
  if (item.aliases.some((a) => a.startsWith(query))) return 4;
  return 5;
}

function toSuggestion(item: CommandSearchItem): CommandSuggestion {
  return {
    label: `/${item.name}`,
    value: `/${item.name} `,
    description: item.description,
    command: item.command,
  };
}

/**
 * 根据查询词返回排序后的命令建议
 * @param commands 候选命令列表
 * @param query    去掉 "/" 的查询词（可为空）
 * @param limit    最多返回条数
 */
export function getCommandSuggestions(
  commands: UnifiedCommand[],
  query: string,
  limit = 20,
): CommandSuggestion[] {
  const q = query.toLowerCase();
  const { fuse, items } = getSearchIndex(commands);

  // 空查询：全部候选，按使用频率 + 字母序
  if (q === "") {
    return [...items]
      .sort((a, b) => {
        const usageDiff = getUsageScore(b.name) - getUsageScore(a.name);
        if (Math.abs(usageDiff) > 0.001) return usageDiff;
        return a.name.localeCompare(b.name);
      })
      .slice(0, limit)
      .map(toSuggestion);
  }

  const results: FuseResult<CommandSearchItem>[] = fuse.search(q);

  const sorted = results
    .map((r) => ({
      item: r.item,
      score: r.score ?? 1,
      priority: getPriority(r.item, q),
    }))
    .sort((a, b) => {
      // 1. 优先级
      if (a.priority !== b.priority) return a.priority - b.priority;
      // 2. 前缀/精确匹配同级时，更短的名称更"接近"
      if (a.priority <= 4) {
        const lenDiff = a.item.name.length - b.item.name.length;
        if (lenDiff !== 0) return lenDiff;
      }
      // 3. Fuse 分数
      const scoreDiff = a.score - b.score;
      if (Math.abs(scoreDiff) > 0.1) return scoreDiff;
      // 4. 使用频率
      return getUsageScore(b.item.name) - getUsageScore(a.item.name);
    })
    .slice(0, limit)
    .map((r) => toSuggestion(r.item));

  return sorted;
}

// ============================================================
// 空输入分类展示
// ============================================================

export interface CategorizedSuggestion {
  category: string;
  commands: CommandSuggestion[];
}

/**
 * 当用户只输入 "/" 时，按分类展示所有命令：
 * 最近使用 → 内置命令 → Skills → 自定义命令
 */
export function getCategorizedCommands(
  commands: UnifiedCommand[],
): CategorizedSuggestion[] {
  const visible = buildSearchItems(commands);
  const results: CategorizedSuggestion[] = [];

  // 1. 最近使用（top 5，使用分数 > 0）
  const recentlyUsed = [...visible]
    .filter((c) => getUsageScore(c.name) > 0)
    .sort((a, b) => getUsageScore(b.name) - getUsageScore(a.name))
    .slice(0, 5);
  const recentNames = new Set(recentlyUsed.map((c) => c.name));
  if (recentlyUsed.length > 0) {
    results.push({
      category: "最近使用",
      commands: recentlyUsed.map(toSuggestion),
    });
  }

  // 2. 内置命令
  const builtin = visible
    .filter((c) => c.command.source === "builtin" && !recentNames.has(c.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (builtin.length > 0) {
    results.push({ category: "内置命令", commands: builtin.map(toSuggestion) });
  }

  // 3. Skills
  const skills = visible
    .filter((c) => c.command.source === "skill" && !recentNames.has(c.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (skills.length > 0) {
    results.push({ category: "Skills", commands: skills.map(toSuggestion) });
  }

  // 4. 自定义命令
  const custom = visible
    .filter(
      (c) =>
        (c.command.source === "user" || c.command.source === "project") &&
        !recentNames.has(c.name),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
  if (custom.length > 0) {
    results.push({ category: "自定义命令", commands: custom.map(toSuggestion) });
  }

  return results;
}

/** 清除索引缓存（命令来源变化时调用） */
export function clearSuggestionsCache(): void {
  indexCache = null;
}

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
}

export interface RankedCommandSuggestion {
  label: string;
  value: string;
  description: string;
  /** 命中的别名（若通过别名匹配），用于在描述中提示 */
  matchedAlias?: string;
  /** 无参数就无法工作——透传给 UI 决定回车是执行还是回填 */
  requiresArgs?: boolean;
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
      description: matchedAlias
        ? `(${matchedAlias}) ${item.description}`
        : item.description,
      matchedAlias,
      requiresArgs: item.requiresArgs,
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
