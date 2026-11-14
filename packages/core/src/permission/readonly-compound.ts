/**
 * 工作区内 `cd` + 只读主体的复合命令判定（B3）
 *
 * ## 为什么单独一个模块
 *
 * `tool/bash/read-only-validation.ts` 的 `isReadOnlyCommand` 是**不带上下文的纯函数**：
 * 它不知道会话 cwd，也不知道工作区边界，所以 `cd` 一律判非只读——这是对的
 * （`isReadOnlyIgnoringCd` 的注释写明「不许拿去做权限放行」），但代价是本会话
 * 51 条 bash 普通确认里有 22 条是「`cd <会话 cwd> && git log`」这类完全安全的命令，
 * 合计等了 327.8s。
 *
 * 本模块是**权限层**的补回：拿到 cwd 与工作区判定之后，回答「这条 `cd` 复合命令
 * 除了切目录之外是不是只读」。判不准一律返回 `readOnly: false`（落确认），
 * 方向是「多问一次」而不是「多放一条」。
 *
 * ## 与 PR-1 的 `judgeReadOnlyGitInOwnRepo` 的分工
 *
 * 那个模块补的是「`git -C <本仓>` / 本仓归属」；本模块补的是「`cd` 前进 + 只读主体」。
 * git 段的仓库归属判定**复用**它，不在这里重写一份——两套口径迟早漂移。
 *
 * ## 只接受 `&&` 与 `;`（含换行）
 *
 * - `||`：失败分支让「哪条命令真的会跑」不可静态确定，且 `cd 不存在 || ls /` 这种
 *   形态的只读性完全取决于运行时；
 * - 后台 `&`：并发执行 + cwd 与链式语义脱钩；
 * - 子 shell `( … )` / 命令替换：里面的 `cd` 顶层拆分看不到。
 *
 * 这三种一律不放行。`;` 与 `&&` 的差别必须保留：`cd X; git log` 在 cd 失败时会在
 * **原目录**继续跑，而 `&&` 会停下。所以 `;` 连接的 cd 之后，两个 cwd 都要判。
 */

import * as path from "node:path";
import { isReadOnlyCommand } from "../tool/bash/read-only-validation.ts";
import {
  extractShellStatements,
  parseBashCommand,
  splitShellWords,
  type BashASTNode,
} from "../tool/bash/parser.ts";
import { parseLiteralCdTarget } from "./allow-composition.ts";
import { resolveGitRepoTrust } from "./git-repo-trust.ts";
import { judgeReadOnlyGitInOwnRepo, NON_LITERAL_PATH } from "./readonly-git-boundary.ts";
import { splitCommandStructure } from "./shell-structure.ts";

export interface ReadOnlyCompoundInput {
  /** 待判定的完整命令 */
  command: string;
  /** 命令实际运行的起始目录（`input.cwd` / 会话 cwd），绝对路径 */
  startCwd: string;
  /** 本仓公共 git 目录；`null` 表示工作区不是 git 仓库 */
  ownCommonDir: string | null;
  /** 工作目录集合判定，见 `PathValidator.isWithinWorkingDirectories`（含 realpath 与 /add-dir 白名单） */
  isWithinWorkingDirectories: (absPath: string) => boolean;
  /** symlink 归一化，见 `PathValidator.resolveRealPath`。缺省不做 realpath（测试用） */
  resolveRealPath?: (absPath: string) => string;
}

export interface ReadOnlyCompoundResult {
  /** 命令里是否有 `cd` 段。`false` 时调用方沿用工具自身的判定，不取本模块结论 */
  applicable: boolean;
  readOnly: boolean;
  /** 不放行时的短原因，进日志与决策理由 */
  reason?: string;
}

/**
 * cd 候选目录上限。
 *
 * `;` 连接的 cd 会让「上一段是否成功」的每条分支都留下一个候选，链越长候选越多
 * （理论上 2^n）。超过这个数就判非只读——真实的 `cd` 链极少超过 3 段，
 * 而每多一个候选就要多一次 git 仓库归属 stat，没必要为病态输入付出这个代价。
 */
