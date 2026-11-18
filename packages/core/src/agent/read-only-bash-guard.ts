/**
 * 只读子代理的 bash 机械门禁（PR12 / D5）
 *
 * ## 为什么需要它
 *
 * explore 类子代理要能跑 `git log -S` / `git blame` / `wc -l` 才谈得上「探索」——
 * 只有 read/grep 时它只能整文件读，长文档与历史线索全靠猜。但一旦把 bash 给它，
 * 「只读」就**不能只写在系统提示里**：提示词是模型可以违背的建议，不是约束。
 * 把 `rm -rf` / `git checkout .` 交给一句「你处于只读模式」，等于没有防线。
 *
 * 所以门禁放在**工具层**：bash 的 execute 之前先做一次机械判定，判不成只读就拒绝，
 * 并把拒绝原因与可行下一步交回模型。这样无论模型怎么被提示词带跑，写命令都执行不到。
 *
 * ## 判定口径不另写名单
 *
 * 复用现成的两个函数：
 * - `isReadOnlyCommand`（tool/bash/read-only-validation.ts）——不带上下文的纯函数；
 * - `judgeReadOnlyCompoundBash`（permission/readonly-compound.ts）——带 cwd/仓库上下文，
 *   补的是 `cd <工作区> && git log` 这一类。
 *
 * 与 plan 模式的「只读 bash 放行」用**同一组函数**，不写第二份命令名单：
 * 两份名单必然漂移，漂移的方向又总是「门禁比权限层更松」。
 *
 * ## 判不准一律按非只读处理
 *
 * 方向与权限层一致：多拒一次，模型会换写法；多放一条，写操作就落到了只读代理手里。
 * 缺 `PathValidator`（测试装配 / 退化路径）时只信 `isReadOnlyCommand`，`cd` 复合一律拒。
 */

import * as path from "node:path";
import { isReadOnlyCommand } from "../tool/bash/read-only-validation.ts";
import { judgeReadOnlyCompoundBash } from "../permission/readonly-compound.ts";
import { resolveOwnCommonDir } from "../permission/git-repo-trust.ts";
import { getCwd } from "../bootstrap/state.ts";

/**
 * bash 工具在门禁眼里需要的最小形态。
 *
 * 刻意用结构化类型、**不 import `LegacyTool`**：`lint:legacy-tool` 是只减不增的棘轮
 * （`tests/scripts/legacy-tool-gate.test.ts` 有一条「基线与当前实测一致」的断言），
 * 新增文件去引用旧接口会把这个数字永久抬高，而本模块只是包一层 execute、
 * 用不到旧接口的其它字段。
 */
type BashExecute = (
  input: unknown,
  signal?: AbortSignal,
  onProgress?: (event: unknown) => void,
) => Promise<{ output: string; isError?: boolean }>;

interface BashLikeTool {
  execute: BashExecute;
}

/** 判定所需的路径/仓库上下文（与 `judgeReadOnlyCompoundBash` 的入参同口径） */
export interface ReadOnlyBashJudgeContext {
  /** 命令实际运行的起始目录（绝对路径） */
  startCwd: string;
  /** 本仓公共 git 目录；`null` 表示工作区不是 git 仓库 */
  ownCommonDir: string | null;
  /** 工作目录集合判定，见 `PathValidator.isWithinWorkingDirectories` */
  isWithinWorkingDirectories: (absPath: string) => boolean;
  /** symlink 归一化，见 `PathValidator.resolveRealPath`。缺省不做 realpath（测试用） */
  resolveRealPath?: (absPath: string) => string;
}

export type ReadOnlyBashVerdict = { allowed: true } | { allowed: false; reason: string };

/**
 * 判定一条 bash 命令能否在只读子代理里执行。
 *
 * 两段口径：整体只读（`isReadOnlyCommand`）直接放行；否则再问「是不是工作区内的
 * `cd` + 只读主体」（`judgeReadOnlyCompoundBash`，`applicable` 为假表示它不接管）。
 * 两段都不过 → 拒绝，原因取复合判定的 reason（有的话）或一句固定说明。
 */
