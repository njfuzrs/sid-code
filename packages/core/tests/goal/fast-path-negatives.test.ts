/**
 * Goal fast-path 负例集（F2 / F3 / F7，2026-09-03 排查）
 *
 * ## 这个文件为什么单独存在
 *
 * fast-path 一放行，任务就结束了——**没有第二道判定兜底**。所以它唯一真正危险的
 * 方向是「过度放行」，而只测「该放行时放行」无法排除这个方向。
 *
 * 本文件专收**「看起来通过但实际没通过」**的真实输出样本：每种 runner / 构建工具
 * 各一条，断言 fast-path **不得**放行。每次发现新形态就往这里加一条。
 *
 * 三条被修的缺陷共享同一个病根：**用字符串形态推断语义**。
 * - F2：jest/vitest 有 `Test Suites` / `Tests` 两级计数，suite 整体没跑起来时
 *   `Tests: 0 failed` 仍然成立 → 旧判据判成"测试全绿"。
 * - F3：报告型 fast-path 靠 objective 里的关键词猜"这是报告任务"，
 *   `分析` / `检查...结果` 这些词大量出现在实干型目标里 → 500 字废话即放行。
 * - F7：`hasBuildPattern` 只要输出含 `build` 就算构建结果，`cat package.json` 中招。
 */

import { describe, test, expect } from "bun:test";
import { collectEvidence } from "@sid-code/core/goal/evidence-collector.ts";
import { tryFastPathEval, tryReportFallbackEval } from "@sid-code/core/goal/evaluator.ts";
import { createGoal } from "@sid-code/core/goal/state.ts";

// ─── F2：test_result fast-path 不得把「suite 整体失败」判成全绿 ───

/**
 * 每条形状都是「喂一个表面成功的输出 → 断言 fast-path 不放行」。
 * 走完整 collectEvidence → tryFastPathEval 链路，不重写判定逻辑。
 */
const LOOKS_PASSING_BUT_ISNT: Array<[name: string, output: string]> = [
  [
    "jest suite 级失败（3 个套件没跑起来，跑起来的 120 个全过）",
    [
      "FAIL src/auth/login.test.ts",
      "  ● Test suite failed to run",
      "    Cannot find module '../config' from 'src/auth/login.test.ts'",
      "FAIL src/auth/token.test.ts",
      "  ● Test suite failed to run",
      "FAIL src/auth/session.test.ts",
      "  ● Test suite failed to run",
      "",
      "Test Suites: 3 failed, 5 passed, 8 total",
      "Tests:       0 failed, 120 passed, 120 total",
      "Snapshots:   0 total",
      "Time:        4.2 s",
    ].join("\n"),
  ],
  [
    "vitest 文件级失败（Test Files 3 failed，Tests 行本身 0 failed）",
    [
      "Test Files  3 failed | 5 passed (8)",
      "Tests  0 failed | 120 passed (120)",
      "Duration  4.20s",
    ].join("\n"),
  ],
  [
    "pytest collect 阶段错误（一个都没跑，0 failed 成立）",
    [
      "==================== ERRORS ====================",
      "____________ ERROR collecting test_foo.py ______",
      "ImportError while importing test module 'test_foo.py'",
      "=============== 0 failed, 0 passed, 1 error ===============",
    ].join("\n"),
  ],
];

describe("F2：fast-path 不得放行「看起来通过但没通过」", () => {
  for (const [name, output] of LOOKS_PASSING_BUT_ISNT) {
    test(`不放行：${name}（变异自证：修复前这条必失败）`, () => {
      const goal = createGoal("让 test/auth/ 下所有测试跑到绿灯");
      const ev = collectEvidence("bash", output, 5);
      expect(ev).not.toBeNull();
      goal.evidenceLog.push(ev!);
      expect(tryFastPathEval(goal)).toBeNull();
    });
  }

  test("suite 级失败时 summary 必须保留 Test Suites 那一行（治根：不再只取一行）", () => {
    // 旧实现 lines.reverse() 后取第一个命中的汇总行，于是命中 `Tests: 0 failed`、
    // 跳过它上面的 `Test Suites: 3 failed`——真实的失败信号压根没进 summary。
    const ev = collectEvidence("bash", LOOKS_PASSING_BUT_ISNT[0]![1], 5);
    expect(ev!.type).toBe("test_result");
    expect(ev!.summary).toContain("Test Suites");
    expect(ev!.summary).toContain("3 failed");
  });

  test("命令失败（is_error）时不放行，即便输出里写着 0 failed", () => {
    // 测试是否通过本质由退出码定义，不由输出文本定义。
    const goal = createGoal("让 bun test 全绿");
    const ev = collectEvidence("bash", "42 pass, 0 fail", 5, { isError: true });
    expect(ev!.isError).toBe(true);
    goal.evidenceLog.push(ev!);
    expect(tryFastPathEval(goal)).toBeNull();
  });
});

