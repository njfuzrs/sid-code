/**
 * 危险命令的**结构化**判定：按「执行的程序 + 参数」判，不再匹配命令原文。
 *
 * ## 为什么必须换判据
 *
 * 原来的 `DANGEROUS_PATTERNS` 是一组对命令文本的正则，而正则分不清「程序在执行什么」
 * 与「参数里写了什么字」。两个方向同时出错（2026-10-26 实测，always-allow 档）：
 *
 * | 形态 | 旧判据结果 | 真相 |
 * | --- | --- | --- |
 * | `git commit -m "rm -rf / was a bad idea"` | **硬拒 critical** | 程序是 git，rm 只出现在参数值里 |
 * | `rm -rf ~/Downloads/old` | **硬拒 critical** | 真的在删，但目标是家目录下的普通子目录 |
 * | `rm -rf '/'` | **放行** | 真的在删根目录，只是加了个引号 |
 * | `rm -Rf /` / `rm --recursive --force /` | **放行** | 真在删根目录，只是换了大写 R / 长选项 |
 * | `rm -rf $HOME` | **放行** | 真在删家目录，只是没写 `~` |
 *
 * 误报的后果不是「多一次确认」：critical 在 `checkUngated` 里是**硬拒绝**，`--yes`、
 * hook allow、allow 规则、熔断都放不过去，管线内没有任何批准出口。所以两类错误必须
 * 同批修——只放宽正则会让漏报更严重（§4.2 已否决「只修正则」）。
 *
 * ## 判据来源
 *
 * `expandShellCommand(cmd)` 的 `commands` 已经给出每个子命令（含 `sh -c` / `eval` /
 * 命令替换内层）去引号、剥 wrapper（`sudo` / `xargs` / `env` / `timeout` 等）、
 * basename 化（`/bin/rm` → `rm`）之后的 `program` 与 `args`；`pipelines` 额外保留了
 * 「哪几段在同一个管道里」——「下载并执行」正是关于管道结构的判断。
 *
 * 危险路径集口径来自 CC（`pathValidation.ts` 的 `isDangerousRemovalPath`），但**刻意收窄**：
 * CC 把「任意深度 `/*` 结尾」都判危险，整套照搬会让 `rm -rf build/*` 变成硬拒
 * （当前是放行的正当操作）。本文件只收 `/`、homedir、`*`、前缀为 `/` 或 homedir 的
 * `/*`、以及根的直接子目录。
 *
 * ## 已知残留（本模块覆盖不到，见 Agent Note）
 *
 * - `echo / | xargs rm -rf`：路径在上一段，rm 的 args 里没有（要管道级数据流追踪）
 * - `cd / && rm -rf *`：`*` 是否危险取决于执行时的 cwd（要追踪同一条命令内的 cd）
 * - `find . -exec rm -rf {} +`：program 是 find，rm 只是参数（要递归解析 -exec）
 */

import * as path from "node:path";
import { detectRedirections } from "./shell-parser.ts";
import type { ShellCommandExpansion } from "./shell-command-variants.ts";

export interface DangerousFinding {
  name: string;
  severity: "critical" | "high" | "medium";
}

export interface DangerContext {
  /** 相对路径的解析基准（与 bash 实际执行目录同口径） */
  cwd: string;
  /** 家目录：`~` / `$HOME` / `${HOME}` 的展开目标 */
  home: string;
}

/**
 * 模式名与原正则表逐字一致——审计日志 `decisionReason.pattern`、UI 提示、
 * 现有测试都按这些名字断言，改名等于悄悄改变可观测口径。
 */
const NAMES = {
  rmRoot: "递归删除根目录",
  rmHome: "递归删除家目录",
  diskWipe: "磁盘擦除",
  mkfs: "格式化磁盘",
  blockDevice: "写入块设备",
  downloadExec: "下载并执行",
  base64Exec: "base64 解码执行",
  xxdExec: "xxd 解码执行",
  pythonExec: "Python exec 执行",
  perlExec: "Perl system 执行",
} as const;

/** 会把 stdin 当代码执行的解释器（管道后段命中它 = 前面下载的内容被直接执行） */
const CODE_EXECUTORS =
  /^(sh|bash|zsh|dash|ksh|fish|ash|mksh|python[23]?(\.\d+)?|perl|ruby|node|nodejs)$/;

/** 下载器：管道前段是它、后段是解释器 → 「下载并执行」 */
const DOWNLOADERS = new Set(["curl", "wget"]);

/**
 * 块设备路径。只列 macOS / Linux 上真实存在的命名，避免把 `/dev/null`、
 * `/dev/stdout`、`/dev/fd/*` 这些「写了也无害」的字符设备卷进来。
 */
const BLOCK_DEVICE_RE = /^\/dev\/(sd|hd|nvme|disk|mmcblk|xvd|vd|loop|md)/;

