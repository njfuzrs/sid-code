/**
 * 活着的 judge promptPath 必须指向真实文件（11a PR-C / C4）。
 *
 * 评测不在 CI 里跑：漏改一处路径 = 运行时 ENOENT，门禁绿着失效。
 * 起草时 8 处里 5 个 `run-*-capability.ts` 已随 13 号 PR3c 删除。
 * ⛔ 不许再断言 8 处：死路径会让门禁要么恒红、要么跳过它们（绿着失效）。
 *
 * 反向自证：故意改错一个路径 ⇒ 必须红。只跑 happy path 分不清
 * 「逻辑对」与「checker 恒返 ok」。
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");

/**
 * 从赋值处抠路径字面量。`[\s\S]{0,N}` 贪心会跳到后面无关的 join ——
 * 实测 run-bench 会抠到 `console.log` 那段（门禁绿着指错文件）。
 * 所以锚在 `key` 后的**第一个** `join(..., "…")`，N 收成 80 且非贪心。
 */
function extractQuotedJoin(src: string, key: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`${key}[\\s\\S]{0,80}?join\\([^\\n]*["']([^"']+\\.md)["']`, "g");
  for (const m of src.matchAll(re)) out.push(m[1]!);
  return out;
}

const LIVE: { file: string; key: string; expectedSuffix: string; what: string }[] = [
  {
    file: "scripts/eval/run-bench.ts",
    key: "promptPath",
    expectedSuffix: "packages/eval-framework/judge/prompt-v2.md",
    what: "run-bench 唯一还活着的 v2 读者",
  },
  {
    file: "scripts/eval/run-cross-baseline.ts",
    key: "promptPath",
    expectedSuffix: "evals/_judge/prompt-v3.md",
    what: "run-cross-baseline 用 v3（路径不变）",
  },
  {
    file: "scripts/eval/calibrate-judge.ts",
    key: "JUDGE_PROMPT",
    expectedSuffix: "evals/_judge/prompt-v3.md",
    what: "calibrate-judge 用 v3（路径不变）",
  },
];

describe("活着的 promptPath 指向的文件存在", () => {
  test.each(LIVE)("$what → $expectedSuffix", ({ file, key, expectedSuffix }) => {
    const abs = join(ROOT, file);
    expect(existsSync(abs)).toBe(true);
    const src = readFileSync(abs, "utf-8");
    const hits = extractQuotedJoin(src, key);
    expect(hits, `${file} 里找不到 ${key} 的 join(...) 路径`).toContain(expectedSuffix);
    expect(existsSync(join(ROOT, expectedSuffix))).toBe(true);
  });

  test("恰好 3 处代码常量，不是起草时的 8 处", () => {
    expect(LIVE).toHaveLength(3);
  });
});

describe("反向自证：改错路径必须红", () => {
  test("把 v2 路径改回已搬走的旧位置 ⇒ 文件不存在", () => {
    const gone = join(ROOT, "evals/_judge/prompt-v2.md");
    expect(existsSync(gone)).toBe(false);
    const live = join(ROOT, "packages/eval-framework/judge/prompt-v2.md");
    expect(existsSync(live)).toBe(true);
  });

  test("extractQuotedJoin 真能抠到路径（空提取 = 门禁恒绿）", () => {
    const fixture = `promptPath: join(ROOT, "evals/_judge/prompt-v3.md"),`;
    expect(extractQuotedJoin(fixture, "promptPath")).toEqual(["evals/_judge/prompt-v3.md"]);
  });

  test("故意喂一条不存在的路径 ⇒ existsSync 为假（判定会翻转）", () => {
    const bogus = "evals/_judge/prompt-does-not-exist.md";
    expect(existsSync(join(ROOT, bogus))).toBe(false);
  });
});

describe("v3 注释出处没被顺手改错", () => {
  test("rubric-template.ts 仍指向 evals/_judge/prompt-v3.md", () => {
    const src = readFileSync(
      join(ROOT, "packages/eval-framework/judge/rubric-template.ts"),
      "utf-8",
    );
    expect(src).toContain("evals/_judge/prompt-v3.md");
  });
});
