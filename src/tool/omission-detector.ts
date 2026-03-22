/**
 * 省略占位符检测器
 * 检测 LLM 生成代码中的省略标记，防止代码被截断
 * 参考 gemini-cli 的 omissionPlaceholderDetector
 */

/** 省略占位符匹配结果 */
export interface OmissionMatch {
  line: number;
  text: string;
  pattern: string;
}

/** 省略占位符模式 */
const OMISSION_PATTERNS = [
  // JavaScript/TypeScript 注释
  { pattern: /\/\/\s*\.\.\.\s*(rest|remaining|existing|previous|other|more)/i, name: "JS comment ellipsis" },
  { pattern: /\/\*\s*\.\.\.\s*(rest|remaining|existing|previous|other|more).*?\*\//i, name: "JS block comment ellipsis" },
  { pattern: /\/\/\s*(existing|previous|rest of|remaining)\s+(code|implementation|logic|methods?|functions?)/i, name: "JS existing code" },
  { pattern: /\/\/\s*TODO:\s*(implement|add|complete)/i, name: "TODO placeholder" },

  // Python/Shell 注释
  { pattern: /#\s*\.\.\.\s*(rest|remaining|existing|previous|other|more)/i, name: "Python/Shell ellipsis" },
  { pattern: /#\s*(existing|previous|rest of|remaining)\s+(code|implementation|logic|methods?|functions?)/i, name: "Python/Shell existing code" },

  // HTML 注释
  { pattern: /<!--\s*\.\.\.\s*(rest|remaining|existing|previous|other|more).*?-->/i, name: "HTML ellipsis" },
  { pattern: /<!--\s*(existing|previous|rest of|remaining)\s+(code|content|markup).*?-->/i, name: "HTML existing code" },

  // 独立省略号（整行只有省略号或空白）
  { pattern: /^\s*\.{3,}\s*$/m, name: "Standalone ellipsis" },

  // 常见占位符文本
  { pattern: /\[\.{3}\]/i, name: "Bracketed ellipsis" },
  { pattern: /\(\.{3}\)/i, name: "Parenthesized ellipsis" },
];

/**
 * 检测内容中的省略占位符
 * 返回所有匹配的位置和文本
 */
export function detectOmissionPlaceholders(content: string): OmissionMatch[] {
  const matches: OmissionMatch[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    for (const { pattern, name } of OMISSION_PATTERNS) {
      if (pattern.test(line)) {
        matches.push({
          line: lineNum,
          text: line.trim(),
          pattern: name,
        });
        break; // 每行只记录第一个匹配
      }
    }
  }

  return matches;
}

/**
 * 检查内容是否包含省略占位符
 * 返回 true 表示检测到省略
 */
export function hasOmissionPlaceholders(content: string): boolean {
  return detectOmissionPlaceholders(content).length > 0;
}