describe("F2：不回退已有能力（正例仍须放行）", () => {
  test("bun 全绿 `42 pass, 0 fail` 仍命中", () => {
    const goal = createGoal("让 bun test 全绿");
    const ev = collectEvidence("bash", "bun test v1.3.14\n42 pass, 0 fail", 9);
    goal.evidenceLog.push(ev!);
    const r = tryFastPathEval(goal);
    expect(r).not.toBeNull();
    expect(r!.satisfied).toBe(true);
  });

  test("jest 真全绿（两级计数都是 0 failed）仍命中", () => {
    const goal = createGoal("让所有测试通过");
    const ev = collectEvidence(
      "bash",
      ["Test Suites: 8 passed, 8 total", "Tests:       120 passed, 120 total"].join("\n"),
      9,
    );
    goal.evidenceLog.push(ev!);
    // 注：jest 全绿时输出里没有 "0 failed" 字样，判据靠 0-fail 正则会漏判。
    // 漏判方向安全（退回评估器判定），故此处只断言"不得假阳性"，不强制命中。
    const r = tryFastPathEval(goal);
    if (r) expect(r.satisfied).toBe(true);
  });
});

// ─── F3：报告型 fast-path 不得抢在评估器前面放行实干型目标 ───

/** 720 字符纯叙述，没干任何实事——与一份真实报告在长度上不可区分。 */
const FILLER = "我先分析一下当前的情况，看起来还需要进一步确认。".repeat(30);

describe("F3：报告型放行只作评估器不可用时的兜底", () => {
  test("评估器健康时，报告型目标不由 fast-path 抢跑（变异自证）", () => {
    // tryFastPathEval 已不再接收 stopReason / 文本长度这两个信号——报告型放行
    // 整段移到了 tryReportFallbackEval。签名收窄本身就是这条缺陷的结构性修复：
    // 抢跑的前提（fast-path 能看到 end_turn 信号）被从类型上拿掉了。
    const goal = createGoal("审计这份文档与源码的一致性，汇总告诉我");
    expect(tryFastPathEval(goal)).toBeNull();
  });

  const HANDS_ON_OBJECTIVES = [
    "分析并修复 src/auth 下所有失败的测试，直到 bun test 全绿",
    "检查并修复类型错误，确认 tsc 结果为空",
    "总结现状后把 CI 的 lint 报错全部修掉",
  ];
  for (const obj of HANDS_ON_OBJECTIVES) {
    test(`实干型目标即便含报告类词也不得兜底放行：${obj.slice(0, 16)}…`, () => {
      const goal = createGoal(obj);
      expect(tryReportFallbackEval(goal, "end_turn", FILLER.length)).toBeNull();
    });
  }

  test("纯报告型目标 + 实质文本 → 评估器不可用时仍能放行（保住原能力）", () => {
    const goal = createGoal("审计这份文档与源码的一致性，汇总告诉我");
    const r = tryReportFallbackEval(goal, "end_turn", FILLER.length);
    expect(r).not.toBeNull();
    expect(r!.satisfied).toBe(true);
  });

  test("文本不足 500 字符时不放行（阈值不变）", () => {
    const goal = createGoal("汇总告诉我排查结果");
    expect(tryReportFallbackEval(goal, "end_turn", 480)).toBeNull();
  });

  test("Evidence Log 最后一条是失败时，报告型兜底也不得放行", () => {
    const goal = createGoal("汇总告诉我排查结果");
    goal.evidenceLog.push({
      turn: 7,
      timestamp: Date.now(),
      type: "test_result",
      summary: "Tests: 12 failed, 108 passed, 120 total",
    });
    expect(tryReportFallbackEval(goal, "end_turn", FILLER.length)).toBeNull();
  });
});

// ─── F7：hasBuildPattern 不得把普通命令记成 build_result ───

describe("F7：build 判据需要「关键词 + 结果形态」双重条件", () => {
  test("cat package.json 不产生 build_result（变异自证）", () => {
    const catOutput = [
      "{",
      '  "scripts": {',
      '    "build": "make build",',
      '    "test": "bun test"',
      "  }",
      "}",
    ].join("\n");
    const ev = collectEvidence("bash", catOutput, 3);
    expect(ev).not.toBeNull();
    expect(ev!.type).not.toBe("build_result");
    expect(ev!.type).toBe("command_output");
  });

  test("git log 提到 build 的提交信息不产生 build_result", () => {
    const ev = collectEvidence(
      "bash",
      "6efba79e fix(release): 恢复 release.sh 可执行位\n834ae578 chore: tweak build script",
      3,
    );
    expect(ev!.type).not.toBe("build_result");
  });

  test("真实 tsc 错误仍产生 build_result（不回退）", () => {
    const ev = collectEvidence(
      "bash",
      "$ tsc --noEmit\nerror TS2345: Argument of type 'string' is not assignable",
      3,
    );
    expect(ev!.type).toBe("build_result");
    expect(ev!.summary).toContain("TS2345");
  });

  test("vite build 成功仍产生 build_result（不回退）", () => {
    const ev = collectEvidence(
      "bash",
      "$ vite build\nvite v5.0.0 building for production...\n✓ 34 modules transformed.\nbuilt in 1.24s",
      4,
    );
    expect(ev!.type).toBe("build_result");
  });

  test("summary 为纯符号/空白的证据不入库", () => {
    // `"  } | }"` 这种 summary 无论 type 对不对都没有证据价值，
    // 留着只会挤占评估器「最近 20 条」的窗口。
    const ev = collectEvidence("bash", "{\n}\n", 3);
    expect(ev).toBeNull();
  });
});
