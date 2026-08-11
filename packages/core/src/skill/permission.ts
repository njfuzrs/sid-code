/**
 * Skill 权限控制（Task 5）
 *
 * 对齐 Claude Code 的 Skill 安全模型：
 *   安全属性白名单 + deny/allow/ask 三级规则 + MCP 来源隔离
 *
 * 设计要点（"安全默认"）：未来新增的 Skill 属性默认需要权限审批，
 * 除非被显式添加到 SAFE_SKILL_PROPERTIES 白名单中。
 */

import type { SkillDefinition } from "./types.ts";

/** Skill 权限决策 */
export type SkillPermissionDecision = "allow" | "deny" | "ask";

/**
 * 安全属性白名单：只有这些属性的 Skill 可以自动放行。
 * 带有白名单之外属性（hooks / allowedTools 等敏感能力）的 Skill 默认需审批。
 */
export const SAFE_SKILL_PROPERTIES = new Set<keyof SkillDefinition>([
  "name",
  "description",
  "source",
  "loadedFrom",
  "whenToUse",
  "argumentHint",
  "model",
  "context",
  "mode",
  "paths",
  "userInvocable",
  "disableModelInvocation",
  "skillRoot",
  "filePath",
  "prompt",
  "disabled",
  "isBuiltin",
  "version",
  "argumentNames",
]);

/** 敏感属性：出现即视为"非纯安全"，需审批 */
const SENSITIVE_PROPERTIES: Array<keyof SkillDefinition> = [
  "hooks",
  "allowedTools",
  "shell",
  "agent",
  "maxTurns",
  "timeoutMins",
  "effort",
];

/**
 * 检查 Skill 是否只含安全属性
 * 任意敏感属性有有效值 → false（需审批）
 */
export function skillHasOnlySafeProperties(skill: SkillDefinition): boolean {
  for (const key of SENSITIVE_PROPERTIES) {
    const value = skill[key];
    if (value === undefined || value === null) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    return false;
  }
  return true;
}

/** Skill 权限规则集 */
export interface SkillPermissionRules {
  /** 拒绝列表（最高优先级，支持精确名或 "*" 通配 source） */
  deny?: string[];
  /** 允许列表 */
  allow?: string[];
}

/**
 * Skill 权限检查
 *
 * 优先级：
 *   1. deny 规则命中 → deny
 *   2. allow 规则命中 → allow
 *   3. MCP 来源 + 含敏感属性 → ask（远程来源更保守）
 *   4. 仅安全属性 → allow
 *   5. 默认 → ask
 */
export function checkSkillPermission(
  skill: SkillDefinition,
  rules: SkillPermissionRules = {},
): SkillPermissionDecision {
  const name = skill.name;

  if (matchesRule(name, rules.deny)) return "deny";
  if (matchesRule(name, rules.allow)) return "allow";

  const safe = skillHasOnlySafeProperties(skill);

  // MCP 来源带敏感属性时一律 ask（不享受白名单自动放行）
  if (skill.loadedFrom === "mcp" && !safe) {
    return "ask";
  }

  if (safe) return "allow";

  return "ask";
}

/** 规则匹配：精确名 / "skill:name" 形式 / "*" 全通配 */
function matchesRule(name: string, rules?: string[]): boolean {
  if (!rules || rules.length === 0) return false;
  for (const rule of rules) {
    if (rule === "*" || rule === name) return true;
    // 支持 "skill:<name>" 前缀写法
    if (rule === `skill:${name}`) return true;
  }
  return false;
}
