/**
 * LCS diff 算法测试
 */

import { describe, test, expect } from "bun:test";
import { computeDiff, applyDiff, reverseDiff } from "@sid-code/core/checkpoint/diff.ts";

describe("computeDiff", () => {
  test("相同内容返回 keep", () => {
    const text = "line1\nline2\nline3";
    const diff = computeDiff(text, text);
    expect(diff.ops).toHaveLength(1);
    expect(diff.ops[0].type).toBe("keep");
    expect(diff.ops[0].lines).toEqual(["line1", "line2", "line3"]);
  });

  test("新增行", () => {
    const old = "line1\nline3";
    const new_ = "line1\nline2\nline3";
    const diff = computeDiff(old, new_);

    // 应该包含 keep + add + keep
    const types = diff.ops.map(op => op.type);
    expect(types).toContain("keep");
    expect(types).toContain("add");
  });

  test("删除行", () => {
    const old = "line1\nline2\nline3";
    const new_ = "line1\nline3";
    const diff = computeDiff(old, new_);

    const types = diff.ops.map(op => op.type);
    expect(types).toContain("remove");
  });

  test("修改行（删除旧 + 新增新）", () => {
    const old = "line1\nold_line\nline3";
    const new_ = "line1\nnew_line\nline3";
    const diff = computeDiff(old, new_);

    const types = diff.ops.map(op => op.type);
    expect(types).toContain("remove");
    expect(types).toContain("add");
  });

  test("空文本到有内容", () => {
    const diff = computeDiff("", "hello\nworld");
    expect(diff.ops.some(op => op.type === "add")).toBe(true);
  });

  test("有内容到空文本", () => {
    const diff = computeDiff("hello\nworld", "");
    expect(diff.ops.some(op => op.type === "remove")).toBe(true);
  });
});

describe("applyDiff", () => {
  test("apply 后还原出 newText", () => {
    const old = "line1\nline2\nline3";
    const new_ = "line1\nmodified\nline3\nline4";
    const diff = computeDiff(old, new_);
    const result = applyDiff(old, diff);
    expect(result).toBe(new_);
  });

  test("相同内容 apply 后不变", () => {
    const text = "hello\nworld";
    const diff = computeDiff(text, text);
    expect(applyDiff(text, diff)).toBe(text);
  });

  test("完全替换", () => {
    const old = "aaa\nbbb";
    const new_ = "ccc\nddd";
    const diff = computeDiff(old, new_);
    expect(applyDiff(old, diff)).toBe(new_);
  });

  test("多行新增", () => {
    const old = "start\nend";
    const new_ = "start\na\nb\nc\nend";
    const diff = computeDiff(old, new_);
    expect(applyDiff(old, diff)).toBe(new_);
  });
});

describe("reverseDiff", () => {
  test("反向 apply 还原出 oldText", () => {
    const old = "line1\nline2\nline3";
    const new_ = "line1\nmodified\nline3\nline4";
    const diff = computeDiff(old, new_);
    const result = reverseDiff(new_, diff);
    expect(result).toBe(old);
  });

  test("相同内容反向不变", () => {
    const text = "hello\nworld";
    const diff = computeDiff(text, text);
    expect(reverseDiff(text, diff)).toBe(text);
  });
});
