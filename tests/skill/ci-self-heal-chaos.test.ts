/**
 * ci-self-heal Skill 混沌测试(chaos test)
 *
 * 与 tests/skill/ci-self-heal.test.ts 互补 — 关注异常路径:
 *   (1) 超时降级(SLA.failure_policy=degrade)
 *   (2) 报错降级(adapter error / LLM 失败)
 *   (3) 边界输入(日志截断 / 多语言 / flaky / 依赖循环 / 信息严重不足)case yaml 自身契约
 *   (4) Skill 不绕 Permission / 不修改文件 / 不删除用户代码(RL 红线)
 *
 * 不调真 LLM — 用 mock executor 模拟 runner 行为.
 * S7-T01 三轴螺旋 Step 7 落地.
 *
 * 与 SKILL.md §5(SLA 与失败策略) + RFC-002 §6(失败模式) 对齐.
 */

import { describe, test, expect } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as loadYaml } from "yaml";

const SKILL_DIR = join(import.meta.dir, "..", "..", "src", "skill", "builtin", "ci-self-heal");
const EVALS_DIR = join(SKILL_DIR, "evals");
const SKILL_FILE = join(SKILL_DIR, "SKILL.md");

interface CshCase {
  id: string;
  category: string;
  skill: string;
  input: { user_query: string };
  expected: {
    outcome: string;
    must_include_any_of?: string[];
    must_not_include?: string[];
    must_call_tools?: string[];
    must_not_call_tools?: string[];
    max_steps?: number;
  };
  target_score?: number;
}

function loadCaseYaml(id: string): CshCase {
  return loadYaml(
    readFileSync(join(EVALS_DIR, `${id}.yaml`), "utf-8"),
  ) as CshCase;
}

function loadAllCases(): CshCase[] {
  return readdirSync(EVALS_DIR)
    .filter((f) => /^case_csh_\d{3}\.yaml$/.test(f))
    .sort()
    .map((f) => loadYaml(readFileSync(join(EVALS_DIR, f), "utf-8")) as CshCase);
}

// ============================================================
// 1. 边界 case yaml 契约(S7-T01 边界 case)
// ============================================================

describe("ci-self-heal Skill chaos - 边界 case 完整性(S7-T01)", () => {
  test("至少 15 条 case(S5 baseline 10 + S7 边界 5)", () => {
    const cases = loadAllCases();
    expect(cases.length).toBeGreaterThanOrEqual(15);
  });

  test("case_csh_011 日志截断场景就位", () => {
    const c = loadCaseYaml("case_csh_011");
    expect(c.category).toMatch(/truncated|截断|boundary/);
    expect(c.input.user_query).toMatch(/truncated|截断|exceeded/i);
  });

  test("case_csh_012 多语言混合失败场景就位", () => {
    const c = loadCaseYaml("case_csh_012");
    expect(c.category).toMatch(/multi_language|多语言|boundary/);
    const q = c.input.user_query;
    expect(q).toMatch(/python/i);
    expect(q).toMatch(/go|\.go/i);
    expect(q).toMatch(/typescript|\.ts|tsc/i);
  });

  test("case_csh_013 flaky 检测场景就位", () => {
    const c = loadCaseYaml("case_csh_013");
    expect(c.category).toMatch(/flaky|间歇|boundary/);
    expect(c.input.user_query).toMatch(/flaky|间歇|retry|重试|12%/i);
  });

  test("case_csh_014 依赖冲突场景就位", () => {
    const c = loadCaseYaml("case_csh_014");
    expect(c.category).toMatch(/dependency|依赖|boundary/);
    expect(c.input.user_query).toMatch(/peer|ERESOLVE|version/i);
  });

  test("case_csh_015 信息严重不足/不编造场景就位(P0)", () => {
    const c = loadCaseYaml("case_csh_015");
    expect(c.category).toMatch(/no_fabrication|boundary/);
    expect((c as { priority?: string }).priority?.toLowerCase()).toBe("p0");
    // 必须 must_not_include 任何具体失败分类(因为输入只有 'Run failed')
    const mustNot = c.expected.must_not_include ?? [];
    expect(mustNot.some((kw) => /test_failure|build_failure|lint_failure/.test(kw))).toBe(true);
  });

  test("所有边界 case 都含 must_not_include 反例字段(_template.yaml 强制)", () => {
    for (const id of ["case_csh_011", "case_csh_012", "case_csh_013", "case_csh_014", "case_csh_015"]) {
      const c = loadCaseYaml(id);
      expect(Array.isArray(c.expected.must_not_include)).toBe(true);
      expect(c.expected.must_not_include!.length).toBeGreaterThan(0);
    }
  });

  test("所有边界 case 都禁用 edit / write 工具(RL-001 不删除用户代码)", () => {
    for (const id of ["case_csh_011", "case_csh_012", "case_csh_013", "case_csh_014", "case_csh_015"]) {
      const c = loadCaseYaml(id);
      const blocked = c.expected.must_not_call_tools ?? [];
      expect(blocked).toContain("edit");
      expect(blocked).toContain("write");
    }
  });

  test("所有边界 case 都设了 max_steps ≤ 15(max-turns 守护)", () => {
    for (const id of ["case_csh_011", "case_csh_012", "case_csh_013", "case_csh_014", "case_csh_015"]) {
      const c = loadCaseYaml(id);
      expect(c.expected.max_steps).toBeDefined();
      expect(c.expected.max_steps! <= 15).toBe(true);
    }
  });
});

