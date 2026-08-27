/**
 * Harbor agent 契约门禁 —— 覆盖 `evals/external-benchmarks/harbor/sid_code_agent.py`
 *
 * ## 这份测试为什么必须存在
 *
 * 仓库的五道门禁(`bun test` / `make build` / `bun run lint` / `format:check` /
 * `lint:boundary`)**一道都不认 `.py`**。于是那份 Python 代码的语法错误与签名漂移
 * 会**延迟到跑评测时才暴露** —— 而那时已经起了容器、拉了镜像、花了钱。
 *
 * ## 为什么分两层(这是本文件唯一的设计决策)
 *
 * 最直觉的做法是「探测 `import harbor`,失败就 skip」。但那样在 CI 上**永远 skip** ——
 * CI 不装 Python 依赖 —— 于是门禁形同不存在,而 PR 页面一片绿。
 * 本仓有过同型教训:防线自己成了它当初要消灭的死功能。
 *
 * 所以拆成两层,按「需不需要 harbor」切:
 *
 * | 层 | 依赖 | CI 上 | 拦什么 |
 * | --- | --- | --- | --- |
 * | **L1 静态** | 只要 `python3`(stdlib `ast`,**不 import**) | ✅ **真的在跑** | 语法坏了 / 四成员缺失 / 装饰器顺序反了 / 输出格式被改回 json / key 进容器 |
 * | **L2 导入** | 要装 `harbor` | ⚠️ skip | 真 import + issubclass + capabilities 全 False |
 *
 * L1 是主力。它拦得住的恰好是那批**不报错的**失效形态,而这正是延迟到运行时最贵的部分。
 *
 * ## 变异自证(`CLAUDE.md`:新增门禁必做变异自证)
 *
 * 下面每组断言都配一条**反向用例**:把被测条件人为改坏(在 tmpdir 的 fixture 上,
 * **不动真源文件**),判定必须翻转。只断言 happy path 的测试无法区分
 * 「逻辑对」与「checker 恒返 ok」。
 *
 * ⚠️ 它替代不了真实运行验证。README 里那四步冒烟(oracle/nop 双向对照、cost 非 0、
 * 三 agent 对照)才是真验收,这条只拦「语法坏了 / 签名漂移 / 关键开关被改」。
 */

import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const AGENT_PY = join(
  import.meta.dir,
  "..",
  "..",
  "evals",
  "external-benchmarks",
  "harbor",
  "sid_code_agent.py",
);

/**
 * L1 checker:用 stdlib `ast` 解析源文件,**只提取事实,不做判断**。
 *
 * 判断留在 TS 侧,理由有两条:① 断言写在 `expect` 里,失败信息直接指出哪一条崩了;
 * ② checker 自己不含判据 → 它没法「恒返 ok」,变异自证才有意义。
 *
 * 用 `ast` 而不是 `import`:import 会连带要求 harbor 装好(那正是我们要绕开的),
 * 而且 import 一个 harbor 缺失的模块只会得到 ModuleNotFoundError ——
 * 分不清「我们的代码坏了」和「环境没装依赖」。
 */
const L1_CHECKER = String.raw`
import ast, json, sys

tree = ast.parse(open(sys.argv[1], encoding="utf-8").read())

def dec_name(node):
    # 装饰器可能是 Name(@override) 或 Attribute/Call;只取最终名字
    while isinstance(node, ast.Call):
        node = node.func
    if isinstance(node, ast.Attribute):
        return node.attr
    return getattr(node, "id", "")

out = {
    "classes": [],
    "bases": [],
    "members": [],
    "decorators": {},
    "class_attrs": [],
    "capabilities_args": None,
    "string_consts": [],
    "flag_pairs": {},
}

for node in ast.walk(tree):
    if isinstance(node, ast.ClassDef):
        out["classes"].append(node.name)
        out["bases"] += [dec_name(b) for b in node.bases]
        for item in node.body:
            if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
                out["members"].append(item.name)
                out["decorators"][item.name] = [dec_name(d) for d in item.decorator_list]
            elif isinstance(item, ast.Assign):
                for t in item.targets:
                    if isinstance(t, ast.Name):
                        out["class_attrs"].append(t.id)
                        if t.id == "capabilities" and isinstance(item.value, ast.Call):
                            out["capabilities_args"] = len(item.value.args) + len(item.value.keywords)

    # 相邻的 "--flag", "value" 字面量对(命令是按 list 拼的)
    if isinstance(node, (ast.List, ast.Tuple)):
        elts = node.elts
        for i, e in enumerate(elts[:-1]):
            nxt = elts[i + 1]
            if (isinstance(e, ast.Constant) and isinstance(e.value, str)
                    and e.value.startswith("--")
                    and isinstance(nxt, ast.Constant) and isinstance(nxt.value, str)):
                out["flag_pairs"].setdefault(e.value, []).append(nxt.value)

    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        out["string_consts"].append(node.value)

print(json.dumps(out))
`;

