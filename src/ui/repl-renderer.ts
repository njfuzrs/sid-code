/**
 * REPL 模式渲染器
 * 集中所有 REPL 模式的 UI 渲染逻辑：欢迎信息、工具调用展示、权限确认、
 * spinner、流式 Markdown 渲染、完成摘要
 */

import type { Config } from "../config/config.ts";
import type { SessionState } from "../session/state.ts";
import type { Manager as ContextManager } from "../context/manager.ts";
import { renderMarkdown } from "./markdown.ts";

// ANSI 颜色码
const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  gray: "\x1b[90m",
  white: "\x1b[37m",
  blue: "\x1b[34m",
} as const;

/** 格式化耗时：<1s 显示 XXms，>=1s 显示 X.Xs */
function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** 格式化文件大小 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  return `${(bytes / 1024).toFixed(1)}KB`;
}

/** 缩短路径（用 ~ 替代 home 目录） */
function shortenPath(p: string): string {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  if (home && p.startsWith(home)) {
    return "~" + p.slice(home.length);
  }
  return p;
}

/** 从工具输入中提取文件路径 */
function extractFilePath(input: any): string {
  return input?.file_path || input?.filePath || input?.path || "";
}

/** 从工具输入中提取摘要信息 */
function extractToolSummary(toolName: string, input: any): string {
  const lower = toolName.toLowerCase();

  if (lower === "read") {
    const fp = extractFilePath(input);
    const offset = input?.offset;
    const limit = input?.limit;
    let suffix = "";
    if (offset && limit) suffix = ` (行 ${offset}-${offset + limit})`;
    else if (offset) suffix = ` (从行 ${offset})`;
    else if (limit) suffix = ` (前 ${limit} 行)`;
    return `${C.cyan}${shortenPath(fp)}${C.reset}${suffix}`;
  }

  if (lower === "edit") {
    const fp = extractFilePath(input);
    return `${C.cyan}${shortenPath(fp)}${C.reset}`;
  }

  if (lower === "write") {
    const fp = extractFilePath(input);
    return `${C.cyan}${shortenPath(fp)}${C.reset}`;
  }

  if (lower === "bash") {
    const cmd = input?.command || "";
    const desc = input?.description || "";
    const short = cmd.length > 60 ? cmd.slice(0, 57) + "..." : cmd;
    const parts = [`${C.dim}${short}${C.reset}`];
    if (desc) parts.push(`${C.gray}"${desc}"${C.reset}`);
    return parts.join(" ");
  }

  if (lower === "grep") {
    const pattern = input?.pattern || "";
    const glob = input?.glob || input?.include || "";
    const path = input?.path || "";
    const parts = [`${C.yellow}"${pattern}"${C.reset}`];
    if (glob) parts.push(`in ${C.cyan}${glob}${C.reset}`);
    else if (path) parts.push(`in ${C.cyan}${shortenPath(path)}${C.reset}`);
    return parts.join(" ");
  }

  if (lower === "glob") {
    const pattern = input?.pattern || "";
    const path = input?.path || "";
    const parts = [`${C.cyan}${pattern}${C.reset}`];
    if (path) parts.push(`in ${C.cyan}${shortenPath(path)}${C.reset}`);
    return parts.join(" ");
  }

  // SubAgent / Skill / 自定义 Agent
  if (lower.startsWith("subagent") || lower.startsWith("agent__") || lower.startsWith("skill__")) {
    const agentType = input?.type || input?.agentType || "";
    const prompt = input?.prompt || input?.task || "";
    const short = prompt.length > 40 ? prompt.slice(0, 37) + "..." : prompt;
    const parts: string[] = [];
    if (agentType) parts.push(`${C.cyan}${agentType}${C.reset}`);
    if (short) parts.push(`${C.dim}"${short}"${C.reset}`);
    return parts.join(" ");
  }

  // 通用：显示 JSON 摘要
  const json = JSON.stringify(input);
  if (json.length > 80) return `${C.dim}${json.slice(0, 77)}...${C.reset}`;
  return `${C.dim}${json}${C.reset}`;
}

