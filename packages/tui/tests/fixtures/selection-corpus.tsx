/**
 * 选区引擎语料（B9 / T6.2a，契约 M2）。每条是一棵树 + 一串鼠标字节（数字 = 前进的毫秒数），
 * 屏幕 10 行、alt-screen。期望值是旧底座在同一输入下的实测结果，入库在 `selection-vectors.json`
 * （探针经端口实例驱动 legacy，读 `copySelectionNoClear()` 与 xterm 无头终端里的高亮单元，D-5）。
 *
 * 连击计数是跨用例的进程级状态：旧底座同一进程里上一条用例的点击会和下一条连上，所以探针里
 * 每条用例前空 700ms（> MULTI_CLICK_MS）。这里每条用例用新状态，等价于那 700ms。
 */
import React from "react";

/** 端口的 Box / Text（legacy 生成向量时）或新底座的（单测时）；语料本身不 import 任何底座 */
export type CorpusComponents = { Box: React.ComponentType<any>; Text: React.ComponentType<any> };

export const ROWS = 10;

export type SelectionCase = {
  name: string;
  cols: number;
  node: React.ReactNode;
  seq: (string | number)[];
};

const P = (x: number, y: number) => `\x1b[<0;${x};${y}M`;
const R = (x: number, y: number) => `\x1b[<0;${x};${y}m`;
const D = (x: number, y: number) => `\x1b[<32;${x};${y}M`;
const click = (x: number, y: number) => [P(x, y), R(x, y)];
const dbl = (x: number, y: number) => [...click(x, y), ...click(x, y)];
const tpl = (x: number, y: number) => [...click(x, y), ...click(x, y), ...click(x, y)];
const drag = (a: [number, number], b: [number, number]) => [P(...a), 5, D(...b), 5, R(...b)];

