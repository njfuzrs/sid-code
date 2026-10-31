/**
 * 横向裁剪快路径（长会话按键延迟）。
 *
 * 工具标题行包在 `overflow="hidden" height={1}` 里，每行都处在横向 clip 中但一列都不裁。
 * getScreen 对这类行跳过 sliceColumns 原样写入；这里锁两件事：
 * 1. 不裁时，有 clip 与没有 clip 落出的屏幕逐字节相同（快路径不改字节，含 ANSI 样式）；
 * 2. 真要裁时（左裁 / 右裁）照旧裁——快路径条件写宽了这里会红。
 */
import { describe, expect, test } from "bun:test";
import Output from "../src/output.ts";
import { serializeRow } from "../src/screen/index.ts";

const STYLED =
  "\x1b[38;2;120;200;80m\x1b[1m● read\x1b[22m\x1b[39m packages/tui/src/output.ts \x1b[2m(42 行)\x1b[22m";

function rows(out: Output): string[] {
  const screen = out.getScreen();
  return Array.from({ length: screen.height }, (_, y) => serializeRow(screen, y));
}

function render(text: string, x: number, clip?: { x1: number; x2: number }, width = 120): string[] {
  const out = new Output({ width, height: 1 });
  if (clip) out.clip({ x1: clip.x1, x2: clip.x2, y1: undefined, y2: undefined });
  out.write(x, 0, text, { transformers: [] });
  if (clip) out.unclip();
  return rows(out);
}

describe("Output.getScreen 横向裁剪", () => {
  test("clip 不裁任何列时，与无 clip 逐字节相同（带 ANSI 样式）", () => {
    expect(render(STYLED, 2, { x1: 2, x2: 116 })).toEqual(render(STYLED, 2));
  });

  test("右边界压进文本时照旧裁掉右侧", () => {
    const [row] = render("abcdefghij", 0, { x1: 0, x2: 5 }, 20);
    expect(row).toContain("abcde");
    expect(row).not.toContain("f");
  });

  test("左边界压进文本时照旧裁掉左侧并移到裁剪框左边界", () => {
    const [row] = render("abcdefghij", 0, { x1: 3, x2: 20 }, 20);
    expect(row).toContain("defghij");
    expect(row).not.toContain("abc");
  });
});
