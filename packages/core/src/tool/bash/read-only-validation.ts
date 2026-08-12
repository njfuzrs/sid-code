/**
 * 只读命令快速路径
 * 判断 Bash 命令是否为纯只读操作，可跳过用户确认
 */

import { parseBashCommand, extractSimpleCommands, extractRedirectTargets } from "./parser.ts";

/** 已知的只读命令 */
const READ_ONLY_COMMANDS = new Set([
  // 文件查看
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "file",
  "stat",
  "du",
  "df",
  "find",
  "locate",
  "which",
  "whereis",
  "type",
  "readlink",
  // 搜索
  "grep",
  "rg",
  "ag",
  "ack",
  "fgrep",
  "egrep",
  // Git 只读
  "git", // git 子命令单独检查
  // 版本查询
  "node",
  "npm",
  "bun",
  "deno",
  "python",
  "python3",
  "ruby",
  "go",
  "rustc",
  "cargo",
  "java",
  "javac",
  "gcc",
  "g++",
  "clang",
  "make",
  // 系统信息
  "echo",
  "printf",
  "date",
  "whoami",
  "hostname",
  "uname",
  "pwd",
  "env",
  "printenv",
  "id",
  "uptime",
  "free",
  "top",
  // 数据处理（无写入）
  "jq",
  "yq",
  "sort",
  "uniq",
  "cut",
  "tr",
  "awk",
  "sed",
  "diff",
  "comm",
  "paste",
  "column",
  "tee",
  // 目录
  "tree",
  "basename",
  "dirname",
  "realpath",
  // 网络（只读）
  "ping",
  "dig",
  "nslookup",
  "host",
  "curl",
  "wget",
]);

/**
 * 已知的只读 Git 子命令。
 *
 * ⚠️ 注意：`config` **不在**此列表——`git config --get x`（读）与 `git config user.email x`（写）
 * 语义完全不同。把整个 config 子命令判只读会让写操作（含 `core.hooksPath` 劫持）被自动放行，
 * 违反「NEVER 更新 git config」安全协议（对齐 CC）。config 的只读判定改由 isReadOnlyGitConfig
 * 按 flag 细分（见下）。
 */
const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  "status",
  "log",
  "diff",
  "show",
  "branch",
  "remote",
  "tag",
  "stash",
  "describe",
  "shortlog",
  "blame",
  "ls-files",
  "ls-tree",
  "cat-file",
  "rev-parse",
  "rev-list",
  "reflog",
  "name-rev",
  "for-each-ref",
]);

/**
 * 判断 `git config` 的参数是否为纯只读形态（P0-1）。
 *
 * 只读：带纯读 flag（`--get`/`--get-all`/`--get-regexp`/`--get-urlmatch`/`--list`/`-l`）
 *       且**无裸 `key value` 写入位置参数**。
 * 写：出现 `--add`/`--unset`/`--unset-all`/`--replace-all`/`--edit`/`-e`/`--rename-section`/
 *     `--remove-section`，或提供了 `key value`（两个及以上位置参数）→ 写，非只读。
 *
 * 保守默认：无法确定时返回 false（当作写操作，落到确认），安全优先。
 *
 * @param args `git config` 之后的参数数组（不含 "git" 与 "config"）
 */
export function isReadOnlyGitConfig(args: string[]): boolean {
  // 写操作 flag —— 命中任一即非只读
  const WRITE_FLAGS = new Set([
    "--add",
    "--unset",
    "--unset-all",
    "--replace-all",
    "--edit",
    "-e",
    "--rename-section",
    "--remove-section",
    "--unset-section",
  ]);
  // 纯读 flag —— 命中即倾向只读（仍需无写入位置参数）
  const READ_FLAGS = new Set([
    "--get",
    "--get-all",
    "--get-regexp",
    "--get-urlmatch",
    "--list",
    "-l",
    "--get-color",
    "--get-colorbool",
  ]);

  let hasReadFlag = false;
  // 作用域 flag（--global/--system/--local/--worktree/--file/-f/--blob）本身不决定读写，
  // 但其后若跟 key value 则是写。逐一扫描，收集非 flag 的位置参数。
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a) continue;
    if (WRITE_FLAGS.has(a)) return false;
    if (READ_FLAGS.has(a)) {
      hasReadFlag = true;
      continue;
    }
    // --file <path> / -f <path> / --blob <blob>：跳过其后紧跟的值参数（不算 key/value）
    if (a === "--file" || a === "-f" || a === "--blob") {
      i++;
      continue;
    }
    // 作用域 flag 与其它 -- 开头选项：跳过
    if (a.startsWith("-")) continue;
    positional.push(a);
  }

  // 有纯读 flag：只读的前提是没有裸 key value 写入。
  //   `--get key`（1 个位置参数=要读的 key）→ 只读；
  //   `--get-regexp pattern` → 只读；
  //   位置参数 ≥ 2 时按写处理（保守）。
  if (hasReadFlag) {
    return positional.length <= 1;
  }

  // 无任何读写 flag：
  //   `git config key`（1 个位置参数）→ 读取该 key（等价隐式 --get）→ 只读；
  //   `git config key value`（≥2 位置参数）→ 写入 → 非只读；
  //   `git config`（0 位置参数，通常配 --list 才有意义，裸跑无效）→ 视为只读。
  return positional.length <= 1;
}

/**
 * 「安全」的 git 全局选项——出现在子命令之前、本身无副作用、剥离后不改变只读语义。
 *
 * 明确**不含** `-c` / `--config-env` / `--exec-path`：它们能注入配置（`core.pager`、
 * `alias.*`、`core.sshCommand`）从而借只读子命令执行任意代码，必须保持「非只读」判定。
 */
