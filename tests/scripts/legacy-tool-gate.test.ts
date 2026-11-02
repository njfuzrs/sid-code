/**
 * 工具接口棘轮门禁（scripts/legacy-tool-gate.ts）自身的口径 + 变异自证。
 *
 * 门禁最糟的失败模式不是报错，是「扫出一个空集然后全程绿」。下面每条口径断言都对应
 * 一种会让它恒绿或恒红的错误实现：按 `implements` 计数（恒 0）、把 `toLegacyTool`
 * 算进来（bridge 永远删不掉）、把注释算进来（逼人删解释性注释）、把测试算进来。
 */

import { describe, test, expect } from "bun:test";
import {
  referencesLegacyTool,
  findLegacyToolFiles,
  scanRepo,
  readBaseline,
} from "../../scripts/legacy-tool-gate.ts";

describe("referencesLegacyTool 口径", () => {
  test("别名导入 `LegacyTool as Tool` 算依赖（全仓主流写法，没有一处 implements）", () => {
    expect(referencesLegacyTool('import type { LegacyTool as Tool } from "./types.ts";')).toBe(
      true,
    );
  });

  test("只导入 LegacyToolResult 也算", () => {
    expect(referencesLegacyTool("let r: LegacyToolResult;")).toBe(true);
  });

  test("词边界：toLegacyTool 不算", () => {
    expect(referencesLegacyTool("const t = toLegacyTool(x);")).toBe(false);
  });

  test("行注释、块注释、跨行 JSDoc 里的提及都不算", () => {
    expect(referencesLegacyTool("// 旧 LegacyTool 接口")).toBe(false);
    expect(referencesLegacyTool("const a = 1; /* LegacyTool */ const b = 2;")).toBe(false);
    expect(
      referencesLegacyTool(["/**", " * 见 LegacyTool", " */", "const a = 1;"].join("\n")),
    ).toBe(false);
  });

  test("块注释结束后同一行的代码仍被检查", () => {
    expect(referencesLegacyTool("/* x */ let t: LegacyTool;")).toBe(true);
    expect(referencesLegacyTool(["/*", " x */ let t: LegacyTool;"].join("\n"))).toBe(true);
  });
});

describe("findLegacyToolFiles 口径", () => {
  const files = [
    { path: "packages/core/src/tool/a.ts", source: "import { LegacyTool as Tool } from './t';" },
    { path: "packages/core/src/tool/b.ts", source: "export const thinkTool = buildTool({});" },
    { path: "packages/core/src/tool/a.test.ts", source: "let t: LegacyTool;" },
    { path: "packages/core/tests/tool/c.ts", source: "let t: LegacyTool;" },
  ];

  test("只数生产文件里的真实引用", () => {
    expect(findLegacyToolFiles(files)).toEqual(["packages/core/src/tool/a.ts"]);
  });
});

describe("变异自证：门禁必须真的能分辨新旧", () => {
  const hits = scanRepo();

  test("扫描结果非空（排除「恒返回空集然后全绿」）", () => {
    // 存量确实存在。迁移完成、真降到 0 时这条会红，届时连同 LegacyTool 一起删掉本门禁。
    expect(hits.length).toBeGreaterThan(0);
    expect(hits).toContain("packages/core/src/tool/registry.ts");
    expect(hits).toContain("packages/core/src/tool/bash.ts");
  });

  test("已迁到新接口的文件不被计入（排除「把所有工具文件都算进去」）", () => {
    // think.ts 用 buildTool 定义、直接 registry.register(thinkTool)，不再引用旧接口
    expect(hits).not.toContain("packages/core/src/tool/think.ts");
    // 只在注释里提到 LegacyTool 的文件
    expect(hits).not.toContain("packages/core/src/tool/tool-search-scoring.ts");
  });

  test("往一个新接口文件里加一行旧接口引用，计数必须 +1", () => {
    const base = [{ path: "packages/core/src/tool/think.ts", source: "buildTool({});" }];
    const mutated = [
      { path: "packages/core/src/tool/think.ts", source: "buildTool({});\nlet t: LegacyTool;" },
    ];
    expect(findLegacyToolFiles(mutated).length).toBe(findLegacyToolFiles(base).length + 1);
  });

  test("基线与当前实测一致（不允许悄悄留余量）", () => {
    // 低于基线也要红：余量会被下一个新增的旧接口文件悄悄吃掉
    expect(hits.length).toBe(readBaseline().legacyToolFiles);
  });
});
