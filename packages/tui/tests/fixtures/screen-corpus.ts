/**
 * 屏幕缓冲对拍语料（B9 / T3.1，契约 R3 / R9 / T3 / T4）。
 *
 * 纯数据：生成器（scripts/tui-screen-vectors.ts）用旧底座把它渲染成首帧字节，
 * 测试（tests/screen.test.ts）用新底座渲染同一棵树再序列化，逐字节比较。
 * 这个文件不 import 任何底座，所以两边共用它不会让测试间接依赖旧底座。
 *
 * 节点 DSL：字符串 = `<Text>` 内容；`{box, children}` = `<Box>`；`{text, children}` = 带 props 的 `<Text>`。
 * 加条目时在注释里写清楚它钉住哪条规则。
 */
const E = "\x1b";
const link = (url: string, text: string) => `${E}]8;;${url}\x07${text}${E}]8;;\x07`;

export type CorpusNode =
  | string
  | { box: Record<string, unknown>; children: CorpusNode[] }
  | { text: Record<string, unknown>; children: (string | CorpusNode)[] };

export type CorpusCase = { name: string; cols?: number; node: CorpusNode };

const box = (props: Record<string, unknown>, ...children: CorpusNode[]): CorpusNode => ({
  box: props,
  children,
});
const text = (
  props: Record<string, unknown>,
  ...children: (string | CorpusNode)[]
): CorpusNode => ({
  text: props,
  children,
});
const col = (...children: CorpusNode[]) => box({ flexDirection: "column" }, ...children);
const row = (...children: CorpusNode[]) => box({ flexDirection: "row" }, ...children);
const abs = (marginLeft: number, ...children: CorpusNode[]) =>
  box({ position: "absolute", marginLeft }, ...children);