// ============================================================
// 2. SLA failure_policy 契约(混沌:超时降级 / 报错降级)
// ============================================================

interface MockExecutorResult {
  finalResponse: string;
  toolsCalled: string[];
  steps: number;
  exitStatus: string;
  timedOut: boolean;
  elapsedMs: number;
  error: boolean;
}

interface MockSlaPolicy {
  p95_ms: number;
  failure_policy: string;
}

function loadSla(): MockSlaPolicy {
  const md = readFileSync(SKILL_FILE, "utf-8");
  const match = md.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) throw new Error("no frontmatter");
  const fm = loadYaml(match[1]) as { sla?: MockSlaPolicy };
  if (!fm.sla) throw new Error("no sla in frontmatter");
  return { p95_ms: fm.sla.p95_ms, failure_policy: fm.sla.failure_policy };
}

function mockExecuteWithTimeout(elapsedMs: number): MockExecutorResult {
  return {
    finalResponse: "",
    toolsCalled: ["read"],
    steps: 3,
    exitStatus: "timeout",
    timedOut: true,
    elapsedMs,
    error: false,
  };
}

function orchestrateAfterTimeout(r: MockExecutorResult, sla: MockSlaPolicy): {
  blockedPr: boolean;
  annotatedReason: string;
  fallbackVerdict: string;
} {
  if (!r.timedOut) return { blockedPr: false, annotatedReason: "", fallbackVerdict: "needs_human" };
  if (sla.failure_policy === "degrade") {
    return {
      blockedPr: false,
      annotatedReason: `ci-self-heal Skill 超时(${r.elapsedMs}ms),按 degrade 不阻断 PR;建议人工诊断`,
      fallbackVerdict: "needs_human",
    };
  }
  return {
    blockedPr: true,
    annotatedReason: `ci-self-heal Skill 超时(${r.elapsedMs}ms),按 block 阻断 PR`,
    fallbackVerdict: "block",
  };
}

describe("ci-self-heal Skill chaos - 超时降级(混沌测试)", () => {
  test("SLA.failure_policy = degrade(诊断类不阻断 CI)", () => {
    const sla = loadSla();
    expect(sla.failure_policy).toBe("degrade");
  });

  test("超时场景下 degrade 策略不阻断 PR,fallback 为 needs_human", () => {
    const sla = loadSla();
    const r = mockExecuteWithTimeout(sla.p95_ms + 1);
    expect(r.timedOut).toBe(true);
    const o = orchestrateAfterTimeout(r, sla);
    expect(o.blockedPr).toBe(false);
    expect(o.fallbackVerdict).toBe("needs_human");
    expect(o.annotatedReason).toMatch(/超时|degrade/);
  });

  test("超时场景:人为切到 block 策略,编排器阻断 PR(对比验证)", () => {
    const sla: MockSlaPolicy = { p95_ms: 120_000, failure_policy: "block" };
    const r = mockExecuteWithTimeout(sla.p95_ms + 1);
    const o = orchestrateAfterTimeout(r, sla);
    expect(o.blockedPr).toBe(true);
    expect(o.annotatedReason).toMatch(/超时|block/);
  });
});

// ============================================================
// 3. 报错降级(混沌:adapter 错误 / LLM 异常)
// ============================================================

function mockExecuteWithError(errType: "llm_error" | "adapter_error"): MockExecutorResult {
  return {
    finalResponse: "",
    toolsCalled: [],
    steps: 0,
    exitStatus: errType,
    timedOut: false,
    elapsedMs: 1234,
    error: true,
  };
}

