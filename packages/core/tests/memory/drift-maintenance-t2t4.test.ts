/**
 * 漂移与维护方案 T2-2 / T3 / T4-3 的回归（2026-11-15）。
 *
 * 三个改动共同的形态：**参数化的阈值/判据统计过去只能靠人看影子统计**
 * （`scripts/memory-drift-shadow-stats.ts` 是只读脚本，不能保证实现与它同口径）。
 * 这里用**造数据**把口径钉死在单测里 —— 真实库里凑不出「恰好 30% 该标」
 * 和「恰好 2 条 user 被归档」这两种边界，等生产数据等于永远不验。
 */
import { describe, test, expect } from "bun:test";
import {
  annotateIndexAges,
  INDEX_AGED_FRACTION,
  type MemoryEntry,
} from "@sid-code/core/memory/store.ts";
import { countAnchorHealth, extractRepoPaths } from "@sid-code/core/memory/anchor-health.ts";
import {
  evaluateDreamPrunes,
  MAX_USER_PRUNES_PER_DREAM,
  type DreamEntrySnapshot,
} from "@sid-code/core/memory/dream/guard.ts";

const DAY = 24 * 60 * 60 * 1000;

function entry(key: string, updatedAt: number, type: MemoryEntry["type"] = "project"): MemoryEntry {
  return {
    key,
    value: "正文",
    scope: "project",
    createdAt: updatedAt,
    updatedAt,
    type,
    description: "描述",
    source: "user_explicit",
  };
}

function indexText(keys: string[]): string {
  return ["# Memory Index", "", ...keys.map((k) => `- [${k}](${k}.md) — 描述`)].join("\n");
}

function entriesOf(items: MemoryEntry[]): Map<string, MemoryEntry> {
  return new Map(items.map((e) => [e.key, e]));
}

describe("T2-2 annotateIndexAges：只标最旧的一批", () => {
  test("100 条里恰好标 30 条（= floor(n × 0.3)），且标的是最旧的", () => {
    const now = Date.now();
    // k00 最旧（99 天前），k99 最新（当天）
    const items = Array.from({ length: 100 }, (_, i) =>
      entry(`k${String(i).padStart(2, "0")}`, now - (99 - i) * DAY),
    );
    const out: { entryCount?: number; agedCount?: number } = {};
    const text = annotateIndexAges(indexText(items.map((e) => e.key)), entriesOf(items), out);

    expect(out.entryCount).toBe(100);
    expect(out.agedCount).toBe(Math.floor(100 * INDEX_AGED_FRACTION)); // 30
    // 最旧的 30 条带标记，第 31 条起不带
    const lines = text.split("\n").filter((l) => l.startsWith("- ["));
    expect(lines.slice(0, 30).every((l) => l.includes("⏳"))).toBe(true);
    expect(lines.slice(30).every((l) => !l.includes("⏳"))).toBe(true);
  });

  test("4 条里标 1 条；3 条里一条都不标（floor 到 0，小库不制造噪声）", () => {
    const now = Date.now();
    const four = [0, 1, 2, 3].map((i) => entry(`m${i}`, now - (4 - i) * DAY));
    const out4: { agedCount?: number } = {};
    annotateIndexAges(indexText(four.map((e) => e.key)), entriesOf(four), out4);
    expect(out4.agedCount).toBe(1);

    const three = [0, 1, 2].map((i) => entry(`n${i}`, now - (3 - i) * DAY));
    const out3: { agedCount?: number } = {};
    annotateIndexAges(indexText(three.map((e) => e.key)), entriesOf(three), out3);
    expect(out3.agedCount).toBe(0);
  });

  test("最旧的一批里若有 1 天内的（刚写），不标也不算进 agedCount", () => {
    const now = Date.now();
    // 2 条：配额 floor(2*0.3)=0 —— 用 4 条让配额=1，且最旧那条就是当天
    const items = [
      entry("fresh", now - 60_000),
      entry("b", now - DAY),
      entry("c", now - 2 * DAY),
      entry("d", now - 3 * DAY),
    ];
    const out: { agedCount?: number } = {};
    const text = annotateIndexAges(indexText(items.map((e) => e.key)), entriesOf(items), out);
    // 最旧是 d（3 天），不是 fresh —— fresh 不在配额内
    expect(out.agedCount).toBe(1);
    expect(text).toContain("⏳");
  });

  test("同 updatedAt 的大批条目不会整批标上（用 key 集合而非时间阈值）", () => {
    const now = Date.now();
    const same = Array.from({ length: 40 }, (_, i) => entry(`s${i}`, now - 10 * DAY));
    const out: { agedCount?: number } = {};
    annotateIndexAges(indexText(same.map((e) => e.key)), entriesOf(same), out);
    // 时间阈值实现会标 40 条；key 集合实现严格 floor(40*0.3)=12
    expect(out.agedCount).toBe(Math.floor(40 * INDEX_AGED_FRACTION));
  });

  test("孤儿行（索引里有、内存里没有）不计数、不编造年龄", () => {
    const now = Date.now();
    const items = [entry("a", now - 5 * DAY)];
    const out: { entryCount?: number; agedCount?: number } = {};
    const text = annotateIndexAges(indexText(["a", "ghost"]), entriesOf(items), out);
    expect(out.entryCount).toBe(2);
    expect(text).toContain("[ghost]");
    expect(text.split("\n").find((l) => l.includes("ghost"))).not.toContain("⏳");
  });
});

