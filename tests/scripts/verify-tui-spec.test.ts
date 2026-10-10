/**
 * verify-tui-spec（B9 / T0.3）的正确性 + 变异自证。
 *
 * 这道检查的失败模式是「永远绿」：表格格式一改、解析出 0 条，所有逐条检查都不跑。
 * 所以除了真实 SPEC 通过，每类错误都用合成 SPEC 证明会红。
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractTestIds,
  GROUPS,
  parseSpec,
  parseTestRef,
  SPEC_PATH,
  verify,
} from "../../scripts/verify-tui-spec.ts";

/** 每个分组各一条合法待办契约，作为合成 SPEC 的底座（否则「分组为空」会淹没要测的错误）。 */
const BASE = GROUPS.map((g) => `| ${g}90 | 行为 | 来源 | ⏳ T1.1 |`).join("\n");

function errorsOf(extra: string, setup?: (root: string) => void): string[] {
  const root = join(tmpdir(), `tui-spec-${process.pid}-${Math.random().toString(36).slice(2)}`);
  const tests = join(root, "packages/cli/tests/render-port");
  mkdirSync(tests, { recursive: true });
  try {
    setup?.(root);
    return verify(`${BASE}\n${extra}\n`, { root, portTestsDir: tests }).errors;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("解析", () => {
  test("只取四列且首列是 ID 的行；表头、分隔行、模式归属表跳过", () => {
    const md = [
      "| ID | 行为 | 来源 | 测试 |",
      "| --- | --- | --- | --- |",
      "| R1 | a | b | ⏳ T1.1 |",
      "| 模式 | 底座：开 | 底座：关 | CLI：开 | CLI：关 |",
      "| bracketed paste | x | y | z | w |",
    ].join("\n");
    expect(parseSpec(md).map((c) => c.id)).toEqual(["R1"]);
  });

  test("单元格里转义的 \\| 不当列分隔", () => {
    expect(parseSpec("| T2 | a \\| b | c | ⏳ T1.1 |")[0]!.behavior).toBe("a \\| b");
  });

  test("测试列三种形态", () => {
    // T0.5 已落地：阶段 0 的待办全部关闭，新契约不能再挂「待 T0.5」
    expect(parseTestRef("⏳ T0.5").kind).toBe("invalid");
    expect(parseTestRef("⏳ T8.1")).toEqual({ kind: "pending-later", task: "T8.1" });
    // T0.4 已落地：场景契约必须直接引用 scenarios.tsx，不能再挂「待 T0.4」
    expect(parseTestRef("⏳ T0.4 S3").kind).toBe("invalid");
    expect(parseTestRef("`a/b.test.ts` I1:")).toEqual({
      kind: "existing",
      file: "a/b.test.ts",
      fragment: "I1:",
    });
    expect(parseTestRef("TODO").kind).toBe("invalid");
    expect(parseTestRef("⏳ T0.4 S99").kind).toBe("invalid");
  });

  test("测试名里的 ID 前缀（test / it / describe / test.skip）", () => {
    const src = `test("I1: a", ()=>{}); it('R11: b'); describe(\`X3: c\`); test.skip("L4: d"); test("无前缀")`;
    expect(extractTestIds(src)).toEqual(["I1", "R11", "X3", "L4"]);
  });
});

describe("变异自证：每类错误都会红", () => {
  test("合法底座本身零错误", () => {
    expect(errorsOf("")).toEqual([]);
  });

  test("解析出 0 条（格式被改坏）", () => {
    const root = join(tmpdir(), `tui-spec-empty-${process.pid}`);
    mkdirSync(root, { recursive: true });
    try {
      const { errors } = verify("# 空\n", { root, portTestsDir: join(root, "none") });
      expect(errors.some((e) => e.includes("一条契约都没解析到"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("ID 重复", () => {
    expect(errorsOf("| R90 | 又一条 | 来源 | ⏳ T1.1 |").some((e) => e.includes("ID 重复"))).toBe(
      true,
    );
  });

  test("分组不在闭集", () => {
    expect(errorsOf("| Z1 | a | b | ⏳ T1.1 |").some((e) => e.includes("分组不在闭集"))).toBe(true);
  });

  test("来源为空", () => {
    expect(errorsOf("| R91 | a |  | ⏳ T1.1 |").some((e) => e.includes("来源为空"))).toBe(true);
  });

  test("测试列非法", () => {
    expect(errorsOf("| R92 | a | b | 回头补 |").some((e) => e.includes("测试列只能是"))).toBe(true);
  });

  test("引用的测试文件不存在", () => {
    expect(
      errorsOf("| R93 | a | b | `nope.test.ts` R93: |").some((e) => e.includes("测试文件不存在")),
    ).toBe(true);
  });

  test("测试文件在但片段对不上（测试改名后契约没跟）", () => {
    const errs = errorsOf("| R94 | a | b | `t.test.ts` R94: |", (root) =>
      writeFileSync(join(root, "t.test.ts"), `test("R95: x", () => {});`),
    );
    expect(errs.some((e) => e.includes("找不到片段"))).toBe(true);
  });

  test("孤儿测试：端口测试引用了 SPEC 里没有的 ID", () => {
    const errs = errorsOf("", (root) =>
      writeFileSync(
        join(root, "packages/cli/tests/render-port/x.test.ts"),
        `test("R77: x", () => {});`,
      ),
    );
    expect(errs.some((e) => e.includes("孤儿测试"))).toBe(true);
  });
});

describe("真实 SPEC.md", () => {
  const md = readFileSync(SPEC_PATH, "utf8");
  const { contracts, errors } = verify(md);

  test("零错误", () => {
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("规模下限：九个分组都有契约，总数不少于 50", () => {
    expect(contracts.length).toBeGreaterThanOrEqual(50);
    for (const g of GROUPS) expect(contracts.some((c) => c.group === g)).toBe(true);
  });

  test("T0.3 的两条硬要求已经有测试：I1（stdin 双读者）与 R11（D-3 Static 语义）", () => {
    for (const id of ["I1", "R11"]) {
      const c = contracts.find((x) => x.id === id)!;
      expect(parseTestRef(c.test).kind).toBe("existing");
    }
  });
});
