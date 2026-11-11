/**
 * Worktree 路径语义文案（CG-2 / 台账 H3、后续规划 §2.7）
 *
 * 缺陷形态：进入 worktree 之后，上下文里还留着大量「主仓的绝对路径」——它们是进入前读过的
 * 文件、以及历史里成型的路径习惯。模型在 worktree 里写文件时复用这些路径，落盘就落到主仓，
 * 而它以为自己改的是工作树。台账基线：worktree 内 edit/write 写到主仓路径 53 次 / 4 会话，
 * 「主仓读过、worktree 路径没读过」类拒绝 21 次 / 13 会话。
 *
 * 上游没有解决这个问题的先例（两份附件都确认过），所以这里按 02 号文档的方案做，并且
 * **只提示、不拦截**：用户确实可能想在 worktree 里顺手改主仓的一份共享配置，硬拦会误伤。
 * 验收判据是「每个会话 ≤ 1 次」，即允许写错一次，提示之后必须改正。
 *
 * 三个出口：
 *   1. 进入 worktree：说明「主仓根不是你的工作树」；
 *   2. 退出 worktree：说明「worktree 路径不再是当前工作树」；
 *   3. 在 worktree 里写到主仓路径：给出**可直接执行的替换路径**（§2.7 规定的文案形态）。
 */

import { join, relative, resolve, sep } from "path";
import { getCurrentWorktreeSession } from "./manager.ts";

/**
 * target 是否落在 base 之下（含 base 本身）。
 *
 * 必须按路径分段判断而不是裸 `startsWith`：`/repo-other` 以 `/repo` 开头，
 * 裸比较会把隔壁仓库当成主仓内的文件，给出一个错的替换路径。
 */
function isUnder(target: string, base: string): boolean {
  if (target === base) return true;
  return target.startsWith(base.endsWith(sep) ? base : base + sep);
}

/** 本仓所有 worktree 的存放目录（主仓根下）。 */
function worktreesRoot(mainRoot: string): string {
  return join(mainRoot, ".sid-code", "worktrees");
}

/**
 * 进入 worktree 时的路径语义说明（拼在成功结果的末尾）。
 *
 * 不写「请勿写入主仓」这类禁令：模型此刻手上就有主仓绝对路径，禁令不给替代方案，
 * 下一轮它还是会用旧路径。给出的必须是「此后在这个仓库写文件用哪个前缀」。
 */
export function enterWorktreePathsNotice(worktreePath: string, mainRoot: string): string {
  return (
    `\n主仓根: ${mainRoot}（不是当前工作树）` +
    `\n⚠️ 此前在该仓库读过的文件路径指向主仓，写入会落到主仓而不是这个 worktree；` +
    `此后写文件请用 ${worktreePath} 下的路径。`
  );
}

/**
 * 退出 worktree 时的路径语义说明。
 *
 * `removed` 区分 keep / remove：keep 的目录还在磁盘上（可能还要回去），
 * remove 的目录已被删除——把「仍在磁盘上」写给 remove 场景会误导模型去用这个路径。
 */
export function exitWorktreePathsNotice(
  worktreePath: string,
  mainRoot: string,
  removed: boolean,
): string {
  const tail = removed
    ? `${worktreePath} 已删除，不再是当前工作树。`
    : `${worktreePath} 不再是当前工作树（目录仍保留在磁盘上）。`;
  return `\n当前工作目录: ${mainRoot}\n${tail}此后写文件请用 ${mainRoot} 下的路径。`;
}

/**
 * 若本次写入落在主仓（而不是当前 worktree）里，返回带**可执行替换路径**的提示；否则返回空串。
 *
 * 只在「当前确实处于 worktree 会话」时生效——不在 worktree 里时，主仓路径就是正确答案，
 * 提示只会变成噪音。
 *
 * 三种情况刻意不给提示：
 * - 写到当前 worktree 内：正常路径，说明模型没搞错；
 * - 写到主仓根之外（如 `/tmp`）：与 worktree 身份无关，替换路径无从计算；
 * - 写到 `.sid-code/worktrees/` 下的**其它** worktree：那不属于「以为在 worktree 却写到主仓」，
 *   按当前 worktree 做替换会拼出一个不存在的路径（比不提示更糟）。
 */
export function mainRepoWriteHint(filePath: string): string {
  const session = getCurrentWorktreeSession();
  if (!session) return "";

  const target = resolve(filePath);
  const worktreePath = resolve(session.worktreePath);
  const mainRoot = resolve(session.originalCwd);

  if (isUnder(target, worktreePath)) return "";
  if (!isUnder(target, mainRoot)) return "";
  if (isUnder(target, worktreesRoot(mainRoot))) return "";

  const rel = relative(mainRoot, target);
  // rel 为空 = 目标就是主仓根本身（写一个目录会失败），没有可替换的路径。
  if (!rel) return "";
  const suggested = join(worktreePath, rel);
  return (
    `\n\n⚠️ 你写入的 ${target} 在主仓，不在当前 worktree。` +
    `当前 worktree 里对应的路径是 ${suggested}。` +
    `如果确实要改主仓那份文件，可以忽略本条。`
  );
}
