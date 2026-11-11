/**
 * Edit 工具 - 编辑文件内容
 * 通过字符串查找替换来修改文件
 * 支持 4 级降级匹配策略：精确 → 灵活 → 正则 → 模糊
 * 要求：必须先用 Read 工具读取文件后才能编辑（先读后改）
 */

import type {
  LegacyTool as Tool,
  LegacyToolResult as ToolResult,
  PermissionResult,
  ToolUseContext,
} from "./types.ts";
import type { FileReadTracker } from "./file-read-tracker.ts";
import { getLogger } from "../debug/logger.ts";
import { detectOmissionPlaceholders, isDocumentFile, isPythonFile } from "./omission-detector.ts";
import { emitOmissionRejected } from "../query/guidance-events.ts";
import { coerceSemanticBoolean } from "@sid-code/shared/utils/semantic-boolean.ts";
import { mkdirSync, existsSync } from "fs";
import { dirname, basename, extname } from "path";
import { normalizeToolPath, formatPathNotFoundError } from "./path-utils.ts";
import { pickPaths } from "./jit-affected-paths.ts";
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

type MatchStrategy = "exact" | "normalized" | "flexible" | "regex" | "fuzzy";

/**
 * 可编辑文件大小上限（字节）。edit 需把整个文件载入内存做字符串替换，
 * 超大文件会 OOM。对标 claude-code 的 1 GiB 上限。
 */
const MAX_EDIT_FILE_SIZE_BYTES = 1024 * 1024 * 1024; // 1 GiB

interface ReplacementResult {
  newContent: string;
  occurrences: number;
  strategy: MatchStrategy | "none";
  /** 命中块的起止行（1-based，含端点）。拿不到位置的策略省略。 */
  matchStartLine?: number;
  matchEndLine?: number;
  /** 仅模糊匹配：1 - 加权编辑距离/长度，越大越像。 */
  similarity?: number;
}

