/**
 * DF1 词级 diff 配对逻辑单测
 *
 * 验证 computeWordDiffPairs：连续 del 块与紧随 add 块按行序一一配对，
 * 多出的行不配对（回退整行高亮）。
 */

import { test, expect, describe } from "bun:test";
import { computeWordDiffPairs } from "../../src/ui/components/DiffRenderer.tsx";

describe("computeWordDiffPairs 词级 diff 配对", () => {
  test("1 del + 1 add 配对成功，互相指向对侧内容", () => {
    const lines = [
      { type: "del" as const, content: "const a = 1;" },
      { type: "add" as const, content: "const a = 2;" },
    ];
    const map = computeWordDiffPairs(lines);
    expect(map.get(0)).toBe("const a = 2;");
    expect(map.get(1)).toBe("const a = 1;");
    expect(map.size).toBe(2);
  });

  test("纯新增（无 del）不配对", () => {
    const lines = [
      { type: "context" as const, content: "x" },
      { type: "add" as const, content: "new line" },
    ];
    const map = computeWordDiffPairs(lines);
    expect(map.size).toBe(0);
  });

  test("纯删除（无 add）不配对", () => {
    const lines = [
      { type: "del" as const, content: "gone" },
      { type: "context" as const, content: "x" },
    ];
    const map = computeWordDiffPairs(lines);
    expect(map.size).toBe(0);
  });

  test("2 del + 2 add 全部配对", () => {
    const lines = [
      { type: "del" as const, content: "a-old" },
      { type: "del" as const, content: "b-old" },
      { type: "add" as const, content: "a-new" },
      { type: "add" as const, content: "b-new" },
    ];
    const map = computeWordDiffPairs(lines);
    expect(map.get(0)).toBe("a-new");
    expect(map.get(1)).toBe("b-new");
    expect(map.get(2)).toBe("a-old");
    expect(map.get(3)).toBe("b-old");
  });

  test("3 del + 1 add：仅首行配对，多出的 2 个 del 不配对", () => {
    const lines = [
      { type: "del" as const, content: "d0" },
      { type: "del" as const, content: "d1" },
      { type: "del" as const, content: "d2" },
      { type: "add" as const, content: "a0" },
    ];
    const map = computeWordDiffPairs(lines);
    expect(map.get(0)).toBe("a0");
    expect(map.get(3)).toBe("d0");
    expect(map.has(1)).toBe(false);
    expect(map.has(2)).toBe(false);
    expect(map.size).toBe(2);
  });

  test("1 del + 3 add：仅首行配对，多出的 2 个 add 不配对", () => {
    const lines = [
      { type: "del" as const, content: "d0" },
      { type: "add" as const, content: "a0" },
      { type: "add" as const, content: "a1" },
      { type: "add" as const, content: "a2" },
    ];
    const map = computeWordDiffPairs(lines);
    expect(map.get(0)).toBe("a0");
    expect(map.get(1)).toBe("d0");
    expect(map.has(2)).toBe(false);
    expect(map.has(3)).toBe(false);
  });

  test("两组独立的 del/add 块各自配对", () => {
    const lines = [
      { type: "del" as const, content: "g1-old" },
      { type: "add" as const, content: "g1-new" },
      { type: "context" as const, content: "ctx" },
      { type: "del" as const, content: "g2-old" },
      { type: "add" as const, content: "g2-new" },
    ];
    const map = computeWordDiffPairs(lines);
    expect(map.get(0)).toBe("g1-new");
    expect(map.get(1)).toBe("g1-old");
    expect(map.get(3)).toBe("g2-new");
    expect(map.get(4)).toBe("g2-old");
  });
});
