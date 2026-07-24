/**
 * §12 P1-3：mergeInstructions 单测
 */

import { describe, test, expect } from "bun:test";
import { mergeInstructions } from "../../../src/query/compact/merge-instructions.ts";

describe("mergeInstructions", () => {
  test("全空返回 undefined", () => {
    expect(mergeInstructions()).toBeUndefined();
    expect(mergeInstructions(undefined, null, "", "   ")).toBeUndefined();
  });

  test("单段原样返回（trim）", () => {
    expect(mergeInstructions("  保留 schema  ")).toBe("保留 schema");
  });

  test("多段用双换行拼接，过滤空段", () => {
    expect(mergeInstructions("focus auth", undefined, "保留 schema", "")).toBe(
      "focus auth\n\n保留 schema",
    );
  });

  test("顺序保持（focus 在前，hook 在后）", () => {
    const merged = mergeInstructions("A", "B");
    expect(merged).toBe("A\n\nB");
  });
});
