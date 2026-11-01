/**
 * getCursorVisualPosition 复用调用方已算好的视觉行（长会话按键延迟 PR5）。
 * 锁：传入 visualLines 与不传结果逐项相同（含折行、宽字符、行尾光标、越界回退）。
 */
import { describe, expect, test } from "bun:test";
import { getCursorVisualPosition, getVisualLines } from "@sid-code/cli/ui/text-buffer.ts";

const cases: Array<{ lines: string[]; row: number; col: number; width: number }> = [
  { lines: ["abcdefghij"], row: 0, col: 7, width: 4 },
  { lines: ["abcdefgh"], row: 0, col: 8, width: 4 },
  { lines: ["中文宽字符测试"], row: 0, col: 3, width: 5 },
  { lines: ["first", "", "third line here"], row: 2, col: 10, width: 6 },
  { lines: ["x"], row: 5, col: 0, width: 10 },
  { lines: ["abc"], row: 0, col: 2, width: 0 },
];

describe("getCursorVisualPosition 复用视觉行", () => {
  for (const c of cases) {
    test(`${JSON.stringify(c.lines)} @${c.row}:${c.col} w=${c.width}`, () => {
      const visual = getVisualLines(c.lines, c.width);
      expect(getCursorVisualPosition(c.lines, c.row, c.col, c.width, visual)).toEqual(
        getCursorVisualPosition(c.lines, c.row, c.col, c.width),
      );
    });
  }

  test("传入的视觉行确实被使用（不再折一次行）", () => {
    const fake = [{ logicalRow: 0, start: 0, end: 99, text: "" }];
    expect(getCursorVisualPosition(["abcdefgh"], 0, 6, 2, fake)).toEqual({
      visualRow: 0,
      visualCol: 6,
    });
  });
});
