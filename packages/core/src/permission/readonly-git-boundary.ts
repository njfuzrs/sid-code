/**
 * 只读 git 的「执行边界」判定（B1/B2/B4 的权限层那一半）
 *
 * `isReadOnlyCommand` 是纯文本层的严格口径：不认白名单外的前导变量赋值、不认
 * `-C` / `--git-dir` / `--work-tree` / `--bare`。这样「换仓库」的写法一律落到确认，
 * 方向是对的，但会误伤 `git -C <本仓子目录> log -1` 这类完全安全的常用写法。
 *
 * 本模块补回**只对本仓生效**的那部分：
 * - `git -C <本仓内目录> …` 等价于「只对这一条 git 命令生效的 `cd <dir>`」，可放行；
 * - `--git-dir` / `--work-tree` / `--bare` 一律不放行（B2 明确不补回）；
 * - 所有 git 段的实际目录都必须属于**本仓**（B4），本仓的 linked worktree 算本仓；
 * - 命令起始目录也必须在工作区内（跨命令 `cd` 到异仓后跑裸 git 的形态）；
 * - **前导变量赋值照 B1 的白名单口径复核**，剥 `-C` 不会把 `GIT_DIR=…` 一起洗白。
 */

import * as path from "node:path";
import {
  parseBashCommand,
  extractShellStatements,
  type SimpleCommand,
} from "../tool/bash/parser.ts";
import { isForbiddenAssignmentName, isReadOnlyCommand } from "../tool/bash/read-only-validation.ts";
import { resolveGitRepoTrust } from "./git-repo-trust.ts";

export interface ReadOnlyGitBoundaryInput {
  /** 待判定的完整命令 */
  command: string;
  /** 命令实际运行的起始目录（`input.cwd` / 会话 cwd），绝对路径 */
  startCwd: string;
  /** 本仓公共 git 目录，见 resolveOwnCommonDir；`null` 表示工作区不是 git 仓库 */
  ownCommonDir: string | null;
}

export interface ReadOnlyGitBoundaryResult {
  /** 命令里是否有 git 段。`false` 时调用方沿用工具自身的判定，不走本模块结论 */
  applicable: boolean;
  allowed: boolean;
  /** 不放行时的短原因，进日志与决策理由 */
  reason?: string;
}

/**
 * `-C` / `cd` 目标必须是字面量：含变量、通配、命令替换、重定向/分隔符、转义、`~` 的一律拒绝。
 * `~` 也算非字面量——它要按家目录展开，`path.resolve` 会解析成 `<cwd>/~/x`，与 git 语义不符。
 *
 * 导出给 `readonly-compound.ts`（B3 的 `cd` 目标判定）复用：两处判的是同一件事
 * （「这个路径 token 能不能直接交给 path.resolve」），各写一份正则迟早漂移。
 */
