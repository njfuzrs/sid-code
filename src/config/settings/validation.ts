/**
 * Settings 验证：Zod 错误格式化 + 权限规则预过滤
 *
 * 对齐 Spec 15 §3.6：增加修复建议（suggestion）。
 * 容错策略：单条坏权限规则不毒化整个文件（预过滤），单字段失败不影响其他字段。
 */

import type { z } from "zod";

/** 结构化验证错误 */
export interface ValidationError {
  file?: string; // 文件路径
  path: string; // 点分路径（如 "permissions.defaultMode"）
  message: string; // 人类可读的错误信息
  expected?: string; // 期望的值/类型
  invalidValue?: unknown; // 实际的无效值
  suggestion?: string; // 修复建议
}

/**
 * 格式化 Zod 错误为 ValidationError 列表。
 * 兼容 zod@3 的 ZodIssue 结构。
 */
export function formatZodErrors(
  error: z.ZodError,
  filePath: string,
): ValidationError[] {
  return error.issues.map((issue) => {
    const anyIssue = issue as any;
    return {
      file: filePath,
      path: issue.path.join("."),
      message: issue.message,
      expected: anyIssue.expected !== undefined ? String(anyIssue.expected) : undefined,
      invalidValue: anyIssue.received,
      suggestion: generateSuggestion(issue),
    };
  });
}

/** 根据错误类型生成修复建议（兼容 zod@3 的 issue.code） */
function generateSuggestion(issue: z.ZodIssue): string | undefined {
  const anyIssue = issue as any;
  if (issue.code === "invalid_enum_value") {
    const options = anyIssue.options;
    if (Array.isArray(options)) {
      return `有效值为: ${options.join(", ")}`;
    }
  }
  if (issue.code === "invalid_type") {
    return `期望类型 ${anyIssue.expected}，实际为 ${anyIssue.received}`;
  }
  if (issue.code === "too_small" && anyIssue.minimum !== undefined) {
    return `最小值为 ${anyIssue.minimum}`;
  }
  if (issue.code === "too_big" && anyIssue.maximum !== undefined) {
    return `最大值为 ${anyIssue.maximum}`;
  }
  return undefined;
}

/**
 * 预过滤无效权限规则（在 Zod 验证之前执行）。
 *
 * 避免一条坏规则（非字符串）导致整个 permissions 字段被 Zod 拒绝。
 * 直接原地修改 data.permissions，返回被剔除规则的警告列表。
 */
export function filterInvalidPermissionRules(
  data: any,
  filePath: string,
): ValidationError[] {
  const warnings: ValidationError[] = [];
  if (!data?.permissions || typeof data.permissions !== "object") return warnings;

  for (const ruleType of ["allow", "deny", "ask"] as const) {
    const rules = data.permissions[ruleType];
    if (!Array.isArray(rules)) continue;

    data.permissions[ruleType] = rules.filter((rule: unknown) => {
      if (typeof rule !== "string") {
        warnings.push({
          file: filePath,
          path: `permissions.${ruleType}`,
          message: `无效的权限规则（非字符串），已忽略`,
          invalidValue: rule,
        });
        return false;
      }
      return true;
    });
  }

  return warnings;
}
