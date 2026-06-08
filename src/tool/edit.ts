/**
 * Edit 工具 - 编辑文件内容
 * 通过字符串查找替换来修改文件
 * 支持 4 级降级匹配策略：精确 → 灵活 → 正则 → 模糊
 * 要求：必须先用 Read 工具读取文件后才能编辑（先读后改）
 */

import type { LegacyTool as Tool, LegacyToolResult as ToolResult, PermissionResult, ToolUseContext } from "./types.ts";
import type { FileReadTracker } from "./file-read-tracker.ts";
import { getLogger } from "../debug/logger.ts";
import { detectOmissionPlaceholders } from "./omission-detector.ts";
import { coerceSemanticBoolean } from "../utils/semantic-boolean.ts";
import { mkdirSync, existsSync } from "fs";
import { dirname, basename } from "path";
import { normalizeToolPath, formatPathNotFoundError } from "./path-utils.ts";

// ─── 内部类型 ────────────────────────────────────────────────────────────────

type MatchStrategy = "exact" | "flexible" | "regex" | "fuzzy";

interface ReplacementResult {
  newContent: string;
  occurrences: number;
  strategy: MatchStrategy | "none";
}

// ─── 辅助函数 ────────────────────────────────────────────────────────────────

/** 检测文件行尾格式 */
function detectLineEnding(content: string): "\r\n" | "\n" {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

/** 转义正则特殊字符 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 将 replaceLines 的缩进对齐到 targetIndent。
 * 以 replaceLines[0] 的缩进为基准，后续行保留相对缩进。
 */
function applyIndentation(lines: string[], targetIndent: string): string[] {
  if (lines.length === 0) return [];
  const refIndent = (lines[0].match(/^([ \t]*)/) ?? ["", ""])[1];
  return lines.map((line) => {
    if (line.trim() === "") return "";
    if (line.startsWith(refIndent)) {
      return targetIndent + line.slice(refIndent.length);
    }
    return targetIndent + line.trimStart();
  });
}

/** 恢复尾部换行符（保持与原文件一致） */
function restoreTrailingNewline(original: string, modified: string): string {
  const had = original.endsWith("\n");
  if (had && !modified.endsWith("\n")) return modified + "\n";
  if (!had && modified.endsWith("\n")) return modified.replace(/\n$/, "");
  return modified;
}

// ─── 策略 1：精确匹配 ─────────────────────────────────────────────────────────

function tryExactMatch(
  content: string,
  search: string,
  replace: string,
  replaceAll: boolean,
): ReplacementResult | null {
  const count = content.split(search).length - 1;
  if (count === 0) return null;
  if (!replaceAll && count > 1) {
    // 多处匹配但未设 replace_all，返回 occurrences 供上层报错
    return { newContent: content, occurrences: count, strategy: "exact" };
  }
  const newContent = replaceAll
    ? content.split(search).join(replace)
    : content.replace(search, replace);
  return {
    newContent: restoreTrailingNewline(content, newContent),
    occurrences: count,
    strategy: "exact",
  };
}

// ─── 策略 2：灵活匹配（忽略行首缩进差异） ────────────────────────────────────

function tryFlexibleMatch(
  content: string,
  search: string,
  replace: string,
  replaceAll: boolean,
): ReplacementResult | null {
  const sourceLines = content.match(/.*(?:\n|$)/g)?.slice(0, -1) ?? [];
  const searchLinesStripped = search.split("\n").map((l) => l.trim());
  const replaceLines = replace.split("\n");
  const N = searchLinesStripped.length;

  let occurrences = 0;
  let i = 0;
  while (i <= sourceLines.length - N) {
    const window = sourceLines.slice(i, i + N);
    const windowStripped = window.map((l) => l.trim());
    const isMatch = windowStripped.every((l, idx) => l === searchLinesStripped[idx]);

    if (isMatch) {
      occurrences++;
      if (!replaceAll && occurrences > 1) {
        // 多处匹配但未设 replace_all
        return { newContent: content, occurrences, strategy: "flexible" };
      }
      // 取匹配块第一行的实际缩进
      const indent = (window[0].match(/^([ \t]*)/) ?? ["", ""])[1];
      const indented = applyIndentation(replaceLines, indent);
      sourceLines.splice(i, N, indented.join("\n"));
      i += replaceLines.length;
    } else {
      i++;
    }
  }

  if (occurrences === 0) return null;
  return {
    newContent: restoreTrailingNewline(content, sourceLines.join("")),
    occurrences,
    strategy: "flexible",
  };
}

// ─── 策略 3：正则匹配（忽略空白数量差异） ────────────────────────────────────

function tryRegexMatch(
  content: string,
  search: string,
  replace: string,
  replaceAll: boolean,
): ReplacementResult | null {
  const delimiters = ["(", ")", ":", "[", "]", "{", "}", ">", "<", "="];
  let processed = search;
  for (const d of delimiters) {
    processed = processed.split(d).join(` ${d} `);
  }
  const tokens = processed.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;

  const pattern = `^([ \t]*)${tokens.map(escapeRegex).join("\\s*")}`;
  const globalRegex = new RegExp(pattern, "gm");
  const matches = content.match(globalRegex);
  if (!matches) return null;

  const occurrences = matches.length;
  if (!replaceAll && occurrences > 1) {
    return { newContent: content, occurrences, strategy: "regex" };
  }

  const replaceLines = replace.split("\n");
  const replaceRegex = new RegExp(pattern, replaceAll ? "gm" : "m");
  const newContent = content.replace(
    replaceRegex,
    (_match, indent) => applyIndentation(replaceLines, indent || "").join("\n"),
  );

  return {
    newContent: restoreTrailingNewline(content, newContent),
    occurrences,
    strategy: "regex",
  };
}

// ─── 策略 4：模糊匹配（Levenshtein 滑动窗口） ────────────────────────────────

/** 内联简化版 Levenshtein 距离（无需外部依赖） */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[] = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const temp = dp[j];
      dp[j] = a[i - 1] === b[j - 1]
        ? prev
        : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = temp;
    }
  }
  return dp[n];
}

