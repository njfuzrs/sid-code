/**
 * 只读命令的读路径工作区校验（B5）
 *
 * ## 这一层在回答什么问题
 *
 * 「这条**只读**命令会读到工作区外的文件吗？」——只读命令在 Step 5.5 / 5.6 被自动放行，
 * 此前它们的路径参数没人看：`cat /etc/hosts` 直接放行（工作区外读取静默通过），
 * 而 `cat ../README.md`（工作区内）反倒被 Step 2 的「路径遍历」文本正则拦成危险确认。
 * 两个方向都和 CC 不一致。
 *
 * ## 为什么单独一个模块
 *
 * 路径收集要「按该段的有效 cwd 解析」——`cat a && cd sub && cat b` 里两个路径的基准目录
 * 不同，用整条命令的起始 cwd 去解析后者会把工作区内的路径误判成越界。cd 链已经在
 * `readonly-compound.ts` 里算过（PR-2），本模块只消费它给出的 `stages`，不自己再走一遍
 * ——两套 cd 链路迟早漂移。
 *
 * ## 豁免（J4）
 *
 * 只豁免 **sid 自己明确让模型去读**的路径：后台任务输出、计划文件、会话工具输出的落盘。
 * 不豁免整个 `~/.sid-code`（里面有 `settings.json`、`usage-ledger.jsonl` 和凭证类文件），
 * 也不豁免 `/tmp`（CC 同样不豁免）。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { sidPaths } from "../config/paths.ts";
import { extractBashReadTargets } from "./shell-command-variants.ts";

export interface ReadOnlyReadPathInput {
  /** 命令原文。`stages` 缺省时用它提取（无 cd 的纯只读命令） */
  command: string;
  /** 命令实际运行的起始目录（`input.cwd` 优先于会话 cwd，见 `resolveBashCwdForCheck`） */
  startCwd: string;
  /**
   * cd 复合命令的主体段与有效 cwd（`judgeReadOnlyCompoundBash` 的 `stages`）。
   * 缺省或为空时整条命令按 `startCwd` 解析。
   */
  stages?: Array<{ unit: string; cwds: string[] }>;
  /** symlink 归一。缺省不做 realpath（纯逻辑测试用） */
  resolveRealPath?: (absPath: string) => string;
}

export interface ReadOnlyReadPathTarget {
  /** 命令里的原始 token（进日志与确认框，保留用户写的样子） */
  raw: string;
  /** 解析后的绝对路径（已按所属段的有效 cwd 解析，可选 realpath） */
  abs: string;
}

/** `~` / `~/x` 展开。`~user` 不展开（shell 里少见，展开了反而可能与 shell 行为不符） */
function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * 收集命令会读到的全部文件路径（绝对路径、去重）。
 *
 * `;` 连接造成的多个 cwd 候选会各自解析一次——**任一候选落在工作区外都会进确认**
 * （保守方向：真实的 cwd 取决于运行时，宁多问一次）。
 */
export function collectReadOnlyReadPaths(input: ReadOnlyReadPathInput): ReadOnlyReadPathTarget[] {
  const realpath = input.resolveRealPath ?? ((p: string) => p);
  const add = (map: Map<string, ReadOnlyReadPathTarget>, raw: string, cwd: string) => {
    if (!raw || raw === "-") return;
    const expanded = expandHome(raw);
    const absolute = path.isAbsolute(expanded)
      ? path.normalize(expanded)
      : path.resolve(cwd, expanded);
    const abs = realpath(absolute);
    if (!map.has(abs)) map.set(abs, { raw, abs });
  };

  const out = new Map<string, ReadOnlyReadPathTarget>();
  const startCwd = path.resolve(input.startCwd);
  if (input.stages && input.stages.length > 0) {
    for (const stage of input.stages) {
      for (const raw of extractBashReadTargets(stage.unit)) {
        // 读路径跟着段走：同一 token 在不同 cwd 候选下是不同文件，各算一次
        for (const cwd of stage.cwds) add(out, raw, cwd);
      }
    }
    return [...out.values()];
  }

  for (const raw of extractBashReadTargets(input.command)) add(out, raw, startCwd);
  return [...out.values()];
}

/** realpath 归一，失败（路径不存在 / 权限）退回原样 */
function safeRealpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * 构造 J4 豁免判定：给定绝对路径，判断它是不是 sid 自己让模型去读的文件。
 *
 * 一次性把根目录算好（每次 bash 权限检查只调一次），避免在路径循环里反复 stat。
 */
export function createSidSelfReadPathFilter(): (absPath: string) => boolean {
  // 收 `sidPaths` 的三个根：任务输出（`<output-file>`）、计划文件、会话工具输出落盘
  // （`[完整输出已保存到 …，使用 read 工具查看完整内容]`）。全部是提示词明确指给模型的路径。
  const roots = [sidPaths.tasks(), sidPaths.plans(), path.join(sidPaths.trajectories(), "sessions")]
    .map((r) => safeRealpath(path.resolve(r)))
    .map((r) => (r.endsWith(path.sep) ? r.slice(0, -1) : r));

  return (absPath: string): boolean => {
    const p = absPath.endsWith(path.sep) ? absPath.slice(0, -1) : absPath;
    return roots.some((root) => p === root || p.startsWith(root + path.sep));
  };
}
