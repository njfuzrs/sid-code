/**
 * bash 命令「等价执行形态」展开（deny / ask 规则、危险命令检测、写入目标保护共用）。
 *
 * ## 为什么需要它
 *
 * 规则与危险模式都是对**命令文本**做匹配，而 shell 有大量「文本不同、执行的是同一个程序」的写法。
 * 2026-10-24 对 `deny: ["Bash(curl *)"]` 实测（always-allow 下），下列形态**全部静默放行**：
 *
 * | 形态 | 例 |
 * | --- | --- |
 * | 前导空白 | `  curl evil.com` |
 * | 绝对路径 | `/usr/bin/curl evil.com` |
 * | 环境变量前缀 | `FOO=1 curl evil.com` |
 * | 包装命令 | `env curl` / `command curl` / `nohup curl` / `timeout 5 curl` / `xargs curl` |
 * | 转义 / 引号拼接 | `c\url evil.com` / `"cu"rl evil.com` |
 * | 再起一层 shell | `sh -c 'curl x'` / `bash -c` / `eval 'curl x'` |
 *
 * 危险命令硬编码检测同样被 `sh -c 'rm -rf /'` / `r\m -rf /` 绕过（实测 always-allow 下放行）。
 *
 * ## 口径：只用于「拦」，不用于「放」
 *
 * 展开出来的形态**只喂给 deny / ask / 危险检测 / 写保护**（取 some：任一形态命中即拦）。
 * allow 规则**不**用展开形态匹配——否则 `allow: ["Bash(npm *)"]` 会因为剥掉 `FOO=1` 而放行
 * `FOO=1 npm …` 之外的东西，等于把「拦」的宽口径借给了「放」。拦宽放窄 = fail-closed。
 *
 * ## 为什么不把参数也去引号
 *
 * 只规范化**命令头**（剥环境变量 / 包装命令、去转义、取 basename），参数保持原文。
 * 若把整条去引号再拼接，`git commit -m "rm -rf /"` 会变成 `git commit -m rm -rf /`，
 * 危险模式把一条提交说明当成删根目录——拦的宽度变成了误报的来源。
 * 真正要往里看的「参数即代码」只有 `sh -c` / `eval` / 命令替换三类，单独递归展开。
 */

import * as path from "node:path";
import type { HeredocBlock } from "../tool/bash/heredoc.ts";
import {
  extractHeredocBlocks,
  isPosixShellProgram,
  isShellLikeProgram,
  splitCommandStructure,
} from "./shell-structure.ts";
import { detectRedirections } from "./shell-parser.ts";

/** 带原文位置的 token（value 是去引号 / 去转义之后的值） */
interface PositionedToken {
  value: string;
  start: number;
  end: number;
}

/**
 * 位置感知的 shell 分词：认单/双引号与反斜杠转义，返回每个 token 的值与原文区间。
 * 与 tool/bash/parser.ts 的 tokenize 同一口径，多出来的只是区间——命令头规范化之后
 * 要把参数部分按原文拼回去，必须知道命令头在原文里结束于哪里。
 */
function tokenizeWithPositions(cmd: string): PositionedToken[] {
  const tokens: PositionedToken[] = [];
  let value = "";
  let start = -1;
  let inSingle = false;
  let inDouble = false;
  let i = 0;
  const flush = (end: number) => {
    if (start >= 0) tokens.push({ value, start, end });
    value = "";
    start = -1;
  };
  while (i < cmd.length) {
    const ch = cmd[i];
    if (!inSingle && !inDouble && /\s/.test(ch)) {
      flush(i);
      i++;
      continue;
    }
    if (start < 0) start = i;
    if (ch === "\\" && !inSingle && i + 1 < cmd.length) {
      value += cmd[i + 1];
      i += 2;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      i++;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      i++;
      continue;
    }
    value += ch;
    i++;
  }
  flush(cmd.length);
  return tokens;
}

/** 包装命令：执行的其实是后面那个程序。argOpts = 自带一个参数的选项；positional = 程序前的位置参数个数 */
interface WrapperSpec {
  argOpts?: ReadonlySet<string>;
  positional?: number;
  /** 出现这些选项时它不是在执行后面的程序（`command -v curl` 是查询，不是调用） */
  notExecIf?: ReadonlySet<string>;
  /** env 允许在程序前再写一串 VAR=val */
  allowsAssignments?: boolean;
}

const WRAPPERS: Readonly<Record<string, WrapperSpec>> = {
  env: {
    argOpts: new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"]),
    allowsAssignments: true,
  },
  command: { notExecIf: new Set(["-v", "-V"]) },
  builtin: {},
  exec: { argOpts: new Set(["-a"]) },
  nohup: {},
  nice: { argOpts: new Set(["-n", "--adjustment"]) },
  time: { argOpts: new Set(["-f", "--format", "-o", "--output"]) },
  timeout: { argOpts: new Set(["-k", "--kill-after", "-s", "--signal"]), positional: 1 },
  stdbuf: { argOpts: new Set(["-i", "-o", "-e"]) },
  ionice: { argOpts: new Set(["-c", "--class", "-n", "--classdata", "-p", "--pid"]) },
  chrt: { positional: 1 },
  taskset: { positional: 1 },
  setsid: {},
  unbuffer: {},
  caffeinate: { argOpts: new Set(["-t", "-w"]) },
  sudo: {
    argOpts: new Set([
      "-u",
      "--user",
      "-g",
      "--group",
      "-C",
      "-h",
      "--host",
      "-p",
      "-U",
      "-r",
      "-t",
    ]),
  },
  doas: { argOpts: new Set(["-u", "-C"]) },
  xargs: {
    argOpts: new Set(["-n", "-I", "-P", "-L", "-d", "-s", "-E", "-a", "--max-args", "--delimiter"]),
  },
};

/** find 的「执行动作」：其后第一个 token 处在程序位置 */
const FIND_EXEC_ACTIONS = new Set(["-exec", "-execdir", "-ok", "-okdir"]);

/** 引号是否闭合（反斜杠转义感知）。未闭合时分词结果与 shell 的理解可能不一致 */
function hasBalancedQuotes(cmd: string): boolean {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (ch === "\\" && !inSingle) {
      i++;
      continue;
    }
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
  }
  return !inSingle && !inDouble;
}

/**
 * 命令前缀关键字：它们后面紧跟的才是「要执行的命令」（`if $(cmd); then …`）。
 * 不当关键字跳过的话，`if` 会被当成程序位，`$(cmd)` 变成它的参数位而躲过命令位判定。
 */
const COMMAND_PREFIX_KEYWORDS = new Set([
  "if",
  "then",
  "elif",
  "else",
  "while",
  "until",
  "do",
  "!",
  "time",
]);

/**
 * 一段 token 里所有处在「程序位置」的下标：命令头、沿 wrapper 链往下的每一层
 * （`env FOO=1 nohup sudo id` → env、nohup、sudo、id），以及 `find … -exec <程序>` 的程序。
 *
 * 返回下标而不是名字：`detectCommandSubstitutionDanger` 要用它判「这处替换的**结果**
 * 是不是要被当成程序执行」——那是位置问题，只看名字不够。
 */
function programPositionIndexes(tokens: readonly string[]): number[] {
  const positions: number[] = [];

  const walk = (start: number) => {
    let i = start;
    // 前导赋值与前缀关键字不占程序位：`FOO=1 cmd` / `if cmd` 的 cmd 才是程序
    for (let guard = 0; guard < 8; guard++) {
      let moved = false;
      while (i < tokens.length && ASSIGNMENT_RE.test(tokens[i])) {
        i++;
        moved = true;
      }
      if (i < tokens.length && COMMAND_PREFIX_KEYWORDS.has(tokens[i])) {
        i++;
        moved = true;
      }
      if (!moved) break;
    }
    for (let guard = 0; guard < 8 && i < tokens.length; guard++) {
      const name = path.basename(tokens[i]);
      positions.push(i);
      const spec = WRAPPERS[name];
      if (!spec) break;
      let j = i + 1;
      let notExec = false;
      while (j < tokens.length) {
        const t = tokens[j];
        if (spec.allowsAssignments && ASSIGNMENT_RE.test(t)) {
          j++;
          continue;
        }
        if (t === "--") {
          j++;
          break;
        }
        if (!t.startsWith("-") || t === "-") break;
        if (spec.notExecIf?.has(t)) notExec = true;
        j += spec.argOpts?.has(t) && !t.includes("=") ? 2 : 1;
      }
      if (notExec) break;
      j += spec.positional ?? 0;
      if (j >= tokens.length) break;
      i = j;
    }
    // find -exec / -execdir / -ok / -okdir 之后是一个新的程序位置（可多次出现）
    const last = positions[positions.length - 1];
    if (last !== undefined && path.basename(tokens[last]) === "find") {
      for (let k = i + 1; k < tokens.length; k++) {
        if (FIND_EXEC_ACTIONS.has(tokens[k]) && k + 1 < tokens.length) walk(k + 1);
      }
    }
  };
  walk(0);
  return positions;
}

/**
 * 一个简单命令里所有处在「程序位置」的名字（去引号 / 去转义 / 取 basename）：
 * 命令头、沿 wrapper 链往下的每一层（`env FOO=1 nohup sudo id` → env、nohup、sudo、id），
 * 以及 `find … -exec <程序>` 的程序。
 *
 * 用途：判「是不是在执行 X」——这是程序位置的问题，不是原文里有没有 X 字样的问题
 * （`grep -n "sudo 命令" f` 不在执行 sudo）。
 *
 * 引号未闭合时返回 null，调用方应回退到原文判定（宁严勿松）。
 */
