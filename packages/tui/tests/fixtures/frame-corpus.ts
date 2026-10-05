/**
 * 帧间增量对拍语料（B9 / T3.2，契约 R1 / R3–R6 / R12）。
 *
 * 纯数据：每条是一串帧，每帧是若干行 `<Text>` 内容（一列 Box 排开），或 resize / forceRedraw / SIGCONT（见 FrameStep）。
 * 生成器（scripts/tui-frame-vectors.ts）在旧底座 TTY 路径上逐帧提交，记下每帧写出的字节与 onFrame 的 full reset 原因；
 * 测试（tests/frame.test.ts）在新底座上跑同一串帧，逐帧比较。这个文件不 import 任何底座。
 */
/**
 * 一帧：若干行内容；或一次（同 tick 内可多次的）resize；或调用实例 forceRedraw；或进程收到 SIGCONT。
 * 后三种不提交新内容（T3.3：R7 / R8 / R10）。
 */
export type FrameStep =
  | string[]
  | { resize: [number, number] }
  | { resizes: Array<[number, number]> }
  | { forceRedraw: true; then?: string[]; resizeFirst?: [number, number] }
  | { sigcont: true };

export type FrameCase = {
  name: string;
  cols?: number;
  rows?: number;
  /** stdout 是否 TTY（默认是）；false 走 R12 非 TTY 整帧 */
  tty?: boolean;
  frames: FrameStep[];
};

const L = (n: number, f?: (i: number) => string) =>
  Array.from({ length: n }, (_, i) => (f ? f(i) : String(i)));
const at = (n: number, rows: number[], v = "X") => L(n, (i) => (rows.includes(i) ? v : String(i)));
const E = "\x1b";

