/**
 * Unicode 净化（对齐 Claude Code 的 sanitization 模式）
 *
 * 防御「不可见字符」攻击：零宽空格、方向控制符、私用区字符等
 * 可以让用户「看到」的路径/命令与实际值不符。
 *
 * 攻击示例：
 *   "safe‌_file.txt" —— "safe" 和 "_file" 之间嵌入零宽非连接符 U+200C，
 *   用户肉眼看到 safe_file.txt（正常），实际是另一个文件名。
 *
 * 处理策略：
 * 1. NFKC 规范化：把兼容字符 / 组合序列折叠为标准形式
 * 2. 移除格式控制符 \p{Cf}：零宽空格、方向控制符（LRO/RLO 等）
 * 3. 移除私用区 \p{Co}：可能被特定字体渲染为任意图形
 * 4. 保留合法的非 ASCII（中文、日文、emoji 等），不误伤多语言
 */

/** 危险 Unicode 字符：格式控制符 + 私用区 */
const DANGEROUS_UNICODE_PATTERN = /[\p{Cf}\p{Co}]/gu;

/**
 * 净化字符串：NFKC 规范化 + 移除危险不可见字符。
 * 合法的多语言字符（中文/日文/emoji）会被保留。
 */
export function sanitizeUnicode(input: string): string {
  // 先规范化（NFKC 会展开部分兼容字符），再移除危险字符
  return input.normalize("NFKC").replace(DANGEROUS_UNICODE_PATTERN, "");
}

/**
 * 检测字符串是否包含危险 Unicode 字符。
 * 用于路径 / 命令验证时的预检查——命中即视为可疑输入。
 *
 * 注意：每次新建正则避免 lastIndex 状态污染（全局正则的 test 有副作用）。
 */
export function hasDangerousUnicode(input: string): boolean {
  return /[\p{Cf}\p{Co}]/u.test(input);
}
