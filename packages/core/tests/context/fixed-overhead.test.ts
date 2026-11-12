/**
 * F5 / PR-4：/context 固定开销来源（记忆索引 / `@` 导入文件逐项列出 + 超 2% 提示）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir, homedir } from "os";
import { realpathSync } from "fs";
import { computeFixedOverheadSources } from "@sid-code/core/context/fixed-overhead.ts";
import { processImports, type ImportedFileRecord } from "@sid-code/core/config/import-processor.ts";
import { estimateTextTokens } from "@sid-code/core/context/token.ts";

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "sid-fixed-overhead-")));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("processImports.onImported：记下每个成功展开的导入", () => {
  test("记录导入路径、来源文件、行号、被导入文件自身字符数（含嵌套）", async () => {
    writeFileSync(join(dir, "A.md"), "aaa\n@B.md\n");
    writeFileSync(join(dir, "B.md"), "bbbb");
    const claude = join(dir, "CLAUDE.md");
    const src = "# rules\n\n@A.md\n";
    writeFileSync(claude, src);
    const recs: ImportedFileRecord[] = [];
    await processImports(src, claude, {
      allowedDirectories: [dir, homedir()],
      projectRoot: dir,
      onImported: (r) => recs.push(r),
    });
    const byName = Object.fromEntries(recs.map((r) => [r.importPath, r]));
    expect(byName["A.md"]).toMatchObject({
      fromFile: claude,
      line: 3,
      chars: "aaa\n@B.md\n".length,
    });
    expect(byName["B.md"]).toMatchObject({ fromFile: join(dir, "A.md"), line: 2, chars: 4 });
  });

  test("不存在的导入不记录", async () => {
    const claude = join(dir, "CLAUDE.md");
    const recs: ImportedFileRecord[] = [];
    await processImports("@missing.md\n", claude, {
      allowedDirectories: [dir],
      projectRoot: dir,
      onImported: (r) => recs.push(r),
    });
    expect(recs).toEqual([]);
  });
});

describe("computeFixedOverheadSources", () => {
  const big = "规".repeat(4000); // 中文 0.65 tok/char ≈ 2600 tok
  const projIndex = `#### 项目记忆（目录：/m/proj）\n\n- [a](a.md)：${"摘".repeat(3000)}`;
  const globalIndex = `#### 全局记忆（目录：/m/global）\n\n- [g](g.md)：全局`;

  function promptWith(parts: string[]) {
    return ["# 身份", ...parts, "<system-reminder>\n# claudeMd\nxx\n</system-reminder>"].join(
      "\n\n",
    );
  }

  test("记忆索引按 scope 分别列出，token = 启发式 × 校准系数", () => {
    const sp = promptWith([projIndex, globalIndex]);
    const r = computeFixedOverheadSources(sp, [], {
      maxTokens: 1_000_000,
      calibrationFactor: 1.25,
    });
    const proj = r.sources.find((s) => s.key === "memoryIndex:project")!;
    const glob = r.sources.find((s) => s.key === "memoryIndex:global")!;
    expect(proj.tokens).toBe(Math.round(estimateTextTokens(projIndex) * 1.25));
    expect(glob.tokens).toBe(Math.round(estimateTextTokens(globalIndex) * 1.25));
  });

  test("@ 导入按文件列出，标注「经 来源:行 导入」；超窗口 2% 给提示", () => {
    const rec: ImportedFileRecord = {
      absolutePath: "/repo/CONTRIBUTING.md",
      importPath: "CONTRIBUTING.md",
      fromFile: "/repo/CLAUDE.md",
      line: 18,
      chars: big.length,
    };
    const sp = promptWith([
      `<system-reminder>\n@CONTRIBUTING.md\n<!-- @import CONTRIBUTING.md -->\n${big}\n<!-- end @import CONTRIBUTING.md -->\n</system-reminder>`,
    ]);
    const r = computeFixedOverheadSources(sp, [rec], {
      maxTokens: 100_000,
      calibrationFactor: 1,
      projectRoot: "/repo",
    });
    const src = r.sources.find((s) => s.key === "import:/repo/CONTRIBUTING.md")!;
    expect(src.label).toBe("@CONTRIBUTING.md");
    expect(src.detail).toBe("经 CLAUDE.md:18 导入");
    expect(src.tokens).toBe(estimateTextTokens(big));
    expect(r.hints.some((h) => h.includes("CONTRIBUTING.md") && h.includes("CLAUDE.md:18"))).toBe(
      true,
    );
  });

  test("低于 2% 不提示", () => {
    const rec: ImportedFileRecord = {
      absolutePath: "/repo/S.md",
      importPath: "S.md",
      fromFile: "/repo/CLAUDE.md",
      line: 1,
      chars: 3,
    };
    const sp = promptWith([`<!-- @import S.md -->\nabc\n<!-- end @import S.md -->`]);
    const r = computeFixedOverheadSources(sp, [rec], {
      maxTokens: 1_000_000,
      calibrationFactor: 1,
    });
    expect(r.sources.length).toBe(1);
    expect(r.hints).toEqual([]);
  });

  test("没进最终提示词的导入（找不到标记）不计——不虚报", () => {
    const rec: ImportedFileRecord = {
      absolutePath: "/repo/X.md",
      importPath: "X.md",
      fromFile: "/repo/CLAUDE.md",
      line: 1,
      chars: 999,
    };
    const r = computeFixedOverheadSources(promptWith([]), [rec], {
      maxTokens: 1000,
      calibrationFactor: 1,
    });
    expect(r.sources).toEqual([]);
  });

  test("嵌套导入不重复计数：外层只算自身内容", () => {
    const inner = "内".repeat(100);
    const outerSelf = "外".repeat(50);
    const sp = promptWith([
      `<!-- @import A.md -->\n${outerSelf}\n<!-- @import B.md -->\n${inner}\n<!-- end @import B.md -->\n<!-- end @import A.md -->`,
    ]);
    const recs: ImportedFileRecord[] = [
      { absolutePath: "/r/B.md", importPath: "B.md", fromFile: "/r/A.md", line: 2, chars: 100 },
      { absolutePath: "/r/A.md", importPath: "A.md", fromFile: "/r/CLAUDE.md", line: 1, chars: 60 },
    ];
    const r = computeFixedOverheadSources(sp, recs, { maxTokens: 1_000_000, calibrationFactor: 1 });
    const a = r.sources.find((s) => s.key === "import:/r/A.md")!;
    const b = r.sources.find((s) => s.key === "import:/r/B.md")!;
    expect(b.tokens).toBe(estimateTextTokens(inner));
    expect(a.tokens).toBe(estimateTextTokens(`${outerSelf}\n`));
  });

  test("召回模式的项目段标注「按需召回」，且不对它提示", () => {
    const pointer = `#### 项目记忆（目录：/m/proj）\n\n> 本项目记忆较多、索引已超出上限，本会话改为**按需召回**：…`;
    const r = computeFixedOverheadSources(promptWith([pointer]), [], {
      maxTokens: 10,
      calibrationFactor: 1,
    });
    const proj = r.sources.find((s) => s.key === "memoryIndex:project")!;
    expect(proj.detail).toContain("按需召回");
    expect(r.hints).toEqual([]);
  });

  test("项目索引超 2% 给出 /memory 与自动召回的处理提示", () => {
    const r = computeFixedOverheadSources(promptWith([projIndex]), [], {
      maxTokens: 50_000,
      calibrationFactor: 1,
    });
    expect(r.hints.some((h) => h.startsWith("项目记忆索引") && h.includes("/memory"))).toBe(true);
  });
});
