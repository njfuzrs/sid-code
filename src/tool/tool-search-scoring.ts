/**
 * ToolSearch 加权关键词搜索 —— 纯函数评分内核
 *
 * 对标 claude-code `tools/ToolSearchTool/ToolSearchTool.ts` 的
 * parseToolName / compileTermPatterns / searchToolsWithKeywords。
 *
 * 与 registry 解耦：只吃 `{ name, description, searchHint }` 三元组，
 * 不依赖 LegacyTool 实例，便于单测与复用。registry.searchDeferredTools 把工具
 * 实例摊平成这个轻量结构后调用本模块，再按返回的 name 顺序还原工具实例。
 *
 * 设计要点（与 claude 一致）：
 * - 工具名按 CamelCase / mcp__ 三段拆词，使 "create issue" 能命中 mcp__github__create_issue。
 * - MCP 工具命中给更高权重（server 名是模型最强的检索信号）。
 * - searchHint（人工策划的能力短语）权重高于 description。
 * - 用词边界正则匹配 description/searchHint，避免 "read" 误命中 "already"。
 * - 支持 "+term" 必需词：带 + 前缀的词必须全部命中才进候选。
 */

/** 工具名解析结果 */
export interface ParsedToolName {
  /** 分词数组（小写，已去空） */
  parts: string[];
  /** 空格连接的全名（小写），用于子串兜底 */
  full: string;
  /** 是否 MCP 工具（mcp__ 前缀） */
  isMcp: boolean;
}

/** 参与评分的工具轻量视图 */
export interface SearchableTool {
  name: string;
  description: string;
  searchHint?: string;
}

/** 搜索结果条目 */
export interface ScoredTool {
  name: string;
  score: number;
}

/**
 * 解析工具名为可检索的分词。
 *
 * - MCP 工具 `mcp__server__action`：剥掉 mcp__ 前缀，按 `__` 与 `_` 双层拆词，
 *   full 名把分隔符替换为空格（"github create issue"）。
 * - 普通工具：CamelCase 插空格 + 下划线转空格 + 小写拆词
 *   （"ToolSearch" → ["tool","search"]，"tool_search" → ["tool","search"]）。
 */
