/**
 * 契约 I3（B9 / T5.2a）：终端回复与回复残片不当按键。
 *
 * 只通过端口驱动。期望值全部是 2026-10-08 对拍 legacy 的黑盒探针实测
 * （结果备份在 `~/Backups/sid-code-t5x-probe-results-20261008/t52a/`），没有读旧底座代码（设计文档 D-5）。
 * 更细的分片边界（切在 1、2、中间、末字节 × 10 / 80ms 间隔）在键位语料的 `resp` 组里逐条对拍
 * （`packages/tui/tests/input.test.ts`）；这里钉住用户看得见的结论：回复的字节一个都不进 `useInput`。
 *
 * 旧底座侧曾有同名测试（测解析器内部函数），T9.1 随旧底座删除；
 * 它的 10 条输入在下面「旧测试的 10 条输入」一组里按端口口径保留。
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { Text } from "@sid-code/cli/ui/render-port/components.ts";
import { useInput } from "@sid-code/cli/ui/render-port/hooks.ts";
import { mountTTY, tick, ttyStreams } from "./tty-streams.ts";

const E = "\x1b";

const trueKeys = (k: object) =>
  Object.entries(k)
    .filter(([, v]) => v === true)
    .map(([n]) => n)
    .sort()
    .join(",");

/** 按块写 stdin（数字 = 等待毫秒），返回 `useInput` 收到的 `[input, 为真的 key 字段]` */
async function drive(chunks: Array<string | number>): Promise<string[][]> {
  const s = ttyStreams({ stdoutTTY: false });
  const got: string[][] = [];
  function Probe() {
    useInput((input, key) => {
      got.push([input, trueKeys(key)]);
    });
    return <Text>k</Text>;
  }
  const m = mountTTY(<Probe />, s);
  await tick(10);
  for (const c of chunks) {
    if (typeof c === "number") await tick(c);
    else s.stdin.write(c);
  }
  // 盖过 ESC 冲刷超时（40–60ms）
  await tick(90);
  m.teardown();
  return got;
}

type Case = [name: string, chunks: Array<string | number>, want: string[][]];

describe("I3 旧测试的 10 条输入", () => {
  const cases: Case[] = [
    ["XTVERSION 回复只到一半就被冲刷", [`${E}P>|xterm.js(6.1.0-beta.288)`, 80], []],
    ["单独的 ST 残尾后跟完整 DA1", [`${E}\\${E}[?1;2c`], []],
    ["DA1 缺终止符被冲刷", [`${E}[?1;2`, 80], []],
    ["OSC 11 背景色回复被冲刷", [`${E}]11;rgb:1a1a/1b1b`, 80], []],
    ["完整 XTVERSION", [`${E}P>|ghostty 1.2${E}\\`], []],
    ["完整 DA1", [`${E}[?1;2c`], []],
    [
      "方向键照常",
      [`${E}[A${E}[B${E}[C${E}[D`],
      [
        ["", "upArrow"],
        ["", "downArrow"],
        ["", "rightArrow"],
        ["", "leftArrow"],
      ],
    ],
    [
      "修饰键 / Delete / Home / End 照常",
      [`${E}[1;5A${E}[3~${E}[H${E}[F`],
      [
        ["", "ctrl,upArrow"],
        ["", "delete"],
        ["", "home"],
        ["", "end"],
      ],
    ],
    ["普通文本照常", ["hello world"], [["hello world", ""]]],
    ["单独 ESC 冲刷成 Esc 键", [E, 80], [["", "escape,meta"]]],
  ];
  for (const [name, chunks, want] of cases) {
    test(`I3: ${name}`, async () => {
      expect(await drive(chunks)).toEqual(want);
    });
  }
});

