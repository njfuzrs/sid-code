/**
 * 权限规则匹配
 * 支持 allow/deny/ask 规则配置，带 glob 模式匹配
 * 规则格式：工具名(参数模式)，如 "Read", "Bash(npm *)", "Edit(.env*)"
 *
 * 优先级计算：具体规则优先于通用规则（对标 Claude Code）
 * - 带参数的规则（如 Bash(npm *)）比通用规则（如 Bash）优先级更高
 * - 同等具体度下，deny > ask > allow
 */

import { minimatch } from "minimatch";
import type { PermissionRule, PermissionRequest, Decision } from "./types.ts";
import { matchShellRulePattern } from "./shell-rule-matching.ts";
import { matchPathRule, type PathRuleContext } from "./path-rule-matching.ts";

/** 文件路径类工具（走 matchPathRule 做前缀解析） */
const FILE_PATH_TOOLS = new Set(["read", "write", "edit"]);

/**
 * 规则名归一：把 CC 风格的规则名映射到 sid 内部工具名。
 * - Agent ↔ sub_agent
 * - WebFetch ↔ web_fetch
 * - WebSearch ↔ web_search
 * 大小写不敏感。
 */
const RULE_NAME_ALIASES: Record<string, string> = {
  agent: "sub_agent",
  webfetch: "web_fetch",
  websearch: "web_search",
};

/** 把规则里的工具名归一到内部工具名（小写） */
function normalizeRuleToolName(toolName: string): string {
  const lower = toolName.toLowerCase();
  return RULE_NAME_ALIASES[lower] ?? lower;
}

/**
 * 从请求提取用于匹配的参数值。
 * - bash：command
 * - 文件类：file_path
 * - sub_agent：subagent_type / type（供 Agent(type) 规则匹配）
 * - web_fetch：domain:hostname（供 WebFetch(domain:x) 规则匹配）
 * - web_search：query（供 WebSearch(pattern) 规则匹配）
 * - 其它：pattern
 */
function extractMatchValue(req: PermissionRequest): string {
  const input = req.input as any;
  const tool = req.toolName.toLowerCase();

  if (tool === "sub_agent") {
    return input?.subagent_type || input?.type || "";
  }
  if (tool === "web_fetch") {
    const url: string = input?.url || "";
    if (!url) return "";
    try {
      return `domain:${new URL(url).hostname}`;
    } catch {
      return "";
    }
  }
  // web_search 无 URL 可归一，按查询词匹配（`WebSearch` 裸规则不走到这里，仍匹配全部搜索）
  if (tool === "web_search") {
    return input?.query || "";
  }
  return input?.file_path || input?.command || input?.pattern || "";
}

/** 规则匹配结果（带分数） */
interface RuleMatch {
  rule: string;
  type: "allow" | "deny" | "ask";
  score: number;
}

/**
 * 匹配单条规则
 * 规则格式：ToolName 或 ToolName(pattern)
 * - "Read" 匹配所有 read 操作
 * - "Read(src/**)" 只匹配 src 目录下的读取（路径前缀解析见 path-rule-matching）
 * - "Bash(npm *)" 匹配 npm 开头的命令（走自研 matchWildcardPattern，`*` 跨 `/`）
 * - "Bash(prefix:git )" 前缀匹配（git 开头的命令）
 * - "Bash(*)" 匹配所有 bash 命令（含含路径命令）
 * - "Edit(.env*)" 匹配 .env 开头的文件
 * - "Agent" 匹配所有子代理；"Agent(explore)" 匹配 explore 类型子代理
 * - "WebFetch(domain:github.com)" 匹配 github.com 的抓取
 * - "mcp__myserver__*" 匹配 myserver 的所有 MCP 工具（通配符支持）
 * - "mcp__myserver" 匹配 myserver 的所有 MCP 工具（服务器级匹配）
 * - "mcp__*" 匹配所有 MCP 工具
 *
 * @param pathCtx 文件路径类工具（read/write/edit）的前缀解析上下文；不传则退化为 cwd/home 默认
 */