const MAX_CWD_CANDIDATES = 16;

/** 读类重定向操作符。`<<<` 是 here-string（读字符串），不算文件路径。 */
const INPUT_REDIRECT_MODES = new Set(["<", "n<"]);

/**
 * 判定「工作区内 `cd` + 只读主体」的复合命令能否免确认执行。
 *
 * 传入的命令若整体已经是只读（`isReadOnlyCommand` 为真），返回 `applicable: false`
 * ——那属于工具自身判定 / PR-1 的 git 边界路径，本模块不接管，避免两处结论打架。
 */
export function judgeReadOnlyCompoundBash(input: ReadOnlyCompoundInput): ReadOnlyCompoundResult {
  const { command, ownCommonDir, isWithinWorkingDirectories } = input;

  // 1. 整体已只读 → 不接管
  if (isReadOnlyCommand(command)) return { applicable: false, readOnly: false };

  const pipelines = splitCommandStructure(command);
  if (pipelines.length === 0) return { applicable: false, readOnly: false };

  // 2. 必须有 cd 段才谈得上「cd 复合」。没有 cd 的命令走工具自身的判定。
  //
  // 用 AST 而不是「首 token 是不是 cd」：`(cd X && ls)` 是单个 stage，首 token 是 `(cd`，
  // 按 token 判会得出「没有 cd」→ applicable false → 子 shell 里的 cd 漏出本模块视野。
  // 子 shell 里的 cd 在 AST 里是 `(cd`（`(` 粘在 command 上），两种形态都算。
  const hasCd = extractShellStatements(parseBashCommand(command)).some(
    (s) => s.command === "cd" || /^\(+cd$/.test(s.command),
  );
  if (!hasCd) return { applicable: false, readOnly: false };

  const realpath = input.resolveRealPath ?? ((p: string) => p);
  const startCwd = path.resolve(input.startCwd);

  /**
   * 当前可能成立的 cwd（`&&` 链的**成功路径**）。
   * 初始是会话 cwd；每次 cd 用「对每个候选分别解析」替换。
   */
  let possible = new Set<string>([startCwd]);
  /** 失败路径可能停留的 cwd。`;` 之后重新并入 `possible`（cd 失败仍在原目录继续跑） */
  let history = new Set<string>();
  /** 是否已经出现过 cd —— cd 之前的相对路径输入重定向不随 cd 改变含义 */
  let sawCd = false;

  for (const pipeline of pipelines) {
    const boundary = pipeline.boundary;

    // 3. 只接受 && 与 ;（含换行）。理由见文件头。
    if (boundary === "||" || boundary === "&") {
      return { applicable: true, readOnly: false, reason: `分隔符 ${boundary} 不支持只读判定` };
    }
    if (boundary === ";" || boundary === "\n") {
      possible = new Set([...possible, ...history]);
      history = new Set();
    }
    // 进入本管道时可能成立的目录 —— 本管道里的 cd 若失败就停在这里
    for (const c of possible) history.add(c);

    const unit = pipeline.stages.join(" | ");

    // 4. 子 shell / 命令替换：里面的 cd 顶层拆分看不到，静态推断不可靠
    if (pipeline.stages.length === 1 && /^\s*[(`]/.test(unit)) {
      return { applicable: true, readOnly: false, reason: "子 shell / 命令替换形态" };
    }

    const cd = pipeline.stages.length === 1 ? parseCdStage(pipeline.stages[0]!) : null;
    if (cd) {
      sawCd = true;
      if (cd.target === null) {
        return { applicable: true, readOnly: false, reason: "cd 目标不是字面量路径" };
      }
      const next = new Set<string>();
      for (const base of possible) {
        const resolved = realpath(path.resolve(base, cd.target));
        if (!isWithinWorkingDirectories(resolved)) {
          return { applicable: true, readOnly: false, reason: "cd 目标在工作区外" };
        }
        // B4 的两步绕过：`cd <异仓>`（单独一条，看起来无害）之后，下一条裸 `git status`
        // 就在异仓里跑了。工作区内的普通目录（不属于任何仓库）照常放行；
        // 异仓 / 裸仓库形态一律不放行 —— 与 git 段同一口径，用同一个 resolveGitRepoTrust。
        const trust = resolveGitRepoTrust(resolved, ownCommonDir);
        if (trust === "foreign" || trust === "bare") {
          return { applicable: true, readOnly: false, reason: "cd 目标属于别的仓库" };
        }
        next.add(resolved);
      }
      // `&&`：cd 失败整条链就停了，只剩成功路径；`;`：失败仍留在原目录，并上候选
      possible = boundary === "&&" ? next : new Set([...next, ...history]);
      if (possible.size > MAX_CWD_CANDIDATES) {
        return { applicable: true, readOnly: false, reason: "cd 链过长，无法静态确定目录" };
      }
      continue;
    }

    // 5. cd 之后的相对路径输入重定向：路径含义随 cd 改变，静态判不准
    if (sawCd && hasRelativeInputRedirect(parseBashCommand(unit))) {
      return { applicable: true, readOnly: false, reason: "cd 后的相对路径输入重定向" };
    }

    // 6. 主体单元：含 git 段时复用 PR-1 的仓库归属判定（它对非 git 段也用
    //    isReadOnlyCommand 逐段判），否则用纯函数口径。
    if (hasGitStatement(unit)) {
      if (!ownCommonDir) {
        return { applicable: true, readOnly: false, reason: "工作区不是 git 仓库" };
      }
      for (const base of new Set([...possible, ...history])) {
        const r = judgeReadOnlyGitInOwnRepo({ command: unit, startCwd: base, ownCommonDir });
        if (!r.applicable || !r.allowed) {
          return { applicable: true, readOnly: false, reason: r.reason ?? "git 段不在本仓" };
        }
      }
      continue;
    }

    if (!isReadOnlyCommand(unit)) {
      return { applicable: true, readOnly: false, reason: "主体不是只读命令" };
    }
  }

  return { applicable: true, readOnly: true };
}

/** `cd` 单段的解析结果。`isCd` 为真但 `target` 为 null 表示「是 cd，但目标不可静态解析」。 */
interface CdStage {
  isCd: true;
  target: string | null;
}

/**
 * 解析单独成段的 `cd <字面量目录>`。
 *
 * 非 cd 返回 null。目标是字面量的条件比 `parseLiteralCdTarget` 更严一档：
 * 后者不排 `~`（`cd ~` 在那边能过），而 `path.resolve(cwd, "~")` 会算成
 * `<cwd>/~`，与 shell 语义不符 —— `NON_LITERAL_PATH` 与 PR-1 的 `-C` 判定共用同一份正则。
 */
function parseCdStage(stage: string): CdStage | null {
  if (splitShellWords(stage)[0] !== "cd") return null;
  const raw = parseLiteralCdTarget(stage);
  if (!raw || NON_LITERAL_PATH.test(raw)) return { isCd: true, target: null };
  return { isCd: true, target: raw };
}

/** 单元里是否有 git 段（用与判定同一套 AST 提取，不自己扫字符串）。 */
function hasGitStatement(unit: string): boolean {
  return extractShellStatements(parseBashCommand(unit)).some((s) => s.command === "git");
}

/**
 * 是否有「相对路径的读类重定向」。
 *
 * `cd` 改变了相对路径的基准目录：`cd sub && cat < in.txt` 读的是 `sub/in.txt`，
 * 而权限层的路径校验是按命令起始 cwd 算的 —— 两边不一致，静态判不准就落确认。
 * 绝对路径不受 cd 影响，照常放行。
 */
function hasRelativeInputRedirect(node: BashASTNode): boolean {
  switch (node.type) {
    case "redirect":
      if (INPUT_REDIRECT_MODES.has(node.mode) && !path.isAbsolute(node.file)) return true;
      return hasRelativeInputRedirect(node.target);
    case "pipeline":
    case "sequence":
      return node.commands.some((c) => hasRelativeInputRedirect(c));
    default:
      return false;
  }
}