export const SCREEN_CORPUS: CorpusCase[] = [
  // —— 空白与光标前移 ——
  { name: "空白跳过用 CUF", node: "a                    b" },
  { name: "行尾空白丢弃", node: "ab   " },
  { name: "中间空行", node: col("a", " ", "b") },
  { name: "Box 高度留出的空行", node: col(box({ height: 3 }, "a"), "b") },
  { name: "paddingLeft 偏移", node: box({ paddingLeft: 3 }, "x") },

  // —— SGR 切换（diffAnsiCodes 口径）——
  // Text props 的组合顺序、`dim`（上游只有 dimColor）、旧底座 `<Text dimColor>` 不出 SGR，都属于宿主组件，留给 T4.x；
  // 这里只钉屏幕层：给定 SGR 串，切换序列是什么
  { name: "嵌套 SGR 先开后关", node: `${E}[31mr${E}[39m${E}[31m${E}[1mrb${E}[22m${E}[39mn` },
  { name: "粗体中途换色", node: `${E}[1mx${E}[31my${E}[22mz${E}[39mw` },
  { name: "下划线续上再加粗", node: `${E}[4ma${E}[24m${E}[1m${E}[4mb${E}[0m` },
  {
    name: "Text bold / color",
    node: row(text({ color: "ansi:red" }, "r"), text({ bold: true }, "B")),
  },
  { name: "hex 颜色", node: text({ color: "#ff0000" }, "h") },
  {
    name: "原始 SGR 串",
    node: `${E}[31ma${E}[1mb${E}[22mc${E}[0md${E}[38;5;200me${E}[48;2;1;2;3mf${E}[39;49mg${E}[4mh${E}[24mi`,
  },
  { name: "复合 SGR 拆开", node: `${E}[1;31;4ma${E}[0mb` },
  { name: "ESC[m 不关", node: `${E}[38;2;1;2;3md${E}[mE` },
  { name: "前景背景交错", node: `${E}[44ma${E}[31mb${E}[49mc${E}[0md` },
  { name: "粗体与暗共存", node: `${E}[1ma${E}[2mb${E}[22mc` },
  { name: "带样式的空格照写", node: `a${E}[4m ${E}[24mb${E}[7m c${E}[27m` },
  { name: "样式下的默认空白跳过不关样式", node: `${E}[1ma${E}[22m   ${E}[1mb` },
  { name: "样式结束后行尾空白", node: `${E}[1ma${E}[22m   ` },
  { name: "reset 后空白", node: `${E}[1;4ma${E}[0m b` },
  { name: "反色多行", node: `${E}[7mab\ncd${E}[27m` },
  { name: "反色只在首行", node: col(`${E}[7mab`, "cd") },
  { name: "未知 SGR", node: `${E}[53ma${E}[55m b${E}[5mc${E}[25m` },
  { name: "冒号子参数", node: `${E}[4:3ma${E}[58;5;1mb${E}[0m` },
  { name: "Box 背景色", node: box({ backgroundColor: "ansi:blue", width: 6 }, "ab") },
  { name: "反色尾随空格", node: text({ inverse: true }, "i  ") },

  // —— 超链接 ——
  {
    name: "链接改写成带 id",
    node: `${link("https://a.com", "lk")} ${link("https://b.org/x", "bb")}`,
  },
  { name: "相邻两个链接直接切换", node: `${link("http://x", "q")}${link("http://y", "w")}` },
  { name: "链接中间的空白", node: `${link("http://u", "a")}  ${link("http://u", "b")}` },
  { name: "带样式的链接", node: text({ color: "ansi:green" }, `x${link("http://x", "yy")}z`) },
  { name: "链接与 SGR 的先后", node: `${E}[31m${link("http://u", "a")}${E}[34mb` },
  {
    name: "链接与 SGR 换链接",
    node: `${E}[31m${E}]8;;http://u\x07a${E}[39m${E}]8;;http://v\x07b${E}]8;;\x07`,
  },
  { name: "行尾先关 SGR 后关链接", node: `${E}]8;;http://u\x07${E}[1m${E}[4mab` },
  { name: "已带 id 的链接原样", node: `${E}]8;id=foo;http://u\x07ab${E}]8;;\x07` },
  { name: "带参数的链接原样", node: `${E}]8;foo=bar;http://u\x07a${E}]8;;\x07` },
  { name: "ST 结尾的链接原样", node: `${E}]8;;http://u${E}\\ab${E}]8;;${E}\\` },
  { name: "空 url 链接", node: `${E}]8;;\x07a` },
  { name: "非 ASCII url", node: `${E}]8;;http://例え.jp/😀\x07a${E}]8;;\x07` },
  { name: "链接跨换行", node: box({ width: 4 }, link("http://x", "abcdefgh")) },
  { name: "链接跨 \\n", node: `${E}]8;;http://x\x07ab\ncd${E}]8;;\x07e` },

  // —— 宽字符与宽度补偿（R9）——
  { name: "CJK", node: "中文混排 ABC 一二三" },
  { name: "VS16 宽字符补偿", node: "a❤️b☀️c✔️d" },
  { name: "VS16 连续", node: "❤️❤️" },
  { name: "VS16 后跟空白", node: "❤️  x" },
  { name: "VS16 在行尾", node: "ab❤️" },
  { name: "keycap 与旗帜", node: "1️⃣|#️⃣|🏳️‍🌈|🇨🇳|👍🏽" },
  { name: "VS16 但窄", node: "a↔b©️c" },
  { name: "CJK 加 VS16", node: "a中️b" },
  { name: "孤立 VS16", node: "a️b" },
  { name: "补偿与样式", node: `${E}[31m❤️${E}[39mz` },
  { name: "补偿与链接", node: `${link("http://x", "❤️")}z` },
  { name: "ZWJ 家庭", node: "x👨‍👩‍👧y" },
  { name: "天城文连字", node: "aक्षb" },
  { name: "全角", node: "a　bＡc" },
  { name: "VS16 压在行尾列", cols: 6, node: "abcd❤️" },
  { name: "VS16 换到下一行", cols: 6, node: "abcde❤️" },

  // —— 零宽与控制字符 ——
  { name: "零宽空格与 ZWJ", node: "a​b‍c" },
  { name: "行首孤立附标", node: "́ab" },
  { name: "控制字符丢弃", node: "ab\x08c\x7fd\x00e" },
  { name: "非 SGR 的 CSI 被清理", node: `a\x07b${E}[2Kc${E}[5Ad` },
  { name: "非链接 OSC 丢弃", node: `a${E}]0;title\x07b${E}]2;t${E}\\c` },

  // —— Tab：按屏幕绝对列对齐到 8 ——
  { name: "tab", node: "a\tb" },
  { name: "tab 多个", node: "abcdefg\th\tz" },
  { name: "tab 行首", node: "\tx" },
  { name: "tab 在偏移后", node: box({ marginLeft: 3 }, "ab\tc") },
  { name: "tab 前有兄弟", node: row("xyz", "a\tb") },
  { name: "tab 带样式", node: `${E}[7ma\tb${E}[27m` },

  // —— 裁剪与覆盖（T4：不留孤立 spacer）——
  {
    name: "裁剪右边界压宽字符",
    node: box({ width: 3, overflow: "hidden" }, box({ width: 10, flexShrink: 0 }, "ab中x")),
  },
  {
    name: "裁剪右边界后有兄弟",
    node: row(
      box({ width: 3, overflow: "hidden" }, box({ width: 10, flexShrink: 0 }, "ab中x")),
      "|",
    ),
  },
  {
    name: "裁剪左边界压宽字符",
    node: row(
      "[",
      box(
        { width: 4, overflow: "hidden" },
        box({ width: 10, flexShrink: 0, marginLeft: -1 }, "中文ab"),
      ),
      "]",
    ),
  },
  {
    name: "裁剪带样式",
    node: box(
      { width: 3, overflow: "hidden" },
      box({ width: 10, flexShrink: 0 }, `${E}[7mab中x${E}[27m`),
    ),
  },
  {
    name: "屏幕右边界压宽字符",
    cols: 12,
    node: row(box({ width: 11, flexShrink: 0 }, "."), box({ width: 4, flexShrink: 0 }, "中x")),
  },
  { name: "宽字符被挤到 1 列", node: row(box({ width: 1 }, "中"), "|") },
  { name: "截断末尾宽字符", node: box({ width: 5 }, text({ wrap: "truncate-end" }, "ab中文字")) },
  {
    name: "截断中间",
    node: box({ width: 12 }, text({ wrap: "truncate-middle" }, "很长的中文路径/目录/文件名.ts")),
  },
  {
    name: "覆盖宽字符右半格",
    node: box({ width: 10, height: 1 }, abs(0, "中文中文"), abs(1, "X")),
  },
  {
    name: "覆盖宽字符左半格",
    node: box({ width: 10, height: 1 }, abs(0, "中文中文"), abs(2, "Y")),
  },
  { name: "宽字符覆盖窄字符", node: box({ width: 10, height: 1 }, abs(0, "abcdef"), abs(1, "中")) },
  {
    name: "宽字符错位覆盖",
    node: box(
      { width: 10, height: 1 },
      abs(0, text({ color: "ansi:red" }, "中文中文")),
      abs(3, "中"),
    ),
  },
  {
    name: "覆盖带背景的宽字符",
    node: box({ width: 10, height: 1 }, abs(0, `${E}[44m中文中文${E}[49m`), abs(1, "X")),
  },
  {
    name: "覆盖带背景的宽字符 2",
    node: box({ width: 10, height: 1 }, abs(0, `${E}[44m中文中文${E}[49m`), abs(2, "Y")),
  },

  // —— 布局里的常见形态 ——
  { name: "圆角边框", node: box({ borderStyle: "round", width: 12, paddingX: 1 }, "你好 ok") },
  {
    name: "边框颜色",
    node: box({ borderStyle: "single", borderColor: "ansi:cyan", width: 8 }, "x"),
  },
  { name: "CJK 换行", node: box({ width: 7 }, "你好世界abcdef一二三") },
  { name: "反色换行", node: box({ width: 4 }, `${E}[7mabcdefgh${E}[27m`) },
  {
    name: "行内多段 Text",
    node: row(text({ color: "ansi:red" }, "a"), " ", text({ color: "ansi:red" }, "b")),
  },
];