/** 从工具结果中提取完成摘要 */
function extractResultSummary(toolName: string, input: any, output: string, isError: boolean): string {
  const lower = toolName.toLowerCase();

  if (isError) {
    const short = output.length > 80 ? output.slice(0, 77) + "..." : output;
    return `${C.red}${short}${C.reset}`;
  }

  if (lower === "read") {
    const fp = extractFilePath(input);
    const lines = output.split("\n").length;
    return `${C.cyan}${shortenPath(fp)}${C.reset} ${lines} 行`;
  }

  if (lower === "edit") {
    const fp = extractFilePath(input);
    return `${C.cyan}${shortenPath(fp)}${C.reset} 替换完成`;
  }

  if (lower === "write") {
    const fp = extractFilePath(input);
    const size = formatSize(output.length);
    return `${C.cyan}${shortenPath(fp)}${C.reset} ${size}`;
  }

  if (lower === "bash") {
    // 尝试提取退出码
    const exitMatch = output.match(/exit code[:\s]*(\d+)/i);
    if (exitMatch) return `退出码 ${exitMatch[1]}`;
    const lines = output.split("\n").length;
    return `${lines} 行输出`;
  }

  if (lower === "grep") {
    const lines = output.trim().split("\n").filter(l => l.length > 0);
    return `找到 ${lines.length} 个结果`;
  }

  if (lower === "glob") {
    const lines = output.trim().split("\n").filter(l => l.length > 0);
    return `找到 ${lines.length} 个文件`;
  }

  if (lower.startsWith("subagent") || lower.startsWith("agent__") || lower.startsWith("skill__")) {
    return "完成";
  }

  return `${output.length} 字符`;
}

export class REPLRenderer {
  // Spinner 状态
  private spinnerTimer: ReturnType<typeof setInterval> | null = null;
  private spinnerFrameIdx = 0;
  private readonly spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

  // 流式渲染：累积全部文本，flush 时用 markdown 渲染替换原始输出
  private fullStreamText = "";

  /** 渲染欢迎信息 */
  renderWelcome(_config: Config, _toolCount: number, _cwd: string, _gitBranch?: string): void {
    const w = process.stdout.columns || 80;

    const logoLines = [
      "   _____ _     _     _____          _      ",
      "  / ____(_)   | |   / ____|        | |     ",
      " | (___  _  __| |  | |     ___   __| | ___ ",
      "  \\___ \\| |/ _` |  | |    / _ \\ / _` |/ _ \\",
      "  ____) | | (_| |  | |___| (_) | (_| |  __/",
      " |_____/|_|\\__,_|   \\_____\\___/ \\__,_|\\___|",
    ];

    // 边框撑满窗口，左右各留 2 列 margin
    const margin = 2;
    const boxInner = w - margin * 2 - 2;
    const indent = " ".repeat(margin);

    const topLine = `${indent}${C.cyan}╭${"─".repeat(boxInner)}╮${C.reset}`;
    const botLine = `${indent}${C.cyan}╰${"─".repeat(boxInner)}╯${C.reset}`;
    const emptyLine = `${indent}${C.cyan}│${C.reset}${" ".repeat(boxInner)}${C.cyan}│${C.reset}`;

    const centerLine = (colored: string, visLen: number): string => {
      const pad = boxInner - visLen;
      const left = Math.floor(Math.max(0, pad) / 2);
      const right = Math.max(0, pad - left);
      return `${indent}${C.cyan}│${C.reset}${" ".repeat(left)}${colored}${" ".repeat(right)}${C.cyan}│${C.reset}`;
    };

    process.stdout.write("\n");
    process.stdout.write(`${topLine}\n`);
    process.stdout.write(`${emptyLine}\n`);

    for (const line of logoLines) {
      const colored = `${C.cyan}${C.bold}${line}${C.reset}`;
      process.stdout.write(`${centerLine(colored, line.length)}\n`);
    }

    process.stdout.write(`${emptyLine}\n`);

    const version = "v0.1.0  ·  AI-Powered Coding Assistant";
    process.stdout.write(`${centerLine(`${C.dim}${version}${C.reset}`, version.length)}\n`);

    process.stdout.write(`${emptyLine}\n`);

    const hint = "输入消息开始对话，或 /help 查看命令";
    // 中文占 2 列宽
    const hintVisLen = [...hint].reduce((w, ch) => {
      const c = ch.codePointAt(0)!;
      return w + ((c >= 0x4E00 && c <= 0x9FFF) || (c >= 0x3000 && c <= 0x303F) || (c >= 0xFF00 && c <= 0xFFEF) ? 2 : 1);
    }, 0);
    process.stdout.write(`${centerLine(`${C.dim}${hint}${C.reset}`, hintVisLen)}\n`);

    process.stdout.write(`${emptyLine}\n`);
    process.stdout.write(`${botLine}\n\n`);
  }

