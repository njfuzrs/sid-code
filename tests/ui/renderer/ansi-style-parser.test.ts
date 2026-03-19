/**
 * ansi-style-parser 单元测试
 */

import { describe, it, expect } from "bun:test";
import {
  resolveInkColor,
  parseCellStyle,
  writeStyledChars,
  writeAnsiText,
} from "../../../src/ui/renderer/ansi-style-parser.ts";
import { ScreenBuffer } from "../../../src/ui/renderer/screen-buffer.ts";
import {
  COLOR_DEFAULT,
  MOD_BOLD,
  MOD_DIM,
  MOD_ITALIC,
  MOD_UNDERLINE,
  MOD_BLINK,
  MOD_REVERSE,
  MOD_HIDDEN,
  MOD_STRIKETHROUGH,
} from "../../../src/ui/renderer/constants.ts";

describe("resolveInkColor", () => {
  it("undefined 返回 COLOR_DEFAULT", () => {
    expect(resolveInkColor(undefined)).toBe(COLOR_DEFAULT);
  });

  it("hex 颜色 #RRGGBB", () => {
    expect(resolveInkColor("#ff0000")).toBe(0xff0000);
    expect(resolveInkColor("#00ff00")).toBe(0x00ff00);
    expect(resolveInkColor("#0000ff")).toBe(0x0000ff);
  });

  it("hex 颜色 #RGB", () => {
    expect(resolveInkColor("#f00")).toBe(0xff0000);
    expect(resolveInkColor("#0f0")).toBe(0x00ff00);
    expect(resolveInkColor("#00f")).toBe(0x0000ff);
  });

  it("rgb(r, g, b)", () => {
    expect(resolveInkColor("rgb(255, 0, 0)")).toBe(0xff0000);
    expect(resolveInkColor("rgb(0, 255, 0)")).toBe(0x00ff00);
    expect(resolveInkColor("rgb(0, 0, 255)")).toBe(0x0000ff);
  });

  it("ansi256(n)", () => {
    expect(resolveInkColor("ansi256(0)")).toBe(0x000000); // 黑
    expect(resolveInkColor("ansi256(1)")).toBe(0xaa0000); // 红
    expect(resolveInkColor("ansi256(9)")).toBe(0xff5555); // 亮红
  });

  it("命名颜色", () => {
    expect(resolveInkColor("black")).toBe(0x000000);
    expect(resolveInkColor("red")).toBe(0xaa0000);
    expect(resolveInkColor("green")).toBe(0x00aa00);
    expect(resolveInkColor("yellow")).toBe(0xaa5500);
    expect(resolveInkColor("blue")).toBe(0x0000aa);
    expect(resolveInkColor("magenta")).toBe(0xaa00aa);
    expect(resolveInkColor("cyan")).toBe(0x00aaaa);
    expect(resolveInkColor("white")).toBe(0xaaaaaa);
    expect(resolveInkColor("gray")).toBe(0x555555);
    expect(resolveInkColor("redBright")).toBe(0xff5555);
  });

  it("未知颜色返回 COLOR_DEFAULT", () => {
    expect(resolveInkColor("unknown")).toBe(COLOR_DEFAULT);
    expect(resolveInkColor("invalid")).toBe(COLOR_DEFAULT);
  });
});

/** 辅助函数：构造 StyledChar.styles 格式 */
function ansiStyle(code: string, endCode: string = "\x1b[0m") {
  return { type: "ansi", code, endCode };
}

