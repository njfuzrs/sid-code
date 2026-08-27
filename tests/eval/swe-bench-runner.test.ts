/**
 * SWE-bench 阶段 A runner / 判分的单测。
 *
 * 事实源：`evals/external-benchmarks/swe-bench/接入计划.md` §4.2–§4.6 + §6
 *
 * ## 这份测试专防什么
 *
 * 本仓反复踩的那一个陷阱：**「绿了但没测到」**。所以每一组断言都配一条
 * **变异自证** —— 把被测逻辑改成错的写法，断言测试会因此失败。
 * 没有变异自证的断言，说不清它拦的是真行为还是恒真表达式。
 *
 * 最重要的三条不变量（每条都对应一个真实踩过的坑）：
 *   1. `ungraded` 不许折叠成 0 —— 那是被否决的路径 A「scorer 恒返 0」的同型；
 *   2. 验收 schema 里**不许出现百分比字段** —— n=10 时 60% 与 70% 统计上无法区分；
 *   3. 「agent 失败」与「没有 patch」是两件事，不能合并判定。
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseSubset,
  buildPrompt,
  isTestPath,
  parseNumstatZ,
  newFilePaths,
  patchOnlyAddsFiles,
  splitExtractOutput,
  normalizePatch,
  deriveOutcome,
  pickArtifact,
  parseArgs,
  extractAgentLogSignals,
  MODEL_NAME,
} from "../../evals/external-benchmarks/swe-bench/runner.ts";
import {
  mapOutcomes,
  buildAcceptance,
  renderReport,
  findReport,
  readGoldOk,
  METER_NOTE,
  buildTimingProfile,
  renderTimingSection,
  type OfficialReport,
} from "../../evals/external-benchmarks/swe-bench/grade.ts";

const SWE_DIR = join(import.meta.dir, "../../evals/external-benchmarks/swe-bench");

// ─────────────────────────────────────────────────────────────────────────────
// subset 解析
// ─────────────────────────────────────────────────────────────────────────────

describe("parseSubset：只读 instances 段", () => {
  const yaml = `
dataset:
  name: "x"
instances:
  - instance_id: "a__a-1"
    repo: "a/a"
    base_commit: "aaa111"
    version: "1.0"
    difficulty: "<15 min fix"
    fail_to_pass_count: 1
  - instance_id: "b__b-2"
    repo: "b/b"
    base_commit: "bbb222"
    version: "2.0"
    difficulty: "1-4 hours"
candidate_pool:
  - instance_id: "c__c-3"
    repo: "c/c"
    base_commit: "ccc333"
`;

  test("解析出两条，字段完整", () => {
    const got = parseSubset(yaml);
    expect(got).toHaveLength(2);
    expect(got[0]).toEqual({
      instance_id: "a__a-1",
      repo: "a/a",
      base_commit: "aaa111",
      version: "1.0",
      difficulty: "<15 min fix",
    });
    expect(got[1].base_commit).toBe("bbb222");
  });

  /**
   * ⚠️ 这条是**分母保护**。候选池被捎带进来 → n 从 10 变 15，
   * 而 `solved_count` 的分母跟着变，两次跑分就不可比了。
   * §6 那五个验收字段里 `solved_count: n/10` 的 10 是写死的口径。
   */
  test("candidate_pool 不许被捎带进来（否则分母从 10 变 15）", () => {
    const ids = parseSubset(yaml).map((s) => s.instance_id);
    expect(ids).not.toContain("c__c-3");
  });

  test("变异自证：若不在顶格 key 处终止 instances 段，候选池就会漏进来", () => {
    // 模拟「忘了终止」的实现：把 candidate_pool: 这一行也当成普通内容
    const naive = (y: string) => {
      const out: string[] = [];
      let inb = false;
      for (const line of y.split("\n")) {
        if (/^instances:\s*$/.test(line)) {
          inb = true;
          continue;
        }
        if (!inb) continue;
        const m = line.match(/^\s*-\s+instance_id:\s*"([^"]+)"/);
        if (m) out.push(m[1]);
      }
      return out;
    };
    // 这个错误实现确实会把候选池带进来 —— 证明上面那条断言不是恒真
    expect(naive(yaml)).toContain("c__c-3");
    expect(parseSubset(yaml).map((s) => s.instance_id)).not.toContain("c__c-3");
  });

  test("真实 verified-subset.yaml 解析出 10 条且 base_commit 都是 40 位 sha", () => {
    const real = parseSubset(readFileSync(join(SWE_DIR, "verified-subset.yaml"), "utf8"));
    expect(real).toHaveLength(10);
    for (const r of real) {
      expect(r.base_commit).toMatch(/^[0-9a-f]{40}$/);
      expect(r.instance_id).toMatch(/^[a-z0-9-]+__[a-z0-9-]+-\d+$/i);
    }
  });

  /** 占位符残留（上一版 yaml 里有 11 处 TODO_S8_FILL）会让 base_commit 是假的 */
  test("真实 yaml 里不许有 TODO 占位符", () => {
    const raw = readFileSync(join(SWE_DIR, "verified-subset.yaml"), "utf8");
    expect(raw).not.toContain("TODO_S8_FILL");
    expect(raw).not.toMatch(/TODO/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// prompt 契约（§4.3）
// ─────────────────────────────────────────────────────────────────────────────

describe("prompt 契约 §4.3", () => {
  test("题面注入占位符", () => {
    expect(buildPrompt("{problem_statement}\n\nX", "题面内容")).toBe("题面内容\n\nX");
  });

  test("模板缺占位符必须抛，而不是静默产出一个没题面的 prompt", () => {
    expect(() => buildPrompt("没有占位符", "题面")).toThrow(/占位符/);
  });

  const tpl = readFileSync(join(SWE_DIR, "prompt-v1.txt"), "utf8");

  /**
   * §4.3 第 1 条：只给 problem_statement 原文，不加元信息。
   * 这条测试拦的是「后来有人往 prompt 里加一句『这是 SWE-bench 题，请仔细』」——
   * 那会让分数与之前不可比，而且不会有任何东西报错。
   */
  test("prompt-v1.txt 不含任何 SWE-bench 元信息与答案字段名", () => {
    for (const forbidden of [
      "SWE-bench",
      "FAIL_TO_PASS",
      "PASS_TO_PASS",
      "base_commit",
      "gold",
      "benchmark",
    ]) {
      expect(tpl).not.toContain(forbidden);
    }
  });

  /** §4.3 第 2 条：显式禁止改测试文件，且约束**加在题面之后**（D17） */
  test("禁改测试文件的约束存在，且位于题面占位符之后", () => {
    expect(tpl.toLowerCase()).toContain("test");
    const phIdx = tpl.indexOf("{problem_statement}");
    const constraintIdx = tpl.toLowerCase().indexOf("do not modify");
    expect(phIdx).toBeGreaterThanOrEqual(0);
    expect(constraintIdx).toBeGreaterThan(phIdx);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// patch 提取 + 硬检查（§4.5）
// ─────────────────────────────────────────────────────────────────────────────

describe("isTestPath：软约束的硬检查", () => {
  test.each([
    ["tests/test_foo.py", true],
    ["testing/test_collection.py", true],
    ["src/_pytest/tests/helper.py", true],
    ["astropy/modeling/tests/test_separable.py", true],
    ["conftest.py", true],
    ["foo/bar_test.go", true],
    ["test_top_level.py", true],
    ["astropy/modeling/separable.py", false],
    ["django/db/models/base.py", false],
    ["src/latest/contest.py", false],
    ["lib/matplotlib/image.py", false],
  ])("%s → %s", (p, want) => {
    expect(isTestPath(p)).toBe(want);
  });

  /**
   * ⚠️ 判据故意**宁可多报**：少报一次 = 一个改了测试的 patch 被静默计入解出，
   * 那个分数就不可信了。所以这里验的是「不漏」，不是「不多」。
   */
  test("变异自证：只按文件名前缀判会漏掉 tests/ 目录下的普通名字", () => {
    const naive = (p: string) => /^test_/.test(p.split("/").pop() ?? "");
    expect(naive("astropy/modeling/tests/helpers.py")).toBe(false); // 漏了
    expect(isTestPath("astropy/modeling/tests/helpers.py")).toBe(true); // 没漏
  });
});

describe("parseNumstatZ", () => {
  test("按 NUL 切记录，二进制标记为 add === '-'", () => {
    const out = "3\t1\tsrc/a.py\0-\t-\tdocs/logo.png\0";
    expect(parseNumstatZ(out)).toEqual([
      { path: "src/a.py", binary: false },
      { path: "docs/logo.png", binary: true },
    ]);
  });

  /** 路径含空格时，非 -z 的输出会被 quote，按 TAB 切会切错 */
  test("路径含空格与中文仍能正确取出", () => {
    const out = "1\t0\tsrc/a b/文件 名.py\0";
    expect(parseNumstatZ(out)[0].path).toBe("src/a b/文件 名.py");
  });

  test("空输入返回空数组，不抛", () => {
    expect(parseNumstatZ("")).toEqual([]);
    expect(parseNumstatZ("\0\0")).toEqual([]);
  });

  /**
   * ⛔ 这一组防的是一道**被静默架空的门禁**（2026-08-25 复核 smoke-2 数据时发现）。
   *
   * 提取那步在 shell 里是 `extract_out="$(docker exec ...)"`，
   * 而 **bash 命令替换会丢弃 NUL 字节**。于是 `--numstat -z` 的多条记录
   * 落盘时首尾相接、没有任何分隔符：
   *
   *   "5\t0\tsrc/foo.py3\t1\ttests/test_foo.py2\t0\tsrc/bar.py"
   *
   * 旧实现按 NUL 切 → 只得到 1 条，path 是把后面全部记录粘成的怪串 →
   * `isTestPath` 匹配不上 → **`patch_touches_tests` 恒为 false**，
   * 「禁改测试文件」这道硬检查就没了。全程 exit 0、字段自洽。
   *
   * 实测代价：smoke-2 报告里 `patch_touches_tests: 0` 是个**假阴性** ——
   * `matplotlib-20488` 的 patch 里确实有 `repro_test.py`。
   *
   * 现在容器侧把 NUL 转成 RS(\x1e)（活得过命令替换），TS 侧三种形态都收：
   * NUL（原生）/ RS（转译后）/ 粘连（旧数据仍要能读）。
   */
  test("NUL 被 shell 吃掉后仍能切对 —— 否则 patch_touches_tests 恒 false", () => {
    const glued = "\n5\t0\tsrc/foo.py3\t1\ttests/test_foo.py2\t0\tsrc/bar.py\n";
    const files = parseNumstatZ(glued);
    expect(files.map((f) => f.path)).toEqual(["src/foo.py", "tests/test_foo.py", "src/bar.py"]);
    // 门禁必须真的能命中那个测试文件
    expect(files.map((f) => f.path).filter(isTestPath)).toEqual(["tests/test_foo.py"]);
  });

  test("RS(\\x1e) 分隔（容器侧 tr 转译后的形态）等价于 NUL", () => {
    const rs = "5\t0\tsrc/foo.py\x1e3\t1\ttests/test_foo.py\x1e";
    const nul = "5\t0\tsrc/foo.py\x003\t1\ttests/test_foo.py\x00";
    expect(parseNumstatZ(rs)).toEqual(parseNumstatZ(nul));
    expect(parseNumstatZ(rs)).toHaveLength(2);
  });

  test("粘连形态下二进制标记仍分得清", () => {
    // NUL 丢失 + 混有二进制文件（core dump 那种）
    const files = parseNumstatZ("-\t-\tcore5\t0\tsrc/a.py");
    expect(files).toEqual([
      { path: "core", binary: true },
      { path: "src/a.py", binary: false },
    ]);
  });

  /** 反向断言：路径里含 TAB 时不许被当成字段分隔切断（`-z` 存在的理由） */
  test("路径含 TAB 也不切断（只有 `数字TAB数字TAB` 才是记录头）", () => {
    const files = parseNumstatZ("5\t0\ta b/c\td.py\x001\t0\tsrc/x.py\x00");
    expect(files.map((f) => f.path)).toEqual(["a b/c\td.py", "src/x.py"]);
  });
});

describe("newFilePaths / patchOnlyAddsFiles：区分「新建调试脚本」与「改了源码」", () => {
  /**
   * 实测背景（2026-08-25 smoke-2）：`django-15128` 与 `matplotlib-20488` 的 patch 里
   * **只有 agent 自建的复现脚本**（`repro/*.py` / `repro_test.py`），一行源码没改 ——
   * agent 卡在复现阶段。而这在 `patch_bytes=3412` / `outcome=patch_produced` 上
   * 完全看不出来。
   *
   * ⛔ 刻意**不**在提取时滤掉这些文件（ZZZ.5 第 3 条已否决「提取时排除」）：
   * 滤掉后那两条会变成干净的 `no_patch`，而 `no_patch` 读起来像「没想出办法」——
   * 与「想了、试了、卡在复现」是两件不同的事。这个字段只标注，不改判定。
   */
  const mkDiff = (entries: { path: string; isNew: boolean }[]) =>
    entries
      .map(
        (e) =>
          `diff --git a/${e.path} b/${e.path}\n` +
          (e.isNew ? "new file mode 100644\nindex 0000000..e69de29\n" : "index aaa..bbb 100644\n") +
          `--- ${e.isNew ? "/dev/null" : `a/${e.path}`}\n+++ b/${e.path}\n@@ -0,0 +1 @@\n+x\n`,
      )
      .join("");

  test("全是新建文件 → true（就是那两条 repro 的形态）", () => {
    const paths = ["repro/run.py", "repro/settings.py"];
    const diff = mkDiff(paths.map((p) => ({ path: p, isNew: true })));
    expect(newFilePaths(diff).sort()).toEqual([...paths].sort());
    expect(patchOnlyAddsFiles(diff, paths)).toBe(true);
  });

  test("改了既有源码 → false（哪怕同时也新建了调试脚本）", () => {
    const diff = mkDiff([
      { path: "django/db/models/base.py", isNew: false },
      { path: "repro_test_tmp.py", isNew: true },
    ]);
    const paths = ["django/db/models/base.py", "repro_test_tmp.py"];
    expect(patchOnlyAddsFiles(diff, paths)).toBe(false);
  });

  test("纯改源码 → false，且 newFilePaths 为空", () => {
    const diff = mkDiff([{ path: "src/_pytest/pathlib.py", isNew: false }]);
    expect(newFilePaths(diff)).toEqual([]);
    expect(patchOnlyAddsFiles(diff, ["src/_pytest/pathlib.py"])).toBe(false);
  });

  /** 空 patch 不许判 true —— 否则一个 no_patch 会被贴上「只新建文件」的标签 */
  test("空 patch / 空文件列表 → false", () => {
    expect(patchOnlyAddsFiles("", [])).toBe(false);
    expect(patchOnlyAddsFiles(mkDiff([{ path: "a.py", isNew: true }]), [])).toBe(false);
  });
});

describe("splitExtractOutput", () => {
  test("切出 numstat 与 diff 两段", () => {
    const raw = "===NUMSTAT===\n1\t0\ta.py\0\n===DIFF===\ndiff --git a/a.py b/a.py\n+x\n";
    const { numstat, diff } = splitExtractOutput(raw);
    expect(numstat).toContain("a.py");
    expect(diff.startsWith("diff --git")).toBe(true);
  });

  /** 标记缺失 → 返回空，绝不把整段 raw 当成 diff（那会产出一个假 patch） */
  test("标记缺失时返回空，而不是把整段输出当 diff", () => {
    expect(splitExtractOutput("随便一段没有标记的输出")).toEqual({ numstat: "", diff: "" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 过程类结论
// ─────────────────────────────────────────────────────────────────────────────

describe("deriveOutcome：agent 失败 ≠ 没有 patch", () => {
  test("有 patch 就是 patch_produced，即使 agent 非 0 退出", () => {
    expect(deriveOutcome({ agentExit: 1, patchBytes: 500, timedOut: false })).toBe(
      "patch_produced",
    );
  });

  test("超时且无 patch → eval_timeout", () => {
    expect(deriveOutcome({ agentExit: 124, patchBytes: 0, timedOut: true })).toBe("eval_timeout");
  });

  test("超时但已有 patch → 仍记 patch_produced（部分改动不该被丢）", () => {
    expect(deriveOutcome({ agentExit: 124, patchBytes: 10, timedOut: true })).toBe(
      "patch_produced",
    );
  });

  test("agent 非 0 且无 patch → agent_error", () => {
    expect(deriveOutcome({ agentExit: 2, patchBytes: 0, timedOut: false })).toBe("agent_error");
  });

  test("agent 正常退出但无 patch → no_patch（与 agent_error 是两回事）", () => {
    expect(deriveOutcome({ agentExit: 0, patchBytes: 0, timedOut: false })).toBe("no_patch");
  });

  /**
   * 变异自证：合并判定（「非 0 退出就一律 agent_error」）会把一个
   * **有 patch** 的超时结果记成失败，那条 patch 就永远进不了判分。
   */
  test("变异自证：合并判定会丢掉超时但已产出 patch 的结果", () => {
    const naive = (i: { agentExit: number; patchBytes: number }) =>
      i.agentExit !== 0 ? "agent_error" : i.patchBytes > 0 ? "patch_produced" : "no_patch";
    expect(naive({ agentExit: 124, patchBytes: 800 })).toBe("agent_error"); // 丢了
    expect(deriveOutcome({ agentExit: 124, patchBytes: 800, timedOut: true })).toBe(
      "patch_produced",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 产物选择（D3 兜底路径）
// ─────────────────────────────────────────────────────────────────────────────

describe("pickArtifact：不许硬编码架构", () => {
  test("amd64 → linux-x64；arm64 → linux-arm64", () => {
    expect(pickArtifact("amd64", "0.1.601")).toContain("linux-x64");
    expect(pickArtifact("arm64", "0.1.601")).toContain("linux-arm64");
  });

  /**
   * D3 的兜底是「借一台 x86_64 linux 机器」。硬编码任何一侧
   * 都等于把那条兜底路径写死成不可用 —— 而它是 arm64 构建失控时唯一的退路。
   */
  test("两个架构产出不同路径（硬编码一侧会让这条失败）", () => {
    expect(pickArtifact("amd64", "1.0.0")).not.toBe(pickArtifact("arm64", "1.0.0"));
  });
});

describe("parseArgs", () => {
  test("多个 --instance 累加", () => {
    const a = parseArgs(["--run-id", "r1", "--instance", "x", "--instance", "y"]);
    expect(a.runId).toBe("r1");
    expect(a.instances).toEqual(["x", "y"]);
  });

  test("默认值：max-turns 40 / timeout 1800 / 非 dry-run", () => {
    const a = parseArgs([]);
    expect(a.maxTurns).toBe(40);
    expect(a.timeoutSec).toBe(1800);
    expect(a.dryRun).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 判分映射（§4.6）—— 本文件最重要的一组
// ─────────────────────────────────────────────────────────────────────────────

describe("mapOutcomes：六类结果，ungraded 单独成类", () => {
  const submitted = ["s1", "s2", "s3", "s4", "s5"];
  const report: OfficialReport = {
    resolved_ids: ["s1"],
    unresolved_ids: ["s2", "s4"],
    error_ids: ["s3"],
    empty_patch_ids: ["s4"],
  };

  test("solved / wrong_patch / grader_error / no_patch 各归各位", () => {
    const got = mapOutcomes(report, submitted);
    expect(got.s1).toBe("solved");
    expect(got.s2).toBe("wrong_patch");
    expect(got.s3).toBe("grader_error");
    expect(got.s4).toBe("no_patch");
  });

  /**
   * ⚠️ 本文件的头号不变量。s5 我们提交了，但 report 的**任何列表里都没有它** ——
   * 它的真实状态是**未知**，不是「未解出」。折叠成 unresolved 就是
   * 「我们的数据错」伪装成「模型能力差」。实测手挑 subset 里 3 条 id 不存在，
   * 那 30% 会静默变成未解出。
   */
  test("report 没提到的实例 → ungraded，不折叠成未解出", () => {
    expect(mapOutcomes(report, submitted).s5).toBe("ungraded");
  });

  /**
   * 顺序不变量：一个实例可以**同时**出现在 unresolved_ids 与 error_ids
   * （§4.6：`0 failed` 与 `errors: 1` 可同时成立）。先判 unresolved
   * 会把一次 grader 崩溃记成「模型改错了」—— 归因错了，而且看不出来。
   */
  test("同时在 unresolved 与 error 里 → 判 grader_error（不是 wrong_patch）", () => {
    const r: OfficialReport = { unresolved_ids: ["x"], error_ids: ["x"] };
    expect(mapOutcomes(r, ["x"]).x).toBe("grader_error");
  });

  test("变异自证：先判 unresolved 的实现会把 grader 崩溃记成模型改错", () => {
    const naive = (r: OfficialReport, ids: string[]) =>
      Object.fromEntries(
        ids.map((id) => [
          id,
          r.resolved_ids?.includes(id)
            ? "solved"
            : r.unresolved_ids?.includes(id)
              ? "wrong_patch"
              : r.error_ids?.includes(id)
                ? "grader_error"
                : "ungraded",
        ]),
      );
    const r: OfficialReport = { unresolved_ids: ["x"], error_ids: ["x"] };
    expect(naive(r, ["x"]).x).toBe("wrong_patch"); // 归因错了
    expect(mapOutcomes(r, ["x"]).x).toBe("grader_error"); // 归因对了
  });
});

describe("buildAcceptance：§6 五个验收字段", () => {
  const base = {
    runId: "t1",
    promptVersion: "prompt-v1",
    submitted: ["a", "b"],
    patchBytesById: { a: 100, b: 200 },
    touchesTestsIds: [] as string[],
    goldOk: true,
    wallMs: 1234,
    expectedTotal: 2,
    model: "claude-sonnet-5-ppchat",
    gatewayHost: "code.ppchat.vip",
    // 被测代码身份 + 必控变量：一份"干净的 run"必须记全这些，
    // 所以基线 fixture 也得带上 —— 否则下面几条断言 unaccounted 为 null 的
    // 用例其实在测"缺字段时的样子"，而它们的名字写的是"全解出/跑满"。
    sidCodeVersion: "0.1.601",
    // ⚠️ 产物身份（artifact_*）与宿主状态（git_*）是**两组不同的事实**：
    // 产物可能是几天前编的，`gitCommit` 记的只是跑评测时宿主的 HEAD。
    // 一份"干净的 run"现在必须记全产物那一组 —— 否则 unaccounted 会点破
    // 「只有 host_head_commit，而那不是产物编自哪个 commit」。
    // 这里让两者**相等**（就是在当前 HEAD 上编的包），因为这条 fixture 描述的
    // 正是"最干净的那种 run"。两者不等的情形由 artifact-identity.test.ts 覆盖。
    artifactCommit: "b19927eb00000000000000000000000000000000",
    artifactBranch: "main",
    artifactDirty: false,
    artifactOrigin: "release",
    artifactIdentitySource: "embedded",
    artifactGateVerdict: "ok",
    gateBypassed: [] as string[],
    hostHeadCommit: "b19927eb00000000000000000000000000000000",
    gitCommit: "b19927eb00000000000000000000000000000000",
    gitDirty: false,
    artifactSha256: "a".repeat(64),
    effortLevel: "max",
    costLimitUsd: 0,
  };

  test("全解出：link_ok / graded_ok / gold_ok 三个二值都真", () => {
    const a = buildAcceptance({
      ...base,
      report: { resolved_ids: ["a", "b"] },
    });
    expect(a.link_ok).toBe(true);
    expect(a.graded_ok).toBe(true);
    expect(a.gold_ok).toBe(true);
    expect(a.solved_count).toBe(2);
    expect(a.total_count).toBe(2);
    expect(a.unaccounted).toBeNull();
  });

  test("有空 patch → link_ok 假", () => {
    const a = buildAcceptance({
      ...base,
      patchBytesById: { a: 100, b: 0 },
      report: { resolved_ids: ["a"], unresolved_ids: ["b"] },
    });
    expect(a.link_ok).toBe(false);
  });

  /**
   * link_ok 的**口径**测试（2026-08-25 补，对应 ZZZ.5 第 2 条）。
   *
   * 它是「单次跑完的成功率」，**不合并复跑**。实测背景：smoke-2 有两条零 patch
   * 让 link_ok=FAIL，各自复跑一次都产出了 patch —— 所以那次 FAIL 是偶发故障。
   *
   * ⛔ 这条测试防的是「为了让 link_ok 变绿而在这里合并复跑结果」：
   * 那会让一条「跑三次才成一次」的链路显示 PASS，而链路不稳正是阶段 A 要发现的。
   */
  test("link_ok 是单次口径：只看本次 patch 字节，不因'复跑能成'而转真", () => {
    const a = buildAcceptance({
      ...base,
      patchBytesById: { a: 100, b: 0 }, // b 本次零 patch（复跑能成也不算）
      report: { resolved_ids: ["a"], unresolved_ids: ["b"] },
    });
    expect(a.link_ok).toBe(false);
    // 反向断言：本次两条都有 patch 才为真（防「恒 false」式误改）
    expect(buildAcceptance({ ...base, report: { resolved_ids: ["a", "b"] } }).link_ok).toBe(true);
  });

  test("link_ok=FAIL 时报告必须点破'单次'与'不等于做不出来'", () => {
    const md = renderReport(
      buildAcceptance({
        ...base,
        patchBytesById: { a: 100, b: 0 },
        report: { resolved_ids: ["a"], unresolved_ids: ["b"] },
      }),
    );
    expect(md).toContain("单次");
    expect(md).toContain("不合并复跑");
    // 关键的那句免责：FAIL ≠ 能力不足
    expect(md).toContain("不等于 agent 做不出来");
    // 变异自证：PASS 时不该出现那段免责（否则这条断言恒真）
    const okMd = renderReport(buildAcceptance({ ...base, report: { resolved_ids: ["a", "b"] } }));
    expect(okMd).not.toContain("不等于 agent 做不出来");
    // 但「单次」口径的标注在两种情况下都要在
    expect(okMd).toContain("单次");
  });

  /**
   * ⚠️ 最关键的一条：report 读不回来时**不许**产出「solved_count: 0 + 一切正常」。
   * 那正是被否决的路径 A 那个 `Score(value=0)` 的同型 ——
   * 它长得和一个真实的 0 分完全一样，但含义是「仪器没接上」。
   */
  test("report 为 null → graded_ok 假、全部 ungraded、unaccounted 必须写明", () => {
    const a = buildAcceptance({ ...base, report: null });
    expect(a.graded_ok).toBe(false);
    expect(Object.values(a.outcomes)).toEqual(["ungraded", "ungraded"]);
    expect(a.solved_count).toBe(0);
    expect(a.unaccounted).toBeTruthy();
    expect(a.unaccounted).toContain("判分没发生");
  });

  test("有 ungraded → graded_ok 假，且 unaccounted 列出是哪几条", () => {
    const a = buildAcceptance({
      ...base,
      submitted: ["a", "b", "c"],
      patchBytesById: { a: 1, b: 1, c: 1 },
      expectedTotal: 3,
      report: { resolved_ids: ["a"], unresolved_ids: ["b"] },
    });
    expect(a.graded_ok).toBe(false);
    expect(a.outcomes.c).toBe("ungraded");
    expect(a.unaccounted).toContain("c");
  });

  test("只跑了部分 → partial 真，且 unaccounted 点明分母", () => {
    const a = buildAcceptance({
      ...base,
      submitted: ["a"],
      patchBytesById: { a: 1 },
      expectedTotal: 10,
      report: { resolved_ids: ["a"] },
    });
    expect(a.partial).toBe(true);
    expect(a.unaccounted).toContain("1/10");
  });

  test("meter 固定 null（D4：无中立计价源）", () => {
    const a = buildAcceptance({ ...base, report: { resolved_ids: [] } });
    expect(a.meter).toBeNull();
    expect(a.meter_note).toBe(METER_NOTE);
  });

  test("patch_touches_tests 是计数，不影响 solved_count（单独列出而非静默扣掉）", () => {
    const a = buildAcceptance({
      ...base,
      touchesTestsIds: ["a"],
      report: { resolved_ids: ["a", "b"] },
    });
    expect(a.patch_touches_tests).toBe(1);
    expect(a.solved_count).toBe(2); // 不因触及测试而被静默扣掉
  });

  /**
   * 模型名是**可比性的前提**：换了模型的两次 run 的 solved_count 之间没有可比性，
   * 而分数本身看不出这件事。所以缺 model 时必须在 unaccounted 里点破 ——
   * 只把字段记成 null 不够，读报告的人会自动把 null 读成「默认那个模型」。
   */
  test("model 缺失 → 字段为 null 且 unaccounted 点明不可并排比较", () => {
    const { model: _m, gatewayHost: _g, ...noModel } = base;
    const a = buildAcceptance({ ...noModel, report: { resolved_ids: ["a", "b"] } });
    expect(a.model).toBeNull();
    expect(a.gateway_host).toBeNull();
    expect(a.unaccounted).toContain("不能与其他 run 并排比较");
    // 变异自证：**有** model 时这句话不该出现，否则这条断言是恒真的
    const withModel = buildAcceptance({ ...base, report: { resolved_ids: ["a", "b"] } });
    expect(withModel.unaccounted).toBeNull();
  });

  /**
   * ## 被测代码身份：为什么判据是 git_commit 而不是 sid_code_version
   *
   * 实测（2026-08-26）：`package.json` 停在 `0.1.601`，而 tag `v0.1.601` 打在
   * 8月21 的提交上；此后合入的 429 重试修复、权限修复**都不在那个 tag 里**
   * （`git merge-base --is-ancestor <fix> v0.1.601` 失败）。
   * 也就是说**同一个版本号对应过多个 commit** —— 只记 version 等于没记。
   *
   * 配套的失败形态：`make build` 不 bump 版本号，所以
   * `artifact_for()` 会静默复用 `dist/release/<ver>/` 下那份 8月21 的产物 ——
   * 「跑评测验证本轮修复」跑成「跑 5 天前的代码」，而分数、日志、version 全正常。
   */
  test("commit 全缺 → 点破「不知道跑的是哪份代码」；有 version 也不算", () => {
    // ⚠️ 判据是「两个 commit 都没有」。只缺 artifact_commit（旧 run 的形态）
    // 有单独一条更精确的 note，见下一条测试与 artifact-identity.test.ts。
    const { gitCommit: _c, artifactCommit: _a, hostHeadCommit: _h, ...noCommit } = base;
    const a = buildAcceptance({ ...noCommit, report: { resolved_ids: ["a", "b"] } });
    expect(a.git_commit).toBeNull();
    expect(a.artifact_commit).toBeNull();
    // ⚠️ 关键：version 还在（"0.1.601"），但仍然要报缺 —— 版本号顶不了 commit
    expect(a.sid_code_version).toBe("0.1.601");
    expect(a.unaccounted).toContain("未记录产物 commit");
    // 变异自证：有 commit 时这句不该出现
    const withCommit = buildAcceptance({ ...base, report: { resolved_ids: ["a", "b"] } });
    expect(withCommit.unaccounted).toBeNull();
  });

  test("产物编自脏工作区 → 点破「只可自比不可外比」", () => {
    // ⚠️ 判据从 gitDirty 换成了 artifactDirty：宿主此刻脏**不说明产物有问题**
    // （产物的 dirty 编在它自己的字节里）。一个从干净 commit 编出的好产物，
    // 不该因为宿主有未提交改动而被打上"只可自比"的标签。
    const a = buildAcceptance({
      ...base,
      artifactDirty: true,
      report: { resolved_ids: ["a", "b"] },
    });
    expect(a.artifact_dirty).toBe(true);
    expect(a.unaccounted).toContain("只可自比");
    // 变异自证：干净时不报
    expect(
      buildAcceptance({ ...base, report: { resolved_ids: ["a", "b"] } }).unaccounted,
    ).toBeNull();
  });

  test("git_dirty 缺省是 null（不知道），不是 false（断言干净）", () => {
    // 旧 run 没这个字段时是"不知道脏不脏"。记成 false 就是替它断言"干净"——
    // 那正是这个字段要防的事。所以 grade.ts 里必须是 `?? null` 不是 `?? false`。
    const { gitDirty: _d, ...noDirty } = base;
    const a = buildAcceptance({ ...noDirty, report: { resolved_ids: ["a", "b"] } });
    expect(a.git_dirty).toBeNull();
    // null 不该触发 dirty 那条 note（它只在确认脏时报）
    expect(a.unaccounted).toBeNull();
  });

  test("成本闸门 > 0 → 点破「零 patch 的归因需先排除它」", () => {
    // loop.ts 在 quota exceeded 处 `yield done; return` —— **整轮静默结束**，
    // 被记成 no_patch，读起来像能力问题。团队默认模板的值正是 100。
    const a = buildAcceptance({
      ...base,
      costLimitUsd: 100,
      report: { resolved_ids: ["a", "b"] },
    });
    expect(a.cost_limit_usd).toBe(100);
    expect(a.unaccounted).toContain("成本闸门开启");
    // 变异自证：0（不限）时不报 —— 否则这条断言对任何取值都成立
    expect(
      buildAcceptance({ ...base, report: { resolved_ids: ["a", "b"] } }).unaccounted,
    ).toBeNull();
  });

  test("effort_level 缺失 → 点破它是必控变量", () => {
    const { effortLevel: _e, ...noEffort } = base;
    const a = buildAcceptance({ ...noEffort, report: { resolved_ids: ["a", "b"] } });
    expect(a.effort_level).toBeNull();
    expect(a.unaccounted).toContain("effort_level");
  });

  /**
   * 并发跑的 run 与串行 run **不可并排** —— 而这在分数上完全看不出来。
   *
   * 成因：并发下多个容器争 docker daemon、宿主 CPU、同一份网关配额，
   * 每条实例的 agent_ms 都被别的实例拖长；限流概率也随请求速率抬升
   * （ZZZZZ 那个 P0 就是一次 429 终止整轮）。
   *
   * ⚠️ 与判分并发（`SWE_GRADE_JOBS`）区分开：判分不碰网关、是纯函数
   * （同一份 predictions 判两次结论必须一样），所以它不影响可比性、不记这里。
   */
  test("jobs > 1 → 点破「不可与串行 run 并排」", () => {
    const a = buildAcceptance({ ...base, jobs: 4, report: { resolved_ids: ["a", "b"] } });
    expect(a.jobs).toBe(4);
    expect(a.unaccounted).toContain("不可与串行 run 并排");
    // 渲染里也要带警告（JSON 字段没人逐个读，报告正文才是入口）
    expect(renderReport(a)).toContain("不可与串行 run 并排");
  });

  test("jobs === 1（串行）不报警告 —— 否则这条断言恒真", () => {
    const a = buildAcceptance({ ...base, jobs: 1, report: { resolved_ids: ["a", "b"] } });
    expect(a.jobs).toBe(1);
    expect(a.unaccounted).toBeNull();
  });

  test("jobs 缺失 → null（旧 run），不报警告也不假设是 1", () => {
    // 记成 1 就是替旧 run 断言"它是串行跑的"，而那件事无从确认。
    const a = buildAcceptance({ ...base, report: { resolved_ids: ["a", "b"] } });
    expect(a.jobs).toBeNull();
    expect(a.unaccounted).toBeNull();
  });

  test("model / gateway_host 原样进 Acceptance，且渲染进报告", () => {
    const a = buildAcceptance({ ...base, report: { resolved_ids: ["a", "b"] } });
    expect(a.model).toBe("claude-sonnet-5-ppchat");
    expect(a.gateway_host).toBe("code.ppchat.vip");
    const md = renderReport(a);
    expect(md).toContain("claude-sonnet-5-ppchat");
    expect(md).toContain("code.ppchat.vip");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// readGoldOk：三态判据（未跑 / 通过 / 失败）
// ─────────────────────────────────────────────────────────────────────────────

describe("readGoldOk：gold 自检的三态", () => {
  /**
   * ⚠️ 三态而不是二值，是因为「没跑 gold」与「跑了但失败」的处置完全不同：
   *   - null（未跑）→ 这一轮没有环境背书，分数要打折看，但没有具体故障要查；
   *   - false（失败）→ **停下来查环境**，此时任何 solved_count 都不可信；
   *   - true（通过）→ 环境可信，剩下的差异才可以归因到能力。
   * 把 null 折叠成 false 会让人去查一个没发生的失败；
   * 折叠成 true 更糟 —— 那等于放弃「环境错 vs 能力差」这个区分本身。
   */
  const mkdirTmp = () => {
    const d = join(tmpdir(), `gold-test-${Math.random().toString(36).slice(2)}`);
    mkdirSync(d, { recursive: true });
    return d;
  };
  const writeRep = (dir: string, name: string, rep: OfficialReport) =>
    writeFileSync(join(dir, name), JSON.stringify(rep));

  test("目录不存在 → null（未跑），不是 false", () => {
    expect(readGoldOk(join(tmpdir(), "definitely-not-here-xyz"), ["a"])).toBeNull();
  });

  test("目录空 → null", () => {
    expect(readGoldOk(mkdirTmp(), ["a"])).toBeNull();
  });

  test("submitted 全部跑过且全 resolved → true", () => {
    const d = mkdirTmp();
    writeRep(d, "gold.a.json", { submitted_ids: ["a"], resolved_ids: ["a"] });
    writeRep(d, "gold.b.json", { submitted_ids: ["b"], resolved_ids: ["b"] });
    expect(readGoldOk(d, ["a", "b"])).toBe(true);
  });

  test("有一条没跑过 gold → null（未跑），**不是 false**", () => {
    const d = mkdirTmp();
    writeRep(d, "gold.a.json", { submitted_ids: ["a"], resolved_ids: ["a"] });
    // b 压根没有 gold 记录
    expect(readGoldOk(d, ["a", "b"])).toBeNull();
  });

  test("全跑过但有一条没 resolved → false（环境有问题，要停下来查）", () => {
    const d = mkdirTmp();
    writeRep(d, "gold.a.json", { submitted_ids: ["a"], resolved_ids: ["a"] });
    writeRep(d, "gold.b.json", { submitted_ids: ["b"], resolved_ids: [], unresolved_ids: ["b"] });
    expect(readGoldOk(d, ["a", "b"])).toBe(false);
  });

  test("坏 json 被跳过，不让一个坏文件把整个判据变成 false", () => {
    const d = mkdirTmp();
    writeFileSync(join(d, "broken.json"), "{ not json");
    writeRep(d, "gold.a.json", { submitted_ids: ["a"], resolved_ids: ["a"] });
    expect(readGoldOk(d, ["a"])).toBe(true);
  });

  test("submitted 为空 → null（没有可判的对象）", () => {
    const d = mkdirTmp();
    writeRep(d, "gold.a.json", { submitted_ids: ["a"], resolved_ids: ["a"] });
    expect(readGoldOk(d, [])).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// normalizePatch：末尾必须恰好一个换行（GNU patch 的硬要求）
// ─────────────────────────────────────────────────────────────────────────────

describe("normalizePatch：patch 末尾换行", () => {
  /**
   * 实测背景（2026-08-25 的 10 题跑分）：原来是 `diff.trimEnd()`，
   * 容器里的 GNU patch 2.7.6 因此报
   * `patch unexpectedly ends in middle of line` / `malformed patch` / exit=2，
   * 补一个 `\n` 就 exit=0 —— 差别一个字节。
   *
   * ⚠️ 这个 bug 在 macOS 上跑不出来（BSD patch 容忍缺尾换行），
   * 所以这里断言的是**字节形态**，不去跑 patch 命令 ——
   * 跑命令的话这条测试在 mac 上会假绿。
   */
  test("缺尾换行 → 补上恰好一个", () => {
    const d = "diff --git a/x b/x\n@@ -0,0 +1 @@\n+x = 1";
    expect(normalizePatch(d).endsWith("\n")).toBe(true);
    expect(normalizePatch(d)).toBe(d + "\n");
  });

  test("多余的**换行** → 收敛成恰好一个", () => {
    const core = "diff --git a/x b/x\n@@ -0,0 +1 @@\n+x = 1";
    for (const tail of ["\n", "\n\n\n", "\n\n\n\n\n"]) {
      expect(normalizePatch(core + tail)).toBe(core + "\n");
    }
  });

  /**
   * ⛔ 这一组是**第二次修**（2026-08-25）加的，它推翻了第一版的一条断言。
   *
   * 第一版写 `trimEnd()`，于是这条测试原本断言
   * `core + "\n  \n\t"` 和 `core + "   "` 都收敛成 `core + "\n"` ——
   * **那个断言本身是错的，它把 bug 固化成了"正确行为"**。
   *
   * 在 unified diff 里 `" "` 开头的行是**合法上下文行**，
   * 一个仅含单空格的行就是「上下文里的空行」。剥掉它 → hunk body 比
   * `@@ -a,b +c,d @@` 声明的行数少 → patch 自相矛盾 →
   * `git apply` 报 `corrupt patch`（实测 exit=128）。
   *
   * 容器内三格变异自证（同一份 astropy-12907 patch、同一个官方镜像）：
   *   trimEnd()            → exit=128 corrupt patch at line 12
   *   trimEnd() + 补 \n    → exit=128 corrupt patch at line 13   ← 第一版"修复"没修好
   *   只规范换行（现在）    → exit=0   Applied patch ... cleanly
   *
   * 所以不变量是「**除末尾换行之外逐字不变**」，而不是「末尾清干净」。
   */
  test("末尾的空上下文行（单空格行）不许被吃掉 —— 吃掉就 corrupt patch", () => {
    // 真实形态：hunk 声明 7 行上下文，最后一行是内容仅一个空格的上下文行
    const d =
      "diff --git a/x.py b/x.py\n" +
      "--- a/x.py\n+++ b/x.py\n" +
      "@@ -1,3 +1,3 @@\n" +
      " a\n-b\n+c\n \n";
    const out = normalizePatch(d);
    expect(out).toBe(d); // 逐字不变（本来就是恰好一个尾换行）
    // 关键断言：末尾那个 " " 上下文行还在
    expect(out.split("\n").at(-2)).toBe(" ");
    // 行数不变 —— 少一行就是 hunk 与 header 对不上
    expect(out.split("\n").length).toBe(d.split("\n").length);
  });

  test("末尾非换行空白（空格/tab）不许剥 —— 它可能是上下文行的内容", () => {
    const core = "diff --git a/x b/x\n@@ -1,2 +1,2 @@\n-a\n+b\n";
    // "\n  \n\t" 这种尾巴里，" " / "\t" 都可能是合法上下文行的行内内容
    expect(normalizePatch(core + "  ")).toBe(core + "  \n");
    expect(normalizePatch(core + " \n")).toBe(core + " \n");
    expect(normalizePatch(core + " \n\n\n")).toBe(core + " \n");
    // 反向断言（防「改成什么都不做也能过」）：多余换行仍然被收敛
    expect(normalizePatch(core + "\n\n\n")).toBe(core);
  });

  /**
   * 不变量的机械表述，直接锁住"只许动换行"这件事：
   * 输出去掉尾部换行后，必须与输入去掉尾部换行后**逐字相同**。
   */
  test("不变量：除尾部换行外，输出与输入逐字相同", () => {
    const samples = [
      "diff --git a/x b/x\n@@ -1,3 +1,3 @@\n a\n-b\n+c\n \n",
      "diff --git a/x b/x\n@@ -0,0 +1 @@\n+x = 1",
      "diff --git a/x b/x\n@@ -1,2 +1,2 @@\n-a\n+b\n\t\n\n",
      "diff --git a/x b/x\n@@ -0,0 +1 @@\n+x\n\\ No newline at end of file\n",
    ];
    for (const s of samples) {
      const strip = (v: string) => v.replace(/\n+$/, "");
      expect(strip(normalizePatch(s))).toBe(strip(s));
    }
  });

  /**
   * 变异自证的关键一条：空 diff **不许**变成 "\n"。
   * 变了的话 `patchBytes` 从 0 变 1，`deriveOutcome` 会把一个
   * 真实的 no_patch 误判成「产出了 patch」—— 那正是本轮踩的那类
   * 「环境/工具故障伪装成有结果」。
   */
  test("空 diff 保持空（否则 patchBytes 0→1，no_patch 被误判成有 patch）", () => {
    expect(normalizePatch("")).toBe("");
    expect(normalizePatch("   \n\n")).toBe("");
    expect(normalizePatch("").length).toBe(0);
    // 串到 deriveOutcome 上确认这个不变量真的守住了
    expect(
      deriveOutcome({ agentExit: 0, patchBytes: normalizePatch("").length, timedOut: false }),
    ).toBe("no_patch");
  });

  test("已经正好一个换行 → 幂等", () => {
    const d = "diff --git a/x b/x\n@@ -0,0 +1 @@\n+x = 1\n";
    expect(normalizePatch(d)).toBe(d);
    expect(normalizePatch(normalizePatch(d))).toBe(d);
  });

  test("`\\ No newline at end of file` 标记不被吃掉（它是 diff 语义的一部分）", () => {
    const d = "diff --git a/x b/x\n@@ -0,0 +1 @@\n+x = 1\n\\ No newline at end of file\n";
    const out = normalizePatch(d);
    expect(out).toContain("No newline at end of file");
    expect(out.endsWith("\n")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// expectedTotal / partial：分母不许静默说谎
// ─────────────────────────────────────────────────────────────────────────────

describe("partial 的分母口径", () => {
  const base = {
    runId: "t1",
    promptVersion: "prompt-v1",
    touchesTestsIds: [] as string[],
    goldOk: true,
    wallMs: 1,
    model: "m",
    gatewayHost: "h",
    // 见上一个 describe 的同款注释：这些 fixture 要代表"干净的 run"，
    // 否则测 partial 的用例会顺带被身份字段缺失的 note 干扰。
    // 产物身份那一组也要给全（与 host 相等 = 就在当前 HEAD 上编的包）。
    artifactCommit: "c".repeat(40),
    artifactDirty: false,
    artifactIdentitySource: "embedded",
    artifactGateVerdict: "ok",
    hostHeadCommit: "c".repeat(40),
    gitCommit: "c".repeat(40),
    gitDirty: false,
    effortLevel: "max",
    costLimitUsd: 0,
  };

  /**
   * expectedTotal 曾是 grade.ts 里硬编码的 10。硬编码的两个失败方向都会说谎：
   *   - subset 缩到 5：5 条全跑完仍判 partial=true（「只跑了 5/10」）——
   *     一个跑满的 run 被记成跑了一半；
   *   - subset 扩到 15：跑 10 条判 partial=false —— **更坏**，
   *     一个只覆盖三分之二的 run 被记成全量。
   */
  test("跑满 subset → partial 假", () => {
    const a = buildAcceptance({
      ...base,
      submitted: ["a", "b", "c"],
      patchBytesById: { a: 1, b: 1, c: 1 },
      expectedTotal: 3,
      report: { resolved_ids: ["a", "b", "c"] },
    });
    expect(a.partial).toBe(false);
    expect(a.unaccounted).toBeNull();
  });

  test("subset 扩大后只跑一部分 → partial 真（不因分母变大而看起来跑满）", () => {
    const a = buildAcceptance({
      ...base,
      submitted: ["a", "b", "c"],
      patchBytesById: { a: 1, b: 1, c: 1 },
      expectedTotal: 15,
      report: { resolved_ids: ["a", "b", "c"] },
    });
    expect(a.partial).toBe(true);
    expect(a.unaccounted).toContain("3/15");
  });

  /**
   * subset 读失败时 expectedTotal 退化成 submitted.length，于是 partial **恒为 false**。
   * 这一步本身没错（没有别的分母可用），但必须点破 ——
   * 否则「读不到 subset」这个事实会被一个绿色的 partial=false 吞掉。
   */
  test("subsetReadFailed → partial 恒假，但 unaccounted 必须点破", () => {
    const a = buildAcceptance({
      ...base,
      submitted: ["a"],
      patchBytesById: { a: 1 },
      expectedTotal: 1, // 退化后的值
      subsetReadFailed: true,
      report: { resolved_ids: ["a"] },
    });
    expect(a.partial).toBe(false);
    expect(a.unaccounted).toContain("读不到 verified-subset.yaml");
    // 变异自证：不置 subsetReadFailed 时这句话不该出现
    const clean = buildAcceptance({
      ...base,
      submitted: ["a"],
      patchBytesById: { a: 1 },
      expectedTotal: 1,
      report: { resolved_ids: ["a"] },
    });
    expect(clean.unaccounted).toBeNull();
  });

  test("parseSubset 现取的条数就是真实 subset 大小（与 grade.ts 用的同一函数）", () => {
    const n = parseSubset(readFileSync(join(SWE_DIR, "verified-subset.yaml"), "utf8")).length;
    expect(n).toBe(10); // §4.1：阶段 A 就是 10 条
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 报告不含百分比（§6 硬约束）
// ─────────────────────────────────────────────────────────────────────────────

describe("§6：报告不许含百分比", () => {
  const a = buildAcceptance({
    runId: "t1",
    promptVersion: "prompt-v1",
    submitted: ["a", "b", "c"],
    patchBytesById: { a: 1, b: 1, c: 1 },
    touchesTestsIds: [],
    goldOk: true,
    wallMs: 1,
    expectedTotal: 3,
    report: { resolved_ids: ["a", "b"] },
  });

  /**
   * 约束落在**类型与渲染**两层，不落在「大家别算百分比」这句话上。
   * D2：n=10 时 SE=14.5pp、95% CI 半宽 ±28pp，「60% 与 70% 统计上无法区分」。
   * 没有那个字段，就没人能把 10 题的比例画成 release 曲线。
   */
  test("Acceptance 对象里没有任何百分比/比率类字段名", () => {
    const keys = Object.keys(a);
    for (const k of keys) {
      expect(k).not.toMatch(/percent|pct|ratio|rate|score(?!s)|accuracy/i);
    }
  });

  test("渲染出的 markdown 里不出现 % 号", () => {
    const md = renderReport(a);
    // 说明性文字里引用统计量（SE=14.5pp / ±28pp）用 pp，不用 %
    expect(md).not.toMatch(/\d+(\.\d+)?%/);
  });

  test("渲染包含五个验收字段与三个诚实字段", () => {
    const md = renderReport(a);
    for (const f of [
      "link_ok",
      "graded_ok",
      "gold_ok",
      "solved_count",
      "patch_touches_tests",
      "wall_ms",
      "meter",
      "unaccounted",
    ]) {
      expect(md).toContain(f);
    }
    expect(md).toContain("2 / 3"); // 绝对数带分母
  });
});

describe("findReport：找不到必须返回 null", () => {
  test("目录不存在 → null（不是空对象）", () => {
    expect(findReport("/tmp/definitely-not-here-swe-xyz", "r1")).toBeNull();
  });

  /**
   * 变异自证：返回 `{}` 的实现会让下游把「没判分」算成「全 0」——
   * `buildAcceptance` 收到非 null 就认为判分发生了，于是 graded_ok
   * 只看 ungraded 数量，而空 report 下所有条目恰好都是 ungraded……
   * 关键差别在 unaccounted 那句「判分没发生」会不会写出来。
   */
  test("返回 {} 与返回 null 在验收字段上必须可区分", () => {
    const common = {
      runId: "t",
      promptVersion: "prompt-v1",
      submitted: ["a"],
      patchBytesById: { a: 1 },
      touchesTestsIds: [],
      goldOk: null,
      wallMs: 0,
      expectedTotal: 1,
    };
    const asNull = buildAcceptance({ ...common, report: null });
    const asEmpty = buildAcceptance({ ...common, report: {} });
    expect(asNull.unaccounted).toContain("判分没发生");
    expect(asEmpty.unaccounted).not.toContain("判分没发生");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 数据隔离（§3）—— 静态扫描
// ─────────────────────────────────────────────────────────────────────────────

describe("§3 数据隔离：答案不许流入本仓", () => {
  const files = [
    "verified-subset.yaml",
    "prompt-v1.txt",
    "runner.ts",
    "grade.ts",
    "record.ts",
    "fetch-instance.py",
    "exec-swebench.sh",
  ];

  /**
   * 全量扫一遍：**任何 PR4 文件里都不许出现 diff 正文**。
   *
   * 这条拦的是「调试时把某条实例的 gold patch 贴进注释/夹具里」——
   * 一旦进了仓库，它就在 agent 能读到的工作树里，而 §4.1 ③ 那条断言
   * （镜像内没有上游 fix commit）拦的是镜像，拦不住我们自己的仓库。
   */
  test("所有 PR4 文件里都没有 diff 正文（gold patch 不许被贴进来）", () => {
    for (const f of files) {
      const raw = readFileSync(join(SWE_DIR, f), "utf8");
      // `diff --git a/… b/…` 是 patch 正文的特征头
      expect(raw).not.toMatch(/^diff --git a\/\S+ b\/\S+$/m);
      // unified diff 的 hunk 头
      expect(raw).not.toMatch(/^@@ -\d+,?\d* \+\d+,?\d* @@/m);
    }
  });

  /**
   * 答案字段（patch / FAIL_TO_PASS / PASS_TO_PASS / test_patch）的**内容**
   * 不许出现在这些文件里。这里能出现的只有「字段名本身」——
   * 且只允许出现在「说明为什么不取它」的注释/白名单里。
   */
  test("verified-subset.yaml 里没有答案字段的键", () => {
    const raw = readFileSync(join(SWE_DIR, "verified-subset.yaml"), "utf8");
    // 排除注释行后再查
    const body = raw
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("#"))
      .join("\n");
    for (const k of ["FAIL_TO_PASS", "PASS_TO_PASS", "test_patch", "problem_statement:"]) {
      expect(body).not.toContain(k);
    }
    expect(body).not.toMatch(/^\s*patch:/m);
  });

  /**
   * fetch-instance.py 的白名单必须是**白名单**（默认不输出）。
   * 黑名单的默认行为是输出 —— 上游加一个 `solution_hint` 之类的字段，
   * 我们会在毫无察觉的情况下把它喂给 agent。
   */
  test("fetch-instance.py 用白名单，且白名单里没有答案字段", () => {
    const src = readFileSync(join(SWE_DIR, "fetch-instance.py"), "utf8");
    const m = src.match(/SAFE_FIELDS\s*=\s*\(([\s\S]*?)\)/);
    expect(m).toBeTruthy();
    const list = m![1];
    for (const k of ["patch", "FAIL_TO_PASS", "PASS_TO_PASS", "test_patch"]) {
      expect(list).not.toContain(k);
    }
    expect(list).toContain("problem_statement");
    expect(list).toContain("base_commit");
  });

  /** 报告要落 evals/_reports/external/，不进 evals/_scores/ */
  test("grade.ts 写 _reports/external，不碰 _scores", () => {
    const src = readFileSync(join(SWE_DIR, "grade.ts"), "utf8");
    expect(src).toContain("evals/_reports/external");
    // ⚠️ 必须剥掉**块注释整体**，不能只按行首 `*` / `//` 过滤 ——
    // 注释里正当地写着「不碰 `evals/_scores/`」这句说明，
    // 而 `/** … */` 单行块的首字符是 `/` 不是 `*`，按行首过滤会漏掉它，
    // 于是这条断言会因为一句注释而红。实测踩过一次。
    const body = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    // ⚠️ 查的是**路径** `evals/_scores`，不是裸串 `_scores` ——
    // 后者会被 `baseline_scores`（正文里那句「不写 baseline_scores」）命中，
    // 于是一条正确的隔离声明反而让隔离断言变红。实测踩过一次。
    expect(body).not.toMatch(/evals\/_scores|_scores\//);
  });

  test("model_name_or_path 固定 sid-code（官方三字段口径）", () => {
    expect(MODEL_NAME).toBe("sid-code");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// exec-swebench.sh 的形态断言
// ─────────────────────────────────────────────────────────────────────────────

describe("exec-swebench.sh：三条实测约束不许回退", () => {
  const sh = readFileSync(join(SWE_DIR, "exec-swebench.sh"), "utf8");

  /**
   * `--no-session-persistence` 在编译产物里**报未知选项**（bun parseArgs
   * 不收 `no-` 前缀声明名）。加回去 = 每条实例第一步就挂，
   * 而 grep 源码 / `--help` 都看不出来（它在源码里是声明着的）。
   */
  test("不许出现 --no-session-persistence", () => {
    // 只查**可执行行**，注释里提它是允许的 —— 那正是记录"为什么不能加"的地方，
    // 而把知识写下来不该让门禁转红。与下面 `--namespace` 那条同款处理。
    const body = sh
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("#"))
      .join("\n");
    expect(body).not.toContain("--no-session-persistence");
  });

  test("必须激活 conda testbed（不激活 import 全挂）", () => {
    expect(sh).toContain("conda activate testbed");
    expect(sh).toContain("/opt/miniconda3/bin/activate");
  });

  test("必须写 settings.json（config.ts 的门禁：不写起不来）", () => {
    expect(sh).toContain("settings.json");
    expect(sh).toContain("SID_CONFIG_DIR");
  });

  /**
   * §6.2 / oh-my-pi：key 只走 exec env。进了 argv 就能被
   * `docker inspect` 读到，容器删了还留在 daemon 记录里。
   */
  test("API key 走 -e 注入，不出现在 sid-code 的命令行里", () => {
    expect(sh).toMatch(/-e "SC_API_KEY=\$SC_API_KEY"/);
    // sid-code 那行不许带 key
    const agentLine = sh.split("\n").find((l) => l.includes("/usr/local/bin/sid-code -p"));
    expect(agentLine).toBeTruthy();
    expect(agentLine!).not.toContain("SC_API_KEY");
    expect(agentLine!).not.toContain("api_key");
  });

  /** §5.1：没有代理 = agent 能读上游修复 = 分数不可信。必须硬失败 */
  test("取不到 allowlist 代理 IP 时必须 exit，不许降级继续跑", () => {
    expect(sh).toContain("net-setup.sh");
    const idx = sh.indexOf("取不到 allowlist 代理");
    expect(idx).toBeGreaterThan(0);
    expect(sh.slice(idx, idx + 400)).toContain("exit 1");
  });

  /** §4.6：退出码不可信，判据必须是摘要计数 */
  test("gold 自检按摘要计数判，不按退出码判", () => {
    expect(sh).toContain("Instances with errors:");
    expect(sh).toContain("Instances resolved:");
    expect(sh).toContain("退出码不可信");
  });

  /** 5.0.2 已删 --namespace，留着会直接报 No such option */
  test("不许再出现已被删除的 --namespace 选项", () => {
    const body = sh
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("#"))
      .join("\n");
    expect(body).not.toContain("--namespace");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// agent.log 机械信号（ZZZZ.11 P2）—— 把 no_patch 桶里的非能力原因标出来
// ═══════════════════════════════════════════════════════════════════════════
//
// 样本全部是 **smoke-8 真实 agent.log 的片段**（含 ANSI 色码剥离后的形态），
// 不是我照着实现编的字符串 —— 后者只能证明"函数按我写的方式工作"，
// 证明不了"它认得真实日志"。这个区别在本仓踩过：判据用文案匹配时，
// 唯一可信的样本来源是真实轨迹。
describe("extractAgentLogSignals", () => {
  // smoke-8 matplotlib-26466 的真实尾部（轮次撞顶）
  const HIT_MAX_TURNS = `
[07:33:38] ● [QUERY_LOOP] 工具调用: grep
[07:33:39] ● [QUERY_LOOP] P1-1：达到最大轮次 40，请求强制总结
[07:34:09] ⚠ [QUERY_LOOP] 达到最大轮次限制: 40
`;

  // smoke-8 xarray-6461 的真实尾部（429 未重试即终止）
  const LLM_FATAL_429 = `
[07:46:43] · [FALLBACK] 流式阶段尝试 1/11
[07:46:46] ⚠ [AUDIT:API] ✗ Anthropic 请求异常 model=claude-sonnet-5-ppchat err=429 {"error":{"message":"当前分组上游负载已饱和，请稍后再试","code":"rate_limited"}}
[07:46:46] ● [FALLBACK] 无交互通道，降级为自动切换默认 fallback
[07:46:46] ⚠ [FALLBACK] 用户/钩子选择不切换，终止本轮
[07:46:46] ✗ [ENGINE] queryLoop 异常，封装为 fatal_error: LLM 错误: 主模型请求失败，已终止本轮。
`;

  // smoke-8 matplotlib-20488 的真实权限拒绝片段
  const PERMISSION_DENIED = `
[07:10:46] ● [PERMISSION] write(/tmp/repro.py) → 需确认(路径验证: 写入路径在工作区外: /tmp/repro.py)
[07:10:46] ● [PERMISSION] write(/tmp/repro.py) → 拒绝(非交互模式)
[07:10:46] ⚠ [PERMISSION] 权限拒绝: write - 拒绝 — 非交互模式
[07:11:02] ● [PERMISSION] bash(cd /testbed && python3 -m pytest lib/matplotlib/tests/test_image.py) → 拒绝(非交互模式)
[07:11:02] ⚠ [PERMISSION] 权限拒绝: bash - 拒绝 — 非交互模式
`;

  test("轮次撞顶 → hitMaxTurns", () => {
    expect(extractAgentLogSignals(HIT_MAX_TURNS).hitMaxTurns).toBe(true);
    expect(extractAgentLogSignals(HIT_MAX_TURNS).llmFatal).toBe(false);
  });

  test("429 打断 → llmFatal", () => {
    const s = extractAgentLogSignals(LLM_FATAL_429);
    expect(s.llmFatal).toBe(true);
    expect(s.hitMaxTurns).toBe(false);
  });

  test("权限拒绝按次计数", () => {
    expect(extractAgentLogSignals(PERMISSION_DENIED).permissionDenials).toBe(2);
  });

  test("正常跑完的日志 → 三个信号全静默", () => {
    const clean = `
[06:22:51] ● [AUDIT:TOOL] ▶ bash id=toolu_01
[06:22:56] ● [AUDIT:TOOL] ✓ bash id=toolu_01
[06:23:10] ● [QUERY_LOOP] 轮次 12/40，消息数 23，上下文 3%
`;
    const s = extractAgentLogSignals(clean);
    expect(s.hitMaxTurns).toBe(false);
    expect(s.llmFatal).toBe(false);
    expect(s.permissionDenials).toBe(0);
  });

  test("空日志不抛、全静默（agent.log 缺失时的兜底路径）", () => {
    const s = extractAgentLogSignals("");
    expect(s.hitMaxTurns).toBe(false);
    expect(s.llmFatal).toBe(false);
    expect(s.permissionDenials).toBe(0);
  });

  // ── 关键负向断言：这条防的是我第一版差点犯的错 ──
  //
  // 若 llmFatal 的状态码判据写成 `/429|502|504/` 直接扫全文，会把
  // request-id 与 token 计数里的数字全扫进来。smoke-8 实测：10 条实例里
  // grep 到 "429" 的有 6 条，而**真实限流只有 2 次** —— 其余全是
  // `cacheCreationInputTokens: 12429` / `缓存命中下降 17% (3429 tokens)`
  // 这类巧合。误判的后果很具体：把一条**正常跑完**的实例标成"被限流打断"，
  // 于是"零 patch 里没有基础设施原因"这条收口判据永远过不了，
  // 而人会以为是网关在抖。
  test("token 计数/request-id 里的数字不许被当成状态码", () => {
    const decoys = `
[07:10:08] ⚠ [CACHE_BREAK] 缓存命中下降 17% (3429 tokens): 本地前缀 hash 未变（1180f65848e83719）
[07:24:11] ● [LLM] ← tool_use in=231 out=489 23.4s $1.1195
      "cacheCreationInputTokens": 12429,
      "clientRequestId": "d61ce6ea-e9ea-4297-923e-3b0957d4a366"
[06:52:56] · [LLM:ANTHROPIC] 首 token 延迟: 4292ms
`;
    // 连 fatal_error 都没有，llmFatal 必须为 false
    expect(extractAgentLogSignals(decoys).llmFatal).toBe(false);
    // 就算硬塞一个 fatal_error（但没有真正的上游错误行），也不该判 llmFatal ——
    // 那意味着致命错误另有成因，不该记到"网关/限流"账上。
    // ⚠️ 这里刻意不含 "限流"/"overloaded" 等词，只有巧合数字。
    expect(extractAgentLogSignals(decoys + "\nfatal_error: 别的原因\n").llmFatal).toBe(false);
  });

  test("agent.log 缺失时 record.ts 走兜底而不是抛", () => {
    // 与上面那条空日志用例互补：这条测的是**契约**（返回三个 boolean/number
    // 而不是 undefined），因为 record.ts 会直接把它们塞进 RunRecord。
    const s = extractAgentLogSignals("");
    expect(typeof s.hitMaxTurns).toBe("boolean");
    expect(typeof s.llmFatal).toBe("boolean");
    expect(typeof s.permissionDenials).toBe("number");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 耗时归因：wall_ms 一个数回答不了「慢在哪」
// ═══════════════════════════════════════════════════════════════════════════

/**
 * ## 为什么这组测试存在
 *
 * 「10 题跑 2-3 小时，定位不到哪道题慢」—— 而 `wall_ms` 从 smoke-1 起就逐题落盘了，
 * 只是报告只渲染了**总和**。数据一直在，没人看得到。
 *
 * 实测（smoke-8 记录重新汇总）：最慢 22.2min / 最快 1.8min，**差 12 倍**。
 * 这个分布形态直接决定优化方向（并发压墙钟 vs 调 max-turns 只影响长尾），
 * 所以报告必须逐题渲染、按耗时降序。
 *
 * 三段分解（setup/agent/extract）防的是另一件事：`wall_ms` 的边界是
 * `docker run` 前 → 收尾 `rm` 后，它把**起容器 + cp 40MB 产物 + 取回轨迹**
 * 都算进了"这道题花的时间"。不拆开的话，"该优化 harness 还是调 prompt"
 * 这个问题没有判据。
 */
describe("buildTimingProfile：耗时归因", () => {
  const full = [
    {
      instance_id: "slow",
      wall_ms: 600_000,
      setup_ms: 30_000,
      agent_ms: 560_000,
      extract_ms: 10_000,
    },
    {
      instance_id: "mid",
      wall_ms: 300_000,
      setup_ms: 20_000,
      agent_ms: 275_000,
      extract_ms: 5_000,
    },
    { instance_id: "fast", wall_ms: 60_000, setup_ms: 15_000, agent_ms: 40_000, extract_ms: 5_000 },
  ];

  test("按 wall_ms 降序 —— 最慢的排最前（那是唯一值得先看的）", () => {
    // 输入故意乱序：若实现忘了 sort，这条会红
    const t = buildTimingProfile([full[2]!, full[0]!, full[1]!]);
    expect(t.per_instance.map((r) => r.instance_id)).toEqual(["slow", "mid", "fast"]);
  });

  test("三段合计正确，且 setup+agent+extract === wall", () => {
    const t = buildTimingProfile(full);
    expect(t.total_wall_ms).toBe(960_000);
    expect(t.total_setup_ms).toBe(65_000);
    expect(t.total_agent_ms).toBe(875_000);
    expect(t.total_extract_ms).toBe(20_000);
    // 不变量：三段之和 == wall。它防的是"挪动某个 now_ms 调用点，
    // 于是某一段耗时掉在所有字段之外"—— record.ts 落盘原先就在取回轨迹之前。
    expect(t.total_setup_ms! + t.total_agent_ms! + t.total_extract_ms!).toBe(t.total_wall_ms);
  });

  test("串行代价 = 总和 / 最慢单条（并发的上界）", () => {
    const t = buildTimingProfile(full);
    expect(t.serial_penalty_x).toBeCloseTo(960_000 / 600_000, 5);
  });

  test("只有一条时串行代价是 null，不是 1.0", () => {
    // 1.0 会被读成「并发也没用」，而真相是「这个样本量说不了这件事」。
    // 这两个结论在决策上完全相反，所以不能用同一个值表示。
    expect(buildTimingProfile([full[0]!]).serial_penalty_x).toBeNull();
    expect(buildTimingProfile([]).serial_penalty_x).toBeNull();
  });

  /**
   * ## 缺分解时必须全部为 null，不许 `?? 0` 混着算
   *
   * 旧 run 没有这三个字段。用 `?? 0` 求和会得到
   * 「setup 合计 = 只有那 2 条有值的和」，而报告里它长得和完整分解一模一样。
   * **一个残缺的分解比没有分解更坏** —— 它看起来是个可用的数。
   */
  test("任一条缺分解 → 三段合计全为 null（不做部分汇总）", () => {
    const mixed = [full[0]!, { instance_id: "old", wall_ms: 120_000 }];
    const t = buildTimingProfile(mixed);
    expect(t.total_setup_ms).toBeNull();
    expect(t.total_agent_ms).toBeNull();
    expect(t.total_extract_ms).toBeNull();
    // wall 仍然可用（它老 run 也有），逐题也仍然给出 —— 只是分解不给
    expect(t.total_wall_ms).toBe(720_000);
    expect(t.per_instance).toHaveLength(2);
    // 变异自证：全员都有分解时才非 null
    expect(buildTimingProfile(full).total_setup_ms).not.toBeNull();
  });

  test("空 records → 三段为 null 而不是 0（0 会被读成「什么都没花时间」）", () => {
    const t = buildTimingProfile([]);
    expect(t.total_setup_ms).toBeNull();
    expect(t.total_wall_ms).toBe(0);
    expect(t.per_instance).toEqual([]);
  });

  test("setup_ms 为 0 是合法值，不等于「没量」", () => {
    // `typeof === "number"` 与 `?? 0` 的区别就在这条：一个真的 0（快到测不出）
    // 不该被当成缺字段。用 `??` 的实现在这条上表现一样，
    // 但在上面那条 mixed 用例上会红 —— 两条一起才锁住语义。
    const zero = [{ instance_id: "z", wall_ms: 100, setup_ms: 0, agent_ms: 100, extract_ms: 0 }];
    expect(buildTimingProfile(zero).total_setup_ms).toBe(0);
  });

  test("渲染：逐题一行、降序、不出现百分号", () => {
    const md = renderTimingSection(buildTimingProfile(full)).join("\n");
    // 逐题都在
    for (const id of ["slow", "mid", "fast"]) expect(md).toContain(id);
    // 降序：slow 出现在 fast 之前
    expect(md.indexOf("slow")).toBeLessThan(md.indexOf("fast"));
    // ## 不许出现「数字+%」
    //
    // §6 那条门禁只扫 renderReport()，技术上这里写 % 不会被它抓到。
    // 但那条门禁的理由（「在正文里现算一个比例和加一个 percent 字段是同一件事」）
    // 对耗时同样成立 —— n=10 的耗时方差极大（模型延迟本身抖动就有数倍），
    // 两轮百分比作差说明不了任何因果。所以这里补一条同形态的断言。
    expect(md).not.toMatch(/\d+(\.\d+)?%/);
    // 也不许有 percent/ratio 这类词混进来
    expect(md).not.toMatch(/percent|占比/);
  });

  test("渲染：缺分解时点破「不用 wall 顶替 agent」", () => {
    const md = renderTimingSection(
      buildTimingProfile([full[0]!, { instance_id: "old", wall_ms: 1000 }]),
    ).join("\n");
    expect(md).toContain("缺三段分解");
    // 表头只有 wall 一列（不能凭空造出搬运/模型/收尾三列）
    expect(md).not.toContain("| 搬运 |");
  });

  test("渲染：空输入返回空数组（不产出一个空段落）", () => {
    expect(renderTimingSection(buildTimingProfile([]))).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 评测配置的必控变量（ZZZZ.11 P1 + 本轮新增）
// ═══════════════════════════════════════════════════════════════════════════
describe("exec-swebench.sh 的必控变量与容器配置", () => {
  const sh = readFileSync(
    join(import.meta.dir, "../../evals/external-benchmarks/swe-bench/exec-swebench.sh"),
    "utf8",
  );

  /**
   * 可执行行（剥掉注释）。多条断言共用：注释里必然会提到那些被禁的字面量
   * （作为"为什么不能用它"的说明），扫全文会把说明本身当成违规。
   * 这与本文件「轨迹 cp 必须在 rm 之前」那条踩的是同一个坑，只是方向相反。
   */
  const shBody = sh
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("#"))
    .join("\n");

  test("权限只能用 --dangerously-skip-permissions 布尔 flag", () => {
    // ## 这条断言的上一版是错的，且错得全绿
    //
    // 上一版写的是 `expect(sh).toContain("bypassPermissions")` ——
    // 而 `bypassPermissions` **不是 sid-code 的合法权限模式名**
    // （`config/schema.ts` 的 VALID_PERMISSION_MODES 只有 9 个值，不含它）。
    // 传进去只得到一条 warn 而非错误，然后 checker 的 `=== "always-allow"`
    // 精确匹配不命中 → 落默认 ask → headless 直接拒绝。
    // 实测三模式对照：bypassPermissions 连**工作区内**的 write 都拒，
    // 比它要修的 acceptEdits 更差。
    //
    // 于是那条断言把一个错误取值**锁定成了正确行为**，并躲过了全量 11033 个测试。
    // 这正是本文件开头那条纪律要防的形态，而它出现在防它的测试里。
    expect(shBody).toContain("--dangerously-skip-permissions");
    // 三个已知的错误取值一律不许出现在可执行行里
    for (const wrong of ["bypassPermissions", "acceptEdits", "always-allow"]) {
      expect(shBody).not.toContain(wrong);
    }
    // ⚠️ 必须是布尔 flag，不能是 `--permission-mode <值>`：
    // 实测 `--permission-mode dangerously-skip-permissions` 三项全 false ——
    // cli.ts 把布尔 flag 映射到 config.skipPermissions，而 checker 的早退判据
    // 就是它；只设 permissionMode 字符串碰不到那条早退。
    expect(shBody).not.toMatch(/--permission-mode\s/);
  });

  test("run-meta.json 必须记全必控变量与被测代码身份", () => {
    // 它们和模型一样：换了值分数不可并排，而分数本身看不出来。
    for (const key of ['"max_turns"', '"permission_mode"', '"timeout_sec"']) {
      expect(sh).toContain(key);
    }
    // effort_level / cost_limit_usd：此前完全没记，而它们是被团队默认模板
    // 悄悄塞进来的（effortLevel=max / costLimit=100）——
    // 也就是说前几轮跑的是谁也没选过的值。
    for (const key of ['"effort_level"', '"cost_limit_usd"']) {
      expect(sh).toContain(key);
    }
    // ## git_commit 是被测代码的**唯一**身份，version 不是
    //
    // 实测（2026-08-26）：package.json 停在 0.1.601，而 tag v0.1.601 打在 8月21；
    // 此后合入的 429 修复、权限修复都不在那个 tag 里
    // （`git merge-base --is-ancestor <fix> v0.1.601` 失败）。
    // 同一个版本号对应过多个 commit → 只记 version 等于没记。
    for (const key of ['"git_commit"', '"git_dirty"', '"artifact_sha256"']) {
      expect(sh).toContain(key);
    }
    // 取 commit 必须真的调 git，不能只声明字段名
    expect(shBody).toContain("rev-parse HEAD");
    expect(shBody).toContain("status --porcelain");
  });

  test("旧产物必须拦住，且判据是产物自报的 commit 而**不是** mtime", () => {
    // 失败形态：跑评测想验证本轮修复，实际跑的是 5 天前的产物 ——
    // 分数正常、日志正常、run-meta 里的 version 也正常。
    //
    // ## ⚠️ 判据从 mtime 换成了产物自报的 commit（构建溯源方案）
    //
    // 上一轮这里断言的是 `warn_if_stale_artifact` + `log -1 --format=%ct`，
    // 而 mtime 判据**两个方向都会错**（实测）：
    //   假阴性：`cp old new` 把 mtime 重置成"现在"，内容一字未改 → 放行。
    //           而 cp / 下载 / docker cp 正是最常见的产物搬运方式。
    //   假阳性：docs-only 提交推进全仓 HEAD 时间 → 好产物被拦。
    // 假阳性的代价不是"多敲一次命令"：一道经常误报的门禁会被养成
    // 「先加 SWE_ALLOW_STALE_ARTIFACT=1 再说」的习惯 —— **误报会训练人绕过门禁**。
    expect(shBody).toContain("check_artifact_identity");
    // 必须在 cmd_run 里真的被调用，不是只定义（"函数零调用"这个坑本仓踩过）
    const calls = shBody.split("check_artifact_identity").length - 1;
    expect(calls).toBeGreaterThanOrEqual(2); // 1 处定义 + ≥1 处调用
    // 判定必须走那份唯一实现（scripts/lib/artifact-identity.ts 的桥 CLI），
    // 不是在 bash 里再写一份 —— 两份会各自漂移，而漂移不报错。
    expect(shBody).toContain("artifact-identity.ts");
    // ⚠️ 旧的 mtime 判据必须彻底消失。留着的形态最坑：两套判据并存，
    // 而 mtime 那套是恒放行的，看起来门禁还在跑。
    expect(shBody).not.toContain("warn_if_stale_artifact");
    // 精确到"取 HEAD 提交时间"这条命令：它现在只该出现在
    // scripts/lib 的 mtime **兜底**路径里，不该在 exec-swebench.sh 里
    expect(shBody).not.toContain("log -1 --format=%ct");
  });

  test("run-meta 把产物身份与宿主 HEAD 分开记（F3）", () => {
    // 旧的 `git_commit` 记的是**跑评测时宿主的 HEAD**，而产物可能是几天前编的 ——
    // 这两个值不一定相等，**而读报告的人会当它们相等**。
    // 变异自证：把 artifact_commit 那行从 run-meta 里删掉 → 红
    for (const key of [
      '"artifact_commit"',
      '"host_head_commit"',
      '"artifact_identity_source"',
      '"gate_bypassed"',
    ]) {
      expect(sh).toContain(key);
    }
    // artifact_commit 必须来自**门禁读回的那份 JSON**（产物字节），
    // 不能是宿主 HEAD 的回填 —— 回填出来的每个字段都正常，而结论是错的。
    expect(shBody).toContain("GATE_JSON");
    expect(shBody).toContain('gate.get("artifact_commit"');
    // 两个逃生舱必须分开接（语义不同：一个是"我要跑旧的"，一个是"我要跑别的分支"）
    expect(shBody).toContain("SWE_ALLOW_STALE_ARTIFACT");
    expect(shBody).toContain("SWE_ALLOW_FOREIGN_ARTIFACT");
  });

  test("轨迹必须在 docker rm 之前取回", () => {
    // ⚠️ 必须只看**可执行行**。第一版这条断言用 `sh.lastIndexOf("docker rm -f")`
    // 扫全文，而注释里也提到 `docker rm -f`（解释轨迹为什么会丢）——
    // 于是 lastIndexOf 命中的是**注释**，把 cp 挪到真正的 rm 之后测试照样全绿。
    // 变异自证抓出来的：这正是本文件开头那条纪律要防的形态。
    const lines = sh.split("\n").filter((l) => !l.trimStart().startsWith("#"));
    const cpIdx = lines.findIndex((l) => l.includes("sid-traj/."));
    // run_instance 收尾那个 rm（可执行行里的最后一个）
    const rmIdx = lines.reduce((acc, l, i) => (l.includes("docker rm -f") ? i : acc), -1);
    expect(cpIdx).toBeGreaterThan(0);
    expect(rmIdx).toBeGreaterThan(0);
    // 取回必须发生在收尾 docker rm 之前，否则容器已经没了
    expect(cpIdx).toBeLessThan(rmIdx);
  });

  test("settings.json 必须占住团队默认模板会 merge 进来的顶层键", () => {
    // backfill-team-defaults 迁移会把编译进二进制的 team-defaults.template.json
    // 里**用户缺失的顶层键**补进 settings.json。缺 fallbackModel 就会被塞
    // ali-deepseek-v4-flash（评测里出现第二个模型 = 必控变量失控），
    // 缺 trace 就会被塞指向线上平台的 upload 配置（容器无外网，白跑重试队列）。
    for (const key of ["fallbackModel", "subAgentModels", "trace", "mcpServers", "hooks"]) {
      expect(sh).toContain(key);
    }
    // fallbackModel 必须显式为空：评测只许一个模型
    expect(sh).toMatch(/"fallbackModel":\s*""/);
  });

  test("占位必须覆盖团队默认模板的**全部**顶层键（清单从模板现取）", () => {
    // ## 为什么现取而不是手写一份清单
    //
    // 上一版只手写了 5 个键（fallbackModel/subAgentModels/trace/mcpServers/hooks），
    // 而实测（2026-08-26，照抄 PYCFG 跑真二进制）迁移**仍然**补进 12 个：
    //   language, permissionMode, allowedTools, disallowedTools, quota, costLimit,
    //   search, disabledSkills, trustProjectExtensions, allowedDirectories,
    //   blockedDirectories, effortLevel
    // 手写清单会在模板加键时**静默过期** —— 门禁还绿着，而评测里又多了一个
    // 谁也没选过的变量。所以清单必须从模板现取：模板加键，这条自动开始要求。
    const tpl = JSON.parse(
      readFileSync(join(import.meta.dir, "../../scripts/team-defaults.template.json"), "utf8"),
    ) as Record<string, unknown>;
    // model / availableModels 由脚本按 SC_MODEL 自己构造，不是"占位"
    const skip = new Set(["model", "availableModels"]);
    const missing = Object.keys(tpl).filter((k) => !skip.has(k) && !sh.includes(`"${k}"`));
    expect(missing).toEqual([]);
  });

  test("成本闸门必须显式为 0（不限），否则整轮会静默结束并被记成零 patch", () => {
    // 模板值 costLimit=100。撞上时 loop.ts 在 exceeded 处 `yield done; return` ——
    // **整轮静默结束**，被记成 no_patch，读起来像能力问题。
    // quota.ts 的判据是 `costLimit <= 0` 直接 return null（= 不限）。
    expect(shBody).toContain('COST_LIMIT="${SWE_COST_LIMIT:-0}"');
    // 顶层 costLimit 与 quota.costLimit 是两个互不影响的字段（config/schema.ts），
    // 只占一个另一个照样被塞 100。
    expect(shBody).toMatch(/"costLimit":\s*float\(/);
    expect(shBody).toMatch(/"quota":\s*\{"costLimit":\s*float\(/);
  });

  test("trace outputDir 末级必须是 trajectories，否则取回来 digest 读不到", () => {
    // ## 一个"取回成功但读不了"的缝（2026-08-26 实测）
    //
    //   - collector.ts 是 `outputDir ?? sidPaths.trajectories()` —— 显式给了
    //     outputDir 时它**就是** sessions 的父目录，不再拼一层 trajectories/；
    //   - 而 trace/digest.ts 的 resolvePaths 硬拼 `{root}/trajectories/sessions`。
    // 于是 outputDir=/tmp/sid-traj 产出 `/tmp/sid-traj/sessions/<id>/`，
    // SID_CODE_HOME 指过去 digest 报「未找到任何会话轨迹」——
    // 文件都在、cp 也成功，**排查工具一条都读不到**。
    expect(shBody).toMatch(/"outputDir":\s*"\/tmp\/sid-traj\/trajectories"/);
    // mkdir 也要建到那一层，否则首次写入要靠 collector 自己兜
    expect(shBody).toContain("/tmp/sid-traj/trajectories");
    // cp 的源必须是 /tmp/sid-traj/. —— 多一层或少一层都让落地形状对不上 digest
    expect(shBody).toContain("/tmp/sid-traj/.");
  });

  test("三段计时必须都量到，且 record.ts 落盘在最后（否则又漏一段）", () => {
    // wall_ms 的边界是 docker run 前 → 收尾 rm 后。record.ts 原先在提取之后、
    // 取回轨迹**之前**跑 —— 于是 cp 40MB 轨迹的耗时掉在所有字段之外。
    for (const flag of ["--setup-ms", "--agent-ms", "--extract-ms"]) {
      expect(shBody).toContain(flag);
    }
    // 三个时间点都要真的调 now_ms
    for (const v of ["t_setup_done=$(now_ms)", "t_agent_done=$(now_ms)", "t1=$(now_ms)"]) {
      expect(shBody).toContain(v);
    }
    // ⚠️ t1 必须在 docker rm 之后取 —— 否则收尾搬运不计入
    const lines = shBody.split("\n");
    const rmIdx = lines.reduce((acc, l, i) => (l.includes("docker rm -f") ? i : acc), -1);
    const t1Idx = lines.findIndex((l) => l.includes("t1=$(now_ms)"));
    expect(t1Idx).toBeGreaterThan(rmIdx);
  });

  test("产物只解压一次（不是每题一次），且解出的目录不许在 run_one 里删", () => {
    // 每题各自 tar -xzf 一份 40MB 产物 = 纯浪费，并发下还会几个 tar 抢磁盘 IO。
    expect(shBody).toContain("resolve_binary");
    expect(shBody).toContain("RESOLVED_BIN");
    // ⛔ run_one 里不许再有 tar 解压或 rm -rf tmp_extract：
    // 并发下"一条删掉了另一条正在 cp 的文件"，失败形态是随机的 cp 报文件不存在。
    expect(shBody).not.toContain('rm -rf "$tmp_extract"');
    // tar 只在 resolve_binary 里出现一次
    expect(shBody.split("tar -xzf").length - 1).toBe(1);
  });

  test("SWE_JOBS 默认 1，非法值在起容器前就停", () => {
    // 默认必须是 1：并发是必控变量，smoke-9 要能与串行的 smoke-8 并排读。
    expect(shBody).toContain('jobs="${SWE_JOBS:-1}"');
    // 校验在 run-meta 之前（否则会跑掉半轮才发现 meta 是坏的）
    const lines = shBody.split("\n");
    const chk = lines.findIndex((l) => l.includes("SWE_JOBS 必须是"));
    const meta = lines.findIndex((l) => l.includes("run-meta.json"));
    expect(chk).toBeGreaterThan(-1);
    expect(chk).toBeLessThan(meta);
    // jobs 必须进 run-meta（它改变可比性，而分数上看不出来）
    expect(sh).toContain('"jobs"');
  });

  test("并发下不许直接 append 共享 jsonl —— 必须走 .parts/ 再合并", () => {
    // ## 失败形态：并发 append 几 KB 的 model_patch 不保证原子
    //
    // 两条记录交错成一行连合法 JSON 都不是的东西，官方 harness 读到坏行
    // 的反应是跳过 → 一个跑完了的实例看起来像"没提交" → 被记成 no_patch。
    // **并发把有效数据变成了能力问题**，而这在分数上完全看不出来。
    expect(shBody).toContain(".parts");
    // 合并顺序按 subset 而不是完成顺序（让两次 run 的 jsonl 可以直接 diff）
    expect(shBody).toMatch(/for iid in \$ids; do[\s\S]{0,400}\.parts/);
    // 缺分片不许静默跳过 —— 那正是"一条实例悄悄没进 predictions"的形态
    expect(shBody).toContain("缺 record/prediction 分片");
  });

  test("record.ts 写每题独立文件，不 appendFileSync 共享 jsonl", () => {
    const rec = readFileSync(join(SWE_DIR, "record.ts"), "utf8");
    const recBody = rec
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*"))
      .join("\n");
    expect(recBody).not.toContain("appendFileSync");
    expect(recBody).toContain(".record.json");
    expect(recBody).toContain(".prediction.json");
  });

  test("判分并发独立于 SWE_JOBS，且默认 1", () => {
    // 判分不碰模型网关且是纯函数（同一份 predictions 判两次结论必须一样），
    // 所以它**不影响可比性** —— 不该和 SWE_JOBS 共用一个开关，
    // 否则"想让判分快点"会连带把跑 agent 也改成并发、静默破坏可比性。
    expect(shBody).toContain('grade_jobs="${SWE_GRADE_JOBS:-1}"');
    expect(shBody).toContain('-j "$grade_jobs"');
    // 判分那一处不许再有硬编码的 -j 1。
    // ⚠️ 判据必须限定在 `-p "$preds"` 那条命令上 —— gold 自检
    // （`eval verified --gold -i "$iid"`）也是 `-j 1`，而那里**本该**是 1：
    // 它一次只判一条实例，并发没有意义。扫全文会把它误当违规。
    expect(shBody).not.toMatch(/eval verified -p "\$preds"[\s\S]{0,120}-j 1/);
    // 反向锁住 gold 自检仍是 -j 1（防有人"顺手统一"把它也改成变量）
    expect(shBody).toMatch(/eval verified --gold[\s\S]{0,80}-j 1/);
  });

  test("$SID_CONFIG_DIR 侧的遥测也要取回，且不许把 settings.json 带出来", () => {
    // telemetry/events.jsonl、session-index.jsonl、sessions/ 落在 SID_CONFIG_DIR，
    // **不随 trace.outputDir 走** —— 上面那条轨迹 cp 一个都带不到。
    for (const rel of ["telemetry", "session-index.jsonl", "sessions"]) {
      expect(shBody).toContain(rel);
    }
    // ⛔ 不许整个 cp 配置目录：settings.json 里有 api_key，
    // 而纪律是 key 只走 exec env、绝不落盘。
    expect(shBody).not.toMatch(/docker cp\s+"\$cname:\/tmp\/sid-cfg"/);
    expect(shBody).not.toMatch(/docker cp\s+"\$cname:\/tmp\/sid-cfg\/\."/);
  });
});