function stripWhitespace(s: string): string {
  return s.replace(/\s/g, "");
}

const FUZZY_THRESHOLD = 0.1;          // 允许 10% 差异
const WHITESPACE_PENALTY = 0.1;       // 空白差异权重
const FUZZY_MIN_LENGTH = 10;          // 最短触发长度
const FUZZY_COMPLEXITY_LIMIT = 4e8;   // 复杂度保护

function tryFuzzyMatch(
  content: string,
  search: string,
  replace: string,
  replaceAll: boolean,
): ReplacementResult | null {
  if (search.length < FUZZY_MIN_LENGTH) return null;

  const sourceLines = content.match(/.*(?:\n|$)/g)?.slice(0, -1) ?? [];
  const searchLines = search.match(/.*(?:\n|$)/g)?.slice(0, -1)?.map((l) => l.trimEnd()) ?? [];
  const N = searchLines.length;
  if (N === 0) return null;

  // 复杂度保护
  if (sourceLines.length * Math.pow(search.length, 2) > FUZZY_COMPLEXITY_LIMIT) return null;

  const searchBlock = searchLines.join("\n");
  const candidates: Array<{ index: number; score: number }> = [];

  for (let i = 0; i <= sourceLines.length - N; i++) {
    const windowText = sourceLines.slice(i, i + N).map((l) => l.trimEnd()).join("\n");
    // 长度启发式过滤
    const lengthDiff = Math.abs(windowText.length - searchBlock.length);
    if (lengthDiff / searchBlock.length > FUZZY_THRESHOLD / WHITESPACE_PENALTY) continue;

    const dRaw = levenshtein(windowText, searchBlock);
    const dNorm = levenshtein(stripWhitespace(windowText), stripWhitespace(searchBlock));
    const weighted = dNorm + (dRaw - dNorm) * WHITESPACE_PENALTY;
    const score = weighted / searchBlock.length;

    if (score <= FUZZY_THRESHOLD) {
      candidates.push({ index: i, score });
    }
  }

  if (candidates.length === 0) return null;

  // 按分数升序，选出不重叠的最优匹配
  candidates.sort((a, b) => a.score - b.score || a.index - b.index);
  const selected: typeof candidates = [];
  for (const c of candidates) {
    if (!selected.some((s) => Math.abs(s.index - c.index) < N)) {
      selected.push(c);
      if (!replaceAll) break; // 只替换一处时取最优
    }
  }

  if (selected.length === 0) return null;
  if (!replaceAll && selected.length > 1) {
    return { newContent: content, occurrences: selected.length, strategy: "fuzzy" };
  }

  // 从后往前替换，保持行索引有效
  selected.sort((a, b) => b.index - a.index);
  const replaceLines = replace.split("\n");
  for (const match of selected) {
    const indent = (sourceLines[match.index].match(/^([ \t]*)/) ?? ["", ""])[1];
    const indented = applyIndentation(replaceLines, indent);
    let replacement = indented.join("\n");
    if (sourceLines[match.index + N - 1]?.endsWith("\n")) replacement += "\n";
    sourceLines.splice(match.index, N, replacement);
  }

  return {
    newContent: restoreTrailingNewline(content, sourceLines.join("")),
    occurrences: selected.length,
    strategy: "fuzzy",
  };
}

