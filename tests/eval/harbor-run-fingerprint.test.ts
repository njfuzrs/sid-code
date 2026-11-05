/**
 * run 级指纹（方案 T11 / §3.4）的**接线与形态**门禁。
 *
 * ## 为什么这个文件必须存在
 *
 * 仓库的五道门禁（`bun test` / `make build` / `bun run lint` / `format:check` /
 * `lint:boundary`）**一道都不认 `.py`**（`evals/CLAUDE.md` §4.1）。而 T11 交付的是
 * 三个 Python 文件加四条 shell 接线，**每一个环节坏掉都不会有东西报错**：
 *
 * | 坏法 | 后果 |
 * | --- | --- |
 * | `run_fingerprint.py` 的 `FIELDS` 少一个字段 | 该字段**静默不参与比对**，两份指纹看起来「全一致」 |
 * | `SOURCES` 少一个键 | 那个数说不出取数源（违反 §1.7），而报告照样漂亮 |
 * | 跑法脚本忘了调 `run_fingerprint_collect` | 工具在、**零次被执行** —— 本仓 `w3-summary.py` 的原注释记着同型教训（digest 工具九棒里零次被跑过） |
 * | `sid_code_agent.py` 不落 `sid_max_turns` | 指纹里 `max_turns` 恒 null → 两次不同轮数的 run 被判「无法比较」而非「不一致」 |
 *
 * 所以本文件锁的是**形态与接线**；字段级的**行为**（逐字段变异 → INVALID 且点名）
 * 在 `evals/external-benchmarks/harbor/test-run-fingerprint.py`，由下面第三组真跑。
 *
 * ## 分层（照 `harbor-agent-contract.test.ts` 的 L1/L2 切法，`evals/CLAUDE.md` §4.2）
 *
 * - **L1 静态**：只要 `python3`（stdlib `ast`，**不 import harbor**）→ **CI 上真的在跑**
 * - **行为**：跑 `test-run-fingerprint.py`，它也只用 stdlib → **CI 上真的在跑**
 *
 * ⛔ 本文件**没有一条 `skip`**。§4.2 的判据：探测依赖失败就 skip = 门禁不存在，
 * 而 skip 条件写错的门禁与不存在的门禁在 CI 上是同一个东西。
 *
 * ## 变异自证（`evals/CLAUDE.md` §4.3）
 *
 * 最后一组在 **tmpdir 的副本**上把判据改坏（不动真源文件），断言判定翻转。
 * 覆盖四类：删掉被测的那一行 / 加一个「下一个」同类项 / 抠出空集 / 语法整体坏掉。
 */
import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const HARBOR = join(import.meta.dir, "../../evals/external-benchmarks/harbor");
const PY = join(HARBOR, "run_fingerprint.py");
const TEST_PY = join(HARBOR, "test-run-fingerprint.py");
const SH = join(HARBOR, "run-fingerprint.sh");
const AGENT_PY = join(HARBOR, "sid_code_agent.py");

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
 * 从 `run_fingerprint.py` 提事实。**只解析、不执行** —— 执行会跑 `main()`。
 *
 * 与 `harbor-agent-contract.test.ts` 的 `runL1` 同一种做法：把「读源码」这件事
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
    "fields": None,
    "declared_only": None,
    "sources_keys": None,
    "verdict_rule_version": None,
    "exit_map": {},
    "functions": [],
    "has_raise_on_unknown": False,
}

def const_strs(node):
    return [e.value for e in getattr(node, "elts", []) if isinstance(e, ast.Constant)]

