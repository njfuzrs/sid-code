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
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
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
    // 候选路径(尤其 uv tool 隔离环境那条)在大多数机器/CI runner 上根本不存在,
    // Bun.spawnSync 对不存在的可执行文件是**同步抛异常**(ENOENT),不是返回非零 exitCode——
    // 不 catch 就会以「Unhandled error between tests」打断整个文件,而不是走到下一个候选。
    try {
      const p = Bun.spawnSync({ cmd: [py, "-c", "import harbor"], stdout: "pipe", stderr: "pipe" });
      if ((p.exitCode ?? 1) === 0) return py;
    } catch {
      continue;
    }
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

  test("权限档是显式的、可观测的,且 skip 用布尔 flag(判据已于 2026-08-29 纠正)", () => {
    // ⚠️ **这条断言的判据被整个换掉过一次,换掉的理由比断言本身重要。**
    //
    // 原判据是「源码里不许出现 `dangerously-skip-permissions` —— 它会关掉我们想测的
    // 那层防线」。它**忠实地执行了一个错误的决定**:自建 swe-bench 链路早在
    // 2026-08-25 就用 113 次权限拒绝的实测得出「acceptEdits 不可用,必须换 skip」,
    // 而 Harbor 侧引用**同一个数字**得出了相反结论(「正好观察防线」),
    // 然后用这道门禁把错的那一侧钉死 —— 任何人想改回与 swe-bench 一致,
    // 都会被一道**注释理由读起来完全正当**的绿色门禁拦住。
    //
    // 本机 10 题全量实测(源:`logs/permissions-audit.log`)确认了同一形态:
    // **144 次拒绝 / 178 次放行**,其中 111 次(77%)是 acceptEdits 不放行普通 bash
    // (`nproc` / `which git` / `qemu-img info` 全被拒)。于是「40 轮预算用尽」
    // 被读成能力不足,而真相是非能力原因混进了能力账。
    //
    // **教训(本仓判读纪律)**:一道门禁的注释理由正当,不代表它守的判据正确。
    // 修法是**改判据,不是拆门** —— 反向锁的价值仍在(防止有人无意识地把权限档
    // 改成一个静默失效的形态),所以这里换成锁「显式 + 可观测 + 形态正确」三件事。
    const src = readFileSync(AGENT_PY, "utf-8");

    // ① skip 必须是**布尔** CliFlag。这一条是三个实测坑里最隐蔽的那个:
    //    `--permission-mode dangerously-skip-permissions` **不生效**(checker 判的是
    //    `config.skipPermissions`,只有布尔 flag 会设它),而它**不报错** ——
    //    命令行看起来完全正确,容器里照样被拒 144 次。
    //    Harbor 侧只有 `type == "bool"` 才输出裸 flag(`installed/base.py:723-725`),
    //    写成 str 会拼出 `--dangerously-skip-permissions True`。
    const skipFlag = /CliFlag\(\s*\n\s*"skip_permissions",[\s\S]*?\n\s*\)/.exec(src)?.[0] ?? "";
    expect(skipFlag).not.toBe("");
    expect(skipFlag).toContain('cli="--dangerously-skip-permissions"');
    expect(skipFlag).toMatch(/type="bool"/);

    // ② `permission_mode` 的 choices 里**不许**出现 skip 的模式名。
    //    传它进 --permission-mode 是那条静默失效路径,把它列进 choices 等于把坑
    //    做成一个官方旋钮。同理 `bypassPermissions` 压根不是合法模式名(只 warn)。
    const modeFlag = /CliFlag\(\s*\n\s*"permission_mode",[\s\S]*?\n\s*\)/.exec(src)?.[0] ?? "";
    expect(modeFlag).not.toBe("");
    expect(modeFlag).not.toContain('"dangerously-skip-permissions"');
    expect(modeFlag).not.toContain("bypassPermissions");

    // ③ **两个都传时必须硬失败。** sid-code 侧 skip 优先(`config.ts:1557` 覆盖
    //    permissionMode),所以同时给出时 `--ak permission_mode=acceptEdits` 是个
    //    假开关:metadata 如实记下 acceptEdits,实际全放开,**跑完没有东西会报错**。
    //    这一层要在起容器之前拦,不是在读结果时才发现整轮数据不可用。
    expect(facts!.members).toContain("_assert_permission_flags_coherent");

    // ④ **观测值必须落 metadata,且与请求值分成两个键。**
    //    「命令行传了什么」只证明我请求了全放开;三个坑全是「请求了但没生效且不报错」。
    //    所以判据必须是审计日志里 deny 的**观测**条数 —— 而六棒无人读过那份日志,
    //    正是 §17.3 那次错能活这么久的原因。
    expect(facts!.members).toContain("_count_permission_decisions");
    expect(src).toContain("sid_permission_mode_requested");
    expect(src).toContain("sid_permission_denials");
    // 日志缺失要与「零拒绝」区分:后者是换档成功的判据,混在一起会让一次
    // 采集失败伪装成一次成功换档(与成本那处「绝不填 0」同一条纪律)。
    expect(src).toContain("sid_permission_audit_missing");
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
  test("成本兜底源存在,且取的是 flow 口径而非 total_tokens_sent", () => {
    // ⚠️ **2026-08-29 从 A11 真实 benchmark 里挖出来的口径缺陷。**
    // trial 撞 Harbor 的 agent 硬顶被 SIGKILL 时,`result` 事件从未发出 →
    // `cost_usd: null` / `sid_cost_source: "missing"`,而轨迹里明明有
    // 3 次成功调用、75,732 prompt tokens、$0.0538 的真实花费。
    // 那笔钱没进任何账,且**它不报错** —— `null` 被下游求和当成 0。
    // 低报幅度与超时 trial 的比例成正比:10 题 1 超时 = 1.1%,跑 500 题就系统性偏低。
    expect(facts!.members).toContain("_recover_usage_from_traj");

    const src = readFileSync(AGENT_PY, "utf-8");
    // ⛔ 最关键的一条:`n_input_tokens` 必须取 flow 口径。
    // `total_tokens_sent` 是**末次快照值**(stock,含全历史),而 cost 是逐次累加(flow);
    // stock ÷ flow 会算出一个错的单价,**且它不报错**,只是让"每 token 花多少钱"整体偏移。
    // 同源教训:§15.1 的静态前缀曾误用 cache_write_tokens,得到一个每跑一次变 2.5 倍的数。
    expect(src).toContain("total_cumulative_prompt_tokens");
    // ⚠️ 断的是「**有没有真的去读**那个字段」,不是「源文件里有没有出现这串字符」——
    // 源码里那条 ⛔ 注释本身就写着 `total_tokens_sent`(在解释为什么不能用它),
    // 按裸字符串断会把**警告注释自己**判成违规。这正是本仓「判据写错的门禁
    // 与不存在的门禁等价」那一类:第一版就是这么写的,它红了,而被测代码是对的。
    // 所以按取数形态断:`_num("…")` / `.get("…")` 才算真的读了它。
    expect(src).toMatch(/_num\("total_cumulative_prompt_tokens"\)/);
    expect(src).not.toMatch(/_num\("total_tokens_sent"\)/);
    expect(src).not.toMatch(/\.get\(\s*"total_tokens_sent"\s*\)/);

    // 兜底源与权威源的口径标记**必须不同**:兜底值可能偏低(最后 ≤30s 的调用
    // 没来得及落盘),混成同一个标签就等于宣称"补全了",而它只是"比 null 准"。
    expect(facts!.string_consts).toContain("session-traj-fallback");
    expect(facts!.string_consts).toContain("stream-json-result");
    // 两个源都拿不到时仍要落 missing —— 绝不填 0(填 0 让"没采到"伪装成"没花钱")。
    expect(facts!.string_consts).toContain("missing");
  });

  test("result 事件的每个字段都被 metadata 消费,或在豁免名单里(跨语言边界形态门禁)", () => {
    // ⚠️ **2026-08-29 第七棒补。这是本文件里唯一拦「跨语言边界丢键」的断言,
    // 而它比它当初要补的那一个字段重要得多。**
    //
    // 形态(已真实发生一次):第六棒给 result 事件加了
    // `num_turns_without_model_interaction`,TS 侧三处齐全 ——
    // `message-converter.ts` 发、`schemas.ts` 认(`.default(0)`)、还带单测,全绿。
    // 但 `sid_code_agent.py` **一句不落地丢掉** → `result.json` 里查不到,
    // 跑完与修复前**逐字节一样**,而**任何日志都不会报错**。
    // 于是那次 run 会产出「修复没效果」这个**错误结论**。
    //
    // 这是本仓「代码在、测试绿、真实路径不经过」的同型第三例:
    // ① 钳制实现了但生产调用点少传一个参数;② 本条,跨语言边界丢一个键;
    // ③ TS 改了但没重编二进制,容器里跑的是旧字节。三者**都不报错**。
    //
    // 所以这条断言拦的是**形态**,不是那一个字段:schemas.ts 上新增任何字段,
    // 只要 Python 侧既不读、也不显式豁免,这里就红。
    // 只补一行 metadata 而不加这条断言,下一个新字段会掉在同一条边界上。
    const schemaSrc = readFileSync(
      join(import.meta.dir, "..", "..", "packages", "core", "src", "sdk", "schemas.ts"),
      "utf-8",
    );
    const agentSrc = readFileSync(AGENT_PY, "utf-8");

    /** 抠出一个 schema 的顶层字段名。**先去注释** —— 注释里的散字会被当成字段。 */
    const schemaKeys = (name: string, endMark: string): string[] => {
      const start = schemaSrc.indexOf(`export const ${name}`);
      expect(start).toBeGreaterThan(-1);
      const end = schemaSrc.indexOf(endMark, start);
      expect(end).toBeGreaterThan(start);
      const body = schemaSrc
        .slice(start, end)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*/g, "");
      // 顶层字段固定 4 空格缩进(z.object({ 内一层)
      return [...body.matchAll(/^ {4}([a-z_][a-z0-9_]*):/gm)].map((m) => m[1]!);
    };

    const keys = [
      ...schemaKeys("SDKResultSuccessSchema", "export const SDKResultErrorSchema"),
      ...schemaKeys("SDKResultErrorSchema", "/** 结果消息（成功或错误） */"),
    ];
    // 先证明真的抠到了字段。抠空了的话下面的 for 循环是空转,**门禁会绿着失效**
    // —— 与本文件 L2 那条 `n_caps > 0` 同一个道理。
    expect(keys.length).toBeGreaterThanOrEqual(9);
    expect(keys).toContain("num_turns_without_model_interaction");

    /**
     * 显式豁免:**不消费是刻意的**,每条都要有理由。
     * 名单必须是白名单而不是黑名单 —— 新字段的默认命运是「必须被消费」,
     * 而不是「默认放过、等人想起来」。
     */
    const WAIVED: Record<string, string> = {
      type: "判别式常量('result'),`_last_result_event` 已用它筛事件,回填无意义",
      result: "最终答复正文。判分由 verifier 做,把模型自述塞进 metadata 反而会被当判据",
      structured_output: "sid-code 侧当前不产出;真要用了它就该落 metadata,所以留在名单里显式记着",
    };

    const consumed = (key: string): boolean =>
      // `result.get("k")` —— 允许换行(长键名会被 formatter 折行)
      new RegExp(String.raw`result\.get\(\s*\n?\s*"${key}"`).test(agentSrc) ||
      // usage 是嵌套读的:`usage.get(...)` + `raw_usage = result.get("usage")`
      new RegExp(String.raw`raw_usage\s*=\s*result\.get\(\s*"${key}"`).test(agentSrc);

    const dropped = keys.filter((k) => !consumed(k) && !(k in WAIVED));
    // 失败信息直接点名是哪个键掉了 —— 不然下一个人要自己去比两份文件。
    expect(dropped).toEqual([]);

    // 豁免名单不许发霉:名单里却已经被消费了的键要清掉,否则名单会渐渐变成
    // 一份「谁也不敢删的历史遗留」,失去「新字段默认必须消费」这层语义。
    expect(Object.keys(WAIVED).filter((k) => consumed(k))).toEqual([]);
    // 名单里的键也必须真的在 schema 上(改名/删字段后名单要跟着改)。
    expect(Object.keys(WAIVED).filter((k) => !keys.includes(k))).toEqual([]);

    // 最后钉住这一次的那个字段本身(上面是形态,这条是本次的具体判据):
    // 缺陷 1(§15.5)的唯一结构化判据就是它,读不到就等于那次修复无法验证。
    expect(agentSrc).toContain("sid_num_turns_without_model_interaction");
  });

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

    test("skip 改成非布尔 type → 权限档形态断言翻红", () => {
      // 精确复现三个坑里最隐蔽的那个:`type` 不是 bool 时 Harbor 拼出
      // `--dangerously-skip-permissions True`,**不报错、也不生效**。
      // 用 str 而不是删掉整条 flag:删掉会让「skipFlag 抠不到」先红,
      // 那报的是「flag 缺失」不是「形态错了」—— 两者的排查方向不同。
      withMutatedFixture(
        (s) =>
          s.replace(
            '            type="bool",\n            default=True,',
            '            type="str",\n            default=True,',
          ),
        (pth) => {
          const s = readFileSync(pth, "utf-8");
          const skipFlag = /CliFlag\(\s*\n\s*"skip_permissions",[\s\S]*?\n\s*\)/.exec(s)?.[0] ?? "";
          expect(skipFlag).not.toBe("");
          // 判据翻红:不再是 bool
          expect(skipFlag).not.toMatch(/type="bool"/);
        },
      );
    });

    test("把 skip 模式名列进 permission_mode 的 choices → 断言翻红", () => {
      // 那是「把一条静默失效的路径做成官方旋钮」。
      withMutatedFixture(
        (s) =>
          s.replace(
            'choices=["default", "acceptEdits", "plan", "always-allow"],',
            'choices=["default", "acceptEdits", "plan", "dangerously-skip-permissions"],',
          ),
        (pth) => {
          const s = readFileSync(pth, "utf-8");
          const modeFlag = /CliFlag\(\s*\n\s*"permission_mode",[\s\S]*?\n\s*\)/.exec(s)?.[0] ?? "";
          expect(modeFlag).toContain('"dangerously-skip-permissions"');
        },
      );
    });

    test("删掉互斥校验 / 观测计数 → 对应断言翻红", () => {
      // 这两个是「跑完才发现整轮不可用」与「读配置以为自己知道实际行为」两条的对策,
      // 删掉任一条都不会让 harbor 报错 —— 所以必须有门禁盯着它们存在。
      withMutatedFixture(
        (s) =>
          s
            .replace(
              "    def _assert_permission_flags_coherent(self) -> None:",
              "    def _disabled_coherence_check(self) -> None:",
            )
            .replace(
              "    def _count_permission_decisions(self) -> dict[str, Any] | None:",
              "    def _disabled_decision_count(self) -> dict[str, Any] | None:",
            ),
        (pth) => {
          const f = runL1(pth).facts!;
          expect(f.members).not.toContain("_assert_permission_flags_coherent");
          expect(f.members).not.toContain("_count_permission_decisions");
        },
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
// L1b:harbor 目录下**其余** .py 的语法与判据单源性。
//
// ⚠️ 为什么单独一层:上面那 27 条只认 `sid_code_agent.py`,而这个目录里还有 7 个
// 复算/进度脚本。仓库五道门禁一道都不认 `.py` —— 于是它们的语法错误会**延迟到
// 跑评测时才暴露**,而那时已经起了容器、拉了镜像、花了钱。这正是本文件开头那条
// 「补上 .py 门禁」的理由,只是当初只覆盖了 agent 那一个文件。
// ─────────────────────────────────────────────────────────────────────────────

describe.if(HAS_PYTHON3)("L1b 复算脚本的语法与判据单源性", () => {
  const HARBOR_DIR = join(import.meta.dir, "..", "..", "evals", "external-benchmarks", "harbor");

  /** 目录里所有 .py(不含 agent 本体 —— 它由上面那 27 条覆盖)。 */
  const scripts = readdirSync(HARBOR_DIR)
    .filter((f) => f.endsWith(".py") && f !== "sid_code_agent.py")
    .sort();

  /**
   * 剥掉注释**与 docstring**,只留真正会执行的代码。
   *
   * ⚠️ 这个函数本身是踩出来的:初版只过滤 `#` 开头的行,于是
   * `verifier_health.py` 与 `analyze-permission-switch.py` 的 **docstring** 里
   * 那句「别拿 `command not found` 当判据」的教训**被当成了判据本体**,
   * 门禁把两个正确的文件判成了违规 —— 一个假红。
   *
   * 而「把教训从文档字符串里删掉让门禁变绿」正是最坏的做法:抹掉的是唯一的溯源线索。
   * 所以要剥的是 docstring,不是教训。
   */
  const TRIPLE_D = '"' + '""';
  const TRIPLE_S = "'" + "''";
  const codeOnly = (src: string): string => {
    // 三引号块(docstring 与多行字符串)整段去掉,非贪婪
    const stripBlocks = (text: string, fence: string): string => {
      const re = new RegExp(fence + "[\\s\\S]*?" + fence, "g");
      return text.replace(re, "");
    };
    return stripBlocks(stripBlocks(src, TRIPLE_D), TRIPLE_S)
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("#"))
      .join("\n");
  };

  test("目录里确实有复算脚本(空集会让下面每条都空转通过)", () => {
    // 没有这条的话,`scripts` 变成空数组时 for 循环一次都不执行,
    // 整个 describe 看起来「全部通过」—— 与真的通过完全一样。
    expect(scripts.length).toBeGreaterThan(0);
  });

  test("每个脚本都能被 python 编译(拦语法错误,不 import 所以零依赖)", () => {
    // 用 py_compile 而不是 import:import 会执行模块顶层代码(有的脚本读 argv),
    // 而我们只想知道「语法坏了没有」。
    for (const f of scripts) {
      const r = Bun.spawnSync({
        cmd: [
          "python3",
          "-c",
          "import py_compile,sys; py_compile.compile(sys.argv[1], doraise=True)",
          join(HARBOR_DIR, f),
        ],
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(r.exitCode, `${f} 编译失败:\n${r.stderr.toString()}`).toBe(0);
    }
  });

  test("verifier 判据只有一处定义 —— 消费者一律 import,不许各写一份", () => {
    // ⚠️ 这一条是 2026-08-29 自己踩出来的:进度脚本与复算脚本各写了一份判据
    //(一份还多要求 `installing to /root/.local/bin`),于是**同一题可能一个报 ✅
    // 一个报 ⛔**,而分歧会在无人看的时候发生。判据只能有一个定义处。
    const HEALTH = "verifier_health.py";
    expect(scripts).toContain(HEALTH);

    // 定义处:正则必须在这里,且只在这里。
    const health = readFileSync(join(HARBOR_DIR, HEALTH), "utf-8");
    expect(health).toMatch(/passed\|failed/);

    // 消费者:凡是判 verifier 健康的脚本,必须 import 共享模块,
    // **不许自己写 pytest 结论行的正则**。
    for (const f of scripts) {
      if (f === HEALTH) continue;
      const src = readFileSync(join(HARBOR_DIR, f), "utf-8");
      const usesHealth = /from verifier_health import|import verifier_health/.test(src);
      // 只在**代码里**找:注释与 docstring 里提到不算
      //(记录教训的文字必须能安全地留着)。
      const ownRegex = /passed\|failed/.test(codeOnly(src));
      expect(
        !ownRegex || usesHealth,
        `${f} 自己写了 pytest 结论行判据却没 import verifier_health —— 判据会分叉`,
      ).toBe(true);
    }
  });

  test("用 `command not found` 的脚本必须同时有**正向**判据(pytest 结论行)", () => {
    // ## 这条断言的措辞被改过一次,改的理由比断言本身重要
    //
    // 初版断言的是「代码里**不许出现** `command not found`」。它把
    // `analyze-prefix.py`(前一棒的脚本)判成了违规 —— 而那个脚本**是对的**:
    // 它的排除决策由 `verifier_ran`(正向判据)把关,
    // `command not found` 只用来在标签里说明**是哪一种坏法**:
    //
    //     elif broken_hit and not verifier_ran:   ← 决策看的是 verifier_ran
    //         bucket = f"excluded:verifier-broken({broken_hit.group(0)})"
    //
    // **一个假红。** 而假红的代价不只是浪费时间:它会训练人「让门禁闭嘴」,
    // 而闭嘴最省事的做法恰好是删掉那段记录教训的文字。
    //
    // 所以判据从「禁止这个词」改成「**用了它就必须同时有正向判据**」——
    // 拦的是「只靠症状做判定」这个**形态**,不是某个字符串。
    //
    // 被拦住的真实坏法(2026-08-29 实测):`polyglot-c-py` 的 verifier 是在
    // 下载 uv 的**中途被超时杀掉**的,日志停在 `downloading uv 0.7.13`,
    // 那句 `command not found` 压根没来得及打印。只认症状的判据漏了它 ——
    // 它只是**恰好**因为 `reward=None` 才被排除(运气,不是判据)。
    for (const f of scripts) {
      const code = codeOnly(readFileSync(join(HARBOR_DIR, f), "utf-8"));
      if (!/command not found/.test(code)) continue;
      // 正向判据:要么自己有 pytest 结论行的正则,要么 import 共享模块。
      const hasPositive =
        /passed\|failed|failed\|passed|passed\|error|failed\|error/.test(code) ||
        /from verifier_health import|import verifier_health/.test(code);
      expect(
        hasPositive,
        `${f} 用 command not found 做判定却没有正向判据(pytest 结论行 / verifier_ran)`,
      ).toBe(true);
    }
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

  test("_recover_usage_from_traj:result 事件缺失时从 session.traj 兜底取到真实花费", () => {
    // ⚠️ **2026-08-29 从 A11 真实 benchmark 里挖出来的成本低报缺陷。**
    // 本 test 用的数字**全部取自真实那一题**(`fix-code-vulnerability`,撞 3600s 硬顶
    // 被 SIGKILL):cost=0.05377850000000001 / cumulative_prompt=1146 /
    // cache_read=59195 / cache_creation=15391 / received=117 / api_calls=3。
    // (prompt 总量 1146+59195+15391 = 75,732,与 §15.7 记的一致。)
    //
    // 放 L2 而不是 L1,理由同 `_derive_is_error`:测的是**行为**(给定磁盘布局 → 回填值),
    // 而 L1 只能看到源码形态 —— 形态断言拦不住「函数在但读错了字段」。
    const snippet = [
      "import json, os, tempfile, types",
      "from pathlib import Path",
      "from sid_code_agent import SidCodeAgent as A",
      "",
      "def probe(md, *, mtimes=None):",
      "    root = Path(tempfile.mkdtemp())",
      "    sess = root / 'sid-home' / 'trajectories' / 'sessions'",
      "    if md is not None:",
      "        for name, meta in md.items():",
      "            d = sess / name",
      "            d.mkdir(parents=True)",
      "            (d / 'session.traj').write_text(json.dumps({'metadata': meta}))",
      "            if mtimes and name in mtimes:",
      "                os.utime(d / 'session.traj', (mtimes[name], mtimes[name]))",
      "    else:",
      "        sess.mkdir(parents=True)",
      // 不实例化 SidCodeAgent（它的 __init__ 要 Harbor 的完整 config）：
      // 造一个只带 logs_dir 的替身，把未绑定方法挂上去调用。
      // 这样测的仍是**真实那段实现**，而不是它的复制品。
      "    stub = types.SimpleNamespace(logs_dir=root)",
      "    return A._recover_usage_from_traj(stub)",
      "",
      "REAL = {",
      "  'total_cost_usd': 0.05377850000000001,",
      "  'total_cumulative_prompt_tokens': 1146,",
      "  'total_tokens_received': 117,",
      "  'total_cache_read_tokens': 59195,",
      "  'total_cache_creation_tokens': 15391,",
      "  'total_api_calls': 3,",
      "  'total_steps': 38,",
      "  'session_id': '20260828-145335-3b0a5194',",
      "}",
      "",
      "out = {}",
      "out['real'] = probe({'20260828-145335-3b0a5194': REAL})",
      // 目录不存在 / 空目录 / cost 缺失 / cost=0 → 一律 None（绝不填 0）
      "out['no_dir'] = probe(None)",
      "out['zero_cost'] = probe({'s': dict(REAL, total_cost_usd=0)})",
      "out['null_cost'] = probe({'s': {k: v for k, v in REAL.items() if k != 'total_cost_usd'}})",
      // 两个会话时取 mtime 最新的那个（install 阶段的自检可能留下第二个）
      "out['newest'] = probe(",
      "  {'old': dict(REAL, total_cost_usd=0.11, session_id='old'),",
      "   'new': dict(REAL, total_cost_usd=0.22, session_id='new')},",
      "  mtimes={'old': 1_000_000, 'new': 2_000_000},",
      ")",
      "print(json.dumps(out))",
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

    // ① 真实那一题:修复前这里全是 null,那 $0.0538 没进任何账。
    expect(r.real).not.toBeNull();
    expect(r.real.cost_usd).toBeCloseTo(0.0537785, 7);
    // ⛔ flow 口径:1146(cumulative_prompt),**不是** stock 的 total_tokens_sent。
    expect(r.real.n_input_tokens).toBe(1146);
    expect(r.real.n_output_tokens).toBe(117);
    expect(r.real.n_cache_tokens).toBe(59195);
    expect(r.real.cache_write_tokens).toBe(15391);
    expect(r.real.total_api_calls).toBe(3);
    expect(r.real.session_id).toBe("20260828-145335-3b0a5194");
    // §15.7 的判据:三段相加 = 75,732
    expect(r.real.n_input_tokens + r.real.n_cache_tokens + r.real.cache_write_tokens).toBe(75_732);

    // ② 拿不到时**必须** None,绝不 0 —— 填 0 会让「没采到」伪装成「没花钱」,
    // 而这两件事在数据上不可区分。这三条是本修复最容易被"优化"掉的部分。
    expect(r.no_dir).toBeNull();
    expect(r.zero_cost).toBeNull();
    expect(r.null_cost).toBeNull();

    // ③ 多会话取最新:挑错会让 sid_session_id 与轨迹对不上,而那是唯一的反查接缝。
    expect(r.newest.session_id).toBe("new");
    expect(r.newest.cost_usd).toBeCloseTo(0.22, 6);
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