export const NON_LITERAL_PATH = /[$`~*?[\]{}()<>|;&\n\\]/;

/** 把 `-C` / `cd` 的字面量目标解析成绝对路径；不是字面量返回 null。 */
function resolveLiteralPath(raw: string, base: string): string | null {
  if (!raw || raw === "-" || NON_LITERAL_PATH.test(raw)) return null;
  return path.resolve(base, raw);
}

/**
 * 段的最简文本形态，用于**复用 `isReadOnlyCommand` 的逐段判定**。
 *
 * 前导赋值必须一起拼回去：剥 `-C` 只该剥掉「换仓库」那一段语义，
 * `GIT_DIR=… git -C <本仓> status` 里的 `GIT_DIR` 仍要被 B1 的白名单拦下。
 * 参数里带空格时拼出来的文本会被解析成多个 token，方向是判非只读 → 不放行，安全。
 */
function segmentText(st: SimpleCommand): string {
  const prefix = st.envPrefix
    ? Object.entries(st.envPrefix)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ")
    : "";
  const body = [st.command, ...st.args].join(" ");
  return prefix ? `${prefix} ${body}` : body;
}

interface StrippedC {
  /** 剥掉 `-C` 之后的 git 参数（保留其余全局选项与子命令） */
  args: string[];
  /** 剥完 `-C` 之后该段实际运行的目录 */
  cwd: string;
}

/**
 * 剥掉 git 段**子命令之前**的 `-C <字面量目录>`。
 *
 * 只剥 `-C`：`--git-dir` / `--work-tree` / `--bare` 出现即返回 `null`（B2 不补回）。
 * `-C` 目标不合格（非字面量、解析后不属于本仓）同样返回 `null` —— 调用方据此落确认，
 * 不放行。其余全局选项原样保留，交给 `isReadOnlyCommand` 判。
 *
 * 判据用「仓库归属」而不是「物理位置」：本仓的 linked worktree 常常建在工作区外
 * （`/tmp/wt`），但它的公共 git 目录与主仓相同、配置与 hooks 都来自主仓，不是「别人的仓库」。
 */
function stripLeadingC(args: string[], baseCwd: string, ownCommonDir: string): StrippedC | null {
  let cwd = baseCwd;
  const kept: string[] = [];
  let i = 0;
  for (; i < args.length; i++) {
    const tok = args[i]!;
    if (!tok.startsWith("-")) break; // 到达子命令
    if (tok === "--git-dir" || tok.startsWith("--git-dir=")) return null;
    if (tok === "--work-tree" || tok.startsWith("--work-tree=")) return null;
    if (tok === "--bare") return null;
    if (tok === "-C") {
      const target = args[i + 1];
      const resolved = target ? resolveLiteralPath(target, cwd) : null;
      if (!resolved) return null;
      cwd = resolved;
      i++; // 跳过值
      continue;
    }
    if (tok.startsWith("-C") && tok.length > 2) {
      // `-C<dir>` 连写形式
      const resolved = resolveLiteralPath(tok.slice(2), cwd);
      if (!resolved) return null;
      cwd = resolved;
      continue;
    }
    kept.push(tok);
  }
  kept.push(...args.slice(i));
  if (resolveGitRepoTrust(cwd, ownCommonDir) !== "own") return null;
  return { args: kept, cwd };
}

/**
 * 判定一条命令能否按「只读 git 且作用在本仓」放行。
 *
 * 两步缺一不可：
 * 1. **整条命令仍必须只读** —— 剥掉本仓 `-C` 后逐段复用 `isReadOnlyCommand`，
 *    不另写一套只读规则（两套规则必然漂移）。
 * 2. **每个 git 段的有效目录都属于本仓** —— 裸仓库形态、嵌套异仓、工作区外的仓库都不放行。
 *
 * 起始目录同样要在工作区内：`cd <异仓>`（单独一条，工作区内、会被持久化）之后
 * 再跑裸 `git status` 时，git 段自身的 cwd 就是异仓，第 2 步会拦；但 `cd <ws>; git status`
 * 这种「段内 cd 回本仓」的形态，只看段 cwd 会漏掉「命令是在异仓里起跑的」这件事，
 * 所以两端都判。
 */
export function judgeReadOnlyGitInOwnRepo(
  input: ReadOnlyGitBoundaryInput,
): ReadOnlyGitBoundaryResult {
  const { command, ownCommonDir } = input;
  const startCwd = path.resolve(input.startCwd);

  const statements = extractShellStatements(parseBashCommand(command));
  if (!statements.some((s) => s.command === "git")) {
    return { applicable: false, allowed: false };
  }
  if (!ownCommonDir) {
    return {
      applicable: true,
      allowed: false,
      reason: "工作区不是 git 仓库，无法判定仓库归属",
    };
  }
  // 起始目录按「仓库归属」判，不按「物理在工作区内」判：本仓的 linked worktree
  // 常常建在工作区外，它仍然是本仓（公共 git 目录相同）。异仓 / 裸仓库形态一律不放行。
  if (resolveGitRepoTrust(startCwd, ownCommonDir) !== "own") {
    return { applicable: true, allowed: false, reason: "命令起始目录不属于本仓" };
  }

  let cwd = startCwd;
  for (const st of statements) {
    if (!st.command) {
      // 独立变量赋值语句（`GIT_DIR=…` 单独一段）。普通变量（`B=origin/x`）直接跳过——
      // 它只设 shell 变量、不进子进程环境；GIT_* / 注入类变量要拦（见 isForbiddenAssignmentName）。
      for (const name of Object.keys(st.envPrefix ?? {})) {
        if (isForbiddenAssignmentName(name)) {
          return { applicable: true, allowed: false, reason: "独立赋值含注入类变量" };
        }
      }
      continue;
    }
    if (st.command === "cd") {
      const target = st.args.length === 1 ? st.args[0]! : null;
      const resolved = target ? resolveLiteralPath(target, cwd) : null;
      if (!resolved) {
        return { applicable: true, allowed: false, reason: "无法确定 cd 的目标目录" };
      }
      cwd = resolved;
      continue;
    }
    if (st.command === "git") {
      const stripped = stripLeadingC(st.args, cwd, ownCommonDir);
      if (!stripped) {
        return { applicable: true, allowed: false, reason: "git 换仓库选项不指向本仓" };
      }
      const text = segmentText({ command: "git", args: stripped.args, envPrefix: st.envPrefix });
      if (!isReadOnlyCommand(text)) {
        return { applicable: true, allowed: false, reason: "git 段不是只读" };
      }
      continue;
    }
    if (!isReadOnlyCommand(segmentText(st))) {
      return { applicable: true, allowed: false, reason: "命令含非只读段" };
    }
  }

  return { applicable: true, allowed: true };
}
