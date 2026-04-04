/**
 * 只读命令快速路径
 * 判断 Bash 命令是否为纯只读操作，可跳过用户确认
 */

import { parseBashCommand, extractSimpleCommands, extractRedirectTargets } from "./parser.ts";

/** 已知的只读命令 */
const READ_ONLY_COMMANDS = new Set([
  // 文件查看
  "ls", "cat", "head", "tail", "wc", "file", "stat", "du", "df",
  "find", "locate", "which", "whereis", "type", "readlink",
  // 搜索
  "grep", "rg", "ag", "ack", "fgrep", "egrep",
  // Git 只读
  "git", // git 子命令单独检查
  // 版本查询
  "node", "npm", "bun", "deno", "python", "python3", "ruby", "go", "rustc", "cargo",
  "java", "javac", "gcc", "g++", "clang", "make",
  // 系统信息
  "echo", "printf", "date", "whoami", "hostname", "uname",
  "pwd", "env", "printenv", "id", "uptime", "free", "top",
  // 数据处理（无写入）
  "jq", "yq", "sort", "uniq", "cut", "tr", "awk", "sed",
  "diff", "comm", "paste", "column", "tee",
  // 目录
  "tree", "basename", "dirname", "realpath",
  // 网络（只读）
  "ping", "dig", "nslookup", "host", "curl", "wget",
]);

/** 已知的只读 Git 子命令 */
const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  "status", "log", "diff", "show", "branch", "remote", "tag",
  "stash", "describe", "shortlog", "blame", "ls-files",
  "ls-tree", "cat-file", "rev-parse", "rev-list", "config",
  "reflog", "name-rev", "for-each-ref",
]);

/** 已知的危险 Git 子命令 */
const DANGEROUS_GIT_SUBCOMMANDS = new Set([
  "push", "reset", "rebase", "merge", "cherry-pick",
  "clean", "checkout", "restore", "switch", "rm", "mv",
  "commit", "pull", "fetch", "clone", "init", "submodule",
]);

/** 需要特殊处理的命令（看起来只读但可能有副作用） */
const CONDITIONAL_COMMANDS: Record<string, (args: string[]) => boolean> = {
  // sed 只有不带 -i 时才是只读
  sed: (args) => !args.some(a => a === "-i" || a.startsWith("-i") || a === "--in-place"),
  // awk 只有不带重定向时才是只读（重定向在 AST 层处理）
  awk: () => true,
  // tee 总是写文件
  tee: () => false,
  // curl/wget 只有不带 -o/-O 时才是只读
  curl: (args) => !args.some(a => a === "-o" || a === "-O" || a === "--output" || a.startsWith("-o")),
  wget: (args) => !args.some(a => a === "-O" || a === "--output-document" || a.startsWith("-O")),
  // npm/bun 只有特定子命令是只读
  npm: (args) => {
    const sub = args[0];
    return ["list", "ls", "view", "info", "show", "search", "outdated", "audit", "why", "explain"].includes(sub);
  },
  bun: (args) => {
    const sub = args[0];
    return ["--version", "pm", "x"].includes(sub);
  },
};

/**
 * 检查命令是否为只读
 */
export function isReadOnlyCommand(command: string): boolean {
  if (!command.trim()) return true;

  const ast = parseBashCommand(command);

  // 1. 有写入重定向 → 非只读
  const redirectTargets = extractRedirectTargets(ast);
  if (redirectTargets.length > 0) return false;

  // 2. 检查所有子命令
  const simpleCommands = extractSimpleCommands(ast);
  if (simpleCommands.length === 0) return false;

  for (const { command: cmd, args } of simpleCommands) {
    if (!cmd) return false;

    // 条件命令特殊处理
    if (cmd in CONDITIONAL_COMMANDS) {
      if (!CONDITIONAL_COMMANDS[cmd](args)) return false;
      continue;
    }

    // Git 子命令检查
    if (cmd === "git") {
      const subCmd = args[0];
      if (!subCmd) continue; // 裸 git 是只读的
      if (DANGEROUS_GIT_SUBCOMMANDS.has(subCmd)) return false;
      if (!READ_ONLY_GIT_SUBCOMMANDS.has(subCmd)) return false; // 未知子命令默认非只读
      continue;
    }

    // 版本查询快速路径
    if (args.length === 1 && (args[0] === "--version" || args[0] === "-v" || args[0] === "-V")) {
      continue;
    }

    // 检查是否在只读列表中
    if (!READ_ONLY_COMMANDS.has(cmd)) return false;
  }

  return true;
}

/**
 * 检查命令是否为破坏性操作（critical 级别）
 */
export function isDestructiveCommand(command: string): boolean {
  // 递归删除
  if (/rm\s+(-[rf]*\s+)*\/($|\s)/.test(command)) return true;
  if (/rm\s+(-[rf]*\s+)*~/.test(command)) return true;
  // 磁盘操作
  if (/dd\s+if=\/dev\/(zero|random|urandom)/i.test(command)) return true;
  if (/mkfs\./.test(command)) return true;
  // Fork 炸弹
  if (/:()\s*\{.*:\|:.*&.*\}\s*;/.test(command)) return true;
  // 下载并执行
  if (/(curl|wget).*\|\s*(sh|bash|python|perl|ruby)/.test(command)) return true;

  return false;
}
