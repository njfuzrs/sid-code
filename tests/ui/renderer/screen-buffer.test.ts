/**
 * ScreenBuffer 单元测试
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { ScreenBuffer } from "../../../src/ui/renderer/screen-buffer.ts";
import { COLOR_DEFAULT, MOD_BOLD, MOD_DIM, MOD_ITALIC, FLAG_OVERFLOW } from "../../../src/ui/renderer/constants.ts";

describe("ScreenBuffer", () => {
  let buf: ScreenBuffer;

  beforeEach(() => {
    buf = new ScreenBuffer(10, 5);
  });

  describe("constructor + clear", () => {
    it("初始化为空格 + 默认色 + width=1", () => {
      expect(buf.getSymbol(0, 0)).toBe(" ");
      expect(buf.getFg(0, 0)).toBe(COLOR_DEFAULT);
      expect(buf.getBg(0, 0)).toBe(COLOR_DEFAULT);
      expect(buf.getMods(0, 0)).toBe(0);
      expect(buf.getCellWidth(0, 0)).toBe(1);
    });

    it("所有 cell 都是空格", () => {
      for (let y = 0; y < 5; y++) {
        for (let x = 0; x < 10; x++) {
          expect(buf.getSymbol(x, y)).toBe(" ");
        }
      }
    });
  });

  describe("setCell + getters", () => {
    it("设置并读取 ASCII 字符", () => {
      buf.setCell(3, 2, "A", 0xff0000, 0x00ff00, MOD_BOLD, 1);
      expect(buf.getSymbol(3, 2)).toBe("A");
      expect(buf.getFg(3, 2)).toBe(0xff0000);
      expect(buf.getBg(3, 2)).toBe(0x00ff00);
      expect(buf.getMods(3, 2)).toBe(MOD_BOLD);
      expect(buf.getCellWidth(3, 2)).toBe(1);
    });

    it("设置多个 modifier flags", () => {
      buf.setCell(0, 0, "X", 0, 0, MOD_BOLD | MOD_ITALIC | MOD_DIM);
      expect(buf.getMods(0, 0)).toBe(MOD_BOLD | MOD_ITALIC | MOD_DIM);
    });

    it("越界写入被忽略", () => {
      buf.setCell(-1, 0, "X");
      buf.setCell(10, 0, "X");
      buf.setCell(0, -1, "X");
      buf.setCell(0, 5, "X");
      // 不应抛出异常，且 buffer 内容不变
      expect(buf.getSymbol(0, 0)).toBe(" ");
    });

    it("空字符串写入为空格", () => {
      buf.setCell(0, 0, "");
      expect(buf.getSymbol(0, 0)).toBe(" ");
    });
  });

  describe("溢出字符（emoji/ZWJ）", () => {
    it("emoji 存入 overflow map", () => {
      buf.setCell(0, 0, "😀", 0, 0, 0, 2);
      expect(buf.getSymbol(0, 0)).toBe("😀");
      expect(buf.getCellWidth(0, 0)).toBe(2);
    });

    it("ZWJ 序列存入 overflow map", () => {
      const zjw = "👨‍👩‍👧‍👦";
      buf.setCell(0, 0, zjw, 0, 0, 0, 2);
      expect(buf.getSymbol(0, 0)).toBe(zjw);
    });
  });

  describe("宽字符续接", () => {
    it("宽字符自动标记续接 cell", () => {
      buf.setCell(2, 0, "中", 0xff0000, 0, 0, 2);
      expect(buf.getSymbol(2, 0)).toBe("中");
      expect(buf.getCellWidth(2, 0)).toBe(2);
      // 续接 cell
      expect(buf.getSymbol(3, 0)).toBe(""); // char=0 → 空字符串
      expect(buf.getCellWidth(3, 0)).toBe(0);
    });

    it("宽字符在右边界不溢出", () => {
      // width=10, 在 x=9 写入宽字符，x+1=10 越界
      buf.setCell(9, 0, "中", 0, 0, 0, 2);
      expect(buf.getSymbol(9, 0)).toBe("中");
      // x=10 越界，不应写入续接
    });
  });

  describe("cellEquals", () => {
    it("相同内容返回 true", () => {
      const other = new ScreenBuffer(10, 5);
      expect(buf.cellEquals(other, 0, 0)).toBe(true);
    });

    it("不同字符返回 false", () => {
      const other = new ScreenBuffer(10, 5);
      other.setCell(0, 0, "X");
      expect(buf.cellEquals(other, 0, 0)).toBe(false);
    });

    it("不同颜色返回 false", () => {
      const other = new ScreenBuffer(10, 5);
      other.setCell(0, 0, " ", 0xff0000);
      expect(buf.cellEquals(other, 0, 0)).toBe(false);
    });

    it("不同 mods 返回 false", () => {
      const other = new ScreenBuffer(10, 5);
      other.setCell(0, 0, " ", 0, 0, MOD_BOLD);
      expect(buf.cellEquals(other, 0, 0)).toBe(false);
    });
  });

  describe("fillRect", () => {
    it("填充矩形区域", () => {
      buf.fillRect(1, 1, 3, 2, "#", 0xff0000, 0x00ff00, MOD_BOLD);
      for (let y = 1; y <= 2; y++) {
        for (let x = 1; x <= 3; x++) {
          expect(buf.getSymbol(x, y)).toBe("#");
          expect(buf.getFg(x, y)).toBe(0xff0000);
          expect(buf.getBg(x, y)).toBe(0x00ff00);
          expect(buf.getMods(x, y)).toBe(MOD_BOLD);
        }
      }
      // 区域外不受影响
      expect(buf.getSymbol(0, 0)).toBe(" ");
      expect(buf.getSymbol(4, 1)).toBe(" ");
    });

    it("超出边界的 fillRect 被裁剪", () => {
      buf.fillRect(-1, -1, 3, 3, "X");
      expect(buf.getSymbol(0, 0)).toBe("X");
      expect(buf.getSymbol(1, 1)).toBe("X");
      expect(buf.getSymbol(2, 2)).toBe(" "); // 超出 3x3 范围
    });

    it("完全越界的 fillRect 无效果", () => {
      buf.fillRect(20, 20, 5, 5, "X");
      expect(buf.getSymbol(0, 0)).toBe(" ");
    });
  });

  describe("copyFrom", () => {
    it("完整复制 buffer 内容", () => {
      buf.setCell(0, 0, "A", 0xff0000, 0x00ff00, MOD_BOLD);
      buf.setCell(5, 3, "😀", 0, 0, 0, 2);

      const copy = new ScreenBuffer(10, 5);
      copy.copyFrom(buf);

      expect(copy.getSymbol(0, 0)).toBe("A");
      expect(copy.getFg(0, 0)).toBe(0xff0000);
      expect(copy.getBg(0, 0)).toBe(0x00ff00);
      expect(copy.getMods(0, 0)).toBe(MOD_BOLD);
      expect(copy.getSymbol(5, 3)).toBe("😀");
    });

    it("不同尺寸的 copyFrom 自动调整", () => {
      const small = new ScreenBuffer(3, 3);
      small.setCell(0, 0, "X");

      const big = new ScreenBuffer(10, 10);
      big.copyFrom(small);

      expect(big.width).toBe(3);
      expect(big.height).toBe(3);
      expect(big.getSymbol(0, 0)).toBe("X");
    });

    it("overflow map 也被复制", () => {
      buf.setCell(0, 0, "😀", 0, 0, 0, 2);
      const copy = new ScreenBuffer(10, 5);
      copy.copyFrom(buf);
      expect(copy.getSymbol(0, 0)).toBe("😀");
    });
  });

  describe("resize", () => {
    it("resize 后内容清空", () => {
      buf.setCell(0, 0, "X");
      buf.resize(20, 10);
      expect(buf.width).toBe(20);
      expect(buf.height).toBe(10);
      expect(buf.getSymbol(0, 0)).toBe(" ");
    });

    it("resize 后 overflow map 清空", () => {
      buf.setCell(0, 0, "😀", 0, 0, 0, 2);
      buf.resize(5, 5);
      expect(buf.overflow.size).toBe(0);
    });
  });
});