  /** 渲染工具开始执行 */
  renderToolStart(toolName: string, input: unknown): void {
    const summary = extractToolSummary(toolName, input);
    process.stderr.write(`\n  ${C.yellow}●${C.reset} ${C.bold}${toolName}${C.reset} ${summary}\n`);
  }

  /** 渲染工具执行结果 */
  renderToolResult(toolName: string, input: unknown, output: string, isError: boolean, elapsedMs: number): void {
    const icon = isError ? `${C.red}✗${C.reset}` : `${C.green}✓${C.reset}`;
    const summary = extractResultSummary(toolName, input, output, isError);
    const elapsed = `${C.dim}(${formatElapsed(elapsedMs)})${C.reset}`;
    process.stderr.write(`  ${icon} ${C.bold}${toolName}${C.reset} ${summary} ${elapsed}\n`);
  }

  /** 格式化权限请求 */
  formatPermissionRequest(toolName: string, input: unknown): string {
    const lines: string[] = [];
    const boxWidth = 52;
    const topLine = `┌ 权限请求 ${"─".repeat(boxWidth - 12)}┐`;
    const bottomLine = `└${"─".repeat(boxWidth - 2)}┘`;

    lines.push(`\n${C.yellow}${topLine}${C.reset}`);
    lines.push(`${C.yellow}│${C.reset}  工具: ${C.bold}${toolName}${C.reset}${" ".repeat(Math.max(0, boxWidth - 10 - toolName.length))}${C.yellow}│${C.reset}`);

    // 按工具类型显示关键参数
    const lower = toolName.toLowerCase();
    if (lower === "bash") {
      const cmd = (input as any)?.command || "";
      const short = cmd.length > 38 ? cmd.slice(0, 35) + "..." : cmd;
      lines.push(`${C.yellow}│${C.reset}  命令: ${C.cyan}${short}${C.reset}${" ".repeat(Math.max(0, boxWidth - 10 - short.length))}${C.yellow}│${C.reset}`);
    } else if (lower === "edit") {
      const fp = extractFilePath(input);
      const short = shortenPath(fp);
      const displayPath = short.length > 38 ? short.slice(0, 35) + "..." : short;
      lines.push(`${C.yellow}│${C.reset}  文件: ${C.cyan}${displayPath}${C.reset}${" ".repeat(Math.max(0, boxWidth - 10 - displayPath.length))}${C.yellow}│${C.reset}`);
      // 显示简化 diff（前 3 行）
      const oldStr = (input as any)?.old_string || (input as any)?.oldString || "";
      const newStr = (input as any)?.new_string || (input as any)?.newString || "";
      if (oldStr || newStr) {
        const oldLines = oldStr.split("\n").slice(0, 3);
        const newLines = newStr.split("\n").slice(0, 3);
        lines.push(`${C.yellow}│${C.reset}  ${C.red}- ${oldLines[0] || ""}${C.reset}${" ".repeat(Math.max(0, boxWidth - 6 - (oldLines[0] || "").length))}${C.yellow}│${C.reset}`);
        lines.push(`${C.yellow}│${C.reset}  ${C.green}+ ${newLines[0] || ""}${C.reset}${" ".repeat(Math.max(0, boxWidth - 6 - (newLines[0] || "").length))}${C.yellow}│${C.reset}`);
      }
    } else if (lower === "write") {
      const fp = extractFilePath(input);
      const short = shortenPath(fp);
      const displayPath = short.length > 38 ? short.slice(0, 35) + "..." : short;
      lines.push(`${C.yellow}│${C.reset}  文件: ${C.cyan}${displayPath}${C.reset}${" ".repeat(Math.max(0, boxWidth - 10 - displayPath.length))}${C.yellow}│${C.reset}`);
    } else {
      const json = JSON.stringify(input);
      const short = json.length > 38 ? json.slice(0, 35) + "..." : json;
      lines.push(`${C.yellow}│${C.reset}  参数: ${C.dim}${short}${C.reset}${" ".repeat(Math.max(0, boxWidth - 10 - short.length))}${C.yellow}│${C.reset}`);
    }

    lines.push(`${C.yellow}${bottomLine}${C.reset}`);
    return lines.join("\n");
  }