/** bidi 只在需要软件重排的终端上生效（模块加载时判定），单独一组环境跑。 */
export const BIDI_CORPUS: CorpusCase[] = [
  { name: "RTL 混排", node: "RTL: שלום עולם mixed" },
  { name: "RTL 带样式", node: `${E}[31mab ${E}[1mשלום${E}[22m cd${E}[39m` },
  { name: "RTL 换行", cols: 9, node: "RTL: שלום עולם mixed" },
];

/** kitty 下超链接终止符换成 ST（与 OSC 工具同一判定）。 */
export const KITTY_CORPUS: CorpusCase[] = [
  { name: "kitty 链接", node: `${link("http://u", "c")} ${E}]8;id=foo;http://v\x07d${E}]8;;\x07` },
  { name: "kitty 补偿与链接", node: `${link("http://x", "❤️")}z` },
];

/** 三组环境：每组在独立子进程里跑（终端判定都在模块加载时）。 */
export const CORPUS_ENVS: Record<string, { env: Record<string, string>; cases: CorpusCase[] }> = {
  default: { env: {}, cases: SCREEN_CORPUS },
  bidi: { env: { WT_SESSION: "screen-vectors" }, cases: BIDI_CORPUS },
  kitty: { env: { KITTY_WINDOW_ID: "1" }, cases: KITTY_CORPUS },
};

/** 子进程的干净环境：终端识别类变量清掉，颜色固定真彩。 */
export function cleanEnv(extra: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  const drop = new Set([
    "TERM_PROGRAM",
    "TMUX",
    "STY",
    "KITTY_WINDOW_ID",
    "WT_SESSION",
    "LC_TERMINAL",
    "VTE_VERSION",
    "SSH_CONNECTION",
    "NO_COLOR",
    "FORCE_COLOR",
    "COLORTERM",
    "SID_TUI_RENDERER",
  ]);
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !drop.has(k)) out[k] = v;
  return { ...out, TERM: "xterm-256color", FORCE_COLOR: "3", ...extra };
}

/** 用给定的 React 与 Box / Text 把 DSL 建成元素树。两边各自传入自己的组件。 */
export function buildTree(
  React: typeof import("react"),
  Box: React.ComponentType<any>,
  Text: React.ComponentType<any>,
  node: CorpusNode,
  key?: number,
): React.ReactElement {
  if (typeof node === "string") return React.createElement(Text, { key }, node);
  if ("box" in node) {
    return React.createElement(
      Box,
      { ...node.box, key },
      ...node.children.map((c, i) => buildTree(React, Box, Text, c, i)),
    );
  }
  return React.createElement(
    Text,
    { ...node.text, key },
    ...node.children.map((c, i) => (typeof c === "string" ? c : buildTree(React, Box, Text, c, i))),
  );
}
