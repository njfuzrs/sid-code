/**
 * DF3 — diff ANSI 行生产者单测
 *
 * 验证 buildDiffAnsiLines:行数与计划一致、行号槽右对齐、+/- 前缀、折叠占位行、
 * 含 ANSI 转义序列。用于 RawAnsi 单 leaf 路径。
 */

import { test, expect, describe, beforeAll } from "bun:test";
import chalk from "chalk";
import {
  buildDiffAnsiLines,
  type DiffAnsiColors,
} from "@sid-code/cli/ui/components/diffAnsiLines.ts";
import {
  planDiffWithContextCollapse,
  type DiffLine,
} from "@sid-code/cli/ui/components/DiffRenderer.tsx";

// colorize 用全局 chalk 单例;测试环境默认 level=0(无色),这里强制开色以验证 ANSI 转义。
beforeAll(() => {
  chalk.level = 3;
});

const COLORS: DiffAnsiColors = {
  secondary: "#888888",
  addFg: "#00ff00",
  delFg: "#ff0000",
  addBg: "#003300",
  delBg: "#330000",
};

// 去掉 ANSI 转义,取可见文本
// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

/** 一行里出现过的所有背景色转义(去重)。用于断言「一行只有一种底色」。 */
const bgSequences = (s: string): Set<string> => new Set(s.match(/\x1b\[48[;0-9]*m/g) ?? []);

function build(displayableLines: DiffLine[], termW = 80) {
  const plan = planDiffWithContextCollapse(
    displayableLines.map((l) => ({ type: l.type, content: l.content })),
  );
  const maxNum = Math.max(
    0,
    ...displayableLines.map((l) => l.oldLine ?? 0),
    ...displayableLines.map((l) => l.newLine ?? 0),
  );
  return buildDiffAnsiLines({
    plan,
    displayableLines,
    baseIndentation: 0,
    gutterWidth: Math.max(1, maxNum.toString().length),
    terminalWidth: termW,
    colors: COLORS,
  });
}

describe("buildDiffAnsiLines", () => {
  test("行数与计划一致", () => {
    const lines: DiffLine[] = [
      { type: "context", content: "a", oldLine: 1, newLine: 1 },
      { type: "del", content: "b-old", oldLine: 2 },
      { type: "add", content: "b-new", newLine: 2 },
    ];
    const out = build(lines);
    expect(out.length).toBe(3);
  });

  test("每行含 ANSI 转义序列", () => {
    const lines: DiffLine[] = [{ type: "add", content: "hello", newLine: 1 }];
    const out = build(lines);
    expect(out[0]).toContain("\x1b["); // 有颜色转义
  });

  test("add 行前缀为 +,del 行前缀为 -", () => {
    const lines: DiffLine[] = [
      { type: "add", content: "x", newLine: 1 },
      { type: "del", content: "y", oldLine: 1 },
    ];
    const out = build(lines);
    const plain0 = stripAnsi(out[0]);
    const plain1 = stripAnsi(out[1]);
    // 行号槽后是 "+ " / "- "
    expect(plain0).toMatch(/\+\s/);
    expect(plain1).toMatch(/-\s/);
    expect(plain0).toContain("x");
    expect(plain1).toContain("y");
  });

  test("context 行前缀为空格,保留内容", () => {
    const lines: DiffLine[] = [{ type: "context", content: "ctx-line", oldLine: 5, newLine: 5 }];
    const out = build(lines);
    expect(stripAnsi(out[0])).toContain("ctx-line");
  });

  test("行号右对齐在行号槽内", () => {
    const lines: DiffLine[] = [
      { type: "context", content: "a", oldLine: 1, newLine: 1 },
      { type: "context", content: "b", oldLine: 100, newLine: 100 },
    ];
    const out = build(lines);
    // gutterWidth=3(100 三位),行号 1 右对齐 → 前面有空格
    const plain = stripAnsi(out[0]);
    expect(plain.startsWith("  1 ")).toBe(true);
  });

  test("超长 context 折叠为占位行", () => {
    const lines: DiffLine[] = Array.from({ length: 20 }, (_, i) => ({
      type: "context" as const,
      content: `line${i}`,
      oldLine: i + 1,
      newLine: i + 1,
    }));
    const out = build(lines);
    // 折叠后:3 + 1 占位 + 3 = 7 行
    expect(out.length).toBe(7);
    const collapsed = out.find((l) => stripAnsi(l).includes("行未变更上下文已折叠"));
    expect(collapsed).toBeDefined();
    expect(stripAnsi(collapsed!)).toContain("14"); // 隐藏 14 行
  });

  test("整行只有一种底色:不做词级强调,全区域无 bold 转义", () => {
    const lines: DiffLine[] = [
      { type: "del", content: "const a = 1", oldLine: 1 },
      { type: "add", content: "const a = 2", newLine: 1 },
    ];
    const out = build(lines);
    // 整行(含 +/- 前缀符号)都不得出现 bold 转义 \x1b[1m:字重全区域统一。
    expect(out.some((l) => l.includes("\x1b[1m"))).toBe(false);
    // add/del 每行**恰好**一种背景色(整行底色)。旧实现里变化词会再叠一层 emphasis 底色,
    // 同一行出现两种背景色 → 观感「有的字深、有的字浅,像背景叠了两层」。用 toBe(1) 而不是
    // 上界断言:上界在「完全没有底色」时也会通过,那就守不住这条契约。
    for (const line of out) {
      expect(bgSequences(line).size).toBe(1);
    }
    expect(stripAnsi(out[0])).toContain("const a = 1");
    expect(stripAnsi(out[1])).toContain("const a = 2");
  });

  test("中文长行:整行底色统一,碎片化的变化词不再被换成第二种底色", () => {
    // 复现用户报的现象:`diffWordsWithSpace` 对 CJK 按字切分,一行中文里散落个别
    // 被判成「变化」的碎片(emoji / 加粗片段),旧实现下这些碎片各有一块更深底色。
    const lines: DiffLine[] = [
      { type: "del", content: "删掉判据 → 用例必须红（评估器被调、goal_gate_retry", oldLine: 1 },
      {
        type: "add",
        content:
          "删掉判据 → 用例必须红（评估器被调、goal_gate_retry ✅ 已断言 ⬜ 本条由 S-goal-wait-achieved 承担",
        newLine: 1,
      },
    ];
    const out = build(lines);
    for (const line of out) {
      expect(bgSequences(line).size).toBe(1);
    }
    expect(stripAnsi(out[1])).toContain("✅ 已断言");
  });

  test("空计划返回空数组", () => {
    expect(build([])).toEqual([]);
  });
});
