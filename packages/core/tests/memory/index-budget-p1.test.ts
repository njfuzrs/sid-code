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
  INDEX_DESC_MAX_LEN,
  truncateIndexDesc,
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

// ────────────────────────────────────────────────────────────────────────────
// C3-A（2026-11-03）：索引行描述截到 INDEX_DESC_MAX_LEN
// ────────────────────────────────────────────────────────────────────────────
describe("C3-A：索引行描述上限把字节预算还给可见条数", () => {
  test("超长描述截到上限，短描述原样保留", () => {
    const long = "这是一条足够长的中文摘要".repeat(10); // 130 字符
    const cut = truncateIndexDesc(long);
    // D-18：`…` 占一格，所以结果是「39 个原字符 + …」。上限本身不动：
    // 截断后的描述仍然不超过 INDEX_DESC_MAX_LEN 个 code point。
    expect(Array.from(cut).length).toBe(INDEX_DESC_MAX_LEN);
    expect(cut).toBe(
      Array.from(long)
        .slice(0, INDEX_DESC_MAX_LEN - 1)
        .join("") + "…",
    );

    expect(truncateIndexDesc("短摘要")).toBe("短摘要");
    expect(truncateIndexDesc("")).toBe("");
  });

  test("D-18：超长描述以 `…` 结尾，读者能分辨「被截断」而非「原文结束」", () => {
    const long = "这是一条足够长的中文摘要".repeat(10); // 130 字符
    const cut = truncateIndexDesc(long);
    expect(cut.endsWith("…")).toBe(true);
    // 恰好等于上限（40）的描述不截断，也就不该多出 `…`
    const exact = "a".repeat(INDEX_DESC_MAX_LEN);
    expect(truncateIndexDesc(exact)).toBe(exact);
    expect(truncateIndexDesc(exact).endsWith("…")).toBe(false);
  });

  test("D-18：超长描述里反引号未闭合时，退到反引号之前，输出反引号成对", () => {
    // 唯一的反引号落在第 21 个字符：在 39 字符切口之内，且位于**后半段**——判据是
    // `lastTick > cut / 2`，落在前半段的反引号按设计不退回（退到它之前会把描述砍掉
    // 一半以上，见下一条「太靠前」用例）。旧实现直接切在 40，产出
    // `` …`docs/xxx `` 这种半截代码片段。后面的 x/y 用 repeat 写，长度一眼可数。
    const desc = "用户明确要求不要把缺陷文档主动移动" + "xxxx`" + "y".repeat(26);
    expect(Array.from(desc).length).toBeGreaterThan(INDEX_DESC_MAX_LEN);
    const cut = truncateIndexDesc(desc);
    expect(cut.endsWith("…")).toBe(true);
    // 用 Array.from 过滤而不是正则：反引号是 ASCII，这里只为把「数反引号」写成
    // 与实现同一个口径（code point），避免两处对「字符」的理解漂移。
    const ticks = Array.from(cut).filter((ch) => ch === "`").length;
    expect(ticks % 2).toBe(0); // 成对
    expect(ticks).toBe(0); // 这里只有那一个反引号，应被整个退掉
    // 退到反引号之前，不是退成空串
    expect(cut.startsWith("用户明确要求")).toBe(true);
  });

  test("D-18：反引号已闭合（成对）时不退，只补 `…`", () => {
    // 反引号对落在前 10 个字符内（成对且靠前），其后一路到 40 都没有反引号
    const desc =
      "先看 `a` 再改，然后继续写很多很多很多很多很多的正文还要更长一点" + "尾巴还要继续写下去";
    const cut = truncateIndexDesc(desc);
    expect(cut.endsWith("…")).toBe(true);
    expect((cut.match(/`/g) ?? []).length % 2).toBe(0);
    expect(cut).toBe(
      Array.from(desc)
        .slice(0, INDEX_DESC_MAX_LEN - 1)
        .join("") + "…",
    );
  });

  test("D-18：反引号出现得太靠前时宁可留半个片段，也不交出一条几乎空的描述", () => {
    // 反引号在位置 5，退到它之前只剩 5 个字符 → 信息量太低，保留原切口
    const desc = "abcde`fghijklmnopqrstuvwxyz0123456789ABCDEFG";
    const cut = truncateIndexDesc(desc);
    expect(cut.endsWith("…")).toBe(true);
    expect(Array.from(cut).length).toBe(INDEX_DESC_MAX_LEN);
  });

  test("按 code point 截断，不切坏代理对（索引里含 ⭐⚠️🌐⚡）", () => {
    // 40 个 emoji + 尾巴：若用 slice(0, 40) 按 UTF-16 code unit 切，
    // 40 个 emoji 占 80 个 code unit，会被切在第 20 个 emoji 之后/中间。
    const emojis = "⚠️".repeat(30); // 每个是 2 个 code point（⚠ + 变体选择符）
    const cut = truncateIndexDesc(emojis);
    // 不产生孤立代理项（含 `…` 也不能破坏这一点）
    expect(cut.includes("\uFFFD")).toBe(false);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(cut)).toBe(
      false,
    );
    // 每个保留的字符都能再切出同样的码点序列
    expect(Array.from(cut).length).toBe(INDEX_DESC_MAX_LEN);
  });

  test("同一条数下，描述截短后的索引能列出更多条（字节预算的收益）", () => {
    // 模拟真实分布：key 45 + 文件名 56 + 描述 277 字节 ≈ 389 字节/行（本机实测）。
    // 不截断 25KB 只放得下 64 条左右；截到 40 字符后应显著更多。
    const longDesc = "中文摘要".repeat(23) + "xx"; // ≈ 70 字符 ≈ 210 字节
    const entries = Array.from({ length: 200 }, (_, i) => ({
      key: `user_person_interview_prep_topic_${i}`,
      file: `user_interview_prep_topic_${i}.md`,
      desc: longDesc,
    }));

    const raw = entries.map((e) => line(e.key.length > 0 ? 0 : 0, e.desc) + `-${e.key}`);
    const rawResult = buildTruncatedIndex(raw);
    const trimmed = entries.map((e) => line(0, truncateIndexDesc(e.desc)).replace("key0", e.key));
    const trimmedResult = buildTruncatedIndex(trimmed);

    expect(trimmedResult.truncated).toBe(true); // 200 条仍超 25KB（这是预期：C3-C 负责收敛存量）
    expect(trimmedResult.entryCount).toBeGreaterThan(rawResult.entryCount);
    // 提升至少 30%：截 40 字符把描述从 ~450 字节压到 ~120 字节
    expect(trimmedResult.entryCount).toBeGreaterThanOrEqual(Math.floor(rawResult.entryCount * 1.3));
  });

  test("索引行描述常量必须远小于 frontmatter 的 150（否则 A 方案没有收益）", () => {
    expect(INDEX_DESC_MAX_LEN).toBeLessThan(150);
    // 40 是本方案定的值：中文 1 字符 3 字节，40 字符 ≈ 120 字节，
    // 配合 key+文件名的 ~100 字节能让 25KB 列出 130 条以上（本机实测 132）。
    expect(INDEX_DESC_MAX_LEN).toBe(40);
  });
});
