/**
 * StreamingMarkdown 稳定前缀切分纯函数单测。
 *
 * 保护对象：computeStreamSplit —— 流式正文「冻结前缀 + 增长后缀」的切分逻辑。
 * 这是去掉视口裁剪后防闪烁的核心：前缀逐字节稳定 → 已滚入 scrollback 的早期行不变 →
 * 不触发 log-update 的 full-reset。最致命的回归是：
 *   ① 切分丢字符（stablePrefix + unstableSuffix !== input）；
 *   ② 边界回退（冻结前缀不再是新文本的前缀 → 早期行变化 → 闪烁）；
 *   ③ 未闭合代码围栏被从中间切断（前缀含半个围栏 → markdown 解析错乱）。
 */

import { describe, test, expect } from "bun:test";
import { computeStreamSplit } from "../../src/ui/components/StreamingMarkdown.tsx";

describe("computeStreamSplit（流式稳定前缀切分）", () => {
  test("空串 → 全空", () => {
    expect(computeStreamSplit("", 0)).toEqual({
      stablePrefix: "",
      unstableSuffix: "",
      boundary: 0,
    });
  });

  test("不变量：stablePrefix + unstableSuffix === input（各种形态）", () => {
    const cases = [
      "hello",
      "single paragraph no newline yet",
      "# 标题\n\n正文段落\n\n第二段",
      "para1\n\npara2\n\n```js\ncode\n```\n\npara3",
      "| a | b |\n| --- | --- |\n| 1 | 2 |\n\ntrailing",
      "中文段落带 emoji 🎉\n\n另一段",
    ];
    for (const text of cases) {
      const { stablePrefix, unstableSuffix } = computeStreamSplit(text, 0);
      expect(stablePrefix + unstableSuffix).toBe(text);
    }
  });

  test("单段无换行 → 前缀空、全进 unstable", () => {
    const text = "这是一段正在增长的文本还没有任何块边界";
    const { stablePrefix, unstableSuffix, boundary } = computeStreamSplit(text, 0);
    expect(stablePrefix).toBe("");
    expect(unstableSuffix).toBe(text);
    expect(boundary).toBe(0);
  });

  test("多块 → 最后一块落在 unstable，前面的块进 stable", () => {
    const text = "第一段\n\n第二段\n\n第三段正在增长";
    const { stablePrefix, unstableSuffix } = computeStreamSplit(text, 0);
    // 最后一块（第三段）应在 unstable 后缀里
    expect(unstableSuffix).toContain("第三段正在增长");
    // 前缀应包含已完成的前两段
    expect(stablePrefix).toContain("第一段");
    expect(stablePrefix).toContain("第二段");
    expect(stablePrefix).not.toContain("第三段");
  });

  test("未闭合代码围栏整体留在 unstable、不被从中间切断", () => {
    // marked 把未闭合围栏当作单个 token → 边界落在围栏起点之前
    const text = "前置说明\n\n```ts\nconst a = 1;\nconst b = 2;";
    const { stablePrefix, unstableSuffix } = computeStreamSplit(text, 0);
    // 整个围栏（含起始 ```）应完整落在 unstable，stable 不含半个围栏
    expect(unstableSuffix).toContain("```ts");
    expect(unstableSuffix).toContain("const a = 1;");
    expect(stablePrefix).not.toContain("```");
  });

  test("边界单调不减：committed 大于候选时不回退", () => {
    const text = "第一段\n\n第二段正在增长";
    // 上一帧已提交一个较大边界（覆盖到第二段中间）
    const committed = text.length - 3;
    const { boundary, stablePrefix, unstableSuffix } = computeStreamSplit(text, committed);
    expect(boundary).toBeGreaterThanOrEqual(committed);
    expect(stablePrefix + unstableSuffix).toBe(text);
  });

  test("边界钳制在 [0, text.length] 内", () => {
    const text = "abc\n\ndef";
    // committed 超过文本长度 → 钳制到 text.length（全进 stable，unstable 空）
    const over = computeStreamSplit(text, 999);
    expect(over.boundary).toBe(text.length);
    expect(over.stablePrefix).toBe(text);
    expect(over.unstableSuffix).toBe("");
  });

  test("逐 delta 增长：前缀始终是新文本的真前缀（startsWith 不变量）", () => {
    // 模拟流式：committed 从上一帧带入，验证冻结前缀永远是当前文本前缀
    const deltas = [
      "# 标题",
      "# 标题\n\n第一",
      "# 标题\n\n第一段完成",
      "# 标题\n\n第一段完成\n\n第二段",
      "# 标题\n\n第一段完成\n\n第二段也完成了",
      "# 标题\n\n第一段完成\n\n第二段也完成了\n\n```js\ncode",
    ];
    let committed = 0;
    let prevPrefix = "";
    for (const text of deltas) {
      // 新文本必须以上一帧冻结前缀开头（否则组件会重置；这里验证不需重置）
      expect(text.startsWith(prevPrefix)).toBe(true);
      const { stablePrefix, unstableSuffix, boundary } = computeStreamSplit(text, committed);
      expect(stablePrefix + unstableSuffix).toBe(text);
      expect(boundary).toBeGreaterThanOrEqual(committed);
      committed = boundary;
      prevPrefix = stablePrefix;
    }
    // 末帧：未闭合围栏整体在 unstable
    expect(prevPrefix).not.toContain("```");
  });

  test("最后一个 content 块即使其后已有空行也留在 unstable（防过早冻结）", () => {
    // 末块后跟 \n\n（marked 产出 trailing space token）。若按"最后一个 token"切，
    // 会把末块过早冻结；正确做法是跳过 space token、末 content 块仍在 unstable。
    const text = "第一段\n\n第二段\n\n";
    const { stablePrefix, unstableSuffix } = computeStreamSplit(text, 0);
    expect(stablePrefix + unstableSuffix).toBe(text);
    expect(unstableSuffix).toContain("第二段");
    expect(stablePrefix).not.toContain("第二段");
  });

  test("迟到的 setext 标记重解释末块时不会被冻结切断", () => {
    // 流式：先到 "标题文字\n"，下一帧补 "===" → marked 把它重解释为 setext H1。
    // 若上一帧已冻结 "标题文字"，则前缀=段落、后缀=半个 setext → 解析错乱。
    // 正确：committed 不应越过该块,使整块在 unstable 内被整体重解释。
    const d1 = "前置段落\n\n标题文字\n";
    const s1 = computeStreamSplit(d1, 0);
    // 第二帧把同一行变成 setext 标题
    const d2 = "前置段落\n\n标题文字\n===\n";
    const s2 = computeStreamSplit(d2, s1.boundary);
    expect(s2.stablePrefix + s2.unstableSuffix).toBe(d2);
    // 冻结边界不得越过 "标题文字" 那一块的起点（否则 setext 被切断）
    expect(s2.stablePrefix).not.toContain("标题文字");
    expect(s2.unstableSuffix).toContain("标题文字\n===");
  });
});
