/**
 * Bash 命令结构化解析器（启发式）
 * 不追求完整的 Bash 语法解析，只处理 90% 的常见命令模式
 * 对于无法解析的复杂命令，回退到正则匹配
 */

/** Bash 命令 AST 节点类型 */
export type BashASTNode =
  | { type: "simple"; command: string; args: string[]; envPrefix?: Record<string, string> }
  | { type: "pipeline"; commands: BashASTNode[] }
  | { type: "sequence"; operator: "&&" | "||" | ";"; commands: BashASTNode[] }
  | { type: "redirect"; target: BashASTNode; file: string; mode: ">" | ">>" | "<" | "2>" }
  | { type: "unknown"; raw: string };

/** 包装命令前缀（需要剥离以获取实际命令） */
const WRAPPER_COMMANDS = new Set([
  "timeout",
  "env",
  "nice",
  "nohup",
  "time",
  "strace",
  "ionice",
  "taskset",
  "chrt",
  "numactl",
]);

/**
 * 解析 Bash 命令为 AST
 */
export function parseBashCommand(command: string): BashASTNode {
  const trimmed = command.trim();
  if (!trimmed) return { type: "simple", command: "", args: [] };

  try {
    // 1. 处理复合命令（&&、||、;）— 在引号外拆分
    const seqParts = splitOutsideQuotes(trimmed, /\s*(&&|\|\||;)\s*/);
    if (seqParts.parts.length > 1) {
      const commands = seqParts.parts.map((p) => parseBashCommand(p));
      return {
        type: "sequence",
        operator: (seqParts.separators[0] || "&&") as "&&" | "||" | ";",
        commands,
      };
    }

    // 2. 处理管道（|）— 在引号外拆分
    const pipeParts = splitOutsideQuotes(trimmed, /\s*\|\s*(?!\|)/);
    if (pipeParts.parts.length > 1) {
      return { type: "pipeline", commands: pipeParts.parts.map((p) => parseBashCommand(p)) };
    }

    // 3. 处理重定向
    const redirectMatch = trimmed.match(/^(.+?)\s+(>>|2>|>)\s*(\S+)\s*$/);
    if (redirectMatch) {
      return {
        type: "redirect",
        target: parseBashCommand(redirectMatch[1]),
        file: unquote(redirectMatch[3]),
        mode: redirectMatch[2] as ">" | ">>" | "2>",
      };
    }

    // 4. 解析简单命令
    return parseSimpleCommand(trimmed);
  } catch {
    return { type: "unknown", raw: trimmed };
  }
}

/**
 * 解析简单命令（无管道、无复合）
 */
function parseSimpleCommand(cmd: string): BashASTNode {
  const tokens = tokenize(cmd);
  if (tokens.length === 0) return { type: "simple", command: "", args: [] };

  // 提取环境变量前缀（VAR=value）
  const envPrefix: Record<string, string> = {};
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) {
    const eqIdx = tokens[i].indexOf("=");
    envPrefix[tokens[i].slice(0, eqIdx)] = tokens[i].slice(eqIdx + 1);
    i++;
  }

  if (i >= tokens.length) {
    // 只有环境变量赋值，没有命令
    return { type: "simple", command: "", args: [], envPrefix };
  }

  // 剥离包装命令（timeout 10 cmd → cmd）
  let command = tokens[i];
  let argsStart = i + 1;

  if (WRAPPER_COMMANDS.has(command)) {
    // 跳过包装命令及其参数
    argsStart = i + 1;
    // timeout 的参数：跳过数字参数和 -k 等选项
    while (argsStart < tokens.length) {
      const arg = tokens[argsStart];
      if (arg.startsWith("-") || /^\d+(\.\d+)?[smhd]?$/.test(arg)) {
        argsStart++;
      } else {
        break;
      }
    }
    if (argsStart < tokens.length) {
      command = tokens[argsStart];
      argsStart++;
    }
  }

  const args = tokens.slice(argsStart);
  const result: BashASTNode = { type: "simple", command, args };
  if (Object.keys(envPrefix).length > 0) {
    (result as any).envPrefix = envPrefix;
  }
  return result;
}

