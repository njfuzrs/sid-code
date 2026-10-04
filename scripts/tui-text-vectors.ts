#!/usr/bin/env bun
/**
 * 从旧底座生成文本工具的测试向量（B9 / T2.1 契约 T1 / T2 / T3；T2.2 颜色与 styled-chars，契约 T6）。
 *
 * 新底座的文本工具是对着这份向量写、对着这份向量测的：旧底座只回答「输出应该是什么」，
 * 不提供实现（设计文档 D-5）。向量入库，所以 T9 删掉旧底座之后测试照样能跑；
 * 只有想扩充语料时才需要旧底座在场重新生成。
 *
 * 用法：
 *   bun run tui:text-vectors          # 重新生成 packages/tui/tests/fixtures/text-vectors.json
 *   bun run tui:text-vectors --check  # 只比对，不一致退 1（旧底座行为变了，或语料改了没重生成）
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// bidi 只在「终端不自己做 bidi」时生效，判定在旧底座模块首次调用时缓存。
// 生成向量时强制打开，才能拿到重排结果；「不需要时原样返回」由新底座测试单独覆盖。
process.env.WT_SESSION = "tui-text-vectors";

const ROOT = resolve(import.meta.dir, "..");
const OUT = join(ROOT, "packages/tui/tests/fixtures/text-vectors.json");

const { stringWidth } = await import("../packages/tui-renderer/src/stringWidth.ts");
const { default: wrapText } = await import("../packages/tui-renderer/src/wrap-text.ts");
const { reorderBidi } = await import("../packages/tui-renderer/src/bidi.ts");
const colorizeMod = await import("../packages/tui-renderer/src/colorize.ts");
const styled = await import("../packages/tui-renderer/src/_vendor/styled-chars.ts");
const { default: chalk } = await import("chalk");

/** 换行 / 截断语料：每条都对应一类对拍时发现过的差异，加新条目时写清楚为什么。 */
export const WRAP_CORPUS = [
  "你好世界abcdef一二三四五", // CJK 不劈半
  "hello world foo bar baz", // 普通断词
  "a😀b👨‍👩‍👧c❤️d", // emoji / ZWJ 序列 / VS16
  "\x1b[31mred 中文 text\x1b[0m tail", // SGR 跨截断点，reset 之后的文本
  "  leading  spaces  ", // trim 与否
  "é́ combining", // 组合附标
  "一二三四五六七八九十", // 宽 1 时 CJK
  "word-with-dash and more",
  "tab\there", // \t 零宽且原样保留
  "line1\nline2 long long", // \n 原样保留
  "\x1b]8;;http://x\x07link text here\x1b]8;;\x07 after", // OSC 8 超链接
  "\x1b[1mbold\x1b[22m and \x1b[38;5;200mcolor 中\x1b[39m", // 256 色 + 粗体
  "中a中a中a中a", // 宽窄交替，右边界压宽字符
  "\x1b[4munder\x1b[24m中\x1b[7mrev\x1b[27m",
  "",
  "x",
  "ab\x1b[31m", // 末尾悬空的 SGR
  "\x1b[32mx\x1b[0m\x1b[33my\x1b[0m",
  "क्ष क्ष abc", // 天城文连字：终端占 2 格
];
export const WRAP_MODES = [
  "wrap",
  "wrap-trim",
  "truncate",
  "truncate-end",
  "truncate-middle",
  "truncate-start",
  "end", // 历史值：旧底座原样返回
  "middle",
];
export const MAX_COLUMNS = 20;

/** 宽度：多码位序列（单码位走全码位扫描）。 */
export const WIDTH_SEQUENCES = [
  "👨‍👩‍👧",
  "🏳️‍🌈",
  "👍🏽",
  "🇨🇳",
  "1️⃣",
  "❤️",
  "क्ष",
  "é",
  "a‍b",
  "ﾊﾟ",
  "\x1b[31mab\x1b[0m",
  "\x1b]8;;http://x\x07ab\x1b]8;;\x07",
  "中文ab",
  "tab\there",
];

export const BIDI_CORPUS = [
  "ab שלום cd",
  "שלום",
  "abc",
  "مرحبا 123 x",
  "(שלום) [x]", // 括号不镜像
  "שָׁלוֹם ab", // 希伯来文附标跟着基字符
  "abc 123 שלום 456 def",
  "שלום abc עולם",
  "中文 שלום 😀",
  "مرحبا، عالم! 1.5%",
  "x́ שלוםְ",
];