export function listInvokedPrograms(sub: string): string[] | null {
  if (!hasBalancedQuotes(sub)) return null;
  const tokens = tokenizeWithPositions(sub).map((t) => t.value);
  return programPositionIndexes(tokens).map((i) => path.basename(tokens[i]));
}

/** 把参数当脚本执行的 shell（`sh -c '<脚本>'`） */
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "ash", "mksh"]);

export interface CanonicalCommand {
  /** 命令头规范化后的整条（参数保持原文）；与原文相同时为 null */
  canonical: string | null;
  /** 规范化后的程序名 */
  program: string;
  /** 程序之后的参数（去引号值） */
  args: string[];
  /** 需要递归展开的内层脚本（sh -c / eval） */
  innerScripts: string[];
}

const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * D1：段首可跳过的 shell 关键字——它们自己不占「程序位」，后面紧跟的才是要执行的命令。
 *
 * 与 `COMMAND_PREFIX_KEYWORDS`（供 `programPositionIndexes` 判命令替换位置用）刻意分开：
 * 那个集合的取值直接决定注入层「这处替换的结果会不会被当程序执行」，往里面加词会改变
 * A3 那半边的判定面；这里只服务危险层的程序位归一化，两边各管各的。
 */
const SHELL_PREFIX_KEYWORDS = new Set([
  "if",
  "then",
  "elif",
  "else",
  "while",
  "until",
  "do",
  "!",
  "time",
  "select",
  "case",
]);

/** 段尾的收尾关键字：它们后面没有程序，整段不含可执行命令 */
const SHELL_CLOSER_KEYWORDS = new Set(["fi", "done", "esac", "}", ")"]);

/** 函数定义头：`f()` / `f(){` / `function f {` 之后才是函数体里的命令 */
const FUNCTION_HEAD_RE = /^[A-Za-z_][\w-]*\(\)\{?$/;

/**
 * D1：剥掉「整段被一对分组括号包裹」的外层（`(rm -rf /)` → `rm -rf /`）。
 *
 * 只剥**首字符的括号与末字符的括号确实配对**的形态：`$(` / `${` 是命令替换与变量展开，
 * 不是分组，`x=(a b)` 的 `(` 前紧邻 `=` 是数组赋值，三种都不剥（`(rm` 这种段内孤立
 * 前括号也不会被当成外层包裹，M1 的拆段由 `expandShellCommand` 的 `collectGroupBodies`
 * 负责，不靠这里猜）。
 */
function stripOuterGroup(sub: string): string {
  const text = sub.trim();
  const open = text[0];
  if (open !== "(" && open !== "{") return sub;
  const close = open === "(" ? ")" : "}";
  if (!text.endsWith(close) || text.length < 2) return sub;

  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\" && !inSingle) {
      i++;
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
    if (inSingle || inDouble) continue;
    // `${` 与 `$(` 不是分组括号
    if (ch === "$" && (text[i + 1] === "(" || text[i + 1] === "{")) {
      i++;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      // 首括号在段中间就闭合了（`((x++))` 的算术 / `(a; b) | (c; d)` 的某一侧）：
      // 不是「整段包裹」，保持原样交给调用方
      if (depth === 0 && i !== text.length - 1) return sub;
    }
  }
  if (depth !== 0) return sub;
  return text.slice(1, -1);
}

/**
 * D1：把简单命令段归一化成「只留真正要执行的程序 + 参数」。
 *
 * 危险命令层按 program 位做 token 判定（`judgeCommand` 要求 `program === "rm"`），
 * 而 `splitCommandStructure` 为了与 `splitCompoundCommand` 口径一致，不在分组内拆段
 * （checker 的 `flatCount` 一致性断言依赖这一点）。于是三种形态的 program 都不是真实程序：
 *
 * - M1 子 shell 分组：`(rm -rf /)` → `(rm`
 * - M2 关键字占位：`if true; then rm -rf /` → `if` / `then`
 * - M3 函数头：`f() { rm -rf /` → `f()`
 *
 * 修前这三种在 always-allow 档静默放行（`(rm -rf /etc)` 没有 `--preserve-root` 兜底）。
 * 归一化只影响「取哪个 token 当程序」，不改变原文——`canonical` 与 stage 的 `text`
 * 仍是原文，`detectRedirections` / 文本正则不受影响。
 */
/**
 * D1：剥掉段尾「悬空」的分组闭括号（拆段后可能出现的 `rm -rf /)`）。
 *
 * 只剥比段内开括号多出来的那些 `)`——`echo $(ls)` 里 `$(` 与 `)` 成对（判为配对），
 * 不会被剥；`echo "hi)"` 的 `)` 在引号里，不参与统计。这样修 M1 的拆段结果时不会
 * 顺手破坏命令替换的原文。
 */
function stripDanglingGroupClosers(text: string): string {
  let open = 0;
  let close = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\" && !inSingle) {
      i++;
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
    if (inSingle || inDouble) continue;
    if (ch === "$" && text[i + 1] === "(") {
      open++;
      i++;
      continue;
    }
    if (ch === "(") open++;
    else if (ch === ")") close++;
  }
  let extra = close - open;
  if (extra <= 0) return text;
  let end = text.length;
  while (end > 0 && extra > 0) {
    const ch = text[end - 1];
    if (/\s/.test(ch)) {
      end--;
      continue;
    }
    if (ch === ")") {
      end--;
      extra--;
      continue;
    }
    break;
  }
  return text.slice(0, end);
}

function normalizeSimpleCommandPrefix(sub: string): string {
  let text = stripDanglingGroupClosers(stripOuterGroup(sub));
  let tokens = tokenizeWithPositions(text);
  let i = 0;
  for (let guard = 0; guard < 16 && i < tokens.length; guard++) {
    const v = tokens[i].value;
    if (SHELL_PREFIX_KEYWORDS.has(v)) {
      i++;
      continue;
    }
    // 函数头 `f()` / `f(){`：跳过它，若后面紧跟 `{` 一并跳过
    if (FUNCTION_HEAD_RE.test(v)) {
      i++;
      if (i < tokens.length && tokens[i].value === "{") i++;
      continue;
    }
    // `function f { … }`：`function` 之后是函数名（不是程序），再之后才是函数体
    if (v === "function") {
      i++;
      if (i < tokens.length) i++;
      if (i < tokens.length && tokens[i].value === "{") i++;
      continue;
    }
    if (v === "{") {
      i++;
      continue;
    }
    // `case x in pat)`：`case` 已在关键字集合里跳过一次，这里跳过 `x in pat)` 这一段
    if (tokens[i - 1]?.value === "case") {
      let j = i;
      while (j < tokens.length && tokens[j].value !== "in") j++;
      if (j < tokens.length) {
        let k = j + 1;
        while (k < tokens.length && !tokens[k].value.endsWith(")")) k++;
        i = k < tokens.length ? k + 1 : tokens.length;
        continue;
      }
      // 没有 `in`：`;;` 把这半段拆开了，这一段不含可执行命令
      return "";
    }
    if (SHELL_CLOSER_KEYWORDS.has(v)) {
      // 收尾关键字开头：整段没有可执行命令
      return "";
    }
    // case 的分支模式 `pat)`：`;;` 把每个分支拆成独立段，除第一支外其余分支都以它开头
    // （`case x in a) echo a;; b) rm -rf /etc;; esac` 的第二段是 `b) rm -rf /etc`）。
    // 段首出现 `xxx)` 这个形态基本只可能来自 case 模式，剥掉它才能看到真实程序位。
    if (/^[^\s()]+\)$/.test(v)) {
      i++;
      continue;
    }
    break;
  }
  if (i === 0) return text;
  if (i >= tokens.length) return "";
  // 用剩余文本重建（保留原 token 间距，args 的解析口径不变）
  const head = tokens[i];
  text = text.slice(head.start);
  return text;
}

export function canonicalizeSimpleCommand(sub: string): CanonicalCommand {
  const normalized = normalizeSimpleCommandPrefix(sub);
  const tokens = tokenizeWithPositions(normalized);
  let i = 0;
  // 1. 前导环境变量赋值
  while (i < tokens.length && ASSIGNMENT_RE.test(tokens[i].value)) {
    // 数组赋值 `x=(a b)`：`( … )` 整段都是赋值，不是命令。不跳过时程序位会落到 `b)`
    // 这种形态上（既存行为，修 M2 的括号归一化时顺手修正）。
    if (tokens[i].value.includes("=(")) {
      i++;
      while (i < tokens.length && !tokens[i].value.endsWith(")")) i++;
      if (i < tokens.length) i++;
      continue;
    }
    i++;
  }
  // 2. 包装命令（可多层：`env FOO=1 nohup timeout 5 curl`）
  for (let guard = 0; guard < 8 && i < tokens.length; guard++) {
    const name = path.basename(tokens[i].value);
    const spec = WRAPPERS[name];
    if (!spec) break;
    let j = i + 1;
    let notExec = false;
    while (j < tokens.length) {
      const t = tokens[j].value;
      if (spec.allowsAssignments && ASSIGNMENT_RE.test(t)) {
        j++;
        continue;
      }
      if (t === "--") {
        j++;
        break;
      }
      if (!t.startsWith("-") || t === "-") break;
      if (spec.notExecIf?.has(t)) notExec = true;
      j += spec.argOpts?.has(t) && !t.includes("=") ? 2 : 1;
    }
    if (notExec) break;
    let positional = spec.positional ?? 0;
    while (positional > 0 && j < tokens.length) {
      j++;
      positional--;
    }
    if (j >= tokens.length) break; // 包装命令后面没有程序：它自己就是程序
    i = j;
  }
  if (i >= tokens.length) return { canonical: null, program: "", args: [], innerScripts: [] };

  const head = tokens[i];
  // 3. 去转义 / 去引号后的程序名，路径形态取 basename（`/usr/bin/curl` → `curl`）
  const program = head.value.includes("/") ? path.basename(head.value) : head.value;
  // 偏移基于归一化后的文本（前缀可能被剥掉），不是原 sub
  const rest = normalized.slice(head.end);
  const canonicalText = `${program}${rest}`.trim();
  const args = tokens.slice(i + 1).map((t) => t.value);

  // 4. 参数即代码的两种形态
  const innerScripts: string[] = [];
  if (SHELLS.has(program)) {
    for (let k = 0; k < args.length; k++) {
      const a = args[k];
      if (a === "--") break;
      if (!a.startsWith("-")) break;
      // `-c` 或组合短选项（`-lc` / `-ec`）
      if (/^-[A-Za-z]*c[A-Za-z]*$/.test(a)) {
        const script = args[k + 1];
        if (typeof script === "string") innerScripts.push(script);
        break;
      }
    }
  } else if (program === "eval" && args.length > 0) {
    innerScripts.push(args.join(" "));
  }

  return {
    canonical: canonicalText !== sub.trim() ? canonicalText : null,
    program,
    args,
    innerScripts,
  };
}

