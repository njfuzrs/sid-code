/**
 * Edit 工具 - 编辑文件内容
 * 通过字符串查找替换来修改文件
 * 支持 4 级降级匹配策略：精确 → 灵活 → 正则 → 模糊
 * 要求：必须先用 Read 工具读取文件后才能编辑（先读后改）
 */

import type { LegacyTool as Tool, LegacyToolResult as ToolResult, PermissionResult, ToolUseContext } from "./types.ts";
import type { FileReadTracker } from "./file-read-tracker.ts";
import { getLogger } from "../debug/logger.ts";
import { detectOmissionPlaceholders, isDocumentFile, isPythonFile } from "./omission-detector.ts";
import { coerceSemanticBoolean } from "../utils/semantic-boolean.ts";
import { mkdirSync, existsSync } from "fs";
import { dirname, basename } from "path";
import { normalizeToolPath, formatPathNotFoundError } from "./path-utils.ts";
import { buildStructuredPatch } from "./diff-output.ts";
import { z } from "zod/v4";
import { lazySchema } from "../sdk/lazy-schema.ts";

/** Edit 工具输入 schema —— 运行时校验 + JSON Schema 生成的唯一真相源 */
const editSchema = lazySchema(() =>
  z.object({
    file_path: z.string().describe("要编辑的文件的绝对路径"),
    old_string: z.string().describe("要替换的原始字符串。设为空字符串且文件不存在时，创建新文件"),
    new_string: z.string().describe("替换后的新字符串"),
    replace_all: z.boolean().optional().describe("是否替换所有匹配项（默认 false，要求唯一匹配）"),
  }),
);

// ─── 内部类型 ────────────────────────────────────────────────────────────────

type MatchStrategy = "exact" | "flexible" | "regex" | "fuzzy";

/**
 * 可编辑文件大小上限（字节）。edit 需把整个文件载入内存做字符串替换，
 * 超大文件会 OOM。对标 claude-code 的 1 GiB 上限。
 */
const MAX_EDIT_FILE_SIZE_BYTES = 1024 * 1024 * 1024; // 1 GiB

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
    : content.replace(search, () => replace);
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
/**
 * 模糊匹配歧义边界：单处替换时，若次优候选分数与最优候选之差小于此值，
 * 判定为"歧义"（old_string 可能命中错误的相似块）并拒绝，避免静默错位替换。
 * 值越大越保守（越容易判歧义）。0.05 ≈ 次优与最优的差异度需拉开 5% 才放行。
 */
const FUZZY_AMBIGUITY_MARGIN = 0.05;

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

  // 歧义守卫：单处替换时，若存在另一处不重叠候选且分数与最优接近，
  // 说明 old_string 可能命中了错误的相似块（模糊匹配最危险的静默错位）。
  // 此时宁可拒绝、让模型提供更精确的 old_string，也不赌一个可能改错地方的替换。
  if (!replaceAll) {
    const best = selected[0];
    const runnerUp = candidates.find(
      (c) => Math.abs(c.index - best.index) >= N,
    );
    if (runnerUp && runnerUp.score - best.score < FUZZY_AMBIGUITY_MARGIN) {
      // 用 occurrences=-1 作为"模糊歧义"信号，上层据此报专门的错误
      return { newContent: content, occurrences: -1, strategy: "fuzzy" };
    }
  }

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

/**
 * 将弯引号规范化为直引号（LLM 常见行为：把代码里的直引号输出成弯引号）。
 *
 * 必须保持长度不变（1:1 字符映射）：calculateReplacement 的引号匹配路径会用
 * quotedContent 的下标去 slice normalizedContent 定位原始子串，一旦规范化改变了
 * 字符串长度，下标就会错位、slice 出错误子串导致替换污染前后文。
 * 故这里只做单字符到单字符映射；破折号/省略号等变长归一化一律不做（CC 同）。
 */
