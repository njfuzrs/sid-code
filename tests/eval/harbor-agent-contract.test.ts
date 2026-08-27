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
 * | **L1 静态** | 只要 `python3`(stdlib `ast`,**不 import**) | ✅ **真的在跑** | 语法坏了 / 四成员缺失 / 装饰器顺序反了 / 输出格式被改回 json / key 进容器 / **产物身份的键名与架构校验** |
 * | **L2 导入** | 要装 `harbor` | ⚠️ skip | 真 import + issubclass + 能力全 False + **`_derive_is_error` 的行为** |
 *
 * L1 是主力。它拦得住的恰好是那批**不报错的**失效形态,而这正是延迟到运行时最贵的部分。
 *
 * ## ⚠️ L2 的探测方式本身曾经是个缺陷(2026-08-27 修)
 *
 * 原先探 `python3 -c "import harbor"`,而 README 教的装法是 `uv tool install`——
 * **装进隔离环境,系统 python 看不到**。于是 L2 在**本机装了 harbor 的情况下照样 skip**,
 * 而它本可以直接拦住那次真实失败(import 了 pin 版本里不存在的模块)。
 *
 * **形态**:修一个「永远 skip」的门禁时,只改了「谁来跑」,没改「**怎么判断能不能跑**」。
 * 一个 skip 条件写错的门禁,和一个不存在的门禁,在 CI 上是同一个东西。
 * 现在按 `SID_HARBOR_PYTHON` → uv tool 隔离环境 → 系统 `python3` 依次探(见 `findHarborPython`)。
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
    # 顶层 import 的模块名(含 from X import ...)。用来对着 pin 的 harbor 版本
    # 核「这些模块真的存在吗」—— 见 L1「import 的模块都在 pin 的版本里」那条。
    "imported_modules": [],
}

for node in ast.walk(tree):
    if isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
        out["imported_modules"].append(node.module)
    elif isinstance(node, ast.Import):
        out["imported_modules"] += [a.name for a in node.names]

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
  imported_modules: string[];
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

/**
 * 找一个 **import 得到 harbor** 的解释器。
 *
 * ⚠️ README 教的装法是 `uv tool install harbor`,它把 harbor 装进一个
 * **独立的隔离环境**(`~/.local/share/uv/tools/harbor/`),系统 `python3`
 * **看不到它**。原先只探 `python3 -c "import harbor"` 的形态是:
 * **本机明明装了 harbor,L2 照样 skip** —— 一条永远不跑的门禁,
 * 而它看起来只是「环境没装」。2026-08-27 实测踩到:那次 L2 本可以拦住
 * `harbor.agents.capabilities` 不存在这个真缺陷,却因为探测方式而静默让路。
 *
 * 所以按顺序试:① `SID_HARBOR_PYTHON` 显式指定 → ② uv tool 的隔离环境
 * → ③ 系统 `python3`(pip/venv 装法)。找不到才 skip。
 */
function findHarborPython(): string | null {
  const candidates = [
    process.env.SID_HARBOR_PYTHON,
    join(process.env.HOME ?? "", ".local", "share", "uv", "tools", "harbor", "bin", "python"),
    "python3",
  ].filter((c): c is string => !!c);
  for (const py of candidates) {
    const p = Bun.spawnSync({ cmd: [py, "-c", "import harbor"], stdout: "pipe", stderr: "pipe" });
    if ((p.exitCode ?? 1) === 0) return py;
  }
  return null;
}