export const FRAME_CORPUS: FrameCase[] = [
  // —— 视口内：增长 / 改行 / 收缩 ——
  {
    name: "增长 改行 收缩 拉长 截短 中间空行",
    frames: [["a", "b"], ["a", "b", "c"], ["a", "X", "c"], ["a"], ["abc"], ["ab"], ["ab", "", "d"]],
  },
  { name: "内容不变不写", frames: [["a"], ["a"]] },
  { name: "空帧到有内容", rows: 10, frames: [[], L(2)] },
  { name: "变成空帧", rows: 10, frames: [L(3), []] },
  { name: "1 行 / 2 行变成空帧", rows: 10, frames: [L(1), [], L(2), []] },
  { name: "改末行", rows: 10, frames: [L(3), at(3, [2])] },
  { name: "不相邻两行改", rows: 10, frames: [L(6), at(6, [1, 4])] },
  { name: "相邻两行改", rows: 10, frames: [L(4), at(4, [1, 2])] },
  {
    name: "改行带列偏移",
    rows: 10,
    frames: [L(6), L(6, (i) => (i === 1 ? "1X" : i === 4 ? "4Y" : String(i)))],
  },
  { name: "改行同时增长", rows: 10, frames: [L(3), at(5, [0])] },
  { name: "收缩同时改行", rows: 10, frames: [L(6), at(4, [1])] },
  { name: "收缩一行 两行 三行", rows: 6, frames: [L(5), L(4), L(2)] },

  // —— 行内：样式 / 宽字符 / 宽度补偿 / 超链接 ——
  { name: "行内两段变化", frames: [["abcdefghij"], ["XbcdefghiY"]] },
  {
    name: "两段带样式变化，中间跳过",
    frames: [["abcdefghij"], [`a${E}[1mb${E}[22mcdefgh${E}[1mi${E}[22mj`]],
  },
  { name: "跳过时样式不关", frames: [[`${E}[1mabcdef${E}[22m`], [`${E}[1mXbcdeY${E}[22m`]] },
  { name: "宽字符替换 截短 错位", frames: [["ab中cd"], ["ab文cd"], ["ab文c"], ["a文文c"]] },
  { name: "跳过未变的宽字符", frames: [["中文中文x"], ["中文中文y"], ["中x中文y"]] },
  { name: "宽字符两侧都改（行内跳过宽字符）", frames: [["a中b文c"], ["X中Y文Z"]] },
  { name: "只改宽字符的颜色", frames: [[`${E}[31m中${E}[39m文`], [`${E}[32m中${E}[39m文`]] },
  { name: "宽度补偿字符前后改", frames: [["a❤️b"], ["a❤️c"], ["x❤️c"]] },
  {
    name: "超链接改字与改目标",
    frames: [
      [`${E}]8;;http://x\x07ab${E}]8;;\x07cd`],
      [`${E}]8;;http://x\x07aX${E}]8;;\x07cd`],
      [`${E}]8;;http://y\x07aX${E}]8;;\x07cd`],
    ],
  },
  { name: "行尾变空白与再写", frames: [["abc"], ["a"], ["a  b"]] },

  // —— 超出视口：scrollback 与 full reset（R4 / R5 / R6）——
  { name: "纯增长越过视口", rows: 6, frames: [L(3), L(10)] },
  { name: "溢出后在视口内收缩一行", rows: 6, frames: [L(10), L(9)] },
  { name: "溢出后改屏外行", rows: 6, frames: [L(9), at(9, [0])] },
  { name: "溢出后改视口首行", rows: 6, frames: [L(10), at(10, [4])] },
  { name: "溢出后改视口第二行", rows: 6, frames: [L(10), at(10, [4]), at(10, [4, 5])] },
  { name: "收缩后改行", rows: 6, frames: [L(10), L(9), at(9, [4])] },
  { name: "溢出后增长且改可视行", rows: 6, frames: [L(10), at(12, [8])] },
  { name: "溢出后增长且改屏外行", rows: 6, frames: [L(10), at(12, [3])] },
  { name: "溢出后收缩且改屏外行", rows: 6, frames: [L(10), at(8, [2])] },
  { name: "占满视口时改首行", rows: 6, frames: [L(6), at(6, [0])] },
  { name: "占满视口时改第二行", rows: 6, frames: [L(6), at(6, [1])] },
  { name: "差一行占满时改首行", rows: 6, frames: [L(5), at(5, [0])] },
  { name: "增长越过视口且改首行", rows: 6, frames: [L(3), at(8, [0])] },
  { name: "大幅收缩后再改与再长", rows: 6, frames: [L(20), L(15), at(15, [11]), at(15, [9])] },
  { name: "大幅收缩后增长", rows: 6, frames: [L(20), L(15), L(17)] },
  // 收缩阈值：p → n，视口 H。full reset 当且仅当 p − n > H − 1，或 p ≥ H 且 n ≤ H
  ...(
    [
      [6, 4],
      [6, 5],
      [7, 5],
      [7, 6],
      [7, 7],
      [8, 6],
      [8, 7],
      [9, 7],
      [10, 4],
      [10, 5],
      [10, 6],
      [10, 7],
      [10, 8],
      [11, 6],
      [11, 7],
      [12, 7],
      [13, 7],
      [20, 7],
      [20, 10],
      [30, 24],
      [30, 25],
    ] as const
  ).map(([p, n]) => ({ name: `收缩 ${p}→${n}（视口 6）`, rows: 6, frames: [L(p), L(n)] })),
  { name: "收缩 15→10 与 15→11（视口 10）", rows: 10, frames: [L(15), L(10), L(15), L(11)] },
  { name: "收缩 16→6（视口 10）", rows: 10, frames: [L(16), L(6)] },

  // —— 宽度变化（R7 的帧层部分）——
  { name: "变宽", frames: [["ab"], { resize: [30, 6] }, ["ab"]] },
  { name: "变窄", frames: [["ab", "cd"], { resize: [10, 6] }, ["ab", "cd"]] },

  // —— resize 事件（R7，T3.3）：合并、变矮 / 变高、尺寸不变 ——
  { name: "尺寸不变的 resize 不出帧", frames: [["ab"], { resize: [20, 6] }] },
  {
    name: "同 tick 两次 resize 回到原尺寸",
    frames: [
      ["ab"],
      {
        resizes: [
          [15, 6],
          [20, 6],
        ],
      },
    ],
  },
  {
    name: "同 tick 三次变宽",
    frames: [
      ["ab"],
      {
        resizes: [
          [22, 6],
          [24, 6],
          [26, 6],
        ],
      },
    ],
  },
  {
    name: "变矮 full reset 变高不 reset",
    rows: 8,
    frames: [L(3), { resize: [20, 6] }, { resize: [20, 4] }, { resize: [20, 9] }, at(3, [2])],
  },
  { name: "溢出态变矮再变宽", rows: 6, frames: [L(9), { resize: [20, 4] }, { resize: [24, 4] }] },
  { name: "空帧变宽也 reset", frames: [[], { resize: [18, 6] }, ["a"]] },
  { name: "变矮后再改行", rows: 8, frames: [L(4), { resize: [20, 5] }, at(4, [3])] },

  // —— forceRedraw（R8，T3.3）——
  { name: "forceRedraw 后照常增量", frames: [L(2), { forceRedraw: true }, at(2, [1])] },
  { name: "forceRedraw 同 tick 再提交", frames: [L(2), { forceRedraw: true, then: at(2, [0]) }] },
  { name: "forceRedraw 空帧", frames: [[], { forceRedraw: true }] },
  {
    name: "溢出态 forceRedraw 后改末行",
    rows: 6,
    frames: [L(9), { forceRedraw: true }, at(9, [8])],
  },
  {
    name: "resize 与 forceRedraw 同 tick",
    frames: [L(2), { forceRedraw: true, resizeFirst: [18, 6] }],
  },
  {
    name: "变矮与 forceRedraw 同 tick",
    frames: [L(2), { forceRedraw: true, resizeFirst: [20, 4] }],
  },
  {
    name: "变矮后 forceRedraw",
    rows: 8,
    frames: [L(2), { resize: [20, 5] }, { forceRedraw: true }],
  },

  // —— 主屏 SIGCONT（R10，T3.3）：不写字节，下一帧从光标处接着写，前面没变的行省成换行 ——
  { name: "SIGCONT 后同内容", rows: 10, frames: [L(4), { sigcont: true }, L(4)] },
  { name: "SIGCONT 后改中间行", rows: 10, frames: [L(4), { sigcont: true }, at(4, [1])] },
  { name: "SIGCONT 后改首行", rows: 10, frames: [L(4), { sigcont: true }, at(4, [0])] },
  { name: "SIGCONT 后增长", rows: 10, frames: [L(2), { sigcont: true }, L(4)] },
  { name: "SIGCONT 后收缩", rows: 10, frames: [L(4), { sigcont: true }, L(2)] },
  { name: "SIGCONT 后溢出态改末行", rows: 5, frames: [L(8), { sigcont: true }, at(8, [7])] },
  {
    name: "SIGCONT 后变矮",
    rows: 8,
    frames: [L(2), { sigcont: true }, { resize: [20, 4] }, at(2, [0])],
  },
  {
    name: "SIGCONT 后 forceRedraw",
    rows: 8,
    frames: [L(2), { sigcont: true }, { forceRedraw: true }],
  },
  {
    name: "SIGCONT 后第二帧照常 diff",
    rows: 8,
    frames: [L(2), { sigcont: true }, L(2), at(2, [1])],
  },

  // —— 非 TTY（R12）——
  { name: "非 TTY 逐帧整帧", tty: false, frames: [[], ["a"], ["a"], [], ["b", ""], ["a", "c"]] },
];
