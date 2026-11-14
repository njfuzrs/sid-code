/**
 * 回归：diff 区域字重全区域统一——任何一段都不加粗。
 *
 * 旧实现给「词级变化词」和行首 `+`/`-` 符号都加了 bold（`\x1b[1m`）。两个观感问题：
 * 1. CJK 没有词边界，`diffWordsWithSpace` 退化成按字切分 → 一行中文里散落个别加粗单字；
 *    中文字体普遍没有真 bold，终端用合成粗体顶替，笔画加宽、字形变糊，像「字号变了」。
 * 2. 配对行走 renderWordDiff、未配对行走 colorizeLine。两行内容差异越大，被判成变化
 *    的段越多 → 同一块 diff 里「这一行整行加粗、紧邻的行不加粗」，粗细参差。
 *
 * 现在强调只靠「emphasis 底色 + 状态色 + 行首 +/- 符号」，bold 全部去掉。
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

describe("diff 区域字重统一（任何一段都不加粗）", () => {
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

  test("变化词仍靠 emphasis 底色区分（去 bold 不等于去掉强调）", () => {
    const { lastFrame } = render(
      <DiffRenderer diffContent={pairedDiff} filename="a.ts" terminalWidth={100} />,
      { columns: 100 },
    );
    const frame = lastFrame() ?? "";
    // 行级底色 + 词级 emphasis 底色都还在(背景色转义存在)
    expect(frame).toMatch(/\x1b\[48[;0-9]*m/);
    // 可见文本未被破坏
    const plain = stripAnsi(frame);
    expect(plain).toContain("const wireEffort = thinkingWire.dropEffort ? undefined;");
    expect(plain).toContain("「关思考落到最低档」");
  });

  test("纯中文配对行:不再出现「个别汉字被加粗」", () => {
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
    expect(lastFrame() ?? "").not.toContain("\x1b[1m");
  });
});
