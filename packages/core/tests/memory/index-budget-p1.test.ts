/**
 * P1-7 防复发：索引截断的三个口径
 *
 * 三个错合起来让「双上限」只剩一个真正在起作用：
 *  ① 200 行上限实装 198 条（表头挤占条目配额）；
 *  ② 字节上限比的是 UTF-16 char 数，中文下实测超标 2.7×；
 *  ③ 硬切在行中间产出半行链接，且切完再追加警告 ⇒ 最终长度必然超上限。
 *
 * ⚠️ 变异自证：这批用例逐条确认过「把 index-budget.ts 改回旧实现就变红」。
 * 特别是 ②，**断言样本必须含中文** —— 纯 ASCII 下 `.length` 与 `Buffer.byteLength`
 * 恰好相等，旧实现同样会绿，那就是个测不到东西的空门禁。
 */

import { describe, test, expect } from "bun:test";
import {
  buildTruncatedIndex,
  utf8Bytes,
  INDEX_TRUNCATION_NOTICE,
} from "@sid-code/core/memory/index-budget.ts";
import { MEMORY_LIMITS } from "@sid-code/core/memory/types.ts";

/** 造一条形如索引指针的行 */
function line(i: number, desc: string): string {
  return `- [key${i}](reference_key${i}.md) — ${desc}`;
}

describe("P1-7 ① 条数上限数的是指针条数，表头不挤占配额", () => {
  test("恰好 200 条时全部列出，且不触发截断", () => {
    const lines = Array.from({ length: MEMORY_LIMITS.INDEX_MAX_ENTRIES }, (_, i) =>
      line(i, "短摘要"),
    );
    const { content, entryCount, truncated } = buildTruncatedIndex(lines);

    // 旧实现在这里只放得下 198 条并报 truncated —— 这两条断言同时锁住 ①
    expect(entryCount).toBe(MEMORY_LIMITS.INDEX_MAX_ENTRIES);
    expect(truncated).toBe(false);

    // 表头存在，但不计入条目数
    expect(content.startsWith("# Memory Index\n\n")).toBe(true);
    const pointerLines = content.split("\n").filter((l) => l.startsWith("- ["));
    expect(pointerLines.length).toBe(MEMORY_LIMITS.INDEX_MAX_ENTRIES);
  });

  test("第 201 条被截断，且条数与 STORE_MAX_ENTRIES 口径对齐", () => {
    const lines = Array.from({ length: MEMORY_LIMITS.INDEX_MAX_ENTRIES + 1 }, (_, i) =>
      line(i, "短摘要"),
    );
    const { entryCount, truncated } = buildTruncatedIndex(lines);
    expect(entryCount).toBe(MEMORY_LIMITS.INDEX_MAX_ENTRIES);
    expect(truncated).toBe(true);

    // 两条线必须同值：索引容量低于磁盘保留线 ⇒ 稳态下永远有记忆是「孤儿」
    expect(MEMORY_LIMITS.INDEX_MAX_ENTRIES).toBe(MEMORY_LIMITS.STORE_MAX_ENTRIES);
  });
});

describe("P1-7 ② 字节上限量的是真 UTF-8 字节", () => {
  test("utf8Bytes 对中文按 3 字节计，与 .length 分道扬镳", () => {
    const zh = "记忆索引摘要";
    expect(zh.length).toBe(6); // UTF-16 code unit
    expect(utf8Bytes(zh)).toBe(18); // 真字节
    // 这就是旧实现把 25KB 预算实付成 67KB 的比率来源
    expect(utf8Bytes(zh) / zh.length).toBe(3);
  });

  test("纯中文长摘要下产出**真字节**不超上限（旧实现在此超标 2.7×）", () => {
    // 每条 ~150 中文字符的摘要 ≈ 450 字节；190 条 ≈ 85KB，远超 25KB。
    // 旧实现按 char 数比，190×150=28500 char 才刚触发截断，此时真字节已 ~67KB。
    const desc = "这是一条足够长的中文摘要用于触发字节预算".repeat(8);
    const lines = Array.from({ length: 190 }, (_, i) => line(i, desc));
    const { content, truncated } = buildTruncatedIndex(lines);

    expect(truncated).toBe(true);
    // 核心断言：真字节 ≤ 上限。旧实现这里会是 ~67000。
    expect(utf8Bytes(content)).toBeLessThanOrEqual(MEMORY_LIMITS.INDEX_MAX_BYTES);
  });
});

describe("P1-7 ③ 只在行边界停，且警告文案计入预算", () => {
  test("截断后不存在残缺的半行链接", () => {
    const desc = "中文摘要内容".repeat(30);
    const lines = Array.from({ length: 300 }, (_, i) => line(i, desc));
    const { content } = buildTruncatedIndex(lines);

    // 每个以 `- [` 开头的行都必须是完整的 `- [key](file) — desc` 形态。
    // 旧实现 slice 硬切会留下 `- [key199](reference_key199.m` 这种
    // **看起来可用、实际 Read 必失败**的行。
    for (const l of content.split("\n")) {
      if (!l.startsWith("- [")) continue;
      expect(l).toMatch(/^- \[[^\]]+\]\([^)]+\.md\) — /);
    }
  });

  test("含警告文案的最终长度仍 ≤ 上限（旧实现必然超出）", () => {
    const desc = "中文摘要".repeat(60);
    const lines = Array.from({ length: 400 }, (_, i) => line(i, desc));
    const { content, truncated } = buildTruncatedIndex(lines);

    expect(truncated).toBe(true);
    expect(content).toContain(INDEX_TRUNCATION_NOTICE.trim());
    // 旧实现是「先切到上限、再 += 警告」⇒ 恒超上限。这条锁住「预留」这个修法。
    expect(utf8Bytes(content)).toBeLessThanOrEqual(MEMORY_LIMITS.INDEX_MAX_BYTES);
  });

  test("不截断时不追加警告（不制造假告警）", () => {
    const { content, truncated } = buildTruncatedIndex([line(0, "短"), line(1, "短")]);
    expect(truncated).toBe(false);
    expect(content).not.toContain("索引已截断");
  });

  test("空输入产出只有表头的索引，不报截断", () => {
    const { content, entryCount, truncated } = buildTruncatedIndex([]);
    expect(entryCount).toBe(0);
    expect(truncated).toBe(false);
    expect(content.trim()).toBe("# Memory Index");
  });
});
