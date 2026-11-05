/**
 * L2 判定器（方案 T12 / §5.2）与配对对照（外部评测缺陷 28）的**形态与接线**门禁。
 *
 * ## 为什么这个文件必须存在
 *
 * 仓库的五道门禁（`bun test` / `make build` / `bun run lint` / `format:check` /
 * `lint:boundary`）**一道都不认 `.py`**（`evals/CLAUDE.md` §4.1）。而 T12 交付的是
 * 判定器 + 配对脚本改造，**每一个环节坏掉都不会有东西报错**：
 *
 * | 坏法 | 后果 |
 * | --- | --- |
 * | `VERDICTS` 少一种结论 | `release.sh` 少一个必须处理的分支 —— 静默放行 |
 * | 阈值被顺手调松（`INFRA_FAULT_MAX_RATIO` 0.10 → 0.20） | 故障率翻倍才拦，报告照样漂亮 |
 * | `VERDICT_RULE_VERSION` 另立一个字符串 | 同一批产物用两套判据能得出相反结论，而指纹看起来「一致」 |
 * | 判定器自己重写排除判据 | 两个脚本对「这题算不算数」给出不同答案（`verifier_health.py` 文件头那个坑） |
 * | `compare-paired.py` 只查一个方向 | 换档后多出来的题被静默丢弃（缺陷 28 原形态） |
 *
 * ## 分层（照 `harbor-run-fingerprint.test.ts` 的 L1/L2 切法，`evals/CLAUDE.md` §4.2）
 *
 * - **L1 静态**：只要 `python3`（stdlib `ast`，**不 import harbor**）→ **CI 上真的在跑**
 * - **行为**：跑 `test-eval-verdict.py` 与 `test-compare-paired.py`，它们也只用 stdlib
 *   → **CI 上真的在跑**
 *
 * ⛔ 本文件**没有一条 `skip`**。§4.2 的判据：探测依赖失败就 skip = 门禁不存在。
 *
 * ## 变异自证（`evals/CLAUDE.md` §4.3）
 *
 * 最后一组在 **tmpdir 的副本**上把判据改坏（不动真源文件），断言判定翻转。
 * 覆盖四类：删掉被测的那一行 / 改一个阈值 / 抠出空集 / 语法整体坏掉。
 */
import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const HARBOR = join(import.meta.dir, "../../evals/external-benchmarks/harbor");
const PY = join(HARBOR, "eval-verdict.py");
const TEST_PY = join(HARBOR, "test-eval-verdict.py");
const CMP_PY = join(HARBOR, "compare-paired.py");
const TEST_CMP_PY = join(HARBOR, "test-compare-paired.py");
const OUTCOMES_PY = join(HARBOR, "trial_outcomes.py");

/** python3 是 macOS 与 GitHub runner 自带的。真缺才是环境问题，不是设计上的 skip。 */
const HAS_PYTHON3 = (Bun.spawnSync({ cmd: ["python3", "--version"] }).exitCode ?? 1) === 0;

/**
 * 只读**代码行**，不读注释。
 *
 * ⚠️ 本仓踩过：注释里写了关键词、真正的注入行被摘掉，门禁照绿。
 * 所以凡断言「某行存在」的地方，一律先剥掉整行注释。
 */
const codeOf = (p: string) =>
  readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");

// ─────────────────────────────────────────────────────── L1：stdlib ast 提事实

/**
 * 从 `eval-verdict.py` 提事实。**只解析、不执行** —— 执行会跑 `main()`。
 *
 * 与 `harbor-run-fingerprint.test.ts` 的 `runL1` 同一种做法：把「读源码」这件事
 * 交给 Python 自己的 AST（比正则稳），判断留在 TS 侧（`evals/CLAUDE.md` §4.1）。
 */
