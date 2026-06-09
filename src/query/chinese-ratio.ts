/**
 * 中文占比计算 + 英文触发词检测（L3 + L5）
 *
 * L3：流结束后扫描完整响应文本，检测 DeepSeek 常见英文输出模式。
 * L5：移除代码块/行内代码/日志行/纯路径行后计算中文字符占比，
 *     作为语言纠正重试的触发条件。
 *
 * 对标 Claude Code 的自定义错误类型设计模式
 * （CannotRetryError / FallbackTriggeredError），但用途不同：
 * Claude Code 用于 API 错误，sid-code 用于内容质量。
 */

/** 语言纠正最大重试次数 */
export const MAX_LANG_RETRY = 2;

/** 中文占比较硬阈值：低于此值触发语言纠正重试 */
export const CHINESE_RATIO_HARD_THRESHOLD = 0.5;

/** 中文占比警告阈值：低于此值记录 WARN 日志但不重试 */
export const CHINESE_RATIO_WARN_THRESHOLD = 0.8;

/**
 * 中文正则：CJK 统一表意文字（基本区 + 扩展 A 区）
 * 覆盖 \u4e00-\u9fff（基本区）和 \u3400-\u4dbf（扩展 A）
 */
const CHINESE_CHAR_RE = /[\u4e00-\u9fff\u3400-\u4dbf]/g;

// ============================================================
// L3: 英文触发词检测
// ============================================================

/** DeepSeek 常见英文输出的触发模式（窄匹配，避免工具调用输出误触发） */
const ENGLISH_TRIGGER_PATTERNS: RegExp[] = [
  // DeepSeek reasoning 泄露到 content 的典型标记
  /\bTHINKING_IN_ENGLISH\b/,
  // 大段英文自然语言开头（至少 50 个连续英文字符后跟句号，跨行匹配）
  /(?:^|\n)[A-Za-z][^\u4e00-\u9fff]{50,}\.\s*(?:\n|$)/,
  // 纯英文段落的典型开头（排除代码块和表格，前面不能是 ` | -）
  /(?<![`|\-])(?:\n|^)(I will|Let me|First, I will|Now I will)\s/,
];

/**
 * 检测英文触发词
 * 在流结束后扫描完整响应文本，检测 DeepSeek 常见英文输出模式。
 */
export function detectEnglishTriggerWords(text: string): boolean {
  if (!text || text.trim().length === 0) return false;
  for (const pattern of ENGLISH_TRIGGER_PATTERNS) {
    if (pattern.test(text)) return true;
  }
  return false;
}

// ============================================================
// L5: 中文占比计算
// ============================================================

/**
 * 计算响应文本中的中文字符占比。
 *
 * 预处理阶段移除以下内容以避免误判：
 * 1. 代码块（``` ```）
 * 2. 行内代码（` `）
 * 3. 日志行（以时间戳开头的行，如 2024-01-01 12:00:00）
 * 4. 纯路径行（如 /Users/xxx/file.ts）
 *
 * @param text 响应文本
 * @returns 中文字符占比 (0.0 – 1.0)
 */
export function calculateChineseRatio(text: string): number {
  if (!text || text.trim().length === 0) return 1.0;

  let cleaned = text;

  // 1. 移除代码块（``` ... ```）
  cleaned = cleaned.replace(/```[\s\S]*?```/g, "");

  // 2. 移除行内代码（`code`）
  cleaned = cleaned.replace(/`[^`\n]*`/g, "");

  // 3. 移除日志行（ISO 时间戳开头）
  cleaned = cleaned.replace(
    /^\d{4}-\d{2}-\d{2}[\sT]\d{2}:\d{2}:\d{2}[^\n]*$/gm,
    "",
  );

  // 4. 移除纯路径行（Unix + Windows 风格）
  cleaned = cleaned.replace(
    /^(?:\/[\w.\-~]+)+\/?$|^[A-Za-z]:\\(?:[\w.\-~]+\\)*[\w.\-~]*$/gm,
    "",
  );

  // 提取所有中文字符
  const chineseChars = (cleaned.match(CHINESE_CHAR_RE) || []).length;

  // 移除所有空白字符后计算总有意义字符数
  const totalChars = cleaned.replace(/\s/g, "").length;

  if (totalChars === 0) return 1.0;

  return chineseChars / totalChars;
}

// ============================================================
// 自定义错误类型（对标 Claude Code CannotRetryError 设计模式）
// ============================================================

/**
 * 语言质量不达标错误
 *
 * 对标 Claude Code 的 CannotRetryError（withRetry.ts:144-158），
 * 但触发条件从 API 错误改为内容质量。
 */
export class LanguageRetryError extends Error {
  constructor(
    public readonly chineseRatio: number,
    public readonly maxRetries: number,
  ) {
    super(
      `语言纠正重试耗尽（中文占比 ${(chineseRatio * 100).toFixed(1)}%，已达上限 ${maxRetries} 次）`,
    );
    this.name = "LanguageRetryError";
  }
}

/** 中文占比检测结果 */
export interface ChineseRatioResult {
  /** 中文字符占比 */
  ratio: number;
  /** 是否需要触发重试（ratio < 硬阈值且 retryCount < max） */
  needsRetry: boolean;
  /** 是否需要记录警告（ratio < 警告阈值但 >= 硬阈值） */
  needsWarn: boolean;
}

/**
 * 评估中文占比结果
 * @param ratio 中文占比
 * @param retryCount 当前重试次数
 * @param maxRetries 最大重试次数
 */
export function evaluateChineseRatio(
  ratio: number,
  retryCount: number,
  maxRetries: number = MAX_LANG_RETRY,
): ChineseRatioResult {
  return {
    ratio,
    needsRetry:
      ratio < CHINESE_RATIO_HARD_THRESHOLD && retryCount < maxRetries,
    needsWarn:
      ratio >= CHINESE_RATIO_HARD_THRESHOLD &&
      ratio < CHINESE_RATIO_WARN_THRESHOLD,
  };
}

/** 语言纠正用户消息模板 */
export function buildLanguageCorrectionMessage(): string {
  return (
    "请用中文重新回答上述问题。" +
    "所有解释性文字、推理过程和回复都必须使用中文。" +
    "代码和 API 名称可保持原文，但解释和推理必须用中文。"
  );
}
