/**
 * semanticBoolean — LLM 友好的布尔验证（对齐 Claude Code 的 semanticBoolean）
 *
 * 问题：LLM 经常把布尔值写成字符串，比如 `"replace_all": "false"`。
 * JS 的 truthiness 会把非空字符串 "false" 当作 true，导致灾难性误操作
 * （本该替换一处，结果替换全部）。
 *
 * 解法：在 Zod 验证前做一次预处理，把字符串 "true"/"false" 归一化为
 * 真正的布尔值，其余值原样交给内层 schema 验证。
 *
 * 关键：不能用 z.coerce.boolean()——它走的就是 JS truthiness，
 * "false" 会被强制为 true，正好是我们要规避的 bug。
 *
 * 生成的 JSON Schema 仍然是 {"type":"boolean"}：字符串容忍只是
 * 客户端的隐式兜底，不会「教」模型去发送字符串。
 */

import { z } from "zod";

export function semanticBoolean<T extends z.ZodType = z.ZodBoolean>(
  inner: T = z.boolean() as unknown as T,
): z.ZodEffects<T> {
  return z.preprocess((v: unknown) => {
    if (v === "true") return true;
    if (v === "false") return false;
    return v;
  }, inner) as unknown as z.ZodEffects<T>;
}

/**
 * 不依赖 Zod 的轻量版本：把单个值归一化为布尔。
 * 用于不值得引入完整 schema 的热路径单字段场景（如工具的 replace_all）。
 *
 * - true / "true"  → true
 * - false / "false" / undefined / null → false（fail-safe：默认关闭）
 * - 其他值按 Boolean() 处理
 */
export function coerceSemanticBoolean(v: unknown, defaultValue = false): boolean {
  if (v === undefined || v === null) return defaultValue;
  if (v === true || v === "true") return true;
  if (v === false || v === "false") return false;
  return Boolean(v);
}
