/**
 * `agent_started` 判据门禁 —— 防「启动未完成的题被记进能力账」
 *
 * ## 这份测试为什么必须存在（2026-09-03 实测）
 *
 * `runs/modelswitch-base-rerun` 的 `fix-code-vulnerability` 拿到 `reward=0.0`，
 * verifier **判分正常**，于是它**被当成一个真实的 0 分放进了配对分母**。
 * 它的真实形态是**卡死在启动里、一次 API 都没发出**：
 *
 *   - `debug.log` 只有 134 行，时间戳首末**都是** 16:25:57（healthy 题 522~3419 行）
 *   - 最后一行是 `[SKILL] 加载了 8 个 Skill`，`[PERF] startup` **没有**（其余 90 题全有）
 *   - `trajectories/` 目录**都没建出来**
 *   - `AgentTimeoutError after 3600.0s` —— 60 分钟全耗在一个没动的进程上
 *
 * 而 cc 侧同一题是 **1.0** ⇒ 配对均值被拉成 `0.250 → 0.125`，读起来像
 * 「换档退步了」。接上判据后是 `0.143 → 0.143`（n=7）——**那个"退步"整个是假的**。
 *
 * ## 为什么 `agent_ran` 拦不住它（这条是本门禁的核心，别把两者合并）
 *
 * 它整份 metadata 缺失（`sid_result_event_missing=True`）⇒ 两个 token 键都是 `None`
 * ⇒ `agent_ran` 返回 **None（不可判）而不是 False**，于是消费侧的
 * `agent_ran(d) is False` **不成立**。`llm_fatal` 读的也是同一份缺失的 metadata
 * ⇒ **两条判据都放行**。判据必须取一个**不依赖被怀疑那条链路**的源。
 *
 * ## 为什么只有 L1（纯静态）
 *
 * 本门禁只用 stdlib `ast` 读源文件文本 + 在 tmpdir 上跑判据函数，
 * **不起容器、不跑 harbor、不联网** —— 所以在 CI 上**真的在跑**。
 * 「探测依赖失败就 skip」在 CI 上等于门禁不存在（`evals/CLAUDE.md` §4.2，踩过两次）。
 */

import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const HARBOR = join(import.meta.dir, "../../evals/external-benchmarks/harbor");
const HEALTH = join(HARBOR, "verifier_health.py");
const PAIRED = join(HARBOR, "compare-paired.py");
const ANALYZE = join(HARBOR, "analyze-model-switch.py");

const read = (p: string) => readFileSync(p, "utf8");

/**
 * ⚠️ 断言必须只看**代码**，不看注释 —— 本仓踩过两次同源的坑：一次把源码里
 * 「不要用它」的警告注释判成了违规（假红），一次把注释里的关键词当成代码在生效
 * （假绿）。这里注释里必然出现 `agent_started` 等词，读全文就会绿着失效。
 */
const codeOf = (p: string) =>
  read(p)
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");

/** 用 stdlib `ast` 提事实，判断留在 TS 侧（`evals/CLAUDE.md` §4.1）。 */
const FACTS = `
import ast, json, sys
tree = ast.parse(open(sys.argv[1], encoding="utf-8").read())
funcs, consts = [], []
for node in tree.body:
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
        funcs.append(node.name)
    elif isinstance(node, ast.Assign):
        for t in node.targets:
            if isinstance(t, ast.Name):
                consts.append(t.id)
imported = []
for node in ast.walk(tree):
    if isinstance(node, ast.ImportFrom) and node.module == "verifier_health":
        imported += [a.name for a in node.names]
print(json.dumps({"funcs": funcs, "consts": consts, "imported": imported}))
`;

function facts(path: string) {
  const r = spawnSync("python3", ["-c", FACTS, path], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`ast 提取失败(${path}): ${r.stderr}`);
  return JSON.parse(r.stdout) as { funcs: string[]; consts: string[]; imported: string[] };
}