type L1Facts = {
  classes: string[];
  bases: string[];
  members: string[];
  decorators: Record<string, string[]>;
  class_attrs: string[];
  capabilities_args: number | null;
  string_consts: string[];
  flag_pairs: Record<string, string[]>;
};

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

/** python3 是 macOS 与 GitHub runner 自带的。真缺才 skip —— 这条 skip 是环境问题,不是设计。 */
const HAS_PYTHON3 = (Bun.spawnSync({ cmd: ["python3", "--version"] }).exitCode ?? 1) === 0;

/** harbor 是可选的本地依赖(`uv pip install 'harbor>=0.22.0,<0.23'`)。 */
const HAS_HARBOR =
  HAS_PYTHON3 && (Bun.spawnSync({ cmd: ["python3", "-c", "import harbor"] }).exitCode ?? 1) === 0;

/** 在 tmpdir 里造一份被改坏的 fixture,用于变异自证。**绝不动真源文件。** */
function withMutatedFixture<T>(mutate: (src: string) => string, fn: (path: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "harbor-agent-mutation-"));
  try {
    const path = join(dir, "sid_code_agent.py");
    writeFileSync(path, mutate(readFileSync(AGENT_PY, "utf-8")));
    return fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// L1:静态层。不需要 harbor,CI 上真的在跑。
// ─────────────────────────────────────────────────────────────────────────────

describe.if(HAS_PYTHON3)("L1 静态契约(无需 harbor)", () => {
  const { code, facts, stderr } = runL1(AGENT_PY);

  test("源文件语法合法且能解析出 SidCodeAgent", () => {
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(facts).not.toBeNull();
    expect(facts!.classes).toContain("SidCodeAgent");
    expect(facts!.bases).toContain("BaseInstalledAgent");
  });

  test("Harbor 要求的四个成员齐备", () => {
    // name/install/run 是基类的 @abstractmethod,缺了 Harbor 实例化时就 TypeError;
    // populate_context_post_run 基类默认 `pass`,**缺了不报错**只是用量与成本全为 None
    // —— 那正好是「字段在、值是废的」那类失效,所以必须一起断。
    for (const m of ["name", "install", "run", "populate_context_post_run"]) {
      expect(facts!.members).toContain(m);
    }
  });

  test("run 的 @with_prompt_template 在 @override 之上", () => {
    // ⚠️ 这条是本文件最重要的一条。顺序反了**不报错**,只是 instruction 原样透传、
    // 提示模板静默失效 —— 而提示模板是跨 agent 对照的第一必控变量。
    const decs = facts!.decorators["run"] ?? [];
    expect(decs).toContain("with_prompt_template");
    expect(decs).toContain("override");
    expect(decs.indexOf("with_prompt_template")).toBeLessThan(decs.indexOf("override"));
  });

  test("--output-format 的取值是 stream-json,不是 json", () => {
    // 两者是**分叉的两条实现**(app.ts 的 early-return 是分界线),
    // 只有 stream-json 的 result 事件带 total_cost_usd —— 改回 json 会让成本静默全 None。
    expect(facts!.flag_pairs["--output-format"]).toEqual(["stream-json"]);
  });

  test("--print 在命令里(否则起的是 TUI,评测里必然挂)", () => {
    expect(facts!.string_consts).toContain("--print");
  });

  test("不声明 MODEL_CONNECTION —— 它的作用恰恰是把 key 注入容器", () => {
    expect(facts!.class_attrs).not.toContain("MODEL_CONNECTION");
  });

  test("不出现 dangerously-skip-permissions —— 它会关掉我们想测的那层防线", () => {
    expect(facts!.string_consts.join("\n")).not.toContain("dangerously-skip-permissions");
  });

  test("capabilities 是零参 AgentCapabilities()(首版全 False)", () => {
    // 参数一旦非零就意味着有人打开了某个能力。resume/handoff/atif 各自是独立 PR,
    // 声明了但不可靠会让多步任务**静默走错分支**,所以这里锁成 0。
    expect(facts!.class_attrs).toContain("capabilities");
    expect(facts!.capabilities_args).toBe(0);
    // 旧的 SUPPORTS_* 类变量会触发 DeprecationWarning,一并锁掉。
    expect(facts!.class_attrs.filter((a) => a.startsWith("SUPPORTS_"))).toEqual([]);
  });

  // ── 变异自证:每条判据都要能被改坏并翻红 ──────────────────────────────────
  describe("变异自证(fixture 在 tmpdir,不动真源文件)", () => {
    test("name() 改名 → 四成员断言翻红", () => {
      // 用**改名**而不是整段删掉:删掉方法体会留下悬空的 @staticmethod/@override,
      // 于是 fixture 变成 SyntaxError —— checker 照样报错,但**报错原因指错了地方**
      // (语法坏了 ≠ 成员缺失)。改名能精确命中「成员缺失」这一条判据。
      withMutatedFixture(
        (src) => src.replace("    def name() -> str:", "    def name_typo() -> str:"),
        (p) => {
          const f = runL1(p).facts!;
          expect(f.members).not.toContain("name");
          expect(f.members).toContain("name_typo");
        },
      );
    });

    test("装饰器换序 → 顺序断言翻红", () => {
      withMutatedFixture(
        (src) =>
          src.replace(
            "    @with_prompt_template\n    @override\n",
            "    @override\n    @with_prompt_template\n",
          ),
        (p) => {
          const decs = runL1(p).facts!.decorators["run"]!;
          expect(decs.indexOf("with_prompt_template")).toBeGreaterThan(decs.indexOf("override"));
        },
      );
    });

    test("stream-json 改回 json → 输出格式断言翻红", () => {
      withMutatedFixture(
        (src) => src.replace('            "stream-json",', '            "json",'),
        (p) => expect(runL1(p).facts!.flag_pairs["--output-format"]).toEqual(["json"]),
      );
    });

    test("加回 MODEL_CONNECTION → key 泄露断言翻红", () => {
      withMutatedFixture(
        (src) =>
          src.replace(
            "    capabilities = AgentCapabilities()",
            "    MODEL_CONNECTION = None\n    capabilities = AgentCapabilities()",
          ),
        (p) => expect(runL1(p).facts!.class_attrs).toContain("MODEL_CONNECTION"),
      );
    });

    test("语法坏掉 → checker 非 0 退出(不是静默返回空事实)", () => {
      // 这一条防的是 checker 自己的失效模式:解析失败却 exit 0 + 空 JSON,
      // 于是上面所有 `toContain` 都对着空数组跑……而空数组什么都不包含,
      // 断言会红 —— 但**红的原因会指错地方**。所以显式锁死退出码。
      withMutatedFixture(
        (src) => src + "\nclass Broken(:\n",
        (p) => {
          const r = runL1(p);
          expect(r.code).not.toBe(0);
          expect(r.stderr).toContain("SyntaxError");
        },
      );
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// L2:导入层。装了 harbor 才跑;CI 上 skip,这是已知且被说破的边界(见 README)。
// ─────────────────────────────────────────────────────────────────────────────

describe.if(HAS_HARBOR)("L2 真实导入契约(需要 harbor)", () => {
  test("能被 import,且是 BaseInstalledAgent 的子类、capabilities 全 False", () => {
    const snippet = [
      "import json, sys",
      "from harbor.agents.installed.base import BaseInstalledAgent",
      "import sid_code_agent as m",
      "c = m.SidCodeAgent",
      "caps = c.capabilities.model_dump()",
      "print(json.dumps({",
      "  'subclass': issubclass(c, BaseInstalledAgent),",
      "  'name': c.name(),",
      // frozenset(bridges) 不是 bool,统一按「非空即 True」折叠
      "  'any_cap': any(bool(v) for v in caps.values()),",
      "}))",
    ].join("\n");
    const proc = Bun.spawnSync({
      cmd: ["python3", "-c", snippet],
      env: {
        ...process.env,
        PYTHONPATH: join(import.meta.dir, "..", "..", "evals", "external-benchmarks", "harbor"),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.stderr?.toString() ?? "").toBe("");
    expect(proc.exitCode).toBe(0);
    const r = JSON.parse(proc.stdout!.toString());
    expect(r.subclass).toBe(true);
    expect(r.name).toBe("sid-code");
    expect(r.any_cap).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 元断言:让「本次到底跑了哪几层」出现在测试输出里。
// ─────────────────────────────────────────────────────────────────────────────

test("门禁覆盖面自报(L1 必须生效,L2 可选)", () => {
  // 没有这条的话,L1 与 L2 双 skip 的那次运行看起来与「全部通过」**完全一样**。
  // 一个恒 skip 的门禁比没有门禁更坏,因为它看起来是在保护你。
  expect(HAS_PYTHON3).toBe(true);
  if (!HAS_HARBOR) {
    console.log("  ℹ️  L2(真实 import)已跳过:本机未装 harbor。装法见 harbor/README.md");
  }
});
