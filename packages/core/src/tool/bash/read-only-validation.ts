/**
 * 只读命令快速路径
 * 判断 Bash 命令是否为纯只读操作，可跳过用户确认
 */

import { parseBashCommand, extractShellStatements, extractRedirectTargets } from "./parser.ts";
import { judgeDdCommand } from "../../permission/dangerous-command.ts";
import { expandShellCommand } from "../../permission/shell-command-variants.ts";
// R7：内置等待原语只读判定复用同一份语法解析，避免「功能认 sid-wait、权限不认」两套规则漂移
import { parseSidWaitCommand } from "../../task/sid-wait.ts";

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
  // find 不在此列：`-delete` / `-exec` / `-fprint` 等动作会写盘或执行任意命令，见 isReadOnlyFind
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
  // 包管理器：子命令由 CONDITIONAL_COMMANDS 细化（list/view 才只读）
  "npm",
  "bun",
  // 解释器 / 构建器 **不** 进这张表（P0-3）。
  // 旧表把 python/node/make/gcc/java 当只读 → BashTool.checkPermissions 返回 allow
  // → checker Step 5.5 直接 return，plan / deny-write 全部打穿。
  // 版本查询走下方 `--version` / `-v` / `-V` 快速路径，不会因此把 `python3 --version` 误伤成要确认。
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
  // sort / uniq / awk 不在此列：它们能借参数写文件或执行命令，由 CONDITIONAL_COMMANDS 按参数判
  "cut",
  "tr",
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
  // 网络查询（只读：只问本地解析器，不携带用户数据、不取回可执行内容）
  "ping",
  "dig",
  "nslookup",
  "host",
  // curl / wget 不在此列：它们能向任意 URL 发请求并取回响应体。
  // 「不带 -o 就是只读」不成立——响应体照样回到工具输出、进主模型上下文，
  // 这正是网页注入的入口。它们的放行由 CONDITIONAL_COMMANDS 恒判为非只读，
  // 落到权限确认，而不是在工具级直接 allow。
]);

/**
 * 已知的只读 Git 子命令。
 *
 * ⚠️ 注意：`config` **不在**此列表——`git config --get x`（读）与 `git config user.email x`（写）
 * 语义完全不同。把整个 config 子命令判只读会让写操作（含 `core.hooksPath` 劫持）被自动放行，
 * 违反「NEVER 更新 git config」安全协议（对齐 CC）。config 的只读判定改由 isReadOnlyGitConfig
 * 按 flag 细分（见下）。
 *
 * ⚠️ **有写形态的子命令也不能整条放进这张表**：`stash` / `branch` / `tag` / `remote` / `reflog`
 * 都既有读形态又有写形态（裸 `git stash` = push、`git branch <name>` = 新建分支、
 * `git tag <name>` = 新建 tag、`git remote add` = 配远端、`git reflog expire` = 删 reflog）。
 * 按子命令名整体放行会让这些写操作在 default 模式下**不经确认直接执行**，
 * 而 prompt 红线 RL-001 明写禁止 `git stash`。它们的只读判定改由
 * isReadOnlyGitStash / Branch / Tag / Remote / Reflog 按参数细分（见下）。
 */
const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  "status",
  "log",
  "diff",
  "show",
  "describe",
  "shortlog",
  "blame",
  "ls-files",
  "ls-tree",
  "cat-file",
  "rev-parse",
  "rev-list",
  "name-rev",
  "for-each-ref",
  "merge-base",
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
 * shell 的 fd 复制记号（`2>&1`、`>&2`、`1>&2`）。
 *
 * parser 会把它们原样留在 args 里（`git branch -a 2>&1` → `["branch","-a","2>&1"]`），
 * 它不是 flag 也不是位置参数。不滤掉就会被「没有列表开关却带位置参数 = 新建分支」这类
 * 规则当成位置参数，把纯读命令误判成写。原型回放里这一条造成了 6 次误判。
 */
const FD_DUPLICATION_TOKEN = /^\d*>&\d+$/;

function stripFdDuplicationTokens(args: string[]): string[] {
  return args.filter((a) => !FD_DUPLICATION_TOKEN.test(a));
}

/** 从 `--flag=value` 里取 flag 名（短选项粘连值如 `-n5` 不在此列，各判定自行处理）。 */
function flagName(token: string): string {
  const eq = token.indexOf("=");
  return eq > 0 ? token.slice(0, eq) : token;
}

/**
 * `git stash` 的只读形态（B1）。
 *
 * 读：动词是 `list` / `show`（后者可带 diff 显示选项和一个 `stash@{n}`）。
 * 写：裸 `git stash`（等于 `push`，会改工作区）、`push` / `pop` / `apply` / `save` / `drop` /
 *     `clear` / `branch` 等其余动词、无动词却带 flag（`git stash -u` 仍是 push）、
 *     白名单外的 flag。
 *
 * 未知 flag 判写是刻意的保守方向：多弹一次确认，而不是把带未知副作用的形态放行。
 */
