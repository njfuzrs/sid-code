#!/usr/bin/env bun
/**
 * 从旧底座生成文本工具的测试向量（B9 / T2.1，契约 T1 / T2 / T3）。
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
  };
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
