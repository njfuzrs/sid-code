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

/** 从工具调用结果中提取证据（自动，无需模型配合） */
export function collectEvidence(
  toolName: string,
  toolResult: string,
  turn: number,
): EvidenceEntry | null {
  // Bash 命令输出：提取关键结果行
  if (toolName === "bash" || toolName === "Bash") {
    // 测试结果模式
    if (hasTestPattern(toolResult)) {
      const entry: EvidenceEntry = {
        turn,
        timestamp: Date.now(),
        type: "test_result",
        summary: extractTestSummary(toolResult),
        raw: truncate(toolResult, 2000),
      };
      log.debug(
        "GOAL_EVIDENCE",
        `提取证据: type=${entry.type}, tool=${toolName}, summary=${entry.summary.slice(0, 100)}`,
      );
      return entry;
    }
    // 构建结果模式
    if (hasBuildPattern(toolResult)) {
      const entry: EvidenceEntry = {
        turn,
        timestamp: Date.now(),
        type: "build_result",
        summary: extractBuildSummary(toolResult),
        raw: truncate(toolResult, 2000),
      };
      log.debug(
        "GOAL_EVIDENCE",
        `提取证据: type=${entry.type}, tool=${toolName}, summary=${entry.summary.slice(0, 100)}`,
      );
      return entry;
    }
    // 其他有内容的命令输出
    const lines = toolResult.split("\n").filter((l) => l.trim().length > 0);
    if (lines.length > 0) {
      const entry: EvidenceEntry = {
        turn,
        timestamp: Date.now(),
        type: "command_output",
        summary: lines.slice(-3).join(" | ").slice(0, 500),
        raw: truncate(toolResult, 2000),
      };
      log.debug(
        "GOAL_EVIDENCE",
        `提取证据: type=${entry.type}, tool=${toolName}, summary=${entry.summary.slice(0, 100)}`,
      );
      return entry;
    }
  }

  // 文件写入操作
  if (toolName === "Write" || toolName === "Edit") {
    const entry: EvidenceEntry = {
      turn,
      timestamp: Date.now(),
      type: "file_change",
      summary: `文件修改: ${extractFilePath(toolResult)}`,
    };
    log.debug(
      "GOAL_EVIDENCE",
      `提取证据: type=${entry.type}, tool=${toolName}, summary=${entry.summary.slice(0, 100)}`,
    );
    return entry;
  }

  return null;
}

/** 从一轮的所有工具调用结果中批量提取证据 */
export function collectEvidenceFromTurn(
  toolResults: Array<{ toolName: string; result: string }>,
  turn: number,
): EvidenceEntry[] {
  const entries: EvidenceEntry[] = [];
  for (const { toolName, result } of toolResults) {
    const entry = collectEvidence(toolName, result, turn);
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

function hasBuildPattern(output: string): boolean {
  return /\b(build|compile|tsc|error TS|esbuild|webpack|vite|rollup)\b/i.test(output);
}

// ─── 摘要提取 ───

function extractTestSummary(output: string): string {
  const lines = output.split("\n");
  // 尝试找到汇总行（如 "42 tests passed, 2 failures"）
  const summaryPatterns = [
    /\d+\s*(test|spec|suite).*?(pass|fail|skip)/i,
    /(pass|fail|error).*?\d+/i,
    /Tests?:.*?\d+/i,
    /✓.*?\d+|✗.*?\d+|●.*?\d+/,
  ];

  for (const line of lines.reverse()) {
    for (const pattern of summaryPatterns) {
      if (pattern.test(line)) {
        return line.trim().slice(0, 500);
      }
    }
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
