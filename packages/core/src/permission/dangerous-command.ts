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
 * `/dev/` 下明确无害的字符设备 / 特殊文件：读或写都不破坏任何持久数据。
 *
 * 这里用的是**反向白名单**（`/dev/` 下除这些之外一律当危险设备），不是
 * 「块设备前缀黑名单」。理由见 `isDangerousDeviceTarget`。
 */
const HARMLESS_DEV_TARGET_RE =
  /^\/dev\/(null|zero|random|urandom|stdout|stderr|(fd|pts)\/\w+|tty)$/;

/**
 * `/dev/` 下的**非设备节点**：tmpfs 挂载点里的普通文件（`/dev/shm/x`）。
 * 它们不是块设备，写它们与写普通文件同性质（超出 tmpfs 容量只是写失败）。
 */
const DEV_TMPFS_FILE_RE = /^\/dev\/(shm|mqueue)\//;

/** 参数里出现危险设备路径就算写入的命令（它们的非选项参数就是写入目标） */
const WRITE_PROGRAMS = new Set(["tee", "cp", "mv", "install", "dd"]);

/**
 * 这个路径是不是「写它就可能毁数据」的设备节点。
 *
 * ## 为什么是反向白名单，而不是补前缀
 *
 * 旧实现是九个前缀的黑名单（`sd|hd|nvme|disk|mmcblk|xvd|vd|loop|md`），漏掉
 * macOS 的 `/dev/rdisk*`、LVM 的 `/dev/mapper/*` 与 `/dev/dm-*`、`/dev/ram*`、
 * `/dev/zram*`、`/dev/sr*`。后果是双向的（2026-10-26 实测，always-allow 档）：
 *
 * | 命令 | 旧判据 |
 * | --- | --- |
 * | `dd if=/dev/sdb of=/dev/mapper/vg-lv` | **放行**（现状漏报，静默真写） |
 * | `dd if=/dev/zero of=/dev/rdisk2 count=100` | 拦住，但靠的是 `if=` 误报兜底 |
 *
 * 补前缀等于「等下一个设备名出现再漏一次」，而一次漏报的后果是真擦盘、critical
 * 又不可确认。反向白名单的代价只是多拦几个没见过的设备节点（用户还能靠
 * `--dangerously-skip-permissions` 全局关检测绕过）。在「误拦一个设备节点」与
 * 「漏一次真擦盘」之间，只能选前者。
 *
 * 注意它只判「是不是设备节点」，**普通文件不归它管**：`/tmp/x` 返回 false，
 * 但「往普通文件无 `count=` 地写」仍由 `judgeDdCommand` 判危险。
 */
function isDangerousDeviceTarget(raw: string): boolean {
  const t = raw.trim();
  if (!t.startsWith("/dev/")) return false;
  if (HARMLESS_DEV_TARGET_RE.test(t)) return false;
  // tmpfs 挂载点里的普通文件：不是块设备（`cp x /dev/shm/` 是常见正当用法）
  if (DEV_TMPFS_FILE_RE.test(t)) return false;
  return true;
}

