/**
 * Evidence Collector — 从工具结果自动提取证据
 *
 * Evidence Log 在 queryLoop 中通过工具结果拦截自动收集，无需模型主动汇报。
 * 这是 sid-code 超越 Claude Code 和 Codex 的关键设计：
 * - Claude Code：评估者看完整 transcript → 长任务时 transcript 巨大，小模型容易漏关键信息
 * - Codex：靠模型自我汇报（update_goal tool）→ 模型可能忘记汇报或虚报
 * - sid-code：自动从工具结果中提取证据，不依赖模型配合，也不受 Compact 影响
 */

import type { EvidenceEntry } from "./state.ts";
import { getLogger } from "../debug/logger.ts";

const log = getLogger();

/** 采集时的附加信号（取自 tool_result 块本身，不靠解析输出文本猜） */
export interface EvidenceSignals {
  /**
   * 该工具调用是否失败（tool_result.is_error）。
   *
   * F2（2026-09-03）：fast-path 判「测试是否通过」原先只看输出文本里有没有 `0 fail`，
   * 而**测试是否通过本质由退出码定义，不由输出文本定义**。bash 工具在退出码非 0
   * 且语义上确属错误时会置 is_error（grep 无匹配那类非 0 已被 interpretExitCode 排除），
   * 把它带进证据里，fast-path 就有了一个不依赖文本形态的硬前提。
   */
  isError?: boolean;
}

/**
 * summary 的最小信息量门槛（去掉空白与标点后的字符数）。
 *
 * F7：`cat package.json` 曾被记成一条 build_result，summary 是 `"  } | }"`。
 * 这种条目无论 type 对不对都没有证据价值，留着只会挤占评估器「最近 20 条」的窗口，
 * 把真实的测试结果挤出视野。
 */
const MIN_SUMMARY_SIGNAL_CHARS = 3;

/** 从工具调用结果中提取证据（自动，无需模型配合） */
export function collectEvidence(
  toolName: string,
  toolResult: string,
  turn: number,
  signals?: EvidenceSignals,
): EvidenceEntry | null {
  const errorFlag = signals?.isError === true ? { isError: true as const } : {};

  // Bash 命令输出：提取关键结果行
  if (toolName === "bash" || toolName === "Bash") {
    // 测试结果模式
    if (hasTestPattern(toolResult)) {
      return finalize(
        {
          turn,
          timestamp: Date.now(),
          type: "test_result",
          summary: extractTestSummary(toolResult),
          raw: truncate(toolResult, 2000),
          ...errorFlag,
        },
        toolName,
      );
    }
    // 构建结果模式
    if (hasBuildPattern(toolResult)) {
      return finalize(
        {
          turn,
          timestamp: Date.now(),
          type: "build_result",
          summary: extractBuildSummary(toolResult),
          raw: truncate(toolResult, 2000),
          ...errorFlag,
        },
        toolName,
      );
    }
    // 其他有内容的命令输出
    const lines = toolResult.split("\n").filter((l) => l.trim().length > 0);
    if (lines.length > 0) {
      return finalize(
        {
          turn,
          timestamp: Date.now(),
          type: "command_output",
          summary: lines.slice(-3).join(" | ").slice(0, 500),
          raw: truncate(toolResult, 2000),
          ...errorFlag,
        },
        toolName,
      );
    }
  }

  // 文件写入操作
  if (toolName === "Write" || toolName === "Edit") {
    return finalize(
      {
        turn,
        timestamp: Date.now(),
        type: "file_change",
        summary: `文件修改: ${extractFilePath(toolResult)}`,
        ...errorFlag,
      },
      toolName,
    );
  }

  return null;
}

/**
 * 出口统一把关：summary 无信息量的条目直接丢弃（F7 方案 C）。
 *
 * 放在这里而不是各分支里，是为了「新增证据类型时不会漏掉这道过滤」。
 */
function finalize(entry: EvidenceEntry, toolName: string): EvidenceEntry | null {
  if (!hasSignal(entry.summary)) {
    log.debug(
      "GOAL_EVIDENCE",
      `丢弃无信息量证据: type=${entry.type}, tool=${toolName}, summary=${JSON.stringify(entry.summary)}`,
    );
    return null;
  }
  log.debug(
    "GOAL_EVIDENCE",
    `提取证据: type=${entry.type}, tool=${toolName}, summary=${entry.summary.slice(0, 100)}`,
  );
  return entry;
}

