/**
 * 规则阴影检测
 * 检测被高优先级规则覆盖的低优先级规则，帮助用户发现配置错误
 *
 * 例如：userSettings 中 allow Bash(npm *)，但 localSettings 中 deny Bash(npm *)
 * → localSettings 优先级更高，userSettings 的 allow 被"阴影"了
 */

import type { SourcedPermissionRule } from "./types.ts";
import { RULE_SOURCE_PRIORITY } from "./types.ts";

/** 阴影检测结果 */
export interface ShadowedRule {
  /** 被阴影的规则 */
  shadowed: SourcedPermissionRule;
  /** 覆盖它的规则 */
  shadowedBy: SourcedPermissionRule;
  /** 描述 */
  description: string;
  /**
   * 严重度（对标 claude-code Unreachable Rules 的两档）：
   * - "blocked": 被更高优先级的 deny 规则完全拦截，该 allow 永远不可达（更严重）
   * - "shadowed": 被更高优先级的 ask 规则遮蔽，仍会弹窗确认、无法自动放行（较温和）
   */
  severity: "blocked" | "shadowed";
}

/**
 * 检测规则列表中的阴影关系
 * 高优先级来源的规则会覆盖低优先级来源的同类规则
 */
export function detectShadowedRules(rules: SourcedPermissionRule[]): ShadowedRule[] {
  const results: ShadowedRule[] = [];

  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];
    // 检查是否被更高优先级的规则覆盖
    for (let j = 0; j < rules.length; j++) {
      if (i === j) continue;
      const other = rules[j];

      // other 必须优先级更高
      if (RULE_SOURCE_PRIORITY[other.source] <= RULE_SOURCE_PRIORITY[rule.source]) continue;

      // 行为必须冲突（allow vs deny，或 allow vs ask）
      if (rule.behavior === other.behavior) continue;

      // 检查规则是否匹配相同的工具
      if (rulesOverlap(rule.rawRule, other.rawRule)) {
        results.push({
          shadowed: rule,
          shadowedBy: other,
          description: `${rule.source} 的 ${rule.behavior}(${rule.rawRule}) 被 ${other.source} 的 ${other.behavior}(${other.rawRule}) 覆盖`,
          // deny 遮蔽 = 完全拦截(blocked)；ask 遮蔽 = 仍弹窗(shadowed)
          severity: other.behavior === "deny" ? "blocked" : "shadowed",
        });
        break; // 每条规则只报告一次阴影
      }
    }
  }

  return results;
}

/**
 * 检查两条规则是否存在重叠（匹配相同的工具/参数）
 * 简化实现：提取工具名部分，如果工具名相同则认为可能重叠
 */
function rulesOverlap(ruleA: string, ruleB: string): boolean {
  const toolA = extractToolName(ruleA);
  const toolB = extractToolName(ruleB);

  if (!toolA || !toolB) return false;

  // 工具名相同
  if (toolA.toLowerCase() === toolB.toLowerCase()) {
    // 如果其中一个没有参数模式（匹配所有），则一定重叠
    if (!hasPattern(ruleA) || !hasPattern(ruleB)) return true;
    // 都有参数模式，用互相匹配来判断
    // 构造一个虚拟请求来测试
    const patternA = extractPattern(ruleA);
    const patternB = extractPattern(ruleB);
    if (patternA && patternB) {
      // 简单判断：模式相同或其中一个是通配符
      if (patternA === patternB) return true;
      if (patternA === "*" || patternB === "*") return true;
    }
    return false;
  }

  // 通配符工具名
  if (toolA.includes("*") || toolB.includes("*")) {
    // 简单判断：如果一个是 mcp__* 另一个是 mcp__server1，则重叠
    const shorter = toolA.length < toolB.length ? toolA : toolB;
    const longer = toolA.length < toolB.length ? toolB : toolA;
    const prefix = shorter.replace(/\*.*/, "");
    if (longer.startsWith(prefix)) return true;
  }

  return false;
}

/** 提取规则中的工具名部分 */
function extractToolName(rule: string): string | null {
  const match = rule.match(/^([*\w]+)/);
  return match ? match[1] : null;
}

/** 检查规则是否有参数模式 */
function hasPattern(rule: string): boolean {
  return rule.includes("(");
}

/** 提取规则中的参数模式 */
function extractPattern(rule: string): string | null {
  const match = rule.match(/\(([^)]+)\)/);
  return match ? match[1] : null;
}

/**
 * 筛选出与指定工具相关的阴影规则（供权限确认对话框展示）。
 *
 * 只保留"被阴影规则"的工具名与当前请求工具一致的条目——用户在为工具 X 做确认决策时，
 * 只需看到与 X 相关的不可达规则提示，无关工具的阴影是噪声。
 *
 * @param rules    全部带来源的规则
 * @param toolName 当前请求的工具名（如 "Bash" / "Edit"）
 */
export function getShadowedRulesForTool(
  rules: SourcedPermissionRule[],
  toolName: string,
): ShadowedRule[] {
  if (!toolName) return [];
  const all = detectShadowedRules(rules);
  const target = toolName.toLowerCase();
  return all.filter((s) => {
    const t = extractToolName(s.shadowed.rawRule);
    return t != null && t.toLowerCase() === target;
  });
}