export function parseToolName(name: string): ParsedToolName {
  if (name.startsWith("mcp__")) {
    const withoutPrefix = name.replace(/^mcp__/, "").toLowerCase();
    const parts = withoutPrefix.split("__").flatMap((p) => p.split("_"));
    return {
      parts: parts.filter(Boolean),
      full: withoutPrefix.replace(/__/g, " ").replace(/_/g, " "),
      isMcp: true,
    };
  }

  const parts = name
    .replace(/([a-z])([A-Z])/g, "$1 $2") // CamelCase → 空格
    .replace(/_/g, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

  return {
    parts,
    full: parts.join(" "),
    isMcp: false,
  };
}

/** 转义正则元字符（用户搜索词可能含特殊字符） */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 预编译词边界正则（去重）。
 *
 * 每次搜索只编译一次，避免在 工具数×词数×2 次匹配中重复 new RegExp。
 * 词边界 `\b...\b` 确保 "read" 不会命中 "already" / "thread"。
 */
export function compileTermPatterns(terms: string[]): Map<string, RegExp> {
  const patterns = new Map<string, RegExp>();
  for (const term of terms) {
    if (!patterns.has(term)) {
      patterns.set(term, new RegExp(`\\b${escapeRegExp(term)}\\b`));
    }
  }
  return patterns;
}

/**
 * 加权关键词搜索（对标 claude-code searchToolsWithKeywords）。
 *
 * @param query        用户搜索词（已去 select: 前缀的纯关键词或裸工具名）
 * @param deferredTools 延迟工具池（仅在这些里搜索/评分）
 * @param allTools      全量工具池（精确名快路径回退用——选已加载工具是无害 no-op）
 * @param maxResults    最大返回数
 * @returns 按分数降序的 { name, score }，已截断到 maxResults
 *
 * 快路径：
 *   A. query 恰好等于某工具名（delegate/compact 后模型常裸写工具名）→ 直接返回该工具。
 *   B. query 以 `mcp__xxx` 开头 → startsWith 前缀匹配延迟池，命中即返回。
 * 评分权重：
 *   名分词整词命中 +10(MCP +12) / 名分词子串命中 +5(MCP +6) /
 *   full 子串兜底（仅当本轮 score 仍为 0）+3 / searchHint 整词 +4 / description 整词 +2。
 */
export function searchToolsWithScoring(
  query: string,
  deferredTools: SearchableTool[],
  allTools: SearchableTool[],
  maxResults: number,
): ScoredTool[] {
  const queryLower = query.toLowerCase().trim();
  if (!queryLower) return [];

  // 快路径 A：精确名匹配（先查延迟池，再回退全量池）。
  // 命中全量池里已加载的工具时也返回——"选中已加载工具"是无害 no-op，
  // 让模型继续推进而非陷入重试 churn（对标 claude exactMatch 快路径）。
  const exact =
    deferredTools.find((t) => t.name.toLowerCase() === queryLower) ??
    allTools.find((t) => t.name.toLowerCase() === queryLower);
  if (exact) {
    return [{ name: exact.name, score: 100 }];
  }

  // 快路径 B：mcp__server 前缀搜索（模型按 server 名带 mcp__ 前缀检索时）。
  if (queryLower.startsWith("mcp__") && queryLower.length > 5) {
    const prefixMatches = deferredTools
      .filter((t) => t.name.toLowerCase().startsWith(queryLower))
      .slice(0, maxResults)
      .map((t) => ({ name: t.name, score: 50 }));
    if (prefixMatches.length > 0) {
      return prefixMatches;
    }
  }

  const queryTerms = queryLower.split(/\s+/).filter((term) => term.length > 0);

  // 拆分必需词（+前缀）与可选词
  const requiredTerms: string[] = [];
  const optionalTerms: string[] = [];
  for (const term of queryTerms) {
    if (term.startsWith("+") && term.length > 1) {
      requiredTerms.push(term.slice(1));
    } else {
      optionalTerms.push(term);
    }
  }

  const allScoringTerms =
    requiredTerms.length > 0 ? [...requiredTerms, ...optionalTerms] : queryTerms;
  if (allScoringTerms.length === 0) return [];
  const termPatterns = compileTermPatterns(allScoringTerms);

  // 预过滤：含必需词时，只保留"在 名/描述/hint 命中所有必需词"的候选
  let candidateTools = deferredTools;
  if (requiredTerms.length > 0) {
    candidateTools = deferredTools.filter((tool) => {
      const parsed = parseToolName(tool.name);
      const descNormalized = tool.description.toLowerCase();
      const hintNormalized = tool.searchHint?.toLowerCase() ?? "";
      return requiredTerms.every((term) => {
        const pattern = termPatterns.get(term)!;
        return (
          parsed.parts.includes(term) ||
          parsed.parts.some((part) => part.includes(term)) ||
          pattern.test(descNormalized) ||
          (hintNormalized !== "" && pattern.test(hintNormalized))
        );
      });
    });
  }

  const scored: ScoredTool[] = candidateTools.map((tool) => {
    const parsed = parseToolName(tool.name);
    const descNormalized = tool.description.toLowerCase();
    const hintNormalized = tool.searchHint?.toLowerCase() ?? "";

    let score = 0;
    for (const term of allScoringTerms) {
      const pattern = termPatterns.get(term)!;

      // 工具名分词命中（高权重；MCP server/动作名是最强信号）
      if (parsed.parts.includes(term)) {
        score += parsed.isMcp ? 12 : 10;
      } else if (parsed.parts.some((part) => part.includes(term))) {
        score += parsed.isMcp ? 6 : 5;
      }

      // full 名子串兜底（仅当本轮其它命中都为 0，处理边角 case）
      if (parsed.full.includes(term) && score === 0) {
        score += 3;
      }

      // searchHint 命中（人工策划能力短语，信号强于 description）
      if (hintNormalized !== "" && pattern.test(hintNormalized)) {
        score += 4;
      }

      // description 命中（词边界，避免子串误命中）
      if (pattern.test(descNormalized)) {
        score += 2;
      }
    }

    return { name: tool.name, score };
  });

  return scored
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);
}