const L1_CHECKER = `
import ast, json, sys

path = sys.argv[1]
try:
    tree = ast.parse(open(path, encoding="utf-8").read())
except SyntaxError as exc:
    print(f"SYNTAX_ERROR: {exc}", file=sys.stderr)
    sys.exit(3)

facts = {
    "verdicts": None,
    "exit_map": {},
    "consts": {},
    "fraction_consts": {},
    "attr_consts": {},
    "functions": [],
    "imports": [],
    "calls": [],
}

def const_strs(node):
    return [e.value for e in getattr(node, "elts", []) if isinstance(e, ast.Constant)]

for node in tree.body:
    if isinstance(node, ast.Import):
        facts["imports"].extend(a.name for a in node.names)
    elif isinstance(node, ast.ImportFrom):
        if node.module:
            facts["imports"].append(node.module)
    elif isinstance(node, (ast.Assign, ast.AnnAssign)):
        targets = node.targets if isinstance(node, ast.Assign) else [node.target]
        value = node.value
        for t in targets:
            if not isinstance(t, ast.Name):
                continue
            if t.id == "VERDICTS" and isinstance(value, ast.Tuple):
                facts["verdicts"] = const_strs(value)
            elif t.id == "EXIT" and isinstance(value, ast.Dict):
                for k, v in zip(value.keys, value.values):
                    if isinstance(k, ast.Constant) and isinstance(v, ast.Constant):
                        facts["exit_map"][k.value] = v.value
            elif isinstance(value, ast.Constant):
                facts["consts"][t.id] = value.value
            elif (
                isinstance(value, ast.Call)
                and isinstance(value.func, ast.Name)
                and value.func.id == "Fraction"
            ):
                args = [a.value for a in value.args if isinstance(a, ast.Constant)]
                if len(args) == 2:
                    facts["fraction_consts"][t.id] = args
            elif isinstance(value, ast.Attribute):
                base = value.value
                if isinstance(base, ast.Name):
                    facts["attr_consts"][t.id] = f"{base.id}.{value.attr}"
    elif isinstance(node, ast.FunctionDef):
        facts["functions"].append(node.name)

for node in ast.walk(tree):
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
        base = node.func.value
        if isinstance(base, ast.Name):
            facts["calls"].append(f"{base.id}.{node.func.attr}")

print(json.dumps(facts, ensure_ascii=False))
`;

interface L1Facts {
  verdicts: string[] | null;
  exit_map: Record<string, number>;
  consts: Record<string, number | string>;
  fraction_consts: Record<string, number[]>;
  attr_consts: Record<string, string>;
  functions: string[];
  imports: string[];
  calls: string[];
}

