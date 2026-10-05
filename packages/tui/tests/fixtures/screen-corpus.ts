/**
 * 屏幕缓冲对拍语料（B9 / T3.1，契约 R3 / R9 / T3 / T4）。
 *
 * 纯数据：生成器（scripts/tui-screen-vectors.ts）用旧底座把它渲染成首帧字节，
 * 测试（tests/screen.test.ts）用新底座渲染同一棵树再序列化，逐字节比较。
 * 这个文件不 import 任何底座，所以两边共用它不会让测试间接依赖旧底座。
 *
 * 节点 DSL：字符串 = `<Text>` 内容；`{box, children}` = `<Box>`；`{text, children}` = 带 props 的 `<Text>`；
 * `{ansi, props}` = `<Ansi>`；`{raw, width}` = `<RawAnsi>`（T4.1）。
 * 加条目时在注释里写清楚它钉住哪条规则。
 */
const E = "\x1b";
const link = (url: string, text: string) => `${E}]8;;${url}\x07${text}${E}]8;;\x07`;

export type CorpusNode =
  | string
  | { box: Record<string, unknown>; children: CorpusNode[] }
  | { text: Record<string, unknown>; children: (string | CorpusNode)[] }
  | { ansi: string; props?: Record<string, unknown> }
  | { raw: string[]; width: number };

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
const ansi = (s: string, props?: Record<string, unknown>): CorpusNode => ({ ansi: s, props });
const raw = (width: number, ...lines: string[]): CorpusNode => ({ raw: lines, width });
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
  // —— T4.1：Text 样式 props 的组合顺序（字节由叠加顺序决定）——
  { name: "Text italic", node: text({ italic: true }, "i") },
  { name: "Text underline", node: text({ underline: true }, "u") },
  { name: "Text strikethrough", node: text({ strikethrough: true }, "s") },
  { name: "Text inverse", node: text({ inverse: true }, "v") },
  { name: "Text backgroundColor", node: text({ backgroundColor: "ansi:blue" }, "b") },
  { name: "Text dimColor", node: text({ dimColor: true }, "d") },
  { name: "Text dim", node: text({ dim: true }, "d") },
  {
    name: "Text 全部样式",
    node: text(
      {
        color: "ansi:red",
        backgroundColor: "ansi:blue",
        bold: true,
        italic: true,
        underline: true,
        strikethrough: true,
        inverse: true,
      },
      "all",
    ),
  },
  {
    name: "Text 颜色 + 粗体 + 背景（hex）",
    node: text({ color: "#00ff00", backgroundColor: "#102030", bold: true }, "g"),
  },
  { name: "Text 粗体 + 下划线", node: text({ bold: true, underline: true }, "bu") },
  { name: "Text 斜体 + 删除线", node: text({ italic: true, strikethrough: true }, "is") },
  {
    name: "嵌套 Text 内层改色",
    node: text({ color: "ansi:red" }, "a", text({ color: "ansi:green" }, "b"), "c"),
  },
  {
    name: "嵌套 Text 内层加粗",
    node: text({ color: "ansi:red" }, "a", text({ bold: true }, "b"), "c"),
  },
  {
    name: "嵌套 Text 外层反色",
    node: text({ inverse: true }, "a", text({ underline: true }, "b")),
  },
  {
    name: "Box 背景色继承到 Text",
    node: box({ backgroundColor: "ansi:blue", width: 6 }, text({ color: "ansi:red" }, "ab")),
  },
  {
    name: "Box 背景色被 Text 背景覆盖",
    node: box(
      { backgroundColor: "ansi:blue", width: 6 },
      text({ backgroundColor: "ansi:red" }, "ab"),
    ),
  },
  { name: "Text 未知颜色名", node: text({ color: "ansi:gray" }, "g") },
  { name: "Text 换行带样式", node: box({ width: 3 }, text({ underline: true }, "abcdef")) },
  {
    name: "Text 截断带样式",
    node: box({ width: 4 }, text({ bold: true, wrap: "truncate-end" }, "abcdef")),
  },
  { name: "Text 内嵌 SGR 与 props", node: text({ bold: true }, `a${E}[31mb${E}[39mc`) },

  // —— T4.1：Ansi ——
  { name: "Ansi 基本", node: ansi(`${E}[31mred${E}[0m plain`) },
  { name: "Ansi 复合与 reset", node: ansi(`${E}[1;4;31mx${E}[0my${E}[7mz${E}[27m`) },
  { name: "Ansi 256 与真彩", node: ansi(`${E}[38;5;200ma${E}[48;2;1;2;3mb${E}[0mc`) },
  { name: "Ansi 亮色", node: ansi(`${E}[91ma${E}[102mb${E}[0m`) },
  { name: "Ansi 粗体与暗", node: ansi(`${E}[1ma${E}[2mb${E}[22mc`) },
  { name: "Ansi 暗", node: ansi(`${E}[2mdim${E}[22m n`) },
  { name: "Ansi 斜体删除线", node: ansi(`${E}[3ma${E}[9mb${E}[23mc${E}[29md`) },
  { name: "Ansi 下划线变体", node: ansi(`${E}[4:3ma${E}[21mb${E}[24mc`) },
  { name: "Ansi 多行", node: ansi(`${E}[32mab\ncd${E}[0m\nef`) },
  { name: "Ansi 换行", node: box({ width: 4 }, ansi(`${E}[35mabcdefgh${E}[0m`)) },
  { name: "Ansi 链接", node: ansi(`x${link("https://a.com", "lk")}y`) },
  { name: "Ansi 带样式的链接", node: ansi(`${E}[31m${link("http://u", "ab")}c${E}[0m`) },
  { name: "Ansi dimColor", node: ansi(`${E}[31mr${E}[0m p`, { dimColor: true }) },
  { name: "Ansi dimColor 遇粗体", node: ansi(`${E}[1mb${E}[22m p`, { dimColor: true }) },
  { name: "Ansi 空串", node: col("a", ansi(""), "b") },
  { name: "Ansi 无样式", node: ansi("plain text") },
  { name: "Ansi CJK 与 emoji", node: ansi(`${E}[33m中文❤️${E}[0mz`) },
  {
    name: "Ansi 在行内",
    node: row(text({ color: "ansi:red" }, "["), ansi(`${E}[1mb${E}[0m`), "]"),
  },
  { name: "Ansi 非 SGR 控制序列", node: ansi(`a${E}[2Kb${E}]0;t\x07c`) },
  { name: "Ansi 空行", node: ansi("a\n\nb") },
  { name: "Ansi tab", node: ansi(`a\t${E}[1mb${E}[0m`) },
  { name: "Ansi 未闭合样式", node: col(ansi(`${E}[31mopen`), "next") },

  // —— T4.1：RawAnsi ——
  { name: "RawAnsi 基本", node: col(raw(5, `${E}[32mgreen${E}[0m`, "x")) },
  { name: "RawAnsi 空 lines", node: col("a", raw(5), "b") },
  { name: "RawAnsi 宽度大于内容", node: row(raw(6, "ab"), "|") },
  { name: "RawAnsi 宽度小于内容", node: row(raw(2, "abcd"), "|") },
  { name: "RawAnsi 背景色行", node: col(raw(4, `${E}[44mab  ${E}[49m`, `${E}[41mcd${E}[49m`)) },
  { name: "RawAnsi CJK", node: col(raw(6, "中文ab", "x")) },
  { name: "RawAnsi 链接", node: col(raw(4, link("http://x", "ab"))) },
  {
    name: "RawAnsi 在边框里",
    node: box({ borderStyle: "round", width: 7 }, raw(5, "ab", `${E}[1mcd${E}[22m`)),
  },
  { name: "RawAnsi 后有兄弟", node: col(raw(3, "a", "b"), "c") },
  { name: "RawAnsi 未闭合样式", node: col(raw(3, `${E}[31mab`), "c") },
  { name: "RawAnsi 空行", node: col(raw(3, "a", "", "b")) },
  { name: "RawAnsi 在窄容器里", node: box({ width: 4 }, raw(10, "abcdefghij"), "|") },
  {
    name: "RawAnsi 在裁剪容器里",
    node: row(box({ width: 3, overflow: "hidden" }, raw(6, "abcdef")), "|"),
  },
  { name: "RawAnsi 列方向后跟兄弟", node: col(box({ width: 4 }, raw(8, "abcdefgh")), "z") },
  { name: "RawAnsi 偏移", node: box({ paddingLeft: 2 }, raw(3, "ab", "cd")) },
  { name: "RawAnsi tab", node: col(raw(10, "a\tb")) },
  { name: "RawAnsi 非 SGR 序列", node: col(raw(5, `a${E}[2Kb${E}]0;t\x07c`)) },
  { name: "RawAnsi 带换行符", node: col(raw(5, "ab\ncd"), "z") },

  // —— T4.1：Ansi 解析的边角 ——
  { name: "Ansi 暗后粗体", node: ansi(`${E}[2ma${E}[1mb${E}[22mc`) },
  { name: "Ansi 22 同时关粗体与暗", node: ansi(`${E}[1;2ma${E}[22mb`) },
  { name: "Ansi 39 / 49", node: ansi(`${E}[31;44ma${E}[39mb${E}[49mc`) },
  { name: "Ansi ESC[m", node: ansi(`${E}[31ma${E}[mb`) },
  { name: "Ansi 0;1", node: ansi(`${E}[31ma${E}[0;1mb${E}[0m`) },
  { name: "Ansi 标准前景 30-37", node: ansi(`${E}[30ma${E}[33mb${E}[37mc${E}[0m`) },
  { name: "Ansi 标准背景 40-47 与亮背景", node: ansi(`${E}[40ma${E}[47mb${E}[100mc${E}[0m`) },
  { name: "Ansi 38;5 低位", node: ansi(`${E}[38;5;1ma${E}[38;5;9mb${E}[48;5;15mc${E}[0m`) },
  { name: "Ansi 38;2", node: ansi(`${E}[38;2;10;20;30ma${E}[0m`) },
  { name: "Ansi 未知 SGR", node: ansi(`${E}[5ma${E}[53mb${E}[8mc${E}[0md`) },
  { name: "Ansi 反色关", node: ansi(`${E}[7;4ma${E}[27mb${E}[24mc`) },
  { name: "Ansi dimColor 已有暗", node: ansi(`${E}[2ma${E}[22mb`, { dimColor: true }) },
  { name: "Ansi dimColor 多样式", node: ansi(`${E}[4;44ma${E}[0mb`, { dimColor: true }) },
  { name: "Ansi 在 Text 里", node: text({ color: "ansi:red" }, "x") },
  { name: "Text bold + dim", node: text({ bold: true, dim: true }, "x") },
  { name: "Text dim + color", node: text({ dim: true, color: "ansi:red" }, "x") },
  { name: "Text dimColor + color", node: text({ dimColor: true, color: "ansi:red" }, "x") },
  {
    name: "Text color ansi256 / rgb",
    node: row(text({ color: "ansi256(200)" }, "a"), text({ color: "rgb(1,2,3)" }, "b")),
  },
  { name: "Text 空字符串", node: col("a", text({}, ""), "b") },
  { name: "Text 多段字符串子节点", node: text({}, "n=", "3") },
  { name: "Ansi 冒号颜色", node: ansi(`${E}[38:5:200ma${E}[38:2::1:2:3mb${E}[0mc`) },
  { name: "Ansi 4:0 关下划线", node: ansi(`${E}[4ma${E}[4:0mb`) },
  { name: "Ansi 2;1 同一序列", node: ansi(`${E}[2;1ma${E}[0m`) },
  { name: "Ansi 隐藏与闪烁", node: ansi(`${E}[8ma${E}[28mb${E}[25mc`) },
  { name: "Ansi 越界 256 色", node: ansi(`${E}[38;5;300ma${E}[0mb`) },
  { name: "Ansi 不完整 38", node: ansi(`${E}[38;5ma${E}[38;2;1mb${E}[31mc${E}[0m`) },
  { name: "Ansi 默认颜色后续样式", node: ansi(`${E}[31;1ma${E}[39mb${E}[0m`) },
  { name: "Ansi 链接无支持带样式", node: ansi(`${E}]8;;http://u${E}\\a${E}]8;;${E}\\b`) },
  { name: "RawAnsi 空 lines 在行内", node: row("[", raw(3), "]") },

  // —— T4.1：Box props（SURFACE.md §2，字节级）——
  {
    name: "Box maxHeight",
    node: col(box({ maxHeight: 2, flexDirection: "column" }, "a", "b", "c"), "z"),
  },
  { name: "Box minWidth", node: row(box({ minWidth: 4 }, "a"), "|") },
  {
    name: "Box alignSelf",
    node: box({ height: 3, alignItems: "flex-end" }, box({ alignSelf: "flex-start" }, "a"), "b"),
  },
  { name: "Box flexWrap", node: box({ width: 4, flexWrap: "wrap" }, "ab", "cd", "ef") },
  {
    name: "Box justifyContent space-between",
    node: box({ width: 8, justifyContent: "space-between" }, "a", "b", "c"),
  },
  {
    name: "Box alignItems center",
    node: box({ height: 3, alignItems: "center" }, "a", col("b", "c", "d")),
  },
  {
    name: "Box height 100%",
    node: box({ height: 3 }, box({ height: "100%", borderStyle: "single" }, "x")),
  },
  {
    name: "Box width 百分比",
    node: box({ width: 10 }, box({ width: "50%", backgroundColor: "ansi:red" }, "a"), "b"),
  },
  {
    name: "Box flexGrow",
    node: box({ width: 8 }, box({ flexGrow: 1, backgroundColor: "ansi:blue" }, "a"), "b"),
  },
  {
    name: "Box 边框只留左边",
    node: box(
      {
        borderStyle: "single",
        borderTop: false,
        borderBottom: false,
        borderRight: false,
        borderColor: "ansi:green",
        paddingLeft: 1,
      },
      "x",
    ),
  },
  {
    name: "Box 边框加背景",
    node: box({ borderStyle: "round", backgroundColor: "ansi:blue", width: 5 }, "a"),
  },
  {
    name: "Box overflowX hidden",
    node: row(box({ width: 3, overflowX: "hidden" }, box({ flexShrink: 0 }, "abcdef")), "|"),
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

/** 终端支持超链接时 Ansi 里的 OSC 8 怎么走（T4.1）。 */
export const HYPERLINK_CORPUS: CorpusCase[] = [
  { name: "Ansi 链接", node: ansi(`x${link("https://a.com", "lk")}y`) },
  { name: "Ansi 带样式的链接", node: ansi(`${E}[31m${link("http://u", "ab")}c${E}[0m`) },
  { name: "Ansi 带 id 的链接", node: ansi(`${E}]8;id=foo;http://u\x07ab${E}]8;;\x07c`) },
  { name: "Ansi 链接跨行", node: box({ width: 3 }, ansi(link("http://x", "abcdef"))) },
  { name: "Text 里的链接", node: `x${link("https://a.com", "lk")}y` },
  { name: "Ansi 链接中途 reset", node: ansi(`${E}]8;;http://u\x07${E}[1ma${E}[0mb${E}]8;;\x07c`) },
];

/** 各组环境：每组在独立子进程里跑（终端判定都在模块加载时）。 */
export const CORPUS_ENVS: Record<string, { env: Record<string, string>; cases: CorpusCase[] }> = {
  default: { env: {}, cases: SCREEN_CORPUS },
  bidi: { env: { WT_SESSION: "screen-vectors" }, cases: BIDI_CORPUS },
  kitty: { env: { KITTY_WINDOW_ID: "1" }, cases: KITTY_CORPUS },
  hyperlinks: { env: { TERM_PROGRAM: "iTerm.app" }, cases: HYPERLINK_CORPUS },
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

/** 两边各自传入自己的宿主组件（Ansi / RawAnsi 只有 T4.1 起的语料用到）。 */
export type CorpusComponents = {
  Box: React.ComponentType<any>;
  Text: React.ComponentType<any>;
  Ansi?: React.ComponentType<any>;
  RawAnsi?: React.ComponentType<any>;
};

/** 用给定的 React 与宿主组件把 DSL 建成元素树。 */
export function buildTree(
  React: typeof import("react"),
  C: CorpusComponents,
  node: CorpusNode,
  key?: number,
): React.ReactElement {
  if (typeof node === "string") return React.createElement(C.Text, { key }, node);
  if ("box" in node) {
    return React.createElement(
      C.Box,
      { ...node.box, key },
      ...node.children.map((c, i) => buildTree(React, C, c, i)),
    );
  }
  if ("ansi" in node) {
    if (!C.Ansi) throw new Error("语料用到 Ansi，但没有传入");
    return React.createElement(C.Ansi, { ...node.props, key }, node.ansi);
  }
  if ("raw" in node) {
    if (!C.RawAnsi) throw new Error("语料用到 RawAnsi，但没有传入");
    return React.createElement(C.RawAnsi, { lines: node.raw, width: node.width, key });
  }
  return React.createElement(
    C.Text,
    { ...node.text, key },
    ...node.children.map((c, i) => (typeof c === "string" ? c : buildTree(React, C, c, i))),
  );
}