/**
 * `git worktree` 的只读形态（B8）：只有 `list` 是纯读。
 *
 * `add` / `remove` / `prune` / `move` / `lock` / `unlock` / `repair` 都改工作树状态，
 * 一律非只读。`remove --force` 另有危险命令模式兜底（见 dangerous-command），
 * 两处判的是不同层：这里决定「要不要确认」，那里决定「是不是 critical」。
 */
export function isReadOnlyGitWorktree(args: string[]): boolean {
  if (args[0] !== "list") return false;
  for (const token of args.slice(1)) {
    if (token === "--porcelain" || token === "-v" || token === "--verbose" || token === "-z") {
      continue;
    }
    return false;
  }
  return true;
}

/**
 * 值可省略的只读 flag（`git grep`）。带值形式统一在循环里按「下一个 token 是值」处理。
 */
const GIT_GREP_BOOL_FLAGS = new Set([
  "-i",
  "--ignore-case",
  "-I",
  "-w",
  "--word-regexp",
  "-v",
  "--invert-match",
  "-n",
  "--line-number",
  "-l",
  "--files-with-matches",
  "-L",
  "--files-without-match",
  "-c",
  "--count",
  "-h",
  "-H",
  "--full-name",
  "--cached",
  "-a",
  "--text",
  "--no-textconv",
  "-p",
  "--show-function",
  "-W",
  "--function-context",
  "-q",
  "--quiet",
  "-s",
  "--no-messages",
  "-o",
  "--only-matching",
  "-z",
  "--null",
  "-F",
  "--fixed-strings",
  "-E",
  "--extended-regexp",
  "-G",
  "--basic-regexp",
  "-P",
  "--perl-regexp",
  "--all-match",
  "--and",
  "--or",
  "--not",
  "--break",
  "--heading",
  "--column",
  "--no-color",
  "--color",
]);

/** `git grep` 里带值的只读 flag（值在下一个 token 或粘连形式里） */
const GIT_GREP_VALUE_FLAGS = new Set([
  "-A",
  "-B",
  "-C",
  "-m",
  "--max-count",
  "--threads",
  "--exclude",
  "--max-depth",
  "-e",
]);

/** `--` 之前的 `=` 形式带值 flag（`--max-count=3` / `--color=always`） */
const GIT_GREP_EQ_FLAGS = new Set([
  "--max-count",
  "--threads",
  "--exclude",
  "--max-depth",
  "--color",
]);

/**
 * `git grep` 的只读形态（B8）。
 *
 * 比「在只读表里加一个名字」多做一步，因为 `git grep` 有两个能**执行任意程序**的 flag：
 * `-O<orderfile>` 与 `--open-files-in-pager[=<pager>]`。直接把 `grep` 放进只读子命令
 * 集合等于开一个任意代码执行口子。所以这里用白名单：认识的只读 flag 才放行，
 * 其余（含 `-O` / `--open-files-in-pager` / `-f`）一律非只读。
 *
 * 三个**刻意**不放行的形态（等 B5 的路径校验落地再放开，不是遗漏）：
 * - `-f <file>` / `--file=<file>`：从文件读模式，文件路径绕过权限层的路径校验；
 * - `--no-index` / `--untracked`：pathspec 会扩展到文件系统任意路径（可读工作区外文件）；
 * - `--pathspec-from-file`：pathspec 来自文件，同样绕开路径校验。
 *
 * pathspec 只做「不出仓库」的粗判（拒绝对路径、`..`、`~`）：精确的工作区校验属于 B5。
 */
export function isReadOnlyGitGrep(args: string[]): boolean {
  let i = 0;
  /** 第一个位置参数是 pattern，其后都是 pathspec */
  let patternSeen = false;
  let afterDoubleDash = false;

  while (i < args.length) {
    const token = args[i]!;

    if (afterDoubleDash) {
      if (!isSafeGitPathspec(token)) return false;
      i++;
      continue;
    }
    if (token === "--") {
      afterDoubleDash = true;
      i++;
      continue;
    }

    // 位置参数：先 pattern，再 pathspec
    if (!token.startsWith("-") || token === "-") {
      if (!patternSeen) {
        patternSeen = true;
        i++;
        continue;
      }
      if (!isSafeGitPathspec(token)) return false;
      i++;
      continue;
    }

    // `--flag=value`：只认识表内的只读 flag
    const eq = token.indexOf("=");
    if (token.startsWith("--") && eq > 0) {
      if (!GIT_GREP_EQ_FLAGS.has(token.slice(0, eq))) return false;
      i++;
      continue;
    }

    // 粘连形式：`-A3` / `-e<pattern>`
    const attached = /^-([ABCm])(.+)$/.exec(token) ?? /^-e(.+)$/.exec(token);
    if (attached) {
      i++;
      continue;
    }

    if (GIT_GREP_BOOL_FLAGS.has(token)) {
      i++;
      continue;
    }

    if (GIT_GREP_VALUE_FLAGS.has(token)) {
      const value = args[i + 1];
      // 值缺失，或值看起来是另一个选项（`-e --foo` 除外：`-e` 的值可以以 `-` 开头）
      if (value === undefined || (token !== "-e" && value.startsWith("-"))) return false;
      i += 2;
      continue;
    }

    // 未知 flag（含 -O / --open-files-in-pager / -f / --no-index / --untracked）→ 非只读
    return false;
  }

  return true;
}