/**
 * 提取命令前缀（用于权限规则匹配）
 * "git commit -m 'fix'" → "git commit"
 * "timeout 10 npm test" → "npm test"
 * "VAR=1 make build"    → "make build"
 */
export function getCommandPrefix(command: string): string {
  const ast = parseBashCommand(command);
  return getFirstCommand(ast);
}

/** 从 AST 中提取第一个实际命令 */
function getFirstCommand(node: BashASTNode): string {
  switch (node.type) {
    case "simple":
      // 对于 git 等多级命令，返回 "git subcommand"
      if (node.args.length > 0 && !node.args[0].startsWith("-")) {
        return `${node.command} ${node.args[0]}`;
      }
      return node.command;
    case "pipeline":
    case "sequence":
      return node.commands.length > 0 ? getFirstCommand(node.commands[0]) : "";
    case "redirect":
      return getFirstCommand(node.target);
    case "unknown":
      return node.raw.split(/\s+/)[0] || "";
  }
}

/**
 * 从 AST 中提取所有重定向目标文件
 */
export function extractRedirectTargets(node: BashASTNode): string[] {
  const targets: string[] = [];
  collectRedirects(node, targets);
  return targets;
}

function collectRedirects(node: BashASTNode, targets: string[]): void {
  switch (node.type) {
    case "redirect":
      if (node.mode === ">" || node.mode === ">>") {
        targets.push(node.file);
      }
      collectRedirects(node.target, targets);
      break;
    case "pipeline":
    case "sequence":
      for (const cmd of node.commands) collectRedirects(cmd, targets);
      break;
    default:
      break;
  }
}

/**
 * 从 AST 中提取所有简单命令节点
 */
export function extractSimpleCommands(
  node: BashASTNode,
): Array<{ command: string; args: string[] }> {
  const commands: Array<{ command: string; args: string[] }> = [];
  collectSimpleCommands(node, commands);
  return commands;
}

function collectSimpleCommands(
  node: BashASTNode,
  out: Array<{ command: string; args: string[] }>,
): void {
  switch (node.type) {
    case "simple":
      if (node.command) out.push({ command: node.command, args: node.args });
      break;
    case "pipeline":
    case "sequence":
      for (const cmd of node.commands) collectSimpleCommands(cmd, out);
      break;
    case "redirect":
      collectSimpleCommands(node.target, out);
      break;
    default:
      break;
  }
}

// ===== 内部工具函数 =====

/**
 * 在引号外按分隔符拆分字符串
 */
function splitOutsideQuotes(
  str: string,
  sepRegex: RegExp,
): { parts: string[]; separators: string[] } {
  const parts: string[] = [];
  const separators: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  let i = 0;

  while (i < str.length) {
    const ch = str[i];

    if (escaped) {
      current += ch;
      escaped = false;
      i++;
      continue;
    }

    if (ch === "\\") {
      escaped = true;
      current += ch;
      i++;
      continue;
    }

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      current += ch;
      i++;
      continue;
    }

    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      current += ch;
      i++;
      continue;
    }

    if (!inSingle && !inDouble) {
      // 尝试匹配分隔符
      const remaining = str.slice(i);
      const match = remaining.match(sepRegex);
      if (match && match.index === 0) {
        parts.push(current);
        separators.push(match[1] || match[0].trim());
        current = "";
        i += match[0].length;
        continue;
      }
    }

    current += ch;
    i++;
  }

  parts.push(current);
  return { parts, separators };
}

/**
 * 简单的 shell 词法分析（处理引号和转义）
 */
function tokenize(cmd: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (ch === "\\" && !inSingle) {
      escaped = true;
      continue;
    }

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }

    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }

    if (/\s/.test(ch) && !inSingle && !inDouble) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += ch;
  }

  if (current) tokens.push(current);
  return tokens;
}

/** 去除引号 */
function unquote(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}
