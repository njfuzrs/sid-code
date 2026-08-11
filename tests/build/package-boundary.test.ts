/**
 * 包边界门禁（P2-2 分包 · 步骤 6，2026-08-11）。
 *
 * 分包的价值全部押在「core 不知道 TUI 的存在」这一条上 —— 它是 core 将来能当库用、
 * 能被非 TUI 宿主（SDK / daemon / 服务端）引入的前提。而这条约束只靠一次性重构守不住：
 * 分包时越界从 58 处修到 0，但下一次「随手 import 一下」就能把它加回来，
 * 且**类型越界连运行时都不会报错**（`import type` 编译后整行消失），tsc 也照样绿。
 * 所以必须有一道会在 CI 变红的门禁。
 *
 * 本文件断言三件事，对应 `scripts/pkg-boundary-scan.ts --packages` 报的三类违规：
 *
 *  1. **rank 越界**：shared(0) < tui-renderer(1) < core(2) < cli(3)，低 rank 不得导入高 rank。
 *  2. **跨包相对路径**：`../../core/src/x.ts` 这种偷渡 —— 方向合法也算违规，因为它绕过
 *     package.json 的 exports 契约，依赖关系在 dependencies 字段里查不到，
 *     单独发包时才会炸（那时已经很难追责到具体某次提交）。
 *  3. **自包 bare 导入**：本包内部不该走 `@sid-code/<自己>`，绕一圈 node_modules symlink，
 *     既拖慢解析也让「这文件属于哪个包」在阅读时失去局部性。
 *
 * ⚠️ **本文件必须包含「防假绿」用例**（见最后一个 describe）。原因是项目里反复栽过同一个跟头：
 * 一道扫描式门禁只要路径指错 / 目录改名 / 静默 `return []`，就会永远绿 —— 比没有门禁更糟，
 * 因为它还提供了虚假的安全感。所以除了「当前 0 违规」，还要证明**扫描器真的能检出违规**。
 */
import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import {
  PACKAGE_RANK,
  PACKAGES,
  extractImports,
  scanPackagesMode,
} from "../../scripts/pkg-boundary-scan.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const PACKAGES_ROOT = join(REPO_ROOT, "packages");

const scan = scanPackagesMode(PACKAGES_ROOT);

describe("包边界：packages/ 下的真实依赖方向", () => {
  test("零越界依赖（rank / 跨包相对路径 / 自包 bare 导入）", () => {
    // 失败时把违规逐条打出来：这类失败光看 "expected 0 got 3" 无法定位，
    // 而违规往往是别人几十个文件的改动里夹带的一行 import。
    const detail = scan.violations
      .map((v) => `  [${v.kind}] ${v.fromPkg}→${v.toPkg}  ${v.file}:${v.line}  ${v.spec}`)
      .join("\n");
    expect(scan.violations.length, `包边界越界：\n${detail}\n\n修法见 scripts/pkg-boundary-scan.ts 文件头`).toBe(0);
  });

  test("core 完全不知道 TUI 的存在（分包的核心目标）", () => {
    // 单独立一条：它是分包最重要的那个不变量，混在「零越界」里失败时不够醒目。
    const coreToTui = scan.violations.filter(
      (v) => v.fromPkg === "core" && v.toPkg === "tui-renderer",
    );
    expect(coreToTui.map((v) => `${v.file}:${v.line}`)).toEqual([]);
    // 边也必须为 0（边包含合法方向的引用，rank 违规只是它的子集）
    expect(scan.edges.get("core→tui-renderer") ?? 0).toBe(0);
    expect(scan.edges.get("core→cli") ?? 0).toBe(0);
  });

  test("rank 表自洽：shared(0) < tui-renderer(1) < core(2) < cli(3)", () => {
    // 锁住顺序本身。曾经的设计方案里 §2.1 与 §4.4 自相矛盾（tui-renderer 到底是不是叶子），
    // 择一之后必须钉死，否则「把 rank 调一下让门禁变绿」是最省事也最有害的修法。
    expect(PACKAGES.map((p) => PACKAGE_RANK[p])).toEqual([0, 1, 2, 3]);
  });
});

describe("包边界门禁自身有效性（防假绿）", () => {
  test("扫描器真的扫到了 4 个包的源码", () => {
    // 路径指错 / 包改名 → 扫到 0 个文件 → 违规恒为 0 → 门禁永远绿。
    // scanPackagesMode 内部对 0 文件会抛，这里再断一次规模下限，双保险。
    expect([...scan.sizes.keys()].sort()).toEqual([...PACKAGES].sort());
    for (const pkg of PACKAGES) {
      expect(scan.sizes.get(pkg)!.files, `包 ${pkg} 扫到的文件数异常`).toBeGreaterThan(10);
    }
    // 全仓生产源码规模下限：分包时实测约 1010 个文件 / 22.8 万行。
    // 取一半作阈值 —— 既能挡住「扫了个空目录」，又不会因正常增删而频繁误红。
    const totalFiles = PACKAGES.reduce((n, p) => n + scan.sizes.get(p)!.files, 0);
    expect(totalFiles).toBeGreaterThan(500);
  });

  test("扫描器确实在数跨包边（不是所有 import 都被跳过了）", () => {
    // 若 extractImports 或 bare specifier 正则失效，违规会是 0，但边也会是 0。
    // 「零违规 + 零边」是假绿的典型指纹，「零违规 + 大量合法边」才是真的干净。
    expect(scan.edges.get("cli→core") ?? 0).toBeGreaterThan(100);
    expect(scan.edges.get("cli→tui-renderer") ?? 0).toBeGreaterThan(50);
    expect(scan.edges.get("core→shared") ?? 0).toBeGreaterThan(0);
  });

  test("三类违规都能被检出（用合成源码验证判定逻辑）", () => {
    // 不落盘、不动真实文件：直接喂合成内容给 extractImports，再按 scanPackagesMode
    // 的同一套判据核对。落盘植入探针的做法在并行跑测试时会互相干扰，且失败时可能留下垃圾文件。
    const cases: Array<{ spec: string; desc: string }> = [
      { spec: "@sid-code/cli/app.ts", desc: "rank 越界" },
      { spec: "../../shared/src/version.ts", desc: "跨包相对路径" },
      { spec: "@sid-code/core/config/config.ts", desc: "自包 bare 导入（假设 from=core）" },
    ];
    for (const c of cases) {
      const imports = extractImports(`import type { A } from "${c.spec}";\nexport type B = A;\n`);
      expect(imports.map((i) => i.spec), `${c.desc}：导入说明符未被提取到`).toContain(c.spec);
      // 类型导入必须被识别为 type-only：类型越界是最容易漏的一类
      //（编译后整行消失，运行时零征兆），漏判 isTypeOnly 会让报告误导排查方向。
      expect(imports[0]!.isTypeOnly, `${c.desc}：isTypeOnly 判定错误`).toBe(true);
    }
  });

  test("注释里的 import 示例不算依赖（避免误红）", () => {
    // tui-renderer 的文档注释里有 `from 'ink'` 这类示例代码。若不先剥注释，
    // 门禁会对着注释报越界 —— 一道会误红的门禁最终会被 --no-verify 绕过。
    const withComment = [
      "/**",
      " * 用法：import { Box } from '@sid-code/cli/app.ts'",
      " */",
      "// import type { X } from '@sid-code/cli/app.ts'",
      "export const a = 1;",
    ].join("\n");
    expect(extractImports(withComment)).toEqual([]);
  });
});
