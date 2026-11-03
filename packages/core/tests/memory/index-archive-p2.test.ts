/**
 * C3-C 门禁：索引截断时的低频记忆归档判据（2026-11-03）。
 *
 * 背景（方案 §五 C3）：本机实测 project 记忆 201 个文件、`MEMORY.md` 只列 63 条，
 * 索引每轮都在报「已截断」，而被截掉的 138 条在磁盘上永远不会被模型看见。
 * 描述截短（C3-A）只把天花板抬高一次，**分母还在涨** —— 归档才是收敛存量的机制。
 *
 * 这组断言锁的是「判据只能往不归档那一侧出错」：
 * 归档虽不是删除（字节进 `archive/`，可恢复），但它是「让模型看不见」的动作，
 * 误伤一条高频记忆的代价远大于少归档十条。所以三个条件必须同时满足，
 * 且读统计缺失时门槛更高（90 天）。
 *
 * ⚠️ 变异自证：把 `ARCHIVABLE_TYPES` 改成包含 `feedback` → 类型断言变红；
 * 把读统计判断去掉 → `readCount > 0` 的用例变红；
 * 把 age 判断去掉 → 新记忆用例变红。
 */

import { describe, test, expect } from "bun:test";
import {
  selectIndexArchiveCandidates,
  INDEX_ARCHIVE_MIN_AGE_MS,
  INDEX_ARCHIVE_MIN_AGE_NO_STATS_MS,
  INDEX_ARCHIVE_MAX_PER_RUN,
} from "@sid-code/core/memory/index-archive.ts";
import type { MemoryReadStat } from "@sid-code/core/memory/read-stats.ts";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

/** 造一条 `ageDays` 天前写入的记忆条目 */
function entry(
  key: string,
  opts: { type?: string; ageDays?: number } = {},
): { key: string; filename: string; type: string; updatedAt: number } {
  return {
    key,
    filename: `${opts.type ?? "project"}_${key}.md`,
    type: opts.type ?? "project",
    updatedAt: NOW - (opts.ageDays ?? 0) * DAY,
  };
}

/** 无读统计（= 从未被 Read）的默认入参 */
const NO_STATS: Record<string, MemoryReadStat> = {};

describe("C3-C 归档判据：三个条件同时满足才进候选", () => {
  test("超过 30 天未更新、从未被 Read 的 project → 归档候选", () => {
    const c = selectIndexArchiveCandidates({
      entries: [entry("old", { ageDays: 40 })],
      readStats: NO_STATS,
      hasReadStats: true,
      now: NOW,
    });
    expect(c.map((x) => x.key)).toEqual(["old"]);
  });

  test("user / feedback 永不归档（索引优先级最高的一类，S9 刻意保它们）", () => {
    const c = selectIndexArchiveCandidates({
      entries: [
        entry("pref", { type: "user", ageDays: 400 }),
        entry("fb", { type: "feedback", ageDays: 400 }),
      ],
      readStats: NO_STATS,
      hasReadStats: true,
      now: NOW,
    });
    expect(c).toEqual([]);
  });

  test("30 天内更新过的记忆不动（即使从没被读过）", () => {
    const c = selectIndexArchiveCandidates({
      entries: [entry("fresh", { ageDays: 5 })],
      readStats: NO_STATS,
      hasReadStats: true,
      now: NOW,
    });
    expect(c).toEqual([]);
    // 边界：恰好 30 天（>=）才归档
    const boundary = selectIndexArchiveCandidates({
      entries: [
        {
          key: "exact",
          filename: "project_exact.md",
          type: "project",
          updatedAt: NOW - INDEX_ARCHIVE_MIN_AGE_MS,
        },
      ],
      readStats: NO_STATS,
      hasReadStats: true,
      now: NOW,
    });
    expect(boundary.map((x) => x.key)).toEqual(["exact"]);
  });

  test("被 Read 过的记忆不动 —— 「从未用过」才是低频的唯一直接证据", () => {
    const c = selectIndexArchiveCandidates({
      entries: [entry("used", { ageDays: 400 })],
      readStats: { "project_used.md": { readCount: 3, lastRead: NOW - DAY } },
      hasReadStats: true,
      now: NOW,
    });
    expect(c).toEqual([]);
  });

  test("读统计缺失时门槛抬到 90 天：老目录不能因为「没记录」被整批搬走", () => {
    // 30 天前（有统计时够格）但统计文件缺失 → 不归档
    const middle = selectIndexArchiveCandidates({
      entries: [entry("old30", { ageDays: 30 })],
      readStats: NO_STATS,
      hasReadStats: false,
      now: NOW,
    });
    expect(middle).toEqual([]);

    // 100 天前 → 归档
    const ancient = selectIndexArchiveCandidates({
      entries: [entry("old100", { ageDays: 100 })],
      readStats: NO_STATS,
      hasReadStats: false,
      now: NOW,
    });
    expect(ancient.map((x) => x.key)).toEqual(["old100"]);
    expect(INDEX_ARCHIVE_MIN_AGE_NO_STATS_MS).toBeGreaterThan(INDEX_ARCHIVE_MIN_AGE_MS);
  });

  test("类型缺失（老数据没有 type）不归档 —— 判不准就不动", () => {
    const c = selectIndexArchiveCandidates({
      entries: [{ key: "untyped", filename: "x.md", type: undefined, updatedAt: NOW - 400 * DAY }],
      readStats: NO_STATS,
      hasReadStats: true,
      now: NOW,
    });
    expect(c).toEqual([]);
  });

  test("filename 为空（映射缺失）不归档 —— 归档需要真实文件路径", () => {
    const c = selectIndexArchiveCandidates({
      entries: [{ key: "no-file", filename: "", type: "project", updatedAt: NOW - 400 * DAY }],
      readStats: NO_STATS,
      hasReadStats: true,
      now: NOW,
    });
    expect(c).toEqual([]);
  });
});

describe("C3-C 归档顺序与上限", () => {
  test("最旧先归档（updatedAt 升序），同日按 key 稳定排序", () => {
    const c = selectIndexArchiveCandidates({
      entries: [
        entry("newer", { ageDays: 31 }),
        entry("oldest", { ageDays: 100 }),
        entry("middle", { ageDays: 60 }),
        entry("b-same", { ageDays: 40 }),
        entry("a-same", { ageDays: 40 }),
      ],
      readStats: NO_STATS,
      hasReadStats: true,
      now: NOW,
    });
    expect(c.map((x) => x.key)).toEqual(["oldest", "middle", "a-same", "b-same", "newer"]);
  });

  test("单次最多归档 maxPerRun 条（默认 20），剩下的留给后续写入路径收敛", () => {
    const entries = Array.from({ length: 50 }, (_, i) => entry(`k${i}`, { ageDays: 60 + i }));
    const c = selectIndexArchiveCandidates({
      entries,
      readStats: NO_STATS,
      hasReadStats: true,
      now: NOW,
    });
    expect(c.length).toBe(INDEX_ARCHIVE_MAX_PER_RUN);
    // 取最旧的一批
    expect(c[0]!.key).toBe("k49");

    // 可覆盖上限（测试 / 未来调参用）
    const small = selectIndexArchiveCandidates({
      entries,
      readStats: NO_STATS,
      hasReadStats: true,
      now: NOW,
      maxPerRun: 3,
    });
    expect(small.length).toBe(3);
  });

  test("空输入返回空数组（不抛）", () => {
    expect(
      selectIndexArchiveCandidates({
        entries: [],
        readStats: NO_STATS,
        hasReadStats: true,
        now: NOW,
      }),
    ).toEqual([]);
  });
});