for node in tree.body:
    if isinstance(node, (ast.Assign, ast.AnnAssign)):
        targets = node.targets if isinstance(node, ast.Assign) else [node.target]
        value = node.value
        for t in targets:
            if not isinstance(t, ast.Name):
                continue
            if t.id == "FIELDS" and isinstance(value, ast.Tuple):
                facts["fields"] = const_strs(value)
            elif t.id == "DECLARED_ONLY" and isinstance(value, ast.Tuple):
                facts["declared_only"] = const_strs(value)
            elif t.id == "SOURCES" and isinstance(value, ast.Dict):
                facts["sources_keys"] = [
                    k.value for k in value.keys if isinstance(k, ast.Constant)
                ]
            elif t.id == "VERDICT_RULE_VERSION" and isinstance(value, ast.Constant):
                facts["verdict_rule_version"] = value.value
            elif t.id == "EXIT" and isinstance(value, ast.Dict):
                for k, v in zip(value.keys, value.values):
                    if isinstance(k, ast.Constant) and isinstance(v, ast.Constant):
                        facts["exit_map"][k.value] = v.value
    elif isinstance(node, ast.FunctionDef):
        facts["functions"].append(node.name)

# 「白名单而非黑名单」的形态判据：未知键必须 raise，不是静默忽略。
for node in ast.walk(tree):
    if isinstance(node, ast.Raise) and isinstance(node.exc, ast.Call):
        func = node.exc.func
        if isinstance(func, ast.Name) and func.id == "ValueError":
            facts["has_raise_on_unknown"] = True

