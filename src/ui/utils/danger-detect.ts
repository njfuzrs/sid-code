/**
 * TUI 权限确认框的「危险操作」判定（对标 cc 的 destructiveCommandWarning）。
 *
 * 复用工具层 `isDestructiveCommand`（仅覆盖删根/删家目录/磁盘擦除等 critical 核心），
 * 在 UI 侧额外补充日常高频的破坏性命令模式（rm -rf、git reset --hard、git clean -fd、
 * drop table、批量 kill 等），让确认框能对这些操作标红 + 仪式感文案 + 安全默认。
 *
 * 仅做「展示差异化」用途，不替代权限系统的实际拦截决策（那在 src/permission/checker.ts）。
 */

import { isDestructiveCommand } from "../../tool/bash/read-only-validation.ts";

/** UI 侧补充的破坏性命令模式（核心 isDestructiveCommand 未覆盖的日常高频项） */
const UI_DESTRUCTIVE_PATTERNS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /\brm\s+(-\w*\s+)*-?\w*[rf]/i, label: "递归/强制删除文件" },
  { pattern: /\bgit\s+reset\s+--hard/i, label: "丢弃所有本地改动 (git reset --hard)" },
  { pattern: /\bgit\s+clean\s+-\w*[fd]/i, label: "删除未跟踪文件 (git clean)" },
  { pattern: /\bgit\s+push\s+.*(--force|-f)\b/i, label: "强制推送 (git push --force)" },
  { pattern: /\b(drop|truncate)\s+(table|database)\b/i, label: "删除数据库表/库" },
  { pattern: /\bkill(all)?\s+(-9\s+)?-?\w/i, label: "批量终止进程" },
  { pattern: />\s*\/dev\/sd/i, label: "写入块设备" },
  { pattern: /\bchmod\s+-R\b/i, label: "递归修改权限" },
];

export interface DangerVerdict {
  /** 是否为破坏性命令 */
  isDangerous: boolean;
  /** 命中的危险描述（用于确认框标红提示），非危险时为空 */
  label: string;
}

/** 判定单条命令字符串是否破坏性，并返回命中的描述。 */
export function inspectCommand(command: string): DangerVerdict {
  if (!command) return { isDangerous: false, label: "" };
  // 先走工具层 critical 检测
  if (isDestructiveCommand(command)) {
    return { isDangerous: true, label: "高危系统操作" };
  }
  for (const { pattern, label } of UI_DESTRUCTIVE_PATTERNS) {
    if (pattern.test(command)) return { isDangerous: true, label };
  }
  return { isDangerous: false, label: "" };
}

/** 从工具调用（toolName + toolInput）判定是否破坏性。 */
export function inspectToolCall(toolName: string, toolInput: unknown): DangerVerdict {
  const input = toolInput as Record<string, unknown> | null | undefined;
  // 仅对会执行 shell 命令的工具检命令字符串（bash / shell 等）
  const isShellTool = /bash|shell|exec|command/i.test(toolName);
  const command = typeof input?.command === "string" ? input.command : "";
  if (isShellTool && command) {
    const verdict = inspectCommand(command);
    if (verdict.isDangerous) return verdict;
  }
  return { isDangerous: false, label: "" };
}
