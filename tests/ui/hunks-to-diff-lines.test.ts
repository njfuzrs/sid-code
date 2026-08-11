/**
 * hunksToDiffLines 单测
 *
 * 验证「结构化 hunks → DiffLine[]」适配函数:
 * - 每个 hunk 产出一个 'hunk' 行 + 按前缀映射的 add/del/context/other 行
 * - 行号从 hunk.oldStart/newStart 起正确递增
 * - 与「文本路径」(buildStructuredPatch 同口径)对齐,保证两条渲染路径视觉一致
 */

import { test, expect, describe } from "bun:test";
import { hunksToDiffLines } from "@sid-code/cli/ui/components/DiffRenderer.tsx";
import { buildStructuredPatch } from "@sid-code/core/tool/diff-output.ts";

describe("hunksToDiffLines", () => {
  test("修改场景:hunk 行 + add/del/context 类型与行号正确", () => {
    const hunks = buildStructuredPatch(
      "/tmp/foo.ts",
      "a\nb\nc\n",
      "a\nB\nc\n",
    );
    const lines = hunksToDiffLines(hunks);

    // 首行为 hunk 头
    expect(lines[0].type).toBe("hunk");
    expect(lines[0].content).toMatch(/^@@ -\d+,\d+ \+\d+,\d+ @@/);

    const del = lines.find((l) => l.type === "del");
    const add = lines.find((l) => l.type === "add");
    expect(del?.content).toBe("b");
    expect(add?.content).toBe("B");
    // 删除行有 oldLine、新增行有 newLine
    expect(del?.oldLine).toBe(2);
    expect(add?.newLine).toBe(2);

    // context 行同时有 oldLine 和 newLine
    const ctxLines = lines.filter((l) => l.type === "context");
    expect(ctxLines.length).toBeGreaterThan(0);
    for (const c of ctxLines) {
      expect(typeof c.oldLine).toBe("number");
      expect(typeof c.newLine).toBe("number");
    }
  });

  test("新建文件:全部为 add 行(除 hunk),可被 isNewFile 判定", () => {
    const hunks = buildStructuredPatch("/tmp/new.ts", "", "x\ny\nz\n");
    const lines = hunksToDiffLines(hunks);
    // 除 hunk/other 外全是 add
    const nonAdd = lines.filter(
      (l) => l.type !== "add" && l.type !== "hunk" && l.type !== "other",
    );
    expect(nonAdd.length).toBe(0);
    // newLine 从 1 递增
    const adds = lines.filter((l) => l.type === "add");
    expect(adds[0].newLine).toBe(1);
    expect(adds[1].newLine).toBe(2);
  });

  test("空 hunks → 空 DiffLine[]", () => {
    expect(hunksToDiffLines([])).toEqual([]);
  });

  test("多 hunk:各自带独立 hunk 头", () => {
    // 构造首尾各一处改动、中间大段不变 → 两个 hunk
    const oldText = ["a", ...Array.from({ length: 20 }, (_, i) => `line${i}`), "z"].join("\n") + "\n";
    const newText = ["A", ...Array.from({ length: 20 }, (_, i) => `line${i}`), "Z"].join("\n") + "\n";
    const hunks = buildStructuredPatch("/tmp/m.ts", oldText, newText);
    expect(hunks.length).toBe(2);
    const lines = hunksToDiffLines(hunks);
    const hunkHeaders = lines.filter((l) => l.type === "hunk");
    expect(hunkHeaders.length).toBe(2);
  });
});