  /** 启动 spinner（写到 stderr 避免干扰管道） */
  startSpinner(label: string): void {
    this.stopSpinner();
    this.spinnerFrameIdx = 0;
    this.spinnerTimer = setInterval(() => {
      const frame = this.spinnerFrames[this.spinnerFrameIdx % this.spinnerFrames.length];
      process.stderr.write(`\r  ${C.cyan}${frame}${C.reset} ${C.dim}${label}${C.reset}`);
      this.spinnerFrameIdx++;
    }, 80);
  }

  /** 停止 spinner */
  stopSpinner(): void {
    if (this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = null;
      // 清除 spinner 行
      process.stderr.write("\r\x1b[K");
    }
  }

  /** 渲染完成摘要（dim 色，不抢视觉焦点） */
  renderCompletionSummary(
    turns: number,
    sessionState: SessionState,
    ctxMgr: ContextManager,
    toolCount: number,
  ): void {
    const usage = sessionState.getTotalUsage();
    const inputK = usage.inputTokens > 1000
      ? `${(usage.inputTokens / 1000).toFixed(1)}K`
      : `${usage.inputTokens}`;
    const outputK = usage.outputTokens > 1000
      ? `${(usage.outputTokens / 1000).toFixed(1)}K`
      : `${usage.outputTokens}`;
    const cost = sessionState.totalCostUSD > 0
      ? `$${sessionState.totalCostUSD.toFixed(4)}`
      : "$0";
    const ctxUsed = ctxMgr.estimateTokens(toolCount);
    const ctxMax = 200000;
    const ctxPct = Math.round((ctxUsed / ctxMax) * 100);

    process.stdout.write(
      `\n${C.dim}  ─ ${turns} 轮 | ${inputK}↓ ${outputK}↑ tokens | ${cost} | 上下文 ${ctxPct}% ─${C.reset}\n`,
    );
  }

  /** 流式文本：接收增量文本块 */
  renderStreamChunk(text: string): void {
    this.fullStreamText += text;
    // 原样输出到 stdout，保证用户能实时看到生成的文本
    process.stdout.write(text);
  }

  /** 刷新流式缓冲区：用 markdown 渲染结果替换原始输出 */
  flushStream(): void {
    if (this.fullStreamText.length === 0) return;

    // 计算原始输出占用的可视行数（考虑 CJK 双宽字符和终端折行）
    const termWidth = process.stdout.columns || 80;
    const rawLines = this.fullStreamText.split("\n");
    let visualLineCount = 0;
    for (const line of rawLines) {
      let lineWidth = 0;
      for (const ch of line) {
        const code = ch.codePointAt(0)!;
        // CJK 字符占 2 列宽
        if (
          (code >= 0x4E00 && code <= 0x9FFF) || (code >= 0x3000 && code <= 0x303F) ||
          (code >= 0xFF00 && code <= 0xFFEF) || (code >= 0x3400 && code <= 0x4DBF) ||
          (code >= 0x20000 && code <= 0x2A6DF) || (code >= 0xF900 && code <= 0xFAFF) ||
          (code >= 0x3040 && code <= 0x309F) || (code >= 0x30A0 && code <= 0x30FF) ||
          (code >= 0xAC00 && code <= 0xD7AF)
        ) {
          lineWidth += 2;
        } else {
          lineWidth += 1;
        }
      }
      visualLineCount += Math.max(1, Math.ceil(lineWidth / termWidth));
    }

    // 光标回退到原始输出起始位置，清除原始文本
    const goBack = visualLineCount - 1;
    if (goBack > 0) {
      process.stdout.write(`\x1b[${goBack}A`); // 向上移动 N 行
    }
    process.stdout.write("\r\x1b[J"); // 回到行首 + 清除到屏幕底部

    // 用完整的 markdown 渲染结果替换
    try {
      const rendered = renderMarkdown(this.fullStreamText);
      process.stdout.write(rendered);
    } catch {
      process.stdout.write(this.fullStreamText);
    }

    this.fullStreamText = "";
  }

  /** 重置流式状态（每次新对话前调用） */
  resetStream(): void {
    this.fullStreamText = "";
  }
}
