/**
 * 轻量 normalize：如果 JSON.parse 后的对象中某些 string 字段看起来像 JSON 对象/数组，
 * 尝试递归解析。对齐 CC 的 normalizeContentFromAPI 行为。
 *
 * 背景：Anthropic API 偶尔返回嵌套的字符串化 JSON（即 JSON.parse 后某些字段仍是
 * JSON 字符串而非对象）。CC 用 normalizeContentFromAPI() 做递归解析。
 *
 * 只做一层深度（非无限递归），避免对正常字符串值误判。
 */
export function normalizeToolInput(input: unknown): unknown {
  if (typeof input !== "object" || input === null) return input;
  if (Array.isArray(input)) return input.map(normalizeToolInput);

  const obj = input as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
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