/** 命令替换 / 进程替换在原文里的区间与内层脚本 */
interface SubstitutionSpan {
  start: number;
  end: number;
  body: string;
}

/** 解析结果：替换区间 + 简单命令段的区间 */
interface ShellTextAnalysis {
  spans: SubstitutionSpan[];
  /** 按 `;&|\n(){}` 切出的「段」区间（引号内与替换内部都不切） */
  segments: Array<{ start: number; end: number }>;
}

/** 段分隔符：`;` `&` `|` 换行与括号 / 花括号。引号内与替换内部不算 */
const SEGMENT_BREAK_RE = /[;&|\n(){}]/;

/**
 * 一次扫描拿到「每处替换的区间」和「每个简单命令段的区间」。
 *
 * 两件事必须一起做：段划分要跳过替换内部（`$(a; b)` 的 `;` 不是命令分隔符），
 * 而替换提取又需要知道自己在哪一段里，分两次扫一定会漂移。
 *
 * 口径与 `extractSubstitutionBodies` 完全一致（单引号内是字面量，双引号内的 `$(…)`
 * 照样执行，`$((` 是算术不算替换），因为它就是后者的实现。
 */
function analyzeShellText(cmd: string): ShellTextAnalysis {
  const spans: SubstitutionSpan[] = [];
  const segments: ShellTextAnalysis["segments"] = [];
  let segStart = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (ch === "\\" && !inSingle) {
      i++;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (inSingle) continue;
    if (ch === '"') {
      inDouble = !inDouble;
      continue;
    }
    if (ch === "`") {
      const close = cmd.indexOf("`", i + 1);
      if (close < 0) break;
      spans.push({ start: i, end: close + 1, body: cmd.slice(i + 1, close) });
      i = close;
      continue;
    }
    const opensParen =
      (ch === "$" && cmd[i + 1] === "(" && cmd[i + 2] !== "(") ||
      (!inDouble && (ch === "<" || ch === ">") && cmd[i + 1] === "(");
    if (opensParen) {
      let depth = 1;
      let j = i + 2;
      for (; j < cmd.length && depth > 0; j++) {
        if (cmd[j] === "(") depth++;
        else if (cmd[j] === ")") depth--;
      }
      if (depth === 0) {
        spans.push({ start: i, end: j, body: cmd.slice(i + 2, j - 1) });
      }
      i = j - 1;
      continue;
    }
    if (!inDouble && SEGMENT_BREAK_RE.test(ch)) {
      segments.push({ start: segStart, end: i });
      segStart = i + 1;
    }
  }
  segments.push({ start: segStart, end: cmd.length });
  return { spans, segments };
}

/**
 * 提取命令替换 / 进程替换的内层脚本：`$(…)`、反引号、`<(…)`、`>(…)`。
 * 单引号内是字面量，不提取；双引号内的 `$(…)` 照样执行，要提取。
 */
export function extractSubstitutionBodies(cmd: string): string[] {
  return analyzeShellText(cmd)
    .spans.map((s) => s.body)
    .filter((b) => b.trim() !== "");
}

/** 展开结果 */
export interface ShellCommandExpansion {
  /** 逐子命令的待匹配形态：原文（已 trim）+ 命令头规范化形态，含内层脚本递归展开 */
  variants: string[];
  /** 整段脚本：原命令 + 每一层 sh -c / eval / 命令替换的内层脚本（跨管道模式要整段匹配） */
  scripts: string[];
  /** 逐子命令的规范化程序名与参数（写入目标提取、结构化危险判定用） */
  commands: Array<{ program: string; args: string[]; text: string }>;
  /**
   * 按管道分组的程序名与参数：`curl x | sh` 是 `[[curl], [sh]]`。
   * 「下载并执行」「base64 解码执行」判的就是**同一条管道**里的前后段关系，
   * 扁平的 commands 里看不出谁和谁在同一个管道。
   */
  pipelines: Array<Array<{ program: string; args: string[]; text: string }>>;
  /**
   * 接收者是解释器、且 stdin 就是代码的 heredoc 正文（`python3 - <<'PY' … PY`）。
   *
   * 为什么不并进 `variants` / `scripts`：那两处是「当 shell 命令解析」的口径，供 deny/ask
   * 规则与危险命令判定使用。解释器脚本不是 shell 命令，混进去会改变 Step 2 的判定面。
   * 现状是这类正文**已经**被 `isShellLikeProgram` 认成 shell 脚本递归展开（那是对的，
   * `sh <<EOF` 与 `python <<EOF` 都从 stdin 读代码），但正文里的 `open(...)` 不是 shell
   * 命令，展开不出写目标。所以这里额外留一份**原样正文**给写目标提取用。
   */
  interpreterHeredocs: string[];
  /**
   * 展开没走完：形态数撞上 MAX_VARIANTS 后还有没处理的子命令，或嵌套深度用完时还有内层脚本。
   * 上面五个字段只覆盖已展开的部分，拦截方看到 true 必须按「看不全」保守处理——
   * 修前超出部分静默丢弃，`echo 0 && … && echo 199 && rm -rf /` 在 always-allow 下直接放行。
   */
  truncated: boolean;
}

/** 递归深度上限：`sh -c "bash -c 'eval …'"` 嵌套到这一层已远超正常用法 */
const MAX_DEPTH = 4;
/** 形态数上限：防病态输入把展开撑爆（超出部分不再展开，并置 truncated，拦截方据此 fail-closed） */
const MAX_VARIANTS = 128;

/**
 * 会把 stdin 正文交给**远端 / 容器内** shell 解释的程序。
 *
 * `ssh host <<EOF` 的正文在远端被 login shell 解析，`docker exec -i c sh <<EOF` 在容器里
 * 被 sh 解析——解析发生在别处，但「正文是 shell 脚本」这件事没变，注入层要按脚本扫。
 * 危险命令层不靠这张表（它按 `isShellLikeProgram(owner)` 判，`ssh` 不在其中，宁可漏也不误报）；
 * 注入层是 fail-closed 的，宁可多扫一遍正文。
 */
const REMOTE_SHELL_PROGRAMS = new Set(["ssh", "docker", "podman", "kubectl", "nerdctl", "oc"]);

/** 一个 heredoc 块的接收者归属 */
export interface HeredocOwnership {
  block: HeredocBlock;
  /** 承接这块正文的简单命令段（程序名 + 参数）；null = 认不出接收者 */
  owner: { program: string; args: string[] } | null;
  /**
   * 正文按 **shell 语法**执行（真 shell 接收 / 管道下游是真 shell / 远端 shell）。
   * 注入层（bash 词法差异检测）只对这类正文再扫一遍。
   */
  shellScript: boolean;
  /**
   * 危险命令层口径：正文要作为待判命令递归展开。
   *
   * 比 `shellScript` 宽——`python3 - <<'PY'` 的正文是 Python 代码，bash 词法差异对它
   * 无意义（注入层不该扫），但里面可能写着 `os.system("rm -rf /")`，危险命令层按现状
   * 仍要展开（口径不变，见 §4.2.1）。
   */
  codeForDangerScan: boolean;
  /** 正文由「从 stdin 读代码的解释器」接收（`python3 - <<'PY'`） */
  interpreterStdin: boolean;
}

/**
 * 远端程序收到的 stdin 是否会被某个 shell 解释。
 *
 * 两种成立形态：
 * - 远端命令里点名了 shell（`docker exec -i c sh`、`ssh h bash -s`）；
 * - `ssh host <<EOF` 这种没点名任何命令的形态——远端跑的就是 login shell。
 *
 * `ssh host cat > f <<EOF` 不在此列（点名了 cat，正文是它的数据）。
 */
function remoteShellReceivesScript(program: string, args: string[]): boolean {
  if (!REMOTE_SHELL_PROGRAMS.has(program)) return false;
  // `ssh host 'bash -s'` 的脚本是一个带引号 token（`bash -s`），basename 认不出来——
  // 按空白取第一个词再判，否则「点名了 shell 但 shell 带参数」这一形态会漏。
  if (args.some((a) => isPosixShellProgram(path.basename(a.split(/\s+/)[0] ?? "")))) return true;
  // heredoc 占位符（`<<__SID_HD_0__`）是重定向记号，不是远端要执行的命令名——
  // 不过滤掉它，`ssh h <<EOF` 会被算成「远端执行了两个参数」而漏判。
  const positionals = args.filter((a) => !a.startsWith("-") && !a.includes("<<"));
  if (program === "ssh") {
    // 第一个位置参数是 host；它之后没有别的命令 → 远端 login shell 读正文
    return positionals.length <= 1;
  }
  return false;
}

