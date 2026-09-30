/**
 * Settings 验证：Zod 错误格式化 + 权限规则预过滤
 *
 * 对齐 Spec 15 §3.6：增加修复建议（suggestion）。
 * 容错策略：单条坏权限规则不毒化整个文件（预过滤），单字段失败不影响其他字段。
 */

import type { z } from "zod/v3";

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
export function formatZodErrors(error: z.ZodError, filePath: string): ValidationError[] {
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
export function filterInvalidPermissionRules(data: any, filePath: string): ValidationError[] {
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

/**
 * 按 Zod issue 的路径把校验失败的值从 data 里摘掉（原地修改），供重新校验。
 *
 * 为什么需要它（D10）：Zod 是整体校验语义——`maxTokens: "32768"` 这种类型错误会让
 * safeParse 整体失败，而 parseSettingsFile 失败时返回 null，于是同一个文件里的
 * `permissions.deny` 等全部配置跟着一个无关笔误一起消失。预过滤
 * （filterInvalidPermissionRules）只覆盖了 permissions 三个数组，字段层面问题原样存在。
 * 这里把"失效粒度 = 错误粒度"落实到任意字段：只摘出错的那个值，其余照常校验通过。
 *
 * 数组元素用 splice 摘除：同一数组内先摘大下标，避免前面的摘除让后面的下标错位。
 *
 * @returns 是否摘掉了至少一个值。路径为空（根本身不是对象）或路径已不存在时返回 false，
 *          调用方据此停止重试、整份判失败（那是真正无法局部修复的情形）。
 */
export function removeInvalidValues(data: unknown, issues: readonly z.ZodIssue[]): boolean {
  const paths = issues.map((i) => i.path);
  if (paths.some((p) => p.length === 0)) return false;

  // 去重 + 按路径逆序（数字段按数值比较），保证同一数组内先删大下标
  const unique = [...new Map(paths.map((p) => [JSON.stringify(p), p])).values()];
  unique.sort((a, b) => {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      if (a[i] === b[i]) continue;
      if (typeof a[i] === "number" && typeof b[i] === "number") {
        return (b[i] as number) - (a[i] as number);
      }
      return String(b[i]).localeCompare(String(a[i]));
    }
    return b.length - a.length;
  });

  let removed = false;
  for (const path of unique) {
    // 缺必填字段时 issue 路径指向一个不存在的键（如 availableModels.0.name），摘不到——
    // 这时往上退一级，摘掉包含它的那个元素 / 对象。退到根仍摘不到就放弃这条。
    for (let len = path.length; len > 0; len--) {
      if (removeAt(data, path.slice(0, len))) {
        removed = true;
        break;
      }
    }
  }
  return removed;
}

function removeAt(data: unknown, path: readonly (string | number)[]): boolean {
  let parent: any = data;
  for (const seg of path.slice(0, -1)) {
    parent = parent?.[seg as any];
  }
  if (!parent || typeof parent !== "object") return false;
  const leaf = path[path.length - 1]!;
  if (Array.isArray(parent) && typeof leaf === "number") {
    if (leaf >= parent.length) return false;
    parent.splice(leaf, 1);
    return true;
  }
  if (!Object.prototype.hasOwnProperty.call(parent, leaf)) return false;
  delete parent[leaf as any];
  return true;
}