/** 无损去向：`/dev/null` 这类字符设备，以及 dd 约定的 `of=-`（stdout） */
function isHarmlessWritableTarget(raw: string): boolean {
  const t = raw.trim();
  if (t === "-") return true; // dd 约定：`of=-` 是标准输出
  return HARMLESS_DEV_TARGET_RE.test(t);
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

/**
 * `dd` 一支的危险判定。**权限层与 TUI 标红共用这一个函数**——两处各写一份正则
 * 已经漂移过一次（`tool/bash/read-only-validation.ts` 的 `isDestructiveCommand`
 * 仍是旧判据），表现为「权限层放行、界面标红成高危」。
 *
 * ## 为什么不能只看 `if=`
 *
 * `dd` 的危险性由**去向**（`of=`）和**写入量上限**（`count=`）决定，来源只说明
 * 「数据是什么」。只看来源会把两类无害命令判成 critical（无出口的硬拒）：
 *
 * | 命令 | 真相 |
 * | --- | --- |
 * | `dd if=/dev/zero of=/dev/null bs=1M count=1` | 测写入速度，目标 /dev/null |
 * | `dd if=/dev/urandom of=/tmp/key bs=32 count=1` | 生成 32 字节密钥文件 |
 * | `dd if=/dev/urandom \| base64 \| head -c 16` | 生成随机密码 |
 *
 * ## 判定树（有序，顺序本身是判据的一部分）
 *
 * ```text
 * of= 目标 t：
 * ├─ t 是危险设备节点（isDangerousDeviceTarget）      → 拦（磁盘擦除 / 写入块设备）
 * ├─ t 是无损去向（/dev/null、of=- 等）               → 放行（不论有没有 count）
 * ├─ 没有 of=（写 stdout）                            → 放行
 * └─ 其余（普通文件 / 相对路径 / 未知路径）
 *      ├─ 来源是 zero/random/urandom 且无 count=      → 拦 · 磁盘擦除
 *      └─ 有 count=                                   → 放行
 * ```
 *
 * 「无损去向」必须排在「无 count 就拦」之前，否则 `dd if=/dev/zero of=/dev/null`
 * （不带 count 的基准测试写法）修完仍然硬拒。`of=-` 是 dd 约定的 stdout，四条朴素
 * 规则都不覆盖它，必须显式当成无损去向。
 *
 * ## 已知残留（取舍，不是「有 count 就安全」）
 *
 * `dd if=/dev/zero of=<普通文件> count=999999999` 会放行：按默认 bs=512 实写约 512 GB，
 * 足以填满磁盘。按 `bs × count` 估实际写入量被放弃——`bs` 有缺省值、`count=1M` 这类
 * 后缀合法、`oflag=append` / `seek` 还会再改落盘量，静态估算的误差面比它挡住的风险大。
 */
export function judgeDdCommand(args: string[]): DangerousFinding | null {
  // 不看参数顺序：`dd of=… if=…` 与 `dd if=… of=…` 等价
  const zeroSource = args.some((a) => /^if=\/dev\/(zero|random|urandom)$/i.test(a));
  const ofArg = args.find((a) => /^of=/i.test(a));
  const ofTarget = ofArg === undefined ? undefined : ofArg.slice(3).trim();

  if (ofTarget !== undefined) {
    // 去向是设备节点：与来源无关都是 critical。来源是零数据时报「磁盘擦除」，
    // 否则报「写入块设备」（如整盘对拷 `dd if=/dev/sdb of=/dev/sda`）。
    if (isDangerousDeviceTarget(ofTarget)) {
      return { name: zeroSource ? NAMES.diskWipe : NAMES.blockDevice, severity: "critical" };
    }
    // 无损去向（/dev/null、/dev/stdout、of=- …）：写多少都不破坏持久数据
    if (isHarmlessWritableTarget(ofTarget)) return null;
  }

  // 只有「无限来源」才有无 count 的危险：从普通文件读会在 EOF 结束，
  // 从 /dev/zero 读则会一直写下去直到磁盘满。
  if (!zeroSource) return null;
  // 写 stdout / 无损设备：不落盘
  if (ofTarget === undefined || isHarmlessWritableTarget(ofTarget)) return null;
  if (args.some((a) => /^count=/i.test(a))) return null;
  return { name: NAMES.diskWipe, severity: "critical" };
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
    const finding = judgeDdCommand(args);
    if (finding) return finding;
  }

  // 裸 `mkfs` 与 `mkfs.ext4` / `mkfs.ntfs` 都算（旧正则只认后者）
  if (program === "mkfs" || program.startsWith("mkfs.")) {
    return { name: NAMES.mkfs, severity: "critical" };
  }

  // 写入块设备：重定向目标，或 tee / cp / mv / install 的参数
  const { targets } = detectRedirections(text);
  if (targets.some(isDangerousDeviceTarget)) {
    return { name: NAMES.blockDevice, severity: "critical" };
  }
  if (WRITE_PROGRAMS.has(program) && args.some(isDangerousDeviceTarget)) {
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