export function buildSelectionCases({ Box, Text }: CorpusComponents): SelectionCase[] {
  const rows = (lines: string[]) => (
    <Box flexDirection="column">
      {lines.map((l, i) => (
        <Text key={i}>{l}</Text>
      ))}
    </Box>
  );

  const L = [
    "hello world foo-bar baz",
    "第一行 可以被选中的文本",
    "path/to/file.ts:12 x",
    "a.b_c d$e (f) 'g'",
  ];
  const W = [
    '~a@b#c%d+e=f,g;h!i?j*k&l|m\\n`o"p[q]r{s}t<u>v',
    "中文abc中 中文，文本。x",
    "((a)) ::b:: --c-- ..d.. //e//",
    "😀😀a 😀",
    "a\tb",
  ];
  const U = [
    "!?!? (@) a'b x:y",
    "über Ωmega 12.5 ä",
    "１２ａｂ 한국어 ひらがなカタカナ",
    "→→ ←a #!# @@x",
    "ée é ab😀cd 👍🏽x",
  ];
  const Q = ["a^b c·d e٣f g…h i—j k'l", 'x::y a!?b "q" ab—cd'];
  const WR = ["aaaa bbbb cccc dddd eeee"];

  const cases: SelectionCase[] = [];
  const add = (
    name: string,
    lines: string[] | React.ReactNode,
    seq: (string | number)[],
    cols = 40,
  ) => cases.push({ name, cols, node: Array.isArray(lines) ? rows(lines) : lines, seq });

  // 拖选 / 宽字符 / 屏幕外（probe2c、probe78）
  add("trailing-spaces", ["ab   ", "cd"], drag([1, 1], [2, 2]));
  add("wrap", ["aaaaaaaaaabbbbbbbbbbcccc"], drag([1, 1], [4, 2]), 10);
  add("wrap-tpl", WR, tpl(2, 2), 10);
  add("wrap-dbl", ["aaaaaaaaaabbbbbbbbbbcccc"], dbl(2, 2), 10);
  add("wide-end-left", L, drag([1, 2], [3, 2]));
  add("wide-back", L, drag([6, 2], [2, 2]));
  add("wide-back2", L, drag([5, 2], [1, 2]));
  add("drag-y0", L, drag([5, 2], [3, 0]));
  add("drag-ybig", L, drag([5, 2], [3, 30]));
  add("drag-xbig", L, drag([5, 1], [90, 1]));
  add("drag-x0", L, drag([5, 1], [0, 1]));
  add("drag-no-release", L, [P(1, 1), 5, D(5, 1)]);
  add("drag-then-back-to-start", L, [P(3, 1), 5, D(8, 1), 5, D(3, 1), 5, R(3, 1)]);
  add("drag-one-cell", L, drag([3, 1], [4, 1]));
  add("release-elsewhere", L, [P(1, 1), 5, D(5, 1), 5, R(9, 1)]);
  add("motion-no-button", L, [P(1, 1), 5, "\x1b[<35;5;1M", 5, R(5, 1)]);
  add("wheel-during", L, [P(1, 1), 5, D(5, 1), 5, "\x1b[<64;5;1M", 5, R(5, 1)]);
  add("x10-drag", L, ["\x1b[M !!", 5, "\x1b[M@%!", 5, "\x1b[M#%!"]);
  add("drag-wide-right-cells", L, drag([2, 2], [4, 2]));
  add("drag-to-left-of-wide", L, drag([8, 2], [4, 2]));
  add("alt-press", L, ["\x1b[<8;1;1M", 5, "\x1b[<40;5;1M", 5, "\x1b[<8;5;1m"]);
  add("ctrl-press", L, ["\x1b[<16;1;1M", 5, "\x1b[<48;5;1M", 5, "\x1b[<16;5;1m"]);
  add("shift-drag", L, ["\x1b[<4;1;1M", 5, "\x1b[<36;5;1M", 5, "\x1b[<4;5;1m"]);
  add("styled", ["\x1b[31mred\x1b[0m plain"], drag([1, 1], [9, 1]));

  // 连击时间 / 位置（probe2c、probe78、probe10）
  // 离阈值 500ms 只差几毫秒的用例（495 / 500 / 505）不进向量：生成器的定时器抖动会让它们时连时断，
  // 阈值本身由 selection.test.ts 里的精确用例钉住
  for (const t of [450, 480, 520, 560]) add(`dt-${t}`, L, [...click(3, 1), t, ...click(3, 1)]);
  for (const dx of [2, 3, 5]) add(`dx-${dx}`, L, [...click(3, 1), ...click(3 + dx, 1)]);
  add("dy-2", L, [...click(3, 1), ...click(3, 3)]);
  add("tpl-slow3", L, [...click(3, 1), ...click(3, 1), 600, ...click(3, 1)]);
  add("tpl-moved", L, [...click(3, 1), ...click(3, 1), ...click(10, 2)]);
  add("dbl-tol-diag", L, [...click(3, 1), ...click(4, 2)]);
  add("dbl-tol-left", L, [...click(3, 1), ...click(2, 1)]);
  add("tpl-tol", L, [...click(3, 1), ...click(4, 1), ...click(5, 1)]);
  add("tpl-tol2", L, [...click(3, 1), ...click(4, 1), ...click(6, 1)]);
  add("tpl-time", L, [...click(3, 1), 300, ...click(3, 1), 300, ...click(3, 1)]);
  add("five", L, [...tpl(3, 1), ...click(3, 1), ...click(3, 1)]);
  add("six", L, [...tpl(3, 1), ...tpl(3, 1)]);

  // 词 / 行模式的拖动（probe2c、probe10、probe11）
  add("dbl-drag-back", L, [...click(15, 1), ...drag([15, 1], [3, 1])]);
  add("dbl-drag-space", L, [...click(3, 1), ...drag([3, 1], [6, 1])]);
  add("dbl-drag-up", L, [...click(5, 3), ...drag([5, 3], [3, 1])]);
  add("tpl-drag-up", L, [...click(3, 3), ...click(3, 3), ...drag([3, 3], [3, 1])]);
  add("dbl-then-drag-same", L, [...click(3, 1), ...drag([3, 1], [3, 1])]);
  add("drag-zero-move", L, drag([3, 1], [3, 1]));
  add("drag-zero-then-move", L, [P(3, 1), 5, D(3, 1), 5, D(5, 1), 5, R(5, 1)]);
  add("drag-cancels-count", L, [...click(3, 1), ...drag([3, 1], [5, 1]), ...click(3, 1)]);
  add("click-after-dbl-drag", L, [...click(3, 1), ...drag([3, 1], [15, 1]), 50, ...click(15, 1)]);
  add("drag-then-click-same", L, [...drag([3, 1], [8, 1]), ...click(3, 1)]);
  add("drag-then-click-end", L, [...drag([3, 1], [8, 1]), ...click(8, 1)]);
  add("drag-then-dbl", L, [...drag([3, 1], [8, 1]), ...dbl(3, 1)]);
  add("right-after-sel", L, [...drag([1, 1], [5, 1]), "\x1b[<2;9;2M", "\x1b[<2;9;2m"]);
  add("middle-after-sel", L, [...drag([1, 1], [5, 1]), "\x1b[<1;9;2M", "\x1b[<1;9;2m"]);
  add("press-only", L, [P(3, 1)]);
  add("dbl-press-only", L, [...click(3, 1), P(3, 1)]);
  add("dbl-no-release-first", L, [P(3, 1), P(3, 1)]);
  add("release-only", L, [R(3, 1)]);
  add("press-out-then-drag", L, drag([3, 15], [5, 1]));
  add("press-out-x-then-drag", L, drag([60, 1], [5, 1]));
  add("oob-press-count", L, [...click(3, 15), ...click(3, 1)]);
  add("oob-dbl-then-in", L, [...click(3, 15), ...click(3, 15), ...click(3, 14)]);
  add("dbl-at-x40", L, dbl(40, 1));
  add("dbl-at-x41", L, dbl(41, 1));
  add("dbl-at-y10", L, dbl(3, 10));
  add("dbl-at-y11", L, dbl(3, 11));
  add("dbl-drag-oob", L, [...click(3, 1), ...drag([3, 1], [3, 20])]);
  add("tpl-drag-oob", L, [...click(3, 1), ...click(3, 1), ...drag([3, 1], [3, 20])]);
  add("dbl-drag-y0", L, [...click(3, 2), ...drag([3, 2], [3, 0])]);
  add("dbl-wide-spacer", L, dbl(2, 2));
  add("tpl-row-short", ["ab", "cd"], tpl(1, 1));
  add("tpl-blank", L, tpl(3, 7));
  add("dbl-blank-row", L, dbl(3, 7));
  add("dbl-then-click-far-fast", L, [...dbl(3, 1), ...click(20, 3)]);

  // 软换行（probe6、probe11）
  add("tpl-wrap-row0", WR, tpl(2, 1), 10);
  add("tpl-wrap-row2", WR, tpl(2, 3), 10);
  add("drag-wrap-end", WR, drag([1, 1], [10, 1]), 10);
  add("drag-wrap-3", WR, drag([1, 1], [3, 3]), 10);
  add("drag-wrap-12", WR, drag([1, 1], [3, 2]), 12);
  add("tpl-wrap-12", WR, tpl(2, 1), 12);
  add("drag-wrap-hardnl", ["aaaa\nbbbb"], drag([1, 1], [3, 2]), 10);
  add("drag-wrap-2texts", ["aaaa", "bbbb"], drag([1, 1], [3, 2]), 10);
  add("drag-wrap-long", ["xxxxxxxxxxyyy"], drag([5, 1], [2, 2]), 10);
  add("drag-wrap-sp", ["aaaaaaaaa bbbb"], drag([1, 1], [3, 2]), 10);
  add("sw12-0-8", WR, drag([1, 1], [9, 1]), 12);
  add("sw12-0-9", WR, drag([1, 1], [10, 1]), 12);
  add("sw12-0-11", WR, drag([1, 1], [12, 1]), 12);
  add("sw12-10-11-then-next", WR, drag([11, 1], [2, 2]), 12);
  add("sw12-start-mid-next", WR, drag([6, 1], [12, 2]), 12);
  add("sw-multispace", ["aa   bb   cc"], drag([1, 1], [2, 2]), 4);
  add("sw-multispace-tpl", ["aa   bb   cc"], tpl(1, 1), 4);
  add("sw-multispace6", ["aaaa   bbbb"], drag([1, 1], [3, 2]), 6);
  add("sw-hard-long", ["abcdefghij"], drag([1, 1], [2, 2]), 4);
  add("sw-cjk", ["第一行可以被选中的文本"], drag([1, 1], [4, 2]), 9);
  add("sw-dbl-across", ["aaaaaaaaaabbbb"], dbl(2, 1), 10);
  add("sw-dbl-across2", ["aaaaaaaaaabbbb"], dbl(2, 2), 10);
  add("sw-dbl-word", ["aaaa bbbbbb"], dbl(2, 1), 8);
  add("sw-dbl-wordwrap", ["aaaa bbbbbb"], dbl(2, 2), 8);
  add("sw-ends-at-space-only", ["aaaa bbbb"], drag([1, 2], [3, 2]), 5);
  add("sw-trailing-sp-hard", ["aaaa    ", "b"], drag([1, 1], [1, 2]), 20);

  // 词边界（probe2c、probe5、probe6、probe78）
  for (let x = 1; x <= 44; x++) add(`w0-${x}`, W, dbl(x, 1), 50);
  for (const x of [1, 3, 6, 8, 10, 12, 14, 16, 18, 19]) add(`w1-${x}`, W, dbl(x, 2), 50);
  for (const x of [1, 2, 4, 7, 8, 10, 13, 14, 15, 16, 19, 20, 21, 25, 26, 28])
    add(`w2-${x}`, W, dbl(x, 3), 50);
  for (const x of [1, 2, 5, 6, 7]) add(`w3-${x}`, W, dbl(x, 4), 50);
  for (const x of [1, 3, 9]) add(`w4-${x}`, W, dbl(x, 5), 50);
  const uProbes: [number, number][] = [
    [1, 1],
    [2, 1],
    [3, 1],
    [6, 1],
    [7, 1],
    [8, 1],
    [11, 1],
    [12, 1],
    [13, 1],
    [15, 1],
    [16, 1],
    [1, 2],
    [7, 2],
    [12, 2],
    [13, 2],
    [14, 2],
    [17, 2],
    [1, 3],
    [5, 3],
    [10, 3],
    [17, 3],
    [23, 3],
    [1, 4],
    [4, 4],
    [5, 4],
    [8, 4],
    [9, 4],
    [12, 4],
    [13, 4],
    [1, 5],
    [4, 5],
    [8, 5],
    [10, 5],
    [12, 5],
    [15, 5],
    [16, 5],
    [18, 5],
  ];
  for (const [x, y] of uProbes) add(`u-${x}-${y}`, U, dbl(x, y), 50);
  for (const x of [2, 6, 10, 14, 18, 22, 23]) add(`q0-${x}`, Q, dbl(x, 1), 50);
  for (const x of [2, 8, 12, 16, 18]) add(`q1-${x}`, Q, dbl(x, 2), 50);
  const seps = [
    "!😀!",
    "©",
    "€",
    "$5",
    "°",
    "。",
    "「",
    "！",
    "ー",
    "々",
    " ",
    "　",
    "👨‍👩‍👧",
    "x́",
    "ǅ",
    "²",
    "ⅷ",
    "​",
    "@",
    ":",
    "'",
    "%",
    "#",
    "=",
    "^",
    "|",
  ];
  for (const sp of seps) {
    add(`c-${JSON.stringify(sp)}-a`, [`ab${sp}cd`], dbl(1, 1), 30);
    add(`c-${JSON.stringify(sp)}-mid`, [`ab${sp}cd`], dbl(3, 1), 30);
  }
  add("adj-emoji-punct", ["a!😀b"], dbl(2, 1), 30);
  add("adj-emoji-punct2", ["a😀!b"], dbl(2, 1), 30);
  add("adj-cjkpunct-ascii", ["a。!b"], dbl(2, 1), 30);
  add("adj-nbsp-space", ["a  b"], dbl(2, 1), 30);
  add("adj-ideo-space", ["a　 b"], dbl(2, 1), 30);

  // 布局：padding、并排两列、边框、背景色（probe9；旧底座这几条是在已挂载的树上 rerender 再选）
  const pad = (
    <Box flexDirection="column">
      <Box paddingLeft={2}>
        <Text>pad me</Text>
      </Box>
      {/* 前导空格写成字符串：JSX 文本里的连续空格会被 oxfmt 压成一个 */}
      <Text>{"   lead spaces"}</Text>
    </Box>
  );
  const twoCols = (
    <Box>
      <Box width={10}>
        <Text>left text wraps here</Text>
      </Box>
      <Text>right</Text>
    </Box>
  );
  add("box-pad", pad, drag([1, 1], [10, 2]));
  add("box-pad-dbl", pad, dbl(1, 1));
  add("two-cols", twoCols, drag([1, 1], [5, 2]));
  add("two-cols-tpl", twoCols, tpl(1, 1));
  add(
    "border",
    <Box borderStyle="round">
      <Text>inside</Text>
    </Box>,
    drag([1, 1], [9, 2]),
  );
  add("bg-text", <Text backgroundColor="blue">blue bg </Text>, drag([1, 1], [20, 1]));
  add("middle", L, ["\x1b[<1;1;1M", 5, "\x1b[<33;5;1M", 5, "\x1b[<1;5;1m"]);
  add("tpl-y-beyond", L, tpl(3, 15));
  add("dbl-x-beyond", L, dbl(60, 1));

  return cases;
}
