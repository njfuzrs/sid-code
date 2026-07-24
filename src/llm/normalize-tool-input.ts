/**
 * 轻量 normalize：如果 JSON.parse 后的对象中某些 string 字段看起来像 JSON 对象/数组，
 * 尝试递归解析。对齐 CC 的 normalizeContentFromAPI 行为。
 *
 * 背景：Anthropic API 偶尔返回嵌套的字符串化 JSON（即 JSON.parse 后某些字段仍是
 * JSON 字符串而非对象）。CC 用 normalizeContentFromAPI() 做递归解析。
 *
 * 只做一层深度（非无限递归），避免对正常字符串值误判。
 */

/**
 * 「原样字符串」字段白名单——这些字段承载的是文件内容 / 代码 / 配置文本，
 * 必须原样保留为字符串，绝不能因为"看起来像 JSON"就被 JSON.parse 成对象。
 *
 * 根因（2026-07 迁移 skill 崩溃复盘）：模型写 `.mcp.json` 时正确地把 JSON 配置
 * 作为字符串放进 write.content，但本函数的"贪心解析"把它转成了对象，导致 write
 * 工具的 `content: z.string()` 校验报 "期望 string，实际收到 object"。
 *
 * 涉及字段（覆盖所有内置文件写入类工具的原样字符串入参）：
 *   - write.content          写入文件内容
 *   - edit.old_string/new_string   编辑前后文本
 *   - notebook_edit.new_source     notebook cell 内容
 * 这些字段值即便以 `{` / `[` 开头也必须保持字符串形态。
 */
const RAW_STRING_FIELDS: ReadonlySet<string> = new Set([
  "content",
  "old_string",
  "new_string",
  "new_source",
]);

export function normalizeToolInput(input: unknown): unknown {
  if (typeof input !== "object" || input === null) return input;
  if (Array.isArray(input)) return input.map(normalizeToolInput);

  const obj = input as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    // 原样字符串字段：无条件保持原值，不做 JSON 解析（防止把文件内容/代码/配置
    // 文本误转成对象，破坏下游 z.string() 校验）。
    if (RAW_STRING_FIELDS.has(key)) {
      result[key] = value;
      continue;
    }
    if (typeof value === "string" && value.length > 1) {
      const firstChar = value[0];
      // 只尝试解析看起来像 JSON 对象/数组的字符串
      if (firstChar === "{" || firstChar === "[") {
        try {
          result[key] = JSON.parse(value);
          continue;
        } catch {
          // 不是 JSON，保持原值
        }
      }
    }
    result[key] = value;
  }
  return result;
}
