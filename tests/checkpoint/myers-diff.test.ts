/**
 * 大文件 diff 算法测试
 */

import { describe, test, expect } from "bun:test";
import { computeDiff, applyDiff } from "../../src/checkpoint/diff.ts";

describe("大文件 diff", () => {
  test("小文件（<1000 行）使用 LCS", () => {
    const lines = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`);
    const oldText = lines.join("\n");

    const newLines = [...lines];
    newLines[250] = "modified line 251";
    const newText = newLines.join("\n");

    const diff = computeDiff(oldText, newText);
    expect(diff.ops.length).toBeGreaterThan(0);

    const result = applyDiff(oldText, diff);
    expect(result).toBe(newText);
  });

  test("超大文件（>10000 行）返回空 ops", () => {
    // 生成 12000 行文件
    const lines = Array.from({ length: 12000 }, (_, i) => `line ${i + 1}`);
    const oldText = lines.join("\n");
    const newText = oldText + "\nnew line";

    const diff = computeDiff(oldText, newText);

    // 超大文件应该返回空 ops（调用方会直接存 full）
    expect(diff.ops).toHaveLength(0);
  });

  test("边界情况：恰好 1000 行（使用 LCS）", () => {
    const lines = Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`);
    const oldText = lines.join("\n");

    const newLines = [...lines];
    newLines[500] = "modified";
    const newText = newLines.join("\n");

    const diff = computeDiff(oldText, newText);
    const result = applyDiff(oldText, diff);

    expect(result).toBe(newText);
  });

  test("边界情况：恰好 10000 行（返回空 ops）", () => {
    const lines = Array.from({ length: 10000 }, (_, i) => `line ${i + 1}`);
    const oldText = lines.join("\n");

    const newLines = [...lines];
    newLines[5000] = "modified";
    const newText = newLines.join("\n");

    const diff = computeDiff(oldText, newText);

    // 10000 行应该返回空 ops
    expect(diff.ops).toHaveLength(0);
  });

  test("LCS 性能测试（小文件）", () => {
    // 生成 800 行文件，修改 10%
    const lines = Array.from({ length: 800 }, (_, i) => `line ${i + 1}`);
    const oldText = lines.join("\n");

    const newLines = [...lines];
    for (let i = 0; i < 80; i++) {
      newLines[i * 10] = `modified line ${i * 10 + 1}`;
    }
    const newText = newLines.join("\n");

    const start = Date.now();
    const diff = computeDiff(oldText, newText);
    const elapsed = Date.now() - start;

    // LCS 应该在 100ms 内完成
    expect(elapsed).toBeLessThan(100);

    // 验证正确性
    const result = applyDiff(oldText, diff);
    expect(result).toBe(newText);
  });

  test("相同内容优化", () => {
    const lines = Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`);
    const text = lines.join("\n");

    const start = Date.now();
    const diff = computeDiff(text, text);
    const elapsed = Date.now() - start;

    // 相同内容应该立即返回
    expect(elapsed).toBeLessThan(10);
    expect(diff.ops).toHaveLength(1);
    expect(diff.ops[0].type).toBe("keep");
  });
});
