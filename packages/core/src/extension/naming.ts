/**
 * 扩展名称验证和清理
 */

/**
 * 清理扩展名称：替换非法字符为 -
 * 非法字符：: \ / < > * ? " | 和空格
 */
export function sanitizeName(name: string): string {
  return name.replace(/[:\\/<>*?"|]/g, "-").replace(/\s+/g, "-");
}

/**
 * 验证扩展名称是否为合法 slug 格式
 * @returns null 表示验证通过，否则返回错误信息
 */
export function validateName(name: string): string | null {
  if (!name) {
    return "名称不能为空";
  }

  // slug 格式：小写字母、数字、连字符、下划线，首字符必须是字母或数字
  if (!/^[a-z0-9][a-z0-9-_]*$/i.test(name)) {
    return `名称 "${name}" 不符合 slug 格式（只允许字母、数字、-、_，且必须以字母或数字开头）`;
  }

  if (name.length > 64) {
    return "名称不能超过 64 个字符";
  }

  return null; // 验证通过
}
