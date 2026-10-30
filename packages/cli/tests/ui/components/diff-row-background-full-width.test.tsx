/**
 * 回归：React 路径(小 diff)的 add/del 行底色必须铺满到 terminalWidth。
 *
 * 旧实现把整行底色挂在内容 <Text> 上,而 Text 的底色只覆盖到最后一个字符,
 * 行尾在 \x1b[49m 之后就没有底色,红绿块参差不齐。现在底色挂在 flexGrow 的 Box 上,
 * 由 renderBackground 按计算宽度铺满。RawAnsi 路径(>80 行)由 diff-ansi-lines.test.ts 覆盖。
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import React from "react";
import chalk from "chalk";
import { render } from "@sid-code/cli/ui/render-port/testing.ts";
import { DiffRenderer } from "@sid-code/cli/ui/components/DiffRenderer.tsx";
import { stringWidth } from "@sid-code/cli/ui/render-port/text.ts";

// 底色只有开色时才会输出;存/恢复原值,不污染同进程其他测试
const savedLevel = chalk.level;
beforeAll(() => {
  chalk.level = 3;
});
afterAll(() => {
  chalk.level = savedLevel;
});

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("DiffRenderer 增删行底色铺满整行", () => {
  const WIDTH = 40;
  const diff = [
    "--- a/x.txt",
    "+++ b/x.txt",
    "@@ -1,3 +1,3 @@",
    " ctx",
    "-old word",
    "+new",
    "+added only line",
  ].join("\n");

  test("add/del 行可见宽度 = terminalWidth,且行尾空格处于底色内", () => {
    const { lastFrame } = render(<DiffRenderer diffContent={diff} terminalWidth={WIDTH} />);
    const lines = (lastFrame() ?? "").split("\n");
    const changed = lines.filter((l) => /^\s*\d+ [+-] /.test(stripAnsi(l)));
    expect(changed.length).toBe(3);
    for (const line of changed) {
      expect(stringWidth(stripAnsi(line))).toBe(WIDTH);
      // 行尾空格之后才关闭底色(\x1b[49m),而不是在最后一个词之后
      expect(line).toMatch(/ {2,}\x1b\[49m$/);
      // 中途不得关闭底色:唯一一次 \x1b[49m 必须在行尾
      expect(line.split("\x1b[49m").length - 1).toBe(1);
    }
  });
});
