/**
 * 环境变量插值模块
 * 支持在配置文件中使用 $VAR 和 ${VAR} 语法引用环境变量
 */

/**
 * 递归替换对象中所有字符串值里的环境变量引用。
 * 支持 $VAR_NAME 和 ${VAR_NAME} 两种格式。
 * 未定义的变量保留原占位符不替换。
 * 使用 WeakSet 防止循环引用。
 */
export function resolveEnvVars<T>(
  obj: T,
  env: Record<string, string> = process.env as Record<string, string>,
): T {
  const visited = new WeakSet<object>();

  function resolve(value: any): any {
    // 基本类型直接返回
    if (value === null || value === undefined) {
      return value;
    }

    // 字符串类型：执行插值
    if (typeof value === "string") {
      return interpolateString(value, env);
    }

    // 非对象类型直接返回
    if (typeof value !== "object") {
      return value;
    }

    // 循环引用检测
    if (visited.has(value)) {
      return value;
    }
    visited.add(value);

    // 数组：递归处理每个元素
    if (Array.isArray(value)) {
      return value.map((item) => resolve(item));
    }

    // 对象：递归处理每个值（不处理 key）
    const result: any = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = resolve(val);
    }
    return result;
  }

  return resolve(obj);
}

/**
 * 在字符串中插值环境变量
 * 支持两种格式：
 * - $VAR_NAME
 * - ${VAR_NAME}
 */
function interpolateString(str: string, env: Record<string, string>): string {
  // 替换 ${VAR_NAME} 格式
  let result = str.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (match, varName) => {
    const value = env[varName];
    return value !== undefined ? value : match; // 未定义时保留原占位符
  });

  // 替换 $VAR_NAME 格式（不在 ${} 内的）
  // 使用负向后顾断言确保 $ 前面不是 {
  result = result.replace(/(?<!\{)\$([A-Z_][A-Z0-9_]*)/g, (match, varName) => {
    const value = env[varName];
    return value !== undefined ? value : match; // 未定义时保留原占位符
  });

  return result;
}