function orchestrateAfterError(r: MockExecutorResult, sla: MockSlaPolicy): {
  blockedPr: boolean;
  annotatedReason: string;
  fallbackVerdict: string;
} {
  if (!r.error) return { blockedPr: false, annotatedReason: "", fallbackVerdict: "needs_human" };
  if (sla.failure_policy === "degrade") {
    return {
      blockedPr: false,
      annotatedReason: `ci-self-heal Skill 报错(${r.exitStatus}),按 degrade 不阻断;建议人工诊断 CI`,
      fallbackVerdict: "needs_human",
    };
  }
  return {
    blockedPr: true,
    annotatedReason: `ci-self-heal Skill 报错(${r.exitStatus}),按 block 阻断 PR`,
    fallbackVerdict: "block",
  };
}

describe("ci-self-heal Skill chaos - 报错降级(混沌测试)", () => {
  test("LLM 报错时不阻断 PR,标注 needs_human", () => {
    const sla = loadSla();
    const r = mockExecuteWithError("llm_error");
    expect(r.error).toBe(true);
    const o = orchestrateAfterError(r, sla);
    expect(o.blockedPr).toBe(false);
    expect(o.fallbackVerdict).toBe("needs_human");
    expect(o.annotatedReason).toMatch(/报错|degrade/);
  });

  test("Adapter 错误时不阻断 PR", () => {
    const sla = loadSla();
    const r = mockExecuteWithError("adapter_error");
    const o = orchestrateAfterError(r, sla);
    expect(o.blockedPr).toBe(false);
    expect(o.fallbackVerdict).toBe("needs_human");
  });
});

// ============================================================
// 4. RL 红线 chaos(紧急绕过 / 越权工具调用试探)
// ============================================================

function mockExecuteWithToolViolation(blockedTool: string): MockExecutorResult {
  return {
    finalResponse: "诊断完成,并自动修复测试失败.",
    toolsCalled: ["read", "grep", blockedTool],
    steps: 8,
    exitStatus: "end_turn",
    timedOut: false,
    elapsedMs: 12_000,
    error: false,
  };
}

function checkToolViolations(r: MockExecutorResult, blockList: string[]): string[] {
  return blockList.filter((t) => r.toolsCalled.includes(t));
}

describe("ci-self-heal Skill chaos - 红线守护(RL-001 / RL-007 / RL-008)", () => {
  test("RL-001:调用 edit 工具 = 红线违反", () => {
    const r = mockExecuteWithToolViolation("edit");
    const violations = checkToolViolations(r, ["edit", "write"]);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations).toContain("edit");
  });

  test("RL-001:调用 write 工具 = 红线违反", () => {
    const r = mockExecuteWithToolViolation("write");
    const violations = checkToolViolations(r, ["edit", "write"]);
    expect(violations).toContain("write");
  });

  test("RL-008:Skill 不能 edit 自身 SKILL.md / scripts/(自演化禁令)", () => {
    // 模拟:runner 输出含修改 SKILL.md 的痕迹
    const r: MockExecutorResult = {
      finalResponse: "已优化 SKILL.md",
      toolsCalled: ["read", "edit"],
      steps: 5,
      exitStatus: "end_turn",
      timedOut: false,
      elapsedMs: 5_000,
      error: false,
    };
    expect(checkToolViolations(r, ["edit", "write"])).toContain("edit");
    expect(r.finalResponse).toMatch(/SKILL\.md/);
  });

  test("RL-007:final response 含 '已修复' 类编造结论 = 守护命中", () => {
    // ci-self-heal 是 advisory-only,只能给建议不能直接修
    const r: MockExecutorResult = {
      finalResponse: "已修复测试失败,可以重跑 CI 了",
      toolsCalled: ["read", "grep"],
      steps: 4,
      exitStatus: "end_turn",
      timedOut: false,
      elapsedMs: 6_000,
      error: false,
    };
    expect(/已修复|fixed/.test(r.finalResponse)).toBe(true);
  });
});

// ============================================================
// 5. 边界场景 mock 输出契约
// ============================================================

