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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseSubset,
  buildPrompt,
  isTestPath,
  parseNumstatZ,
  splitExtractOutput,
  deriveOutcome,
  pickArtifact,
  parseArgs,
  MODEL_NAME,
} from "../../evals/external-benchmarks/swe-bench/runner.ts";
import {
  mapOutcomes,
  buildAcceptance,
  renderReport,
  findReport,
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
    expect(sh).not.toContain("--no-session-persistence");
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
