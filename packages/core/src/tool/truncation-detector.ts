/**
 * 内容截断检测器
 *
 * 轻量级启发式检测：文件内容是否"看起来被截断了"。
 * 典型场景：LLM 输出撞上 max_tokens，tool_use 的 JSON 参数被续写拼接后
 * JSON.parse 成功（参数是完整 JSON），但内部的 content 字段本身是半截的代码/HTML。
 *
 * 设计原则：
 * - 只检测高置信度的截断信号（宁可漏报也不误杀）
 * - 纯函数、无副作用、便于单测
 * - 不检测文档/Markdown 文件（结构松散，误报率高）
 */

import { isDocumentFile } from "./omission-detector.ts";

/** 截断检测结果 */
export interface TruncationSignal {
  /** 是否疑似被截断 */
  isTruncated: boolean;
  /** 检测到的信号描述（用于告知模型） */
  reason?: string;
}

/** 最小检测阈值：内容太短不值得检测（短文件不可能是"大文件被截断"） */
const MIN_CONTENT_LENGTH = 500;

/** 括号类字符对 */
const BRACKET_PAIRS: Array<[string, string]> = [
  ["{", "}"],
  ["[", "]"],
  ["(", ")"],
];

/**
 * 检测内容是否疑似被截断
 *
 * 策略（全部命中才报截断，降低误报）：
 * 1. 括号不平衡：左括号比右括号多 ≥ 3（容忍字符串内的括号干扰）
 * 2. 末尾突然中断：最后一行是半截的字符串/标签/语句
 *
 * @param content 要检测的文件内容
 * @param filePath 文件路径（用于判断文件类型）
 */
export function detectTruncation(content: string, filePath: string): TruncationSignal {
  // 文档文件不检测
  if (isDocumentFile(filePath)) {
    return { isTruncated: false };
  }

  // 太短不检测
  if (content.length < MIN_CONTENT_LENGTH) {
    return { isTruncated: false };
  }

  // 策略 1：括号平衡检测
  const bracketResult = checkBracketBalance(content);
  if (bracketResult) {
    return { isTruncated: true, reason: bracketResult };
  }

  // 策略 2：末尾突然中断检测
  const tailResult = checkAbruptEnding(content, filePath);
  if (tailResult) {
    return { isTruncated: true, reason: tailResult };
  }

  return { isTruncated: false };
}

/**
 * 括号平衡检测（简化版，不做完整语法分析）
 *
 * 排除字符串/注释内的括号：跟踪引号状态。
 * 阈值设为 3（容忍模板字面量、正则等少量不平衡）。
 */
function checkBracketBalance(content: string): string | undefined {
  for (const [open, close] of BRACKET_PAIRS) {
    let depth = 0;
    let inString: string | null = null; // 当前字符串开始引号
    let escaped = false;

    for (let i = 0; i < content.length; i++) {
      const ch = content[i];

      if (escaped) {
        escaped = false;
        continue;
      }

      if (ch === "\\") {
        escaped = true;
        continue;
      }

      // 简化的字符串状态追踪
      if (inString) {
        if (ch === inString) {
          inString = null;
        }
        continue;
      }

      if (ch === '"' || ch === "'" || ch === "`") {
        inString = ch;
        continue;
      }

      // 跳过单行注释
      if (ch === "/" && i + 1 < content.length) {
        if (content[i + 1] === "/") {
          // 跳到行尾
          const nl = content.indexOf("\n", i + 2);
          i = nl === -1 ? content.length - 1 : nl;
          continue;
        }
        if (content[i + 1] === "*") {
          // 跳到 */
          const end = content.indexOf("*/", i + 2);
          i = end === -1 ? content.length - 1 : end + 1;
          continue;
        }
      }

      if (ch === open) depth++;
      if (ch === close) depth--;
    }

    // 左括号多出 3 个以上 → 高度疑似截断
    if (depth >= 3) {
      return `${open}${close} 括号不平衡（未闭合 ${depth} 层），内容可能被截断`;
    }
  }
  return undefined;
}

/**
 * 末尾突然中断检测
 *
 * 检查最后一行是否是明显的"半截"模式
 */
function checkAbruptEnding(content: string, filePath: string): string | undefined {
  const lines = content.split("\n");
  // 取最后一个非空行
  let lastLine = "";
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (trimmed) {
      lastLine = trimmed;
      break;
    }
  }

  if (!lastLine) return undefined;

  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();

  // HTML/JSX: 以未闭合的标签开头结尾（如 <div class="foo ）
  if ((ext === ".html" || ext === ".htm" || ext === ".jsx" || ext === ".tsx" || ext === ".vue" || ext === ".svelte") &&
      /^<[a-zA-Z][^>]*$/.test(lastLine)) {
    return "末尾是未闭合的 HTML 标签，内容可能被截断";
  }

  // 通用: 最后一行以未闭合的字符串字面量结尾
  if (/["'`][^"'`]*$/.test(lastLine) && !lastLine.endsWith(";") && !lastLine.endsWith(",")) {
    // 额外检查：引号数量必须是奇数（真正未闭合）
    const quotes = (lastLine.match(/["'`]/g) || []).length;
    if (quotes % 2 !== 0) {
      return "末尾有未闭合的字符串字面量，内容可能被截断";
    }
  }

  // 通用: 最后一行以逗号结尾（暗示还有后续项）且 overall 括号不平衡 ≥ 1
  // 这单独不足以判定，所以不加（留给括号平衡策略）

  return undefined;
}