// ─── 引号规范化 ─────────────────────────────────────────────────────────────

/** 将弯引号规范化为直引号（LLM 常见行为） */
function normalizeQuotes(str: string): string {
  return str
    .replace(/[\u201C\u201D]/g, '"')   // "" → "
    .replace(/[\u2018\u2019]/g, "'")   // '' → '
    .replace(/\u2014/g, "--")          // — → --
    .replace(/\u2013/g, "-")           // – → -
    .replace(/\u2026/g, "...");        // … → ...
}

// ─── 设置文件保护 ─────────────────────────────────────────────────────────────

/** 受保护的设置文件模式 */
const PROTECTED_SETTINGS_PATTERNS = [
  /\.sid-code\/settings\.json$/,
  /\.sid-code\/config\.json$/,
  /\.claude\/settings\.json$/,
];

/** 检查是否为受保护的设置文件 */
function isProtectedSettingsFile(filePath: string): boolean {
  return PROTECTED_SETTINGS_PATTERNS.some(p => p.test(filePath));
}

// ─── 主替换函数 ───────────────────────────────────────────────────────────────

function calculateReplacement(
  content: string,
  search: string,
  replace: string,
  replaceAll: boolean,
): ReplacementResult {
  // 统一 CRLF → LF 后匹配
  const normalizedContent = content.replace(/\r\n/g, "\n");
  const normalizedSearch = search.replace(/\r\n/g, "\n");
  const normalizedReplace = replace.replace(/\r\n/g, "\n");

  const exact = tryExactMatch(normalizedContent, normalizedSearch, normalizedReplace, replaceAll);
  if (exact) return exact;

  // 引号规范化后重试精确匹配（LLM 常将直引号替换为弯引号）
  const quotedSearch = normalizeQuotes(normalizedSearch);
  const quotedContent = normalizeQuotes(normalizedContent);
  if (quotedSearch !== normalizedSearch || quotedContent !== normalizedContent) {
    const quotedExact = tryExactMatch(quotedContent, quotedSearch, normalizedReplace, replaceAll);
    if (quotedExact) {
      // 在原始内容上用规范化后的匹配位置做替换
      const origExact = tryExactMatch(normalizedContent, normalizedContent.slice(
        quotedContent.indexOf(quotedSearch),
        quotedContent.indexOf(quotedSearch) + quotedSearch.length,
      ), normalizedReplace, replaceAll);
      if (origExact && origExact.occurrences > 0) return origExact;
      // 回退：直接在规范化内容上替换
      return quotedExact;
    }
  }

  const flexible = tryFlexibleMatch(normalizedContent, normalizedSearch, normalizedReplace, replaceAll);
  if (flexible) return flexible;

  const regex = tryRegexMatch(normalizedContent, normalizedSearch, normalizedReplace, replaceAll);
  if (regex) return regex;

  const fuzzy = tryFuzzyMatch(normalizedContent, normalizedSearch, normalizedReplace, replaceAll);
  if (fuzzy) return fuzzy;

  return { newContent: content, occurrences: 0, strategy: "none" };
}