function runL1(pyFile: string): { code: number; facts: L1Facts | null; stderr: string } {
  const proc = Bun.spawnSync({
    cmd: ["python3", "-c", L1_CHECKER, pyFile],
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = proc.exitCode ?? 1;
  const stdout = proc.stdout?.toString() ?? "";
  return {
    code,
    facts: code === 0 && stdout.trim() ? (JSON.parse(stdout) as L1Facts) : null,
    stderr: proc.stderr?.toString() ?? "",
  };
}

describe.if(HAS_PYTHON3)("L1 判定器形态（stdlib ast，零依赖）", () => {
  const { code, facts, stderr } = runL1(PY);

  test("源文件语法合法且能解析出 eval-verdict.py", () => {
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(facts).not.toBeNull();
  });

  test("结论是 §5.2 的四种，一种不多一种不少（闭集）", () => {
    // ⚠️ 空集会让下面每条都空转通过；多一种则 `release.sh` 要处理一个它不知道的分支。
    expect([...(facts!.verdicts ?? [])].sort()).toEqual(["INVALID", "PASS", "REGRESSION", "WARN"]);
  });

  test("退出码：PASS / WARN 放行，REGRESSION / INVALID 阻断且互不相同", () => {
    expect(facts!.exit_map.PASS).toBe(0);
    expect(facts!.exit_map.WARN).toBe(0);
    expect(facts!.exit_map.REGRESSION).not.toBe(0);
    expect(facts!.exit_map.INVALID).not.toBe(0);
    // 两种阻断的处置不同（一个「出结论但拦」，一个「不出结论」），退出码不能合并
    expect(facts!.exit_map.INVALID).not.toBe(facts!.exit_map.REGRESSION);
  });

  test("§5.2 的阈值逐个对上（防「顺手调松」）", () => {
    // 这些数字是文档写死、P2 结束时冻结的。调它们必须同时改文档与 Agent Note，
    // 而不是让它悄悄通过。
    expect(facts!.consts.INFRA_FAULT_MAX_RATIO).toBe(0.1);
    expect(facts!.consts.CACHE_DROP_PP).toBe(10);
    expect(facts!.consts.COST_RISE_RATIO).toBe(0.3);
    expect(facts!.consts.MIN_STABLE_FOR_BLOCKING).toBe(6);
    expect(facts!.consts.DEGRADED_MIN_PASS_RATE).toBe(0.5);
    // 精确有理数：0.15 的浮点展开在 |S|=10 那条边界上会翻一档
    expect(facts!.fraction_consts.EPSILON_FLOOR).toEqual([1, 10]);
    expect(facts!.fraction_consts.ALPHA).toEqual([1, 20]);
  });

  test("VERDICT_RULE_VERSION 复用 run_fingerprint，不另立字符串", () => {
    // 同一批产物用两套判据能得出相反结论，那时差异不是配置造成的 —— 所以版本号
    // 必须与 T11 的指纹共用同一个常量，否则指纹比对会以为「配置变了」。
    expect(facts!.attr_consts.VERDICT_RULE_VERSION).toBe("run_fingerprint.VERDICT_RULE_VERSION");
  });

  test("判定链路的函数齐备（少一个都会静默给不出结论）", () => {
    for (const fn of [
      "binomial_tail",
      "min_m",
      "mcnemar_one_sided_p",
      "stable_set",
      "validate_baseline",
      "current_fingerprint",
      "evaluate",
      "render",
      "main",
    ]) {
      expect(facts!.functions).toContain(fn);
    }
  });

  test("复用共享模块，不重写判据（evals/CLAUDE.md §0）", () => {
    // 逐题结局只能有一个取数处（trial_outcomes），指纹比对只能有一个实现
    // （run_fingerprint）。重写一份的形态是「两个脚本对同一题给出不同答案」。
    expect(facts!.imports).toContain("trial_outcomes");
    expect(facts!.imports).toContain("run_fingerprint");
    expect(facts!.calls).toContain("run_fingerprint.compare");
    expect(facts!.calls).toContain("run_fingerprint.collect");
    expect(facts!.calls).toContain("O.load_runs");
  });
});

// ─────────────────────────────── 缺陷 28：compare-paired.py 的双向检查在代码里

describe("compare-paired.py 双向题集检查（外部评测缺陷 28）", () => {
  const code = codeOf(CMP_PY);

  test("两个方向的集合差都在（少一侧就是原缺陷）", () => {
    expect(code).toContain("set(base) - set(new)");
    expect(code).toContain("set(new) - set(base)");
  });

  test("new_only 进结论分支（打印了但不拦，等于没修）", () => {
    // 缺陷 28 的形态：打印处有、结论处没有 ⇒ 均值照样被引用。
    const conclusion = code.slice(code.indexOf("=== 结论 ==="));
    expect(conclusion).toContain("new_only");
    expect(conclusion).toMatch(/rc = 2/);
  });

  test("base_only 没有放行开关（它是「尚未跑」，不存在合法忽略）", () => {
    // `--allow-extra` 只能放行 new_only；给 base_only 也开口子会让「没跑完」
    // 变成可以显式忽略的东西。
    expect(code).toContain("if base_only:");
    expect(code).not.toContain("base_only and not args.allow_extra");
  });

  test("逐题结局来自 trial_outcomes，不自己写排除链", () => {
    expect(code).toContain("import trial_outcomes");
    expect(code).toContain("trial_outcomes as O");
    // 旧实现里的六个排除字符串不该再出现在本文件
    for (const s of ["verifier未判分", "零调用", "启动未完成", "上游打断"]) {
      expect(code).not.toContain(s);
    }
  });
});

describe("trial_outcomes.py 是逐题结局的唯一取数处", () => {
  test("文件存在且声明了 Outcome / load_run / load_runs", () => {
    expect(existsSync(OUTCOMES_PY)).toBe(true);
    const code = codeOf(OUTCOMES_PY);
    for (const name of ["class Outcome", "def load_run", "def load_runs", "def read_result"]) {
      expect(code).toContain(name);
    }
  });

  test("排除顺序与 compare-paired.py 原实现一致（`is False` 不是 `not`）", () => {
    // 这一条是 2026-09-03 那次实测的教训：`not` 会把没有 debug.log 的整侧排除掉。
    const code = codeOf(OUTCOMES_PY);
    expect(code).toContain("agent_ran(d) is False");
    expect(code).toContain("agent_started(trial_dir) is False");
    expect(code).not.toContain("agent_ran(d) is not True");
  });
});

// ───────────────────────────────────────────── 行为：真跑 Python 侧测试（CI 也跑）

describe.if(HAS_PYTHON3)("Python 侧行为测试（含 6 组人造产物与变异自证，CI 上也跑不 skip）", () => {
  test("test-eval-verdict.py 退出 0", () => {
    const r = spawnSync("python3", [TEST_PY], {
      encoding: "utf8",
      cwd: HARBOR,
      timeout: 120_000,
    });
    if (r.status !== 0) {
      throw new Error(
        `test-eval-verdict.py rc=${r.status}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`,
      );
    }
    expect(r.status).toBe(0);
    // 顺带确认它真的跑了断言，不是空转退出 0
    expect(r.stdout).toContain("失败 0");
  });

  test("test-compare-paired.py 退出 0", () => {
    const r = spawnSync("python3", [TEST_CMP_PY], {
      encoding: "utf8",
      cwd: HARBOR,
      timeout: 60_000,
    });
    if (r.status !== 0) {
      throw new Error(
        `test-compare-paired.py rc=${r.status}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`,
      );
    }
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("失败 0");
  });
});

// ────────────────────────────────────────────── 变异自证：改坏判据，判定必须翻转

describe.if(HAS_PYTHON3)("变异自证：门禁真的在看这些行（tmpdir 副本，不动真源文件）", () => {
  const ORIGINAL = readFileSync(PY, "utf8");
  let dir = "";

  // 惰性创建：不依赖「某个 test 先跑过」。测试执行顺序一旦变化，
  // 那种「靠前一条 test 准备环境」的写法会变成 ENOENT，而报错指向变异用例，
  // 读起来像是判据坏了 —— 归因方向完全错。
  const workdir = (): string => {
    if (!dir) dir = mkdtempSync(join(tmpdir(), "eval-verdict-gate-"));
    return dir;
  };

  const mutated = (mutate: (s: string) => string): string => {
    const p = join(workdir(), `m${Math.random().toString(36).slice(2)}.py`);
    writeFileSync(p, mutate(ORIGINAL), "utf8");
    return p;
  };

  test("① 删掉一个阈值常量 → 「阈值逐个对上」断言翻转", () => {
    // 防的是「门禁真的在看这一行」。删掉之后 facts 里没有这个键 ——
    // 真门禁那条 `toBe(0.1)` 会拿到 undefined 而红。
    const p = mutated((s) => s.replace(/^INFRA_FAULT_MAX_RATIO = 0\.10$/m, ""));
    const { facts } = runL1(p);
    expect(facts!.consts.INFRA_FAULT_MAX_RATIO).toBeUndefined();
    expect(facts!.consts.INFRA_FAULT_MAX_RATIO).not.toBe(0.1);
  });

  test("② 把阈值改松一档 → 「等于 0.10」断言翻转（拦的是值不是存在性）", () => {
    // 这一条最容易漏：只测「常量存在」，下一个被调松的值仍会掉在同一条边界上。
    const p = mutated((s) =>
      s.replace("INFRA_FAULT_MAX_RATIO = 0.10", "INFRA_FAULT_MAX_RATIO = 0.20"),
    );
    const { facts } = runL1(p);
    expect(facts!.consts.INFRA_FAULT_MAX_RATIO).toBe(0.2);
    expect(facts!.consts.INFRA_FAULT_MAX_RATIO).not.toBe(0.1);
  });

  test("③ 把 VERDICTS 抠成空集 → 「四种结论齐备」断言翻转（绿着失效的一种）", () => {
    const p = mutated((s) => s.replace(/^VERDICTS = \(.*\)$/m, "VERDICTS = ()"));
    const { facts } = runL1(p);
    expect(facts!.verdicts).toEqual([]);
    // 真门禁那条是 `toEqual([...四种])`。在空集上它会红 ——
    // 这里断言「它确实变成空集」，即那条断言此刻应当失败。
    expect([...(facts!.verdicts ?? [])].sort()).not.toEqual([
      "INVALID",
      "PASS",
      "REGRESSION",
      "WARN",
    ]);
  });

  test("④ VERDICT_RULE_VERSION 改成自己写的字符串 → 「复用」断言翻转", () => {
    // 这一条守的是跨脚本契约：判定器和指纹必须用同一个版本号。
    const p = mutated((s) =>
      s.replace(
        "VERDICT_RULE_VERSION = run_fingerprint.VERDICT_RULE_VERSION",
        'VERDICT_RULE_VERSION = "1"',
      ),
    );
    const { facts } = runL1(p);
    expect(facts!.attr_consts.VERDICT_RULE_VERSION).toBeUndefined();
  });

  test("⑤ 语法整体坏掉 → checker 自己非 0 退出（不是静默返回空事实）", () => {
    const p = mutated((s) => s + "\ndef broken(:\n");
    const { code, facts, stderr } = runL1(p);
    expect(code).not.toBe(0);
    expect(facts).toBeNull();
    expect(stderr).toContain("SYNTAX_ERROR");
  });

  test("清理 tmpdir", () => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
});