describe("parseCellStyle", () => {
  it("空数组返回默认值", () => {
    const { fg, bg, mods } = parseCellStyle([]);
    expect(fg).toBe(COLOR_DEFAULT);
    expect(bg).toBe(COLOR_DEFAULT);
    expect(mods).toBe(0);
  });

  it("SGR 0 重置所有", () => {
    const { fg, bg, mods } = parseCellStyle([
      ansiStyle("\x1b[1;31;42m"),
      ansiStyle("\x1b[0m"),
    ]);
    expect(fg).toBe(COLOR_DEFAULT);
    expect(bg).toBe(COLOR_DEFAULT);
    expect(mods).toBe(0);
  });

  it("modifier flags: 1-9", () => {
    expect(parseCellStyle([ansiStyle("\x1b[1m")]).mods).toBe(MOD_BOLD);
    expect(parseCellStyle([ansiStyle("\x1b[2m")]).mods).toBe(MOD_DIM);
    expect(parseCellStyle([ansiStyle("\x1b[3m")]).mods).toBe(MOD_ITALIC);
    expect(parseCellStyle([ansiStyle("\x1b[4m")]).mods).toBe(MOD_UNDERLINE);
    expect(parseCellStyle([ansiStyle("\x1b[5m")]).mods).toBe(MOD_BLINK);
    expect(parseCellStyle([ansiStyle("\x1b[7m")]).mods).toBe(MOD_REVERSE);
    expect(parseCellStyle([ansiStyle("\x1b[8m")]).mods).toBe(MOD_HIDDEN);
    expect(parseCellStyle([ansiStyle("\x1b[9m")]).mods).toBe(MOD_STRIKETHROUGH);
  });

  it("组合 modifier flags", () => {
    const { mods } = parseCellStyle([
      ansiStyle("\x1b[1m"),
      ansiStyle("\x1b[3m"),
      ansiStyle("\x1b[4m"),
    ]);
    expect(mods).toBe(MOD_BOLD | MOD_ITALIC | MOD_UNDERLINE);
  });

  it("取消 modifier flags: 22-29", () => {
    let result = parseCellStyle([ansiStyle("\x1b[1;2;22m")]);
    expect(result.mods).toBe(0); // 22 取消 bold + dim

    result = parseCellStyle([ansiStyle("\x1b[3;23m")]);
    expect(result.mods).toBe(0); // 23 取消 italic

    result = parseCellStyle([ansiStyle("\x1b[4;24m")]);
    expect(result.mods).toBe(0); // 24 取消 underline
  });

  it("基本前景色: 30-37", () => {
    expect(parseCellStyle([ansiStyle("\x1b[30m")]).fg).toBe(0x000000);
    expect(parseCellStyle([ansiStyle("\x1b[31m")]).fg).toBe(0xaa0000);
    expect(parseCellStyle([ansiStyle("\x1b[32m")]).fg).toBe(0x00aa00);
    expect(parseCellStyle([ansiStyle("\x1b[33m")]).fg).toBe(0xaa5500);
    expect(parseCellStyle([ansiStyle("\x1b[34m")]).fg).toBe(0x0000aa);
    expect(parseCellStyle([ansiStyle("\x1b[35m")]).fg).toBe(0xaa00aa);
    expect(parseCellStyle([ansiStyle("\x1b[36m")]).fg).toBe(0x00aaaa);
    expect(parseCellStyle([ansiStyle("\x1b[37m")]).fg).toBe(0xaaaaaa);
  });

  it("亮前景色: 90-97", () => {
    expect(parseCellStyle([ansiStyle("\x1b[90m")]).fg).toBe(0x555555);
    expect(parseCellStyle([ansiStyle("\x1b[91m")]).fg).toBe(0xff5555);
    expect(parseCellStyle([ansiStyle("\x1b[92m")]).fg).toBe(0x55ff55);
  });

  it("基本背景色: 40-47", () => {
    expect(parseCellStyle([ansiStyle("\x1b[40m")]).bg).toBe(0x000000);
    expect(parseCellStyle([ansiStyle("\x1b[41m")]).bg).toBe(0xaa0000);
  });

  it("亮背景色: 100-107", () => {
    expect(parseCellStyle([ansiStyle("\x1b[100m")]).bg).toBe(0x555555);
    expect(parseCellStyle([ansiStyle("\x1b[101m")]).bg).toBe(0xff5555);
  });

  it("前景色默认: 39", () => {
    const { fg } = parseCellStyle([ansiStyle("\x1b[31m"), ansiStyle("\x1b[39m")]);
    expect(fg).toBe(COLOR_DEFAULT);
  });

  it("背景色默认: 49", () => {
    const { bg } = parseCellStyle([ansiStyle("\x1b[41m"), ansiStyle("\x1b[49m")]);
    expect(bg).toBe(COLOR_DEFAULT);
  });

  it("256 色前景: 38;5;N", () => {
    const { fg } = parseCellStyle([ansiStyle("\x1b[38;5;196m")]);
    expect(fg).toBe(0xff0000);
  });

  it("256 色背景: 48;5;N", () => {
    const { bg } = parseCellStyle([ansiStyle("\x1b[48;5;196m")]);
    expect(bg).toBe(0xff0000);
  });

  it("24 位前景色: 38;2;R;G;B", () => {
    const { fg } = parseCellStyle([ansiStyle("\x1b[38;2;255;128;64m")]);
    expect(fg).toBe(0xff8040);
  });

  it("24 位背景色: 48;2;R;G;B", () => {
    const { bg } = parseCellStyle([ansiStyle("\x1b[48;2;64;128;255m")]);
    expect(bg).toBe(0x4080ff);
  });

  it("复杂组合", () => {
    const { fg, bg, mods } = parseCellStyle([
      ansiStyle("\x1b[1m"),
      ansiStyle("\x1b[3m"),
      ansiStyle("\x1b[38;2;255;0;0m"),
      ansiStyle("\x1b[48;5;232m"),
    ]);
    expect(mods).toBe(MOD_BOLD | MOD_ITALIC);
    expect(fg).toBe(0xff0000);
    expect(bg).toBe(0x080808);
  });
});

