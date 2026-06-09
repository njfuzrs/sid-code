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

// 文档类文件扩展名（不区分大小写）
const DOCUMENT_EXTENSIONS = new Set([
  ".md", ".mdx", ".markdown",
  ".txt", ".rst", ".adoc", ".asciidoc",
  ".org",
]);

/**
 * 判断文件是否为文档类型（基于扩展名）
 */
export function isDocumentFile(filePath: string): boolean {
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  return DOCUMENT_EXTENSIONS.has(ext);
}

/** 省略占位符模式（docSafe: true 表示文档文件跳过检测） */
const OMISSION_PATTERNS: Array<{ pattern: RegExp; name: string; docSafe: boolean }> = [
  // JavaScript/TypeScript 注释
  { pattern: /\/\/\s*\.{3,}\s*(rest|remaining|existing|previous|other|more)/i,
    name: "JS comment ellipsis", docSafe: false },
  { pattern: /\/\*\s*\.{3,}\s*(rest|remaining|existing|previous|other|more).*?\*\//i,
    name: "JS block comment ellipsis", docSafe: true },
  { pattern: /\/\/\s*(existing|previous|rest of|remaining)\s+(code|implementation|logic|methods?|functions?)/i,
    name: "JS existing code", docSafe: false },
  { pattern: /\/\/\s*TODO:\s*(implement|add|complete)/i,
    name: "TODO placeholder", docSafe: false },

  // Python/Shell 注释
  { pattern: /#\s*\.{3,}\s*(rest|remaining|existing|previous|other|more)/i,
    name: "Python/Shell ellipsis", docSafe: false },
  { pattern: /#\s*(existing|previous|rest of|remaining)\s+(code|implementation|logic|methods?|functions?)/i,
    name: "Python/Shell existing code", docSafe: false },

  // HTML 注释
  { pattern: /<!--\s*\.{3,}\s*(rest|remaining|existing|previous|other|more).*?-->/i,
    name: "HTML ellipsis", docSafe: true },
  { pattern: /<!--\s*(existing|previous|rest of|remaining)\s+(code|content|markup).*?-->/i,
    name: "HTML existing code", docSafe: true },

  // 独立省略号（整行只有省略号或空白）
  // 修复：去掉 m 多行标志，外层循环已逐行处理，m 标志导致匹配跨行污染和错误行号报告
  { pattern: /^\s*\.{3,}\s*$/, name: "Standalone ellipsis", docSafe: true },

  // 常见占位符文本
  { pattern: /\[\.{3,}\]/i, name: "Bracketed ellipsis", docSafe: true },
  { pattern: /\(\.{3,}\)/i, name: "Parenthesized ellipsis", docSafe: true },
];

/**
 * 检测内容中的省略占位符
 * @param content 要检测的内容
 * @param isDoc 是否为文档文件，文档文件会跳过部分易误伤规则（默认 false）
 */
export function detectOmissionPlaceholders(
  content: string,
  isDoc = false,
): OmissionMatch[] {
  const matches: OmissionMatch[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    for (const { pattern, name, docSafe } of OMISSION_PATTERNS) {
      if (isDoc && docSafe) continue;  // 文档文件跳过易误伤规则
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
 * @param content 要检测的内容
 * @param isDoc 是否为文档文件（默认 false）
 */
export function hasOmissionPlaceholders(content: string, isDoc = false): boolean {
  return detectOmissionPlaceholders(content, isDoc).length > 0;
}