const HARBOR_PYTHON = HAS_PYTHON3 ? findHarborPython() : null;
const HAS_HARBOR = HARBOR_PYTHON !== null;

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

  test("不声明任何能力(首版全 False,靠基类默认)", () => {
    // 打开任何一项都意味着有人声明了 resume/handoff/atif ——
    // 声明了但不可靠会让多步任务**静默走错分支**,所以这里锁成「一个都不写」。
    // 显式写 `SUPPORTS_X = False` 也拦:那只是把基类默认值抄一次,
    // 抄来的常量会在基类改默认时静默失配。
    expect(facts!.class_attrs.filter((a) => a.startsWith("SUPPORTS_"))).toEqual([]);
    // `capabilities = AgentCapabilities()` 同样拦 —— 那个类在 pin 的 0.22.0 里
    // **不存在**(PR #2834 在 v0.22.0 之后才合入),用它 harbor 启动即 import 失败。
    expect(facts!.class_attrs).not.toContain("capabilities");
  });

  test("产物身份读的字段名与 artifact-identity.ts 的实际输出一致", () => {
    // ⚠️ **2026-08-27 用一次真实评测换来的。**
    // 初版找 `artifact_commit`,而脚本吐的键是 `commit` —— 永远匹配不上,
    // 每次都退化到 `host-head-fallback`。而这个缺陷**被 fallback 掩盖**:
    // 宿主 HEAD 通常就是构建 commit,于是 `sid_commit` 的**值完全正确**,
    // 唯一暴露它的是 `commit_source` 那个字段。在别人机器上(HEAD 已往前走)
    // 读出的 commit 就是错的,而**没有任何东西会报错**。
    //
    // 所以这条不做「源码里出现某个字符串」的形态检查,而是**真的跑一次脚本**
    // 拿它的键集合来对 —— 字符串检查会在脚本改了输出键名时静默失效。
    const identityScript = join(import.meta.dir, "..", "..", "scripts", "artifact-identity.ts");
    const probe = Bun.spawnSync({
      cmd: ["bun", "run", identityScript, "read", process.execPath],
      cwd: join(import.meta.dir, "..", ".."),
      stdout: "pipe",
      stderr: "pipe",
    });
    // 拿 bun 自己的二进制探:它必然不含 sid-code 的身份块,所以脚本走的是
    // 「读不到 → 报告缺失」那条路径,而**键名结构与命中时一致**(这是重点)。
    // 用真实产物会要求先跑一次构建,那让门禁依赖一个几分钟的前置步骤。
    const out = probe.stdout?.toString() ?? "";
    let keys: string[] = [];
    try {
      keys = Object.keys(JSON.parse(out) as Record<string, unknown>);
    } catch {
      // 脚本行为变了(不再吐 JSON)—— 这本身就该红,而不是静默跳过。
      throw new Error(`artifact-identity.ts read 未输出可解析 JSON。stdout=${out.slice(0, 300)}`);
    }
    // agent 侧读的键必须在脚本实际输出的键集合里。
    expect(keys).toContain("commit");
    expect(keys).toContain("identity_source");
    // 反向锁:那个**不存在的键名**不许再出现在**实际取值处**。
    // ⚠️ 只查「源码里有没有这个词」是不行的 —— 它出现在记录这次教训的注释里,
    // 而删掉注释来让门禁变绿正是最坏的做法(抹掉的是唯一的溯源线索)。
    // 所以精确锁 `identity.get(...)` 的实参。
    const src = readFileSync(AGENT_PY, "utf-8");
    const identityReads = [...src.matchAll(/identity\.get\(\s*"([^"]+)"/g)].map((m) => m[1]!);
    expect(identityReads.length).toBeGreaterThan(0);
    // **每一个**读的键都必须在脚本的输出键集合里 —— 不是只查 commit 那一个。
    // 同型错误已经发生过两次(`artifact_commit` / `artifact_dirty`),
    // 而 `artifact_dirty` 那格更隐蔽:它本来就允许是 null,「恒 null」
    // 看起来像正常缺省值,实际是键名压根没匹配上。逐个核才拦得住下一个。
    for (const key of identityReads) {
      expect(keys).toContain(key);
    }

    // ⚠️ 同一次实测暴露的第二个洞:读不到身份时脚本**照样吐完整 JSON**,
    // 字段填字面量 "unknown"。所以 `if not commit` 判不出失败,
    // 退化路径永不触发,会写下一个 `commit="unknown"` 却自称 artifact-bytes
    // 的 build.json —— `commit_source` 这层保护恰好在最需要它时失效。
    const missed = JSON.parse(out) as Record<string, unknown>;
    expect(missed["commit"]).toBe("unknown"); // 锁住「miss 也返回值」这个前提
    expect(missed["identity_source"]).toBe("none");
    // 于是 agent 侧必须按**形态**判(40 位十六进制),不能只判真假。
    expect(src).toMatch(/\[0-9a-f\]\{40\}/);
  });

  test("二进制选择会校验产物实际架构(读 ELF,不信目录名)", () => {
    // ⚠️ **2026-08-27 实测缺陷。** `build-branch-artifact.sh` 的输出目录名
    // `<branch-slug>-<commit12>` **不含架构**,同一 commit 编 arm64/x64 会互相覆盖。
    // 于是「按 commit 匹配」拿到的是「上次编的那个架构」——
    // 实测在只发 amd64 的 Terminal-Bench 镜像上上传了 arm64 包,
    // build.json 写下 `arch: "x64"`(期望值),容器里 `exit 127: not found`,
    // 而**报错完全不指向架构**。说好「绝不静默回落到别的包」,
    // 实际静默上传了错架构的包。
    expect(facts!.members).toContain("_elf_arch");
    const src = readFileSync(AGENT_PY, "utf-8");
    // ELF e_machine 的两个取值必须在源码里(x86-64 = 62,AArch64 = 183)。
    // 断具体数值而不是「有没有叫 _elf_arch 的函数」:一个空壳函数照样能过前一条。
    expect(src).toMatch(/62:\s*"x64"/);
    expect(src).toMatch(/183:\s*"arm64"/);
    // 且必须真的用它比较,不是只定义了。
    expect(src).toContain("actual != arch");
  });

  test("import 的模块全部存在于 pin 的 harbor 版本里", () => {
    // ⚠️ **这条是 2026-08-27 用一次真实失败换来的。**
    // H1 原始代码 `from harbor.agents.capabilities import AgentCapabilities`,
    // 而 PyPI 上 pin 的 0.22.0 没有那个模块(它在 v0.22.0 tag 之后才合入主干)。
    // 形态:harbor 启动即 `ValueError: Failed to import module 'sid_code_agent'`,
    // **一个 trial 都跑不起来**,而 L1(ast 静态,不 import)与 L2(CI 上 skip)
    // 当时都拦不到 —— 于是这个缺陷一路合进了 main。
    //
    // 这条断言只在**本机装了 harbor 时**能做真实校验(装了才知道模块在不在);
    // 没装时退化成「模块名清单不为空」的形态检查,并把退化说破 ——
    // 一个假装自己在校验的断言比没有断言更坏。
    const mods = facts!.imported_modules.filter((m) => m.startsWith("harbor"));
    expect(mods.length).toBeGreaterThan(0);
    if (!HAS_HARBOR) {
      console.log(
        `  ℹ️  未装 harbor,跳过 ${mods.length} 个 harbor 模块的存在性校验(仅查清单非空)。` +
          `真实校验在 L2 与跑评测时`,
      );
      return;
    }
    const probe = [
      "import importlib, json, sys",
      "missing = []",
      "for m in sys.argv[1:]:",
      "    try: importlib.import_module(m)",
      "    except Exception as e: missing.append(f'{m}: {type(e).__name__}')",
      "print(json.dumps(missing))",
    ].join("\n");
    const proc = Bun.spawnSync({
      cmd: [HARBOR_PYTHON!, "-c", probe, ...mods],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode).toBe(0);
    expect(JSON.parse(proc.stdout!.toString()) as string[]).toEqual([]);
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
        (src) => src.replace("    CLI_FLAGS = [", "    MODEL_CONNECTION = None\n    CLI_FLAGS = ["),
        (p) => expect(runL1(p).facts!.class_attrs).toContain("MODEL_CONNECTION"),
      );
    });

    test("声明 SUPPORTS_RESUME → 能力断言翻红", () => {
      withMutatedFixture(
        (src) => src.replace("    CLI_FLAGS = [", "    SUPPORTS_RESUME = True\n    CLI_FLAGS = ["),
        (p) =>
          expect(runL1(p).facts!.class_attrs.filter((a) => a.startsWith("SUPPORTS_"))).toEqual([
            "SUPPORTS_RESUME",
          ]),
      );
    });

    test("import 一个 pin 版本里不存在的模块 → 存在性断言翻红", () => {
      // 精确复现 2026-08-27 那次真实失败:`harbor.agents.capabilities` 在
      // pin 的 0.22.0 里不存在。**这条只在装了 harbor 时有判据** ——
      // 没装时它证明不了任何事,所以直接跳过而不是假装通过。
      if (!HAS_HARBOR) return;
      withMutatedFixture(
        (src) =>
          src.replace(
            "from harbor.agents.installed.base import (",
            "from harbor.agents.capabilities import AgentCapabilities\nfrom harbor.agents.installed.base import (",
          ),
        (p) => {
          const mods = runL1(p).facts!.imported_modules.filter((m) => m.startsWith("harbor"));
          expect(mods).toContain("harbor.agents.capabilities");
          const probe = [
            "import importlib, json, sys",
            "missing = []",
            "for m in sys.argv[1:]:",
            "    try: importlib.import_module(m)",
            "    except Exception as e: missing.append(m)",
            "print(json.dumps(missing))",
          ].join("\n");
          const proc = Bun.spawnSync({
            cmd: [HARBOR_PYTHON!, "-c", probe, ...mods],
            stdout: "pipe",
            stderr: "pipe",
          });
          // 判据收紧到「红的是哪一条」:必须恰好是那个不存在的模块,
          // 而不是「有东西红了」—— 后者分不清是命中了判据还是别处坏了。
          expect(JSON.parse(proc.stdout!.toString()) as string[]).toEqual([
            "harbor.agents.capabilities",
          ]);
        },
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
      // pin 的 0.22.0 用 SUPPORTS_* ClassVar,不是结构化的 AgentCapabilities
      // (那个类在 v0.22.0 之后才进主干)。从基类枚举字段名再逐个读回来 ——
      // 硬编码七个名字会在 harbor 加第八个能力时静默漏掉它。
      "caps = {k: getattr(c, k) for k in dir(BaseInstalledAgent) if k.startswith('SUPPORTS_')}",
      "print(json.dumps({",
      "  'subclass': issubclass(c, BaseInstalledAgent),",
      "  'name': c.name(),",
      "  'n_caps': len(caps),",
      // frozenset(bridges) 不是 bool,统一按「非空即 True」折叠
      "  'any_cap': any(bool(v) for v in caps.values()),",
      "}))",
    ].join("\n");
    const proc = Bun.spawnSync({
      cmd: [HARBOR_PYTHON!, "-c", snippet],
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
    // 先断「确实枚举到了能力位」再断「全 False」。少了这条,某天 harbor 把
    // SUPPORTS_* 整体换名(它正在往 AgentCapabilities 迁),caps 会变成空 dict,
    // 而 `any({}.values())` 是 False —— **门禁会绿着失效**。
    expect(r.n_caps).toBeGreaterThan(0);
    expect(r.any_cap).toBe(false);
  });

  test("_derive_is_error:错误路径缺 is_error 字段时从 subtype 推", () => {
    // ⚠️ **2026-08-27 从真实评测里挖出来的仪器缺陷。**
    // sid-code 在**错误路径**的 result 事件里**根本不发 `is_error`**
    // (成功路径才发 `is_error: false`)。实测那条 `error_during_execution`
    // 事件的键只有 {duration_ms, errors, num_turns, session_id, subtype,
    // total_cost_usd, type, usage} —— 于是只读 `is_error` 会得到 `None`,
    // 而 `None` 在下游一律被当成「不是错误」:
    // **一个失败的 trial 被记成正常的 0 分,直接污染分子。**
    //
    // 这条放 L2 而不是 L1:它测的是**行为**(给定事件 → 判定),
    // 而 L1 只能看到源码形态。形态断言拦不住「函数在但逻辑反了」。
    const snippet = [
      "import json",
      "from sid_code_agent import SidCodeAgent as A",
      "cases = [",
      '  {"is_error": False, "subtype": "success"},', // 显式 False 优先
      '  {"is_error": True, "subtype": "success"},', // 显式 True 优先于 subtype
      '  {"subtype": "error_during_execution"},', // ← 实测那条事件的形态
      '  {"subtype": "error_max_turns"},',
      '  {"subtype": "success"},',
      '  {"subtype": "some_new_failure_mode"},', // 枚举 error_* 会漏,!=success 不漏
      "  {},", // 真判不出 → None,不兜底成 False
      "]",
      "print(json.dumps([A._derive_is_error(c) for c in cases]))",
    ].join("\n");
    const proc = Bun.spawnSync({
      cmd: [HARBOR_PYTHON!, "-c", snippet],
      env: {
        ...process.env,
        PYTHONPATH: join(import.meta.dir, "..", "..", "evals", "external-benchmarks", "harbor"),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.stderr?.toString() ?? "").toBe("");
    expect(proc.exitCode).toBe(0);
    expect(JSON.parse(proc.stdout!.toString()) as (boolean | null)[]).toEqual([
      false,
      true,
      true,
      true,
      false,
      true,
      // ⚠️ 最后一格必须是 null,**不能兜底成 false**。判不出时说「没出错」
      // 是编造一个乐观结论;null 至少能在下游被识别成「这条不可用」。
      null,
    ]);
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
