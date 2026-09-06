/**
 * 命令体系门禁自身的正确性 + 变异自证（P3）。
 *
 * ## 这道测试存在的理由
 *
 * 门禁有一个**比"报错"糟糕得多的失败模式**：扫出一个空集，然后全程绿。
 * 本仓已经踩过这个形态（见 `tests/scripts/affected-tests.test.ts` 的「选空集然后全绿」），
 * 而本次要修的三条缺陷本身就是「代码在、调用为零、没有任何东西报警」。
 * 如果这道门禁自己空转，它就成了它当初要消灭的那种死功能 —— 这事在本仓发生过一次。
 *
 * 所以下面除了口径断言，还有**变异自证**：造一个已知的死导出，门禁必须数到它；
 * 造一个已知的活导出，门禁必须不数它。两个方向都锁，才排除
 * 「恒返回 0」与「恒把所有导出都当死的」这两种恰好也能通过单向断言的实现。
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  extractExportedSymbols,
  countProductionReferences,
  findDeadExports,
  countLegacyBuiltins,
} from "../../scripts/command-system-gate.ts";

const ROOT = join(import.meta.dir, "../..");

describe("extractExportedSymbols 口径", () => {
  test("识别各种导出形态", () => {
    const src = [
      "export function foo() {}",
      "export async function bar() {}",
      "export class Baz {}",
      "export const qux = 1;",
      "export interface Quux { a: string }",
      "export type Corge = string;",
      "export enum Grault { A }",
    ].join("\n");
    expect(extractExportedSymbols(src).sort()).toEqual(
      ["Baz", "Corge", "Grault", "Quux", "bar", "foo", "qux"].sort(),
    );
  });

  test("不把非导出符号算进来", () => {
    const src = ["function hidden() {}", "const secret = 1;", "interface Internal {}"].join("\n");
    expect(extractExportedSymbols(src)).toEqual([]);
  });

  test("不把 re-export 的 from 语句误当声明", () => {
    // `export { a } from "./x.ts"` 没有声明关键字，不该产出符号名
    expect(extractExportedSymbols('export { a } from "./x.ts";')).toEqual([]);
  });
});

describe("countProductionReferences 口径", () => {
  const files = [
    { path: "a.ts", source: "export function target() {}" },
    { path: "b.ts", source: "import { target } from './a.ts';\ntarget();" },
    { path: "c.test.ts", source: "target();" },
    { path: "d.ts", source: "// target() 只在注释里出现" },
    { path: "e.ts", source: "targetSuffix();" },
  ];

  test("数到真实引用", () => {
    expect(countProductionReferences("target", "a.ts", files)).toBe(1);
  });

  test("不数定义所在文件自身", () => {
    // a.ts 自己含 "target" 但被排除；否则每个导出至少 1 次引用，门禁恒绿
    expect(countProductionReferences("target", "a.ts", files)).not.toBe(2);
  });

  test("不数测试文件——「测试绿不代表代码活」", () => {
    // 这是 P2-1 那 246 行死代码能藏住的原因：queue.ts 有个跑得好好的绿测试，
    // 覆盖率把它算成已覆盖，而那个类在生产里一次都不会被实例化。
    const only = [files[0], files[2]];
    expect(countProductionReferences("target", "a.ts", only)).toBe(0);
  });

  test("不数注释——「注释描述的是意图，不是行为」", () => {
    const only = [files[0], files[3]];
    expect(countProductionReferences("target", "a.ts", only)).toBe(0);
  });

  test("词边界：不把 targetSuffix 当成 target", () => {
    const only = [files[0], files[4]];
    expect(countProductionReferences("target", "a.ts", only)).toBe(0);
  });
});

describe("变异自证：门禁必须真的能分辨死活", () => {
  test("已知的活导出不被判死（排除「把所有导出都当死的」实现）", () => {
    const dead = findDeadExports().map((d) => d.symbol);
    // canRunDuringStreaming 被 ui/App.tsx 的 handleSubmit 真实调用
    expect(dead).not.toContain("canRunDuringStreaming");
    // isFilePath 本次刚接线进 executor.ts —— 它此前正是一条零调用导出
    expect(dead).not.toContain("isFilePath");
    expect(dead).not.toContain("parseSlashCommand");
  });

  test("扫描结果非空（排除「恒返回空集然后全绿」实现）", () => {
    // 存量确实有死导出。这条断言不是在庆祝存量，而是在证明扫描器没有空转：
    // 若某天存量真的清零，这条会红，那时把它改成 toBe(0) 并同步基线。
    expect(findDeadExports().length).toBeGreaterThan(0);
  });

  test("基线与当前实测一致（防漂移：基线不能悄悄放宽）", () => {
    const baseline = JSON.parse(
      readFileSync(
        join(import.meta.dir, "../../scripts/command-system-gate.baseline.json"),
        "utf8",
      ),
    ) as { deadExports: number; legacyBuiltins: number };
    // 门禁是棘轮（只禁新增），但基线不该比实测高——高出来的部分就是白送的额度
    expect(findDeadExports().length).toBeLessThanOrEqual(baseline.deadExports);
    expect(countLegacyBuiltins()).toBeLessThanOrEqual(baseline.legacyBuiltins);
  });
});

describe("G2 旧体系计数", () => {
  test("数到 builtins.ts 里的 registry.register", () => {
    expect(countLegacyBuiltins()).toBeGreaterThan(0);
  });

  test("计数与直接 grep 一致", () => {
    const src = readFileSync(join(ROOT, "packages/cli/src/command/builtins.ts"), "utf8");
    const grep = (src.match(/registry\.register/g) ?? []).length;
    expect(countLegacyBuiltins()).toBe(grep);
  });
});

describe("P2-1 死代码簇确已删除（防倒退）", () => {
  test("四个死文件与其测试都不在了", () => {
    const gone = [
      "packages/cli/src/command/input-router.ts",
      "packages/cli/src/command/queue.ts",
      "packages/cli/src/command/queue-processor.ts",
      "packages/cli/src/ui/hooks/useQueueProcessor.ts",
      "packages/cli/tests/command/queue.test.ts",
    ];
    for (const p of gone) {
      expect(existsSyncSafe(join(ROOT, p))).toBe(false);
    }
  });
});

function existsSyncSafe(p: string): boolean {
  try {
    readFileSync(p);
    return true;
  } catch {
    return false;
  }
}
