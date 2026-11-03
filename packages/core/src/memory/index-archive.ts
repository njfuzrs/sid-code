/**
 * 索引截断时的低频记忆归档（C3-C，2026-11-03）—— 解决「只增不减」。
 *
 * ## 为什么需要它
 *
 * `index-capacity.ts`（T3）只让**写入侧知道**索引满了，没有任何机制收敛存量：
 * 本机实测（2026-11-03）project 记忆 201 个文件、`MEMORY.md` 只列 63 条，
 * 索引每轮都在报「已截断」，而被截掉的那 138 条在磁盘上永远不会再被模型看见。
 * 描述截短（C3-A）把可见条数从 63 提到 132，但**分母没变**——再攒 70 条又满。
 *
 * ## 判据只能往「不归档」那一侧出错
 *
 * 归档不是删除（`archive/` 在 `scan.ts` 的 `SKIP_DIRS` 里，字节还在、用户能捞回），
 * 但它仍然是「让模型看不见」的动作，误伤一条高频记忆的代价远大于少归档十条。
 * 所以三个条件**同时**满足才进候选，且每个都取保守值：
 *
 * 1. **类型**只限 `project` / `reference`。`user` / `feedback` 是长期偏好，
 *    `indexTypeRank` 已把它们排在最前（S9），归档它们等于把索引的优先级设计反过来。
 * 2. **30 天没被写过**（`updatedAt`）。这是 LWU 口径，本身与价值无关
 *    （见 `types.ts` `STORE_MAX_ENTRIES` 的注释），所以它**只作为过滤条件**，
 *    不是排序依据；真正区分「低频」的是下一条。
 * 3. **从未被 Read 过**（`.read-stats.json` 的 `readCount` 为 0 或缺失）。
 *    这是唯一与「有没有被用到」直接相关的本地事实（`read-stats.ts` T1.1）。
 *    注意「缺失」也按 0 处理：老的记忆文件早于读统计上线，缺失不代表高频。
 *
 * 单次上限（`maxPerRun`）宁可小：收敛是渐进的，下一次写记忆时会继续。
 * 一次搬走几百条既难 review，也让「是不是误判」不可回滚。
 */

import type { MemoryReadStat } from "./read-stats.ts";

/** 候选的最低「年龄」：写入后至少 30 天没动过才可能被归档。 */
export const INDEX_ARCHIVE_MIN_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * **没有读统计文件时**的最低年龄（90 天）。
 *
 * `.read-stats.json` 是读统计上线（T1.1）之后才有的。缺失时不能把「没记录」
 * 直接当成「从未读过」—— 一个老用户的记忆目录里所有条目都会缺失，判据会退化成
 * 「只按 30 天没写归档」，可能一次搬走整批记忆。缺统计时把年龄门槛抬到 90 天，
 * 让「很老很老且没有任何使用证据」成为唯一被归档的形态。
 */
export const INDEX_ARCHIVE_MIN_AGE_NO_STATS_MS = 90 * 24 * 60 * 60 * 1000;

/** 单次收敛最多归档的条数。剩下的留给后续写入路径慢慢收敛。 */
export const INDEX_ARCHIVE_MAX_PER_RUN = 20;

/**
 * 可被归档的记忆类型。
 *
 * `user` / `feedback` 必须留在索引里：`INDEX_TYPE_RANK` 把它们的 rank 设为 0/1，
 * 截断时最后才掉（S9）。归档它们等于绕过那个优先级设计。
 */
const ARCHIVABLE_TYPES: ReadonlySet<string> = new Set(["project", "reference"]);

export interface IndexArchiveCandidate {
  /** 记忆 key */
  key: string;
  /** 相对记忆目录的文件名（与 `.read-stats.json` 的键同形） */
  filename: string;
  /** 记忆类型 */
  type: string;
  /** 最后写入时刻 */
  updatedAt: number;
}

/**
 * 从当前索引条目里挑出可归档的低频记忆（纯函数，无 I/O）。
 *
 * @param opts.entries      索引里的全部条目（含 filename / type / updatedAt）
 * @param opts.readStats    `.read-stats.json` 的内容（键 = 相对文件名）
 * @param opts.hasReadStats `.read-stats.json` 是否存在。缺失时年龄门槛抬到 90 天
 *   （见 `INDEX_ARCHIVE_MIN_AGE_NO_STATS_MS`），避免老目录被整批归档
 * @param opts.now          当前时刻（测试注入，便于构造「30 天前」的样本）
 * @returns 按 `updatedAt` 升序（最旧先）的前 `maxPerRun` 条
 *
 * 不变量（门禁在 `tests/memory/index-archive-p2.test.ts`）：
 * - 只返回 `project` / `reference`（`user` / `feedback` 永不归档）；
 * - 只返回 `readCount === 0`（或读统计缺失）的条目；
 * - 只返回 `updatedAt <= now - minAgeMs` 的条目；
 * - 返回长度不超过 `maxPerRun`。
 */
export function selectIndexArchiveCandidates(opts: {
  entries: ReadonlyArray<{
    key: string;
    filename: string;
    type?: string;
    updatedAt: number;
  }>;
  readStats: Readonly<Record<string, MemoryReadStat>>;
  hasReadStats: boolean;
  now: number;
  minAgeMs?: number;
  maxPerRun?: number;
}): IndexArchiveCandidate[] {
  const minAgeMs =
    opts.minAgeMs ??
    (opts.hasReadStats ? INDEX_ARCHIVE_MIN_AGE_MS : INDEX_ARCHIVE_MIN_AGE_NO_STATS_MS);
  const maxPerRun = opts.maxPerRun ?? INDEX_ARCHIVE_MAX_PER_RUN;

  return opts.entries
    .filter((e) => e.filename.length > 0 && e.key.length > 0)
    .filter((e) => ARCHIVABLE_TYPES.has(e.type ?? ""))
    .filter((e) => opts.now - e.updatedAt >= minAgeMs)
    .filter((e) => (opts.readStats[e.filename]?.readCount ?? 0) === 0)
    .sort((a, b) => a.updatedAt - b.updatedAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .slice(0, maxPerRun)
    .map((e) => ({
      key: e.key,
      filename: e.filename,
      type: e.type ?? "",
      updatedAt: e.updatedAt,
    }));
}
