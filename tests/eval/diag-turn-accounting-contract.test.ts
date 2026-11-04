/**
 * `diag-turn-accounting.py` 的门禁 —— 保住 T10a 诊断出的那个口径判据。
 *
 * ## 为什么需要这条门禁（`evals/CLAUDE.md` §4.1）
 *
 * 仓库的八道门禁一道都不认 `.py`。而这份脚本的**唯一价值**就是那条口径判据：
 * `num_turns` 在轨迹兜底分支里不是轮次，而是 `total_steps`。
 * 判据一旦被后来的改动抹掉，脚本照样退出 0、照样打表 —— 只是结论静默变错，
 * 而下游（T10b 的修复方向、P2 的基线口径）会照着错结论走。
 *
 * ## 两层结构（§4.2：不允许「探测失败就 skip」）
 *
 * | 层 | 依赖 | CI 上 | 拦什么 |
 * | --- | --- | --- | --- |
 * | L1 静态 | `python3` + stdlib `ast` | ✅ 真的在跑 | 语法坏了 / 判据常量被合并 / 关键函数被删 |
 * | L1 动态 | `python3`（脚本只用 stdlib） | ✅ 真的在跑 | `--self-test` 里的 15 条判据全部真的通过 |
 *
 * 两层都**不依赖 harbor**，所以不存在「CI 上永远 skip」那条老路。
 *
 * ## 变异自证（§4.3）
 *
 * 两条变异都作用在 tmpdir 的副本上，不动真源文件：
 * ① 把兜底分支的返回值改成正常档 → `--self-test` 必须红；
 * ② 把兜底常量改成与正常档同值 → 静态断言必须红（三档必须是闭集且互不相同）。
 *
 * 判据是**红的是哪一条**，不是「有东西红了」—— 所以下面每条 `expect` 都带自己的
 * 失败信息。
 */

import { describe, test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const SCRIPT = join(
  import.meta.dir,
  "..",
  "..",
  "evals",
  "external-benchmarks",
  "harbor",
  "diag-turn-accounting.py",
);

/** 用 stdlib `ast` 解析源文件，**只提取事实，不做判断**（判断留在 TS 侧）。 */
const L1_CHECKER = String.raw`
import ast, json, sys
src = open(sys.argv[1], encoding="utf-8").read()
tree = ast.parse(src)
consts = {}
for node in tree.body:
    if isinstance(node, ast.Assign) and len(node.targets) == 1:
        t = node.targets[0]
        if isinstance(t, ast.Name) and t.id.isupper():
            try:
                consts[t.id] = ast.literal_eval(node.value)
            except Exception:
                pass
funcs = [n.name for n in tree.body if isinstance(n, ast.FunctionDef)]
print(json.dumps({"consts": consts, "funcs": funcs}, ensure_ascii=False))
`;

function factsOf(path: string): { consts: Record<string, unknown>; funcs: string[] } {
  const r = spawnSync("python3", ["-c", L1_CHECKER, path], { encoding: "utf-8" });
  // ⛔ 这里不能用 expect：checker 自己失败（语法坏掉 / python3 缺失）必须与
  // 「断言不成立」区分开，否则排查时会朝错的方向看。
  if (r.status !== 0) {
    throw new Error(`L1 checker 退出 ${r.status}\n${r.stderr || r.stdout}`);
  }
  return JSON.parse(r.stdout);
}

function runSelfTest(path: string): { status: number | null; out: string } {
  const r = spawnSync("python3", [path, "--self-test"], { encoding: "utf-8" });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe("diag-turn-accounting.py：口径判据门禁", () => {
  test("L1 静态：三档取数路径是闭集且互不相同", () => {
    const { consts } = factsOf(SCRIPT);
    const keys = [
      "TURNS_SOURCE_RESULT",
      "TURNS_SOURCE_TRAJ_FALLBACK",
      "TURNS_SOURCE_MISSING",
    ] as const;
    for (const k of keys) {
      expect(consts[k], `常量 ${k} 必须存在（判据的分档名）`).toBeTypeOf("string");
    }
    const values = keys.map((k) => consts[k] as string);
    expect(new Set(values).size, `三档取值必须互不相同，实际: ${values.join(" / ")}`).toBe(3);
    // 兜底档的名字必须自证它指的是轨迹，不是轮次 —— 改名的同时必须改文档与消费侧。
    expect(values[1]).toContain("traj");
  });

  test("L1 静态：关键函数都在（判据、分析、渲染、自检）", () => {
    const { funcs } = factsOf(SCRIPT);
    for (const fn of ["classify_turns_source", "analyze", "render", "self_test"]) {
      expect(funcs, `函数 ${fn} 被删或改名了`).toContain(fn);
    }
  });

  test("L1 动态：--self-test 全部通过，且真的跑了判据", () => {
    const { status, out } = runSelfTest(SCRIPT);
    expect(status, `--self-test 退出 ${status}\n${out}`).toBe(0);
    expect(out).not.toContain("❌");
    // 只断言退出 0 不够：一个把 check() 全删掉的版本也退 0。
    // 15 = classify 的 4 条 + analyze/render 的 9 条 + 2 条变异。
    const passed = (out.match(/✅/g) ?? []).length;
    expect(passed, `自检只跑了 ${passed} 条断言（期望 ≥ 15）`).toBeGreaterThanOrEqual(15);
  });

  test("变异①：把兜底分支改回正常档 → 自检必须红", () => {
    const dir = mkdtempSync(join(tmpdir(), "diag-turn-"));
    try {
      const copy = join(dir, "diag-turn-accounting.py");
      copyFileSync(SCRIPT, copy);
      const src = readFileSync(copy, "utf-8");
      const broken = src.replace(
        "    if without is None:\n        return TURNS_SOURCE_TRAJ_FALLBACK",
        "    if without is None:\n        return TURNS_SOURCE_RESULT",
      );
      expect(broken, "变异没打上：找不兜底分支的 return（脚本结构变了？）").not.toBe(src);
      writeFileSync(copy, broken, "utf-8");
      const { status, out } = runSelfTest(copy);
      expect(status, `兜底分支被改坏后自检仍然通过 —— 判据没有真在守\n${out}`).toBe(1);
      expect(out).toContain("T0002 判兜底");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("变异②：三档常量被合并成一档 → 静态断言必须红", () => {
    const dir = mkdtempSync(join(tmpdir(), "diag-turn-"));
    try {
      const copy = join(dir, "diag-turn-accounting.py");
      copyFileSync(SCRIPT, copy);
      const src = readFileSync(copy, "utf-8");
      const broken = src.replace(
        'TURNS_SOURCE_TRAJ_FALLBACK = "session-traj-fallback"',
        'TURNS_SOURCE_TRAJ_FALLBACK = "stream-json-result"',
      );
      expect(broken, "变异没打上：找不到兜底常量赋值").not.toBe(src);
      writeFileSync(copy, broken, "utf-8");
      const { consts } = factsOf(copy);
      const values = [
        consts["TURNS_SOURCE_RESULT"],
        consts["TURNS_SOURCE_TRAJ_FALLBACK"],
        consts["TURNS_SOURCE_MISSING"],
      ];
      expect(new Set(values).size, "三档被合并后必须不再等于 3").toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