describe("I3 回复与残片丢弃", () => {
  const cases: Case[] = [
    ["DCS 以 BEL 结尾，后面的按键照常", [`${E}P>|xterm.js(6.1.0)\x07a`], [["a", ""]]],
    ["OSC 以 ST 结尾，后面的按键照常", [`${E}]11;rgb:1a1a/1b1b/1c1c${E}\\a`], [["a", ""]]],
    ["CSI 次级回复（DA2 / modifyOtherKeys）", [`${E}[>0;276;0c${E}[>4;2mk`], [["k", ""]]],
    ["CSI 私有回复（DECRPM / kitty 查询）", [`${E}[?2026;2$y${E}[?31uk`], [["k", ""]]],
    ["两条 DA1 粘在一块", [`${E}[?1;2c${E}[?62c`, 80, "k"], [["k", ""]]],
    ["XTVERSION + DA1 同块", [`${E}P>|xterm.js(6.1.0)${E}\\${E}[?1;2c`, 80, "k"], [["k", ""]]],
    ["DCS 分三次到达、间隔 30ms，最后才来 ST", [`${E}Pab`, 30, "cd", 30, `ef${E}\\k`], [["k", ""]]],
    [
      "DCS 分次到达没等到 ST 就冲刷，之后的输入照常",
      [`${E}Pab`, 30, "cd", 30, "ef", 80, "k"],
      [["k", ""]],
    ],
    ["DA1 分三次到达", [`${E}[?1`, 30, ";2", 30, "c", 80, "k"], [["k", ""]]],
    [
      "DCS 切在 ST 的 ESC 之后、隔 10ms 补齐，再跟 DA1",
      [`${E}P>|x${E}`, 10, `\\${E}[?1;2c`, 80, "k"],
      [["k", ""]],
    ],
    // DCS / OSC 串里的 ESC、换行、Ctrl+C 都算内容，一起丢
    ["DCS 内夹 ESC a 与 CSI", [`${E}Pab${E}a${E}[Acd${E}\\z`], [["z", ""]]],
    ["DCS 内夹换行", [`${E}Pa\nb${E}\\z`], [["z", ""]]],
    ["OSC 开头后隔 10ms 来 Ctrl+C：Ctrl+C 被吞进串里", [`${E}]`, 10, "\x03", 80, "k"], [["k", ""]]],
    [
      "私有 CSI 后紧跟方向键：方向键照常",
      [`${E}[?62;22${E}[A`],
      [
        ["[?62;22", ""],
        ["", "upArrow"],
      ],
    ],
    [
      "文本后接 DCS 残片",
      [`ab${E}P>|x`, 80, "k"],
      [
        ["ab", ""],
        ["k", ""],
      ],
    ],
  ];
  for (const [name, chunks, want] of cases) {
    test(`I3: ${name}`, async () => {
      expect(await drive(chunks)).toEqual(want);
    });
  }
});

describe("I3 边界：不是回复的照旧交出", () => {
  const cases: Case[] = [
    // 只有 ESC 一个字节时看不出是回复：冲刷成 Esc，后面的字节当普通文本
    [
      "回复只到 ESC 就冲刷",
      [E, 80, "P>|x"],
      [
        ["", "escape,meta"],
        ["P>|x", ""],
      ],
    ],
    [
      "APC 原样交出，不丢",
      [`${E}_abc${E}\\z`],
      [
        ["_abc\x1b\\", ""],
        ["z", ""],
      ],
    ],
    [
      "APC 半截冲刷：原样交出",
      [`${E}_a`, 80, "k"],
      [
        ["_a", ""],
        ["k", ""],
      ],
    ],
    [
      "SOS 不当串：ESC X 是 meta+X",
      [`${E}Xab`],
      [
        ["X", "meta,shift"],
        ["ab", ""],
      ],
    ],
    ["`CSI =` 不算回复", [`${E}[=1c`], [["[=1c", ""]]],
    ["`CSI ?` 被控制符截断：原样交出", [`${E}[?1\x01b`], [["[?1\x01b", ""]]],
    [
      "`CSI ?` 被 ESC 截断：原样交出",
      [`${E}[?${E}[A`],
      [
        ["[?", ""],
        ["", "upArrow"],
      ],
    ],
    ["C1 的 0x9C 不算 ST：吞到下一个 ESC \\ 为止", [`${E}Pa\x9cb${E}\\k`], [["k", ""]]],
  ];
  for (const [name, chunks, want] of cases) {
    test(`I3: ${name}`, async () => {
      expect(await drive(chunks)).toEqual(want);
    });
  }
});

describe("I3 粘贴内容里夹着回复", () => {
  test("I3: 粘贴里的 DCS / OSC / 私有 CSI 原样算粘贴内容", async () => {
    expect(await drive([`${E}[200~a${E}Pb${E}\\c${E}[201~k`])).toEqual([
      ["a\x1bPb\x1b\\c", ""],
      ["k", ""],
    ]);
    expect(await drive([`${E}[200~a${E}]b\x07c${E}[201~k`])).toEqual([
      ["a\x1b]b\x07c", ""],
      ["k", ""],
    ]);
    expect(await drive([`${E}[200~a${E}[?1cb${E}[201~k`])).toEqual([
      ["a\x1b[?1cb", ""],
      ["k", ""],
    ]);
  });

  test("I3: 粘贴里的 DCS 没收齐 ST 时会吞掉结束标记，粘贴一直不结束", async () => {
    expect(await drive([`${E}[200~a${E}Pb${E}[201~k`, 80, "more", 80, `${E}\\z`, 80, "q"])).toEqual(
      [],
    );
  });
});
