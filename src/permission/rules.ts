/**
 * 权限规则匹配
 * 支持 allow/deny/ask 规则配置，带 glob 模式匹配
 * 规则格式：工具名(参数模式)，如 "Read", "Bash(npm *)", "Edit(.env*)"
 */

import { minimatch } from "minimatch";
import type { PermissionRule, PermissionRequest, Decision } from "./types.ts";

/**
 * 匹配单条规则
 * 规则格式：ToolName 或 ToolName(pattern)
 * - "Read" 匹配所有 read 操作
 * - "Read(src/**)" 只匹配 src 目录下的读取
 * - "Bash(npm *)" 匹配 npm 开头的命令
 * - "Edit(.env*)" 匹配 .env 开头的文件
 */
export function matchRule(rule: string, req: PermissionRequest): boolean {
  const match = rule.match(/^(\w+)(?:\(([^)]+)\))?$/);
  if (!match) return false;

  const [, toolName, pattern] = match;

  // 工具名不匹配（大小写不敏感）
  if (toolName.toLowerCase() !== req.toolName.toLowerCase()) return false;

  // 无参数模式，匹配所有该工具的操作
  if (!pattern) return true;

  // 提取关键参数（file_path 或 command）
  const input = req.input as any;
  const value = input?.file_path || input?.command || input?.pattern || "";

  if (!value) return false;

  // glob 匹配
  return minimatch(value, pattern, { dot: true });
}

/**
 * 检查权限规则
 * 优先级：deny > allow > ask
 * 返回 null 表示无匹配规则
 */
export function checkRules(rules: PermissionRule, req: PermissionRequest): Decision | null {
  // 黑名单优先
  if (rules.deny?.some(r => matchRule(r, req))) {
    return {
      allowed: false,
      reason: `规则拒绝: ${req.toolName}`,
    };
  }

  // 白名单
  if (rules.allow?.some(r => matchRule(r, req))) {
    return { allowed: true };
  }

  // ask 列表
  if (rules.ask?.some(r => matchRule(r, req))) {
    return {
      allowed: false,
      needsConfirmation: true,
      reason: `规则要求确认: ${req.toolName}`,
    };
  }

  return null; // 无匹配规则
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
