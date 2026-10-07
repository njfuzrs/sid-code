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
 * SkillDefinition 每个字段的安全分级（单一事实源）。
 *
 * P2-2：用 `Record<keyof SkillDefinition, ...>` 而不是两张手写列表——SkillDefinition 新增字段
 * 却没在这里分类时，类型检查直接报缺键；另有 tests/skill/p2-skill-defects.test.ts 从 types.ts
 * 源码抽字段名比对这张表（CI 不跑 tsc，不能只靠类型）。此前「白名单 19 + 敏感 7 = 26」是巧合，
 * 没有任何机制保证新字段被分类。
 */
const SKILL_PROPERTY_CLASS: Record<keyof SkillDefinition, "safe" | "sensitive"> = {
  name: "safe",
  description: "safe",
  source: "safe",
  loadedFrom: "safe",
  whenToUse: "safe",
  argumentHint: "safe",
  model: "safe",
  context: "safe",
  mode: "safe",
  paths: "safe",
  userInvocable: "safe",
  disableModelInvocation: "safe",
  skillRoot: "safe",
  filePath: "safe",
  prompt: "safe",
  disabled: "safe",
  isBuiltin: "safe",
  version: "safe",
  argumentNames: "safe",
  hooks: "sensitive",
  allowedTools: "sensitive",
  shell: "sensitive",
  agent: "sensitive",
  maxTurns: "sensitive",
  timeoutMins: "sensitive",
  effort: "sensitive",
};

/** 字段分级表（只读视图，供门禁测试比对 types.ts） */
export const SKILL_PROPERTY_CLASSIFICATION: Readonly<Record<string, "safe" | "sensitive">> =
  SKILL_PROPERTY_CLASS;

/**
 * 安全属性白名单：只有这些属性的 Skill 可以自动放行。
 * 带有白名单之外属性（hooks / allowedTools 等敏感能力，或任何未分类的属性）的 Skill 默认需审批。
 */
export const SAFE_SKILL_PROPERTIES: ReadonlySet<string> = new Set(
  Object.keys(SKILL_PROPERTY_CLASS).filter(
    (k) => SKILL_PROPERTY_CLASS[k as keyof SkillDefinition] === "safe",
  ),
);

/** 值是否「没有提供能力」：缺省 / null / 空数组 视同未声明 */
function isEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (Array.isArray(value) && value.length === 0) return true;
  return false;
}

/**
 * 检查 Skill 是否只含安全属性
 *
 * P2-2：遍历 skill **自身的全部属性**、按白名单判定，而不是只遍历敏感表——
 * 后者对任何未登记的新属性默认放行，与文件头承诺的「未来新增属性默认需审批」方向相反。
 * 现在任一非白名单属性有有效值 → false（需审批）。
 */
export function skillHasOnlySafeProperties(skill: SkillDefinition): boolean {
  for (const [key, value] of Object.entries(skill)) {
    if (SAFE_SKILL_PROPERTIES.has(key)) continue;
    if (isEmptyValue(value)) continue;
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
  /**
   * 确认列表：命中即 ask。必须早于 allow 判定——否则 `allow: ["Skill"]` 通配
   * 会盖掉精确的 `ask: ["Skill(deploy)"]`，用户配的确认闸静默失效（P0-1）。
   */
  ask?: string[];
}

/**
 * Skill 权限检查
 *
 * 优先级：
 *   1. deny 规则命中 → deny
 *   2. ask 规则命中 → ask（早于 allow，见 SkillPermissionRules.ask）
 *   3. allow 规则命中 → allow
 *   4. MCP 来源 + 含敏感属性 → ask（远程来源更保守）
 *   5. 仅安全属性 → allow
 *   6. 默认 → ask
 */
export function checkSkillPermission(
  skill: SkillDefinition,
  rules: SkillPermissionRules = {},
): SkillPermissionDecision {
  const name = skill.name;

  if (matchesRule(name, rules.deny)) return "deny";
  if (matchesRule(name, rules.ask)) return "ask";
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