/** 参数里出现块设备路径就算写入的命令（它们的非选项参数就是写入目标） */
const WRITE_PROGRAMS = new Set(["tee", "cp", "mv", "install", "dd"]);

function isBlockDevicePath(p: string): boolean {
  return BLOCK_DEVICE_RE.test(p.trim());
}

/** 展开 `~` / `$HOME` / `${HOME}`；其余变量静态不可知，留给调用方判 */
function expandHomePath(raw: string, home: string): string {
  if (raw === "~") return home;
  if (raw.startsWith("~/")) return path.join(home, raw.slice(2));
  if (raw === "$HOME" || raw === "${HOME}") return home;
  if (raw.startsWith("$HOME/")) return path.join(home, raw.slice(6));
  if (raw.startsWith("${HOME}/")) return path.join(home, raw.slice(8));
  return raw;
}

/**
 * 判定一个「递归删除的目标」是否危险（口径见文件头）。
 *
 * 不含 symlink 解析：删除看的是用户写下的那个路径。macOS 上 `/tmp` 是指向
 * `/private/tmp` 的链接，按原路径判定才能拦住 `rm -rf /tmp`——这与 safetyCheck
 * 要跟随 symlink（写入保护看实际落盘位置）方向相反，两者都对。
 */
export function isDangerousRemovalPath(raw: string, ctx: DangerContext): boolean {
  const trimmed = raw.trim();
  if (trimmed === "") return false;
  const expanded = expandHomePath(trimmed, ctx.home);

  // 含无法静态展开的变量 / 命令替换：只有「以 * 结尾」时按危险处理
  // （`rm -rf "$DIR"/*` 无法证明安全，宁可多拦；`rm -rf "$BUILD_DIR"` 不拦，
  //  否则项目里常见的清理写法会变成无出口的硬拒）。
  if (/\$|`/.test(expanded)) return /\*$/.test(expanded);

  if (expanded === "*") return true;

  const resolved = path.resolve(ctx.cwd, expanded);
  if (resolved === "/") return true;
  if (resolved === ctx.home) return true;
  if (path.basename(resolved) === "*") {
    const dir = path.dirname(resolved);
    // 前缀是 `/` 或 homedir 的 `/*`；以及 `rm -rf *`（删 cwd 下所有）
    if (dir === "/" || dir === ctx.home || dir === path.resolve(ctx.cwd)) return true;
  }
  // 根的直接子目录：`/usr`、`/etc`、`/tmp` 等（`rm -rf /tmp` 因此硬拒，
  // `rm -rf /tmp/x` 仍放行——这是 §5.6 明示的有意收紧）。
  return path.dirname(resolved) === "/";
}

/** 命中危险路径时区分模式名：家目录 → 「递归删除家目录」，其余 → 「递归删除根目录」 */
function classifyRemovalTarget(raw: string, ctx: DangerContext): "root" | "home" | null {
  if (!isDangerousRemovalPath(raw, ctx)) return null;
  const expanded = expandHomePath(raw.trim(), ctx.home);
  if (/\$|`/.test(expanded)) return "root";
  const resolved = path.resolve(ctx.cwd, expanded);
  if (resolved === ctx.home || resolved.startsWith(ctx.home + path.sep)) return "home";
  return "root";
}

/** `rm` 是否带递归选项：`-r` / `-R` / 组合短选项（`-Rf`、`-fR`）/ `--recursive` */
function hasRecursiveFlag(args: string[]): boolean {
  for (const a of args) {
    if (a === "--") break;
    if (a === "--recursive") return true;
    if (/^-[A-Za-z]*[rR][A-Za-z]*$/.test(a)) return true;
  }
  return false;
}

/**
 * 提取删除类命令的目标路径。
 *
 * `--` 之后一律当路径（`rm -- -/../x` 这种以 `-` 开头的路径，朴素过滤会丢掉），
 * 单个 `-` 是 stdin，不算路径。
 */
function removalPaths(args: string[]): string[] {
  const paths: string[] = [];
  let afterDashDash = false;
  for (const a of args) {
    if (!afterDashDash && a === "--") {
      afterDashDash = true;
      continue;
    }
    if (!afterDashDash && a.startsWith("-")) continue;
    if (a === "-") continue;
    paths.push(a);
  }
  return paths;
}

/** 取短选项的**那一个**参数值（`python -c '<代码>'` / `perl -e '<代码>'`） */
function shortOptionValue(args: string[], letter: string): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") break;
    if (a.startsWith("--") || !a.startsWith("-") || a === "-") continue;
    if (a.slice(1).includes(letter)) return args[i + 1] ?? null;
  }
  return null;
}

/** `base64` 的解码开关（`-d` / `--decode` / `-di` 这类组合短选项） */
function hasDecodeFlag(args: string[]): boolean {
  return args.some(
    (a) => a === "--decode" || (!a.startsWith("--") && /^-[A-Za-z]*d[A-Za-z]*$/.test(a)),
  );
}

/** `xxd` 的反向（十六进制 → 二进制）开关 */
function hasRevertFlag(args: string[]): boolean {
  return args.some(
    (a) => a === "--revert" || (!a.startsWith("--") && /^-[A-Za-z]*r[A-Za-z]*$/.test(a)),
  );
}

/** 逐命令判定：程序 + 参数。`text` 是该 stage 的原文，用于看重定向目标。 */
function judgeCommand(
  program: string,
  args: string[],
  text: string,
  ctx: DangerContext,
): DangerousFinding | null {
  // 递归删除根目录 / 家目录
  if (program === "rm" || program === "rmdir") {
    // rmdir 本身就是删目录，没有递归选项也要判；rm 必须带递归（`rm /x` 只是删文件）
    const recursive = program === "rmdir" || hasRecursiveFlag(args);
    if (recursive) {
      for (const p of removalPaths(args)) {
        const kind = classifyRemovalTarget(p, ctx);
        if (kind === "home") return { name: NAMES.rmHome, severity: "critical" };
        if (kind === "root") return { name: NAMES.rmRoot, severity: "critical" };
      }
    }
  }

  if (program === "dd") {
    // 不看参数顺序：`dd of=… if=…` 与 `dd if=… of=…` 等价
    if (args.some((a) => /^if=\/dev\/(zero|random|urandom)$/i.test(a))) {
      return { name: NAMES.diskWipe, severity: "critical" };
    }
    const of = args.find((a) => /^of=/i.test(a));
    if (of && isBlockDevicePath(of.slice(3))) {
      return { name: NAMES.blockDevice, severity: "critical" };
    }
  }

  // 裸 `mkfs` 与 `mkfs.ext4` / `mkfs.ntfs` 都算（旧正则只认后者）
  if (program === "mkfs" || program.startsWith("mkfs.")) {
    return { name: NAMES.mkfs, severity: "critical" };
  }

  // 写入块设备：重定向目标，或 tee / cp / mv / install 的参数
  const { targets } = detectRedirections(text);
  if (targets.some(isBlockDevicePath)) {
    return { name: NAMES.blockDevice, severity: "critical" };
  }
  if (WRITE_PROGRAMS.has(program) && args.some(isBlockDevicePath)) {
    return { name: NAMES.blockDevice, severity: "critical" };
  }

  // 参数即代码：仍按文本判，但**只判 -c / -e 的那一个参数**，不对整条命令匹配
  if (/^python[23]?(\.\d+)?$/.test(program)) {
    const code = shortOptionValue(args, "c");
    if (code && /\bexec\s*\(/.test(code)) {
      return { name: NAMES.pythonExec, severity: "critical" };
    }
  }
  if (program === "perl") {
    const code = shortOptionValue(args, "e");
    if (code && /\bsystem\s*\(/.test(code)) {
      return { name: NAMES.perlExec, severity: "critical" };
    }
  }

  return null;
}

/**
 * 管道结构判定：前一段取回内容、后一段直接执行。
 *
 * 只看**同一管道**内、前段在后段之前的组合。`git commit -m "curl x | sh"` 里的 `|`
 * 在引号内，`splitCommandStructure` 不会把它拆成两段，所以这里看不到它——误报消失。
 */
function judgePipeline(
  stages: Array<{ program: string; args: string[] }>,
): DangerousFinding | null {
  const executedAfter = (i: number) =>
    stages.slice(i + 1).some((s) => CODE_EXECUTORS.test(s.program));

  for (let i = 0; i < stages.length; i++) {
    const left = stages[i];
    if (DOWNLOADERS.has(left.program) && executedAfter(i)) {
      return { name: NAMES.downloadExec, severity: "critical" };
    }
    if (left.program === "base64" && hasDecodeFlag(left.args) && executedAfter(i)) {
      return { name: NAMES.base64Exec, severity: "critical" };
    }
    if (left.program === "xxd" && hasRevertFlag(left.args) && executedAfter(i)) {
      return { name: NAMES.xxdExec, severity: "critical" };
    }
  }
  return null;
}

/**
 * 结构化危险判定入口：覆盖 10 条 critical（`Fork 炸弹` 仍在 checker 的正则表里，
 * 它对原文匹配，实测 `echo ':(){ :|:& };:'` 不误报）。
 */
export function detectStructuredCriticalDanger(
  expansion: ShellCommandExpansion,
  ctx: DangerContext,
): DangerousFinding | null {
  for (const cmd of expansion.commands) {
    const finding = judgeCommand(cmd.program, cmd.args, cmd.text ?? "", ctx);
    if (finding) return finding;
  }
  for (const pipeline of expansion.pipelines) {
    const finding = judgePipeline(pipeline);
    if (finding) return finding;
  }
  return null;
}