export function judgeReadOnlyBash(
  command: string,
  ctx: ReadOnlyBashJudgeContext,
): ReadOnlyBashVerdict {
  if (isReadOnlyCommand(command)) return { allowed: true };

  const compound = judgeReadOnlyCompoundBash({
    command,
    startCwd: ctx.startCwd,
    ownCommonDir: ctx.ownCommonDir,
    isWithinWorkingDirectories: ctx.isWithinWorkingDirectories,
    resolveRealPath: ctx.resolveRealPath,
  });
  if (compound.readOnly) return { allowed: true };

  return {
    allowed: false,
    reason: compound.reason ?? "不是已知的只读命令（写操作、或静态判断不出只读性）",
  };
}

/** 拒绝文案：说清「谁拒的、为什么、下一步怎么办」，让模型能自己改道 */
export function formatReadOnlyBashRejection(command: string, reason: string): string {
  return [
    "只读代理的 bash 门禁拒绝了这条命令：本代理类型声明为只读（readOnly），工具层按机械判定拦截，不是提示词建议。",
    `命令：${command}`,
    `判定：${reason}`,
    "",
    "可行的下一步：",
    "- 改用 read / grep / glob / ls / read_many 工具；",
    "- 只读命令直接可用：git status / git log / git show <rev>:<path> / git blame -L <a>,<b> <file> / git diff / wc -l / find / sed -n / rg；",
    "- 需要写文件、切分支、提交等变更时，把这件事连同「为什么需要写」交回派你来的代理，由它执行。",
  ].join("\n");
}

/** 包装器依赖：工作区边界与路径判定能力 */
export interface ReadOnlyBashGuardOptions {
  /** 工作区根（只读子代理的隔离边界，通常是 agent root，不是进程 cwd） */
  workspaceDir: string;
  /** 路径校验能力；缺省时退化为「只信 isReadOnlyCommand」的保守口径 */
  pathValidator?: {
    isWithinWorkingDirectories(absPath: string): boolean;
    resolveRealPath(absPath: string): string;
  } | null;
  /** 起始 cwd 解析；缺省 `input.cwd`（绝对路径）→ `getCwd()` */
  resolveStartCwd?: (input: unknown) => string;
}

function defaultStartCwd(input: unknown): string {
  const raw = (input as { cwd?: unknown } | null)?.cwd;
  if (typeof raw === "string" && raw.trim() !== "") return path.resolve(raw);
  return getCwd();
}

/**
 * 给 bash 工具套一层只读门禁视图。
 *
 * 用 `Object.create(tool)` 原型链继承而不是重写整个工具：`checkPermissions` /
 * `maxResultSizeChars` / `interruptBehavior` 等能力字段与内层视图（如子代理绑了独立
 * tracker 的 `withFileReadTracker` 视图）全部原样生效，只遮蔽 `execute` 一个方法。
 * 与 `BashTool.withFileReadTracker` 同一写法、同一理由。
 *
 * 判定本身抛错时**按拒绝处理**：门禁失效不能变成放行。
 */
export function wrapBashWithReadOnlyGuard<T extends BashLikeTool>(
  tool: T,
  options: ReadOnlyBashGuardOptions,
): T {
  const ownCommonDir = resolveOwnCommonDir(options.workspaceDir);
  const validator = options.pathValidator ?? null;
  const resolveStartCwd = options.resolveStartCwd ?? defaultStartCwd;

  const innerExecute: BashExecute = tool.execute;
  const view = Object.create(tool) as T;
  view.execute = (async (input, signal, onProgress) => {
    const command = (input as { command?: unknown } | null)?.command;
    // 命令缺失/非字符串交给内层：参数校验是 bash 自己的职责，门禁不抢答。
    if (typeof command !== "string" || command.trim() === "") {
      return innerExecute.call(view, input, signal, onProgress);
    }

    let verdict: ReadOnlyBashVerdict;
    try {
      verdict = judgeReadOnlyBash(command, {
        startCwd: resolveStartCwd(input),
        ownCommonDir,
        isWithinWorkingDirectories: validator
          ? (absPath) => validator.isWithinWorkingDirectories(absPath)
          : () => false,
        resolveRealPath: validator ? (absPath) => validator.resolveRealPath(absPath) : undefined,
      });
    } catch (err) {
      // 门禁自己坏掉时按拒绝处理：静默放行等于给只读代理开一条任意写通道。
      verdict = { allowed: false, reason: `只读判定异常（${(err as Error).message}）` };
    }
    if (!verdict.allowed) {
      return { output: formatReadOnlyBashRejection(command, verdict.reason), isError: true };
    }
    return innerExecute.call(view, input, signal, onProgress);
  }) as T["execute"];
  return view;
}