/**
 * 判定每个 heredoc 块被谁接收、正文该不该按 shell 文本处理。
 *
 * **单一事实源**：`expandShellCommand`（危险命令层，决定正文要不要递归判危险）与
 * `partitionHeredocForScan`（注入层，决定正文要不要按 bash 词法扫）都走它——两层的
 * 「正文归属」判据各写一份必然漂移，2026-11-17 的 A1 误报就是归属判据只在危险层存在。
 */
export function classifyHeredocOwnership(
  stripped: string,
  blocks: readonly HeredocBlock[],
): HeredocOwnership[] {
  const ownership: HeredocOwnership[] = blocks.map((block) => ({
    block,
    owner: null,
    shellScript: false,
    codeForDangerScan: false,
    interpreterStdin: false,
  }));
  if (ownership.length === 0) return ownership;

  const parsedPipelines = splitCommandStructure(stripped).map((pipeline) =>
    pipeline.stages.map((stage) => {
      const c = canonicalizeSimpleCommand(stage);
      return { program: c.program, args: c.args };
    }),
  );

  for (const parsed of parsedPipelines) {
    for (const item of ownership) {
      if (item.owner) continue;
      const placeholder = `<<${item.block.placeholder}`;
      const ownerIdx = parsed.findIndex((p) => p.args.some((a) => a.includes(placeholder)));
      if (ownerIdx < 0) continue;
      const owner = parsed[ownerIdx];
      item.owner = { program: owner.program, args: owner.args };
      // 管道下游是真 shell（`cat <<EOF | sh`）：正文经管道进了 shell，同样按脚本处理
      const downstreamShell = parsed
        .slice(ownerIdx + 1)
        .some((p) => isPosixShellProgram(p.program));
      item.shellScript =
        isPosixShellProgram(owner.program) ||
        downstreamShell ||
        remoteShellReceivesScript(owner.program, owner.args);
      // 危险命令层口径：真 shell / 管道下游 shell / 远端 shell 的正文都要递归判定。
      //
      // 远端那一条是 C-1（2026-11-18）：`ssh h <<'EOF' ⏎ rm -rf /etc ⏎ EOF` 的正文在
      // 远端 login shell 里执行，而修前这里只认 `isShellLikeProgram(owner)` —— `ssh` /
      // `docker` / `kubectl` 都不在其中，正文一条都不判，always-allow 下静默放行
      // （探针实测 8 种远端形态全部 allowed=true）。注入层早就按
      // `remoteShellReceivesScript` 扫这份正文了，两层口径在这里对齐。
      //
      // 只对齐 heredoc 正文：`ssh host 'rm -rf /etc'` 这种「引号里的脚本参数」不在这里处理——
      // 把参数当脚本递归展开会让 `ssh host "echo 'rm -rf / is bad'"` 这类数据文本误报
      // critical 硬拒（无出口），需要单独的「远端参数即代码」判据，见方案附件。
      item.codeForDangerScan =
        isShellLikeProgram(owner.program) ||
        downstreamShell ||
        remoteShellReceivesScript(owner.program, owner.args);
      item.interpreterStdin =
        !downstreamShell && interpreterReadsCodeFromStdin(owner.program, owner.args);
    }
  }
  return ownership;
}

/** heredoc 分区结果：注入层据此决定扫哪几段文本 */
export interface HeredocScanPartition {
  /** 剥掉全部正文后的命令段（`<<__SID_HD_n__` 占位） */
  stripped: string;
  /** 必须按 shell 命令文本扫描的片段：真 shell / 远端 shell 接收者的正文 + 不带引号正文里的 $()/反引号内层 */
  shellFragments: string[];
  /** 分区是否可信：认不出接收者 → false，调用方按原文扫（fail-closed） */
  reliable: boolean;
}

/**
 * 把一条命令按 heredoc 接收者切成「命令段」与「要按脚本扫的正文」。
 *
 * 注入层（`bash-security.ts` 的 `checkInjectionPatterns`）与危险命令层对正文的归属判定
 * 必须一致，所以这里复用 `classifyHeredocOwnership`，不另写一份。
 */
export function partitionHeredocForScan(cmd: string): HeredocScanPartition {
  const { stripped, blocks } = extractHeredocBlocks(cmd);
  // 没有可识别的块（无 heredoc / 未闭合 / `$((1 << 2))`）：stripped 就是原文，
  // 按它扫与按原文扫等价，分区可信。
  if (blocks.length === 0) return { stripped, shellFragments: [], reliable: true };

  const shellFragments: string[] = [];
  let reliable = true;
  for (const item of classifyHeredocOwnership(stripped, blocks)) {
    // 不带引号定界符（`<<EOF`）的正文会先做变量展开与命令替换：`cat <<EOF ⏎ $(rm -rf /) ⏎ EOF`
    // 里的 `$(…)` 在 shell 里**真的会执行**。带引号（`<<'EOF'`）是纯字面量，一条都不取。
    if (!item.block.quoted) {
      shellFragments.push(...extractSubstitutionBodies(item.block.body));
    }
    if (!item.owner) {
      // 认不出接收者（多管道边界 / 解析失败）：调用方回退按原文扫
      reliable = false;
      continue;
    }
    if (item.shellScript) shellFragments.push(item.block.body);
  }
  return { stripped, shellFragments, reliable };
}

/**
 * D1：提取一段命令里所有「裸分组」的内部文本（`( … )`）。
 *
 * 排除三类不是分组的 `(`：`$(` / `$((` 命令替换与算术（命令替换由
 * `extractSubstitutionBodies` 单独展开，重复展开会改变 `scripts` / `variants` 的口径）、
 * `x=(a b)` 数组赋值（`(` 前紧邻 `=`）、`((x++))` 算术（`(` 后紧跟 `(`）。
 *
 * 为什么需要单独提取：`splitCommandStructure` 为了与 `splitCompoundCommand` 保持同一份
 * 拆分口径（checker 的 `flatCount === subCommands.length` 一致性断言），在 `parenDepth > 0`
 * 时一律不拆段。于是 `(echo hi; rm -rf /)` 的整个分组只产出一条 program 为 `(echo` 的命令，
 * 真实命令 `rm -rf /` 完全没进危险层的 `judgeCommand`（D1 的 M1）。
 */
function extractGroupBodies(script: string): string[] {
  const bodies: string[] = [];
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let substDepth = 0; // $( 内部：不提取，交给 extractSubstitutionBodies
  let arithDepth = 0; // (( 算术
  let arrayDepth = 0; // x=( 数组赋值
  let depth = 0; // 裸 ( 分组
  let start = -1;

  for (let i = 0; i < script.length; i++) {
    const ch = script[i];
    if (ch === "\\" && !inSingle) {
      i++;
      continue;
    }
    if (ch === "'" && !inDouble && !inBacktick) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle && !inBacktick) {
      inDouble = !inDouble;
      continue;
    }
    if (ch === "`" && !inSingle && !inDouble) {
      inBacktick = !inBacktick;
      continue;
    }
    if (inSingle || inDouble || inBacktick) continue;

    if (ch === "$" && script[i + 1] === "(") {
      substDepth++;
      i++;
      continue;
    }
    // 替换 / 算术 / 数组内部只做括号配对，不提取
    if (substDepth > 0 || arithDepth > 0 || arrayDepth > 0) {
      if (ch === "(") {
        if (substDepth > 0) substDepth++;
        else if (arithDepth > 0) arithDepth++;
        else arrayDepth++;
      } else if (ch === ")") {
        if (substDepth > 0) substDepth--;
        else if (arithDepth > 0) arithDepth--;
        else arrayDepth--;
      }
      continue;
    }
    if (ch === "(") {
      if (script[i - 1] === "=") {
        arrayDepth = 1;
        continue;
      }
      if (script[i + 1] === "(") {
        arithDepth = 2;
        i++;
        continue;
      }
      depth++;
      if (depth === 1) start = i + 1;
      continue;
    }
    if (ch === ")") {
      if (depth === 0) continue;
      depth--;
      if (depth === 0 && start >= 0) {
        bodies.push(script.slice(start, i));
        start = -1;
      }
      continue;
    }
  }
  return bodies;
}

/**
 * 把一条 bash 命令展开成所有「等价执行形态」。只用于拦截类判定，见文件头「口径」一节。
 */