export function matchRule(
  rule: string,
  req: PermissionRequest,
  pathCtx?: PathRuleContext,
): boolean {
  const match = rule.match(/^([*\w]+)(?:\(([^)]+)\))?$/);
  if (!match) return false;

  const [, rawToolName, pattern] = match;

  // 规则名归一：Agent→sub_agent、WebFetch→web_fetch，其它转小写
  const toolName = normalizeRuleToolName(rawToolName);
  const reqToolLower = req.toolName.toLowerCase();

  // 通配符匹配（支持 mcp__* 和 mcp__server__* 格式）
  if (toolName.includes("*")) {
    const wildcardMatched = minimatch(reqToolLower, toolName);
    if (!wildcardMatched) return false;
    // 通配符匹配成功，如果有参数模式则继续检查参数
    if (!pattern) return true;
  } else {
    // MCP 服务器级匹配：规则 "mcp__server1" 匹配 "mcp__server1__tool1"
    if (reqToolLower !== toolName) {
      // 检查是否为 MCP 服务器级匹配
      if (toolName.startsWith("mcp__") && reqToolLower.startsWith(toolName + "__")) {
        // 服务器级匹配成功
        if (!pattern) return true;
      } else {
        return false;
      }
    } else {
      // 精确匹配成功
      if (!pattern) return true;
    }
  }

  // 提取用于匹配的参数值（按工具类型分流）
  const value = extractMatchValue(req);
  if (!value) return false;

  // 按工具类型选择匹配器：
  // - bash：自研 shell 通配符匹配（`*` 跨 `/`，尾部 ` *` 特判，dotAll）
  // - 文件类（read/write/edit）：路径前缀解析 + gitignore 风格匹配
  // - 其它（sub_agent 的 type、web_fetch 的 domain:、MCP、pattern）：shell 风格通配符
  if (reqToolLower === "bash") {
    return matchShellRulePattern(pattern, value);
  }
  if (FILE_PATH_TOOLS.has(reqToolLower)) {
    // prefix: 兼容语法对文件路径仍走前缀匹配
    if (pattern.startsWith("prefix:")) {
      return value.startsWith(pattern.slice(7));
    }
    const ctx: PathRuleContext = pathCtx ?? { workspaceRoot: process.cwd() };
    return matchPathRule(pattern, value, ctx);
  }

  // prefix: 前缀匹配（兼容既有语法）
  if (pattern.startsWith("prefix:")) {
    return value.startsWith(pattern.slice(7));
  }

  // sub_agent 的 type、web_fetch 的 domain:、其它通配符：走 shell 风格通配符匹配
  // （matchWildcardPattern 对无通配符退化为精确匹配，语义正确；支持 Agent(verify*)、domain:*.example.com）
  return matchShellRulePattern(pattern, value);
}

/**
 * 计算规则匹配分数
 * 分数越高优先级越高：
 * - 基础分：deny=1000, ask=500, allow=0
 * - 有参数（更具体）：+100
 * 返回 null 表示不匹配
 *
 * P3-1（与 CC 纯 first-match 的差异说明，经审计确认无害，刻意保留）：
 * CC 是纯 first-match（按规则出现顺序取第一条命中）。sid 用打分选最高分。二者在生产路径等价，原因：
 * - checker 把 checkRules **分三次单层调用**（deny-only / ask-only / allow-only），
 *   层级序 deny→ask→allow 已由 hasPermissionsInner 的步骤顺序强制保证；
 * - 故 deny=1000/ask=500/allow=0 的基础分差在单层调用里根本不参与比较（同一次调用只有一种 behavior）；
 * - +100 具体度加成只在**同类规则内**做 tiebreak（如同为 deny 时，带参规则优先于裸工具名），
 *   这比 CC 的「谁先写谁赢」更符合直觉，且不改变 deny>ask>allow 的层级裁决。
 * 结论：打分模型在此架构下与 first-match 结果一致，改纯 first-match 无收益且有回归风险，保留。
 */
function scoreMatch(
  rule: string,
  req: PermissionRequest,
  type: "allow" | "deny" | "ask",
  pathCtx?: PathRuleContext,
): number | null {
  if (!matchRule(rule, req, pathCtx)) return null;

  let score = 0;
  // 类型基础分
  if (type === "deny") score += 1000;
  else if (type === "ask") score += 500;

  // 有参数 = 更具体 = 更高优先级
  if (rule.includes("(")) score += 100;

  return score;
}

/**
 * 检查权限规则
 * 收集所有匹配的规则，按分数排序选最高分（具体规则优先于通用规则）
 * 返回 null 表示无匹配规则
 *
 * @param pathCtx 文件路径类工具的前缀解析上下文（workspaceRoot/homeDir/cwd）
 */
export function checkRules(
  rules: PermissionRule,
  req: PermissionRequest,
  pathCtx?: PathRuleContext,
): Decision | null {
  const matches: RuleMatch[] = [];

  for (const r of rules.deny || []) {
    const score = scoreMatch(r, req, "deny", pathCtx);
    if (score !== null) matches.push({ rule: r, type: "deny", score });
  }
  for (const r of rules.allow || []) {
    const score = scoreMatch(r, req, "allow", pathCtx);
    if (score !== null) matches.push({ rule: r, type: "allow", score });
  }
  for (const r of rules.ask || []) {
    const score = scoreMatch(r, req, "ask", pathCtx);
    if (score !== null) matches.push({ rule: r, type: "ask", score });
  }

  if (matches.length === 0) return null;

  // 选最高分
  matches.sort((a, b) => b.score - a.score);
  const best = matches[0];

  switch (best.type) {
    case "deny":
      return {
        allowed: false,
        reason: `规则拒绝: ${req.toolName} (匹配 ${best.rule})`,
      };
    case "allow":
      return { allowed: true };
    case "ask":
      return {
        allowed: false,
        needsConfirmation: true,
        reason: `规则要求确认: ${req.toolName} (匹配 ${best.rule})`,
      };
  }
}

/**
 * 合并多层权限规则（数组合并，不覆盖）
 */
export function mergeRules(...layers: PermissionRule[]): PermissionRule {
  const merged: PermissionRule = { allow: [], deny: [], ask: [] };
  for (const layer of layers) {
    if (layer.allow) merged.allow!.push(...layer.allow);
    if (layer.deny) merged.deny!.push(...layer.deny);
    if (layer.ask) merged.ask!.push(...layer.ask);
  }
  return merged;
}
