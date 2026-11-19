/**
 * D-12（2026-11-19）：记忆年龄从「N days ago」改成「YYYY-MM-DD（N 天前）」
 *
 * 为什么要改：相对天数只在读到它的**当天**成立，而索引进 system prompt 后会跨天常驻；
 * 提示词自己也要求「相对日期一律改写成绝对日期再保存」（记忆会在很久之后被读到）。
 * 两处口径原本互相矛盾，这里断言的是改后的单一口径。
 *
 * ⚠️ 变异自证：把 `memoryAge` 改回 `return \`${days} days ago\`` 后，
 * 本文件全部用例变红（见 PR 说明）。
 */

import { describe, test, expect } from "bun:test";
import { memoryAge, memoryAgeDays } from "@sid-code/core/memory/freshness.ts";

const DAY = 24 * 60 * 60 * 1000;

/** 与实现同口径的本地日期（用本地时区，因为 updatedAt 是本地写入时刻） */
function ymd(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

describe("D-12：memoryAge 输出「绝对日期（N 天前）」", () => {
  test("文档验收示例：形如 2026-06-26（146 天前）", () => {
    // 用固定时间戳而不是 `now - N*DAY`：跨时区时「now 减 146 天」不一定正好是同月同日，
    // 期望值必须由同一个时间戳派生，否则断言会在别的时区变绿/变红而不自知。
    const updated = Date.UTC(2026, 5, 26, 4, 0, 0); // 本地 2026-06-26 12:00（UTC+8）
    const now = updated + 146 * DAY;
    const out = memoryAge(updated, now);
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2}（\d+ 天前）$/);
    expect(out).toBe(`${ymd(updated)}（146 天前）`);
  });

  test("不再是英文相对天数：不含 days ago / today / yesterday", () => {
    const updated = Date.UTC(2026, 5, 26, 4, 0, 0);
    const out = memoryAge(updated, updated + 146 * DAY);
    expect(out).not.toContain("days ago");
    expect(out).not.toContain("today");
    expect(out).not.toContain("yesterday");
  });

  test("days <= 0 走「今天」分支，days === 1 走「昨天」，都不出现负数天数", () => {
    const updated = Date.UTC(2026, 5, 26, 4, 0, 0);
    expect(memoryAge(updated, updated)).toBe(`${ymd(updated)}（今天）`);
    // 同一天内但小时更晚（days 仍为 0）同样是今天
    expect(memoryAge(updated, updated + 6 * 60 * 60 * 1000)).toBe(`${ymd(updated)}（今天）`);
    expect(memoryAge(updated, updated + DAY)).toBe(`${ymd(updated)}（昨天）`);
    // 记忆时间晚于 now（时钟回拨 / 跨机同步）：天数会算出负数，不能渲染成「-1 天前」。
    // 注意不能裸断言「不含 -」——日期本身的 `2026-06-27` 里有连字符，那样是空断言。
    expect(memoryAge(updated + DAY, updated)).toBe(`${ymd(updated + DAY)}（今天）`);
    expect(memoryAge(updated + DAY, updated)).not.toMatch(/（-\d+ 天前）/);
  });

  test("日期部分取记忆自身的日期，而不是 now 的日期", () => {
    const a = Date.UTC(2025, 0, 2, 4, 0, 0);
    const b = Date.UTC(2025, 0, 20, 4, 0, 0);
    expect(memoryAge(a, b)).toBe(`${ymd(a)}（18 天前）`);
    expect(memoryAge(b, b + 5 * DAY)).toBe(`${ymd(b)}（5 天前）`);
  });

  test("天数与 memoryAgeDays 同源（避免索引说 146 天、警告说 145 天）", () => {
    const updated = Date.UTC(2026, 5, 26, 4, 0, 0);
    const now = updated + 146 * DAY + 12 * 60 * 60 * 1000;
    const days = memoryAgeDays(updated, now);
    expect(memoryAge(updated, now)).toBe(`${ymd(updated)}（${days} 天前）`);
  });
});
