/**
 * allow 复合命令的「其余段」判定：管道下游纯过滤器 + 首段工作区内 `cd`。
 *
 * ## 为什么需要它
 *
 * `checkAllowList` 原先要求复合命令的**每一段**都命中 allow。`allow: ["Bash(bun test *)"]`
 * 下 `bun test x 2>&1 | tail -30` 因为 `tail -30` 不命中而整条落到默认 ask，无头模式直接落拒。
 * harness-bench P1v / P2v 实测 6 次误拦全是这个形态，模型看到拒绝后原样重发，白烧轮次。
 *
 * ## 为什么不用 `isReadOnlyCommand` 判「其余段」
 *
 * 只读集是为「单条只读命令免确认」设计的，从没按「接在 allow 命令后面」的标准审过，
 * 而且审过之后仍然是一张大表（`find` / `awk` / `cat` / `git` 各有一套参数语义）。
 * 拿它当放行条件，`bun test x | awk '{system($0)}'`、`| cat /etc/passwd` 都会被带进来。
 * 这里改用一张**很小的白名单**，每个程序逐个约束参数：只读 stdin、不收文件操作数、
 * 不带写重定向。放行面可以逐条列举，见 `FILTER_SPECS`。
 *
 * 刻意不收：`awk`、`sed`、`xargs`、`tee`、`cat`（带文件就是任意读）、`less`、任何 shell。
 */

import * as path from "node:path";
import { parseBashCommand, splitShellWords, type BashASTNode } from "../tool/bash/parser.ts";

/** 选项解析规格：短选项按字符、长选项按名字，分「布尔」与「带值」两类，表外一律拒绝 */
interface FilterSpec {
  /** 布尔短选项字符（可组合，如 `-nq`） */
  shortBool: string;
  /** 带值短选项字符（值可紧贴，如 `-n30`，也可在下一个 token） */
  shortValue: string;
  longBool?: readonly string[];
  longValue?: readonly string[];
  /** 允许 `-30` 这种「数字即行数」的写法（head / tail） */
  numericShort?: boolean;
  /** 允许的位置参数个数上限（过滤器只读 stdin，绝大多数是 0） */
  maxPositional: number;
  /** 出现这些带值选项时位置参数上限变成 0（grep 用 `-e` 给出模式后，位置参数就是文件了） */
  patternOpts?: readonly string[];
  /** 带值选项的值校验（head / tail 的行数必须是数字，防 `-n *` 被 glob 展开成文件名） */
  validateValue?: (opt: string, value: string) => boolean;
}

const COUNT_RE = /^[+-]?\d+[a-zA-Z]*$/;

const HEAD_TAIL: FilterSpec = {
  shortBool: "fFqvz",
  shortValue: "nc",
  longBool: ["--follow", "--quiet", "--silent", "--verbose", "--zero-terminated"],
  longValue: ["--lines", "--bytes"],
  numericShort: true,
  maxPositional: 0,
  validateValue: (_opt, value) => COUNT_RE.test(value),
};

const GREP: FilterSpec = {
  // 刻意不含 r / R（递归读目录）、f（模式来自文件）、d / D（目录 / 设备动作）
  shortBool: "EFGPivwxcLlnhHoqsbUzaT",
  shortValue: "eABCm",
  longBool: [
    "--extended-regexp",
    "--fixed-strings",
    "--basic-regexp",
    "--perl-regexp",
    "--ignore-case",
    "--invert-match",
    "--word-regexp",
    "--line-regexp",
    "--count",
    "--line-number",
    "--only-matching",
    "--quiet",
    "--silent",
    "--no-messages",
    "--color",
    "--colour",
    "--text",
  ],
  longValue: [
    "--regexp",
    "--max-count",
    "--after-context",
    "--before-context",
    "--context",
    "--color",
    "--colour",
  ],
  maxPositional: 1,
  patternOpts: ["-e", "--regexp"],
};

