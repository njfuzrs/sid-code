/**
 * 新底座文本工具对拍旧底座生成的向量（B9 / T2.1，契约 T1 / T2 / T3）。
 *
 * 向量由 `bun run tui:text-vectors` 从旧底座生成并入库（tests/fixtures/text-vectors.json），
 * 这里只读向量、不 import 旧底座 —— T9 删掉旧底座后本测试照样成立。
 */
import { afterEach, describe, expect, test } from "bun:test";
import vectors from "./fixtures/text-vectors.json";
import {
  reorderBidi,
  sliceColumns,
  stringWidth,
  terminalNeedsSoftwareBidi,
  widestLine,
  wrapText,
} from "../src/text/index.ts";
import { resetBidiDetectionForTesting } from "../src/text/bidi.ts";

describe("T1 stringWidth 对拍旧底座", () => {
  test("全部码位（游程压缩，去代理区）逐个一致", () => {
    const runs = vectors.width.codepointRuns as [number, number][];
    expect(runs.length).toBeGreaterThan(100); // 防空向量全绿
    let mismatches = 0;
    const examples: string[] = [];
    for (let i = 0; i < runs.length; i++) {
      const [from, w] = runs[i]!;
      const to = i + 1 < runs.length ? runs[i + 1]![0] : 0x110000;
      for (let cp = from; cp < to; cp++) {
        if (cp >= 0xd800 && cp <= 0xdfff) continue;
        const got = stringWidth(String.fromCodePoint(cp));
        if (got !== w) {
          mismatches++;
          if (examples.length < 5) examples.push(`U+${cp.toString(16)} 期望 ${w} 实际 ${got}`);
        }
      }
    }
    expect(examples).toEqual([]);
    expect(mismatches).toBe(0);
  });

  for (const [s, w] of vectors.width.sequences as [string, number][]) {
    test(`序列 ${JSON.stringify(s)} → ${w}`, () => {
      expect(stringWidth(s)).toBe(w);
    });
  }

  test("widestLine 取最宽一行", () => {
    expect(widestLine("ab\n中文中\nx")).toBe(6);
    expect(widestLine("")).toBe(0);
  });
});

describe("T2 wrap / truncate 对拍旧底座", () => {
  const cases = vectors.wrap as { text: string; out: Record<string, string[]> }[];
  test("向量非空", () => {
    expect(cases.length).toBeGreaterThan(10);
  });
  for (const { text, out } of cases) {
    for (const [mode, byColumns] of Object.entries(out)) {
      test(`${mode} ${JSON.stringify(text)}（宽 0–${byColumns.length - 1}）`, () => {
        const got = byColumns.map((_, c) => wrapText(text, c, mode));
        expect(got).toEqual(byColumns);
      });
    }
  }

  test("截断结果不超宽（宽字符不劈半，宁可少一格）", () => {
    for (const { text } of cases) {
      for (let c = 1; c <= 20; c++) {
        for (const mode of ["truncate", "truncate-middle", "truncate-start"]) {
          expect(stringWidth(wrapText(text, c, mode))).toBeLessThanOrEqual(c);
        }
      }
    }
  });
});

describe("sliceColumns", () => {
  test("宽字符起点在切片外整个丢掉，不劈半", () => {
    expect(sliceColumns("中a", 1, 3)).toBe("a");
  });
  test("样式：开头补生效的 SGR、结尾关掉", () => {
    expect(sliceColumns("\x1b[31mabc\x1b[39m", 1, 2)).toBe("\x1b[31mb\x1b[39m");
  });
  test("列数没到 end 就走完字符串：末尾悬空的控制序列原样带出，并补上关闭", () => {
    expect(sliceColumns("ab\x1b[31m", 0, 5)).toBe("ab\x1b[31m\x1b[39m");
    // 恰好到 end 算截断：末尾序列只影响后面被丢掉的字符，不带出
    expect(sliceColumns("ab\x1b[31m", 0, 2)).toBe("ab");
  });
  test("空切片：slice(0,0) 为空串，越过开头样式后的空切片输出关闭序列（对拍旧底座）", () => {
    expect(sliceColumns("\x1b[31mabc", 0, 0)).toBe("");
    expect(sliceColumns("\x1b[31mabc", 1, 1)).toBe("\x1b[39m");
  });
  test("超链接关闭序列不被当成仍生效的样式（不多关一次）", () => {
    const link = "\x1b]8;;http://x\x07ab\x1b]8;;\x07 c";
    expect(sliceColumns(link, 0, 4)).toBe(link);
  });
});

describe("T3 bidi", () => {
  const env = { WT_SESSION: process.env.WT_SESSION, TERM_PROGRAM: process.env.TERM_PROGRAM };
  afterEach(() => {
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetBidiDetectionForTesting();
  });

  const segmenter = new Intl.Segmenter();
  const clusters = (s: string) =>
    [...segmenter.segment(s)].map((x, i) => ({ value: x.segment, id: i }));

  test("需要软件 bidi 的终端：重排结果与旧底座一致", () => {
    process.env.WT_SESSION = "1";
    resetBidiDetectionForTesting();
    const cases = vectors.bidi as [string, number[]][];
    expect(cases.some(([, order]) => order.some((v, i) => v !== i))).toBe(true); // 至少有一条真的重排了
    for (const [text, order] of cases) {
      expect(
        reorderBidi(clusters(text)).map((c) => c.id),
        text,
      ).toEqual(order);
    }
  });

  test("其他终端原样返回同一个数组", () => {
    delete process.env.WT_SESSION;
    delete process.env.TERM_PROGRAM;
    resetBidiDetectionForTesting();
    const input = clusters("ab שלום cd");
    if (process.platform !== "win32") expect(reorderBidi(input)).toBe(input);
  });

  test("判定规则：win32 / WT_SESSION（空串也算）/ TERM_PROGRAM=vscode", () => {
    expect(terminalNeedsSoftwareBidi({}, "win32")).toBe(true);
    expect(terminalNeedsSoftwareBidi({ WT_SESSION: "" }, "linux")).toBe(true);
    expect(terminalNeedsSoftwareBidi({ TERM_PROGRAM: "vscode" }, "darwin")).toBe(true);
    expect(terminalNeedsSoftwareBidi({ TERM_PROGRAM: "iTerm.app" }, "darwin")).toBe(false);
    expect(terminalNeedsSoftwareBidi({}, "linux")).toBe(false);
  });
});
