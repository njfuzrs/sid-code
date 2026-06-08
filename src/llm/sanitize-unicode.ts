/**
 * 递归清理对象/数组中所有字符串字段的孤立 surrogate。
 * 使用 ES2024 toWellFormed()：仅替换真正孤立的 surrogate，完整 surrogate pair 不受影响。
 * 返回新对象，不修改原始对象（不可变）。
 *
 * 例：
 *   sanitizeStrings({ a: "\uD83D" })           → { a: "\uFFFD" }
 *   sanitizeStrings({ a: "\uD83D\uDE10" })     → { a: "😐" }    // 完整 pair 保留
 *   sanitizeStrings([{ b: "\uDE00hello" }])    → [{ b: "\uFFFDhello" }]
 */
export function sanitizeStrings(obj: unknown): unknown {
  if (typeof obj === "string") {
    return obj.isWellFormed() ? obj : obj.toWellFormed();
  }
  if (Array.isArray(obj)) {
    return obj.map(sanitizeStrings);
  }
  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      result[k] = sanitizeStrings(v);
    }
    return result;
  }
  return obj; // number, boolean, null, undefined 等非字符串/non-iterable 原值
}
