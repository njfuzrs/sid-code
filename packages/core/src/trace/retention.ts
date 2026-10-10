/**
 * 本地轨迹目录（trajectories/sessions/{id}/）的淘汰选择 —— 纯函数，不碰磁盘。
 *
 * ## 为什么从「按数量 100」改成「按体积」
 *
 * 此前 `pruneOldSessions()` 默认只留最近 100 个目录。100 是按「原始轨迹 ≈45MB/会话」
 * 推出来的磁盘保护，但实测（2026-10-10，开发者本机 100 个目录）合计只有 37MB：
 * p50 24KB、p95 1.3MB、最大 3.2MB —— 那条前提差了一个数量级以上。
 * 而一天 24~36 个会话时，100 个只够留 2~4 周，`raw.jsonl` / `session.traj` /
 * `events.jsonl`（TTFT/TTFB 分组、`trace-digest`、`provider-health` 的数据源）
 * 在想回头调试时已经没了。
 *
 * 与会话保留（`session/retention.ts`，PR #218）同一个思路：真正要防的是盘满，
 * 不是「目录多」—— 拿数量近似体积，误伤的恰好是最想留的那批。
 * 所以默认**不限数量**，兜底是总体积上限（与 `sessionRetention.maxTotalSize` 共用一个数）。
 *
 * ## 淘汰顺序与保护
 *
 * - 已上传的（有 `.uploaded`，数据已在远端）优先删，其次才动未上传的；各自最旧在前。
 * - **受保护的永不删**：活着的进程正在写的会话、`minRetention` 窗口内更新过的目录。
 *   宁可暂时超限，也不删正在写的轨迹 —— 与会话清理的口径一致。
 */

export interface TraceDirEntry {
  /** 目录名 = trace session id */
  id: string;
  dir: string;
  mtimeMs: number;
  uploaded: boolean;
  /** 目录字节数；只在启用体积上限时需要 */
  bytes?: number;
}

export interface TracePrunePolicy {
  /** 显式数量上限；undefined = 不限（默认） */
  maxCount?: number;
  /** 总体积上限（字节）；undefined = 不按体积删 */
  maxTotalBytes?: number;
  /** 该时间点之后更新过的目录不删（minRetention 窗口） */
  protectAfterMs?: number;
  /** 正被活着的进程使用的 session id */
  protectedIds?: ReadonlySet<string>;
}

export function selectTraceDirsToPrune(
  entries: readonly TraceDirEntry[],
  policy: TracePrunePolicy,
): TraceDirEntry[] {
  const isProtected = (e: TraceDirEntry): boolean =>
    (policy.protectedIds?.has(e.id) ?? false) ||
    (policy.protectAfterMs !== undefined && e.mtimeMs > policy.protectAfterMs);

  // 删除优先级：已上传的优先（最旧在前），其次未上传的（最旧在前）
  const byAge = (a: TraceDirEntry, b: TraceDirEntry) => a.mtimeMs - b.mtimeMs;
  const candidates = [
    ...entries.filter((e) => e.uploaded && !isProtected(e)).sort(byAge),
    ...entries.filter((e) => !e.uploaded && !isProtected(e)).sort(byAge),
  ];

  const selected: TraceDirEntry[] = [];
  let next = 0;

  const maxCount = policy.maxCount;
  if (maxCount !== undefined && Number.isFinite(maxCount) && maxCount > 0) {
    let overflow = entries.length - Math.floor(maxCount);
    while (overflow > 0 && next < candidates.length) {
      selected.push(candidates[next++]);
      overflow--;
    }
  }

  const limit = policy.maxTotalBytes;
  if (limit !== undefined && Number.isFinite(limit) && limit > 0) {
    const chosen = new Set(selected);
    let total = 0;
    for (const e of entries) if (!chosen.has(e)) total += e.bytes ?? 0;
    while (total > limit && next < candidates.length) {
      const e = candidates[next++];
      selected.push(e);
      total -= e.bytes ?? 0;
    }
  }

  return selected;
}