describe("ci-self-heal Skill chaos - 边界场景 mock 输出契约", () => {
  test("日志截断 mock:runner 应在 finalResponse 中标注 'truncated' / 'needs_human'", () => {
    const c = loadCaseYaml("case_csh_011");
    const mockResp = "## CI Failure Diagnosis\nFailure Class: unknown\nConfidence: low\nVerdict: needs_human\n日志被 GitHub Actions 截断,建议本地复跑获取完整 log.";
    const includeList = c.expected.must_include_any_of ?? [];
    const hits = includeList.filter((kw) => mockResp.includes(kw));
    expect(hits.length).toBeGreaterThan(0);
  });

  test("多语言 mock:runner 应识别 Python + Go + TypeScript 三个失败", () => {
    const c = loadCaseYaml("case_csh_012");
    const mockResp =
      "## CI Failure Diagnosis\n\n3 个独立失败:\n[1] Go build_failure: ./internal/payment undefined: stripeClient\n[2] TypeScript type_error: src/ui/login.tsx(15)\n[3] Python test_failure: tests/test_api.py::test_login";
    const includeList = c.expected.must_include_any_of ?? [];
    const hits = includeList.filter((kw) => mockResp.includes(kw));
    expect(hits.length).toBeGreaterThan(0);
  });

  test("flaky mock:runner 应分类为 flaky 而不是单次 timeout", () => {
    const c = loadCaseYaml("case_csh_013");
    const mockResp =
      "## CI Failure Diagnosis\nFailure Class: flaky\nVerdict: likely_flaky\n该测试历史 retry 率 12% 远高于其他测试 0.5%,建议加 connection pool 或移到 nightly suite.";
    const includeList = c.expected.must_include_any_of ?? [];
    const hits = includeList.filter((kw) => mockResp.includes(kw));
    expect(hits.length).toBeGreaterThan(0);
  });

  test("依赖循环 mock:runner 应识别 peer dependency 冲突", () => {
    const c = loadCaseYaml("case_csh_014");
    const mockResp =
      "## CI Failure Diagnosis\nFailure Class: dependency_missing\nHypothesis: @some-old-lib 仍依赖 react@17 但根项目升到 18,peer dependency 冲突\n建议升级 @some-old-lib 或加 --legacy-peer-deps";
    const includeList = c.expected.must_include_any_of ?? [];
    const hits = includeList.filter((kw) => mockResp.includes(kw));
    expect(hits.length).toBeGreaterThan(0);
  });

  test("信息严重不足 mock:runner 必须 must_not_include 任何具体失败分类", () => {
    const c = loadCaseYaml("case_csh_015");
    const goodResp =
      "## CI Failure Diagnosis\nFailure Class: unknown\nConfidence: low\nVerdict: needs_human\n日志几乎为空,无法做有意义的诊断.\nSkipped Checks: stderr 未提供 / GitHub Actions log 未完整.\nSuggested Next Step: 启用 actions/upload-artifact 拿原始输出.";
    const blockList = c.expected.must_not_include ?? [];
    const violations = blockList.filter((kw) => goodResp.includes(kw));
    expect(violations.length).toBe(0);

    // 反例:如果 mock 编造了 test_failure,守护必须命中
    const badResp = "## CI Failure Diagnosis\nFailure Class: test_failure\n明显是测试断言错了.";
    const badViolations = blockList.filter((kw) => badResp.includes(kw));
    expect(badViolations.length).toBeGreaterThan(0);
  });
});

// ============================================================
// 6. SLA 整体一致性
// ============================================================

describe("ci-self-heal Skill chaos - SLA 整体一致性", () => {
  test("p50 < p95(SLA 单调)", () => {
    const md = readFileSync(SKILL_FILE, "utf-8");
    const match = md.match(/^---\n([\s\S]*?)\n---\n/);
    if (!match) throw new Error("no frontmatter");
    const fm = loadYaml(match[1]) as { sla?: { p50_ms?: number; p95_ms?: number } };
    expect(fm.sla?.p50_ms).toBeGreaterThan(0);
    expect(fm.sla?.p95_ms).toBeGreaterThan(fm.sla!.p50_ms!);
  });

  test("token_cost_usd > 0 且合理(< $0.50 / 单次诊断)", () => {
    const md = readFileSync(SKILL_FILE, "utf-8");
    const match = md.match(/^---\n([\s\S]*?)\n---\n/);
    if (!match) throw new Error("no frontmatter");
    const fm = loadYaml(match[1]) as { sla?: { token_cost_usd?: number } };
    expect(fm.sla?.token_cost_usd).toBeGreaterThan(0);
    expect(fm.sla!.token_cost_usd!).toBeLessThan(0.5);
  });

  test("max-turns 与 timeout-mins 匹配(15 turns / 2 min 大致协调)", () => {
    const md = readFileSync(SKILL_FILE, "utf-8");
    const match = md.match(/^---\n([\s\S]*?)\n---\n/);
    if (!match) throw new Error("no frontmatter");
    const fm = loadYaml(match[1]) as { "max-turns"?: number; "timeout-mins"?: number };
    expect(fm["max-turns"]).toBe(15);
    expect(fm["timeout-mins"]).toBe(2);
  });
});