// ─── EditTool 类 ──────────────────────────────────────────────────────────────

export class EditTool implements Tool {
  private tracker: FileReadTracker | null;

  constructor(tracker?: FileReadTracker) {
    this.tracker = tracker ?? null;
  }

  name(): string {
    return "edit";
  }

  /** 工具级权限检查：敏感文件路径要求确认，其余 passthrough */
  async checkPermissions(input: unknown, _context: ToolUseContext): Promise<PermissionResult> {
    const filePath = (input as any)?.file_path;
    if (!filePath || typeof filePath !== "string") {
      return { behavior: "passthrough" };
    }
    const name = basename(filePath);
    if (name.startsWith(".env") || name === "credentials.json" || name.endsWith(".pem") || name.endsWith(".key")) {
      return { behavior: "ask", message: `编辑敏感文件需要确认: ${filePath}` };
    }
    return { behavior: "passthrough" };
  }

  description(): string {
    return "通过查找替换来编辑文件内容。支持精确/灵活/正则/模糊 4 级匹配策略，自动降级。old_string='' 且文件不存在时创建新文件。";
  }

  usageGuide(): string {
    return `- 使用 edit 而不是 bash sed/awk 来修改文件
- 必须先用 read 读取文件，否则会被拒绝
- old_string 优先精确匹配，失败时自动尝试灵活/正则/模糊匹配
- 如果 read 输出带行号前缀（如 "123→"），edit 会自动剥离，无需手动处理
- 设置 replace_all=true 可替换所有匹配项
- old_string='' 且文件不存在时，直接创建新文件（等价于 write）`;
  }

