/**
 * 斜杠命令解析器
 *
 * 职责：
 * 1. 从用户输入中提取命令名和参数
 * 2. 区分命令和文件路径（/var/log 不是命令）
 * 3. 识别 MCP 命令标记
 *
 * 从 UI 层（App.tsx handleSubmit）下沉的解析逻辑，使其可独立测试。
 */

export interface ParsedSlashCommand {
  /** 命令名（含子命令路径前的第一段，如 "mcp"） */
  commandName: string;
  /** 命令名之后的参数字符串 */
  args: string;
  /** 是否为 MCP 命令格式 /command (MCP) */
  isMcp: boolean;
}

export function parseSlashCommand(input: string): ParsedSlashCommand | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;

  const withoutSlash = trimmed.slice(1);
  const words = withoutSlash.split(/\s+/);
  if (words.length === 0 || !words[0]) return null;

  let commandName = words[0];
  let isMcp = false;
  let argsStartIndex = 1;

  // 检测 MCP 命令格式: /command (MCP) args
  if (words.length > 1 && words[1] === "(MCP)") {
    commandName = commandName + " (MCP)";
    isMcp = true;
    argsStartIndex = 2;
  }

  const args = words.slice(argsStartIndex).join(" ");
  return { commandName, args, isMcp };
}

/**
 * 判断一个字符串是否"看起来像"命令名
 * 命令名只包含字母、数字、冒号、连字符和下划线
 * 包含 / 的（如 var/log）是文件路径，不是命令
 */
export function looksLikeCommand(name: string): boolean {
  return /^[a-zA-Z0-9:\-_]+$/.test(name);
}

/**
 * 检查输入是否为以 / 开头的绝对文件路径（异步，需要文件系统访问）
 * 用于区分 /var/log/syslog 这类路径与命令
 */
export async function isFilePath(name: string): Promise<boolean> {
  try {
    const fs = await import("node:fs/promises");
    await fs.stat(`/${name}`);
    return true;
  } catch {
    return false;
  }
}