export function expandShellCommand(cmd: string): ShellCommandExpansion {
  const variants = new Set<string>();
  const scripts = new Set<string>();
  const interpreterHeredocs: string[] = [];
  const commands: Array<{ program: string; args: string[]; text: string }> = [];
  const pipelines: Array<Array<{ program: string; args: string[]; text: string }>> = [];
  let truncated = false;

  /**
   * D1：把分组体里的命令补进 `commands` / `pipelines`（只补危险层判据）。
   *
   * 不往 `variants` 里加：`variants` 同时是文本正则（high/medium）的匹配对象与
   * `detectPrivilegeEscalation` 的输入，往里加拆开的段会改变那一层的判定面；
   * 而 M1 的缺陷只在「按 program 位判 critical」这一层（`judgeCommand`），
   * 所以这里的最小修复面就是 commands / pipelines。
   */
  const collectGrouped = (text: string, level: number) => {
    if (level > MAX_DEPTH) return;
    for (const body of extractGroupBodies(text)) {
      for (const pipeline of splitCommandStructure(body)) {
        const parsed: Array<{ program: string; args: string[]; text: string }> = [];
        for (const stage of pipeline.stages) {
          const c = canonicalizeSimpleCommand(stage);
          if (!c.program) continue;
          const entry = { program: c.program, args: c.args, text: stage };
          commands.push(entry);
          parsed.push(entry);
        }
        if (parsed.length > 0) pipelines.push(parsed);
      }
      collectGrouped(body, level + 1);
    }
  };

  const visit = (script: string, depth: number) => {
    const trimmed = script.trim();
    if (!trimmed) return;
    if (variants.size >= MAX_VARIANTS) {
      truncated = true;
      return;
    }
    // heredoc 正文不参与「整段匹配」：它是数据，修前 `cat > f <<EOF` 的正文会被
    // 跨管道正则（`curl x | sh` 之类）当成命令。正文是否当脚本由接收者决定，见下。
    const { stripped, blocks } = extractHeredocBlocks(trimmed);
    const source = stripped.trim() === "" ? trimmed : stripped.trim();
    if (scripts.has(source)) return;
    scripts.add(source);

    const nested: string[] = [...extractSubstitutionBodies(source)];
    for (const pipeline of splitCommandStructure(source)) {
      const parsed: Array<{ program: string; args: string[]; text: string }> = [];
      for (const stage of pipeline.stages) {
        if (variants.size >= MAX_VARIANTS) {
          truncated = true;
          break;
        }
        variants.add(stage);
        const c = canonicalizeSimpleCommand(stage);
        if (c.canonical) variants.add(c.canonical);
        if (c.program) {
          const entry = { program: c.program, args: c.args, text: stage };
          commands.push(entry);
          parsed.push(entry);
        }
        nested.push(...c.innerScripts);
      }
      // heredoc 正文的归属在 pipeline 循环外统一判（见 classifyHeredocOwnership），
      // 这里不能再各判一份——归属判据两处各写一遍必然漂移，A1 就是那么来的。
      pipelines.push(parsed);
    }

    // D1：分组（`( … )`）内部的命令同样要进危险层判据（M1）。
    collectGrouped(source, 0);

    // heredoc 正文的归属：接收者是解释器（`bash <<EOF`）或管道下游是解释器
    // （`cat <<EOF | bash`）时正文是脚本，要递归判危险；接收者是文件时正文是数据，丢弃。
    for (const item of classifyHeredocOwnership(source, blocks)) {
      // 不带引号定界符（`<<EOF`）的正文会先做变量展开与命令替换，
      // `cat <<EOF ⏎ $(rm -rf /) ⏎ EOF` 里的 `$(…)` 在 shell 里**真的会执行**。
      // 接收者不是 shell 时下面那条 `nested.push(block.body)` 不触发，正文里的
      // 替换就完全没人看——修前这条命令在 always-allow 下直接放行。
      // 带引号（`<<'EOF'`）是纯字面量，一条都不取。
      if (!item.block.quoted) nested.push(...extractSubstitutionBodies(item.block.body));
      if (!item.owner) continue;
      if (item.codeForDangerScan) nested.push(item.block.body);
      // 解释器从 stdin 读脚本（`python3 - <<'PY'`）：正文是代码，不是 shell 命令。
      // 与上面的 nested 不互斥——它已按 shell 口径展开过一遍（现状，不动它，
      // 否则会改 Step 2 的危险命令判定面），这里额外给写目标提取留一份原样正文。
      if (item.interpreterStdin) interpreterHeredocs.push(item.block.body);
    }
    if (depth < MAX_DEPTH) {
      for (const n of nested) visit(n, depth + 1);
    } else if (nested.some((n) => n.trim() !== "")) {
      truncated = true;
    }
  };
  visit(cmd, 0);

  return {
    variants: [...variants],
    scripts: [...scripts],
    commands,
    pipelines,
    interpreterHeredocs,
    truncated,
  };
}

/** 命令替换出现的位置：决定替换的**结果**会不会被当成命令执行 */
type SubstitutionPosition =
  /** 命令位：替换结果就是程序名（`$(curl x)`、`` `cat cmd.txt` ``、`sudo $(cat f)`） */
  | "program"
  /** 参数即代码：`sh -c "$(…)"` / `eval "$(…)"` / `source` / `.` 的参数会被当脚本再跑一遍 */
  | "code-argument"
  /** 参数位：替换结果只作为参数值，内层命令已由 expandShellCommand 单独展开检查 */
  | "argument";

/** 段首是这些程序时，参数位的替换同样会被当作代码执行 */
const CODE_ARGUMENT_PROGRAMS = new Set(["eval", "source", "."]);

/**
 * 每处命令替换落在什么位置。
 *
 * 「有没有替换」不足以决定危险性：`echo $(git rev-parse HEAD)` 的替换在参数位，
 * 内层 `git rev-parse HEAD` 已经被 `expandShellCommand` 展开成独立的 variant 检查过；
 * 而 `$(curl -s x)` 的替换**结果就是程序名**，静态检查根本看不见要执行什么。
 * 修前两者一律 high，于是最普通的 `echo $(date)` 也弹「危险命令」红框——
 * 级别没错但语义错了，用户每次都要在红框里点确认。
 *
 * 位置判定用「占位符 + 程序位置下标」而不是正则：`sh -c "$(…)"` 里的替换在
 * **参数**位置，但那个参数是要执行的脚本，与 `echo $(…)` 完全不同。
 */
function classifySubstitutions(
  cmd: string,
): Array<{ span: SubstitutionSpan; position: SubstitutionPosition }> {
  const { spans, segments } = analyzeShellText(cmd);
  if (spans.length === 0) return [];

  return spans.map((span) => {
    const seg = segments.find((s) => span.start >= s.start && span.start < s.end) ?? {
      start: 0,
      end: cmd.length,
    };
    // 用占位符遮住段内所有替换再分词：否则 `echo $(a b)` 会把内层命令的 token
    // 当成外层的参数，位置判定直接错。
    let masked = "";
    let pos = seg.start;
    const placeholder = new Map<SubstitutionSpan, string>();
    const inSegment = spans.filter((s) => s.start >= seg.start && s.start < seg.end);
    for (const [k, s] of inSegment.entries()) {
      masked += cmd.slice(pos, s.start);
      const ph = `__SID_SUBST_${k}__`;
      placeholder.set(s, ph);
      masked += ph;
      pos = s.end;
    }
    masked += cmd.slice(pos, seg.end);

    const tokens = tokenizeWithPositions(masked).map((t) => t.value);
    const mention = placeholder.get(span);
    if (!mention) return { span, position: "argument" as const };
    const tokenIdx = tokens.findIndex((t) => t.includes(mention));
    if (tokenIdx < 0) return { span, position: "argument" as const };

    const programPositions = programPositionIndexes(tokens);
    if (programPositions.includes(tokenIdx)) return { span, position: "program" as const };

    const headIdx = programPositions[0];
    if (headIdx === undefined) return { span, position: "argument" as const };
    const head = path.basename(tokens[headIdx]);
    // `eval` / `source` / `.`：所有参数都是代码，参数位的替换同样看不穿
    if (CODE_ARGUMENT_PROGRAMS.has(head)) return { span, position: "code-argument" as const };
    // `sh -c <脚本>`：只有 `-c` 后面那个参数是代码；`sh script.sh $(x)` 的替换是普通参数
    if (SHELLS.has(head)) {
      for (let k = headIdx + 1; k < tokens.length; k++) {
        const a = tokens[k];
        if (a === "--") break;
        if (!a.startsWith("-")) break;
        if (/^-[A-Za-z]*c[A-Za-z]*$/.test(a)) {
          if (k + 1 === tokenIdx) return { span, position: "code-argument" as const };
          break;
        }
      }
    }
    return { span, position: "argument" as const };
  });
}

/**
 * 命令替换危险判定（取代 DANGEROUS_PATTERNS 里的「命令替换注入」正则）。
 *
 * ## 判据
 *
 * - **命令位**（替换结果就是程序名）→ high：静态看不见要执行什么。
 * - **参数即代码**（`sh -c` / `eval` / `source` / `.` 的参数）→ high：同理。
 * - **参数位** → 不报：内层命令已经作为独立 variant 过了一遍全部危险判定
 *   （`echo $(rm -rf /)` 因此仍命中 critical「递归删除根目录」）。
 * - **引号没闭合** → high：位置判定不可信，且内层命令根本没被提取
 *   （`echo "$(date` 修前在 always-allow 下静默放行）。
 *
 * ## 为什么不在这一层递归判内层危险
 *
 * 内层命令已经被 `expandShellCommand` 展开进 `variants`，Step 2 的每一条判定
 * （结构化 critical、sudo 程序位、其余正则）都会看见它。在这里再判一遍等于
 * 第二份口径，迟早与 variants 那条漂移。
 */