  inputSchema(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "要编辑的文件的绝对路径",
        },
        old_string: {
          type: "string",
          description: "要替换的原始字符串。设为空字符串且文件不存在时，创建新文件",
        },
        new_string: {
          type: "string",
          description: "替换后的新字符串",
        },
        replace_all: {
          type: "boolean",
          description: "是否替换所有匹配项（默认 false，要求唯一匹配）",
        },
      },
      required: ["file_path", "old_string", "new_string"],
    };
  }

  async execute(input: unknown): Promise<ToolResult> {
    const log = getLogger();
    const params = input as {
      file_path: string;
      old_string: string;
      new_string: string;
      replace_all?: boolean;
    };

    if (!params.file_path || params.old_string === undefined || params.new_string === undefined) {
      return { output: "错误: 缺少必需参数", isError: true };
    }

    let filePath: string;
    try {
      filePath = normalizeToolPath(params.file_path);
    } catch (err: any) {
      return { output: `路径无效: ${err.message}`, isError: true };
    }

    log.info("TOOL", `▶ 编辑 ${filePath}`);

    // 设置文件保护：禁止编辑 sid-code 自身的配置文件
    if (isProtectedSettingsFile(filePath)) {
      return {
        output: `错误: ${filePath} 是受保护的设置文件，不允许通过 edit 工具修改。请使用 /config 命令或手动编辑。`,
        isError: true,
      };
    }

    // 先读后改校验
    if (this.tracker) {
      const error = this.tracker.validateForEdit(filePath);
      if (error) {
        return { output: `错误: ${error}`, isError: true };
      }
    }

    // 行号前缀剥离（如 "123→content" → "content"）
    const oldString = this.stripLineNumbers(params.old_string);
    const newString = params.new_string;
    // LLM 可能把布尔写成字符串 "false"——JS truthiness 会误判为 true，
    // 导致本该替换一处却替换全部。用语义化布尔归一化兜底。
    const replaceAll = coerceSemanticBoolean(params.replace_all, false);

    // 省略占位符检测（仅对较长的 new_string 检测，避免小编辑误报）
    if (newString.split("\n").length > 5) {
      const omissions = detectOmissionPlaceholders(newString);
      if (omissions.length > 0) {
        const details = omissions.map(m => `  行 ${m.line}: ${m.text}`).join("\n");
        return {
          output: `错误: new_string 中检测到省略占位符，请提供完整代码:\n${details}\n\n请重新生成完整的替换内容。`,
          isError: true,
        };
      }
    }

    try {
      const file = Bun.file(filePath);
      const exists = await file.exists();

      // ── old_string='' 创建新文件 ──────────────────────────────────────────
      if (oldString === "") {
        if (exists) {
          return {
            output: `错误: 文件已存在，无法用空 old_string 创建。请用 edit 修改内容，或用 write 覆盖整个文件。`,
            isError: true,
          };
        }

        const dir = dirname(filePath);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        await Bun.write(filePath, newString);
        log.info("TOOL", `✓ 创建新文件 ${filePath}`);
        return { output: `文件已创建: ${filePath}` };
      }

      // ── 普通编辑 ──────────────────────────────────────────────────────────
      if (!exists) {
        return { output: formatPathNotFoundError(filePath), isError: true };
      }

      const rawContent = await file.text();
      const lineEnding = detectLineEnding(rawContent);

      const result = calculateReplacement(rawContent, oldString, newString, replaceAll);

      if (result.occurrences === 0) {
        return { output: "错误: 未找到要替换的字符串", isError: true };
      }

      if (!replaceAll && result.occurrences > 1) {
        return {
          output: `错误: 找到 ${result.occurrences} 处匹配，但 replace_all=false。请提供更具体的 old_string 或设置 replace_all=true`,
          isError: true,
        };
      }

      // 恢复原始行尾格式
      let finalContent = result.newContent;
      if (lineEnding === "\r\n") {
        finalContent = finalContent.replace(/\r?\n/g, "\r\n");
      }

      await Bun.write(filePath, finalContent);

      if (this.tracker) {
        this.tracker.updateMtime(filePath);
      }

      const strategyNote = result.strategy !== "exact"
        ? `，使用${this.strategyLabel(result.strategy)}匹配`
        : "";
      log.info("TOOL", `✓ 编辑 ${filePath} 完成 (${result.occurrences}处${strategyNote})`);

      // 生成 diff 上下文片段（帮助 LLM 验证编辑结果）
      const diffContext = this.getDiffContextSnippet(rawContent, finalContent, oldString);

      return {
        output: `文件已编辑: ${filePath}（替换了 ${result.occurrences} 处${strategyNote}）${diffContext}`,
      };
    } catch (err: any) {
      return { output: `编辑文件失败: ${err.message}`, isError: true };
    }
  }

  private strategyLabel(strategy: MatchStrategy | "none"): string {
    const labels: Record<string, string> = {
      flexible: "灵活",
      regex: "正则",
      fuzzy: "模糊",
    };
    return labels[strategy] ?? strategy;
  }

  /** 剥离行号前缀（如 "  123→content" → "content"） */
  private stripLineNumbers(str: string): string {
    return str
      .split("\n")
      .map((line) => line.replace(/^\s*\d+→/, ""))
      .join("\n");
  }

  /** 生成 diff 上下文片段：显示变更周围 5 行代码 */
  private getDiffContextSnippet(oldContent: string, newContent: string, searchString: string): string {
    try {
      const oldLines = oldContent.split("\n");
      const newLines = newContent.split("\n");

      // 找到变更位置（简单查找第一个不同的行）
      let changeStart = 0;
      for (let i = 0; i < Math.min(oldLines.length, newLines.length); i++) {
        if (oldLines[i] !== newLines[i]) {
          changeStart = i;
          break;
        }
      }

      // 提取上下文（变更前后各 5 行）
      const contextSize = 5;
      const start = Math.max(0, changeStart - contextSize);
      const end = Math.min(newLines.length, changeStart + contextSize + 1);
      const contextLines = newLines.slice(start, end);

      if (contextLines.length === 0) return "";

      const snippet = contextLines
        .map((line, idx) => {
          const lineNum = start + idx + 1;
          const marker = lineNum === changeStart + 1 ? "→" : " ";
          return `${lineNum}${marker} ${line}`;
        })
        .join("\n");

      return `\n\n变更上下文:\n${snippet}`;
    } catch {
      return ""; // 生成失败时静默忽略
    }
  }
}
