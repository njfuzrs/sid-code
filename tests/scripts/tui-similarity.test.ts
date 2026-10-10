/**
 * 相似度门禁 scripts/tui-similarity.ts 的变异自证（B9 / T1.3）。
 *
 * 用合成夹具，不依赖 vendor:fetch 取回的旧底座：
 * - 新底座含一段上游也有的代码（旧底座同样有）→ 放行，算「继承自上游」；
 * - 新底座含一段只有旧底座有的代码 → 违规。这就是门禁要拦的「从旧底座复制」。
 * 外加一条真实仓库用例：旧底座在场时整仓必须 0 违规。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { scan, scanRepo } from "../../scripts/tui-similarity.ts";

const ROOT = resolve(import.meta.dir, "../..");
const work = mkdtempSync(join(tmpdir(), "tui-sim-test-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

// 两段都远超 30 token，且彼此不同
const UPSTREAM_FN = `export function measureColumns(rows: string[][], gap: number): number[] {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length + gap);
    });
  }
  return widths;
}
`;
const LEGACY_ONLY_FN = `export function packSelection(start: { row: number; col: number }, end: { row: number; col: number }) {
  const forward = start.row < end.row || (start.row === end.row && start.col <= end.col);
  const a = forward ? start : end;
  const b = forward ? end : start;
  return { top: a.row, left: a.col, bottom: b.row, right: b.col, span: b.row - a.row + 1 };
}
`;

function fixture(name: string, newContent: string) {
  const base = join(work, name);
  const dirs = {
    upstream: join(base, "upstream"),
    legacy: join(base, "legacy"),
    next: join(base, "next"),
  };
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
  writeFileSync(join(dirs.upstream, "layout.ts"), UPSTREAM_FN);
  writeFileSync(join(dirs.legacy, "layout.ts"), UPSTREAM_FN + "\n" + LEGACY_ONLY_FN);
  writeFileSync(join(dirs.next, "layout.ts"), newContent);
  return scan({
    newDirs: [dirs.next],
    legacyDir: dirs.legacy,
    upstreamDir: dirs.upstream,
    minSources: 2,
  });
}

describe("tui-similarity 判定", () => {
  test("新底座只含上游代码 → 0 违规，计 1 处继承", () => {
    const r = fixture("clean", UPSTREAM_FN);
    expect(r.violations).toEqual([]);
    expect(r.inherited).toBe(1);
  });

  test("变异：从旧底座复制一个上游没有的函数进新底座 → 红", () => {
    const r = fixture("copied", UPSTREAM_FN + "\n" + LEGACY_ONLY_FN);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]!.legacyFile).toBe("layout.ts");
  });

  test("变异：只改空白 / 缩进仍然算复制（判定按去空白比对）", () => {
    const reindented = LEGACY_ONLY_FN.replace(/^ {2}/gm, "\t");
    const r = fixture("reindented", reindented);
    expect(r.violations).toHaveLength(1);
  });

  test("新底座文件里有中文注释时，上游继承块仍被认出（jscpd 偏移是字节，不是字符）", () => {
    // 继承块前放中文注释（每个汉字 3 字节 / 1 字符），后面跟一段新底座自己的代码（两边都没有）。
    // 按字符串下标切，切片会整体后移、吃进后面那段新代码 → 上游里找不到 → 误报违规。
    const comment = `// ${"这是一段用来制造多字节偏移的中文注释".repeat(4)}\n`;
    // 不以 export 开头：旧底座夹具在同一位置也是 export，jscpd 会把重复块多延伸一个 token
    const ownCode = `const ownOnly = (xs: number[]) => xs.filter((x) => x % 7 === 3).map((x) => x * 11);\nvoid ownOnly;\n`;
    const r = fixture("cjk", comment + UPSTREAM_FN + "\n" + ownCode);
    expect(r.violations).toEqual([]);
    expect(r.inherited).toBe(1);
  });

  test("防空转：扫到的文件数低于下限就抛", () => {
    const base = join(work, "empty");
    mkdirSync(join(base, "n"), { recursive: true });
    mkdirSync(join(base, "l"), { recursive: true });
    writeFileSync(join(base, "n", "a.ts"), "export const a = 1;\n");
    writeFileSync(join(base, "l", "a.ts"), "export const a = 1;\n");
    expect(() =>
      scan({ newDirs: [join(base, "n")], legacyDir: join(base, "l"), upstreamDir: base }),
    ).toThrow(/空转/);
  });
});

describe("真实仓库", () => {
  // 旧底座要 vendor:fetch 取回（CI 的 test job 有这一步）；本地没取回时跳过，不误报
  const hasLegacy = existsSync(join(ROOT, "packages/tui-renderer/src/root.ts"));
  test.skipIf(!hasLegacy)(
    "新底座整仓 0 违规，且确有继承自上游的重复块（门禁没空转）",
    () => {
      const r = scanRepo();
      expect(r.violations).toEqual([]);
      expect(r.inherited).toBeGreaterThan(10);
    },
    60_000,
  );
});