/** 颜色写法：每种合法写法一条，加上对拍时确认过「原样返回」的边界。 */
export const COLORS = [
  "ansi:red",
  "ansi:blueBright",
  "ansi:whiteBright",
  "ansi:gray", // chalk 有 gray 属性，但不在 16 色名单里
  "ansi:bold", // chalk 的样式名，不是颜色
  "ansi:constructor",
  "ansi:",
  "ANSI:red",
  "red", // 裸名：端口 Color 类型要求 ansi: 前缀
  "#ff8800",
  "#f80",
  "#",
  "#zzz",
  "  #ff0000",
  "rgb(1,2,3)",
  "rgb( 1, 2, 3 )",
  "rgb(300,0,0)",
  "rgb(1.5,2,3)",
  "rgb(1,2,3) ",
  "ansi256(200)",
  "ansi256( 5 )",
  "ansi256(999)",
  "ansi256(-1)",
  "ansi256(5)x",
  "",
];

export const TEXT_STYLES = [
  { bold: true },
  { dim: true },
  { italic: true },
  { underline: true },
  { strikethrough: true },
  { inverse: true },
  { bold: true, dim: true },
  { color: "#ff0000", backgroundColor: "ansi:blue", bold: true, inverse: true, underline: true },
  {
    bold: true,
    dim: true,
    italic: true,
    underline: true,
    strikethrough: true,
    inverse: true,
    color: "ansi:red",
    backgroundColor: "rgb(1,2,3)",
  },
  { bold: false },
  {},
];

/** 颜色输入的文本：普通、空串、多行、已带样式。 */
export const COLOR_TEXTS = ["ab", "", "a\nb", "\x1b[31mx\x1b[39m"];

/**
 * 颜色级别修正的环境矩阵（与 chalk 自动探测出的初始级别组合）。
 * 每条在子进程里跑旧底座，记录修正后的 chalk.level。
 */
export const LEVEL_ENVS: Record<string, string>[] = [
  { FORCE_COLOR: "0" },
  { FORCE_COLOR: "1" },
  { FORCE_COLOR: "2" },
  { FORCE_COLOR: "3" },
  { FORCE_COLOR: "1", TERM_PROGRAM: "vscode" },
  { FORCE_COLOR: "2", TERM_PROGRAM: "vscode" },
  { FORCE_COLOR: "3", TERM_PROGRAM: "vscode" },
  { FORCE_COLOR: "2", TERM_PROGRAM: "VSCode" }, // 区分大小写
  { FORCE_COLOR: "2", TMUX: "x" },
  { FORCE_COLOR: "3", TMUX: "x" },
  { FORCE_COLOR: "3", TMUX: "" }, // 空 TMUX 不算
  { FORCE_COLOR: "3", TMUX: "x", CLAUDE_CODE_TMUX_TRUECOLOR: "1" },
  { FORCE_COLOR: "3", TMUX: "x", CLAUDE_CODE_TMUX_TRUECOLOR: "0" }, // 任意非空都算开
  { FORCE_COLOR: "3", TMUX: "x", CLAUDE_CODE_TMUX_TRUECOLOR: "" },
  { FORCE_COLOR: "2", TMUX: "x", TERM_PROGRAM: "vscode" }, // 先升后降
  { FORCE_COLOR: "3", TERM: "tmux-256color" }, // 只看 TMUX，不看 TERM
];

/** 旧底座在给定环境下修正后的 chalk.level（子进程，模块加载时判定）。 */
function levelUnder(env: Record<string, string>): number {
  const clean = { ...process.env };
  for (const k of [
    "TMUX",
    "TERM_PROGRAM",
    "COLORTERM",
    "FORCE_COLOR",
    "NO_COLOR",
    "TERM",
    "CLAUDE_CODE_TMUX_TRUECOLOR",
  ])
    delete clean[k];
  const code = `await import(${JSON.stringify(join(ROOT, "packages/tui-renderer/src/colorize.ts"))});
    const { default: chalk } = await import("chalk"); process.stdout.write(String(chalk.level));`;
  const r = Bun.spawnSync([process.execPath, "-e", code], { env: { ...clean, ...env }, cwd: ROOT });
  const out = r.stdout.toString().trim();
  if (!/^[0-3]$/.test(out)) throw new Error(`子进程没给出级别：${out} ${r.stderr.toString()}`);
  return Number(out);
}

/** styled-chars 语料：每条都对应一类对拍时确认过的边界。 */
export const STYLED_CORPUS = [
  "\x1b[31mhello\x1b[39m 中文 world  x",
  "ab cdefgh", // 词放不下但不超行宽 → 换行；超行宽 → 硬折并先填满当前行
  "a 中文中",
  "中文中",
  "abcdef ghi",
  "  ab", // 行首空白丢掉
  "ab  ", // 行尾空白放不下 → 换行且丢掉，留一个空行
  "a  b",
  "a\tb c", // \t 算空白
  "\t\tab cd",
  "ab \tcd",
  "a\t b",
  "a\nb", // \n 不是空白，属于词
  "\nab cd",
  "ab\n",
  "a\u3000b c", // 全角空格不是空白
  "a\u00a0b", // 不换行空格不是空白
  "é́ab cd", // 组合附标
  "ab\u0301 c",
  "\u0301中",
  "x 😀😀",
  "क्ष क्ष", // tokenizer 报窄，实占 2 格
  "\x1b[31m  ab\x1b[39m",
  "\x1b]8;;http://x\x07link text\x1b]8;;\x07 after",
  " ",
  "  ",
  "",
];
export const STYLED_COLUMNS = [-1, 0, 1, 2, 3, 4, 5, 6, 8, 12];