const FILTER_SPECS: Readonly<Record<string, FilterSpec>> = {
  tail: HEAD_TAIL,
  head: HEAD_TAIL,
  grep: GREP,
  egrep: GREP,
  fgrep: GREP,
  wc: {
    shortBool: "lwcmL",
    shortValue: "",
    longBool: ["--lines", "--words", "--bytes", "--chars", "--max-line-length"],
    maxPositional: 0,
  },
  // 刻意不含 -o / --output（写文件）、--compress-program（执行程序）、-T（写临时目录）
  sort: {
    shortBool: "bdfgiMhnRrVuszc",
    shortValue: "kt",
    longBool: [
      "--reverse",
      "--numeric-sort",
      "--general-numeric-sort",
      "--human-numeric-sort",
      "--version-sort",
      "--month-sort",
      "--unique",
      "--ignore-case",
      "--ignore-leading-blanks",
      "--dictionary-order",
      "--stable",
      "--zero-terminated",
    ],
    longValue: ["--key", "--field-separator"],
    maxPositional: 0,
  },
  // uniq 的第二个位置参数是输出文件，所以一个都不收
  uniq: {
    shortBool: "cdDiuz",
    shortValue: "fsw",
    longBool: ["--count", "--repeated", "--unique", "--ignore-case", "--zero-terminated"],
    longValue: ["--skip-fields", "--skip-chars", "--check-chars"],
    maxPositional: 0,
  },
  cut: {
    shortBool: "snz",
    shortValue: "bcdf",
    longBool: ["--complement", "--only-delimited", "--zero-terminated"],
    longValue: ["--bytes", "--characters", "--delimiter", "--fields", "--output-delimiter"],
    maxPositional: 0,
  },
  // tr 从不接文件，位置参数是字符集
  tr: {
    shortBool: "cCdst",
    shortValue: "",
    longBool: ["--complement", "--delete", "--squeeze-repeats", "--truncate-set1"],
    maxPositional: 2,
  },
  nl: {
    shortBool: "p",
    shortValue: "bdfhilnsvw",
    longValue: [
      "--body-numbering",
      "--section-delimiter",
      "--footer-numbering",
      "--header-numbering",
      "--line-increment",
      "--join-blank-lines",
      "--number-format",
      "--number-separator",
      "--starting-line-number",
      "--number-width",
    ],
    maxPositional: 0,
  },
};

/** fd 复制（`2>&1`、`>&2`）：只在 fd 之间搬运，不落盘。解析器把它们留在 args 里 */
const FD_DUP_RE = /^\d*>&\d+$/;
/** 丢弃型重定向目标，与 parser.ts 的 DISCARD_TARGETS 同口径（必须整段相等） */
const DISCARD_TARGETS = new Set(["/dev/null"]);

/**
 * 原文里会让「一个 token」变成「别的东西」的展开：glob、花括号、波浪号、变量（未加引号时
 * 会再次分词）、命令 / 进程替换。`grep a*` 若当前目录有匹配文件，glob 会把文件名塞成
 * 操作数，过滤器就变成了读文件。解析后的 args 已经去引号，看不出这一点，所以在原文上判。
 */
function hasUnsafeExpansion(stage: string): boolean {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < stage.length; i++) {
    const ch = stage[i];
    if (inSingle) {
      if (ch === "'") inSingle = false;
      continue;
    }
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "`") return true;
    if (ch === "$" && stage[i + 1] === "(") return true;
    if (inDouble) {
      if (ch === '"') inDouble = false;
      continue;
    }
    if (ch === "'") inSingle = true;
    else if (ch === '"') inDouble = true;
    else if ("*?[{~$".includes(ch)) return true;
    else if ((ch === "<" || ch === ">") && stage[i + 1] === "(") return true;
  }
  // 引号未闭合：解析器和 shell 的理解可能不一致，宁严勿松
  return inSingle || inDouble;
}