/** summary 去掉空白与纯结构标点后是否还剩下足够字符 */
function hasSignal(summary: string): boolean {
  const stripped = summary.replace(/[\s|{}[\]()<>,;:'"`.-]/g, "");
  return stripped.length >= MIN_SUMMARY_SIGNAL_CHARS;
}

/** 批量从一轮的所有工具调用结果中提取证据 */
export function collectEvidenceFromTurn(
  toolResults: Array<{ toolName: string; result: string; isError?: boolean }>,
  turn: number,
): EvidenceEntry[] {
  const entries: EvidenceEntry[] = [];
  for (const { toolName, result, isError } of toolResults) {
    const entry = collectEvidence(toolName, result, turn, { isError });
    if (entry) {
      entries.push(entry);
    }
  }
  return entries;
}

// ─── 模式检测 ───

function hasTestPattern(output: string): boolean {
  return (
    /\b(pass|fail|error|test|spec|assert)\b/i.test(output) && /\d+\s*(pass|fail|test)/i.test(output)
  );
}

/**
 * 构建输出判据：**关键词 + 结果形态**双重条件（F7）。
 *
 * 原实现只要输出里出现 `build` 这个词就算构建结果，于是 `cat package.json`
 * （scripts 里有 `"build"`）、`git log`（提交信息提到 build）、`ls` 出含 build 的目录
 * 全部被记成 build_result，summary 是 `"  } | }"` 这类噪音。
 *
 * 对齐 `hasTestPattern` 的形状——它一直有第二道「数字 + 结果词」判据，这里缺了。
 * `error TS\d+` 单独保留：它是 tsc 的强特征，且 `\b...\b` 匹配不到带空格的短语。
 */
function hasBuildPattern(output: string): boolean {
  const hasKeyword = /\b(build|compile|compiled|tsc|esbuild|webpack|vite|rollup)\b/i.test(output);
  if (!hasKeyword) return false;
  const hasOutcome =
    /error TS\d+/i.test(output) ||
    /\d+\s*(error|warning)/i.test(output) ||
    /\b(succeeded|success|successful|done|built|compiled|failed|failure)\b/i.test(output) ||
    /\bbuil(t|ding) in\b/i.test(output);
  return hasOutcome;
}

// ─── 摘要提取 ───

/**
 * 汇总行数量上限。
 *
 * F2 的治根改动：不再「取第一个命中的汇总行」，而是保留**全部**汇总行。
 * jest / vitest 的两级计数是相邻两行：
 *
 *     Test Suites: 3 failed, 5 passed, 8 total     ← 3 个套件根本没执行
 *     Tests:       0 failed, 120 passed, 120 total ← 跑起来的 120 个全过
 *
 * 旧实现 `lines.reverse()` 后取第一个命中的，于是只留下 `Tests: 0 failed` 那行，
 * 上面真实的失败信号压根没进 summary——fast-path 因此判定"测试全绿"并收尾。
 */
const MAX_SUMMARY_LINES = 3;

function extractTestSummary(output: string): string {
  const lines = output.split("\n");
  // 尝试找到汇总行（如 "42 tests passed, 2 failures"）
  const summaryPatterns = [
    /\d+\s*(test|spec|suite).*?(pass|fail|skip)/i,
    /(pass|fail|error).*?\d+/i,
    /Tests?:.*?\d+/i,
    /✓.*?\d+|✗.*?\d+|●.*?\d+/,
  ];

  // 按原文顺序收集全部命中行，保留至多 MAX_SUMMARY_LINES 条最靠后的
  // （靠后的是汇总，靠前的通常是逐条明细）。
  const matched: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (summaryPatterns.some((p) => p.test(trimmed))) matched.push(trimmed);
  }
  if (matched.length > 0) {
    return matched.slice(-MAX_SUMMARY_LINES).join(" | ").slice(0, 500);
  }

  // 回退：取最后 3 行
  return lines
    .filter((l) => l.trim())
    .slice(-3)
    .join(" | ")
    .slice(0, 500);
}

function extractBuildSummary(output: string): string {
  const lines = output.split("\n");

  // 找错误汇总行
  const errorLine = lines.find((l) => /\d+\s*error/i.test(l) || /error TS\d+/i.test(l));
  if (errorLine) {
    return errorLine.trim().slice(0, 500);
  }

  // 找成功标志
  const successLine = lines.find(
    (l) => /\b(success|done|built|compiled)\b/i.test(l) && !/error/i.test(l),
  );
  if (successLine) {
    return successLine.trim().slice(0, 500);
  }

  // 回退：最后 2 行
  return lines
    .filter((l) => l.trim())
    .slice(-2)
    .join(" | ")
    .slice(0, 500);
}

function extractFilePath(toolResult: string): string {
  // 常见模式："Wrote 42 lines to src/foo.ts" 或 "src/foo.ts"
  const writeMatch = toolResult.match(/(?:to|wrote|created|modified)\s+(\S+\.\w+)/i);
  if (writeMatch) return writeMatch[1]!;

  // 尝试从第一行提取路径
  const firstLine = toolResult.split("\n")[0] ?? "";
  const pathMatch = firstLine.match(/([\w./\-]+\.\w+)/);
  if (pathMatch) return pathMatch[1]!;

  return "(unknown file)";
}

// ─── 工具函数 ───

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  // 保留头尾，中间截断
  const headLen = Math.floor(maxLen * 0.7);
  const tailLen = maxLen - headLen - 20; // 20 for separator
  return text.slice(0, headLen) + "\n...[truncated]...\n" + text.slice(-tailLen);
}
