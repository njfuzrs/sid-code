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
// 评测配置的必控变量（ZZZZ.11 P1 + 本轮新增）
// ═══════════════════════════════════════════════════════════════════════════
describe("exec-swebench.sh 的必控变量与容器配置", () => {
  const sh = readFileSync(
    join(import.meta.dir, "../../evals/external-benchmarks/swe-bench/exec-swebench.sh"),
    "utf8",
  );

  test("权限模式不许再用 acceptEdits（headless 下会拒掉 pytest/write）", () => {
    // 实测 smoke-8：acceptEdits 导致 113 次权限拒绝，三条实例过半轮次白烧。
    // 只放行 FILE_TOOLS + cwd 内 7 个 fs 命令，python/pytest 全落 ask → headless 拒绝。
    expect(sh).toContain("bypassPermissions");
    // 命令行里不许出现硬编码的 acceptEdits（注释里作为历史说明可以有）
    const body = sh
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("#"))
      .join("\n");
    expect(body).not.toContain("acceptEdits");
  });

  test("max_turns / permission_mode 必须进 run-meta.json", () => {
    // 它们和模型一样是必控变量：换了值分数不可并排，而分数本身看不出来。
    expect(sh).toContain('"max_turns"');
    expect(sh).toContain('"permission_mode"');
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
});
