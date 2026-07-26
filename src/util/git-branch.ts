/**
 * 实时读取当前 git 分支（P2-G7 per-message 上下文落盘用）。
 *
 * 为什么不复用启动快照：gitStatus 在会话启动时抓一次就冻结（见 gitstatus-frozen-snapshot
 * 教训），用户会话中途 checkout 到别的分支后，"这条消息发在哪个分支"就归错因。故此处**每次
 * 现读**，但加一个极短 TTL 缓存（默认 2s）避免同一轮连续多次 git 调用的开销——分支不会在
 * 2s 内反复横跳，缓存窗口内的误差可忽略，而单轮里 user_message 落盘只调用一次，命中缓存的
 * 是相邻辅助路径。
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const TTL_MS = 2000;
let cache: { cwd: string; branch: string | undefined; at: number } | null = null;

/**
 * 返回 cwd 所在仓库的当前分支名；非 git 仓库 / git 不可用 / detached HEAD 时返回 undefined。
 * 失败与"不在 git 仓库"一律吞掉返回 undefined——落盘诊断字段缺失不影响任何主流程。
 *
 * @param cwd 探测目录
 * @param now 当前毫秒时间戳（由调用方注入，便于测试与避免此模块内直接读时钟）
 */
export async function getCurrentGitBranch(cwd: string, now: number): Promise<string | undefined> {
  if (cache && cache.cwd === cwd && now - cache.at < TTL_MS) {
    return cache.branch;
  }
  let branch: string | undefined;
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      encoding: "utf-8",
    });
    const name = stdout.trim();
    // detached HEAD 会返回字面 "HEAD"，此时无有意义分支名 → undefined。
    branch = name && name !== "HEAD" ? name : undefined;
  } catch {
    branch = undefined;
  }
  cache = { cwd, branch, at: now };
  return branch;
}
