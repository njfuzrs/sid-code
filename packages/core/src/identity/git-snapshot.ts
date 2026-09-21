/**
 * 采集侧 git 快照（M1 PR-1.2 顺手字段）。
 *
 * git_head / git_dirty 离线补不回来：评测用 base_commit 现在靠时间反查，多分支上会错。
 * 进程内缓存——每条事件 / 每轮 traj 重建都 fork git 没有收益。
 *
 * 失败返回空：不在 git 仓库、没装 git、权限不够，都不当成错误（身份通道 fail-open）。
 */

import { execFileSync } from "node:child_process";

export interface GitSnapshot {
  head: string | null;
  dirty: boolean | null;
}

let cached: GitSnapshot | null = null;

export function getGitSnapshot(): GitSnapshot {
  if (cached) return cached;
  cached = collect();
  return cached;
}

function collect(): GitSnapshot {
  try {
    const gitOpts = {
      encoding: "utf-8" as const,
      stdio: ["ignore", "pipe", "ignore"] as ["ignore", "pipe", "ignore"],
      timeout: 3000,
    };
    const head = execFileSync("git", ["rev-parse", "HEAD"], gitOpts).trim();
    if (!head) return { head: null, dirty: null };
    const porcelain = execFileSync("git", ["status", "--porcelain"], gitOpts);
    return { head, dirty: porcelain.trim() !== "" };
  } catch {
    return { head: null, dirty: null };
  }
}

/** 仅测试 */
export function __resetGitSnapshotForTest(): void {
  cached = null;
}
