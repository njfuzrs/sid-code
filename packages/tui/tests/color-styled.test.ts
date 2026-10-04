/**
 * 新底座颜色与 styled-chars 对拍旧底座生成的向量（B9 / T2.2，契约 T6 + 端口 text.ts 的颜色三函数）。
 * 向量由 `bun run tui:text-vectors` 生成，这里不 import 旧底座。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import chalk from "chalk";
import vectors from "./fixtures/text-vectors.json";
import { adjustColorLevel, applyColor, applyTextStyles, colorize } from "../src/colorize.ts";
import {
  styledCharsWidth,
  toStyledCharacters,
  widestLineFromStyledChars,
  wordBreakStyledChars,
  wrapStyledChars,
} from "../src/text/styled-chars.ts";

// 输入随向量一起入库，不 import 生成器（它顶层 import 旧底座，T9 删掉旧底座后会挂）
const {
  colors: COLORS,
  texts: COLOR_TEXTS,
  styles: TEXT_STYLES,
} = vectors.color.inputs as { colors: string[]; texts: string[]; styles: object[] };

type ByLevel = {
  foreground: string[][];
  background: string[][];
  applyColor: string[];
  undefinedColor: string[];
  textStyles: string[][];
};

describe("colorize / applyColor / applyTextStyles 对拍旧底座（chalk 级别 0–3）", () => {
  const saved = chalk.level;
  afterAll(() => {
    chalk.level = saved;
  });
  const byLevel = vectors.color.byLevel as Record<string, ByLevel>;
  test("向量非空", () => {
    expect(Object.keys(byLevel)).toEqual(["0", "1", "2", "3"]);
    expect(COLORS.length).toBeGreaterThan(20);
  });
  for (const [level, want] of Object.entries(byLevel)) {
    test(`级别 ${level}`, () => {
      chalk.level = Number(level) as typeof chalk.level;
      expect(COLOR_TEXTS.map((t) => COLORS.map((c) => colorize(t, c, "foreground")))).toEqual(
        want.foreground,
      );
      expect(COLOR_TEXTS.map((t) => COLORS.map((c) => colorize(t, c, "background")))).toEqual(
        want.background,
      );
      expect(COLORS.map((c) => applyColor("ab", c as never))).toEqual(want.applyColor);
      expect([colorize("ab", undefined, "foreground"), applyColor("ab", undefined)]).toEqual(
        want.undefinedColor,
      );
      expect(
        COLOR_TEXTS.map((t) => TEXT_STYLES.map((s) => applyTextStyles(t, s as never))),
      ).toEqual(want.textStyles);
    });
  }
});

describe("颜色级别修正", () => {
  const levels = vectors.color.levels as [Record<string, string>, number][];
  test("与旧底座的环境矩阵一致（初始级别取 FORCE_COLOR）", () => {
    expect(levels.length).toBeGreaterThan(10);
    for (const [env, want] of levels) {
      const initial = Number(env.FORCE_COLOR) as typeof chalk.level;
      expect(adjustColorLevel(initial, env), JSON.stringify(env)).toBe(want);
    }
  });

  test("新变量名 SID_CODE_TMUX_TRUECOLOR 与旧名等效（D125）；新名优先", () => {
    expect(adjustColorLevel(3, { TMUX: "x", SID_CODE_TMUX_TRUECOLOR: "1" })).toBe(3);
    expect(adjustColorLevel(3, { TMUX: "x", SID_CODE_TMUX_TRUECOLOR: "0" })).toBe(3);
    // 新名显式置空 = 不开，哪怕旧名开着
    expect(
      adjustColorLevel(3, {
        TMUX: "x",
        SID_CODE_TMUX_TRUECOLOR: "",
        CLAUDE_CODE_TMUX_TRUECOLOR: "1",
      }),
    ).toBe(2);
  });

  test("模块加载时真的改了进程级 chalk.level（子进程）", () => {
    const code = `await import(${JSON.stringify(join(import.meta.dir, "../src/colorize.ts"))});
      const { default: chalk } = await import("chalk"); process.stdout.write(String(chalk.level));`;
    const env: Record<string, string | undefined> = { ...process.env, FORCE_COLOR: "3", TMUX: "x" };
    delete env.SID_CODE_TMUX_TRUECOLOR;
    delete env.CLAUDE_CODE_TMUX_TRUECOLOR;
    const r = Bun.spawnSync([process.execPath, "-e", code], { env: env as Record<string, string> });
    expect(r.stdout.toString()).toBe("2");
  });
});

describe("T6 styled-chars 五函数对拍旧底座", () => {
  type Case = {
    text: string;
    chars: unknown[];
    width: number;
    words: number[][];
    wrap: Record<string, { lines: number[][]; widest: number }>;
  };
  const cases = vectors.styledChars as Case[];
  test("向量非空", () => {
    expect(cases.length).toBeGreaterThan(20);
  });
  for (const c of cases) {
    test(JSON.stringify(c.text), () => {
      const chars = toStyledCharacters(c.text);
      expect(JSON.parse(JSON.stringify(chars))).toEqual(c.chars);
      expect(styledCharsWidth(chars)).toBe(c.width);
      expect(wordBreakStyledChars(chars).map((w) => w.map((ch) => chars.indexOf(ch)))).toEqual(
        c.words,
      );
      for (const [columns, want] of Object.entries(c.wrap)) {
        const lines = wrapStyledChars(chars, Number(columns));
        // indexOf 同时钉住「返回输入里的同一批对象」：复制出来的对象会得到 -1
        expect(
          lines.map((l) => l.map((ch) => chars.indexOf(ch))),
          `宽 ${columns}`,
        ).toEqual(want.lines);
        expect(widestLineFromStyledChars(lines)).toBe(want.widest);
      }
    });
  }

  test("空输入", () => {
    expect(styledCharsWidth([])).toBe(0);
    expect(widestLineFromStyledChars([])).toBe(0);
    expect(wordBreakStyledChars([])).toEqual([]);
  });
});