describe("writeStyledChars", () => {
  /** 构造 StyledChar */
  function sc(value: string, styles: Array<{ type: string; code: string; endCode: string }> = []) {
    return { type: "char" as const, value, fullWidth: false, styles };
  }

  it("写入简单文本", () => {
    const buf = new ScreenBuffer(10, 1);
    writeStyledChars(buf, 0, 0, [sc("H"), sc("i")]);
    expect(buf.getSymbol(0, 0)).toBe("H");
    expect(buf.getSymbol(1, 0)).toBe("i");
  });

  it("写入带样式的文本", () => {
    const buf = new ScreenBuffer(10, 1);
    writeStyledChars(buf, 0, 0, [
      sc("A", [ansiStyle("\x1b[1m"), ansiStyle("\x1b[31m")]),
    ]);
    expect(buf.getSymbol(0, 0)).toBe("A");
    expect(buf.getMods(0, 0)).toBe(MOD_BOLD);
    expect(buf.getFg(0, 0)).toBe(0xaa0000);
  });

  it("水平裁剪：x1", () => {
    const buf = new ScreenBuffer(10, 1);
    writeStyledChars(buf, 0, 0, [sc("A"), sc("B"), sc("C")], { x1: 1 });
    expect(buf.getSymbol(0, 0)).toBe(" "); // 被裁剪
    expect(buf.getSymbol(1, 0)).toBe("B");
    expect(buf.getSymbol(2, 0)).toBe("C");
  });

  it("水平裁剪：x2（exclusive 边界）", () => {
    const buf = new ScreenBuffer(10, 1);
    writeStyledChars(buf, 0, 0, [sc("A"), sc("B"), sc("C")], { x2: 2 });
    expect(buf.getSymbol(0, 0)).toBe("A");
    expect(buf.getSymbol(1, 0)).toBe("B");
    expect(buf.getSymbol(2, 0)).toBe(" "); // 被裁剪（x2=2 是 exclusive）
  });

  it("垂直裁剪：y1", () => {
    const buf = new ScreenBuffer(10, 3);
    writeStyledChars(buf, 0, 0, [sc("X")], { y1: 1 });
    expect(buf.getSymbol(0, 0)).toBe(" "); // 被裁剪
  });

  it("垂直裁剪：y2（exclusive 边界）", () => {
    const buf = new ScreenBuffer(10, 3);
    writeStyledChars(buf, 0, 2, [sc("X")], { y2: 2 });
    expect(buf.getSymbol(0, 2)).toBe(" "); // 被裁剪（y2=2 是 exclusive）
  });
});

describe("writeAnsiText", () => {
  it("写入纯文本", () => {
    const buf = new ScreenBuffer(10, 1);
    writeAnsiText(buf, 0, 0, "Hello");
    expect(buf.getSymbol(0, 0)).toBe("H");
    expect(buf.getSymbol(1, 0)).toBe("e");
    expect(buf.getSymbol(2, 0)).toBe("l");
    expect(buf.getSymbol(3, 0)).toBe("l");
    expect(buf.getSymbol(4, 0)).toBe("o");
  });

  it("写入带 ANSI 的文本", () => {
    const buf = new ScreenBuffer(10, 1);
    writeAnsiText(buf, 0, 0, "\x1b[1;31mRed\x1b[0m");
    expect(buf.getSymbol(0, 0)).toBe("R");
    expect(buf.getMods(0, 0)).toBe(MOD_BOLD);
    expect(buf.getFg(0, 0)).toBe(0xaa0000);
  });

  it("写入多段样式", () => {
    const buf = new ScreenBuffer(20, 1);
    writeAnsiText(buf, 0, 0, "\x1b[31mRed\x1b[0m \x1b[32mGreen\x1b[0m");
    expect(buf.getFg(0, 0)).toBe(0xaa0000); // R
    expect(buf.getFg(4, 0)).toBe(0x00aa00); // G
  });
});