/** 按 spec 解析参数；表外选项、值不合法、位置参数超限都返回 false */
function argsFitSpec(args: string[], spec: FilterSpec): boolean {
  let positional = 0;
  let maxPositional = spec.maxPositional;
  const longValue = new Set(spec.longValue ?? []);
  const longBool = new Set(spec.longBool ?? []);
  const patternOpts = new Set(spec.patternOpts ?? []);
  const checkValue = (opt: string, value: string | undefined) =>
    value !== undefined && (spec.validateValue?.(opt, value) ?? true);

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") {
      positional += args.length - i - 1;
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = eq > 0 ? a.slice(0, eq) : a;
      if (eq > 0) {
        if (!longValue.has(name) || !checkValue(name, a.slice(eq + 1))) return false;
      } else if (longBool.has(name)) {
        // 布尔长选项
      } else if (longValue.has(name)) {
        if (!checkValue(name, args[++i])) return false;
      } else {
        return false;
      }
      if (patternOpts.has(name)) maxPositional = 0;
      continue;
    }
    if (a.startsWith("-") && a !== "-") {
      if (spec.numericShort && /^-\d+$/.test(a)) continue;
      for (let k = 1; k < a.length; k++) {
        const c = a[k];
        if (spec.shortBool.includes(c)) continue;
        if (!spec.shortValue.includes(c)) return false;
        const value = k + 1 < a.length ? a.slice(k + 1) : args[++i];
        if (!checkValue(`-${c}`, value)) return false;
        if (patternOpts.has(`-${c}`)) maxPositional = 0;
        break;
      }
      continue;
    }
    positional++;
  }
  return positional <= maxPositional;
}

/**
 * 一段管道是否是「只读 stdin、只写 stdout」的纯过滤器（见 FILTER_SPECS）。
 * 只判这一段本身；「必须处在 `|` 之后」由调用方保证。
 */
export function isPipelineFilterStage(stage: string): boolean {
  if (hasUnsafeExpansion(stage)) return false;

  let node: BashASTNode = parseBashCommand(stage);
  // 重定向只认丢弃型写（`2>/dev/null`）；读重定向 `< f` 等于读任意文件，同样拒绝
  while (node.type === "redirect") {
    if (node.mode !== ">" && node.mode !== "n>") return false;
    if (!DISCARD_TARGETS.has(node.file)) return false;
    node = node.target;
  }
  if (node.type !== "simple") return false;
  // 前导赋值（`LD_PRELOAD=… tail`）能改变程序行为，不算纯过滤器
  if (node.envPrefix && Object.keys(node.envPrefix).length > 0) return false;
  // 带路径的程序名（`./tail`）是任意可执行文件
  if (node.command.includes("/")) return false;

  const spec = FILTER_SPECS[node.command];
  if (!spec) return false;
  const args = node.args.filter((a) => !FD_DUP_RE.test(a));
  // 解析器漏剥的重定向记号（如 `>&file`）一律拒绝
  if (args.some((a) => /^\d*[<>]/.test(a) && !/^\d+$/.test(a))) return false;
  return argsFitSpec(args, spec);
}

/**
 * 首段 `cd <dir>` 的目录（只接受一个字面量参数；`cd`、`cd -`、`cd ~`、`cd $X` 都不认）。
 * 返回 null 表示这一段不是可接受的 cd。
 */
export function parseLiteralCdTarget(stage: string): string | null {
  if (hasUnsafeExpansion(stage)) return null;
  if (/[<>]/.test(stage)) return null;
  const tokens = splitShellWords(stage.trim());
  if (tokens.length !== 2 || tokens[0] !== "cd") return null;
  const dir = tokens[1];
  if (!dir || dir.startsWith("-")) return null;
  return dir;
}

/** 解析 cd 目标为绝对路径（相对路径按 cwd） */
export function resolveCdTarget(dir: string, cwd: string): string {
  return path.isAbsolute(dir) ? dir : path.resolve(cwd, dir);
}