/** 字符偏移 → 1-based 行号（offset 落在首字符之前时按第 1 行算）。 */
function lineOfOffset(text: string, offset: number): number {
  if (offset <= 0) return 1;
  return text.slice(0, offset).split("\n").length;
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
  // 首个命中块的起始行索引（0-based）：事件要能回到 messages 里核对改的是不是那一处。
  let firstMatchIndex = -1;
  let i = 0;
  while (i <= sourceLines.length - N) {
    const window = sourceLines.slice(i, i + N);
    const windowStripped = window.map((l) => l.trim());
    const isMatch = windowStripped.every((l, idx) => l === searchLinesStripped[idx]);

    if (isMatch) {
      if (firstMatchIndex === -1) firstMatchIndex = i;
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
    ...(firstMatchIndex >= 0
      ? { matchStartLine: firstMatchIndex + 1, matchEndLine: firstMatchIndex + N }
      : {}),
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
  // 用 matchAll 而不是 match：事件要报首个命中所在行，match 只给字符串不给 index。
  const matches = [...content.matchAll(globalRegex)];
  if (matches.length === 0) return null;

  const occurrences = matches.length;
  if (!replaceAll && occurrences > 1) {
    return { newContent: content, occurrences, strategy: "regex" };
  }

  const replaceLines = replace.split("\n");
  const replaceRegex = new RegExp(pattern, replaceAll ? "gm" : "m");
  const newContent = content.replace(replaceRegex, (_match, indent) =>
    applyIndentation(replaceLines, indent || "").join("\n"),
  );

  // 正则 pattern 不含换行，命中块固定是单行。
  const firstLine = lineOfOffset(content, matches[0]!.index ?? 0);
  return {
    newContent: restoreTrailingNewline(content, newContent),
    occurrences,
    strategy: "regex",
    matchStartLine: firstLine,
    matchEndLine: firstLine,
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
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = temp;
    }
  }
  return dp[n];
}

function stripWhitespace(s: string): string {
  return s.replace(/\s/g, "");
}

const FUZZY_THRESHOLD = 0.1; // 允许 10% 差异
const WHITESPACE_PENALTY = 0.1; // 空白差异权重
const FUZZY_MIN_LENGTH = 10; // 最短触发长度
const FUZZY_COMPLEXITY_LIMIT = 4e8; // 复杂度保护
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
  const searchLines =
    search
      .match(/.*(?:\n|$)/g)
      ?.slice(0, -1)
      ?.map((l) => l.trimEnd()) ?? [];
  const N = searchLines.length;
  if (N === 0) return null;

  // 复杂度保护
  if (sourceLines.length * Math.pow(search.length, 2) > FUZZY_COMPLEXITY_LIMIT) return null;

  const searchBlock = searchLines.join("\n");
  const candidates: Array<{ index: number; score: number }> = [];

  for (let i = 0; i <= sourceLines.length - N; i++) {
    const windowText = sourceLines
      .slice(i, i + N)
      .map((l) => l.trimEnd())
      .join("\n");
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

  // 事件要报「命中的是哪一块、像到什么程度」，必须在 sort（原地改顺序）之前取。
  const bestMatch = selected[0]!;
  const bestIndex = bestMatch.index;
  const similarity = 1 - bestMatch.score;

  // 歧义守卫：单处替换时，若存在另一处不重叠候选且分数与最优接近，
  // 说明 old_string 可能命中了错误的相似块（模糊匹配最危险的静默错位）。
  // 此时宁可拒绝、让模型提供更精确的 old_string，也不赌一个可能改错地方的替换。
  if (!replaceAll) {
    const runnerUp = candidates.find((c) => Math.abs(c.index - bestIndex) >= N);
    if (runnerUp && runnerUp.score - bestMatch.score < FUZZY_AMBIGUITY_MARGIN) {
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
    matchStartLine: bestIndex + 1,
    matchEndLine: bestIndex + N,
    similarity,
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
    .replace(/[\u201C\u201D]/g, '"') // curly double quotes -> "
    .replace(/[\u2018\u2019]/g, "'"); // curly single quotes -> '
}

// ─── EditLenientMatch 事件（宽进命中的可观测口径） ───────────────────────────

/**
 * 归一化 / 灵活 / 正则 / 模糊命中成功替换时发一条事件。
 *
 * 为什么需要它：这四条降级路径此前只有 tool_result 里一句「使用模糊匹配」，既没有命中
 * 位置也没有相似度，「3,880 次成功 edit 里那 43 次宽进到底改对没有」无法从轨迹上抽样核对。
 *
 * 只放可聚合的量：不记 old_string / new_string / 文件路径原文——原文已经在 messages
 * 里，重复落盘只是放大轨迹体积；`file_ext` 足够回答「哪类文件最容易触发宽进」。
 * 走模块级 sink 而不是穿 `traceAppendEvent`：调用方是 EditTool（主循环与子代理共用），
 * 不持有 collector（同 edit-failure-tracker 的写法）。
 */
export const EDIT_LENIENT_MATCH_EVENT_NAME = "EditLenientMatch";

type EditMatchSink = (data: Record<string, unknown>) => void;
let editMatchSink: EditMatchSink | null = null;

/** 注入/清除事件通道（App 在 collector 就绪后调用；测试收尾传 null 复位） */
export function setEditMatchSink(s: EditMatchSink | null): void {
  editMatchSink = s;
}

function emitEditLenientMatch(data: Record<string, unknown>): void {
  if (!editMatchSink) return;
  try {
    editMatchSink({ ...data, ts: Date.now() });
  } catch {
    /* 埋点失败不影响工具结果 */
  }
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
      if (origExact && origExact.occurrences > 0) {
        return {
          ...origExact,
          // 归一化命中单独成策略：未读文件守卫仍与 exact 同权（见下方 deferUnreadCheck），
          // 但事件层必须能把它和真正的精确命中分开统计。
          strategy: "normalized",
          matchStartLine: lineOfOffset(normalizedContent, idx),
          matchEndLine: lineOfOffset(normalizedContent, idx + quotedSearch.length - 1),
        };
      }
    }
  }

  const flexible = tryFlexibleMatch(
    normalizedContent,
    normalizedSearch,
    normalizedReplace,
    replaceAll,
  );
  if (flexible) return flexible;

  const regex = tryRegexMatch(normalizedContent, normalizedSearch, normalizedReplace, replaceAll);
  if (regex) return regex;

  const fuzzy = tryFuzzyMatch(normalizedContent, normalizedSearch, normalizedReplace, replaceAll);
  if (fuzzy) return fuzzy;

  return { newContent: content, occurrences: 0, strategy: "none" };
}

// ─── EditTool 类 ──────────────────────────────────────────────────────────────

export class EditTool implements Tool {
  /** D11：编辑类：漏 required 字段会改错文件，strict 超限时优先保留（见 ToolCapabilityFields.strictPriority） */
  readonly strictPriority = 50;

  private tracker: FileReadTracker | null;

  /** zod schema：执行器据此做运行时校验，registry 据此生成 LLM 定义 */
  readonly zodSchema = editSchema();

  /** P2-9：JIT 上下文发现的路径自报（契约见 types.ts jitAffectedPaths） */
  jitAffectedPaths(input: unknown): string[] {
    return pickPaths(input, "file_path");
  }

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
    } catch {
      return undefined;
    }
  }

  /** 工具级权限检查：敏感文件路径要求确认，其余 passthrough */
  async checkPermissions(input: unknown, _context: ToolUseContext): Promise<PermissionResult> {
    const filePath = (input as any)?.file_path;
    if (!filePath || typeof filePath !== "string") {
      return { behavior: "passthrough" };
    }
    const name = basename(filePath);
    if (
      name.startsWith(".env") ||
      name === "credentials.json" ||
      name.endsWith(".pem") ||
      name.endsWith(".key")
    ) {
      return { behavior: "ask", message: `编辑敏感文件需要确认: ${filePath}` };
    }
    return { behavior: "passthrough" };
  }

  description(): string {
    return "通过查找替换来编辑文件内容。支持精确/灵活/正则/模糊 4 级匹配策略，自动降级。old_string='' 且文件不存在时创建新文件。";
  }

  usageGuide(): string {
    return `- 使用 edit 而不是 bash sed/awk 来修改文件
- 编辑前应先用 read 读取文件；没读过的文件只在 old_string 精确命中时放行，近似匹配会被拒绝
- old_string 优先精确匹配，失败时自动尝试灵活/正则/模糊匹配
- 如果 read 输出带行号前缀（如 "123→"），edit 会自动剥离，无需手动处理
- 设置 replace_all=true 可替换所有匹配项
- old_string='' 且文件不存在时，直接创建新文件（等价于 write）
- new_string 必须包含完整替换内容，禁止使用 ... 省略已存在的代码
- 单次 edit 的内容尽量控制在数百行以内；超大改动请拆成多次 edit 逐段完成。一次性替换过长内容容易在流式输出中途被截断/中断，导致该次调用参数不完整而未执行`;
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

    // 并发冲突检测（Phase 2.1 + 2.4 配置化）。
    // PR-6：闸门逻辑提取到 conflict-gate.ts（edit/write/notebook_edit 三处共用单一实现），
    // 语义与优先级（block > 分支分叉自动放行 > 弹窗 > 无头降级）见该文件头注释。
    let conflictNote = "";
    {
      const { runConflictGate } = await import("./conflict-gate.ts");
      const gate = await runConflictGate(filePath, "edit", this.tracker);
      if (!gate.proceed) {
        return { output: gate.output, isError: true };
      }
      conflictNote = gate.note;
    }

    // 行号前缀剥离（如 "123\tcontent" / "123→content" → "content"）
    const oldString = this.stripLineNumbers(params.old_string);

    // 先读后改校验。
    // 从没 read 过的文件**不在这里一刀切拒绝**，延后到匹配之后判：old_string 在磁盘全文里
    // 精确命中就放行，只靠灵活/正则/模糊才命中则拒绝。
    // 理由（2026-10-15 轨迹核验，188 会话）：未读拒绝 38 次里 30 次模型其实已用 bash cat
    // 看过该文件，20 次补读后原样重发——拦截零收益、白烧一轮。精确命中本身就证明模型对
    // 那段的认知与磁盘一致；真正的风险在 4 级降级匹配：没看过文件凭印象拼的 old_string
    // 可能被模糊匹配静默落到相似的错误块上，read 前置是这条路唯一的前置防线，所以保留。
    // old_string='' 的创建/填充语义不属于"匹配"，仍走原校验（行为不变）。
    // write 不受影响：整文件覆盖会丢掉模型没见过的内容，validateForWrite 照旧拦。
    const deferUnreadCheck =
      this.tracker !== null && oldString !== "" && this.tracker.isUnread(filePath);
    if (this.tracker && !deferUnreadCheck) {
      const error = this.tracker.validateForEdit(filePath);
      if (error) {
        return { output: `错误: ${error}`, isError: true };
      }
    }
    const newString = params.new_string;
    // LLM 可能把布尔写成字符串 "false"——JS truthiness 会误判为 true，
    // 导致本该替换一处却替换全部。用语义化布尔归一化兜底。
    const replaceAll = coerceSemanticBoolean(params.replace_all, false);

    // no-op 拦截：old===new 无实际变更。对标 claude-code（errorCode 1）提前拒绝，
    // 避免无谓写盘扰动 mtime（进而误触发下一次 edit 的"外部修改"判定）。
    // 仅对非创建场景检查（oldString==='' 是创建/覆盖语义，走下方分支）。
    if (oldString !== "" && oldString === newString) {
      return {
        // 文案要点破「不要拿 old==new 当探针」：被评会话里 old==new 之后的下一步有 9 次又是 old==new，
        // 原文案只说「没有需要修改的内容」，模型读成「这段确实在文件里」后原样再发。
        output:
          "错误: old_string 与 new_string 完全相同，没有需要修改的内容。" +
          "new_string 必须是改后的完整内容；想确认文件当前内容请用 read，不要用 old_string 与 new_string 相同的 edit 当探针。",
        isError: true,
      };
    }

    // 省略占位符检测（文档文件完全不检测；代码文件仅对 > 10 行的 new_string 检测）
    const isDoc = isDocumentFile(filePath);
    if (!isDoc && newString.split("\n").length > 10) {
      const omissions = detectOmissionPlaceholders(newString, false, isPythonFile(filePath));
      if (omissions.length > 0) {
        emitOmissionRejected({
          tool_name: "edit",
          file_path: filePath,
          patterns: omissions.map((m) => m.pattern),
          match_count: omissions.length,
        });
        const details = omissions.map((m) => `  行 ${m.line}: ${m.text}`).join("\n");
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
      // P1-8：私有 / agent 记忆 secret 守卫。上面那道只管 team 目录（且团队记忆未启用时
      // 直接放行），私有记忆与 agent 记忆经 edit 写入时此前零闸门——而后台提取代理
      // 正走这条路。两道守卫在下面**两个写盘分支各调一次**：edit 有
      // 「old_string='' 创建/填充」与「常规替换」两条出口，只挡一条等于没挡。
      const { checkPrivateMemSecrets, afterMemoryFileWrite } =
        await import("../memory/write-guard.ts");
      // CG-2（台账 H3）：worktree 会话里写到主仓路径时，在结果末尾给出可直接执行的替换路径。
      // 是提示不是拦截 —— 用户确实可能想在 worktree 里顺手改主仓的一份共享配置。
      // 动态 import：worktree/manager 会带进 fs/git 一整套依赖，不为一句提示让
      // edit 的模块图变重（非 worktree 会话下这里只是命 module cache）。
      const { mainRepoWriteHint } = await import("../worktree/path-semantics.ts");

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
        // P1-8：私有 / agent 记忆同判据（出口一：old_string='' 创建或填充空文件）
        const privErr = checkPrivateMemSecrets(filePath, newString);
        if (privErr) {
          return { output: `错误: ${privErr}`, isError: true };
        }

        // D1：写盘**之前**在 IDE 里协商最终内容（用户可在 diff 视图里手改再保存）。
        // 无 IDE / 未开启 / 出错一律返回"照原样写"——IDE 是可选增强。
        const { negotiateContentViaIDE } = await import("../ide/tool-hooks.ts");
        const negotiated = await negotiateContentViaIDE(filePath, "", newString);
        if (!negotiated.proceed) {
          return { output: `已取消: ${negotiated.reason}`, isError: true };
        }
        const contentToWrite = negotiated.content;

        const dir = dirname(filePath);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        await Bun.write(filePath, contentToWrite);
        // P1-11：记忆文件被改过 ⇒ 推进缓存代数（非记忆路径 no-op）
        afterMemoryFileWrite(filePath);
        log.info("TOOL", `✓ 创建新文件 ${filePath}`);
        // 结构化 diff(全 + 行)直传 UI;output 仅摘要,不含完整内容。
        return {
          output:
            `文件已创建: ${filePath}` +
            (negotiated.userEdited ? "（采用了你在 IDE 中修改后的内容）" : "") +
            mainRepoWriteHint(filePath),
          structuredPatch: buildStructuredPatch(filePath, "", contentToWrite),
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

      // 未读文件的延后判定：只认精确命中（含 1:1 引号规范化，它也报 exact）。
      // 必须排在下面「歧义 / 未命中 / 多处」报错之前——否则未读文件会拿到近似匹配的
      // 诊断信息，暗示它"差一点就能改"，而真正该做的是先 read。
      // normalized 与 exact 同权：它是同一段原文的字符级归一（长度不变），不是近似匹配，
      // 所以不改变「未读文件只能精确改」的边界；事件层再把它和 exact 分开统计。
      if (deferUnreadCheck && this.tracker) {
        if (result.strategy !== "exact" && result.strategy !== "normalized") {
          return {
            output: `错误: ${this.tracker.rejectUnread(filePath, "edit", result.strategy)}`,
            isError: true,
          };
        }
        this.tracker.noteUnreadExactEdit();
      }

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
      // P1-8：私有 / agent 记忆同判据（出口二：常规替换）。
      // 比的是 `finalContent`（替换后的整份内容）而非 `newString`：凭证可能是
      // 被替换进来的那一段之外的内容——但那属于「文件本来就有」，
      // 与 team 那道守卫的口径保持一致，不在这里另立判据。
      const privErr = checkPrivateMemSecrets(filePath, finalContent);
      if (privErr) {
        return { output: `错误: ${privErr}`, isError: true };
      }

      // D1：写盘**之前**在 IDE 里协商最终内容。这是一次阻塞的内容协商而非展示——
      // 用户在 diff 视图里手改后保存时，该落盘的是**用户改过的版本**。
      const { negotiateContentViaIDE } = await import("../ide/tool-hooks.ts");
      const negotiated = await negotiateContentViaIDE(filePath, rawContent, finalContent);
      if (!negotiated.proceed) {
        return { output: `已取消: ${negotiated.reason}`, isError: true };
      }
      // 用户改过时以用户版本为准；secret 守卫已在上方对 finalContent 校验过，
      // 用户版本是人当面写的、且不经模型，不再重复拦（守卫针对的是模型误写）。
      finalContent = negotiated.content;

      await Bun.write(filePath, finalContent);
      // P1-11：记忆文件被改过 ⇒ 推进缓存代数（非记忆路径 no-op）
      afterMemoryFileWrite(filePath);

      if (this.tracker) {
        // 传入新内容，让 tracker 刷新内容快照 —— 否则下次 edit 的外部修改内容比对
        // 会拿旧内容比对，把自己刚写的内容误判为外部修改。
        this.tracker.updateMtime(filePath, finalContent);

        // 声明文件编辑意图（并发冲突检测）
        if (this.tracker.sessionId && this.tracker.pid && this.tracker.cwd) {
          const { declareFileIntent } = await import("../session/file-intent.ts");
          declareFileIntent(
            this.tracker.sessionId,
            this.tracker.pid,
            this.tracker.cwd,
            filePath,
            "edit",
            this.tracker.parentSessionId,
          );
        }
      }

      // 宽进命中进事件（T3）：只记可聚合量，不记 old/new 原文与文件路径
      //（原文已在 messages 里，重复落盘只放大轨迹体积；file_ext 足够回答「哪类文件最容易触发」）。
      // exact 不记——它是绝大多数，分母从 tool_use 计数取即可。
      if (result.strategy !== "exact") {
        emitEditLenientMatch({
          strategy: result.strategy,
          file_ext: extname(filePath).replace(/^\./, ""),
          old_len: oldString.length,
          occurrences: result.occurrences,
          replace_all: replaceAll,
          ...(result.matchStartLine !== undefined
            ? { match_start_line: result.matchStartLine }
            : {}),
          ...(result.matchEndLine !== undefined ? { match_end_line: result.matchEndLine } : {}),
          ...(result.similarity !== undefined
            ? { similarity: Number(result.similarity.toFixed(4)) }
            : {}),
        });
      }

      const strategyNote =
        result.strategy !== "exact" ? `，使用${this.strategyLabel(result.strategy)}匹配` : "";
      log.info("TOOL", `✓ 编辑 ${filePath} 完成 (${result.occurrences}处${strategyNote})`);

      // 结构化 diff 直传 UI 渲染(独立于回传 LLM 的文本);给 LLM 的 output 仅一句话摘要,
      // 不再拼接完整 diff —— 对标 claude-code 省 token,且大文件 diff 不受 content 压缩影响。
      return {
        output:
          `文件已编辑: ${filePath}（替换了 ${result.occurrences} 处${strategyNote}）` +
          (negotiated.userEdited ? "（采用了你在 IDE 中修改后的内容）" : "") +
          conflictNote +
          mainRepoWriteHint(filePath),
        structuredPatch: buildStructuredPatch(filePath, rawContent, finalContent),
      };
    } catch (err: any) {
      return { output: `编辑文件失败: ${err.message}`, isError: true };
    }
  }

  private strategyLabel(strategy: MatchStrategy | "none"): string {
    const labels: Record<string, string> = {
      normalized: "归一化",
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