const SAFE_GIT_GLOBAL_BOOL_OPTS = new Set([
  "-P",
  "--no-pager",
  "--paginate",
  "--bare",
  "--no-replace-objects",
  "--literal-pathspecs",
  "--glob-pathspecs",
  "--noglob-pathspecs",
  "--icase-pathspecs",
  "--no-optional-locks",
  "--no-lazy-fetch",
  "--no-advice",
]);
/** 安全的带值全局选项（值可能是同 token 的 `--opt=v` 或下一个 token）。 */
const SAFE_GIT_GLOBAL_VALUE_OPTS = new Set(["-C", "--git-dir", "--work-tree", "--namespace"]);

/**
 * 剥离 git 命令**子命令之前**的安全全局选项，返回以子命令开头的参数数组。
 *
 * @param args `git` 之后的全部参数
 * @returns 剥离后的参数数组；遇到不可信全局选项（`-c` 等）返回 `null`（调用方判非只读）
 */
export function stripSafeGitGlobalOptions(args: string[]): string[] | null {
  let i = 0;
  for (; i < args.length; i++) {
    const tok = args[i];
    if (!tok || !tok.startsWith("-")) break; // 到达子命令
    const eq = tok.indexOf("=");
    const name = eq > 0 ? tok.slice(0, eq) : tok;
    if (SAFE_GIT_GLOBAL_VALUE_OPTS.has(name)) {
      if (eq < 0) i++; // 值在下一个 token
      continue;
    }
    if (SAFE_GIT_GLOBAL_BOOL_OPTS.has(name)) continue;
    // `git --version` / `git --help` 等：本身就是「子命令位」的 flag，交给下游判定
    if (name === "--version" || name === "--help" || name === "-v" || name === "-h") break;
    // 其余以 - 开头的全局选项（含 -c / --config-env / --exec-path / 未知项）→ 不可信
    return null;
  }
  return args.slice(i);
}

/** 已知的危险 Git 子命令 */
const DANGEROUS_GIT_SUBCOMMANDS = new Set([
  "push",
  "reset",
  "rebase",
  "merge",
  "cherry-pick",
  "clean",
  "checkout",
  "restore",
  "switch",
  "rm",
  "mv",
  "commit",
  "pull",
  "fetch",
  "clone",
  "init",
  "submodule",
]);

/** 需要特殊处理的命令（看起来只读但可能有副作用） */
const CONDITIONAL_COMMANDS: Record<string, (args: string[]) => boolean> = {
  // sed 只有不带 -i 时才是只读
  sed: (args) => !args.some((a) => a === "-i" || a.startsWith("-i") || a === "--in-place"),
  // awk 只有不带重定向时才是只读（重定向在 AST 层处理）
  awk: () => true,
  // tee 总是写文件
  tee: () => false,
  // curl/wget 只有不带 -o/-O 时才是只读
  curl: (args) =>
    !args.some((a) => a === "-o" || a === "-O" || a === "--output" || a.startsWith("-o")),
  wget: (args) => !args.some((a) => a === "-O" || a === "--output-document" || a.startsWith("-O")),
  // npm/bun 只有特定子命令是只读
  npm: (args) => {
    const sub = args[0];
    return [
      "list",
      "ls",
      "view",
      "info",
      "show",
      "search",
      "outdated",
      "audit",
      "why",
      "explain",
    ].includes(sub);
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
      // git 允许在子命令前插入全局选项（`git -C dir log`、`git --no-pager diff`）。
      // 不剥离会把 "-C" 当子命令 → 未知子命令 → 一律判非只读，纯读命令白弹确认。
      //
      // ⚠️ 安全边界：**只剥离无副作用的全局选项**。`-c k=v` / `--config-env` / `--exec-path`
      // 刻意**不剥离**——`-c core.pager='sh -c evil'`、`-c alias.x='!evil'` 能借只读子命令
      // 执行任意代码，必须落确认（保持 return false）。
      const gitArgs = stripSafeGitGlobalOptions(args);
      if (gitArgs === null) return false; // 命中不可信全局选项（-c 等）→ 非只读
      const subCmd = gitArgs[0];
      if (!subCmd) continue; // 裸 git（或仅剩安全全局选项）是只读的
      // `git --version` / `git --help`：纯信息查询，此前落到「未知子命令」被判非只读，白弹确认
      if (subCmd === "--version" || subCmd === "--help" || subCmd === "-v" || subCmd === "-h")
        continue;
      if (DANGEROUS_GIT_SUBCOMMANDS.has(subCmd)) return false;
      // P0-1：git config 按 flag 细分读写（写操作含 core.hooksPath 劫持不可判只读）
      if (subCmd === "config") {
        if (!isReadOnlyGitConfig(gitArgs.slice(1))) return false;
        continue;
      }
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
  // Fork 炸弹（经典形式 :(){ :|:& };:）。
  // 注意旧正则写成 /:()…/，其中 () 是空捕获组而非字面括号 → 实际匹配 ":{"、漏判真正的 ":(){"。
  // 修正为显式匹配函数名 : + 字面括号 () + 函数体内的 :|: 自调用管道 + & 后台。
  if (/:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:[^}]*&[^}]*\}\s*;/.test(command)) return true;
  // 下载并执行
  if (/(curl|wget).*\|\s*(sh|bash|python|perl|ruby)/.test(command)) return true;

  return false;
}
