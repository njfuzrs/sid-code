/**
 * 回归：diff 区域视觉统一——任何一段都不加粗，且整行只有一种底色。
 *
 * 两个观感问题同源，都是「用词级强调去区分变化词」造成的：
 * 1. 旧实现给变化词和行首 `+`/`-` 都加了 bold（`\x1b[1m`）：CJK 没有词边界，
 *    `diffWordsWithSpace` 退化成按字切分 → 一行中文里散落个别加粗单字；中文字体
 *    普遍没有真 bold，终端用合成粗体顶替，笔画加宽、字形变糊，像「字号变了」。
 * 2. 去掉 bold 后仍留着 emphasis 底色 → 一行中文里散落个别碎片被换成更深的底色，
 *    观感就是「同一块 diff 有的字深、有的字浅，像背景叠了两层」。
 *
 * 现在整行单一底色 + 单一状态前景色，词级强调连同 emphasis 底色一起去掉。
 * 本用例走 React 路径（小 diff）锁住回归；RawAnsi 快路径（>80 行）的同款断言在
 * `tests/ui/diff-ansi-lines.test.ts`。
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import React from "react";
import chalk from "chalk";
import { render } from "@sid-code/cli/ui/render-port/testing.ts";
import { DiffRenderer } from "@sid-code/cli/ui/components/DiffRenderer.tsx";

// bold/底色只有开色时才会输出;存/恢复原值,不污染同进程其他测试
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

/** 一行里出现过的所有背景色转义(去重)。一行只允许一种底色。 */
function bgKinds(line: string): Set<string> {
  return new Set(line.match(/\x1b\[48[;0-9]*m/g) ?? []);
}

describe("diff 区域视觉统一（不加粗、一行一种底色）", () => {
  // del 是代码、add 是中文注释:词级 diff 会把几乎整行判成变化,旧实现下这一行整行加粗
  const pairedDiff = [
    "@@ -1,2 +1,2 @@",
    "-const wireEffort = thinkingWire.dropEffort ? undefined;",
    "+// 「关思考落到最低档」优先于用户档位：后者是「想多深」，",
    " ctx",
  ].join("\n");

  test("配对行整帧无 bold 转义（词级强调与 +/- 前缀符号都不例外）", () => {
    const { lastFrame } = render(
      <DiffRenderer diffContent={pairedDiff} filename="a.ts" terminalWidth={100} />,
      { columns: 100 },
    );
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("\x1b[1m");
  });

  test("整行只有一种底色（不做词级强调）", () => {
    const { lastFrame } = render(
      <DiffRenderer diffContent={pairedDiff} filename="a.ts" terminalWidth={100} />,
      { columns: 100 },
    );
    const frame = lastFrame() ?? "";
    // 旧实现里变化词会再叠一层 emphasis 底色,同一行出现两种背景色 → 观感「有的字深、
    // 有的字浅」。上下文行没有底色,所以判据是「至多一种」而不是「恰好一种」。
    for (const line of frame.split("\n")) {
      if (line.trim().length === 0) continue;
      expect(bgKinds(line).size).toBeLessThanOrEqual(1);
    }
    // 可见文本未被破坏
    const plain = stripAnsi(frame);
    expect(plain).toContain("const wireEffort = thinkingWire.dropEffort ? undefined;");
    expect(plain).toContain("「关思考落到最低档」");
  });

  test("纯中文配对行:不再出现「个别汉字被加粗」,底色也只有一种", () => {
    const diff = [
      "@@ -10,1 +10,1 @@",
      "-const 定义 = 一个中文标识符;",
      "+const 定义 = 两个中文标识符;",
    ].join("\n");
    const { lastFrame } = render(
      <DiffRenderer diffContent={diff} filename="a.ts" terminalWidth={80} />,
      {
        columns: 80,
      },
    );
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("\x1b[1m");
    for (const line of frame.split("\n")) {
      if (line.trim().length === 0) continue;
      expect(bgKinds(line).size).toBeLessThanOrEqual(1);
    }
  });
});
