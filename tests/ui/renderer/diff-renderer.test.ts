/**
 * DiffRenderer 单元测试
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { DiffRenderer } from "../../../src/ui/renderer/diff-renderer.ts";

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
      // 应包含 changed 但不包含 line1 和 line3 的重写
      expect(output).toContain("changed");
      // 不应包含 line1（未变化的行不重写）
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
      // 应包含 EL（清除行）序列
      expect(output).toContain("\x1b[2K");
    });

    it("完全不同的内容：全部重写", () => {
      renderer.render("old1\nold2");
      stdout.clear();

      renderer.render("new1\nnew2");
      const output = stdout.getOutput();
      expect(output).toContain("new1");
      expect(output).toContain("new2");
    });
  });

  describe("clear()", () => {
    it("清除所有行", () => {
      renderer.render("line1\nline2\nline3");
      stdout.clear();

      renderer.clear();
      const output = stdout.getOutput();
      // 应包含 EL 序列（清除行）
      expect(output).toContain("\x1b[2K");
      // 应包含 CUU 序列（光标上移）
      expect(output).toContain("\x1b[1A");
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