/**
 * pathspec 的粗判：必须以仓库内相对路径表达，不能是绝对路径、`~` 展开或跳出仓库的 `..`。
 * 不含 glob 检查——pathspec 里的通配是正常用法，且通配不会把范围扩到工作区外。
 */
function isSafeGitPathspec(p: string): boolean {
  if (!p || p.startsWith("/") || p.startsWith("~") || p.startsWith("\\")) return false;
  if (/[$`]/.test(p)) return false;
  return !p.split("/").includes("..");
}

export function isReadOnlyGitStash(args: string[]): boolean {
  const tokens = stripFdDuplicationTokens(args);
  let verb: string | null = null;
  const positional: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const a = tokens[i]!;
    if (a === "--") {
      positional.push(...tokens.slice(i + 1));
      break;
    }
    if (a.startsWith("-") && a !== "-") {
      const name = flagName(a);
      if (!STASH_READ_FLAGS.has(name)) return false;
      // 带值选项：`--format='%gd'` 用 = 形式；`--format '%gd'` 是两个 token
      if (STASH_READ_VALUE_FLAGS.has(name) && !a.includes("=")) i++;
      continue;
    }
    if (verb === null) verb = a;
    else positional.push(a);
  }
  if (verb === null) return false;
  if (!STASH_READ_VERBS.has(verb)) return false;
  // 动词后最多一个位置参数：`git stash show stash@{0}`
  return positional.length <= 1;
}

/** `git stash list` / `show` 可接受的显示类选项——它们只影响输出，不改仓库状态。 */
const STASH_READ_VERBS = new Set(["list", "show"]);
const STASH_READ_FLAGS = new Set([
  // list 的 log 选项
  "--oneline",
  "--format",
  "--pretty",
  "--date",
  "--skip",
  "-n",
  "--max-count",
  // show 的 diff 选项
  "-p",
  "--patch",
  "--stat",
  "--numstat",
  "--shortstat",
  "--summary",
  "--raw",
  "--binary",
  "--name-only",
  "--name-status",
  "--include-untracked",
  "-u",
  "--only-untracked",
  "--unified",
  "-U",
  "--no-color",
  "--color",
  "--no-ext-diff",
]);
const STASH_READ_VALUE_FLAGS = new Set([
  "--format",
  "--pretty",
  "--date",
  "--skip",
  "-n",
  "--max-count",
  "--unified",
  "-U",
]);

/**
 * `git branch` 的只读形态（B1）。
 *
 * 读：只有列表/显示类 flag（`-a` `-r` `-v` `-vv` `--list` `-l` `--show-current` `--contains`
 *     `--merged` `--points-at` `--sort` …）；带 `--list`/`-l` 时位置参数视为匹配模式。
 * 写：出现 `-m/-M/-c/-C/-d/-D/-f/-u/--set-upstream-to/--unset-upstream/-t/--track/
 *     --no-track/--edit-description`，或**没有列表开关却带位置参数**——那是新建分支
 *     （`git branch feat/x`）。
 *
 * `--contains` / `--merged` 等的值可以省略（省略时默认 HEAD）。规则：下一个 token 不以
 * `-` 开头才当作值吞掉。不吞的话 `git branch --contains feat/x` 里的 `feat/x` 会被当成
 * 新建分支误判为写；硬吞的话 `git branch --contains -a` 会把 `-a` 吃掉。
 */
export function isReadOnlyGitBranch(args: string[]): boolean {
  const tokens = stripFdDuplicationTokens(args);
  let listMode = false;
  const positional: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const a = tokens[i]!;
    if (a === "--") {
      positional.push(...tokens.slice(i + 1));
      break;
    }
    if (a.startsWith("-") && a !== "-") {
      const name = flagName(a);
      if (BRANCH_WRITE_FLAGS.has(name)) return false;
      if (!BRANCH_READ_FLAGS.has(name)) return false; // 未知 flag → 写（保守）
      if (name === "--list" || name === "-l") listMode = true;
      if (BRANCH_OPTIONAL_VALUE_FLAGS.has(name) && !a.includes("=")) {
        const next = tokens[i + 1];
        if (next !== undefined && !next.startsWith("-")) i++;
      }
      continue;
    }
    positional.push(a);
  }
  if (positional.length === 0) return true;
  // 有位置参数：只有列表模式才是「模式匹配」，否则是新建分支
  return listMode;
}

/** `git branch` 的写形态 flag——命中即写，不看其余参数。 */
const BRANCH_WRITE_FLAGS = new Set([
  "-m",
  "-M",
  "--move",
  "-c",
  "-C",
  "--copy",
  "-d",
  "-D",
  "--delete",
  "-f",
  "--force",
  "-u",
  "--set-upstream-to",
  "--unset-upstream",
  "-t",
  "--track",
  "--no-track",
  "--edit-description",
]);
/** `git branch` 的只读 flag。`-l` 按现代 git 的 `--list` 处理（旧版意思是建 reflog，见方案 R2）。 */
const BRANCH_READ_FLAGS = new Set([
  "-a",
  "--all",
  "-r",
  "--remotes",
  "-v",
  "--verbose",
  "-vv",
  "-l",
  "--list",
  "--show-current",
  "--contains",
  "--no-contains",
  "--merged",
  "--no-merged",
  "--points-at",
  "--format",
  "--sort",
  "--color",
  "--no-color",
  "--column",
  "--no-column",
  "--abbrev",
  "-i",
  "--ignore-case",
]);
/** 值可省略的读 flag：只有下一个 token 不以 `-` 开头时才当值吞掉。 */
const BRANCH_OPTIONAL_VALUE_FLAGS = new Set([
  "--contains",
  "--no-contains",
  "--merged",
  "--no-merged",
  "--points-at",
  "--format",
  "--sort",
  "--color",
  "--no-color",
  "--column",
  "--abbrev",
]);

/**
 * `git tag` 的只读形态（B1）。
 *
 * 读：无参数；带 `-l`/`--list` 时位置参数视为匹配模式；`-n` `--contains` `--merged`
 *     `--points-at` `--sort` `--format` `--color` `--column` 等显示选项；`-v`/`--verify`
 *     （校验签名，位置参数是待校验的 tag 名）。
 * 写：`-a/-s/-u/-m/-F/-d/-f/-e`，或**没有 `-l`/`-v` 却带位置参数**——那是新建 tag
 *     （`git tag v1.0`）。
 */
export function isReadOnlyGitTag(args: string[]): boolean {
  const tokens = stripFdDuplicationTokens(args);
  let listMode = false;
  let verifyMode = false;
  const positional: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const a = tokens[i]!;
    if (a === "--") {
      positional.push(...tokens.slice(i + 1));
      break;
    }
    if (a.startsWith("-") && a !== "-") {
      // `-n5` 是 git 对 `-n` 的粘连数字写法（`git tag -n5` 列 5 行），等价于 `-n`
      const name = /^-n\d+$/.test(a) ? "-n" : flagName(a);
      if (TAG_WRITE_FLAGS.has(name)) return false;
      if (!TAG_READ_FLAGS.has(name)) return false; // 未知 flag → 写（保守）
      if (name === "--list" || name === "-l") listMode = true;
      if (name === "--verify" || name === "-v") verifyMode = true;
      if (TAG_OPTIONAL_VALUE_FLAGS.has(name) && !a.includes("=")) {
        const next = tokens[i + 1];
        if (next !== undefined && !next.startsWith("-")) i++;
      }
      continue;
    }
    positional.push(a);
  }
  if (positional.length === 0) return true;
  // 有位置参数：列表模式是匹配模式，verify 模式是待校验 tag 名；否则是新建 tag
  return listMode || verifyMode;
}

/** `git tag` 的写形态 flag。 */
const TAG_WRITE_FLAGS = new Set([
  "-a",
  "--annotate",
  "-s",
  "--sign",
  "-u",
  "--local-user",
  "-m",
  "--message",
  "-F",
  "--file",
  "-d",
  "--delete",
  "-f",
  "--force",
  "-e",
  "--edit",
]);
const TAG_READ_FLAGS = new Set([
  "-l",
  "--list",
  "-n",
  "--contains",
  "--no-contains",
  "--merged",
  "--no-merged",
  "--points-at",
  "--sort",
  "--format",
  "--color",
  "--no-color",
  "--column",
  "--no-column",
  "-v",
  "--verify",
  "-i",
  "--ignore-case",
]);
/** 值可省略的读 flag（见 isReadOnlyGitBranch 同名集合的注释）。`-n` 只在粘连形式带值。 */
const TAG_OPTIONAL_VALUE_FLAGS = new Set([
  "--contains",
  "--no-contains",
  "--merged",
  "--no-merged",
  "--points-at",
  "--sort",
  "--format",
  "--color",
  "--no-color",
  "--column",
]);

/**
 * `git remote` 的只读形态（B1）。
 *
 * 读：无参数、`-v`/`--verbose`、动词 `show` 与 `get-url`（`show` 会联网但只读本地状态，
 *     与现状一致，见方案 R3）。
 * 写：`add` / `remove`/`rm` / `rename` / `set-url` / `set-head` / `set-branches` / `prune` /
 *     `update` 及任何未知动词。
 */
export function isReadOnlyGitRemote(args: string[]): boolean {
  const tokens = stripFdDuplicationTokens(args);
  const positional: string[] = [];
  for (const a of tokens) {
    if (a === "-v" || a === "--verbose") continue;
    if (a.startsWith("-")) return false; // 未知 flag → 写（保守）
    positional.push(a);
  }
  if (positional.length === 0) return true;
  return REMOTE_READ_VERBS.has(positional[0]!);
}

const REMOTE_READ_VERBS = new Set(["show", "get-url"]);

/**
 * `git reflog` 的只读形态（B1）。
 *
 * 读：无参数、纯 flag（`-12`、`-n 5`、`--all` 都是 log 显示选项）、动词 `show`。
 * 写：`expire`、`delete` 及其他动词（它们会删 reflog / 改引用日志）。
 *
 * 这里不设 flag 白名单：reflog 的写只能由动词触发，flag 本身写不了仓库。
 */
export function isReadOnlyGitReflog(args: string[]): boolean {
  const tokens = stripFdDuplicationTokens(args);
  const positional: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const a = tokens[i]!;
    if (a === "--") {
      positional.push(...tokens.slice(i + 1));
      break;
    }
    if (a.startsWith("-") && a !== "-") {
      // `-n 5` / `--max-count 5` 的值不是位置参数，吞掉
      const name = flagName(a);
      if (REFLOG_VALUE_FLAGS.has(name) && !a.includes("=")) i++;
      continue;
    }
    positional.push(a);
  }
  if (positional.length === 0) return true;
  return positional[0] === "show";
}

/** `git reflog` 里带值、但值不是位置参数的 log 选项。 */
const REFLOG_VALUE_FLAGS = new Set([
  "-n",
  "--max-count",
  "--skip",
  "--format",
  "--pretty",
  "--date",
  "--since",
  "--until",
]);

/**
 * 「安全」的 git 全局选项——出现在子命令之前、本身无副作用、剥离后不改变只读语义。
 *
 * 明确**不含** `-c` / `--config-env` / `--exec-path`：它们能注入配置（`core.pager`、
 * `alias.*`、`core.sshCommand`）从而借只读子命令执行任意代码，必须保持「非只读」判定。
 *
 * ⚠️ 也**不含** `-C` / `--git-dir` / `--work-tree` / `--bare`（B2）：它们只改变「用哪个仓库」，
 * 剥掉就等于把「在别人的仓库里跑 git」当成「在本仓里跑」。`cd <恶意目录> && git status`
 * 会因为目录里的 git 配置/钩子被判非只读，`git -C <恶意目录> status` 是同一件事，
 * 不能因为换了写法就放行。这三类写法在权限层另有补回：`git -C <本仓内目录>` 由
 * `checker.ts` 的只读 git 执行边界判定放行，其余落到确认。
 */
const SAFE_GIT_GLOBAL_BOOL_OPTS = new Set([
  "-P",
  "--no-pager",
  "--paginate",
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
const SAFE_GIT_GLOBAL_VALUE_OPTS = new Set(["--namespace"]);

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

/**
 * gh 只读子命令：按「命令组 + 子命令」两级精确匹配，不做前缀匹配。
 *
 * 为什么要有：被评会话 ce7ea52e 里 `gh issue view 373 --json …` 被判非只读，
 * 失去并发安全资格、每次都要过权限判定。
 *
 * 刻意不进的：
 * - `gh api`：方法由 `-X/--method` 决定，带 `-f/-F/--input` 时会**隐式变成 POST**。
 *   解析稍有遗漏就会把写操作判成只读并发放行，收益不值这个风险。
 * - `gh pr checkout` 等：名字像「看」，实际改本地分支/工作区。
 * - `--web` / `-w`：拉起浏览器，是本机副作用，不是读。
 */
const READ_ONLY_GH_SUBCOMMANDS: Record<string, ReadonlySet<string>> = {
  issue: new Set(["view", "list"]),
  pr: new Set(["view", "list", "diff", "checks"]),
  repo: new Set(["view"]),
};

export function isReadOnlyGh(args: string[]): boolean {
  const [group, sub] = args;
  if (group === "--version" || group === "--help") return args.length === 1;
  if (!group || !sub) return false;
  const subs = READ_ONLY_GH_SUBCOMMANDS[group];
  if (!subs || !subs.has(sub)) return false;
  return !args.some((a) => a === "--web" || a === "-w" || a.startsWith("--web="));
}

/**
 * find 的副作用动作：删除、执行任意命令、写文件。命中任一即非只读。
 * 只看 token 精确相等——`-name '-delete'` 这种把它当模式值的写法会被误判成非只读，
 * 方向是落到确认，可接受。
 */
const FIND_SIDE_EFFECT_ACTIONS = new Set([
  "-delete",
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  "-fprint",
  "-fprint0",
  "-fprintf",
  "-fls",
]);

export function isReadOnlyFind(args: string[]): boolean {
  return !args.some((a) => FIND_SIDE_EFFECT_ACTIONS.has(a));
}

/**
 * awk 脚本里的三条副作用通道 `system()`、`print | "cmd"` / `"cmd" | getline`、`print > "f"`
 * 都在脚本串内部，不是 shell 重定向，AST 层看不到。这里不做 awk 语法解析，按关键字保守判：
 * 含 `system`、`getline`、单个 `|`、不接 `=` 的 `>` 任一即非只读。
 *
 * `>=` 与 `||` 排除在外：它们在 awk 里只可能是比较和逻辑或，不会是重定向或管道。
 * 本地轨迹实测（4889 条 bash 命令，2026-10-28），修前判只读的 5 条 awk 有 3 条是
 * `NR>=12`、`a || b` 这种行号筛选，不排除就有 60% 的只读 awk 白弹确认。
 * 剩下的代价是 `$1 > 5` 这类数值比较、`/a|b/` 这类正则交替仍会落到确认
 * （看不懂就不算只读，落 ask 不是硬拒）。
 */
const AWK_SIDE_EFFECT_PATTERN = /system|getline|(?<!\|)\|(?!\|)|>(?!=)/;
/** 带值的 awk 选项：值不是脚本。`-f` / `--file` / `-e` / `--source` 单独处理。 */
const AWK_VALUE_OPTS = new Set(["-F", "-v", "--field-separator", "--assign"]);

export function isReadOnlyAwk(args: string[]): boolean {
  const scripts: string[] = [];
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "--") {
      i++;
      break;
    }
    if (!a.startsWith("-") || a === "-") break;
    // 脚本从文件读：内容看不到，按非只读
    if (a === "-f" || a.startsWith("-f") || a === "--file" || a.startsWith("--file=")) return false;
    // gawk 的 -e / --source 直接给脚本串
    if (a === "-e" || a === "--source") {
      scripts.push(args[++i] ?? "");
      continue;
    }
    if (a.startsWith("--source=")) {
      scripts.push(a.slice("--source=".length));
      continue;
    }
    if (AWK_VALUE_OPTS.has(a)) {
      i++;
      continue;
    }
    // -F: / -vx=1 / --assign=x=1 等同 token 带值形态，以及其余无值选项：跳过
  }
  // 没有 -e / --source 时，第一个位置参数就是脚本
  if (scripts.length === 0 && i < args.length) scripts.push(args[i] ?? "");
  return !scripts.some((s) => AWK_SIDE_EFFECT_PATTERN.test(s));
}

/** 需要特殊处理的命令（看起来只读但可能有副作用） */
const CONDITIONAL_COMMANDS: Record<string, (args: string[]) => boolean> = {
  // sed 只有不带 -i 时才是只读
  sed: (args) => !args.some((a) => a === "-i" || a.startsWith("-i") || a === "--in-place"),
  // awk 的副作用在脚本串里，shell 重定向检查看不到，见 isReadOnlyAwk
  awk: isReadOnlyAwk,
  gawk: isReadOnlyAwk,
  mawk: isReadOnlyAwk,
  find: isReadOnlyFind,
  // sort -o 写输出文件
  sort: (args) =>
    !args.some(
      (a) =>
        a === "-o" ||
        (a.startsWith("-o") && !a.startsWith("--")) ||
        a === "--output" ||
        a.startsWith("--output="),
    ),
  // uniq 的第二个位置参数是输出文件（`uniq in out`）。选项一律跳过：-f/-s/-w 的数值
  // 若写成分开的 token 会被当成位置参数，判非只读，方向是落确认
  uniq: (args) => {
    let positional = 0;
    for (const a of args) if (!a.startsWith("-") || a === "-") positional++;
    return positional <= 1;
  },
  // tee 总是写文件
  tee: () => false,
  // curl/wget 恒非只读。
  //
  // 旧规则「不带 -o/-O 就当只读」只看了有没有写文件，漏了两件事：
  // 请求本身会把 URL 参数里的数据发往任意主机，响应体（含网页里的指令）
  // 会经工具输出进主模型上下文。-o 只是其中一种副作用，不是唯一的。
  // 判非只读后它们落到权限确认；用户想免确认需显式配 allow 规则。
  curl: () => false,
  wget: () => false,
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
  gh: isReadOnlyGh,
};

/**
 * 检查命令是否为只读
 */
export function isReadOnlyCommand(command: string): boolean {
  return isReadOnlyImpl(command, false);
}

/** 只改 shell 自身工作目录、不碰文件系统的内建 */
const DIRECTORY_BUILTINS = new Set(["cd", "pushd", "popd"]);

/**
 * 允许出现在只读命令前面的环境变量白名单（B1）。
 *
 * ## 为什么是白名单而不是黑名单
 *
 * 旧实现完全不看前导变量赋值，`GIT_EXTERNAL_DIFF=/tmp/evil.sh git diff`、
 * `GIT_CONFIG_COUNT=1 … git status` 都被判只读、零确认执行——一条看起来是 `git status`
 * 的命令能跑任意程序。黑名单（`bash-security.ts` 的 `validateDangerousVariables…`）
 * 只覆盖 `PATH` / `LD_*` 那九个，而 git 自己读的几十个变量
 * （`GIT_EXTERNAL_DIFF`、`GIT_CONFIG_*`、`GIT_DIR`、`GIT_EXEC_PATH`、`GIT_SSH_COMMAND`、
 * `GIT_PAGER`、`GIT_EDITOR`…）一个都不在。补黑名单是结构性补不全的。
 *
 * 取值 = 上游 CC 的 `SAFE_ENV_VARS` 与本仓实际用法取交集后再裁剪：
 * **任何 `GIT_*`、`*PATH`、`*_OPTIONS`、`PAGER`、`EDITOR`、`HOME`、`TMPDIR`、`SHELL`、
 * `BASH_ENV`、`ENV`、`IFS` 都不收**。加新变量前先问：它能改变哪个程序的行为？
 * 能（哪怕只是 pager / 编辑器 / 配置注入）就不该进这张表。
 */
const SAFE_ENV_VARS = new Set([
  // 本地化与终端外观：只影响输出文本，不影响执行什么
  "LANG",
  "LANGUAGE",
  "TZ",
  "NO_COLOR",
  "FORCE_COLOR",
  "TERM",
  // 语言运行时：只影响错误输出格式与产物落盘策略，不能指定可执行代码
  "NODE_ENV",
  "PYTHONUNBUFFERED",
  "PYTHONDONTWRITEBYTECODE",
  "RUST_BACKTRACE",
  "RUST_LOG",
  "GOOS",
  "GOARCH",
  "CGO_ENABLED",
  "GO111MODULE",
]);

/** `LC_*` 是成组的本地化变量，逐个列举会漏，按前缀收（大小写严格，避免 `LC_` 之外的花样）。 */
const SAFE_ENV_PREFIX = /^LC_[A-Z]+$/;

function isSafeEnvVarName(name: string): boolean {
  return SAFE_ENV_VARS.has(name) || SAFE_ENV_PREFIX.test(name);
}

/**
 * 独立变量赋值语句（`GIT_DIR=…` 单独一行）里也不许出现的变量名。
 *
 * 独立赋值只设 shell 变量、不进子进程环境，所以 `B=origin/x` 换行再 `git show $B:…`
 * 这类型号常用写法**不受影响**。例外是同名变量可能早已被 `export` 过，这时重新赋值
 * 会改变子进程看到的值；为了不依赖运行时会话状态（shell 快照只 source 用户 profile，
 * 是否保留旧 export 不是判定能保证的事），这些类别一律判非只读。
 *
 * 导出给 `permission/readonly-git-boundary.ts` 用：权限层补回「本仓内 `git -C`」时
 * 也要对独立赋值做同一套例外检查，规则只能有一处定义，否则两层迟早漂移。
 */
const FORBIDDEN_ASSIGNMENT_NAMES = new Set([
  "PAGER",
  "EDITOR",
  "HOME",
  "TMPDIR",
  "SHELL",
  "BASH_ENV",
  "ENV",
  "IFS",
]);

export function isForbiddenAssignmentName(name: string): boolean {
  if (name.startsWith("GIT_")) return true;
  if (name.endsWith("PATH") || name.endsWith("_OPTIONS")) return true;
  return FORBIDDEN_ASSIGNMENT_NAMES.has(name);
}

/**
 * 「除了切目录之外是否只读」：把 `cd` / `pushd` / `popd` 视为无副作用，其余判据与
 * {@link isReadOnlyCommand} 完全相同。
 *
 * ⚠️ **只给 Bash 失败级联用**（query/tool-executor.ts），不许拿去做权限放行或并发判定：
 * - 权限：`cd <恶意目录> && git status` 能借目录里的 git 配置/钩子执行代码（cc 的
 *   readOnlyValidation 为此单独拦 cd+git），放行要走 isReadOnlyCommand 的严格口径；
 * - 并发 / cwd 追踪：bash.ts 对只读命令跳过 `pwd -P` 写回，`cd X && ls` 若被判只读，
 *   cd 就不再跨命令持久化。
 * 级联只需要回答「这条失败的命令有没有可能让后面的写操作落错地方」，`cd` 失败恰好
 * 不会改任何文件，所以这里放宽是安全的。
 */
export function isReadOnlyIgnoringCd(command: string): boolean {
  return isReadOnlyImpl(command, true);
}

function isReadOnlyImpl(command: string, ignoreCd: boolean): boolean {
  if (!command.trim()) return true;

  const ast = parseBashCommand(command);

  // 1. 有写入重定向 → 非只读
  const redirectTargets = extractRedirectTargets(ast);
  if (redirectTargets.length > 0) return false;

  // 2. 检查所有子命令。用 extractShellStatements 而非 extractSimpleCommands，
  //    是为了把**独立变量赋值语句**（`GIT_DIR=…` 单独一行）也取出来——后者会丢掉
  //    command 为空的条目，而 B1 需要对它做例外检查（见下）。
  const simpleCommands = extractShellStatements(ast);
  if (simpleCommands.length === 0) return false;
  // 整条命令只有赋值（`B=origin/x`）：没有任何可执行程序，修前判非只读
  // （extractSimpleCommands 为空 → return false），保持这个口径不动——判成只读会连带
  // 改变 cwd 回写、并发安全等消费者的行为，而它换不来任何放行收益。
  if (simpleCommands.every((s) => !s.command)) return false;

  for (const { command: cmd, args, envPrefix } of simpleCommands) {
    // B1：前导变量赋值只在白名单内才继续按只读判定。
    // 旧实现完全不看它，`GIT_EXTERNAL_DIFF=/tmp/evil.sh git diff` 与 `git diff` 同样判只读，
    // 一条看起来是只读 git 的命令因此能零确认执行任意程序。
    if (envPrefix) {
      for (const name of Object.keys(envPrefix)) {
        if (!cmd) {
          // 独立赋值只设 shell 变量、不进子进程环境，`B=origin/x` 换行再 `git show $B:…`
          // 这类常用写法保持放行；GIT_* / 注入类变量例外，见 isForbiddenAssignmentName。
          if (isForbiddenAssignmentName(name)) return false;
        } else if (!isSafeEnvVarName(name)) {
          return false;
        }
      }
    }
    if (!cmd) continue; // 独立赋值语句：内容已在上面的例外里检查过
    if (ignoreCd && DIRECTORY_BUILTINS.has(cmd)) continue;

    // R7：内置等待原语（`sid-wait gh-pr <n>`）由 harness 解释执行，只发 gh REST GET、
    // 不写任何文件。不认它就会落进「未知命令 → 非只读」，每等一次 PR 弹一次确认。
    if (cmd === "sid-wait") {
      if (parseSidWaitCommand([cmd, ...args].join(" ")) === null) return false;
      continue;
    }

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
      // diff / log / show 等子命令都接受 --output=<file>，把结果写进文件。
      // 检查放在所有子命令分支**之前**：下面的细分子命令走 continue，写在后面会被跳过。
      if (gitArgs.some((a) => a === "--output" || a.startsWith("--output="))) return false;
      // P0-1：git config 按 flag 细分读写（写操作含 core.hooksPath 劫持不可判只读）
      if (subCmd === "config") {
        if (!isReadOnlyGitConfig(gitArgs.slice(1))) return false;
        continue;
      }
      // B1：这五个子命令都有写形态，按参数细分读写（见各自函数注释）。
      // 判不准时落确认，不落放行。
      if (subCmd === "stash") {
        if (!isReadOnlyGitStash(gitArgs.slice(1))) return false;
        continue;
      }
      if (subCmd === "branch") {
        if (!isReadOnlyGitBranch(gitArgs.slice(1))) return false;
        continue;
      }
      if (subCmd === "tag") {
        if (!isReadOnlyGitTag(gitArgs.slice(1))) return false;
        continue;
      }
      if (subCmd === "remote") {
        if (!isReadOnlyGitRemote(gitArgs.slice(1))) return false;
        continue;
      }
      if (subCmd === "reflog") {
        if (!isReadOnlyGitReflog(gitArgs.slice(1))) return false;
        continue;
      }
      // B8：`git worktree list` / `git grep` 是纯读，但都有写形态与执行程序的口子，
      // 按参数细分（见各自函数注释）。
      if (subCmd === "worktree") {
        if (!isReadOnlyGitWorktree(gitArgs.slice(1))) return false;
        continue;
      }
      if (subCmd === "grep") {
        if (!isReadOnlyGitGrep(gitArgs.slice(1))) return false;
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
 *
 * `dd` 这一支**复用权限层的 `judgeDdCommand`**，不再自己写一份正则。两处各写一份
 * 已经漂移过一次：权限层（`permission/dangerous-command.ts`）按 `of=` / `count=`
 * 结构化判定后放行 `dd if=/dev/zero of=/tmp/x count=1`，而这里的旧正则
 * `/dd\s+if=\/dev\/(zero|random|urandom)/i` 仍把它标红成「高危系统操作」——
 * 权限框红框 + Enter 默认拒绝。只要这条命令因**其它**原因弹确认，用户看到的
 * 仍是红色高危，等于修好的误报在 UI 侧原样复现。
 *
 * 其余分支（rm / mkfs / fork 炸弹 / 下载并执行）保持原样：本次只收窄 dd，
 * 连带改它们的标红面会让 review 分不清哪些行为变化是必要的（见 Agent Note）。
 */
export function isDestructiveCommand(command: string): boolean {
  // 递归删除
  if (/rm\s+(-[rf]*\s+)*\/($|\s)/.test(command)) return true;
  if (/rm\s+(-[rf]*\s+)*~/.test(command)) return true;
  // 磁盘操作：与权限层同一判据（按 of= 去向 + count= 上限判，不是只看 if=）
  if (/\bdd\b/.test(command)) {
    const dangerousDd = expandShellCommand(command).commands.some(
      (c) => c.program === "dd" && judgeDdCommand(c.args) !== null,
    );
    if (dangerousDd) return true;
  }
  if (/mkfs\./.test(command)) return true;
  // Fork 炸弹（经典形式 :(){ :|:& };:）。
  // 注意旧正则写成 /:()…/，其中 () 是空捕获组而非字面括号 → 实际匹配 ":{"、漏判真正的 ":(){"。
  // 修正为显式匹配函数名 : + 字面括号 () + 函数体内的 :|: 自调用管道 + & 后台。
  if (/:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:[^}]*&[^}]*\}\s*;/.test(command)) return true;
  // 下载并执行
  if (/(curl|wget).*\|\s*(sh|bash|python|perl|ruby)/.test(command)) return true;

  return false;
}
