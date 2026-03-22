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
 * - "Read(src/**)" 只匹配 src 目录下的读取
 * - "Bash(npm *)" 匹配 npm 开头的命令
 * - "Edit(.env*)" 匹配 .env 开头的文件
 * - "mcp__myserver__*" 匹配 myserver 的所有 MCP 工具（通配符支持）
 * - "mcp__*" 匹配所有 MCP 工具
 */
export function matchRule(rule: string, req: PermissionRequest): boolean {
  const match = rule.match(/^([*\w]+)(?:\(([^)]+)\))?$/);
  if (!match) return false;

  const [, toolName, pattern] = match;

  // 通配符匹配（支持 mcp__* 和 mcp__server__* 格式）
  if (toolName.includes("*")) {
    const wildcardMatched = minimatch(req.toolName.toLowerCase(), toolName.toLowerCase());
    if (!wildcardMatched) return false;
    // 通配符匹配成功，如果有参数模式则继续检查参数
    if (!pattern) return true;
  } else {
    // 精确工具名匹配（大小写不敏感）
    if (toolName.toLowerCase() !== req.toolName.toLowerCase()) return false;
    // 无参数模式，匹配所有该工具的操作
    if (!pattern) return true;
  }

  // 提取关键参数（file_path 或 command）
  const input = req.input as any;
  const value = input?.file_path || input?.command || input?.pattern || "";

  if (!value) return false;

  // glob 匹配
  return minimatch(value, pattern, { dot: true });
}

/**
 * 计算规则匹配分数
 * 分数越高优先级越高：
 * - 基础分：deny=1000, ask=500, allow=0
 * - 有参数（更具体）：+100
 * 返回 null 表示不匹配
 */
function scoreMatch(rule: string, req: PermissionRequest, type: "allow" | "deny" | "ask"): number | null {
  if (!matchRule(rule, req)) return null;

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
 */
export function checkRules(rules: PermissionRule, req: PermissionRequest): Decision | null {
  const matches: RuleMatch[] = [];

  for (const r of rules.deny || []) {
    const score = scoreMatch(r, req, "deny");
    if (score !== null) matches.push({ rule: r, type: "deny", score });
  }
  for (const r of rules.allow || []) {
    const score = scoreMatch(r, req, "allow");
    if (score !== null) matches.push({ rule: r, type: "allow", score });
  }
  for (const r of rules.ask || []) {
    const score = scoreMatch(r, req, "ask");
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
