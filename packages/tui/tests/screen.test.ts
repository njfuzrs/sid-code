/**
 * cell 级屏幕缓冲对拍旧底座首帧（B9 / T3.1，契约 R3 / R9 / T3 / T4）。
 *
 * 向量由 `bun run tui:screen-vectors` 从旧底座的 TTY 首帧生成并入库；这里用新底座渲染同一棵树，
 * `serializeScreen` 的字节必须逐字节一致。只读向量与语料，不 import 旧底座。
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import vectors from "./fixtures/screen-vectors.json";
import { CORPUS_ENVS, cleanEnv } from "./fixtures/screen-corpus.ts";
import {
  CellWidth,
  HyperlinkPool,
  hyperlinkId,
  Screen,
  screenToString,
  serializeRow,
  StylePool,
} from "../src/screen/index.ts";

const PROBE = join(import.meta.dir, "fixtures", "screen-probe.tsx");
const groups = vectors.groups as Record<string, { cols: number; frames: Record<string, string> }>;

describe("屏幕缓冲首帧对拍旧底座", () => {
  test("向量与语料同一批条目（语料改了要重生成向量）", () => {
    for (const [g, { cases }] of Object.entries(CORPUS_ENVS)) {
      expect(Object.keys(groups[g]!.frames)).toEqual(cases.map((c) => c.name));
    }
  });

  for (const [group, { env }] of Object.entries(CORPUS_ENVS)) {
    describe(group, () => {
      const r = Bun.spawnSync([process.execPath, PROBE], {
        env: { ...cleanEnv(env), GROUP: group },
      });
      const actual: Record<string, string> =
        r.exitCode === 0 ? JSON.parse(r.stdout.toString()) : {};
      test("探针子进程正常退出", () => {
        expect(r.exitCode, r.stderr.toString()).toBe(0);
      });
      for (const [name, expected] of Object.entries(groups[group]!.frames)) {
        test(name, () => {
          expect(JSON.stringify(actual[name])).toBe(JSON.stringify(expected));
        });
      }
    });
  }
});

describe("Screen 单元规则（T4：不留孤立 spacer）", () => {
  const pools = () => ({ styles: new StylePool(), links: new HyperlinkPool() });

  /** 每个 spacer 左边必须紧挨一个宽字符左半格，反之亦然 */
  function assertNoOrphans(s: Screen) {
    for (let y = 0; y < s.height; y++) {
      for (let x = 0; x < s.width; x++) {
        const w = s.widths[s.index(x, y)];
        if (w === CellWidth.Spacer)
          expect(x > 0 && s.widths[s.index(x - 1, y)] === CellWidth.Wide).toBe(true);
        if (w === CellWidth.Wide)
          expect(x + 1 < s.width && s.widths[s.index(x + 1, y)] === CellWidth.Spacer).toBe(true);
      }
    }
  }

  test("任意位置覆盖写入后都没有孤立 spacer", () => {
    const writes = ["中文中文中", "a", "中", "ab", "❤️x", "\x1b[7m中\x1b[27m"];
    for (const first of writes)
      for (const second of writes)
        for (let x = 0; x < 6; x++) {
          const s = new Screen(8, 1, pools());
          s.writeLine(0, 0, first);
          s.writeLine(x, 0, second);
          assertNoOrphans(s);
        }
  });

  test("宽字符压在右边界整个丢掉", () => {
    const s = new Screen(3, 1, pools());
    expect(s.writeLine(0, 0, "ab中")).toBe(2);
    expect(screenToString(s)).toBe("ab");
    assertNoOrphans(s);
  });

  test("左边界之前的宽字符整个丢掉，不劈半", () => {
    const s = new Screen(6, 1, pools());
    s.writeLine(-1, 0, "中文ab");
    expect(screenToString(s)).toBe(" 文ab");
    assertNoOrphans(s);
  });

  test("行外写入忽略", () => {
    const s = new Screen(4, 1, pools());
    s.writeLine(0, 1, "ab");
    s.writeLine(0, -1, "ab");
    expect(screenToString(s)).toBe("");
  });

  test("被劈开的宽字符剩下的半格还原成默认空白（样式也清掉）", () => {
    const p = pools();
    const s = new Screen(6, 1, p);
    s.writeLine(0, 0, "\x1b[44m中文\x1b[49m");
    s.writeLine(1, 0, "X");
    expect(s.styles[0]).toBe(0);
    expect(s.charAt(0)).toBe(" ");
    expect(serializeRow(s, 0)).toBe("\x1b[1CX\x1b[44m文\x1b[49m");
  });
});

describe("样式池 / 超链接池", () => {
  test("同样式同 id，空样式恒为 0", () => {
    const p = new StylePool();
    const s1 = new Screen(4, 1, { styles: p, links: new HyperlinkPool() });
    s1.writeLine(0, 0, "\x1b[31ma\x1b[39mb\x1b[31mc");
    expect(s1.styles[0]).toBe(s1.styles[2]);
    expect(s1.styles[1]).toBe(0);
    expect(p.size).toBe(2);
  });

  test("切换序列按 (from, to) 缓存，相同样式为空串", () => {
    const p = new StylePool();
    const s = new Screen(2, 1, { styles: p, links: new HyperlinkPool() });
    s.writeLine(0, 0, "\x1b[1ma\x1b[22m");
    const bold = s.styles[0]!;
    expect(p.transition(bold, bold)).toBe("");
    expect(p.transition(0, bold)).toBe("\x1b[1m");
    expect(p.transition(bold, 0)).toBe("\x1b[22m");
  });

  test("超链接 id = url 的 Java 式 hash，无符号 36 进制", () => {
    expect(hyperlinkId("https://a.com")).toBe("1sos1z9");
    expect(hyperlinkId("http://x")).toBe("1wtdrc6");
    expect(hyperlinkId("https://b.org/x")).toBe("saegnm");
  });
});
