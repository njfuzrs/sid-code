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

// Python 源码文件扩展名（不区分大小写）。
// Python 的 `...`（Ellipsis）是合法字面量：抽象方法体、`.pyi` stub、占位实现、
// numpy 切片、重载声明都会独占一行写 `...`。对这类文件放行"独立省略号"规则，
// 否则合法 Python 代码会被误判为"偷懒省略"而拒写（见约束型误伤排查清单 Top 2）。
const PYTHON_EXTENSIONS = new Set([
  ".py", ".pyi", ".pyw",
]);

/**
 * 判断文件是否为文档类型（基于扩展名）
 */
export function isDocumentFile(filePath: string): boolean {
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  return DOCUMENT_EXTENSIONS.has(ext);
}

/**
 * 判断文件是否为 Python 源码（基于扩展名）。
 * 用于对 Python 的合法 `...` Ellipsis 字面量放行"独立省略号"检测。
 */
export function isPythonFile(filePath: string): boolean {
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  return PYTHON_EXTENSIONS.has(ext);
}

/**
 * 省略占位符模式。
 * - docSafe: true 表示文档文件（.md 等）跳过此规则。
 * - pySafe: true 表示 Python 源码文件跳过此规则（Python `...` 是合法 Ellipsis 字面量）。
 *
 * 注意（2026-07-07 约束型误伤修复）：原 `TODO placeholder` 规则已移除。
 * `// TODO: implement X` 是完全合法的注释，不等同于"用省略标记代替已有代码"这种偷懒省略。
 * 把合法 TODO 当成省略占位符拒写属误伤（CLAUDE.md 禁的是省略标记，不是 TODO 注释）。
 * 真正的"偷懒省略"由 `... rest of` / `existing code` / 独立省略号等规则覆盖，无需 TODO 规则。
 */
const OMISSION_PATTERNS: Array<{ pattern: RegExp; name: string; docSafe: boolean; pySafe?: boolean }> = [
  // JavaScript/TypeScript 注释
  { pattern: /\/\/\s*\.{3,}\s*(rest|remaining|existing|previous|other|more)/i,
    name: "JS comment ellipsis", docSafe: false },
  { pattern: /\/\*\s*\.{3,}\s*(rest|remaining|existing|previous|other|more).*?\*\//i,
    name: "JS block comment ellipsis", docSafe: true },
  { pattern: /\/\/\s*(existing|previous|rest of|remaining)\s+(code|implementation|logic|methods?|functions?)/i,
    name: "JS existing code", docSafe: false },

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
  // pySafe：Python 源码放行——`...` 是合法 Ellipsis 字面量（stub/抽象方法/占位实现）。
  { pattern: /^\s*\.{3,}\s*$/, name: "Standalone ellipsis", docSafe: true, pySafe: true },

  // 常见占位符文本
  { pattern: /\[\.{3,}\]/i, name: "Bracketed ellipsis", docSafe: true },
  { pattern: /\(\.{3,}\)/i, name: "Parenthesized ellipsis", docSafe: true },
];

/**
 * 检测内容中的省略占位符
 * @param content 要检测的内容
 * @param isDoc 是否为文档文件，文档文件会跳过部分易误伤规则（默认 false）
 * @param isPython 是否为 Python 源码文件，会跳过对 Python 合法的 `...` 独立省略号规则（默认 false）
 */
export function detectOmissionPlaceholders(
  content: string,
  isDoc = false,
  isPython = false,
): OmissionMatch[] {
  const matches: OmissionMatch[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    for (const { pattern, name, docSafe, pySafe } of OMISSION_PATTERNS) {
      if (isDoc && docSafe) continue;  // 文档文件跳过易误伤规则
      if (isPython && pySafe) continue;  // Python 源码跳过合法 `...` Ellipsis 规则
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
 * @param isPython 是否为 Python 源码文件（默认 false）
 */
export function hasOmissionPlaceholders(content: string, isDoc = false, isPython = false): boolean {
  return detectOmissionPlaceholders(content, isDoc, isPython).length > 0;
}