export function detectCommandSubstitutionDanger(
  expansion: ShellCommandExpansion,
  originalCommand: string,
): { name: string; severity: "high" } | null {
  const name = "命令替换注入";
  // 解析失败 fail-closed：只在**确实含替换**时才报，纯引号笔误不该变成危险命令
  if (!hasBalancedQuotes(originalCommand) && /`|\$\(|<\(|>\(/.test(originalCommand)) {
    return { name, severity: "high" };
  }
  for (const script of expansion.scripts) {
    if (!hasBalancedQuotes(script)) continue;
    const classified = classifySubstitutions(script);
    if (classified.some((c) => c.position !== "argument")) return { name, severity: "high" };
  }
  return null;
}

/** 参数即写入目标的命令（全部非选项参数） */
const ALL_ARGS_WRITE = new Set([
  "tee",
  "touch",
  "mkdir",
  "rm",
  // `mv` 的**源**同样会消失：`mv .git/hooks/pre-commit /tmp/x` 与 `rm` 同一后果。
  // 修前它在 LAST_ARG_WRITE 里只取最后一个非选项参数（目标），源路径完全漏掉。
  "mv",
  "rmdir",
  "unlink",
  "truncate",
  "chmod",
  "chown",
  "chgrp",
]);

/** 内联脚本程序：`sed -i` / `perl -pi` 的**脚本**参数不是写入目标，单独判 */
const INLINE_SCRIPT_PROGRAMS = new Set(["sed", "perl"]);
/** `<` `>` `>>` `2>` `&>` `>|` 等重定向记号（可带紧贴的目标，如 `>f`） */
const REDIRECT_TOKEN_RE = /^(\d*|&)?(<|>{1,2}\|?|<<<?)/;
/** 最后一个非选项参数是写入目标（这些命令不破坏源，只取目标） */
const LAST_ARG_WRITE = new Set(["cp", "install", "ln", "rsync", "scp"]);

/** git 全局选项里带独立取值的那几个（`git -C dir diff`），取值不是子命令 */
const GIT_GLOBAL_OPTS_WITH_VALUE = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--config-env",
]);

/**
 * git 的写文件参数。修前 `extractBashWriteTargets` 没有 git 分支：
 * `git diff --output=.git/hooks/pre-commit`、`git format-patch -o .git/hooks`
 * 在 always-allow 下绕过 safetyCheck 的 hook 目录保护（`cp` 写同一路径会被拦）。
 *
 * - `--output=<f>` / `--output <f>`：diff 族选项，diff / log / show / format-patch / range-diff
 *   都接受。不按子命令限定——git 不认的组合自己会报错，这里宁多勿少（见下方函数头）。
 * - format-patch 的 `-o <dir>` / `--output-directory[=]<dir>`：写的是目录。目录本身只命中宽泛的
 *   `.git/`，safetyCheck 的目录模式要求路径「包含 /<dir>/」，所以另加 `<dir>/_` 占位，
 *   让目录下的文件（真正落盘的 0001-*.patch）也能被判到。
 * - `--` 之后是路径参数，不是选项（`git diff -- --output=x` 里的 x 是被比较的文件）。
 *
 * 已知局限：`-C <dir>` 改变的是写目标的相对基准，这里不修正，仍按调用方 cwd 解析。
 */
function gitOutputTargets(args: string[]): string[] {
  const out: string[] = [];
  let k = 0;
  // 跳过全局选项，找子命令
  while (k < args.length && args[k].startsWith("-")) {
    if (GIT_GLOBAL_OPTS_WITH_VALUE.has(args[k])) k++;
    k++;
  }
  const sub = args[k];
  const addDir = (d: string) => {
    if (!d) return;
    out.push(d);
    out.push(`${d.replace(/\/+$/, "")}/_`);
  };
  for (k = k + 1; k < args.length; k++) {
    const a = args[k];
    if (a === "--") break;
    if (a.startsWith("--output=")) out.push(a.slice("--output=".length));
    else if (a === "--output" && args[k + 1]) out.push(args[++k]);
    else if (sub === "format-patch") {
      if (a.startsWith("--output-directory=")) addDir(a.slice("--output-directory=".length));
      else if ((a === "-o" || a === "--output-directory") && args[k + 1]) addDir(args[++k]);
      else if (/^-o.+/.test(a)) addDir(a.slice(2));
    }
  }
  return out;
}

/**
 * 解释器程序名：`-c` / `-e` 之后是代码串，代码里的路径字面量可能是写目标。
 * 与 `shell-structure.ts` 的 `isShellLikeProgram` 是同一张表，但**用途不同**——
 * 那边判「stdin 是不是代码」，这边判「有没有 `-c`/`-e` 代码串」，刻意不合并。
 */
const INTERPRETER_RE = /^(python[23]?(\.\d+)?|node|nodejs|bun|perl|ruby)$/;

/**
 * 明确的写 API。判据必须**区分读写**：
 * 本机 959 会话实测解释器用 `open(path)` 只读的合法操作有 122 条（读审计日志、
 * 读 settings.json 做统计），把它们当写会直接误伤日常用法。
 */
const WRITE_API_RE =
  /\b(?:writeFileSync|writeFile|write_text|write_bytes|appendFileSync|appendFile|unlinkSync|unlink|rmSync|rmdirSync|rmdir|renameSync|rename|copyFileSync|copyFile|truncateSync|truncate|mkdirSync|mkdir|Bun\.write|shutil\.(?:rmtree|move|copy2?|copyfile)|os\.(?:remove|unlink|rename|rmdir)|fs\.(?:writeFile|appendFile|unlink|rm|rename|mkdir|rmdir))\b/;

/** `open(path, 'w'|'a'|'x'|'+')`：第二个参数含 w/a/x/+ 才算写；`open(path)` / `open(path,'r')` 是读 */
const OPEN_WRITE_RE = /\bopen\s*\(\s*[^(),]+,\s*(['"])[^'"]*[wax+][^'"]*\1/;

/**
 * 解释器的「代码串」参数：`-c` / `-e` / `--eval` / `--print` 之后的那一个。
 *
 * 组合短选项（`-pe` / `-lc`）按「含 c/e/p 即认」，与 `dangerous-command.ts` 的
 * `shortOptionValue` 同口径。刻意**不含 `i`**：perl 的 `-i` 是「原地编辑」开关，
 * 真正的代码在紧邻的 `-e` 里；把 `i` 也算进来会把 `-e` 这个选项字符串当成代码。
 */
function interpreterCode(args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") break;
    if (a.startsWith("--")) {
      if (a === "--eval" || a === "--print") return args[i + 1] ?? null;
      continue;
    }
    if (!a.startsWith("-") || a === "-") continue;
    if (/^-[A-Za-z]*[cep][A-Za-z]*$/.test(a)) return args[i + 1] ?? null;
  }
  return null;
}

/**
 * 解释器是不是把 heredoc 正文当**脚本**（`python3 - <<'PY'`）。
 * `python3 script.py <<EOF` 的正文是 stdin 数据，不是代码。
 */
function interpreterReadsCodeFromStdin(program: string, args: string[]): boolean {
  if (!INTERPRETER_RE.test(program)) return false;
  if (interpreterCode(args) !== null) return false; // 已有 -c/-e，stdin 是数据
  for (const a of args) {
    if (!a || a.startsWith("<<__SID_HD_")) continue; // heredoc 占位符不是位置参数
    if (a === "-") return true; // 显式 "-"：从 stdin 读脚本
    if (a.startsWith("-")) continue; // 解释器选项
    return false; // 有脚本文件参数
  }
  return true; // 没有位置参数：解释器默认从 stdin 读
}

/** 代码串里的字符串字面量 → 路径候选（与 tool/jit-affected-paths.ts 的 bashWriteTargets 同一套过滤） */
function literalPathCandidates(code: string): string[] {
  const out: string[] = [];
  // 超长代码通常是 heredoc 灌的大段内容，只判前段，避免扫描在极端输入上退化
  const src = code.length > 4000 ? code.slice(0, 4000) : code;
  for (let i = 0; i < src.length; i++) {
    const quote = src[i];
    if (quote !== "'" && quote !== '"') continue;
    let j = i + 1;
    let value = "";
    let escaped = false;
    for (; j < src.length; j++) {
      const ch = src[j];
      if (ch === "\\" && j + 1 < src.length) {
        escaped = true;
        j++;
        continue;
      }
      if (ch === quote) break;
      value += ch;
    }
    i = j;
    // 转义 / 未闭合：可能是正则或没写完的串，不猜
    if (escaped || j >= src.length) continue;
    if (!isPathLikeLiteral(value)) continue;
    if (!out.includes(value)) out.push(value);
    if (out.length >= 32) break; // 病态输入上限
  }
  return out;
}

function isPathLikeLiteral(value: string): boolean {
  if (!value || value.length > 240) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return false; // URL 不是本地路径
  // 设备 / 临时目录不在受保护面，提出来只会多判一次
  if (value.startsWith("/dev/") || value.startsWith("/tmp/")) return false;
  // 连分隔符或扩展名都没有的字符串不是路径（`'w'`、`'utf-8'` 这类写模式 / 编码）
  return value.includes("/") || value.includes(".");
}

/**
 * 解释器代码串里的写目标候选（L3）。
 *
 * 两条判据同时满足才提取：① 代码串里有**写 API**（或 `open(...,'w'|'a'|'x'|'+')`）；
 * ② 代码串里有字面量路径。提到什么不判「该不该拦」——候选统一交给 safetyCheck，
 * 命中受保护路径才产生确认。
 *
 * 已知局限（静态分析的能力上限，不在本方案修）：拼接 / 变量 / `getattr` 反射拼出的
 * 路径看不出来。这一档由 L4（always-allow 下「写 API 但目标不可判定」落确认）兜底，另开 PR。
 */
function interpreterWriteTargets(program: string, args: string[]): string[] {
  if (!INTERPRETER_RE.test(program)) return [];
  const code = interpreterCode(args);
  if (code === null) return [];
  return writeTargetsFromCode(code);
}

function writeTargetsFromCode(code: string): string[] {
  if (!WRITE_API_RE.test(code) && !OPEN_WRITE_RE.test(code)) return [];
  return literalPathCandidates(code);
}

/**
 * `sed -i` / `perl -pi` 的文件参数：跳过内联脚本。
 *
 * 为什么必须跳：`sed -i 's/a/b/' f` 里的 `s/a/b/` 是**脚本**，收进来会让 checkpoint
 * 去快照一个不存在的文件（`/undo` 列表里多一条噪音）。安全侧多一个候选只是多判一次，
 * 但两侧现在共用同一份提取（`writeTargetsFromExpansion`），所以统一在这里收口。
 *
 * 只有「原地编辑」才写文件：`sed -e 's/a/b/' f` / `perl -pe '…' f` 是只读。
 */
function scriptProgramTargets(args: string[]): string[] {
  const inplace = args.some(
    (a) => a === "--in-place" || a.startsWith("--in-place=") || /^-[A-Za-z]*i/.test(a),
  );
  if (!inplace) return [];

  const out: string[] = [];
  let scriptSeen = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a) continue;
    // `-e <脚本>` / `--expression <脚本>` / `-f <脚本文件>`：显式给出的脚本，不是写入目标
    if (a === "-e" || a === "--expression" || a === "-f" || a === "--file") {
      i++;
      scriptSeen = true;
      continue;
    }
    if (a.startsWith("--expression=") || a.startsWith("--file=")) {
      scriptSeen = true;
      continue;
    }
    if (a.startsWith("-")) {
      // 组合短选项里的 e（`-pe` / `-pie`）：下一个参数是代码
      if (/^-[A-Za-z]*e[A-Za-z]*$/.test(a)) {
        i++;
        scriptSeen = true;
      }
      continue;
    }
    if (!scriptSeen) {
      scriptSeen = true; // 没有 -e/-f 时，第一个非选项参数就是内联脚本
      continue;
    }
    out.push(a);
  }
  return out;
}

/** find 的副作用动作：会真的删 / 写文件，或执行任意命令 */
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

/**
 * `find` 的起点目录（L2）。
 *
 * 只取起点，不展开 `-name` / `-path` 过滤器：`find .git/hooks -name x -delete` 的起点
 * 命中保护目录即够拦；`find . -name '*.ts' -delete` 的起点 `.` 不命中，就不新增确认——
 * safetyCheck 的语义是保护特定路径，不是「所有删除都确认」。
 * `-exec rm {} \;` 的参数 `{}` 静态不可知，起点目录已覆盖「在受保护目录内执行任意命令」。
 */
function findWriteTargets(args: string[]): string[] {
  if (!args.some((a) => FIND_SIDE_EFFECT_ACTIONS.has(a))) return [];
  const start = args.find((a) => a !== "" && !a.startsWith("-"));
  return [start ?? "."];
}

/** `git rm` / `git mv` / `git restore` 的位置参数必是路径；`git checkout` 的首个位置参数可能是分支 */
const GIT_PATH_SUBCOMMANDS = new Set(["rm", "mv", "restore"]);
/**
 * git 里带独立取值、且取值**不是路径**的选项：
 * - `git restore -s HEAD~1 file`：`-s` / `--source` 的取值是 tree-ish；
 * - `git checkout -b feat/x` / `-t origin/main`：取值是分支名 / 上游。
 *   不跳过的话 `feat/x` 含 `/`，会被下面的「看起来像路径」启发式收成写目标。
 */
const GIT_PATH_OPTS_WITH_VALUE = new Set([
  "-s",
  "--source",
  "--pathspec-from-file",
  "-b",
  "-B",
  "--orphan",
  "--track",
  "-t",
]);

/**
 * git 的**破坏性**子命令的路径参数（L1）。
 *
 * 修前 `git rm .git/hooks/pre-commit` / `git checkout -- <hook>` 在 always-allow 下
 * 直接放行——同一件事写成 `rm .git/hooks/pre-commit` 会被 Step 6 拦。
 *
 * - `git rm` / `git mv` / `git restore`：位置参数必是路径（这三个不接受分支名），
 *   `--` 前后都收。
 * - `git checkout`：位置参数可能是分支 / commit，只收**看起来像路径**的（含 `/` 或 `.`）
 *   与 `--` 之后的。`git checkout main` 不收（切分支），`git checkout foo.ts` 收
 *   （checkpoint 侧要靠它给 `/undo` 留快照）。判不准的复杂形态不猜（方案 R8）。
 */
function gitWritePathTargets(args: string[]): string[] {
  let k = 0;
  while (k < args.length && args[k].startsWith("-")) {
    if (GIT_GLOBAL_OPTS_WITH_VALUE.has(args[k])) k++;
    k++;
  }
  const sub = args[k];
  if (!sub) return [];
  const isCheckout = sub === "checkout";
  if (!isCheckout && !GIT_PATH_SUBCOMMANDS.has(sub)) return [];

  const out: string[] = [];
  let afterDashes = false;
  for (let i = k + 1; i < args.length; i++) {
    const a = args[i];
    if (a === "--") {
      afterDashes = true;
      continue;
    }
    if (!afterDashes) {
      if (a.startsWith("-")) {
        // 选项的取值不是路径：`git restore -s HEAD~1 file`
        if (GIT_PATH_OPTS_WITH_VALUE.has(a)) i++;
        continue;
      }
      // checkout 的位置参数可能是分支名：只收看起来像路径的（`main` 不是，`foo.ts` 是）
      if (isCheckout && !a.includes("/") && !a.includes(".")) continue;
    }
    if (a) out.push(a);
  }
  return out;
}

/**
 * 从一次展开结果里提取写目标——safetyCheck 与 checkpoint 的**唯一**事实源。
 *
 * 宁多勿少：多出来的候选只会被 safetyCheck 判一次「是不是受保护路径」，不是就放过；
 * 漏一个则是一条免确认写入 hook 的路径。
 *
 * 为什么抽成独立函数：checkpoint 侧（`getBashAffectedFiles`）与 safetyCheck 侧
 * （`extractBashWriteTargets`）原先是两套实现，实测 `perl -pi` 在安全侧能识别、
 * 在 checkpoint 侧不能，`mv` 源则反过来——修一处不会自动修另一处。
 */
export function writeTargetsFromExpansion(expansion: ShellCommandExpansion): string[] {
  const { commands, scripts, interpreterHeredocs } = expansion;
  const targets = new Set<string>();
  for (const s of scripts) {
    for (const t of detectRedirections(s).targets) targets.add(t);
  }
  for (const { program, args } of commands) {
    const nonOpt: string[] = [];
    for (let k = 0; k < args.length; k++) {
      const a = args[k];
      // 重定向记号与它的目标不是命令参数（目标已由上面 detectRedirections 收走）
      if (REDIRECT_TOKEN_RE.test(a)) {
        if (/[<>]$/.test(a)) k++;
        continue;
      }
      if (program === "dd" && a.startsWith("of=")) targets.add(a.slice(3));
      if (
        (program === "cp" || program === "mv" || program === "install" || program === "ln") &&
        (a === "-t" || a === "--target-directory")
      ) {
        if (args[k + 1]) targets.add(args[k + 1]);
      }
      if (a.startsWith("--target-directory=")) targets.add(a.slice("--target-directory=".length));
      if (program === "curl" && (a === "-o" || a === "--output") && args[k + 1])
        targets.add(args[k + 1]);
      if (program === "curl" && /^-o.+/.test(a)) targets.add(a.slice(2));
      if (program === "wget" && (a === "-O" || a === "--output-document") && args[k + 1])
        targets.add(args[k + 1]);
      if (program === "wget" && a.startsWith("--output-document="))
        targets.add(a.slice("--output-document=".length));
      if (!a.startsWith("-")) nonOpt.push(a);
    }
    if (program === "git") {
      for (const t of gitOutputTargets(args)) targets.add(t);
      for (const t of gitWritePathTargets(args)) targets.add(t);
    }
    if (program === "find") for (const t of findWriteTargets(args)) targets.add(t);
    // `sed -i` / `perl -pi` 的文件参数（脚本 token 已跳过）
    if (INLINE_SCRIPT_PROGRAMS.has(program)) {
      for (const t of scriptProgramTargets(args)) targets.add(t);
    }
    for (const t of interpreterWriteTargets(program, args)) targets.add(t);
    if (ALL_ARGS_WRITE.has(program)) for (const a of nonOpt) targets.add(a);
    if (LAST_ARG_WRITE.has(program) && nonOpt.length >= 2) targets.add(nonOpt[nonOpt.length - 1]);
  }
  // 解释器 heredoc：正文是代码，不是 shell 命令，走同一套「写 API + 字面量」判据
  for (const body of interpreterHeredocs) {
    for (const t of writeTargetsFromCode(body)) targets.add(t);
  }
  return [...targets].filter((t) => t !== "" && t !== "-" && !t.startsWith("&"));
}

/**
 * 提取 bash 命令可能写入的文件路径（供 safetyCheck 对 `.git/hooks` 等可执行路径做保护）。
 *
 * 实测（修前，always-allow）：
 * `cp x .git/hooks/pre-commit` / `tee .git/hooks/pre-commit` / `sed -i … .git/hooks/pre-commit`
 * 全部静默放行——Step 2 的重定向检测只认 `>`，不认这些命令。
 * 同一类失明还有：`mv` 的源路径、`git rm` / `git checkout --` 的路径参数、`find -delete`
 * 的起点、解释器 `-c`/`-e` 与解释器 heredoc 里的写路径（本次一并补齐）。
 */
export function extractBashWriteTargets(cmd: string): string[] {
  return writeTargetsFromExpansion(expandShellCommand(cmd));
}

/**
 * 读类命令的「哪些参数是文件路径」（B5）。
 *
 * ## 为什么和写目标表分开
 *
 * 两张表回答的是不同问题，判据方向也相反：
 * - 写目标**宁多勿少**——漏一个就是一条免确认写入（`cp x .git/hooks/pre-commit`）；
 * - 读路径**宁准勿滥**——多认一个非路径 token（`head -n 5` 的 `5`）会被解析成
 *   `<cwd>/5`，虽然落在工作区内不会误报，但把「这到底是不是路径」的成本转嫁给了用户。
 *
 * 所以写目标表里那些 `ALL_ARGS_WRITE` 兜底命令（`tee`/`mkdir`/`rm`）在这里没有对应项，
 * 而读表里列出的命令在写表里也基本没有。
 *
 * ## 数据来源
 *
 * 命令与参数位置照 claude-code 的 `PATH_EXTRACTORS`（`tools/BashTool/pathValidation.ts`）首批，
 * 覆盖本仓 `READ_ONLY_COMMANDS` 里所有带文件参数的只读命令。**`git` 刻意不在表里**：
 * 它的路径参数（`git show HEAD:f`、`git -C <dir>`）由只读 git 的边界判定管，
 * 两处一起管会让同一个路径被两条口径各判一次，结论打架时没人说得清哪条对。
 */
interface ReadPathSpec {
  /** 取全部非选项参数 */
  all?: boolean;
  /** 首个非选项参数不是路径（`grep` 的模式 / `sed` 的脚本 / `jq` 的 filter） */
  firstIsPattern?: boolean;
  /** 只取前 N 个非选项参数（`find` 的起点、`diff` 的两个操作数） */
  take?: number;
  /**
   * 这些选项本身就携带模式/脚本，出现时首个位置参数不再是模式。
   * 与 `valueOpts` 分开写：`grep -f pat.txt` 里 `-f` 既是「带值选项」又是「模式来源」。
   */
  patternOpts?: ReadonlySet<string>;
  /** 带独立取值的选项：下一个 token 是它的值，不是路径 */
  valueOpts?: ReadonlySet<string>;
}

const READ_PATH_SPECS: Readonly<Record<string, ReadPathSpec>> = {
  // ── 全部位置参数都是被读取的文件 ──
  cat: { all: true },
  head: { all: true, valueOpts: new Set(["-n", "-c", "--lines", "--bytes"]) },
  tail: {
    all: true,
    valueOpts: new Set(["-n", "-c", "-s", "--lines", "--bytes", "--sleep-interval"]),
  },
  less: {
    all: true,
    valueOpts: new Set(["-b", "-h", "-j", "-o", "-O", "-p", "-P", "-t", "-T", "-x", "-y", "-z"]),
  },
  more: { all: true },
  wc: { all: true, valueOpts: new Set(["--files0-from"]) },
  file: {
    all: true,
    valueOpts: new Set(["-e", "-f", "-m", "--exclude", "--files-from", "--magic-file"]),
  },
  stat: { all: true, valueOpts: new Set(["-c", "--format", "--printf"]) },
  du: {
    all: true,
    valueOpts: new Set([
      "-d",
      "-B",
      "-t",
      "-X",
      "--max-depth",
      "--block-size",
      "--threshold",
      "--exclude",
      "--exclude-from",
    ]),
  },
  df: { all: true },
  ls: {
    all: true,
    valueOpts: new Set([
      "-w",
      "-I",
      "-T",
      "--ignore",
      "--width",
      "--hide",
      "--format",
      "--sort",
      "--time",
      "--color",
      "--block-size",
      "--time-style",
      "--quoting-style",
    ]),
  },
  tree: {
    all: true,
    valueOpts: new Set(["-L", "-P", "-I", "-o", "--charset", "--filelimit", "--timefmt"]),
  },
  tac: { all: true },
  nl: { all: true, valueOpts: new Set(["-b", "-n", "-w", "-s", "-v", "-i", "-l"]) },
  od: { all: true, valueOpts: new Set(["-A", "-j", "-N", "-t"]) },
  xxd: { all: true, valueOpts: new Set(["-c", "-g", "-l", "-o", "-s"]) },
  strings: { all: true, valueOpts: new Set(["-a", "-n", "-t", "-e"]) },
  readlink: { all: true },
  realpath: { all: true },
  // 数据处理：位置参数全是输入文件
  paste: { all: true },
  comm: { all: true },
  column: { all: true, valueOpts: new Set(["-s", "-o", "-c", "--separator"]) },
  sort: {
    all: true,
    valueOpts: new Set([
      "-k",
      "-t",
      "-S",
      "-T",
      "-o",
      "--key",
      "--field-separator",
      "--buffer-size",
      "--temporary-directory",
      "--output",
    ]),
  },
  uniq: {
    all: true,
    valueOpts: new Set(["-f", "-s", "-w", "--skip-fields", "--skip-chars", "--check-chars"]),
  },
  cut: {
    all: true,
    valueOpts: new Set([
      "-d",
      "-f",
      "-b",
      "-c",
      "--delimiter",
      "--fields",
      "--bytes",
      "--characters",
    ]),
  },

  // ── 首个位置参数是模式/脚本 ──
  grep: {
    all: true,
    firstIsPattern: true,
    patternOpts: new Set(["-e", "-f", "--regexp", "--file"]),
    valueOpts: new Set([
      "-e",
      "-f",
      "-m",
      "-A",
      "-B",
      "-C",
      "-d",
      "-D",
      "--regexp",
      "--file",
      "--max-count",
      "--after-context",
      "--before-context",
      "--context",
      "--include",
      "--exclude",
    ]),
  },
  egrep: {
    all: true,
    firstIsPattern: true,
    patternOpts: new Set(["-e", "-f"]),
    valueOpts: new Set(["-e", "-f", "-m", "-A", "-B", "-C"]),
  },
  fgrep: {
    all: true,
    firstIsPattern: true,
    patternOpts: new Set(["-e", "-f"]),
    valueOpts: new Set(["-e", "-f", "-m", "-A", "-B", "-C"]),
  },
  rg: {
    all: true,
    firstIsPattern: true,
    patternOpts: new Set(["-e", "-f", "--regexp", "--file"]),
    valueOpts: new Set([
      "-e",
      "-f",
      "-m",
      "-A",
      "-B",
      "-C",
      "-g",
      "-t",
      "-T",
      "-j",
      "--regexp",
      "--file",
      "--max-count",
      "--after-context",
      "--before-context",
      "--context",
      "--glob",
      "--type",
      "--type-not",
      "--threads",
    ]),
  },
  ag: {
    all: true,
    firstIsPattern: true,
    patternOpts: new Set(["-e", "--regexp"]),
    valueOpts: new Set(["-e", "-m", "-A", "-B", "-C", "-g", "--regexp", "--max-count"]),
  },
  ack: {
    all: true,
    firstIsPattern: true,
    patternOpts: new Set(["-e", "--regexp"]),
    valueOpts: new Set(["-e", "-m", "-A", "-B", "-C", "-g", "--regexp", "--max-count"]),
  },
  sed: {
    all: true,
    firstIsPattern: true,
    patternOpts: new Set(["-e", "-f", "--expression", "--file"]),
    valueOpts: new Set(["-e", "-f", "--expression", "--file"]),
  },
  awk: {
    all: true,
    firstIsPattern: true,
    patternOpts: new Set(["-f", "--file"]),
    valueOpts: new Set(["-f", "-F", "-v", "--file", "--field-separator", "--assign"]),
  },
  jq: {
    all: true,
    firstIsPattern: true,
    valueOpts: new Set(["-e", "-f", "--arg", "--argjson", "--slurpfile", "--rawfile"]),
  },
  yq: {
    all: true,
    firstIsPattern: true,
    valueOpts: new Set(["-e", "-f", "--arg", "--argjson", "--from-file"]),
  },

  // ── 只取前 N 个位置参数 ──
  find: { take: 1 },
  diff: {
    take: 2,
    valueOpts: new Set([
      "-U",
      "-C",
      "-x",
      "-I",
      "--label",
      "--unified",
      "--context",
      "--from-file",
      "--to-file",
    ]),
  },
};

/**
 * 从一次展开结果里提取「读类命令会读到的文件路径」。
 *
 * 与 `writeTargetsFromExpansion` 同源（同一份 `expandShellCommand` 结果），
 * 所以 `sh -c 'cat /etc/hosts'` 的内层同样被看到。
 *
 * 输入重定向（`< file` / `n< file`）也算读路径：它不经过任何命令参数，
 * 但结论和 `cat file` 一样——这个文件会被读。`<<` / `<<<` 不是文件（heredoc 正文 /
 * here-string），跳过。
 */
export function readTargetsFromExpansion(expansion: ShellCommandExpansion): string[] {
  const targets = new Set<string>();
  for (const { program, args } of expansion.commands) {
    for (const t of readTargetsForCommand(program, args)) targets.add(t);
  }
  return [...targets].filter((t) => t !== "" && t !== "-");
}

function readTargetsForCommand(program: string, args: string[]): string[] {
  const spec = READ_PATH_SPECS[program];
  const positional: string[] = [];
  const inputRedirects: string[] = [];
  let patternGiven = false;
  let afterDoubleDash = false;

  for (let k = 0; k < args.length; k++) {
    const a = args[k]!;
    if (REDIRECT_TOKEN_RE.test(a)) {
      // 输入重定向的目标是被读取的文件；`<<`(heredoc) / `<<<`(here-string) 不是
      if (/^(\d*)?<$/.test(a)) {
        const target = args[k + 1];
        if (target) inputRedirects.push(target);
        k++;
      } else if (/[<>]$/.test(a)) {
        k++;
      }
      continue;
    }
    if (afterDoubleDash) {
      positional.push(a);
      continue;
    }
    if (a === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (a.startsWith("-") && a !== "-") {
      if (spec?.patternOpts?.has(a)) patternGiven = true;
      if (spec?.valueOpts?.has(a)) k++;
      continue;
    }
    positional.push(a);
  }

  if (!spec) return inputRedirects;

  const skip = spec.firstIsPattern && !patternGiven ? 1 : 0;
  let picked = skip > 0 ? positional.slice(skip) : positional;
  if (spec.take !== undefined) picked = picked.slice(0, spec.take);
  return [...inputRedirects, ...picked];
}

/**
 * 提取 bash 命令会读取的文件路径（B5 的工作区校验用）。
 *
 * 覆盖范围见 `READ_PATH_SPECS`：只读命令里有文件参数的常见一族。
 * 表外的命令返回空数组（等于不做工作区校验）——这是**刻意**的：
 * 把任意程序的位置参数当路径会大面积误报（`echo /etc` 只是打印一个字符串），
 * 而 PR-3 要修的是 `cat`/`grep`/`ls` 这一类的静默越界读。
 */
export function extractBashReadTargets(cmd: string): string[] {
  return readTargetsFromExpansion(expandShellCommand(cmd));
}