/** 全码位宽度压成游程：[起始码位, 宽度]，宽度变化处开一段。代理区跳过（单独的代理不是合法字符）。 */
function widthRuns(): [number, number][] {
  const runs: [number, number][] = [];
  let prev = Number.NaN;
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const w = stringWidth(String.fromCodePoint(cp));
    if (w !== prev) {
      runs.push([cp, w]);
      prev = w;
    }
  }
  return runs;
}

const segmenter = new Intl.Segmenter();
export function clusters(text: string) {
  return [...segmenter.segment(text)].map((s, i) => ({
    value: s.segment,
    width: 1,
    styleId: i,
    hyperlink: undefined,
  }));
}

function build() {
  return {
    _comment: "由 scripts/tui-text-vectors.ts 从旧底座生成，勿手改。",
    width: {
      codepointRuns: widthRuns(),
      sequences: WIDTH_SEQUENCES.map((s) => [s, stringWidth(s)]),
    },
    wrap: WRAP_CORPUS.map((text) => ({
      text,
      // out[mode][columns]
      out: Object.fromEntries(
        WRAP_MODES.map((mode) => [
          mode,
          Array.from({ length: MAX_COLUMNS + 1 }, (_, c) => wrapText(text, c, mode as "wrap")),
        ]),
      ),
    })),
    // 结果是簇序号的排列（styleId 即原下标）
    bidi: BIDI_CORPUS.map((text) => [text, reorderBidi(clusters(text)).map((c) => c.styleId)]),
    color: buildColor(),
    styledChars: STYLED_CORPUS.map((text) => {
      const chars = styled.toStyledCharacters(text);
      return {
        text,
        chars,
        width: styled.styledCharsWidth(chars),
        words: styled.wordBreakStyledChars(chars).map((w) => w.map((c) => chars.indexOf(c))),
        // 换行结果记字符下标：同时钉住「返回输入里的同一批对象」
        wrap: Object.fromEntries(
          STYLED_COLUMNS.map((c) => {
            const lines = styled.wrapStyledChars(chars, c);
            return [
              c,
              {
                lines: lines.map((l) => l.map((ch) => chars.indexOf(ch))),
                widest: styled.widestLineFromStyledChars(lines),
              },
            ];
          }),
        ),
      };
    }),
  };
}

/** 颜色：四个 chalk 级别下的 colorize（前景 / 背景）、applyColor、applyTextStyles，以及级别修正矩阵。 */
function buildColor() {
  const saved = chalk.level;
  const byLevel: Record<string, unknown> = {};
  for (const level of [0, 1, 2, 3] as const) {
    chalk.level = level;
    byLevel[level] = {
      foreground: COLOR_TEXTS.map((t) =>
        COLORS.map((c) => colorizeMod.colorize(t, c, "foreground")),
      ),
      background: COLOR_TEXTS.map((t) =>
        COLORS.map((c) => colorizeMod.colorize(t, c, "background")),
      ),
      applyColor: COLORS.map((c) => colorizeMod.applyColor("ab", c as never)),
      undefinedColor: [
        colorizeMod.colorize("ab", undefined, "foreground"),
        colorizeMod.applyColor("ab", undefined),
      ],
      textStyles: COLOR_TEXTS.map((t) =>
        TEXT_STYLES.map((st) => colorizeMod.applyTextStyles(t, st as never)),
      ),
    };
  }
  chalk.level = saved;
  return { byLevel, levels: LEVEL_ENVS.map((env) => [env, levelUnder(env)]) };
}

if (import.meta.main) {
  const json = `${JSON.stringify(build(), null, 1)}\n`;
  if (process.argv.includes("--check")) {
    const cur = readFileSync(OUT, "utf8");
    if (cur !== json) {
      console.error(
        "text-vectors.json 与旧底座当前行为不一致：跑 bun run tui:text-vectors 重新生成并 review 差异",
      );
      process.exit(1);
    }
    console.log("text-vectors.json 与旧底座一致");
  } else {
    writeFileSync(OUT, json);
    console.log(`写入 ${OUT}（${json.length} 字节）`);
  }
}
