/**
 * DiffRenderer 单元测试
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { DiffRenderer } from "../../../src/ui/renderer/diff-renderer.ts";

/** ANSI 转义序列常量 */
const EL = "\x1b[2K";
const CUU = (n: number) => `\x1b[${n}A`;
const CUD = (n: number) => `\x1b[${n}B`;

/** 模拟 stdout，记录所有写入的数据 */
function createMockStdout() {
  const chunks: string[] = [];
  return {
    chunks,
    write(data: string) {
      chunks.push(data);
      return true;
    },
    /** 获取所有写入的拼接结果 */
    getOutput() {
      return chunks.join("");
    },
    /** 清空记录 */
    clear() {
      chunks.length = 0;
    },
  } as unknown as NodeJS.WriteStream & { chunks: string[]; getOutput: () => string; clear: () => void };
}

describe("DiffRenderer", () => {
  let stdout: ReturnType<typeof createMockStdout>;
  let renderer: DiffRenderer;

  beforeEach(() => {
    stdout = createMockStdout();
    renderer = new DiffRenderer(stdout);
  });

  describe("render()", () => {
    it("首次渲染：输出完整内容", () => {
      renderer.render("hello\nworld");
      expect(stdout.getOutput()).toBe("hello\nworld");
    });

    it("无变化：不产生输出", () => {
      renderer.render("hello\nworld");
      stdout.clear();

      renderer.render("hello\nworld");
      expect(stdout.getOutput()).toBe("");
    });

    it("单行变化：只更新变化行", () => {
      renderer.render("line1\nline2\nline3");
      stdout.clear();

      renderer.render("line1\nchanged\nline3");
      const output = stdout.getOutput();
      expect(output).toContain("changed");
      expect(output).not.toContain("line1");
    });

    it("多行变化：更新变化区间", () => {
      renderer.render("a\nb\nc\nd");
      stdout.clear();

      renderer.render("a\nB\nC\nd");
      const output = stdout.getOutput();
      expect(output).toContain("B");
      expect(output).toContain("C");
    });

    it("行数增加：正确追加新行", () => {
      renderer.render("line1\nline2");
      stdout.clear();

      renderer.render("line1\nline2\nline3");
      const output = stdout.getOutput();
      expect(output).toContain("line3");
    });

    it("行数减少：清除多余行", () => {
      renderer.render("line1\nline2\nline3");
      stdout.clear();

      renderer.render("line1\nline2");
      const output = stdout.getOutput();
      expect(output).toContain(EL);
    });

    it("完全不同的内容：全部重写", () => {
      renderer.render("old1\nold2");
      stdout.clear();

      renderer.render("new1\nnew2");
      const output = stdout.getOutput();
      expect(output).toContain("new1");
      expect(output).toContain("new2");
    });

    // === 边界情况 ===

    it("只有第一行变化", () => {
      renderer.render("first\nsecond");
      stdout.clear();

      renderer.render("FIRST\nsecond");
      const output = stdout.getOutput();
      expect(output).toContain(CUU(1));
      expect(output).toContain("FIRST");
      expect(output).not.toContain("second");
    });

    it("只有最后一行变化", () => {
      renderer.render("first\nsecond");
      stdout.clear();

      renderer.render("first\nSECOND");
      const output = stdout.getOutput();
      expect(output).toContain("SECOND");
      expect(output).not.toContain("first");
    });

    it("单行到多行", () => {
      renderer.render("only");
      stdout.clear();

      renderer.render("first\nsecond\nthird");
      const output = stdout.getOutput();
      expect(output).toContain("first");
      expect(output).toContain("second");
      expect(output).toContain("third");
    });

    it("多行到单行", () => {
      renderer.render("a\nb\nc\nd");
      stdout.clear();

      renderer.render("only");
      const output = stdout.getOutput();
      expect(output).toContain("only");
      const elCount = (output.match(/\x1b\[2K/g) || []).length;
      expect(elCount).toBeGreaterThanOrEqual(4);
    });

    it("连续多次差分更新：状态保持正确", () => {
      renderer.render("a\nb\nc");

      // 第 1 次更新
      stdout.clear();
      renderer.render("a\nB\nc");
      expect(stdout.getOutput()).toContain("B");
      expect(stdout.getOutput()).not.toContain("a");

      // 第 2 次更新
      stdout.clear();
      renderer.render("a\nB\nC");
      expect(stdout.getOutput()).toContain("C");
      expect(stdout.getOutput()).not.toContain("B");

      // 第 3 次更新：全部变化
      stdout.clear();
      renderer.render("X\nY\nZ");
      expect(stdout.getOutput()).toContain("X");
      expect(stdout.getOutput()).toContain("Y");
      expect(stdout.getOutput()).toContain("Z");

      // 第 4 次更新：无变化
      stdout.clear();
      renderer.render("X\nY\nZ");
      expect(stdout.getOutput()).toBe("");
    });

    it("空字符串输入", () => {
      renderer.render("");
      expect(stdout.getOutput()).toBe("");
      expect(renderer.getLineCount()).toBe(1);
    });

    it("单个换行符输入", () => {
      renderer.render("\n");
      expect(stdout.getOutput()).toBe("\n");
      expect(renderer.getLineCount()).toBe(2);
    });

    it("行数从 2 减到 1 后再增到 3", () => {
      renderer.render("a\nb");
      stdout.clear();

      renderer.render("X");
      expect(stdout.getOutput()).toContain("X");
      expect(renderer.getLineCount()).toBe(1);

      stdout.clear();
      renderer.render("P\nQ\nR");
      const output = stdout.getOutput();
      expect(output).toContain("P");
      expect(output).toContain("Q");
      expect(output).toContain("R");
      expect(renderer.getLineCount()).toBe(3);
    });

    // === 带尾部换行的 Ink 真实场景 ===

    it("Ink 场景：带尾部换行的连续更新", () => {
      // Ink 的 outputToRender = output + "\n"，split 后尾部有空字符串
      renderer.render("InputBox\nStatusBar\n");
      expect(renderer.getLineCount()).toBe(3); // ["InputBox", "StatusBar", ""]

      stdout.clear();
      renderer.render("InputBox_v2\nStatusBar\n");
      const output1 = stdout.getOutput();
      expect(output1).toContain("InputBox_v2");
      expect(output1).not.toContain("StatusBar");

      // 第三次更新：验证光标位置没有漂移
      stdout.clear();
      renderer.render("InputBox_v3\nStatusBar\n");
      const output2 = stdout.getOutput();
      expect(output2).toContain("InputBox_v3");
      expect(output2).not.toContain("StatusBar");

      // 第四次：无变化
      stdout.clear();
      renderer.render("InputBox_v3\nStatusBar\n");
      expect(stdout.getOutput()).toBe("");
    });

    it("Ink 场景：流式输出中 Live 区域频繁更新", () => {
      // 模拟流式输出时 Live 区域的快速更新
      renderer.render("streaming...\nInputBox\nStatusBar\n");

      for (let i = 1; i <= 5; i++) {
        stdout.clear();
        renderer.render(`streaming chunk ${i}\nInputBox\nStatusBar\n`);
        const output = stdout.getOutput();
        expect(output).toContain(`streaming chunk ${i}`);
        // 不应重写未变化的行
        expect(output).not.toContain("InputBox");
        expect(output).not.toContain("StatusBar");
      }
    });

    // === ANSI 序列精确验证 ===

    it("ANSI 精确验证：中间行变化", () => {
      // 3 行，光标在索引 2
      renderer.render("L0\nL1\nL2");
      stdout.clear();

      // 只有索引 1 变化
      renderer.render("L0\nXX\nL2");
      const output = stdout.getOutput();

      // CUU(1) 到索引 1 + \r + EL + "XX" + CUD(1) 回到索引 2
      expect(output).toBe(CUU(1) + "\r" + EL + "XX" + CUD(1));
    });

    it("ANSI 精确验证：首行变化（2行）", () => {
      renderer.render("A\nB");
      stdout.clear();

      renderer.render("X\nB");
      const output = stdout.getOutput();

      // CUU(1) 到索引 0 + \r + EL + "X" + CUD(1) 回到索引 1
      expect(output).toBe(CUU(1) + "\r" + EL + "X" + CUD(1));
    });

    it("ANSI 精确验证：末行变化（2行）", () => {
      renderer.render("A\nB");
      stdout.clear();

      renderer.render("A\nX");
      const output = stdout.getOutput();

      // 光标已在索引 1（最后一行），不需要移动
      // \r + EL + "X"（光标已在最后一行，无需额外移动）
      expect(output).toBe("\r" + EL + "X");
    });

    it("ANSI 精确验证：行数增加（追加 1 行）", () => {
      renderer.render("A\nB");
      stdout.clear();

      renderer.render("A\nB\nC");
      const output = stdout.getOutput();

      // 光标在索引 1，firstChanged=2（新行），CUD(1) 到索引 2
      // \r + EL + "C"（光标已在最后一行，无需额外移动）
      expect(output).toBe(CUD(1) + "\r" + EL + "C");
    });

    it("ANSI 精确验证：行数减少（3→2）", () => {
      renderer.render("A\nB\nC");
      stdout.clear();

      renderer.render("A\nX");
      const output = stdout.getOutput();

      // 光标在索引 2，firstChanged=1, lastChanged=2, lastNewLine=min(2,1)=1
      // CUU(1) 到索引 1 + \r + EL + "X"
      // 清除 1 行多余行：\r\n + EL（光标到索引 2）
      // backUp = (1 + 1) - (2 - 1) = 1 → CUU(1) 回到索引 1（newLines 最后一行）
      expect(output).toBe(
        CUU(1) + "\r" + EL + "X" + "\r\n" + EL + CUU(1)
      );
    });

    it("ANSI 精确验证：行数减少（3→1）", () => {
      renderer.render("A\nB\nC");
      stdout.clear();

      renderer.render("X");
      const output = stdout.getOutput();

      // 光标在索引 2，firstChanged=0, lastChanged=2, lastNewLine=min(2,0)=0
      // CUU(2) 到索引 0 + \r + EL + "X"
      // 清除 2 行多余行：\r\n + EL + \r\n + EL（光标到索引 2）
      // backUp = (0 + 2) - (1 - 1) = 2 → CUU(2) 回到索引 0
      expect(output).toBe(
        CUU(2) + "\r" + EL + "X" + "\r\n" + EL + "\r\n" + EL + CUU(2)
      );
    });

    it("ANSI 精确验证：两行全部变化", () => {
      renderer.render("A\nB");
      stdout.clear();

      renderer.render("X\nY");
      const output = stdout.getOutput();

      // 光标在索引 1，firstChanged=0, lastChanged=1, lastNewLine=1
      // CUU(1) + \r + EL + "X" + \r\n + EL + "Y"
      // lastNewLine == newLines.length - 1，无需额外移动
      expect(output).toBe(
        CUU(1) + "\r" + EL + "X" + "\r\n" + EL + "Y"
      );
    });

    it("ANSI 精确验证：首行变化（3行）光标回到末行", () => {
      renderer.render("A\nB\nC");
      stdout.clear();

      renderer.render("X\nB\nC");
      const output = stdout.getOutput();

      // 光标在索引 2，CUU(2) 到索引 0
      // \r + EL + "X"
      // CUD(2) 回到索引 2
      expect(output).toBe(CUU(2) + "\r" + EL + "X" + CUD(2));
    });
  });

  describe("clear()", () => {
    it("清除所有行", () => {
      renderer.render("line1\nline2\nline3");
      stdout.clear();

      renderer.clear();
      const output = stdout.getOutput();
      expect(output).toContain(EL);
      expect(output).toContain(CUU(1));
    });

    it("空状态下 clear 不产生输出", () => {
      renderer.clear();
      expect(stdout.getOutput()).toBe("");
    });

    it("clear 后再 render 应全量输出", () => {
      renderer.render("old content");
      renderer.clear();
      stdout.clear();

      renderer.render("new content");
      expect(stdout.getOutput()).toBe("new content");
    });

    it("ANSI 精确验证：clear 2 行", () => {
      renderer.render("A\nB");
      stdout.clear();

      renderer.clear();
      const output = stdout.getOutput();

      expect(output).toBe("\r" + EL + CUU(1) + "\r" + EL);
    });

    it("ANSI 精确验证：clear 1 行", () => {
      renderer.render("only");
      stdout.clear();

      renderer.clear();
      const output = stdout.getOutput();

      expect(output).toBe("\r" + EL);
    });
  });

  describe("reset()", () => {
    it("重置状态不写入终端", () => {
      renderer.render("some\ncontent");
      stdout.clear();

      renderer.reset();
      expect(stdout.getOutput()).toBe("");
    });

    it("reset 后再 render 应全量输出", () => {
      renderer.render("old");
      renderer.reset();
      stdout.clear();

      renderer.render("new");
      expect(stdout.getOutput()).toBe("new");
    });
  });

  describe("sync()", () => {
    it("同步状态不写入终端", () => {
      renderer.sync("line1\nline2");
      expect(stdout.getOutput()).toBe("");
    });

    it("sync 后 render 相同内容不产生输出", () => {
      renderer.sync("hello\nworld");
      stdout.clear();

      renderer.render("hello\nworld");
      expect(stdout.getOutput()).toBe("");
    });

    it("sync 后 render 不同内容只更新变化行", () => {
      renderer.sync("line1\nline2");
      stdout.clear();

      renderer.render("line1\nchanged");
      const output = stdout.getOutput();
      expect(output).toContain("changed");
      expect(output).not.toContain("line1");
    });

    it("sync 后 clear", () => {
      renderer.sync("a\nb\nc");
      stdout.clear();

      renderer.clear();
      const output = stdout.getOutput();
      expect(output).toContain(EL);
      expect(renderer.getLineCount()).toBe(0);
    });
  });

  describe("getLineCount()", () => {
    it("初始为 0", () => {
      expect(renderer.getLineCount()).toBe(0);
    });

    it("render 后返回正确行数", () => {
      renderer.render("a\nb\nc");
      expect(renderer.getLineCount()).toBe(3);
    });

    it("clear 后返回 0", () => {
      renderer.render("a\nb");
      renderer.clear();
      expect(renderer.getLineCount()).toBe(0);
    });

    it("sync 后返回正确行数", () => {
      renderer.sync("x\ny\nz\nw");
      expect(renderer.getLineCount()).toBe(4);
    });
  });
});