print(json.dumps(facts, ensure_ascii=False))
`;

interface L1Facts {
  fields: string[] | null;
  declared_only: string[] | null;
  sources_keys: string[] | null;
  verdict_rule_version: string | null;
  exit_map: Record<string, number>;
  functions: string[];
  has_raise_on_unknown: boolean;
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

describe.if(HAS_PYTHON3)("L1 指纹字段清单的形态（stdlib ast，零依赖）", () => {
  const { code, facts, stderr } = runL1(PY);

  test("源文件语法合法且能解析出 run_fingerprint", () => {
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(facts).not.toBeNull();
  });

  test("FIELDS 非空（空集会让下面每条都空转通过）", () => {
    expect(facts!.fields!.length).toBeGreaterThan(0);
  });

  test("§3.4 点名的四个字段都在 FIELDS 里", () => {
    // 方案原文：「fingerprint（`model_id`、二进制 sha256、`taskset_digest`、
    // `verdict_rule_version` 等）」。这四个是点名项，少一个就不是 §3.4 的指纹。
    for (const f of ["model_id", "sid_binary_sha256", "taskset_digest", "verdict_rule_version"]) {
      expect(facts!.fields).toContain(f);
    }
  });

  test("§3.4 的其余必控变量也在（轮数/预算/网络/权限/架构/harbor 版本/题集 commit）", () => {
    for (const f of [
      "arch",
      "harbor_version",
      "traj_bench_commit",
      "max_turns",
      "budget_usd",
      "network_policy",
      "permission_mode",
    ]) {
      expect(facts!.fields).toContain(f);
    }
  });

  test("SOURCES 覆盖 FIELDS 全集 —— 每个数都能指到取数源（§1.7）", () => {
    // ⚠️ 这是本文件最重要的一条：少一个 SOURCES 键不会让任何东西报错，
    // 只会让那个字段变成「说不出从哪来」的数字 —— 而报告照样漂亮。
    expect([...(facts!.sources_keys ?? [])].sort()).toEqual([...(facts!.fields ?? [])].sort());
  });

  test("DECLARED_ONLY 是 FIELDS 的子集（声明字段不能凭空冒出来）", () => {
    for (const f of facts!.declared_only!) {
      expect(facts!.fields).toContain(f);
    }
  });

  test("verdict_rule_version 是字符串常量，不是 None", () => {
    // 它参与比对：同一批产物用两套判据能得出相反结论，那时差异不是配置造成的。
    expect(typeof facts!.verdict_rule_version).toBe("string");
    expect(facts!.verdict_rule_version!.length).toBeGreaterThan(0);
  });

  test("三种结论都有退出码，且 INCOMPLETE 不是 0（不等于通过）", () => {
    expect(Object.keys(facts!.exit_map).sort()).toEqual(["INCOMPLETE", "INVALID", "VALID"]);
    expect(facts!.exit_map.VALID).toBe(0);
    expect(facts!.exit_map.INVALID).not.toBe(0);
    expect(facts!.exit_map.INCOMPLETE).not.toBe(0);
  });

  test("未知键走 raise，不是静默忽略（白名单纪律 §4.5）", () => {
    expect(facts!.has_raise_on_unknown).toBe(true);
  });
});

// ─────────────────────────────────────────────────── 接线：四条跑法脚本真的调用了

const RUNNERS = [
  "w3-run.sh",
  "run-claude-code-contrast.sh",
  "run-model-switch.sh",
  "run-permission-switch.sh",
] as const;

describe("指纹采集接进 4/4 跑法脚本（工具存在 ≠ 会被执行）", () => {
  test("run_fingerprint.py / run-fingerprint.sh 存在", () => {
    expect(existsSync(PY)).toBe(true);
    expect(existsSync(SH)).toBe(true);
  });

  test("清单写死且与「目录里所有跑法脚本」一致（加新跑法忘了接会红）", () => {
    // ⚠️ 别用 `run*.sh` glob：它匹配不到 `w3-run.sh`，数出来 3 当 4
    // （同一条教训在 harbor-eval-gates.test.ts:52 已经踩过一次）。
    //
    // 且必须排除 `run-fingerprint.sh` 自身 —— 它是**采集库**（被 source 的），
    // 不是跑法脚本，把它算进去会让「跑法脚本」这个集合的定义失去意义。
    const names = readdirSync(HARBOR).filter(
      (n) => n.endsWith(".sh") && n !== "run-fingerprint.sh",
    );
    expect(names.filter((n) => n.startsWith("run")).sort()).toEqual([
      "run-claude-code-contrast.sh",
      "run-model-switch.sh",
      "run-permission-switch.sh",
    ]);
    expect(names).toContain("w3-run.sh");
  });

  for (const name of RUNNERS) {
    test(`${name}：source 了 run-fingerprint.sh 且调用了 collect`, () => {
      const code = codeOf(join(HARBOR, name));
      expect(code).toMatch(/source\s+\.\/run-fingerprint\.sh/);
      expect(code).toContain("run_fingerprint_collect");
    });

    test(`${name}：采集失败不改变 run 的退出码（只读旁路）`, () => {
      // 采集挂了不该把一次成功的 run 判成失败 —— 跑分产物已经落盘了。
      //
      // ⚠️ 判据不能写成「调用点在 `RUN_RC=$?` 之后」：`w3-run.sh` 压根**没有**
      // 这个变量（它用 `break` / `exit 1` 的循环结构），那条断言会对着一个
      // 正确的脚本报 -1 —— 而红的原因指错了地方，正是 §4.3 说要避免的那类。
      // 所以判据拆成两条，对四个脚本都成立：
      const code = codeOf(join(HARBOR, name));

      // ① 调用点没被 `|| exit` / `&& exit` 串成会传播失败的形式
      const callAt = code.indexOf("run_fingerprint_collect");
      expect(callAt).toBeGreaterThanOrEqual(0);
      const callLine = code.slice(callAt).split("\n")[0];
      expect(callLine).not.toMatch(/\|\|\s*exit|\&\&\s*exit/);

      // ② 采集函数自身不 `exit`，且以 `return 0` 收尾（失败也不改 RC）
      const lib = codeOf(SH);
      expect(lib).toMatch(/return 0\s*\n\}/);
      expect(lib).not.toMatch(/^\s*exit\s/m);
    });
  }
});

// ─────────────────────────────── agent 侧：两个必控变量必须落 metadata（否则指纹采不到）

describe("sid_code_agent.py 落 max_turns / max_budget_usd 到 metadata", () => {
  const code = codeOf(AGENT_PY);

  test("两格都写进 metadata（不是只写注释）", () => {
    // §1.4：「代码在」≠「生效」。判据是**生产路径真的会写**，所以看代码行不看注释。
    expect(code).toContain('"sid_max_turns": self._resolved_flags.get("max_turns")');
    expect(code).toContain('"sid_max_budget_usd": self._resolved_flags.get("max_budget_usd")');
  });

  test("取值来自 _resolved_flags（默认值也拿得到），不是 result 事件", () => {
    // ⚠️ 这是本组的关键：Harbor 的 result.json 只记**显式传的** `--ak`，
    // 默认值不落产物（实测 a11-sid 的 `config.agent.kwargs` 是 `{}`，
    // 而那一轮实际跑的是 40 轮上限）。从 result 事件找只会得到「没有这个字段」，
    // 与「这一档没有上限」不可区分。
    expect(code).toContain("self._resolved_flags.get(");
  });
});

// ───────────────────────────────────────────── 行为：真跑 Python 侧测试（CI 也跑）

describe.if(HAS_PYTHON3)("Python 侧行为测试（含逐字段变异，CI 上也跑不 skip）", () => {
  test("test-run-fingerprint.py 退出 0", () => {
    const r = spawnSync("python3", [TEST_PY], {
      encoding: "utf8",
      cwd: HARBOR,
      timeout: 60_000,
    });
    if (r.status !== 0) {
      throw new Error(
        `test-run-fingerprint.py rc=${r.status}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`,
      );
    }
    expect(r.status).toBe(0);
    // 顺带确认它真的跑了断言，不是空转退出 0
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
    if (!dir) dir = mkdtempSync(join(tmpdir(), "run-fp-gate-"));
    return dir;
  };

  const mutated = (mutate: (s: string) => string): string => {
    const p = join(workdir(), `m${Math.random().toString(36).slice(2)}.py`);
    writeFileSync(p, mutate(ORIGINAL), "utf8");
    return p;
  };

  test("① 删掉 FIELDS 里的一个字段 → SOURCES/FIELDS 覆盖断言翻转", () => {
    // 防的是「门禁真的在看这一行」。删字段本身不改 SOURCES，于是两者对不上 —— 红。
    const p = mutated((s) => s.replace('    "max_turns",\n', ""));
    const { facts } = runL1(p);
    expect(facts!.fields).not.toContain("max_turns");
    // 真门禁的断言复现一遍：覆盖不齐 → 应当红
    expect([...(facts!.sources_keys ?? [])].sort()).not.toEqual([...(facts!.fields ?? [])].sort());
  });

  test("② 加一个「下一个」同类字段到 FIELDS → 覆盖断言同样翻转（拦形态不是拦个案）", () => {
    // 这一条最容易漏：只测已知的那 13 个，下一个新字段仍会掉在同一条边界上。
    const p = mutated((s) =>
      s.replace('    "model_id",\n', '    "model_id",\n    "brand_new_field",\n'),
    );
    const { facts } = runL1(p);
    expect(facts!.fields).toContain("brand_new_field");
    expect(facts!.sources_keys).not.toContain("brand_new_field");
    expect([...(facts!.sources_keys ?? [])].sort()).not.toEqual([...(facts!.fields ?? [])].sort());
  });

  test("③ 把 FIELDS 抠成空集 → 「FIELDS 非空」断言翻转（绿着失效的一种）", () => {
    const p = mutated((s) => s.replace(/^FIELDS = \([\s\S]*?\n\)/m, "FIELDS = ()"));
    const { facts } = runL1(p);
    expect(facts!.fields).toEqual([]);
    // 真门禁那条是 `expect(length).toBeGreaterThan(0)`。在空集上它会红 ——
    // 这里断言「它确实变成空集」，即那条断言此刻应当失败。
    expect(facts!.fields!.length > 0).toBe(false);
  });

  test("④ 语法整体坏掉 → checker 自己非 0 退出（不是静默返回空事实）", () => {
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
