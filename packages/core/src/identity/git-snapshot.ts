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

/** 异步跑一条 git，失败返回 null（与同步版 fail-open 同口径） */
async function gitAsync(args: string[]): Promise<{ code: number; out: string } | null> {
  try {
    const proc = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => proc.kill(), 3000);
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    clearTimeout(timer);
    return { code, out };
  } catch {
    return null;
  }
}

let prefetching: Promise<void> | null = null;

/**
 * X1（PR-D）：启动早期调一次，把 git 快照异步算好写进缓存。之后 collector / 埋点元数据的
 * 同步 `getGitSnapshot()` 直接命中缓存，不再在首帧前同步 fork 两次 git（`status --porcelain`
 * 本仓实测 ~30–50ms，随工作区文件数增长）。
 *
 * 预取没跑完时同步读取仍按旧路径现算（结果一致，只是没省下时间）——不让正确性依赖时序。
 */
export function prefetchGitSnapshot(): Promise<void> {
  if (cached) return Promise.resolve();
  if (prefetching) return prefetching;
  prefetching = (async () => {
    const [head, status] = await Promise.all([
      gitAsync(["rev-parse", "HEAD"]),
      gitAsync(["status", "--porcelain"]),
    ]);
    if (cached) return; // 同步路径已经抢先算过
    const h = head && head.code === 0 ? head.out.trim() : "";
    cached =
      h && status && status.code === 0
        ? { head: h, dirty: status.out.trim() !== "" }
        : { head: null, dirty: null };
  })().catch(() => {});
  return prefetching;
}

/** 仅测试 */
export function __resetGitSnapshotForTest(): void {
  cached = null;
  prefetching = null;
}