function normalizeQuotes(str: string): string {
  return str
    .replace(/[\u201C\u201D]/g, '"')   // curly double quotes -> "
    .replace(/[\u2018\u2019]/g, "'");  // curly single quotes -> '
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

  // 引号规范化后重试精确匹配（LLM 常将直引号替换为弯引号）。
  // normalizeQuotes 保证长度不变（1:1 映射），故 indexOf 偏移可直接用于原串 slice。
  const quotedSearch = normalizeQuotes(normalizedSearch);
  const quotedContent = normalizeQuotes(normalizedContent);
  if (quotedSearch !== normalizedSearch || quotedContent !== normalizedContent) {
    const idx = quotedContent.indexOf(quotedSearch);
    if (idx !== -1) {
      // 长度不变 → 偏移直接映射回原串
      const actualOld = normalizedContent.slice(idx, idx + quotedSearch.length);
      const origExact = tryExactMatch(normalizedContent, actualOld, normalizedReplace, replaceAll);
      if (origExact && origExact.occurrences > 0) return origExact;
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

  /** zod schema：执行器据此做运行时校验，registry 据此生成 LLM 定义 */
  readonly zodSchema = editSchema();

  constructor(tracker?: FileReadTracker) {
    this.tracker = tracker ?? null;
  }

  name(): string {
    return "edit";
  }

  /**
   * G7：给 auto 模式安全分类器的精简语义视图——报文件路径 + 替换摘要，
   * 不含完整 old_string/new_string（分类器只需判路径风险）。
   */
  toAutoClassifierInput(input: unknown): string | undefined {
    const filePath = (input as any)?.file_path;
    if (!filePath || typeof filePath !== "string") return undefined;
    const oldStr = typeof (input as any)?.old_string === "string" ? (input as any).old_string : "";
    const newStr = typeof (input as any)?.new_string === "string" ? (input as any).new_string : "";
    return `编辑 ${filePath}: "${oldStr.slice(0, 60)}" → "${newStr.slice(0, 60)}"`;
  }

  /**
   * G14：观测输入回填——把 file_path 展开为绝对路径，供权限校验/hook 观测。
   * 执行输入不变（保持 prompt cache 前缀稳定）。
   */
  backfillObservableInput(input: unknown): unknown | undefined {
    const filePath = (input as any)?.file_path;
    if (!filePath || typeof filePath !== "string") return undefined;
    try {
      const expanded = normalizeToolPath(filePath);
      if (expanded === filePath) return undefined;
      return { ...(input as any), file_path: expanded };
    } catch { return undefined; }
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
- old_string='' 且文件不存在时，直接创建新文件（等价于 write）
- new_string 必须包含完整替换内容，禁止使用 ... 省略已存在的代码`;
  }

  inputSchema(): Record<string, unknown> {
    return z.toJSONSchema(editSchema()) as Record<string, unknown>;
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

    // 先读后改校验
    if (this.tracker) {
      const error = this.tracker.validateForEdit(filePath);
      if (error) {
        return { output: `错误: ${error}`, isError: true };
      }
    }

    // 行号前缀剥离（如 "123\tcontent" / "123→content" → "content"）
    const oldString = this.stripLineNumbers(params.old_string);
    const newString = params.new_string;
    // LLM 可能把布尔写成字符串 "false"——JS truthiness 会误判为 true，
    // 导致本该替换一处却替换全部。用语义化布尔归一化兜底。
    const replaceAll = coerceSemanticBoolean(params.replace_all, false);

    // no-op 拦截：old===new 无实际变更。对标 claude-code（errorCode 1）提前拒绝，
    // 避免无谓写盘扰动 mtime（进而误触发下一次 edit 的"外部修改"判定）。
    // 仅对非创建场景检查（oldString==='' 是创建/覆盖语义，走下方分支）。
    if (oldString !== "" && oldString === newString) {
      return {
        output: "错误: old_string 与 new_string 完全相同，没有需要修改的内容。",
        isError: true,
      };
    }

    // 省略占位符检测（文档文件完全不检测；代码文件仅对 > 10 行的 new_string 检测）
    const isDoc = isDocumentFile(filePath);
    if (!isDoc && newString.split("\n").length > 10) {
      const omissions = detectOmissionPlaceholders(newString, false, isPythonFile(filePath));
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

      // E.11 团队记忆 secret 守卫（写入团队记忆目录的内容含 secret 则拒绝）
      const { checkTeamMemSecrets } = await import("../memory/team/secret-guard.ts");
      const { getTeamMemoryOptions } = await import("../memory/team/runtime.ts");
      const teamOpts = getTeamMemoryOptions();

      // ── old_string='' 创建新文件或填充空文件 ─────────────────────────────
      if (oldString === "") {
        if (exists) {
          // 对标 CC：空文件 + old_string='' → 等价于"用 new_string 替换空内容"（合法）
          const rawContent = await file.text();
          if (rawContent.trim() !== "") {
            return {
              output: `错误: 文件已存在且非空，无法用空 old_string 创建。请用 edit 修改内容，或用 write 覆盖整个文件。`,
              isError: true,
            };
          }
          // 空文件：当作"替换空内容"处理，与创建新文件逻辑复用
        }

        const guardErr = checkTeamMemSecrets(filePath, newString, teamOpts);
        if (guardErr) {
          log.warn("TOOL", `✗ 拒绝写入含 secret 的团队记忆: ${filePath}`);
          return { output: `错误: ${guardErr}`, isError: true };
        }

        const dir = dirname(filePath);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        await Bun.write(filePath, newString);
        log.info("TOOL", `✓ 创建新文件 ${filePath}`);
        // 结构化 diff(全 + 行)直传 UI;output 仅摘要,不含完整内容。
        return {
          output: `文件已创建: ${filePath}`,
          structuredPatch: buildStructuredPatch(filePath, "", newString),
        };
      }

      // ── 普通编辑 ──────────────────────────────────────────────────────────
      if (!exists) {
        return { output: formatPathNotFoundError(filePath), isError: true };
      }

      // 大文件保护：超过上限拒绝编辑，避免把整个文件读进内存做字符串替换而 OOM。
      // 对标 claude-code（1 GiB / errorCode 10）。edit 需全量载入替换，故必须预检。
      const fileSize = file.size;
      if (fileSize > MAX_EDIT_FILE_SIZE_BYTES) {
        const sizeMB = (fileSize / (1024 * 1024)).toFixed(1);
        const limitMB = (MAX_EDIT_FILE_SIZE_BYTES / (1024 * 1024)).toFixed(0);
        return {
          output: `错误: 文件过大 (${sizeMB} MB，超过 ${limitMB} MB 编辑上限)，无法安全编辑。请用 bash 的 sed 等流式工具处理超大文件。`,
          isError: true,
        };
      }

      const rawContent = await file.text();
      const lineEnding = detectLineEnding(rawContent);

      const result = calculateReplacement(rawContent, oldString, newString, replaceAll);

      // 模糊匹配歧义信号（occurrences=-1）：old_string 拼写偏差过大，
      // 有多个相似度接近的候选块，无法确定该改哪个。拒绝而非静默赌一个。
      if (result.occurrences === -1) {
        const preview = oldString.length > 200 ? oldString.slice(0, 200) + " …[已截断]" : oldString;
        return {
          output:
            `错误: old_string 与文件中多个位置都近似匹配（模糊匹配歧义），无法确定要修改哪一处。` +
            `请提供更精确、更长的 old_string（包含唯一的上下文行）以消除歧义。\n` +
            `你提供的 old_string:\n${preview}`,
          isError: true,
        };
      }

      if (result.occurrences === 0) {
        // 回显 old_string 摘要，帮模型定位失配（对标 claude-code 的 "String: ..."）。
        // 4 级策略（精确/灵活/正则/模糊）全落空，说明与磁盘内容差异较大。
        const preview = oldString.length > 200 ? oldString.slice(0, 200) + " …[已截断]" : oldString;
        return {
          output:
            `错误: 未找到要替换的字符串（精确/灵活/正则/模糊匹配均未命中）。` +
            `请重新 read 该文件确认最新内容后再编辑，注意保留精确的缩进与空白。\n` +
            `未匹配的 old_string:\n${preview}`,
          isError: true,
        };
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

      const guardErr = checkTeamMemSecrets(filePath, finalContent, teamOpts);
      if (guardErr) {
        log.warn("TOOL", `✗ 拒绝写入含 secret 的团队记忆: ${filePath}`);
        return { output: `错误: ${guardErr}`, isError: true };
      }

      await Bun.write(filePath, finalContent);

      if (this.tracker) {
        // 传入新内容，让 tracker 刷新内容快照 —— 否则下次 edit 的外部修改内容比对
        // 会拿旧内容比对，把自己刚写的内容误判为外部修改。
        this.tracker.updateMtime(filePath, finalContent);
      }

      const strategyNote = result.strategy !== "exact"
        ? `，使用${this.strategyLabel(result.strategy)}匹配`
        : "";
      log.info("TOOL", `✓ 编辑 ${filePath} 完成 (${result.occurrences}处${strategyNote})`);

      // 结构化 diff 直传 UI 渲染(独立于回传 LLM 的文本);给 LLM 的 output 仅一句话摘要,
      // 不再拼接完整 diff —— 对标 claude-code 省 token,且大文件 diff 不受 content 压缩影响。
      return {
        output: `文件已编辑: ${filePath}（替换了 ${result.occurrences} 处${strategyNote}）`,
        structuredPatch: buildStructuredPatch(filePath, rawContent, finalContent),
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

  /**
   * 剥离行号前缀。兼容 read 工具两种输出格式：
   *   - tab 分隔（现行 read.ts 用 `${n}\t${line}`，对齐 cat -n）："123\tcontent"
   *   - 箭头分隔（历史/其它来源）："  123→content"
   * 模型直接粘贴 read 输出当 old_string 时,若不剥离会因行号前缀失配。
   */
  private stripLineNumbers(str: string): string {
    return str
      .split("\n")
      .map((line) => line.replace(/^\s*\d+(?:\t|→)/, ""))
      .join("\n");
  }
}
