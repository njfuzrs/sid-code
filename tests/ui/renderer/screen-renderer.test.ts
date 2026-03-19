/**
 * ScreenRenderer 单元测试
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { ScreenRenderer } from "../../../src/ui/renderer/screen-renderer.ts";
import { COLOR_DEFAULT, MOD_BOLD } from "../../../src/ui/renderer/constants.ts";

/** 模拟 stdout */
function createMockStdout() {
  const chunks: string[] = [];
  return {
    chunks,
    write(data: string) {
      chunks.push(data);
      return true;
    },
    getOutput() {
      return chunks.join("");
    },
    clear() {
      chunks.length = 0;
    },
    // shouldSynchronize 需要的属性
    isTTY: false,
    _handle: null,
  } as unknown as NodeJS.WriteStream & {
    chunks: string[];
    getOutput: () => string;
    clear: () => void;
  };
}

/** ANSI 常量 */
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const RESET_STYLE = "\x1b[0m";
const EL = "\x1b[2K";
const CUU = (n: number) => `\x1b[${n}A`;

describe("ScreenRenderer", () => {
  let stdout: ReturnType<typeof createMockStdout>;
  let renderer: ScreenRenderer;

  beforeEach(() => {
    stdout = createMockStdout();
    renderer = new ScreenRenderer(stdout, 10, 3);
  });

  describe("flush() 基本功能", () => {
    it("空 buffer flush 输出 HIDE_CURSOR 但不输出 SHOW_CURSOR（终端光标始终隐藏）", () => {
      const back = renderer.getBackBuffer();
      back.clear();
      renderer.flush();
      const output = stdout.getOutput();
      expect(output).toContain(HIDE_CURSOR);
      expect(output).not.toContain(SHOW_CURSOR);
      expect(output).toContain(RESET_STYLE);
    });

    it("首次 flush 输出所有非空 cell", () => {
      const back = renderer.getBackBuffer();
      back.clear();
      back.setCell(0, 0, "H");
      back.setCell(1, 0, "i");
      renderer.flush();
      const output = stdout.getOutput();
      expect(output).toContain("H");
      expect(output).toContain("i");
    });

    it("相同内容第二次 flush 不输出字符", () => {
      const back = renderer.getBackBuffer();
      back.clear();
      back.setCell(0, 0, "X");
      renderer.flush();
      stdout.clear();

      // 第二次 flush 相同内容
      const back2 = renderer.getBackBuffer();
      back2.clear();
      back2.setCell(0, 0, "X");
      renderer.flush();
      const output = stdout.getOutput();
      // 应该只有光标控制序列，没有字符 "X"
      expect(output).not.toContain("X");
    });

    it("变化的 cell 被输出", () => {
      const back = renderer.getBackBuffer();
      back.clear();
      back.setCell(0, 0, "A");
      renderer.flush();
      stdout.clear();

      const back2 = renderer.getBackBuffer();
      back2.clear();
      back2.setCell(0, 0, "B");
      renderer.flush();
      const output = stdout.getOutput();
      expect(output).toContain("B");
    });
  });

  describe("flush() 样式输出", () => {
    it("输出前景色 SGR 序列", () => {
      const back = renderer.getBackBuffer();
      back.clear();
      back.setCell(0, 0, "R", 0xff0000);
      renderer.flush();
      const output = stdout.getOutput();
      // 24 位前景色: \x1b[38;2;255;0;0m
      expect(output).toContain("38;2;255;0;0");
      expect(output).toContain("R");
    });

    it("输出背景色 SGR 序列", () => {
      const back = renderer.getBackBuffer();
      back.clear();
      back.setCell(0, 0, " ", COLOR_DEFAULT, 0x00ff00);
      renderer.flush();
      const output = stdout.getOutput();
      // 24 位背景色: \x1b[48;2;0;255;0m
      expect(output).toContain("48;2;0;255;0");
    });

    it("输出 modifier SGR 序列", () => {
      const back = renderer.getBackBuffer();
      back.clear();
      back.setCell(0, 0, "B", COLOR_DEFAULT, COLOR_DEFAULT, MOD_BOLD);
      renderer.flush();
      const output = stdout.getOutput();
      // bold: \x1b[1m
      expect(output).toMatch(/\x1b\[\d*;?1m/);
      expect(output).toContain("B");
    });
  });

  describe("flush() 行数变化", () => {
    it("行数增加", () => {
      // 首次 3 行
      const back = renderer.getBackBuffer();
      back.clear();
      back.setCell(0, 0, "A");
      renderer.flush();
      stdout.clear();

      // 增加到 5 行
      back.resize(10, 5);
      back.clear();
      back.setCell(0, 0, "A");
      back.setCell(0, 4, "E");
      renderer.flush();
      const output = stdout.getOutput();
      expect(output).toContain("E");
    });

    it("行数减少时清除多余行", () => {
      // 首次 5 行
      const back = renderer.getBackBuffer();
      back.resize(10, 5);
      back.clear();
      back.setCell(0, 0, "A");
      back.setCell(0, 4, "E");
      renderer.flush();
      stdout.clear();

      // 减少到 2 行
      back.resize(10, 2);
      back.clear();
      back.setCell(0, 0, "X");
      renderer.flush();
      const output = stdout.getOutput();
      expect(output).toContain(EL); // 清除多余行
      expect(output).toContain("X");
    });
  });

  describe("clearLive()", () => {
    it("清除 Live 区域", () => {
      const back = renderer.getBackBuffer();
      back.clear();
      back.setCell(0, 0, "A");
      back.setCell(0, 1, "B");
      back.setCell(0, 2, "C");
      renderer.flush();
      stdout.clear();

      renderer.clearLive();
      const output = stdout.getOutput();
      expect(output).toContain(EL);
      expect(renderer.getLiveHeight()).toBe(0);
    });

    it("空状态 clearLive 不产生输出", () => {
      renderer.clearLive();
      expect(stdout.getOutput()).toBe("");
    });
  });

  describe("resize()", () => {
    it("resize 后 liveHeight 重置", () => {
      const back = renderer.getBackBuffer();
      back.clear();
      back.setCell(0, 0, "X");
      renderer.flush();
      expect(renderer.getLiveHeight()).toBe(3);

      renderer.resize(20, 5);
      expect(renderer.getLiveHeight()).toBe(0);
    });
  });

  describe("reset()", () => {
    it("reset 后状态清空", () => {
      const back = renderer.getBackBuffer();
      back.clear();
      back.setCell(0, 0, "X");
      renderer.flush();

      renderer.reset();
      expect(renderer.getLiveHeight()).toBe(0);
    });
  });

  describe("syncLiveHeight()", () => {
    it("同步 Live 区域高度", () => {
      renderer.syncLiveHeight(5);
      expect(renderer.getLiveHeight()).toBe(5);
    });
  });
});