/** 在 tmpdir 上造一个 trial 目录，**绝不动真实 run 目录**（§4.3）。 */
function makeTrial(debugLogContent: string | null): { dir: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "agent-started-"));
  const trial = join(root, "some-task__ABC123");
  if (debugLogContent !== null) {
    const f = join(trial, "agent", "sid-home", "debug.log");
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, debugLogContent, "utf8");
  } else {
    mkdirSync(trial, { recursive: true });
  }
  return { dir: trial, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** 直接跑真判据函数（不 import harbor，只 import 这一个 stdlib-only 模块）。 */
function callAgentStarted(trialDir: string): string {
  const r = spawnSync(
    "python3",
    [
      "-c",
      `import sys; sys.path.insert(0, sys.argv[1])
from verifier_health import agent_started
print(repr(agent_started(sys.argv[2])))`,
      HARBOR,
      trialDir,
    ],
    { encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(`调用失败: ${r.stderr}`);
  return r.stdout.trim();
}

describe("agent_started：判据存在且定义在唯一定义处", () => {
  test("verifier_health.py 是唯一定义处，且导出了 agent_started", () => {
    expect(existsSync(HEALTH)).toBe(true);
    expect(facts(HEALTH).funcs).toContain("agent_started");
  });

  test("判据字符串是具名常量，不是散落的字面量", () => {
    // 散落的字面量会在两处漂移，而漂移时两边都"能自证"——本模块存在的理由。
    expect(facts(HEALTH).consts).toContain("AGENT_STARTUP_MARK");
  });

  test("取数源是 debug.log，不是 metadata", () => {
    // 🔴 核心：metadata **恰恰是缺失的那一份**（所以 agent_ran 才判不出来）。
    // 判据取 metadata 就等于用被怀疑的链路自证。
    const code = codeOf(HEALTH);
    expect(code).toMatch(/debug\.log/);
  });
});

describe("agent_started：三态语义（None 与 False 必须分开）", () => {
  test("走完启动 → True", () => {
    const t = makeTrial("[16:49:57] · [PERF] startup 1010.5ms\n[16:49:57] ● [APP] 开始初始化...\n");
    try {
      expect(callAgentStarted(t.dir)).toBe("True");
    } finally {
      t.cleanup();
    }
  });

  test("卡在启动里（无 startup 行）→ False —— 这就是那一题的形态", () => {
    const t = makeTrial("[16:25:57] ● [SKILL] 加载了 8 个 Skill\n");
    try {
      expect(callAgentStarted(t.dir)).toBe("False");
    } finally {
      t.cleanup();
    }
  });

  test("没有 debug.log（cc / mswea / nop 侧）→ None，**不是 False**", () => {
    // 🔴 若这里返回 False，消费侧会把**整个对照侧**排除掉 —— 比不排除更坏。
    const t = makeTrial(null);
    try {
      expect(callAgentStarted(t.dir)).toBe("None");
    } finally {
      t.cleanup();
    }
  });
});

describe("消费侧：两个脚本都接上了，且用 `is False` 而非 `not`", () => {
  for (const [label, path] of [
    ["compare-paired.py", PAIRED],
    ["analyze-model-switch.py", ANALYZE],
  ] as const) {
    test(`${label} 从 verifier_health 导入 agent_started（不自己重写一份）`, () => {
      expect(facts(path).imported).toContain("agent_started");
    });

    test(`${label} 判 \`is False\`，绝不用 \`not ...\`（否则吞掉 None）`, () => {
      // 🔴 这条是本门禁最该守的形态：`not X` 会把 None（= 没有 sid debug.log 的
      // 对照侧，cc / mswea / nop）也判成"未启动"，**把整个对照侧排除掉**。
      //
      // ⚠️ 两个脚本的形态不同，判据必须各自贴合，不能用同一条正则硬套：
      //   - compare-paired.py  ：内联调用 `agent_started(td) is False`
      //   - analyze-model-switch.py：先存进 row（`agent_started=agent_started(tdir)`），
      //     再在派生处判 `r["agent_started"] is False`
      // 硬套一条会逼出一个"为了让门禁绿"的改写，那比没有门禁更坏。
      const code = codeOf(path);
      expect(code).toMatch(/agent_started(?:\([^)]*\)|"\])\s+is\s+False/);
      // 反向：任何 `not` 形态都不许出现（含 row 取值那种写法）。
      expect(code).not.toMatch(/\bnot\s+(?:agent_started\(|r\["agent_started"\])/);
    });
  }

  test("compare-paired 把它作为独立排除原因，不与「零调用」合并", () => {
    // 合并的话，两种故障的下一步动作会被混成一个：零调用查上游失败率，
    // 启动未完成查 agent 卡在哪一步。
    expect(codeOf(PAIRED)).toContain("启动未完成");
  });

  test("analyze-model-switch 把它并入 excluded 集（否则并排段仍会报「对称」）", () => {
    // excluded 是「两侧排除的题名集合」的唯一来源；漏了它，§并排段那句
    // 「非能力失败的分布不对称」就检测不出这一题 —— 而那正是本次要修的东西。
    expect(codeOf(ANALYZE)).toMatch(/excluded=sorted\([\s\S]*?nostart/);
  });
});

describe("变异自证：判据人为改坏后，判定必须翻转（§4.3）", () => {
  test("① 删掉 startup 标志行 → True 翻成 False", () => {
    const good = makeTrial("[16:49:57] · [PERF] startup 1010.5ms\n");
    const bad = makeTrial("[16:49:57] · 别的什么行\n");
    try {
      expect(callAgentStarted(good.dir)).toBe("True");
      expect(callAgentStarted(bad.dir)).toBe("False"); // 判定翻转 ⇒ 判据真的在看这一行
    } finally {
      good.cleanup();
      bad.cleanup();
    }
  });

  test("② 空 debug.log → False，而**目录整个不存在** → None（两者不可混）", () => {
    // 「文件在但内容空」= agent 起了但没走完（该排除）；
    // 「文件不在」= 这一侧压根不是 sid agent（不可判）。混淆会波及整个对照侧。
    const empty = makeTrial("");
    const none = makeTrial(null);
    try {
      expect(callAgentStarted(empty.dir)).toBe("False");
      expect(callAgentStarted(none.dir)).toBe("None");
    } finally {
      empty.cleanup();
      none.cleanup();
    }
  });

  test("③ 真实那一题的 debug.log 尾部原样喂进去 → False（回归锚）", () => {
    // 逐字取自 runs/modelswitch-base-rerun/fix-code-vulnerability__VnAKMAG。
    const t = makeTrial(
      [
        "[16:25:57] · [BASH] shell 快照已创建: /logs/agent/sid-home/shell-snapshots/snapshot-bash-73.sh",
        "[16:25:57] ● [SKILL] 已释放 8 个 builtin Skill、共 105 个文件",
        "[16:25:57] ● [SKILL] 加载了 8 个 Skill",
        "  {",
        '    "names": [',
        '      "bug-fix"',
        "    ]",
        "  }",
        "",
      ].join("\n"),
    );
    try {
      expect(callAgentStarted(t.dir)).toBe("False");
    } finally {
      t.cleanup();
    }
  });

  test("④ 提取逻辑坏掉时**必须非 0 退出**，不是静默返回空事实", () => {
    // 空集上跑 toContain 会红，但红的原因指错地方（§4.3 第四类变异）。
    const root = mkdtempSync(join(tmpdir(), "agent-started-syntax-"));
    const broken = join(root, "broken.py");
    writeFileSync(broken, "def (((\n", "utf8");
    try {
      expect(() => facts(broken)).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
