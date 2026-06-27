/**
 * Worktree Slug 校验与扁平化（P0-4 / P1-7 / B5）
 *
 * 安全核心：slug 最终会拼进文件系统路径和 git branch 名，必须防路径穿越。
 * 所有创建入口（EnterWorktreeTool / createAgentWorktree / SubAgentRunner）
 * 在任何 fs/git 操作前调用 validateWorktreeSlug()。
 *
 * 扁平化：支持 "user/feature" 风格命名，存储时 "/" → "+"，
 * 既避免 Git D/F（目录/文件）冲突，又保持纯函数可逆（不变量 §8.5）。
 */

/** slug 校验结果 */
export interface SlugValidation {
  valid: boolean;
  error?: string;
}

/** slug 总长度上限（对齐 CC） */
export const MAX_SLUG_LENGTH = 64;

/** 单段合法字符：字母数字 . _ -（不含 /，/ 是段分隔符） */
const SEGMENT_RE = /^[a-zA-Z0-9._-]+$/;

/** Windows 驱动器号格式，如 "C:" */
const WINDOWS_DRIVE_RE = /^[a-zA-Z]:$/;

/**
 * 校验 worktree slug 是否安全。
 *
 * 规则：
 * - 非空，总长度 <= 64
 * - 不以 "/" 开头（绝对路径）
 * - 按 "/" 拆分为段，每段非空且匹配 [a-zA-Z0-9._-]
 * - 禁止 "." 和 ".." 作为独立段（路径穿越）
 * - 禁止 Windows 驱动器号格式（C:）
 */
export function validateWorktreeSlug(slug: string): SlugValidation {
  if (typeof slug !== "string" || slug.length === 0) {
    return { valid: false, error: "slug 不能为空" };
  }
  if (slug.length > MAX_SLUG_LENGTH) {
    return { valid: false, error: `slug 长度超过 ${MAX_SLUG_LENGTH} 字符` };
  }
  if (slug.startsWith("/")) {
    return { valid: false, error: "slug 不能以 / 开头（疑似绝对路径）" };
  }
  if (slug.includes("\\")) {
    return { valid: false, error: "slug 不能含反斜杠" };
  }
  if (slug.includes("\0")) {
    return { valid: false, error: "slug 不能含空字节" };
  }

  const segments = slug.split("/");
  for (const seg of segments) {
    if (seg.length === 0) {
      return { valid: false, error: "slug 含空段（连续的 / 或首尾 /）" };
    }
    if (seg === "." || seg === "..") {
      return { valid: false, error: `slug 段不能为 "${seg}"（路径穿越）` };
    }
    if (WINDOWS_DRIVE_RE.test(seg)) {
      return { valid: false, error: `slug 段不能为驱动器号 "${seg}"` };
    }
    if (!SEGMENT_RE.test(seg)) {
      return {
        valid: false,
        error: `slug 段 "${seg}" 含非法字符（仅允许字母数字 . _ -）`,
      };
    }
  }

  return { valid: true };
}

/**
 * 扁平化 slug 用作目录名 / branch 名：将 "/" 替换为 "+"。
 * 纯函数：同一 slug 永远映射同一目录名（不变量 §8.5）。
 *
 * "user/feature" → "user+feature"
 */
export function flattenSlug(slug: string): string {
  return slug.replace(/\//g, "+");
}

/**
 * 反扁平化（用于显示）：将 "+" 还原为 "/"。
 * 注意：仅当原 slug 含 "/" 时可逆；若原 slug 本身就含 "+" 则不可逆，
 * 故仅用于 UI 展示，不用于路径计算。
 */
export function unflattenSlug(flatSlug: string): string {
  return flatSlug.replace(/\+/g, "/");
}

/** 由扁平 slug 推导 branch 名（对齐 CC：worktree-<flattened-slug>） */
export function branchNameForSlug(flatSlug: string): string {
  return `worktree-${flatSlug}`;
}