describe("T3 锚点健康度：只认「全部不存在」", () => {
  const root = "/repo";
  const alive = new Set(["/repo/src/a.ts", "/repo/pkg/src/b.ts"]);

  test("引用路径全部存在 → dead 0", () => {
    const h = countAnchorHealth(["看 src/a.ts"], [root], (p) => alive.has(p));
    expect(h).toEqual({ referencedEntries: 1, deadEntries: 0 });
  });

  test("全部不存在 → dead 1；部分存在 → 不计数", () => {
    const dead = countAnchorHealth(["看 src/gone.ts"], [root], (p) => alive.has(p));
    expect(dead.deadEntries).toBe(1);

    const partial = countAnchorHealth(["看 src/a.ts 与 src/gone.ts"], [root], (p) => alive.has(p));
    expect(partial.deadEntries).toBe(0); // 只认全部失效，部分失效是已知误报来源
    expect(partial.referencedEntries).toBe(1);
  });

  test("没引用任何仓内路径的记忆不进分母", () => {
    const h = countAnchorHealth(["这是一条没有路径的记忆"], [root], () => false);
    expect(h).toEqual({ referencedEntries: 0, deadEntries: 0 });
  });

  test("多根任一命中即算活着（monorepo 包内相对路径）", () => {
    const h = countAnchorHealth(["看 src/b.ts"], [root, "/repo/pkg"], (p) => alive.has(p));
    expect(h.deadEntries).toBe(0);
  });

  test("没有可信根时返回 0/0（宁可不报，也不拿错根判一堆假失效）", () => {
    const h = countAnchorHealth(["看 src/gone.ts"], [], () => false);
    expect(h).toEqual({ referencedEntries: 0, deadEntries: 0 });
  });

  test("extractRepoPaths 不认 URL / node_modules / 裸文件名", () => {
    expect(extractRepoPaths("https://github.com/a/b.ts")).toEqual([]);
    expect(extractRepoPaths("node_modules/x/y.ts")).toEqual([]);
    expect(extractRepoPaths("改 store.ts 里的 load()")).toEqual([]);
    expect(extractRepoPaths("改 src/a.ts:12-18")).toEqual(["src/a.ts"]); // 行号后缀剥掉
  });
});

describe("T4-3 dream 损失闸门：user 归档上限", () => {
  const strip = (t: string) => t.replace(/^---\s*\n[\s\S]*?\n---/, "");
  const snap = (type: string, text = "正文内容"): DreamEntrySnapshot => ({
    text: `---\ntype: ${type}\n---\n${text}`,
    type,
  });

  test("一次归档 1 条 user → 放行（合法删除）", () => {
    const before = new Map([
      ["user_a.md", snap("user")],
      ["proj_b.md", snap("project")],
    ]);
    const after = new Map([
      ["user_a.md", "---\ntype: user\n---\n"],
      ["proj_b.md", "---\ntype: project\n---\n正文内容"],
    ]);
    const v = evaluateDreamPrunes(before, after, strip);
    expect(v.userPruned).toBe(1);
    expect(v.rejected).toBe(false);
  });

  test("一次归档 2 条 user → 整次拒绝", () => {
    const before = new Map([
      ["user_a.md", snap("user")],
      ["user_b.md", snap("user")],
    ]);
    const after = new Map([
      ["user_a.md", ""],
      ["user_b.md", ""],
    ]);
    const v = evaluateDreamPrunes(before, after, strip);
    expect(v.userPruned).toBe(2);
    expect(v.rejected).toBe(true);
    expect(v.pruned).toHaveLength(2);
  });

  test("非 user 被批量归档不触发拒绝（上限只保护 user）", () => {
    const before = new Map([
      ["r1.md", snap("reference")],
      ["p1.md", snap("project")],
      ["p2.md", snap("project")],
    ]);
    const after = new Map([
      ["r1.md", ""],
      ["p1.md", ""],
      ["p2.md", ""],
    ]);
    const v = evaluateDreamPrunes(before, after, strip);
    expect(v.userPruned).toBe(0);
    expect(v.rejected).toBe(false);
  });

  test("文件被直接删除也算归档（不能靠「文件还在」漏判）", () => {
    const before = new Map([["user_a.md", snap("user")]]);
    const v = evaluateDreamPrunes(before, new Map(), strip);
    expect(v.pruned).toHaveLength(1);
    expect(v.rejected).toBe(false);
  });

  test("精炼（正文非空但变短）不算归档", () => {
    const before = new Map([["user_a.md", snap("user", "很长很长的正文")]]);
    const after = new Map([["user_a.md", "---\ntype: user\n---\n短正文"]]);
    const v = evaluateDreamPrunes(before, after, strip);
    expect(v.pruned).toHaveLength(0);
    expect(v.rejected).toBe(false);
  });

  test("上限常量是 1（写进断言的契约，改它要同时改 PR 说明）", () => {
    expect(MAX_USER_PRUNES_PER_DREAM).toBe(1);
  });
});
