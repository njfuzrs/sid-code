/**
 * 终端拖拽路径 shell 转义还原的单元测试。
 *
 * `unescapeDroppedPath` 是纯逻辑（单行判定 / 去引号 / 反转义 / 路径前缀 / 存在性），
 * exists 全部注入假函数，不碰真实文件系统——CI 上结果与宿主目录内容无关。
 *
 * 重点守两类回归：
 * 1. 「只有引号、内部无转义」（`'/Volumes/My Disk/a.md'`）必须能去引号——判据 2
 *    的比较对象若取「去引号后的串」，这一整类会静默原样返回；
 * 2. shell 片段（`echo a \& b`）与 Windows 路径（`C:\new\test`）不得被改坏。
 */
import { describe, test, expect } from "bun:test";
import { unescapeDroppedPath } from "@sid-code/cli/ui/utils/dropped-path.ts";

/** 记录 stat 过的路径：既断言「还原结果只 stat 一次」，也断言反例根本没 stat */
function fakeExists(result: boolean, calls: string[] = []) {
  return (p: string) => {
    calls.push(p);
    return result;
  };
}

describe("unescapeDroppedPath", () => {
  test("正例：引号 + 转义一起去掉", () => {
    const calls: string[] = [];
    expect(
      unescapeDroppedPath("'/Users/x/16-Workflow\\&Schedule/a.md'", fakeExists(true, calls)),
    ).toBe("/Users/x/16-Workflow&Schedule/a.md");
    expect(calls).toEqual(["/Users/x/16-Workflow&Schedule/a.md"]);
  });

  test("正例：只有引号、内部无转义（空格在引号内不需要反斜杠）", () => {
    expect(unescapeDroppedPath("'/Volumes/My Disk/a.md'", fakeExists(true))).toBe(
      "/Volumes/My Disk/a.md",
    );
  });

  test("正例：只有引号、无转义（中文目录）", () => {
    expect(unescapeDroppedPath("'/Users/x/中文目录/a.md'", fakeExists(true))).toBe(
      "/Users/x/中文目录/a.md",
    );
  });

  test("正例：空格转义", () => {
    expect(unescapeDroppedPath("/tmp/a\\ b.md", fakeExists(true))).toBe("/tmp/a b.md");
  });

  test("正例：多层目录里的多种特殊字符", () => {
    expect(unescapeDroppedPath("/x/a\\&b/c\\ d/e.md", fakeExists(true))).toBe("/x/a&b/c d/e.md");
  });

  test("正例：保留原文首尾空白（不引入 trim 新语义）", () => {
    expect(unescapeDroppedPath("  /tmp/a\\&b.md  ", fakeExists(true))).toBe("  /tmp/a&b.md  ");
  });

  test("反例：shell 片段（不以路径前缀开头，stat 之前就短路）", () => {
    const calls: string[] = [];
    expect(unescapeDroppedPath("echo a \\& b", fakeExists(false, calls))).toBe("echo a \\& b");
    expect(calls).toEqual([]);
  });

  test("反例：多行（单行判据，stat 之前早退）", () => {
    const calls: string[] = [];
    expect(unescapeDroppedPath("a\\&b\nc", fakeExists(true, calls))).toBe("a\\&b\nc");
    expect(calls).toEqual([]);
  });

  test("反例：还原后不存在 → 原样保留转义形态", () => {
    expect(unescapeDroppedPath("/x/a\\&b.md", fakeExists(false))).toBe("/x/a\\&b.md");
  });

  test("反例：无转义无引号（幂等，不 stat）", () => {
    const calls: string[] = [];
    expect(unescapeDroppedPath("/x/a.md", fakeExists(true, calls))).toBe("/x/a.md");
    expect(calls).toEqual([]);
  });

  test("负向对照：Windows 路径不被误伤（\\n 不是 shell 特殊字符）", () => {
    expect(unescapeDroppedPath("C:\\new\\test", fakeExists(false))).toBe("C:\\new\\test");
  });

  test("相对路径前缀 ./ 也认", () => {
    expect(unescapeDroppedPath("./a\\ b.md", fakeExists(true))).toBe("./a b.md");
  });
});
